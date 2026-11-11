import { lstat, realpath } from 'fs/promises';
import os from 'os';
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
import { runWpCliTool } from '../tools/wp-cli';
import { wpcomRequestTool } from '../tools/wpcom-request';
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk/core';
import type { ClaudeOperationClass, ClaudeStudioTarget } from '@studio/agent/protocol/claude-code';

// What each operation is, independent of any turn. The execution policy applies
// these rules immediately before execution.

export interface ClaudeEnabledTools {
	readonly native: readonly string[];
	readonly studio: readonly string[];
}

/** What a Claude turn may run in this build. Widening it is a reviewed change. */
export const CLAUDE_ENABLED_TOOLS: ClaudeEnabledTools = Object.freeze( {
	native: Object.freeze( [ 'Read' ] ),
	studio: Object.freeze( [ runWpCliTool.name ] ),
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

/** The revision of the origin rule a navigation guard must apply. */
export const CLAUDE_NAVIGATION_RULE_REVISION = 1;

/**
 * What a browser-layer guard guarantees for every page a Studio tool opens. A
 * host name check cannot bind a browser: a public name can resolve to this
 * machine, and a page can redirect or load from anywhere. So a tool that opens
 * a URL in a browser can be enabled only under a guard declaring all of these,
 * for this rule revision and this turn's target.
 */
export interface ClaudeNavigationGuard {
	/** `CLAUDE_NAVIGATION_RULE_REVISION`. */
	readonly ruleRevision: number;
	/** The target site's own origin, or null for a global target. */
	readonly targetOrigin: string | null;
	/**
	 * Every request the browser sends for the tool passes the guard before it
	 * connects: navigations, frames, subresources, fetches, workers, WebSockets
	 * and prefetches, not only the first URL.
	 */
	readonly checksEveryRequest: true;
	/** Each redirect hop is checked as a new request before it is followed. */
	readonly checksEveryRedirect: true;
	/**
	 * The policy's origin rule, on host names normalized as `normalizeHostname`
	 * does: http and https only, no credentials, and a local host name or a
	 * local site's host name only at `targetOrigin`.
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
	 * A refused or unverifiable request fails, and the tool reports an error; a
	 * guard that cannot start stops the tool. Nothing is retried without it.
	 */
	readonly failsClosed: true;
}

export type ClaudeNavigationConfinement =
	| { readonly mode: 'none' }
	| { readonly mode: 'guarded'; readonly guard: ClaudeNavigationGuard | undefined };

/** This build has no navigation guard, so no tool that opens a URL in a browser can be enabled. */
export const CLAUDE_NAVIGATION_CONFINEMENT: ClaudeNavigationConfinement = Object.freeze( {
	mode: 'none',
} );

const NAVIGATION_GUARANTEES = [
	'checksEveryRequest',
	'checksEveryRedirect',
	'appliesOriginRule',
	'checksResolvedAddresses',
	'pinsCheckedAddress',
	'failsClosed',
] as const;
const NAVIGATION_GUARD_KEYS: ReadonlySet< string > = new Set( [
	'ruleRevision',
	'targetOrigin',
	...NAVIGATION_GUARANTEES,
] );

/**
 * Whether a declared navigation guard can be verified: it states every
 * guarantee and nothing else, applies this rule revision and is bound to this
 * turn's target origin.
 */
export function isVerifiedNavigationGuard(
	confinement: ClaudeNavigationConfinement,
	targetOrigin: string | null
): boolean {
	if ( confinement.mode !== 'guarded' ) return false;
	const guard: unknown = confinement.guard;
	return (
		isRecord( guard ) &&
		Object.keys( guard ).every( ( key ) => NAVIGATION_GUARD_KEYS.has( key ) ) &&
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

export interface ClaudeStudioToolRule {
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
	/** Opens its URLs in a browser; it can be enabled only under a verified navigation guard. */
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

function studioRule(
	operationClass: ClaudeOperationClass,
	options: Partial< Omit< ClaudeStudioToolRule, 'operationClass' > > = {}
): ClaudeStudioToolRule {
	return { operationClass, approval: 'tool', ...options };
}

function onSite(
	operationClass: ClaudeOperationClass,
	options: Partial< Omit< ClaudeStudioToolRule, 'operationClass' > > = {}
): ClaudeStudioToolRule {
	return studioRule( operationClass, { site: namedSite, ...options } );
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
export const CLAUDE_STUDIO_TOOL_RULES: ReadonlyMap< string, ClaudeStudioToolRule > = new Map( [
	[ createSiteTool.name, studioRule( 'local-change', { approval: 'host' } ) ],
	[ listSitesTool.name, studioRule( 'remote-read' ) ],
	[ getSiteInfoTool.name, onSite( 'read' ) ],
	[ startSiteTool.name, onSite( 'local-change', { approval: 'host' } ) ],
	[ stopSiteTool.name, onSite( 'local-change', { approval: 'host' } ) ],
	[ deleteSiteTool.name, onSite( 'local-overwrite', { approval: 'host' } ) ],
	[ createPreviewTool.name, onSite( 'remote-change', { approval: 'host' } ) ],
	[ listPreviewsTool.name, onSite( 'read' ) ],
	[ updatePreviewTool.name, onSite( 'remote-overwrite', { approval: 'host' } ) ],
	[ deletePreviewTool.name, studioRule( 'remote-overwrite', { approval: 'host' } ) ],
	[ runWpCliTool.name, onSite( 'command', { approval: 'host' } ) ],
	[ scaffoldThemeTool.name, onSite( 'local-change' ) ],
	[ pickDesignTool.name, studioRule( 'read' ) ],
	[
		validateBlocksTool.name,
		onSite( 'local-overwrite', {
			paths: ( args, siteFolder ) => {
				const file = isRecord( args ) ? args.filePath : undefined;
				if ( file === undefined ) return [];
				if ( typeof file !== 'string' || ! siteFolder ) return;
				return [ path.resolve( siteFolder, file ) ];
			},
		} ),
	],
	[
		takeScreenshotTool.name,
		studioRule( 'local-change', {
			urls: pageUrls,
			navigates: true,
			paths: ( args ) => {
				const directory = isRecord( args ) ? args.themeScreenshot : undefined;
				if ( directory === undefined ) return [];
				if ( typeof directory !== 'string' || ! path.isAbsolute( directory ) ) return;
				return [ path.resolve( directory ) ];
			},
		} ),
	],
	[ inspectDesignTool.name, studioRule( 'read', { urls: pageUrls, navigates: true } ) ],
	[
		generateImagesTool.name,
		studioRule( 'remote-change', {
			paths: ( args ) => {
				const images = isRecord( args ) ? args.images : undefined;
				if ( ! Array.isArray( images ) ) return;
				const files = images.map( ( image ) => ( isRecord( image ) ? image.path : undefined ) );
				if ( ! files.every( ( file ) => typeof file === 'string' && path.isAbsolute( file ) ) )
					return;
				return ( files as string[] ).map( ( file ) => path.resolve( file ) );
			},
		} ),
	],
	[ installTaxonomyScriptsTool.name, onSite( 'local-change' ) ],
	[
		auditPerformanceTool.name,
		onSite( 'read', { urls: auditUrls, urlsOnSite: true, navigates: true } ),
	],
	[ auditSeoTool.name, onSite( 'read', { urls: auditUrls, urlsOnSite: true, navigates: true } ) ],
	[ listConnectedRemoteSitesTool.name, onSite( 'remote-read' ) ],
	[
		wpcomRequestTool.name,
		studioRule( 'remote-overwrite', {
			classify: ( args ) => {
				const method = isRecord( args ) ? args.method : undefined;
				if ( method === 'GET' ) return 'remote-read';
				if ( method === 'POST' || method === 'PUT' || method === 'DELETE' )
					return 'remote-overwrite';
			},
			remote: wpcomScope,
		} ),
	],
	[ pushSiteTool.name, onSite( 'remote-overwrite', { approval: 'host' } ) ],
	[ pullSiteTool.name, onSite( 'remote-overwrite', { approval: 'host' } ) ],
	[ importSiteTool.name, onSite( 'local-overwrite', { approval: 'host' } ) ],
	[ exportSiteTool.name, onSite( 'local-overwrite', { approval: 'host' } ) ],
	[
		openAnnotationBrowserTool.name,
		studioRule( 'local-change', { urls: pageUrls, navigates: true } ),
	],
	[ refreshBrowserTool.name, studioRule( 'read' ) ],
	[ sendFeedbackTool.name, studioRule( 'external-message' ) ],
	// Tools built by factories for the host's capabilities.
	[ 'AskUserQuestion', studioRule( 'read' ) ],
	[ 'Skill', studioRule( 'read' ) ],
	[ 'present_design_options', studioRule( 'local-change' ) ],
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

export const CLAUDE_NATIVE_TOOL_RULES: ReadonlyMap< string, ClaudeNativeToolRule > = new Map<
	string,
	ClaudeNativeToolRule
>( [
	[ 'Read', { operationClass: 'read', path: filePath } ],
	[ 'Grep', { operationClass: 'read', path: searchPath, patterns: [ 'glob' ] } ],
	[ 'Glob', { operationClass: 'read', path: searchPath, patterns: [ 'pattern' ] } ],
	[ 'LS', { operationClass: 'read', path: { ...searchPath, required: true } } ],
	[ 'Write', { operationClass: 'local-change', path: filePath } ],
	[ 'Edit', { operationClass: 'local-change', path: filePath } ],
	[ 'MultiEdit', { operationClass: 'local-change', path: filePath } ],
	[ 'Bash', { operationClass: 'command', accepts: isBoundedShellInput, shell: true } ],
] );

function isInside( root: string, candidate: string ): boolean {
	const relative = path.relative( root, candidate );
	return (
		relative === '' ||
		( relative !== '..' &&
			! relative.startsWith( '..' + path.sep ) &&
			! path.isAbsolute( relative ) )
	);
}

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

const isStringList = ( value: unknown ): value is string[] =>
	Array.isArray( value ) && value.every( ( item ) => typeof item === 'string' );

/**
 * Whether a declared confinement can be verified. A sandbox counts only when
 * it uses no setting outside a short list, is enabled, refuses to run without
 * its dependencies, never lets a command out, leaves every command to the
 * user's approval and writes only in the workspace.
 */
export function isVerifiedShellConfinement(
	confinement: ClaudeShellConfinement,
	workspace: string
): boolean {
	if ( confinement.mode === 'approval-only' ) return true;
	if ( confinement.mode !== 'sandbox' ) return false;
	const sandbox: unknown = confinement.sandbox;
	if (
		! isRecord( sandbox ) ||
		Object.keys( sandbox ).some( ( key ) => ! SANDBOX_KEYS.has( key ) )
	)
		return false;
	const filesystem = sandbox.filesystem ?? {};
	return (
		sandbox.enabled === true &&
		( sandbox.failIfUnavailable === undefined || sandbox.failIfUnavailable === true ) &&
		sandbox.allowUnsandboxedCommands === false &&
		sandbox.autoAllowBashIfSandboxed === false &&
		isRecord( filesystem ) &&
		Object.entries( filesystem ).every(
			( [ key, value ] ) => SANDBOX_FILESYSTEM_KEYS.has( key ) && isStringList( value )
		) &&
		( ( filesystem.allowWrite as string[] | undefined ) ?? [] ).every(
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
	return enabled.native.filter( ( name ) => {
		const rule = CLAUDE_NATIVE_TOOL_RULES.get( name );
		return !! rule && ( ! rule.shell || isVerifiedShellConfinement( confinement, workspace ) );
	} );
}

/** The Studio tools a turn may run: enabled, known, and guarded when they open a browser. */
export function claudeStudioTools(
	enabled: ClaudeEnabledTools,
	navigation: ClaudeNavigationConfinement,
	targetOrigin: string | null
): string[] {
	return enabled.studio.filter( ( name ) => {
		const rule = CLAUDE_STUDIO_TOOL_RULES.get( name );
		return !! rule && ( ! rule.navigates || isVerifiedNavigationGuard( navigation, targetOrigin ) );
	} );
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
		...claudeStudioTools( enabled, navigation, targetOrigin ).map(
			( name ) => STUDIO_MCP_PREFIX + name
		),
	];
}

/** The Studio tool a native MCP tool name refers to, when it is one. */
export function studioToolName( name: string ): string | undefined {
	return name.startsWith( STUDIO_MCP_PREFIX ) ? name.slice( STUDIO_MCP_PREFIX.length ) : undefined;
}

function isSensitivePath( candidate: string ): boolean {
	return candidate
		.split( /[\\/]/ )
		.some( ( part ) =>
			/^(?:\.env(?:\..*)?|wp-config\.php|\.credentials(?:\..*)?|\.ssh|database|.*secret.*|.*credential.*|.*\.(?:pem|key|p12|pfx))$/i.test(
				part
			)
		);
}

/**
 * Whether a native file tool may reach an existing path: inside one of the
 * canonical roots, outside the native configuration and clear of files that
 * commonly hold credentials.
 */
export async function isAllowedNativePath(
	file: string,
	roots: readonly string[],
	configDirectory: string,
	allowRoot = false
): Promise< boolean > {
	if ( ! path.isAbsolute( file ) ) return false;
	try {
		const canonical = await realpath( file );
		return (
			roots.some(
				( root ) => isInside( root, canonical ) && ( allowRoot || canonical !== root )
			) &&
			! isInside( configDirectory, canonical ) &&
			! isSensitivePath( file ) &&
			! isSensitivePath( canonical )
		);
	} catch {
		return false;
	}
}

/**
 * Whether a path, which may not exist yet, lies in a canonical root once its
 * deepest existing folder is resolved.
 */
export async function isInsideCanonicalRoot( root: string, file: string ): Promise< boolean > {
	if ( ! path.isAbsolute( file ) ) return false;
	const missing: string[] = [];
	for ( let current = path.resolve( file ); ; current = path.dirname( current ) ) {
		try {
			return isInside( root, path.join( await realpath( current ), ...missing ) );
		} catch ( error ) {
			if (
				( error as NodeJS.ErrnoException ).code !== 'ENOENT' ||
				path.dirname( current ) === current
			)
				return false;
			missing.unshift( path.basename( current ) );
		}
	}
}

// The WP-CLI commands this build runs: a few reads and one bounded draft creation.
export function classifyWpCliArgs( args: readonly unknown[] ): ClaudeOperationClass | undefined {
	if ( ! args.every( ( arg ) => typeof arg === 'string' ) ) return;
	const list = args as readonly string[];
	if (
		list.length === 3 &&
		list[ 0 ] === 'option' &&
		list[ 1 ] === 'get' &&
		[ 'blogname', 'blogdescription', 'home', 'siteurl' ].includes( list[ 2 ] )
	)
		return 'read';
	if ( list.length === 2 && list[ 0 ] === 'post' && list[ 1 ] === 'list' ) return 'read';
	if (
		list.length === 3 &&
		list[ 0 ] === 'post' &&
		list[ 1 ] === 'get' &&
		/^\d{1,10}$/.test( list[ 2 ] )
	)
		return 'read';
	if ( list[ 0 ] !== 'post' || list[ 1 ] !== 'create' || list.length < 4 || list.length > 5 )
		return;
	const options = list.slice( 2 );
	if ( new Set( options.map( ( option ) => option.split( '=', 1 )[ 0 ] ) ).size !== options.length )
		return;
	if ( ! options.includes( '--post_status=draft' ) ) return;
	if ( ! options.some( ( option ) => /^--post_title=[\s\S]{1,200}$/.test( option ) ) ) return;
	if (
		! options.every(
			( option ) =>
				option === '--post_status=draft' ||
				/^--post_title=[\s\S]{1,200}$/.test( option ) ||
				/^--post_content=[\s\S]{0,10000}$/.test( option )
		)
	)
		return;
	return 'command';
}

export function wpCliOption( args: readonly unknown[], name: string ): string | undefined {
	const prefix = `--${ name }=`;
	const option = args.find(
		( arg ): arg is string => typeof arg === 'string' && arg.startsWith( prefix )
	);
	return option?.slice( prefix.length );
}

// WP-CLI reads configuration that can point a command at another site or host.
export async function hasWpCliOverrides( siteDirectory: string ): Promise< boolean > {
	if (
		Object.entries( process.env ).some( ( [ name, value ] ) => /^WP_CLI_/i.test( name ) && value )
	)
		return true;
	const candidates = new Set( [ path.join( os.homedir(), '.wp-cli', 'config.yml' ) ] );
	if ( process.env.HOME && path.isAbsolute( process.env.HOME ) ) {
		candidates.add( path.join( process.env.HOME, '.wp-cli', 'config.yml' ) );
	}
	for ( let directory = siteDirectory; ; directory = path.dirname( directory ) ) {
		candidates.add( path.join( directory, 'wp-cli.local.yml' ) );
		candidates.add( path.join( directory, 'wp-cli.yml' ) );
		if ( path.dirname( directory ) === directory ) break;
	}
	for ( const candidate of candidates ) {
		try {
			await lstat( candidate );
			return true;
		} catch ( error ) {
			if ( ( error as NodeJS.ErrnoException ).code !== 'ENOENT' ) return true;
		}
	}
	return false;
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
