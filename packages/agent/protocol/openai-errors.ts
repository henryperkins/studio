import { __ } from '@wordpress/i18n';

export type OpenAiErrorKind =
	| 'authentication'
	| 'permission'
	| 'model-unavailable'
	| 'invalid-request'
	| 'rate-limit'
	| 'quota'
	| 'server'
	| 'network'
	| 'cancelled'
	| 'interrupted'
	| 'unknown';

export interface OpenAiErrorSummary {
	kind: OpenAiErrorKind;
	/** The HTTP status, when the failure was an HTTP response. */
	status?: number;
	/** OpenAI's error code, e.g. `insufficient_quota`, when it sent one. */
	code?: string;
	/**
	 * OpenAI's own explanation with anything key-shaped removed. Never kept for
	 * authentication failures, whose text quotes part of the rejected key.
	 */
	detail?: string;
}

// OpenAI keys (`sk-…`, `sk-proj-…`) and bearer headers. Error text from the
// API can quote part of a rejected key.
const KEY_SHAPED = /\bsk-[A-Za-z0-9_*.-]{4,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9_*.-]+/gi;
const MAX_DETAIL_LENGTH = 500;

/** Removes the given secrets and anything shaped like an OpenAI key or bearer token. */
export function redactOpenAiSecrets( text: string, secrets: readonly string[] = [] ): string {
	let redacted = text;
	for ( const secret of secrets ) {
		if ( secret ) {
			redacted = redacted.split( secret ).join( '[redacted]' );
		}
	}
	return redacted.replace( KEY_SHAPED, '[redacted]' ).replace( BEARER, 'Bearer [redacted]' );
}

/** A failed request that never got a response, e.g. offline or DNS failure. */
export function summarizeOpenAiNetworkFailure(
	error: unknown,
	secrets: readonly string[] = []
): OpenAiErrorSummary {
	const message = error instanceof Error ? error.message : String( error );
	const cause = error instanceof Error ? ( error as { cause?: unknown } ).cause : undefined;
	const causeMessage = cause instanceof Error ? `: ${ cause.message }` : '';
	return { kind: 'network', detail: redactOpenAiSecrets( message + causeMessage, secrets ) };
}

function readErrorObject( body: unknown ): { message?: string; type?: string; code?: string } {
	const error =
		body && typeof body === 'object' && 'error' in body
			? ( body as { error?: unknown } ).error
			: undefined;
	if ( ! error || typeof error !== 'object' ) {
		return {};
	}
	const { message, type, code } = error as Record< string, unknown >;
	return {
		message: typeof message === 'string' ? message : undefined,
		type: typeof type === 'string' ? type : undefined,
		code: typeof code === 'string' ? code : undefined,
	};
}

function toDetail( message: string | undefined, secrets: readonly string[] ): string | undefined {
	if ( ! message?.trim() ) {
		return undefined;
	}
	const redacted = redactOpenAiSecrets( message.trim(), secrets );
	return redacted.length > MAX_DETAIL_LENGTH
		? `${ redacted.slice( 0, MAX_DETAIL_LENGTH ) }…`
		: redacted;
}

/** Classifies an HTTP error response from the OpenAI API. */
export function classifyOpenAiHttpError(
	status: number,
	body: unknown,
	secrets: readonly string[] = []
): OpenAiErrorSummary {
	const error = readErrorObject( body );
	const code = error.code ?? error.type;
	const detail = toDetail( error.message, secrets );
	if ( status === 401 ) {
		return { kind: 'authentication', status, code };
	}
	if ( status === 403 ) {
		return { kind: 'permission', status, code, detail };
	}
	if ( status === 404 || code === 'model_not_found' ) {
		return { kind: 'model-unavailable', status, code, detail };
	}
	if ( status === 429 ) {
		const isQuota = code === 'insufficient_quota' || error.type === 'insufficient_quota';
		return { kind: isQuota ? 'quota' : 'rate-limit', status, code, detail };
	}
	if ( status === 408 || status === 409 || status >= 500 ) {
		return { kind: 'server', status, code, detail };
	}
	if ( status >= 400 ) {
		return { kind: 'invalid-request', status, code, detail };
	}
	return { kind: 'unknown', status, code, detail };
}

