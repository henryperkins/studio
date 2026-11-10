import { __ } from '@wordpress/i18n';
import {
	getChatGptAccessToken,
	invalidateChatGptAccessToken,
} from '@studio/agent/node/chatgpt/credential-broker';
import {
	ChatGptRouteError,
	sendChatGptRequest,
	type ChatGptRouteResponse,
	type ChatGptTokenSource,
} from '@studio/agent/node/chatgpt/route';
import { redactChatGptSecrets } from '@studio/agent/protocol/chatgpt-errors';
import {
	getChatGptModelCapabilities,
	type ChatGptModelCapabilities,
} from '@studio/agent/protocol/chatgpt-models';
import type { ChatGptErrorSummary } from '@studio/agent/protocol/chatgpt-errors';
import type {
	ChatGptModelAvailability,
	ProviderModelRef,
} from '@studio/agent/protocol/connections';

export {
	CHATGPT_MODEL_CAPABILITIES,
	describeChatGptReasoningProblem,
	getChatGptModelCapabilities,
	resolveChatGptReasoning,
	type ChatGptModelCapabilities,
	type ChatGptReasoningProblem,
} from '@studio/agent/protocol/chatgpt-models';

const MODEL_LIST_TIMEOUT_MS = 15_000;

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
	options: {
		getAccessToken?: ChatGptTokenSource;
		invalidateAccessToken?: ( rejectedAccessToken: string ) => Promise< void >;
	} = {}
): Promise< ChatGptModelListResult > {
	const timeout = AbortSignal.timeout( MODEL_LIST_TIMEOUT_MS );
	let result: ChatGptRouteResponse;
	try {
		result = await sendChatGptRequest( {
			endpoint: 'models',
			getAccessToken: options.getAccessToken ?? ( () => getChatGptAccessToken( connectionId ) ),
			invalidateAccessToken:
				options.invalidateAccessToken ??
				( ( token ) => invalidateChatGptAccessToken( connectionId, token ) ),
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
