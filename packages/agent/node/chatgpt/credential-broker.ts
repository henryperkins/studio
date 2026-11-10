import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isErrnoException } from '@studio/common/lib/is-errno-exception';
import {
	createOsCredentialStore,
	type OsCredentialStore,
} from '@studio/common/lib/os-credential-store';
import { getConfigDirectory } from '@studio/common/lib/well-known-paths';
import { __ } from '@wordpress/i18n';
import { readFile } from 'atomically';
import {
	ChatGptConnectionError,
	createChatGptAccount,
	createChatGptRegistrationId,
	isChatGptRegistrationId,
	isIssuedChatGptClientId,
	isSameChatGptIdentity,
	lockChatGptFile,
	markChatGptSignInNeeded,
	readChatGptAccount,
	readChatGptAccounts,
	removeChatGptFile,
	startChatGptSignOut,
	updateChatGptAccountSignIn,
	watchChatGptAccounts,
	writeChatGptFileAtomically,
	type ChatGptAccount,
	type ChatGptAccountSignIn,
} from '@studio/agent/node/chatgpt/account-store';
import type { ParentChannel } from '@studio/agent/node/openai-credentials';
import type { ConnectionRegistryEntry } from '@studio/agent/protocol/connections';

/**
 * The tokens of ChatGPT sign-ins, for backend code only: the Desktop main
 * process, the `studio ui` server and the CLI. Nothing here returns a token to
 * a renderer, writes one to a log, or puts one in a child's environment.
 *
 * A registration's tokens are one record in a vault file, sealed with
 * AES-256-GCM under a random key kept in the system keychain and bound to the
 * registration and the record's version. Without a keychain the vault
 * refuses; it never falls back to plaintext. A registration may instead keep
 * its tokens in the memory of the app that signed in, for that session only;
 * a turn the app forks asks it for an access token over their IPC channel.
 *
 * A lockfile per registration serializes refreshes across processes, and a
 * sign-out raises the registration's logout generation first, so a refresh
 * that began before it never commits.
 */

/** The scope that lets a token use the account's ChatGPT plan. */
export const CHATGPT_DIRECT_USE_SCOPE = 'chatgpt.tokens.use.direct';

/** Refresh errors after which the tokens can't be used again (SIWC "Errors and recovery"). */
export const CHATGPT_TERMINAL_REFRESH_ERRORS: readonly string[] = [
	'invalid_grant',
	'invalid_refresh_token',
	'token_expired',
	'refresh_token_expired',
	'refresh_token_invalidated',
	'refresh_token_reused',
];

/**
 * The longest a turn in one process runs on after another process signs its
 * connection out: the account list is watched, and read at least this often.
 */
export const CHATGPT_TURN_WATCH_POLL_MS = 2_000;

const CREDENTIALS_DIRECTORY = 'chatgpt-credentials';
const RECORD_VERSION = 1;
const WRAPPING_KEY_ACCOUNT = 'chatgpt-vault-key';
const WRAPPING_KEY_BYTES = 32;
// 32 bytes, base64url: within what every keychain tool takes without escaping.
const WRAPPING_KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
// A token this close to expiry is renewed before it is used.
const RENEWAL_MARGIN_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 30_000;
const REVOKE_TIMEOUT_MS = 10_000;
const SESSION_TOKEN_REPLY_TIMEOUT_MS = 10_000;
// Creating the key runs the keychain tool twice, which can take seconds on Windows.
const WRAPPING_KEY_LOCK_MS = 60_000;
// Set on a forked turn's environment to the registrations whose session-only
// tokens the app holds, so the turn knows it may ask. Ids, never tokens.
const SESSION_OFFER_ENV = 'STUDIO_CHATGPT_SESSIONS_OFFERED';
const SESSION_TOKEN_REQUEST = 'studio.chatgpt-session-token.request';
const SESSION_TOKEN_REPLY = 'studio.chatgpt-session-token';
const SESSION_TOKEN_INVALIDATE = 'studio.chatgpt-session-token.invalidate';

export interface ChatGptBrokerTiming {
	/** How long a sign-out waits for this process's turns on the account to settle. */
	turnSettleTimeoutMs: number;
	/** The waits between revocation attempts: one attempt more than there are waits. */
	revokeRetryDelaysMs: readonly number[];
	/** When a refresh lock counts as abandoned: longer than any refresh or sign-out holds it. */
	refreshLockStaleMs: number;
	/** How long to wait for another process's refresh or sign-out. */
	refreshLockWaitMs: number;
	/** How often the account list is read in case watching it misses a change. */
	accountsPollMs: number;
}

const DEFAULT_TIMING: ChatGptBrokerTiming = {
	turnSettleTimeoutMs: 5_000,
	revokeRetryDelaysMs: [ 1_000, 3_000 ],
	refreshLockStaleMs: 120_000,
	refreshLockWaitMs: 60_000,
	accountsPollMs: CHATGPT_TURN_WATCH_POLL_MS,
};

/** A token endpoint response, as the token client parses it. */
export interface ChatGptTokenSet {
	accessToken: string;
	/** A refresh response without one keeps the current refresh token. */
	refreshToken?: string;
	idToken?: string;
	tokenType: string;
	/** Seconds the access token stays valid. */
	expiresIn: number;
	/** Space-separated. A refresh response without it keeps the grant's scopes. */
	scope?: string;
}

export interface ChatGptTokenRequest {
	/** The registration's issued client. */
	clientId: string;
	refreshToken: string;
	signal: AbortSignal;
}

export interface ChatGptTokenServiceError {
	/**
	 * `terminal`: trying again won't help; for a refresh, the refresh token is
	 * dead (see `CHATGPT_TERMINAL_REFRESH_ERRORS`). `transient`: a network
	 * failure or a server error, which may pass.
	 */
	kind: 'terminal' | 'transient';
	code?: string;
	/** The HTTP status; none when the service wasn't reached. */
	status?: number;
}

export type ChatGptTokenServiceResult< T > =
	| { ok: true; value: T }
	| { ok: false; error: ChatGptTokenServiceError };

/** The token endpoint, which the sign-in module implements over HTTP. */
export interface ChatGptTokenClient {
	refresh( request: ChatGptTokenRequest ): Promise< ChatGptTokenServiceResult< ChatGptTokenSet > >;
	/** `ok` once the service confirmed the refresh token is revoked. */
	revoke( request: ChatGptTokenRequest ): Promise< ChatGptTokenServiceResult< void > >;
}

/** A sign-in that completed and was validated, ID token included. */
export interface ChatGptSignIn extends ChatGptAccountSignIn {
	/** The registration signed in to again; none for a new one. */
	registrationId?: string;
	tokens: ChatGptTokenSet;
}

