// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
	createOsCredentialStore,
	runCommand,
	SecureStorageError,
	type CommandResult,
	type CommandRunner,
} from '@studio/common/lib/os-credential-store';

/**
 * What each platform's keychain does when it can't, or won't, keep a secret,
 * and how a secret reaches each tool. The tools are emulated from their
 * sources: macOS `security -i` reads a command line of at most 4095
 * characters and runs whatever follows as the next command; libsecret's
 * `secret-tool store` keeps at most 8192 bytes of stdin and still exits 0;
 * Windows' PasswordVault script reads the secret from stdin.
 */

type Platform = 'darwin' | 'linux' | 'win32';

const PLATFORMS: readonly Platform[] = [ 'darwin', 'linux', 'win32' ];
const ACCOUNT = 'chatgpt-vault-key';
// Placeholders only: obviously fake, shaped like the vault key and an API key.
const SECRET = 'test-only-wrapping-0123456789ABCDEFGHIJKLMN';
const OTHER_SECRET = 'sk-test-only-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789';

interface Call {
	command: string;
	args: readonly string[];
	input?: string;
}

// The PowerShell script a Windows call runs: it travels on the command line.
function scriptOf( args: readonly string[] ): string {
	const index = args.indexOf( '-EncodedCommand' );
	return index === -1 ? '' : Buffer.from( args[ index + 1 ], 'base64' ).toString( 'utf16le' );
}

// Everything another process could read about a call: its command line.
const commandLineOf = ( call: Call ) =>
	[ call.command, ...call.args, scriptOf( call.args ) ].join( '\n' );

// Any run of `size` characters of the secret, so a cut-off piece counts too.
function findFragment( text: string, secret: string, size = 12 ): string | null {
	if ( ! secret ) {
		return null;
	}
	if ( secret.length < size ) {
		return text.includes( secret ) ? secret : null;
	}
	for ( let start = 0; start + size <= secret.length; start++ ) {
		const piece = secret.slice( start, start + size );
		if ( text.includes( piece ) ) {
			return piece;
		}
	}
	return null;
}

function describeError( error: unknown ): string {
	return error instanceof Error
		? `${ error.message }\n${ error.stack }\n${ JSON.stringify( error ) }`
		: JSON.stringify( error );
}

function expectNoSecretIn( text: string, ...secrets: string[] ) {
	for ( const secret of secrets ) {
		expect( findFragment( text, secret ) ).toBeNull();
	}
}

// The secret only ever crosses to a tool on stdin, never on a command line.
function expectSecretOnlyOnStdin( calls: readonly Call[], secret: string ) {
	for ( const call of calls ) {
		expectNoSecretIn( commandLineOf( call ), secret );
	}
}

const ok = ( stdout = '' ): CommandResult => ( { code: 0, stdout, stderr: '' } );
const answer = ( code: number, stderr: string ): CommandResult => ( { code, stdout: '', stderr } );
const missing = ( command: string ): CommandResult => ( {
	code: null,
	stdout: '',
	stderr: '',
	spawnError: Object.assign( new Error( `spawn ${ command } ENOENT` ), {
		code: 'ENOENT',
		syscall: `spawn ${ command }`,
		path: command,
	} ),
} );
// What `runCommand` reports once it has killed a tool that ran past its time.
const timedOut: CommandResult = { code: null, stdout: '', stderr: '' };

