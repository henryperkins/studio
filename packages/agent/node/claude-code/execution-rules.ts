import path from 'path';
import { createPreviewTool } from '../tools/create-preview';
import { createSiteTool } from '../tools/create-site';
import { deletePreviewTool } from '../tools/delete-preview';
import { deleteSiteTool } from '../tools/delete-site';
import { exportSiteTool } from '../tools/export-site';
import { generateImagesTool } from '../tools/generate-images';
import { importSiteTool } from '../tools/import-site';
import { inspectDesignTool } from '../tools/inspect-design';
import { installTaxonomyScriptsTool } from '../tools/install-taxonomy-scripts';
import { listConnectedRemoteSitesTool } from '../tools/list-connected-remote-sites';
import { listPreviewsTool } from '../tools/list-previews';
import { listSitesTool } from '../tools/list-sites';
import { auditPerformanceTool } from '../tools/need-for-speed';
import { openAnnotationBrowserTool } from '../tools/open-annotation-browser';
import { pickDesignTool } from '../tools/pick-design';
import { pullSiteTool } from '../tools/pull-site';
import { pushSiteTool } from '../tools/push-site';
import { auditSeoTool } from '../tools/rank-me-up';
import { refreshBrowserTool } from '../tools/refresh-browser';
import { scaffoldThemeTool } from '../tools/scaffold-theme';
import { sendFeedbackTool } from '../tools/send-feedback';
import { getSiteInfoTool } from '../tools/site-info';
import { startSiteTool } from '../tools/start-site';
import { stopSiteTool } from '../tools/stop-site';
import { takeScreenshotTool } from '../tools/take-screenshot';
import { updatePreviewTool } from '../tools/update-preview';
import { validateBlocksTool } from '../tools/validate-blocks';
import { runWpCliTool, splitCommandArgs } from '../tools/wp-cli';
import { wpcomRequestTool } from '../tools/wpcom-request';
import { isInside } from './local-paths';
import { hasOnlyKeys, hasOwn, plainData, plainList, plainStrings } from './plain-data';
import { classifyWpCliArgs, wpCliRouteCommands } from './wp-cli-rules';
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk/core';
import type { ClaudeOperationClass, ClaudeStudioTarget } from '@studio/agent/protocol/claude-code';

// What each operation is, independent of any turn. The execution policy applies
// these rules immediately before execution.

export interface ClaudeEnabledTools {
	readonly native: readonly string[];
	readonly studio: readonly string[];
}

/**
 * What a Claude turn may run in this build. Widening it is a reviewed change,
 * and listing a Studio tool here is not enough: it runs only once its rule is
 * qualified.
 */
export const CLAUDE_ENABLED_TOOLS: ClaudeEnabledTools = Object.freeze( {
	native: Object.freeze( [ 'Read' ] ),
	studio: Object.freeze( [ runWpCliTool.name, getSiteInfoTool.name ] ),
} );

/** How long the user has to answer an approval. */
export const CLAUDE_APPROVAL_TIMEOUT_MS = 120_000;

/**
 * The PreToolUse hook's timeout, in seconds. A native approval waits inside the
 * hook, so the hook must outlast it; Claude Code blocks a tool call whose hook
 * times out.
 */
export const CLAUDE_HOOK_TIMEOUT_SECONDS = 180;

/**
 * How long an operation that needs no approval may rely on the last real check
 * of the native sign-in. Once it is older, the policy reads the sign-in again
 * before allowing anything, so no operation runs longer than this after the
 * stored account changes.
 */
export const CLAUDE_ACCOUNT_RECHECK_MS = 10_000;

/**
 * How shell commands are confined. A shell tool can be enabled only under a
 * mode the policy verifies: an SDK sandbox whose writes stay in the workspace,
 * or `approval-only`, where every command needs its own approval and the user
 * is told it is not confined.
 */
export type ClaudeShellConfinement =
	| { readonly mode: 'none' }
	| { readonly mode: 'approval-only' }
	| { readonly mode: 'sandbox'; readonly sandbox: SandboxSettings | undefined };

/** This build configures no shell confinement, so no shell tool can be enabled. */
export const CLAUDE_SHELL_CONFINEMENT: ClaudeShellConfinement = Object.freeze( { mode: 'none' } );

/**
 * The revision of what a navigation guard must guarantee: the origin rule and
 * the guarantees below. A guard built for an earlier revision does not verify.
 */
export const CLAUDE_NAVIGATION_RULE_REVISION = 2;

/**
 * What a browser-layer guard guarantees for every page a Studio tool opens. A
 * host name check cannot bind a browser: a public name can resolve to this
 * machine, and a page can redirect or load from anywhere. So a tool that
 * drives a browser can be enabled only under a guard declaring all of these,
 * for this rule revision and this turn's target.
 */
export interface ClaudeNavigationGuard {
	/** `CLAUDE_NAVIGATION_RULE_REVISION`. */
	readonly ruleRevision: number;
	/** The target site's own origin, or null for a global target. */
	readonly targetOrigin: string | null;
	/**
	 * Every HTTP, HTTPS and WebSocket request the browser sends for the tool
	 * passes the guard before it connects: navigations, frames, subresources,
	 * fetches, dedicated, shared and service workers, WebSockets and
	 * prefetches, not only the first URL. Anything else a page can open is
	 * `blocksUncheckedChannels`'s to stop.
	 */
	readonly checksEveryRequest: true;
	/** Each redirect hop is checked as a new request before it is followed. */
	readonly checksEveryRedirect: true;
	/**
	 * The policy's origin rule, on host names normalized as `normalizeHostname`
	 * does: http and https only, no credentials, and a local host name or a
	 * local site's host name only at `targetOrigin`. The one document
	 * `confinesFileDocuments` admits is the only exception to the scheme.
	 */
	readonly appliesOriginRule: true;
	/**
	 * The guard resolves every host name and refuses a loopback, unspecified,
	 * private, shared, link-local or unique-local address, in any IPv4 or IPv6
	 * form, unless the request is to `targetOrigin`.
	 */
	readonly checksResolvedAddresses: true;
	/** The browser connects only to the address the guard checked; nothing resolves the name again. */
	readonly pinsCheckedAddress: true;
	/**
	 * A `file:` URL loads only as the top-level document of a page the host
	 * itself wrote for the call, which names that exact URL to the guard.
	 * Everything that document then loads or opens (subresources, frames,
	 * workers, fetches and navigations) passes the same origin rule as any
	 * other request, so it reaches a local address only at `targetOrigin`, and
	 * a `file:` subresource, frame, worker or navigation is refused. No other
	 * page loads a `file:` URL at all.
	 */
	readonly confinesFileDocuments: true;
	/**
	 * Every way a page can reach the network other than the requests the guard
	 * checks is disabled or refused: WebRTC (ICE, STUN and TURN), WebTransport
	 * and QUIC, and any other channel the browser exposes. A request
	 * interceptor or a proxy does not see these, so checking requests is not
	 * enough.
	 */
	readonly blocksUncheckedChannels: true;
	/**
	 * A refused or unverifiable request fails, and the tool reports an error; a
	 * guard that cannot start stops the tool. Nothing is retried without it.
	 */
	readonly failsClosed: true;
}

