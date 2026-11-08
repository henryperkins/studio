import { describe, expect, it } from 'vitest';
import {
	createOsCredentialStore,
	SecureStorageError,
	type CommandResult,
	type CommandRunner,
} from '@studio/common/lib/os-credential-store';

const SECRET = 'sk-proj-TESTONLY_abcdefghijklmnopqrstuvwxyz-0123456789';

interface Call {
	command: string;
	args: readonly string[];
	input?: string;
}

const ok = ( stdout = '' ): CommandResult => ( { code: 0, stdout, stderr: '' } );

/**
 * Emulates each platform's keychain tool over an in-memory store, recording
 * every invocation so tests can check what crossed the command line.
 */
function createFakeKeychain( platform: 'darwin' | 'linux' | 'win32' ) {
	const items = new Map< string, string >();
	const calls: Call[] = [];
	let failNextWrite: CommandResult | null = null;
	let dropWrites = false;

	const keyOf = ( service: string, account: string ) => `${ service }/${ account }`;
	const argAfter = ( args: readonly string[], flag: string ) => args[ args.indexOf( flag ) + 1 ];

	const run: CommandRunner = async ( command, args, { input } ) => {
		calls.push( { command, args, input } );
		if ( platform === 'darwin' ) {
			expect( command ).toBe( '/usr/bin/security' );
			if ( args[ 0 ] === 'default-keychain' ) {
				return ok( '"/Users/me/Library/Keychains/login.keychain-db"' );
			}
			if ( args[ 0 ] === '-i' ) {
				if ( failNextWrite ) {
					const failure = failNextWrite;
					failNextWrite = null;
					return failure;
				}
				const tokens = ( input ?? '' ).trim().split( /\s+/ );
				expect( tokens[ 0 ] ).toBe( 'add-generic-password' );
				if ( ! dropWrites ) {
					items.set(
						keyOf( argAfter( tokens, '-s' ), argAfter( tokens, '-a' ) ),
						argAfter( tokens, '-w' )
					);
				}
				return ok();
			}
			const key = keyOf( argAfter( args, '-s' ), argAfter( args, '-a' ) );
			if ( args[ 0 ] === 'find-generic-password' ) {
				const value = items.get( key );
				return value === undefined
					? { code: 44, stdout: '', stderr: 'The specified item could not be found.' }
					: ok( `${ value }\n` );
			}
			if ( args[ 0 ] === 'delete-generic-password' ) {
				return items.delete( key ) ? ok() : { code: 44, stdout: '', stderr: 'not found' };
			}
		}
		if ( platform === 'linux' ) {
			expect( command ).toBe( 'secret-tool' );
			const key = keyOf( argAfter( args, 'service' ), argAfter( args, 'account' ) );
			if ( args[ 0 ] === 'lookup' ) {
				const value = items.get( key );
				return value === undefined ? { code: 1, stdout: '', stderr: '' } : ok( value );
			}
			if ( args[ 0 ] === 'store' ) {
				if ( failNextWrite ) {
					const failure = failNextWrite;
					failNextWrite = null;
					return failure;
				}
				if ( ! dropWrites ) {
					items.set( key, input ?? '' );
				}
				return ok();
			}
			if ( args[ 0 ] === 'clear' ) {
				items.delete( key );
				return ok();
			}
		}
		if ( platform === 'win32' ) {
			expect( command ).toBe( 'powershell.exe' );
			const script = Buffer.from( argAfter( args, '-EncodedCommand' ), 'base64' ).toString(
				'utf16le'
			);
			const match = /Retrieve\('([^']+)', '([^']+)'\)/.exec( script );
			if ( ! match ) {
				return ok();
			}
			const key = keyOf( match[ 1 ], match[ 2 ] );
			if ( script.includes( '$vault.Add(' ) ) {
				// A replace removes the previous credential before adding the new one,
				// and only a script that puts it back keeps it when the add fails.
				const previous = items.get( key );
				if ( script.includes( '$vault.Remove(' ) ) {
					items.delete( key );
				}
				if ( failNextWrite ) {
					const failure = failNextWrite;
					failNextWrite = null;
					if ( previous !== undefined && script.includes( '$vault.Add($previous)' ) ) {
						items.set( key, previous );
					}
					return failure;
				}
				if ( ! dropWrites ) {
					items.set( key, input ?? '' );
				}
				return ok();
			}
			if ( ! items.has( key ) ) {
				return { code: 3, stdout: '', stderr: '' };
			}
			if ( script.includes( '$vault.Remove($credential)' ) ) {
				items.delete( key );
				return ok();
			}
			return ok( items.get( key ) );
		}
		throw new Error( `Unexpected command: ${ command } ${ args.join( ' ' ) }` );
	};

	return {
		run,
		calls,
		items,
		failNextWrite( result: CommandResult ) {
			failNextWrite = result;
		},
		dropWrites() {
			dropWrites = true;
		},
	};
}

