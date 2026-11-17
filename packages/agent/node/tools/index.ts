import { bindTool } from './define-tool';
import { runStudioTool } from './execution';
import { generateImagesTool } from './generate-images';
import { createInspectDesignTool, inspectDesignTool } from './inspect-design';
import { createPickDesignTool, pickDesignTool } from './pick-design';
import { refreshBrowserTool } from './refresh-browser';
import { studioToolDefinitions } from './registry';
import { createTakeScreenshotTool, takeScreenshotTool } from './take-screenshot';
import { wpcomRequestTool } from './wpcom-request';
import type {
	AnyStudioAgentTool,
	StudioToolDefinition,
	StudioToolResultDetails,
} from './define-tool';
import type { DesignTracksContext } from '@studio/agent/node/design-tracks';
import type { StudioAgentHost, StudioAgentUi } from '@studio/agent/node/host';
import type { StudioToolProgressUpdate } from '@studio/agent/protocol/tool-progress';

// The registry, frozen as a process runs it (`registry.ts`).
export { studioToolDefinitions };

export interface StudioToolsOptions {
	// Enable generate_images. Callers resolve isImageGenerationAvailable()
	// (async) and pass it; when off, sessions behave exactly as before the tool
	// existed (no tool, no imagery prompt sections).
	imageGeneration?: boolean;
	// False for models that cannot view images. Defaults to true.
	visionEnabled?: boolean;
	// With `visionEnabled` false, a connection that doesn't take images in tool
	// results yet, for a model that views attached ones: the tools say so instead.
	toolImagesUnavailable?: boolean;
	// False leaves out wpcom_request, for hosts that don't accept a tool reaching any
	// WordPress.com endpoint. Defaults to true.
	wpcomRequest?: boolean;
	// Lets pick_design offer options to pick from. Defaults to false.
	canAskUser?: boolean;
	// The chat session the design tools record Tracks events for; absent for the MCP server.
	tracks?: DesignTracksContext;
	// How a local image is linked in the agent's reply so the host shows it to the user.
	// Set by hosts without Studio's chat UI, which shows images as chat artifacts instead.
	imageLink?: ( file: string ) => string;
}

// The Studio tools a host can run, as definitions: the registry less the tools
// the host's capabilities leave out, with the factory-built variants those
// capabilities call for. Every runtime builds its tools from this list, and
// finds a tool in it by name, so a registry with two tools of one name is
// refused. Of the host, only what it provides counts here.
export function resolveStudioToolDefinitions(
	host: Pick< StudioAgentHost, 'ui' >,
	options: StudioToolsOptions = {}
): StudioToolDefinition[] {
	const names = new Set< string >();
	for ( const { name } of studioToolDefinitions ) {
		if ( names.has( name ) ) {
			throw new Error( `The Studio tool registry has two tools named ${ name }.` );
		}
		names.add( name );
	}
	return studioToolDefinitions.flatMap( ( candidate ) => {
		if ( candidate.name === generateImagesTool.name && ! options.imageGeneration ) {
			return [];
		}
		if ( candidate.name === wpcomRequestTool.name && options.wpcomRequest === false ) {
			return [];
		}
		// Only a Studio UI shows the preview it reloads.
		if ( candidate.name === refreshBrowserTool.name && ! host.ui ) {
			return [];
		}
		let tool = candidate;
		if ( candidate.name === takeScreenshotTool.name ) {
			tool = createTakeScreenshotTool( {
				visionEnabled: options.visionEnabled !== false,
				toolImagesUnavailable: options.toolImagesUnavailable,
				imageLink: options.imageLink,
				userSeesCapture: Boolean( host.ui ) || Boolean( options.imageLink ),
			} );
		}
		if ( candidate.name === inspectDesignTool.name && options.visionEnabled === false ) {
			tool = createInspectDesignTool( { visionEnabled: false } );
		}
		if ( candidate.name === pickDesignTool.name && ( options.canAskUser || options.tracks ) ) {
			tool = createPickDesignTool( {
				canAskUser: options.canAskUser === true,
				tracks: options.tracks,
			} );
		}
		return [ tool ];
	} );
}

// The Studio tools, bound to `host`, in the Pi route's form. Visual results show
// in the conversation only when the host has a UI; otherwise they would leak
// into terminal transcripts.
export function resolveStudioTools(
	host: StudioAgentHost,
	options: StudioToolsOptions = {}
): AnyStudioAgentTool[] {
	return resolveStudioToolDefinitions( host, options ).map( ( tool ) =>
		toPiTool( bindTool( tool, host ), host.ui )
	);
}

/**
 * A bound Studio tool in the Pi route's form, run through the shared execution
 * semantics (`execution.ts`). Pi validates a call against the tool's schema,
 * coercing what models commonly send, before it calls `execute`, so the call is
 * not validated again here. Progress is a tool update carrying only its message,
 * a failure is thrown for pi to report by its message, and what the result
 * leaves for Studio (artifacts, pending work, the service it used) goes in
 * `details`, which the model never sees.
 */
export function toPiTool< TTool extends AnyStudioAgentTool >(
	tool: TTool,
	ui: StudioAgentUi | undefined
): TTool {
	return {
		...tool,
		execute: async ( _toolCallId, params, _signal, onUpdate ) => {
			const run = await runStudioTool( tool, params, {
				validate: false,
				ui,
				onProgress: ( message, update ) => {
					const details: StudioToolProgressUpdate = { studioProgress: { message, update } };
					onUpdate?.( { content: [], details } );
				},
			} );
			if ( run.status === 'failed' ) {
				throw run.error;
			}
			if ( run.status !== 'completed' ) {
				throw new Error( `Not run: ${ tool.name }` );
			}
			const { content, studioArtifacts, pending, studioService } = run.result;
			const details: StudioToolResultDetails | undefined =
				studioArtifacts?.length || pending || studioService
					? { studioArtifacts, pending, ...( studioService ? { studioService } : {} ) }
					: undefined;
			return { content, details };
		},
	};
}
