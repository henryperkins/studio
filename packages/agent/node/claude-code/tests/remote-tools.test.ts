import { mkdir, mkdtemp, realpath, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { readAuthToken } from '@studio/common/lib/shared-config';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePreview } from '../../tests/fake-host';
import { createStudioClaudeToolBridge } from '../tool-bridge';
import { createPolicyFixture } from './fixtures/execution-policy';

// The tools that look beyond the conversation's own site or reach WordPress.com,
// each driven through the real execution policy and the bridge the SDK calls,
// against a fake host whose operations are spies. Nothing here leaves the
// machine: the host's network members are spies, and the stored login is a
// test value in a configuration folder of this test's own.

const config = vi.hoisted( () => ( { root: '' } ) );

vi.mock( '@studio/common/lib/well-known-paths', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/common/lib/well-known-paths') >();
	const path = await import( 'path' );
	return {
		...actual,
		getConfigDirectory: () => config.root,
		getSharedConfigPath: () => path.join( config.root, 'shared.json' ),
		getAiPayloadsPath: () => path.join( config.root, 'tmp', 'ai-payloads' ),
	};
} );

const LOGIN = { accessToken: 'test-login-token', id: 7, expirationTime: Number.MAX_SAFE_INTEGER };

vi.mock( '@studio/common/lib/shared-config', async ( importOriginal ) => ( {
	...( await importOriginal< object >() ),
	readAuthToken: vi.fn(),
} ) );

beforeAll( async () => {
	config.root = await realpath(
		await mkdtemp( path.join( os.tmpdir(), 'studio-claude-config-' ) )
	);
	await mkdir( path.join( config.root, 'tmp', 'ai-payloads' ), { recursive: true } );
} );
afterAll( () => rm( config.root, { recursive: true, force: true } ) );

beforeEach( () => {
	vi.mocked( readAuthToken )
		.mockReset()
		.mockResolvedValue( LOGIN as never );
} );

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

// A conversation without a site, as a global chat starts.
const global = ( paths: { parent: string; config: string } ) => ( {
	target: { environment: 'global' as const },
	targetSite: undefined,
	workspace: { siteId: null, workingDirectory: paths.parent, configDirectory: paths.config },
	localRoots: [ paths.parent ],
} );

const text = ( result: { content: Array< { type: string; text?: string } > } ) =>
	result.content.map( ( part ) => part.text ?? '' ).join( '\n' );

describe( 'site_list on the Claude route', () => {
	// What the CLI's `site list` gives of a site, admin account and mail folder included.
	const entry = ( name: string, sitePath: string ) => ( {
		id: `${ name }-id`,
		name,
		path: sitePath,
		port: 8881,
		url: 'http://localhost:8881',
		phpVersion: '8.4',
		running: true,
		adminUsername: 'admin',
		adminEmail: 'admin@example.test',
		emailPath: path.join( sitePath, 'mail' ),
		customDomain: 'custom.example.test',
		enableDebugLog: true,
	} );

	it( 'lists, in a conversation without a site, every local site with the fields every site has and the WordPress.com sites the stored login reaches, unprompted and unjournaled', async () => {
		const { bridge, host, context, journal, site, other } = await setup( global );
		vi.mocked( host.sites.list ).mockResolvedValue( [
			entry( 'Site', site ),
			entry( 'Other', other ),
		] );
		vi.mocked( host.wpcom.sites ).mockResolvedValue( [
			{ id: 1001, name: 'Remote', url: 'https://remote.example.test' },
		] );
		expect( bridge.tools ).toContain( 'site_list' );
		const result = await bridge.invoke( 'site_list', {} );
		expect( result.isError ).toBe( false );
		const listed = JSON.parse( text( result ) );
		expect( listed.local ).toEqual(
			[
				[ 'Site', site ],
				[ 'Other', other ],
			].map( ( [ name, sitePath ] ) => ( {
				id: `${ name }-id`,
				name,
				path: sitePath,
				port: 8881,
				url: 'http://localhost:8881',
				phpVersion: '8.4',
				running: true,
			} ) )
		);
		expect( listed.wordpressCom ).toEqual( {
			signedIn: true,
			sites: [ { id: 1001, name: 'Remote', url: 'https://remote.example.test' } ],
		} );
		expect( host.wpcom.sites ).toHaveBeenCalledWith( LOGIN.accessToken );
		expect( text( result ) ).not.toContain( 'admin@example.test' );
		expect( text( result ) ).not.toContain( LOGIN.accessToken );
		expect( context.approve ).not.toHaveBeenCalled();
		expect( journal ).toEqual( [] );
	} );

	it( 'says the user is not signed in to WordPress.com without asking it anything', async () => {
		const { bridge, host } = await setup( global );
		vi.mocked( readAuthToken ).mockResolvedValue( null );
		const result = await bridge.invoke( 'site_list', {} );
		expect( result.isError ).toBe( false );
		expect( JSON.parse( text( result ) ).wordpressCom ).toEqual( { signedIn: false, sites: [] } );
		expect( host.wpcom.sites ).not.toHaveBeenCalled();
	} );

	it( 'lists nothing in a conversation that has its site, says why, and reads nothing first', async () => {
		const onSite = await setup();
		const globalOnSite = await setup( ( paths ) => ( {
			...global( paths ),
			target: { environment: 'local' as const, siteId: 'site-123' },
			targetSite: { id: 'site-123', path: paths.site, url: 'http://localhost:8888' },
		} ) );
		for ( const { bridge, host, journal } of [ onSite, globalOnSite ] ) {
			const result = await bridge.invoke( 'site_list', {} );
			expect( result.isError ).toBe( true );
			expect( text( result ) ).toContain(
				'Studio runs this tool only in a conversation without a site'
			);
			expect( host.sites.list ).not.toHaveBeenCalled();
			expect( host.wpcom.sites ).not.toHaveBeenCalled();
			expect( journal ).toEqual( [] );
		}
		expect( readAuthToken ).not.toHaveBeenCalled();
	} );

	it( 'reads no stored login that lies in a folder the turn reaches', async () => {
		const { bridge, host } = await setup( ( paths ) => ( {
			...global( paths ),
			localRoots: [ paths.parent, config.root ],
		} ) );
		expect( ( await bridge.invoke( 'site_list', {} ) ).isError ).toBe( true );
		expect( readAuthToken ).not.toHaveBeenCalled();
		expect( host.sites.list ).not.toHaveBeenCalled();
	} );
} );

