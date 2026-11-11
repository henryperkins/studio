import { createHash, randomUUID } from 'crypto';
import { lstat, realpath } from 'fs/promises';
import os from 'os';
import path from 'path';
import { escapeClaudeApprovalText } from '@studio/agent/protocol/claude-code';
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
import type { HostOperationOptions, HostSite, StudioAgentHost } from '../host';
import type {
	BackendApprovalOperation,
	BackendTurnEvent,
} from '@studio/agent/protocol/backend-events';
import type { ClaudeOperationClass, ClaudeStudioTarget } from '@studio/agent/protocol/claude-code';

/**
 * The single place that decides what a Claude turn may execute. The SDK
 * PreToolUse hook, the native permission request, Studio's in-process MCP tools
 * and every host operation they reach ask it, immediately before execution.
 * Anything it does not know is denied.
 */

/** Changes whenever what this policy allows changes; turns and approvals carry it. */
export const CLAUDE_EXECUTION_POLICY_REVISION = 1;

export interface ClaudeEnabledTools {
	readonly native: readonly string[];
	readonly studio: readonly string[];
}

/** What a Claude turn may run in this build. Widening it is a reviewed change. */
export const CLAUDE_ENABLED_TOOLS: ClaudeEnabledTools = Object.freeze( {
	native: Object.freeze( [ 'Read' ] ),
	studio: Object.freeze( [ runWpCliTool.name ] ),
} );

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

export interface ClaudeStudioToolRule {
	/** The class, or for a tool classified by its arguments the widest class it can reach. */
	readonly operationClass: ClaudeOperationClass;
	/** Narrows the class from a call's arguments; undefined denies the call. */
	readonly classify?: ( args: unknown ) => ClaudeOperationClass | undefined;
	/**
	 * The WordPress.com scope a call reaches directly: a site, which must be the
	 * turn's live target, or the account. Undefined denies the call.
	 */
	readonly remote?: ( args: unknown ) => { wpcomSiteId?: number } | undefined;
	/**
	 * Where a call that needs approval is approved: at the host operation that
	 * carries its effect, with that operation's exact arguments, or for the tool
	 * call itself when its effect does not go through the host.
	 */
	readonly approval: 'host' | 'tool';
}

function isRecord( value: unknown ): value is Record< string, unknown > {
	return !! value && typeof value === 'object' && ! Array.isArray( value );
}

function studioRule(
	operationClass: ClaudeOperationClass,
	approval: ClaudeStudioToolRule[ 'approval' ] = 'tool'
): ClaudeStudioToolRule {
	return { operationClass, approval };
}

