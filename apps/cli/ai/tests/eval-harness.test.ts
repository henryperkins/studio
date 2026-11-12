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
	evalHistoryMessages,
	findEvalFixturesDir,
	installWpcomWriteGuard,
	loadEvalAttachments,
	withMockedRemote,
	withMockedWpcomRequest,
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
