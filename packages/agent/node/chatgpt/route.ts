import { ChatGptConnectionError } from '@studio/agent/node/chatgpt/account-store';
import { OPENAI_API_BASE_URL } from '@studio/agent/node/openai-model-list';
import {
	classifyChatGptHttpError,
	redactChatGptSecrets,
	type ChatGptErrorSummary,
} from '@studio/agent/protocol/chatgpt-errors';

/*
 * How Studio reaches the ChatGPT plan route (SIWC "Models and inference"):
 * only these two endpoints of the public API, never ChatGPT's backend-api;
 * the connection's current access token as the bearer, taken afresh for each
 * request and never kept; no account or client header besides; no redirects.
 */

export const CHATGPT_RESPONSES_URL = `${ OPENAI_API_BASE_URL }/responses`;
const CHATGPT_MODELS_URL = `${ OPENAI_API_BASE_URL }/models`;

/**
 * The waits before each new try of a request the route answered with 503, so
 * one try more than there are waits. Nothing streams from a 503, so a new try
 * repeats nothing; no other failure is tried again.
 */
export const CHATGPT_UNAVAILABLE_RETRY_DELAYS_MS: readonly number[] = [ 1_000, 3_000 ];

/** A current access token for the connection, for one request. */
export type ChatGptTokenSource = () => Promise< string >;

/** A `POST` of a JSON body to the Responses endpoint, or a `GET` of the model list. */
export type ChatGptRouteRequest = {
	getAccessToken: ChatGptTokenSource;
	signal?: AbortSignal;
} & ( { endpoint: 'responses'; body: string } | { endpoint: 'models' } );

export interface ChatGptRouteResponse {
	/** The response, whatever its status; an error response's body is still unread. */
	response: Response;
	/** The response's `x-request-id`. */
	requestId?: string;
	/** Why the request failed, when the response is an HTTP error. */
	failure?: ChatGptErrorSummary;
	/** Removes the tokens the request used from text, and anything token-shaped. */
	redact( text: string ): string;
}

/** A request that got no response: no token for it, or no connection. */
export class ChatGptRouteError extends Error {
	readonly summary: ChatGptErrorSummary;

	constructor( summary: ChatGptErrorSummary ) {
		super( summary.detail ?? summary.kind );
		this.name = 'ChatGptRouteError';
		this.summary = summary;
	}
}

/** Why a token source couldn't give a token, as a failure to show. */
export function summarizeChatGptTokenFailure(
	error: unknown,
	redact: ( text: string ) => string = redactChatGptSecrets
): ChatGptErrorSummary {
	if ( error instanceof ChatGptConnectionError ) {
		return { kind: 'credentials', code: error.code, detail: redact( error.message ) };
	}
	const message = ( error instanceof Error ? error.message : String( error ) ).trim();
	return { kind: 'credentials', ...( message ? { detail: redact( message ) } : {} ) };
}

function describeNetworkFailure( error: unknown ): string {
	const message = error instanceof Error ? error.message : String( error );
	const cause = error instanceof Error ? ( error as { cause?: unknown } ).cause : undefined;
	return cause instanceof Error ? `${ message }: ${ cause.message }` : message;
}

// The token source doesn't take a signal; a canceled request stops waiting for it.
function untilAborted< T >( promise: Promise< T >, signal: AbortSignal | undefined ): Promise< T > {
	if ( ! signal ) {
		return promise;
	}
	return new Promise< T >( ( resolve, reject ) => {
		const onAbort = () => reject( signal.reason );
		signal.addEventListener( 'abort', onAbort, { once: true } );
		promise.then( resolve, reject ).finally( () => signal.removeEventListener( 'abort', onAbort ) );
	} );
}

function sleep( ms: number, signal: AbortSignal | undefined ): Promise< void > {
	return new Promise< void >( ( resolve, reject ) => {
		if ( signal?.aborted ) {
			reject( signal.reason );
			return;
		}
		const timer = setTimeout( () => {
			signal?.removeEventListener( 'abort', onAbort );
			resolve();
		}, ms );
		function onAbort() {
			clearTimeout( timer );
			reject( signal?.reason );
		}
		signal?.addEventListener( 'abort', onAbort, { once: true } );
	} );
}

function parseJson( text: string ): unknown {
	try {
		return JSON.parse( text );
	} catch {
		return undefined;
	}
}

/**
 * Sends one request to the ChatGPT plan route, trying a 503 again after each
 * of `CHATGPT_UNAVAILABLE_RETRY_DELAYS_MS`, with a fresh token each time.
 * Resolves with the response whatever its status, an HTTP error classified.
 * Throws `ChatGptRouteError` when no response came, and the abort reason when
 * `signal` aborts.
 */
export async function sendChatGptRequest(
	request: ChatGptRouteRequest
): Promise< ChatGptRouteResponse > {
	const { signal } = request;
	const tokens: string[] = [];
	const redact = ( text: string ) => redactChatGptSecrets( text, tokens );
	for ( let attempt = 0; ; attempt++ ) {
		let token: string;
		try {
			signal?.throwIfAborted();
			token = await untilAborted( request.getAccessToken(), signal );
		} catch ( error ) {
			if ( signal?.aborted ) {
				throw error;
			}
			throw new ChatGptRouteError( summarizeChatGptTokenFailure( error, redact ) );
		}
		tokens.push( token );
		let response: Response;
		try {
			response =
				request.endpoint === 'responses'
					? await fetch( CHATGPT_RESPONSES_URL, {
							method: 'POST',
							headers: { authorization: `Bearer ${ token }`, 'content-type': 'application/json' },
							body: request.body,
							redirect: 'error',
							signal,
					  } )
					: await fetch( CHATGPT_MODELS_URL, {
							method: 'GET',
							headers: { authorization: `Bearer ${ token }` },
							redirect: 'error',
							signal,
					  } );
		} catch ( error ) {
			if ( signal?.aborted ) {
				throw error;
			}
			throw new ChatGptRouteError( {
				kind: 'network',
				detail: redact( describeNetworkFailure( error ) ),
			} );
		}
		const requestId = response.headers.get( 'x-request-id' ) ?? undefined;
		const delay = CHATGPT_UNAVAILABLE_RETRY_DELAYS_MS[ attempt ];
		if ( response.status === 503 && delay !== undefined ) {
			await response.body?.cancel().catch( () => undefined );
			await sleep( delay, signal );
			continue;
		}
		if ( response.ok ) {
			return { response, requestId, redact };
		}
		// Read once to classify, then handed on with the same body.
		const text = await response.text().catch( () => '' );
		return {
			response: new Response( text, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			} ),
			requestId,
			failure: classifyChatGptHttpError( response.status, parseJson( text ), {
				requestId,
				secrets: tokens,
			} ),
			redact,
		};
	}
}
