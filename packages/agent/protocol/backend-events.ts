import type { StudioChatArtifactData } from './chat-artifacts';
import type {
	ClaudeOperationClass,
	ClaudeStudioTarget,
	ClaudeUncertainOperation,
} from './claude-code';
import type { ConnectionBackend, ConnectionSelection } from './connections';
import type { AiProviderId } from './providers';

interface BackendTurnIds {
	runId: string;
	turnId: string;
}

type FrozenConnection< ProviderId extends AiProviderId | 'claude-code' > = Readonly<
	Omit< ConnectionSelection< ProviderId >, 'model' > & {
		model: Readonly< ConnectionSelection< ProviderId >[ 'model' ] >;
	}
>;

interface TurnWorkspace {
	conversationId: string;
	siteId: string | null;
	workingDirectory: string;
}

interface TurnSnapshot<
	Backend extends ConnectionBackend,
	ProviderId extends AiProviderId | 'claude-code',
> extends Readonly< BackendTurnIds > {
	readonly backend: Backend;
	readonly selection: FrozenConnection< ProviderId >;
	readonly effort: string | null;
	readonly permissionPolicyRevision: number;
}

/** Selection and workspace at Send. Runtime credentials are supplied separately. */
export interface PiBackendTurnSnapshot extends TurnSnapshot< 'pi', AiProviderId > {
	readonly workspace: Readonly< TurnWorkspace >;
}

export interface ClaudeBackendTurnSnapshot extends TurnSnapshot< 'claude-code', 'claude-code' > {
	/**
	 * The conversation's native identity, which never moves: its workspace, the
	 * site that folder belongs to (null for the global workspace) and the native
	 * configuration that holds its history.
	 */
	readonly workspace: Readonly< TurnWorkspace & { configDirectory: string } >;
	/** The Studio target selected at Send. A later selection applies to a later turn. */
	readonly target: Readonly< ClaudeStudioTarget >;
}

export type BackendTurnSnapshot = PiBackendTurnSnapshot | ClaudeBackendTurnSnapshot;

export interface BackendTurnOutcome {
	status:
		| 'success'
		| 'error'
		| 'interrupted'
		| 'max_turns'
		| 'budget_exceeded'
		| 'deferred'
		| 'unknown_process_exit';
	/** Display-safe information supplied by the backend. */
	message?: string;
	/**
	 * Why the turn stopped, for an app to explain in its own words:
	 * `account_changed` when the native sign-in became another account or none,
	 * `account_unverified` when it could not be read, `process_unowned` when
	 * Studio could not take ownership of the native process tree, so nothing
	 * was sent, and `process_unconfirmed` when Studio could not confirm that
	 * every process of the turn ended, so the conversation stays locked until
	 * it is recovered, and `recovered` when the turn's process ended without
	 * finishing it and Studio recorded this outcome when it recovered the
	 * conversation.
	 */
	code?:
		| 'rebind_required'
		| 'account_changed'
		| 'account_unverified'
		| 'process_unowned'
		| 'process_unconfirmed'
		| 'recovered';
}

interface ContentBlock {
	messageId: string;
	blockId: string;
	blockType: 'text' | 'reasoning';
	text: string;
}

interface ToolCall {
	toolCallId: string;
}

/** Display-safe copy of the one operation an approval covers. */
export interface BackendApprovalOperation {
	/** Canonical Studio tool, native tool or host operation name. */
	tool: string;
	operationClass: ClaudeOperationClass;
	target: ClaudeStudioTarget;
	/** The exact arguments, as escaped JSON. */
	args: string;
	localPaths: string[];
	remote?: string;
}

/** Events sent by a backend using Studio's display protocol. */
export type BackendTurnEvent = BackendTurnIds &
	// Cumulative text, ordered by sequence within the block.
	( | { type: 'turn.prompt'; text: string }
		| ( { type: 'content.provisional'; sequence: number } & ContentBlock )
		// Authoritative replacement for any provisional text for this block.
		| ( { type: 'content.confirmed' } & ContentBlock )
		| ( { type: 'tool.started'; name: string; messageId?: string; blockId?: string } & ToolCall )
		| ( { type: 'tool.progress'; message: string; update?: boolean } & ToolCall )
		| ( { type: 'tool.result'; message?: string; isError: boolean } & ToolCall )
		| ( {
				type: 'approval.requested';
				requestId: string;
				description: string;
				operation: BackendApprovalOperation;
				draft?: { siteName: string; title: string; content?: string };
		  } & ToolCall )
		| ( { type: 'approval.resolved'; requestId: string } & ToolCall )
		| {
				type: 'question.asked';
				requestId: string;
				questions: Array< {
					question: string;
					options: Array< { label: string; description: string; image?: string } >;
					multiSelect?: boolean;
					allowFreeForm?: boolean;
				} >;
		  }
		| { type: 'chat.artifact'; artifact: StudioChatArtifactData }
		| { type: 'preview.reload' }
		| { type: 'turn.terminal'; outcome: BackendTurnOutcome }
	);

/**
 * An approval request journaled before requests named their operation. Kept
 * for display only: it is never pending and can never be answered.
 */
export interface LegacyApprovalRequestedEvent extends BackendTurnIds, ToolCall {
	type: 'approval.legacy';
	requestId: string;
	description: string;
	draft?: { siteName: string; title: string; content?: string };
}

/**
 * Recorded once when Studio recovers a turn whose process ended without
 * finishing it. Display-only: nothing is replayed or answered from it.
 */
export interface ClaudeRecoveryJournalEvent extends BackendTurnIds {
	type: 'turn.recovered';
	/** Identifies the run lock the recovery released: a hash of its token. */
	lock: string;
	invalidatedApprovals: string[];
	uncertainOperations: ClaudeUncertainOperation[];
}

/** What a Claude conversation's display journal holds once read back. */
export type ClaudeJournalEvent =
	| BackendTurnEvent
	| LegacyApprovalRequestedEvent
	| ClaudeRecoveryJournalEvent;
