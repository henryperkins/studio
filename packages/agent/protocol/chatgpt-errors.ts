import { __, sprintf } from '@wordpress/i18n';
import { redactOpenAiSecrets } from '@studio/agent/protocol/openai-errors';

/**
 * Why a request to the ChatGPT plan route failed, by what the user can do
 * about it. The route's own codes are in the SIWC "Errors and recovery" page.
 */
export type ChatGptErrorKind =
	// HTTP 401: the signed identity or plan permission wasn't accepted.
	| 'authorization'
	// HTTP 403: not eligible, a policy or region check, an unsupported route, or a grant.
	| 'forbidden'
	| 'usage-limit'
	// HTTP 429 without the usage-limit code.
	| 'rate-limit'
	// HTTP 503, or a code saying usage or the user couldn't be checked.
	| 'unavailable'
	| 'unsupported-capability'
	| 'invalid-request'
	| 'server'
	| 'network'
	// The connection's sign-in couldn't give a token: signed out, expired, locked.
	| 'credentials'
	// Studio didn't send the request: it would have broken the route's rules.
	| 'refused'
	// The stream ended with `response.incomplete`.
	| 'incomplete'
	// `response.failed` or an `error` event with a code Studio has no advice for.
	| 'failed'
	// The connection dropped mid-stream.
	| 'interrupted'
	// The stream ended without a terminal event.
	| 'no-completion'
	| 'invalid-response'
	| 'cancelled';

export interface ChatGptErrorSummary {
	kind: ChatGptErrorKind;
	/** The HTTP status, when the request got an error response. */
	status?: number;
	/**
	 * The route's machine-readable reason: `error.code`, or for an incomplete
	 * response its `incomplete_details.reason`. For `credentials`, the sign-in's
	 * own code.
	 */
	code?: string;
	/** The request field the route refused (`error.param`), when it named one. */
	param?: string;
	/** The response's `x-request-id`, for OpenAI support. */
	requestId?: string;
	/**
	 * Diagnostic text with anything token-shaped removed: a `{ "detail": … }`
	 * body, the error's message, or why the sign-in couldn't be used. Never kept
	 * for an authorization failure, whose text can quote the credential.
	 */
	detail?: string;
	/** Part of the reply had streamed before the failure; it is kept, incomplete. */
	partial?: boolean;
}

// Where a ChatGPT user checks the usage limits plan requests count toward.
const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

const MAX_DETAIL_LENGTH = 500;
const MAX_REFERENCE_LENGTH = 64;

// Server-supplied reference fields enter messages, records and logs, so they
// are kept only as a short, safe token: anything else becomes an underscore.
function toSafeReference(
	text: string | undefined,
	secrets: readonly string[]
): string | undefined {
	if ( ! text ) {
		return undefined;
	}
	const safe = redactChatGptSecrets( text, secrets )
		.replace( /[^A-Za-z0-9._-]/g, '_' )
		.slice( 0, MAX_REFERENCE_LENGTH );
	return safe || undefined;
}
// A JSON Web Token: the shape OpenAI's sample access-token payload suggests.
const JWT_SHAPED = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g;

/** Removes the given secrets and anything shaped like a key, bearer header or token. */
export function redactChatGptSecrets( text: string, secrets: readonly string[] = [] ): string {
	return redactOpenAiSecrets( text, secrets ).replace( JWT_SHAPED, '[redacted]' );
}

// The codes the SIWC pages give recovery advice for, and the public stream
// failure codes whose advice is the same as elsewhere.
const CODE_KINDS: Readonly< Record< string, ChatGptErrorKind > > = {
	subscription_sharing_invalid_user: 'authorization',
	subscription_sharing_user_not_eligible: 'forbidden',
	subscription_sharing_route_not_supported: 'forbidden',
	chatpass_v2_scope_not_authorized: 'forbidden',
	chatpass_v2_invalid_authorization_context: 'forbidden',
	subscription_sharing_usage_limit_exceeded: 'usage-limit',
	subscription_sharing_usage_unavailable: 'unavailable',
	subscription_sharing_user_unavailable: 'unavailable',
	subscription_sharing_unsupported_capability: 'unsupported-capability',
	rate_limit_exceeded: 'rate-limit',
	server_error: 'server',
	invalid_prompt: 'invalid-request',
};

