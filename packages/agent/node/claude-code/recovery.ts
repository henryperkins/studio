import { realpath, stat } from 'fs/promises';
import path from 'path';
import {
	checkOwnedTreeEnded,
	checkProcessIdentity,
	readOwnProcessIdentity,
} from '@studio/common/lib/owned-process';
import { __ } from '@wordpress/i18n';
import {
	escapeClaudeApprovalText,
	isClaudeReadOnlyClass,
} from '@studio/agent/protocol/claude-code';
import { claudeLockDigest } from './run-lock';
import type { ClaudeRecoveryClaim, ClaudeRunLockRecord } from './run-lock';
import type { createNativeSessionStore } from './sessions';
import type {
	BackendTurnEvent,
	ClaudeJournalEvent,
	ClaudeRecoveryJournalEvent,
} from '@studio/agent/protocol/backend-events';
import type { ClaudeBackendSessionBinding } from '@studio/agent/protocol/backend-sessions';
import type {
	ClaudeRecoveryBlockedReason,
	ClaudeRecoveryResult,
	ClaudeUncertainOperation,
} from '@studio/agent/protocol/claude-code';
import type {
	OwnedTreeCheck,
	ProcessIdentity,
	ProcessIdentityCheck,
} from '@studio/common/lib/owned-process';

/** What recovery reads of the OS. */
export interface ClaudeRecoverySeams {
	platform: NodeJS.Platform;
	/** The recovering process, which its claim on the lock names. */
	self(): Promise< ProcessIdentity | undefined >;
	checkIdentity( identity: ProcessIdentity ): Promise< ProcessIdentityCheck >;
	checkTree(
		processes: NonNullable< ClaudeRunLockRecord[ 'processes' ] >
	): Promise< OwnedTreeCheck >;
}

const systemSeams: ClaudeRecoverySeams = {
	platform: process.platform,
	self: readOwnProcessIdentity,
	checkIdentity: ( identity ) => checkProcessIdentity( identity ),
	checkTree: ( processes ) => checkOwnedTreeEnded( processes ),
};

type NativeSessionStore = ReturnType< typeof createNativeSessionStore >;

const TREE_REASONS: Record<
	Exclude< OwnedTreeCheck, { state: 'ended' } >[ 'process' ],
	Record< 'alive' | 'unknown', ClaudeRecoveryBlockedReason >
> = {
	native: { alive: 'native-alive', unknown: 'native-unverifiable' },
	guardian: { alive: 'guardian-alive', unknown: 'guardian-unverifiable' },
	descendant: { alive: 'descendants-alive', unknown: 'descendants-unverifiable' },
};

async function isDirectoryAt( directory: string ): Promise< boolean > {
	try {
		return (
			( await realpath( directory ) ) === directory && ( await stat( directory ) ).isDirectory()
		);
	} catch {
		return false;
	}
}

// The native session the next turn would resume: the conversation's own, at
// the workspace and configuration the lock names, with its history in place.
async function verifyNativeSession(
	store: NativeSessionStore,
	record: ClaudeRunLockRecord,
	binding: ClaudeBackendSessionBinding
): Promise< ClaudeRecoveryBlockedReason | undefined > {
	if (
		! ( await isDirectoryAt( binding.workingDirectory ) ) ||
		! ( await isDirectoryAt( binding.configDirectory ) )
	)
		return 'workspace-missing';
	let ref;
	try {
		ref = await store.load( binding.conversationId );
	} catch {
		return 'native-session-mismatch';
	}
	// Without a native session the turn sent no prompt, so there is no history to keep.
	if ( ! ref ) return record.session?.resume ? 'native-session-missing' : undefined;
	if (
		ref.connectionId !== binding.connectionId ||
		ref.siteId !== binding.siteId ||
		ref.workingDirectory !== binding.workingDirectory ||
		ref.configDirectory !== binding.configDirectory ||
		( record.session && record.session.nativeSessionId !== ref.nativeSessionId )
	)
		return 'native-session-mismatch';
	const resolved = await store
		.resolve( ref, binding, path.join( binding.configDirectory, 'projects' ) )
		.catch( () => undefined );
	return resolved?.status === 'ready' ? undefined : 'native-history-missing';
}

