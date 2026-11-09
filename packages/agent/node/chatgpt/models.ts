import { __, sprintf } from '@wordpress/i18n';
import { getChatGptAccessToken } from '@studio/agent/node/chatgpt/credential-broker';
import {
	ChatGptRouteError,
	sendChatGptRequest,
	type ChatGptRouteResponse,
	type ChatGptTokenSource,
} from '@studio/agent/node/chatgpt/route';
import { redactChatGptSecrets } from '@studio/agent/protocol/chatgpt-errors';
import {
	getOpenAiReasoningEffortLabel,
	isOpenAiReasoningEffort,
	OPENAI_MODEL_CAPABILITIES,
	type OpenAiModelId,
	type OpenAiReasoningEffort,
	type OpenAiReasoningMode,
} from '@studio/agent/protocol/openai-models';
import type { ChatGptErrorSummary } from '@studio/agent/protocol/chatgpt-errors';
import type {
	ChatGptModelAvailability,
	ProviderModelRef,
} from '@studio/agent/protocol/connections';

const MODEL_LIST_TIMEOUT_MS = 15_000;

/** What a model accepts on the ChatGPT route, as far as Studio knows. */
export interface ChatGptModelCapabilities {
	/** `reasoning.effort` values the model accepts, lowest first. */
	reasoningEfforts: readonly OpenAiReasoningEffort[];
	/**
	 * `reasoning.mode` values the model accepts. The transport sends no mode, so
	 * every request runs in the default, standard one.
	 */
	reasoningModes: readonly OpenAiReasoningMode[];
	/** Accepts image input, so screenshot tools may be offered. */
	imageInput: boolean;
}

// The API catalog's values for the model of the same name, without what only
// the API takes: its model name and output cap (this route takes no
// `max_output_tokens`), and its context limits.
function seedFromApiCatalog( model: OpenAiModelId ): ChatGptModelCapabilities {
	const { reasoningEfforts, reasoningModes, imageInput } = OPENAI_MODEL_CAPABILITIES[ model ];
	return { reasoningEfforts, reasoningModes, imageInput };
}

/**
 * The ChatGPT-route models Studio supports, by the slug the route lists them
 * under. The route's model list carries no capabilities (SIWC "Models and
 * inference"), so a listed model is offered only when it is here: Studio
 * never guesses what a model accepts.
 */
export const CHATGPT_MODEL_CAPABILITIES: Readonly< Record< string, ChatGptModelCapabilities > > = {
	'gpt-6.1-sol': seedFromApiCatalog( 'gpt-6.1-sol' ),
	'gpt-6-astra': seedFromApiCatalog( 'gpt-6-astra' ),
	'gpt-6.1-terra': seedFromApiCatalog( 'gpt-6.1-terra' ),
	'gpt-6-luna': seedFromApiCatalog( 'gpt-6-luna' ),
};

export function getChatGptModelCapabilities( slug: string ): ChatGptModelCapabilities | undefined {
	return Object.prototype.hasOwnProperty.call( CHATGPT_MODEL_CAPABILITIES, slug )
		? CHATGPT_MODEL_CAPABILITIES[ slug ]
		: undefined;
}

/** A model one ChatGPT connection lists, named as the route names it. */
export interface ChatGptCatalogModel extends ProviderModelRef {
	providerId: 'chatgpt-oauth';
	/** The route's `display_name`, for the model picker. */
	label: string;
	capabilities: ChatGptModelCapabilities;
}

export type ChatGptModelListResult =
	| { ok: true; models: ChatGptCatalogModel[] }
	| { ok: false; error: ChatGptErrorSummary };

const isRecord = ( value: unknown ): value is Record< string, unknown > =>
	typeof value === 'object' && value !== null && ! Array.isArray( value );

/** The `models` array of the route's envelope, or null when the body isn't one. */
function parseModelEntries( text: string ): unknown[] | null {
	let body: unknown;
	try {
		body = JSON.parse( text );
	} catch {
		return null;
	}
	const models = isRecord( body ) ? body.models : undefined;
	return Array.isArray( models ) ? models : null;
}

function toCatalogModels( entries: unknown[] ): ChatGptCatalogModel[] {
	const models: ChatGptCatalogModel[] = [];
	for ( const entry of entries ) {
		if ( ! isRecord( entry ) || entry.visibility !== 'list' || typeof entry.slug !== 'string' ) {
			continue;
		}
		const slug = entry.slug;
		const capabilities = getChatGptModelCapabilities( slug );
		if ( ! capabilities || models.some( ( model ) => model.modelId === slug ) ) {
			continue;
		}
		const label =
			typeof entry.display_name === 'string' && entry.display_name.trim()
				? entry.display_name
				: slug;
		models.push( { providerId: 'chatgpt-oauth', modelId: slug, label, capabilities } );
	}
	return models;
}

/**
 * The models one ChatGPT connection may use: the route's `GET /v1/models`,
 * read with that connection's token, keeping the models meant for display in
 * the server's order, and of those only the ones Studio has capabilities for.
 * A list that arrives broken or in another shape is a failure, never a
 * shorter or empty list.
 */
