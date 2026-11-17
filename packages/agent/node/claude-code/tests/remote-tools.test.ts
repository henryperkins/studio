import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises';
import { createServer } from 'http';
import os from 'os';
import path from 'path';
import { getConnectedWpcomSitesForLocalSite } from '@studio/common/lib/connected-sites';
import { getCurrentUserId, readAuthToken } from '@studio/common/lib/shared-config';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRemoteSite, fakePreview } from '../../tests/fake-host';
import { createStudioClaudeToolBridge } from '../tool-bridge';
import { createPolicyFixture } from './fixtures/execution-policy';
import type { AddressInfo } from 'net';

// The tools that look beyond the conversation's own site or reach WordPress.com,
// each driven through the real execution policy and the bridge the SDK calls,
// against a fake host whose operations are spies. Nothing here leaves the
// machine: the host's network members are spies, the stored login is a test
// value in a configuration folder of this test's own, and the real
// WordPress.com client sends every request a tool makes itself to a server on
// this machine instead of its default origin, as `wpcom-request-scope.test.ts`
// does, so the test sees exactly what the tool would send.

const config = vi.hoisted( () => ( { root: '' } ) );
const wpcom = vi.hoisted( () => ( {
	origin: '',
	received: [] as Array< { method: string; url: string; authorization?: string; body: string } >,
	respond: ( _url: string ): { status: number; body: unknown } => ( { status: 200, body: {} } ),
} ) );

vi.mock( '@studio/common/lib/wpcom-xhr-request-factory', async () => {
	const actual = await vi.importActual< {
		default: ( options: Record< string, unknown >, callback: unknown ) => unknown;
	} >( '@studio/common/lib/wpcom-xhr-request-factory' );
	return {
		default: ( options: Record< string, unknown >, callback: unknown ) =>
			actual.default(
				options.proxyOrigin === undefined ? { ...options, proxyOrigin: wpcom.origin } : options,
				callback
			),
	};
} );

vi.mock( '@studio/common/lib/connected-sites', () => ( {
	getConnectedWpcomSitesForLocalSite: vi.fn( async () => [] ),
} ) );

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
// Another WordPress.com login, to which the user switches mid-conversation.
const OTHER_LOGIN = { ...LOGIN, accessToken: 'other-login-token', id: 8 };

// The stored login, and its user id read from it, as Studio reads both.
vi.mock( '@studio/common/lib/shared-config', async ( importOriginal ) => ( {
	...( await importOriginal< object >() ),
	readAuthToken: vi.fn(),
	getCurrentUserId: vi.fn(),
} ) );

