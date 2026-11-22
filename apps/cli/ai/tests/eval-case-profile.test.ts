// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module keeps the profile it made for its process: each test loads it anew.
const load = async () => {
	vi.resetModules();
	return import( 'cli/ai/eval-case-profile' );
};

describe( 'an eval case’s own Studio profile', () => {
	let tmp: string;
	let source: string;

	beforeEach( () => {
		tmp = fs.realpathSync(
			fs.mkdtempSync( path.join( os.tmpdir(), 'studio-eval-profile-test-' ) )
		);
		source = path.join( tmp, 'source' );
		fs.mkdirSync( path.join( source, 'server-files' ), { recursive: true } );
		fs.writeFileSync( path.join( source, 'server-files', 'kept.txt' ), 'kept' );
		fs.mkdirSync( path.join( tmp, 'temp' ) );
	} );

	afterEach( () => {
		fs.rmSync( tmp, { recursive: true, force: true, maxRetries: 5 } );
	} );

	const writeShared = ( shared: Record< string, unknown > ) =>
		fs.writeFileSync( path.join( source, 'shared.json' ), JSON.stringify( shared ) );

	it( 'copies only the sign-in and the AI provider setting, links the downloads, and points the environment at it', async () => {
		writeShared( {
			version: 1,
			authToken: { accessToken: 'test-token' },
			aiProvider: 'anthropic-api-key',
			anthropicApiKey: 'test-anthropic-key',
			locale: 'fr',
			connectedWpcomSites: { 'local-1': [ { id: 1 } ] },
		} );
		fs.writeFileSync(
			path.join( source, 'cli.json' ),
			JSON.stringify( { sites: [ { port: 8881 }, { port: 'x' } ] } )
		);
		const other = path.join( tmp, 'temp', 'studio-eval-registry-other' );
		fs.mkdirSync( other );
		fs.writeFileSync(
			path.join( other, 'cli.json' ),
			JSON.stringify( { sites: [ { port: 8890 } ] } )
		);
		const env: NodeJS.ProcessEnv = { DEV_CONFIG_DIR: source };
		const { isolateCaseProfile, caseProfile } = await load();

		const made = isolateCaseProfile( env, { tmpdir: path.join( tmp, 'temp' ), home: tmp } );

		expect( made.source ).toBe( source );
		expect( made.reservedPorts.sort() ).toEqual( [ 8881, 8890 ] );
		expect( env ).toMatchObject( {
			E2E: '1',
			DEV_CONFIG_DIR: made.profile,
			E2E_SHARED_CONFIG_PATH: made.profile,
			E2E_CLI_CONFIG_PATH: made.registry,
		} );
		expect( path.basename( made.profile ) ).toMatch( /^studio-eval-config-/ );
		expect( path.basename( made.registry ) ).toMatch( /^studio-eval-registry-/ );
		expect(
			JSON.parse( fs.readFileSync( path.join( made.profile, 'shared.json' ), 'utf8' ) )
		).toEqual( {
			version: 1,
			authToken: { accessToken: 'test-token' },
			aiProvider: 'anthropic-api-key',
			anthropicApiKey: 'test-anthropic-key',
		} );
		expect( fs.lstatSync( path.join( made.profile, 'server-files' ) ).isSymbolicLink() ).toBe(
			true
		);
		expect( fs.readdirSync( made.profile ).sort() ).toEqual( [ 'server-files', 'shared.json' ] );
		expect( caseProfile() ).toEqual( { ok: true, profile: made } );
	} );

	it( 'reads the AI provider from the source’s registry when shared.json has none, as Studio does', async () => {
		writeShared( { version: 1 } );
		fs.writeFileSync(
			path.join( source, 'cli.json' ),
			JSON.stringify( { aiProvider: 'anthropic-api-key', anthropicApiKey: 'test-legacy-key' } )
		);
		const { isolateCaseProfile } = await load();
		const made = isolateCaseProfile(
			{ DEV_CONFIG_DIR: source },
			{ tmpdir: path.join( tmp, 'temp' ) }
		);
		expect(
			JSON.parse( fs.readFileSync( path.join( made.profile, 'shared.json' ), 'utf8' ) )
		).toEqual( {
			version: 1,
			aiProvider: 'anthropic-api-key',
			anthropicApiKey: 'test-legacy-key',
		} );
	} );

	it( 'takes ~/.studio as the source when no override names one', async () => {
		const { sourceConfigDirectory } = await load();
		expect( sourceConfigDirectory( {}, tmp ) ).toBe( path.join( tmp, '.studio' ) );
		expect( sourceConfigDirectory( { E2E: '1', E2E_SHARED_CONFIG_PATH: source }, tmp ) ).toBe(
			source
		);
		expect(
			sourceConfigDirectory(
				{ DEV_CONFIG_DIR: source, E2E: '1', E2E_SHARED_CONFIG_PATH: tmp },
				tmp
			)
		).toBe( source );
	} );

	it( 'keeps only the error code when the entry can’t make it, and leaves no folder behind', async () => {
		const temp = path.join( tmp, 'temp' );
		const env: NodeJS.ProcessEnv = {
			DEV_CONFIG_DIR: path.join( tmp, 'missing' ),
			TEMP: temp,
			TMP: temp,
			TMPDIR: temp,
		};
		const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
		Object.assign( process.env, { TEMP: temp, TMP: temp, TMPDIR: temp } );
		try {
			const { prepareCaseProfile, caseProfile } = await load();
			prepareCaseProfile( env );
			expect( caseProfile() ).toEqual( {
				ok: false,
				problem: 'the entry could not make it (ENOENT)',
			} );
		} finally {
			for ( const [ name, value ] of Object.entries( saved ) ) {
				if ( value === undefined ) {
					delete process.env[ name ];
				} else {
					process.env[ name ] = value;
				}
			}
		}
		expect( env.DEV_CONFIG_DIR ).toBe( path.join( tmp, 'missing' ) );
		expect( fs.readdirSync( temp ) ).toEqual( [] );
	} );

	it( 'says a runner started without the entry has no profile of its own', async () => {
		const { caseProfile } = await load();
		expect( caseProfile() ).toEqual( {
			ok: false,
			problem: 'the runner was started without the entry that makes it',
		} );
	} );

	it( 'withdraws the login for a case without the image service, and removes only its own folders, links as links', async () => {
		writeShared( { version: 1, authToken: { accessToken: 'test-token' }, aiProvider: 'wpcom' } );
		const { isolateCaseProfile, withdrawCaseLogin, removeCaseProfile, caseProfile } = await load();
		const made = isolateCaseProfile(
			{ DEV_CONFIG_DIR: source },
			{ tmpdir: path.join( tmp, 'temp' ) }
		);

		withdrawCaseLogin( made );
		expect(
			JSON.parse( fs.readFileSync( path.join( made.profile, 'shared.json' ), 'utf8' ) )
		).toEqual( { version: 1, aiProvider: 'wpcom' } );

		const warn = vi.fn();
		removeCaseProfile( warn );
		expect( warn ).not.toHaveBeenCalled();
		expect( fs.existsSync( made.profile ) ).toBe( false );
		expect( fs.existsSync( made.registry ) ).toBe( false );
		expect( fs.readFileSync( path.join( source, 'server-files', 'kept.txt' ), 'utf8' ) ).toBe(
			'kept'
		);
		expect( caseProfile().ok ).toBe( false );
		// Only once: a second call has nothing of its own left to remove.
		removeCaseProfile( warn );
		expect( warn ).not.toHaveBeenCalled();
	} );

	describe( 'the Anthropic API key and the provider setting', () => {
		const argvFor = ( vars: Record< string, unknown > ) => [
			'node',
			'eval-runner.mjs',
			'Reply READY.',
			'',
			JSON.stringify( { vars } ),
		];

		it.each( [
			[ 'a chatgpt-oauth selection named by the case', { provider: 'chatgpt-oauth' }, {}, false ],
			[
				'a chatgpt-oauth selection named by the environment',
				{},
				{ STUDIO_EVAL_PROVIDER: 'chatgpt-oauth' },
				false,
			],
			[ 'a wpcom selection', { provider: 'wpcom' }, {}, false ],
			[ 'an openai-api-key selection', { provider: 'openai-api-key' }, {}, false ],
			[
				'an anthropic-api-key selection named by the case',
				{ provider: 'anthropic-api-key' },
				{},
				true,
			],
			[
				'an anthropic-api-key selection named by the environment',
				{},
				{ STUDIO_EVAL_PROVIDER: ' anthropic-api-key ' },
				true,
			],
			[ 'a case on the default path', { model: 'claude-sonnet-4-6' }, {}, true ],
		] )( 'for %s, the key is copied: %s', async ( _name, vars, extraEnv, copied ) => {
			writeShared( {
				version: 1,
				authToken: { accessToken: 'made-up-login' },
				aiProvider: 'anthropic-api-key',
				anthropicApiKey: 'made-up-key',
			} );
			const { isolateCaseProfile } = await load();
			const made = isolateCaseProfile(
				{ DEV_CONFIG_DIR: source, ...extraEnv },
				{ tmpdir: path.join( tmp, 'temp' ), argv: argvFor( vars ) }
			);
			const onDisk = fs.readFileSync( path.join( made.profile, 'shared.json' ), 'utf8' );
			expect( JSON.parse( onDisk ) ).toEqual(
				copied
					? {
							version: 1,
							authToken: { accessToken: 'made-up-login' },
							aiProvider: 'anthropic-api-key',
							anthropicApiKey: 'made-up-key',
					  }
					: { version: 1, authToken: { accessToken: 'made-up-login' } }
			);
			expect( onDisk.includes( 'made-up-key' ) ).toBe( copied );
		} );

		it( 'copies nothing of the legacy registry’s key into a case that does not use it', async () => {
			writeShared( { version: 1 } );
			fs.writeFileSync(
				path.join( source, 'cli.json' ),
				JSON.stringify( {
					aiProvider: 'anthropic-api-key',
					anthropicApiKey: 'made-up-legacy-key',
				} )
			);
			const { isolateCaseProfile } = await load();
			const made = isolateCaseProfile(
				{ DEV_CONFIG_DIR: source },
				{ tmpdir: path.join( tmp, 'temp' ), argv: argvFor( { provider: 'chatgpt-oauth' } ) }
			);
			expect( fs.readFileSync( path.join( made.profile, 'shared.json' ), 'utf8' ) ).not.toContain(
				'made-up-legacy-key'
			);
		} );
	} );
} );
