import {
	createAssistantMessageEventStream,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type ThinkingLevel,
	type ThinkingLevelMap,
} from '@earendil-works/pi-ai';
import { streamSimple as streamOpenAiResponses } from '@earendil-works/pi-ai/api/openai-responses';
import { OPENAI_API_BASE_URL } from '@studio/agent/node/openai-model-list';
import {
	classifyOpenAiHttpError,
	classifyOpenAiStreamFailure,
	describeOpenAiError,
	summarizeOpenAiNetworkFailure,
	type OpenAiErrorSummary,
} from '@studio/agent/protocol/openai-errors';
import {
	OPENAI_MODEL_CAPABILITIES,
	type OpenAiReasoningEffort,
	type OpenAiTurnSettings,
} from '@studio/agent/protocol/openai-models';
import { OPENAI_PI_PROVIDER } from '@studio/agent/protocol/providers';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AiModelId } from '@studio/agent/protocol/models';

type ProviderConfigInput = Parameters< ModelRuntime[ 'registerProvider' ] >[ 1 ];

// Not pi's built-in `openai` provider: that one reads keys from the
// environment and treats keys without `sk-` as ChatGPT sign-in tokens.
export const STUDIO_OPENAI_PROVIDER = OPENAI_PI_PROVIDER;
const OPENAI_ORIGIN = new URL( OPENAI_API_BASE_URL ).origin;
// Compaction keeps context under this, far below every GPT-6 model's 922,000
// input-token limit, and below the 272,000-token mark past which input costs
// more. Studio's other providers use the same budget.
const STUDIO_OPENAI_CONTEXT_BUDGET = 200_000;

// pi's thinking levels map one to one onto OpenAI's efforts, with `off` as
// `none`. A level the model lacks maps to null, so pi never offers it; the
// payload check below still refuses any effort other than the chosen one.
const PI_LEVEL_EFFORT: Record< keyof ThinkingLevelMap, OpenAiReasoningEffort > = {
	off: 'none',
	minimal: 'minimal',
	low: 'low',
	medium: 'medium',
	high: 'high',
	xhigh: 'xhigh',
	max: 'max',
};

export function toPiThinkingLevel( effort: OpenAiReasoningEffort ): ThinkingLevel | 'off' {
	return effort === 'none' ? 'off' : effort;
}

function buildThinkingLevelMap( efforts: readonly OpenAiReasoningEffort[] ): ThinkingLevelMap {
	return Object.fromEntries(
		Object.entries( PI_LEVEL_EFFORT ).map( ( [ level, effort ] ) => [
			level,
			efforts.includes( effort ) ? effort : null,
		] )
	) as ThinkingLevelMap;
}

export function buildOpenAiModel(
	settings: OpenAiTurnSettings,
	label: string
): Model< 'openai-responses' > {
	const capabilities = OPENAI_MODEL_CAPABILITIES[ settings.model ];
	return {
		// Studio's id, kept in session history; the request names `apiModelId`.
		id: settings.model,
		name: label,
		api: 'openai-responses',
		provider: STUDIO_OPENAI_PROVIDER,
		baseUrl: OPENAI_API_BASE_URL,
		reasoning: true,
		input: capabilities.imageInput ? [ 'text', 'image' ] : [ 'text' ],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: Math.min( STUDIO_OPENAI_CONTEXT_BUDGET, capabilities.maxInputTokens ),
		maxTokens: settings.maxOutputTokens,
		thinkingLevelMap: buildThinkingLevelMap( capabilities.reasoningEfforts ),
		compat: {
			// Makes pi send `strict: false` on every function tool. Left out, the
			// Responses API normalizes schemas into strict mode, which turns
			// optional parameters into required nullable ones.
			supportsStrictMode: true,
			// GPT-5.6 and later set cache lifetime with `prompt_cache_options`.
			supportsExplicitPromptCacheMode: true,
			// `configuration_update` items must not meet compaction (per the
			// reasoning guide), so effort stays a request-level field.
			supportsMidConvoEffort: false,
		},
	};
}

/**
 * Applies the turn's settings to the request pi built, and refuses one that
 * would use any other reasoning effort than the chosen one: pi clamps an
 * unsupported level to a neighbour, and Studio must not send that silently.
 */
export function applyOpenAiTurnSettings(
	params: unknown,
	settings: OpenAiTurnSettings
): Record< string, unknown > {
	const request = { ...( params as Record< string, unknown > ) };
	const reasoning = { ...( request.reasoning as Record< string, unknown > | undefined ) };
	if ( reasoning.effort !== settings.reasoningEffort ) {
		throw new Error(
			`Studio stopped an OpenAI request that would have used ${ String(
				reasoning.effort ?? 'the default'
			) } reasoning instead of the selected ${ settings.reasoningEffort }.`
		);
	}
	// Reasoning summaries can require a verified OpenAI organization, and
	// Studio doesn't show them; the encrypted reasoning items are what matter.
	delete reasoning.summary;
	if ( settings.reasoningMode === 'pro' ) {
		reasoning.mode = 'pro';
	}
	return {
		...request,
		model: settings.apiModelId,
		// Exact, rather than pi's estimate-based trim: the budget above keeps
		// input far from the real context window.
		max_output_tokens: settings.maxOutputTokens,
		reasoning,
	};
}

