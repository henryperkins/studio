// @vitest-environment node
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

const signIn = ( storage: 'vault' | 'session' ): ChatGptSignIn => ( {
	issuer: 'https://auth.openai.com',
	subject: 'test-subject-1',
	email: 'someone@example.com',
	clientId: 'test-issued-client-1',
	storage,
	tokens: {
		accessToken: 'test-access-token-1',
		refreshToken: 'test-refresh-token-1',
		idToken: 'test-id-token-1',
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
} );