export interface ChatGptSignOutResult {
	/**
	 * No token from before the sign-out is left stored where Studio would use
	 * it. A sign-in that began after the sign-out keeps its own.
	 */
	localCleared: boolean;
	/**
	 * OpenAI confirmed the refresh token is revoked. False when it couldn't be
	 * reached or refused, or Studio held no token to revoke: ChatGPT's settings
	 * may still list Studio as connected.
	 */
	remoteRevocationConfirmed: boolean;
}

/** How one turn reaches its connection's tokens. */
export interface ChatGptTurnHandle {
	readonly connectionId: string;
	/** Aborted once the connection is signed out, or changes, under the turn. */
	readonly signal: AbortSignal;
	/** Before each model request: checks the connection is as the turn began, and returns a current access token. */
	getAccessToken(): Promise< string >;
	/** Before each tool call: the same check. */
	assertActive(): Promise< void >;
	/** Invalidates the rejected token only if it has not already been replaced. */
	invalidateAccessToken( rejectedAccessToken: string ): Promise< void >;
	/** Once the turn has settled, however it ended. */
	end(): void;
}

export interface ChatGptCredentialBrokerOptions {
	tokenClient: ChatGptTokenClient;
	/** The system keychain by default. */
	credentialStore?: OsCredentialStore;
	timing?: Partial< ChatGptBrokerTiming >;
}

export interface ChatGptCredentialBroker {
	saveSignIn( signIn: ChatGptSignIn ): Promise< ChatGptAccount >;
	getAccessToken( connectionId: string ): Promise< string >;
	/** Drops only the rejected access token, preserving any newer token. */
	invalidateAccessToken( connectionId: string, rejectedAccessToken: string ): Promise< void >;
	/** The ID token to send as `id_token_hint` when signing in again, or null. */
	readIdTokenHint( connectionId: string ): Promise< string | null >;
	beginTurn( connectionId: string ): Promise< ChatGptTurnHandle >;
	signOut( connectionId: string ): Promise< ChatGptSignOutResult >;
	listConnections(): Promise< ConnectionRegistryEntry[] >;
	getSessionForkEnvironment(): Record< string, string >;
	answerSessionTokenRequest( message: unknown, reply: ( message: unknown ) => void ): boolean;
	answerSessionTokenInvalidation( message: unknown ): boolean;
	acceptSessionTokensFromParent( channel?: ParentChannel, env?: NodeJS.ProcessEnv ): void;
}

interface CredentialRecord {
	version: typeof RECORD_VERSION;
	registrationId: string;
	clientId: string;
	subject: string;
	idToken: string;
	accessToken: string;
	refreshToken: string;
	tokenType: string;
	/** Milliseconds since the epoch. */
	expiresAt: number;
	scopes: string[];
	savedAt: number;
}

type RecordRead =
	| { status: 'ok'; record: CredentialRecord }
	| { status: 'missing' }
	| { status: 'unusable' }
	// Written by a newer version of Studio: kept for it, never cleared.
	| { status: 'newer' };

type Renewal =
	| { status: 'renewed'; record: CredentialRecord }
	| { status: 'rejected' }
	| { status: 'failed' };

interface AccessToken {
	accessToken: string;
	expiresAt: number;
	tokenGeneration: string;
	logoutGeneration: number;
}

interface SessionCredentials {
	record: CredentialRecord;
	logoutGeneration: number;
	tokenGeneration: string;
}

type RevocationCredentials = Pick< CredentialRecord, 'clientId' | 'refreshToken' >;

interface SessionSignOut {
	/** Known once this sign-out has advanced the account's generation. */
	logoutGeneration?: number;
	credentials: Map< number, RevocationCredentials >;
}

interface ActiveTurn {
	connectionId: string;
	controller: AbortController;
	settled: Promise< void >;
}

const isNonEmptyString = ( value: unknown ): value is string =>
	typeof value === 'string' && value !== '';

const splitScopes = ( scope: string ) => scope.split( /\s+/ ).filter( Boolean );

const isFresh = ( expiresAt: number ) => expiresAt - Date.now() > RENEWAL_MARGIN_MS;

const sleep = ( ms: number ) => new Promise< void >( ( resolve ) => setTimeout( resolve, ms ) );

function isMessageOfType( message: unknown, type: string ): message is Record< string, unknown > {
	return (
		typeof message === 'object' &&
		message !== null &&
		( message as { type?: unknown } ).type === type
	);
}

function isTokenSet( value: unknown ): value is ChatGptTokenSet {
	if ( typeof value !== 'object' || value === null ) {
		return false;
	}
	const set = value as Record< string, unknown >;
	return (
		isNonEmptyString( set.accessToken ) &&
		isNonEmptyString( set.tokenType ) &&
		typeof set.expiresIn === 'number' &&
		Number.isFinite( set.expiresIn ) &&
		set.expiresIn > 0 &&
		( set.refreshToken === undefined || isNonEmptyString( set.refreshToken ) ) &&
		( set.idToken === undefined || isNonEmptyString( set.idToken ) ) &&
		( set.scope === undefined || typeof set.scope === 'string' )
	);
}

function isCredentialRecord( value: unknown ): value is CredentialRecord {
	if ( typeof value !== 'object' || value === null ) {
		return false;
	}
	const record = value as Record< string, unknown >;
	return (
		record.version === RECORD_VERSION &&
		isChatGptRegistrationId( record.registrationId ) &&
		isNonEmptyString( record.clientId ) &&
		isNonEmptyString( record.subject ) &&
		isNonEmptyString( record.idToken ) &&
		isNonEmptyString( record.accessToken ) &&
		isNonEmptyString( record.refreshToken ) &&
		isNonEmptyString( record.tokenType ) &&
		typeof record.expiresAt === 'number' &&
		Array.isArray( record.scopes ) &&
		record.scopes.every( ( scope ) => typeof scope === 'string' ) &&
		typeof record.savedAt === 'number'
	);
}

const recordAad = ( registrationId: string ) =>
	Buffer.from( `studio.chatgpt-credentials.v${ RECORD_VERSION }:${ registrationId }`, 'utf8' );

