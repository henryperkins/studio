import { describe, expect, it } from 'vitest';
import { createAgent } from '../../agent';
import { createFakeHost } from '../../tests/fake-host';
import type { ClaudeCodeBackend } from '../dispatch';
import type {
	BackendTurnEvent,
	ClaudeBackendTurnSnapshot,
} from '@studio/agent/protocol/backend-events';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise< void >( ( done ) => {
		resolve = done;
	} );
	return { promise, resolve };
}

const initial = () => ( {
	backend: 'claude-code' as const,
	runId: 'run-1',
	turnId: 'turn-1',
	selection: {
		connectionId: 'native',
		model: { providerId: 'claude-code' as const, modelId: 'A' },
		revision: 1,
	},
	effort: 'medium',
	permissionPolicyRevision: 1,
	workspace: {
		workingDirectory: '/workspace',
		configDirectory: '/config',
		conversationId: 'chat',
		siteId: 'site',
	},
} );

function start( claudeCode: ClaudeCodeBackend, snapshot: ClaudeBackendTurnSnapshot = initial() ) {
	const events: BackendTurnEvent[] = [];
	const agent = createAgent( { host: createFakeHost( '.' ), claudeCode } );
	const handle = agent.runBackendTurn( snapshot, {
		backend: 'claude-code',
		prompt: 'Hello',
		onEvent: ( event ) => events.push( event ),
	} );
	return { handle, events };
}

describe( 'dispatching a Claude turn', () => {
	it( 'reconciles provisional snapshots and keeps confirmed content when duplicates or late deltas arrive', async () => {
		const { handle, events } = start( async ( { runId, turnId }, { onEvent } ) => {
			const block = {
				runId,
				turnId,
				messageId: 'message',
				blockId: 'block',
				blockType: 'text' as const,
			};
			const first = { ...block, type: 'content.provisional' as const, sequence: 1, text: 'Hel' };
			const final = { ...block, type: 'content.confirmed' as const, text: 'Hello' };
			onEvent( first );
			onEvent( first );
			onEvent( final );
			onEvent( { ...first, sequence: 2, text: 'Hello' } );
			onEvent( final );
			onEvent( { ...final, runId: 'old-run', blockId: 'old-block' } );
			onEvent( { ...final, turnId: 'old-turn', blockId: 'old-block' } );
			onEvent( { type: 'turn.terminal', runId, turnId, outcome: { status: 'success' } } );
		} );

		await expect( handle.result ).resolves.toEqual( { status: 'success' } );
		expect( events.map( ( event ) => event.type ) ).toEqual( [
			'content.provisional',
			'content.confirmed',
			'turn.terminal',
		] );
	} );

	it( 'keeps an explicit error result through iterator rejection and late events during cleanup', async () => {
		const cleanup = deferred();
		let notify!: ( event: BackendTurnEvent ) => void;
		const { handle, events } = start( async ( { runId, turnId }, { onEvent } ) => {
			notify = onEvent;
			onEvent( {
				type: 'turn.terminal',
				runId,
				turnId,
				outcome: { status: 'error', message: 'Native result' },
			} );
			await cleanup.promise;
			throw new Error( 'Iterator closed' );
		} );
		await Promise.resolve();
		expect( events ).toEqual( [] );
		notify( {
			type: 'turn.terminal',
			runId: 'run-1',
			turnId: 'turn-1',
			outcome: { status: 'unknown_process_exit' },
		} );
		cleanup.resolve();
		await expect( handle.result ).resolves.toEqual( { status: 'error', message: 'Native result' } );
		notify( {
			type: 'turn.terminal',
			runId: 'run-1',
			turnId: 'turn-1',
			outcome: { status: 'success' },
		} );
		expect( events ).toEqual( [
			{
				type: 'turn.terminal',
				runId: 'run-1',
				turnId: 'turn-1',
				outcome: { status: 'error', message: 'Native result' },
			},
		] );
	} );

	it( 'reports an unknown process exit when the backend ends without a result', async () => {
		const { handle, events } = start( async () => {} );
		await expect( handle.result ).resolves.toEqual( { status: 'unknown_process_exit' } );
		expect( events ).toEqual( [
			expect.objectContaining( {
				type: 'turn.terminal',
				outcome: { status: 'unknown_process_exit' },
			} ),
		] );
	} );

	it( 'reports a backend exception as a display-safe error', async () => {
		const { handle, events } = start( async () => {
			throw new Error( 'Unexpected backend error containing private details' );
		} );
		const outcome = { status: 'error', message: 'Claude Code could not complete the turn.' };
		await expect( handle.result ).resolves.toEqual( outcome );
		expect( events ).toEqual( [ expect.objectContaining( { type: 'turn.terminal', outcome } ) ] );
	} );

	it( 'waits for cleanup and reports an interrupt when the signal cancels an unfinished turn', async () => {
		const cleanup = deferred();
		const aborted = deferred();
		const { handle, events } = start( async ( _, { signal } ) => {
			signal.addEventListener( 'abort', () => aborted.resolve(), { once: true } );
			await cleanup.promise;
		} );
		await Promise.resolve();
		const interrupt = handle.interrupt();
		await aborted.promise;
		expect( events ).toEqual( [] );
		cleanup.resolve();
		await interrupt;
		await expect( handle.result ).resolves.toEqual( { status: 'interrupted' } );
		expect( events ).toEqual( [
			expect.objectContaining( { type: 'turn.terminal', outcome: { status: 'interrupted' } } ),
		] );
	} );

	it( 'retains the selection at Send across an awaited tool and uses the new selection next turn', async () => {
		const selection = initial();
		const tool = deferred();
		const observed: Array< [ string, string | null, string, number, number ] > = [];
		const claudeCode: ClaudeCodeBackend = async ( snapshot, { onEvent } ) => {
			const { runId, turnId } = snapshot;
			onEvent( { type: 'tool.started', runId, turnId, toolCallId: 'tool', name: 'Read' } );
			await tool.promise;
			observed.push( [
				snapshot.selection.model.modelId,
				snapshot.effort,
				snapshot.workspace.workingDirectory,
				snapshot.permissionPolicyRevision,
				snapshot.selection.revision,
			] );
			onEvent( { type: 'turn.terminal', runId, turnId, outcome: { status: 'success' } } );
		};
		const first = start( claudeCode, selection );
		await Promise.resolve();
		expect( first.events ).toEqual( [ expect.objectContaining( { type: 'tool.started' } ) ] );

		selection.selection.model.modelId = 'B';
		selection.selection.revision = 2;
		selection.effort = 'high';
		selection.workspace.workingDirectory = '/new-workspace';
		selection.permissionPolicyRevision = 2;
		tool.resolve();
		await first.handle.result;
		await start( claudeCode, { ...selection, runId: 'run-2', turnId: 'turn-2' } ).handle.result;

		expect( observed ).toEqual( [
			[ 'A', 'medium', '/workspace', 1, 1 ],
			[ 'B', 'high', '/new-workspace', 2, 2 ],
		] );
	} );

	it( 'returns an error when no Claude backend is registered', async () => {
		const events: BackendTurnEvent[] = [];
		const agent = createAgent( { host: createFakeHost( '.' ) } );
		const { result } = agent.runBackendTurn( initial(), {
			backend: 'claude-code',
			prompt: 'Hello',
			onEvent: ( event ) => events.push( event ),
		} );
		await expect( result ).resolves.toMatchObject( { status: 'error' } );
		expect( events ).toEqual( [ expect.objectContaining( { type: 'turn.terminal' } ) ] );
	} );
} );