function recoveredMessage( uncertain: boolean ): string {
	return uncertain
		? __(
				'Claude Code stopped before this turn finished, and Studio recovered the chat. An operation in it may or may not have completed: check its result before asking Claude to do it again. Nothing was retried.'
		  )
		: __(
				'Claude Code stopped before this turn finished, and Studio recovered the chat. Nothing was retried.'
		  );
}

// What may or may not have run in the dead turn, each with no recorded result:
// - every operation that does more than read and that Studio authorized, which
//   it journals before the operation runs;
// - every one it asked approval for, since an approval's answer is never
//   journaled (and a journal written before authorizations were journaled
//   shows only the request);
// - every tool it does not recognise that started: such a tool is never taken
//   to only read. A recognised tool that started with nothing authorized has
//   run nothing that does more than read.
// A Studio tool call journaled at the tool and at the host operations it
// reached is reported by those host operations, which say what would have
// changed. Only entries that name their tool call are matched with others:
// one that names none is never merged, settled or taken as accounted for.
async function uncertainOperationsOf(
	events: ClaudeJournalEvent[],
	resolved: ReadonlySet< string >
): Promise< ClaudeUncertainOperation[] > {
	const idOf = ( event: { toolCallId?: unknown } ) =>
		typeof event.toolCallId === 'string' && event.toolCallId ? event.toolCallId : undefined;
	const completed = new Set(
		events.flatMap( ( event ) => {
			const id = event.type === 'tool.result' ? idOf( event ) : undefined;
			return id ? [ id ] : [];
		} )
	);
	const found = new Map< string, ClaudeUncertainOperation >();
	const accounted = new Set< string >();
	for ( const [ index, event ] of events.entries() ) {
		if ( event.type !== 'operation.authorized' && event.type !== 'approval.requested' ) continue;
		const id = idOf( event );
		if ( id ) accounted.add( id );
		const operation: Partial< typeof event.operation > = event.operation ?? {};
		if ( ( id && completed.has( id ) ) || isClaudeReadOnlyClass( operation.operationClass ) )
			continue;
		const tool = typeof operation.tool === 'string' ? operation.tool : '';
		const key = id ? JSON.stringify( [ id, event.requestId ?? null, tool ] ) : `unnamed ${ index }`;
		const evidence = event.type === 'operation.authorized' ? 'authorized' : 'requested';
		const known = found.get( key );
		if ( known ) {
			if ( evidence === 'authorized' ) known.evidence = evidence;
			continue;
		}
		found.set( key, {
			toolCallId: event.toolCallId,
			tool,
			...( typeof operation.operationClass === 'string'
				? { operationClass: operation.operationClass }
				: {} ),
			...( operation.target ? { target: operation.target } : {} ),
			description: typeof event.description === 'string' ? event.description : tool,
			evidence,
			...( event.requestId
				? { requestId: event.requestId, resolved: resolved.has( event.requestId ) }
				: {} ),
		} );
	}
	const started = events.flatMap( ( event, index ) => {
		if ( event.type !== 'tool.started' ) return [];
		const id = idOf( event );
		return id && ( completed.has( id ) || accounted.has( id ) ) ? [] : [ { event, index } ];
	} );
	const named = [ ...found.values() ].flatMap( ( operation ) => idOf( operation ) ?? [] );
	const shared = new Set( named ).size !== named.length;
	// The rules are loaded only when needed: they bring every tool's module with them.
	const rules = started.length || shared ? await import( './execution-rules' ) : undefined;
	for ( const { event, index } of started ) {
		if ( rules?.isKnownClaudeTool( event.name ) ) continue;
		const tool = escapeClaudeApprovalText( String( event.name ) );
		const id = idOf( event );
		// Its kind is the evidence: each app words it in its own language.
		found.set( id ? JSON.stringify( [ id, null, tool ] ) : `unnamed ${ index }`, {
			toolCallId: event.toolCallId,
			tool,
			evidence: 'started',
		} );
	}
	const operations = [ ...found.values() ];
	if ( ! rules ) return operations;
	const reachedHost = new Set(
		operations.flatMap( ( operation ) =>
			rules.isClaudeHostOperation( operation.tool ) ? idOf( operation ) ?? [] : []
		)
	);
	return operations.filter( ( operation ) => {
		const id = idOf( operation );
		return ! (
			id &&
			reachedHost.has( id ) &&
			rules.CLAUDE_STUDIO_TOOL_RULES.has( operation.tool )
		);
	} );
}

