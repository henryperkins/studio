import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { isErrnoException } from '@studio/common/lib/is-errno-exception';
import { __ } from '@wordpress/i18n';
import { createRemoteJWKSet, jwtVerify, type JWSAlgorithm } from 'jose';
import {
	ChatGptConnectionError,
	getChatGptHostId,
	isIssuedChatGptClientId,
	isSameChatGptIdentity,
	readChatGptAccount,
	readChatGptAccounts,
	readRetainedChatGptClientId,
	retainChatGptClientId,
	type ChatGptAccount,
	type ChatGptCredentialStorage,
} from '@studio/agent/node/chatgpt/account-store';
import {
	CHATGPT_DIRECT_USE_SCOPE,
	checkChatGptVaultKey,
	readChatGptIdTokenHint,
	saveChatGptSignIn,
	type ChatGptCredentialBroker,
} from '@studio/agent/node/chatgpt/credential-broker';
import {
	openLoopbackPeerLookup,
	type LoopbackPeerLookup,
	type LoopbackPeerOwner,
} from '@studio/agent/node/chatgpt/loopback-peer';
import {
	CHATGPT_RESOURCE,
	createChatGptTokenClient,
	discoverChatGptAuthServer,
	exchangeChatGptAuthorizationCode,
	type ChatGptAuthServer,
} from '@studio/agent/node/chatgpt/token-client';
import type {
	ChatGptSignInFailureCode,
	ChatGptSignInOptions,
	ChatGptSignInOutcome,
	ChatGptSignInStart,
} from '@studio/agent/protocol/chatgpt';
import type { AddressInfo } from 'node:net';

export type {
	ChatGptSignInFailureCode,
	ChatGptSignInOptions,
	ChatGptSignInOutcome,
	ChatGptSignInStart,
} from '@studio/agent/protocol/chatgpt';

/**
 * Signing in with ChatGPT, as OpenAI documents it for open-source apps: a
 * public client registered on first sign-in, PKCE, a loopback callback on
 * 127.0.0.1 and a verified ID token, against the endpoints OpenAI's discovery
 * document names. Nothing an attempt receives is saved until every check has
 * passed, so no failure changes or clears a registration — except the client
 * a first sign-in is issued, which is kept before its one-time code is
 * exchanged so a failed exchange doesn't register another client next time.
 *
 * The backend opens the authorization page in the system browser itself: its
 * URL can carry the account's ID token, so no caller, renderer or log ever
 * sees it. Nor does the browser opener's command line, which other processes
 * can read: the opener gets a one-time address on the attempt's own loopback
 * listener, which sends the browser on to the authorization URL. Callers get
 * the attempt's id and wait for its outcome, which never carries a secret.
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
// Revoking a failed attempt's tokens holds up its outcome this long at most.
const REVOKE_TIMEOUT_MS = 10_000;
// How long `waitForChatGptSignIn` can still read a finished attempt's outcome.
const OUTCOME_RETENTION_MS = 10 * 60_000;
// Port 0 can't collide; should listening still fail that way, the system picks again.
const LISTEN_ATTEMPTS = 3;
// A browser opens at most six connections to one host at a time; two more
// leave room for it to retry. Beyond these the listener drops a connection
// unread, so no one can hold the process's open files through it.
const MAX_CALLBACK_CONNECTIONS = 8;
// A connection that hasn't sent its whole request this long after it was
// accepted is closed, checked each second, so none can be parked there. Once
// a request is in, answering it isn't timed.
const CALLBACK_REQUEST_TIMEOUT_MS = 10_000;
const CALLBACK_CONNECTIONS_CHECK_MS = 1_000;

/** Opens a URL in the system browser; rejects when it can't. */
export type ChatGptBrowserOpener = ( url: string ) => Promise< void >;

