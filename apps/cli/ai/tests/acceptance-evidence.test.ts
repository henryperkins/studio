// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
	findUnsafeRecord,
	findUnsafeText,
	isManifestVersion,
	openAcceptanceEvidence,
	UnsafeEvidenceError,
	type ManifestRun,
} from 'cli/ai/acceptance-evidence';
import {
	acceptanceRunPaths,
	applyAcceptanceIsolation,
	checkAcceptanceRunDirectory,
	findRealProfileHazard,
	findRealProfileLeak,
	readAcceptanceArgument,
} from 'cli/ai/acceptance-isolation';

const JWT = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJlLXZhbHVl';
const API_KEY = 'sk-proj-AbCdEf0123456789AbCdEf0123456789';
const OPAQUE = 'rt_4f9Kq2LmNz8Xw3Vb7Hc1Yd6Tp0Rs5Ue2Ga9';
const UUID = '0d6b5a8e-3c1f-4e2a-9b7d-5f4c3a2b1e0d';

const manifestRun = ( overrides: Partial< ManifestRun > = {} ): Omit< ManifestRun, 'run' > => ( {
	scenario: 'saved',
	createdOn: '2026-11-11',
	source: { sha: '5c742434a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5', dirty: true },
	platform: { os: 'win32', release: '10.0.26320', arch: 'x64' },
	runtime: { node: '24.22.1', npm: '11.13.0' },
	build: { cliVersion: '1.7.3', buildId: 'a1b2c3d4e5f6' },
	model: 'gpt-6-luna',
	effort: 'medium',
	gates: [],
	...overrides,
} );

describe( 'acceptance evidence guard', () => {
	it.each( [
		[ 'a JSON web token', `token ${ JWT }` ],
		[ 'an API key', API_KEY ],
		[ 'a bearer header', 'Authorization: Bearer abc' ],
		[ 'an opaque refresh token', OPAQUE ],
	] )( 'rejects %s as token-shaped', ( _name, text ) => {
		expect( findUnsafeText( text ) ).toBe( 'token' );
	} );

	it.each( [
		[ 'an authorization URL', 'https://auth.openai.com/api/accounts/authorize' ],
		[ 'a callback URL', 'http://127.0.0.1:50123/auth/callback' ],
		[ 'a callback query', 'callback?code=abc&state=def' ],
		[ 'a loopback address', 'listening on localhost:8881' ],
		[ 'a bare host name', 'see chatgpt.com/settings/usage' ],
	] )( 'rejects %s as URL-shaped', ( _name, text ) => {
		expect( findUnsafeText( text ) ).toBe( 'url' );
	} );

	it( 'rejects email-shaped strings', () => {
		expect( findUnsafeText( 'signed in as someone@example.com' ) ).toBe( 'email' );
	} );

	it( 'rejects registration identifiers and local paths unless allowed', () => {
		expect( findUnsafeText( UUID ) ).toBe( 'identifier' );
		expect( findUnsafeText( UUID, { identifiers: true } ) ).toBeNull();
		expect( findUnsafeText( 'C:\\Users\\someone\\runs\\one' ) ).toBe( 'path' );
		expect( findUnsafeText( '/home/someone/runs/one' ) ).toBe( 'path' );
		expect( findUnsafeText( '/home/someone/runs/one', { paths: true } ) ).toBeNull();
	} );

	it( 'accepts stage names, typed codes and plain sentences', () => {
		for ( const text of [
			'returning-sign-in',
			'timed-out',
			'token-handed-out-during-window',
			'gpt-6-luna',
			'Stage sign-in failed: timed-out (599.5 s of 600 s).',
		] ) {
			expect( findUnsafeText( text ) ).toBeNull();
		}
	} );

	it( 'accepts only bounded counts, booleans and durations in a stage record', () => {
		const record = {
			schemaVersion: ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
			run: 1,
			scenario: 'saved',
			stage: 'sign-in',
			status: 'failed',
			code: 'timed-out',
			durationS: 599.5,
			observations: { browserOpened: true, completedAfterS: 599.5, timeoutS: 600 },
		};
		expect( findUnsafeRecord( record ) ).toBeNull();
		expect(
			findUnsafeRecord( { ...record, observations: { accountEmail: 'someone@example.com' } } )
		).toEqual( { path: 'observations.accountEmail', kind: 'shape' } );
		expect( findUnsafeRecord( { ...record, code: OPAQUE } ) ).toEqual( {
			path: 'code',
			kind: 'shape',
		} );
		expect( findUnsafeRecord( { ...record, message: 'free text' } ) ).toEqual( {
			path: 'message',
			kind: 'shape',
		} );
		expect( findUnsafeRecord( { ...record, observations: { requests: Infinity } } ) ).toEqual( {
			path: 'observations.requests',
			kind: 'shape',
		} );
		expect( findUnsafeRecord( { ...record, status: 'ok' } ) ).toEqual( {
			path: 'status',
			kind: 'shape',
		} );
	} );
} );