describe.each( [ 'darwin', 'linux', 'win32' ] as const )( 'system keychain on %s', ( platform ) => {
	it( 'saves, reads, replaces and removes a secret', async () => {
		const keychain = createFakeKeychain( platform );
		const store = createOsCredentialStore( { platform, run: keychain.run } );

		await expect( store.check() ).resolves.toEqual( { available: true } );
		await expect( store.get( 'openai-api-key' ) ).resolves.toBeNull();

		await store.set( 'openai-api-key', SECRET );
		await expect( store.get( 'openai-api-key' ) ).resolves.toBe( SECRET );

		await store.set( 'openai-api-key', `${ SECRET }-2` );
		await expect( store.get( 'openai-api-key' ) ).resolves.toBe( `${ SECRET }-2` );

		await store.delete( 'openai-api-key' );
		await expect( store.get( 'openai-api-key' ) ).resolves.toBeNull();
		// Removing what isn't there is not an error.
		await expect( store.delete( 'openai-api-key' ) ).resolves.toBeUndefined();
	} );

	it( 'never puts the secret on a command line', async () => {
		const keychain = createFakeKeychain( platform );
		const store = createOsCredentialStore( { platform, run: keychain.run } );

		await store.set( 'openai-api-key', SECRET );
		await store.get( 'openai-api-key' );
		await store.delete( 'openai-api-key' );

		expect( keychain.calls.length ).toBeGreaterThan( 0 );
		for ( const call of keychain.calls ) {
			expect( call.args.join( ' ' ) ).not.toContain( SECRET );
			if ( call.args.includes( '-EncodedCommand' ) ) {
				const script = Buffer.from(
					call.args[ call.args.indexOf( '-EncodedCommand' ) + 1 ],
					'base64'
				).toString( 'utf16le' );
				expect( script ).not.toContain( SECRET );
			}
		}
		expect( keychain.calls.some( ( call ) => call.input?.includes( SECRET ) ) ).toBe( true );
	} );

	it( 'keeps the secret out of a failed save’s error', async () => {
		const keychain = createFakeKeychain( platform );
		const store = createOsCredentialStore( { platform, run: keychain.run } );
		keychain.failNextWrite( { code: 1, stdout: '', stderr: `refused to store ${ SECRET }` } );

		const error = await store.set( 'openai-api-key', SECRET ).catch( ( e: unknown ) => e );
		expect( error ).toBeInstanceOf( SecureStorageError );
		expect( String( ( error as Error ).message ) ).not.toContain( SECRET );
		expect( keychain.items.size ).toBe( 0 );
	} );

	it( 'keeps the previous secret when saving a new one fails', async () => {
		const keychain = createFakeKeychain( platform );
		const store = createOsCredentialStore( { platform, run: keychain.run } );
		await store.set( 'openai-api-key', SECRET );
		keychain.failNextWrite( { code: 1, stdout: '', stderr: 'refused' } );

		await expect( store.set( 'openai-api-key', `${ SECRET }2` ) ).rejects.toBeInstanceOf(
			SecureStorageError
		);
		await expect( store.get( 'openai-api-key' ) ).resolves.toBe( SECRET );
	} );

	it( 'reports a save the keychain silently dropped', async () => {
		const keychain = createFakeKeychain( platform );
		const store = createOsCredentialStore( { platform, run: keychain.run } );
		keychain.dropWrites();

		await expect( store.set( 'openai-api-key', SECRET ) ).rejects.toBeInstanceOf(
			SecureStorageError
		);
	} );

	it( 'refuses secrets and item names that would need escaping', async () => {
		const keychain = createFakeKeychain( platform );
		const store = createOsCredentialStore( { platform, run: keychain.run } );

		await expect( store.set( 'openai-api-key', 'sk-with space' ) ).rejects.toBeInstanceOf(
			SecureStorageError
		);
		await expect( store.set( 'bad name', SECRET ) ).rejects.toThrow( /Invalid keychain item/ );
		expect( keychain.calls ).toHaveLength( 0 );
	} );
} );

describe( 'an unavailable system keychain', () => {
	it( 'explains a missing secret-tool on Linux', async () => {
		const store = createOsCredentialStore( {
			platform: 'linux',
			run: async () => ( {
				code: null,
				stdout: '',
				stderr: '',
				spawnError: Object.assign( new Error( 'spawn secret-tool ENOENT' ), { code: 'ENOENT' } ),
			} ),
		} );
		await expect( store.check() ).resolves.toEqual( {
			available: false,
			reason: expect.stringMatching( /libsecret-tools/ ),
			absent: true,
		} );
	} );

	it( 'reports a Linux session without a Secret Service', async () => {
		const store = createOsCredentialStore( {
			platform: 'linux',
			run: async () => ( {
				code: 1,
				stdout: '',
				stderr: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY',
			} ),
		} );
		const status = await store.check();
		expect( status ).toEqual( {
			available: false,
			reason: expect.stringMatching( /Cannot autolaunch D-Bus/ ),
		} );
		await expect( store.get( 'openai-api-key' ) ).rejects.toBeInstanceOf( SecureStorageError );
	} );

	it( 'has no keychain on an unsupported platform', async () => {
		const store = createOsCredentialStore( {
			platform: 'freebsd',
			run: async () => {
				throw new Error( 'must not run anything' );
			},
		} );
		await expect( store.check() ).resolves.toMatchObject( { available: false, absent: true } );
		await expect( store.set( 'openai-api-key', SECRET ) ).rejects.toBeInstanceOf(
			SecureStorageError
		);
	} );
} );
