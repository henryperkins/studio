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
// The method of each request, in the same order.
const methods: string[] = [];
let stopServer: () => Promise< void >;

beforeAll( async () => {
	const server = createServer( ( request, response ) => {
		received.push( request.url ?? '' );
		methods.push( request.method ?? '' );
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
	methods.length = 0;
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
		[
			{ siteId: 1, method: 'GET', path: '!/plans/features', apiNamespace: 'wpcom/v2' },
			'/wpcom/v2/plans/features',
		],
		[
			{ siteId: 42, method: 'POST', path: '/posts', query: { context: 'edit' }, body: {} },
			'/wp/v2/sites/42/posts?context=edit',
		],
		[ { siteId: 42, method: 'PUT', path: 'pages/4', body: {} }, '/wp/v2/sites/42/pages/4' ],
	];
	for ( const [ args, request ] of allowed ) {
		const decided = scope( args );
		expect( decided, JSON.stringify( args ) ).toBeDefined();
		expect( await send( args ) ).toEqual( [ request ] );
		const site = /^\/[^/]+\/v[\d.]+\/sites\/(\d+)\//.exec( request )?.[ 1 ];
		// What an approval shows is the request the client sent: its method and path.
		expect( decided ).toEqual( {
			...( site === undefined ? {} : { wpcomSiteId: Number( site ) } ),
			request: { method: methods[ 0 ], path: request.split( '?' )[ 0 ] },
		} );
	}
} );

it( 'shows a change as the POST the client sends, and refuses a DELETE, which the client sends as a POST that deletes nothing', async () => {
	const scope = CLAUDE_STUDIO_TOOL_RULES.get( 'wpcom_request' )!.remote!;
	for ( const method of [ 'POST', 'PUT', 'DELETE' ] ) {
		await send( {
			siteId: 42,
			method,
			path: '/posts/9',
			body: method === 'DELETE' ? undefined : {},
		} );
		expect( [ methods, received ], method ).toEqual( [
			[ 'POST' ],
			[ '/wp/v2/sites/42/posts/9' ],
		] );
	}
	expect( scope( { siteId: 42, method: 'PUT', path: '/posts/9' } ) ).toEqual( {
		wpcomSiteId: 42,
		request: { method: 'POST', path: '/wp/v2/sites/42/posts/9' },
	} );
	expect( scope( { siteId: 42, method: 'DELETE', path: '/posts/9' } ) ).toBeUndefined();
	expect( scope( { siteId: 42, method: 'PATCH', path: '/posts/9' } ) ).toBeUndefined();
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
		{
			siteId: 1,
			method: 'GET',
			path: '!/plans/features',
			apiNamespace: 'rest/v1.1/sites/7/posts#',
		},
		{ siteId: 42, method: 'GET', path: '/posts', query: { proxyOrigin: 'http://127.0.0.1:9' } },
	] )
		expect( scope( args ), JSON.stringify( args ) ).toBeUndefined();
} );

it( 'reads no account profile: the client would send it, but it names the account and its primary site', async () => {
	const scope = CLAUDE_STUDIO_TOOL_RULES.get( 'wpcom_request' )!.remote!;
	for ( const apiNamespace of [ '', 'wpcom/v2', undefined ] )
		for ( const path of [ '!/me', '!/me/', '!/me/sites', '!/ME' ] )
			expect(
				scope( { siteId: 1, method: 'GET', path, apiNamespace } ),
				`${ path } ${ apiNamespace }`
			).toBeUndefined();
	expect( await send( { siteId: 1, method: 'GET', path: '!/me', apiNamespace: '' } ) ).toEqual( [
		'/rest/v1.1/me',
	] );
} );

