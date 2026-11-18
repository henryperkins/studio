import { readFileSync, realpathSync, statSync } from 'fs';
import path from 'path';
import { getConfigDirectory, getSessionsDirectory } from '@studio/common/lib/well-known-paths';
import { offerDesignSystemPreview } from '../chat-artifacts';
import { createResultNotes } from '../result-notes';
import { isRecord } from './execution-rules';
import { isInside } from './local-paths';
import type { ClaudeExecutionPolicy } from './execution-policy';
import type { StudioAgentUi } from '../host';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk/core';

export function nativeFileResultHook(
	policy: ClaudeExecutionPolicy,
	ui: StudioAgentUi | undefined,
	localSite: string | undefined,
	configDirectory: string,
	storeRoot: string,
	reportSuccess: ( toolUseId: string ) => void
): HookCallback {
	const excluded = [ configDirectory, storeRoot, getConfigDirectory(), getSessionsDirectory() ];
	const resultNotes = createResultNotes( ( file ) => {
		// Block metadata is read by Studio, outside the native file-tool guard.
		const canonical = realpathSync( file );
		const info = statSync( canonical );
		if (
			canonical !== file ||
			! info.isFile() ||
			info.nlink !== 1 ||
			excluded.some( ( root ) => isInside( root, canonical ) )
		) {
			throw new Error( 'Unavailable block metadata' );
		}
		return readFileSync( canonical, 'utf8' );
	} );
	return async ( hook, _id, context ) => {
		if (
			hook.hook_event_name !== 'PostToolUse' ||
			hook.mcp_server ||
			policy.signal.aborted ||
			context?.signal.aborted
		)
			return {};
		const { tool_name: name, tool_response: output } = hook;
		if ( ( name !== 'Write' && name !== 'Edit' ) || ! isRecord( output ) ) return {};
		const text = name === 'Write' ? output.content : output.newString;
		if (
			typeof text !== 'string' ||
			typeof output.filePath !== 'string' ||
			! path.isAbsolute( output.filePath ) ||
			( name === 'Write' && output.type !== 'create' && output.type !== 'update' )
		)
			return {};
		const file = policy.takeNativeFileWrite( hook.tool_use_id, name, hook.tool_input );
		if ( ! file || path.relative( file, output.filePath ) !== '' ) return {};
		reportSuccess( hook.tool_use_id );
		// The SDK can report a staged edit or write that left the site unchanged.
		if ( output.staged ) return {};
		const preview = await offerDesignSystemPreview( file, ui );
		const notes = localSite ? await resultNotes( localSite, text ) : undefined;
		const additionalContext = [ preview, notes ].filter( Boolean ).join( '\n' );
		return additionalContext
			? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } }
			: {};
	};
}
