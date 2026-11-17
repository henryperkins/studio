import path from 'path';
import { getAiPayloadsPath } from '@studio/common/lib/well-known-paths';

// What a `wpcom_request` call may reach on WordPress.com: the request it would
// send, composed and parsed as the tool and its client compose and parse it.

function isRecord( value: unknown ): value is Record< string, unknown > {
	return !! value && typeof value === 'object' && ! Array.isArray( value );
}

/**
 * Where a request goes: a WordPress.com site, or the account when absent; and
 * the request as Studio's WordPress.com client sends it.
 */
export interface WpcomScope {
	readonly wpcomSiteId?: number;
	readonly request: { readonly method: string; readonly path: string };
}

// The method the WordPress.com client sends for each method the tool takes. It
// sends a PUT as a POST, which WordPress reads alike for every route that
// takes both, and a DELETE as a POST without a body, which deletes nothing,
// so a DELETE is refused rather than approved as something it is not.
const SENT_METHODS: Readonly< Record< string, 'GET' | 'POST' > > = Object.freeze(
	Object.assign( Object.create( null ), { GET: 'GET', POST: 'POST', PUT: 'POST' } )
);

// The only endpoint outside a site a request may reach: WordPress.com's plan
// features, which the hosting-plans skill reads, a public catalog that names
// no account. The account's profile (`/me`) is not read: it holds the
// account's name, e-mail and primary site, which in a conversation bound to
// one site would hand the provider another site's identity.
const WPCOM_ACCOUNT_READS: ReadonlySet< string > = new Set( [ '/plans/features' ] );

// API namespaces a request may use. An absent namespace means the tool's own
// default; an empty one means WordPress.com REST v1.1.
const WPCOM_NAMESPACES: ReadonlySet< string > = new Set( [ '', 'wp/v2', 'wpcom/v2' ] );

// The only namespace a request may change something through: the site's own
// WordPress REST API. A change through the legacy site API (v1.1) or
// WordPress.com's own (`wpcom/v2`), though addressed to the site, can act on
// another site or on the account through its body (a reblog's
// `destination_site_id`, a follow, a like), so it is refused.
const WPCOM_CHANGE_NAMESPACE = 'wp/v2';

// Query keys a request may not carry: those the WordPress.com client lifts out
// of the query into where the request goes (`apiNamespace`, `apiVersion`,
// `proxyOrigin`), those WordPress reads as another method (`_method`, and
// `method` and `http_method_override`, refused as well), and `rest_route`,
// which WordPress reads in place of the path's route.
const WPCOM_REFUSED_KEYS: ReadonlySet< string > = new Set( [
	'apinamespace',
	'apiversion',
	'proxyorigin',
	'_method',
	'method',
	'http_method_override',
	'rest_route',
] );
const WPCOM_REFUSED_LETTERS: ReadonlySet< string > = new Set(
	[ ...WPCOM_REFUSED_KEYS ].map( ( key ) => key.replace( /_/g, '' ) )
);

const hasControlCharacter = ( text: string ) =>
	[ ...text ].some( ( character ) => character < ' ' || character === '\u007f' );

function decodedKey( key: string ): string {
	try {
		return decodeURIComponent( key );
	} catch {
		return key;
	}
}

/**
 * Whether a query key is one a request may not carry, however the client or
 * the server could read it: decoded once; trimmed of the leading whitespace
 * PHP drops; up to a `[`, which makes `_method[]` the same key; with `.`,
 * whitespace and `[` folded into `_` as PHP folds them; in any case; and also
 * by its letters and digits alone. A key with a control character is refused
 * outright. Stricter than the server, as the eval harness's checklist is: a
 * read refused here costs the model one retry.
 */