export type ClaudeNavigationConfinement =
	| { readonly mode: 'none' }
	| { readonly mode: 'guarded'; readonly guard: ClaudeNavigationGuard | undefined };

/** This build has no navigation guard, so no tool that drives a browser can be enabled. */
export const CLAUDE_NAVIGATION_CONFINEMENT: ClaudeNavigationConfinement = Object.freeze( {
	mode: 'none',
} );

const NAVIGATION_GUARANTEES = Object.keys( {
	checksEveryRequest: true,
	checksEveryRedirect: true,
	appliesOriginRule: true,
	checksResolvedAddresses: true,
	pinsCheckedAddress: true,
	confinesFileDocuments: true,
	blocksUncheckedChannels: true,
	failsClosed: true,
} satisfies Record<
	Exclude< keyof ClaudeNavigationGuard, 'ruleRevision' | 'targetOrigin' >,
	true
> );
const NAVIGATION_GUARD_KEYS: ReadonlySet< string > = new Set( [
	'ruleRevision',
	'targetOrigin',
	...NAVIGATION_GUARANTEES,
] );
const NAVIGATION_CONFINEMENT_KEYS: ReadonlySet< string > = new Set( [ 'mode', 'guard' ] );

/**
 * Whether a declared navigation guard can be verified: the declaration and its
 * guard are plain data that state every guarantee and nothing else, apply
 * this rule revision and are bound to this turn's target origin. Anything
 * else is unverified; a malformed declaration never throws.
 */
export function isVerifiedNavigationGuard(
	confinement: ClaudeNavigationConfinement,
	targetOrigin: string | null
): boolean {
	const declared = plainData( confinement );
	if (
		! declared ||
		declared.mode !== 'guarded' ||
		! hasOnlyKeys( declared, NAVIGATION_CONFINEMENT_KEYS ) ||
		( targetOrigin !== null && typeof targetOrigin !== 'string' )
	)
		return false;
	const guard = plainData( declared.guard );
	return (
		!! guard &&
		hasOnlyKeys( guard, NAVIGATION_GUARD_KEYS ) &&
		guard.ruleRevision === CLAUDE_NAVIGATION_RULE_REVISION &&
		guard.targetOrigin === targetOrigin &&
		NAVIGATION_GUARANTEES.every( ( key ) => guard[ key ] === true )
	);
}

/** The origin of a turn's target site, or null for a global target or a site without a URL. */
export function claudeTargetOrigin(
	target: ClaudeStudioTarget,
	targetSite: { url?: string } | undefined
): string | null {
	if ( target.environment === 'global' || ! targetSite?.url ) return null;
	try {
		const { origin } = new URL( targetSite.url );
		return origin === 'null' ? null : origin;
	} catch {
		return null;
	}
}

const STUDIO_MCP_PREFIX = 'mcp__studio__';

const UNPROMPTED_CLASSES: ReadonlySet< ClaudeOperationClass > = new Set( [
	'read',
	'remote-read',
	'local-change',
] );

/**
 * Reads and ordinary local edits run without asking; everything that can delete
 * or overwrite work, reach beyond this machine with a change, send a message or
 * run an unstructured command needs the user's approval of that exact call.
 */
export function requiresClaudeApproval( operationClass: ClaudeOperationClass ): boolean {
	return ! UNPROMPTED_CLASSES.has( operationClass );
}

export function isRecord( value: unknown ): value is Record< string, unknown > {
	return !! value && typeof value === 'object' && ! Array.isArray( value );
}

/**
 * Every way a Studio tool's implementation can have an effect or learn
 * something outside the conversation:
 * - `readsLocalFiles`, `writesLocalFiles`: it reads, or creates, changes or
 *   deletes, local files itself.
 * - `drivesBrowser`: it opens or scripts a page in a browser.
 * - `requestsNetwork`: it or a helper composes and sends a network request,
 *   outside a browser.
 * - `spawnsProcess`: it starts a process itself, other than through a host
 *   operation.
 * - `runsWpCli`: it runs a WP-CLI command on a site.
 * - `callsHostOperation`: it calls an operation of the Studio host.
 * - `reachesWpcom`: it reads or changes something on WordPress.com.
 */
export const CLAUDE_TOOL_CHANNELS = Object.freeze( [
	'readsLocalFiles',
	'writesLocalFiles',
	'drivesBrowser',
	'requestsNetwork',
	'spawnsProcess',
	'runsWpCli',
	'callsHostOperation',
	'reachesWpcom',
] as const );

export type ClaudeToolChannel = ( typeof CLAUDE_TOOL_CHANNELS )[ number ];