// Tool annotations describe these tools to hosts; they are hints. The classes
// here decide, and the tests require each to be at least as strict as the
// tool's annotations.
export const CLAUDE_STUDIO_TOOL_RULES: ReadonlyMap< string, ClaudeStudioToolRule > = new Map( [
	[ createSiteTool.name, studioRule( 'local-change', 'host' ) ],
	[ listSitesTool.name, studioRule( 'remote-read' ) ],
	[ getSiteInfoTool.name, studioRule( 'read' ) ],
	[ startSiteTool.name, studioRule( 'local-change', 'host' ) ],
	[ stopSiteTool.name, studioRule( 'local-change', 'host' ) ],
	[ deleteSiteTool.name, studioRule( 'local-overwrite', 'host' ) ],
	[ createPreviewTool.name, studioRule( 'remote-change', 'host' ) ],
	[ listPreviewsTool.name, studioRule( 'read' ) ],
	[ updatePreviewTool.name, studioRule( 'remote-overwrite', 'host' ) ],
	[ deletePreviewTool.name, studioRule( 'remote-overwrite', 'host' ) ],
	[ runWpCliTool.name, studioRule( 'command', 'host' ) ],
	[ scaffoldThemeTool.name, studioRule( 'local-change' ) ],
	[ pickDesignTool.name, studioRule( 'read' ) ],
	[ validateBlocksTool.name, studioRule( 'local-overwrite' ) ],
	[ takeScreenshotTool.name, studioRule( 'local-change' ) ],
	[ inspectDesignTool.name, studioRule( 'read' ) ],
	[ generateImagesTool.name, studioRule( 'remote-change' ) ],
	[ installTaxonomyScriptsTool.name, studioRule( 'local-change' ) ],
	[ auditPerformanceTool.name, studioRule( 'read' ) ],
	[ auditSeoTool.name, studioRule( 'read' ) ],
	[ listConnectedRemoteSitesTool.name, studioRule( 'remote-read' ) ],
	[
		wpcomRequestTool.name,
		{
			operationClass: 'remote-overwrite',
			approval: 'tool',
			classify: ( args ) => {
				const method = isRecord( args ) ? args.method : undefined;
				if ( method === 'GET' ) return 'remote-read';
				if ( method === 'POST' || method === 'PUT' || method === 'DELETE' )
					return 'remote-overwrite';
			},
			remote: ( args ) => {
				if ( ! isRecord( args ) || typeof args.path !== 'string' ) return;
				if ( args.path.startsWith( '!' ) ) return {};
				if ( Number.isSafeInteger( args.siteId ) ) return { wpcomSiteId: args.siteId as number };
			},
		},
	],
	[ pushSiteTool.name, studioRule( 'remote-overwrite', 'host' ) ],
	[ pullSiteTool.name, studioRule( 'remote-overwrite', 'host' ) ],
	[ importSiteTool.name, studioRule( 'local-overwrite', 'host' ) ],
	[ exportSiteTool.name, studioRule( 'local-overwrite', 'host' ) ],
	[ openAnnotationBrowserTool.name, studioRule( 'local-change' ) ],
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
	/** Rejects input the policy cannot bound. */
	readonly accepts?: ( input: Record< string, unknown > ) => boolean;
}

const SHELL_TIMEOUT_LIMIT_MS = 10 * 60 * 1000;

// A shell command is never judged safe by its text: every call needs approval
// of the exact command. These bounds keep it in the foreground, where the turn's
// cancellation reaches it, and refuse a request to leave the native sandbox.
// They do not confine what the command touches; approval is the guard.
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

const filePath = { field: 'file_path', required: true, allowRoot: false } as const;
const searchPath = { field: 'path', required: false, allowRoot: true } as const;

export const CLAUDE_NATIVE_TOOL_RULES: ReadonlyMap< string, ClaudeNativeToolRule > = new Map<
	string,
	ClaudeNativeToolRule
>( [
	[ 'Read', { operationClass: 'read', path: filePath } ],
	[ 'Grep', { operationClass: 'read', path: searchPath } ],
	[ 'Glob', { operationClass: 'read', path: searchPath } ],
	[ 'LS', { operationClass: 'read', path: { ...searchPath, required: true } } ],
	[ 'Write', { operationClass: 'local-change', path: filePath } ],
	[ 'Edit', { operationClass: 'local-change', path: filePath } ],
	[ 'MultiEdit', { operationClass: 'local-change', path: filePath } ],
	[ 'Bash', { operationClass: 'command', accepts: isBoundedShellInput } ],
] );

/** Whether a tool the native runtime reports is one this build lets a turn run. */
export function isEnabledClaudeTool(
	name: string,
	enabled: ClaudeEnabledTools = CLAUDE_ENABLED_TOOLS
): boolean {
	return (
		enabled.native.includes( name ) ||
		( name.startsWith( STUDIO_MCP_PREFIX ) &&
			enabled.studio.includes( name.slice( STUDIO_MCP_PREFIX.length ) ) )
	);
}

function isInside( root: string, candidate: string ): boolean {
	const relative = path.relative( root, candidate );
	return (
		relative === '' ||
		( relative !== '..' &&
			! relative.startsWith( '..' + path.sep ) &&
			! path.isAbsolute( relative ) )
	);
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

// The WP-CLI commands this build runs: a few reads and one bounded draft creation.
function classifyWpCliArgs( args: readonly unknown[] ): ClaudeOperationClass | undefined {
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

function wpCliOption( args: readonly unknown[], name: string ): string | undefined {
	const prefix = `--${ name }=`;
	const option = args.find(
		( arg ): arg is string => typeof arg === 'string' && arg.startsWith( prefix )
	);
	return option?.slice( prefix.length );
}

// WP-CLI reads configuration that can point a command at another site or host.
async function hasWpCliOverrides( siteDirectory: string ): Promise< boolean > {
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

type HostOperationName =
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

const HOST_OPERATION_CLASSES: Readonly<
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

/** One operation as it will run. An approval covers exactly this, for one call. */
export interface ClaudeOperation {
	/** Canonical Studio tool, native tool or host operation name. */
	readonly tool: string;
	readonly operationClass: ClaudeOperationClass;
	/** The exact arguments that will run. */
	readonly args: unknown;
	/** The local site it acts on. */
	readonly siteId?: string;
	readonly localPaths: readonly string[];
	/** The remote resource it reaches, for display. */
	readonly remote?: string;
	readonly description: string;
	readonly draft?: { readonly siteName: string; readonly title: string; readonly content?: string };
}

/** Immutable: what the user is asked to allow, and everything the answer is scoped to. */
export interface ClaudeApprovalRequest {
	readonly requestId: string;
	readonly runId: string;
	readonly turnId: string;
	readonly toolCallId: string;
	readonly connectionId: string;
	readonly connectionRevision: number;
	readonly policyRevision: number;
	readonly target: Readonly< ClaudeStudioTarget >;
	readonly operation: ClaudeOperation;
}

export type ClaudeApprover = (
	request: ClaudeApprovalRequest,
	signal: AbortSignal
) => Promise< 'allow' | 'deny' >;

/** An allowed approval, usable once for its exact operation. */
export interface ClaudeApprovalGrant {
	readonly requestId: string;
}

export interface ClaudeExecutionContext {
	runId: string;
	turnId: string;
	connectionId: string;
	connectionRevision: number;
	/** The revision the turn was sent with; any other than this build's denies everything. */
	policyRevision: number;
	/** The target the turn was sent with. */
	target: ClaudeStudioTarget;
	/** The native workspace: its site (null when global) and canonical folders. */
	workspace: { siteId: string | null; workingDirectory: string; configDirectory: string };
	/** The target site and its canonical folder; absent for a global target. */
	targetSite?: { id: string; path: string };
	/** Canonical folders native file tools may reach. */
	localRoots: readonly string[];
	enabledTools: ClaudeEnabledTools;
	signal: AbortSignal;
	approve: ClaudeApprover;
	approvalTimeoutMs: number;
	/** Native startup was verified; nothing runs before it. */
	ready: () => boolean;
	/** The connection the turn started on is still attached and unchanged. */
	stillConnected: () => Promise< boolean >;
	/** The conversation still has the turn's native binding and this persisted target. */
	verifyTarget: ( expected: ClaudeStudioTarget ) => Promise< boolean >;
	onEvent: ( event: BackendTurnEvent ) => void;
}

export interface ClaudeToolUse {
	toolName: string;
	input: unknown;
	toolUseId?: string;
	mcpServer?: { name: string; source: string };
}

export interface ClaudeExecutionPolicy {
	/** Aborts when the turn ends or anything it was authorized against changes. */
	readonly signal: AbortSignal;
	/** The SDK PreToolUse hook and the native permission request. */
	authorizeToolUse( use: ClaudeToolUse ): Promise< boolean >;
	/** A Studio MCP tool call, before its handler runs. */
	authorizeStudioCall( name: string, args: unknown, toolCallId: string ): Promise< boolean >;
	/** The host a Studio tool call runs against: every operation with an effect is fenced. */
	guardHost( host: StudioAgentHost, toolCallId: string ): StudioAgentHost;
	requestApproval(
		operation: ClaudeOperation,
		toolCallId: string
	): Promise< ClaudeApprovalGrant | undefined >;
	/** Spends a grant immediately before execution, if it covers exactly this operation. */
	authorizeExecution(
		grant: ClaudeApprovalGrant,
		operation: ClaudeOperation,
		toolCallId: string
	): Promise< boolean >;
	dispose(): void;
}

function deepFreeze< T >( value: T ): T {
	if ( value && typeof value === 'object' && ! Object.isFrozen( value ) ) {
		Object.freeze( value );
		for ( const item of Object.values( value ) ) deepFreeze( item );
	}
	return value;
}

function canonicalJson( value: unknown ): string {
	return JSON.stringify( value, ( _key, item: unknown ) =>
		isRecord( item )
			? Object.fromEntries(
					Object.entries( item ).sort( ( [ a ], [ b ] ) => ( a < b ? -1 : a > b ? 1 : 0 ) )
			  )
			: item
	);
}

interface HostRequest {
	name: HostOperationName;
	site?: HostSite;
	args: unknown[];
	localPaths?: string[];
	remote?: string;
}

interface PreparedHostOperation {
	operation: ClaudeOperation;
	grant?: ClaudeApprovalGrant;
	site?: HostSite;
}

const WP_CLI_ISOLATION = [ '--skip-packages', '--skip-plugins', '--skip-themes' ];

function denied(): Error {
	return new Error( 'Denied' );
}

export function createClaudeExecutionPolicy(
	context: ClaudeExecutionContext
): ClaudeExecutionPolicy {
	const controller = new AbortController();
	const signal = AbortSignal.any( [ context.signal, controller.signal ] );
	const grants = new Map< string, string >();
	const createdSites = new Set< string >();
	const enabledNative = new Set( context.enabledTools.native );
	const enabledStudio = new Set( context.enabledTools.studio );
	// The target the conversation should still have: the one sent, or the site
	// this turn created, which it recorded for the next turn.
	let persisted: ClaudeStudioTarget = context.target;
	signal.addEventListener( 'abort', () => grants.clear(), { once: true } );

	async function checkpoint(): Promise< boolean > {
		if (
			signal.aborted ||
			! context.ready() ||
			context.policyRevision !== CLAUDE_EXECUTION_POLICY_REVISION
		)
			return false;
		const [ connected, targeted ] = await Promise.all( [
			context.stillConnected().catch( () => false ),
			context.verifyTarget( persisted ).catch( () => false ),
		] );
		if ( ! connected || ! targeted ) {
			controller.abort();
			return false;
		}
		return ! signal.aborted;
	}

	function fingerprint( operation: ClaudeOperation, toolCallId: string ): string {
		return createHash( 'sha256' )
			.update(
				canonicalJson( {
					runId: context.runId,
					turnId: context.turnId,
					toolCallId,
					connectionId: context.connectionId,
					connectionRevision: context.connectionRevision,
					policyRevision: context.policyRevision,
					target: context.target,
					operation,
				} )
			)
			.digest( 'hex' );
	}

	function display( operation: ClaudeOperation ): BackendApprovalOperation {
		return {
			tool: escapeClaudeApprovalText( operation.tool ),
			operationClass: operation.operationClass,
			target: { ...context.target },
			args: escapeClaudeApprovalText( JSON.stringify( operation.args, null, 2 ) ?? 'null' ),
			localPaths: operation.localPaths.map( escapeClaudeApprovalText ),
			...( operation.remote ? { remote: escapeClaudeApprovalText( operation.remote ) } : {} ),
		};
	}

	async function awaitAnswer( request: ClaudeApprovalRequest ): Promise< boolean > {
		if ( signal.aborted ) return false;
		const answer = new AbortController();
		const stop = () => answer.abort();
		signal.addEventListener( 'abort', stop, { once: true } );
		const timer = setTimeout( stop, Math.max( 1, context.approvalTimeoutMs ) );
		try {
			const ended = new Promise< 'deny' >( ( resolve ) =>
				answer.signal.addEventListener( 'abort', () => resolve( 'deny' ), { once: true } )
			);
			const result = await Promise.race( [
				Promise.resolve()
					.then( () => context.approve( request, answer.signal ) )
					.catch( () => 'deny' as const ),
				ended,
			] );
			return result === 'allow' && ! answer.signal.aborted;
		} finally {
			clearTimeout( timer );
			signal.removeEventListener( 'abort', stop );
			answer.abort();
		}
	}

	async function requestApproval(
		input: ClaudeOperation,
		toolCallId: string
	): Promise< ClaudeApprovalGrant | undefined > {
		let operation: ClaudeOperation;
		try {
			operation = deepFreeze( structuredClone( input ) );
		} catch {
			return;
		}
		if ( ! ( await checkpoint() ) ) return;
		const request: ClaudeApprovalRequest = deepFreeze( {
			requestId: randomUUID(),
			runId: context.runId,
			turnId: context.turnId,
			toolCallId,
			connectionId: context.connectionId,
			connectionRevision: context.connectionRevision,
			policyRevision: context.policyRevision,
			target: { ...context.target },
			operation,
		} );
		const ids = {
			runId: context.runId,
			turnId: context.turnId,
			toolCallId,
			requestId: request.requestId,
		};
		context.onEvent( {
			type: 'approval.requested',
			...ids,
			description: escapeClaudeApprovalText( operation.description ),
			operation: display( operation ),
			...( operation.draft
				? {
						draft: {
							siteName: escapeClaudeApprovalText( operation.draft.siteName ),
							title: escapeClaudeApprovalText( operation.draft.title ),
							content:
								operation.draft.content === undefined
									? undefined
									: escapeClaudeApprovalText( operation.draft.content ),
						},
				  }
				: {} ),
		} );
		const allowed = await awaitAnswer( request );
		context.onEvent( { type: 'approval.resolved', ...ids } );
		if ( ! allowed || ! ( await checkpoint() ) ) return;
		grants.set( request.requestId, fingerprint( operation, toolCallId ) );
		return { requestId: request.requestId };
	}

	async function authorizeExecution(
		grant: ClaudeApprovalGrant,
		operation: ClaudeOperation,
		toolCallId: string
	): Promise< boolean > {
		const expected = grants.get( grant.requestId );
		grants.delete( grant.requestId );
		if ( expected === undefined ) return false;
		let actual: string;
		try {
			actual = fingerprint( operation, toolCallId );
		} catch {
			return false;
		}
		return expected === actual && ( await checkpoint() );
	}

	async function approveOnce( operation: ClaudeOperation, toolCallId: string ) {
		const grant = await requestApproval( operation, toolCallId );
		return !! grant && ( await authorizeExecution( grant, operation, toolCallId ) );
	}

	async function authorizeToolUse( use: ClaudeToolUse ): Promise< boolean > {
		const { toolName, input, mcpServer } = use;
		if ( toolName.startsWith( 'mcp__' ) ) {
			const name = toolName.slice( STUDIO_MCP_PREFIX.length );
			// The Studio guard for its tools runs where they execute; this only
			// admits Studio's own in-process server.
			return (
				toolName.startsWith( STUDIO_MCP_PREFIX ) &&
				mcpServer?.name === 'studio' &&
				mcpServer.source === 'sdk' &&
				enabledStudio.has( name ) &&
				CLAUDE_STUDIO_TOOL_RULES.has( name ) &&
				( await checkpoint() )
			);
		}
		const rule = CLAUDE_NATIVE_TOOL_RULES.get( toolName );
		if ( ! rule || ! enabledNative.has( toolName ) || ! isRecord( input ) ) return false;
		if ( rule.accepts && ! rule.accepts( input ) ) return false;
		let localPaths = [ context.workspace.workingDirectory ];
		if ( rule.path ) {
			const value = input[ rule.path.field ];
			if ( value !== undefined || rule.path.required ) {
				if (
					typeof value !== 'string' ||
					! ( await isAllowedNativePath(
						value,
						context.localRoots,
						context.workspace.configDirectory,
						rule.path.allowRoot
					) )
				)
					return false;
				localPaths = [ value ];
			}
		}
		if ( ! requiresClaudeApproval( rule.operationClass ) ) return checkpoint();
		return approveOnce(
			{
				tool: toolName,
				operationClass: rule.operationClass,
				args: input,
				siteId: context.targetSite?.id,
				localPaths,
				description: `${ CLASS_DESCRIPTIONS[ rule.operationClass ] }: ${ toolName }`,
			},
			use.toolUseId ?? randomUUID()
		);
	}

	async function authorizeStudioCall(
		name: string,
		args: unknown,
		toolCallId: string
	): Promise< boolean > {
		const rule = CLAUDE_STUDIO_TOOL_RULES.get( name );
		if ( ! rule || ! enabledStudio.has( name ) ) return false;
		const operationClass = rule.classify ? rule.classify( args ) : rule.operationClass;
		if ( ! operationClass ) return false;
		let remote: string | undefined;
		if ( rule.remote ) {
			const scope = rule.remote( args );
			if ( ! scope ) return false;
			if ( scope.wpcomSiteId !== undefined ) {
				const target = context.target;
				if ( target.environment !== 'live' || target.wpcomSiteId !== scope.wpcomSiteId )
					return false;
				remote = `WordPress.com site ${ scope.wpcomSiteId }`;
			}
		}
		if ( ! requiresClaudeApproval( operationClass ) || rule.approval === 'host' )
			return checkpoint();
		return approveOnce(
			{
				tool: name,
				operationClass,
				args,
				siteId: context.targetSite?.id,
				localPaths: [],
				remote,
				description: `${ CLASS_DESCRIPTIONS[ operationClass ] }: ${ name }`,
			},
			toolCallId
		);
	}

	// Re-reads the site from the host and requires it to be the turn's target,
	// still at the canonical folder the turn verified.
	async function resolveTargetSite(
		host: StudioAgentHost,
		site: HostSite
	): Promise< HostSite | undefined > {
		const target = context.target;
		if ( target.environment === 'global' || ! context.targetSite || site.id !== target.siteId )
			return;
		try {
			const current = await host.sites.resolve( site.path );
			if (
				current.id !== target.siteId ||
				( await realpath( current.path ) ) !== context.targetSite.path
			)
				return;
			return current;
		} catch {
			return;
		}
	}

	async function prepare(
		host: StudioAgentHost,
		request: HostRequest,
		toolCallId: string
	): Promise< PreparedHostOperation | undefined > {
		const operationClass =
			request.name === 'sites.wpCli'
				? classifyWpCliArgs( request.args )
				: HOST_OPERATION_CLASSES[ request.name ];
		if ( ! operationClass ) return;
		let site: HostSite | undefined;
		const localPaths = [ ...( request.localPaths ?? [] ) ];
		if ( request.site ) {
			site = await resolveTargetSite( host, request.site );
			if ( ! site || ! context.targetSite ) return;
			localPaths.unshift( context.targetSite.path );
		} else if ( request.name === 'sites.create' ) {
			// Only a global conversation creates sites; a site conversation works
			// in its own site's folder and needs a new conversation for another.
			const sitePath = request.args[ 1 ];
			if (
				context.workspace.siteId !== null ||
				typeof sitePath !== 'string' ||
				! path.isAbsolute( sitePath ) ||
				path.dirname( path.resolve( sitePath ) ) !== path.resolve( host.sitesRoot )
			)
				return;
		} else if ( context.target.environment === 'global' ) {
			return;
		}
		if ( ! ( await checkpoint() ) ) return;
		// The only WP-CLI command this build runs with approval is the bounded draft.
		const draftTitle =
			request.name === 'sites.wpCli' && operationClass === 'command'
				? wpCliOption( request.args, 'post_title' )
				: undefined;
		const operation: ClaudeOperation = {
			tool: request.name,
			operationClass,
			args: request.args,
			siteId: site?.id,
			localPaths,
			remote: request.remote,
			description:
				draftTitle !== undefined && site
					? 'Create a draft post on the current local site'
					: `${ CLASS_DESCRIPTIONS[ operationClass ] }: ${ request.name }`,
			...( draftTitle !== undefined && site
				? {
						draft: {
							siteName: site.name,
							title: draftTitle,
							content: wpCliOption( request.args, 'post_content' ),
						},
				  }
				: {} ),
		};
		if ( ! requiresClaudeApproval( operationClass ) ) return { operation, site };
		const grant = await requestApproval( operation, toolCallId );
		return grant ? { operation, grant, site } : undefined;
	}

	async function fence( prepared: PreparedHostOperation ): Promise< boolean > {
		if ( ! ( await checkpoint() ) ) return false;
		try {
			if ( prepared.site && ( await realpath( prepared.site.path ) ) !== context.targetSite?.path )
				return false;
			if (
				prepared.operation.tool === 'sites.wpCli' &&
				( ! context.targetSite || ( await hasWpCliOverrides( context.targetSite.path ) ) )
			)
				return false;
		} catch {
			return false;
		}
		return ! signal.aborted;
	}

	function guardHost( host: StudioAgentHost, toolCallId: string ): StudioAgentHost {
		const run = async < T >(
			request: HostRequest,
			execute: (
				site: HostSite | undefined,
				options: HostOperationOptions,
				operation: ClaudeOperation
			) => Promise< T >
		): Promise< T > => {
			const prepared = await prepare( host, request, toolCallId );
			if ( ! prepared || ! ( await fence( prepared ) ) ) throw denied();
			if (
				prepared.grant &&
				! ( await authorizeExecution( prepared.grant, prepared.operation, toolCallId ) )
			)
				throw denied();
			signal.throwIfAborted();
			return execute(
				prepared.site,
				{
					signal,
					beforeSpawn: async () => {
						if ( ! ( await fence( prepared ) ) ) throw denied();
					},
				},
				prepared.operation
			);
		};
		const selectSite = host.selectSite;
		return {
			...host,
			sites: {
				...host.sites,
				create: ( name, sitePath, onProgress ) =>
					run(
						{ name: 'sites.create', args: [ name, sitePath ], localPaths: [ sitePath ] },
						async ( _site, options ) => {
							await host.sites.create( name, sitePath, onProgress, options );
							createdSites.add( path.resolve( sitePath ) );
						}
					),
				start: ( site, onProgress ) =>
					run( { name: 'sites.start', site, args: [] }, ( current, options ) =>
						host.sites.start( current!, onProgress, options )
					),
				stop: ( site, onProgress ) =>
					run( { name: 'sites.stop', site, args: [] }, ( current, options ) =>
						host.sites.stop( current!, onProgress, options )
					),
				delete: ( site, deleteFiles, onProgress ) =>
					run( { name: 'sites.delete', site, args: [ deleteFiles ] }, ( current, options ) =>
						host.sites.delete( current!, deleteFiles, onProgress, options )
					),
				import: ( site, file, onProgress ) =>
					run(
						{ name: 'sites.import', site, args: [ file ], localPaths: [ file ] },
						( current, options ) => host.sites.import( current!, file, onProgress, options )
					),
				export: ( site, file, mode, onProgress ) =>
					run(
						{ name: 'sites.export', site, args: [ file, mode ], localPaths: [ file ] },
						( current, options ) => host.sites.export( current!, file, mode, onProgress, options )
					),
				wpCli: ( site, args ) =>
					run( { name: 'sites.wpCli', site, args: [ ...args ] }, ( current, options, operation ) =>
						host.sites.wpCli(
							current!,
							[ ...( operation.args as readonly string[] ), ...WP_CLI_ISOLATION ],
							options
						)
					),
			},
			previews: {
				...host.previews,
				create: ( site, onProgress ) =>
					run( { name: 'previews.create', site, args: [] }, ( current, options ) =>
						host.previews.create( current!, onProgress, options )
					),
				update: ( site, hostname, overwrite, onProgress ) =>
					run(
						{ name: 'previews.update', site, args: [ hostname, overwrite ], remote: hostname },
						( current, options ) =>
							host.previews.update( current!, hostname, overwrite, onProgress, options )
					),
				delete: ( hostname, onProgress ) =>
					run(
						{ name: 'previews.delete', args: [ hostname ], remote: hostname },
						( _site, options ) => host.previews.delete( hostname, onProgress, options )
					),
			},
			sync: {
				push: ( site, options, remoteSite, onProgress ) =>
					run(
						{ name: 'sync.push', site, args: [ options, remoteSite ?? null ], remote: remoteSite },
						( current, fenceOptions ) =>
							host.sync.push( current!, options, remoteSite, onProgress, fenceOptions )
					),
				pull: ( site, options, remoteSite, onProgress ) =>
					run(
						{ name: 'sync.pull', site, args: [ options, remoteSite ?? null ], remote: remoteSite },
						( current, fenceOptions ) =>
							host.sync.pull( current!, options, remoteSite, onProgress, fenceOptions )
					),
			},
			// A site this turn created becomes the conversation's target for the next
			// turn; this turn keeps the target it was sent with.
			selectSite: selectSite
				? async ( site ) => {
						if (
							context.workspace.siteId !== null ||
							typeof site.id !== 'string' ||
							! site.id ||
							! createdSites.has( path.resolve( site.path ) ) ||
							! ( await checkpoint() )
						)
							throw denied();
						await selectSite( site );
						persisted = { environment: 'local', siteId: site.id };
				  }
				: undefined,
		};
	}

	return {
		signal,
		authorizeToolUse,
		authorizeStudioCall,
		guardHost,
		requestApproval,
		authorizeExecution,
		dispose: () => controller.abort(),
	};
}
