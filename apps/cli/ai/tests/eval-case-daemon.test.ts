// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	caseProcessManagerHome,
	isolateCaseProcessManager,
	namesEvalProvider,
	stopCaseProcessManager,
} from 'cli/ai/eval-case-daemon';

const argvWith = ( vars: Record< string, unknown > ) => [
	'node',
	'eval-runner.mjs',
	'Reply READY.',
	'',
	JSON.stringify( { vars } ),
];

describe( 'a provider-qualified eval case’s own process manager', () => {
	let tmp: string;

	beforeEach( () => {
		tmp = fs.realpathSync( fs.mkdtempSync( path.join( os.tmpdir(), 'studio-eval-daemon-test-' ) ) );
	} );

	afterEach( () => {
		fs.rmSync( tmp, { recursive: true, force: true, maxRetries: 5 } );
	} );

	it( 'counts a run as naming a provider from the environment or the case’s provider var only', () => {
		expect( namesEvalProvider( argvWith( {} ), { STUDIO_EVAL_PROVIDER: 'chatgpt-oauth' } ) ).toBe(
			true
		);
		expect( namesEvalProvider( argvWith( { provider: 'wpcom' } ), {} ) ).toBe( true );
		expect( namesEvalProvider( argvWith( {} ), { STUDIO_EVAL_PROVIDER: '  ' } ) ).toBe( false );
		expect( namesEvalProvider( argvWith( { model: 'gpt-6-luna' } ), {} ) ).toBe( false );
		expect( namesEvalProvider( [ 'node', 'eval-runner.mjs', 'Hi', '', 'not json' ], {} ) ).toBe(
			false
		);
	} );

	it( 'gives a run that names a provider a new home, replacing the one it inherited', () => {
		const env: NodeJS.ProcessEnv = {
			STUDIO_EVAL_PROVIDER: 'chatgpt-oauth',
			STUDIO_PROCESS_MANAGER_HOME: path.join( tmp, 'owners-daemon' ),
		};
		const home = isolateCaseProcessManager( argvWith( {} ), env, tmp );
		expect( home ).not.toBeNull();
		expect( env.STUDIO_PROCESS_MANAGER_HOME ).toBe( home );
		expect( path.dirname( home ?? '' ) ).toBe( tmp );
		expect( path.basename( home ?? '' ) ).toMatch( /^studio-eval-daemon-/ );
		expect( fs.statSync( home ?? '' ).isDirectory() ).toBe( true );
		expect( caseProcessManagerHome( env, tmp ) ).toBe( home );
	} );

	it( 'leaves a run on the default path with the daemon it had, creating nothing', () => {
		const env: NodeJS.ProcessEnv = {
			STUDIO_PROCESS_MANAGER_HOME: path.join( tmp, 'owners-daemon' ),
		};
		expect( isolateCaseProcessManager( argvWith( { model: 'gpt-6-luna' } ), env, tmp ) ).toBeNull();
		expect( env.STUDIO_PROCESS_MANAGER_HOME ).toBe( path.join( tmp, 'owners-daemon' ) );
		expect( fs.readdirSync( tmp ) ).toEqual( [] );
		expect( caseProcessManagerHome( env, tmp ) ).toBeNull();
		expect( caseProcessManagerHome( {}, tmp ) ).toBeNull();
		// A folder named like a case's home anywhere but the temporary folder is not one.
		expect(
			caseProcessManagerHome(
				{ STUDIO_PROCESS_MANAGER_HOME: path.join( tmp, 'nested', 'studio-eval-daemon-x' ) },
				tmp
			)
		).toBeNull();
	} );

	it( 'ends the case’s own daemon and removes its home', async () => {
		const env: NodeJS.ProcessEnv = { STUDIO_EVAL_PROVIDER: 'chatgpt-oauth' };
		const home = isolateCaseProcessManager( argvWith( {} ), env, tmp ) ?? '';
		fs.mkdirSync( path.join( home, 'logs' ) );
		fs.writeFileSync( path.join( home, 'logs', 'daemon.log' ), 'log' );
		const kill = vi.fn( async () => undefined );
		const disconnect = vi.fn( async () => undefined );
		const warn = vi.fn();
		expect(
			await stopCaseProcessManager( {
				home: caseProcessManagerHome( env, tmp ),
				processManagerHome: home,
				kill,
				disconnect,
				warn,
			} )
		).toBe( 'stopped' );
		expect( kill ).toHaveBeenCalledTimes( 1 );
		expect( disconnect ).toHaveBeenCalledTimes( 1 );
		expect( fs.existsSync( home ) ).toBe( false );
		expect( warn ).not.toHaveBeenCalled();
	} );

	it( 'removes the home when no daemon ever started for the case', async () => {
		const env: NodeJS.ProcessEnv = { STUDIO_EVAL_PROVIDER: 'chatgpt-oauth' };
		const home = isolateCaseProcessManager( argvWith( {} ), env, tmp ) ?? '';
		const result = await stopCaseProcessManager( {
			home,
			processManagerHome: home,
			kill: async () => {
				throw Object.assign( new Error( 'connect ENOENT' ), { code: 'ENOENT' } );
			},
			disconnect: async () => undefined,
			warn: vi.fn(),
		} );
		expect( result ).toBe( 'stopped' );
		expect( fs.existsSync( home ) ).toBe( false );
	} );

	it( 'never ends a daemon whose home is not the case’s own', async () => {
		const owners = path.join( tmp, 'owners-daemon' );
		fs.mkdirSync( owners );
		const env: NodeJS.ProcessEnv = { STUDIO_EVAL_PROVIDER: 'chatgpt-oauth' };
		const home = isolateCaseProcessManager( argvWith( {} ), env, tmp ) ?? '';
		const kill = vi.fn( async () => undefined );
		const warn = vi.fn();
		expect(
			await stopCaseProcessManager( {
				home,
				processManagerHome: owners,
				kill,
				disconnect: async () => undefined,
				warn,
			} )
		).toBe( 'not-own' );
		expect( kill ).not.toHaveBeenCalled();
		expect( warn ).toHaveBeenCalledTimes( 1 );
		expect( fs.existsSync( owners ) ).toBe( true );

		expect(
			await stopCaseProcessManager( {
				home: null,
				processManagerHome: owners,
				kill,
				disconnect: async () => undefined,
				warn,
			} )
		).toBe( 'none' );
		expect( kill ).not.toHaveBeenCalled();
	} );
} );
