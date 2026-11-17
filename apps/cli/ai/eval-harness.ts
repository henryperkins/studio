/**
 * What an eval case can set up around its turns: remote operations replaced
 * by fixtures and a guard against any other write to WordPress.com, files the
 * user attached, and history the conversation already has. Development only,
 * for the eval runner.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { textResult } from '@studio/agent/node';
// eslint-disable-next-line no-restricted-imports -- development only: no host hook reaches this one tool, so the harness mocks its writes here.
import { wpcomRequestTool } from '@studio/agent/node/tools/wpcom-request';
import {
	buildAttachedFilesPromptBlock,
	type StudioChatFileAttachment,
} from '@studio/agent/protocol/chat-files';
import { normalizeHostname } from '@studio/common/lib/normalize-hostname';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import type { HostSite, StudioAgentHost } from '@studio/agent/node';
import type { StudioChatImage, StudioChatImageMimeType } from '@studio/agent/protocol/chat-images';
import type { Snapshot } from '@studio/common/types/snapshot';
import type { SyncSite } from '@studio/common/types/sync';

/** A remote operation a case's turn asked for, which a mocked host recorded instead of running. */
export interface RemoteCall {
	operation:
		| 'push'
		| 'pull'
		| 'preview-create'
		| 'preview-update'
		| 'preview-delete'
		| 'wpcom-request';
	/** For `wpcom-request`: the method it would have sent. */
	method?: string;
	site?: string;
	target?: string;
	options?: string;
	/** In a staging case: whether its target was the designated staging site, so it ran. */
	designated?: boolean;
}

/** The WordPress.com staging site a `remote: staging` case may change, as WordPress.com lists it. */
export interface StagingSite {
	id: number;
	url: string;
}

// Reserved for documentation (RFC 2606): nothing is ever reached there.
const MOCK_REMOTE_URL = 'https://eval-mock-remote.invalid';
const MOCK_PREVIEW_HOST = 'eval-mock-preview.invalid';

function mockRemoteSite( site: HostSite, remoteSite: string | undefined ): SyncSite {
	return {
		id: 0,
		localSiteId: site.id,
		name: 'Eval mock remote site',
		url: remoteSite && /^https?:\/\//.test( remoteSite ) ? remoteSite : MOCK_REMOTE_URL,
		isStaging: false,
		isPressable: false,
		syncSupport: 'already-connected',
		lastPullTimestamp: null,
		lastPushTimestamp: null,
	};
}

function mockPreview( site: HostSite, hostname = MOCK_PREVIEW_HOST ): Snapshot {
	return {
		url: hostname,
		atomicSiteId: 0,
		localSiteId: site.id,
		date: Date.now(),
		name: `${ site.name } (eval mock preview)`,
	};
}

/**
 * The host with every operation that changes a WordPress.com site (push,
 * pull, preview create, update and delete) recorded in `calls` and answered
 * with a fixture, so an automatic run never reaches a remote site. Everything
 * local stays the real host's.
 */
export function withMockedRemote( host: StudioAgentHost, calls: RemoteCall[] ): StudioAgentHost {
	return {
		...host,
		previews: {
			...host.previews,
			create: async ( site ) => {
				calls.push( { operation: 'preview-create', site: site.name } );
				return mockPreview( site );
			},
			update: async ( site, hostname ) => {
				calls.push( { operation: 'preview-update', site: site.name, target: hostname } );
				return mockPreview( site, hostname );
			},
			delete: async ( hostname ) => {
				calls.push( { operation: 'preview-delete', target: hostname } );
			},
		},
		sync: {
			push: async ( site, options, remoteSite ) => {
				calls.push( { operation: 'push', site: site.name, target: remoteSite, options } );
				return mockRemoteSite( site, remoteSite );
			},
			pull: async ( site, options, remoteSite ) => {
				calls.push( { operation: 'pull', site: site.name, target: remoteSite, options } );
				return mockRemoteSite( site, remoteSite );
			},
		},
	};
}

