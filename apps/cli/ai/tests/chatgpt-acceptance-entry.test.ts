// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptanceRunPaths } from 'cli/ai/acceptance-isolation';

const cliRoot = path.resolve( import.meta.dirname, '..', '..' );
const entryFile = path.join( cliRoot, 'ai', 'chatgpt-acceptance-entry.ts' );

describe( 'ChatGPT acceptance entry', () => {
	const savedEnv = { ...process.env };
	const savedArgv = process.argv;
	let base: string;

	beforeEach( () => {
		base = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-acceptance-entry-' ) );
		vi.resetModules();
	} );

	afterEach( () => {
		process.argv = savedArgv;
		for ( const key of Object.keys( process.env ) ) {
			if ( ! ( key in savedEnv ) ) {
				delete process.env[ key ];
			}
		}
		Object.assign( process.env, savedEnv );
		vi.doUnmock( 'cli/ai/chatgpt-acceptance' );
		vi.restoreAllMocks();
		fs.rmSync( base, { recursive: true, force: true } );
	} );

	it( 'imports nothing that reads the environment before it isolates the run', () => {
		const source = fs.readFileSync( entryFile, 'utf8' );
		const staticImports = [ ...source.matchAll( /^import\s[^;]*?from\s+'([^']+)'/gm ) ].map(
			( [ , specifier ] ) => specifier
		);
		expect( staticImports.length ).toBeGreaterThan( 0 );
		for ( const specifier of staticImports ) {
			expect(
				specifier.startsWith( 'node:' ) ||
					specifier === './acceptance-isolation' ||
					specifier === '@wordpress/i18n'
			).toBe( true );
		}
		const runnerImport = source.search( /import\(\s*'\.\/chatgpt-acceptance'\s*\)/ );
		expect( runnerImport ).toBeGreaterThan( 0 );
		expect( source.indexOf( 'applyAcceptanceIsolation(' ) ).toBeLessThan( runnerImport );
	} );

	it.each( [ 'saved', 'provision' ] )(
		'points the profile and process manager at a new %s run directory before the runner loads',
		async ( scenario ) => {
			const runDir = path.join( base, 'run' );
			const seen: Record< string, string | undefined > = {};
			const run = vi.fn( async () => 2 );
			vi.doMock( 'cli/ai/chatgpt-acceptance', () => {
				for ( const name of [
					'DEV_CONFIG_DIR',
					'STUDIO_PROCESS_MANAGER_HOME',
					'E2E_APP_DATA_PATH',
					'E2E_CLI_CONFIG_PATH',
					'E2E_HOME_PATH',
				] ) {
					seen[ name ] = process.env[ name ];
				}
				return {
					runChatGptAcceptance: run,
					createLiveChatGptAcceptanceDependencies: () => ( { live: true } ),
				};
			} );
			const exit = vi.spyOn( process, 'exit' ).mockImplementation( () => undefined as never );
			process.env.DEV_CONFIG_DIR = path.join( os.homedir(), '.studio' );
			delete process.env.STUDIO_PROCESS_MANAGER_HOME;
			process.env.E2E_CLI_CONFIG_PATH = path.join( base, 'outside' );
			process.env.E2E_HOME_PATH = path.join( base, 'outside' );
			process.argv = [
				'node',
				'chatgpt-acceptance.mjs',
				'--scenario',
				scenario,
				'--run-dir',
				runDir,
			];

			await import( 'cli/ai/chatgpt-acceptance-entry' );
			await vi.waitFor( () => expect( exit ).toHaveBeenCalledWith( 2 ) );

			const paths = acceptanceRunPaths( runDir );
			expect( seen ).toEqual( {
				DEV_CONFIG_DIR: paths.profileDir,
				STUDIO_PROCESS_MANAGER_HOME: paths.daemonDir,
				E2E_APP_DATA_PATH: paths.appDataDir,
				E2E_CLI_CONFIG_PATH: paths.profileDir,
				E2E_HOME_PATH: undefined,
			} );
			expect( run ).toHaveBeenCalledWith( [ '--scenario', scenario, '--run-dir', runDir ], {
				live: true,
			} );
			expect( fs.existsSync( runDir ) ).toBe( false );
		}
	);
} );

describe( 'CLI build configurations', () => {
	const entriesOf = async ( file: string ) => {
		const config = ( await import( /* @vite-ignore */ path.join( cliRoot, file ) ) ).default as {
			build?: { lib?: { entry?: Record< string, string > } };
		};
		return Object.keys( config.build?.lib?.entry ?? {} );
	};

	it( 'builds the acceptance runner and its observer for development only', async () => {
		expect( await entriesOf( 'vite.config.dev.ts' ) ).toEqual(
			expect.arrayContaining( [
				'chatgpt-acceptance',
				'chatgpt-acceptance-observer',
				'eval-runner',
			] )
		);
		for ( const production of [
			'vite.config.prod.ts',
			'vite.config.npm.ts',
			'vite.config.standalone.ts',
		] ) {
			const entries = await entriesOf( production );
			expect( entries ).toContain( 'main' );
			expect( entries.filter( ( name ) => /acceptance|eval/.test( name ) ) ).toEqual( [] );
		}
	} );
} );