describe( 'acceptance evidence store', () => {
	let runDir: string;

	beforeEach( () => {
		runDir = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-acceptance-evidence-' ) );
	} );

	afterEach( () => {
		fs.rmSync( runDir, { recursive: true, force: true } );
	} );

	it( 'keeps a versioned manifest whose runs are appended, never replaced', () => {
		const evidence = openAcceptanceEvidence( runDir, 'chatgpt' );
		expect( evidence.readManifest() ).toBeNull();
		expect( evidence.startRun( manifestRun() ) ).toBe( 1 );
		expect( evidence.startRun( manifestRun( { scenario: 'session' } ) ) ).toBe( 2 );
		const manifest = JSON.parse( fs.readFileSync( path.join( runDir, 'manifest.json' ), 'utf8' ) );
		expect( manifest ).toEqual( {
			schemaVersion: ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
			provider: 'chatgpt',
			runs: [
				{ run: 1, ...manifestRun() },
				{ run: 2, ...manifestRun( { scenario: 'session' } ) },
			],
		} );
	} );

	it( 'refuses a manifest run carrying anything but its known fields', () => {
		const evidence = openAcceptanceEvidence( runDir, 'chatgpt' );
		expect( () => evidence.startRun( { ...manifestRun(), model: 'someone@example.com' } ) ).toThrow(
			UnsafeEvidenceError
		);
		expect( () =>
			evidence.startRun( {
				...manifestRun(),
				build: { cliVersion: '1.7.3', buildId: JWT },
			} )
		).toThrow( UnsafeEvidenceError );
		expect( fs.existsSync( path.join( runDir, 'manifest.json' ) ) ).toBe( false );
	} );

	it( 'accepts an operating system release it can’t read as null, never as free text', () => {
		const evidence = openAcceptanceEvidence( runDir, 'chatgpt' );
		const unread = manifestRun( { platform: { os: 'linux', release: null, arch: 'arm64' } } );
		expect( evidence.startRun( unread ) ).toBe( 1 );
		expect( evidence.readManifest()?.runs[ 0 ].platform.release ).toBeNull();
		expect( () =>
			evidence.startRun(
				manifestRun( { platform: { os: 'linux', release: 'unknown', arch: 'x64' } } )
			)
		).toThrow( UnsafeEvidenceError );
		expect( isManifestVersion( '6.8.0-45-generic' ) ).toBe( true );
		expect( isManifestVersion( '6.1.0+rpt-rpi-v8' ) ).toBe( false );
	} );

	it( 'appends one record per stage and never rewrites earlier ones', () => {
		const evidence = openAcceptanceEvidence( runDir, 'chatgpt' );
		evidence.record( {
			run: 1,
			scenario: 'session',
			stage: 'returning-sign-in',
			status: 'failed',
			code: 'timed-out',
			durationS: 599.5,
			observations: { completedAfterS: 599.5 },
		} );
		const first = fs.readFileSync( path.join( runDir, 'evidence.ndjson' ), 'utf8' );
		evidence.record( {
			run: 2,
			scenario: 'session',
			stage: 'returning-sign-in',
			status: 'passed',
			durationS: 31.2,
			observations: { completedAfterS: 31.2 },
		} );
		const both = fs.readFileSync( path.join( runDir, 'evidence.ndjson' ), 'utf8' );
		expect( both.startsWith( first ) ).toBe( true );
		expect( evidence.readRecords().map( ( record ) => [ record.status, record.code ] ) ).toEqual( [
			[ 'failed', 'timed-out' ],
			[ 'passed', undefined ],
		] );
	} );

	it( 'refuses an unsafe record without writing any of it', () => {
		const evidence = openAcceptanceEvidence( runDir, 'chatgpt' );
		const attempt = () =>
			evidence.record( {
				run: 1,
				scenario: 'saved',
				stage: 'sign-in',
				status: 'failed',
				code: 'timed-out',
				durationS: 1,
				observations: { [ `token${ OPAQUE.replace( /[-_]/g, '' ) }` ]: true },
			} );
		expect( attempt ).toThrow( UnsafeEvidenceError );
		try {
			attempt();
		} catch ( error ) {
			expect( ( error as Error ).message ).not.toContain( OPAQUE.replace( /[-_]/g, '' ) );
		}
		expect( fs.existsSync( path.join( runDir, 'evidence.ndjson' ) ) ).toBe( false );
	} );

	it( 'keeps local test identifiers in state.json, never tokens, URLs or emails', () => {
		const evidence = openAcceptanceEvidence( runDir, 'chatgpt' );
		evidence.writeState( { registrationId: UUID, sitePath: path.join( runDir, 'sites', 'one' ) } );
		expect( evidence.readState() ).toEqual( {
			registrationId: UUID,
			sitePath: path.join( runDir, 'sites', 'one' ),
		} );
		for ( const leak of [
			{ token: JWT },
			{ url: 'https://example.test/a' },
			{ email: 'a@b.co' },
		] ) {
			expect( () => evidence.writeState( leak ) ).toThrow( UnsafeEvidenceError );
		}
		expect( evidence.readState() ).toEqual( {
			registrationId: UUID,
			sitePath: path.join( runDir, 'sites', 'one' ),
		} );
	} );
} );