// The site in a path the server received, or `null` for an account path.
function receivedScope( request: string ): { wpcomSiteId?: number } | null | undefined {
	const route = /^\/(?:rest\/v1\.1|wp\/v2|wpcom\/v2)(\/[^?]*)/.exec( request )?.[ 1 ];
	if ( route === undefined ) return;
	const site = /^\/sites\/(\d+)(?:\/|$)/.exec( route )?.[ 1 ];
	if ( site !== undefined ) return { wpcomSiteId: Number( site ) };
	return route === '/plans/features' ? null : undefined;
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
			decided.wpcomSiteId === undefined ? null : { wpcomSiteId: decided.wpcomSiteId }
		);
		// The path an approval would show is the path the client sent.
		expect( received[ 0 ].split( '?' )[ 0 ], JSON.stringify( args ) ).toBe( decided.request?.path );
	}
	// The table holds legitimate requests too, so the comparison above really ran.
	expect( allowed ).toBeGreaterThanOrEqual( 30 );
} );

// The query keys the eval harness's reviewed checklist refuses, spelled every
// way the client or the server could read them as the same key, and more.
const REFUSED_KEYS = [
	// What the client lifts out of the query into where the request goes.
	'apiNamespace',
	'APINAMESPACE',
	' apiNamespace',
	'apiNamespace ',
	'api_namespace',
	'apiVersion',
	'apiversion',
	'proxyOrigin',
	'PROXYORIGIN',
	'proxy%4Frigin',
	// What WordPress reads as another method: PHP folds `.`, spaces and `[`
	// into `_`, drops leading spaces and makes `_method[]` the same key.
	'_method',
	'_METHOD',
	'.method',
	' _method',
	' method',
	'_method[]',
	'_method[0]',
	'%5Fmethod',
	'%5fmethod',
	'method',
	'Method',
	'me.thod',
	'http_method_override',
	// What WordPress reads in place of the path's route.
	'rest_route',
	'REST_ROUTE',
	'rest.route',
	'rest route',
	' rest_route',
	'rest_route[]',
	'restRoute',
	'%72est_route',
	// A key with a control character, which the server may read as anything.
	'per_page\u0000',
	'\t_method',
	'%00method',
];

it( 'refuses every query key that changes where a request goes, its method or its route, however it is spelled', () => {
	const scope = CLAUDE_STUDIO_TOOL_RULES.get( 'wpcom_request' )!.remote!;
	for ( const key of REFUSED_KEYS )
		for ( const method of [ 'GET', 'POST' ] )
			expect(
				scope( { siteId: 42, method, path: '/posts', query: { [ key ]: 'x' } } ),
				`${ method } ${ JSON.stringify( key ) }`
			).toBeUndefined();
	for ( const key of [ 'per_page', '_fields', 'fields', 'status', 'context', 'methods', 'page' ] )
		expect(
			scope( { siteId: 42, method: 'GET', path: '/posts', query: { [ key ]: '1' } } ),
			key
		).toMatchObject( { wpcomSiteId: 42 } );
} );

it( 'refuses in a path what only a query or fragment needs, raw or escaped, so a proxy that decodes a path before splitting it reads the same path', () => {
	const scope = CLAUDE_STUDIO_TOOL_RULES.get( 'wpcom_request' )!.remote!;
	for ( const suffix of [
		'/posts%3Fstatus=draft',
		'/posts%3fstatus',
		'/posts%23top',
		'/posts%26status',
		'/posts%3Dx',
		'/posts%3dx',
		'/posts&status',
		'/posts=x',
		'/posts/1&_method=DELETE',
	] )
		for ( const method of [ 'GET', 'POST' ] )
			for ( const path of [ suffix, `!/sites/42${ suffix }` ] )
				expect( scope( { siteId: 42, method, path } ), `${ method } ${ path }` ).toBeUndefined();
	// What a route needs stays: escapes of other characters, and `+`, `,`, `:`, `@`.
	for ( const path of [
		'/media/caf%C3%A9',
		'/posts/1:2',
		'/users/a+b',
		'/tags/a,b',
		'/users/@me',
	] )
		expect( scope( { siteId: 42, method: 'GET', path } ), path ).toMatchObject( {
			wpcomSiteId: 42,
		} );
} );

