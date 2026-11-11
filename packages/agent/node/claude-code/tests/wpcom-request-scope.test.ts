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

// The site in a path the server received, or `null` for an account path.
function receivedScope( request: string ): { wpcomSiteId?: number } | null | undefined {
	const route = /^\/(?:rest\/v1\.1|wp\/v2|wpcom\/v2)(\/[^?]*)/.exec( request )?.[ 1 ];
	if ( route === undefined ) return;
	const site = /^\/sites\/(\d+)(?:\/|$)/.exec( route )?.[ 1 ];
	if ( site !== undefined ) return { wpcomSiteId: Number( site ) };
	return [ '/me', '/plans/features' ].includes( route ) ? null : undefined;
}

it( 'denies paths the client would normalize onto another site, which it really does', async () => {
	const scope = CLAUDE_STUDIO_TOOL_RULES.get( 'wpcom_request' )!.remote!;
	for ( const args of [
		{ siteId: 42, method: 'GET', path: '/.\t./7/posts' },
		{ siteId: 42, method: 'GET', path: '/.\n./7/posts' },
		{ siteId: 42, method: 'GET', path: '/.\r./7/posts' },
		{ siteId: 42, method: 'GET', path: '!/sites/42/.\t./7/posts' },
	] ) {
		expect( await send( args ), JSON.stringify( args ) ).toEqual( [ '/wp/v2/sites/7/posts' ] );
		expect( scope( args ), JSON.stringify( args ) ).toBeUndefined();
	}
} );

it( 'either denies a hostile path or sends it to exactly the site it allowed', async () => {
	const scope = CLAUDE_STUDIO_TOOL_RULES.get( 'wpcom_request' )!.remote!;
	const suffixes = [
		'/posts',
		'posts',
		'/./posts',
		'/templates/twentytwentyfour//home',
		'/media/caf%C3%A9',
		'/.\t./7/posts',
		'/.\n./7/posts',
		'/.\r./7/posts',
		'/\t../7/posts',
		'/..\t/7/posts',
		'/.\u000b./7/posts',
		'/.\u000c./7/posts',
		'/.\u0000./7/posts',
		'/ ../7/posts',
		'/.. /7/posts',
		'/../7/posts',
		'/./../7/posts',
		'/%2e%2e/7/posts',
		'/%2E%2E/7/posts',
		'/.%2e/7/posts',
		'/%2e./7/posts',
		'/..%2f7/posts',
		'/%2f..%2f7/posts',
		'/..%5c7/posts',
		'/..%5C7/posts',
		'/..\\7/posts',
		'\\..\\7\\posts',
		'/..;/7/posts',
		'/%252e%252e/7/posts',
		'/.%09./7/posts',
		'/.%0a./7/posts',
		'/.%0D./7/posts',
		'/.%00./7/posts',
		'/.%7f./7/posts',
		'/%c0%ae%c0%ae/7/posts',
		'/%e0%80%ae%e0%80%ae/7/posts',
		'/%ff/7/posts',
		'/\u3002\u3002/7/posts',
		'/\uff0e\uff0e/7/posts',
		'/.\u00ad./7/posts',
		'/..\u2028/7/posts',
		'/posts#/../../7',
		'/posts?/../../7',
		'//7/posts',
		'/../../../rest/v1.1/me',
	];
	const cases: Array< Record< string, unknown > > = [];
	for ( const suffix of suffixes )
		for ( const apiNamespace of [ undefined, '', 'wpcom/v2' ] ) {
			cases.push( { siteId: 42, method: 'GET', path: suffix, apiNamespace } );
			cases.push( { siteId: 42, method: 'GET', path: `!/sites/42${ suffix }`, apiNamespace } );
		}
	for ( const path of [
		'!/sites/7/posts',
		'!/sites/42',
		'!//sites/7/posts',
		'!/sites/042/posts',
		'!/sites/+7/posts',
		'!/sites/4\t2/posts',
		'!/sites/42%2f..%2f7/posts',
		'!/me',
		'!/me/../sites/7/posts',
		'!/me\t',
		'!/ME',
		'!/plans/features',
		'!sites/7/posts',
		'!/sites/9007199254740993/posts',
	] )
		cases.push( { siteId: 42, method: 'GET', path, apiNamespace: '' } );
	for ( const siteId of [ '7', 42.5, -7, 0, 7, Number.MAX_SAFE_INTEGER + 2 ] )
		cases.push( { siteId, method: 'GET', path: '/posts' } );

	let allowed = 0;
	for ( const args of cases ) {
		const decided = scope( args );
		if ( decided === undefined ) continue;
		allowed++;
		const received = await send( args );
		expect( received, JSON.stringify( args ) ).toHaveLength( 1 );
		expect( receivedScope( received[ 0 ] ), JSON.stringify( args ) ).toEqual(
			decided.wpcomSiteId === undefined ? null : decided
		);
	}
	// The table holds legitimate requests too, so the comparison above really ran.
	expect( allowed ).toBeGreaterThanOrEqual( 30 );
} );
