import { randomUUID } from 'crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk/core';
import { z } from 'zod';
import { resolveStudioToolDefinitions, studioToolDefinitions } from '../tools';
import { bindTool } from '../tools/define-tool';
import { runStudioTool } from '../tools/execution';
import {
	CLAUDE_ENABLED_TOOLS,
	CLAUDE_NAVIGATION_CONFINEMENT,
	claudeStudioTools,
	isRecord,
} from './execution-rules';
import type { ClaudeExecutionPolicy } from './execution-policy';
import type { StudioAgentHost } from '../host';
import type { StudioToolsOptions } from '../tools';
import type { StudioToolDefinition, ToolResult } from '../tools/define-tool';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';

type BridgeResult = { content: ToolResult[ 'content' ]; isError: boolean };

/**
 * What the Claude route offers the registry, as the Pi route passes a turn's
 * capabilities. Claude's models see images. Questions and design choices are
 * not bridged yet (C2c), and the turn does not resolve the image service yet,
 * so `generate_images` is left out (C2a-3).
 */
const CLAUDE_STUDIO_TOOL_CAPABILITIES: StudioToolsOptions = Object.freeze( {
	visionEnabled: true,
	canAskUser: false,
	imageGeneration: false,
	wpcomRequest: true,
} );

/** The Studio tools the Claude route can bridge for a host: the registry, resolved as on the Pi route. */
export function claudeStudioToolCandidates( host: StudioAgentHost ): StudioToolDefinition[] {
	return resolveStudioToolDefinitions( host, CLAUDE_STUDIO_TOOL_CAPABILITIES );
}

/**
 * Studio's tools as an in-process MCP server: each one under its canonical
 * name and description, with its canonical schema in the shape the SDK takes.
 */
export function createStudioClaudeMcpServer(
	tools: readonly Pick< StudioToolDefinition, 'name' | 'description' | 'parameters' >[],
	invoke: ( name: string, args: unknown, extra?: unknown ) => Promise< BridgeResult >
) {
	return createSdkMcpServer( {
		name: 'studio',
		tools: tools.map( ( definition ) => {
			const schema = z.fromJSONSchema(
				definition.parameters as unknown as Parameters< typeof z.fromJSONSchema >[ 0 ]
			);
			if ( ! ( schema instanceof z.ZodObject ) ) throw new Error( 'Unsupported tool schema' );
			return tool( definition.name, definition.description, schema.shape, ( args, extra ) =>
				invoke( definition.name, args, extra )
			);
		} ),
	} );
}

/**
 * The server a native startup check lists: the tools a turn of this build can
 * enable, none of which it can run.
 */
export function createStudioClaudeDiscoveryServer() {
	const enabled = new Set(
		claudeStudioTools( CLAUDE_ENABLED_TOOLS, CLAUDE_NAVIGATION_CONFINEMENT, null )
	);
	return createStudioClaudeMcpServer(
		studioToolDefinitions.filter( ( definition ) => enabled.has( definition.name ) ),
		async () => ( { content: [], isError: true } )
	);
}

export interface ClaudeStudioToolBridgeOptions {
	/** The tools a call can name before the policy selects; by default the host's candidates. */
	candidates?: readonly StudioToolDefinition[];
}

// Studio's tools as an in-process MCP server, built from the registry and
// limited to the tools the execution policy enables. Each call runs through the
// shared execution semantics: its arguments are checked against the canonical
// schema, the policy authorizes it, and its tool runs against a host whose
// operations the policy fences again immediately before their CLI commands.
// Claude sees a result's content only, and of a failure a fixed sentence.
export function createStudioClaudeToolBridge(
	host: StudioAgentHost,
	turn: { runId: string; turnId: string; policy: ClaudeExecutionPolicy },
	onEvent: ( event: BackendTurnEvent ) => void,
	options: ClaudeStudioToolBridgeOptions = {}
) {
	const { runId, turnId, policy } = turn;
	const enabled = new Set( policy.studioTools );
	const tools = ( options.candidates ?? claudeStudioToolCandidates( host ) ).filter(
		( definition ) => enabled.has( definition.name )
	);
	const active = new Set< Promise< unknown > >();
	async function execute(
		name: string,
		args: unknown,
		signal?: AbortSignal
	): Promise< BridgeResult > {
		const toolCallId = randomUUID();
		onEvent( { type: 'tool.started', runId, turnId, toolCallId, name } );
		const definition = tools.find( ( candidate ) => candidate.name === name );
		let run: Awaited< ReturnType< typeof runStudioTool > > | undefined;
		if ( definition ) {
			try {
				// The tool reaches the host only as the policy guards it for this call.
				const guarded = policy.guardHost( host, toolCallId, signal );
				run = await runStudioTool( bindTool( definition, guarded ), args, {
					signal: signal ? AbortSignal.any( [ policy.signal, signal ] ) : policy.signal,
					authorize: () => policy.authorizeStudioCall( { host, name, args, toolCallId, signal } ),
					onProgress: ( message, update ) =>
						onEvent( { type: 'tool.progress', runId, turnId, toolCallId, message, update } ),
					ui: guarded.ui,
					completion: {},
				} );
			} catch {
				run = undefined;
			}
		}
		if ( run?.status !== 'completed' ) {
			onEvent( { type: 'tool.result', runId, turnId, toolCallId, isError: true } );
			return {
				isError: true,
				content: [ { type: 'text', text: 'Studio operation denied or failed.' } ],
			};
		}
		onEvent( { type: 'tool.result', runId, turnId, toolCallId, isError: false } );
		return { isError: false, content: run.result.content };
	}
	// `signal` is the MCP call's own: the SDK aborts it when the native runtime
	// gives up on the call, which cancels its approval and anything not yet started.
	async function invoke( name: string, args: unknown, signal?: AbortSignal ) {
		const operation = execute( name, args, signal );
		active.add( operation );
		try {
			return await operation;
		} finally {
			active.delete( operation );
		}
	}
	const server = createStudioClaudeMcpServer( tools, ( name, args, extra ) => {
		const signal = isRecord( extra ) ? extra.signal : undefined;
		return invoke( name, args, signal instanceof AbortSignal ? signal : undefined );
	} );
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