// What recovery records for the dead turn: each approval it left pending,
// resolved so no reply can be applied; its outcome unless it recorded one; and
// what may have run.
async function planRecovery(
	events: ClaudeJournalEvent[],
	record: ClaudeRunLockRecord,
	lock: string
): Promise< {
	events: ClaudeJournalEvent[];
	recovered: ClaudeRecoveryJournalEvent;
	terminal: boolean;
} > {
	const ids = { runId: record.runId, turnId: record.turnId };
	const requested = new Map<
		string,
		Extract< BackendTurnEvent, { type: 'approval.requested' } >
	>();
	const resolved = new Set< string >();
	for ( const event of events ) {
		if ( event.type === 'approval.requested' && ! requested.has( event.requestId ) )
			requested.set( event.requestId, event );
		if ( event.type === 'approval.resolved' ) resolved.add( event.requestId );
	}
	const pending = [ ...requested.values() ].filter(
		( event ) => ! resolved.has( event.requestId )
	);
	const uncertainOperations = await uncertainOperationsOf( events, resolved );
	const terminal = ! events.some( ( event ) => event.type === 'turn.terminal' );
	const recovered: ClaudeRecoveryJournalEvent = {
		type: 'turn.recovered',
		...ids,
		lock,
		invalidatedApprovals: pending.map( ( event ) => event.requestId ),
		uncertainOperations,
	};
	return {
		events: [
			...pending.map( ( event ) => ( {
				type: 'approval.resolved' as const,
				...ids,
				toolCallId: event.toolCallId,
				requestId: event.requestId,
			} ) ),
			...( terminal
				? [
						{
							type: 'turn.terminal' as const,
							...ids,
							outcome: {
								status: 'unknown_process_exit' as const,
								code: 'recovered' as const,
								message: recoveredMessage( uncertainOperations.length > 0 ),
							},
						},
				  ]
				: [] ),
			recovered,
		],
		recovered,
		terminal,
	};
}

/**
 * Recovers a conversation whose run lock outlived the run that took it, in
 * the same native conversation, replaying nothing. It proceeds only when all
 * of these hold, and otherwise blocks as `ClaudeRecoveryBlockedReason`
 * describes:
 * - the lock is a run lock this build wrote, for this conversation, on this OS,
 *   with the conversation's own connection and workspace binding;
 * - its owner is provably gone, and either the SDK was never asked to start
 *   the turn's native process (`locked`) or the tree Studio owned is provably
 *   ended (`owned`);
 * - the workspace and configuration still exist, and the native session is the
 *   conversation's own with its history in place;
 * - this recovery holds the only claim on that exact lock, which is still on
 *   disk byte for byte when it is taken over and again when it is released.
 * It then records, once, the dead turn's interrupted outcome (unless the turn
 * recorded one), resolves its pending approvals so none can be answered, and
 * names any operation that may or may not have run; then it releases the lock.
 */