// macOS `security`, its interactive mode included (SecurityTool/macOS/security.c,
// sharedTool/readline.c, keychain_add.c).
function createSecurityTool() {
	const items = new Map< string, string >();
	const calls: Call[] = [];
	const LINE_BUFFER = 4096;
	const OPTIONS_WITH_VALUES = new Set( 'acCDGjlspwXT'.split( '' ) );
	const COMMANDS = [
		'add-generic-password',
		'default-keychain',
		'delete-generic-password',
		'find-generic-password',
	];
	const NOT_FOUND = answer(
		44,
		'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.'
	);

	// `readline` keeps at most LINE_BUFFER - 1 characters; the rest is the next line.
	function readLines( input: string ): string[] {
		const lines: string[] = [];
		let current = '';
		for ( let index = 0; index < input.length; index++ ) {
			if ( current.length === LINE_BUFFER - 1 ) {
				lines.push( current );
				current = '';
			}
			const character = input[ index ];
			if ( character === '\n' ) {
				lines.push( current );
				current = '';
			} else {
				current += character;
			}
		}
		return lines;
	}

	// `split_line`: whitespace separates, quotes group, a backslash escapes.
	function splitLine( line: string ): string[] {
		const args: string[] = [];
		let state: 'space' | 'arg' | 'quoted' = 'space';
		let quote = '';
		let current = '';
		for ( let index = 0; index < line.length; index++ ) {
			const character = line[ index ];
			if ( state === 'space' ) {
				if ( /\s/.test( character ) ) {
					continue;
				}
				if ( character === '"' || character === "'" ) {
					quote = character;
					state = 'quoted';
					continue;
				}
				state = 'arg';
			}
			if ( character === '\\' ) {
				current += line[ ++index ] ?? '';
			} else if ( state === 'arg' && /\s/.test( character ) ) {
				args.push( current );
				current = '';
				state = 'space';
			} else if ( state === 'quoted' && character === quote ) {
				args.push( current );
				current = '';
				state = 'space';
			} else {
				current += character;
			}
		}
		if ( state !== 'space' ) {
			args.push( current );
		}
		return args;
	}

	// BSD getopt: an option that takes a value takes the next argument, whatever it starts with.
	function parseOptions( args: readonly string[] ): Map< string, string > {
		const options = new Map< string, string >();
		for ( let index = 1; index < args.length; index++ ) {
			const arg = args[ index ];
			if ( arg === '--' || ! arg.startsWith( '-' ) || arg === '-' ) {
				break;
			}
			for ( let at = 1; at < arg.length; at++ ) {
				const option = arg[ at ];
				if ( OPTIONS_WITH_VALUES.has( option ) ) {
					options.set( option, at + 1 < arg.length ? arg.slice( at + 1 ) : args[ ++index ] ?? '' );
					break;
				}
				options.set( option, '' );
			}
		}
		return options;
	}

	function execute( args: readonly string[] ): CommandResult {
		if ( args.length === 0 ) {
			return ok();
		}
		// `match_command` takes a typed name as a prefix of the command's.
		const command = COMMANDS.find( ( name ) => name.startsWith( args[ 0 ] ) );
		if ( ! command ) {
			return answer( 1, `security: unknown command "${ args[ 0 ] }"` );
		}
		const options = parseOptions( args );
		const key = `${ options.get( 's' ) }/${ options.get( 'a' ) }`;
		switch ( command ) {
			case 'default-keychain':
				return ok( '    "/Users/test/Library/Keychains/login.keychain-db"\n' );
			case 'add-generic-password':
				items.set( key, options.get( 'w' ) ?? '' );
				return ok();
			case 'find-generic-password': {
				const value = items.get( key );
				return value === undefined ? NOT_FOUND : ok( `${ value }\n` );
			}
			default:
				return items.delete( key ) ? ok() : NOT_FOUND;
		}
	}

	const run: CommandRunner = async ( command, args, { input } ) => {
		calls.push( { command, args, input } );
		expect( command ).toBe( '/usr/bin/security' );
		if ( args[ 0 ] !== '-i' ) {
			return execute( args );
		}
		// The exit code is the last command's; each failure is reported as it happens.
		let last = ok();
		let stderr = '';
		for ( const line of readLines( input ?? '' ) ) {
			const argv = splitLine( line );
			last = execute( argv );
			if ( last.code !== 0 ) {
				stderr += `${ last.stderr }\n${ argv[ 0 ] }: returned ${ last.code }\n`;
			}
		}
		return { code: last.code, stdout: '', stderr };
	};
	return { run, calls, items };
}