const isRecord = ( value: unknown ): value is Record< string, unknown > =>
	typeof value === 'object' && value !== null && ! Array.isArray( value );

const readString = ( value: unknown ) =>
	typeof value === 'string' && value.trim() ? value : undefined;

function kindForCode( code: string | undefined ): ChatGptErrorKind | undefined {
	return code && Object.prototype.hasOwnProperty.call( CODE_KINDS, code )
		? CODE_KINDS[ code ]
		: undefined;
}

function kindForStatus( status: number ): ChatGptErrorKind {
	switch ( status ) {
		case 401:
			return 'authorization';
		case 403:
			return 'forbidden';
		case 429:
			return 'rate-limit';
		case 503:
			return 'unavailable';
	}
	if ( status === 408 || status >= 500 ) {
		return 'server';
	}
	return status >= 400 ? 'invalid-request' : 'invalid-response';
}

function toDetail( text: string | undefined, secrets: readonly string[] ): string | undefined {
	if ( ! text?.trim() ) {
		return undefined;
	}
	const redacted = redactChatGptSecrets( text.trim(), secrets );
	return redacted.length > MAX_DETAIL_LENGTH
		? `${ redacted.slice( 0, MAX_DETAIL_LENGTH ) }…`
		: redacted;
}

// A summary from an `error` object's fields, wherever the route put them.
// The code and param are the route's text too: they are shown to the user, so
// anything token-shaped comes out of them as it does out of the detail.
function summarizeErrorFields(
	fields: Record< string, unknown >,
	fallback: ChatGptErrorKind,
	text: string | undefined,
	secrets: readonly string[]
): ChatGptErrorSummary {
	const code = readString( fields.code );
	const param = readString( fields.param );
	const kind = kindForCode( code ) ?? fallback;
	const detail = kind === 'authorization' ? undefined : toDetail( text, secrets );
	const safeCode = toSafeReference( code, secrets );
	const safeParam = toSafeReference( param, secrets );
	return {
		kind,
		...( safeCode ? { code: safeCode } : {} ),
		...( safeParam ? { param: safeParam } : {} ),
		...( detail ? { detail } : {} ),
	};
}

/**
 * Classifies an HTTP error response from the ChatGPT route. Before a stream
 * opens, the body can be `{ "detail": … }` (diagnostic text, not a code) or
 * the Responses `{ "error": { code, param, message } }`.
 */
export function classifyChatGptHttpError(
	status: number,
	body: unknown,
	options: { requestId?: string; secrets?: readonly string[] } = {}
): ChatGptErrorSummary {
	const error = isRecord( body ) && isRecord( body.error ) ? body.error : {};
	let text = readString( error.message );
	if ( isRecord( body ) && body.detail !== undefined ) {
		text = typeof body.detail === 'string' ? body.detail : JSON.stringify( body.detail );
	}
	const summary = summarizeErrorFields(
		error,
		kindForStatus( status ),
		// A 401's text can quote the rejected credential, whatever its code.
		status === 401 ? undefined : text,
		options.secrets ?? []
	);
	return {
		...summary,
		status,
		...( options.requestId ? { requestId: options.requestId } : {} ),
	};
}

/**
 * Classifies one event of a ChatGPT response stream: a summary for
 * `response.failed`, `response.incomplete` and `error`, undefined for any
 * other event. Its detail has anything token-shaped removed; the caller
 * removes the request's own token.
 */
export function classifyChatGptStreamEvent( event: unknown ): ChatGptErrorSummary | undefined {
	if ( ! isRecord( event ) ) {
		return undefined;
	}
	const response = isRecord( event.response ) ? event.response : {};
	const fromFields = ( fields: Record< string, unknown > ) =>
		summarizeErrorFields( fields, 'failed', readString( fields.message ), [] );
	switch ( event.type ) {
		case 'response.incomplete': {
			const details = isRecord( response.incomplete_details ) ? response.incomplete_details : {};
			const reason = readString( details.reason );
			const safeReason = toSafeReference( reason, [] );
			return {
				kind: 'incomplete',
				...( safeReason ? { code: safeReason } : {} ),
			};
		}
		case 'response.failed':
			return isRecord( response.error ) ? fromFields( response.error ) : { kind: 'failed' };
		case 'error':
			// Read as the OpenAI SDK reads an `error` event: its `error`, else itself.
			return fromFields( isRecord( event.error ) ? event.error : event );
	}
	return undefined;
}

