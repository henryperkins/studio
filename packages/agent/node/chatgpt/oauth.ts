import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { isErrnoException } from '@studio/common/lib/is-errno-exception';
import { __ } from '@wordpress/i18n';
import { createRemoteJWKSet, jwtVerify, type JWSAlgorithm } from 'jose';
import {
	ChatGptConnectionError,
	getChatGptHostId,
	isIssuedChatGptClientId,
	readChatGptAccount,
	type ChatGptAccount,
	type ChatGptCredentialStorage,
} from '@studio/agent/node/chatgpt/account-store';
import {
	CHATGPT_DIRECT_USE_SCOPE,
	readChatGptIdTokenHint,
	saveChatGptSignIn,
	type ChatGptCredentialBroker,
} from '@studio/agent/node/chatgpt/credential-broker';
import {
	CHATGPT_RESOURCE,
	discoverChatGptAuthServer,
	exchangeChatGptAuthorizationCode,
	type ChatGptAuthServer,
} from '@studio/agent/node/chatgpt/token-client';
import type { AddressInfo } from 'node:net';

/**
 * Signing in with ChatGPT, as OpenAI documents it for open-source apps: a
 * public client registered on first sign-in, PKCE, a loopback callback on
 * 127.0.0.1 and a verified ID token, against the endpoints OpenAI's discovery
 * document names. Nothing an attempt receives is saved until every check has
 * passed, so no failure changes or clears a registration.
 *
 * The caller opens the authorization URL in the system browser and waits for
 * the outcome, which never carries a secret.
 */

/** How long a sign-in waits for ChatGPT to send the browser back. */
export const CHATGPT_SIGN_IN_TIMEOUT_MS = 10 * 60_000;

const PENDING_ATTEMPT_VERSION = 1;
// The client a first sign-in registers through; the account's own comes back in the callback.
const REGISTRATION_CLIENT_ID = 'dynamic_agent_client';
const AGENT_NAME = 'WordPress Studio';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/auth/callback';
const REQUESTED_SCOPE =
	'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
// Asymmetric signatures only: never `none`, never HMAC.
const ID_TOKEN_ALGORITHMS: JWSAlgorithm[] = [
	'RS256',
	'RS384',
	'RS512',
	'PS256',
	'PS384',
	'PS512',
	'ES256',
	'ES384',
	'ES512',
	'EdDSA',
	'Ed25519',
];
// A desktop's clock may be a few minutes off.
const ID_TOKEN_CLOCK_TOLERANCE_S = 5 * 60;
// An ID token is issued during its attempt, so it is never older than one.
const ID_TOKEN_MAX_AGE_S = CHATGPT_SIGN_IN_TIMEOUT_MS / 1000;
const KEY_SET_TIMEOUT_MS = 30_000;
// How long `waitForChatGptSignIn` can still read a finished attempt's outcome.
const OUTCOME_RETENTION_MS = 10 * 60_000;
// Port 0 can't collide; should listening still fail that way, the system picks again.
const LISTEN_ATTEMPTS = 3;

export type ChatGptSignInFailureCode =
	| 'unknown-attempt'
	| 'not-found'
	| 'accounts-unreadable'
	| 'discovery-failed'
	| 'callback-unavailable'
	| 'cancelled'
	| 'timed-out'
	| 'denied'
	| 'authorization-failed'
	| 'registration-incomplete'
	| 'client-mismatch'
	| 'code-rejected'
	| 'token-exchange-failed'
	| 'id-token-invalid'
	| 'identity-mismatch'
	| 'permission-missing'
	| 'vault-unavailable'
	| 'save-failed';

/** How a sign-in ended: the registration it saved, or why it saved nothing. Never a secret. */
export type ChatGptSignInOutcome =
	| { ok: true; registrationId: string; label: string; email: string | null }
	| { ok: false; code: ChatGptSignInFailureCode; message: string };

export interface ChatGptSignInOptions {
	/** Shows ChatGPT's consent screen again, to grant a permission declined before. */
	reconsent?: boolean;
	/** Where the tokens are kept: the vault (the default), or this app's memory only. */
	storage?: ChatGptCredentialStorage;
}