interface OpenAiExchange {
	fetch: typeof fetch;
	/** Why the latest HTTP request failed, when it did. */
	failure(): OpenAiErrorSummary | undefined;
}

/**
 * The fetch the OpenAI client uses: only to the OpenAI API, never following a
 * redirect (which could carry the key elsewhere), recording each failure so
 * the error can be classified by status and code rather than by text.
 *
 * Each request carries Studio's key and no organization or project. The
 * OpenAI SDK would otherwise add what it finds in the process environment:
 * `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, and `OPENAI_CUSTOM_HEADERS`, which
 * can even replace the `Authorization` header.
 */
function createOpenAiExchange( apiKey: string ): OpenAiExchange {
	let failure: OpenAiErrorSummary | undefined;
	const guardedFetch = async ( input: RequestInfo | URL, init?: RequestInit ) => {
		const url = new URL( input instanceof Request ? input.url : String( input ) );
		if ( url.origin !== OPENAI_ORIGIN ) {
			throw new Error( `Studio sends OpenAI requests only to ${ OPENAI_ORIGIN }.` );
		}
		const headers = new Headers(
			init?.headers ?? ( input instanceof Request ? input.headers : {} )
		);
		headers.delete( 'openai-organization' );
		headers.delete( 'openai-project' );
		headers.set( 'authorization', `Bearer ${ apiKey }` );
		let response: Response;
		try {
			response = await fetch( input, { ...init, headers, redirect: 'error' } );
		} catch ( error ) {
			if ( ! init?.signal?.aborted ) {
				failure = summarizeOpenAiNetworkFailure( error, [ apiKey ] );
			}
			throw error;
		}
		if ( response.ok ) {
			failure = undefined;
		} else {
			const body: unknown = await response
				.clone()
				.json()
				.catch( () => undefined );
			failure = classifyOpenAiHttpError( response.status, body, [ apiKey ] );
		}
		return response;
	};
	return { fetch: guardedFetch as typeof fetch, failure: () => failure };
}

/**
 * Rewrites a failed turn's error with what went wrong and how to fix it —
 * never with the WordPress.com usage-cap wording, and never with the key.
 * Cancellations pass through as they are.
 */
function withOpenAiErrorsClassified(
	source: AssistantMessageEventStream,
	exchange: OpenAiExchange,
	apiKey: string
): AssistantMessageEventStream {
	const classified = createAssistantMessageEventStream();
	void ( async () => {
		for await ( const event of source ) {
			if ( event.type === 'error' && event.error.stopReason === 'error' ) {
				const summary =
					exchange.failure() ??
					classifyOpenAiStreamFailure( event.error.errorMessage ?? '', [ apiKey ] );
				event.error.errorMessage = describeOpenAiError( summary );
			}
			classified.push( event );
		}
		classified.end();
	} )();
	return classified;
}

// pi parses registerProvider values as templates (`$NAME`, a leading `!`).
function escapePiConfigValue( value: string ): string {
	const dollarEscaped = value.replace( /\$/g, () => '$$' );
	return dollarEscaped.startsWith( '!' ) ? `$${ dollarEscaped }` : dollarEscaped;
}

export function createOpenAiProviderConfig(
	model: Model< 'openai-responses' >,
	apiKey: string,
	settings: OpenAiTurnSettings
): ProviderConfigInput {
	if ( model.id !== ( settings.model as AiModelId ) ) {
		throw new Error( 'The OpenAI model and its turn settings disagree.' );
	}
	return {
		baseUrl: OPENAI_API_BASE_URL,
		apiKey: escapePiConfigValue( apiKey ),
		api: 'openai-responses',
		streamSimple: ( m, context, options?: SimpleStreamOptions ) => {
			const exchange = createOpenAiExchange( apiKey );
			return withOpenAiErrorsClassified(
				streamOpenAiResponses( m as Model< 'openai-responses' >, context, {
					...options,
					fetch: exchange.fetch,
					onPayload: async ( params: unknown, payloadModel ) => {
						const next = ( await options?.onPayload?.( params, payloadModel ) ) ?? params;
						return applyOpenAiTurnSettings( next, settings );
					},
				} ),
				exchange,
				apiKey
			);
		},
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				baseUrl: model.baseUrl,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				thinkingLevelMap: model.thinkingLevelMap,
				compat: model.compat,
			},
		],
	};
}
