import { SecureStorageError, type OsCredentialStore } from '@studio/common/lib/os-credential-store';

/** An in-memory stand-in for the system keychain, with switchable availability. */
export function createFakeCredentialStore() {
	const items = new Map< string, string >();
	const state = {
		available: true,
		// Unavailable because the machine has no keychain at all, not because it can't be reached.
		absent: false,
		reason: 'The keychain can’t be reached.',
	};
	const ensureAvailable = () => {
		if ( ! state.available ) {
			throw new SecureStorageError( state.reason );
		}
	};
	const store: OsCredentialStore = {
		check: async () => {
			if ( state.available ) {
				return { available: true };
			}
			return state.absent
				? { available: false, reason: state.reason, absent: true }
				: { available: false, reason: state.reason };
		},
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