/**
 * Whether a push's or pull's remote names the designated staging site, read as
 * the push and pull commands resolve it: digits alone are a site id, anything
 * else is matched by its hostname. Anything that isn't plainly that site,
 * including no remote at all, is not.
 */
export function remoteIsStagingSite( remote: string | undefined, site: StagingSite ): boolean {
	const identifier = remote?.trim();
	if ( ! identifier ) {
		return false;
	}
	if ( /^\d+$/.test( identifier ) ) {
		return Number( identifier ) === site.id;
	}
	return normalizeHostname( identifier ) === normalizeHostname( site.url );
}

/**
 * The host of a staging case: a push runs for real only when its remote is the
 * designated staging site; no pull runs (it keeps its files under the real
 * home directory, whatever the case's profile) and no preview is created,
 * updated or deleted. Each is recorded in `calls`, with whether it was the
 * designated site; anything else is refused before it starts, recorded in
 * `refused`, and fails the case.
 */
export function withStagingRemote(
	host: StudioAgentHost,
	calls: RemoteCall[],
	site: StagingSite,
	refused: WpcomWriteAttempt[]
): StudioAgentHost {
	const refuse = ( call: RemoteCall ): never => {
		calls.push( { ...call, designated: false } );
		refused.push( {
			code: STAGING_WRITE_CODE,
			method: 'OTHER',
			host: 'wpcom',
			endpoint: 'other',
			via: 'remote-operation',
			operation: call.operation,
		} );
		throw new Error( stagingBlockedMessage() );
	};
	return {
		...host,
		previews: {
			...host.previews,
			create: async ( localSite ) =>
				refuse( { operation: 'preview-create', site: localSite.name } ),
			update: async ( localSite, hostname ) =>
				refuse( { operation: 'preview-update', site: localSite.name, target: hostname } ),
			delete: async ( hostname ) => refuse( { operation: 'preview-delete', target: hostname } ),
		},
		sync: {
			push: async ( localSite, options, remoteSite, onProgress ) => {
				const call: RemoteCall = {
					operation: 'push',
					site: localSite.name,
					target: remoteSite,
					options,
				};
				if ( ! remoteIsStagingSite( remoteSite, site ) ) {
					return refuse( call );
				}
				calls.push( { ...call, designated: true } );
				return host.sync.push( localSite, options, remoteSite, onProgress );
			},
			pull: async ( localSite, options, remoteSite ) =>
				refuse( { operation: 'pull', site: localSite.name, target: remoteSite, options } ),
		},
	};
}

const READ_METHODS = new Set( [ 'GET', 'HEAD' ] );
const OVERRIDE_HEADERS = new Set( [
	'x-http-method-override',
	'x-http-method',
	'x-method-override',
] );

const hasControlCharacter = ( text: string ): boolean =>
	[ ...text ].some( ( char ) => char.charCodeAt( 0 ) < 32 || char.charCodeAt( 0 ) === 127 );

function decodeKey( key: string ): string {
	try {
		return decodeURIComponent( key );
	} catch {
		return key;
	}
}

/**
 * Whether a query key could become a `_method` or `method` override on the
 * server, which folds some other spellings into `_method` when it fills its
 * parameters. Deliberately stricter than the server: a read refused here costs
 * the model one retry.
 */
