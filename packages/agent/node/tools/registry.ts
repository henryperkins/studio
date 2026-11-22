import { createPreviewTool } from './create-preview';
import { createSiteTool } from './create-site';
import { deletePreviewTool } from './delete-preview';
import { deleteSiteTool } from './delete-site';
import { exportSiteTool } from './export-site';
import { generateImagesTool } from './generate-images';
import { importSiteTool } from './import-site';
import { inspectDesignTool } from './inspect-design';
import { installTaxonomyScriptsTool } from './install-taxonomy-scripts';
import { listConnectedRemoteSitesTool } from './list-connected-remote-sites';
import { listPreviewsTool } from './list-previews';
import { listSitesTool } from './list-sites';
import { auditPerformanceTool } from './need-for-speed';
import { openAnnotationBrowserTool } from './open-annotation-browser';
import { pickDesignTool } from './pick-design';
import { pullSiteTool } from './pull-site';
import { pushSiteTool } from './push-site';
import { auditSeoTool } from './rank-me-up';
import { refreshBrowserTool } from './refresh-browser';
import { scaffoldThemeTool } from './scaffold-theme';
import { sendFeedbackTool } from './send-feedback';
import { getSiteInfoTool } from './site-info';
import { startSiteTool } from './start-site';
import { stopSiteTool } from './stop-site';
import { takeScreenshotTool } from './take-screenshot';
import { updatePreviewTool } from './update-preview';
import { validateBlocksTool } from './validate-blocks';
import { runWpCliTool } from './wp-cli';
import { wpcomRequestTool } from './wpcom-request';
import type { StudioToolDefinition } from './define-tool';

/**
 * The registry as a process runs it. Every runtime builds its tools from it,
 * and the Claude route trusts its entries by identity, so it is frozen:
 * nothing can add, replace or remove a tool once the process runs, whatever
 * its environment says. A test that needs a tool of its own mocks this module
 * with an extendable copy, which only the test runner can do.
 */
export const studioToolDefinitions: StudioToolDefinition[] = Object.freeze( [
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
] ) as StudioToolDefinition[];
