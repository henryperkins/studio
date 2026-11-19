import { mkdir } from 'node:fs/promises';
import { getSessionsDirectory } from '@studio/common/lib/well-known-paths';
import { readSite } from '@studio/common/sites/site-path';
import {
	parseClaudeSessionSelection,
	resolveClaudeSession,
} from '@studio/agent/protocol/claude-code';
import { createHydratedAiSession } from '../sessions/manage';
import { appendStudioEntry, loadAiSession } from '../sessions/store';
import { recoverClaudeRun } from './recovery';
import {
	createNativeSessionStore,
	getClaudeGlobalWorkspace,
	getClaudeSessionStoreRoot,
} from './sessions';
import {
	isClaudeRuntimeEnabled,
	requireClaudeRuntime,
	requireSupportedSelection,
	validateClaudeSendWithCatalog,
} from './studio-host';
import type {
	ClaudeModelCatalog,
	ClaudeRecoveryResult,
	ClaudeSendContext,
	CreateClaudeSessionRequest,
} from '@studio/agent/protocol/claude-code';

export {
	configureClaudeRuntime,
	discardClaudeChatFile,
	getClaudeRuntimeState,
	getClaudeSessionStoreRoot,
	getClaudeTurnConnectionRevision,
	setClaudeSessionTarget,
	stageClaudeChatFile,
	startWithClaudeChatFiles,
	verifyClaudeTurnSession,
	verifyClaudeTurnTarget,
	ClaudeSignInActionRequiredError,
	ClaudeSignInRefusedError,
} from './studio-host';

// The dedicated workspace all global conversations run in, created on first use.
async function ensureGlobalWorkspace( sessionsRoot: string ): Promise< string > {
	const workspace = getClaudeGlobalWorkspace( getClaudeSessionStoreRoot( sessionsRoot ) );
	await mkdir( workspace, { recursive: true, mode: 0o700 } );
	return workspace;
}

async function getModelCatalog(
	connectionId: string,
	siteId: string | null | undefined,
	sessionsRoot: string
): Promise< ClaudeModelCatalog > {
	if ( ! isClaudeRuntimeEnabled() )
		return { ok: false, blockers: [ 'experimental-feature-disabled' ] };
	let workspace: string;
	if ( siteId === null || siteId === undefined ) {
		workspace = await ensureGlobalWorkspace( sessionsRoot );
	} else {
		const site = await readSite( siteId );
		if ( ! site ) return { ok: false, blockers: [ 'local-site-not-found' ] };
		workspace = site.path;
	}
	const { discoverClaudeModels } = await import( './runtime' );
	const result = await discoverClaudeModels( connectionId, workspace );
	return result.ok ? { ok: true, models: result.models } : result;
}

/** Models a connection offers in a site's workspace, or the global one without a site. */
export function getClaudeModelCatalog(
	connectionId: string,
	siteId?: string | null,
	root = getSessionsDirectory()
): Promise< ClaudeModelCatalog > {
	return getModelCatalog( connectionId, siteId, root );
}

/**
 * Creates a Claude conversation on a local site, working in that site's folder,
 * or without a site as a global conversation in the dedicated global workspace.
 */
export async function createClaudeSession( root: string, request: CreateClaudeSessionRequest ) {
	requireClaudeRuntime();
	const siteId: unknown = request?.siteId;
	if (
		typeof request?.connectionId !== 'string' ||
		( siteId !== undefined && siteId !== null && typeof siteId !== 'string' )
	) {
		throw new Error( 'Select a Claude Code connection.' );
	}
	const selection = parseClaudeSessionSelection( request.selection );
	let site: Awaited< ReturnType< typeof readSite > > | undefined;
	let workspace: string;
	if ( typeof siteId === 'string' ) {
		site = await readSite( siteId );
		if ( ! site ) throw new Error( 'This local site is unavailable.' );
		workspace = site.path;
	} else {
		workspace = await ensureGlobalWorkspace( root );
	}
	const { discoverClaudeModels } = await import( './runtime' );
	const catalog = await discoverClaudeModels( request.connectionId, workspace );
	requireSupportedSelection( catalog, selection );
	return createHydratedAiSession( root, {
		site: site ?? undefined,
		claude: {
			binding: {
				connectionId: request.connectionId,
				siteId: site?.id ?? null,
				workingDirectory: catalog.workingDirectory,
				configDirectory: catalog.configDirectory,
			},
			selection,
		},
	} );
}

export async function setClaudeSessionSelection(
	root: string,
	sessionId: string,
	rawSelection: unknown
): Promise< void > {
	requireClaudeRuntime();
	const selection = parseClaudeSessionSelection( rawSelection );
	const { summary, entries } = await loadAiSession( root, sessionId );
	const context = resolveClaudeSession( entries );
	if ( ! context ) throw new Error( 'This chat does not use Claude Code.' );
	const catalog = await getModelCatalog(
		context.binding.connectionId,
		context.binding.siteId,
		root
	);
	requireSupportedSelection( catalog, selection );
	await appendStudioEntry( root, summary.id, 'studio.claude_selection', selection );
}

export function validateClaudeSendSelection(
	root: string,
	sessionId: string,
	rawSelection: unknown,
	expected?: ClaudeSendContext,
	requiresImageInput = false
) {
	return validateClaudeSendWithCatalog(
		root,
		sessionId,
		rawSelection,
		expected,
		requiresImageInput ? getModelCatalog : undefined
	);
}

/**
 * Recovers a Claude chat whose run lock outlived the run that took it, so the
 * same native conversation can continue with its next turn. Nothing is
 * replayed. When ownership or the native binding cannot be proven, nothing
 * changes and the result says why.
 */
export async function recoverClaudeSession(
	sessionId: string,
	root = getSessionsDirectory()
): Promise< ClaudeRecoveryResult > {
	if ( ! isClaudeRuntimeEnabled() ) return { status: 'blocked', reason: 'runtime-disabled' };
	let binding;
	try {
		const { summary, entries } = await loadAiSession( root, sessionId );
		const context = resolveClaudeSession( entries );
		if ( context ) binding = { ...context.binding, conversationId: summary.id };
	} catch {
		// An unreadable chat or binding proves nothing.
	}
	if ( ! binding ) return { status: 'blocked', reason: 'not-claude-session' };
	return recoverClaudeRun( createNativeSessionStore( getClaudeSessionStoreRoot( root ) ), binding );
}
