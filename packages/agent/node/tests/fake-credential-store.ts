import { SecureStorageError, type OsCredentialStore } from '@studio/common/lib/os-credential-store';

/** An in-memory stand-in for the system keychain, with switchable availability. */
export function createFakeCredentialStore() {
	const items = new Map< string, string >();
	const state = { available: true, reason: 'There is no keychain on this machine.' };
	const ensureAvailable = () => {
		if ( ! state.available ) {
			throw new SecureStorageError( state.reason );
		}
	};
	const store: OsCredentialStore = {
		check: async () =>
			state.available ? { available: true } : { available: false, reason: state.reason },
		get: async ( account ) => {
			ensureAvailable();
			return items.get( account ) ?? null;
		},
		set: async ( account, secret ) => {
			ensureAvailable();
			items.set( account, secret );
		},
		delete: async ( account ) => {
			ensureAvailable();
			items.delete( account );
		},
	};
	return { store, items, state };
}

export type FakeCredentialStore = ReturnType< typeof createFakeCredentialStore >;
