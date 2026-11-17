import { randomUUID } from 'crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk/core';
import { z } from 'zod';
import { resolveStudioToolDefinitions } from '../tools';
import { bindTool } from '../tools/define-tool';
import { runStudioTool } from '../tools/execution';
import {
	CLAUDE_ENABLED_TOOLS,
	CLAUDE_NAVIGATION_CONFINEMENT,
	claudeRouteNote,
	claudeStudioTools,
	isRecord,
} from './execution-rules';
import type { ClaudeExecutionPolicy } from './execution-policy';
import type { StudioAgentHost } from '../host';
import type { StudioToolsOptions } from '../tools';
import type { StudioToolDefinition, ToolResult } from '../tools/define-tool';
import type { StudioToolRun } from '../tools/execution';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';

type BridgeResult = { content: ToolResult[ 'content' ]; isError: boolean };

/**
 * What the Claude route offers the registry, as the Pi route passes a turn's
 * capabilities. Claude's models see images. Questions and design choices are
 * not bridged yet (C2c). `generate_images` is offered only to a turn that
 * found Studio's image service (`ClaudeStudioToolCapabilities`).
 */
const CLAUDE_STUDIO_TOOL_CAPABILITIES: StudioToolsOptions = Object.freeze( {
	visionEnabled: true,
	canAskUser: false,
	imageGeneration: false,
	wpcomRequest: true,
} );

/** What a turn found that changes the tools it offers. */
export interface ClaudeStudioToolCapabilities {
	/** Studio's image service is available (`isImageGenerationAvailable`), as the Pi route asks. */
	imageGeneration?: boolean;
}

/** The Studio tools the Claude route can bridge for a host: the registry, resolved as on the Pi route. */
export function claudeStudioToolCandidates(
	host: Pick< StudioAgentHost, 'ui' >,
	capabilities: ClaudeStudioToolCapabilities = {}
): StudioToolDefinition[] {
	return resolveStudioToolDefinitions( host, {
		...CLAUDE_STUDIO_TOOL_CAPABILITIES,
		imageGeneration: capabilities.imageGeneration === true,
	} );
}

/**
 * Studio's tools as an in-process MCP server: each one under its canonical
 * name and description, with its canonical schema in the shape the SDK takes.
 * Where the description offers more than this route runs, the policy's own
 * note on what it runs follows it.
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
			const note = claudeRouteNote( definition.name );
			return tool(
				definition.name,
				note ? `${ definition.description }\n\n${ note }` : definition.description,
				schema.shape,
				( args, extra ) => invoke( definition.name, args, extra )
			);
		} ),
	} );
}

/**
 * The server a native startup check lists, none of whose tools it can run.
 * Discovery has no host or turn, so it lists what a turn of this build lists
 * for a host with no capabilities: every enabled tool no capability gates. Its
 * startup check, like a turn's, compares what the executable reports with
 * `tools`, the list its own server registered.
 */
export function createStudioClaudeDiscoveryServer() {
	const enabled = new Set(
		claudeStudioTools( CLAUDE_ENABLED_TOOLS, CLAUDE_NAVIGATION_CONFINEMENT, null )
	);
	const tools = claudeStudioToolCandidates( {} ).filter( ( definition ) =>
		enabled.has( definition.name )
	);
	return {
		server: createStudioClaudeMcpServer( tools, async () => ( { content: [], isError: true } ) ),
		tools: Object.freeze( tools.map( ( definition ) => definition.name ) ),
	};
}

// What Claude hears of a call that did not complete: which arguments the
// canonical schema refuses, so it can correct them; why the policy refused,
// in the policy's own fixed words; or else one fixed sentence, since a
// failure's own text can hold anything.
function describeNotRun(
	name: string,
	run: StudioToolRun | undefined,
	refused: readonly string[]
): string {
	if ( run?.status === 'invalid-arguments' )
		return `Invalid arguments for ${ name }: ${ run.problems.join( '; ' ) }.`;
	if ( refused.length ) return `Studio did not run this. ${ refused.join( ' ' ) }`;
	return 'Studio operation denied or failed.';
}

export interface ClaudeStudioToolBridgeOptions extends ClaudeStudioToolCapabilities {
	/**
	 * Narrows the tools a call can name before the policy selects; by default the
	 * host's candidates. Only those candidates' own definitions count: the policy
	 * authorizes a call by its tool's name, so any other definition is dropped.
	 */
	candidates?: readonly StudioToolDefinition[];
	/** How long `dispose` waits for calls still settling; `CLAUDE_TOOL_SETTLE_WAIT_MS` by default. */
	settleWaitMs?: number;
}

/**
 * How long a turn that ends waits for its calls still settling, such as the
 * attachments a cancelled `generate_images` call completes or deletes. Once
 * cancelled a call starts no new work, so this bounds only what was under way.
 */
const CLAUDE_TOOL_SETTLE_WAIT_MS = 30_000;

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
	const registry = claudeStudioToolCandidates( host, options );
	const tools = ( options.candidates ?? registry ).filter(
		( definition ) => registry.includes( definition ) && enabled.has( definition.name )
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
		let run: StudioToolRun | undefined;
		if ( definition ) {
			// The SDK aborts a call's own signal only when it cancels the call, so
			// the host lives exactly as long as this call: once the call has
			// settled, however it ended, a tool that kept the host can do nothing
			// with it.
			const call = new AbortController();
			try {
				// The tool reaches the host only as the policy guards it for this call.
				const guarded = policy.guardHost(
					host,
					toolCallId,
					signal ? AbortSignal.any( [ signal, call.signal ] ) : call.signal
				);
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
			} finally {
				call.abort();
			}
		}
		const refused = policy.takeRefusals( toolCallId );
		if ( run?.status !== 'completed' ) {
			onEvent( { type: 'tool.result', runId, turnId, toolCallId, isError: true } );
			return {
				isError: true,
				content: [ { type: 'text', text: describeNotRun( name, run, refused ) } ],
			};
		}
		onEvent( { type: 'tool.result', runId, turnId, toolCallId, isError: false } );
		return {
			isError: false,
			content: refused.length
				? [ ...run.result.content, { type: 'text', text: `Studio note: ${ refused.join( ' ' ) }` } ]
				: run.result.content,
		};
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
		/** The tools `server` lists, as the executable must report them at startup. */
		tools: Object.freeze( tools.map( ( definition ) => definition.name ) ),
		invoke,
		// Waits for the calls still running, at most `settleWaitMs`: the policy has
		// ended their authority, so they start nothing new, and only what they
		// must settle can still be under way.
		async dispose() {
			policy.dispose();
			try {
				await server.instance.close();
			} finally {
				let timer: ReturnType< typeof setTimeout > | undefined;
				await Promise.race( [
					Promise.allSettled( active ),
					new Promise< void >( ( resolve ) => {
						timer = setTimeout( resolve, options.settleWaitMs ?? CLAUDE_TOOL_SETTLE_WAIT_MS );
					} ),
				] );
				clearTimeout( timer );
			}
		},
	};
}
