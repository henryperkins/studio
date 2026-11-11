import { randomUUID } from 'crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk/core';
import { Value } from 'typebox/value';
import { z } from 'zod';
import { bindTool } from '../tools/define-tool';
import { runWpCliTool } from '../tools/wp-cli';
import type { ClaudeExecutionPolicy } from './execution-policy';
import type { StudioAgentHost } from '../host';
import type { ToolResult } from '../tools/define-tool';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';

export function createStudioClaudeMcpServer(
	invoke: ( args: unknown ) => Promise< { content: ToolResult[ 'content' ]; isError: boolean } >
) {
	const schema = z.fromJSONSchema(
		runWpCliTool.parameters as unknown as Parameters< typeof z.fromJSONSchema >[ 0 ]
	);
	if ( ! ( schema instanceof z.ZodObject ) ) throw new Error( 'Unsupported tool schema' );
	return createSdkMcpServer( {
		name: 'studio',
		tools: [
			tool(
				runWpCliTool.name,
				'Read the current local WordPress site or request approval to create a draft post.',
				schema.shape,
				invoke
			),
		],
	} );
}

// Studio's tools as an in-process MCP server. Each call is authorized by the
// execution policy before its handler runs, and runs against a host whose
// operations the policy fences again immediately before their CLI commands.
export function createStudioClaudeToolBridge(
	host: StudioAgentHost,
	turn: { runId: string; turnId: string; policy: ClaudeExecutionPolicy },
	onEvent: ( event: BackendTurnEvent ) => void
) {
	const { runId, turnId, policy } = turn;
	const active = new Set< Promise< unknown > >();
	async function execute( name: string, args: unknown ) {
		const toolCallId = randomUUID();
		onEvent( { type: 'tool.started', runId, turnId, toolCallId, name } );
		const fail = () => {
			onEvent( { type: 'tool.result', runId, turnId, toolCallId, isError: true } );
			return {
				isError: true as const,
				content: [ { type: 'text' as const, text: 'Studio operation denied or failed.' } ],
			};
		};
		try {
			if (
				policy.signal.aborted ||
				name !== runWpCliTool.name ||
				! Value.Check( runWpCliTool.parameters, args ) ||
				! ( await policy.authorizeStudioCall( name, args, toolCallId ) )
			)
				return fail();
			const bound = bindTool( runWpCliTool, policy.guardHost( host, toolCallId ) );
			const result = await bound.rawHandler( args, {
				onProgress: ( message, update ) =>
					onEvent( { type: 'tool.progress', runId, turnId, toolCallId, message, update } ),
			} );
			const pending = await result.pending;
			onEvent( { type: 'tool.result', runId, turnId, toolCallId, isError: false } );
			return {
				isError: false as const,
				content: pending
					? [ ...result.content, { type: 'text' as const, text: pending } ]
					: result.content,
			};
		} catch {
			return fail();
		}
	}
	async function invoke( name: string, args: unknown ) {
		const operation = execute( name, args );
		active.add( operation );
		try {
			return await operation;
		} finally {
			active.delete( operation );
		}
	}
	const server = createStudioClaudeMcpServer( ( args ) => invoke( runWpCliTool.name, args ) );
	return {
		server,
		invoke,
		async dispose() {
			policy.dispose();
			try {
				await server.instance.close();
			} finally {
				await Promise.allSettled( active );
			}
		},
	};
}
