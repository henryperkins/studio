// What a `wpcom_request` call may reach on WordPress.com: the request it would
// send, composed and parsed as the tool and its client compose and parse it.

function isRecord( value: unknown ): value is Record< string, unknown > {
	return !! value && typeof value === 'object' && ! Array.isArray( value );
}

// The only account endpoints a request may reach: reads the bundled skills use.
const WPCOM_ACCOUNT_READS: ReadonlySet< string > = new Set( [ '/me', '/plans/features' ] );

// API namespaces a request may use. An absent namespace means the tool's own
// default; an empty one means WordPress.com REST v1.1.
const WPCOM_NAMESPACES: ReadonlySet< string > = new Set( [ '', 'wp/v2', 'wpcom/v2' ] );

// Query keys the WordPress.com client turns into where the request goes, or
// that WordPress reads as another method.
const WPCOM_TRANSPORT_KEYS: ReadonlySet< string > = new Set( [
	'apinamespace',
	'apiversion',
	'proxyorigin',
	'_method',
	'method',
	'http_method_override',
] );

// The origin the WordPress.com client sends to unless a transport option, which
// the scope refuses, names another.
const WPCOM_API_ORIGIN = 'https://public-api.wordpress.com';

// A request path: printable ASCII path characters, and percent-escapes that do
// not decode to whitespace, a control character, '%', '.', '/' or '\'. No
// query, fragment, backslash or raw whitespace.
const WPCOM_PATH =
	/^(?:[A-Za-z0-9\-._~!$&'()*+,=:@/]|%(?![01][0-9a-f]|2[05ef]|5c|7f)[0-9a-f]{2})*$/i;

function isWpcomPath( value: string ): boolean {
	if ( ! WPCOM_PATH.test( value ) || value.includes( '..' ) ) return false;
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
// that parsed path, which for a relative path must be the site it names.
export function wpcomScope( args: unknown ): { wpcomSiteId?: number } | undefined {
	if ( ! isRecord( args ) || typeof args.path !== 'string' ) return;
	if (
		args.apiNamespace !== undefined &&
		( typeof args.apiNamespace !== 'string' || ! WPCOM_NAMESPACES.has( args.apiNamespace ) )
	)
		return;
	if (
		args.query !== undefined &&
		( ! isRecord( args.query ) ||
			Object.keys( args.query ).some( ( key ) => WPCOM_TRANSPORT_KEYS.has( key.toLowerCase() ) ) )
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
	const site = /^\/sites\/([1-9]\d*)(?:\/|$)/.exec( route );
	if ( site ) {
		const id = Number( site[ 1 ] );
		if ( ! Number.isSafeInteger( id ) || ( ! absolute && id !== siteId ) ) return;
		return { wpcomSiteId: id };
	}
	return absolute && args.method === 'GET' && WPCOM_ACCOUNT_READS.has( route ) ? {} : undefined;
}