/**
 * What bounds a channel a tool uses, immediately before it runs:
 * - `site`, `paths`, `urls`, `navigates`: that element of the tool's rule.
 * - `scope`: the rule's `remote` element.
 * - `class`: the rule's operation class, which asks the user to approve every
 *   exact call. A file channel takes it only next to `paths`, so the approval
 *   shows the files.
 * - `host`: the effect is a host operation, which runs only through
 *   `guardHost`.
 */
export type ClaudeChannelBinding =
	| 'site'
	| 'paths'
	| 'urls'
	| 'navigates'
	| 'scope'
	| 'class'
	| 'host';

/** For every channel, `false` when the implementation does not use it, or what bounds it. */
export type ClaudeToolChannelDeclaration = {
	readonly [ Channel in ClaudeToolChannel ]: false | readonly ClaudeChannelBinding[];
};

/**
 * Whether a tool has been qualified to run. Having a rule does not qualify it:
 * a rule written before anyone traced the tool's implementation can miss a
 * route through it. So a tool is unqualified until a reviewed change records,
 * for every channel, that its implementation does not use it or what bounds
 * it. `unbound` names channels an unqualified tool is known to use that
 * nothing in its rule bounds yet.
 */
export type ClaudeToolQualification =
	| { readonly qualified: false; readonly unbound?: readonly ClaudeToolChannel[] }
	| { readonly qualified: true; readonly channels: ClaudeToolChannelDeclaration };

export interface ClaudeStudioToolRule {
	/** Whether the tool may be enabled at all. No host declaration replaces it. */
	readonly qualification: ClaudeToolQualification;
	/** The class, or for a tool classified by its arguments the widest class it can reach. */
	readonly operationClass: ClaudeOperationClass;
	/** Narrows the class from a call's arguments; undefined denies the call. */
	readonly classify?: ( args: unknown ) => ClaudeOperationClass | undefined;
	/**
	 * The local site a call names. It must resolve to the turn's target site; a
	 * missing reference denies the call.
	 */
	readonly site?: ( args: unknown ) => string | undefined;
	/**
	 * Local paths the tool writes itself, given the named site's folder. Each must
	 * lie in the target site's folder; undefined denies the call.
	 */
	readonly paths?: ( args: unknown, siteFolder: string | undefined ) => string[] | undefined;
	/**
	 * The WordPress.com scope a call reaches directly: a site, which must be the
	 * turn's live target, or the account. Undefined denies the call.
	 */
	readonly remote?: ( args: unknown ) => { wpcomSiteId?: number } | undefined;
	/**
	 * The URLs a call opens, given the named site's URL; undefined denies the call.
	 * Only http and https are allowed. A local address must be the target site's
	 * own origin; a public page is an external read.
	 */
	readonly urls?: ( args: unknown, siteUrl: string | undefined ) => string[] | undefined;
	/** Every URL the call opens must be the named site's own origin. */
	readonly urlsOnSite?: true;
	/**
	 * Drives a browser, whether it opens a URL from its arguments, a page of the
	 * named site or a document it wrote itself; it can be enabled only under a
	 * verified navigation guard.
	 */
	readonly navigates?: true;
	/**
	 * Where a call that needs approval is approved: at the host operation that
	 * carries its effect, with that operation's exact arguments, or for the tool
	 * call itself when its effect does not go through the host.
	 */
	readonly approval: 'host' | 'tool';
}

function namedSite( args: unknown ): string | undefined {
	return isRecord( args ) && typeof args.nameOrPath === 'string' ? args.nameOrPath : undefined;
}

type StudioRuleElements = Omit< ClaudeStudioToolRule, 'qualification' >;

function studioRule(
	operationClass: ClaudeOperationClass,
	options: Partial< Omit< StudioRuleElements, 'operationClass' > > = {}
): StudioRuleElements {
	return { operationClass, approval: 'tool', ...options };
}

function onSite(
	operationClass: ClaudeOperationClass,
	options: Partial< Omit< StudioRuleElements, 'operationClass' > > = {}
): StudioRuleElements {
	return studioRule( operationClass, { site: namedSite, ...options } );
}

function unqualified(
	rule: StudioRuleElements,
	unbound?: readonly ClaudeToolChannel[]
): ClaudeStudioToolRule {
	return { ...rule, qualification: unbound ? { qualified: false, unbound } : { qualified: false } };
}

function qualified(
	rule: StudioRuleElements,
	channels: ClaudeToolChannelDeclaration
): ClaudeStudioToolRule {
	return { ...rule, qualification: { qualified: true, channels } };
}

// What a tool that acts on the site it names only through the host uses: host
// operations, WP-CLI among them, bound to the target site by the host guard.
const LOCAL_SITE_HOST_CHANNELS: Partial< ClaudeToolChannelDeclaration > = {
	runsWpCli: [ 'site', 'host' ],
	callsHostOperation: [ 'site', 'host' ],
};

// A declaration that marks every channel it does not name as unused.
function using( used: Partial< ClaudeToolChannelDeclaration > ): ClaudeToolChannelDeclaration {
	return {
		readsLocalFiles: false,
		writesLocalFiles: false,
		drivesBrowser: false,
		requestsNetwork: false,
		spawnsProcess: false,
		runsWpCli: false,
		callsHostOperation: false,
		reachesWpcom: false,
		...used,
	};
}

function frozen< Value >( value: Value ): Value {
	if ( value && typeof value === 'object' && ! Object.isFrozen( value ) ) {
		Object.freeze( value );
		for ( const item of Object.values( value ) ) frozen( item );
	}
	return value;
}

// A `Map` accepts `set` and `delete` whatever type it is declared with, so the
// rule tables are exposed only as this frozen view, over frozen rules: nothing
// can add, replace or loosen a rule at run time. A rule has no prototype
// either, so it has no element but those it states.
function ruleTable< Rule extends object >(
	entries: ReadonlyArray< readonly [ string, Rule ] >
): ReadonlyMap< string, Rule > {
	const rules = new Map(
		entries.map( ( [ name, rule ] ) => [
			name,
			frozen< Rule >( Object.assign( Object.create( null ), rule ) ),
		] )
	);
	const table: ReadonlyMap< string, Rule > = {
		get size() {
			return rules.size;
		},
		get: ( name ) => rules.get( name ),
		has: ( name ) => rules.has( name ),
		forEach: ( callback, thisArg ) =>
			rules.forEach( ( rule, name ) => callback.call( thisArg, rule, name, table ) ),
		entries: () => rules.entries(),
		keys: () => rules.keys(),
		values: () => rules.values(),
		[ Symbol.iterator ]: () => rules[ Symbol.iterator ](),
	};
	return Object.freeze( table );
}