describe( 'the listings the guarded host gives', () => {
	it( 'lists every site and the account’s WordPress.com sites only in a conversation without a site, while the call lives', async () => {
		const { policy, host } = await setup( global );
		const call = new AbortController();
		const guarded = policy.guardHost( host, 'call', call.signal );
		await expect( guarded.sites.list() ).resolves.toEqual( [] );
		await expect( guarded.wpcom.sites( LOGIN.accessToken ) ).resolves.toEqual( [] );
		call.abort();
		await expect( guarded.sites.list() ).rejects.toThrow( 'Denied' );
		await expect( guarded.wpcom.sites( LOGIN.accessToken ) ).rejects.toThrow( 'Denied' );
		expect( host.sites.list ).toHaveBeenCalledOnce();
		expect( host.wpcom.sites ).toHaveBeenCalledOnce();
	} );

	it( 'lists nothing in a conversation that has its site, or for a turn whose target changed, and never every site’s full details', async () => {
		const onSite = await setup();
		const guarded = onSite.policy.guardHost( onSite.host, 'call' );
		await expect( guarded.sites.list() ).rejects.toThrow( 'Denied' );
		await expect( guarded.wpcom.sites( LOGIN.accessToken ) ).rejects.toThrow( 'Denied' );
		const moved = await setup( global );
		vi.mocked( moved.context.verifyTarget ).mockResolvedValue( false );
		const stale = moved.policy.guardHost( moved.host, 'call' );
		await expect( stale.sites.list() ).rejects.toThrow( 'Denied' );
		await expect( stale.wpcom.sites( LOGIN.accessToken ) ).rejects.toThrow( 'Denied' );
		const unbound = await setup( global );
		await expect( unbound.policy.guardHost( unbound.host, 'call' ).sites.all() ).rejects.toThrow(
			'Denied'
		);
		for ( const { host } of [ onSite, moved, unbound ] ) {
			expect( host.sites.list ).not.toHaveBeenCalled();
			expect( host.wpcom.sites ).not.toHaveBeenCalled();
			expect( host.sites.all ).not.toHaveBeenCalled();
		}
	} );
} );

describe( 'preview_list on the Claude route', () => {
	it( 'lists the previews of the conversation’s own site, unprompted and unjournaled', async () => {
		const { bridge, host, context, journal, localSite } = await setup();
		vi.mocked( host.previews.list ).mockResolvedValue( [ fakePreview ] );
		expect( bridge.tools ).toContain( 'preview_list' );
		const result = await bridge.invoke( 'preview_list', { nameOrPath: 'site' } );
		expect( result.isError ).toBe( false );
		expect( JSON.parse( text( result ) ) ).toEqual( [
			expect.objectContaining( { type: 'preview', url: `https://${ fakePreview.url }` } ),
		] );
		expect( host.previews.list ).toHaveBeenCalledWith( localSite );
		expect( context.approve ).not.toHaveBeenCalled();
		expect( journal ).toEqual( [] );
	} );

	it( 'lists no other site’s previews, and none from a conversation without a site', async () => {
		const onSite = await setup();
		expect(
			( await onSite.bridge.invoke( 'preview_list', { nameOrPath: 'other' } ) ).isError
		).toBe( true );
		const unbound = await setup( global );
		expect(
			( await unbound.bridge.invoke( 'preview_list', { nameOrPath: 'site' } ) ).isError
		).toBe( true );
		for ( const { host } of [ onSite, unbound ] )
			expect( host.previews.list ).not.toHaveBeenCalled();
	} );

	it( 'reads, through the guarded host, the previews of the target site only, and none once the call has ended or the target moved', async () => {
		const { policy, host, localSite, otherSite, context } = await setup();
		const call = new AbortController();
		const guarded = policy.guardHost( host, 'call', call.signal );
		await expect( guarded.previews.list( localSite ) ).resolves.toEqual( [] );
		await expect( guarded.previews.list( otherSite ) ).rejects.toThrow( 'Denied' );
		call.abort();
		await expect( guarded.previews.list( localSite ) ).rejects.toThrow( 'Denied' );
		vi.mocked( context.verifyTarget ).mockResolvedValue( false );
		await expect( policy.guardHost( host, 'later' ).previews.list( localSite ) ).rejects.toThrow(
			'Denied'
		);
		expect( host.previews.list ).toHaveBeenCalledOnce();
	} );
} );
