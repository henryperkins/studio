import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	getClaudeConnections,
	openClaudeNativeSignIn,
	prepareClaudeInvocation,
	saveClaudeConnection,
} from '../connection';
import { inspectClaudeExecutable } from '../discovery';
import { peBinary } from './fixtures/native-binaries';
import type { ExecFileOptions } from 'child_process';

const { invoke } = vi.hoisted( () => ( {
	invoke:
		vi.fn<
			( file: string, args: string[], options: ExecFileOptions ) => Promise< { stdout: string } >
		>(),
} ) );

vi.mock( 'child_process', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('child_process') >();
	const { promisify } = await import( 'util' );
	const execFile = Object.assign( vi.fn(), { [ promisify.custom ]: invoke } );
	return { ...actual, execFile };
} );

function peHeader( machine: number ): Buffer {
	return peBinary( { machine } );
}

describe.runIf( process.platform === 'win32' && process.arch === 'x64' )(
	'Windows Claude process preflight with a simulated executable',
	() => {
		let root: string;
		let executable: string;
		let config: string;
		let workspace: string;
		let stdout: string;
		let authFailure: Error | undefined;
		let version: string;
		let duringPowerShell: ( ( script: string ) => Promise< void > ) | undefined;
		let duringAuthStatus: ( () => Promise< void > ) | undefined;
		let duringVersion: ( () => Promise< void > ) | undefined;
		const scripts = () =>
			invoke.mock.calls
				.filter( ( [ , args ] ) => args[ 2 ] === '-EncodedCommand' )
				.map( ( [ , args, options ] ) => ( {
					script: Buffer.from( args[ 3 ], 'base64' ).toString( 'utf16le' ),
					options,
				} ) );

		beforeEach( async () => {
			root = await mkdtemp( path.join( os.tmpdir(), 'Studio Claude Évidence ' ) );
			executable = path.join( root, 'Claude Édition.exe' );
			config = path.join( root, 'configuration' );
			workspace = path.join( root, 'local site' );
			await Promise.all( [
				mkdir( config ),
				mkdir( workspace ),
				writeFile( executable, peHeader( 0x8664 ) ),
			] );
			for ( const key of Object.keys( process.env ) ) {
				if ( /^(ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|AZURE_|.*_PROXY$|NODE_OPTIONS$)/i.test( key ) ) {
					vi.stubEnv( key, undefined );
				}
			}
			vi.stubEnv( 'STUDIO_EXPERIMENTAL_CLAUDE_CODE', '1' );
			vi.stubEnv( 'STUDIO_OPENAI_API_KEY', 'studio-secret-fixture' );
			vi.stubEnv( 'DEV_CONFIG_DIR', config );
			vi.stubEnv( 'USERPROFILE', root );
			vi.stubEnv( 'ProgramFiles', root );
			stdout = JSON.stringify( {
				loggedIn: true,
				authMethod: 'claude.ai',
				apiProvider: 'firstParty',
				storedClaudeAiLogin: true,
				subscriptionType: 'pro',
				configDirectory: config,
				projectsDirectory: path.join( config, 'projects' ),
				email: 'native-test@example.invalid',
			} );
			authFailure = undefined;
			version = '2.1.319 (Claude Code)';
			duringPowerShell = undefined;
			duringAuthStatus = undefined;
			duringVersion = undefined;
			invoke.mockReset();
			invoke.mockImplementation( async ( file, args ) => {
				if ( args[ 0 ] === '-NoProfile' ) {
					const script = Buffer.from( args[ 3 ], 'base64' ).toString( 'utf16le' );
					if ( script.includes( 'IsWow64Process2' ) ) return { stdout: '34404' };
					await duringPowerShell?.( script );
					return { stdout: '' };
				}
				expect( file ).toBe( executable );
				if ( args[ 0 ] === '--version' ) {
					await duringVersion?.();
					return { stdout: version };
				}
				expect( args ).toEqual( [ 'auth', 'status', '--json' ] );
				await duringAuthStatus?.();
				if ( authFailure ) throw authFailure;
				return { stdout };
			} );
		} );

		afterEach( async () => {
			vi.unstubAllEnvs();
			await rm( root, { recursive: true, force: true, maxRetries: 4 } );
		} );

		it( 'runs the selected path containing spaces and Unicode with the same cwd and filtered environment', async () => {
			await expect(
				prepareClaudeInvocation( executable, workspace, config )
			).resolves.toMatchObject( {
				ok: true,
				cwd: workspace,
				executablePath: executable,
				executable: {
					target: 'windows-x64',
					format: 'pe',
					provenance: { verification: 'authenticode', signer: 'Anthropic, PBC' },
					qualification: { state: 'qualified' },
				},
				executableIdentity: { path: executable },
			} );
			const [ , , options ] = invoke.mock.calls.find( ( [ , args ] ) => args[ 0 ] === 'auth' )!;
			expect( options ).toMatchObject( { cwd: workspace, timeout: 10000 } );
			expect( options.shell ).not.toBe( true );
			expect( options.env?.CLAUDE_CONFIG_DIR ).toBe( config );
			expect( options.env?.STUDIO_OPENAI_API_KEY ).toBeUndefined();
		} );

		it( 'refuses absent executables, shims and wrong architecture before running a child', async () => {
			await expect(
				inspectClaudeExecutable( path.join( root, 'absent.exe' ) )
			).resolves.toMatchObject( { ok: false } );
			await expect(
				inspectClaudeExecutable( path.join( root, 'claude.bat' ) )
			).resolves.toMatchObject( { ok: false } );
			await writeFile( executable, peHeader( 0xaa64 ) );
			await expect( inspectClaudeExecutable( executable ) ).resolves.toMatchObject( {
				ok: false,
				reason: 'architecture-unqualified',
			} );
			expect( invoke ).not.toHaveBeenCalled();
		} );

		it( 'refuses an installed version older than the qualified pair', async () => {
			version = '2.1.318 (Claude Code)';
			await expect( inspectClaudeExecutable( executable ) ).resolves.toMatchObject( {
				ok: false,
				reason: 'version-unqualified',
				qualification: {
					state: 'unqualified',
					reason: 'version-unqualified',
					supportedRuntimeVersions: [ '2.1.319' ],
				},
			} );
		} );

		it( 'recognizes the native signed-out exit and JSON response', async () => {
			authFailure = Object.assign( new Error(), {
				code: 1,
				stdout: '{"loggedIn":false,"authMethod":"none"}',
			} );
			await expect(
				prepareClaudeInvocation( executable, workspace, config )
			).resolves.toMatchObject( {
				ok: false,
				blockers: [ 'native-auth-unqualified' ],
			} );
		} );

		it( 'refuses a nonzero exit even when its output claims an active login', async () => {
			authFailure = Object.assign( new Error(), { code: 1, stdout } );
			await expect(
				prepareClaudeInvocation( executable, workspace, config )
			).resolves.toMatchObject( {
				ok: false,
			} );
		} );

		it( 'returns sanitized evidence for a timeout or malformed JSON', async () => {
			const unknown = { ok: false, blockers: [ 'preflight-unavailable' ] };
			authFailure = Object.assign( new Error( 'private stderr' ), { killed: true } );
			await expect( prepareClaudeInvocation( executable, workspace, config ) ).resolves.toEqual(
				unknown
			);
			authFailure = undefined;
			stdout = 'malformed and private output';
			await expect( prepareClaudeInvocation( executable, workspace, config ) ).resolves.toEqual(
				unknown
			);
		} );

		it( 'stops before running the executable when a managed policy is deployed, saying where', async () => {
			await mkdir( path.join( root, 'ClaudeCode' ) );
			await writeFile( path.join( root, 'ClaudeCode', 'managed-settings.json' ), '{"secret":1}' );
			const result = await prepareClaudeInvocation( executable, workspace, config );
			expect( result ).toMatchObject( {
				ok: false,
				blockers: [ 'managed-policy-unverified' ],
				managedPolicy: {
					state: 'present',
					present: [
						{
							kind: 'settings-file',
							scope: 'machine',
							location: path.join( root, 'ClaudeCode', 'managed-settings.json' ),
						},
					],
				},
			} );
			expect( JSON.stringify( result ) ).not.toContain( 'secret' );
			expect( invoke.mock.calls.some( ( [ file ] ) => file === executable ) ).toBe( false );
		} );

		it( 'requests a separate visible native console using the selected executable', async () => {
			await saveClaudeConnection( {
				id: 'native-login',
				executablePath: executable,
				configDirectory: config,
			} );
			await expect( openClaudeNativeSignIn( 'native-login' ) ).resolves.toEqual( {
				state: 'launched',
			} );

			const launch = scripts().find( ( { script } ) => script.includes( 'ProcessStartInfo' ) )!;
			expect( launch.script ).toContain( '$i.UseShellExecute=$true' );
			expect( launch.script ).toContain( '[System.Diagnostics.ProcessWindowStyle]::Normal' );
			expect( launch.script ).toContain( "$i.Arguments='auth login'" );
			expect( launch.script ).toContain( Buffer.from( executable, 'utf8' ).toString( 'base64' ) );
			expect( launch.script ).not.toContain( 'Start-Process' );
			expect( launch.options.env?.CLAUDE_CONFIG_DIR ).toBe( config );
			expect( launch.options.env?.STUDIO_OPENAI_API_KEY ).toBeUndefined();
			expect( ( await getClaudeConnections() )[ 0 ].revision ).toBe( 2 );
		} );

		it( 'launches no sign-in and keeps the connection when the executable changed after inspection', async () => {
			await saveClaudeConnection( { id: 'swapped', executablePath: executable } );
			duringPowerShell = async ( script ) => {
				if ( script.includes( 'Policies' ) )
					await writeFile( executable, peBinary( { body: 'swapped' } ) );
			};
			await expect( openClaudeNativeSignIn( 'swapped' ) ).resolves.toEqual( {
				state: 'refused',
				reason: 'executable-changed',
			} );
			expect( scripts().some( ( { script } ) => script.includes( 'ProcessStartInfo' ) ) ).toBe(
				false
			);
			expect( ( await getClaudeConnections() )[ 0 ].revision ).toBeUndefined();
		} );

		it( 'refuses sign-in with a typed reason when the executable, configuration or policy is not qualified', async () => {
			const refusedWith = async ( id: string, reason: string ) => {
				await expect( openClaudeNativeSignIn( id ), reason ).resolves.toEqual( {
					state: 'refused',
					reason,
				} );
				expect(
					scripts().some( ( { script } ) => script.includes( 'ProcessStartInfo' ) ),
					reason
				).toBe( false );
				expect(
					( await getClaudeConnections() ).find( ( item ) => item.id === id )?.revision,
					reason
				).toBeUndefined();
			};
			await saveClaudeConnection( { id: 'old', executablePath: executable } );
			version = '2.1.318 (Claude Code)';
			await refusedWith( 'old', 'version-unqualified' );
			version = '2.1.319 (Claude Code)';

			await saveClaudeConnection( { id: 'routed-environment', executablePath: executable } );
			vi.stubEnv( 'ANTHROPIC_BASE_URL', 'https://gateway.example' );
			await refusedWith( 'routed-environment', 'environment-conflict' );
			vi.stubEnv( 'ANTHROPIC_BASE_URL', undefined );

			await saveClaudeConnection( {
				id: 'conflict',
				executablePath: executable,
				configDirectory: config,
			} );
			vi.stubEnv( 'CLAUDE_CONFIG_DIR', workspace );
			await refusedWith( 'conflict', 'config-directory-conflict' );
			vi.stubEnv( 'CLAUDE_CONFIG_DIR', undefined );

			await saveClaudeConnection( {
				id: 'routed',
				executablePath: executable,
				configDirectory: config,
			} );
			await writeFile(
				path.join( config, 'settings.json' ),
				JSON.stringify( { apiKeyHelper: 'helper' } )
			);
			await refusedWith( 'routed', 'configuration-unqualified' );
			await rm( path.join( config, 'settings.json' ) );

			await saveClaudeConnection( { id: 'managed', executablePath: executable } );
			await mkdir( path.join( root, 'ClaudeCode' ) );
			await writeFile( path.join( root, 'ClaudeCode', 'managed-settings.json' ), '{}' );
			await refusedWith( 'managed', 'managed-policy-unverified' );
		} );

		it( 'asks for the user’s action over a remote session and changes nothing', async () => {
			await saveClaudeConnection( { id: 'remote', executablePath: executable } );
			vi.stubEnv( 'SSH_CONNECTION', '10.0.0.2 50000 10.0.0.1 22' );
			await expect( openClaudeNativeSignIn( 'remote' ) ).resolves.toEqual( {
				state: 'user-action-needed',
				reason: 'no-interactive-desktop',
			} );
			expect( scripts().some( ( { script } ) => script.includes( 'ProcessStartInfo' ) ) ).toBe(
				false
			);
			expect( ( await getClaudeConnections() )[ 0 ].revision ).toBeUndefined();
		} );

		it( 'reads no native status once the selected path leads to another binary after inspection', async () => {
			const first = path.join( root, 'first' );
			const second = path.join( root, 'second' );
			const current = path.join( root, 'current' );
			await Promise.all( [ mkdir( first ), mkdir( second ) ] );
			executable = path.join( first, 'claude.exe' );
			await writeFile( executable, peHeader( 0x8664 ) );
			await writeFile( path.join( second, 'claude.exe' ), peBinary( { body: 'next version' } ) );
			await symlink( first, current, 'junction' );
			duringVersion = async () => {
				await unlink( current );
				await symlink( second, current, 'junction' );
			};
			await expect(
				prepareClaudeInvocation( path.join( current, 'claude.exe' ), workspace, config )
			).resolves.toMatchObject( { ok: false, blockers: [ 'executable-changed' ] } );
			expect( invoke.mock.calls.some( ( [ , args ] ) => args[ 0 ] === 'auth' ) ).toBe( false );
		} );

		it( 'refuses a preparation whose executable changed while the native status was read', async () => {
			duringAuthStatus = async () => {
				await writeFile( executable, peBinary( { body: 'auto-updated' } ) );
			};
			await expect(
				prepareClaudeInvocation( executable, workspace, config )
			).resolves.toMatchObject( { ok: false, blockers: [ 'executable-changed' ] } );
		} );
	}
);
