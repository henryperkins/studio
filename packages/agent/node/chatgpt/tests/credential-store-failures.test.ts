// @vitest-environment node
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	createOsCredentialStore,
	type CommandResult,
	type CommandRunner,
} from '@studio/common/lib/os-credential-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ChatGptConnectionError,
	readChatGptAccount,
	readChatGptAccounts,
} from '@studio/agent/node/chatgpt/account-store';
import {
	createChatGptCredentialBroker,
	type ChatGptSignIn,
	type ChatGptTokenClient,
} from '@studio/agent/node/chatgpt/credential-broker';

// Every store here runs over a scripted tool; the real keychain is never reached.
vi.mock( '@studio/common/lib/os-credential-store', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/common/lib/os-credential-store') >();
	return {
		...actual,
		createOsCredentialStore: (
			options?: Parameters< typeof actual.createOsCredentialStore >[ 0 ]
		) => {
			if ( ! options?.run ) {
				throw new Error( 'A test must never reach the system keychain.' );
			}
			return actual.createOsCredentialStore( options );
		},
	};
} );

type Platform = 'darwin' | 'linux' | 'win32';

const GRANTED_SCOPE =
	'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
// Placeholders only: nothing here is, or looks like, a real credential.
const TOKEN_MARKERS = [ 'test-access-token', 'test-refresh-token', 'test-id-token' ];

const signIn = ( storage: 'vault' | 'session', id = 1 ): ChatGptSignIn => ( {
	issuer: 'https://auth.openai.com',
	subject: 'test-subject-1',
	email: 'someone@example.com',
	clientId: 'test-issued-client-1',
	storage,
	tokens: {
		accessToken: `test-access-token-${ id }`,
		refreshToken: `test-refresh-token-${ id }`,
		idToken: `test-id-token-${ id }`,
		tokenType: 'Bearer',
		expiresIn: 3600,
		scope: GRANTED_SCOPE,
	},
} );

// No sign-in here reaches the token service: a call to it is a failure of the test.
const unreachableTokenService: ChatGptTokenClient = {
	refresh: async () => {
		throw new Error( 'The token service must not be called.' );
	},
	revoke: async () => {
		throw new Error( 'The token service must not be called.' );
	},
};

const answer = ( code: number, stderr: string ): CommandResult => ( { code, stdout: '', stderr } );
const missing = ( command: string ): CommandResult => ( {
	code: null,
	stdout: '',
	stderr: '',
	spawnError: Object.assign( new Error( `spawn ${ command } ENOENT` ), { code: 'ENOENT' } ),
} );
const timedOut: CommandResult = { code: null, stdout: '', stderr: '' };

interface Failure {
	name: string;
	/** What the tool answers to every call. */
	result: CommandResult;
}

