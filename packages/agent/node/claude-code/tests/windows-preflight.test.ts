import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	openClaudeNativeSignIn,
	prepareClaudeInvocation,
	saveClaudeConnection,
} from '../connection';
import { inspectClaudeExecutable } from '../discovery';
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
	const buffer = Buffer.alloc( 96 );
	buffer.write( 'MZ' );
	buffer.writeUInt32LE( 64, 60 );
	buffer.writeUInt32LE( 0x4550, 64 );
	buffer.writeUInt16LE( machine, 68 );
	return buffer;
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
			invoke.mockReset();
			invoke.mockImplementation( async ( file, args ) => {
				if ( args[ 0 ] === '-NoProfile' ) return { stdout: '' };
				expect( file ).toBe( executable );
				if ( args[ 0 ] === '--version' ) return { stdout: version };
				expect( args ).toEqual( [ 'auth', 'status', '--json' ] );
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
			await expect( inspectClaudeExecutable( executable ) ).resolves.toEqual( {
				ok: false,
				reason: 'architecture-unqualified',
			} );
			expect( invoke ).not.toHaveBeenCalled();
		} );

		it( 'refuses an installed version older than the qualified pair', async () => {
			version = '2.1.318 (Claude Code)';
			await expect( inspectClaudeExecutable( executable ) ).resolves.toEqual( {
				ok: false,
				reason: 'version-unqualified',
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

		it( 'requests a separate visible native console using the selected executable', async () => {
			await saveClaudeConnection( {
				id: 'native-login',
				executablePath: executable,
				configDirectory: config,
			} );
			await openClaudeNativeSignIn( 'native-login' );

			const commands = invoke.mock.calls
				.filter( ( [ , args ] ) => args[ 2 ] === '-EncodedCommand' )
				.map( ( [ , args, options ] ) => ( {
					script: Buffer.from( args[ 3 ], 'base64' ).toString( 'utf16le' ),
					options,
				} ) );
			const launch = commands.find( ( { script } ) => script.includes( 'Start-Process' ) )!;
			expect( launch.script ).toContain( '-WindowStyle Normal' );
			expect( launch.script ).toContain( '-ErrorAction Stop' );
			expect( launch.script ).toContain( "-ArgumentList @('auth','login')" );
			expect( launch.script ).toContain( Buffer.from( executable, 'utf8' ).toString( 'base64' ) );
			expect( launch.options.env?.CLAUDE_CONFIG_DIR ).toBe( config );
		} );
	}
);