export interface ChatGptSignInStart {
	attemptId: string;
	/**
	 * The page to open in the system browser. Signing in again, it carries the
	 * account's ID token as `id_token_hint`: never log it or send it to a renderer.
	 */
	authorizationUrl: string;
}

export interface ChatGptSignInFlowOptions {
	/** Replaced only by tests, with a local stand-in for OpenAI's. */
	discoveryUrl?: string;
	/** Replaced only by tests: how long an attempt waits for its callback. */
	timeoutMs?: number;
	/** The broker sign-ins are saved through: the app's by default. */
	credentials?: Pick< ChatGptCredentialBroker, 'saveSignIn' | 'readIdTokenHint' >;
}

export interface ChatGptSignInFlow {
	begin( registrationId?: string, options?: ChatGptSignInOptions ): Promise< ChatGptSignInStart >;
	wait( attemptId: string ): Promise< ChatGptSignInOutcome >;
	cancel( attemptId: string ): boolean;
}

function describeSignInFailure( code: ChatGptSignInFailureCode ): string {
	switch ( code ) {
		case 'unknown-attempt':
			return __( 'This ChatGPT sign-in isn’t in progress. Start signing in again.' );
		case 'not-found':
			return __( 'Studio has no record of this ChatGPT account. Sign in to ChatGPT again.' );
		case 'accounts-unreadable':
			return __(
				'Studio couldn’t read its list of ChatGPT accounts, so nothing was changed. It may have been written by a newer version of Studio.'
			);
		case 'discovery-failed':
			return __(
				'Studio couldn’t reach ChatGPT’s sign-in service. Check your connection and try again.'
			);
		case 'callback-unavailable':
			return __(
				'Studio couldn’t open a local port to receive ChatGPT’s answer. Try signing in again.'
			);
		case 'cancelled':
			return __( 'Signing in to ChatGPT was cancelled.' );
		case 'timed-out':
			return __( 'Signing in to ChatGPT took too long, so Studio stopped waiting. Try again.' );
		case 'denied':
			return __(
				'You didn’t allow WordPress Studio to use your ChatGPT account, so nothing was saved.'
			);
		case 'authorization-failed':
			return __( 'ChatGPT couldn’t complete the sign-in, so nothing was saved. Try again.' );
		case 'registration-incomplete':
			return __(
				'ChatGPT didn’t finish registering WordPress Studio, so nothing was saved. Try again.'
			);
		case 'client-mismatch':
			return __(
				'ChatGPT answered for another registration of WordPress Studio, so nothing was changed. Try again.'
			);
		case 'code-rejected':
			return __( 'ChatGPT didn’t accept the sign-in, so nothing was saved. Try again.' );
		case 'token-exchange-failed':
			return __(
				'Studio couldn’t finish signing in with ChatGPT, so nothing was saved. Check your connection and try again.'
			);
		case 'id-token-invalid':
			return __(
				'Studio couldn’t verify the ChatGPT account you signed in to, so nothing was saved. Try again.'
			);
		case 'identity-mismatch':
			return __(
				'You signed in as a different ChatGPT account than this connection uses, so nothing was changed.'
			);
		case 'permission-missing':
			return __(
				'ChatGPT didn’t give WordPress Studio permission to use your plan, so nothing was saved. Sign in again and allow access to your plan.'
			);
		case 'vault-unavailable':
			return __(
				'Studio couldn’t reach the system keychain to save your ChatGPT sign-in, so nothing was saved. Unlock it and try again.'
			);
		case 'save-failed':
			return __( 'Studio couldn’t save your ChatGPT sign-in. Try again.' );
	}
}

/** Why a sign-in couldn't begin. The message is for the user and never holds a secret. */
export class ChatGptSignInError extends Error {
	readonly code: ChatGptSignInFailureCode;

	constructor( code: ChatGptSignInFailureCode ) {
		super( describeSignInFailure( code ) );
		this.name = 'ChatGptSignInError';
		this.code = code;
	}
}

/**
 * What an attempt keeps until its callback, in the memory of the process that
 * began it and nowhere else.
 */