describe( 'acceptance run isolation', () => {
	let base: string;
	const home = path.join( os.tmpdir(), 'studio-acceptance-home' );

	beforeEach( () => {
		base = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-acceptance-isolation-' ) );
	} );

	afterEach( () => {
		fs.rmSync( base, { recursive: true, force: true } );
	} );

	it( 'reads an option from the command line without parsing anything else', () => {
		const argv = [ '--live', '--scenario', 'saved', '--run-dir=/tmp/run' ];
		expect( readAcceptanceArgument( argv, '--scenario' ) ).toBe( 'saved' );
		expect( readAcceptanceArgument( argv, '--run-dir' ) ).toBe( '/tmp/run' );
		expect( readAcceptanceArgument( argv, '--model' ) ).toBeUndefined();
	} );

	it( 'puts the profile, process manager, sites, observations and WP-CLI files inside the run directory', () => {
		const runDir = path.join( base, 'run' );
		expect( acceptanceRunPaths( runDir ) ).toEqual( {
			runDir,
			profileDir: path.join( runDir, 'profile' ),
			daemonDir: path.join( runDir, 'daemon' ),
			sitesDir: path.join( runDir, 'sites' ),
			appDataDir: path.join( runDir, 'appdata' ),
			observerDir: path.join( runDir, 'observer' ),
			wpCliDir: path.join( runDir, 'wp-cli' ),
		} );
	} );

	it( 'refuses a missing, relative, non-empty or Studio-profile run directory', () => {
		expect( checkAcceptanceRunDirectory( undefined, { mustBeNew: true, home } ) ).toEqual( {
			ok: false,
			problem: 'run-dir-missing',
		} );
		expect( checkAcceptanceRunDirectory( 'relative/run', { mustBeNew: true, home } ) ).toEqual( {
			ok: false,
			problem: 'run-dir-relative',
		} );
		fs.writeFileSync( path.join( base, 'left-over' ), '' );
		expect( checkAcceptanceRunDirectory( base, { mustBeNew: true, home } ) ).toEqual( {
			ok: false,
			problem: 'run-dir-not-empty',
		} );
		expect(
			checkAcceptanceRunDirectory( path.join( home, '.studio', 'acceptance' ), {
				mustBeNew: true,
				home,
			} )
		).toEqual( { ok: false, problem: 'run-dir-in-studio-profile' } );
		expect(
			checkAcceptanceRunDirectory( path.join( base, 'missing' ), { mustBeNew: false, home } )
		).toEqual( { ok: false, problem: 'run-dir-not-found' } );
		expect(
			checkAcceptanceRunDirectory( path.join( base, 'new' ), { mustBeNew: true, home } )
		).toEqual( { ok: true, paths: acceptanceRunPaths( path.join( base, 'new' ) ) } );
	} );

	it( 'sets the isolated environment only for an acceptable run directory', () => {
		const env: NodeJS.ProcessEnv = { DEV_CONFIG_DIR: 'elsewhere' };
		expect(
			applyAcceptanceIsolation( env, { runDir: 'relative', mustBeNew: true, home } ).ok
		).toBe( false );
		expect( env ).toEqual( { DEV_CONFIG_DIR: 'elsewhere' } );

		const runDir = path.join( base, 'run' );
		expect( applyAcceptanceIsolation( env, { runDir, mustBeNew: true, home } ).ok ).toBe( true );
		expect( env ).toEqual( {
			DEV_CONFIG_DIR: path.join( runDir, 'profile' ),
			STUDIO_PROCESS_MANAGER_HOME: path.join( runDir, 'daemon' ),
			E2E: '1',
			E2E_SITES_ROOT: path.join( runDir, 'sites' ),
			E2E_APP_DATA_PATH: path.join( runDir, 'appdata' ),
			E2E_CLI_CONFIG_PATH: path.join( runDir, 'profile' ),
			E2E_SHARED_CONFIG_PATH: path.join( runDir, 'profile' ),
			WP_CLI_CONFIG_PATH: path.join( runDir, 'wp-cli', 'config.yml' ),
			WP_CLI_CACHE_DIR: path.join( runDir, 'wp-cli', 'cache' ),
			WP_CLI_PACKAGES_DIR: path.join( runDir, 'wp-cli', 'packages' ),
		} );
		expect( fs.existsSync( runDir ) ).toBe( false );
	} );

	it( 'drops every inherited E2E_ variable before pointing the ones Studio reads at the run', () => {
		const outside = path.join( base, 'outside' );
		const env: NodeJS.ProcessEnv = {
			PATH: 'kept',
			E2E_CLI_CONFIG_PATH: outside,
			E2E_SHARED_CONFIG_PATH: outside,
			E2E_APP_DATA_PATH: outside,
			E2E_SITES_ROOT: outside,
			E2E_HOME_PATH: outside,
			e2e_daemon_logs_dir: outside,
		};
		const runDir = path.join( base, 'run' );
		expect( applyAcceptanceIsolation( env, { runDir, mustBeNew: true, home } ).ok ).toBe( true );
		expect( env.PATH ).toBe( 'kept' );
		const e2e = Object.entries( env ).filter( ( [ name ] ) => /^e2e_/i.test( name ) );
		expect( e2e.map( ( [ name ] ) => name ).sort() ).toEqual( [
			'E2E_APP_DATA_PATH',
			'E2E_CLI_CONFIG_PATH',
			'E2E_SHARED_CONFIG_PATH',
			'E2E_SITES_ROOT',
		] );
		for ( const [ , value ] of e2e ) {
			expect( path.relative( runDir, value ?? '' ).startsWith( '..' ) ).toBe( false );
		}
	} );

	it( 'finds, without changing anything, a real profile a CLI migration would rename in', () => {
		const realHome = path.join( base, 'home' );
		const studio = path.join( realHome, '.studio' );
		expect( findRealProfileHazard( realHome ) ).toBeNull();
		fs.mkdirSync( path.join( studio, 'pm2' ), { recursive: true } );
		expect( findRealProfileHazard( realHome ) ).toBe( 'legacy-process-manager-home' );
		expect( fs.readdirSync( studio ) ).toEqual( [ 'pm2' ] );
		fs.mkdirSync( path.join( studio, 'daemon' ) );
		expect( findRealProfileHazard( realHome ) ).toBeNull();
		expect( fs.readdirSync( studio ).sort() ).toEqual( [ 'daemon', 'pm2' ] );
	} );

	it( "finds either variable resolving to the user's real Studio profile", () => {
		const realProfile = path.join( home, '.studio' );
		expect( findRealProfileLeak( { DEV_CONFIG_DIR: realProfile }, home ) ).toBe( 'DEV_CONFIG_DIR' );
		expect( findRealProfileLeak( { DEV_CONFIG_DIR: path.join( base, 'p' ) }, home ) ).toBe(
			'STUDIO_PROCESS_MANAGER_HOME'
		);
		expect(
			findRealProfileLeak(
				{
					DEV_CONFIG_DIR: path.join( base, 'p' ),
					STUDIO_PROCESS_MANAGER_HOME: path.join( realProfile, 'daemon' ),
				},
				home
			)
		).toBe( 'STUDIO_PROCESS_MANAGER_HOME' );
		expect(
			findRealProfileLeak(
				{
					DEV_CONFIG_DIR: path.join( base, 'p' ),
					STUDIO_PROCESS_MANAGER_HOME: path.join( base, 'd' ),
				},
				home
			)
		).toBeNull();
	} );
} );
