// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
	assertNativeTestIdentity,
	createNativeTestIdentity,
	NATIVE_CREDENTIAL_STORE_TEST_ENV,
	NativeCleanupError,
	nativeCredentialStoreTestGate,
	nativeTestIdentityForRun,
	PRODUCTION_CREDENTIAL_SERVICE,
	withNativeStoreSession,
} from './utils/native-credential-store';
import type { OsCredentialStore } from '@studio/common/lib/os-credential-store';

// The logic of the opt-in native keychain tests, proven here against an
// in-memory keychain so that it holds before anyone opts in.

const SECRET = 'test-only-native-harness-secret-0123456789';

// A keychain shared by every service, as the system's is, recording each call.
function createFakeKeychain( seeded: Record< string, string > = {} ) {
	const items = new Map( Object.entries( seeded ) );
	const calls: Array< { service: string; operation: string; account?: string } > = [];
	let failSetFor: string | null = null;
	let failDeleteFor: string | null = null;
	const createStore = ( service: string ): OsCredentialStore => ( {
		check: async () => {
			calls.push( { service, operation: 'check' } );
			return { available: true };
		},
		get: async ( account ) => {
			calls.push( { service, operation: 'get', account } );
			return items.get( `${ service }/${ account }` ) ?? null;
		},
		set: async ( account, secret ) => {
			calls.push( { service, operation: 'set', account } );
			// A write that fails part-way, leaving something behind.
			items.set( `${ service }/${ account }`, secret.slice( 0, 4 ) );
			if ( failSetFor === account ) {
				throw new Error( 'test-keychain-refused' );
			}
			items.set( `${ service }/${ account }`, secret );
		},
		delete: async ( account ) => {
			calls.push( { service, operation: 'delete', account } );
			if ( failDeleteFor === account ) {
				throw new Error( 'test-keychain-refused-delete' );
			}
			items.delete( `${ service }/${ account }` );
		},
	} );
	return {
		createStore,
		items,
		calls,
		failSet( account: string ) {
			failSetFor = account;
		},
		failDelete( account: string ) {
			failDeleteFor = account;
		},
	};
}

// What Studio and other programs keep there, which a test run must leave alone.
const UNRELATED = {
	[ `${ PRODUCTION_CREDENTIAL_SERVICE }/chatgpt-vault-key` ]: 'production-vault-key',
	[ `${ PRODUCTION_CREDENTIAL_SERVICE }/openai-api-key` ]: 'production-api-key',
	'studio-native-test-0123456789abcdef/chatgpt-vault-key': 'another-run-left-this',
	'some-other-app/token': 'another-app',
};

describe( 'when the native keychain tests run', () => {
	it( 'runs only when opted in with exactly "1"', () => {
		for ( const env of [
			{},
			{ [ NATIVE_CREDENTIAL_STORE_TEST_ENV ]: '' },
			{ [ NATIVE_CREDENTIAL_STORE_TEST_ENV ]: '0' },
			{ [ NATIVE_CREDENTIAL_STORE_TEST_ENV ]: 'true' },
			{ [ NATIVE_CREDENTIAL_STORE_TEST_ENV ]: 'yes' },
		] ) {
			expect( nativeCredentialStoreTestGate( env ) ).toEqual( {
				run: false,
				reason: `it writes to this machine's keychain, so it runs only with ${ NATIVE_CREDENTIAL_STORE_TEST_ENV }=1`,
			} );
		}
		expect(
			nativeCredentialStoreTestGate( { [ NATIVE_CREDENTIAL_STORE_TEST_ENV ]: '1' } )
		).toEqual( {
			run: true,
		} );
	} );

	it( 'never runs in CI, even when opted in', () => {
		for ( const ci of [ 'true', '1', 'yes' ] ) {
			expect(
				nativeCredentialStoreTestGate( { [ NATIVE_CREDENTIAL_STORE_TEST_ENV ]: '1', CI: ci } )
			).toEqual( { run: false, reason: 'it never runs in CI' } );
		}
	} );

	it( 'is not opted in by this test run’s own environment', () => {
		expect( process.env[ NATIVE_CREDENTIAL_STORE_TEST_ENV ] ).toBeUndefined();
		expect( nativeCredentialStoreTestGate().run ).toBe( false );
	} );
} );

describe( 'the keychain names a native test run uses', () => {
	it( 'are its own: a service named for a random run id, never Studio’s', () => {
		const first = createNativeTestIdentity();
		const second = createNativeTestIdentity();

		expect( first.service ).toMatch( /^studio-native-test-[0-9a-f]{16}$/ );
		expect( first.service ).toBe( `studio-native-test-${ first.runId }` );
		expect( second.runId ).not.toBe( first.runId );
		expect( first.service ).not.toBe( PRODUCTION_CREDENTIAL_SERVICE );
	} );

	it.each( [
		[ 'Studio’s own service', PRODUCTION_CREDENTIAL_SERVICE ],
		[ 'nothing', '' ],
		[ 'a path', '../wordpress-studio' ],
		[ 'too short an id', '0123' ],
		[ 'upper case', '0123456789ABCDEF' ],
	] )( 'refuse a run id that is %s', ( _name, runId ) => {
		expect( () => createNativeTestIdentity( () => runId ) ).toThrow(
			/Refusing to use keychain service/
		);
		expect( () => nativeTestIdentityForRun( runId ) ).toThrow( /Refusing to use keychain service/ );
	} );

	it( 'refuse a service that is Studio’s, or another run’s', () => {
		const { runId } = createNativeTestIdentity();

		for ( const service of [
			PRODUCTION_CREDENTIAL_SERVICE,
			'studio-native-test-0123456789abcdef',
			`studio-native-test-${ runId }-extra`,
		] ) {
			expect( () => assertNativeTestIdentity( { runId, service } ) ).toThrow(
				/Refusing to use keychain service/
			);
		}
	} );
} );

