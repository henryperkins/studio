// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAcceptanceIsolation } from 'cli/ai/acceptance-isolation';
import { acceptanceChildEnvironment } from 'cli/ai/chatgpt-acceptance';

const cliRoot = path.resolve( import.meta.dirname, '..', '..' );

// The path modules a CLI process the runner starts resolves its files through.
const PATH_MODULES: Record< string, () => Promise< Record< string, unknown > > > = {
	'@studio/common/lib/well-known-paths': () => import( '@studio/common/lib/well-known-paths' ),
	'cli/lib/appdata': () => import( 'cli/lib/appdata' ),
	'cli/lib/paths': () => import( 'cli/lib/paths' ),
	'cli/lib/site-paths': () => import( 'cli/lib/site-paths' ),
	'cli/lib/dependency-management/paths': () => import( 'cli/lib/dependency-management/paths' ),
};

// Exports allowed to resolve outside the run directory, and why.
const OUTSIDE_THE_RUN: Record< string, string > = {
	'cli/lib/paths#STUDIO_CLI_HOME':
		'only the default under PROCESS_MANAGER_HOME, which the run sets; migration 03 keeps its own copy, and the runner refuses the one profile state in which it renames anything',
};

const isWithin = ( inner: string, outer: string ) => {
	const relative = path.relative( outer.toLowerCase(), inner.toLowerCase() );
	return relative === '' || ( ! relative.startsWith( '..' ) && ! path.isAbsolute( relative ) );
};

describe( 'ChatGPT acceptance child isolation', () => {
	const savedEnv = { ...process.env };
	let base: string;

	beforeEach( () => {
		base = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-acceptance-children-' ) );
	} );

	afterEach( () => {
		for ( const key of Object.keys( process.env ) ) {
			if ( ! ( key in savedEnv ) ) {
				delete process.env[ key ];
			}
		}
		Object.assign( process.env, savedEnv );
		vi.resetModules();
		fs.rmSync( base, { recursive: true, force: true } );
	} );

	it( 'resolves every Studio path helper inside the run directory under the environment its children get', async () => {
		const runDir = path.join( base, 'run' );
		const outside = path.join( base, 'outside' );
		const realProfile = path.join( os.homedir(), '.studio' );
		// A shell that would point a run at the real profile and somewhere else.
		const shell: NodeJS.ProcessEnv = {
			...process.env,
			DEV_CONFIG_DIR: realProfile,
			STUDIO_PROCESS_MANAGER_HOME: path.join( realProfile, 'daemon' ),
			E2E_CLI_CONFIG_PATH: outside,
			E2E_SHARED_CONFIG_PATH: outside,
			E2E_APP_DATA_PATH: outside,
			E2E_SITES_ROOT: outside,
		};
		delete shell.E2E;
		expect(
			applyAcceptanceIsolation( shell, { runDir, mustBeNew: true, home: os.homedir() } ).ok
		).toBe( true );
		const child = acceptanceChildEnvironment( shell );
		for ( const key of Object.keys( process.env ) ) {
			if ( ! ( key in child ) ) {
				delete process.env[ key ];
			}
		}
		Object.assign( process.env, child );
		vi.resetModules();

		const resolved: Array< [ string, string ] > = [];
		for ( const [ specifier, load ] of Object.entries( PATH_MODULES ) ) {
			for ( const [ name, value ] of Object.entries( await load() ) ) {
				const key = `${ specifier }#${ name }`;
				const result =
					typeof value === 'function'
						? ( value as ( ...args: string[] ) => unknown )(
								...Array.from( { length: value.length }, () => '8.3' )
						  )
						: value;
				if ( typeof result === 'string' ) {
					resolved.push( [ key, result ] );
				}
			}
		}

		const checked = resolved.filter(
			( [ , value ] ) => path.isAbsolute( value ) && ! value.startsWith( '\\\\.\\pipe\\' )
		);
		expect( checked.map( ( [ key ] ) => key ) ).toEqual(
			expect.arrayContaining( [
				'@studio/common/lib/well-known-paths#getConfigDirectory',
				'@studio/common/lib/well-known-paths#getSessionsDirectory',
				'@studio/common/lib/well-known-paths#getCliConfigPath',
				'cli/lib/appdata#getAppdataDirectory',
				'cli/lib/paths#PROCESS_MANAGER_HOME',
				'cli/lib/site-paths#STUDIO_SITES_ROOT',
				'cli/lib/dependency-management/paths#getPhpBinaryPath',
			] )
		);
		const escaping = checked
			.filter( ( [ key, value ] ) => {
				if ( isWithin( value, runDir ) || key in OUTSIDE_THE_RUN ) {
					return false;
				}
				// Read-only files that ship with the CLI itself.
				return ! isWithin( value, cliRoot );
			} )
			.map( ( [ key ] ) => key );
		expect( escaping ).toEqual( [] );
	} );

	it( 'points WP-CLI’s config, cache and packages inside the run directory, leaving the home directory as it is', async () => {
		const runDir = path.join( base, 'run' );
		const realWpCli = path.join( os.homedir(), '.wp-cli' );
		const shell: NodeJS.ProcessEnv = {
			...process.env,
			WP_CLI_CONFIG_PATH: path.join( realWpCli, 'config.yml' ),
			WP_CLI_CACHE_DIR: path.join( realWpCli, 'cache' ),
			WP_CLI_PACKAGES_DIR: path.join( realWpCli, 'packages' ),
		};
		expect(
			applyAcceptanceIsolation( shell, { runDir, mustBeNew: true, home: os.homedir() } ).ok
		).toBe( true );
		const child = acceptanceChildEnvironment( shell );
		for ( const key of Object.keys( process.env ) ) {
			if ( ! ( key in child ) ) {
				delete process.env[ key ];
			}
		}
		Object.assign( process.env, child );
		vi.resetModules();
		// The environment the CLI gives the PHP process that runs WP-CLI.
		const { getPhpChildEnv } = await import( 'cli/lib/native-php/php-process' );
		const php = getPhpChildEnv();
		for ( const name of [ 'WP_CLI_CONFIG_PATH', 'WP_CLI_CACHE_DIR', 'WP_CLI_PACKAGES_DIR' ] ) {
			expect( php[ name ], name ).toBeDefined();
			expect( isWithin( php[ name ] as string, runDir ), name ).toBe( true );
		}
		expect( php.HOME ).toBe( savedEnv.HOME );
		expect( php.USERPROFILE ).toBe( savedEnv.USERPROFILE );
	} );
} );
