import { randomUUID } from 'crypto';
import { readSite } from '@studio/common/sites/site-path';
import {
	parseClaudeSessionSelection,
	resolveClaudeSession,
} from '@studio/agent/protocol/claude-code';
import { createHydratedAiSession, reconcileSessionEnvironment } from '../sessions/manage';
import { appendStudioEntry, loadAiSession } from '../sessions/store';
import {
	disconnectClaudeConnection,
	getClaudeConnections,
	inspectClaudeConnection,
	openClaudeNativeSignIn,
	saveClaudeConnection,
} from './connection';
import { inspectClaudeExecutable } from './discovery';
import type { ClaudeBackendTurnSnapshot } from '@studio/agent/protocol/backend-events';
import type {
	ClaudeModelCatalog,
	ClaudeRuntimeAction,
	ClaudeRuntimeState,
	ClaudeSessionSelection,
	CreateClaudeSessionRequest,
} from '@studio/agent/protocol/claude-code';

export { getClaudeSessionStoreRoot } from './sessions';

function isClaudeRuntimeEnabled(): boolean {
	return (
		process.platform === 'win32' &&
		process.arch === 'x64' &&
		process.env.STUDIO_EXPERIMENTAL_CLAUDE_CODE === '1'
	);
}

function requireClaudeRuntime() {
	if ( ! isClaudeRuntimeEnabled() ) throw new Error( 'The Claude Code experiment is disabled.' );
}

export async function getClaudeRuntimeState(): Promise< ClaudeRuntimeState > {
	if ( ! isClaudeRuntimeEnabled() ) return { enabled: false, connections: [] };
	const connections = await getClaudeConnections();
	return {
		enabled: true,
		connections: await Promise.all(
			connections.map( async ( connection ) => {
				const status = await inspectClaudeConnection(
					connection.executablePath,
					connection.configDirectory
				);
				const executable =
					status.executable ?? ( await inspectClaudeExecutable( connection.executablePath ) );
				const blockers = executable.ok
					? status.blockers
					: [ ...new Set( [ executable.reason, ...status.blockers ] ) ];
				return {
					...connection,
					version: executable.ok ? executable.version : undefined,
					authMethod: status.auth?.method,
					blockers,
					findings: status.findings ?? [],
				};
			} )
		),
	};
}

export async function configureClaudeRuntime( action: ClaudeRuntimeAction ): Promise< void > {
	requireClaudeRuntime();
	if (
		action?.type === 'save' &&
		typeof action.executablePath === 'string' &&
		( action.configDirectory === undefined || typeof action.configDirectory === 'string' )
	) {
		await saveClaudeConnection( {
			id: randomUUID(),
			executablePath: action.executablePath.trim(),
			configDirectory: action.configDirectory?.trim() || undefined,
		} );
		return;
	}
	if (
		( action?.type === 'sign-in' || action?.type === 'disconnect' ) &&
		typeof action.connectionId === 'string'
	) {
		if ( action.type === 'sign-in' ) await openClaudeNativeSignIn( action.connectionId );
		else await disconnectClaudeConnection( action.connectionId );
		return;
	}
	throw new Error( 'Invalid Claude Code connection action.' );
}

export async function getClaudeModelCatalog(
	connectionId: string,
	siteId: string
): Promise< ClaudeModelCatalog > {
	if ( ! isClaudeRuntimeEnabled() )
		return { ok: false, blockers: [ 'experimental-feature-disabled' ] };
	const site = await readSite( siteId );
	if ( ! site ) return { ok: false, blockers: [ 'local-site-not-found' ] };
	const { discoverClaudeModels } = await import( './runtime' );
	const result = await discoverClaudeModels( connectionId, site.path );
	return result.ok ? { ok: true, models: result.models } : result;
}

function requireSupportedSelection(
	catalog: ClaudeModelCatalog,
	selection: ClaudeSessionSelection
): asserts catalog is Extract< ClaudeModelCatalog, { ok: true } > {
	if ( ! catalog.ok )
		throw new Error( `Claude Code is unavailable (${ catalog.blockers.join( ', ' ) }).` );
	if (
		! catalog.models.some(
			( item ) => item.id === selection.model && item.efforts.includes( selection.effort )
		)
	) {
		throw new Error( 'Claude Code did not report support for this model and effort.' );
	}
}

export async function createClaudeSession( root: string, request: CreateClaudeSessionRequest ) {
	requireClaudeRuntime();
	if ( typeof request?.siteId !== 'string' || typeof request.connectionId !== 'string' ) {
		throw new Error( 'Select a Claude Code connection and a local site.' );
	}
	const selection = parseClaudeSessionSelection( request.selection );
	const site = await readSite( request.siteId );
	if ( ! site ) throw new Error( 'This local site is unavailable.' );
	const { discoverClaudeModels } = await import( './runtime' );
	const catalog = await discoverClaudeModels( request.connectionId, site.path );
	requireSupportedSelection( catalog, selection );
	return createHydratedAiSession( root, {
		site,
		claude: {
			binding: {
				connectionId: request.connectionId,
				siteId: site.id,
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
	const catalog = await getClaudeModelCatalog(
		context.binding.connectionId,
		context.binding.siteId
	);
	requireSupportedSelection( catalog, selection );
	await appendStudioEntry( root, summary.id, 'studio.claude_selection', selection );
}

export async function validateClaudeSendSelection(
	root: string,
	sessionId: string,
	rawSelection: unknown
) {
	const session = await loadAiSession( root, sessionId );
	const context = resolveClaudeSession( session.entries );
	if ( ! context ) {
		if ( session.summary.backend === 'claude-code' )
			throw new Error( 'The Claude Code workspace binding is missing.' );
		if ( rawSelection !== undefined ) throw new Error( 'This chat does not use Claude Code.' );
		if ( session.summary.activeEnvironment === 'live' )
			await reconcileSessionEnvironment( root, sessionId );
		return;
	}
	requireClaudeRuntime();
	const selected = parseClaudeSessionSelection( rawSelection );
	if (
		selected.model !== context.selection.model ||
		selected.effort !== context.selection.effort
	) {
		throw new Error( 'Claude Code settings changed. Reload this chat and send again.' );
	}
	return selected;
}

export async function verifyClaudeTurnSession(
	root: string,
	snapshot: ClaudeBackendTurnSnapshot
): Promise< boolean > {
	if ( ! isClaudeRuntimeEnabled() ) return false;
	const { workspace, selection, effort } = snapshot;
	try {
		const { entries, summary } = await loadAiSession( root, workspace.conversationId );
		const session = resolveClaudeSession( entries );
		return (
			!! session &&
			summary.id === workspace.conversationId &&
			session.binding.connectionId === selection.connectionId &&
			session.binding.siteId === workspace.siteId &&
			session.binding.workingDirectory === workspace.workingDirectory &&
			session.binding.configDirectory === workspace.configDirectory &&
			session.selection.model === selection.model.modelId &&
			session.selection.effort === effort
		);
	} catch {
		return false;
	}
}
