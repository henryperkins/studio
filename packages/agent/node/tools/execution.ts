import { Value } from 'typebox/value';
import { emitChatArtifactWidgets } from '@studio/agent/node/chat-artifacts';
import type { AnyStudioAgentTool, ToolResult } from './define-tool';
import type { StudioAgentUi } from '@studio/agent/node/host';
import type { StudioChatArtifactWidgetDraft } from '@studio/agent/protocol/chat-artifacts';
import type { TSchema } from 'typebox';

/**
 * How a Studio tool call runs, whichever runtime asked for it: the Pi route,
 * `studio mcp` or the Claude route. Each runtime adapts its own transport to
 * these steps and renders the outcome in its own form, but none runs a tool's
 * handler any other way.
 */

type ToolContent = ToolResult[ 'content' ][ number ];

export type ToolProgress = ( message: string, update?: boolean ) => void;

/** Work tools leave running, kept across calls (the Pi route's `PendingWork`). */
export interface PendingWorkTracker {
	add( pending: Promise< string | undefined > ): void;
	settle(): Promise< void >;
	takeReports(): string | undefined;
}

export interface ToolResultCompletion {
	/**
	 * Where the work a tool leaves running goes, to be reported with a later
	 * result. Without it, the call waits for that work and reports it with its
	 * own result.
	 */
	pendingWork?: PendingWorkTracker;
	/** Facts Studio adds about what a result's text shows (`result-notes.ts`). */
	notes?: ( text: string ) => Promise< string | undefined > | string | undefined;
}

export interface StudioToolRunOptions {
	/**
	 * Checks the arguments against the tool's canonical schema before anything
	 * else. A runtime whose transport has already validated them against that
	 * schema turns this off.
	 */
	validate?: boolean;
	/** Decides, once the arguments are valid and before the tool starts, whether the call may run. */
	authorize?: () => Promise< boolean >;
	/** Once aborted, a call that has not started does not start. */
	signal?: AbortSignal;
	onProgress?: ToolProgress;
	/** Shows the result's artifacts in the conversation; absent when no app shows it. */
	ui?: StudioAgentUi;
	/**
	 * Completes the result here. Without it the result keeps its pending work,
	 * for a runtime that completes every tool's result itself.
	 */
	completion?: ToolResultCompletion;
}

/**
 * How a call ended. Only `completed` carries anything the tool produced; a
 * failure keeps the error for the runtime to decide what it may show.
 */
export type StudioToolRun =
	| { status: 'completed'; result: ToolResult }
	| { status: 'invalid-arguments'; problems: string[] }
	| { status: 'refused' }
	| { status: 'cancelled' }
	| { status: 'failed'; error: unknown };

/** What is wrong with a call's arguments, at most three problems, or undefined when they are valid. */
export function checkToolArguments( schema: unknown, args: unknown ): string[] | undefined {
	if ( Value.Check( schema as TSchema, args ) ) {
		return undefined;
	}
	return [ ...Value.Errors( schema as TSchema, args ) ]
		.slice( 0, 3 )
		.map( ( error ) => `${ error.instancePath || 'arguments' } ${ error.message }` );
}

/** The text a thrown value carries, as the runtimes that show it to the model word it. */
export function describeToolError( error: unknown ): string {
	return error instanceof Error ? error.message : String( error );
}

/**
 * Shows a result's artifacts in the conversation. They are presentation only:
 * a failure to show them is logged and never fails the call.
 */
async function showToolArtifacts(
	ui: StudioAgentUi | undefined,
	toolName: string,
	widgets: readonly StudioChatArtifactWidgetDraft[] | undefined
): Promise< void > {
	if ( ! ui ) {
		return;
	}
	try {
		await emitChatArtifactWidgets( ui, widgets );
	} catch ( error ) {
		console.warn( `[chat-artifacts] failed to emit artifact for ${ toolName }:`, error );
	}
}

/** A tool that renders the site runs only once the work earlier tools left running has settled. */
export async function settlePendingWorkFor(
	tool: { settlesPendingWork?: boolean },
	pendingWork: PendingWorkTracker | undefined
): Promise< void > {
	if ( tool.settlesPendingWork ) {
		await pendingWork?.settle();
	}
}

/**
 * Adds Studio's notes, and what work left running reports, to a result's
 * content as one text block after it. Returns the same array when there is
 * nothing to add.
 */
export async function completeToolResult(
	content: ToolContent[],
	pending: Promise< string | undefined > | undefined,
	{ pendingWork, notes }: ToolResultCompletion
): Promise< ToolContent[] > {
	const text = content.map( ( part ) => ( part.type === 'text' ? part.text : '' ) ).join( '\n' );
	if ( pending && pendingWork ) {
		pendingWork.add( pending );
	}
	const noted = await notes?.( text );
	const reported = pendingWork ? pendingWork.takeReports() : await pending;
	const added = [ noted, reported ].filter( Boolean ).join( '\n' );
	return added ? [ ...content, { type: 'text', text: added } ] : content;
}

/**
 * Runs one call of a bound Studio tool: its arguments are checked against the
 * canonical schema, the runtime's gate decides, a cancelled call never starts,
 * progress goes to `onProgress`, the result is completed with notes and pending
 * work, and a successful result's artifacts are shown. With `completion` they
 * are shown only once the result is complete, so nothing of a call whose
 * pending work or notes fail is shown. Without it they are shown as soon as the
 * tool returns, and its pending work is the runtime's (Pi reports it with a
 * later result). From the gate on, anything that goes wrong is the outcome; only
 * the argument check runs before that, and throws as `studio mcp`'s own check
 * always could, for a schema or arguments it cannot read.
 */
export async function runStudioTool(
	tool: AnyStudioAgentTool,
	args: unknown,
	options: StudioToolRunOptions = {}
): Promise< StudioToolRun > {
	const { signal, completion } = options;
	if ( options.validate !== false ) {
		const problems = checkToolArguments( tool.parameters, args );
		if ( problems ) {
			return { status: 'invalid-arguments', problems };
		}
	}
	try {
		if ( signal?.aborted ) {
			return { status: 'cancelled' };
		}
		if ( options.authorize && ! ( await options.authorize() ) ) {
			return { status: 'refused' };
		}
		await settlePendingWorkFor( tool, completion?.pendingWork );
		if ( signal?.aborted ) {
			return { status: 'cancelled' };
		}
		const { onProgress } = options;
		const result = await tool.rawHandler( args as never, onProgress ? { onProgress } : undefined );
		if ( ! completion ) {
			await showToolArtifacts( options.ui, tool.name, result.studioArtifacts );
			return { status: 'completed', result };
		}
		const { pending, ...completed } = result;
		const content = await completeToolResult( result.content, pending, completion );
		await showToolArtifacts( options.ui, tool.name, result.studioArtifacts );
		return { status: 'completed', result: { ...completed, content } };
	} catch ( error ) {
		return { status: 'failed', error };
	}
}
