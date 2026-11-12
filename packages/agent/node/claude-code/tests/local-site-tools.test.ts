import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeSite } from '../../tests/fake-host';
import { createStudioClaudeToolBridge } from '../tool-bridge';
import { createPolicyFixture } from './fixtures/execution-policy';

// The local site tools qualified for the Claude route, each driven through the
// real execution policy and the bridge the SDK calls, against a fake host
// whose operations are spies.

const cleanups: Array< () => Promise< void > > = [];
afterEach( async () => {
	await Promise.all( cleanups.splice( 0 ).map( ( cleanup ) => cleanup() ) );
} );

async function setup( ...args: Parameters< typeof createPolicyFixture > ) {
	const fixture = await createPolicyFixture( ...args );
	cleanups.push( fixture.cleanup );
	const bridge = createStudioClaudeToolBridge(
		fixture.host,
		{ runId: 'run', turnId: 'turn', policy: fixture.policy },
		() => {}
	);
	cleanups.push( () => bridge.dispose() );
	return { ...fixture, bridge };
}

const text = ( result: { content: Array< { type: string; text?: string } > } ) =>
	result.content.map( ( part ) => part.text ?? '' ).join( '\n' );

describe( 'site_info on the Claude route', () => {
	it( 'reads the status of the conversation’s own site, unprompted and unjournaled', async () => {
		const { bridge, host, context, journal, localSite } = await setup();
		expect( bridge.tools ).toContain( 'site_info' );
		const result = await bridge.invoke( 'site_info', { nameOrPath: 'site' } );
		expect( result.isError ).toBe( false );
		expect( JSON.parse( text( result ) ) ).toMatchObject( { emailPath: '/email/site-123' } );
		expect( host.sites.status ).toHaveBeenCalledWith( localSite );
		expect( context.approve ).not.toHaveBeenCalled();
		expect( journal ).toEqual( [] );
	} );

	it( 'reads no other site', async () => {
		const { bridge, host } = await setup();
		expect( ( await bridge.invoke( 'site_info', { nameOrPath: 'other' } ) ).isError ).toBe( true );
		expect( host.sites.status ).not.toHaveBeenCalled();
	} );
} );

describe( 'the host members a qualified tool reads through', () => {
	it( 'reads the status of the target site only, and nothing once the call has ended', async () => {
		const { policy, host, otherSite, localSite } = await setup();
		const call = new AbortController();
		const guarded = policy.guardHost( host, 'call', call.signal );
		await expect( guarded.sites.status( localSite ) ).resolves.toMatchObject( {
			adminUsername: 'admin',
		} );
		await expect( guarded.sites.isRunning( localSite ) ).resolves.toBe( true );
		await expect( guarded.sites.status( otherSite ) ).rejects.toThrow( 'Denied' );
		await expect( guarded.sites.isRunning( otherSite ) ).rejects.toThrow( 'Denied' );
		await expect(
			guarded.sites.status( { ...fakeSite, path: localSite.path, id: 'forged' } )
		).rejects.toThrow( 'Denied' );
		call.abort();
		await expect( guarded.sites.status( localSite ) ).rejects.toThrow( 'Denied' );
		await expect( guarded.sites.isRunning( localSite ) ).rejects.toThrow( 'Denied' );
		expect( host.sites.status ).toHaveBeenCalledOnce();
		expect( host.sites.isRunning ).toHaveBeenCalledOnce();
	} );

	it( 'reads nothing for a turn whose target or connection changed', async () => {
		const { policy, host, context, localSite } = await setup();
		vi.mocked( context.verifyTarget ).mockResolvedValue( false );
		await expect( policy.guardHost( host, 'call' ).sites.status( localSite ) ).rejects.toThrow(
			'Denied'
		);
		expect( host.sites.status ).not.toHaveBeenCalled();
	} );

	it( 'refuses every member no qualified tool needs: every site, WordPress.com and analytics', async () => {
		const { policy, host } = await setup();
		const guarded = policy.guardHost( host, 'call' );
		await expect( guarded.sites.all() ).rejects.toThrow( 'Denied' );
		await expect( guarded.sites.list() ).rejects.toThrow( 'Denied' );
		await expect( guarded.wpcom.sites( 'token' ) ).rejects.toThrow( 'Denied' );
		await expect( guarded.tracks.record( 'studio_agent_x' as never, {} ) ).rejects.toThrow(
			'Denied'
		);
		expect( host.sites.all ).not.toHaveBeenCalled();
		expect( host.sites.list ).not.toHaveBeenCalled();
		expect( host.wpcom.sites ).not.toHaveBeenCalled();
		expect( host.tracks.record ).not.toHaveBeenCalled();
	} );
} );
