import { describe, expect, it } from 'vitest';
import { createClaudeEventAdapter } from '../event-adapter';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';

describe( 'Claude SDK event adapter (mock SDK messages)', () => {
	it( 'reports only the first explicit terminal outcome and rejects an error marked success', () => {
		const events: BackendTurnEvent[] = [];
		const adapter = createClaudeEventAdapter( 'run', 'turn', ( event ) => events.push( event ) );
		adapter.accept( { type: 'result', subtype: 'success', is_error: true, session_id: 'session' } );
		adapter.accept( {
			type: 'result',
			subtype: 'success',
			is_error: false,
			session_id: 'session',
		} );
		expect( events ).toEqual( [
			{
				type: 'turn.terminal',
				runId: 'run',
				turnId: 'turn',
				outcome: { status: 'error', message: 'Claude Code reported an error.' },
			},
		] );
	} );

	it.each( [
		[ 'error_max_turns', 'max_turns' ],
		[ 'error_max_budget_usd', 'budget_exceeded' ],
	] )( 'maps %s to %s', ( subtype, status ) => {
		const events: BackendTurnEvent[] = [];
		const adapter = createClaudeEventAdapter( 'run', 'turn', ( event ) => events.push( event ) );
		adapter.accept( { type: 'result', subtype, is_error: true, session_id: 'session' } );
		expect( events[ 0 ] ).toMatchObject( { type: 'turn.terminal', outcome: { status } } );
	} );
} );

it( 'reconciles a complete assistant block before its stop and ignores replayed frames', () => {
	const events: BackendTurnEvent[] = [];
	const adapter = createClaudeEventAdapter( 'run', 'turn', ( event ) => events.push( event ) );
	adapter.accept( {
		type: 'stream_event',
		event: { type: 'message_start', message: { id: 'message' } },
	} );
	adapter.accept( {
		type: 'stream_event',
		event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
	} );
	adapter.accept( {
		type: 'stream_event',
		event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
	} );
	const final = {
		type: 'assistant',
		uuid: 'frame',
		message: { id: 'message', content: [ { type: 'text', text: 'Hi!' } ] },
	};
	adapter.accept( final );
	adapter.accept( { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } } );
	adapter.accept( final );
	expect( events ).toMatchObject( [
		{ type: 'content.provisional', messageId: 'message', blockId: '0', text: 'Hi' },
		{ type: 'content.confirmed', messageId: 'message', blockId: '0', text: 'Hi!' },
	] );
} );

it( 'fails closed when a success result reports an abnormal terminal reason', () => {
	const events: BackendTurnEvent[] = [];
	const adapter = createClaudeEventAdapter( 'run', 'turn', ( event ) => events.push( event ) );
	adapter.accept( {
		type: 'result',
		subtype: 'success',
		is_error: false,
		terminal_reason: 'model_error',
	} );
	expect( events ).toMatchObject( [ { type: 'turn.terminal', outcome: { status: 'error' } } ] );
} );

it( 'rejects reported chargeable overage and does not accept a later success', () => {
	const events: BackendTurnEvent[] = [];
	const adapter = createClaudeEventAdapter( 'run', 'turn', ( event ) => events.push( event ) );
	adapter.accept( { type: 'rate_limit_event', rate_limit_info: { isUsingOverage: true } } );
	adapter.accept( { type: 'result', subtype: 'success', is_error: false } );
	expect( events ).toMatchObject( [ { type: 'turn.terminal', outcome: { status: 'error' } } ] );
} );

it( 'does not report success for a zero-turn blocked prompt', () => {
	const events: BackendTurnEvent[] = [];
	const adapter = createClaudeEventAdapter( 'run', 'turn', ( event ) => events.push( event ) );
	adapter.accept( {
		type: 'result',
		subtype: 'success',
		is_error: false,
		num_turns: 0,
		duration_api_ms: 0,
		stop_reason: null,
	} );
	expect( events ).toMatchObject( [ { type: 'turn.terminal', outcome: { status: 'error' } } ] );
} );

