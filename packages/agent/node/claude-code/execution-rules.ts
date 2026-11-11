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
import type { ClaudeOperationClass } from '@studio/agent/protocol/claude-code';

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
 * Whether a host name belongs to this machine or a private network: loopback,
 * private, link-local and unique-local addresses, `localhost` and `.local`.
 */
export function isLocalHostname( hostname: string ): boolean {
	const host = hostname.toLowerCase().replace( /^\[|\]$/g, '' );
	if (
		! host ||
		host === 'localhost' ||
		host.endsWith( '.localhost' ) ||
		host.endsWith( '.local' )
	)
		return true;
	const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec( host );
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

// The WordPress.com scope of a `wpcom_request` call, decided from everything
// the client builds the request from: the path, the namespace and the query.
// A path that could step out of its site once the URL is normalized, or carry
// its own query, is denied.
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
	const route = args.path;
	if ( /\.\.|%2e|[\\?#]/i.test( route ) ) return;
	if ( ! route.startsWith( '!' ) )
		return Number.isSafeInteger( args.siteId ) ? { wpcomSiteId: args.siteId as number } : undefined;
	const absolute = route.slice( 1 );
	const site = /^\/sites\/([^/]+)(?:\/|$)/.exec( absolute );
	if ( site ) {
		const id = Number( site[ 1 ] );
		return /^\d+$/.test( site[ 1 ] ) && Number.isSafeInteger( id )
			? { wpcomSiteId: id }
			: undefined;
	}
	return args.method === 'GET' && WPCOM_ACCOUNT_READS.has( absolute ) ? {} : undefined;
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
			paths: ( args ) => {
				const directory = isRecord( args ) ? args.themeScreenshot : undefined;
				if ( directory === undefined ) return [];
				if ( typeof directory !== 'string' || ! path.isAbsolute( directory ) ) return;
				return [ path.resolve( directory ) ];
			},
		} ),
	],
	[ inspectDesignTool.name, studioRule( 'read', { urls: pageUrls } ) ],
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
	[ auditPerformanceTool.name, onSite( 'read', { urls: auditUrls, urlsOnSite: true } ) ],
	[ auditSeoTool.name, onSite( 'read', { urls: auditUrls, urlsOnSite: true } ) ],
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
	[ openAnnotationBrowserTool.name, studioRule( 'local-change', { urls: pageUrls } ) ],
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

const ABSOLUTE_START = /^(?:[~/\\]|[a-z]:)/i;

/**
 * A file pattern that cannot match above the folder it is searched from, for
 * any glob engine: neither the pattern nor any alternative a brace or extglob
 * group expands to, at any depth, may be absolute or step up, and no character
 * class may match a separator.
 */
export function isContainedPattern( pattern: unknown ): boolean {
	if (
		typeof pattern !== 'string' ||
		! pattern.length ||
		pattern.includes( '..' ) ||
		ABSOLUTE_START.test( pattern ) ||
		path.isAbsolute( pattern )
	)
		return false;
	const groups: string[] = [];
	for ( let index = 0; index < pattern.length; index++ ) {
		const character = pattern[ index ];
		let alternative = false;
		if ( character === '{' || character === '(' ) {
			groups.push( character );
			alternative = true;
		} else if ( character === '}' || character === ')' ) {
			groups.pop();
		} else if (
			( character === ',' && groups.at( -1 ) === '{' ) ||
			( character === '|' && groups.at( -1 ) === '(' )
		) {
			alternative = true;
		} else if ( character === '[' ) {
			const end = pattern.indexOf( ']', index + 1 );
			if ( end === -1 || /[/\\]/.test( pattern.slice( index + 1, end ) ) ) return false;
		}
		if ( alternative && ABSOLUTE_START.test( pattern.slice( index + 1 ) ) ) return false;
	}
	return true;
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

/** Every tool name the native runtime may report for a turn. */
export function claudeToolInventory(
	enabled: ClaudeEnabledTools,
	confinement: ClaudeShellConfinement,
	workspace: string
): string[] {
	return [
		...claudeNativeTools( enabled, confinement, workspace ),
		...enabled.studio
			.filter( ( name ) => CLAUDE_STUDIO_TOOL_RULES.has( name ) )
			.map( ( name ) => STUDIO_MCP_PREFIX + name ),
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
