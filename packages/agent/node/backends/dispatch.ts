import { runPiBackendTurn, type PiBackendTurnHandlers } from './pi';
import type { StudioAgentHost } from '../host';
import type {
	BackendTurnEvent,
	BackendTurnOutcome,
	BackendTurnSnapshot,
	ClaudeBackendTurnSnapshot,
	PiBackendTurnSnapshot,
} from '@studio/agent/protocol/backend-events';
import type { StudioChatImage } from '@studio/agent/protocol/chat-images';

interface ClaudeBackendTurnInput {
	prompt: string;
	images?: StudioChatImage[];
	onEvent: ( event: BackendTurnEvent ) => void;
}

export interface ClaudeBackendTurnHandlers extends ClaudeBackendTurnInput {
	backend: 'claude-code';
}

/** Emits a terminal result when known and settles after its resources are cleaned up. */
export type ClaudeCodeBackend = (
	snapshot: ClaudeBackendTurnSnapshot,
	input: ClaudeBackendTurnInput & { signal: AbortSignal }
) => Promise< void >;

export interface BackendTurnHandle {
	result: Promise< BackendTurnOutcome >;
	interrupt(): Promise< void >;
}

export interface RunBackendTurn {
	( snapshot: ClaudeBackendTurnSnapshot, handlers: ClaudeBackendTurnHandlers ): BackendTurnHandle;
	( snapshot: PiBackendTurnSnapshot, handlers: PiBackendTurnHandlers ): BackendTurnHandle;
}

export function createBackendTurnRunner(
	host: StudioAgentHost,
	claudeCode: ClaudeCodeBackend | undefined
): RunBackendTurn {
	return (
		snapshot: BackendTurnSnapshot,
		handlers: ClaudeBackendTurnHandlers | PiBackendTurnHandlers
	) => {
		if ( snapshot.backend === 'pi' && handlers.backend === 'pi' ) {
			return runPiBackendTurn( host, snapshot, handlers );
		}
		if ( snapshot.backend === 'claude-code' && handlers.backend === 'claude-code' ) {
			return runClaudeBackendTurn( snapshot, handlers, claudeCode );
		}
		throw new Error( 'The turn handlers do not match the selected backend.' );
	};
}

function freezeClaudeTurn( snapshot: ClaudeBackendTurnSnapshot ): ClaudeBackendTurnSnapshot {
	const { runId, turnId, effort, permissionPolicyRevision } = snapshot;
	const { connectionId, model, revision } = snapshot.selection;
	const { conversationId, siteId, workingDirectory, configDirectory } = snapshot.workspace;
	return Object.freeze( {
		backend: 'claude-code',
		runId,
		turnId,
		effort,
		permissionPolicyRevision,
		selection: Object.freeze( {
			connectionId,
			model: Object.freeze( { providerId: model.providerId, modelId: model.modelId } ),
			revision,
		} ),
		workspace: Object.freeze( { conversationId, siteId, workingDirectory, configDirectory } ),
	} );
}

function runClaudeBackendTurn(
	selection: ClaudeBackendTurnSnapshot,
	{ onEvent, prompt, images }: ClaudeBackendTurnHandlers,
	claudeCode: ClaudeCodeBackend | undefined
): BackendTurnHandle {
	const snapshot = freezeClaudeTurn( selection );
	const { runId, turnId } = snapshot;
	const controller = new AbortController();
	const { signal } = controller;
	// null marks a confirmed block, which no partial or repeated final may change.
	const blocks = new Map< string, number | null >();
	let terminal: BackendTurnOutcome | undefined;

	const receiveEvent = ( event: BackendTurnEvent ) => {
		if ( terminal || signal.aborted || event.runId !== runId || event.turnId !== turnId ) {
			return;
		}
		if ( event.type === 'turn.terminal' ) {
			terminal = { ...event.outcome };
			return;
		}
		if ( event.type === 'content.provisional' || event.type === 'content.confirmed' ) {
			const key = JSON.stringify( [ event.messageId, event.blockId ] );
			const lastSequence = blocks.get( key );
			if ( lastSequence === null ) {
				return;
			}
			if ( event.type === 'content.provisional' ) {
				if ( lastSequence !== undefined && event.sequence <= lastSequence ) {
					return;
				}
				blocks.set( key, event.sequence );
			} else {
				blocks.set( key, null );
			}
		}
		onEvent( event );
	};

	const result = Promise.resolve().then( async () => {
		if ( ! signal.aborted ) {
			if ( ! claudeCode ) {
				terminal = { status: 'error', message: 'Claude Code is unavailable.' };
			} else {
				try {
					await claudeCode( snapshot, { prompt, images, signal, onEvent: receiveEvent } );
				} catch {
					if ( ! signal.aborted ) {
						terminal ??= { status: 'error', message: 'Claude Code could not complete the turn.' };
					}
				}
			}
		}
		terminal ??= { status: signal.aborted ? 'interrupted' : 'unknown_process_exit' };
		onEvent( { type: 'turn.terminal', runId, turnId, outcome: terminal } );
		return terminal;
	} );

	return {
		result,
		async interrupt() {
			if ( ! terminal ) {
				controller.abort();
			}
			await result;
		},
	};
}