it( 'keeps stopped streamed block identities when a complete multi-block frame arrives and is replayed', () => {
	const events: BackendTurnEvent[] = [];
	const adapter = createClaudeEventAdapter( 'run', 'turn', ( event ) => events.push( event ) );
	adapter.accept( {
		type: 'stream_event',
		event: { type: 'message_start', message: { id: 'message' } },
	} );
	for ( const [ index, text ] of [
		[ 0, 'First' ],
		[ 1, 'Second' ],
	] as const ) {
		adapter.accept( {
			type: 'stream_event',
			event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
		} );
		adapter.accept( {
			type: 'stream_event',
			event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
		} );
		adapter.accept( { type: 'stream_event', event: { type: 'content_block_stop', index } } );
	}
	const payload = {
		id: 'message',
		content: [
			{ type: 'text', text: 'First' },
			{ type: 'text', text: 'Second' },
		],
	};
	adapter.accept( { type: 'assistant', uuid: 'frame', message: payload } );
	adapter.accept( { type: 'assistant', uuid: 'replayed-frame', message: payload } );
	expect( events.filter( ( event ) => event.type === 'content.confirmed' ) ).toMatchObject( [
		{ messageId: 'message', blockId: '0', text: 'First' },
		{ messageId: 'message', blockId: '1', text: 'Second' },
	] );
} );

it( 'reconciles a stopped single block with a late complete frame', () => {
	const events: BackendTurnEvent[] = [];
	const adapter = createClaudeEventAdapter( 'run', 'turn', ( event ) => events.push( event ) );
	adapter.accept( {
		type: 'stream_event',
		event: { type: 'message_start', message: { id: 'message' } },
	} );
	adapter.accept( {
		type: 'stream_event',
		event: { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
	} );
	adapter.accept( {
		type: 'stream_event',
		event: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Hello' } },
	} );
	adapter.accept( { type: 'stream_event', event: { type: 'content_block_stop', index: 2 } } );
	adapter.accept( {
		type: 'assistant',
		uuid: 'late',
		message: { id: 'message', content: [ { type: 'text', text: 'Hello' } ] },
	} );
	expect( events ).toMatchObject( [
		{ type: 'content.provisional', blockId: '2' },
		{ type: 'content.confirmed', blockId: '2' },
	] );
} );

it( 'does not associate a completed text block with an earlier non-text stream block', () => {
	const events: BackendTurnEvent[] = [];
	const adapter = createClaudeEventAdapter( 'run', 'turn', ( event ) => events.push( event ) );
	adapter.accept( {
		type: 'stream_event',
		event: { type: 'message_start', message: { id: 'm' } },
	} );
	adapter.accept( {
		type: 'stream_event',
		event: {
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'call', name: 'Read', input: {} },
		},
	} );
	adapter.accept( { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } } );
	adapter.accept( {
		type: 'stream_event',
		event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
	} );
	adapter.accept( {
		type: 'stream_event',
		event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } },
	} );
	adapter.accept( { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } } );
	adapter.accept( {
		type: 'assistant',
		uuid: 'f',
		message: { id: 'm', content: [ { type: 'text', text: 'Hi' } ] },
	} );
	expect( events ).toMatchObject( [
		{ type: 'content.provisional', blockId: '1' },
		{ type: 'content.confirmed', blockId: '1' },
	] );
} );

it( 'retains text and reasoning from one complete assistant message', () => {
	const events: BackendTurnEvent[] = [];
	const adapter = createClaudeEventAdapter( 'run', 'turn', ( event ) => events.push( event ) );
	adapter.accept( {
		type: 'assistant',
		uuid: 'frame',
		message: {
			id: 'm',
			content: [
				{ type: 'thinking', thinking: 'Consider' },
				{ type: 'text', text: 'Answer' },
			],
		},
	} );
	expect( events ).toMatchObject( [
		{ type: 'content.confirmed', blockType: 'reasoning', blockId: '0', text: 'Consider' },
		{ type: 'content.confirmed', blockType: 'text', blockId: '1', text: 'Answer' },
	] );
} );

it( 'uses provisional text evidence to distinguish stopped text blocks', () => {
	const events: BackendTurnEvent[] = [];
	const adapter = createClaudeEventAdapter( 'run', 'turn', ( event ) => events.push( event ) );
	adapter.accept( {
		type: 'stream_event',
		event: { type: 'message_start', message: { id: 'm' } },
	} );
	for ( const index of [ 0, 1 ] ) {
		adapter.accept( {
			type: 'stream_event',
			event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
		} );
		if ( index === 1 )
			adapter.accept( {
				type: 'stream_event',
				event: {
					type: 'content_block_delta',
					index,
					delta: { type: 'text_delta', text: 'Second' },
				},
			} );
		adapter.accept( { type: 'stream_event', event: { type: 'content_block_stop', index } } );
	}
	adapter.accept( {
		type: 'assistant',
		uuid: 'frame',
		message: { id: 'm', content: [ { type: 'text', text: 'Second' } ] },
	} );
	expect( events ).toMatchObject( [
		{ type: 'content.provisional', blockId: '1' },
		{ type: 'content.confirmed', blockId: '1' },
	] );
} );