export async function recoverClaudeRun(
	store: NativeSessionStore,
	binding: ClaudeBackendSessionBinding,
	seams: ClaudeRecoverySeams = systemSeams
): Promise< ClaudeRecoveryResult > {
	const { conversationId } = binding;
	if ( await store.isPendingDeletion( conversationId ) )
		return { status: 'blocked', reason: 'deletion-pending' };
	const inspected = await store.inspectLock( conversationId );
	if ( inspected.state !== 'run' ) {
		const reasons = {
			none: 'not-locked',
			legacy: 'legacy-lock',
			held: 'lock-not-a-run',
			unreadable: 'lock-unreadable',
		} as const;
		return { status: 'blocked', reason: reasons[ inspected.state ] };
	}
	const { record, raw } = inspected;
	const ids = { runId: record.runId, turnId: record.turnId };
	const blocked = ( reason: ClaudeRecoveryBlockedReason ): ClaudeRecoveryResult => ( {
		status: 'blocked',
		reason,
		...ids,
	} );
	if ( record.conversationId !== conversationId ) return blocked( 'lock-other-conversation' );
	if ( record.platform !== seams.platform ) return blocked( 'platform-mismatch' );
	if (
		record.connection.id !== binding.connectionId ||
		record.workspace.siteId !== binding.siteId ||
		record.workspace.workingDirectory !== binding.workingDirectory ||
		record.workspace.configDirectory !== binding.configDirectory
	)
		return blocked( 'binding-mismatch' );

	const owner = await seams.checkIdentity( record.owner );
	if ( owner === 'alive' ) return blocked( 'owner-alive' );
	if ( owner === 'unknown' ) return blocked( 'owner-unverifiable' );
	if ( record.stage === 'starting' ) return blocked( 'native-unowned' );
	if ( record.stage === 'owned' ) {
		const tree = await seams.checkTree( record.processes! );
		if ( tree.state !== 'ended' ) return blocked( TREE_REASONS[ tree.process ][ tree.state ] );
	}

	const native = await verifyNativeSession( store, record, binding );
	if ( native ) return blocked( native );

	const claimant = await seams.self().catch( () => undefined );
	if ( ! claimant ) return blocked( 'recovery-failed' );
	let claim: ClaudeRecoveryClaim;
	try {
		claim = await store.claimRecovery(
			conversationId,
			record.token,
			claimant,
			seams.checkIdentity
		);
	} catch {
		return blocked( 'recovery-failed' );
	}
	if ( claim.state === 'held' ) return blocked( 'recovery-in-progress' );
	if ( claim.state === 'unreadable' ) return blocked( 'recovery-claim-unreadable' );
	try {
		let held: boolean;
		try {
			held = await store.holdsLock( conversationId, raw );
		} catch {
			return blocked( 'lock-unreadable' );
		}
		if ( ! held ) return blocked( 'lock-changed' );
		let journals: ClaudeJournalEvent[][];
		try {
			journals = await store.readJournals( conversationId );
		} catch {
			return blocked( 'journal-unreadable' );
		}
		const lock = claudeLockDigest( record.token );
		const turn = ( event: ClaudeJournalEvent ) =>
			event.runId === record.runId && event.turnId === record.turnId;
		const recordedBefore = journals.find( ( events ) =>
			events.some(
				( event ) => event.type === 'turn.recovered' && event.lock === lock && turn( event )
			)
		);
		let recovered: ClaudeRecoveryJournalEvent;
		let recordedTerminal: boolean;
		if ( recordedBefore ) {
			recovered = recordedBefore.find(
				( event ): event is ClaudeRecoveryJournalEvent =>
					event.type === 'turn.recovered' && event.lock === lock
			)!;
			recordedTerminal = recordedBefore.some( ( event ) => event.type === 'turn.terminal' );
		} else {
			const plan = await planRecovery( journals.flat().filter( turn ), record, lock );
			try {
				await store.recordRecovery( conversationId, record.token, plan.events );
			} catch {
				return blocked( 'recovery-failed' );
			}
			recovered = plan.recovered;
			recordedTerminal = plan.terminal;
		}
		try {
			if ( ! ( await store.releaseRecoveredLock( conversationId, raw ) ) )
				return blocked( 'lock-changed' );
		} catch {
			return blocked( 'recovery-failed' );
		}
		return {
			status: 'recovered',
			...ids,
			recordedTerminal,
			invalidatedApprovals: recovered.invalidatedApprovals,
			uncertainOperations: recovered.uncertainOperations,
		};
	} finally {
		await claim.release().catch( () => {} );
	}
}
