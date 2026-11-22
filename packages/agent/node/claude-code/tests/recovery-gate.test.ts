import { writeFile } from 'fs/promises';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoveryNote } from '../runtime';
import { admitWpCliRead, createPolicyFixture } from './fixtures/execution-policy';
import type { ClaudeJournalEvent } from '@studio/agent/protocol/backend-events';

// The first turn after a recovery that left operations uncertain asks before
// anything that normally runs unprompted but does more than read, saying an
// interrupted attempt may already have taken effect.

const cleanups: Array< () => Promise< void > > = [];
afterEach( async () => {
	await Promise.all( cleanups.splice( 0 ).map( ( cleanup ) => cleanup() ) );
} );

async function setup( uncertainAfterRecovery: boolean, answer: 'allow' | 'deny' = 'allow' ) {
	const fixture = await createPolicyFixture( () => ( {
		enabledTools: { native: [ 'Read', 'Write' ], studio: [ 'wp_cli' ] },
		uncertainAfterRecovery,
		approve: vi.fn( async () => answer ),
	} ) );
	cleanups.push( fixture.cleanup );
	await writeFile( path.join( fixture.site, 'readme.txt' ), 'fixture' );
	return fixture;
}

const NOTICE = 'may already have taken effect';

describe( 'the approval gate after a recovery with uncertain operations', () => {
	it( 'asks once before an unprompted change, saying an interrupted attempt may already have taken effect', async () => {
		const { policy, host, context, localSite, journal, site } = await setup( true );
		await policy.guardHost( host, 'start' ).sites.start( localSite, () => {} );
		expect( host.sites.start ).toHaveBeenCalledOnce();
		expect(
			await policy.authorizeToolUse( {
				toolName: 'Write',
				input: { file_path: path.join( site, 'readme.txt' ), content: 'x' },
				toolUseId: 'write',
			} )
		).toBe( true );
		const requests = vi.mocked( context.approve ).mock.calls.map( ( [ request ] ) => request );
		expect( requests.map( ( request ) => request.operation.tool ) ).toEqual( [
			'sites.start',
			'Write',
		] );
		for ( const request of requests ) {
			expect( request.operation.operationClass ).toBe( 'local-change' );
			expect( request.operation.description ).toContain( NOTICE );
		}
		// Each approval is used once, for its operation, and is named in the journal.
		expect( journal.map( ( entry ) => entry.requestId ) ).toEqual(
			requests.map( ( request ) => request.requestId )
		);
		await policy.guardHost( host, 'again' ).sites.start( localSite, () => {} );
		expect( context.approve ).toHaveBeenCalledTimes( 3 );
	} );

	it( 'leaves reads unprompted', async () => {
		const { policy, host, context, localSite, site } = await setup( true );
		await admitWpCliRead( policy, host, 'read' );
		await policy
			.guardHost( host, 'read' )
			.sites.wpCli( localSite, [ 'option', 'get', 'blogname' ] );
		expect(
			await policy.authorizeToolUse( {
				toolName: 'Read',
				input: { file_path: path.join( site, 'readme.txt' ) },
				toolUseId: 'read',
			} )
		).toBe( true );
		expect( context.approve ).not.toHaveBeenCalled();
	} );

	it( 'does not ask in a turn without the note', async () => {
		const { policy, host, context, localSite, journal } = await setup( false );
		await policy.guardHost( host, 'start' ).sites.start( localSite, () => {} );
		expect( host.sites.start ).toHaveBeenCalledOnce();
		expect( context.approve ).not.toHaveBeenCalled();
		expect( journal ).toHaveLength( 1 );
		expect( journal[ 0 ].description ).not.toContain( NOTICE );
	} );

	it( 'refuses the change when the user denies it, and journals nothing for it', async () => {
		const { policy, host, context, localSite, journal } = await setup( true, 'deny' );
		await expect(
			policy.guardHost( host, 'start' ).sites.start( localSite, () => {} )
		).rejects.toThrow( 'Denied' );
		expect( context.approve ).toHaveBeenCalledOnce();
		expect( host.sites.start ).not.toHaveBeenCalled();
		expect( journal ).toEqual( [] );
	} );
} );

describe( 'the recovery note a turn carries', () => {
	const recovered = ( uncertainOperations: unknown[] ): ClaudeJournalEvent =>
		( {
			type: 'turn.recovered',
			runId: 'dead',
			turnId: 'dead',
			lock: 'lock',
			invalidatedApprovals: [],
			uncertainOperations,
		} ) as unknown as ClaudeJournalEvent;

	it( 'gates the turn only when the interrupted turn left an operation uncertain', () => {
		const uncertain = recoveryNote( [
			[ recovered( [ { tool: 'sites.start', description: 'Change local work: sites.start' } ] ) ],
		] );
		expect( uncertain?.uncertain ).toBe( true );
		const settled = recoveryNote( [ [ recovered( [] ) ] ] );
		expect( settled ).toBeDefined();
		expect( settled?.uncertain ).toBe( false );
		expect( recoveryNote( [] ) ).toBeUndefined();
	} );
} );
