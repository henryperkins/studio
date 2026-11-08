import {
	createOsCredentialStore,
	SecureStorageError,
	type CredentialStoreStatus,
	type OsCredentialStore,
} from '@studio/common/lib/os-credential-store';
import type { OpenAiKeyStorage } from '@studio/agent/protocol/providers';

/**
 * Where the OpenAI API key lives. Backend-only: the Desktop main process, the
 * `studio ui` server and the CLI use it; nothing here ever reaches a renderer.
 *
 * The key goes to the system keychain. When this machine has none, the user
 * can keep a key for the current app session instead: it stays in this
 * process's memory and is handed to each forked CLI turn, never written down.
 */

const KEYCHAIN_ACCOUNT = 'openai-api-key';
// How a session-only key reaches a forked CLI turn. The CLI removes it from its
// environment on startup, before anything it spawns could inherit it.
export const OPENAI_SESSION_KEY_ENV = 'STUDIO_OPENAI_SESSION_API_KEY';
const UNAVAILABLE_RECHECK_MS = 30_000;

let store: OsCredentialStore | undefined;
let sessionKey: string | null = null;
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

/**
 * The key a turn uses: this session's key when there is one, else the
 * keychain's. Null when there is neither, or the keychain can't be read.
 */
export async function readOpenAiKeySource(): Promise< OpenAiKeySource | null > {
	if ( sessionKey ) {
		return { key: sessionKey, storage: 'session' };
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
	} );
}

/** Forgets the session key and removes the keychain's copy. */
export function deleteOpenAiKey(): Promise< void > {
	return serialize( async () => {
		sessionKey = null;
		if ( ( await getSecureStorageStatus() ).available ) {
			await getStore().delete( KEYCHAIN_ACCOUNT );
		}
	} );
}

/** The environment that hands this process's session-only key to a forked CLI. */
export function getOpenAiSessionKeyEnvironment(): Record< string, string > {
	return sessionKey ? { [ OPENAI_SESSION_KEY_ENV ]: sessionKey } : {};
}

/**
 * Takes over a session-only key a parent process handed down, and removes it
 * from the environment so no process started from here inherits it.
 */
export function adoptOpenAiSessionKey( env: NodeJS.ProcessEnv = process.env ): void {
	const key = env[ OPENAI_SESSION_KEY_ENV ]?.trim();
	delete env[ OPENAI_SESSION_KEY_ENV ];
	if ( key ) {
		sessionKey = key;
	}
}
