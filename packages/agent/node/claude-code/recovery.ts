import { realpath, stat } from 'fs/promises';
import path from 'path';
import {
	checkOwnedTreeEnded,
	checkProcessIdentity,
	readProcessIdentity,
} from '@studio/common/lib/owned-process';
import { __ } from '@wordpress/i18n';
import { claudeLockDigest } from './sessions';
import type { ClaudeRunLockRecord, createNativeSessionStore } from './sessions';
import type {
	BackendTurnEvent,
	ClaudeJournalEvent,
	ClaudeRecoveryJournalEvent,
} from '@studio/agent/protocol/backend-events';
import type { ClaudeBackendSessionBinding } from '@studio/agent/protocol/backend-sessions';
import type {
	ClaudeOperationClass,
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

let ownIdentity: Promise< ProcessIdentity | undefined > | undefined;

const systemSeams: ClaudeRecoverySeams = {
	platform: process.platform,
	self: () => {
		ownIdentity ??= readProcessIdentity( process.pid ).then( ( found ) => {
			if ( ! found ) ownIdentity = undefined;
			return found;
		} );
		return ownIdentity;
	},
	checkIdentity: ( identity ) => checkProcessIdentity( identity ),
	checkTree: ( processes ) => checkOwnedTreeEnded( processes ),
};

type NativeSessionStore = ReturnType< typeof createNativeSessionStore >;

// Operations that change nothing. Every other operation an approval was asked for is a mutation.
const READ_CLASSES: ReadonlySet< ClaudeOperationClass > = new Set( [ 'read', 'remote-read' ] );

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

// What recovery records for the dead turn: each approval it left pending,
// resolved so no reply can be applied; its outcome unless it recorded one; and
// what may have run.
function planRecovery(
	events: ClaudeJournalEvent[],
	record: ClaudeRunLockRecord,
	lock: string
): { events: ClaudeJournalEvent[]; recovered: ClaudeRecoveryJournalEvent; terminal: boolean } {
	const ids = { runId: record.runId, turnId: record.turnId };
	const requested = new Map<
		string,
		Extract< BackendTurnEvent, { type: 'approval.requested' } >
	>();
	const resolved = new Set< string >();
	const completed = new Set< string >();
	for ( const event of events ) {
		if ( event.type === 'approval.requested' && ! requested.has( event.requestId ) )
			requested.set( event.requestId, event );
		if ( event.type === 'approval.resolved' ) resolved.add( event.requestId );
		if ( event.type === 'tool.result' ) completed.add( event.toolCallId );
	}
	const pending = [ ...requested.values() ].filter(
		( event ) => ! resolved.has( event.requestId )
	);
	// Its answer is never journaled, and journal writes trail execution, so a
	// mutation without a recorded result may have run whether or not its
	// approval shows as answered.
	const uncertainOperations: ClaudeUncertainOperation[] = [ ...requested.values() ]
		.filter(
			( event ) =>
				! READ_CLASSES.has( event.operation.operationClass ) && ! completed.has( event.toolCallId )
		)
		.map( ( event ) => ( {
			requestId: event.requestId,
			toolCallId: event.toolCallId,
			tool: event.operation.tool,
			operationClass: event.operation.operationClass,
			target: event.operation.target,
			description: event.description,
			resolved: resolved.has( event.requestId ),
		} ) );
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
 * of these hold, and otherwise leaves the lock, the journal and the native
 * history exactly as they were:
 * - the lock is a run lock this build wrote, for this conversation, on this OS,
 *   with the conversation's own connection and workspace binding;
 * - its owner is provably gone, and either no native process could have
 *   started (`locked`) or the tree Studio owned is provably ended (`owned`);
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
	let claim: Awaited< ReturnType< NativeSessionStore[ 'claimRecovery' ] > >;
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
	if ( ! claim ) return blocked( 'recovery-in-progress' );
	try {
		if ( ! ( await store.holdsLock( conversationId, raw ) ) ) return blocked( 'lock-changed' );
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
			const plan = planRecovery( journals.flat().filter( turn ), record, lock );
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