// libsecret's `secret-tool` (tool/secret-tool.c).
function createSecretTool() {
	const items = new Map< string, string >();
	const calls: Call[] = [];
	const PASSWORD_BUFFER = 8192;
	const run: CommandRunner = async ( command, args, { input } ) => {
		calls.push( { command, args, input } );
		expect( command ).toBe( 'secret-tool' );
		const attribute = ( name: string ) => args[ args.indexOf( name ) + 1 ];
		const key = `${ attribute( 'service' ) }/${ attribute( 'account' ) }`;
		switch ( args[ 0 ] ) {
			case 'store': {
				const password = input ?? '';
				// `read_password_stdin` stops at its buffer, warns, and stores what it read.
				items.set( key, password.slice( 0, PASSWORD_BUFFER ) );
				return password.length >= PASSWORD_BUFFER
					? { code: 0, stdout: '', stderr: 'secret-tool: password is too long\n' }
					: ok();
			}
			case 'lookup': {
				const value = items.get( key );
				return value === undefined ? answer( 1, '' ) : ok( value );
			}
			case 'clear':
				return items.delete( key ) ? ok() : answer( 1, '' );
		}
		throw new Error( `Unexpected secret-tool command: ${ args[ 0 ] }` );
	};
	return { run, calls, items };
}