interface PendingAttempt {
	version: typeof PENDING_ATTEMPT_VERSION;
	attemptId: string;
	/** The registration signed in to again, with its verified identity and issued client; null for a new one. */
	registration: Pick< ChatGptAccount, 'registrationId' | 'issuer' | 'subject' | 'clientId' > | null;
	storage: ChatGptCredentialStorage;
	authServer: ChatGptAuthServer;
	redirectUri: string;
	state: string;
	nonce: string;
	codeVerifier: string;
}

interface Attempt {
	attemptId: string;
	/** Gone, with its secrets, once the attempt is over. */
	pending: PendingAttempt | null;
	/** `completing` from the callback on, `committing` once its sign-in is being saved. */
	status: 'waiting' | 'completing' | 'committing' | 'done';
	/** The `Host` a browser sends to the callback. */
	callbackHost: string;
	server: http.Server;
	timer: ReturnType< typeof setTimeout >;
	/** Aborts the attempt's requests when it is cancelled or times out. */
	controller: AbortController;
	outcome: Promise< ChatGptSignInOutcome >;
	resolve: ( outcome: ChatGptSignInOutcome ) => void;
}

const randomValue = () => randomBytes( 32 ).toString( 'base64url' );

function isSameText( value: string, expected: string ): boolean {
	const actual = Buffer.from( value );
	const wanted = Buffer.from( expected );
	return actual.length === wanted.length && timingSafeEqual( actual, wanted );
}

function failure( code: ChatGptSignInFailureCode ): ChatGptSignInOutcome {
	return { ok: false, code, message: describeSignInFailure( code ) };
}

function commitFailureCode( error: unknown ): ChatGptSignInFailureCode {
	if ( error instanceof ChatGptConnectionError ) {
		switch ( error.code ) {
			case 'vault-unavailable':
			case 'identity-mismatch':
			case 'not-found':
			case 'accounts-unreadable':
				return error.code;
		}
	}
	return 'save-failed';
}

