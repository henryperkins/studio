import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';
import type { JsonEvent } from '@studio/agent/protocol/json-events';

export type AgentEvent =
	| JsonEvent
	| { type: 'run.started'; timestamp: string }
	| { type: 'run.interrupting'; timestamp: string }
	| { type: 'run.exited'; timestamp: string; status: 'success' | 'error'; code: number | null }
	| { type: 'run.interrupted'; timestamp: string };

export interface AgentRunEvent {
	runId: string;
	sessionId: string;
	event: AgentEvent;
}

export interface ActiveAgentRun {
	runId: string;
	sessionId: string;
	startedAt: number;
	phase: 'running' | 'interrupting';
	pendingClaudeApprovals?: Extract< BackendTurnEvent, { type: 'approval.requested' } >[];
	pendingQuestions?: Extract< JsonEvent, { type: 'question.asked' } >[ 'questions' ];
}