it( 'refuses a `.` segment, which the parser would drop from the path it decides on', () => {
	const scope = CLAUDE_STUDIO_TOOL_RULES.get( 'wpcom_request' )!.remote!;
	for ( const path of [
		'/./posts',
		'/posts/.',
		'./posts',
		'!/sites/42/./posts',
		'!/./sites/42/posts',
	] )
		expect( scope( { siteId: 42, method: 'GET', path } ), path ).toBeUndefined();
} );

it( 'lets a request change a site only through that site’s WordPress REST API, under the site, never the legacy or WordPress.com APIs or the account', () => {
	const scope = CLAUDE_STUDIO_TOOL_RULES.get( 'wpcom_request' )!.remote!;
	const changes: Array< [ Record< string, unknown >, { wpcomSiteId: number } | undefined ] > = [
		[ { path: '/posts' }, { wpcomSiteId: 42 } ],
		[ { path: 'posts/7' }, { wpcomSiteId: 42 } ],
		[ { path: '/posts', apiNamespace: 'wp/v2' }, { wpcomSiteId: 42 } ],
		[ { path: '!/sites/42/posts', apiNamespace: 'wp/v2' }, { wpcomSiteId: 42 } ],
		[ { path: '/templates/twentytwentyfour//home' }, { wpcomSiteId: 42 } ],
		[ { path: '/plugins/akismet/akismet' }, { wpcomSiteId: 42 } ],
		// The legacy site API, whose bodies can name another site (a reblog's
		// `destination_site_id`, a follow, a like), and WordPress.com's own.
		[ { path: '/settings', apiNamespace: '' }, undefined ],
		[ { path: '/posts/1/reblogs/new', apiNamespace: '' }, undefined ],
		[ { path: '/plugins/akismet/install', apiNamespace: '' }, undefined ],
		[ { path: '!/sites/42/posts/new', apiNamespace: '' }, undefined ],
		[ { path: '/studio-app/sync/import/initiate', apiNamespace: 'wpcom/v2' }, undefined ],
		// The site itself rather than something in it, or an empty segment there.
		[ { path: '/' }, undefined ],
		[ { path: '' }, undefined ],
		[ { path: '!/sites/42', apiNamespace: 'wp/v2' }, undefined ],
		[ { path: '//posts' }, undefined ],
		// The account.
		[ { path: '!/me', apiNamespace: '' }, undefined ],
		[ { path: '!/me/settings', apiNamespace: '' }, undefined ],
		[ { path: '!/plans/features', apiNamespace: 'wpcom/v2' }, undefined ],
	];
	for ( const method of [ 'POST', 'PUT' ] )
		for ( const [ args, decided ] of changes ) {
			const label = `${ method } ${ JSON.stringify( args ) }`;
			if ( decided )
				expect( scope( { siteId: 42, method, ...args } ), label ).toMatchObject( decided );
			else expect( scope( { siteId: 42, method, ...args } ), label ).toBeUndefined();
		}
	// A DELETE changes nothing anywhere: the client would send it as a POST.
	for ( const [ args ] of changes )
		expect(
			scope( { siteId: 42, method: 'DELETE', ...args } ),
			JSON.stringify( args )
		).toBeUndefined();
	// What the same paths read, for comparison: reads may use every namespace.
	expect(
		scope( { siteId: 42, method: 'GET', path: '/settings', apiNamespace: '' } )
	).toMatchObject( { wpcomSiteId: 42 } );
	expect( scope( { siteId: 42, method: 'GET', path: '/' } ) ).toMatchObject( { wpcomSiteId: 42 } );
	const account = scope( {
		siteId: 1,
		method: 'GET',
		path: '!/plans/features',
		apiNamespace: 'wpcom/v2',
	} );
	expect( account ).toBeDefined();
	expect( account?.wpcomSiteId ).toBeUndefined();
	expect( scope( { siteId: 1, method: 'GET', path: '!/me', apiNamespace: '' } ) ).toBeUndefined();
} );