export function isRefusedWpcomQueryKey( key: string ): boolean {
	const decoded = decodedKey( key );
	if ( hasControlCharacter( key ) || hasControlCharacter( decoded ) ) return true;
	const stripped = decoded.replace( /^\s+/, '' );
	const bracket = stripped.indexOf( '[' );
	const base = bracket > 0 ? stripped.slice( 0, bracket ) : stripped;
	return (
		WPCOM_REFUSED_KEYS.has( base.replace( /[.\s[]/g, '_' ).toLowerCase() ) ||
		WPCOM_REFUSED_KEYS.has( stripped.trim().toLowerCase() ) ||
		WPCOM_REFUSED_LETTERS.has( decoded.replace( /[^a-z0-9]/gi, '' ).toLowerCase() )
	);
}

// The origin the WordPress.com client sends to unless a transport option, which
// the scope refuses, names another.
const WPCOM_API_ORIGIN = 'https://public-api.wordpress.com';

// A request path: printable ASCII path characters, and percent-escapes that do
// not decode to whitespace, a control character, '%', '.', '/' or '\', nor to
// what only a query or fragment needs, '?', '#', '&' or '='. No query,
// fragment, '&', '=', backslash or raw whitespace, and no `.` or `..` segment:
// a proxy that decodes a path before it splits off the query reads the same
// path.
const WPCOM_PATH =
	/^(?:[A-Za-z0-9\-._~!$'()*+,:@/]|%(?![01][0-9a-f]|2[0356ef]|3[df]|5c|7f)[0-9a-f]{2})*$/i;

function isWpcomPath( value: string ): boolean {
	if ( ! WPCOM_PATH.test( value ) || value.includes( '..' ) || value.split( '/' ).includes( '.' ) )
		return false;
	try {
		decodeURIComponent( value );
		return true;
	} catch {
		return false;
	}
}

// The WordPress.com scope of a `wpcom_request` call. The path must match the
// grammar above; the URL is then composed exactly as the tool and client
// compose it, parsed as the client parses it, and the scope is the site in
// that parsed path, which for a relative path must be the site it names. A
// read may use any allowed namespace and reach WordPress.com's plan features;
// a change only goes through the site's WordPress REST API, to something
// under the site. With the scope comes the request as it is sent,
// its method and path, which is what an approval shows.
export function wpcomScope( args: unknown ): WpcomScope | undefined {
	if ( ! isRecord( args ) || typeof args.path !== 'string' ) return;
	const method = typeof args.method === 'string' ? SENT_METHODS[ args.method ] : undefined;
	if ( ! method ) return;
	if (
		args.apiNamespace !== undefined &&
		( typeof args.apiNamespace !== 'string' || ! WPCOM_NAMESPACES.has( args.apiNamespace ) )
	)
		return;
	if (
		args.query !== undefined &&
		( ! isRecord( args.query ) || Object.keys( args.query ).some( isRefusedWpcomQueryKey ) )
	)
		return;
	const absolute = args.path.startsWith( '!' );
	const requested = absolute ? args.path.slice( 1 ) : args.path;
	if ( ( absolute && ! requested.startsWith( '/' ) ) || ! isWpcomPath( requested ) ) return;
	const siteId = args.siteId;
	if ( ! absolute && ! ( Number.isSafeInteger( siteId ) && ( siteId as number ) > 0 ) ) return;
	const fullPath = absolute
		? requested
		: `/sites/${ siteId as number }${ requested.startsWith( '/' ) ? '' : '/' }${ requested }`;
	const namespace = args.apiNamespace ?? 'wp/v2';
	const base = namespace ? `/${ namespace }` : '/rest/v1.1';
	let url: URL;
	try {
		url = new URL( `${ WPCOM_API_ORIGIN }${ base }${ fullPath }` );
	} catch {
		return;
	}
	if (
		url.origin !== WPCOM_API_ORIGIN ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		! url.pathname.startsWith( `${ base }/` )
	)
		return;
	const route = url.pathname.slice( base.length );
	const reads = method === 'GET';
	const request = { method, path: url.pathname };
	const site = /^\/sites\/([1-9]\d*)(?:\/|$)/.exec( route );
	if ( site ) {
		const id = Number( site[ 1 ] );
		if ( ! Number.isSafeInteger( id ) || ( ! absolute && id !== siteId ) ) return;
		// A change reaches something in the site: a first segment after it.
		if (
			! reads &&
			( namespace !== WPCOM_CHANGE_NAMESPACE || ! /^\/sites\/[1-9]\d*\/[^/]/.test( route ) )
		)
			return;
		return { wpcomSiteId: id, request };
	}
	return absolute && reads && WPCOM_ACCOUNT_READS.has( route ) ? { request } : undefined;
}

/**
 * The files a `wpcom_request` call names in Studio's payload folder, resolved
 * as the tool resolves them, and that folder. Only a change sends files; a
 * read or a call that names one other than by a string is refused.
 */
export function wpcomBodyFiles( args: unknown ): { folder: string; files: string[] } | undefined {
	if ( ! isRecord( args ) ) return;
	const { bodyFile, bodyFiles } = args;
	if ( bodyFiles !== undefined && ! isRecord( bodyFiles ) ) return;
	const named = [
		...( bodyFile === undefined ? [] : [ bodyFile ] ),
		...Object.values( bodyFiles ?? {} ),
	];
	const folder = getAiPayloadsPath();
	if ( ! named.length ) return { folder, files: [] };
	if (
		typeof args.method !== 'string' ||
		SENT_METHODS[ args.method ] !== 'POST' ||
		! named.every( ( file ): file is string => typeof file === 'string' )
	)
		return;
	return { folder, files: named.map( ( file ) => path.resolve( folder, file ) ) };
}
