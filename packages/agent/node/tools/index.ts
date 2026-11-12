import { createPreviewTool } from './create-preview';
import { createSiteTool } from './create-site';
import { bindTool } from './define-tool';
import { deletePreviewTool } from './delete-preview';
import { deleteSiteTool } from './delete-site';
import { runStudioTool } from './execution';
import { exportSiteTool } from './export-site';
import { generateImagesTool } from './generate-images';
import { importSiteTool } from './import-site';
import { createInspectDesignTool, inspectDesignTool } from './inspect-design';
import { installTaxonomyScriptsTool } from './install-taxonomy-scripts';
import { listConnectedRemoteSitesTool } from './list-connected-remote-sites';
import { listPreviewsTool } from './list-previews';
import { listSitesTool } from './list-sites';
import { auditPerformanceTool } from './need-for-speed';
import { openAnnotationBrowserTool } from './open-annotation-browser';
import { createPickDesignTool, pickDesignTool } from './pick-design';
import { pullSiteTool } from './pull-site';
import { pushSiteTool } from './push-site';
import { auditSeoTool } from './rank-me-up';
import { refreshBrowserTool } from './refresh-browser';
import { scaffoldThemeTool } from './scaffold-theme';
import { sendFeedbackTool } from './send-feedback';
import { getSiteInfoTool } from './site-info';
import { startSiteTool } from './start-site';
import { stopSiteTool } from './stop-site';
import { createTakeScreenshotTool, takeScreenshotTool } from './take-screenshot';
import { updatePreviewTool } from './update-preview';
import { validateBlocksTool } from './validate-blocks';
import { runWpCliTool } from './wp-cli';
import { wpcomRequestTool } from './wpcom-request';
import type {
	AnyStudioAgentTool,
	StudioToolDefinition,
	StudioToolResultDetails,
} from './define-tool';
import type { DesignTracksContext } from '@studio/agent/node/design-tracks';
import type { StudioAgentHost, StudioAgentUi } from '@studio/agent/node/host';
import type { StudioToolProgressUpdate } from '@studio/agent/protocol/tool-progress';

export const studioToolDefinitions: StudioToolDefinition[] = [
	createSiteTool,
	listSitesTool,
	getSiteInfoTool,
	startSiteTool,
	stopSiteTool,
	deleteSiteTool,
	createPreviewTool,
	listPreviewsTool,
	updatePreviewTool,
	deletePreviewTool,
	runWpCliTool,
	scaffoldThemeTool,
	pickDesignTool,
	validateBlocksTool,
	takeScreenshotTool,
	inspectDesignTool,
	generateImagesTool,
	installTaxonomyScriptsTool,
	auditPerformanceTool,
	auditSeoTool,
	listConnectedRemoteSitesTool,
	wpcomRequestTool,
	pushSiteTool,
	pullSiteTool,
	importSiteTool,
	exportSiteTool,
	openAnnotationBrowserTool,
	refreshBrowserTool,
	sendFeedbackTool,
];

export interface StudioToolsOptions {
	// Enable generate_images. Callers resolve isImageGenerationAvailable()
	// (async) and pass it; when off, sessions behave exactly as before the tool
	// existed (no tool, no imagery prompt sections).
	imageGeneration?: boolean;
	// False for models that cannot view images. Defaults to true.
	visionEnabled?: boolean;
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
// capabilities call for. Every runtime builds its tools from this list.
export function resolveStudioToolDefinitions(
	host: StudioAgentHost,
	options: StudioToolsOptions = {}
): StudioToolDefinition[] {
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
