import {
	CHATGPT_TERMINAL_REFRESH_ERRORS,
	type ChatGptTokenClient,
	type ChatGptTokenServiceResult,
	type ChatGptTokenSet,
} from '@studio/agent/node/chatgpt/credential-broker';

/**
 * OpenAI's authorization server for Sign in with ChatGPT, over HTTP: the
 * discovery document, which alone names the endpoints Studio uses, and the
 * token and revocation endpoints. A redirect is refused rather than followed.
 * Nothing here logs a token or puts one in an error.
 */

// The only issuer Studio accepts, for discovery and ID tokens alike.
const CHATGPT_ISSUER = 'https://auth.openai.com';
/** What ChatGPT plan tokens are for. */
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
const DISCOVERY_URL = `${ CHATGPT_ISSUER }/.well-known/openid-configuration`;
const REQUEST_TIMEOUT_MS = 30_000;
// Endpoints rarely move: renewals and sign-outs look them up again this often.
const DISCOVERY_CACHE_MS = 60 * 60_000;
// An error code, as opposed to anything else a server might put there.
const ERROR_CODE = /^[\w.-]{1,100}$/;

/** The endpoints the discovery document names. */
export interface ChatGptAuthServer {
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	revocationEndpoint: string;
	jwksUri: string;
}

type FormResponse = { reached: true; status: number; body: unknown } | { reached: false };

const isRecord = ( value: unknown ): value is Record< string, unknown > =>
	typeof value === 'object' && value !== null && ! Array.isArray( value );

const isNonEmptyString = ( value: unknown ): value is string =>
	typeof value === 'string' && value !== '';

function withTimeout( signal?: AbortSignal ): AbortSignal {
	const timeout = AbortSignal.timeout( REQUEST_TIMEOUT_MS );
	return signal ? AbortSignal.any( [ signal, timeout ] ) : timeout;
}

function parseJson( text: string ): unknown {
	try {
		return JSON.parse( text );
	} catch {
		return undefined;
	}
}

// An endpoint is served the way the discovery document was: https from OpenAI.
function readEndpoint( value: unknown, protocol: string ): string {
	if ( typeof value === 'string' ) {
		try {
			const url = new URL( value );
			if ( url.protocol === protocol && ! url.username && ! url.password && ! url.hash ) {
				return url.href;
			}
		} catch {
			// Not a URL.
		}
	}
	throw new Error( 'The discovery document names an endpoint Studio can’t use.' );
}

/**
 * Reads the discovery document, which must name OpenAI as its issuer, for the
 * endpoints a sign-in, a renewal and a sign-out use. Throws when it can't be
 * read or doesn't qualify; there is no fallback.
 */
export async function discoverChatGptAuthServer(
	discoveryUrl: string = DISCOVERY_URL,
	signal?: AbortSignal
): Promise< ChatGptAuthServer > {
	const response = await fetch( discoveryUrl, {
		headers: { accept: 'application/json' },
		redirect: 'error',
		signal: withTimeout( signal ),
	} );
	const document = parseJson( await response.text() );
	if ( response.status !== 200 || ! isRecord( document ) || document.issuer !== CHATGPT_ISSUER ) {
		throw new Error( 'OpenAI’s discovery document couldn’t be read.' );
	}
	const { protocol } = new URL( discoveryUrl );
	return {
		issuer: CHATGPT_ISSUER,
		authorizationEndpoint: readEndpoint( document.authorization_endpoint, protocol ),
		tokenEndpoint: readEndpoint( document.token_endpoint, protocol ),
		revocationEndpoint: readEndpoint( document.revocation_endpoint, protocol ),
		jwksUri: readEndpoint( document.jwks_uri, protocol ),
	};
}

async function postForm(
	endpoint: string,
	form: Record< string, string >,
	signal?: AbortSignal
): Promise< FormResponse > {
	try {
		const response = await fetch( endpoint, {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'content-type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams( form ).toString(),
			redirect: 'error',
			signal: withTimeout( signal ),
		} );
		return { reached: true, status: response.status, body: parseJson( await response.text() ) };
	} catch {
		return { reached: false };
	}
}

// `{"error": "<code>"}` from OAuth, `{"error": {"code": …}}` from the API layer;
// a `{"detail": …}` body carries no code.
function readErrorCode( body: unknown ): string | undefined {
	if ( ! isRecord( body ) ) {
		return undefined;
	}
	const code = isRecord( body.error ) ? body.error.code : body.error;
	return typeof code === 'string' && ERROR_CODE.test( code ) ? code : undefined;
}