const STREAM_FAILURE_CODES: Record< string, OpenAiErrorKind > = {
	rate_limit_exceeded: 'rate-limit',
	insufficient_quota: 'quota',
	server_error: 'server',
	model_not_found: 'model-unavailable',
	invalid_request_error: 'invalid-request',
	invalid_prompt: 'invalid-request',
};

/**
 * Classifies a failure reported inside an HTTP 200 stream (`response.failed`,
 * an `error` event, or a stream that stopped early), from pi's message text.
 */
export function classifyOpenAiStreamFailure(
	message: string,
	secrets: readonly string[] = []
): OpenAiErrorSummary {
	const leadingCode = /^(?:Error Code\s+)?([a-z_]+):/i.exec( message.trim() )?.[ 1 ];
	if ( leadingCode && STREAM_FAILURE_CODES[ leadingCode ] ) {
		return {
			kind: STREAM_FAILURE_CODES[ leadingCode ],
			code: leadingCode,
			detail: toDetail( message, secrets ),
		};
	}
	if ( /ended before|ended without|stream (?:was )?interrupted|terminated/i.test( message ) ) {
		return { kind: 'interrupted', detail: toDetail( message, secrets ) };
	}
	return { kind: 'unknown', detail: toDetail( message, secrets ) };
}

// pi decides whether to retry a failed turn by matching English words in the
// error text, while the explanation above them is translated. These untranslated
// markers carry that decision whatever the locale: the retried kinds name a
// status or code pi retries on, and quota names `insufficient_quota`, which pi
// never retries.
const RETRY_MARKERS: Partial< Record< OpenAiErrorKind, string > > = {
	'rate-limit': 'rate_limit_exceeded',
	quota: 'insufficient_quota',
	server: 'server_error',
	network: 'network_error',
	interrupted: 'stream ended without completion',
};

function getReference( error: OpenAiErrorSummary ): string {
	const marker = RETRY_MARKERS[ error.kind ];
	const parts = [
		error.status ? `HTTP ${ error.status }` : '',
		error.code ?? '',
		marker && marker !== error.code ? marker : '',
	].filter( Boolean );
	return parts.length ? `(${ parts.join( ', ' ) })` : '';
}

function compose( explanation: string, error: OpenAiErrorSummary ): string {
	return [ explanation, getReference( error ), error.detail ?? '' ].filter( Boolean ).join( ' ' );
}

/** A user-facing explanation with the way forward, plus the untranslated reference. */
export function describeOpenAiError( error: OpenAiErrorSummary ): string {
	switch ( error.kind ) {
		case 'authentication':
			return compose( __( 'OpenAI didn’t accept the API key. Replace it in Settings → AI.' ), {
				...error,
				detail: undefined,
			} );
		case 'permission':
			return compose(
				__(
					'The OpenAI API key doesn’t have permission for this. Check the key’s permissions and the project’s model access on platform.openai.com.'
				),
				error
			);
		case 'model-unavailable':
			return compose(
				__(
					'This model isn’t available to your OpenAI project. Choose another model, or refresh the model list in Settings → AI.'
				),
				error
			);
		case 'invalid-request':
			return compose( __( 'OpenAI rejected the request.' ), error );
		case 'rate-limit':
			return compose( __( 'OpenAI rate limit reached. Wait a moment, then try again.' ), error );
		case 'quota':
			return compose(
				__(
					'Your OpenAI project is out of quota. Check billing and usage limits on platform.openai.com.'
				),
				error
			);
		case 'server':
			return compose( __( 'OpenAI had a server error. Try again in a moment.' ), error );
		case 'network':
			return compose( __( 'Couldn’t reach OpenAI. Check your connection and try again.' ), error );
		case 'cancelled':
			return __( 'The OpenAI request was canceled.' );
		case 'interrupted':
			return compose( __( 'The OpenAI response stream stopped early. Try again.' ), error );
		case 'unknown':
			return compose( __( 'The OpenAI request failed.' ), error );
	}
}
