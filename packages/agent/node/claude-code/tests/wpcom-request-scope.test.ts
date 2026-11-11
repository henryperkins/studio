import { createServer } from 'http';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createFakeHost } from '../../tests/fake-host';
import { wpcomRequestTool } from '../../tools/wpcom-request';
import { CLAUDE_STUDIO_TOOL_RULES } from '../execution-rules';
import type { AddressInfo } from 'net';

// The real WordPress.com client sends each request here instead of to its
// default origin, so the test sees exactly the request the tool would send.
const local = vi.hoisted( () => ( { origin: '' } ) );

vi.mock( '@studio/common/lib/shared-config', async ( importOriginal ) => ( {
	...( await importOriginal< object >() ),
	readAuthToken: async () => ( { accessToken: 'test-token', id: 1 } ),
} ) );
vi.mock( '@studio/common/lib/wpcom-xhr-request-factory', async () => {
	const actual = await vi.importActual< {
		default: ( options: Record< string, unknown >, callback: unknown ) => unknown;
	} >( '@studio/common/lib/wpcom-xhr-request-factory' );
	return {
		default: ( options: Record< string, unknown >, callback: unknown ) =>
			actual.default(
				options.proxyOrigin === undefined ? { ...options, proxyOrigin: local.origin } : options,
				callback
			),
	};
} );

const received: string[] = [];
let stopServer: () => Promise< void >;

beforeAll( async () => {
	const server = createServer( ( request, response ) => {
		received.push( request.url ?? '' );
		response.setHeader( 'content-type', 'application/json' );
		response.end( '{}' );
	} );
	await new Promise< void >( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
	local.origin = `http://127.0.0.1:${ ( server.address() as AddressInfo ).port }`;
	stopServer = () => new Promise( ( resolve ) => server.close( () => resolve() ) );
} );
afterAll( () => stopServer() );

async function send( args: Record< string, unknown > ): Promise< string[] > {
	received.length = 0;
	await wpcomRequestTool.handler( args as never, {
		host: createFakeHost(),
		onProgress: () => {},
	} );
	return [ ...received ];
}

it( 'decides from the request the WordPress.com client actually sends', async () => {
	const scope = CLAUDE_STUDIO_TOOL_RULES.get( 'wpcom_request' )!.remote!;
	const allowed: Array< [ Record< string, unknown >, string ] > = [
		[ { siteId: 42, method: 'GET', path: '/posts' }, '/wp/v2/sites/42/posts' ],
		[
			{ siteId: 42, method: 'GET', path: '!/sites/42/posts', apiNamespace: 'wpcom/v2' },
			'/wpcom/v2/sites/42/posts',
		],
		[
			{
				siteId: 42,
				method: 'GET',
				path: '/settings',
				apiNamespace: '',
				query: { fields: 'title' },
			},
			'/rest/v1.1/sites/42/settings?fields=title',
		],
		[ { siteId: 1, method: 'GET', path: '!/me', apiNamespace: '' }, '/rest/v1.1/me' ],
	];
	for ( const [ args, request ] of allowed ) {
		const decided = scope( args );
		expect( decided, JSON.stringify( args ) ).toBeDefined();
		expect( await send( args ) ).toEqual( [ request ] );
		const site = /^\/[^/]+\/v[\d.]+\/sites\/(\d+)\//.exec( request )?.[ 1 ];
		expect( decided ).toEqual( site === undefined ? {} : { wpcomSiteId: Number( site ) } );
	}
} );

it( 'denies the requests that would reach another site or origin than they name', async () => {
	const scope = CLAUDE_STUDIO_TOOL_RULES.get( 'wpcom_request' )!.remote!;
	const toSiteSeven = {
		siteId: 42,
		method: 'GET',
		path: '/sites/42/posts',
		apiNamespace: 'wp/v2/sites/7/posts#',
	};
	// The client really does send it to site 7, so the scope must refuse it.
	expect( await send( toSiteSeven ) ).toEqual( [ '/wp/v2/sites/7/posts' ] );
	for ( const args of [
		toSiteSeven,
		{ ...toSiteSeven, apiNamespace: 'wp/v2/sites/7/posts?x=' },
		{ siteId: 1, method: 'GET', path: '!/me', apiNamespace: 'rest/v1.1/sites/7/posts#' },
		{ siteId: 42, method: 'GET', path: '/posts', query: { proxyOrigin: 'http://127.0.0.1:9' } },
	] )
		expect( scope( args ), JSON.stringify( args ) ).toBeUndefined();
} );
