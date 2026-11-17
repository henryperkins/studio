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

	it( 'imports nothing that reads the process manager home before it sets the case’s own', () => {
		const source = fs.readFileSync( entryFile, 'utf8' );
		const staticImports = [ ...source.matchAll( /^import\s[^;]*?from\s+'([^']+)'/gm ) ].map(
			( [ , specifier ] ) => specifier
		);
		for ( const specifier of staticImports ) {
			expect(
				specifier.startsWith( 'node:' ) ||
					specifier === './eval-case-daemon' ||
					specifier === './eval-port-range'
			).toBe( true );
		}
		const runnerImport = source.search( /import\(\s*'\.\/eval-runner'\s*\)/ );
		expect( runnerImport ).toBeGreaterThan( 0 );
		const isolation = source.indexOf( 'isolateCaseProcessManager(' );
		expect( isolation ).toBeGreaterThan( 0 );
		expect( isolation ).toBeLessThan( runnerImport );
	} );

	const loadEntry = async ( vars: Record< string, unknown >, env: NodeJS.ProcessEnv = {} ) => {
		const seen: { home?: string } = {};
		const main = vi.fn( async () => undefined );
		vi.doMock( 'cli/ai/eval-runner', () => {
			seen.home = process.env.STUDIO_PROCESS_MANAGER_HOME;
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
} );
