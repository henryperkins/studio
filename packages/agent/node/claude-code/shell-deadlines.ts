import { isDeepStrictEqual } from 'node:util';
import { SHELL_TIMEOUT_LIMIT_MS } from './execution-rules';
import { plainData } from './plain-data';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk/core';

export type ShellStopReason = 'shell-timeout' | 'shell-background' | 'shell-unverified';
export type ShellApprovalCallback = 'PreToolUse' | 'canUseTool';

interface PendingShell {
	input: Record< string, unknown >;
	timer: NodeJS.Timeout;
	callbacks: Set< ShellApprovalCallback >;
}

/** Approvals can arrive through two SDK callbacks. Neither can extend a running command's time. */
export function createShellDeadlines( stop: ( reason: ShellStopReason ) => void ) {
	const seen = new Set< string >();
	const pending = new Map< string, PendingShell >();
	let disposed = false;
	return {
		get used() {
			return seen.size > 0;
		},
		get running() {
			return pending.size > 0;
		},
		start( id: string, input: Record< string, unknown >, source: ShellApprovalCallback ) {
			if ( disposed ) return false;
			if ( seen.has( id ) ) {
				const command = pending.get( id );
				if ( ! command || command.callbacks.has( source ) ) return false;
				command.callbacks.add( source );
				return true;
			}
			seen.add( id );
			const duration = typeof input.timeout === 'number' ? input.timeout : SHELL_TIMEOUT_LIMIT_MS;
			const timer = setTimeout( () => stop( 'shell-timeout' ), duration ).unref();
			pending.set( id, { input: { ...input }, timer, callbacks: new Set( [ source ] ) } );
			return true;
		},
		settle( hook: HookInput ): 'success' | 'failure' | undefined {
			if (
				( hook.hook_event_name !== 'PostToolUse' &&
					hook.hook_event_name !== 'PostToolUseFailure' ) ||
				hook.tool_name !== 'Bash' ||
				hook.mcp_server
			)
				return;
			const call = pending.get( hook.tool_use_id );
			const resultInput = plainData( hook.tool_input );
			if ( ! call || ! resultInput || ! isDeepStrictEqual( call.input, { ...resultInput } ) )
				return;
			let failed = hook.hook_event_name === 'PostToolUseFailure';
			if ( hook.hook_event_name === 'PostToolUse' ) {
				const result = plainData( hook.tool_response );
				if (
					result?.backgroundTaskId !== undefined ||
					result?.timedOutAfterMs !== undefined ||
					( result?.backgroundedByUser !== undefined && result.backgroundedByUser !== false ) ||
					result?.backgroundCwdHint !== undefined ||
					result?.backgroundEndsWithFinalResponse !== undefined ||
					result?.backgroundWakesOwner !== undefined
				) {
					stop( 'shell-background' );
					return;
				}
				if (
					! result ||
					typeof result.stdout !== 'string' ||
					typeof result.stderr !== 'string' ||
					typeof result.interrupted !== 'boolean' ||
					( result.dangerouslyDisableSandbox !== undefined &&
						result.dangerouslyDisableSandbox !== false )
				) {
					stop( 'shell-unverified' );
					return;
				}
				failed = result.interrupted;
			} else if ( typeof hook.error !== 'string' ) {
				stop( 'shell-unverified' );
				return;
			}
			clearTimeout( call.timer );
			pending.delete( hook.tool_use_id );
			return failed ? 'failure' : 'success';
		},
		dispose() {
			disposed = true;
			for ( const call of pending.values() ) clearTimeout( call.timer );
			pending.clear();
			seen.clear();
		},
	};
}