const FAILURES: Record< Platform, readonly Failure[] > = {
	darwin: [
		{
			name: 'denied',
			result: answer(
				128,
				'security: SecKeychainItemCreateFromContent (<default>): User canceled the operation.'
			),
		},
		{
			name: 'locked with no one to unlock it (headless)',
			result: answer(
				36,
				'security: SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.'
			),
		},
		{ name: 'unavailable', result: missing( '/usr/bin/security' ) },
		{ name: 'timed out', result: timedOut },
	],
	linux: [
		{
			name: 'denied',
			result: answer( 1, 'secret-tool: Cannot create an item in a locked collection' ),
		},
		{ name: 'locked', result: answer( 1, 'secret-tool: Cannot get secret of a locked object' ) },
		{ name: 'without secret-tool', result: missing( 'secret-tool' ) },
		{
			name: 'headless, without a session bus',
			result: answer( 1, 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY' ),
		},
		{ name: 'timed out', result: timedOut },
	],
	win32: [
		{
			name: 'denied',
			result: answer( 1, 'Exception calling "Add" with "1" argument(s): "Access is denied."' ),
		},
		{
			name: 'headless, without a logon session',
			result: answer(
				1,
				'Exception calling "Retrieve" with "2" argument(s): "A specified logon session does not exist."'
			),
		},
		{ name: 'unavailable', result: missing( 'powershell.exe' ) },
		{ name: 'timed out', result: timedOut },
	],
};

const CASES = ( Object.keys( FAILURES ) as Platform[] ).flatMap( ( platform ) =>
	FAILURES[ platform ].map( ( failure ) => ( { platform, ...failure } ) )
);

const WRAPPING_KEY = 'wordpress-studio/chatgpt-vault-key';

// How each tool says nothing is saved under a name.
const NOTHING_SAVED: Record< Platform, CommandResult > = {
	darwin: answer(
		44,
		'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.'
	),
	linux: answer( 1, '' ),
	win32: answer( 3, '' ),
};

/**
 * Each platform's keychain tool, keeping secrets by service and account. While
 * `saysNothingSaved` is set, it answers every read and removal as it does when
 * nothing is saved, though its items are still there: what libsecret may
 * answer once an unlock prompt was dismissed. A write goes through, as one
 * whose unlock prompt was accepted would, and ends that.
 */
function scriptedKeychain( platform: Platform ) {
	const items = new Map< string, string >();
	const state = { saysNothingSaved: false };
	const calls: Array< { args: readonly string[]; input?: string } > = [];
	const ok = ( stdout = '' ): CommandResult => ( { code: 0, stdout, stderr: '' } );
	const write = ( name: string, secret: string ) => {
		items.set( name, secret );
		state.saysNothingSaved = false;
		return ok();
	};
	const read = ( name: string ) => {
		const secret = items.get( name );
		if ( state.saysNothingSaved || secret === undefined ) {
			return NOTHING_SAVED[ platform ];
		}
		return ok( platform === 'darwin' ? `${ secret }\n` : secret );
	};
	const remove = ( name: string ) =>
		! state.saysNothingSaved && items.delete( name ) ? ok() : NOTHING_SAVED[ platform ];
	const run: CommandRunner = async ( _command, args, { input } ) => {
		calls.push( { args, input } );
		if ( platform === 'linux' ) {
			const name = `${ args[ args.indexOf( 'service' ) + 1 ] }/${
				args[ args.indexOf( 'account' ) + 1 ]
			}`;
			if ( args[ 0 ] === 'store' ) {
				return write( name, input ?? '' );
			}
			return args[ 0 ] === 'clear' ? remove( name ) : read( name );
		}
		if ( platform === 'darwin' ) {
			const added = /^add-generic-password -U -s (\S+) -a (\S+) -w (\S+)\n$/.exec( input ?? '' );
			if ( args[ 0 ] === '-i' && added ) {
				return write( `${ added[ 1 ] }/${ added[ 2 ] }`, added[ 3 ] );
			}
			const name = `${ args[ args.indexOf( '-s' ) + 1 ] }/${ args[ args.indexOf( '-a' ) + 1 ] }`;
			return args[ 0 ] === 'delete-generic-password' ? remove( name ) : read( name );
		}
		const script = Buffer.from( args[ args.length - 1 ], 'base64' ).toString( 'utf16le' );
		const named = /\('([^']+)', '([^']+)'/.exec( script );
		const name = named ? `${ named[ 1 ] }/${ named[ 2 ] }` : '';
		if ( script.includes( '[Console]::In.ReadToEnd()' ) ) {
			return write( name, input ?? '' );
		}
		return script.includes( '$vault.Remove($credential)' ) ? remove( name ) : read( name );
	};
	return { store: createOsCredentialStore( { platform, run } ), items, state, calls };
}

describe( 'a ChatGPT sign-in when the system keychain fails', () => {
	let configDir: string;
	let previousConfigDir: string | undefined;
	const logged: unknown[][] = [];

	const vaultFiles = () => {
		const directory = path.join( configDir, 'chatgpt-credentials' );
		return fs.existsSync( directory )
			? fs.readdirSync( directory ).filter( ( name ) => name.includes( '.vault' ) )
			: [];
	};
	// Everything written under the profile, as text.
	const readAllFiles = ( directory = configDir ): string =>
		fs
			.readdirSync( directory, { withFileTypes: true } )
			.map( ( entry ) => {
				const entryPath = path.join( directory, entry.name );
				return entry.isDirectory()
					? readAllFiles( entryPath )
					: fs.readFileSync( entryPath, 'utf8' );
			} )
			.join( '\n' );

	function expectNoToken( text: string ) {
		for ( const marker of TOKEN_MARKERS ) {
			expect( text ).not.toContain( marker );
		}
	}

	function failingKeychain( platform: Platform, result: CommandResult ) {
		const calls: Array< { args: readonly string[]; input?: string } > = [];
		const run: CommandRunner = async ( _command, args, { input } ) => {
			calls.push( { args, input } );
			return result;
		};
		return { store: createOsCredentialStore( { platform, run } ), calls };
	}

	beforeEach( () => {
		configDir = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-chatgpt-keychain-failure-' ) );
		previousConfigDir = process.env.DEV_CONFIG_DIR;
		process.env.DEV_CONFIG_DIR = configDir;
		for ( const method of [ 'log', 'info', 'warn', 'error', 'debug' ] as const ) {
			vi.spyOn( console, method ).mockImplementation( ( ...args: unknown[] ) => {
				logged.push( args );
			} );
		}
	} );

	afterEach( () => {
		vi.restoreAllMocks();
		if ( previousConfigDir === undefined ) {
			delete process.env.DEV_CONFIG_DIR;
		} else {
			process.env.DEV_CONFIG_DIR = previousConfigDir;
		}
		fs.rmSync( configDir, { recursive: true, force: true, maxRetries: 5 } );
		expect( logged.splice( 0 ) ).toEqual( [] );
	} );

	it.each( CASES )(
		'on $platform, $name: refuses to keep it, writes no token anywhere, and keeps it for the session only when asked',
		async ( { platform, result } ) => {
			const keychain = failingKeychain( platform, result );
			const broker = createChatGptCredentialBroker( {
				tokenClient: unreachableTokenService,
				credentialStore: keychain.store,
			} );

			// What the app asks before it offers to keep a sign-in.
			const status = await keychain.store.check();
			const failed = await broker
				.saveSignIn( signIn( 'vault' ) )
				.catch( ( error: unknown ) => error );

			expect( status ).toMatchObject( { available: false } );
			expect( failed ).toBeInstanceOf( ChatGptConnectionError );
			expect( failed ).toMatchObject( { code: 'vault-unavailable' } );
			expect( ( failed as Error ).message ).toMatch( /system keychain/ );
			expectNoToken( `${ ( failed as Error ).message }\n${ ( failed as Error ).stack }` );
			// Not kept anywhere else instead: no registration, no record, no token on disk.
			expect( await readChatGptAccounts() ).toEqual( [] );
			expect( vaultFiles() ).toEqual( [] );
			expectNoToken( readAllFiles() );
			for ( const call of keychain.calls ) {
				expectNoToken( call.args.join( ' ' ) );
			}

			const callsBefore = keychain.calls.length;
			const kept = await broker.saveSignIn( signIn( 'session' ) );

			expect( kept.storage ).toBe( 'session' );
			expect( await readChatGptAccount( kept.registrationId ) ).toMatchObject( {
				state: 'signed-in',
				storage: 'session',
			} );
			await expect( broker.getAccessToken( kept.registrationId ) ).resolves.toBe(
				'test-access-token-1'
			);
			// The keychain isn't asked again, and still nothing reaches the disk.
			expect( keychain.calls ).toHaveLength( callsBefore );
			expect( vaultFiles() ).toEqual( [] );
			expectNoToken( readAllFiles() );
		}
	);

	it.each( [ 'darwin', 'linux', 'win32' ] as const )(
		'on %s, refuses to keep a sign-in a keychain claimed to save but didn’t, writing no token',
		async ( platform ) => {
			// `security -i` exits 0 after a failed command; any tool may drop a write.
			const NOT_FOUND = { darwin: 44, linux: 1, win32: 3 }[ platform ];
			const run: CommandRunner = async ( _command, args, { input } ) => {
				const script = Buffer.from( args[ args.length - 1 ] ?? '', 'base64' ).toString( 'utf16le' );
				const reads =
					args.includes( 'lookup' ) ||
					args.includes( 'find-generic-password' ) ||
					( input === undefined && script.includes( 'RetrievePassword' ) );
				return { code: reads ? NOT_FOUND : 0, stdout: '', stderr: '' };
			};
			const broker = createChatGptCredentialBroker( {
				tokenClient: unreachableTokenService,
				credentialStore: createOsCredentialStore( { platform, run } ),
			} );

			const failed = await broker
				.saveSignIn( signIn( 'vault' ) )
				.catch( ( error: unknown ) => error );

			expect( failed ).toMatchObject( { code: 'vault-unavailable' } );
			expectNoToken( `${ ( failed as Error ).message }\n${ ( failed as Error ).stack }` );
			expect( await readChatGptAccounts() ).toEqual( [] );
			expect( vaultFiles() ).toEqual( [] );
			expectNoToken( readAllFiles() );
		}
	);

	// A locked keyring whose unlock prompt was dismissed may answer like a lost
	// key: neither is ever treated as lost while sealed records depend on it.
	describe( 'when it says nothing is saved while sealed records exist', () => {
		const PLATFORMS = [ 'darwin', 'linux', 'win32' ] as const;

		const records = () =>
			Object.fromEntries(
				vaultFiles().map( ( name ) => [
					name,
					fs.readFileSync( path.join( configDir, 'chatgpt-credentials', name ), 'utf8' ),
				] )
			);

		// Two saved sign-ins under one key, which the keychain then says it doesn't have.
		async function savedUnderUnreadableKey( platform: Platform ) {
			const keychain = scriptedKeychain( platform );
			const broker = () =>
				createChatGptCredentialBroker( {
					tokenClient: unreachableTokenService,
					credentialStore: keychain.store,
				} );
			const first = await broker().saveSignIn( signIn( 'vault', 1 ) );
			const second = await broker().saveSignIn( signIn( 'vault', 2 ) );
			keychain.state.saysNothingSaved = true;
			// Only a write hands the tool something on stdin.
			const writes = () => keychain.calls.filter( ( call ) => call.input !== undefined ).length;
			const writesBefore = writes();
			return {
				keychain,
				broker,
				first,
				second,
				key: keychain.items.get( WRAPPING_KEY ),
				sealed: records(),
				accounts: await readChatGptAccounts(),
				keychainWrites: () => writes() - writesBefore,
			};
		}

		function expectKeyUnreadable( error: unknown ) {
			expect( error ).toBeInstanceOf( ChatGptConnectionError );
			expect( error ).toMatchObject( { code: 'vault-key-unreadable' } );
			const { message, stack } = error as Error;
			expect( message ).toMatch( /system keychain/ );
			expect( message ).toMatch( /sign out of every saved ChatGPT account/ );
			expect( message ).toMatch( /makes a new key/ );
			expectNoToken( `${ message }\n${ stack }` );
		}

		it.each( PLATFORMS )(
			'on %s, reports the key unreadable, keeping the record and the registration as they are',
			async ( platform ) => {
				const saved = await savedUnderUnreadableKey( platform );

				expectKeyUnreadable(
					await saved
						.broker()
						.getAccessToken( saved.first.registrationId )
						.catch( ( error: unknown ) => error )
				);
				const turn = await saved.broker().beginTurn( saved.second.registrationId );
				expectKeyUnreadable( await turn.getAccessToken().catch( ( error: unknown ) => error ) );
				turn.end();
				await expect(
					saved.broker().readIdTokenHint( saved.first.registrationId )
				).resolves.toBeNull();

				expect( records() ).toEqual( saved.sealed );
				expect( await readChatGptAccounts() ).toEqual( saved.accounts );
				expect( saved.keychain.items.get( WRAPPING_KEY ) ).toBe( saved.key );
				expect( saved.keychainWrites() ).toBe( 0 );
			}
		);

		it.each( PLATFORMS )(
			'on %s, refuses a new secure save without making a key, and keeps one for the session when chosen',
			async ( platform ) => {
				const saved = await savedUnderUnreadableKey( platform );
				const app = saved.broker();

				for ( const save of [
					signIn( 'vault', 3 ),
					{ ...signIn( 'vault', 4 ), registrationId: saved.first.registrationId },
				] ) {
					expectKeyUnreadable( await app.saveSignIn( save ).catch( ( error: unknown ) => error ) );
				}
				expect( saved.keychainWrites() ).toBe( 0 );
				expect( saved.keychain.items.get( WRAPPING_KEY ) ).toBe( saved.key );
				expect( await readChatGptAccounts() ).toEqual( saved.accounts );
				expect( records() ).toEqual( saved.sealed );

				const kept = await app.saveSignIn( signIn( 'session', 5 ) );

				await expect( app.getAccessToken( kept.registrationId ) ).resolves.toBe(
					'test-access-token-5'
				);
				expect( saved.keychainWrites() ).toBe( 0 );
				expect( records() ).toEqual( saved.sealed );
				expectNoToken( readAllFiles() );
			}
		);

		it.each( PLATFORMS )(
			'on %s, opens the kept records with the same key once the keychain answers again',
			async ( platform ) => {
				const saved = await savedUnderUnreadableKey( platform );
				const app = saved.broker();
				await expect( app.getAccessToken( saved.first.registrationId ) ).rejects.toMatchObject( {
					code: 'vault-key-unreadable',
				} );

				saved.keychain.state.saysNothingSaved = false;

				await expect( app.getAccessToken( saved.first.registrationId ) ).resolves.toBe(
					'test-access-token-1'
				);
				await expect( saved.broker().getAccessToken( saved.second.registrationId ) ).resolves.toBe(
					'test-access-token-2'
				);
				const third = await app.saveSignIn( signIn( 'vault', 3 ) );
				await expect( saved.broker().getAccessToken( third.registrationId ) ).resolves.toBe(
					'test-access-token-3'
				);
				expect( saved.keychain.items.get( WRAPPING_KEY ) ).toBe( saved.key );
				expect( saved.keychainWrites() ).toBe( 0 );
			}
		);

		it.each( PLATFORMS )(
			'on %s, makes a new key for the next secure save once every saved sign-in is signed out',
			async ( platform ) => {
				const saved = await savedUnderUnreadableKey( platform );
				// The key really is gone.
				saved.keychain.state.saysNothingSaved = false;
				saved.keychain.items.delete( WRAPPING_KEY );
				// A record no saved account owns, which no sign-out could remove, stops nothing.
				fs.writeFileSync(
					path.join( configDir, 'chatgpt-credentials', `${ randomUUID() }.vault` ),
					Object.values( saved.sealed )[ 0 ]
				);
				const app = saved.broker();

				await expect( app.signOut( saved.first.registrationId ) ).resolves.toEqual( {
					localCleared: true,
					remoteRevocationConfirmed: false,
				} );
				expectKeyUnreadable(
					await app.saveSignIn( signIn( 'vault', 3 ) ).catch( ( error: unknown ) => error )
				);
				await app.signOut( saved.second.registrationId );
				const next = await app.saveSignIn( signIn( 'vault', 3 ) );

				const key = saved.keychain.items.get( WRAPPING_KEY );
				expect( key ).toMatch( /^[A-Za-z0-9_-]{43}$/ );
				expect( key ).not.toBe( saved.key );
				await expect( saved.broker().getAccessToken( next.registrationId ) ).resolves.toBe(
					'test-access-token-3'
				);
				expectNoToken( readAllFiles() );
			}
		);

		it.each( PLATFORMS )(
			'on %s, keeps a record its held key can’t open while the keychain says it has none',
			async ( platform ) => {
				const keychain = scriptedKeychain( platform );
				const broker = () =>
					createChatGptCredentialBroker( {
						tokenClient: unreachableTokenService,
						credentialStore: keychain.store,
					} );
				const app = broker();
				const { registrationId } = await app.saveSignIn( signIn( 'vault', 1 ) );
				await expect( app.getAccessToken( registrationId ) ).resolves.toBe( 'test-access-token-1' );
				// Elsewhere, the key went, the account was signed out and in again under a new key.
				keychain.items.delete( WRAPPING_KEY );
				const other = broker();
				await other.signOut( registrationId );
				await other.saveSignIn( { ...signIn( 'vault', 2 ), registrationId } );
				const sealed = records();
				keychain.state.saysNothingSaved = true;

				await expect( app.getAccessToken( registrationId ) ).rejects.toMatchObject( {
					code: 'vault-key-unreadable',
				} );

				expect( records() ).toEqual( sealed );
				expect( await readChatGptAccount( registrationId ) ).toMatchObject( {
					state: 'signed-in',
				} );
				keychain.state.saysNothingSaved = false;
				await expect( app.getAccessToken( registrationId ) ).resolves.toBe( 'test-access-token-2' );
			}
		);

		it.each( PLATFORMS )(
			'on %s, still clears a record its readable key can’t open, keeping the key',
			async ( platform ) => {
				const saved = await savedUnderUnreadableKey( platform );
				saved.keychain.state.saysNothingSaved = false;
				const file = path.join(
					configDir,
					'chatgpt-credentials',
					`${ saved.first.registrationId }.vault`
				);
				const envelope = JSON.parse( fs.readFileSync( file, 'utf8' ) );
				const ciphertext = Buffer.from( envelope.ciphertext, 'base64' );
				ciphertext[ 0 ] ^= 0xff;
				fs.writeFileSync(
					file,
					JSON.stringify( { ...envelope, ciphertext: ciphertext.toString( 'base64' ) } )
				);

				await expect(
					saved.broker().getAccessToken( saved.first.registrationId )
				).rejects.toMatchObject( { code: 'needs-sign-in' } );

				expect( fs.existsSync( file ) ).toBe( false );
				expect( await readChatGptAccount( saved.first.registrationId ) ).toMatchObject( {
					state: 'needs-sign-in',
				} );
				expect( saved.keychain.items.get( WRAPPING_KEY ) ).toBe( saved.key );
				await expect( saved.broker().getAccessToken( saved.second.registrationId ) ).resolves.toBe(
					'test-access-token-2'
				);
			}
		);
	} );
} );
