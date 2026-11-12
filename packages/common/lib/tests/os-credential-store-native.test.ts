// @vitest-environment node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	createOsCredentialStore,
	SecureStorageError,
} from '@studio/common/lib/os-credential-store';
import {
	createNativeTestIdentity,
	nativeCredentialStoreTestGate,
	withNativeStoreSession,
	type NativeStoreSession,
} from './utils/native-credential-store';

/**
 * This machine's real system keychain: Windows Credential Manager, the macOS
 * Keychain or the Linux Secret Service. Opt-in only, never in CI; see
 * scripts/chatgpt-acceptance/README.md. Every entry is written under a keychain
 * service named for the run, `studio-native-test-<16 hex>`, and each test
 * removes what it wrote there, whether it passes or fails.
 */

const gate = nativeCredentialStoreTestGate();
const identity = createNativeTestIdentity();
const FIXTURE = path.join( import.meta.dirname, 'fixtures', 'native-credential-store-process.ts' );
// A keychain prompt may wait for the person running the test.
const TIMEOUT_MS = 180_000;

// Fresh, obviously fake values.
const keyShaped = () => randomBytes( 32 ).toString( 'base64url' );
const fakeSecret = ( length: number ) => {
	const unique = `test-only-${ randomBytes( 8 ).toString( 'hex' ) }-`;
	let text = unique;
	for ( let index = 0; text.length < length; index++ ) {
		text += `${ index.toString( 36 ) }.`;
	}
	return text.slice( 0, length );
};

const withKeychain = ( test: ( session: NativeStoreSession ) => Promise< void > ) => () =>
	withNativeStoreSession( identity, ( service ) => createOsCredentialStore( { service } ), test );

// The run's keychain from a fresh process: the value goes on stdin, and only booleans come back.
function inAnotherProcess(
	account: string,
	operation: 'read' | 'write',
	value: string
): Promise< Record< string, unknown > > {
	return new Promise( ( resolve, reject ) => {
		const child = spawn( process.execPath, [ FIXTURE, identity.runId, account, operation ], {
			stdio: [ 'pipe', 'pipe', 'pipe' ],
			windowsHide: true,
		} );
		let stdout = '';
		child.stdout.setEncoding( 'utf8' ).on( 'data', ( chunk: string ) => ( stdout += chunk ) );
		child.stderr.resume();
		child.on( 'error', reject );
		child.on( 'close', () => {
			try {
				resolve( JSON.parse( stdout.trim().split( '\n' ).pop() ?? '' ) );
			} catch {
				reject( new Error( 'The other process reported nothing.' ) );
			}
		} );
		child.stdin.end( value );
	} );
}

describe.skipIf( ! gate.run )(
	`the real system keychain on ${ process.platform } ${ process.arch }${
		gate.run ? '' : ` (skipped: ${ gate.reason })`
	}`,
	() => {
		it(
			'is available to this session',
			withKeychain( async ( { store } ) => {
				const status = await store.check();
				expect( status, status.available ? undefined : status.reason ).toEqual( {
					available: true,
				} );
			} ),
			TIMEOUT_MS
		);

		it(
			'saves, reads, replaces and removes a secret',
			withKeychain( async ( { store } ) => {
				const first = keyShaped();
				const second = fakeSecret( 164 );

				await expect( store.get( 'round-trip' ) ).resolves.toBeNull();
				await store.set( 'round-trip', first );
				await expect( store.get( 'round-trip' ) ).resolves.toBe( first );
				await store.set( 'round-trip', second );
				await expect( store.get( 'round-trip' ) ).resolves.toBe( second );
				await store.delete( 'round-trip' );
				await expect( store.get( 'round-trip' ) ).resolves.toBeNull();
				await expect( store.delete( 'round-trip' ) ).resolves.toBeUndefined();
			} ),
			TIMEOUT_MS
		);

		it(
			'keeps a secret for a fresh process, and reads one a fresh process saved',
			withKeychain( async ( session ) => {
				const first = keyShaped();
				const second = keyShaped();
				await session.store.set( 'across-processes', first );

				await expect( inAnotherProcess( 'across-processes', 'read', first ) ).resolves.toEqual( {
					found: true,
					matches: true,
				} );
				await expect( inAnotherProcess( 'across-processes', 'write', second ) ).resolves.toEqual( {
					written: true,
				} );
				await expect( session.store.get( 'across-processes' ) ).resolves.toBe( second );
				await session.store.delete( 'across-processes' );
				await expect( inAnotherProcess( 'across-processes', 'read', second ) ).resolves.toEqual( {
					found: false,
					matches: false,
				} );
			} ),
			TIMEOUT_MS
		);

		it(
			'keeps secrets that look like options or shell syntax exactly',
			withKeychain( async ( { store } ) => {
				for ( const secret of [
					`-w-${ keyShaped() }`,
					'--',
					'-U',
					`$(whoami);\`id\`|&<>*?#!%-${ keyShaped() }`,
				] ) {
					await store.set( 'option-like', secret );
					await expect( store.get( 'option-like' ) ).resolves.toBe( secret );
					await expect( inAnotherProcess( 'option-like', 'read', secret ) ).resolves.toEqual( {
						found: true,
						matches: true,
					} );
				}
			} ),
			TIMEOUT_MS
		);

		it(
			'takes a long secret whole or refuses it, never cutting it short or losing the one before',
			withKeychain( async ( { store } ) => {
				let previous = keyShaped();
				await store.set( 'long', previous );
				const taken: number[] = [];
				for ( const length of [ 1024, 2048, 2560, 4000, 8192, 16_384 ] ) {
					const secret = fakeSecret( length );
					const refused = await store.set( 'long', secret ).then(
						() => null,
						( error: unknown ) => error
					);
					const kept = await store.get( 'long' );
					if ( refused === null ) {
						expect( kept ).toBe( secret );
						previous = secret;
						taken.push( length );
					} else {
						expect( refused ).toBeInstanceOf( SecureStorageError );
						expect( ( refused as Error ).message ).not.toContain( secret.slice( -24 ) );
						expect( kept ).toBe( previous );
					}
				}
				// Bounded evidence for the record: which lengths this keychain took whole.
				console.info(
					`native keychain took secrets of ${ taken.join( ', ' ) || 'no' } characters whole`
				);
			} ),
			TIMEOUT_MS
		);

		it(
			'refuses a secret that would need escaping before anything is written',
			withKeychain( async ( { store } ) => {
				for ( const secret of [
					'test-only-"quoted',
					"test-only-'quoted",
					'test-only-\\escaped',
					'test-only\nadd-generic-password -s x -a y -w z',
					'test-only\u0000nul',
					'test-only with-space',
				] ) {
					await expect( store.set( 'needs-escaping', secret ) ).rejects.toBeInstanceOf(
						SecureStorageError
					);
				}
				await expect( store.get( 'needs-escaping' ) ).resolves.toBeNull();
			} ),
			TIMEOUT_MS
		);
	}
);