let stopServer: () => Promise< void >;
beforeAll( async () => {
	config.root = await realpath(
		await mkdtemp( path.join( os.tmpdir(), 'studio-claude-config-' ) )
	);
	await mkdir( path.join( config.root, 'tmp', 'ai-payloads' ), { recursive: true } );
	const server = createServer( ( request, response ) => {
		let body = '';
		request.on( 'data', ( chunk ) => ( body += chunk ) );
		request.on( 'end', () => {
			const url = request.url ?? '';
			wpcom.received.push( {
				method: request.method ?? '',
				url,
				authorization: request.headers.authorization,
				body,
			} );
			const answer = wpcom.respond( url );
			response.statusCode = answer.status;
			response.setHeader( 'content-type', 'application/json' );
			response.end( JSON.stringify( answer.body ) );
		} );
	} );
	await new Promise< void >( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
	wpcom.origin = `http://127.0.0.1:${ ( server.address() as AddressInfo ).port }`;
	stopServer = () => new Promise( ( resolve ) => server.close( () => resolve() ) );
} );
afterAll( async () => {
	await stopServer();
	await rm( config.root, { recursive: true, force: true } );
} );

beforeEach( () => {
	vi.mocked( readAuthToken )
		.mockReset()
		.mockResolvedValue( LOGIN as never );
	// Read from the same stored login, without counting as the tool's own read.
	vi.mocked( getCurrentUserId )
		.mockReset()
		.mockImplementation(
			async () => ( await vi.mocked( readAuthToken ).getMockImplementation()?.() )?.id ?? null
		);
	vi.mocked( getConnectedWpcomSitesForLocalSite ).mockReset().mockResolvedValue( [] );
	wpcom.received.length = 0;
	wpcom.respond = () => ( { status: 200, body: {} } );
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

// What Studio says when the WordPress.com login an operation was prepared
// under is no longer the one Studio is signed in with, or there is none.
const LOGIN_REFUSAL = 'only under the login it was signed in with when the operation was prepared';
// Switches the stored login to another account.
const switchLogin = () => vi.mocked( readAuthToken ).mockResolvedValue( OTHER_LOGIN as never );

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

type Fixture = Awaited< ReturnType< typeof setup > >;

// The order of the journal entries the policy writes and the host operations
// that then run, each spy keeping what it returned.
function journalOrder(
	fixture: Fixture,
	operations: Record< string, ( ...args: never[] ) => Promise< unknown > >
) {
	const order: string[] = [];
	const record = fixture.context.recordOperation;
	fixture.context.recordOperation = async ( event ) => {
		order.push( `journal ${ event.operation.tool }` );
		await record( event );
	};
	for ( const [ name, spy ] of Object.entries( operations ) ) {
		const result = vi.mocked( spy ).getMockImplementation();
		vi.mocked( spy ).mockImplementation( async ( ...args: never[] ) => {
			order.push( `host ${ name }` );
			return result?.( ...args );
		} );
	}
	return order;
}

// A preview of the conversation's own site, as the host lists that site's previews.
const own = { ...fakePreview };

describe( 'preview_create on the Claude route', () => {
	it( 'creates a preview of the conversation’s own site once the user approves it, saying that anyone with its public address can see the site’s content, journaled before the command', async () => {
		const fixture = await setup();
		const { bridge, host, context, journal, site, localSite } = fixture;
		const order = journalOrder( fixture, { 'previews.create': host.previews.create } );
		expect( bridge.tools ).toContain( 'preview_create' );
		const result = await bridge.invoke( 'preview_create', { nameOrPath: 'site' } );
		expect( result.isError ).toBe( false );
		expect( text( result ) ).toContain( own.url );
		expect( host.previews.create ).toHaveBeenCalledWith(
			localSite,
			expect.any( Function ),
			expect.objectContaining( { beforeSpawn: expect.any( Function ) } )
		);
		expect( context.approve ).toHaveBeenCalledOnce();
		const [ request ] = vi.mocked( context.approve ).mock.calls[ 0 ];
		expect( request.operation ).toMatchObject( {
			tool: 'previews.create',
			operationClass: 'remote-change',
			args: [],
			localPaths: [ site ],
			remote: 'A new preview site on WordPress.com',
		} );
		expect( request.operation.description ).toContain(
			'anyone with the preview’s public address can see'
		);
		expect( order ).toEqual( [
			'journal preview_create',
			'journal previews.create',
			'host previews.create',
		] );
		expect( journal[ 1 ] ).toMatchObject( { requestId: request.requestId } );
	} );

	it( 'previews no other site, nothing from a conversation without a site, and nothing the user denies', async () => {
		const onSite = await setup();
		const unbound = await setup( global );
		const denying = await setup( () => ( { approve: vi.fn( async () => 'deny' as const ) } ) );
		expect(
			( await onSite.bridge.invoke( 'preview_create', { nameOrPath: 'other' } ) ).isError
		).toBe( true );
		expect(
			( await unbound.bridge.invoke( 'preview_create', { nameOrPath: 'site' } ) ).isError
		).toBe( true );
		const denied = await denying.bridge.invoke( 'preview_create', { nameOrPath: 'site' } );
		expect( denied.isError ).toBe( true );
		expect( text( denied ) ).toContain( 'The user did not approve this operation' );
		expect( denying.journal.map( ( entry ) => entry.operation.tool ) ).not.toContain(
			'previews.create'
		);
		for ( const { host } of [ onSite, unbound, denying ] )
			expect( host.previews.create ).not.toHaveBeenCalled();
	} );

	it( 'writes the archive it sends only where the conversation cannot reach, checked again immediately before the command starts', async () => {
		const temporary = await realpath( os.tmpdir() );
		const reaching = await setup( ( paths ) => ( { localRoots: [ paths.site, temporary ] } ) );
		vi.mocked( reaching.host.previews.list ).mockResolvedValue( [ own ] );
		for ( const [ name, args ] of [
			[ 'preview_create', { nameOrPath: 'site' } ],
			[ 'preview_update', { nameOrPath: 'site', host: own.url } ],
		] as const ) {
			const refused = await reaching.bridge.invoke( name, args );
			expect( refused.isError, name ).toBe( true );
			expect( text( refused ), name ).toContain( 'the system’s temporary folder' );
		}
		expect( reaching.context.approve ).not.toHaveBeenCalled();
		expect( reaching.host.previews.create ).not.toHaveBeenCalled();
		expect( reaching.host.previews.update ).not.toHaveBeenCalled();
		// The conversation's target moves while the command is about to start.
		const moved = await setup();
		let ran = false;
		vi.mocked( moved.host.previews.create ).mockImplementation(
			async ( _site, _onProgress, options ) => {
				vi.mocked( moved.context.verifyTarget ).mockResolvedValue( false );
				await options?.beforeSpawn?.();
				ran = true;
				return own;
			}
		);
		expect(
			( await moved.bridge.invoke( 'preview_create', { nameOrPath: 'site' } ) ).isError
		).toBe( true );
		expect( ran ).toBe( false );
	} );
} );

describe( 'preview_update and preview_delete on the Claude route', () => {
	const PREVIEW_REFUSAL = 'one of this conversation’s site’s own previews';
	const ordered = ( fixture: Fixture ) =>
		journalOrder( fixture, {
			'previews.update': fixture.host.previews.update,
			'previews.delete': fixture.host.previews.delete,
		} );

	it( 'updates a preview of the conversation’s own site once the user approves it, showing the preview, the site’s folder and that anyone with its address can see it, journaled before the command', async () => {
		const fixture = await setup();
		const { bridge, host, context, journal, site, localSite } = fixture;
		vi.mocked( host.previews.list ).mockResolvedValue( [ own ] );
		const order = ordered( fixture );
		expect( bridge.tools ).toContain( 'preview_update' );
		const result = await bridge.invoke( 'preview_update', {
			nameOrPath: 'site',
			host: 'https://Demo.wp.build/',
		} );
		expect( result.isError ).toBe( false );
		expect( host.previews.update ).toHaveBeenCalledWith(
			localSite,
			own.url,
			false,
			expect.any( Function ),
			expect.objectContaining( { beforeSpawn: expect.any( Function ) } )
		);
		expect( context.approve ).toHaveBeenCalledOnce();
		const [ request ] = vi.mocked( context.approve ).mock.calls[ 0 ];
		expect( request.operation ).toMatchObject( {
			tool: 'previews.update',
			operationClass: 'remote-overwrite',
			args: [ own.url ],
			localPaths: [ site ],
			remote: own.url,
		} );
		expect( request.operation.description ).toContain( 'anyone with the preview’s public address' );
		expect( order ).toEqual( [
			'journal preview_update',
			'journal previews.update',
			'host previews.update',
		] );
		expect( journal[ 1 ] ).toMatchObject( { requestId: request.requestId } );
	} );

	it( 'deletes a preview of the conversation’s own site once the user approves it, showing the preview, journaled before the command', async () => {
		const fixture = await setup();
		const { bridge, host, context, journal } = fixture;
		vi.mocked( host.previews.list ).mockResolvedValue( [ own ] );
		const order = ordered( fixture );
		expect( bridge.tools ).toContain( 'preview_delete' );
		const result = await bridge.invoke( 'preview_delete', { host: own.url } );
		expect( result.isError ).toBe( false );
		expect( host.previews.delete ).toHaveBeenCalledWith(
			own.url,
			expect.any( Function ),
			expect.objectContaining( { beforeSpawn: expect.any( Function ) } )
		);
		const [ request ] = vi.mocked( context.approve ).mock.calls[ 0 ];
		expect( request.operation ).toMatchObject( {
			tool: 'previews.delete',
			operationClass: 'remote-overwrite',
			args: [ own.url ],
			localPaths: [],
			remote: own.url,
		} );
		expect( order ).toEqual( [
			'journal preview_delete',
			'journal previews.delete',
			'host previews.delete',
		] );
		expect( journal[ 1 ] ).toMatchObject( { requestId: request.requestId } );
	} );

	it( 'updates or deletes no preview but the conversation’s site’s own, from no conversation without a site, and never from another site, says why and asks nothing', async () => {
		const onSite = await setup();
		const unbound = await setup( global );
		// What the host lists for the conversation's site: its own preview, one
		// whose record names another site, and two records of one address.
		const foreign = { ...fakePreview, url: 'foreign.wp.build', localSiteId: 'other-site' };
		const twice = { ...fakePreview, url: 'twice.wp.build', atomicSiteId: 1 };
		for ( const { host } of [ onSite, unbound ] )
			vi.mocked( host.previews.list ).mockResolvedValue( [
				own,
				foreign,
				twice,
				{ ...twice, atomicSiteId: 2 },
			] );
		const calls: Array< [ typeof onSite, string, Record< string, unknown > ] > = [
			[ onSite, 'preview_delete', { host: 'elsewhere.wp.build' } ],
			[ onSite, 'preview_delete', { host: foreign.url } ],
			[ onSite, 'preview_delete', { host: twice.url } ],
			[ onSite, 'preview_update', { nameOrPath: 'site', host: 'elsewhere.wp.build' } ],
			[ onSite, 'preview_update', { nameOrPath: 'site', host: foreign.url } ],
			[ unbound, 'preview_delete', { host: own.url } ],
		];
		for ( const [ fixture, name, args ] of calls ) {
			const result = await fixture.bridge.invoke( name, args );
			expect( result.isError, `${ name } ${ JSON.stringify( args ) }` ).toBe( true );
			expect( text( result ), `${ name } ${ JSON.stringify( args ) }` ).toContain(
				PREVIEW_REFUSAL
			);
		}
		const overwrite = await onSite.bridge.invoke( 'preview_update', {
			nameOrPath: 'site',
			host: own.url,
			overwrite: true,
		} );
		expect( overwrite.isError ).toBe( true );
		expect( text( overwrite ) ).toContain( 'only from the site it was made from' );
		expect(
			( await onSite.bridge.invoke( 'preview_update', { nameOrPath: 'other', host: own.url } ) )
				.isError
		).toBe( true );
		for ( const { host, context } of [ onSite, unbound ] ) {
			expect( context.approve ).not.toHaveBeenCalled();
			expect( host.previews.update ).not.toHaveBeenCalled();
			expect( host.previews.delete ).not.toHaveBeenCalled();
		}
	} );

	it( 'checks the preview again once the user has answered and immediately before the command starts, so a preview that changed meanwhile is left alone', async () => {
		// Answered: the address now names another preview.
		const answered = await setup();
		vi.mocked( answered.host.previews.list ).mockResolvedValue( [ own ] );
		vi.mocked( answered.context.approve ).mockImplementationOnce( async () => {
			vi.mocked( answered.host.previews.list ).mockResolvedValue( [
				{ ...own, atomicSiteId: 999 },
			] );
			return 'allow';
		} );
		const afterAnswer = await answered.bridge.invoke( 'preview_delete', { host: own.url } );
		expect( afterAnswer.isError ).toBe( true );
		expect( answered.host.previews.delete ).not.toHaveBeenCalled();
		// Started: the preview is gone when the command's own fence runs.
		const started = await setup();
		vi.mocked( started.host.previews.list ).mockResolvedValue( [ own ] );
		let ran = false;
		vi.mocked( started.host.previews.update ).mockImplementation(
			async ( _site, _hostname, _overwrite, _onProgress, options ) => {
				vi.mocked( started.host.previews.list ).mockResolvedValue( [] );
				await options?.beforeSpawn?.();
				ran = true;
				return own;
			}
		);
		const beforeStart = await started.bridge.invoke( 'preview_update', {
			nameOrPath: 'site',
			host: own.url,
		} );
		expect( beforeStart.isError ).toBe( true );
		expect( ran ).toBe( false );
	} );

	it( 'reaches, through the guarded host, only a preview of the target site, and only while the call lives', async () => {
		const { policy, host, localSite, otherSite } = await setup();
		vi.mocked( host.previews.list ).mockResolvedValue( [ own ] );
		const call = new AbortController();
		const guarded = policy.guardHost( host, 'call', call.signal );
		await expect( guarded.previews.delete( 'elsewhere.wp.build', () => {} ) ).rejects.toThrow(
			'Denied'
		);
		await expect( guarded.previews.update( otherSite, own.url, false, () => {} ) ).rejects.toThrow(
			'Denied'
		);
		await expect( guarded.previews.delete( own.url, () => {} ) ).resolves.toBeUndefined();
		call.abort();
		await expect( guarded.previews.update( localSite, own.url, false, () => {} ) ).rejects.toThrow(
			'Denied'
		);
		expect( host.previews.delete ).toHaveBeenCalledOnce();
		expect( host.previews.update ).not.toHaveBeenCalled();
	} );
} );

// The conversation's site is connected to `fakeRemoteSite` (111), and a
// staging copy of it (112); another local site is connected to 333.
const connections = [
	fakeRemoteSite,
	{
		...fakeRemoteSite,
		id: 112,
		name: 'Staging',
		url: 'https://staging.example.test',
		isStaging: true,
	},
	{ ...fakeRemoteSite, id: 333, localSiteId: 'other-site', url: 'https://other.example.test' },
];
// What an approval shows of each of the conversation's site's connections.
const PRODUCTION = {
	id: 111,
	name: 'My Production Site',
	address: 'myprod.wordpress.com',
	kind: 'production',
};
const PRODUCTION_LABEL =
	'WordPress.com site 111: My Production Site, myprod.wordpress.com, a production site';
const REMOTE_REFUSAL = 'only when it is connected to this conversation’s site';
const OPTIONS_REFUSAL = 'only with options from this list';

describe( 'site_push on the Claude route', () => {
	it( 'pushes the conversation’s site to one of its connected WordPress.com sites, named by its address, once the user approves it, showing the direction, the site and what it overwrites there, journaled before the command', async () => {
		const fixture = await setup();
		const { bridge, host, context, journal, events, site, localSite } = fixture;
		vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( connections );
		const order = journalOrder( fixture, { 'sync.push': host.sync.push } );
		expect( bridge.tools ).toContain( 'site_push' );
		const result = await bridge.invoke( 'site_push', {
			nameOrPath: 'site',
			remoteSite: 'https://MyProd.wordpress.com/',
			options: 'sqls, plugins',
		} );
		expect( result.isError ).toBe( false );
		expect( getConnectedWpcomSitesForLocalSite ).toHaveBeenCalledWith( 'site-123' );
		expect( host.sync.push ).toHaveBeenCalledWith(
			localSite,
			'sqls,plugins',
			'111',
			expect.any( Function ),
			expect.objectContaining( { beforeSpawn: expect.any( Function ) } )
		);
		expect( context.approve ).toHaveBeenCalledOnce();
		const [ request ] = vi.mocked( context.approve ).mock.calls[ 0 ];
		expect( request.operation ).toMatchObject( {
			tool: 'sync.push',
			operationClass: 'remote-overwrite',
			args: [
				{
					direction: 'push',
					remoteSite: PRODUCTION,
					overwrites: [ 'the database', 'the plugins' ],
				},
			],
			localPaths: [ site ],
			remote: PRODUCTION_LABEL,
		} );
		expect( request.operation.description ).toContain(
			'replaces what overwrites names on that site'
		);
		expect( order ).toEqual( [ 'journal site_push', 'journal sync.push', 'host sync.push' ] );
		expect( journal[ 1 ] ).toMatchObject( { requestId: request.requestId } );
		expect( JSON.stringify( [ journal, events ] ) ).not.toContain( LOGIN.accessToken );
	} );

	it( 'pushes, in a conversation on the live site, to that site by its ID, everything by default', async () => {
		const { bridge, host, context } = await setup( () => ( {
			target: { environment: 'live' as const, siteId: 'site-123', wpcomSiteId: 111 },
		} ) );
		vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( connections );
		const result = await bridge.invoke( 'site_push', { nameOrPath: 'site', remoteSite: '111' } );
		expect( result.isError ).toBe( false );
		expect( host.sync.push ).toHaveBeenCalledWith(
			expect.objectContaining( { id: 'site-123' } ),
			'all',
			'111',
			expect.any( Function ),
			expect.anything()
		);
		expect( vi.mocked( context.approve ).mock.calls[ 0 ][ 0 ].operation.args ).toEqual( [
			{
				direction: 'push',
				remoteSite: PRODUCTION,
				overwrites: [ 'the database and every file in wp-content' ],
			},
		] );
	} );

	it( 'pushes to no site but a connected one of the conversation’s site, decided by its ID, nor from a conversation without a site, says why and asks nothing', async () => {
		const onSite = await setup();
		const onLive = await setup( () => ( {
			target: { environment: 'live' as const, siteId: 'site-123', wpcomSiteId: 112 },
		} ) );
		const unbound = await setup( global );
		vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( [
			...connections,
			// Two connections at one address.
			{ ...fakeRemoteSite, id: 113, url: 'https://twice.example.test' },
			{ ...fakeRemoteSite, id: 114, url: 'https://twice.example.test' },
		] );
		const calls: Array< [ Fixture, unknown ] > = [
			[ onSite, '222' ],
			[ onSite, 'https://unconnected.example.test' ],
			[ onSite, '333' ],
			[ onSite, 'https://other.example.test' ],
			[ onSite, 'https://twice.example.test' ],
			[ onSite, '0x6f' ],
			[ onSite, '111.0' ],
			[ onLive, '111' ],
		];
		for ( const [ fixture, remoteSite ] of calls ) {
			const result = await fixture.bridge.invoke( 'site_push', { nameOrPath: 'site', remoteSite } );
			expect( result.isError, String( remoteSite ) ).toBe( true );
			expect( text( result ), String( remoteSite ) ).toContain( REMOTE_REFUSAL );
		}
		// The site a call names is refused before any remote is judged.
		expect(
			( await onSite.bridge.invoke( 'site_push', { nameOrPath: 'other', remoteSite: '333' } ) )
				.isError
		).toBe( true );
		expect(
			( await unbound.bridge.invoke( 'site_push', { nameOrPath: 'site', remoteSite: '111' } ) )
				.isError
		).toBe( true );
		for ( const { host, context } of [ onSite, onLive, unbound ] ) {
			expect( context.approve ).not.toHaveBeenCalled();
			expect( host.sync.push ).not.toHaveBeenCalled();
		}
	} );

	it( 'takes only the options the command takes, as the tool describes them, each once, and no remote picked for it', async () => {
		const { bridge, host, policy, localSite, context } = await setup();
		vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( connections );
		for ( const options of [ 'paths', 'all,sqls', 'sqls,sqls', '', ' , ', 'everything', 'SQLS' ] ) {
			const result = await bridge.invoke( 'site_push', {
				nameOrPath: 'site',
				remoteSite: '111',
				options,
			} );
			expect( result.isError, options ).toBe( true );
			expect( text( result ), options ).toContain( OPTIONS_REFUSAL );
		}
		await expect(
			policy.guardHost( host, 'picker' ).sync.push( localSite, 'all', undefined, () => {} )
		).rejects.toThrow( 'Denied' );
		expect( context.approve ).not.toHaveBeenCalled();
		expect( host.sync.push ).not.toHaveBeenCalled();
	} );

	it( 'checks the connection again once the user has answered and immediately before the command starts', async () => {
		const answered = await setup();
		vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( connections );
		vi.mocked( answered.context.approve ).mockImplementationOnce( async () => {
			vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( [] );
			return 'allow';
		} );
		expect(
			( await answered.bridge.invoke( 'site_push', { nameOrPath: 'site', remoteSite: '111' } ) )
				.isError
		).toBe( true );
		expect( answered.host.sync.push ).not.toHaveBeenCalled();
		const started = await setup();
		vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( connections );
		let ran = false;
		vi.mocked( started.host.sync.push ).mockImplementation(
			async ( _site, _options, _remote, _onProgress, fence ) => {
				vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( [
					{ ...fakeRemoteSite, localSiteId: 'other-site' },
				] );
				await fence?.beforeSpawn?.();
				ran = true;
				return fakeRemoteSite;
			}
		);
		expect(
			( await started.bridge.invoke( 'site_push', { nameOrPath: 'site', remoteSite: '111' } ) )
				.isError
		).toBe( true );
		expect( ran ).toBe( false );
	} );

	it( 'decides by no connection Studio keeps where the conversation can write, and keeps its archive out of the turn’s reach', async () => {
		const temporary = await realpath( os.tmpdir() );
		vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( connections );
		for ( const reach of [ config.root, temporary ] ) {
			const { bridge, host, context } = await setup( ( paths ) => ( {
				localRoots: [ paths.site, reach ],
			} ) );
			expect(
				( await bridge.invoke( 'site_push', { nameOrPath: 'site', remoteSite: '111' } ) ).isError,
				reach
			).toBe( true );
			expect( context.approve ).not.toHaveBeenCalled();
			expect( host.sync.push ).not.toHaveBeenCalled();
		}
	} );
} );

describe( 'site_pull on the Claude route', () => {
	const REPRINT_REFUSAL = 'only with its default engine';
	afterEach( () => {
		vi.unstubAllEnvs();
	} );

	it( 'pulls one of the conversation’s site’s connected WordPress.com sites into it once the user approves it, showing the direction, the site and what it overwrites in the local site, journaled before the command', async () => {
		const fixture = await setup();
		const { bridge, host, context, journal, events, site, localSite } = fixture;
		vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( connections );
		const order = journalOrder( fixture, { 'sync.pull': host.sync.pull } );
		expect( bridge.tools ).toContain( 'site_pull' );
		const result = await bridge.invoke( 'site_pull', {
			nameOrPath: 'site',
			remoteSite: 'myprod.wordpress.com',
			options: 'uploads,themes',
		} );
		expect( result.isError ).toBe( false );
		expect( host.sync.pull ).toHaveBeenCalledWith(
			localSite,
			'uploads,themes',
			'111',
			expect.any( Function ),
			expect.objectContaining( { beforeSpawn: expect.any( Function ) } )
		);
		const [ request ] = vi.mocked( context.approve ).mock.calls[ 0 ];
		expect( request.operation ).toMatchObject( {
			tool: 'sync.pull',
			operationClass: 'remote-overwrite',
			args: [
				{
					direction: 'pull',
					remoteSite: PRODUCTION,
					overwrites: [ 'the uploads', 'the themes' ],
				},
			],
			localPaths: [ site ],
			remote: PRODUCTION_LABEL,
		} );
		expect( request.operation.description ).toContain(
			'replaces what overwrites names in this local site'
		);
		expect( order ).toEqual( [ 'journal site_pull', 'journal sync.pull', 'host sync.pull' ] );
		expect( journal[ 1 ] ).toMatchObject( { requestId: request.requestId } );
		expect( JSON.stringify( [ journal, events ] ) ).not.toContain( LOGIN.accessToken );
	} );

	it( 'pulls from no site but a connected one of the conversation’s site, with only the options the command takes, and with no remote left for it to pick, says why and asks nothing', async () => {
		const { bridge, host, policy, localSite, context } = await setup();
		vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( connections );
		for ( const remoteSite of [ '222', '333', 'https://other.example.test' ] ) {
			const result = await bridge.invoke( 'site_pull', { nameOrPath: 'site', remoteSite } );
			expect( result.isError, remoteSite ).toBe( true );
			expect( text( result ), remoteSite ).toContain( REMOTE_REFUSAL );
		}
		for ( const options of [ 'paths', 'all,uploads', 'sqls,' ] ) {
			const result = await bridge.invoke( 'site_pull', {
				nameOrPath: 'site',
				remoteSite: '111',
				options,
			} );
			expect( result.isError, options ).toBe( true );
			expect( text( result ), options ).toContain( OPTIONS_REFUSAL );
		}
		await expect(
			policy.guardHost( host, 'picker' ).sync.pull( localSite, 'all', undefined, () => {} )
		).rejects.toThrow( 'Denied' );
		expect( context.approve ).not.toHaveBeenCalled();
		expect( host.sync.pull ).not.toHaveBeenCalled();
	} );

	it( 'runs no Reprint pull, which keeps its state outside Studio’s configuration folder, checked again immediately before the command starts', async () => {
		vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( connections );
		vi.stubEnv( 'STUDIO_ENABLE_PULL_REPRINT', '1' );
		const reprint = await setup();
		const refused = await reprint.bridge.invoke( 'site_pull', {
			nameOrPath: 'site',
			remoteSite: '111',
		} );
		expect( refused.isError ).toBe( true );
		expect( text( refused ) ).toContain( REPRINT_REFUSAL );
		expect( reprint.context.approve ).not.toHaveBeenCalled();
		expect( reprint.host.sync.pull ).not.toHaveBeenCalled();
		vi.unstubAllEnvs();
		// Turned on while the command is about to start.
		const started = await setup();
		let ran = false;
		vi.mocked( started.host.sync.pull ).mockImplementation(
			async ( _site, _options, _remote, _onProgress, fence ) => {
				vi.stubEnv( 'STUDIO_ENABLE_PULL_REPRINT', '1' );
				await fence?.beforeSpawn?.();
				ran = true;
				return fakeRemoteSite;
			}
		);
		expect(
			( await started.bridge.invoke( 'site_pull', { nameOrPath: 'site', remoteSite: '111' } ) )
				.isError
		).toBe( true );
		expect( ran ).toBe( false );
	} );

	it( 'checks the connection again once the user has answered, so a site disconnected meanwhile is not pulled', async () => {
		const { bridge, host, context } = await setup();
		vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( connections );
		vi.mocked( context.approve ).mockImplementationOnce( async () => {
			vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( [] );
			return 'allow';
		} );
		expect(
			( await bridge.invoke( 'site_pull', { nameOrPath: 'site', remoteSite: '111' } ) ).isError
		).toBe( true );
		expect( host.sync.pull ).not.toHaveBeenCalled();
	} );
} );

describe( 'what a push or pull approval shows of the WordPress.com site', () => {
	it( 'names it as Studio keeps its connection, by its name, address and whether it is a staging or a production site beside its ID, so a production site and its staging copy read differently, and shows no account', async () => {
		vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( connections );
		for ( const name of [ 'site_push', 'site_pull' ] ) {
			const fixture = await setup();
			for ( const remoteSite of [ '111', 'https://staging.example.test/' ] )
				expect(
					( await fixture.bridge.invoke( name, { nameOrPath: 'site', remoteSite } ) ).isError,
					`${ name } ${ remoteSite }`
				).toBe( false );
			const [ production, staging ] = vi
				.mocked( fixture.context.approve )
				.mock.calls.map( ( [ request ] ) => request.operation );
			expect( production.args, name ).toEqual( [
				expect.objectContaining( { remoteSite: PRODUCTION } ),
			] );
			expect( production.remote, name ).toBe( PRODUCTION_LABEL );
			expect( staging.args, name ).toEqual( [
				expect.objectContaining( {
					remoteSite: {
						id: 112,
						name: 'Staging',
						address: 'staging.example.test',
						kind: 'staging',
					},
				} ),
			] );
			expect( staging.remote, name ).toBe(
				'WordPress.com site 112: Staging, staging.example.test, a staging site'
			);
			// What a person reads: the approval as the app is given it.
			const shown = fixture.events
				.filter( ( event ) => event.type === 'approval.requested' )
				.map(
					( event ) => ( event as { operation: { args: string; remote?: string } } ).operation
				);
			expect( shown, name ).toHaveLength( 2 );
			expect( shown[ 0 ].args, name ).toContain( '"kind": "production"' );
			expect( shown[ 1 ].args, name ).toContain( '"kind": "staging"' );
			expect( shown[ 0 ].remote, name ).not.toBe( shown[ 1 ].remote );
			expect( JSON.stringify( [ fixture.events, fixture.journal ] ), name ).not.toContain(
				LOGIN.accessToken
			);
			expect( vi.mocked( fixture.host.sync.push ).mock.calls.length, name ).toBe(
				name === 'site_push' ? 2 : 0
			);
		}
	} );
} );

describe( 'the operations on a remote, after a recovery and when the account changes', () => {
	const calls: Array< [ string, Record< string, unknown > ] > = [
		[ 'preview_create', { nameOrPath: 'site' } ],
		[ 'preview_update', { nameOrPath: 'site', host: own.url } ],
		[ 'preview_delete', { host: own.url } ],
		[ 'site_push', { nameOrPath: 'site', remoteSite: '111' } ],
		[ 'site_pull', { nameOrPath: 'site', remoteSite: '111' } ],
	];
	const ran = ( { host }: Fixture ) =>
		[
			host.previews.create,
			host.previews.update,
			host.previews.delete,
			host.sync.push,
			host.sync.pull,
		].filter( ( spy ) => vi.mocked( spy ).mock.calls.length ).length;

	it( 'asks for each once, as in any turn, in a turn after a recovery that left operations uncertain', async () => {
		for ( const [ name, args ] of calls ) {
			const fixture = await setup( () => ( { uncertainAfterRecovery: true } ) );
			vi.mocked( fixture.host.previews.list ).mockResolvedValue( [ own ] );
			vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( connections );
			expect( ( await fixture.bridge.invoke( name, args ) ).isError, name ).toBe( false );
			expect( fixture.context.approve, name ).toHaveBeenCalledOnce();
			expect( ran( fixture ), name ).toBe( 1 );
		}
	} );

	it( 'runs none under a WordPress.com login other than the one it was prepared under, even one that keeps the same connection and previews, whether the login changed while the user read the approval or as the command was about to start', async () => {
		for ( const [ name, args ] of calls ) {
			vi.mocked( readAuthToken ).mockResolvedValue( LOGIN as never );
			vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( connections );
			const answered = await setup();
			vi.mocked( answered.host.previews.list ).mockResolvedValue( [ own ] );
			vi.mocked( answered.context.approve ).mockImplementationOnce( async () => {
				switchLogin();
				return 'allow';
			} );
			const afterAnswer = await answered.bridge.invoke( name, args );
			expect( afterAnswer.isError, name ).toBe( true );
			expect( text( afterAnswer ), name ).toContain( LOGIN_REFUSAL );
			expect( ran( answered ), name ).toBe( 0 );
			// Only the tool's own entry: the host operation never got that far.
			expect(
				answered.journal.map( ( entry ) => entry.operation.tool ),
				name
			).toEqual( [ name ] );

			vi.mocked( readAuthToken ).mockResolvedValue( LOGIN as never );
			const started = await setup();
			vi.mocked( started.host.previews.list ).mockResolvedValue( [ own ] );
			let reached = false;
			for ( const spy of [
				started.host.previews.create,
				started.host.previews.update,
				started.host.previews.delete,
				started.host.sync.push,
				started.host.sync.pull,
			] )
				vi.mocked( spy ).mockImplementation( async ( ...received: unknown[] ) => {
					switchLogin();
					const fence = received.at( -1 ) as { beforeSpawn?: () => Promise< void > } | undefined;
					await fence?.beforeSpawn?.();
					reached = true;
					return undefined as never;
				} );
			const beforeStart = await started.bridge.invoke( name, args );
			expect( beforeStart.isError, name ).toBe( true );
			expect( text( beforeStart ), name ).toContain( LOGIN_REFUSAL );
			expect( reached, name ).toBe( false );
		}
	} );

	it( 'runs none while Studio is signed in to no WordPress.com login, says why and asks nothing', async () => {
		for ( const [ name, args ] of calls ) {
			const fixture = await setup();
			vi.mocked( fixture.host.previews.list ).mockResolvedValue( [ own ] );
			vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( connections );
			vi.mocked( readAuthToken ).mockResolvedValue( null );
			const result = await fixture.bridge.invoke( name, args );
			expect( result.isError, name ).toBe( true );
			expect( text( result ), name ).toContain( LOGIN_REFUSAL );
			expect( fixture.context.approve, name ).not.toHaveBeenCalled();
			expect( ran( fixture ), name ).toBe( 0 );
		}
	} );

	it( 'asks nothing and runs nothing once the native account has changed', async () => {
		for ( const [ name, args ] of calls ) {
			const fixture = await setup( () => ( {
				verifyAccount: vi.fn( async () => 'changed' as const ),
			} ) );
			vi.mocked( fixture.host.previews.list ).mockResolvedValue( [ own ] );
			vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( connections );
			expect( ( await fixture.bridge.invoke( name, args ) ).isError, name ).toBe( true );
			expect( fixture.context.approve, name ).not.toHaveBeenCalled();
			expect( ran( fixture ), name ).toBe( 0 );
		}
	} );
} );

describe( 'site_connected_remote_sites on the Claude route', () => {
	// The account's own listing of its sites, as WordPress.com answers it: the
	// site connected to the conversation's site, and another one.
	const accountSites = {
		sites: [
			{
				ID: fakeRemoteSite.id,
				is_wpcom_atomic: true,
				name: 'Connected',
				URL: 'https://c.example.test',
				is_deleted: false,
			},
			{
				ID: 222,
				is_wpcom_atomic: true,
				name: 'Unconnected',
				URL: 'https://u.example.test',
				is_deleted: false,
			},
		],
	};

	it( 'lists the WordPress.com sites connected to the conversation’s own site, asking WordPress.com only for the account’s own listing, with the stored login, unprompted and unjournaled', async () => {
		const { bridge, context, journal } = await setup();
		vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( [ fakeRemoteSite ] );
		wpcom.respond = () => ( { status: 200, body: accountSites } );
		expect( bridge.tools ).toContain( 'site_connected_remote_sites' );
		const result = await bridge.invoke( 'site_connected_remote_sites', { nameOrPath: 'site' } );
		expect( result.isError ).toBe( false );
		expect( getConnectedWpcomSitesForLocalSite ).toHaveBeenCalledWith( 'site-123' );
		expect( JSON.parse( text( result ) ) ).toEqual( [
			expect.objectContaining( { type: 'wpcom-remote', id: fakeRemoteSite.id, name: 'Connected' } ),
		] );
		expect( wpcom.received ).toEqual( [
			expect.objectContaining( {
				method: 'GET',
				url: expect.stringMatching( /^\/rest\/v1\.2\/me\/sites\?/ ),
				authorization: `Bearer ${ LOGIN.accessToken }`,
			} ),
		] );
		expect( text( result ) ).not.toContain( LOGIN.accessToken );
		expect( context.approve ).not.toHaveBeenCalled();
		expect( journal ).toEqual( [] );
	} );

	it( 'says a failure in a fixed sentence, never with the stored login', async () => {
		const { bridge } = await setup();
		vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( [ fakeRemoteSite ] );
		wpcom.respond = () => ( {
			status: 500,
			body: { error: 'oops', message: `bad login ${ LOGIN.accessToken }` },
		} );
		const result = await bridge.invoke( 'site_connected_remote_sites', { nameOrPath: 'site' } );
		expect( result.isError ).toBe( true );
		expect( text( result ) ).toBe( 'Studio operation denied or failed.' );
		expect( wpcom.received ).toHaveLength( 1 );
	} );

	it( 'reads no other site’s connections and asks WordPress.com nothing for them, nor from a conversation without a site', async () => {
		const onSite = await setup();
		const unbound = await setup( global );
		expect(
			( await onSite.bridge.invoke( 'site_connected_remote_sites', { nameOrPath: 'other' } ) )
				.isError
		).toBe( true );
		expect(
			( await unbound.bridge.invoke( 'site_connected_remote_sites', { nameOrPath: 'site' } ) )
				.isError
		).toBe( true );
		expect( getConnectedWpcomSitesForLocalSite ).not.toHaveBeenCalled();
		expect( readAuthToken ).not.toHaveBeenCalled();
		expect( wpcom.received ).toEqual( [] );
	} );

	it( 'reads no stored login that lies in a folder the turn reaches', async () => {
		const { bridge } = await setup( ( paths ) => ( { localRoots: [ paths.site, config.root ] } ) );
		expect(
			( await bridge.invoke( 'site_connected_remote_sites', { nameOrPath: 'site' } ) ).isError
		).toBe( true );
		expect( readAuthToken ).not.toHaveBeenCalled();
		expect( wpcom.received ).toEqual( [] );
	} );
} );

describe( 'wpcom_request on the Claude route', () => {
	// A conversation on a local site that is connected to WordPress.com site 42.
	const live = () => ( {
		target: { environment: 'live' as const, siteId: 'site-123', wpcomSiteId: 42 },
	} );
	const sent = () => wpcom.received.map( ( { method, url } ) => `${ method } ${ url }` );
	const payloads = () => path.join( config.root, 'tmp', 'ai-payloads' );
	const WPCOM_REFUSAL = 'no query key that changes its method, route, namespace or origin';
	const SITE_REFUSAL = 'only to this conversation’s own WordPress.com site';
	// The conversation's WordPress.com site is connected to its local site
	// under the stored login, as Studio keeps it.
	const connected = [ { ...fakeRemoteSite, id: 42 } ];
	beforeEach( () => {
		vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( connected );
	} );
	const PROFILE_REFUSAL = 'does not read the account’s profile (!/me) on this connection';
	const PAYLOAD_REFUSAL = 'must be an existing file in Studio’s payload folder';

	describe( 'reads', () => {
		it( 'reads the conversation’s own WordPress.com site unprompted and unjournaled, sending exactly the request it decided on, with the stored login', async () => {
			const { bridge, context, journal } = await setup( live );
			wpcom.respond = () => ( { status: 200, body: [ { id: 1 } ] } );
			expect( bridge.tools ).toContain( 'wpcom_request' );
			const result = await bridge.invoke( 'wpcom_request', {
				siteId: 42,
				method: 'GET',
				path: '/posts',
				query: { per_page: 2 },
			} );
			expect( result.isError ).toBe( false );
			expect( JSON.parse( text( result ) ) ).toEqual( [ { id: 1 } ] );
			expect( wpcom.received ).toEqual( [
				expect.objectContaining( {
					method: 'GET',
					url: '/wp/v2/sites/42/posts?per_page=2',
					authorization: `Bearer ${ LOGIN.accessToken }`,
				} ),
			] );
			expect( context.approve ).not.toHaveBeenCalled();
			expect( journal ).toEqual( [] );
		} );

		it( 'reads WordPress.com’s plan features from any conversation, and not the account’s profile or anything else of the account, saying so', async () => {
			const { bridge } = await setup( global );
			const read = ( accountPath: string, apiNamespace: string ) =>
				bridge.invoke( 'wpcom_request', {
					siteId: 1,
					method: 'GET',
					path: accountPath,
					apiNamespace,
				} );
			expect( ( await read( '!/plans/features', 'wpcom/v2' ) ).isError ).toBe( false );
			expect( sent() ).toEqual( [ 'GET /wpcom/v2/plans/features' ] );
			for ( const accountPath of [ '!/me', '!/me/sites', '!/me/settings', '!/read/following' ] ) {
				const result = await read( accountPath, '' );
				expect( result.isError, accountPath ).toBe( true );
				expect( text( result ), accountPath ).toContain( PROFILE_REFUSAL );
			}
			expect( wpcom.received ).toHaveLength( 1 );
		} );

		it( 'reads no other site, and no site from a conversation without one on WordPress.com, says why and sends nothing', async () => {
			const onLive = await setup( live );
			const onLocal = await setup();
			const unbound = await setup( global );
			const calls: Array< [ typeof onLive, Record< string, unknown > ] > = [
				[ onLive, { siteId: 7, method: 'GET', path: '/posts' } ],
				[ onLive, { siteId: 42, method: 'GET', path: '!/sites/7/posts' } ],
				[ onLocal, { siteId: 42, method: 'GET', path: '/posts' } ],
				[ unbound, { siteId: 42, method: 'GET', path: '!/sites/42/posts', apiNamespace: '' } ],
			];
			for ( const [ fixture, args ] of calls ) {
				const result = await fixture.bridge.invoke( 'wpcom_request', args );
				expect( result.isError, JSON.stringify( args ) ).toBe( true );
				expect( text( result ), JSON.stringify( args ) ).toContain( SITE_REFUSAL );
			}
			expect( wpcom.received ).toEqual( [] );
		} );

		it( 'refuses a request the rules refuse, says why without its values, and sends nothing', async () => {
			const { bridge } = await setup( live );
			for ( const args of [
				{ siteId: 42, method: 'GET', path: '/posts', query: { _method: 'DELETE' } },
				{
					siteId: 42,
					method: 'GET',
					path: '/posts',
					query: { rest_route: '/wp/v2/sites/7/posts' },
				},
				{ siteId: 42, method: 'GET', path: '/posts', query: { proxyOrigin: 'http://127.0.0.1:9' } },
				{ siteId: 42, method: 'GET', path: '/posts', apiNamespace: 'wp/v2/sites/7/posts#' },
				{ siteId: 42, method: 'GET', path: '/../7/posts' },
			] ) {
				const result = await bridge.invoke( 'wpcom_request', args );
				expect( result.isError, JSON.stringify( args ) ).toBe( true );
				expect( text( result ), JSON.stringify( args ) ).toContain( WPCOM_REFUSAL );
				expect( text( result ), JSON.stringify( args ) ).not.toMatch( /127\.0\.0\.1|sites\/7/ );
			}
			expect( wpcom.received ).toEqual( [] );
		} );

		it( 'reads no stored login that lies in a folder the turn reaches', async () => {
			const { bridge } = await setup( ( paths ) => ( {
				...live(),
				localRoots: [ paths.site, config.root ],
			} ) );
			const result = await bridge.invoke( 'wpcom_request', {
				siteId: 42,
				method: 'GET',
				path: '/posts',
			} );
			expect( result.isError ).toBe( true );
			expect( readAuthToken ).not.toHaveBeenCalled();
			expect( wpcom.received ).toEqual( [] );
		} );
	} );

	describe( 'changes', () => {
		const CONNECTION_REFUSAL =
			'only while it is connected to this conversation’s site under the WordPress.com login Studio is signed in with';
		const change = { siteId: 42, method: 'POST', path: '/posts', body: { title: 'x' } };

		it( 'changes something in the conversation’s own site once the user approves the request, shown by the method sent, the site and the path and never its body, query or the stored login, journaled before it is sent', async () => {
			const { bridge, context, journal } = await setup( live );
			const sentWhenJournaled: number[] = [];
			const record = context.recordOperation;
			context.recordOperation = async ( event ) => {
				sentWhenJournaled.push( wpcom.received.length );
				await record( event );
			};
			wpcom.respond = () => ( { status: 200, body: { id: 9 } } );
			const result = await bridge.invoke( 'wpcom_request', {
				siteId: 42,
				method: 'POST',
				path: '/posts',
				query: { context: 'edit' },
				body: { title: 'Hidden title', content: 'hidden body' },
			} );
			expect( result.isError ).toBe( false );
			expect( context.approve ).toHaveBeenCalledOnce();
			const [ request ] = vi.mocked( context.approve ).mock.calls[ 0 ];
			expect( request.operation ).toMatchObject( {
				tool: 'wpcom_request',
				operationClass: 'remote-overwrite',
				args: { method: 'POST', path: '/wp/v2/sites/42/posts' },
				localPaths: [],
				remote: 'WordPress.com site 42',
			} );
			expect( request.target ).toEqual( live().target );
			expect( JSON.stringify( request ) ).not.toMatch( /hidden|edit|test-login-token/i );
			expect( journal ).toEqual( [
				expect.objectContaining( {
					requestId: request.requestId,
					operation: expect.objectContaining( {
						tool: 'wpcom_request',
						operationClass: 'remote-overwrite',
					} ),
				} ),
			] );
			expect( JSON.stringify( journal ) ).not.toMatch( /hidden|edit|test-login-token|posts/i );
			expect( sentWhenJournaled ).toEqual( [ 0 ] );
			expect( wpcom.received ).toEqual( [
				expect.objectContaining( {
					method: 'POST',
					url: '/wp/v2/sites/42/posts?context=edit',
					authorization: `Bearer ${ LOGIN.accessToken }`,
				} ),
			] );
			expect( JSON.parse( wpcom.received[ 0 ].body ) ).toEqual( {
				title: 'Hidden title',
				content: 'hidden body',
			} );
			// The site is one Studio keeps as connected to the conversation's site.
			expect( getConnectedWpcomSitesForLocalSite ).toHaveBeenCalledWith( 'site-123' );
		} );

		it( 'changes a site only while it is connected to the conversation’s site under the login Studio is signed in with, says why, and asks, journals and sends nothing', async () => {
			const { bridge, context, journal } = await setup( live );
			for ( const stored of [
				[],
				[ { ...fakeRemoteSite, id: 7 } ],
				[ { ...fakeRemoteSite, id: 42, localSiteId: 'other-site' } ],
			] ) {
				vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( stored );
				const result = await bridge.invoke( 'wpcom_request', change );
				expect( result.isError, JSON.stringify( stored ) ).toBe( true );
				expect( text( result ), JSON.stringify( stored ) ).toContain( CONNECTION_REFUSAL );
			}
			vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( connected );
			vi.mocked( readAuthToken ).mockResolvedValue( null );
			const signedOut = await bridge.invoke( 'wpcom_request', change );
			expect( signedOut.isError ).toBe( true );
			expect( text( signedOut ) ).toContain( LOGIN_REFUSAL );
			expect( context.approve ).not.toHaveBeenCalled();
			expect( journal ).toEqual( [] );
			expect( wpcom.received ).toEqual( [] );
		} );

		it( 'sends no change, and journals none, once the login has changed since the user was asked, even to one that has the same site connected', async () => {
			const { bridge, context, journal } = await setup( live );
			vi.mocked( context.approve ).mockImplementationOnce( async () => {
				switchLogin();
				return 'allow';
			} );
			const result = await bridge.invoke( 'wpcom_request', change );
			expect( result.isError ).toBe( true );
			expect( text( result ) ).toContain( LOGIN_REFUSAL );
			expect( context.approve ).toHaveBeenCalledOnce();
			expect( journal ).toEqual( [] );
			expect( wpcom.received ).toEqual( [] );
		} );

		it( 'checks the login again as the last step before the request is sent', async () => {
			const { bridge, context, journal } = await setup( live );
			const record = context.recordOperation;
			context.recordOperation = async ( event ) => {
				await record( event );
				switchLogin();
			};
			const result = await bridge.invoke( 'wpcom_request', change );
			expect( result.isError ).toBe( true );
			expect( text( result ) ).toContain( LOGIN_REFUSAL );
			expect( journal ).toHaveLength( 1 );
			expect( wpcom.received ).toEqual( [] );
		} );

		it( 'shows a PUT as the POST the client sends', async () => {
			const { bridge, context } = await setup( live );
			await bridge.invoke( 'wpcom_request', {
				siteId: 42,
				method: 'PUT',
				path: '/settings',
				body: { title: 'x' },
			} );
			expect( vi.mocked( context.approve ).mock.calls[ 0 ][ 0 ].operation.args ).toEqual( {
				method: 'POST',
				path: '/wp/v2/sites/42/settings',
			} );
			expect( sent() ).toEqual( [ 'POST /wp/v2/sites/42/settings' ] );
		} );

		it( 'sends nothing the user denies, says so, and journals nothing', async () => {
			const { bridge, journal } = await setup( () => ( {
				...live(),
				approve: vi.fn( async () => 'deny' as const ),
			} ) );
			const result = await bridge.invoke( 'wpcom_request', {
				siteId: 42,
				method: 'POST',
				path: '/posts/9',
				body: { status: 'trash' },
			} );
			expect( result.isError ).toBe( true );
			expect( text( result ) ).toContain( 'The user did not approve this operation' );
			expect( wpcom.received ).toEqual( [] );
			expect( journal ).toEqual( [] );
		} );

		it( 'changes nothing through the legacy or WordPress.com APIs, on another site or the account, nor by a DELETE, which the client would send as a POST, and asks nothing for them', async () => {
			const { bridge, context } = await setup( live );
			for ( const args of [
				{
					siteId: 42,
					method: 'POST',
					path: '/settings',
					apiNamespace: '',
					body: { blogname: 'x' },
				},
				{
					siteId: 42,
					method: 'POST',
					path: '/posts/1/reblogs/new',
					apiNamespace: '',
					body: { destination_site_id: 7 },
				},
				{
					siteId: 42,
					method: 'POST',
					path: '/studio-app/sync/import/initiate',
					apiNamespace: 'wpcom/v2',
				},
				{ siteId: 7, method: 'POST', path: '/posts' },
				{ siteId: 42, method: 'POST', path: '!/me/settings', apiNamespace: '' },
				{ siteId: 42, method: 'PUT', path: '/' },
				{ siteId: 42, method: 'DELETE', path: '/posts/9' },
			] )
				expect(
					( await bridge.invoke( 'wpcom_request', args ) ).isError,
					JSON.stringify( args )
				).toBe( true );
			expect( context.approve ).not.toHaveBeenCalled();
			expect( wpcom.received ).toEqual( [] );
		} );
	} );

	describe( 'files a change sends from Studio’s payload folder', () => {
		it( 'are sent with a change the user approves, which shows them', async () => {
			const { bridge, context } = await setup( live );
			await writeFile( path.join( payloads(), 'home.html' ), '<p>Home</p>' );
			const styles = path.join( payloads(), 'styles.json' );
			await writeFile( styles, JSON.stringify( { styles: { color: { text: '#000' } } } ) );
			const page = await bridge.invoke( 'wpcom_request', {
				siteId: 42,
				method: 'POST',
				path: '/pages/4',
				body: { status: 'publish' },
				bodyFiles: { content: 'home.html' },
			} );
			expect( page.isError ).toBe( false );
			const globalStyles = await bridge.invoke( 'wpcom_request', {
				siteId: 42,
				method: 'PUT',
				path: '/global-styles/3',
				bodyFile: styles,
			} );
			expect( globalStyles.isError ).toBe( false );
			expect(
				vi
					.mocked( context.approve )
					.mock.calls.map( ( [ request ] ) => request.operation.localPaths )
			).toEqual( [ [ path.join( payloads(), 'home.html' ) ], [ styles ] ] );
			expect( wpcom.received.map( ( { body } ) => JSON.parse( body ) ) ).toEqual( [
				{ status: 'publish', content: '<p>Home</p>' },
				{ styles: { color: { text: '#000' } } },
			] );
		} );

		it( 'are none from outside that folder, by any path or link, none that holds credentials or does not exist, and none with a read', async () => {
			const { bridge, context, site } = await setup( live );
			await writeFile( path.join( config.root, 'tmp', 'outside.json' ), '{}' );
			await writeFile( path.join( site, 'page.html' ), '<p>Site</p>' );
			await writeFile( path.join( payloads(), 'secret.json' ), '{}' );
			await writeFile( path.join( payloads(), 'read.json' ), '{}' );
			const linked = path.join( payloads(), 'linked' );
			await symlink( site, linked, 'junction' );
			try {
				for ( const args of [
					{ method: 'POST', bodyFile: '../outside.json' },
					{ method: 'POST', bodyFile: path.join( config.root, 'tmp', 'outside.json' ) },
					{ method: 'POST', bodyFiles: { content: path.join( site, 'page.html' ) } },
					{ method: 'POST', bodyFiles: { content: path.join( 'linked', 'page.html' ) } },
					{ method: 'POST', bodyFile: 'secret.json' },
					{ method: 'PUT', bodyFile: 'missing.json' },
					{ method: 'GET', bodyFile: 'read.json' },
				] ) {
					const result = await bridge.invoke( 'wpcom_request', {
						siteId: 42,
						path: '/posts/1',
						...args,
					} );
					expect( result.isError, JSON.stringify( args ) ).toBe( true );
					expect( text( result ), JSON.stringify( args ) ).toContain( PAYLOAD_REFUSAL );
					expect( text( result ), JSON.stringify( args ) ).not.toContain( config.root );
				}
			} finally {
				await rm( linked );
			}
			expect( context.approve ).not.toHaveBeenCalled();
			expect( wpcom.received ).toEqual( [] );
		} );

		it( 'are checked again once the user has answered, so a link planted while the user reads the approval sends nothing', async () => {
			const { context, bridge, site } = await setup( live );
			const staged = path.join( payloads(), 'staged' );
			await mkdir( staged, { recursive: true } );
			await writeFile( path.join( staged, 'page.html' ), '<p>Staged</p>' );
			await writeFile( path.join( site, 'page.html' ), '<p>Site</p>' );
			vi.mocked( context.approve ).mockImplementationOnce( async () => {
				await rm( staged, { recursive: true } );
				await symlink( site, staged, 'junction' );
				return 'allow';
			} );
			try {
				const result = await bridge.invoke( 'wpcom_request', {
					siteId: 42,
					method: 'POST',
					path: '/pages/4',
					bodyFiles: { content: path.join( staged, 'page.html' ) },
				} );
				expect( result.isError ).toBe( true );
				expect( text( result ) ).toContain( PAYLOAD_REFUSAL );
				expect( wpcom.received ).toEqual( [] );
			} finally {
				await rm( staged, { recursive: true, force: true } );
			}
		} );
	} );
} );