function pageUrls( args: unknown ): string[] | undefined {
	return isRecord( args ) && typeof args.url === 'string' ? [ args.url ] : undefined;
}

// A site audit opens `${ siteUrl }${ path }`. The path must be a plain path on
// that site, which the policy then checks again on the composed URL.
function auditUrls( args: unknown, siteUrl: string | undefined ): string[] | undefined {
	const urlPath = isRecord( args ) && args.path !== undefined ? args.path : '/';
	if (
		! siteUrl ||
		typeof urlPath !== 'string' ||
		! /^\/(?![/\\])[^\\\s]*$/.test( urlPath ) ||
		[ ...urlPath ].some( ( character ) => character < ' ' || character === '\u007f' )
	)
		return;
	return [ `${ siteUrl.replace( /\/+$/, '' ) }${ urlPath }` ];
}

/**
 * A host name as every check compares it: lowercase, without IPv6 brackets and
 * without trailing dots, which name the same host. `URL` has already applied
 * IDNA, so a parsed host name is in its punycode form.
 */
export function normalizeHostname( hostname: string ): string {
	return hostname
		.toLowerCase()
		.replace( /^\[|\]$/g, '' )
		.replace( /\.+$/, '' );
}

/**
 * Whether a host name belongs to this machine or a private network: loopback,
 * private, link-local and unique-local addresses, `localhost` and `.local`.
 */