function sealRecord( key: Buffer, record: CredentialRecord ): string {
	const iv = randomBytes( IV_BYTES );
	const cipher = createCipheriv( 'aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_BYTES } );
	cipher.setAAD( recordAad( record.registrationId ) );
	const ciphertext = Buffer.concat( [
		cipher.update( JSON.stringify( record ), 'utf8' ),
		cipher.final(),
	] );
	return JSON.stringify( {
		version: RECORD_VERSION,
		iv: iv.toString( 'base64' ),
		tag: cipher.getAuthTag().toString( 'base64' ),
		ciphertext: ciphertext.toString( 'base64' ),
	} );
}

// Only an intact record sealed for this registration under this key opens.
function openRecord(
	key: Buffer | null,
	registrationId: string,
	sealed: string
): Exclude< RecordRead, { status: 'missing' } > {
	const unusable = { status: 'unusable' } as const;
	try {
		const envelope: unknown = JSON.parse( sealed );
		if ( typeof envelope !== 'object' || envelope === null ) {
			return unusable;
		}
		const { version, iv, tag, ciphertext } = envelope as Record< string, unknown >;
		if ( typeof version === 'number' && version > RECORD_VERSION ) {
			return { status: 'newer' };
		}
		if (
			! key ||
			version !== RECORD_VERSION ||
			typeof iv !== 'string' ||
			typeof tag !== 'string' ||
			typeof ciphertext !== 'string'
		) {
			return unusable;
		}
		const ivBytes = Buffer.from( iv, 'base64' );
		const tagBytes = Buffer.from( tag, 'base64' );
		if ( ivBytes.length !== IV_BYTES || tagBytes.length !== AUTH_TAG_BYTES ) {
			return unusable;
		}
		const decipher = createDecipheriv( 'aes-256-gcm', key, ivBytes, {
			authTagLength: AUTH_TAG_BYTES,
		} );
		decipher.setAAD( recordAad( registrationId ) );
		decipher.setAuthTag( tagBytes );
		const plaintext = Buffer.concat( [
			decipher.update( Buffer.from( ciphertext, 'base64' ) ),
			decipher.final(),
		] );
		const record: unknown = JSON.parse( plaintext.toString( 'utf8' ) );
		return isCredentialRecord( record ) && record.registrationId === registrationId
			? { status: 'ok', record }
			: unusable;
	} catch {
		return unusable;
	}
}

function readSignInTokens( signIn: ChatGptSignIn ) {
	const { tokens } = signIn;
	if (
		! isNonEmptyString( signIn.issuer ) ||
		! isNonEmptyString( signIn.subject ) ||
		! isIssuedChatGptClientId( signIn.clientId ) ||
		( signIn.storage !== 'vault' && signIn.storage !== 'session' ) ||
		! isTokenSet( tokens ) ||
		! isNonEmptyString( tokens.refreshToken ) ||
		! isNonEmptyString( tokens.idToken ) ||
		typeof tokens.scope !== 'string'
	) {
		throw new ChatGptConnectionError( 'invalid-sign-in' );
	}
	const scopes = splitScopes( tokens.scope );
	// A valid ID token alone doesn't let Studio use the plan.
	if ( ! scopes.includes( CHATGPT_DIRECT_USE_SCOPE ) ) {
		throw new ChatGptConnectionError( 'invalid-sign-in' );
	}
	return { ...tokens, refreshToken: tokens.refreshToken, idToken: tokens.idToken, scopes };
}

function isServiceResult( value: unknown ): value is ChatGptTokenServiceResult< unknown > {
	if ( typeof value !== 'object' || value === null ) {
		return false;
	}
	const result = value as { ok?: unknown; error?: { kind?: unknown } };
	return (
		result.ok === true ||
		( result.ok === false &&
			( result.error?.kind === 'terminal' || result.error?.kind === 'transient' ) )
	);
}

// Always settles: an exception, a hang or a malformed result reads as a transient failure.
async function callTokenService< T >(
	call: ( signal: AbortSignal ) => Promise< ChatGptTokenServiceResult< T > >,
	timeoutMs: number
): Promise< ChatGptTokenServiceResult< T > > {
	const transient: ChatGptTokenServiceResult< T > = { ok: false, error: { kind: 'transient' } };
	const controller = new AbortController();
	let timer: ReturnType< typeof setTimeout > | undefined;
	const timedOut = new Promise< ChatGptTokenServiceResult< T > >( ( resolve ) => {
		timer = setTimeout( () => {
			controller.abort();
			resolve( transient );
		}, timeoutMs );
	} );
	try {
		const result = await Promise.race( [
			Promise.resolve()
				.then( () => call( controller.signal ) )
				.catch( () => transient ),
			timedOut,
		] );
		return isServiceResult( result ) ? result : transient;
	} finally {
		clearTimeout( timer );
	}
}

function requestParentToken(
	channel: ParentChannel,
	connectionId: string,
	logoutGeneration: number
): Promise< AccessToken | null > {
	return new Promise( ( resolve ) => {
		const requestId = randomUUID();
		const finish = ( token: AccessToken | null ) => {
			clearTimeout( timer );
			channel.off( 'message', onMessage );
			resolve( token );
		};
		const onMessage = ( message: unknown ) => {
			if ( isMessageOfType( message, SESSION_TOKEN_REPLY ) && message.requestId === requestId ) {
				const { accessToken, expiresAt, tokenGeneration } = message;
				finish(
					message.connectionId === connectionId &&
						message.logoutGeneration === logoutGeneration &&
						isNonEmptyString( accessToken ) &&
						typeof expiresAt === 'number' &&
						Number.isFinite( expiresAt ) &&
						isChatGptRegistrationId( tokenGeneration )
						? { accessToken, expiresAt, tokenGeneration, logoutGeneration }
						: null
				);
			}
		};
		// An app that never answers fails the turn rather than leave it waiting.
		const timer = setTimeout( () => finish( null ), SESSION_TOKEN_REPLY_TIMEOUT_MS );
		channel.on( 'message', onMessage );
		try {
			channel.send?.(
				{ type: SESSION_TOKEN_REQUEST, requestId, connectionId, logoutGeneration },
				( error ) => {
					if ( error ) {
						finish( null );
					}
				}
			);
		} catch {
			finish( null );
		}
	} );
}

async function withLock< T >(
	lockPath: string,
	options: { wait: number; stale: number },
	task: () => Promise< T >
): Promise< T > {
	await fs.mkdir( path.dirname( lockPath ), { recursive: true, mode: 0o700 } );
	const release = await lockChatGptFile( lockPath, options );
	try {
		return await task();
	} finally {
		await release();
	}
}

export function createChatGptCredentialBroker(
	options: ChatGptCredentialBrokerOptions
): ChatGptCredentialBroker {
	const { tokenClient } = options;
	const credentialStore = options.credentialStore ?? createOsCredentialStore();
	const timing: ChatGptBrokerTiming = { ...DEFAULT_TIMING, ...options.timing };
	let wrappingKey: Buffer | null = null;
	// Session-only tokens this app holds, with the logout generation they belong to.
	const sessions = new Map< string, SessionCredentials >();
	const sessionQueues = new Map< string, Promise< unknown > >();
	// Pruning can remove active credentials while sign-out waits for a fork or refresh.
	const sessionSignOuts = new Map< string, Set< SessionSignOut > >();
	let stopWatchingSessions: ( () => void ) | null = null;
	// In a turn forked by an app holding session-only tokens: how to ask it for them.
	let parent: {
		channel: ParentChannel;
		offered: Set< string >;
		tokens: Map< string, AccessToken >;
	} | null = null;
	const turns = new Set< ActiveTurn >();

	const credentialsDirectory = () => path.join( getConfigDirectory(), CREDENTIALS_DIRECTORY );
	const recordFile = ( registrationId: string ) => `${ registrationId }.vault`;

	function vaultUnavailable( error: unknown, secret?: string ): ChatGptConnectionError {
		const reason = error instanceof Error ? error.message : String( error );
		return new ChatGptConnectionError(
			'vault-unavailable',
			secret ? reason.split( secret ).join( '[redacted]' ) : reason
		);
	}

	async function readWrappingKeyText(): Promise< string | null > {
		try {
			return await credentialStore.get( WRAPPING_KEY_ACCOUNT );
		} catch ( error ) {
			throw vaultUnavailable( error );
		}
	}

	function cacheWrappingKey( text: string ): Buffer {
		if ( ! WRAPPING_KEY_TEXT.test( text ) ) {
			throw new ChatGptConnectionError(
				'vault-unavailable',
				__( 'the key Studio saved there is damaged' )
			);
		}
		wrappingKey = Buffer.from( text, 'base64url' );
		return wrappingKey;
	}

	/** The vault's key, as this process last read it; null while there is none. */
	async function getWrappingKey(): Promise< Buffer | null > {
		if ( wrappingKey ) {
			return wrappingKey;
		}
		const text = await readWrappingKeyText();
		return text ? cacheWrappingKey( text ) : null;
	}

	/**
	 * The key a record is sealed with: the one the keychain holds now, which
	 * another process may have put there since this one last read it. Created
	 * there, under the key's lock, only when there is none.
	 */
	async function getSealingKey(): Promise< Buffer > {
		const text = await withLock(
			path.join( credentialsDirectory(), 'vault-key.lock' ),
			{ wait: WRAPPING_KEY_LOCK_MS, stale: WRAPPING_KEY_LOCK_MS },
			async () => {
				const existing = await readWrappingKeyText();
				if ( existing ) {
					return existing;
				}
				const created = randomBytes( WRAPPING_KEY_BYTES ).toString( 'base64url' );
				try {
					await credentialStore.set( WRAPPING_KEY_ACCOUNT, created );
				} catch ( error ) {
					throw vaultUnavailable( error, created );
				}
				return created;
			}
		);
		return cacheWrappingKey( text );
	}

	async function lockRefresh( registrationId: string ): Promise< () => Promise< void > > {
		await fs.mkdir( credentialsDirectory(), { recursive: true, mode: 0o700 } );
		return lockChatGptFile( path.join( credentialsDirectory(), `${ registrationId }.lock` ), {
			wait: timing.refreshLockWaitMs,
			stale: timing.refreshLockStaleMs,
		} );
	}

	async function readSealedRecord( registrationId: string ): Promise< string | null > {
		try {
			return await readFile( path.join( credentialsDirectory(), recordFile( registrationId ) ), {
				encoding: 'utf8',
			} );
		} catch ( error ) {
			if ( isErrnoException( error ) && error.code === 'ENOENT' ) {
				return null;
			}
			throw error;
		}
	}

	async function readRecord( key: Buffer | null, account: ChatGptAccount ): Promise< RecordRead > {
		const sealed = await readSealedRecord( account.registrationId );
		if ( sealed === null ) {
			return { status: 'missing' };
		}
		const opened = openRecord( key, account.registrationId, sealed );
		// A record for another client or account than its registration's is never used.
		if (
			opened.status === 'ok' &&
			( opened.record.clientId !== account.clientId || opened.record.subject !== account.subject )
		) {
			return { status: 'unusable' };
		}
		return opened;
	}

	// A record the held key can't open may be sealed under a key that replaced
	// it in the keychain since this process last read it: the cached key goes,
	// the keychain is read again, and the record is tried once more.
	async function readRecordRetryingStaleKey(
		account: ChatGptAccount,
		heldKey: Buffer | null
	): Promise< { key: Buffer | null; read: RecordRead } > {
		const read = await readRecord( heldKey, account );
		if ( read.status !== 'unusable' ) {
			return { key: heldKey, read };
		}
		wrappingKey = null;
		const key = await getWrappingKey();
		return { key, read: await readRecord( key, account ) };
	}

	const writeSealedRecord = ( registrationId: string, sealed: string ) =>
		writeChatGptFileAtomically( credentialsDirectory(), recordFile( registrationId ), sealed );

	const removeRecord = ( registrationId: string ) =>
		removeChatGptFile( credentialsDirectory(), recordFile( registrationId ) );

	async function requireSignedIn( connectionId: string ): Promise< ChatGptAccount > {
		const account = await readChatGptAccount( connectionId );
		if ( ! account ) {
			throw new ChatGptConnectionError( 'not-found' );
		}
		if ( account.state !== 'signed-in' ) {
			throw new ChatGptConnectionError(
				account.state === 'signed-out' ? 'signed-out' : 'needs-sign-in'
			);
		}
		return account;
	}

	const isUnchanged = ( account: ChatGptAccount | null, logoutGeneration: number ) =>
		account?.state === 'signed-in' && account.logoutGeneration === logoutGeneration;

	// The registration as it is now, provided no sign-out happened since `logoutGeneration`.
	async function requireUnchanged(
		registrationId: string,
		logoutGeneration: number
	): Promise< ChatGptAccount > {
		const account = await requireSignedIn( registrationId );
		if ( account.logoutGeneration !== logoutGeneration ) {
			throw new ChatGptConnectionError( 'signed-out' );
		}
		return account;
	}

	function revokeQuietly( clientId: string, refreshToken: string ): void {
		void callTokenService(
			( signal ) => tokenClient.revoke( { clientId, refreshToken, signal } ),
			REVOKE_TIMEOUT_MS
		);
	}

	async function revoke( clientId: string, refreshToken: string ): Promise< boolean > {
		for ( let attempt = 0; ; attempt++ ) {
			const result = await callTokenService(
				( signal ) => tokenClient.revoke( { clientId, refreshToken, signal } ),
				REVOKE_TIMEOUT_MS
			);
			if ( result.ok ) {
				return true;
			}
			const delay = timing.revokeRetryDelaysMs[ attempt ];
			if ( result.error.kind !== 'transient' || delay === undefined ) {
				return false;
			}
			await sleep( delay );
		}
	}

	async function renew( account: ChatGptAccount, record: CredentialRecord ): Promise< Renewal > {
		const result = await callTokenService(
			( signal ) =>
				tokenClient.refresh( {
					clientId: account.clientId,
					refreshToken: record.refreshToken,
					signal,
				} ),
			REFRESH_TIMEOUT_MS
		);
		if ( ! result.ok ) {
			return { status: result.error.kind === 'terminal' ? 'rejected' : 'failed' };
		}
		if ( ! isTokenSet( result.value ) ) {
			return { status: 'failed' };
		}
		const tokens = result.value;
		const now = Date.now();
		// The ID token stays the one a sign-in verified.
		const renewed: CredentialRecord = {
			...record,
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken ?? record.refreshToken,
			tokenType: tokens.tokenType,
			expiresAt: now + tokens.expiresIn * 1000,
			scopes: tokens.scope === undefined ? record.scopes : splitScopes( tokens.scope ),
			savedAt: now,
		};
		if ( ! renewed.scopes.includes( CHATGPT_DIRECT_USE_SCOPE ) ) {
			revokeQuietly( account.clientId, renewed.refreshToken );
			return { status: 'rejected' };
		}
		return { status: 'renewed', record: renewed };
	}

	// The record can't be used again: it goes, and the registration needs a
	// sign-in, unless it was signed out meanwhile.
	async function clearUnusable( account: ChatGptAccount ): Promise< void > {
		await removeRecord( account.registrationId );
		await markChatGptSignInNeeded( account.registrationId, account.logoutGeneration );
	}

	// Under the registration's refresh lock, the record is read again: another
	// process may have renewed it, or found it unusable, while this one waited.
	async function renewVaultRecord(
		account: ChatGptAccount,
		heldKey: Buffer | null
	): Promise< string > {
		const { registrationId, logoutGeneration } = account;
		const unlock = await lockRefresh( registrationId ).catch( () => {
			throw new ChatGptConnectionError( 'refresh-failed' );
		} );
		try {
			const current = await requireUnchanged( registrationId, logoutGeneration );
			if ( current.storage !== 'vault' ) {
				throw new ChatGptConnectionError( 'session-unavailable' );
			}
			const { key, read } = await readRecordRetryingStaleKey( current, heldKey );
			if ( read.status === 'newer' ) {
				throw new ChatGptConnectionError( 'newer-format' );
			}
			if ( read.status !== 'ok' || ! key ) {
				await clearUnusable( current );
				throw new ChatGptConnectionError( 'needs-sign-in' );
			}
			if ( isFresh( read.record.expiresAt ) ) {
				return read.record.accessToken;
			}
			const renewal = await renew( current, read.record );
			if ( renewal.status === 'failed' ) {
				throw new ChatGptConnectionError( 'refresh-failed' );
			}
			if ( renewal.status === 'rejected' ) {
				await clearUnusable( current );
				throw new ChatGptConnectionError( 'needs-sign-in' );
			}
			// A sign-out since the refresh began wins: nothing is written.
			if ( ! isUnchanged( await readChatGptAccount( registrationId ), logoutGeneration ) ) {
				revokeQuietly( current.clientId, renewal.record.refreshToken );
				throw new ChatGptConnectionError( 'signed-out' );
			}
			await writeSealedRecord( registrationId, sealRecord( key, renewal.record ) );
			return renewal.record.accessToken;
		} finally {
			await unlock();
		}
	}

	async function getVaultAccessToken( account: ChatGptAccount ): Promise< string > {
		const key = await getWrappingKey();
		const read = await readRecord( key, account );
		if ( read.status === 'newer' ) {
			throw new ChatGptConnectionError( 'newer-format' );
		}
		if ( read.status === 'ok' && isFresh( read.record.expiresAt ) ) {
			return read.record.accessToken;
		}
		return renewVaultRecord( account, key );
	}

	// One session-only operation at a time per registration in this process,
	// which alone holds its refresh token.
	function serializeSession< T >( registrationId: string, task: () => Promise< T > ): Promise< T > {
		const previous = sessionQueues.get( registrationId ) ?? Promise.resolve();
		const next = previous.then( task, task );
		const settled = next.then(
			() => undefined,
			() => undefined
		);
		sessionQueues.set( registrationId, settled );
		void settled.then( () => {
			if ( sessionQueues.get( registrationId ) === settled ) {
				sessionQueues.delete( registrationId );
			}
		} );
		return next;
	}

	function retainSessionRevocation(
		registrationId: string,
		logoutGeneration: number,
		record: CredentialRecord
	): boolean {
		let owned = false;
		for ( const pending of sessionSignOuts.get( registrationId ) ?? [] ) {
			if (
				pending.logoutGeneration === undefined ||
				pending.logoutGeneration === logoutGeneration
			) {
				pending.credentials.set( logoutGeneration, {
					clientId: record.clientId,
					refreshToken: record.refreshToken,
				} );
				owned ||= pending.logoutGeneration === logoutGeneration;
			}
		}
		return owned;
	}

	const sessionAccessToken = ( session: SessionCredentials ): AccessToken => ( {
		accessToken: session.record.accessToken,
		expiresAt: session.record.expiresAt,
		tokenGeneration: session.tokenGeneration,
		logoutGeneration: session.logoutGeneration,
	} );

	// While this app holds a session-only sign-in, it watches for a sign-out
	// anywhere, so it stops holding and offering tokens nothing should use.
	function holdSession(
		registrationId: string,
		session: { record: CredentialRecord; logoutGeneration: number }
	): SessionCredentials {
		const held = { ...session, tokenGeneration: randomUUID() };
		sessions.set( registrationId, held );
		retainSessionRevocation( registrationId, held.logoutGeneration, held.record );
		stopWatchingSessions ??= watchChatGptAccounts( pruneSessions, timing.accountsPollMs );
		return held;
	}

	function dropSession( registrationId: string ): void {
		sessions.delete( registrationId );
		if ( ! sessions.size && stopWatchingSessions ) {
			stopWatchingSessions();
			stopWatchingSessions = null;
		}
	}

	// A held record goes once its registration was signed out, here or in
	// another process, or keeps its tokens elsewhere now.
	function pruneSession( registrationId: string ): Promise< void > {
		return serializeSession( registrationId, async () => {
			const held = sessions.get( registrationId );
			if ( ! held ) {
				return;
			}
			const account = await readChatGptAccount( registrationId );
			if (
				account?.state !== 'signed-in' ||
				account.storage !== 'session' ||
				account.logoutGeneration !== held.logoutGeneration
			) {
				dropSession( registrationId );
			}
		} );
	}

	async function pruneSessions(): Promise< void > {
		await Promise.all( [ ...sessions.keys() ].map( pruneSession ) );
	}

	function renewSession( account: ChatGptAccount ): Promise< AccessToken > {
		const { registrationId, logoutGeneration } = account;
		return serializeSession( registrationId, async () => {
			const current = await requireUnchanged( registrationId, logoutGeneration );
			const held = sessions.get( registrationId );
			if ( ! held || held.logoutGeneration !== logoutGeneration || current.storage !== 'session' ) {
				if ( held ) {
					dropSession( registrationId );
				}
				throw new ChatGptConnectionError( 'session-unavailable' );
			}
			if ( isFresh( held.record.expiresAt ) ) {
				return sessionAccessToken( held );
			}
			const renewal = await renew( current, held.record );
			if ( renewal.status === 'failed' ) {
				throw new ChatGptConnectionError( 'refresh-failed' );
			}
			if ( renewal.status === 'rejected' ) {
				dropSession( registrationId );
				await markChatGptSignInNeeded( registrationId, logoutGeneration );
				throw new ChatGptConnectionError( 'needs-sign-in' );
			}
			if ( ! isUnchanged( await readChatGptAccount( registrationId ), logoutGeneration ) ) {
				if ( ! retainSessionRevocation( registrationId, logoutGeneration, renewal.record ) ) {
					revokeQuietly( current.clientId, renewal.record.refreshToken );
				}
				throw new ChatGptConnectionError( 'signed-out' );
			}
			return sessionAccessToken(
				holdSession( registrationId, { record: renewal.record, logoutGeneration } )
			);
		} );
	}

	async function getSessionAccessToken( account: ChatGptAccount ): Promise< AccessToken > {
		const { registrationId, logoutGeneration } = account;
		if ( sessions.has( registrationId ) ) {
			return renewSession( account );
		}
		if ( ! parent?.offered.has( registrationId ) ) {
			throw new ChatGptConnectionError( 'session-unavailable' );
		}
		const cached = parent.tokens.get( registrationId );
		if ( cached && cached.logoutGeneration === logoutGeneration && isFresh( cached.expiresAt ) ) {
			return cached;
		}
		const token = await requestParentToken( parent.channel, registrationId, logoutGeneration );
		if ( ! token ) {
			parent.tokens.delete( registrationId );
			throw new ChatGptConnectionError( 'session-unavailable' );
		}
		parent.tokens.set( registrationId, token );
		return token;
	}

	async function getAccessToken( connectionId: string ): Promise< string > {
		const account = await requireSignedIn( connectionId );
		return account.storage === 'session'
			? ( await getSessionAccessToken( account ) ).accessToken
			: getVaultAccessToken( account );
	}

	function invalidateSessionToken(
		connectionId: string,
		matches: ( held: SessionCredentials ) => boolean
	): Promise< void > {
		return serializeSession( connectionId, async () => {
			const held = sessions.get( connectionId );
			if ( held && matches( held ) ) {
				sessions.set( connectionId, {
					...held,
					record: { ...held.record, expiresAt: 0 },
				} );
			}
		} );
	}

	async function invalidateAccessToken(
		connectionId: string,
		rejectedAccessToken: string
	): Promise< void > {
		const cached = parent?.tokens.get( connectionId );
		const account = await readChatGptAccount( connectionId );
		if ( ! account || account.state !== 'signed-in' ) {
			return;
		}
		if ( account.storage === 'session' ) {
			if ( parent && cached?.accessToken === rejectedAccessToken ) {
				if ( parent.tokens.get( connectionId ) === cached ) {
					parent.tokens.delete( connectionId );
				}
				try {
					parent.channel.send?.(
						{
							type: SESSION_TOKEN_INVALIDATE,
							connectionId,
							tokenGeneration: cached.tokenGeneration,
							logoutGeneration: cached.logoutGeneration,
						},
						() => undefined
					);
				} catch {
					// The app has gone; the next request fails closed anyway.
				}
			}
			await invalidateSessionToken(
				connectionId,
				( held ) =>
					held.logoutGeneration === account.logoutGeneration &&
					held.record.accessToken === rejectedAccessToken
			);
			return;
		}
		const unlock = await lockRefresh( connectionId ).catch( () => null );
		if ( ! unlock ) {
			return;
		}
		try {
			const current = await readChatGptAccount( connectionId );
			if (
				! current ||
				current.state !== 'signed-in' ||
				current.storage !== 'vault' ||
				current.logoutGeneration !== account.logoutGeneration
			) {
				return;
			}
			const heldKey = await getWrappingKey().catch( () => null );
			const { key, read } = await readRecordRetryingStaleKey( current, heldKey );
			if ( read.status === 'ok' && key && read.record.accessToken === rejectedAccessToken ) {
				await writeSealedRecord(
					connectionId,
					sealRecord( key, { ...read.record, expiresAt: 0 } )
				);
			}
		} finally {
			await unlock();
		}
	}

	async function readIdTokenHint( connectionId: string ): Promise< string | null > {
		const account = await readChatGptAccount( connectionId );
		if ( account?.state !== 'signed-in' ) {
			return null;
		}
		if ( account.storage === 'session' ) {
			return sessions.get( connectionId )?.record.idToken ?? null;
		}
		const key = await getWrappingKey().catch( () => null );
		try {
			const { read } = await readRecordRetryingStaleKey( account, key );
			return read.status === 'ok' ? read.record.idToken : null;
		} catch ( error ) {
			// No hint is better than failing the sign-in the hint only helps.
			if ( error instanceof ChatGptConnectionError && error.code === 'vault-unavailable' ) {
				return null;
			}
			throw error;
		}
	}

	async function saveSignIn( signIn: ChatGptSignIn ): Promise< ChatGptAccount > {
		const tokens = readSignInTokens( signIn );
		const existing = signIn.registrationId;
		// Where this sign-in begins: a sign-out started since then wins over it.
		let logoutGeneration = 0;
		if ( existing !== undefined ) {
			const account = await readChatGptAccount( existing );
			if ( ! account ) {
				throw new ChatGptConnectionError( 'not-found' );
			}
			if ( ! isSameChatGptIdentity( account, signIn ) ) {
				throw new ChatGptConnectionError( 'identity-mismatch' );
			}
			logoutGeneration = account.logoutGeneration;
		}
		const registrationId = existing ?? createChatGptRegistrationId();
		const now = Date.now();
		const record: CredentialRecord = {
			version: RECORD_VERSION,
			registrationId,
			clientId: signIn.clientId,
			subject: signIn.subject,
			idToken: tokens.idToken,
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
			tokenType: tokens.tokenType,
			expiresAt: now + tokens.expiresIn * 1000,
			scopes: tokens.scopes,
			savedAt: now,
		};
		const key = signIn.storage === 'vault' ? await getSealingKey() : null;
		const accountSignIn: ChatGptAccountSignIn = {
			issuer: signIn.issuer,
			subject: signIn.subject,
			email: signIn.email,
			clientId: signIn.clientId,
			label: signIn.label,
			storage: signIn.storage,
		};

		const unlock = await lockRefresh( registrationId );
		try {
			const previous = key ? await readSealedRecord( registrationId ) : null;
			if ( key ) {
				await writeSealedRecord( registrationId, sealRecord( key, record ) );
			}
			let account: ChatGptAccount;
			try {
				account = existing
					? await updateChatGptAccountSignIn( registrationId, accountSignIn, logoutGeneration )
					: await createChatGptAccount( registrationId, accountSignIn );
			} catch ( error ) {
				// A sign-in that couldn't be recorded leaves the registration's tokens
				// as they were, for a sign-out that overtook it to clear.
				if ( previous !== null ) {
					await writeSealedRecord( registrationId, previous );
				} else if ( key ) {
					await removeRecord( registrationId );
				}
				if ( error instanceof ChatGptConnectionError && error.code === 'signed-out' ) {
					revokeQuietly( signIn.clientId, tokens.refreshToken );
				}
				throw error;
			}
			await serializeSession( registrationId, async () => {
				if ( key ) {
					dropSession( registrationId );
				} else {
					holdSession( registrationId, { record, logoutGeneration: account.logoutGeneration } );
				}
			} );
			parent?.tokens.delete( registrationId );
			// A record kept from before a switch to this session only is never read again.
			if ( ! key ) {
				await removeRecord( registrationId );
			}
			return account;
		} finally {
			await unlock();
		}
	}

	async function beginTurn( connectionId: string ): Promise< ChatGptTurnHandle > {
		const { logoutGeneration, revision } = await requireSignedIn( connectionId );
		const controller = new AbortController();
		let settle = () => {};
		const turn: ActiveTurn = {
			connectionId,
			controller,
			settled: new Promise< void >( ( resolve ) => ( settle = resolve ) ),
		};
		turns.add( turn );
		const stop = ( code: 'signed-out' | 'needs-sign-in' | 'changed' ) => {
			const error = new ChatGptConnectionError( code );
			controller.abort( error );
			return error;
		};
		// The registration as saved, which another process may have signed out.
		const check = async () => {
			const current = await readChatGptAccount( connectionId );
			if ( ! current || current.logoutGeneration !== logoutGeneration ) {
				throw stop( 'signed-out' );
			}
			if ( current.state !== 'signed-in' ) {
				throw stop( current.state === 'needs-sign-in' ? 'needs-sign-in' : 'signed-out' );
			}
			if ( current.revision !== revision ) {
				throw stop( 'changed' );
			}
		};
		const assertActive = async () => {
			if ( controller.signal.aborted ) {
				throw controller.signal.reason;
			}
			await check();
			if ( controller.signal.aborted ) {
				throw controller.signal.reason;
			}
		};
		// A sign-out in another process aborts the turn too, between requests
		// or in the middle of one, within the watch's poll bound.
		const stopWatching = watchChatGptAccounts( check, timing.accountsPollMs );
		controller.signal.addEventListener( 'abort', stopWatching, { once: true } );
		return {
			connectionId,
			signal: controller.signal,
			assertActive,
			async getAccessToken() {
				await assertActive();
				const token = await getAccessToken( connectionId );
				if ( controller.signal.aborted ) {
					throw controller.signal.reason;
				}
				return token;
			},
			async invalidateAccessToken( rejectedAccessToken ) {
				await assertActive();
				await invalidateAccessToken( connectionId, rejectedAccessToken );
			},
			end() {
				stopWatching();
				if ( turns.delete( turn ) ) {
					settle();
				}
			},
		};
	}

	async function endTurns( connectionId: string ): Promise< void > {
		const ending = [ ...turns ].filter( ( turn ) => turn.connectionId === connectionId );
		if ( ! ending.length ) {
			return;
		}
		const reason = new ChatGptConnectionError( 'signed-out' );
		for ( const turn of ending ) {
			turn.controller.abort( reason );
		}
		let timer: ReturnType< typeof setTimeout > | undefined;
		await Promise.race( [
			Promise.all( ending.map( ( turn ) => turn.settled ) ),
			new Promise< void >(
				( resolve ) => ( timer = setTimeout( resolve, timing.turnSettleTimeoutMs ) )
			),
		] );
		clearTimeout( timer );
	}

	/**
	 * Raises the logout generation, ends this process's turns on the account,
	 * revokes the refresh token and clears every token. The registration, its
	 * issued client and the host id stay, for the next sign-in. A sign-in that
	 * began after the sign-out did keeps what it saved.
	 */
	async function signOut( connectionId: string ): Promise< ChatGptSignOutResult > {
		if ( ! isChatGptRegistrationId( connectionId ) ) {
			throw new ChatGptConnectionError( 'not-found' );
		}
		const pending: SessionSignOut = { credentials: new Map() };
		const held = sessions.get( connectionId );
		if ( held ) {
			pending.credentials.set( held.logoutGeneration, {
				clientId: held.record.clientId,
				refreshToken: held.record.refreshToken,
			} );
		}
		const signingOut = sessionSignOuts.get( connectionId ) ?? new Set< SessionSignOut >();
		signingOut.add( pending );
		sessionSignOuts.set( connectionId, signingOut );
		try {
			const account = await startChatGptSignOut( connectionId );
			const logoutGeneration = account.logoutGeneration - 1;
			pending.logoutGeneration = logoutGeneration;
			for ( const generation of pending.credentials.keys() ) {
				if ( generation !== logoutGeneration ) {
					pending.credentials.delete( generation );
				}
			}
			await endTurns( connectionId );
			parent?.tokens.delete( connectionId );
			const key = await getWrappingKey().catch( () => null );
			const unlock = await lockRefresh( connectionId ).catch( () => null );
			try {
				// Wait for an in-flight session refresh to retain its rotated credential.
				await serializeSession( connectionId, async () => {
					const current = sessions.get( connectionId );
					if ( current && current.logoutGeneration <= logoutGeneration ) {
						dropSession( connectionId );
					}
				} );
				// A newer sign-in may share the old grant; revoking it could end that sign-in too.
				if ( ( await readChatGptAccount( connectionId ) )?.state === 'signed-in' ) {
					return { localCleared: true, remoteRevocationConfirmed: false };
				}
				const session = pending.credentials.get( logoutGeneration );
				const vault = session
					? null
					: await readRecordRetryingStaleKey( account, key ).catch( () => null );
				const record = session ?? ( vault?.read.status === 'ok' ? vault.read.record : null );
				const remoteRevocationConfirmed = record
					? await revoke( record.clientId, record.refreshToken )
					: false;
				const localCleared = await removeRecord( connectionId );
				return { localCleared, remoteRevocationConfirmed };
			} finally {
				await unlock?.();
			}
		} finally {
			pending.credentials.clear();
			signingOut.delete( pending );
			if ( ! signingOut.size ) {
				sessionSignOuts.delete( connectionId );
			}
		}
	}

	// Signed in, with tokens this process can reach.
	function canRunHere( account: ChatGptAccount ): boolean {
		if ( account.state !== 'signed-in' ) {
			return false;
		}
		if ( account.storage === 'vault' ) {
			return true;
		}
		const held = sessions.get( account.registrationId );
		return held
			? held.logoutGeneration === account.logoutGeneration
			: Boolean( parent?.offered.has( account.registrationId ) );
	}

	async function listConnections(): Promise< ConnectionRegistryEntry[] > {
		return ( await readChatGptAccounts() ).map( ( account ) => ( {
			connectionId: account.registrationId,
			providerId: 'chatgpt-oauth',
			backend: 'pi',
			revision: account.revision,
			identity: { subject: account.subject, ...( account.email ? { email: account.email } : {} ) },
			authStatus: canRunHere( account ) ? 'connected' : 'disconnected',
		} ) );
	}

	function getSessionForkEnvironment(): Record< string, string > {
		return sessions.size ? { [ SESSION_OFFER_ENV ]: [ ...sessions.keys() ].join( ',' ) } : {};
	}

	function answerSessionTokenRequest(
		message: unknown,
		reply: ( message: unknown ) => void
	): boolean {
		if ( ! isMessageOfType( message, SESSION_TOKEN_REQUEST ) ) {
			return false;
		}
		const { requestId, connectionId, logoutGeneration } = message;
		void ( async () => {
			let token: AccessToken | null = null;
			// Only a session-only sign-in this app holds is handed over; a turn
			// reads a stored one itself.
			if (
				typeof connectionId === 'string' &&
				typeof logoutGeneration === 'number' &&
				Number.isSafeInteger( logoutGeneration ) &&
				logoutGeneration >= 0 &&
				sessions.has( connectionId )
			) {
				try {
					await pruneSession( connectionId );
					if ( sessions.has( connectionId ) ) {
						token = await renewSession( await requireUnchanged( connectionId, logoutGeneration ) );
					}
				} catch {
					token = null;
				}
			}
			try {
				reply( {
					type: SESSION_TOKEN_REPLY,
					requestId,
					connectionId,
					accessToken: token?.accessToken ?? null,
					expiresAt: token?.expiresAt ?? null,
					tokenGeneration: token?.tokenGeneration ?? null,
					logoutGeneration: token?.logoutGeneration ?? null,
				} );
			} catch {
				// The turn has gone.
			}
		} )();
		return true;
	}

	function answerSessionTokenInvalidation( message: unknown ): boolean {
		if ( ! isMessageOfType( message, SESSION_TOKEN_INVALIDATE ) ) {
			return false;
		}
		const { connectionId, tokenGeneration, logoutGeneration } = message;
		if (
			isChatGptRegistrationId( connectionId ) &&
			isChatGptRegistrationId( tokenGeneration ) &&
			typeof logoutGeneration === 'number' &&
			Number.isSafeInteger( logoutGeneration ) &&
			logoutGeneration >= 0
		) {
			// Enqueue before the next IPC request, comparing again after any refresh finishes.
			void invalidateSessionToken(
				connectionId,
				( held ) =>
					held.tokenGeneration === tokenGeneration && held.logoutGeneration === logoutGeneration
			).catch( () => undefined );
		}
		return true;
	}

	function acceptSessionTokensFromParent(
		channel: ParentChannel = process as unknown as ParentChannel,
		env: NodeJS.ProcessEnv = process.env
	): void {
		const offered = ( env[ SESSION_OFFER_ENV ] ?? '' )
			.split( ',' )
			.filter( isChatGptRegistrationId );
		delete env[ SESSION_OFFER_ENV ];
		if ( offered.length && typeof channel.send === 'function' ) {
			parent = { channel, offered: new Set( offered ), tokens: new Map() };
		}
	}

	return {
		saveSignIn,
		getAccessToken,
		invalidateAccessToken,
		readIdTokenHint,
		beginTurn,
		signOut,
		listConnections,
		getSessionForkEnvironment,
		answerSessionTokenRequest,
		answerSessionTokenInvalidation,
		acceptSessionTokensFromParent,
	};
}

let configuredTokenClient: ChatGptTokenClient | null = null;
let appBroker: ChatGptCredentialBroker | undefined;

/** The token service the app's broker uses: the sign-in module's HTTP client. */
export function setChatGptTokenClient( client: ChatGptTokenClient ): void {
	configuredTokenClient = client;
}

// Until a token client is set, a refresh fails with the credentials kept, and
// a revocation is reported unconfirmed.
function getAppBroker(): ChatGptCredentialBroker {
	appBroker ??= createChatGptCredentialBroker( {
		tokenClient: {
			refresh: ( request ) =>
				configuredTokenClient?.refresh( request ) ??
				Promise.resolve( { ok: false, error: { kind: 'transient', code: 'no_token_client' } } ),
			revoke: ( request ) =>
				configuredTokenClient?.revoke( request ) ??
				Promise.resolve( { ok: false, error: { kind: 'terminal', code: 'no_token_client' } } ),
		},
	} );
	return appBroker;
}

/** Saves a completed, validated sign-in as a new registration or to the one it names. */
export function saveChatGptSignIn( signIn: ChatGptSignIn ): Promise< ChatGptAccount > {
	return getAppBroker().saveSignIn( signIn );
}

/** A current access token for the connection, renewed first when it is about to expire. */
export function getChatGptAccessToken( connectionId: string ): Promise< string > {
	return getAppBroker().getAccessToken( connectionId );
}

/** Drops only the access token that the route rejected. */
export function invalidateChatGptAccessToken(
	connectionId: string,
	rejectedAccessToken: string
): Promise< void > {
	return getAppBroker().invalidateAccessToken( connectionId, rejectedAccessToken );
}

/** The verified ID token kept for the connection, to send as `id_token_hint` when signing in again. */
export function readChatGptIdTokenHint( connectionId: string ): Promise< string | null > {
	return getAppBroker().readIdTokenHint( connectionId );
}

/** Starts a turn on the connection; a sign-out ends it. */
export function beginChatGptTurn( connectionId: string ): Promise< ChatGptTurnHandle > {
	return getAppBroker().beginTurn( connectionId );
}

export function signOutChatGpt( connectionId: string ): Promise< ChatGptSignOutResult > {
	return getAppBroker().signOut( connectionId );
}

/** The ChatGPT connections, as the connection registry lists them. */
export function listChatGptConnections(): Promise< ConnectionRegistryEntry[] > {
	return getAppBroker().listConnections();
}

/**
 * The environment a forked turn gets from this app: the registrations whose
 * session-only tokens it may ask for, never a token.
 */
export function getChatGptSessionForkEnvironment(): Record< string, string > {
	return getAppBroker().getSessionForkEnvironment();
}

/**
 * Answers a forked turn asking for a session-only access token, through
 * `reply` (the child's IPC channel). False for any other message.
 */
export function answerChatGptSessionTokenRequest(
	message: unknown,
	reply: ( message: unknown ) => void
): boolean {
	return getAppBroker().answerSessionTokenRequest( message, reply );
}

/**
 * Takes in a forked turn's word that the session-only access token it was
 * handed was rejected: this app stops handing it out, so the turn's next
 * request refreshes. False for any other message.
 */
export function answerChatGptSessionTokenInvalidation( message: unknown ): boolean {
	return getAppBroker().answerSessionTokenInvalidation( message );
}

/**
 * In a turn forked by a Studio app that holds session-only ChatGPT tokens:
 * lets the turn ask it for access tokens. Call at startup.
 */
export function acceptChatGptSessionTokensFromParent(
	channel?: ParentChannel,
	env?: NodeJS.ProcessEnv
): void {
	getAppBroker().acceptSessionTokensFromParent( channel, env );
}