function readTokenSet( body: unknown ): ChatGptTokenSet | null {
	if (
		! isRecord( body ) ||
		! isNonEmptyString( body.access_token ) ||
		! isNonEmptyString( body.token_type ) ||
		typeof body.expires_in !== 'number' ||
		! Number.isFinite( body.expires_in ) ||
		body.expires_in <= 0
	) {
		return null;
	}
	return {
		accessToken: body.access_token,
		tokenType: body.token_type,
		expiresIn: body.expires_in,
		...( isNonEmptyString( body.refresh_token ) ? { refreshToken: body.refresh_token } : {} ),
		...( isNonEmptyString( body.id_token ) ? { idToken: body.id_token } : {} ),
		...( typeof body.scope === 'string' ? { scope: body.scope } : {} ),
	};
}

/**
 * Only the refresh errors Sign in with ChatGPT lists are terminal. Anything
 * else, a network failure and a server error among them, may pass, so the
 * credentials are kept.
 */
async function requestTokens(
	endpoint: string,
	form: Record< string, string >,
	signal?: AbortSignal
): Promise< ChatGptTokenServiceResult< ChatGptTokenSet > > {
	const response = await postForm( endpoint, form, signal );
	if ( ! response.reached ) {
		return { ok: false, error: { kind: 'transient' } };
	}
	if ( response.status === 200 ) {
		const tokens = readTokenSet( response.body );
		return tokens
			? { ok: true, value: tokens }
			: { ok: false, error: { kind: 'transient', code: 'invalid_response', status: 200 } };
	}
	const code = readErrorCode( response.body );
	return {
		ok: false,
		error: {
			kind:
				code !== undefined && CHATGPT_TERMINAL_REFRESH_ERRORS.includes( code )
					? 'terminal'
					: 'transient',
			...( code !== undefined ? { code } : {} ),
			status: response.status,
		},
	};
}

/** Exchanges a sign-in's authorization code, with its PKCE verifier, for its tokens. */
export function exchangeChatGptAuthorizationCode(
	authServer: ChatGptAuthServer,
	exchange: { clientId: string; code: string; codeVerifier: string; redirectUri: string },
	signal: AbortSignal
): Promise< ChatGptTokenServiceResult< ChatGptTokenSet > > {
	return requestTokens(
		authServer.tokenEndpoint,
		{
			grant_type: 'authorization_code',
			client_id: exchange.clientId,
			code: exchange.code,
			code_verifier: exchange.codeVerifier,
			redirect_uri: exchange.redirectUri,
			resource: CHATGPT_RESOURCE,
		},
		signal
	);
}

/**
 * The token service the credential broker renews and revokes through. Each
 * process that uses the app's broker installs one at startup:
 * `setChatGptTokenClient( createChatGptTokenClient() )`. The discovery URL is
 * replaced only by tests.
 */
export function createChatGptTokenClient(
	options: { discoveryUrl?: string } = {}
): ChatGptTokenClient {
	let discovered: { authServer: ChatGptAuthServer; until: number } | null = null;
	const undiscovered = {
		ok: false,
		error: { kind: 'transient', code: 'discovery_failed' },
	} as const;

	async function findAuthServer( signal: AbortSignal ): Promise< ChatGptAuthServer | null > {
		if ( discovered && discovered.until > Date.now() ) {
			return discovered.authServer;
		}
		try {
			const authServer = await discoverChatGptAuthServer( options.discoveryUrl, signal );
			discovered = { authServer, until: Date.now() + DISCOVERY_CACHE_MS };
			return authServer;
		} catch {
			return null;
		}
	}

	return {
		async refresh( { clientId, refreshToken, signal } ) {
			const authServer = await findAuthServer( signal );
			if ( ! authServer ) {
				return undiscovered;
			}
			// Without `scope`, the grant keeps the scopes it has.
			return requestTokens(
				authServer.tokenEndpoint,
				{
					grant_type: 'refresh_token',
					client_id: clientId,
					refresh_token: refreshToken,
					resource: CHATGPT_RESOURCE,
				},
				signal
			);
		},
		async revoke( { clientId, refreshToken, signal } ) {
			const authServer = await findAuthServer( signal );
			if ( ! authServer ) {
				return undiscovered;
			}
			const response = await postForm(
				authServer.revocationEndpoint,
				{ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId },
				signal
			);
			if ( ! response.reached ) {
				return { ok: false, error: { kind: 'transient' } };
			}
			// An empty 200 confirms it, also for a token that was already invalid;
			// the body of a 200 carries nothing (RFC 7009).
			if ( response.status === 200 ) {
				return { ok: true, value: undefined };
			}
			const code = readErrorCode( response.body );
			return {
				ok: false,
				error: {
					kind: response.status >= 500 ? 'transient' : 'terminal',
					...( code !== undefined ? { code } : {} ),
					status: response.status,
				},
			};
		},
	};
}
