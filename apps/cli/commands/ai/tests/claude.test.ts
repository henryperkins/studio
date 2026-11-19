// @vitest-environment node
import {
	getClaudeModelCatalog,
	createClaudeSession,
	recoverClaudeSession,
} from '@studio/agent/node/claude-code/studio-surface';
import { afterEach, describe, expect, it, vi } from 'vitest';
import yargs from 'yargs';
import { registerCommand } from '../claude';
import type { StudioArgv } from 'cli/types';

vi.mock( '@studio/agent/node/claude-code/studio-surface', () => ( {
	configureClaudeRuntime: vi.fn(),
	createClaudeSession: vi.fn(),
	getClaudeModelCatalog: vi.fn(),
	getClaudeRuntimeState: vi.fn(),
	setClaudeSessionSelection: vi.fn(),
	recoverClaudeSession: vi.fn(),
} ) );

async function run( args: string[] ) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	vi.spyOn( process.stdout, 'write' ).mockImplementation( ( chunk ) => {
		stdout.push( String( chunk ) );
		return true;
	} );
	vi.spyOn( process.stderr, 'write' ).mockImplementation( ( chunk ) => {
		stderr.push( String( chunk ) );
		return true;
	} );
	const exit = vi.spyOn( process, 'exit' ).mockImplementation( () => {
		throw new Error( 'process.exit was called' );
	} );
	const argv = yargs().exitProcess( false ).fail( false ) as unknown as StudioArgv;
	registerCommand( argv );
	let error: unknown;
	try {
		await argv.parseAsync( args );
	} catch ( thrown ) {
		error = thrown;
	} finally {
		vi.restoreAllMocks();
	}
	expect( exit ).not.toHaveBeenCalled();
	return { stdout: stdout.join( '' ), stderr: stderr.join( '' ), error };
}

it( 'uses the global workspace without --site and keeps an explicit local site', async () => {
	vi.mocked( getClaudeModelCatalog ).mockResolvedValue( { ok: true, models: [] } );
	expect( ( await run( [ 'claude', 'models', '--connection=account' ] ) ).error ).toBeUndefined();
	expect( getClaudeModelCatalog ).toHaveBeenCalledWith( 'account', undefined );
	expect(
		( await run( [ 'claude', 'models', '--connection=account', '--site=local' ] ) ).error
	).toBeUndefined();
	expect( getClaudeModelCatalog ).toHaveBeenCalledWith( 'account', 'local' );
	expect(
		(
			await run( [
				'claude',
				'new',
				'--connection=account',
				'--model=claude-model',
				'--effort=high',
			] )
		).error
	).toBeUndefined();
	expect( createClaudeSession ).toHaveBeenCalledWith( expect.any( String ), {
		connectionId: 'account',
		siteId: undefined,
		selection: { model: 'claude-model', effort: 'high' },
	} );
} );

describe( 'studio code claude recover', () => {
	afterEach( () => {
		process.exitCode = undefined;
	} );

	it( 'recovers the session and prints the result as JSON, with a zero exit status', async () => {
		const result = {
			status: 'recovered' as const,
			runId: 'run',
			turnId: 'turn',
			recordedTerminal: true,
			invalidatedApprovals: [ 'request' ],
			uncertainOperations: [],
		};
		vi.mocked( recoverClaudeSession ).mockResolvedValue( result );
		const { stdout, stderr, error } = await run( [ 'claude', 'recover', '--session', 'abc' ] );
		expect( error ).toBeUndefined();
		expect( recoverClaudeSession ).toHaveBeenCalledWith( 'abc' );
		expect( JSON.parse( stdout ) ).toEqual( result );
		expect( stderr ).toBe( '' );
		expect( process.exitCode ).toBeFalsy();
	} );

	it( 'prints a blocked result as JSON, says why on stderr and exits non-zero without calling exit', async () => {
		vi.mocked( recoverClaudeSession ).mockResolvedValue( {
			status: 'blocked',
			reason: 'owner-alive',
			runId: 'run',
			turnId: 'turn',
		} );
		const { stdout, stderr, error } = await run( [ 'claude', 'recover', '--session', 'abc' ] );
		expect( error ).toBeUndefined();
		expect( JSON.parse( stdout ) ).toEqual( {
			status: 'blocked',
			reason: 'owner-alive',
			runId: 'run',
			turnId: 'turn',
		} );
		expect( stderr ).toContain( 'still running' );
		expect( process.exitCode ).toBe( 1 );
	} );

	it( 'says on stderr what to do next: wait for the other app, or follow the manual procedure', async () => {
		vi.mocked( recoverClaudeSession ).mockResolvedValue( {
			status: 'blocked',
			reason: 'owner-alive',
		} );
		expect( ( await run( [ 'claude', 'recover', '--session', 'abc' ] ) ).stderr ).toMatch(
			/wait/i
		);
		vi.mocked( recoverClaudeSession ).mockResolvedValue( {
			status: 'blocked',
			reason: 'legacy-lock',
		} );
		const legacy = await run( [ 'claude', 'recover', '--session', 'abc' ] );
		expect( legacy.stderr ).toContain( 'docs/design-docs/claude-code-recovery.md' );
		expect( JSON.parse( legacy.stdout ) ).toEqual( { status: 'blocked', reason: 'legacy-lock' } );
		expect( process.exitCode ).toBe( 1 );
	} );

	it( 'requires a session and recovers nothing without one', async () => {
		const { error } = await run( [ 'claude', 'recover' ] );
		expect( String( error ) ).toContain( '--session is required.' );
		expect( recoverClaudeSession ).not.toHaveBeenCalled();
	} );
} );