export function isLocalHostname( hostname: string ): boolean {
	const host = normalizeHostname( hostname );
	if (
		! host ||
		host === 'localhost' ||
		host.endsWith( '.localhost' ) ||
		host.endsWith( '.local' )
	)
		return true;
	// IPv4-mapped and IPv4-compatible IPv6 addresses carry an IPv4 address.
	const mapped = /^::(?:ffff:)?(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(
		host
	);
	const ipv4 = mapped
		? mapped[ 1 ] ??
		  [ parseInt( mapped[ 2 ], 16 ), parseInt( mapped[ 3 ], 16 ) ]
				.flatMap( ( word ) => [ word >> 8, word & 255 ] )
				.join( '.' )
		: host;
	const octets = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec( ipv4 )?.slice( 1 ).map( Number );
	if ( octets ) {
		const [ a, b ] = octets;
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			( a === 100 && b >= 64 && b <= 127 ) ||
			( a === 169 && b === 254 ) ||
			( a === 172 && b >= 16 && b <= 31 ) ||
			( a === 192 && b === 168 )
		);
	}
	return (
		host.includes( ':' ) &&
		( host === '::' ||
			host === '::1' ||
			/^f[cd][0-9a-f]{0,2}:/.test( host ) ||
			/^fe[89ab][0-9a-f]?:/.test( host ) )
	);
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
function wpcomScope( args: unknown ): { wpcomSiteId?: number } | undefined {
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

// Tool annotations describe these tools to hosts; they are hints. The classes
// here decide, and the tests require each to be at least as strict as the
// tool's annotations.
//
// Only a qualified tool can be enabled. The rules of the unqualified tools are
// where each one's qualification starts, not a claim that they are complete.
export const CLAUDE_STUDIO_TOOL_RULES: ReadonlyMap< string, ClaudeStudioToolRule > = ruleTable( [
	[ createSiteTool.name, unqualified( studioRule( 'local-change', { approval: 'host' } ) ) ],
	[ listSitesTool.name, unqualified( studioRule( 'remote-read' ) ) ],
	[
		getSiteInfoTool.name,
		// It resolves the site it names and reads that site's status from the
		// host, which the guarded host allows for the target site only. Like
		// every site tool, its module links `tools/utils.ts`, whose `runWpCli`
		// can reach WP-CLI only through the guarded host.
		qualified( onSite( 'read' ), using( LOCAL_SITE_HOST_CHANNELS ) ),
	],
	[ startSiteTool.name, unqualified( onSite( 'local-change', { approval: 'host' } ) ) ],
	[ stopSiteTool.name, unqualified( onSite( 'local-change', { approval: 'host' } ) ) ],
	[ deleteSiteTool.name, unqualified( onSite( 'local-overwrite', { approval: 'host' } ) ) ],
	[ createPreviewTool.name, unqualified( onSite( 'remote-change', { approval: 'host' } ) ) ],
	[ listPreviewsTool.name, unqualified( onSite( 'read' ) ) ],
	[ updatePreviewTool.name, unqualified( onSite( 'remote-overwrite', { approval: 'host' } ) ) ],
	[ deletePreviewTool.name, unqualified( studioRule( 'remote-overwrite', { approval: 'host' } ) ) ],
	[
		runWpCliTool.name,
		// The tool only resolves the site it names and hands the command to the
		// host, which classifies the command, binds it to the target and asks.
		// The call itself is a read only when the host would take its command for
		// one; anything else is a command. The host operation is classified and
		// journaled on its own arguments, whatever this says.
		qualified(
			onSite( 'command', {
				approval: 'host',
				classify: ( args ) => {
					const command = isRecord( args ) ? args.command : undefined;
					return typeof command === 'string' &&
						classifyWpCliArgs( splitCommandArgs( command ) ) === 'read'
						? 'read'
						: 'command';
				},
			} ),
			{
				readsLocalFiles: false,
				writesLocalFiles: false,
				drivesBrowser: false,
				requestsNetwork: false,
				spawnsProcess: false,
				runsWpCli: [ 'site', 'host' ],
				callsHostOperation: [ 'host' ],
				reachesWpcom: false,
			}
		),
	],
	[ scaffoldThemeTool.name, unqualified( onSite( 'local-change' ) ) ],
	[ pickDesignTool.name, unqualified( studioRule( 'read' ) ) ],
	[
		validateBlocksTool.name,
		// It checks the markup in the named site's block editor, which it opens
		// signed in, in the shared browser.
		unqualified(
			onSite( 'local-overwrite', {
				navigates: true,
				paths: ( args, siteFolder ) => {
					const file = isRecord( args ) ? args.filePath : undefined;
					if ( file === undefined ) return [];
					if ( typeof file !== 'string' || ! siteFolder ) return;
					return [ path.resolve( siteFolder, file ) ];
				},
			} )
		),
	],
	[
		takeScreenshotTool.name,
		unqualified(
			studioRule( 'local-change', {
				urls: pageUrls,
				navigates: true,
				paths: ( args ) => {
					const directory = isRecord( args ) ? args.themeScreenshot : undefined;
					if ( directory === undefined ) return [];
					if ( typeof directory !== 'string' || ! path.isAbsolute( directory ) ) return;
					return [ path.resolve( directory ) ];
				},
			} )
		),
	],
	[
		inspectDesignTool.name,
		unqualified( studioRule( 'read', { urls: pageUrls, navigates: true } ) ),
	],
	[
		generateImagesTool.name,
		unqualified(
			studioRule( 'remote-change', {
				paths: ( args ) => {
					const images = isRecord( args ) ? args.images : undefined;
					if ( ! Array.isArray( images ) ) return;
					const files = images.map( ( image ) => ( isRecord( image ) ? image.path : undefined ) );
					if ( ! files.every( ( file ) => typeof file === 'string' && path.isAbsolute( file ) ) )
						return;
					return ( files as string[] ).map( ( file ) => path.resolve( file ) );
				},
			} )
		),
	],
	[ installTaxonomyScriptsTool.name, unqualified( onSite( 'local-change' ) ) ],
	[
		auditPerformanceTool.name,
		unqualified( onSite( 'read', { urls: auditUrls, urlsOnSite: true, navigates: true } ) ),
	],
	[
		auditSeoTool.name,
		unqualified( onSite( 'read', { urls: auditUrls, urlsOnSite: true, navigates: true } ) ),
	],
	[ listConnectedRemoteSitesTool.name, unqualified( onSite( 'remote-read' ) ) ],
	[
		wpcomRequestTool.name,
		unqualified(
			studioRule( 'remote-overwrite', {
				classify: ( args ) => {
					const method = isRecord( args ) ? args.method : undefined;
					if ( method === 'GET' ) return 'remote-read';
					if ( method === 'POST' || method === 'PUT' || method === 'DELETE' )
						return 'remote-overwrite';
				},
				remote: wpcomScope,
			} )
		),
	],
	[ pushSiteTool.name, unqualified( onSite( 'remote-overwrite', { approval: 'host' } ) ) ],
	[ pullSiteTool.name, unqualified( onSite( 'remote-overwrite', { approval: 'host' } ) ) ],
	[ importSiteTool.name, unqualified( onSite( 'local-overwrite', { approval: 'host' } ) ) ],
	[ exportSiteTool.name, unqualified( onSite( 'local-overwrite', { approval: 'host' } ) ) ],
	[
		openAnnotationBrowserTool.name,
		unqualified( studioRule( 'local-change', { urls: pageUrls, navigates: true } ) ),
	],
	[ refreshBrowserTool.name, unqualified( studioRule( 'read' ) ) ],
	[ sendFeedbackTool.name, unqualified( studioRule( 'external-message' ) ) ],
	// Tools built by factories for the host's capabilities.
	[ 'AskUserQuestion', unqualified( studioRule( 'read' ) ) ],
	[ 'Skill', unqualified( studioRule( 'read' ) ) ],
	[
		'present_design_options',
		// It renders HTML the model supplies: it writes that HTML to a file in the
		// host's screenshot folder, loads the file in the shared browser, and
		// first reads every image the HTML names by absolute path or `file:` URL.
		// No argument names those files, so nothing in the rule bounds either
		// file channel yet.
		unqualified( studioRule( 'local-change', { navigates: true } ), [
			'readsLocalFiles',
			'writesLocalFiles',
		] ),
	],
] );

export interface ClaudeNativeToolRule {
	readonly operationClass: ClaudeOperationClass;
	/** The input field naming the path the tool reaches, checked against the target's folders. */
	readonly path?: {
		readonly field: string;
		readonly required: boolean;
		readonly allowRoot: boolean;
	};
	/** Input fields holding a file pattern, which must stay under the searched folder. */
	readonly patterns?: readonly string[];
	/** Rejects input the policy cannot bound. */
	readonly accepts?: ( input: Record< string, unknown > ) => boolean;
	/** Runs an unstructured command; it can be enabled only under a verified confinement. */
	readonly shell?: true;
}

const SHELL_TIMEOUT_LIMIT_MS = 10 * 60 * 1000;

// A shell command is never judged safe by its text: every call needs approval
// of the exact command. These bounds keep it in the foreground, where the turn's
// cancellation reaches it, and refuse a request to run outside any sandbox.
function isBoundedShellInput( input: Record< string, unknown > ): boolean {
	const {
		command,
		timeout,
		description,
		run_in_background: background,
		dangerouslyDisableSandbox: unsandboxed,
		...rest
	} = input;
	return (
		Object.keys( rest ).length === 0 &&
		typeof command === 'string' &&
		command.trim().length > 0 &&
		command.length <= 10000 &&
		( timeout === undefined ||
			( Number.isInteger( timeout ) &&
				( timeout as number ) > 0 &&
				( timeout as number ) <= SHELL_TIMEOUT_LIMIT_MS ) ) &&
		( description === undefined || typeof description === 'string' ) &&
		( background === undefined || background === false ) &&
		( unsandboxed === undefined || unsandboxed === false )
	);
}

// A file pattern: letters, digits, '.', '_', '-', '/', '*', '?' and brace
// groups of two or more non-empty alternatives made of the same characters
// without '/'. Nothing else: no backslash, extglob, '(', ')', '|', '[', '!',
// '~', ':', whitespace, nested or unbalanced group.
const GLOB_PATTERN = /^(?:[A-Za-z0-9._*?/-]|\{[A-Za-z0-9._*?-]+(?:,[A-Za-z0-9._*?-]+)+\})+$/;
const GLOB_MAX_LENGTH = 512;
const GLOB_MAX_EXPANSIONS = 256;

// A segment with a leading dot whose wildcards can make it `..`. A shell lists
// `.` and `..` for such a segment, so `.*/x` can reach the parent.
function mayNameParent( segment: string ): boolean {
	if ( ! segment.startsWith( '.' ) ) return false;
	const source = segment.replace( /\./g, '\\.' ).replace( /\*+/g, '.*' ).replace( /\?/g, '.' );
	return new RegExp( `^${ source }$` ).test( '..' );
}

/**
 * A file pattern that cannot match above the folder it is searched from, for
 * any glob engine: it is in the grammar above, it is relative, and none of the
 * patterns its brace groups expand to contains `..`, an empty segment (an
 * engine that drops a leading `./` would make `.//` absolute) or a segment
 * that can match `..`. Stricter than any engine, so a legitimate pattern may
 * need rewording.
 */
export function isContainedPattern( pattern: unknown ): boolean {
	if (
		typeof pattern !== 'string' ||
		pattern.length > GLOB_MAX_LENGTH ||
		pattern.startsWith( '/' ) ||
		! GLOB_PATTERN.test( pattern )
	)
		return false;
	let expansions = [ '' ];
	for ( const part of pattern.split( /(\{[^{}]*\})/ ) ) {
		const choices = part.startsWith( '{' ) ? part.slice( 1, -1 ).split( ',' ) : [ part ];
		if ( expansions.length * choices.length > GLOB_MAX_EXPANSIONS ) return false;
		expansions = expansions.flatMap( ( prefix ) => choices.map( ( choice ) => prefix + choice ) );
	}
	return expansions.every(
		( expansion ) =>
			! expansion.includes( '..' ) &&
			! expansion.includes( '//' ) &&
			! expansion.split( '/' ).some( mayNameParent )
	);
}

const filePath = { field: 'file_path', required: true, allowRoot: false } as const;
const searchPath = { field: 'path', required: false, allowRoot: true } as const;

export const CLAUDE_NATIVE_TOOL_RULES: ReadonlyMap< string, ClaudeNativeToolRule > =
	ruleTable< ClaudeNativeToolRule >( [
		[ 'Read', { operationClass: 'read', path: filePath } ],
		[ 'Grep', { operationClass: 'read', path: searchPath, patterns: [ 'glob' ] } ],
		[ 'Glob', { operationClass: 'read', path: searchPath, patterns: [ 'pattern' ] } ],
		[ 'LS', { operationClass: 'read', path: { ...searchPath, required: true } } ],
		[ 'Write', { operationClass: 'local-change', path: filePath } ],
		[ 'Edit', { operationClass: 'local-change', path: filePath } ],
		[ 'MultiEdit', { operationClass: 'local-change', path: filePath } ],
		[ 'Bash', { operationClass: 'command', accepts: isBoundedShellInput, shell: true } ],
	] );

// The sandbox settings a verified confinement may use. Everything else is
// refused, including what the SDK describes as weakening isolation or letting
// commands out (excludedCommands, allowNestedUserNamespaces, allowAppleEvents,
// enableWeakerNestedSandbox, enableWeakerNetworkIsolation, ignoreViolations,
// filesystem.disabled, network exceptions, and replaced sandbox binaries).
const SANDBOX_KEYS: ReadonlySet< string > = new Set( [
	'enabled',
	'failIfUnavailable',
	'autoAllowBashIfSandboxed',
	'allowUnsandboxedCommands',
	'filesystem',
] );
const SANDBOX_FILESYSTEM_KEYS: ReadonlySet< string > = new Set( [
	'allowWrite',
	'denyWrite',
	'denyRead',
] );

const SHELL_CONFINEMENT_KEYS: ReadonlySet< string > = new Set( [ 'mode', 'sandbox' ] );

/**
 * Whether a declared confinement can be verified. A sandbox counts only when
 * it uses no setting outside a short list, is enabled, refuses to run without
 * its dependencies, never lets a command out, leaves every command to the
 * user's approval and writes only in the workspace. The declaration is read
 * as plain data at every level, so what is verified is what the SDK receives;
 * a malformed one is unverified and never throws.
 */
export function isVerifiedShellConfinement(
	confinement: ClaudeShellConfinement,
	workspace: string
): boolean {
	const declared = plainData( confinement );
	if ( ! declared || typeof workspace !== 'string' ) return false;
	if ( declared.mode === 'approval-only' ) return Object.keys( declared ).length === 1;
	if ( declared.mode !== 'sandbox' || ! hasOnlyKeys( declared, SHELL_CONFINEMENT_KEYS ) )
		return false;
	const sandbox = plainData( declared.sandbox );
	if ( ! sandbox || ! hasOnlyKeys( sandbox, SANDBOX_KEYS ) ) return false;
	const filesystem = sandbox.filesystem === undefined ? {} : plainData( sandbox.filesystem );
	if ( ! filesystem || ! hasOnlyKeys( filesystem, SANDBOX_FILESYSTEM_KEYS ) ) return false;
	const lists = new Map(
		Object.entries( filesystem ).map( ( [ key, value ] ) => [ key, plainStrings( value ) ] )
	);
	return (
		sandbox.enabled === true &&
		( sandbox.failIfUnavailable === undefined || sandbox.failIfUnavailable === true ) &&
		sandbox.allowUnsandboxedCommands === false &&
		sandbox.autoAllowBashIfSandboxed === false &&
		[ ...lists.values() ].every( ( list ) => !! list ) &&
		( lists.get( 'allowWrite' ) ?? [] ).every(
			( root ) => path.isAbsolute( root ) && isInside( workspace, path.resolve( root ) )
		)
	);
}

/** The native tools a turn may run: enabled, known, and confined when they are shells. */
export function claudeNativeTools(
	enabled: ClaudeEnabledTools,
	confinement: ClaudeShellConfinement,
	workspace: string
): string[] {
	let confined: boolean | undefined;
	return ( plainStrings( plainData( enabled )?.native ) ?? [] ).filter( ( name ) => {
		const rule = CLAUDE_NATIVE_TOOL_RULES.get( name );
		return (
			!! rule &&
			( ! rule.shell || ( confined ??= isVerifiedShellConfinement( confinement, workspace ) ) )
		);
	} );
}

// The bindings that can bound each channel. `needs` must be among those a
// declaration names: a browser is bounded only under the navigation guard, and
// WP-CLI and host operations only through the host guard. A file is bounded by
// checked paths, not by naming a site, and never by an approval alone: an
// approval shows the local paths the rule names, so one that names none would
// ask about files without showing them. A request Studio sends is bounded by a
// scope or an approval, not by a URL check, which cannot see where a name resolves.
const CHANNEL_BOUNDS: Readonly<
	Record<
		ClaudeToolChannel,
		{ readonly admits: readonly ClaudeChannelBinding[]; readonly needs?: ClaudeChannelBinding }
	>
> = {
	readsLocalFiles: { admits: [ 'paths', 'class' ], needs: 'paths' },
	writesLocalFiles: { admits: [ 'paths', 'class' ], needs: 'paths' },
	drivesBrowser: { admits: [ 'navigates', 'urls', 'site' ], needs: 'navigates' },
	requestsNetwork: { admits: [ 'scope', 'class' ] },
	spawnsProcess: { admits: [ 'class' ] },
	runsWpCli: { admits: [ 'host', 'site' ], needs: 'host' },
	callsHostOperation: { admits: [ 'host', 'site' ], needs: 'host' },
	reachesWpcom: { admits: [ 'scope', 'class', 'host' ] },
};

const QUALIFIED_KEYS: ReadonlySet< string > = new Set( [ 'qualified', 'channels' ] );

// The elements a qualified rule may have, and whether each is a function or a mark.
const RULE_ELEMENTS: Readonly<
	Record< keyof ClaudeStudioToolRule, 'function' | 'mark' | 'other' >
> = {
	qualification: 'other',
	operationClass: 'other',
	approval: 'other',
	classify: 'function',
	site: 'function',
	paths: 'function',
	remote: 'function',
	urls: 'function',
	urlsOnSite: 'mark',
	navigates: 'mark',
};

function isRuleElement( [ key, value ]: [ string, unknown ] ): boolean {
	if ( ! hasOwn( RULE_ELEMENTS, key ) ) return false;
	const kind = RULE_ELEMENTS[ key as keyof ClaudeStudioToolRule ];
	return (
		kind === 'other' ||
		value === undefined ||
		( kind === 'mark' ? value === true : typeof value === 'function' )
	);
}

function isOperationClass( value: unknown ): value is ClaudeOperationClass {
	return typeof value === 'string' && hasOwn( CLASS_DESCRIPTIONS, value );
}

// Whether a rule has what a binding names. `class` bounds a channel only when
// every call is approved: the class asks, and no argument narrows it.
function ruleHas( rule: Record< string, unknown >, binding: unknown ): boolean {
	switch ( binding ) {
		case 'site':
			return typeof rule.site === 'function';
		case 'paths':
			return typeof rule.paths === 'function';
		case 'urls':
			return typeof rule.urls === 'function';
		case 'navigates':
			return rule.navigates === true;
		case 'scope':
			return typeof rule.remote === 'function';
		case 'class':
			return (
				isOperationClass( rule.operationClass ) &&
				requiresClaudeApproval( rule.operationClass ) &&
				rule.classify === undefined
			);
		case 'host':
			return true;
		default:
			return false;
	}
}

// The elements of a rule that is qualified, or undefined. Read as plain data,
// so a qualification cannot be inherited, computed or planted on a prototype.
function qualifiedElements( rule: unknown ): Record< string, unknown > | undefined {
	const elements = plainData( rule );
	const qualification = plainData( elements?.qualification );
	if (
		! elements ||
		! qualification ||
		qualification.qualified !== true ||
		! hasOnlyKeys( qualification, QUALIFIED_KEYS ) ||
		! Object.entries( elements ).every( isRuleElement ) ||
		! isOperationClass( elements.operationClass ) ||
		( elements.approval !== 'host' && elements.approval !== 'tool' )
	)
		return;
	const channels = plainData( qualification.channels );
	if ( ! channels || Object.keys( channels ).length !== CLAUDE_TOOL_CHANNELS.length ) return;
	const used = new Set< ClaudeToolChannel >();
	for ( const channel of CLAUDE_TOOL_CHANNELS ) {
		if ( ! hasOwn( channels, channel ) ) return;
		if ( channels[ channel ] === false ) continue;
		const bindings = plainList( channels[ channel ] );
		const { admits, needs } = CHANNEL_BOUNDS[ channel ];
		if (
			! bindings?.length ||
			! bindings.every(
				( binding ) =>
					admits.includes( binding as ClaudeChannelBinding ) && ruleHas( elements, binding )
			) ||
			( needs && ! bindings.includes( needs ) )
		)
			return;
		used.add( channel );
	}
	// The declaration has to cover what the rule itself shows the tool does.
	const covers =
		( elements.navigates === true ) === used.has( 'drivesBrowser' ) &&
		( elements.remote === undefined || used.has( 'reachesWpcom' ) ) &&
		( elements.paths === undefined ||
			used.has( 'readsLocalFiles' ) ||
			used.has( 'writesLocalFiles' ) ) &&
		( elements.urls === undefined ||
			used.has( 'drivesBrowser' ) ||
			used.has( 'requestsNetwork' ) ) &&
		( elements.approval !== 'host' || used.has( 'callsHostOperation' ) ) &&
		( ! used.has( 'runsWpCli' ) || used.has( 'callsHostOperation' ) );
	return covers ? elements : undefined;
}

/**
 * Whether a rule is qualified: marked so, with a declaration that covers every
 * channel, binds each one it uses by something the rule has and that can bound
 * that channel, and accounts for what the rule's own elements show.
 */
export function isQualifiedStudioRule( rule: unknown ): boolean {
	return !! qualifiedElements( rule );
}

/**
 * The tools of a rule table a turn may run: named by the host, qualified, and
 * under a verified navigation guard when they drive a browser. Nothing the
 * host, a confinement or a guard declares enables a tool that is not
 * qualified, and a malformed list or declaration enables nothing.
 */
export function selectClaudeStudioTools(
	rules: ReadonlyMap< string, ClaudeStudioToolRule >,
	enabled: ClaudeEnabledTools,
	navigation: ClaudeNavigationConfinement,
	targetOrigin: string | null
): string[] {
	let guarded: boolean | undefined;
	return ( plainStrings( plainData( enabled )?.studio ) ?? [] ).filter( ( name ) => {
		const elements = qualifiedElements( rules.get( name ) );
		return (
			!! elements &&
			( elements.navigates !== true ||
				( guarded ??= isVerifiedNavigationGuard( navigation, targetOrigin ) ) )
		);
	} );
}

/** The Studio tools a turn may run in this build. */
export function claudeStudioTools(
	enabled: ClaudeEnabledTools,
	navigation: ClaudeNavigationConfinement,
	targetOrigin: string | null
): string[] {
	return selectClaudeStudioTools( CLAUDE_STUDIO_TOOL_RULES, enabled, navigation, targetOrigin );
}

/** Every tool name the native runtime may report for a turn. */
export function claudeToolInventory(
	enabled: ClaudeEnabledTools,
	confinement: ClaudeShellConfinement,
	workspace: string,
	navigation: ClaudeNavigationConfinement,
	targetOrigin: string | null
): string[] {
	return [
		...claudeNativeTools( enabled, confinement, workspace ),
		...claudeStudioTools( enabled, navigation, targetOrigin ).map( studioMcpToolName ),
	];
}

/**
 * What this route runs of what a tool's canonical description offers, written
 * from the rules that decide it; undefined for a tool whose description holds
 * as it is. The canonical description, which every route shares, is unchanged.
 */
export function claudeRouteNote( name: string ): string | undefined {
	if ( name !== runWpCliTool.name ) return;
	const commands = wpCliRouteCommands().map( ( { usage, operationClass } ) =>
		requiresClaudeApproval( operationClass )
			? `\`${ usage }\` (once the user approves it)`
			: `\`${ usage }\``
	);
	return `On this route Studio runs only these WP-CLI commands, in exactly these forms: ${ commands.join(
		'; '
	) }. It refuses every other command and option.`;
}

/** The name the native runtime knows a Studio tool by. */
export function studioMcpToolName( name: string ): string {
	return STUDIO_MCP_PREFIX + name;
}

/** The Studio tool a native MCP tool name refers to, when it is one. */
export function studioToolName( name: string ): string | undefined {
	return name.startsWith( STUDIO_MCP_PREFIX ) ? name.slice( STUDIO_MCP_PREFIX.length ) : undefined;
}

export type HostOperationName =
	| 'sites.create'
	| 'sites.start'
	| 'sites.stop'
	| 'sites.delete'
	| 'sites.import'
	| 'sites.export'
	| 'sites.wpCli'
	| 'previews.create'
	| 'previews.update'
	| 'previews.delete'
	| 'sync.push'
	| 'sync.pull';

export const HOST_OPERATION_CLASSES: Readonly<
	Record< Exclude< HostOperationName, 'sites.wpCli' >, ClaudeOperationClass >
> = {
	'sites.create': 'local-change',
	'sites.start': 'local-change',
	'sites.stop': 'local-change',
	'sites.delete': 'local-overwrite',
	'sites.import': 'local-overwrite',
	'sites.export': 'local-overwrite',
	'previews.create': 'remote-change',
	'previews.update': 'remote-overwrite',
	'previews.delete': 'remote-overwrite',
	'sync.push': 'remote-overwrite',
	'sync.pull': 'remote-overwrite',
};

/** Whether a name is one of the host operations a Studio tool reaches. */
export function isClaudeHostOperation( name: string ): boolean {
	return (
		name === 'sites.wpCli' || Object.prototype.hasOwnProperty.call( HOST_OPERATION_CLASSES, name )
	);
}

/**
 * Whether this build has a rule for a tool or host operation of that name.
 * Recovery takes a tool it does not recognise to have done more than read.
 */
export function isKnownClaudeTool( name: string ): boolean {
	return (
		CLAUDE_STUDIO_TOOL_RULES.has( name ) ||
		CLAUDE_NATIVE_TOOL_RULES.has( name ) ||
		isClaudeHostOperation( name )
	);
}

const CLASS_DESCRIPTIONS: Readonly< Record< ClaudeOperationClass, string > > = {
	read: 'Read',
	'remote-read': 'Read from WordPress.com',
	'local-change': 'Change local work',
	'local-overwrite': 'Change or delete local work',
	'remote-change': 'Change something on WordPress.com',
	'remote-overwrite': 'Change or delete work on WordPress.com',
	'external-message': 'Send a message outside Studio',
	command: 'Run a command',
};

/** What the user is asked to allow. A shell command says how far it reaches. */
export function describeClaudeOperation(
	operationClass: ClaudeOperationClass,
	tool: string,
	shell?: ClaudeShellConfinement
): string {
	if ( shell?.mode === 'sandbox' )
		return `Run a command in a sandbox that can write only in the workspace: ${ tool }`;
	if ( shell )
		return `Run a command that is not confined to the workspace: it can read and change anything your account can: ${ tool }`;
	return `${ CLASS_DESCRIPTIONS[ operationClass ] }: ${ tool }`;
}