describe( 'a native test run’s keychain session', () => {
	it( 'writes under its own service only, and removes exactly what it wrote', async () => {
		const keychain = createFakeKeychain( UNRELATED );
		const identity = createNativeTestIdentity();

		const value = await withNativeStoreSession(
			identity,
			keychain.createStore,
			async ( session ) => {
				await session.store.set( 'entry', SECRET );
				await session.store.set( 'chatgpt-vault-key', SECRET );
				// Written by another process, or by a broker, under the run's service.
				session.track( 'written-elsewhere' );
				keychain.items.set( `${ identity.service }/written-elsewhere`, SECRET );
				return session.store.get( 'entry' );
			}
		);

		expect( value ).toBe( SECRET );
		expect( Object.fromEntries( keychain.items ) ).toEqual( UNRELATED );
		expect( keychain.calls.every( ( call ) => call.service === identity.service ) ).toBe( true );
		expect(
			keychain.calls
				.filter( ( call ) => call.operation === 'delete' )
				.map( ( call ) => call.account )
				.sort()
		).toEqual( [ 'chatgpt-vault-key', 'entry', 'written-elsewhere' ] );
	} );

	it( 'removes what it wrote when the test fails, and reports the test’s own failure', async () => {
		const keychain = createFakeKeychain( UNRELATED );
		const identity = createNativeTestIdentity();
		const failure = new Error( 'test-step-failed' );

		const error = await withNativeStoreSession(
			identity,
			keychain.createStore,
			async ( session ) => {
				await session.store.set( 'entry', SECRET );
				throw failure;
			}
		).catch( ( caught: unknown ) => caught );

		expect( error ).toBe( failure );
		expect( Object.fromEntries( keychain.items ) ).toEqual( UNRELATED );
	} );

	it( 'removes what a write that failed part-way left behind', async () => {
		const keychain = createFakeKeychain( UNRELATED );
		const identity = createNativeTestIdentity();
		keychain.failSet( 'entry' );

		const error = await withNativeStoreSession( identity, keychain.createStore, ( session ) =>
			session.store.set( 'entry', SECRET )
		).catch( ( caught: unknown ) => caught );

		expect( error ).toMatchObject( { message: 'test-keychain-refused' } );
		expect( Object.fromEntries( keychain.items ) ).toEqual( UNRELATED );
	} );

	it( 'names, by account and service only, what it couldn’t remove, without hiding the test’s failure', async () => {
		const keychain = createFakeKeychain( UNRELATED );
		const identity = createNativeTestIdentity();
		keychain.failDelete( 'stuck' );
		const failure = new Error( 'test-step-failed' );

		const error = await withNativeStoreSession(
			identity,
			keychain.createStore,
			async ( session ) => {
				await session.store.set( 'stuck', SECRET );
				await session.store.set( 'entry', SECRET );
				throw failure;
			}
		).catch( ( caught: unknown ) => caught );

		expect( error ).toBeInstanceOf( NativeCleanupError );
		expect( ( error as NativeCleanupError ).testFailure ).toBe( failure );
		expect( ( error as Error ).message ).toBe(
			`Couldn't remove the test entries stuck under keychain service ${ identity.service }. Remove them by hand. The test had already failed: test-step-failed`
		);
		expect( `${ ( error as Error ).message }\n${ ( error as Error ).stack }` ).not.toContain(
			SECRET
		);
		expect( keychain.items.has( `${ identity.service }/entry` ) ).toBe( false );

		const passing = await withNativeStoreSession(
			identity,
			keychain.createStore,
			async ( session ) => {
				session.track( 'stuck' );
			}
		).catch( ( caught: unknown ) => caught );
		expect( passing ).toBeInstanceOf( NativeCleanupError );
		expect( passing ).toMatchObject( {
			message: `Couldn't remove the test entries stuck under keychain service ${ identity.service }. Remove them by hand.`,
			testFailure: undefined,
		} );
	} );

	it( 'won’t open on Studio’s own service', async () => {
		const keychain = createFakeKeychain( UNRELATED );

		await expect(
			withNativeStoreSession(
				{ runId: '0123456789abcdef', service: PRODUCTION_CREDENTIAL_SERVICE },
				keychain.createStore,
				( session ) => session.store.delete( 'chatgpt-vault-key' )
			)
		).rejects.toThrow( /Refusing to use keychain service/ );
		expect( keychain.calls ).toEqual( [] );
		expect( Object.fromEntries( keychain.items ) ).toEqual( UNRELATED );
	} );
} );
