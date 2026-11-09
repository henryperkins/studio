import type { StudioChatArtifactData } from './chat-artifacts';
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
	readonly workspace: Readonly< TurnWorkspace & { siteId: string; configDirectory: string } >;
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

/** Events sent by a backend using Studio's display protocol. */
export type BackendTurnEvent = BackendTurnIds &
	// Cumulative text, ordered by sequence within the block.
	( | ( { type: 'content.provisional'; sequence: number } & ContentBlock )
		// Authoritative replacement for any provisional text for this block.
		| ( { type: 'content.confirmed' } & ContentBlock )
		| ( { type: 'tool.started'; name: string; messageId?: string; blockId?: string } & ToolCall )
		| ( { type: 'tool.progress'; message: string; update?: boolean } & ToolCall )
		| ( { type: 'tool.result'; message?: string; isError: boolean } & ToolCall )
		| ( { type: 'approval.requested'; requestId: string; description: string } & ToolCall )
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