export async function fetchChatGptModels(
	connectionId: string,
	signal?: AbortSignal,
	options: { getAccessToken?: ChatGptTokenSource } = {}
): Promise< ChatGptModelListResult > {
	const timeout = AbortSignal.timeout( MODEL_LIST_TIMEOUT_MS );
	let result: ChatGptRouteResponse;
	try {
		result = await sendChatGptRequest( {
			endpoint: 'models',
			getAccessToken: options.getAccessToken ?? ( () => getChatGptAccessToken( connectionId ) ),
			signal: signal ? AbortSignal.any( [ signal, timeout ] ) : timeout,
		} );
	} catch ( error ) {
		if ( error instanceof ChatGptRouteError ) {
			return { ok: false, error: error.summary };
		}
		if ( signal?.aborted ) {
			return { ok: false, error: { kind: 'cancelled' } };
		}
		return {
			ok: false,
			error: {
				kind: 'network',
				detail: timeout.aborted
					? __( 'The request timed out.' )
					: redactChatGptSecrets( error instanceof Error ? error.message : String( error ) ),
			},
		};
	}
	if ( result.failure ) {
		return { ok: false, error: result.failure };
	}
	const requestId = result.requestId ? { requestId: result.requestId } : {};
	let text: string;
	try {
		text = await result.response.text();
	} catch {
		return {
			ok: false,
			error: {
				kind: 'interrupted',
				...requestId,
				detail: __( 'The model list stopped partway through.' ),
			},
		};
	}
	const entries = parseModelEntries( text );
	if ( ! entries ) {
		return {
			ok: false,
			error: {
				kind: 'invalid-response',
				...requestId,
				detail: __( 'The model list wasn’t in the form ChatGPT documents.' ),
			},
		};
	}
	return { ok: true, models: toCatalogModels( entries ) };
}

/**
 * The availability to keep after reading one connection's model list. A
 * failed read keeps the last good list only when that list was read for the
 * same registration at the same revision: one registration's list never
 * shows for another, nor for the same one signed in again under another
 * issued client.
 */
export function applyChatGptModelList(
	previous: ChatGptModelAvailability | null | undefined,
	target: { connectionId: string; revision: number },
	result: ChatGptModelListResult,
	checkedAt: string = new Date().toISOString()
): ChatGptModelAvailability {
	const { connectionId, revision } = target;
	if ( result.ok ) {
		return {
			connectionId,
			revision,
			checkedAt,
			models: result.models.map( ( model ) => ( { id: model.modelId, label: model.label } ) ),
			lastError: null,
		};
	}
	const same = previous?.connectionId === connectionId && previous.revision === revision;
	return {
		connectionId,
		revision,
		checkedAt: same ? previous.checkedAt : null,
		models: same ? previous.models : null,
		lastError: result.error,
	};
}

export type ChatGptReasoningProblem =
	| { code: 'unknown-model'; model: string }
	| {
			code: 'unsupported-effort';
			model: string;
			effort: string;
			supported: readonly OpenAiReasoningEffort[];
	  };

/**
 * Checks one model and effort against the ChatGPT capability table. Nothing
 * is adjusted: an effort the model doesn't list is a problem to show, never
 * a nearby effort sent instead.
 */
export function resolveChatGptReasoning(
	model: string,
	effort: string
): { ok: true; effort: OpenAiReasoningEffort } | { ok: false; problem: ChatGptReasoningProblem } {
	const capabilities = getChatGptModelCapabilities( model );
	if ( ! capabilities ) {
		return { ok: false, problem: { code: 'unknown-model', model } };
	}
	if ( ! isOpenAiReasoningEffort( effort ) || ! capabilities.reasoningEfforts.includes( effort ) ) {
		return {
			ok: false,
			problem: {
				code: 'unsupported-effort',
				model,
				effort,
				supported: capabilities.reasoningEfforts,
			},
		};
	}
	return { ok: true, effort };
}

export function describeChatGptReasoningProblem( problem: ChatGptReasoningProblem ): string {
	switch ( problem.code ) {
		case 'unknown-model':
			return sprintf(
				/* translators: %s: a ChatGPT model id Studio does not support. */
				__( 'Studio doesn’t support the ChatGPT model “%s”. Choose another model to continue.' ),
				problem.model
			);
		case 'unsupported-effort':
			return sprintf(
				/* translators: 1: ChatGPT model id, 2: the requested reasoning effort, 3: comma-separated list of supported efforts. */
				__( '%1$s doesn’t support “%2$s” reasoning with ChatGPT. Choose one of: %3$s.' ),
				problem.model,
				isOpenAiReasoningEffort( problem.effort )
					? getOpenAiReasoningEffortLabel( problem.effort )
					: problem.effort,
				problem.supported.map( getOpenAiReasoningEffortLabel ).join( ', ' )
			);
	}
}
