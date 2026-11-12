import { randomBytes } from 'node:crypto';
import type { OsCredentialStore } from '@studio/common/lib/os-credential-store';

/**
 * Guards for the opt-in tests that use this machine's real system keychain:
 * whether they may run, the one keychain service a run writes under, and
 * removing exactly the entries the run wrote, also when a test fails.
 */

/** Set to "1" to let the native keychain tests write to this machine's keychain. */
export const NATIVE_CREDENTIAL_STORE_TEST_ENV = 'STUDIO_NATIVE_CREDENTIAL_STORE_TEST';

/** Where Studio itself keeps secrets. A native test never touches it. */
export const PRODUCTION_CREDENTIAL_SERVICE = 'wordpress-studio';

const TEST_SERVICE_PREFIX = 'studio-native-test-';
const RUN_ID = /^[0-9a-f]{16}$/;

export type NativeTestGate = { run: true } | { run: false; reason: string };

export function nativeCredentialStoreTestGate(
	env: NodeJS.ProcessEnv = process.env
): NativeTestGate {
	if ( env[ NATIVE_CREDENTIAL_STORE_TEST_ENV ] !== '1' ) {
		return {
			run: false,
			reason: `it writes to this machine's keychain, so it runs only with ${ NATIVE_CREDENTIAL_STORE_TEST_ENV }=1`,
		};
	}
	if ( env.CI ) {
		return { run: false, reason: 'it never runs in CI' };
	}
	return { run: true };
}

export interface NativeTestIdentity {
	/** Random per run: two runs, or a run and Studio, never share an entry. */
	runId: string;
	/** The keychain service every entry of the run is under. */
	service: string;
}

/** The run's identity, refusing anything but a test run's own service. */
export function nativeTestIdentityForRun( runId: string ): NativeTestIdentity {
	const identity = { runId, service: `${ TEST_SERVICE_PREFIX }${ runId }` };
	assertNativeTestIdentity( identity );
	return identity;
}

export function createNativeTestIdentity(
	random: () => string = () => randomBytes( 8 ).toString( 'hex' )
): NativeTestIdentity {
	return nativeTestIdentityForRun( random() );
}

export function assertNativeTestIdentity( identity: NativeTestIdentity ): void {
	if (
		! RUN_ID.test( identity.runId ) ||
		identity.service !== `${ TEST_SERVICE_PREFIX }${ identity.runId }` ||
		identity.service === PRODUCTION_CREDENTIAL_SERVICE
	) {
		throw new Error(
			`Refusing to use keychain service "${ identity.service }": it isn't a native test run's own.`
		);
	}
}

export interface NativeStoreSession {
	readonly identity: NativeTestIdentity;
	/** The keychain under the run's service; every account written is recorded for removal. */
	readonly store: OsCredentialStore;
	/** Records an account another process or a broker writes under the run's service. */
	track( account: string ): void;
}

interface Cleanup {
	removed: string[];
	/** Accounts that couldn't be removed, by name only. */
	left: string[];
}

/** Entries a test wrote that couldn't be removed, with the test's own failure if it failed. */
export class NativeCleanupError extends Error {
	readonly testFailure: unknown;

	constructor( message: string, testFailure?: unknown ) {
		super( message );
		this.name = 'NativeCleanupError';
		this.testFailure = testFailure;
	}
}

function openNativeStoreSession(
	identity: NativeTestIdentity,
	createStore: ( service: string ) => OsCredentialStore
): NativeStoreSession & { cleanup(): Promise< Cleanup > } {
	assertNativeTestIdentity( identity );
	const keychain = createStore( identity.service );
	const written = new Set< string >();
	const store: OsCredentialStore = {
		check: () => keychain.check(),
		get: ( account ) => keychain.get( account ),
		// Recorded first, so a write that fails part-way is removed too.
		set: async ( account, secret ) => {
			written.add( account );
			await keychain.set( account, secret );
		},
		delete: ( account ) => keychain.delete( account ),
	};
	return {
		identity,
		store,
		track: ( account ) => written.add( account ),
		async cleanup() {
			const removed: string[] = [];
			const left: string[] = [];
			for ( const account of written ) {
				try {
					await keychain.delete( account );
					( ( await keychain.get( account ) ) === null ? removed : left ).push( account );
				} catch {
					left.push( account );
				}
			}
			return { removed, left };
		},
	};
}

/**
 * Runs `test` against the keychain under the run's service, then removes what
 * it wrote there and nothing else, however `test` ended. Entries that can't be
 * removed are named, with the service, so they can be removed by hand.
 */
export async function withNativeStoreSession< T >(
	identity: NativeTestIdentity,
	createStore: ( service: string ) => OsCredentialStore,
	test: ( session: NativeStoreSession ) => Promise< T >
): Promise< T > {
	const session = openNativeStoreSession( identity, createStore );
	let outcome: { value: T } | { error: unknown };
	try {
		outcome = { value: await test( session ) };
	} catch ( error ) {
		outcome = { error };
	}
	const { left } = await session.cleanup();
	if ( left.length ) {
		const leftover = `Couldn't remove the test entries ${ left.join(
			', '
		) } under keychain service ${ identity.service }. Remove them by hand.`;
		if ( 'error' in outcome ) {
			const reason =
				outcome.error instanceof Error ? outcome.error.message : String( outcome.error );
			throw new NativeCleanupError(
				`${ leftover } The test had already failed: ${ reason }`,
				outcome.error
			);
		}
		throw new NativeCleanupError( leftover );
	}
	if ( 'error' in outcome ) {
		throw outcome.error;
	}
	return outcome.value;
}
