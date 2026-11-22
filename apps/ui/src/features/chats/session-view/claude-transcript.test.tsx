import { describe, expect, it } from 'vitest';
import { projectClaudeTranscript } from './claude-transcript';
import type { ClaudeJournalEvent } from '@studio/agent/protocol/backend-events';

describe( 'Claude display journal', () => {
	it( 'copies a multi-block assistant message from its last text block', () => {
		const first = {
			type: 'content.confirmed',
			blockType: 'text',
			runId: 'r',
			turnId: 't',
			messageId: 'm',
			blockId: '0',
			text: 'First',
		} as const;
		const second = { ...first, blockId: '2', text: 'Second' };
		const { replies } = projectClaudeTranscript( [
			first,
			{ ...first, blockType: 'reasoning', blockId: '1', text: 'Thought' },
			second,
		] );
		expect( replies.get( first ) ).toEqual( { text: 'First\n\nSecond', copy: undefined } );
		expect( replies.get( second )?.copy ).toBe( 'First\n\nSecond' );
	} );

	it( 'reconciles overlapping history and live events in their original positions', () => {
		const ids = { runId: 'r', turnId: 't' };
		const block = { ...ids, messageId: 'm', blockId: '0', blockType: 'text' as const };
		const prompt: ClaudeJournalEvent = {
			...ids,
			type: 'turn.prompt',
			text: 'Review this',
			attachments: [ { kind: 'file', name: 'brief.md' } ],
		};
		const tool: ClaudeJournalEvent = {
			...ids,
			type: 'tool.started',
			name: 'wp_cli',
			toolCallId: 'call',
		};
		const result: ClaudeJournalEvent = {
			...ids,
			type: 'tool.result',
			toolCallId: 'call',
			isError: false,
			message: 'Studio site',
		};
		const terminal: ClaudeJournalEvent = {
			...ids,
			type: 'turn.terminal',
			outcome: { status: 'success' },
		};
		const confirmed: ClaudeJournalEvent = { ...block, type: 'content.confirmed', text: 'Final' };
		const task: ClaudeJournalEvent = {
			...ids,
			type: 'task.status',
			taskId: 'work',
			status: 'completed',
		};
		const { rows, results } = projectClaudeTranscript( [
			prompt,
			{ ...block, type: 'content.provisional', sequence: 1, text: 'F' },
			tool,
			result,
			task,
			terminal,
			prompt,
			confirmed,
			tool,
			result,
			terminal,
			{ ...task, status: 'running' },
			{ ...block, type: 'content.provisional', sequence: 7, text: 'stale' },
		] );
		expect( rows ).toEqual( [ prompt, confirmed, tool, task, terminal ] );
		expect( [ ...results.values() ] ).toEqual( [ result ] );
	} );
} );
