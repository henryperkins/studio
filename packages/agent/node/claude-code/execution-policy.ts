import { createHash, randomUUID } from 'crypto';
import { realpath } from 'fs/promises';
import path from 'path';
import {
	escapeClaudeApprovalText,
	isClaudeReadOnlyClass,
} from '@studio/agent/protocol/claude-code';
import { getCreatedSiteFromArtifact } from '../sessions/placement';
import {
	CLAUDE_ACCOUNT_RECHECK_MS,
	CLAUDE_NATIVE_TOOL_RULES,
	CLAUDE_STUDIO_TOOL_RULES,
	HOST_OPERATION_CLASSES,
	claudeNativeTools,
	claudeRouteNote,
	claudeStudioTools,
	claudeTargetOrigin,
	describeClaudeOperation,
	isContainedPattern,
	isLocalHostname,
	isRecord,
	normalizeHostname,
	requiresClaudeApproval,
	studioToolName,
} from './execution-rules';
import {
	isAllowedNativePath,
	isBundledFolder,
	isInsideCanonicalRoot,
	resolveAllowedNewPath,
	resolveAllowedPath,
} from './local-paths';
import { classifyWpCliArgs, hasWpCliOverrides, wpCliOption } from './wp-cli-rules';
import type {
	ClaudeEnabledTools,
	ClaudeNavigationConfinement,
	ClaudeShellConfinement,
	HostOperationName,
} from './execution-rules';
import type { HostOperationOptions, HostSite, StudioAgentHost } from '../host';
import type {
	BackendApprovalOperation,
	BackendTurnEvent,
	ClaudeOperationJournalEvent,
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

/** One operation as it will run. An approval covers exactly this, for one call. */
export interface ClaudeOperation {
	/** Canonical Studio tool, native tool or host operation name. */
	readonly tool: string;
	readonly operationClass: ClaudeOperationClass;
	/** The exact arguments that will run. */
	readonly args: unknown;
	/** The local site its arguments name. */
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
	/** The target site, its canonical folder and its URL; absent for a global target. */
	targetSite?: { id: string; path: string; url?: string };
	/** Canonical folders native file tools may reach. */
	localRoots: readonly string[];
	enabledTools: ClaudeEnabledTools;
	/** How the turn's launch confines shell commands. */
	shellConfinement: ClaudeShellConfinement;
	/** The browser-layer guard the turn's browser tools run under, if any. */
	navigationConfinement: ClaudeNavigationConfinement;
	signal: AbortSignal;
	approve: ClaudeApprover;
	approvalTimeoutMs: number;
	/** Native startup was verified; nothing runs before it. */
	ready: () => boolean;
	/** The connection the turn started on is still attached, at the same revision. */
	stillConnected: () => Promise< boolean >;
	/** Reads the native sign-in now and compares it with the turn's account. */
	verifyAccount: () => Promise< ClaudeAccountCheck >;
	/** When the turn last read the native sign-in, by `now`. */
	accountVerifiedAt: number;
	now: () => number;
	/** The conversation still has the turn's native binding and this persisted target. */
	verifyTarget: ( expected: ClaudeStudioTarget ) => Promise< boolean >;
	onEvent: ( event: BackendTurnEvent ) => void;
	/**
	 * Writes an entry to the turn's journal and resolves once it is on disk.
	 * Every operation that does more than read is recorded this way before it runs.
	 */
	recordOperation: ( event: ClaudeOperationJournalEvent ) => Promise< void >;
	/**
	 * The turn carries the note of a recovery that left at least one operation
	 * of the interrupted turn uncertain. For this turn only, everything that
	 * does more than read asks first, saying so.
	 */
	uncertainAfterRecovery?: boolean;
}

/** What an approval the recovery gate asks for adds to its description. */
const AFTER_RECOVERY =
	'The previous turn was interrupted, so an attempt it made may already have taken effect.';

/**
 * The outcome of reading the native sign-in: the turn's account, another
 * account or none, or a read that failed and so proves nothing.
 */
export type ClaudeAccountCheck = 'same' | 'changed' | 'unverified';

export interface ClaudeToolUse {
	toolName: string;
	input: unknown;
	toolUseId?: string;
	mcpServer?: { name: string; source: string };
}

export interface ClaudeStudioCall {
	/** The unguarded host, used to resolve the site the call names. */
	host: StudioAgentHost;
	name: string;
	args: unknown;
	toolCallId: string;
	/** Aborts when the caller gives up on the call. */
	signal?: AbortSignal;
}

export interface ClaudeExecutionPolicy {
	/** Aborts when the turn ends or anything it was authorized against changes. */
	readonly signal: AbortSignal;
	/** The Studio tools this turn may run: enabled, qualified and, when they drive a browser, guarded. */
	readonly studioTools: readonly string[];
	/**
	 * The SDK PreToolUse hook and the native permission request. `signal` is the
	 * caller's own: when it aborts, the decision is deny.
	 */
	authorizeToolUse( use: ClaudeToolUse, signal?: AbortSignal ): Promise< boolean >;
	/** A Studio MCP tool call, before its handler runs. */
	authorizeStudioCall( call: ClaudeStudioCall ): Promise< boolean >;
	/**
	 * The host a Studio tool call runs against: every operation with an effect is
	 * fenced. Once `signal` or the turn aborts, it refuses every host operation
	 * and the app showing the conversation hears nothing from it. The caller
	 * aborts `signal` when the call settles, however it ended, since the SDK
	 * aborts a call's own signal only when it cancels the call. It changes the
	 * conversation's site only to a site this turn created from a conversation
	 * without a site, and only once that change is journaled.
	 */
	guardHost( host: StudioAgentHost, toolCallId: string, signal?: AbortSignal ): StudioAgentHost;
	requestApproval(
		operation: ClaudeOperation,
		toolCallId: string,
		signal?: AbortSignal
	): Promise< ClaudeApprovalGrant | undefined >;
	/** Spends a grant immediately before execution, if it covers exactly this operation. */
	authorizeExecution(
		grant: ClaudeApprovalGrant,
		operation: ClaudeOperation,
		toolCallId: string,
		signal?: AbortSignal
	): Promise< boolean >;
	/**
	 * Reads the native sign-in again when the last read is older than the bound.
	 * A different or unreadable account ends the turn's authority.
	 */
	refreshAccount(): Promise< boolean >;
	/**
	 * Why the policy refused something a call asked for, in words the model may
	 * hear: fixed sentences, never an argument, a path or a value. Reading them
	 * forgets them.
	 */
	takeRefusals( toolCallId: string ): readonly string[];
	dispose(): void;
}

/** The fixed sentences `takeRefusals` gives. */
const REFUSALS = {
	wpCli: 'This WP-CLI command is outside what Studio runs on the Claude route.',
	notApproved: 'The user did not approve this operation, or did not answer in time.',
	outsideFolders:
		'A file Studio reads or writes for this operation must be an absolute path inside the site’s folder or this conversation’s workspace, and not one that holds credentials.',
	createInSite:
		'A conversation works on one site, and this conversation already has its site. Ask the user to start a new conversation to create another one.',
	siteBinding:
		'Studio did not make that site this conversation’s site: only a site this turn created, in a conversation without a site, can become it.',
	siteFolderMissing:
		'The new site is now this conversation’s site, but Studio could not find its folder, so this turn acts on no site.',
} as const;

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

/** A file a host operation reads, when it must exist, or writes. */
interface HostFile< Path = unknown > {
	path: Path;
	existing: boolean;
}

interface HostRequest {
	name: HostOperationName;
	site?: HostSite;
	args: unknown[];
	localPaths?: string[];
	remote?: string;
	/**
	 * The file the operation reads or writes, as the caller named it. The
	 * operation receives it as checked, the path it resolved to, never as named:
	 * it is the operation's first argument, before `args`, and one of its paths.
	 */
	file?: HostFile;
}

interface PreparedHostOperation {
	operation: ClaudeOperation;
	grant?: ClaudeApprovalGrant;
	site?: HostSite;
	/** The file as checked. */
	file?: HostFile< string >;
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
	// The targets the conversation may have while this turn runs (carry item
	// 7): the one it was sent with until this turn makes a site it created the
	// conversation's site, and that site once the change is written. A change
	// is accepted from before its write starts, so a check that reads the
	// stored target meanwhile never stops the turn for the turn's own change.
	// A write that failed may or may not have landed, so its target is then
	// accepted next to the ones before it. `targetVersion` counts every change
	// of what is accepted.
	let settledTargets: readonly ClaudeStudioTarget[] = [ context.target ];
	const targetWrites = new Map< Promise< void >, ClaudeStudioTarget >();
	let targetVersion = 0;
	const acceptedTargets = () => [ ...settledTargets, ...targetWrites.values() ];
	// The target the turn acts on, and its site's canonical folder: the ones it
	// was sent with, until a site this turn created has become the
	// conversation's site (its selection journaled and written); from then on
	// that site, for the rest of the turn. Site-bound calls resolve against it.
	let actingTarget: ClaudeStudioTarget = context.target;
	let actingSite: { id: string; path: string } | undefined = context.targetSite;
	// Whether this turn has changed the conversation's site, from the moment
	// that change is made, whether or not the turn then found the site's folder.
	let siteChanged = false;
	// Whether the conversation has its site: it was started on one, it acts on
	// one, or this turn changed it. A conversation works on one site.
	const hasSite = () =>
		context.workspace.siteId !== null || actingTarget.environment !== 'global' || siteChanged;
	const refusals = new Map< string, Set< string > >();
	const refuse = ( toolCallId: string, reason: string ) => {
		if ( ! refusals.has( toolCallId ) ) refusals.set( toolCallId, new Set() );
		refusals.get( toolCallId )!.add( reason );
	};
	// Whether an operation of this class asks the user first: by its class, or,
	// in the turn after a recovery that left operations uncertain, whenever it
	// does more than read.
	const gatedAfterRecovery = ( operationClass: ClaudeOperationClass ) =>
		context.uncertainAfterRecovery === true &&
		! requiresClaudeApproval( operationClass ) &&
		! isClaudeReadOnlyClass( operationClass );
	const asksFirst = ( operationClass: ClaudeOperationClass ) =>
		requiresClaudeApproval( operationClass ) || gatedAfterRecovery( operationClass );
	// What an approval and the journal say of an operation: with the recovery
	// gate's notice when that gate is what asks.
	const noticed = ( operationClass: ClaudeOperationClass, description: string ) =>
		gatedAfterRecovery( operationClass ) ? `${ description }. ${ AFTER_RECOVERY }` : description;
	const describe = (
		operationClass: ClaudeOperationClass,
		tool: string,
		shell?: ClaudeShellConfinement
	) => noticed( operationClass, describeClaudeOperation( operationClass, tool, shell ) );
	// A tool use is asked about at most once, whether by the hook or by the
	// permission request, so a hook that times out cannot be answered later.
	const askedToolUses = new Set< string >();
	const nativeTools = new Set(
		claudeNativeTools(
			context.enabledTools,
			context.shellConfinement,
			context.workspace.workingDirectory
		)
	);
	const targetOrigin = claudeTargetOrigin( context.target, context.targetSite );
	const studioTools = new Set(
		claudeStudioTools( context.enabledTools, context.navigationConfinement, targetOrigin )
	);
	signal.addEventListener(
		'abort',
		() => {
			grants.clear();
			refusals.clear();
		},
		{ once: true }
	);

	let accountVerifiedAt = context.accountVerifiedAt;
	let accountRead: Promise< boolean > | undefined;

	async function readAccount(): Promise< boolean > {
		const startedAt = context.now();
		const result = await context.verifyAccount().catch( () => 'unverified' as const );
		if ( result !== 'same' ) {
			controller.abort();
			return false;
		}
		accountVerifiedAt = Math.max( accountVerifiedAt, startedAt );
		return ! signal.aborted;
	}

	// `fresh` reads the sign-in now; otherwise a read younger than the bound is
	// enough, and concurrent operations share one read.
	async function accountIsCurrent( fresh: boolean ): Promise< boolean > {
		if ( signal.aborted ) return false;
		if ( fresh ) return readAccount();
		if ( context.now() - accountVerifiedAt < CLAUDE_ACCOUNT_RECHECK_MS ) return true;
		accountRead ??= readAccount().finally( () => {
			accountRead = undefined;
		} );
		return accountRead;
	}

	// Whether the conversation still has a target this turn may act under. A
	// check that found none while this turn's own change of target was being
	// written, or once what is accepted changed, is made again after that
	// write has settled; anything else means the conversation moved.
	async function targetHolds(): Promise< boolean > {
		for ( let attempt = 0; attempt < 3; attempt++ ) {
			const version = targetVersion;
			const writing = [ ...targetWrites.keys() ];
			const results = await Promise.all(
				acceptedTargets().map( ( target ) => context.verifyTarget( target ).catch( () => false ) )
			);
			if ( results.some( Boolean ) ) return true;
			if ( writing.length ) {
				if ( ! ( await settledWhileTurnLives( Promise.all( writing ) ) ) ) return false;
			} else if ( version === targetVersion ) return false;
		}
		return false;
	}

	// Waits for work that never rejects, unless the turn ends first: a write
	// that never settles holds no check past the turn.
	function settledWhileTurnLives( work: Promise< unknown > ): Promise< boolean > {
		return new Promise( ( resolve ) => {
			if ( signal.aborted ) return resolve( false );
			const ended = () => resolve( false );
			signal.addEventListener( 'abort', ended, { once: true } );
			void work.then( () => {
				signal.removeEventListener( 'abort', ended );
				resolve( true );
			} );
		} );
	}

	// Writes this turn's change of the conversation's target, accepting the new
	// target from before the write starts (see `settledTargets`).
	async function writeTarget(
		target: ClaudeStudioTarget,
		write: () => Promise< void > | void
	): Promise< void > {
		const written = Promise.resolve().then( write );
		const settled = written.then(
			() => {},
			() => {}
		);
		targetWrites.set( settled, target );
		targetVersion++;
		let landed = false;
		try {
			await written;
			landed = true;
		} finally {
			targetWrites.delete( settled );
			settledTargets = landed ? [ target ] : [ ...settledTargets, target ];
			targetVersion++;
		}
	}

	async function checkpoint( callSignal?: AbortSignal, freshAccount = false ): Promise< boolean > {
		if (
			signal.aborted ||
			callSignal?.aborted ||
			! context.ready() ||
			context.policyRevision !== CLAUDE_EXECUTION_POLICY_REVISION
		)
			return false;
		const [ connected, targeted ] = await Promise.all( [
			context.stillConnected().catch( () => false ),
			targetHolds(),
		] );
		if ( ! connected || ! targeted ) {
			controller.abort();
			return false;
		}
		if ( ! ( await accountIsCurrent( freshAccount ) ) ) return false;
		return ! signal.aborted && ! callSignal?.aborted;
	}

	// Everything an approval-class operation needs immediately before it runs,
	// including a read of the native sign-in.
	function accountCheckpoint( callSignal?: AbortSignal ): Promise< boolean > {
		return checkpoint( callSignal, true );
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
					target: actingTarget,
					operation,
				} )
			)
			.digest( 'hex' );
	}

	function display( operation: ClaudeOperation ): BackendApprovalOperation {
		return {
			tool: escapeClaudeApprovalText( operation.tool ),
			operationClass: operation.operationClass,
			target: { ...actingTarget },
			args: escapeClaudeApprovalText( JSON.stringify( operation.args, null, 2 ) ?? 'null' ),
			localPaths: operation.localPaths.map( escapeClaudeApprovalText ),
			...( operation.remote ? { remote: escapeClaudeApprovalText( operation.remote ) } : {} ),
		};
	}

	async function awaitAnswer(
		request: ClaudeApprovalRequest,
		callSignal?: AbortSignal
	): Promise< boolean > {
		if ( signal.aborted || callSignal?.aborted ) return false;
		const answer = new AbortController();
		const stop = () => answer.abort();
		signal.addEventListener( 'abort', stop, { once: true } );
		callSignal?.addEventListener( 'abort', stop, { once: true } );
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
			callSignal?.removeEventListener( 'abort', stop );
			answer.abort();
		}
	}

	async function requestApproval(
		input: ClaudeOperation,
		toolCallId: string,
		callSignal?: AbortSignal
	): Promise< ClaudeApprovalGrant | undefined > {
		let operation: ClaudeOperation;
		try {
			operation = deepFreeze( structuredClone( input ) );
		} catch {
			return;
		}
		if ( ! ( await accountCheckpoint( callSignal ) ) ) return;
		const request: ClaudeApprovalRequest = deepFreeze( {
			requestId: randomUUID(),
			runId: context.runId,
			turnId: context.turnId,
			toolCallId,
			connectionId: context.connectionId,
			connectionRevision: context.connectionRevision,
			policyRevision: context.policyRevision,
			target: { ...actingTarget },
			operation,
		} );
		// The grant covers the target the user is shown.
		let covered: string;
		try {
			covered = fingerprint( operation, toolCallId );
		} catch {
			return;
		}
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
		const allowed = await awaitAnswer( request, callSignal );
		context.onEvent( { type: 'approval.resolved', ...ids } );
		if ( ! allowed ) refuse( toolCallId, REFUSALS.notApproved );
		if ( ! allowed || ! ( await accountCheckpoint( callSignal ) ) ) return;
		grants.set( request.requestId, covered );
		return { requestId: request.requestId };
	}

	async function authorizeExecution(
		grant: ClaudeApprovalGrant,
		operation: ClaudeOperation,
		toolCallId: string,
		callSignal?: AbortSignal
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
		return expected === actual && ( await accountCheckpoint( callSignal ) );
	}

	// The last step before anything that does more than read runs: its record
	// in the turn's journal, on disk, so a recovery can name it if the turn ends
	// before its result is recorded. What cannot be recorded does not run, and
	// the turn stops, since it could no longer account for what it runs.
	async function admit(
		operation: Pick< ClaudeOperation, 'tool' | 'operationClass' | 'description' >,
		toolCallId: string | undefined,
		callSignal?: AbortSignal,
		requestId?: string
	): Promise< boolean > {
		if ( isClaudeReadOnlyClass( operation.operationClass ) ) return true;
		if ( ! toolCallId || signal.aborted || callSignal?.aborted ) return false;
		try {
			await context.recordOperation( {
				type: 'operation.authorized',
				runId: context.runId,
				turnId: context.turnId,
				toolCallId,
				...( requestId ? { requestId } : {} ),
				operation: {
					tool: escapeClaudeApprovalText( operation.tool ),
					operationClass: operation.operationClass,
					target: { ...actingTarget },
				},
				description: escapeClaudeApprovalText( operation.description ),
			} );
		} catch {
			controller.abort();
			return false;
		}
		return ! signal.aborted && ! callSignal?.aborted;
	}

	async function approveOnce(
		operation: ClaudeOperation,
		toolCallId: string,
		callSignal?: AbortSignal
	) {
		const grant = await requestApproval( operation, toolCallId, callSignal );
		return (
			!! grant &&
			( await authorizeExecution( grant, operation, toolCallId, callSignal ) ) &&
			admit( operation, toolCallId, callSignal, grant.requestId )
		);
	}

	async function authorizeToolUse(
		use: ClaudeToolUse,
		callSignal?: AbortSignal
	): Promise< boolean > {
		const { toolName, input, mcpServer } = use;
		if ( callSignal?.aborted ) return false;
		if ( toolName.startsWith( 'mcp__' ) ) {
			const name = studioToolName( toolName );
			// The Studio guard for its tools runs where they execute; this only
			// admits Studio's own in-process server.
			return (
				!! name &&
				mcpServer?.name === 'studio' &&
				mcpServer.source === 'sdk' &&
				studioTools.has( name ) &&
				CLAUDE_STUDIO_TOOL_RULES.has( name ) &&
				( await checkpoint( callSignal ) )
			);
		}
		const rule = CLAUDE_NATIVE_TOOL_RULES.get( toolName );
		if ( ! rule || ! nativeTools.has( toolName ) || ! isRecord( input ) ) return false;
		if ( rule.accepts && ! rule.accepts( input ) ) return false;
		if (
			rule.patterns?.some(
				( field ) => input[ field ] !== undefined && ! isContainedPattern( input[ field ] )
			)
		)
			return false;
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
		const operation = {
			tool: toolName,
			operationClass: rule.operationClass,
			description: describe(
				rule.operationClass,
				toolName,
				rule.shell ? context.shellConfinement : undefined
			),
		};
		if ( ! asksFirst( rule.operationClass ) )
			return ( await checkpoint( callSignal ) ) && admit( operation, use.toolUseId, callSignal );
		const toolUseId = use.toolUseId;
		if ( ! toolUseId || askedToolUses.has( toolUseId ) ) return false;
		askedToolUses.add( toolUseId );
		return approveOnce( { ...operation, args: input, localPaths }, toolUseId, callSignal );
	}

	// Resolves a site reference and requires it to be the turn's target site,
	// still at the canonical folder the turn verified.
	async function resolveTarget(
		host: StudioAgentHost,
		reference: string
	): Promise< HostSite | undefined > {
		const target = actingTarget;
		const targetSite = actingSite;
		if ( target.environment === 'global' || ! targetSite ) return;
		try {
			const current = await host.sites.resolve( reference );
			if (
				current.id !== target.siteId ||
				current.id !== targetSite.id ||
				( await realpath( current.path ) ) !== targetSite.path
			)
				return;
			return current;
		} catch {
			return;
		}
	}

	// The origin a URL may be opened at, if any. Only http and https. A local
	// address, or the address of any local site, must be the target site's own
	// origin; a public page is an external read. A URL a site audit composes
	// must be that site's own origin. Host names are compared normalized; a name
	// that resolves to a local address is the navigation guard's to refuse.
	async function reachableOrigin(
		host: StudioAgentHost,
		url: string,
		onSite: boolean
	): Promise< string | undefined > {
		let parsed: URL;
		try {
			parsed = new URL( url );
		} catch {
			return;
		}
		if (
			( parsed.protocol !== 'http:' && parsed.protocol !== 'https:' ) ||
			parsed.username ||
			parsed.password
		)
			return;
		if ( parsed.origin === targetOrigin ) return parsed.origin;
		if ( onSite ) return;
		const hostname = normalizeHostname( parsed.hostname );
		if ( isLocalHostname( hostname ) ) return;
		try {
			const siteHosts = ( await host.sites.all() ).map( ( item ) =>
				normalizeHostname( new URL( item.url ).hostname )
			);
			if ( siteHosts.includes( hostname ) ) return;
		} catch {
			return;
		}
		return parsed.origin;
	}

	async function authorizeStudioCall( call: ClaudeStudioCall ): Promise< boolean > {
		const { host, name, args, toolCallId, signal: callSignal } = call;
		if ( callSignal?.aborted ) return false;
		const rule = CLAUDE_STUDIO_TOOL_RULES.get( name );
		if ( ! rule || ! studioTools.has( name ) ) return false;
		if ( rule.withoutSite && hasSite() ) {
			refuse( toolCallId, REFUSALS.createInSite );
			return false;
		}
		const operationClass = rule.classify ? rule.classify( args ) : rule.operationClass;
		if ( ! operationClass ) return false;
		let site: HostSite | undefined;
		if ( rule.site ) {
			const reference = rule.site( args );
			site = reference ? await resolveTarget( host, reference ) : undefined;
			if ( ! site ) return false;
		}
		let localPaths: string[] = [];
		if ( rule.paths ) {
			const paths = rule.paths( args, site?.path );
			if ( ! paths ) return false;
			if ( paths.length ) {
				const folder = actingSite?.path;
				if ( ! folder ) return false;
				for ( const file of paths )
					if ( ! ( await isInsideCanonicalRoot( folder, file ) ) ) return false;
			}
			localPaths = paths;
		}
		// What it reads of Studio's own files must still be Studio's own.
		if ( rule.bundled && ! ( await isBundledFolder( rule.bundled(), context.localRoots ) ) )
			return false;
		let remote: string | undefined;
		if ( rule.urls ) {
			const urls = rule.urls( args, site?.url );
			if ( ! urls ) return false;
			for ( const url of urls ) {
				const origin = await reachableOrigin( host, url, rule.urlsOnSite === true );
				if ( ! origin ) return false;
				remote ??= origin;
			}
		}
		if ( rule.remote ) {
			const scope = rule.remote( args );
			if ( ! scope ) return false;
			if ( scope.wpcomSiteId !== undefined ) {
				const target = actingTarget;
				if ( target.environment !== 'live' || target.wpcomSiteId !== scope.wpcomSiteId )
					return false;
				remote = `WordPress.com site ${ scope.wpcomSiteId }`;
			}
		}
		const description = describe( operationClass, name );
		// A tool approved at its host operations is journaled here too: the
		// host operations it reaches are journaled again as they run.
		if ( ! asksFirst( operationClass ) || rule.approval === 'host' )
			return (
				( await checkpoint( callSignal ) ) &&
				admit( { tool: name, operationClass, description }, toolCallId, callSignal )
			);
		// An approval shows the files the rule names; one that names none for
		// this call would ask about files without showing them.
		if ( rule.paths && ! localPaths.length ) return false;
		return approveOnce(
			{
				tool: name,
				operationClass,
				args,
				siteId: site?.id,
				localPaths,
				remote,
				description,
			},
			toolCallId,
			callSignal
		);
	}

	async function prepare(
		host: StudioAgentHost,
		request: HostRequest,
		toolCallId: string,
		callSignal?: AbortSignal
	): Promise< PreparedHostOperation | undefined > {
		const operationClass =
			request.name === 'sites.wpCli'
				? classifyWpCliArgs( request.args )
				: HOST_OPERATION_CLASSES[ request.name ];
		if ( ! operationClass ) {
			if ( request.name === 'sites.wpCli' )
				refuse( toolCallId, `${ REFUSALS.wpCli } ${ claudeRouteNote( 'wp_cli' ) }` );
			return;
		}
		let site: HostSite | undefined;
		const localPaths = [ ...( request.localPaths ?? [] ) ];
		if ( request.site ) {
			site = await resolveTarget( host, request.site.path );
			const targetSite = actingSite;
			if ( ! site || site.id !== request.site.id || ! targetSite ) return;
			localPaths.unshift( targetSite.path );
		} else if ( request.name === 'sites.create' ) {
			// Only a conversation without a site creates one; a conversation works
			// on one site and needs a new conversation for another.
			const sitePath = request.args[ 1 ];
			if ( hasSite() ) {
				refuse( toolCallId, REFUSALS.createInSite );
				return;
			}
			if (
				typeof sitePath !== 'string' ||
				! path.isAbsolute( sitePath ) ||
				path.dirname( path.resolve( sitePath ) ) !== path.resolve( host.sitesRoot )
			)
				return;
		} else if ( context.target.environment === 'global' ) {
			// An operation bound to no site follows the target the turn was sent
			// with: a site this turn created binds site-bound calls only.
			return;
		}
		let args = request.args;
		let file: HostFile< string > | undefined;
		if ( request.file ) {
			const checked = await conversationFile( request.file );
			if ( ! checked ) {
				refuse( toolCallId, REFUSALS.outsideFolders );
				return;
			}
			file = { path: checked, existing: request.file.existing };
			args = [ checked, ...args ];
			localPaths.push( checked );
		}
		if ( ! ( await checkpoint( callSignal ) ) ) return;
		// The only WP-CLI command this build runs with approval is the bounded draft.
		const draftTitle =
			request.name === 'sites.wpCli' && operationClass === 'command'
				? wpCliOption( request.args, 'post_title' )
				: undefined;
		const operation: ClaudeOperation = {
			tool: request.name,
			operationClass,
			args,
			siteId: site?.id,
			localPaths,
			remote: request.remote,
			description:
				draftTitle !== undefined && site
					? 'Create a draft post on the current local site'
					: describe( operationClass, request.name ),
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
		if ( ! asksFirst( operationClass ) ) return { operation, site, file };
		const grant = await requestApproval( operation, toolCallId, callSignal );
		return grant ? { operation, grant, site, file } : undefined;
	}

	// The path a file a host operation reads (`existing`) or writes resolves to,
	// once links and short names are resolved, when it lies in the
	// conversation's own folders, outside the native configuration and clear of
	// credential files; undefined otherwise.
	async function conversationFile( {
		path: file,
		existing,
	}: HostFile ): Promise< string | undefined > {
		if ( typeof file !== 'string' ) return;
		const { localRoots, workspace } = context;
		return existing
			? resolveAllowedPath( file, localRoots, workspace.configDirectory )
			: resolveAllowedNewPath( file, localRoots, workspace.configDirectory );
	}

	async function fence(
		prepared: PreparedHostOperation,
		callSignal?: AbortSignal
	): Promise< boolean > {
		if ( ! ( await checkpoint( callSignal ) ) ) return false;
		const targetSite = actingSite;
		try {
			if ( prepared.site && ( await realpath( prepared.site.path ) ) !== targetSite?.path )
				return false;
			// The file is checked again, since a link can have moved under it: the
			// path the operation receives must still resolve to itself.
			if ( prepared.file && ( await conversationFile( prepared.file ) ) !== prepared.file.path )
				return false;
			if (
				prepared.operation.tool === 'sites.wpCli' &&
				( ! targetSite || ( await hasWpCliOverrides( targetSite.path ) ) )
			)
				return false;
		} catch {
			return false;
		}
		return ! signal.aborted && ! callSignal?.aborted;
	}

	// Whether a site the host resolved may be handed to a tool: the site the
	// turn acts on, or a site this turn created, which the creating tool
	// resolves to report it.
	async function isReachableSite( site: HostSite ): Promise< boolean > {
		if ( createdSites.has( path.resolve( site.path ) ) ) return true;
		const target = actingTarget;
		const targetSite = actingSite;
		if ( target.environment === 'global' || ! targetSite || site.id !== target.siteId )
			return false;
		try {
			return ( await realpath( site.path ) ) === targetSite.path;
		} catch {
			return false;
		}
	}

	// Whether a site may become the conversation's site: one this turn created,
	// from a conversation without a site, that the host still knows by that id
	// at that folder. Once one has become it, only that one: a conversation
	// works on one site.
	async function isCreatedSite(
		host: StudioAgentHost,
		site: { id?: unknown; path?: unknown }
	): Promise< boolean > {
		if (
			context.workspace.siteId !== null ||
			typeof site.id !== 'string' ||
			! site.id ||
			typeof site.path !== 'string' ||
			! createdSites.has( path.resolve( site.path ) ) ||
			( actingTarget.environment !== 'global' && actingSite?.id !== site.id )
		)
			return false;
		try {
			return ( await host.sites.findByFolder( site.path ) )?.id === site.id;
		} catch {
			return false;
		}
	}

	function guardHost(
		host: StudioAgentHost,
		toolCallId: string,
		callSignal?: AbortSignal
	): StudioAgentHost {
		const operationSignal = callSignal ? AbortSignal.any( [ signal, callSignal ] ) : signal;
		const run = async < T >(
			request: HostRequest,
			execute: (
				site: HostSite | undefined,
				options: HostOperationOptions,
				operation: ClaudeOperation,
				file: string | undefined
			) => Promise< T >
		): Promise< T > => {
			const prepared = await prepare( host, request, toolCallId, callSignal );
			if ( ! prepared || ! ( await fence( prepared, callSignal ) ) ) throw denied();
			if (
				( prepared.grant &&
					! ( await authorizeExecution(
						prepared.grant,
						prepared.operation,
						toolCallId,
						callSignal
					) ) ) ||
				! ( await admit( prepared.operation, toolCallId, callSignal, prepared.grant?.requestId ) )
			)
				throw denied();
			operationSignal.throwIfAborted();
			return execute(
				prepared.site,
				{
					signal: operationSignal,
					beforeSpawn: async () => {
						if ( ! ( await fence( prepared, callSignal ) ) ) throw denied();
					},
				},
				prepared.operation,
				prepared.file?.path
			);
		};
		// A read a tool makes of a site: of a site it may reach, under the turn's
		// authority, while the call lives.
		const reading = async < T >( site: HostSite, read: () => Promise< T > ): Promise< T > => {
			if (
				operationSignal.aborted ||
				! ( await isReachableSite( site ) ) ||
				! ( await checkpoint( callSignal ) )
			)
				throw denied();
			operationSignal.throwIfAborted();
			return read();
		};
		// What no qualified tool needs is refused: every site's details, and the
		// members that reach WordPress.com or send analytics.
		const refused = async (): Promise< never > => {
			throw denied();
		};
		// A change of the conversation's site, to a site this turn created: asked
		// about when the turn asks before every change, journaled, then made.
		const changeSite = async (
			name: 'selectSite' | 'ui.showArtifact',
			site: { id?: string; path: string },
			description: string,
			make: ( siteId: string ) => Promise< void >
		): Promise< void > => {
			if ( operationSignal.aborted ) throw denied();
			const siteId = site.id;
			if ( typeof siteId !== 'string' || ! ( await isCreatedSite( host, site ) ) ) {
				refuse( toolCallId, REFUSALS.siteBinding );
				throw denied();
			}
			if ( ! ( await checkpoint( callSignal ) ) ) throw denied();
			const operationClass = HOST_OPERATION_CLASSES[ name ];
			const operation: ClaudeOperation = {
				tool: name,
				operationClass,
				args: [ siteId ],
				siteId,
				localPaths: [ site.path ],
				description: noticed( operationClass, description ),
			};
			let grant: ClaudeApprovalGrant | undefined;
			if ( asksFirst( operationClass ) ) {
				grant = await requestApproval( operation, toolCallId, callSignal );
				// The site is checked again once the user has answered.
				if (
					! grant ||
					! ( await authorizeExecution( grant, operation, toolCallId, callSignal ) ) ||
					! ( await isCreatedSite( host, site ) )
				)
					throw denied();
			}
			if ( ! ( await admit( operation, toolCallId, callSignal, grant?.requestId ) ) )
				throw denied();
			operationSignal.throwIfAborted();
			siteChanged = true;
			await make( siteId );
		};
		const { ui } = host;
		return {
			...host,
			wpcom: { sites: refused },
			tracks: { record: refused },
			// What a call shows in the conversation is written to the chat's record,
			// so it stops with the call's authority. An artifact the run manager
			// binds the chat to a site with changes the conversation's site, as
			// `selectSite` does, so it shows only a site this turn created, once
			// that change is journaled.
			ui: ui && {
				showArtifact: async ( artifact ) => {
					if ( operationSignal.aborted ) throw denied();
					const binding = getCreatedSiteFromArtifact( artifact );
					if ( ! binding ) return ui.showArtifact( artifact );
					await changeSite(
						'ui.showArtifact',
						{ id: binding.siteId, path: binding.sitePath },
						'Show a site this turn created in the conversation, which then stays with that site',
						async () => {
							await ui.showArtifact( artifact );
						}
					);
				},
				reloadPreview: () => {
					if ( ! operationSignal.aborted ) ui.reloadPreview();
				},
			},
			sites: {
				...host.sites,
				resolve: async ( reference ) => {
					const site = await host.sites.resolve( reference );
					if ( ! ( await isReachableSite( site ) ) ) throw denied();
					return site;
				},
				findByFolder: async ( folder ) => {
					const site = await host.sites.findByFolder( folder );
					if ( site && ! ( await isReachableSite( site ) ) ) throw denied();
					return site;
				},
				all: refused,
				list: refused,
				status: ( site ) => reading( site, () => host.sites.status( site ) ),
				isRunning: ( site ) => reading( site, () => host.sites.isRunning( site ) ),
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
						{ name: 'sites.import', site, args: [], file: { path: file, existing: true } },
						( current, options, _operation, checked ) =>
							host.sites.import( current!, checked!, onProgress, options )
					),
				export: ( site, file, mode, onProgress ) =>
					run(
						{ name: 'sites.export', site, args: [ mode ], file: { path: file, existing: false } },
						( current, options, _operation, checked ) =>
							host.sites.export( current!, checked!, mode, onProgress, options )
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
			// Makes a site this turn created the conversation's site. The turn's
			// checks accept the new target from before the change is written, and
			// only it once written (carry item 7); from then on the turn acts on
			// that site, at its canonical folder.
			selectSite: host.selectSite
				? async ( site ) => {
						const selectSite = host.selectSite!;
						await changeSite(
							'selectSite',
							site,
							'Make a site this turn created the conversation’s site',
							async ( siteId ) => {
								const target: ClaudeStudioTarget = { environment: 'local', siteId };
								await writeTarget( target, () => selectSite( site ) );
								// A folder that cannot be resolved binds nothing: calls on
								// the site are then refused, and the turn acts on no site.
								const folder = await realpath( site.path ).catch( () => undefined );
								if ( ! folder ) {
									refuse( toolCallId, REFUSALS.siteFolderMissing );
									return;
								}
								actingTarget = target;
								actingSite = { id: siteId, path: folder };
							}
						);
				  }
				: undefined,
		};
	}

	return {
		signal,
		studioTools: Object.freeze( [ ...studioTools ] ),
		authorizeToolUse,
		authorizeStudioCall,
		guardHost,
		requestApproval,
		authorizeExecution,
		refreshAccount: () => accountIsCurrent( false ),
		takeRefusals: ( toolCallId ) => {
			const reasons = [ ...( refusals.get( toolCallId ) ?? [] ) ];
			refusals.delete( toolCallId );
			return reasons;
		},
		dispose: () => controller.abort(),
	};
}
