import {
	createOsCredentialStore,
	SecureStorageError,
	type CredentialStoreStatus,
	type OsCredentialStore,
} from '@studio/common/lib/os-credential-store';
import { __, sprintf } from '@wordpress/i18n';
import type { OpenAiKeyStorage } from '@studio/agent/protocol/providers';

/**
 * Where the OpenAI API key lives. Backend-only: the Desktop main process, the
 * `studio ui` server and the CLI use it; nothing here ever reaches a renderer.
 *
 * The key goes to the system keychain. When this machine has none, the user
 * can keep a key for the current app session instead: it stays in this
 * process's memory, never written down, and a forked CLI turn that needs it
 * asks for it over the Node IPC channel. It never travels in a child's
 * environment or arguments, which other programs running as the user can read
 * (on Linux, `/proc/<pid>/environ` keeps the starting environment even after
 * the process deletes a variable).
 */

const KEYCHAIN_ACCOUNT = 'openai-api-key';
// Set to "1" on a forked CLI turn's environment when the app keeps a session
// key, so the turn knows it may ask. It carries no secret.
const OPENAI_SESSION_KEY_OFFER_ENV = 'STUDIO_OPENAI_SESSION_KEY_OFFERED';
const SESSION_KEY_REQUEST = 'studio.openai-session-key.request';
const SESSION_KEY_REPLY = 'studio.openai-session-key';
const SESSION_KEY_REPLY_TIMEOUT_MS = 10_000;
const UNAVAILABLE_RECHECK_MS = 30_000;

let store: OsCredentialStore | undefined;
let sessionKey: string | null = null;
// In a forked CLI turn: asks the app that started it for its session key.
let requestParentSessionKey: ( () => Promise< string | null > ) | null = null;
let cachedStatus: { status: CredentialStoreStatus; checkedAt: number } | undefined;
let pending: Promise< unknown > = Promise.resolve();

function getStore(): OsCredentialStore {
	store ??= createOsCredentialStore();
	return store;
}

// One credential operation at a time in this process, so a save and a removal
// can't interleave between the keychain and the session key.
function serialize< T >( operation: () => Promise< T > ): Promise< T > {
	const next = pending.then( operation, operation );
	pending = next.catch( () => undefined );
	return next;
}

/** Whether the system keychain works here. A failure is rechecked after a while. */
export async function getSecureStorageStatus(): Promise< CredentialStoreStatus > {
	if (
		cachedStatus &&
		( cachedStatus.status.available ||
			Date.now() - cachedStatus.checkedAt < UNAVAILABLE_RECHECK_MS )
	) {
		return cachedStatus.status;
	}
	const status = await getStore()
		.check()
		.catch( ( error: unknown ) => ( {
			available: false as const,
			reason: error instanceof Error ? error.message : String( error ),
		} ) );
	cachedStatus = { status, checkedAt: Date.now() };
	return status;
}

export interface OpenAiKeySource {
	key: string;
	storage: OpenAiKeyStorage;
}

/** A turn the app offered its session key to couldn't get that key. */
export class OpenAiSessionKeyUnavailableError extends Error {
	constructor() {
		super(
			__(
				'Studio couldn’t get the OpenAI key kept for this session from the app, so this turn didn’t run. Try again; if it keeps happening, add the key again in Settings → AI.'
			)
		);
		this.name = 'OpenAiSessionKeyUnavailableError';
	}
}

/**
 * The key a turn uses: this session's key when there is one, else the
 * keychain's. Null when there is neither, or the keychain can't be read.
 *
 * A turn the app offered its session key to uses that key or nothing: the
 * keychain may hold a key for another project, so failing to get the session
 * key throws `OpenAiSessionKeyUnavailableError` rather than fall back.
 */
export async function readOpenAiKeySource(): Promise< OpenAiKeySource | null > {
	if ( sessionKey ) {
		return { key: sessionKey, storage: 'session' };
	}
	if ( requestParentSessionKey ) {
		const parentSessionKey = await requestParentSessionKey();
		if ( ! parentSessionKey ) {
			throw new OpenAiSessionKeyUnavailableError();
		}
		return { key: parentSessionKey, storage: 'session' };
	}
	if ( ! ( await getSecureStorageStatus() ).available ) {
		return null;
	}
	const key = await getStore().get( KEYCHAIN_ACCOUNT );
	return key ? { key, storage: 'keychain' } : null;
}

/**
 * Saves the key to the keychain, or keeps it for this session only. A keychain
 * save on a machine without one fails with `SecureStorageError`; it never
 * falls back to the session or to a file.
 */