function getForbiddenExplanation( code: string | undefined ): string {
	switch ( code ) {
		case 'subscription_sharing_user_not_eligible':
			return __(
				'ChatGPT plan usage isn’t available for this account, its workspace or its policy, so Studio won’t send this request again. To keep working, start a new chat with another provider.'
			);
		case 'subscription_sharing_route_not_supported':
			return __(
				'ChatGPT plan usage doesn’t accept the kind of request Studio sent. Please report this to the Studio team.'
			);
		case 'chatpass_v2_scope_not_authorized':
		case 'chatpass_v2_invalid_authorization_context':
			return __(
				'ChatGPT didn’t authorize Studio to use your plan for this request. Sign in to ChatGPT again and allow Studio to use your plan.'
			);
		default:
			return __(
				'ChatGPT refused this request with a policy or permission check, such as where it can be served.'
			);
	}
}

function getExplanation( error: ChatGptErrorSummary ): string {
	switch ( error.kind ) {
		case 'authorization':
			return __(
				'ChatGPT didn’t accept the sign-in for this account. Check that you’re signed in to the right ChatGPT account and that you allowed Studio to use your plan. If this keeps happening, sign in to ChatGPT again.'
			);
		case 'forbidden':
			return getForbiddenExplanation( error.code );
		case 'usage-limit':
			return sprintf(
				/* translators: %s: the address of the user's ChatGPT usage settings. */
				__(
					'You’ve reached a ChatGPT usage limit, which can be your plan’s or one for apps like Studio. Check your usage at %s before sending more.'
				),
				CHATGPT_USAGE_URL
			);
		case 'rate-limit':
			return __(
				'ChatGPT is limiting requests just now. Wait a moment, then send your message again.'
			);
		case 'unavailable':
			return __(
				'ChatGPT plan usage is unavailable right now. Your sign-in is kept; try again in a few minutes.'
			);
		case 'unsupported-capability':
			return error.param
				? sprintf(
						/* translators: %s: the name of the request field ChatGPT doesn't support, e.g. "tools". */
						__(
							'ChatGPT plan usage doesn’t support part of this request (%s), so Studio won’t send it again unchanged.'
						),
						error.param
				  )
				: __(
						'ChatGPT plan usage doesn’t support part of this request, so Studio won’t send it again unchanged.'
				  );
		case 'invalid-request':
			return __( 'ChatGPT rejected the request.' );
		case 'server':
			return __( 'ChatGPT had a server error. Try again in a moment.' );
		case 'network':
			return __( 'Couldn’t reach ChatGPT. Check your connection and try again.' );
		case 'credentials':
			return error.detail ?? __( 'Studio couldn’t use your ChatGPT sign-in for this request.' );
		case 'refused':
			return error.detail ?? __( 'Studio didn’t send this request to ChatGPT.' );
		case 'incomplete':
			return __( 'ChatGPT stopped before finishing its reply.' );
		case 'failed':
			return __( 'ChatGPT couldn’t finish its reply.' );
		case 'interrupted':
			return __( 'The connection to ChatGPT dropped before the response finished.' );
		case 'no-completion':
			return __( 'ChatGPT’s reply ended before ChatGPT confirmed it was complete.' );
		case 'invalid-response':
			return __( 'ChatGPT sent a response Studio couldn’t read.' );
		case 'cancelled':
			return __( 'The ChatGPT request was canceled.' );
	}
}

// The explanation already is the detail for these.
const DETAIL_IS_EXPLANATION: readonly ChatGptErrorKind[] = [ 'credentials', 'refused' ];

/**
 * What went wrong and what the user can do, then the route's untranslated
 * reference (status, code, param, request id) and its diagnostic text.
 */
export function describeChatGptError( error: ChatGptErrorSummary ): string {
	const reference = [
		error.status ? `HTTP ${ error.status }` : '',
		error.code ?? '',
		error.param ? `param ${ error.param }` : '',
		error.requestId ? `request ${ error.requestId }` : '',
	].filter( Boolean );
	return [
		getExplanation( error ),
		error.partial ? __( 'The partial reply is kept but incomplete.' ) : '',
		reference.length ? `(${ reference.join( ', ' ) })` : '',
		DETAIL_IS_EXPLANATION.includes( error.kind ) ? '' : error.detail ?? '',
	]
		.filter( Boolean )
		.join( ' ' );
}
