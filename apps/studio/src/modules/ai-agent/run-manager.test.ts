import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import {
	answerAgentRun,
	interruptAgentRun,
	listActiveAgentRuns,
	startAgentRun,
} from './run-manager';
import type { WebContents } from 'electron';

const { manager } = vi.hoisted( () => ( {
	manager: {
		startAgentRun: vi.fn( () => ( { runId: 'run' } ) ),
		answerAgentRun: vi.fn( () => true ),
		interruptAgentRun: vi.fn(),
		listActiveAgentRuns: vi.fn( () => [
			{ runId: 'run', pendingClaudeQuestions: [ { requestId: 'pending' } ] },
		] ),
	},
} ) );
vi.mock( '@studio/agent/node/run-manager', () => ( { createAgentRunManager: () => manager } ) );
vi.mock( 'src/storage/paths', () => ( {
	getCliPath: () => 'cli',
	getBundledNodeBinaryPath: () => 'node',
} ) );
vi.mock( 'src/modules/cli/lib/execute-command', () => ( { getTracksOriginEnv: vi.fn() } ) );

it( 'only the owning renderer can restore, answer or stop a Claude run, and renderer loss interrupts it', () => {
	const owner = Object.assign( new EventEmitter(), {
		isDestroyed: () => false,
	} ) as unknown as WebContents;
	const other = {} as WebContents;
	const { runId } = startAgentRun( {
		sessionId: 'session',
		prompt: 'Ask',
		webContents: owner,
		claudeSelection: { model: 'model', effort: 'high' },
	} );
	expect( listActiveAgentRuns( other ) ).toEqual( [] );
	expect( listActiveAgentRuns( owner )[ 0 ].pendingClaudeQuestions ).toEqual( [
		{ requestId: 'pending' },
	] );
	expect( answerAgentRun( runId, { 'Choose?': 'B' }, other, 'pending' ) ).toBe( false );
	interruptAgentRun( runId, other );
	expect( manager.answerAgentRun ).not.toHaveBeenCalled();
	expect( manager.interruptAgentRun ).not.toHaveBeenCalled();
	expect( answerAgentRun( runId, { 'Choose?': 'B' }, owner, 'pending' ) ).toBe( true );
	expect( manager.answerAgentRun ).toHaveBeenCalledWith( runId, { 'Choose?': 'B' }, 'pending' );
	interruptAgentRun( runId, owner );
	expect( manager.interruptAgentRun ).toHaveBeenCalledWith( runId );
	manager.interruptAgentRun.mockClear();
	owner.emit( 'render-process-gone' );
	expect( manager.interruptAgentRun ).toHaveBeenCalledWith( runId );
} );
