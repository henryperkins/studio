// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const entryFile = path.resolve( import.meta.dirname, '..', 'eval-runner-entry.ts' );

describe( 'eval runner entry', () => {
	const savedEnv = { ...process.env };
	const savedArgv = process.argv;
	let tmp: string;

	beforeEach( () => {
		tmp = fs.realpathSync( fs.mkdtempSync( path.join( os.tmpdir(), 'studio-eval-entry-' ) ) );
		for ( const name of [ 'TEMP', 'TMP', 'TMPDIR' ] ) {
			process.env[ name ] = tmp;
		}
		// A range the test names, so the entry claims no ports.
		process.env.STUDIO_BASE_PORT = '29900';
		// A source profile in the scratch folder, never this machine's own.
		process.env.DEV_CONFIG_DIR = path.join( tmp, 'no-source-profile' );
		for ( const name of [ 'E2E_SHARED_CONFIG_PATH', 'E2E_CLI_CONFIG_PATH' ] ) {
			delete process.env[ name ];
		}
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
		vi.doUnmock( 'cli/ai/eval-runner' );
		fs.rmSync( tmp, { recursive: true, force: true, maxRetries: 5 } );
	} );

	it( 'imports nothing that fixes a path before it sets the case’s own process manager and profile', () => {
		const source = fs.readFileSync( entryFile, 'utf8' );
		const staticImports = [ ...source.matchAll( /^import\s[^;]*?from\s+'([^']+)'/gm ) ].map(
			( [ , specifier ] ) => specifier
		);
		for ( const specifier of staticImports ) {
			expect(
				specifier.startsWith( 'node:' ) ||
					specifier === './eval-case-daemon' ||
					specifier === './eval-case-profile' ||
					specifier === './eval-port-range'
			).toBe( true );
		}
		for ( const helper of [ 'eval-case-daemon.ts', 'eval-case-profile.ts' ] ) {
			const helperSource = fs.readFileSync(
				path.join( path.dirname( entryFile ), helper ),
				'utf8'
			);
			for ( const [ , specifier ] of helperSource.matchAll(
				/^import\s[^;]*?from\s+'([^']+)'/gm
			) ) {
				expect( specifier ).toMatch( /^node:/ );
			}
		}
		const runnerImport = source.search( /import\(\s*'\.\/eval-runner'\s*\)/ );
		expect( runnerImport ).toBeGreaterThan( 0 );
		for ( const call of [ 'isolateCaseProcessManager(', 'prepareCaseProfile(' ] ) {
			const isolation = source.indexOf( call );
			expect( isolation ).toBeGreaterThan( 0 );
			expect( isolation ).toBeLessThan( runnerImport );
		}
	} );

	const loadEntry = async ( vars: Record< string, unknown >, env: NodeJS.ProcessEnv = {} ) => {
		const seen: { home?: string; configDirectory?: string; sharedConfig?: string } = {};
		const main = vi.fn( async () => undefined );
		vi.doMock( 'cli/ai/eval-runner', () => {
			seen.home = process.env.STUDIO_PROCESS_MANAGER_HOME;
			seen.configDirectory = process.env.DEV_CONFIG_DIR;
			seen.sharedConfig = process.env.E2E_SHARED_CONFIG_PATH;
			return { main };
		} );
		Object.assign( process.env, env );
		process.argv = [ 'node', 'eval-runner.mjs', 'Reply READY.', '', JSON.stringify( { vars } ) ];
		await import( 'cli/ai/eval-runner-entry' );
		await vi.waitFor( () => expect( main ).toHaveBeenCalled() );
		return seen;
	};

	it( 'gives a case that names a provider its own process manager before the runner loads', async () => {
		process.env.STUDIO_PROCESS_MANAGER_HOME = path.join( tmp, 'owners-daemon' );
		const seen = await loadEntry( {}, { STUDIO_EVAL_PROVIDER: 'chatgpt-oauth' } );
		expect( path.dirname( seen.home ?? '' ) ).toBe( tmp );
		expect( path.basename( seen.home ?? '' ) ).toMatch( /^studio-eval-daemon-/ );
		expect( fs.statSync( seen.home ?? '' ).isDirectory() ).toBe( true );
	} );

	it( 'points every case at a Studio profile of its own before the runner loads', async () => {
		const source = path.join( tmp, 'source-profile' );
		fs.mkdirSync( source );
		fs.writeFileSync( path.join( source, 'shared.json' ), JSON.stringify( { version: 1 } ) );
		const before = fs.readdirSync( source );
		const seen = await loadEntry( {}, { DEV_CONFIG_DIR: source } );
		expect( path.dirname( seen.configDirectory ?? '' ) ).toBe( tmp );
		expect( path.basename( seen.configDirectory ?? '' ) ).toMatch( /^studio-eval-config-/ );
		expect( seen.sharedConfig ).toBe( seen.configDirectory );
		expect( fs.readdirSync( source ) ).toEqual( before );
	} );

	it( 'leaves a case on the default path with the process manager it inherited', async () => {
		const owners = path.join( tmp, 'owners-daemon' );
		process.env.STUDIO_PROCESS_MANAGER_HOME = owners;
		delete process.env.STUDIO_EVAL_PROVIDER;
		const seen = await loadEntry( { model: 'gpt-6-luna' } );
		expect( seen.home ).toBe( owners );
		expect(
			fs.readdirSync( tmp ).filter( ( name ) => name.startsWith( 'studio-eval-daemon-' ) )
		).toEqual( [] );
	} );

	describe( 'when it cannot hand over to the runner', () => {
		const fixedMessage = 'The eval runner could not start; nothing of the case was kept.';
		let source: string;
		let exit: ReturnType< typeof vi.spyOn >;
		let stderr: ReturnType< typeof vi.spyOn >;

		beforeEach( () => {
			// A source profile with a made-up login and key, in the scratch folder.
			source = path.join( tmp, 'source-profile' );
			fs.mkdirSync( source );
			fs.writeFileSync(
				path.join( source, 'shared.json' ),
				JSON.stringify( {
					version: 1,
					authToken: { accessToken: 'made-up-login' },
					aiProvider: 'anthropic-api-key',
					anthropicApiKey: 'made-up-key',
				} )
			);
			process.env.DEV_CONFIG_DIR = source;
			process.env.STUDIO_EVAL_PROVIDER = 'anthropic-api-key';
			process.argv = [
				'node',
				'eval-runner.mjs',
				'Reply READY.',
				'',
				JSON.stringify( { vars: {} } ),
			];
			exit = vi.spyOn( process, 'exit' ).mockImplementation( ( () => undefined ) as never );
			stderr = vi.spyOn( process.stderr, 'write' ).mockImplementation( () => true );
		} );

		afterEach( () => {
			exit.mockRestore();
			stderr.mockRestore();
			vi.doUnmock( 'cli/ai/eval-port-range' );
			vi.doUnmock( 'node:fs' );
		} );

		const left = () =>
			fs.readdirSync( tmp ).filter( ( name ) => name.startsWith( 'studio-eval-' ) );

		const expectNothingKept = async () => {
			await import( 'cli/ai/eval-runner-entry' );
			await vi.waitFor( () => expect( exit ).toHaveBeenCalled() );
			expect( exit ).toHaveBeenCalledWith( 1 );
			expect( left() ).toEqual( [] );
			expect( stderr.mock.calls.map( ( call: unknown[] ) => String( call[ 0 ] ) ).join( '' ) ).toBe(
				`${ fixedMessage }\n`
			);
			expect( fs.readdirSync( source ) ).toEqual( [ 'shared.json' ] );
		};

		it( 'removes the profile, the registry, the sites folder and the process manager home when claiming a port range rejects', async () => {
			delete process.env.STUDIO_BASE_PORT;
			vi.doMock( 'cli/ai/eval-port-range', () => ( {
				claimPortRange: async () => {
					throw new Error( 'All 100 eval port ranges are held by running processes.' );
				},
			} ) );
			await expectNothingKept();
		} );

		it( 'removes them when the runner cannot be imported', async () => {
			vi.doMock( 'cli/ai/eval-runner', () => {
				throw new Error( 'cannot load the runner' );
			} );
			await expectNothingKept();
		} );

		const failToClaim = () => {
			delete process.env.STUDIO_BASE_PORT;
			vi.doMock( 'cli/ai/eval-port-range', () => ( {
				claimPortRange: async () => {
					throw new Error( 'All 100 eval port ranges are held by running processes.' );
				},
			} ) );
		};

		it( 'leaves alone a process manager home it did not make: a default-path case that inherited one', async () => {
			delete process.env.STUDIO_EVAL_PROVIDER;
			const inherited = path.join( tmp, 'studio-eval-daemon-inherited' );
			fs.mkdirSync( inherited );
			fs.writeFileSync( path.join( inherited, 'daemon.sock' ), 'x' );
			process.env.STUDIO_PROCESS_MANAGER_HOME = inherited;
			failToClaim();
			await import( 'cli/ai/eval-runner-entry' );
			await vi.waitFor( () => expect( exit ).toHaveBeenCalledWith( 1 ) );
			expect( fs.readdirSync( inherited ) ).toEqual( [ 'daemon.sock' ] );
			expect( left() ).toEqual( [ 'studio-eval-daemon-inherited' ] );
		} );

		it( 'says so, in another fixed sentence with no path, when something could not be removed', async () => {
			failToClaim();
			vi.doMock( 'node:fs', async ( importOriginal ) => {
				const actual = await importOriginal< typeof import('node:fs') >();
				const rmSync = ( target: fs.PathLike, options?: fs.RmOptions ) => {
					if ( String( target ).includes( 'studio-eval-sites-' ) ) {
						throw Object.assign( new Error( 'busy' ), { code: 'EBUSY' } );
					}
					return actual.rmSync( target, options );
				};
				return { ...actual, rmSync, default: { ...actual, rmSync } };
			} );
			await import( 'cli/ai/eval-runner-entry' );
			await vi.waitFor( () => expect( exit ).toHaveBeenCalledWith( 1 ) );
			expect( stderr.mock.calls.map( ( call: unknown[] ) => String( call[ 0 ] ) ).join( '' ) ).toBe(
				'The eval runner could not start, and some of what it made could not be removed.\n'
			);
			expect( left() ).toHaveLength( 1 );
			expect( left()[ 0 ] ).toMatch( /^studio-eval-sites-/ );
		} );
	} );
} );
