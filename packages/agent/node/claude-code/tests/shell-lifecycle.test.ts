import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHELL_TIMEOUT_LIMIT_MS } from '../execution-rules';
import { createShellDeadlines } from '../shell-deadlines';
import type {
	PostToolUseHookInput,
	PostToolUseFailureHookInput,
} from '@anthropic-ai/claude-agent-sdk/core';

const input = { command: 'pwd', timeout: 5_000 };
const hook = {
	session_id: 'session',
	transcript_path: '',
	cwd: '/site',
	tool_name: 'Bash',
	tool_input: input,
	tool_use_id: 'one',
};
const success = ( tool_response: unknown ): PostToolUseHookInput => ( {
	...hook,
	hook_event_name: 'PostToolUse',
	tool_response,
} );
const failure: PostToolUseFailureHookInput = {
	...hook,
	hook_event_name: 'PostToolUseFailure',
	error: 'Failed',
};
afterEach( () => vi.useRealTimers() );

describe( 'an approved foreground Bash command', () => {
	it( 'keeps its original deadline across duplicate approval callbacks', () => {
		vi.useFakeTimers();
		const stop = vi.fn();
		const deadlines = createShellDeadlines( stop );
		expect( deadlines.start( 'one', input, 'PreToolUse' ) ).toBe( true );
		vi.advanceTimersByTime( 4_000 );
		expect( deadlines.start( 'one', input, 'PreToolUse' ) ).toBe( false );
		expect( deadlines.start( 'one', input, 'canUseTool' ) ).toBe( true );
		expect( deadlines.start( 'one', input, 'canUseTool' ) ).toBe( false );
		expect( stop ).not.toHaveBeenCalled();
		vi.advanceTimersByTime( 1_000 );
		expect( stop ).toHaveBeenCalledExactlyOnceWith( 'shell-timeout' );
	} );

	it.each( [ success( { stdout: 'ok', stderr: '', interrupted: false } ), failure ] )(
		'clears only this use’s deadline on $hook_event_name, including a late permission callback',
		( event ) => {
			vi.useFakeTimers();
			const stop = vi.fn();
			const deadlines = createShellDeadlines( stop );
			deadlines.start( 'one', input, 'PreToolUse' );
			deadlines.start( 'other', { command: 'pwd' }, 'PreToolUse' );
			expect( deadlines.settle( event ) ).toBe(
				event.hook_event_name === 'PostToolUseFailure' ? 'failure' : 'success'
			);
			expect( deadlines.start( 'one', input, 'PreToolUse' ) ).toBe( false );
			vi.advanceTimersByTime( SHELL_TIMEOUT_LIMIT_MS - 1 );
			expect( stop ).not.toHaveBeenCalled();
			vi.advanceTimersByTime( 1 );
			expect( stop ).toHaveBeenCalledExactlyOnceWith( 'shell-timeout' );
		}
	);

	it( 'leaves a command pending on unrelated or mismatched results and discards all deadlines on shutdown', () => {
		vi.useFakeTimers();
		const stop = vi.fn();
		const deadlines = createShellDeadlines( stop );
		deadlines.start( 'one', input, 'PreToolUse' );
		const result = success( { interrupted: false } );
		for ( const other of [
			{ ...result, tool_use_id: 'different' },
			{ ...result, tool_input: { command: 'ls' } },
			{ ...result, tool_name: 'Read' },
			{ ...result, mcp_server: { name: 'other', source: 'sdk' as const } },
		] )
			expect( deadlines.settle( other ) ).toBeUndefined();
		vi.advanceTimersByTime( input.timeout );
		expect( stop ).toHaveBeenCalledOnce();
		deadlines.start( 'two', input, 'PreToolUse' );
		deadlines.dispose();
		deadlines.start( 'late', input, 'PreToolUse' );
		vi.runAllTimers();
		expect( stop ).toHaveBeenCalledOnce();
	} );

	it.each( [
		{ backgroundTaskId: 'task' },
		{ timedOutAfterMs: 5_000 },
		{ backgroundedByUser: true },
		{ backgroundEndsWithFinalResponse: true },
		{ backgroundWakesOwner: true },
		{ backgroundCwdHint: 'cwd retained' },
	] )( 'stops the turn on unexpected background execution', ( output ) => {
		vi.useFakeTimers();
		const stop = vi.fn();
		const deadlines = createShellDeadlines( stop );
		deadlines.start( 'one', input, 'PreToolUse' );
		expect( deadlines.settle( success( output ) ) ).toBeUndefined();
		expect( stop ).toHaveBeenCalledExactlyOnceWith( 'shell-background' );
		deadlines.dispose();
	} );

	it.each( [
		null,
		'done',
		{},
		{ stdout: '', stderr: '' },
		{ stdout: '', stderr: '', interrupted: 'false' },
		{ stdout: '', stderr: '', interrupted: false, dangerouslyDisableSandbox: true },
	] )( 'stops on an unverified foreground result', ( output ) => {
		const stop = vi.fn();
		const deadlines = createShellDeadlines( stop );
		deadlines.start( 'one', input, 'PreToolUse' );
		expect( deadlines.settle( success( output ) ) ).toBeUndefined();
		expect( deadlines.running ).toBe( true );
		expect( stop ).toHaveBeenCalledExactlyOnceWith( 'shell-unverified' );
		deadlines.dispose();
	} );
} );