export function couldBeMethodOverrideKey( rawKey: string ): boolean {
	const key = decodeKey( rawKey );
	if ( hasControlCharacter( rawKey ) || hasControlCharacter( key ) ) {
		return true;
	}
	const stripped = key.replace( /^\s+/, '' );
	const bracket = stripped.indexOf( '[' );
	const base = bracket > 0 ? stripped.slice( 0, bracket ) : stripped;
	const folded = base.replace( /[.\s[]/g, '_' ).toLowerCase();
	return (
		folded === '_method' ||
		folded === 'method' ||
		key.replace( /[^a-z0-9]/gi, '' ).toLowerCase() === 'method'
	);
}

function queryOverrideValues( entries: Iterable< [ string, unknown ] > ): string[] {
	const values: string[] = [];
	for ( const [ key, value ] of entries ) {
		if ( ! couldBeMethodOverrideKey( key ) ) {
			continue;
		}
		const listed = ( Array.isArray( value ) ? value : [ value ] ).map( ( v ) => String( v ) );
		const array = Array.isArray( value ) || decodeKey( key ).includes( '[' );
		const hidden = hasControlCharacter( key ) || hasControlCharacter( decodeKey( key ) );
		if (
			hidden ||
			( array && listed.every( ( v ) => READ_METHODS.has( v.trim().toUpperCase() ) ) )
		) {
			values.push( 'OTHER' );
		}
		values.push( ...listed );
	}
	return values;
}

function headerOverrideValues(
	entries: Iterable< [ string, unknown ] >,
	names: Set< string >
): string[] {
	const values: string[] = [];
	for ( const [ key, value ] of entries ) {
		if ( names.has( key.toLowerCase() ) ) {
			values.push( ...( Array.isArray( value ) ? value : [ value ] ).map( ( v ) => String( v ) ) );
		}
	}
	return values;
}

/** The method a request really has: its own, unless a method override in its query or headers names a write. */
function effectiveMethod(
	method: string,
	query?: Record< string, unknown >,
	overrides: string[] = []
): string {
	const declared = method.toUpperCase();
	const named = [ ...queryOverrideValues( Object.entries( query ?? {} ) ), ...overrides ];
	const write = named.find( ( value ) => ! READ_METHODS.has( value.trim().toUpperCase() ) );
	if ( ! READ_METHODS.has( declared ) ) {
		return declared;
	}
	return write === undefined ? declared : write.trim().toUpperCase() || 'OTHER';
}

// The query keys the WordPress.com client takes out of a request's query and
// into its transport (`wpcom`'s send-request): `proxyOrigin` sends the request,
// with the login, to another origin, and `apiNamespace` and `apiVersion`
// change the path it reaches.
const TRANSPORT_KEYS = new Set( [ 'proxyorigin', 'apinamespace', 'apiversion' ] );

/** Whether a query key, decoded, trimmed and in any case, is one the client lifts into its transport. */
function isTransportKey( key: string ): boolean {
	return TRANSPORT_KEYS.has( decodeKey( key ).trim().toLowerCase() );
}

const transportKeyMessage = () =>
	'wpcom-query-key-refused: this eval case may not pass proxyOrigin, apiNamespace or apiVersion in a query, so the request was not sent. Use the apiNamespace argument for a namespace.';

/** The query a request path carries: from its first `?` up to any `#`, since a fragment is never sent. */
function pathQuery( requestPath: string ): string {
	const [ beforeFragment ] = requestPath.split( '#' );
	const start = beforeFragment.indexOf( '?' );
	return start < 0 ? '' : beforeFragment.slice( start + 1 );
}

// What the write guard decided about the writes one `wpcom_request` call sent,
// kept for that call alone, however many calls run at once.
const wpcomRequestDecisions = new AsyncLocalStorage< { allowed: number; refused: number } >();

/**
 * `wpcom_request` with every request whose effective method is not GET or HEAD
 * (declared, or named by a method override in its `query` or in a query written
 * into its `path`) recorded in `calls`. Under `remote: mock` (no `staging`)
 * each is answered by a fixture, as the mocked host does for pushes and
 * previews: a write the agent asks for never leaves the process. In a staging
 * case one to the designated staging site goes to the real tool, where the
 * write guard checks the address it composes, and is recorded as designated
 * only when the guard let what it sent through (a refused one is in the
 * guard's record, once); one to any other site, or to a path outside a site,
 * is refused before it is sent and recorded in `staging.refused`. Reads stay
 * the real tool's. The returned function puts the real tool back.
 */
export function withMockedWpcomRequest(
	calls: RemoteCall[],
	staging?: { site: StagingSite; refused: WpcomWriteAttempt[] }
): () => void {
	const original = wpcomRequestTool.handler;
	// Every request this sends to the real tool: never one whose query the
	// client would lift into its transport.
	const passOn = ( ...[ args, context ]: Parameters< typeof original > ) => {
		if ( Object.keys( args.query ?? {} ).some( isTransportKey ) ) {
			throw new Error( transportKeyMessage() );
		}
		return original.call( wpcomRequestTool, args, context );
	};
	wpcomRequestTool.handler = async ( args, context ) => {
		const method = effectiveMethod(
			args.method,
			args.query,
			queryOverrideValues( new URLSearchParams( pathQuery( args.path ) ).entries() )
		);
		if ( READ_METHODS.has( method ) ) {
			return passOn( args, context );
		}
		const call: RemoteCall = {
			operation: 'wpcom-request',
			method,
			site: String( args.siteId ),
			target: args.path,
		};
		if ( ! staging ) {
			calls.push( call );
			return textResult( JSON.stringify( { eval_mock: true, method, path: args.path } ) );
		}
		// As the tool reads it: a path starting with `!` is not under the site.
		if ( args.siteId === staging.site.id && ! args.path.startsWith( '!' ) ) {
			const decision = { allowed: 0, refused: 0 };
			try {
				return await wpcomRequestDecisions.run( decision, () => passOn( args, context ) );
			} finally {
				calls.push( { ...call, designated: decision.allowed > 0 && decision.refused === 0 } );
			}
		}
		calls.push( { ...call, designated: false } );
		staging.refused.push( {
			code: STAGING_WRITE_CODE,
			method: KNOWN_METHODS.has( method ) ? method : 'OTHER',
			host: 'wpcom',
			endpoint: 'other',
			via: 'wpcom-request',
		} );
		throw new Error( stagingBlockedMessage() );
	};
	return () => {
		wpcomRequestTool.handler = original;
	};
}

const WPCOM_WRITE_CODE = 'wpcom-write-under-mock';
const STAGING_WRITE_CODE = 'wpcom-write-outside-staging';
const KNOWN_METHODS = new Set( [ 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS' ] );

/**
 * A request a guarded case tried to send to WordPress.com that could change
 * something there, which was refused. Never its address.
 */
export interface WpcomWriteAttempt {
	code: typeof WPCOM_WRITE_CODE | typeof STAGING_WRITE_CODE;
	method: string;
	host: 'wpcom' | 'wpcom-ai-proxy';
	endpoint: 'images' | 'other';
	via: 'fetch' | 'http' | 'wpcom-request' | 'remote-operation';
	/** For `remote-operation`: which one. */
	operation?: RemoteCall[ 'operation' ];
}

/** A write a staging case sent to its designated staging site. Never its address. */
interface StagingWrite {
	method: string;
	via: 'fetch' | 'http';
}

export interface WpcomWriteGuardOptions {
	/** The case is labelled as needing Studio's separate image service, which it writes to. */
	allowImageService?: boolean;
	/** The run's provider is WordPress.com, whose model requests go to the AI proxy. */
	allowProxyInference?: boolean;
	/**
	 * A staging case's designated site: a write to it is let through and
	 * recorded in `allowed`; any other write is refused as outside it.
	 */
	stagingSite?: StagingSite;
	/** Where refused requests are recorded, shared with the case's other checks. */
	attempts?: WpcomWriteAttempt[];
}

const WPCOM_API_HOST = 'public-api.wordpress.com';

// A host as it is classified: lower case, without the trailing dot of a fully
// qualified name, which reaches the same host.
const normalizeHost = ( hostname: string ) => hostname.toLowerCase().replace( /\.+$/, '' );

// The domains of WordPress.com hosts, staging sites' own included. A site on a
// custom domain can't be recognised as a WordPress.com host.
const WPCOM_DOMAINS = [ 'wordpress.com', 'wp.com', 'wpcomstaging.com' ];
const isWpcomHost = ( host: string ) =>
	WPCOM_DOMAINS.some( ( domain ) => host === domain || host.endsWith( `.${ domain }` ) );

const stagingHostname = ( site: StagingSite ) =>
	normalizeHost( normalizeHostname( site.url ).split( '/' )[ 0 ] );

// A path segment a shape matches: itself, the designated site (its id or its
// address), or the rest of the path (`REST`, one segment or more, or
// `REST_OR_NONE`).
const SITE = Symbol( 'the designated site' );
const REST = Symbol( 'one segment or more' );
const REST_OR_NONE = Symbol( 'any segments' );
type ShapeSegment = string | typeof SITE | typeof REST | typeof REST_OR_NONE;

/**
 * The only requests a staging case may send that could change something on
 * WordPress.com, each addressed to the designated staging site. A write
 * addressed to the staging site can still act on another site or on the
 * account (a reblog naming its `destination_site_id`, a follow, a like), so
 * every other namespace and path, the legacy `/rest/v1.x` site API included,
 * is refused before it is sent.
 */
const STAGING_WRITE_SHAPES: ReadonlyArray< { host: 'api' | 'site'; path: ShapeSegment[] } > = [
	// The push's upload of the site's archive, as tus sends it: it creates the
	// upload at the site's endpoint, then sends the chunks to the address the
	// server answers with under it.
	{ host: 'api', path: [ 'rest', 'v1.1', 'studio-file-uploads', SITE, REST_OR_NONE ] },
	// The push's request that the site import the uploaded archive.
	{
		host: 'api',
		path: [ 'wpcom', 'v2', 'sites', SITE, 'studio-app', 'sync', 'import', 'initiate' ],
	},
	// The site's own core REST API (`wp/v2`), as `wpcom_request` sends it: the
	// site's posts, pages, templates, styles and other content.
	{ host: 'api', path: [ 'wp', 'v2', 'sites', SITE, REST ] },
	// The same API at the site's own address.
	{ host: 'site', path: [ 'wp-json', 'wp', 'v2', REST ] },
];

function matchesShape(
	segments: string[],
	shape: ShapeSegment[],
	isSite: ( segment: string ) => boolean
): boolean {
	for ( const [ index, expected ] of shape.entries() ) {
		if ( expected === REST || expected === REST_OR_NONE ) {
			return expected === REST_OR_NONE || segments.length > index;
		}
		const segment = segments[ index ];
		if (
			segment === undefined ||
			! ( expected === SITE ? isSite( segment ) : segment === expected )
		) {
			return false;
		}
	}
	return segments.length === shape.length;
}

/**
 * Whether a staging case may send a write to this address: it is one of
 * `STAGING_WRITE_SHAPES`, on the API host with the designated site named by
 * id or by hostname, or at the site's own address. A path the server could
 * read as another one (a dot segment, an encoded slash, an empty segment, a
 * segment that doesn't decode) is not.
 */
export function writesToStagingSite(
	target: { hostname: string; pathname: string },
	site: StagingSite
): boolean {
	const host = normalizeHost( target.hostname );
	const stagingHost = stagingHostname( site );
	const [ root, ...raw ] = target.pathname.split( '/' );
	if ( root !== '' ) {
		return false;
	}
	const segments: string[] = [];
	for ( const encoded of raw ) {
		let segment: string;
		try {
			segment = decodeURIComponent( encoded );
		} catch {
			return false;
		}
		if (
			segment === '' ||
			segment === '.' ||
			segment === '..' ||
			/[\\/]/.test( segment ) ||
			hasControlCharacter( segment )
		) {
			return false;
		}
		segments.push( segment );
	}
	const hostKind = host === WPCOM_API_HOST ? 'api' : host === stagingHost ? 'site' : null;
	const isSite = ( segment: string ) =>
		segment === String( site.id ) || segment.toLowerCase() === stagingHost;
	return STAGING_WRITE_SHAPES.some(
		( shape ) => shape.host === hostKind && matchesShape( segments, shape.path, isSite )
	);
}

interface RequestTarget {
	hostname: string;
	pathname: string;
	method: string;
	search: string;
	headers: Array< [ string, unknown ] >;
}

// What the guard does with a request: let it through (a read, a named
// exception, or in a staging case a write to the designated site), or refuse it.
function classifyWpcomWrite(
	target: RequestTarget,
	options: WpcomWriteGuardOptions
): Omit< WpcomWriteAttempt, 'via' > | { stagingWrite: string } | null {
	const { hostname, pathname } = target;
	const overrides = [
		...queryOverrideValues( new URLSearchParams( target.search ).entries() ),
		...headerOverrideValues( target.headers, OVERRIDE_HEADERS ),
	];
	const method = effectiveMethod( target.method, undefined, overrides );
	if ( ! isWpcomHost( normalizeHost( hostname ) ) || READ_METHODS.has( method ) ) {
		return null;
	}
	const proxy = pathname.startsWith( '/wpcom/v2/ai-api-proxy' );
	const endpoint = proxy && pathname.includes( '/v1/images/' ) ? 'images' : 'other';
	if ( proxy && endpoint === 'images' && options.allowImageService ) {
		return null;
	}
	if ( proxy && endpoint === 'other' && options.allowProxyInference ) {
		return null;
	}
	const shownMethod = KNOWN_METHODS.has( method ) ? method : 'OTHER';
	if ( options.stagingSite && writesToStagingSite( target, options.stagingSite ) ) {
		return { stagingWrite: shownMethod };
	}
	return {
		code: options.stagingSite ? STAGING_WRITE_CODE : WPCOM_WRITE_CODE,
		method: shownMethod,
		host: proxy ? 'wpcom-ai-proxy' : 'wpcom',
		endpoint,
	};
}

const blockedMessage = () =>
	`${ WPCOM_WRITE_CODE }: this eval case may not change anything on WordPress.com, so the request was not sent.`;

const stagingBlockedMessage = () =>
	`${ STAGING_WRITE_CODE }: this staging case may change only its designated staging site on WordPress.com, so the request was not sent.`;

/**
 * Options that give an `http` or `https` request a connection which fails at
 * once, before anything is written: the request is never sent anywhere.
 */
export function blockedConnectionOptions( message: string = blockedMessage() ): {
	agent: undefined;
	createConnection: () => net.Socket;
} {
	return {
		// No agent, so the request takes this connection rather than one to the host.
		agent: undefined,
		createConnection: () => {
			const socket = new net.Socket();
			// Never connected: what the request writes waits for a connection that never comes.
			( socket as { connecting: boolean } ).connecting = true;
			// After the request has attached its listeners to the socket.
			setImmediate( () => socket.destroy( new Error( message ) ) );
			return socket;
		},
	};
}

type RequestFunction = ( ...args: unknown[] ) => unknown;

function readHttpTarget( args: unknown[] ): RequestTarget {
	const [ first, second ] = args;
	const url =
		typeof first === 'string' ? new URL( first ) : first instanceof URL ? first : undefined;
	const options = (
		url ? ( typeof second === 'object' && second !== null ? second : {} ) : first ?? {}
	) as Record< string, unknown >;
	const host = typeof options.host === 'string' ? options.host.replace( /:\d+$/, '' ) : undefined;
	const hostname = String( options.hostname ?? host ?? url?.hostname ?? '' );
	const [ pathname, ...query ] = String(
		options.path ?? `${ url?.pathname ?? '/' }${ url?.search ?? '' }`
	).split( '?' );
	const method = String( options.method ?? 'GET' );
	const headers =
		typeof options.headers === 'object' && options.headers !== null
			? Object.entries( options.headers )
			: [];
	return { hostname, pathname, method, search: query.join( '?' ), headers };
}

function withBlockedConnection( args: unknown[], message: string ): unknown[] {
	const [ first, second, third ] = args;
	if ( typeof first === 'string' || first instanceof URL ) {
		const options = typeof second === 'object' && second !== null ? second : {};
		const callback = typeof second === 'function' ? second : third;
		return [ first, { ...options, ...blockedConnectionOptions( message ) }, callback ].filter(
			( value ) => value !== undefined
		);
	}
	return [ { ...( first as object ), ...blockedConnectionOptions( message ) }, second ].filter(
		( value ) => value !== undefined
	);
}

export interface WpcomWriteGuard {
	/** Every request it refused, in order: what a guarded case was not allowed to send. */
	attempts: WpcomWriteAttempt[];
	/** In a staging case, every write it let through to the designated staging site. */
	allowed: StagingWrite[];
	/** Puts the process's own `fetch` and request functions back. */
	uninstall(): void;
}

/**
 * Refuses, and records, any request this process tries to send to a
 * WordPress.com host with a method other than GET or HEAD, through `fetch` or
 * the `http` and `https` modules that `wpcom` requests go through. Reads pass.
 * The exceptions are named in `options`: Studio's image service in a case
 * labelled as needing it, model requests to the AI proxy on a run whose
 * provider is WordPress.com, and in a staging case writes to its designated
 * staging site, which are recorded in `allowed`.
 */
export function installWpcomWriteGuard(
	options: WpcomWriteGuardOptions = {},
	targets: {
		global: { fetch: typeof fetch };
		http: { request: RequestFunction };
		https: { request: RequestFunction };
	} = {
		global: globalThis,
		http: http as unknown as { request: RequestFunction },
		https: https as unknown as { request: RequestFunction },
	}
): WpcomWriteGuard {
	const attempts: WpcomWriteAttempt[] = options.attempts ?? [];
	const allowed: StagingWrite[] = [];
	// For the `wpcom_request` call that sent the write, when one did.
	const decided = ( decision: 'allowed' | 'refused' ) => {
		const call = wpcomRequestDecisions.getStore();
		if ( call ) {
			call[ decision ] += 1;
		}
	};
	const message = options.stagingSite ? stagingBlockedMessage() : blockedMessage();
	const originalFetch = targets.global.fetch;
	targets.global.fetch = ( async ( input: Parameters< typeof fetch >[ 0 ], init?: RequestInit ) => {
		let url: URL | null = null;
		try {
			url = new URL(
				typeof input === 'string' || input instanceof URL ? input : ( input as Request ).url
			);
		} catch {
			url = null;
		}
		const method = init?.method ?? ( input instanceof Request ? input.method : undefined ) ?? 'GET';
		const headers: Array< [ string, unknown ] > = [];
		for ( const source of [
			input instanceof Request ? input.headers : undefined,
			init?.headers,
		] ) {
			if ( source ) {
				headers.push( ...new Headers( source ).entries() );
			}
		}
		const write = url
			? classifyWpcomWrite(
					{
						hostname: url.hostname,
						pathname: url.pathname,
						method,
						search: url.search,
						headers,
					},
					options
			  )
			: null;
		if ( write && 'stagingWrite' in write ) {
			allowed.push( { method: write.stagingWrite, via: 'fetch' } );
			decided( 'allowed' );
		} else if ( write ) {
			attempts.push( { ...write, via: 'fetch' } );
			decided( 'refused' );
			throw new Error( message );
		}
		return originalFetch( input, init );
	} ) as typeof fetch;
	const modules = [ targets.http, targets.https ];
	const originals = modules.map( ( module ) => {
		const original = module.request;
		module.request = ( ...args: unknown[] ) => {
			const target = readHttpTarget( args );
			const write = classifyWpcomWrite( target, options );
			if ( write && 'stagingWrite' in write ) {
				allowed.push( { method: write.stagingWrite, via: 'http' } );
				decided( 'allowed' );
				return original.apply( module, args );
			}
			if ( ! write ) {
				return original.apply( module, args );
			}
			attempts.push( { ...write, via: 'http' } );
			decided( 'refused' );
			return original.apply( module, withBlockedConnection( args, message ) );
		};
		return original;
	} );
	return {
		attempts,
		allowed,
		uninstall: () => {
			targets.global.fetch = originalFetch;
			modules.forEach( ( module, index ) => {
				module.request = originals[ index ];
			} );
		},
	};
}

/**
 * The folder attachment fixtures are read from: `STUDIO_EVAL_FIXTURES_DIR`,
 * else the repository's `scripts/eval/fixtures`, looked for above `from`.
 */
export function findEvalFixturesDir( from: string, env: NodeJS.ProcessEnv ): string | null {
	if ( env.STUDIO_EVAL_FIXTURES_DIR ) {
		return env.STUDIO_EVAL_FIXTURES_DIR;
	}
	let directory = path.resolve( from );
	for ( let depth = 0; depth < 8; depth++ ) {
		const candidate = path.join( directory, 'scripts', 'eval', 'fixtures' );
		if ( existsSync( candidate ) ) {
			return candidate;
		}
		const parent = path.dirname( directory );
		if ( parent === directory ) {
			break;
		}
		directory = parent;
	}
	return null;
}

const IMAGE_TYPES: Record< string, StudioChatImageMimeType > = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
};

export interface EvalAttachments {
	/** Image input on the turn they are attached to, as the composer sends them. */
	images: StudioChatImage[];
	/** Other files, by absolute path, read with the agent's file tools. */
	files: StudioChatFileAttachment[];
	/** What the first prompt gains for the files, as the CLI appends it. */
	promptBlock: string;
	summary: Array< { fixture: string; kind: 'image' | 'file' } >;
}

/** The named fixtures as the user's attachments, or the first one that is missing. */
export function loadEvalAttachments(
	fixtures: ReadonlyArray< { fixture: string } >,
	fixturesDir: string
): EvalAttachments | { missing: string } {
	const images: StudioChatImage[] = [];
	const files: StudioChatFileAttachment[] = [];
	const summary: EvalAttachments[ 'summary' ] = [];
	for ( const [ index, { fixture } ] of fixtures.entries() ) {
		const file = path.join( fixturesDir, fixture );
		if ( path.basename( fixture ) !== fixture || ! existsSync( file ) ) {
			return { missing: fixture };
		}
		const mimeType = IMAGE_TYPES[ path.extname( fixture ).toLowerCase() ];
		if ( mimeType ) {
			const bytes = readFileSync( file );
			images.push( {
				id: `eval-attachment-${ index }`,
				name: fixture,
				mimeType,
				size: bytes.length,
				dataBase64: bytes.toString( 'base64' ),
			} );
			summary.push( { fixture, kind: 'image' } );
		} else {
			files.push( {
				id: `eval-attachment-${ index }`,
				name: fixture,
				path: file,
				size: statSync( file ).size,
			} );
			summary.push( { fixture, kind: 'file' } );
		}
	}
	return { images, files, promptBlock: buildAttachedFilesPromptBlock( files ), summary };
}

type SessionMessage = Parameters< SessionManager[ 'appendMessage' ] >[ 0 ];

/**
 * Messages a conversation already holds before the case's first turn, the
 * assistant's as a reply on the run's route records it. An assistant message's
 * `contextTokens` is the context size its reply reported, which is what decides
 * whether the next turn compacts first: a fixture can reach a limit that way
 * without sending a request that size.
 */
export function evalHistoryMessages(
	history: ReadonlyArray< { role: 'user' | 'assistant'; text: string; contextTokens?: number } >,
	reply: { provider: string; api: string; model: string },
	startedAt: number = Date.now()
): SessionMessage[] {
	return history.map( ( item, index ) => {
		const content = [ { type: 'text' as const, text: item.text } ];
		const timestamp = startedAt + index;
		if ( item.role === 'user' ) {
			return { role: 'user', content, timestamp } as SessionMessage;
		}
		const tokens = item.contextTokens ?? 0;
		return {
			role: 'assistant',
			content,
			api: reply.api,
			provider: reply.provider,
			model: reply.model,
			usage: {
				input: tokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: tokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: 'stop',
			timestamp,
		} as SessionMessage;
	} );
}