export interface ChatGptSignInFlowOptions {
	/** Replaced only by tests, with a local stand-in for OpenAI's. */
	discoveryUrl?: string;
	/** Replaced only by tests: how long an attempt waits for its callback. */
	timeoutMs?: number;
	/** The broker sign-ins are saved through: the app's by default. */
	credentials?: Pick< ChatGptCredentialBroker, 'checkVaultKey' | 'saveSignIn' | 'readIdTokenHint' >;
	/** The system browser: the opener installed with `setChatGptBrowserOpener` by default. */
	openBrowser?: ChatGptBrowserOpener;
	/** Replaced only by tests: the platform whose rules the listener follows. */
	platform?: NodeJS.Platform;
	/** Replaced only by tests: on Linux, what a listener asks whose socket a request comes from. */
	loopbackPeers?: () => LoopbackPeerLookup;
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
		case 'browser-unavailable':
			return __( 'Studio couldn’t open your web browser to sign in to ChatGPT. Try again.' );
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
		case 'vault-key-unreadable':
			return __(
				'Studio couldn’t read the key in the system keychain that protects your saved ChatGPT sign-ins, so it can’t keep this sign-in in secure storage, and nothing was saved. Unlock the keychain and try again, or keep this sign-in for this app session only. If the key is gone, sign out of every saved ChatGPT account first: the next sign-in kept in secure storage then makes a new key.'
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
	/** A new registration's client, kept from an earlier first sign-in whose exchange never saved it; null when none was kept. */
	retainedClientId: string | null;
	storage: ChatGptCredentialStorage;
	authServer: ChatGptAuthServer;
	redirectUri: string;
	state: string;
	nonce: string;
	codeVerifier: string;
	/** The one-time path the browser opener is given: a random segment and nothing else. */
	startPath: string;
	/** Where the start address sends the browser; null once it has. */
	authorizationUrl: string | null;
}

/** The account a verified ID token names. */
interface VerifiedIdentity {
	subject: string;
	email: string | null;
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
	/** On Linux, whose socket a request to the listener comes from; null elsewhere. */
	peers: LoopbackPeerLookup | null;
	timer: ReturnType< typeof setTimeout >;
	/** Aborts the attempt's requests when it is cancelled or times out. */
	controller: AbortController;
	outcome: Promise< ChatGptSignInOutcome >;
	resolve: ( outcome: ChatGptSignInOutcome ) => void;
}

const randomValue = () => randomBytes( 32 ).toString( 'base64url' );

// Whatever an untyped caller passes, only these two count as a choice.
const isCredentialStorage = ( value: unknown ): value is ChatGptCredentialStorage =>
	value === 'vault' || value === 'session';

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
			case 'vault-key-unreadable':
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

// Sends the browser on from the start address: the URL goes in the Location
// header only, never cached and never passed on as a referrer.
function redirect( response: http.ServerResponse, location: string ): void {
	try {
		response.writeHead( 302, {
			'Cache-Control': 'no-store',
			Connection: 'close',
			'Content-Length': '0',
			Location: location,
			'Referrer-Policy': 'no-referrer',
			'X-Content-Type-Options': 'nosniff',
		} );
		response.end();
	} catch {
		// The browser has gone.
	}
}

const rejectedPage = () =>
	__( 'This sign-in link isn’t valid. Go back to WordPress Studio to sign in again.' );

// For a request whose owner couldn't be checked just now: the link still works.
const retryPage = () =>
	__( 'WordPress Studio couldn’t check this sign-in just now. Reload this page to try again.' );

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
		const server = http.createServer(
			{
				connectionsCheckingInterval: CALLBACK_CONNECTIONS_CHECK_MS,
				headersTimeout: CALLBACK_REQUEST_TIMEOUT_MS,
				requestTimeout: CALLBACK_REQUEST_TIMEOUT_MS,
			},
			answer
		);
		server.maxConnections = MAX_CALLBACK_CONNECTIONS;
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

let installedBrowserOpener: ChatGptBrowserOpener | null = null;

/**
 * How this process opens the system browser for a sign-in, installed once at
 * startup like the token client. Sign-in URLs go there and nowhere else.
 */
export function setChatGptBrowserOpener( open: ChatGptBrowserOpener ): void {
	installedBrowserOpener = open;
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
		checkVaultKey: checkChatGptVaultKey,
		saveSignIn: saveChatGptSignIn,
		readIdTokenHint: readChatGptIdTokenHint,
	};
	const platform = options.platform ?? process.platform;
	const openLoopbackPeers = options.loopbackPeers ?? ( () => openLoopbackPeerLookup() );
	const attempts = new Map< string, Attempt >();
	const keySets = new Map< string, ReturnType< typeof createRemoteJWKSet > >();
	const tokenClient = createChatGptTokenClient( { discoveryUrl: options.discoveryUrl } );

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
	): Promise< VerifiedIdentity | null > {
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

	/**
	 * Whether the grant a failed attempt was issued can go without ending a
	 * saved session: another account's, or a new registration's whose client
	 * no registration uses. One for the registration's own account, or one
	 * whose account isn't known, shares the saved session's client and maybe
	 * its grant, so it stays. Registrations can share an issued client, so a
	 * verified identity is checked against every saved registration with
	 * this client, not only the one signed in to: another registration for
	 * the same account under the same client may share the grant.
	 */
	async function isUnsharedGrant(
		pending: PendingAttempt,
		clientId: string,
		identity: VerifiedIdentity | null
	): Promise< boolean > {
		if ( pending.registration ) {
			if ( ! identity ) {
				return false;
			}
			const verified = { issuer: pending.authServer.issuer, subject: identity.subject };
			if ( isSameChatGptIdentity( pending.registration, verified ) ) {
				return false;
			}
			try {
				const accounts = await readChatGptAccounts();
				return ! accounts.some(
					( account ) => account.clientId === clientId && isSameChatGptIdentity( account, verified )
				);
			} catch {
				return false;
			}
		}
		try {
			const accounts = await readChatGptAccounts();
			return ! accounts.some( ( account ) => account.clientId === clientId );
		} catch {
			return false;
		}
	}

	// Bounded and silent: whatever comes of it, the outcome stays as it is.
	async function revokeQuietly( clientId: string, refreshToken: string ): Promise< void > {
		await tokenClient
			.revoke( { clientId, refreshToken, signal: AbortSignal.timeout( REVOKE_TIMEOUT_MS ) } )
			.catch( () => undefined );
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
		void attempt.peers?.close().catch( () => undefined );
		attempt.resolve( outcome );
		const forget = setTimeout( () => attempts.delete( attempt.attemptId ), OUTCOME_RETENTION_MS );
		forget.unref?.();
	}

	// The callback's checks, in order; nothing but a new registration's issued
	// client is saved until every one has passed.
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
		// The client this attempt registered through, if it already has one:
		// its registration's, or one kept from an unfinished first sign-in.
		const expectedClient = pending.registration?.clientId ?? pending.retainedClientId;
		let clientId: string;
		if ( expectedClient ) {
			// The callback may leave the client out, but may not name another.
			if ( returnedClients.some( ( returned ) => returned !== expectedClient ) ) {
				return failure( 'client-mismatch' );
			}
			clientId = expectedClient;
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
		if ( ! pending.registration && pending.retainedClientId !== clientId ) {
			// OpenAI has registered this client already. Keep it before the
			// one-time code is spent, so an exchange that fails — an expired
			// code above all — doesn't register another client next time.
			// Failing to keep it only costs that, so it never fails the sign-in.
			await retainChatGptClientId( clientId ).catch( () => undefined );
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
		// From here a failure leaves a live grant behind: it goes where no saved session can share it.
		const discard = async (
			code: ChatGptSignInFailureCode,
			identity: VerifiedIdentity | null = null
		): Promise< ChatGptSignInOutcome > => {
			if ( refreshToken && ( await isUnsharedGrant( pending, clientId, identity ) ) ) {
				await revokeQuietly( clientId, refreshToken );
			}
			return failure( code );
		};
		if ( ! refreshToken || ! idToken ) {
			return discard( 'token-exchange-failed' );
		}
		const identity = await verifyIdToken( idToken, pending, clientId );
		if ( ! identity ) {
			return discard( 'id-token-invalid' );
		}
		if (
			pending.registration &&
			! isSameChatGptIdentity( pending.registration, {
				issuer: pending.authServer.issuer,
				subject: identity.subject,
			} )
		) {
			return discard( 'identity-mismatch', identity );
		}
		// A verified identity alone doesn't let Studio use the plan.
		if ( ! ( tokens.scope ?? '' ).split( /\s+/ ).includes( CHATGPT_DIRECT_USE_SCOPE ) ) {
			return discard( 'permission-missing', identity );
		}
		if ( attempt.status !== 'completing' ) {
			return discard( 'cancelled', identity );
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
			return discard( commitFailureCode( error ), identity );
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
		const pending = attempt?.pending;
		const isStart = Boolean( pending && isSameText( url.pathname, pending.startPath ) );
		if ( url.pathname !== CALLBACK_PATH && ! isStart ) {
			respond( response, 404, rejectedPage() );
			return;
		}
		if ( request.method !== 'GET' ) {
			respond( response, 405, rejectedPage() );
			return;
		}
		// Another host name is another site reaching the port, not ChatGPT's redirect.
		if ( ! attempt || ! pending || request.headers.host !== attempt.callbackHost ) {
			respond( response, 400, rejectedPage() );
			return;
		}
		void peerRefusal( attempt, request ).then( ( refusal ) => {
			if ( refusal ) {
				respond( response, 400, refusal === 'unchecked' ? retryPage() : rejectedPage() );
			} else if ( isStart ) {
				answerStart( attempt, request, response );
			} else {
				answerReturn( attempt, url.searchParams, response );
			}
		} );
	}

	/**
	 * Why the request is refused for whose socket it comes from, if it is:
	 * `another-user`, told the link isn't valid, or `unchecked`, told to
	 * reload, as the start address and the attempt are left as they were.
	 *
	 * Only on Linux, where xdg-open takes the start address as an argument and
	 * any local user can read it there, from /proc. On macOS, whose `ps` shows
	 * every user's arguments, and on Windows the CLI's opener reads the address
	 * from its environment instead (`apps/cli/lib/browser.ts`), and the Desktop
	 * app's opener takes no arguments at all.
	 *
	 * The request goes on only when the kernel's socket tables show it comes
	 * from this process's user or root, when a table that could be read has no
	 * row proving its owner, or when the kernel hides a table from this
	 * process (absent or forbidden). Refusing those would break signing in
	 * where the tables are hidden or the connection is relayed (a hardened
	 * kernel, WSL's localhost forwarding); an unprivileged user in the same
	 * network namespace can't keep their socket out of a table the kernel shows
	 * while still reading the answer, and root may read everything anyway.
	 * Any other failure to read or parse a table, or to look the socket up, is
	 * refused: another user can bring one about, by holding the process at its
	 * limit of open files, say.
	 */
	async function peerRefusal(
		attempt: Attempt,
		request: http.IncomingMessage
	): Promise< 'another-user' | 'unchecked' | null > {
		if ( ! attempt.peers ) {
			return null;
		}
		const { remoteAddress, remotePort, localAddress, localPort } = request.socket;
		if ( ! remoteAddress || ! remotePort || ! localAddress || ! localPort ) {
			return 'unchecked';
		}
		let owner: LoopbackPeerOwner;
		try {
			owner = await attempt.peers.ownerOf( {
				remoteAddress,
				remotePort,
				localAddress,
				localPort,
			} );
		} catch {
			return 'unchecked';
		}
		if ( owner === 'other-user' ) {
			return 'another-user';
		}
		return owner === 'unreadable' ? 'unchecked' : null;
	}

	// Once only, and only while the attempt waits for its callback.
	function answerStart(
		attempt: Attempt,
		request: http.IncomingMessage,
		response: http.ServerResponse
	): void {
		const authorizationUrl = attempt.pending?.authorizationUrl;
		if ( attempt.status !== 'waiting' || ! attempt.pending || ! authorizationUrl ) {
			respond( response, 400, rejectedPage() );
			return;
		}
		// A client gone while its owner was looked up can't be sent on: the
		// address stays for the browser.
		if ( request.destroyed || ! request.socket?.writable ) {
			return;
		}
		attempt.pending.authorizationUrl = null;
		redirect( response, authorizationUrl );
	}

	// An unknown, missing or replayed state is refused, and the attempt goes on waiting.
	function answerReturn(
		attempt: Attempt,
		params: URLSearchParams,
		response: http.ServerResponse
	): void {
		const { pending } = attempt;
		const states = params.getAll( 'state' );
		if (
			! pending ||
			attempt.status !== 'waiting' ||
			states.length !== 1 ||
			! isSameText( states[ 0 ], pending.state )
		) {
			respond( response, 400, rejectedPage() );
			return;
		}
		attempt.status = 'completing';
		void settle( attempt, pending, params ).then( ( outcome ) =>
			respond( response, 200, finishedPage( outcome ) )
		);
	}

	async function begin(
		registrationId?: string,
		signInOptions: ChatGptSignInOptions = {}
	): Promise< ChatGptSignInStart > {
		const openBrowser = options.openBrowser ?? installedBrowserOpener;
		if ( ! openBrowser ) {
			throw new ChatGptSignInError( 'browser-unavailable' );
		}
		const account = registrationId === undefined ? null : await findRegistration( registrationId );
		const storage = isCredentialStorage( signInOptions.storage )
			? signInOptions.storage
			: account?.storage ?? 'vault';
		// Saving would refuse for an unreadable key: say so before the browser
		// opens. Saving checks again, as the keychain may lock in between; any
		// other answer here is left for it to report.
		if ( storage === 'vault' ) {
			const refusal = await credentials.checkVaultKey().then(
				() => null,
				( error: unknown ) => error
			);
			if ( refusal instanceof ChatGptConnectionError && refusal.code === 'vault-key-unreadable' ) {
				throw new ChatGptSignInError( 'vault-key-unreadable' );
			}
		}
		let hostId: string;
		try {
			hostId = await getChatGptHostId();
		} catch {
			throw new ChatGptSignInError( 'accounts-unreadable' );
		}
		let retainedClientId: string | null = null;
		if ( ! account ) {
			try {
				retainedClientId = await readRetainedChatGptClientId();
			} catch {
				throw new ChatGptSignInError( 'accounts-unreadable' );
			}
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
		// Opened with the listener, before the opener is given its port.
		let peers: LoopbackPeerLookup | null = null;
		try {
			peers = platform === 'linux' ? openLoopbackPeers() : null;
		} catch {
			server.close();
			throw new ChatGptSignInError( 'callback-unavailable' );
		}
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
			retainedClientId,
			storage,
			authServer,
			redirectUri: `http://${ CALLBACK_HOST }:${ port }${ CALLBACK_PATH }`,
			state: randomValue(),
			nonce: randomValue(),
			codeVerifier: randomValue(),
			startPath: `/${ randomValue() }`,
			authorizationUrl: null,
		};

		const params: Record< string, string > = {
			client_id: account?.clientId ?? retainedClientId ?? REGISTRATION_CLIENT_ID,
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
		if ( ! account && ! retainedClientId ) {
			params.agent_name_hint = AGENT_NAME;
		} else if ( idTokenHint ) {
			params.id_token_hint = idTokenHint;
		} else if ( account?.email ) {
			params.login_hint = account.email;
		}
		if ( signInOptions.reconsent ) {
			params.prompt = 'consent';
		}
		const authorizationUrl = new URL( authServer.authorizationEndpoint );
		for ( const [ name, value ] of Object.entries( params ) ) {
			authorizationUrl.searchParams.set( name, value );
		}
		pending.authorizationUrl = authorizationUrl.toString();

		let resolve: ( outcome: ChatGptSignInOutcome ) => void = () => undefined;
		const outcome = new Promise< ChatGptSignInOutcome >( ( settled ) => ( resolve = settled ) );
		const started: Attempt = {
			attemptId,
			pending,
			status: 'waiting',
			callbackHost: `${ CALLBACK_HOST }:${ port }`,
			server,
			peers,
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

		// The opener gets the start address alone, and its error, which may quote it, goes nowhere.
		const startUrl = `http://${ started.callbackHost }${ pending.startPath }`;
		const opening = Promise.resolve()
			.then( () => openBrowser( startUrl ) )
			.then(
				() => true,
				() => false
			);
		// A browser that never answers holds this up only while the attempt lasts.
		const opened = await Promise.race( [ opening, outcome.then( () => true ) ] );
		// Once the callback has come, the browser plainly opened.
		if ( ! opened && started.status === 'waiting' ) {
			finish( started, failure( 'browser-unavailable' ) );
			throw new ChatGptSignInError( 'browser-unavailable' );
		}
		return { attemptId };
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
 * Listens for the callback, opens the authorization page with the browser
 * opener installed at startup, and returns the attempt's id; wait for it with
 * `waitForChatGptSignIn`.
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