export function storeOpenAiKey( key: string, storage: OpenAiKeyStorage ): Promise< void > {
	return serialize( async () => {
		if ( storage === 'session' ) {
			sessionKey = key;
			requestParentSessionKey = null;
			return;
		}
		const status = await getSecureStorageStatus();
		if ( ! status.available ) {
			throw new SecureStorageError( status.reason );
		}
		try {
			await getStore().set( KEYCHAIN_ACCOUNT, key );
		} catch ( error ) {
			// The keychain may have just become unusable (locked, service gone).
			cachedStatus = undefined;
			throw error;
		}
		sessionKey = null;
		requestParentSessionKey = null;
	} );
}

/**
 * Forgets the session key and removes the keychain's copy. Fails when the
 * machine has a keychain this process can't reach: a key saved there would
 * otherwise come back once it can.
 */
export function deleteOpenAiKey(): Promise< void > {
	return serialize( async () => {
		const hadSessionKey = Boolean( sessionKey || requestParentSessionKey );
		sessionKey = null;
		requestParentSessionKey = null;
		// Checked afresh: a status cached before the keychain went away mustn't
		// turn a failed removal into a quiet success.
		cachedStatus = undefined;
		const status = await getSecureStorageStatus();
		if ( ! status.available ) {
			if ( status.absent ) {
				return;
			}
			throw new SecureStorageError(
				hadSessionKey
					? sprintf(
							/* translators: %s: why the system keychain can't be reached. */
							__(
								'Studio stopped using the key for this session, but couldn’t reach the system keychain to remove a key saved there. %s If one is saved there, Studio will use it again once the keychain is available; remove it then.'
							),
							status.reason
					  )
					: sprintf(
							/* translators: %s: why the system keychain can't be reached. */
							__( 'Studio couldn’t reach the system keychain to remove the key. %s' ),
							status.reason
					  )
			);
		}
		try {
			await getStore().delete( KEYCHAIN_ACCOUNT );
		} catch ( error ) {
			cachedStatus = undefined;
			throw error;
		}
	} );
}

function isMessageOfType( message: unknown, type: string ): boolean {
	return (
		typeof message === 'object' &&
		message !== null &&
		( message as { type?: unknown } ).type === type
	);
}

/**
 * The environment a forked CLI turn gets from this process: an offer of the
 * session key when there is one, never the key itself.
 */
export function getOpenAiSessionKeyForkEnvironment(): Record< string, string > {
	return sessionKey ? { [ OPENAI_SESSION_KEY_OFFER_ENV ]: '1' } : {};
}

/**
 * Answers a forked CLI turn that asks for this process's session key, through
 * `reply` (the child's IPC channel). False for any other message.
 */
export function answerOpenAiSessionKeyRequest(
	message: unknown,
	reply: ( message: { type: string; key: string | null } ) => void
): boolean {
	if ( ! isMessageOfType( message, SESSION_KEY_REQUEST ) ) {
		return false;
	}
	reply( { type: SESSION_KEY_REPLY, key: sessionKey } );
	return true;
}

/** The IPC channel to the app that forked this process: `process` in a forked CLI. */
export interface ParentChannel {
	send?: ( message: unknown, callback: ( error: Error | null ) => void ) => unknown;
	on( event: 'message', listener: ( message: unknown ) => void ): unknown;
	off( event: 'message', listener: ( message: unknown ) => void ): unknown;
}

function askParentForSessionKey( channel: ParentChannel ): Promise< string | null > {
	return new Promise( ( resolve ) => {
		const finish = ( key: string | null ) => {
			clearTimeout( timer );
			channel.off( 'message', onMessage );
			resolve( key );
		};
		const onMessage = ( message: unknown ) => {
			if ( isMessageOfType( message, SESSION_KEY_REPLY ) ) {
				const { key } = message as { key?: unknown };
				finish( typeof key === 'string' && key.trim() ? key.trim() : null );
			}
		};
		// An app that never answers fails the turn rather than leave it stuck.
		const timer = setTimeout( () => finish( null ), SESSION_KEY_REPLY_TIMEOUT_MS );
		channel.on( 'message', onMessage );
		try {
			// With a callback, a closed channel reports here instead of as an
			// 'error' event nobody listens to.
			channel.send?.( { type: SESSION_KEY_REQUEST }, ( error ) => {
				if ( error ) {
					finish( null );
				}
			} );
		} catch {
			finish( null );
		}
	} );
}

/**
 * In a CLI turn forked by a Studio app that keeps a session key: lets the
 * turn ask the app for it, once, the first time it needs the key. Call at
 * startup; it does nothing in a process nobody offered a key to.
 */
export function acceptOpenAiSessionKeyFromParent(
	channel: ParentChannel = process as unknown as ParentChannel,
	env: NodeJS.ProcessEnv = process.env
): void {
	const offered = env[ OPENAI_SESSION_KEY_OFFER_ENV ] === '1';
	delete env[ OPENAI_SESSION_KEY_OFFER_ENV ];
	if ( ! offered || typeof channel.send !== 'function' ) {
		return;
	}
	let request: Promise< string | null > | undefined;
	requestParentSessionKey = () => ( request ??= askParentForSessionKey( channel ) );
}