const escapeHtml = ( text: string ) =>
	text.replace(
		/[&<>"']/g,
		( character ) =>
			( { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } )[ character ] ??
			character
	);

// The browser gets a sentence and nothing else: no code, token or error detail.
function respond( response: http.ServerResponse, status: number, message: string ): void {
	try {
		response.writeHead( status, {
			'Cache-Control': 'no-store',
			Connection: 'close',
			'Content-Security-Policy': "default-src 'none'",
			'Content-Type': 'text/html; charset=utf-8',
			'Referrer-Policy': 'no-referrer',
			'X-Content-Type-Options': 'nosniff',
		} );
		response.end(
			`<!doctype html><meta charset="utf-8"><title>WordPress Studio</title><p>${ escapeHtml(
				message
			) }</p>\n`
		);
	} catch {
		// The browser has gone.
	}
}

const rejectedPage = () =>
	__( 'This sign-in link isn’t valid. Go back to WordPress Studio to sign in again.' );

const finishedPage = ( outcome: ChatGptSignInOutcome ) =>
	outcome.ok
		? __(
				'You’re signed in to ChatGPT. You can close this window and go back to WordPress Studio.'
		  )
		: __(
				'Signing in to ChatGPT didn’t finish. You can close this window and go back to WordPress Studio to see why.'
		  );

// Listens on 127.0.0.1 alone, on a port the system picks, never anywhere else.
async function openCallbackListener(
	answer: http.RequestListener
): Promise< { server: http.Server; port: number } > {
	for ( let tries = 1; ; tries++ ) {
		const server = http.createServer( answer );
		try {
			await new Promise< void >( ( resolve, reject ) => {
				server.once( 'error', reject );
				server.listen( { port: 0, host: CALLBACK_HOST }, () => {
					server.off( 'error', reject );
					resolve();
				} );
			} );
		} catch ( error ) {
			server.close();
			if ( isErrnoException( error ) && error.code === 'EADDRINUSE' && tries < LISTEN_ATTEMPTS ) {
				continue;
			}
			throw new ChatGptSignInError( 'callback-unavailable' );
		}
		// Unheard, a later server error would crash the app; the attempt still ends by its callback, a cancel or the timeout.
		server.on( 'error', () => undefined );
		return { server, port: ( server.address() as AddressInfo ).port };
	}
}

/**
 * Sign-in attempts and their callback listeners, for one process. The app's
 * own is behind `beginChatGptSignIn`; tests make their own.
 */
export function createChatGptSignInFlow(
	options: ChatGptSignInFlowOptions = {}
): ChatGptSignInFlow {
	const timeoutMs = options.timeoutMs ?? CHATGPT_SIGN_IN_TIMEOUT_MS;
	const credentials = options.credentials ?? {
		saveSignIn: saveChatGptSignIn,
		readIdTokenHint: readChatGptIdTokenHint,
	};
	const attempts = new Map< string, Attempt >();
	const keySets = new Map< string, ReturnType< typeof createRemoteJWKSet > >();

	// Cached; fetched again, once per verification, when a token names a key it doesn't hold.
	function keySetFor( jwksUri: string ) {
		let keySet = keySets.get( jwksUri );
		if ( ! keySet ) {
			keySet = createRemoteJWKSet( new URL( jwksUri ), {
				cooldownDuration: 0,
				timeoutDuration: KEY_SET_TIMEOUT_MS,
			} );
			keySets.set( jwksUri, keySet );
		}
		return keySet;
	}

	async function findRegistration( registrationId: string ): Promise< ChatGptAccount > {
		let account: ChatGptAccount | null;
		try {
			account = await readChatGptAccount( registrationId );
		} catch {
			throw new ChatGptSignInError( 'accounts-unreadable' );
		}
		if ( ! account ) {
			throw new ChatGptSignInError( 'not-found' );
		}
		return account;
	}

	async function verifyIdToken(
		idToken: string,
		pending: PendingAttempt,
		clientId: string
	): Promise< { subject: string; email: string | null } | null > {
		try {
			const { payload } = await jwtVerify( idToken, keySetFor( pending.authServer.jwksUri ), {
				issuer: pending.authServer.issuer,
				// `aud` may be a list; it must hold the issued client.
				audience: clientId,
				algorithms: ID_TOKEN_ALGORITHMS,
				requiredClaims: [ 'iss', 'sub', 'aud', 'exp', 'iat', 'nonce' ],
				clockTolerance: ID_TOKEN_CLOCK_TOLERANCE_S,
				maxTokenAge: ID_TOKEN_MAX_AGE_S,
			} );
			if (
				typeof payload.nonce !== 'string' ||
				! isSameText( payload.nonce, pending.nonce ) ||
				typeof payload.sub !== 'string' ||
				! payload.sub
			) {
				return null;
			}
			const email = typeof payload.email === 'string' && payload.email ? payload.email : null;
			return { subject: payload.sub, email };
		} catch {
			return null;
		}
	}

	function finish( attempt: Attempt, outcome: ChatGptSignInOutcome ): void {
		if ( attempt.status === 'done' ) {
			return;
		}
		attempt.status = 'done';
		attempt.pending = null;
		clearTimeout( attempt.timer );
		attempt.controller.abort();
		attempt.server.close();
		attempt.resolve( outcome );
		const forget = setTimeout( () => attempts.delete( attempt.attemptId ), OUTCOME_RETENTION_MS );
		forget.unref?.();
	}

	// The callback's checks, in order; nothing is saved until every one has passed.
	async function complete(
		attempt: Attempt,
		pending: PendingAttempt,
		params: URLSearchParams
	): Promise< ChatGptSignInOutcome > {
		if ( params.has( 'error' ) ) {
			return failure(
				params.get( 'error' ) === 'access_denied' ? 'denied' : 'authorization-failed'
			);
		}
		const returnedClients = params.getAll( 'client_id' );
		let clientId: string;
		if ( pending.registration ) {
			// Signing in again, the callback may leave the client out, but may not name another.
			if ( returnedClients.some( ( returned ) => returned !== pending.registration?.clientId ) ) {
				return failure( 'client-mismatch' );
			}
			clientId = pending.registration.clientId;
		} else {
			const [ issued ] = returnedClients;
			if ( returnedClients.length !== 1 || ! isIssuedChatGptClientId( issued ) ) {
				return failure( 'registration-incomplete' );
			}
			clientId = issued;
		}
		const codes = params.getAll( 'code' );
		if ( codes.length !== 1 || ! codes[ 0 ] ) {
			return failure( 'authorization-failed' );
		}

		const exchange = await exchangeChatGptAuthorizationCode(
			pending.authServer,
			{
				clientId,
				code: codes[ 0 ],
				codeVerifier: pending.codeVerifier,
				redirectUri: pending.redirectUri,
			},
			attempt.controller.signal
		);
		if ( ! exchange.ok ) {
			// A rejected code is discarded; signing in again starts afresh.
			return failure(
				exchange.error.code === 'invalid_grant' ? 'code-rejected' : 'token-exchange-failed'
			);
		}
		const { refreshToken, idToken, ...tokens } = exchange.value;
		if ( ! refreshToken || ! idToken ) {
			return failure( 'token-exchange-failed' );
		}
		const identity = await verifyIdToken( idToken, pending, clientId );
		if ( ! identity ) {
			return failure( 'id-token-invalid' );
		}
		if (
			pending.registration &&
			( identity.subject !== pending.registration.subject ||
				pending.authServer.issuer !== pending.registration.issuer )
		) {
			return failure( 'identity-mismatch' );
		}
		// A verified identity alone doesn't let Studio use the plan.
		if ( ! ( tokens.scope ?? '' ).split( /\s+/ ).includes( CHATGPT_DIRECT_USE_SCOPE ) ) {
			return failure( 'permission-missing' );
		}
		if ( attempt.status !== 'completing' ) {
			return failure( 'cancelled' );
		}

		attempt.status = 'committing';
		try {
			const account = await credentials.saveSignIn( {
				...( pending.registration ? { registrationId: pending.registration.registrationId } : {} ),
				issuer: pending.authServer.issuer,
				subject: identity.subject,
				email: identity.email,
				clientId,
				storage: pending.storage,
				tokens: { ...tokens, refreshToken, idToken },
			} );
			return {
				ok: true,
				registrationId: account.registrationId,
				label: account.label,
				email: account.email,
			};
		} catch ( error ) {
			return failure( commitFailureCode( error ) );
		}
	}

	// The outcome that ended the attempt: a cancel or timeout may have come first.
	async function settle(
		attempt: Attempt,
		pending: PendingAttempt,
		params: URLSearchParams
	): Promise< ChatGptSignInOutcome > {
		let outcome: ChatGptSignInOutcome;
		try {
			outcome = await complete( attempt, pending, params );
		} catch {
			outcome = failure( 'token-exchange-failed' );
		}
		finish( attempt, outcome );
		return attempt.outcome;
	}

	function answerCallback(
		attempt: Attempt | undefined,
		request: http.IncomingMessage,
		response: http.ServerResponse
	): void {
		let url: URL;
		try {
			url = new URL( request.url ?? '/', `http://${ CALLBACK_HOST }` );
		} catch {
			respond( response, 400, rejectedPage() );
			return;
		}
		if ( url.pathname !== CALLBACK_PATH ) {
			respond( response, 404, rejectedPage() );
			return;
		}
		if ( request.method !== 'GET' ) {
			respond( response, 405, rejectedPage() );
			return;
		}
		const pending = attempt?.pending;
		// Another host name is another site reaching the port, not ChatGPT's redirect.
		if ( ! attempt || ! pending || request.headers.host !== attempt.callbackHost ) {
			respond( response, 400, rejectedPage() );
			return;
		}
		// An unknown, missing or replayed state is refused, and the attempt goes on waiting.
		const states = url.searchParams.getAll( 'state' );
		if (
			attempt.status !== 'waiting' ||
			states.length !== 1 ||
			! isSameText( states[ 0 ], pending.state )
		) {
			respond( response, 400, rejectedPage() );
			return;
		}
		attempt.status = 'completing';
		void settle( attempt, pending, url.searchParams ).then( ( outcome ) =>
			respond( response, 200, finishedPage( outcome ) )
		);
	}

	async function begin(
		registrationId?: string,
		signInOptions: ChatGptSignInOptions = {}
	): Promise< ChatGptSignInStart > {
		const account = registrationId === undefined ? null : await findRegistration( registrationId );
		let hostId: string;
		try {
			hostId = await getChatGptHostId();
		} catch {
			throw new ChatGptSignInError( 'accounts-unreadable' );
		}
		let authServer: ChatGptAuthServer;
		try {
			authServer = await discoverChatGptAuthServer( options.discoveryUrl );
		} catch {
			throw new ChatGptSignInError( 'discovery-failed' );
		}
		const idTokenHint = account
			? await credentials.readIdTokenHint( account.registrationId ).catch( () => null )
			: null;

		const attemptId = randomUUID();
		const { server, port } = await openCallbackListener( ( request, response ) =>
			answerCallback( attempts.get( attemptId ), request, response )
		);
		const pending: PendingAttempt = {
			version: PENDING_ATTEMPT_VERSION,
			attemptId,
			registration: account
				? {
						registrationId: account.registrationId,
						issuer: account.issuer,
						subject: account.subject,
						clientId: account.clientId,
				  }
				: null,
			storage: signInOptions.storage === 'session' ? 'session' : 'vault',
			authServer,
			redirectUri: `http://${ CALLBACK_HOST }:${ port }${ CALLBACK_PATH }`,
			state: randomValue(),
			nonce: randomValue(),
			codeVerifier: randomValue(),
		};

		const params: Record< string, string > = {
			client_id: account?.clientId ?? REGISTRATION_CLIENT_ID,
			ext_agent_host_id: hostId,
			response_type: 'code',
			redirect_uri: pending.redirectUri,
			scope: REQUESTED_SCOPE,
			resource: CHATGPT_RESOURCE,
			state: pending.state,
			nonce: pending.nonce,
			code_challenge_method: 'S256',
			code_challenge: createHash( 'sha256' ).update( pending.codeVerifier ).digest( 'base64url' ),
		};
		if ( ! account ) {
			params.agent_name_hint = AGENT_NAME;
		} else if ( idTokenHint ) {
			params.id_token_hint = idTokenHint;
		} else if ( account.email ) {
			params.login_hint = account.email;
		}
		if ( signInOptions.reconsent ) {
			params.prompt = 'consent';
		}
		const authorizationUrl = new URL( authServer.authorizationEndpoint );
		for ( const [ name, value ] of Object.entries( params ) ) {
			authorizationUrl.searchParams.set( name, value );
		}

		let resolve: ( outcome: ChatGptSignInOutcome ) => void = () => undefined;
		const outcome = new Promise< ChatGptSignInOutcome >( ( settled ) => ( resolve = settled ) );
		const started: Attempt = {
			attemptId,
			pending,
			status: 'waiting',
			callbackHost: `${ CALLBACK_HOST }:${ port }`,
			server,
			controller: new AbortController(),
			outcome,
			resolve,
			timer: setTimeout( () => {
				if ( started.status === 'waiting' || started.status === 'completing' ) {
					finish( started, failure( 'timed-out' ) );
				}
			}, timeoutMs ),
		};
		attempts.set( attemptId, started );
		return { attemptId, authorizationUrl: authorizationUrl.toString() };
	}

	function wait( attemptId: string ): Promise< ChatGptSignInOutcome > {
		return attempts.get( attemptId )?.outcome ?? Promise.resolve( failure( 'unknown-attempt' ) );
	}

	function cancel( attemptId: string ): boolean {
		const attempt = attempts.get( attemptId );
		if ( attempt?.status !== 'waiting' && attempt?.status !== 'completing' ) {
			return false;
		}
		finish( attempt, failure( 'cancelled' ) );
		return true;
	}

	return { begin, wait, cancel };
}

let appFlow: ChatGptSignInFlow | undefined;

const getAppFlow = () => ( appFlow ??= createChatGptSignInFlow() );

/**
 * Starts signing in to ChatGPT: a new registration, or `registrationId` again.
 * The callback listener is open before this returns. Open the authorization
 * URL in the system browser, then wait with `waitForChatGptSignIn`.
 */
export function beginChatGptSignIn(
	registrationId?: string,
	options?: ChatGptSignInOptions
): Promise< ChatGptSignInStart > {
	return getAppFlow().begin( registrationId, options );
}

/** How the attempt ended, once it has. */
export function waitForChatGptSignIn( attemptId: string ): Promise< ChatGptSignInOutcome > {
	return getAppFlow().wait( attemptId );
}

/**
 * Ends an attempt that is waiting for its callback or exchanging its code,
 * and closes its listener. False when it has finished, or is being saved.
 */
export function cancelChatGptSignIn( attemptId: string ): boolean {
	return getAppFlow().cancel( attemptId );
}
