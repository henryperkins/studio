// @vitest-environment node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createFakeHost, fakeSite } from '@studio/agent/node/tests/fake-host';
import { wpcomRequestTool } from '@studio/agent/node/tools/wpcom-request';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	blockedConnectionOptions,
	couldBeMethodOverrideKey,
	evalHistoryMessages,
	findEvalFixturesDir,
	installWpcomWriteGuard,
	loadEvalAttachments,
	remoteIsStagingSite,
	withMockedRemote,
	withMockedWpcomRequest,
	withStagingRemote,
	writesToStagingSite,
	type RemoteCall,
} from 'cli/ai/eval-harness';

// No WordPress.com login: a read the mock passes on never leaves the process.
vi.mock( '@studio/common/lib/shared-config', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/common/lib/shared-config') >() ),
	readAuthToken: async () => null,
} ) );

const repositoryFixtures = path.resolve( import.meta.dirname, '../../../../scripts/eval/fixtures' );

describe( 'eval harness', () => {
	let base: string;

	beforeEach( () => {
		base = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-eval-harness-' ) );
	} );

	afterEach( () => {
		fs.rmSync( base, { recursive: true, force: true, maxRetries: 5 } );
	} );

	describe( 'mocked remote operations', () => {
		it( 'records pushes, pulls and preview changes without ever reaching the real host', async () => {
			const host = createFakeHost( base );
			const real = [
				host.sync.push,
				host.sync.pull,
				host.previews.create,
				host.previews.update,
				host.previews.delete,
			];
			const calls: RemoteCall[] = [];
			const mocked = withMockedRemote( host, calls );
			const onProgress = vi.fn();

			const pushed = await mocked.sync.push(
				fakeSite,
				'all',
				'https://myprod.wordpress.com',
				onProgress
			);
			const pulled = await mocked.sync.pull( fakeSite, 'sqls', '111', onProgress );
			const created = await mocked.previews.create( fakeSite, onProgress );
			await mocked.previews.update( fakeSite, 'demo.wp.build', true, onProgress );
			await mocked.previews.delete( 'demo.wp.build', onProgress );

			for ( const fn of real ) {
				expect( fn ).not.toHaveBeenCalled();
			}
			expect( calls ).toEqual( [
				{
					operation: 'push',
					site: fakeSite.name,
					target: 'https://myprod.wordpress.com',
					options: 'all',
				},
				{ operation: 'pull', site: fakeSite.name, target: '111', options: 'sqls' },
				{ operation: 'preview-create', site: fakeSite.name },
				{ operation: 'preview-update', site: fakeSite.name, target: 'demo.wp.build' },
				{ operation: 'preview-delete', target: 'demo.wp.build' },
			] );
			expect( pushed?.url ).toBe( 'https://myprod.wordpress.com' );
			expect( pulled?.url ).toMatch( /\.invalid$/ );
			expect( created.url ).toMatch( /\.invalid$/ );
			// Local operations are the real host's.
			expect( mocked.sites ).toBe( host.sites );
			expect( mocked.previews.list ).toBe( host.previews.list );
		} );
	} );

	describe( 'WordPress.com under remote: mock', () => {
		const context = () => ( { host: createFakeHost( base ), onProgress: () => undefined } );

		it( 'answers a write through wpcom_request with a fixture and records it, and passes reads on', async () => {
			const original = wpcomRequestTool.handler;
			const calls: RemoteCall[] = [];
			const restore = withMockedWpcomRequest( calls );
			try {
				const written = await wpcomRequestTool.handler(
					{ siteId: 113, method: 'POST', path: '/posts', body: { title: 'Hello' } },
					context()
				);
				await wpcomRequestTool.handler(
					{ siteId: 113, method: 'DELETE', path: '/posts/7' },
					context()
				);
				expect( JSON.parse( ( written.content[ 0 ] as { text: string } ).text ) ).toMatchObject( {
					eval_mock: true,
				} );
				expect( calls ).toEqual( [
					{ operation: 'wpcom-request', method: 'POST', site: '113', target: '/posts' },
					{ operation: 'wpcom-request', method: 'DELETE', site: '113', target: '/posts/7' },
				] );
				// A read is the real tool's: here, with no WordPress.com login, it says so.
				await expect(
					wpcomRequestTool.handler( { siteId: 113, method: 'GET', path: '/posts' }, context() )
				).rejects.toThrow( /Not logged in/ );
				expect( calls ).toHaveLength( 2 );
			} finally {
				restore();
			}
			expect( wpcomRequestTool.handler ).toBe( original );
		} );

		it.each( [
			[ '.method', true ],
			[ '%2Emethod', true ],
			[ '%20_method', true ],
			[ '_method%00', true ],
			[ '_method\u0000', true ],
			[ '_method', true ],
			[ 'method', true ],
			[ '_METHOD', true ],
			[ '%5Fmethod', true ],
			[ '_method[]', true ],
			[ '_method[x]', true ],
			[ ' _method', true ],
			[ '[method', true ],
			[ '_method%00foo', true ],
			[ 'me%74hod', true ],
			[ 'me\tthod', true ],
			[ ' _method[x]', true ],
			[ '%20_method[x]', true ],
			[ '\t_method[x]', true ],
			[ ' .method[x]', true ],
			[ '_method [x]', false ],
			[ 'smethod', false ],
			[ 'sMethod', false ],
			[ 's_method', false ],
			[ 'payment_method', false ],
			[ 'methods', false ],
			[ 'method_name', false ],
			[ 'per_page', false ],
			[ 'status', false ],
		] )(
			'decides whether the query key %j could become a method override: %s',
			( key, expected ) => {
				expect( couldBeMethodOverrideKey( key ) ).toBe( expected );
			}
		);

		// Each key is caught by one rule alone, so a mistake in that rule cannot hide behind the others.
		it.each( [
			[ 'the folded name', ' .Method[x]' ],
			[ 'the letters and digits', 'Me-Thod' ],
			[ 'the control character', 'per\u0000page' ],
		] )( 'finds an override through %s alone: %j', ( _rule, key ) => {
			expect( couldBeMethodOverrideKey( key ) ).toBe( true );
		} );

		it( 'treats a method override in the query of a wpcom_request GET as a write', async () => {
			const calls: RemoteCall[] = [];
			const restore = withMockedWpcomRequest( calls );
			try {
				for ( const query of [
					{ _method: 'DELETE' },
					{ _METHOD: 'put' },
					{ Method: 'POST' },
					{ per_page: 5, _method: [ 'GET', 'DELETE' ] },
					{ '.method': 'DELETE' },
					{ '%2Emethod': 'DELETE' },
					{ '%20_method': 'DELETE' },
					{ '_method\u0000': 'DELETE' },
					{ ' _method[x]': 'DELETE' },
					{ ' _method[x]': [ 'GET' ] },
					{ '%20_method[x]': 'DELETE' },
					{ '%20_method[x]': 'GET' },
				] ) {
					const answered = await wpcomRequestTool.handler(
						{ siteId: 113, method: 'GET', path: '/posts/7', query },
						context()
					);
					expect( JSON.parse( ( answered.content[ 0 ] as { text: string } ).text ) ).toMatchObject(
						{
							eval_mock: true,
						}
					);
				}
				expect( calls ).toHaveLength( 12 );
				expect( calls.map( ( call ) => call.method ) ).toEqual( [
					'DELETE',
					'PUT',
					'POST',
					'DELETE',
					'DELETE',
					'DELETE',
					'DELETE',
					'OTHER',
					'DELETE',
					'OTHER',
					'DELETE',
					'OTHER',
				] );
				// An override that names a read is still a read, and passes on.
				await expect(
					wpcomRequestTool.handler(
						{
							siteId: 113,
							method: 'GET',
							path: '/posts',
							query: { _method: 'get', method: 'HEAD' },
						},
						context()
					)
				).rejects.toThrow( /Not logged in/ );
				expect( calls ).toHaveLength( 12 );
			} finally {
				restore();
			}
		} );

		it( 'reads a query written into a wpcom_request path as the request would send it', async () => {
			const calls: RemoteCall[] = [];
			const restore = withMockedWpcomRequest( calls );
			try {
				const overriding = [
					'/posts/7?_method=DELETE',
					'/posts/7?%20_method[x]=DELETE',
					'/posts/7?+_method[x]=GET',
					'/posts/7?context=edit&_method=PUT#top',
				];
				for ( const path of overriding ) {
					const answered = await wpcomRequestTool.handler(
						{ siteId: 113, method: 'GET', path },
						context()
					);
					expect( JSON.parse( ( answered.content[ 0 ] as { text: string } ).text ) ).toMatchObject(
						{ eval_mock: true }
					);
				}
				expect( calls ).toEqual(
					[ 'DELETE', 'DELETE', 'OTHER', 'PUT' ].map( ( method, index ) => ( {
						operation: 'wpcom-request',
						method,
						site: '113',
						target: overriding[ index ],
					} ) )
				);
				// A harmless query is a read, and so is an override after `#`: the fragment is never sent.
				for ( const path of [
					'/posts?per_page=5&status=publish',
					'/posts?per_page=5#&_method=DELETE',
					'/posts#?_method=DELETE',
				] ) {
					await expect(
						wpcomRequestTool.handler( { siteId: 113, method: 'GET', path }, context() )
					).rejects.toThrow( /Not logged in/ );
				}
				expect( calls ).toHaveLength( 4 );
			} finally {
				restore();
			}
		} );

		it( 'refuses a WordPress.com request whose query or headers override the method', async () => {
			const { reached, targets } = network();
			const guard = installWpcomWriteGuard( {}, targets );
			const base = 'https://public-api.wordpress.com/wp/v2/sites/1/posts/7';
			const refused = [
				targets.global.fetch( `${ base }?_method=DELETE` ),
				targets.global.fetch( `${ base }?a=1&_METHOD=put` ),
				targets.global.fetch( `${ base }?method=GET&method=DELETE` ),
				targets.global.fetch( new URL( `${ base }?Method=PATCH` ) ),
				targets.global.fetch( `${ base }?.method=DELETE` ),
				targets.global.fetch( `${ base }?%2Emethod=DELETE` ),
				targets.global.fetch( `${ base }?%20_method=DELETE` ),
				targets.global.fetch( `${ base }?_method%00=DELETE` ),
				targets.global.fetch( `${ base }?_method%00=GET` ),
				targets.global.fetch( `${ base }?_method[]=GET` ),
				targets.global.fetch( `${ base }? _method[x]=DELETE` ),
				targets.global.fetch( `${ base }? _method[x]=GET` ),
				targets.global.fetch( `${ base }?%20_method[x]=DELETE` ),
				targets.global.fetch( `${ base }?%20_method[x]=GET` ),
				targets.global.fetch( `${ base }?+_method[x]=DELETE` ),
				targets.global.fetch( base, { headers: { 'X-HTTP-Method-Override': 'DELETE' } } ),
				targets.global.fetch( base, { headers: new Headers( { 'x-method-override': 'PUT' } ) } ),
				targets.global.fetch( base, { headers: [ [ 'X-HTTP-Method', 'DELETE' ] ] } ),
				targets.global.fetch(
					new Request( base, { headers: { 'X-HTTP-Method-Override': 'DELETE' } } )
				),
			];
			for ( const request of refused ) {
				await expect( request ).rejects.toThrow( /wpcom-write-under-mock/ );
			}
			targets.https.request( {
				host: 'public-api.wordpress.com',
				path: '/wp/v2/sites/1/posts/7?_method=DELETE',
			} );
			targets.https.request( new URL( `${ base }?_method=DELETE` ), {} );
			targets.https.request( `${ base }?method=PUT` );
			targets.https.request( {
				host: 'public-api.wordpress.com',
				path: '/wp/v2/sites/1/posts/7',
				headers: { 'X-HTTP-Method-Override': 'DELETE' },
			} );
			targets.https.request( {
				host: 'public-api.wordpress.com',
				path: '/wp/v2/sites/1/posts/7?%20_method[x]=DELETE',
			} );
			targets.https.request( `${ base }?+_method[x]=GET` );
			expect( guard.attempts ).toHaveLength( 25 );
			expect( reached.filter( ( entry ) => entry.startsWith( 'fetch' ) ) ).toEqual( [] );
			expect( reached.filter( ( entry ) => entry.endsWith( 'network' ) ) ).toEqual( [] );

			// An override that names a read, and a request to another host, pass.
			await targets.global.fetch( `${ base }?_method=GET&method=head` );
			await targets.global.fetch( base, { headers: { 'X-HTTP-Method-Override': 'GET' } } );
			await targets.global.fetch( 'https://example.org/x?_method=DELETE' );
			guard.uninstall();
			expect( guard.attempts ).toHaveLength( 25 );
			expect( reached ).toHaveLength( 3 + 6 );
		} );

		// A process's network calls, played by stand-ins that record what reached them.
		function network() {
			const reached: string[] = [];
			const fetchStub = vi.fn( async ( input: RequestInfo | URL, init?: RequestInit ) => {
				reached.push( `fetch ${ init?.method ?? 'GET' } ${ String( input ) }` );
				return new Response( '{}' );
			} );
			const request = ( name: string ) =>
				vi.fn( ( ...args: unknown[] ) => {
					const options = (
						typeof args[ 0 ] === 'object' && ! ( args[ 0 ] instanceof URL ) ? args[ 0 ] : args[ 1 ]
					) as Record< string, unknown > | undefined;
					reached.push(
						`${ name } ${ String( options?.method ?? 'GET' ) } ${
							options?.createConnection ? 'blocked-connection' : 'network'
						}`
					);
					return { on: () => undefined };
				} );
			const targets = {
				global: { fetch: fetchStub as unknown as typeof fetch },
				http: { request: request( 'http' ) },
				https: { request: request( 'https' ) },
			};
			return { reached, targets };
		}

		it( 'fails a case on a write that goes around the mock, by fetch or by the http module, and blocks it', async () => {
			const { reached, targets } = network();
			const guard = installWpcomWriteGuard( {}, targets );
			await expect(
				targets.global.fetch( 'https://public-api.wordpress.com/rest/v1.1/sites/1/posts/new', {
					method: 'POST',
				} )
			).rejects.toThrow( /wpcom-write-under-mock/ );
			await targets.global.fetch( 'https://public-api.wordpress.com/rest/v1.1/me' );
			await targets.global.fetch( 'https://example.org/form', { method: 'POST' } );
			targets.https.request( {
				host: 'public-api.wordpress.com',
				method: 'PUT',
				path: '/wp/v2/sites/1/settings',
			} );
			targets.https.request( new URL( 'https://public-api.wordpress.com/wp/v2/sites/1/posts' ), {
				method: 'GET',
			} );
			guard.uninstall();

			expect( guard.attempts ).toEqual( [
				{
					code: 'wpcom-write-under-mock',
					method: 'POST',
					host: 'wpcom',
					endpoint: 'other',
					via: 'fetch',
				},
				{
					code: 'wpcom-write-under-mock',
					method: 'PUT',
					host: 'wpcom',
					endpoint: 'other',
					via: 'http',
				},
			] );
			expect( reached ).toEqual( [
				'fetch GET https://public-api.wordpress.com/rest/v1.1/me',
				'fetch POST https://example.org/form',
				'https PUT blocked-connection',
				'https GET network',
			] );
			expect( JSON.stringify( guard.attempts ) ).not.toMatch( /sites\/1|public-api/ );
		} );

		it( 'lets Studio’s image service write only in a case labelled as needing it', async () => {
			const images = 'https://public-api.wordpress.com/wpcom/v2/ai-api-proxy/v1/images/generations';
			for ( const allowImageService of [ false, true ] ) {
				const { reached, targets } = network();
				const guard = installWpcomWriteGuard( { allowImageService }, targets );
				const sent = targets.global.fetch( images, { method: 'POST' } );
				if ( allowImageService ) {
					await sent;
					expect( guard.attempts ).toEqual( [] );
					expect( reached ).toEqual( [ `fetch POST ${ images }` ] );
				} else {
					await expect( sent ).rejects.toThrow( /wpcom-write-under-mock/ );
					expect( guard.attempts ).toEqual( [
						expect.objectContaining( { host: 'wpcom-ai-proxy', endpoint: 'images' } ),
					] );
					expect( reached ).toEqual( [] );
				}
				guard.uninstall();
			}
		} );

		it( 'lets model requests reach the WordPress.com AI proxy only on a run whose provider is WordPress.com', async () => {
			const inference =
				'https://public-api.wordpress.com/wpcom/v2/ai-api-proxy/v1/chat/completions';
			const { targets } = network();
			const onWpcom = installWpcomWriteGuard( { allowProxyInference: true }, targets );
			await targets.global.fetch( inference, { method: 'POST' } );
			onWpcom.uninstall();
			expect( onWpcom.attempts ).toEqual( [] );

			const elsewhere = installWpcomWriteGuard( {}, targets );
			await expect( targets.global.fetch( inference, { method: 'POST' } ) ).rejects.toThrow();
			elsewhere.uninstall();
			expect( elsewhere.attempts ).toEqual( [
				expect.objectContaining( { host: 'wpcom-ai-proxy', endpoint: 'other' } ),
			] );
		} );

		describe( 'in a staging case', () => {
			const staging = { id: 4242, url: 'https://staging-4242.wpcomstaging.com/' };

			it.each( [
				[ 'public-api.wordpress.com', '/rest/v1.1/sites/4242/posts/new', true ],
				[ 'public-api.wordpress.com', '/wp/v2/sites/4242/posts', true ],
				[
					'public-api.wordpress.com',
					'/wpcom/v2/sites/4242/studio-app/sync/import/initiate',
					true,
				],
				[ 'public-api.wordpress.com', '/wpcom/v2/sites/staging-4242.wpcomstaging.com/x', true ],
				[ 'public-api.wordpress.com', '/wpcom/v2/sites/STAGING-4242.wpcomstaging.com/x', true ],
				[ 'public-api.wordpress.com', '/rest/v1.1/studio-file-uploads/4242', true ],
				[ 'public-api.wordpress.com', '/rest/v1.1/studio-file-uploads/4242/upload-1', true ],
				[ 'public-api.wordpress.com', '/wp/v2/sites/%34%32%34%32/posts', true ],
				[ 'public-api.wordpress.com', '/rest/v1.1/sites/113/posts/new', false ],
				[ 'public-api.wordpress.com', '/rest/v1.1/sites/04242/posts/new', false ],
				[ 'public-api.wordpress.com', '/rest/v1.1/sites/myprod.wordpress.com/posts/new', false ],
				[ 'public-api.wordpress.com', '/rest/v1.1/me/settings', false ],
				[ 'public-api.wordpress.com', '/wp/v2/sites/4242/../../sites/113/posts', false ],
				[ 'public-api.wordpress.com', '/wp/v2/sites/4242/%2e%2e/%2E%2E/sites/113/posts', false ],
				[ 'public-api.wordpress.com', '/wp/v2/sites/4242%2F..%2F113/posts', false ],
				[ 'public-api.wordpress.com', '/wp/v2//sites/4242/posts', false ],
				[ 'public-api.wordpress.com', '/wp-json/sites/4242/wpcom/v2', false ],
				[ 'public-api.wordpress.com', '/rest/v1.1/studio-file-uploads/113', false ],
				[ 'public-api.wordpress.com', '/wp/v2/sites/%E0%A4%A/posts', false ],
				[ 'myprod.wordpress.com', '/wp-json/wp/v2/posts', false ],
				[ 'staging-4242.wpcomstaging.com', '/wp-json/wp/v2/posts', true ],
				[ 'wordpress.com', '/sites/4242', false ],
			] )( 'decides whether %s%s is the designated site: %s', ( hostname, pathname, expected ) => {
				expect( writesToStagingSite( { hostname, pathname }, staging ) ).toBe( expected );
			} );

			it.each( [
				[ '4242', true ],
				[ ' 4242 ', true ],
				[ 'https://staging-4242.wpcomstaging.com', true ],
				[ 'staging-4242.wpcomstaging.com/', true ],
				[ '113', false ],
				[ '0x1092', false ],
				[ 'https://myprod.wordpress.com', false ],
				[ '', false ],
				[ undefined, false ],
			] )( 'decides whether the remote %j is the designated site: %s', ( remote, expected ) => {
				expect( remoteIsStagingSite( remote, staging ) ).toBe( expected );
			} );

			it( 'lets a write reach the designated site, records it, and refuses one to any other site', async () => {
				const { reached, targets } = network();
				const guard = installWpcomWriteGuard( { stagingSite: staging }, targets );
				const designated = 'https://public-api.wordpress.com/rest/v1.1/sites/4242/posts/new';
				const other = 'https://public-api.wordpress.com/rest/v1.1/sites/113/posts/new';
				await targets.global.fetch( designated, { method: 'POST' } );
				await expect( targets.global.fetch( other, { method: 'POST' } ) ).rejects.toThrow(
					/wpcom-write-outside-staging/
				);
				await expect(
					targets.global.fetch( 'https://public-api.wordpress.com/rest/v1.1/me/settings', {
						method: 'POST',
					} )
				).rejects.toThrow( /wpcom-write-outside-staging/ );
				// The path a request sends, never normalized by the guard: a dot segment is refused.
				targets.https.request( {
					host: 'public-api.wordpress.com',
					method: 'POST',
					path: '/wp/v2/sites/4242/../../sites/113/posts',
				} );
				targets.https.request( {
					host: 'public-api.wordpress.com',
					path: '/wp/v2/sites/4242/posts?_method=DELETE',
				} );
				// Reads of any site still pass.
				await targets.global.fetch( other );
				guard.uninstall();

				expect( guard.attempts ).toEqual( [
					{
						code: 'wpcom-write-outside-staging',
						method: 'POST',
						host: 'wpcom',
						endpoint: 'other',
						via: 'fetch',
					},
					{
						code: 'wpcom-write-outside-staging',
						method: 'POST',
						host: 'wpcom',
						endpoint: 'other',
						via: 'fetch',
					},
					{
						code: 'wpcom-write-outside-staging',
						method: 'POST',
						host: 'wpcom',
						endpoint: 'other',
						via: 'http',
					},
				] );
				expect( guard.allowed ).toEqual( [
					{ method: 'POST', via: 'fetch' },
					{ method: 'DELETE', via: 'http' },
				] );
				expect( reached ).toEqual( [
					`fetch POST ${ designated }`,
					'https POST blocked-connection',
					'https GET network',
					`fetch GET ${ other }`,
				] );
				expect( JSON.stringify( [ guard.attempts, guard.allowed ] ) ).not.toMatch(
					/4242|113|public-api|wpcomstaging/
				);
			} );

			it( 'passes a wpcom_request write on to the designated site only, refusing any other', async () => {
				const original = wpcomRequestTool.handler;
				const passedOn = vi.fn( async ( _args: { siteId: number } ) => ( {
					content: [ { type: 'text' as const, text: '{"ok":true}' } ],
					details: {},
				} ) );
				wpcomRequestTool.handler = passedOn as unknown as typeof wpcomRequestTool.handler;
				const calls: RemoteCall[] = [];
				const refused: Parameters< typeof withMockedWpcomRequest >[ 1 ] = {
					site: staging,
					refused: [],
				};
				const restore = withMockedWpcomRequest( calls, refused );
				try {
					await wpcomRequestTool.handler(
						{ siteId: 4242, method: 'POST', path: '/posts', body: { title: 'Hi' } },
						context()
					);
					await expect(
						wpcomRequestTool.handler(
							{ siteId: 113, method: 'POST', path: '/posts', body: { title: 'Hi' } },
							context()
						)
					).rejects.toThrow( /wpcom-write-outside-staging/ );
					await expect(
						wpcomRequestTool.handler(
							{ siteId: 4242, method: 'POST', path: '!/me/settings', body: {} },
							context()
						)
					).rejects.toThrow( /wpcom-write-outside-staging/ );
					await wpcomRequestTool.handler(
						{ siteId: 113, method: 'GET', path: '/posts' },
						context()
					);
				} finally {
					restore();
					wpcomRequestTool.handler = original;
				}
				expect( passedOn ).toHaveBeenCalledTimes( 2 );
				expect( passedOn.mock.calls.map( ( [ args ] ) => args.siteId ) ).toEqual( [ 4242, 113 ] );
				expect( calls ).toEqual( [
					{
						operation: 'wpcom-request',
						method: 'POST',
						site: '4242',
						target: '/posts',
						designated: true,
					},
					{
						operation: 'wpcom-request',
						method: 'POST',
						site: '113',
						target: '/posts',
						designated: false,
					},
					{
						operation: 'wpcom-request',
						method: 'POST',
						site: '4242',
						target: '!/me/settings',
						designated: false,
					},
				] );
				expect( refused.refused ).toEqual( [
					{
						code: 'wpcom-write-outside-staging',
						method: 'POST',
						host: 'wpcom',
						endpoint: 'other',
						via: 'wpcom-request',
					},
					{
						code: 'wpcom-write-outside-staging',
						method: 'POST',
						host: 'wpcom',
						endpoint: 'other',
						via: 'wpcom-request',
					},
				] );
			} );

			it( 'runs a push or pull only against the designated site, and no preview change', async () => {
				const host = createFakeHost( base );
				const calls: RemoteCall[] = [];
				const refused: Parameters< typeof withStagingRemote >[ 3 ] = [];
				const staged = withStagingRemote( host, calls, staging, refused );
				const onProgress = vi.fn();

				await staged.sync.push( fakeSite, 'all', '4242', onProgress );
				await staged.sync.pull(
					fakeSite,
					'sqls',
					'https://staging-4242.wpcomstaging.com',
					onProgress
				);
				for ( const attempt of [
					() => staged.sync.push( fakeSite, 'all', 'https://myprod.wordpress.com', onProgress ),
					() => staged.sync.push( fakeSite, 'all', undefined, onProgress ),
					() => staged.sync.pull( fakeSite, 'all', '113', onProgress ),
					() => staged.previews.create( fakeSite, onProgress ),
					() => staged.previews.update( fakeSite, 'demo.wp.build', true, onProgress ),
					() => staged.previews.delete( 'demo.wp.build', onProgress ),
				] ) {
					await expect( attempt() ).rejects.toThrow( /wpcom-write-outside-staging/ );
				}

				expect( host.sync.push ).toHaveBeenCalledTimes( 1 );
				expect( host.sync.push ).toHaveBeenCalledWith( fakeSite, 'all', '4242', onProgress );
				expect( host.sync.pull ).toHaveBeenCalledTimes( 1 );
				for ( const preview of [
					host.previews.create,
					host.previews.update,
					host.previews.delete,
				] ) {
					expect( preview ).not.toHaveBeenCalled();
				}
				expect( calls.map( ( call ) => [ call.operation, call.designated ] ) ).toEqual( [
					[ 'push', true ],
					[ 'pull', true ],
					[ 'push', false ],
					[ 'push', false ],
					[ 'pull', false ],
					[ 'preview-create', false ],
					[ 'preview-update', false ],
					[ 'preview-delete', false ],
				] );
				expect( refused ).toHaveLength( 6 );
				expect( new Set( refused.map( ( attempt ) => attempt.code ) ) ).toEqual(
					new Set( [ 'wpcom-write-outside-staging' ] )
				);
				expect( refused.every( ( attempt ) => attempt.via === 'remote-operation' ) ).toBe( true );
			} );
		} );

		it( 'gives a blocked request a connection that fails without reaching the network', async () => {
			const server = http.createServer( ( _request, response ) => response.end() );
			let connections = 0;
			server.on( 'connection', () => connections++ );
			await new Promise< void >( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
			const { port } = server.address() as { port: number };
			// A loopback server of the test's own, which the request must never reach.
			nock.enableNetConnect( '127.0.0.1' );
			try {
				const error = await new Promise< Error >( ( resolve ) => {
					const request = http.request( {
						host: '127.0.0.1',
						port,
						method: 'POST',
						...blockedConnectionOptions(),
					} );
					request.on( 'error', resolve );
					request.end( 'body' );
				} );
				expect( error.message ).toMatch( /wpcom-write-under-mock/ );
				expect( connections ).toBe( 0 );
			} finally {
				nock.disableNetConnect();
				nock.enableNetConnect( 'raw.githubusercontent.com' );
				await new Promise( ( resolve ) => server.close( resolve ) );
			}
		} );
	} );

	describe( 'attachments', () => {
		it( 'finds the repository fixtures, or the folder the environment names', () => {
			expect( findEvalFixturesDir( import.meta.dirname, {} ) ).toBe( repositoryFixtures );
			expect( findEvalFixturesDir( base, { STUDIO_EVAL_FIXTURES_DIR: base } ) ).toBe( base );
			expect( findEvalFixturesDir( os.tmpdir(), {} ) ).toBeNull();
		} );

		it( 'sends an image fixture as image input and a document by its absolute path', () => {
			const loaded = loadEvalAttachments(
				[ { fixture: 'red-swatch.png' }, { fixture: 'project-brief.md' } ],
				repositoryFixtures
			);
			if ( 'missing' in loaded ) {
				throw new Error( `missing ${ loaded.missing }` );
			}
			expect( loaded.images ).toHaveLength( 1 );
			expect( loaded.images[ 0 ] ).toMatchObject( {
				name: 'red-swatch.png',
				mimeType: 'image/png',
			} );
			expect(
				Buffer.from( loaded.images[ 0 ].dataBase64, 'base64' ).subarray( 1, 4 ).toString()
			).toBe( 'PNG' );
			expect( loaded.files ).toEqual( [
				expect.objectContaining( {
					name: 'project-brief.md',
					path: path.join( repositoryFixtures, 'project-brief.md' ),
				} ),
			] );
			expect( loaded.promptBlock ).toContain( path.join( repositoryFixtures, 'project-brief.md' ) );
			expect( loaded.summary ).toEqual( [
				{ fixture: 'red-swatch.png', kind: 'image' },
				{ fixture: 'project-brief.md', kind: 'file' },
			] );
		} );

		it( 'names a fixture that is missing instead of running without it', () => {
			expect( loadEvalAttachments( [ { fixture: 'nope.png' } ], repositoryFixtures ) ).toEqual( {
				missing: 'nope.png',
			} );
		} );
	} );

	describe( 'seeded history', () => {
		it( 'writes user and assistant messages as the route records them, with the context size a reply reported', () => {
			const [ user, assistant ] = evalHistoryMessages(
				[
					{ role: 'user', text: 'The codename is AURORA-7.' },
					{ role: 'assistant', text: 'Noted.', contextTokens: 190_000 },
				],
				{ provider: 'studio-chatgpt', api: 'openai-responses', model: 'gpt-6-luna' },
				1_000
			);
			expect( user ).toEqual( {
				role: 'user',
				content: [ { type: 'text', text: 'The codename is AURORA-7.' } ],
				timestamp: 1_000,
			} );
			expect( assistant ).toMatchObject( {
				role: 'assistant',
				content: [ { type: 'text', text: 'Noted.' } ],
				provider: 'studio-chatgpt',
				api: 'openai-responses',
				model: 'gpt-6-luna',
				stopReason: 'stop',
				usage: { input: 190_000, totalTokens: 190_000 },
				timestamp: 1_001,
			} );
		} );
	} );
} );