// The Windows PasswordVault script, as the adapter writes it.
function createPasswordVault() {
	const items = new Map< string, string >();
	const calls: Call[] = [];
	const run: CommandRunner = async ( command, args, { input } ) => {
		calls.push( { command, args, input } );
		expect( command ).toBe( 'powershell.exe' );
		const script = scriptOf( args );
		const named = /\('([^']+)', '([^']+)'/.exec( script );
		if ( ! named ) {
			return ok();
		}
		const key = `${ named[ 1 ] }/${ named[ 2 ] }`;
		if ( script.includes( '[Console]::In.ReadToEnd()' ) ) {
			items.set( key, input ?? '' );
			return ok();
		}
		if ( ! items.has( key ) ) {
			return answer( 3, '' );
		}
		if ( script.includes( '$vault.Remove($credential)' ) ) {
			items.delete( key );
			return ok();
		}
		return ok( items.get( key ) );
	};
	return { run, calls, items };
}

function createTool( platform: Platform ) {
	switch ( platform ) {
		case 'darwin':
			return createSecurityTool();
		case 'linux':
			return createSecretTool();
		case 'win32':
			return createPasswordVault();
	}
}

const TOOL: Record< Platform, string > = {
	darwin: '/usr/bin/security',
	linux: 'secret-tool',
	win32: 'powershell.exe',
};

interface FailureCase {
	name: string;
	result: CommandResult;
}

// How each keychain says no. Every call to the tool gets the same answer.
const FAILURES: Record< Platform, readonly FailureCase[] > = {
	darwin: [
		{
			name: 'denied by the user',
			result: answer(
				128,
				'security: SecKeychainItemCreateFromContent (<default>): User canceled the operation.'
			),
		},
		{
			name: 'locked, with no way to ask the user (headless, SSH)',
			result: answer(
				36,
				'security: SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.'
			),
		},
		{
			name: 'without a default keychain',
			result: answer(
				37,
				'security: SecKeychainCopyDefault: A default keychain could not be found.'
			),
		},
		{ name: 'unavailable: the tool is missing', result: missing( '/usr/bin/security' ) },
		{ name: 'timed out', result: timedOut },
	],
	linux: [
		{
			name: 'denied: the unlock prompt was dismissed',
			result: answer( 1, 'secret-tool: Cannot create an item in a locked collection' ),
		},
		{
			name: 'locked',
			result: answer( 1, 'secret-tool: Cannot get secret of a locked object' ),
		},
		{ name: 'unavailable: secret-tool is missing', result: missing( 'secret-tool' ) },
		{
			name: 'headless: no session bus and no display',
			result: answer( 1, 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY' ),
		},
		{
			name: 'a session bus address that leads nowhere',
			result: answer( 1, 'secret-tool: Could not connect: No such file or directory' ),
		},
		{
			name: 'a session bus with no Secret Service on it',
			result: answer(
				1,
				'secret-tool: The name org.freedesktop.secrets was not provided by any .service files'
			),
		},
		{ name: 'timed out', result: timedOut },
	],
	win32: [
		{
			name: 'denied',
			result: answer(
				1,
				'Exception calling "Add" with "1" argument(s): "Access is denied. (Exception from HRESULT: 0x80070005 (E_ACCESSDENIED))"'
			),
		},
		{
			name: 'headless: no logon session',
			result: answer(
				1,
				'Exception calling "Retrieve" with "2" argument(s): "A specified logon session does not exist. It may already have been terminated. (Exception from HRESULT: 0x80070520)"'
			),
		},
		{
			name: 'unavailable: the vault service can’t be reached',
			result: answer(
				1,
				'New-Object : Exception calling ".ctor" with "0" argument(s): "The RPC server is unavailable. (Exception from HRESULT: 0x800706BA)"'
			),
		},
		{ name: 'unavailable: PowerShell is missing', result: missing( 'powershell.exe' ) },
		{ name: 'timed out', result: timedOut },
	],
};

// A tool that answers every call the same way, echoing whatever it was given on
// stdin into its error, as a careless tool might.
function failingTool( result: CommandResult ) {
	const calls: Call[] = [];
	const run: CommandRunner = async ( command, args, { input } ) => {
		calls.push( { command, args, input } );
		return input && result.code !== null
			? { ...result, stderr: `${ result.stderr }\n${ input }` }
			: result;
	};
	return { run, calls };
}

async function failureOf( operation: Promise< unknown > ): Promise< unknown > {
	return operation.then(
		( value ) => {
			throw new Error( `Expected a failure, got ${ JSON.stringify( value ) }` );
		},
		( error: unknown ) => error
	);
}

describe.each( PLATFORMS )( 'the %s keychain when it fails', ( platform ) => {
	describe.each( FAILURES[ platform ] )( '$name', ( { result } ) => {
		it( 'says so with a typed error at every step, never as “no secret saved”, and leaks nothing', async () => {
			const tool = failingTool( result );
			const store = createOsCredentialStore( { platform, run: tool.run } );

			const status = await store.check();
			expect( status.available ).toBe( false );
			const reason = status.available ? '' : status.reason;
			expect( reason ).toMatch( /system keychain|secret-tool is not installed/ );

			const failures = [
				await failureOf( store.get( ACCOUNT ) ),
				await failureOf( store.set( ACCOUNT, SECRET ) ),
				await failureOf( store.delete( ACCOUNT ) ),
			];
			for ( const failure of failures ) {
				expect( failure ).toBeInstanceOf( SecureStorageError );
				expect( ( failure as Error ).message ).toMatch(
					/^Couldn't (read from|save to|remove from) the system keychain/
				);
				expectNoSecretIn( describeError( failure ), SECRET );
			}
			expectNoSecretIn( reason, SECRET );
			expect( tool.calls.every( ( call ) => call.command === TOOL[ platform ] ) ).toBe( true );
			expectSecretOnlyOnStdin( tool.calls, SECRET );
			expect( tool.calls.some( ( call ) => call.input?.includes( SECRET ) ) ).toBe( true );
		} );
	} );

	it( 'reports a save the tool said succeeded but didn’t keep, without the secret', async () => {
		const tool = createTool( platform );
		const store = createOsCredentialStore( { platform, run: tool.run } );
		// `security -i` exits 0 after a failed command; any tool may drop a write.
		const dropping: CommandRunner = async ( command, args, options ) =>
			options.input === undefined
				? tool.run( command, args, options )
				: {
						code: 0,
						stdout: '',
						stderr:
							'security: SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.\nadd-generic-password: returned -25308\n',
				  };
		const dropped = createOsCredentialStore( { platform, run: dropping } );
		await store.set( ACCOUNT, SECRET );

		const failure = await failureOf( dropped.set( ACCOUNT, OTHER_SECRET ) );

		expect( failure ).toBeInstanceOf( SecureStorageError );
		expect( ( failure as Error ).message ).toBe(
			'The system keychain didn’t keep the secret. Check that it is unlocked and try again.'
		);
		expectNoSecretIn( describeError( failure ), SECRET, OTHER_SECRET );
		await expect( store.get( ACCOUNT ) ).resolves.toBe( SECRET );
	} );

	it( 'reads a failed read-back as a failure, never as the secret it was given', async () => {
		const tool = createTool( platform );
		const locked = FAILURES[ platform ][ 1 ].result;
		const run: CommandRunner = async ( command, args, options ) =>
			options.input === undefined ? locked : tool.run( command, args, options );
		const store = createOsCredentialStore( { platform, run } );

		const failure = await failureOf( store.set( ACCOUNT, SECRET ) );

		expect( failure ).toBeInstanceOf( SecureStorageError );
		expectNoSecretIn( describeError( failure ), SECRET );
	} );
} );

describe.each( PLATFORMS )( 'what reaches the %s keychain tool', ( platform ) => {
	// Every one is refused before any tool runs: each tool would need it escaped,
	// and `security -i` reads a command line.
	const REFUSED: Array< [ string, string ] > = [
		[ 'a double quote', 'sk-test-"quoted' ],
		[ 'a single quote', "sk-test-'quoted" ],
		[ 'a backslash', 'sk-test-\\escaped' ],
		[
			'a newline that would start another command',
			'sk-test\ndelete-generic-password -s wordpress-studio -a openai-api-key',
		],
		[ 'a carriage return', 'sk-test\rreturn' ],
		[ 'a NUL', 'sk-test\u0000nul' ],
		[ 'a space', 'sk-test with-space' ],
		[ 'a tab', 'sk-test\ttab' ],
		[ 'non-ASCII', 'sk-test-café' ],
		[ 'nothing', '' ],
	];

	it.each( REFUSED )( 'refuses a secret with %s before any tool runs', async ( _name, secret ) => {
		const tool = createTool( platform );
		const store = createOsCredentialStore( { platform, run: tool.run } );

		const failure = await failureOf( store.set( ACCOUNT, secret ) );

		expect( failure ).toBeInstanceOf( SecureStorageError );
		expectNoSecretIn( describeError( failure ), secret );
		expect( tool.calls ).toEqual( [] );
	} );

	// Printable, unquoted, and none of them special to the tool reading them.
	const KEPT: Array< [ string, string ] > = [
		[ 'a leading dash', '-w-test-secret' ],
		[ 'a double dash', '--' ],
		[ 'a lone option', '-U' ],
		[ 'shell and PowerShell syntax', '$(whoami);`id`|&<>*?#!%' ],
		[ 'a command name', 'delete-generic-password' ],
	];

	it.each( KEPT )( 'keeps a secret with %s exactly, on stdin only', async ( _name, secret ) => {
		const tool = createTool( platform );
		const store = createOsCredentialStore( { platform, run: tool.run } );

		await store.set( ACCOUNT, secret );

		await expect( store.get( ACCOUNT ) ).resolves.toBe( secret );
		expect( [ ...tool.items.values() ] ).toEqual( [ secret ] );
		for ( const call of tool.calls ) {
			expect( call.args ).not.toContain( secret );
			if ( secret.length >= 4 ) {
				expect( commandLineOf( call ) ).not.toContain( secret );
			}
		}
		expect( tool.calls.some( ( call ) => call.input?.includes( secret ) ) ).toBe( true );
	} );

	it( 'refuses account names that a tool could read as an option', async () => {
		const tool = createTool( platform );
		const store = createOsCredentialStore( { platform, run: tool.run } );

		for ( const account of [ '-w', '--label=x', 'a b', "a'b", 'A' ] ) {
			await expect( store.set( account, SECRET ) ).rejects.toThrow( /Invalid keychain item/ );
			await expect( store.get( account ) ).rejects.toThrow( /Invalid keychain item/ );
			await expect( store.delete( account ) ).rejects.toThrow( /Invalid keychain item/ );
		}
		expect( () => createOsCredentialStore( { platform, service: '-s', run: tool.run } ) ).toThrow(
			/Invalid keychain item/
		);
		expect( tool.calls ).toEqual( [] );
	} );

	it( 'never cuts a long secret short, and keeps the previous one when it can’t take it whole', async () => {
		const tool = createTool( platform );
		const store = createOsCredentialStore( { platform, run: tool.run } );
		await store.set( ACCOUNT, SECRET );
		// Distinct all the way along, so any piece of it is recognisable.
		const long = Array.from( { length: 3000 }, ( _, index ) => `t${ index.toString( 36 ) }-` )
			.join( '' )
			.slice( 0, 9000 );

		const outcome = await store.set( ACCOUNT, long ).then(
			() => null,
			( error: unknown ) => error
		);

		const kept = await store.get( ACCOUNT );
		if ( outcome === null ) {
			expect( kept ).toBe( long );
		} else {
			expect( outcome ).toBeInstanceOf( SecureStorageError );
			expectNoSecretIn( describeError( outcome ), long );
			expect( kept ).toBe( SECRET );
			expect( [ ...tool.items.values() ] ).toEqual( [ SECRET ] );
		}
		expectSecretOnlyOnStdin( tool.calls, long );
	} );
} );

describe( 'the longest secret each keychain tool takes whole', () => {
	const distinct = ( length: number ) =>
		Array.from( { length }, ( _, index ) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[ index % 26 ] ).join( '' );

	it( 'is what fits on one `security -i` command line on macOS', async () => {
		const tool = createSecurityTool();
		const store = createOsCredentialStore( { platform: 'darwin', run: tool.run } );
		const room = 4095 - `add-generic-password -U -s wordpress-studio -a ${ ACCOUNT } -w `.length;

		await store.set( ACCOUNT, distinct( room ) );
		await expect( store.get( ACCOUNT ) ).resolves.toBe( distinct( room ) );
		await store.set( ACCOUNT, SECRET );
		const calls = tool.calls.length;

		const failure = await failureOf( store.set( ACCOUNT, distinct( room + 1 ) ) );
		expect( failure ).toBeInstanceOf( SecureStorageError );
		expect( tool.calls ).toHaveLength( calls );
		await expect( store.get( ACCOUNT ) ).resolves.toBe( SECRET );
	} );

	it( 'is what `secret-tool store` reads from stdin on Linux', async () => {
		const tool = createSecretTool();
		const store = createOsCredentialStore( { platform: 'linux', run: tool.run } );

		await store.set( ACCOUNT, distinct( 8192 ) );
		await expect( store.get( ACCOUNT ) ).resolves.toBe( distinct( 8192 ) );
		await store.set( ACCOUNT, SECRET );
		const calls = tool.calls.length;

		const failure = await failureOf( store.set( ACCOUNT, distinct( 8193 ) ) );
		expect( failure ).toBeInstanceOf( SecureStorageError );
		expect( tool.calls ).toHaveLength( calls );
		await expect( store.get( ACCOUNT ) ).resolves.toBe( SECRET );
	} );
} );

describe( 'running a keychain tool', () => {
	const node = process.execPath;

	it( 'hands it the secret on stdin, with nothing of it on the command line', async () => {
		const args = [
			'-e',
			'let s="";process.stdin.setEncoding("utf8").on("data",d=>s+=d).on("end",()=>process.stdout.write(String(s.length)))',
		];

		const result = await runCommand( node, args, { input: OTHER_SECRET, timeoutMs: 20_000 } );

		expect( result ).toEqual( { code: 0, stdout: String( OTHER_SECRET.length ), stderr: '' } );
		expectNoSecretIn( args.join( ' ' ), OTHER_SECRET );
	} );

	it( 'stops a tool that runs past its time, reporting no exit code', async () => {
		const started = Date.now();

		const result = await runCommand( node, [ '-e', 'setTimeout(() => {}, 60000)' ], {
			timeoutMs: 300,
		} );

		expect( result.code ).toBeNull();
		expect( result.spawnError ).toBeUndefined();
		expect( Date.now() - started ).toBeLessThan( 15_000 );
	} );

	it( 'reports a tool that isn’t installed', async () => {
		const result = await runCommand( 'studio-test-no-such-keychain-tool', [], {
			input: OTHER_SECRET,
			timeoutMs: 5_000,
		} );

		expect( result.code ).toBeNull();
		expect( result.spawnError?.code ).toBe( 'ENOENT' );
		expectNoSecretIn( describeError( result.spawnError ), OTHER_SECRET );
	} );

	it( 'survives a tool that exits before reading what it was sent', async () => {
		const result = await runCommand( node, [ '-e', 'process.exit(3)' ], {
			input: 'x'.repeat( 4 * 1024 * 1024 ),
			timeoutMs: 20_000,
		} );

		expect( result.code ).toBe( 3 );
	} );
} );
