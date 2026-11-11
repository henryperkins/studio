import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import { getConnectedWpcomSitesForLocalSite } from '@studio/common/lib/connected-sites';
import { getSessionsDirectory } from '@studio/common/lib/well-known-paths';
import { readSite } from '@studio/common/sites/site-path';
import {
	isSameClaudeTarget,
	parseClaudeSessionSelection,
	resolveClaudeSession,
} from '@studio/agent/protocol/claude-code';
import { createHydratedAiSession, reconcileSessionEnvironment } from '../sessions/manage';
import { appendStudioEntry, loadAiSession } from '../sessions/store';
import {
	claudeConnectionRevision,
	disconnectClaudeConnection,
	getClaudeConnections,
	inspectClaudeConnection,
	openClaudeNativeSignIn,
	saveClaudeConnection,
} from './connection';
import { inspectClaudeExecutable } from './discovery';
import { currentClaudeHost, isClaudeRuntimeSurfaceEnabled } from './platform';
import { getClaudeGlobalWorkspace, getClaudeSessionStoreRoot } from './sessions';
import type { ClaudeSignInActionReason } from './platform';
import type { ClaudeBackendTurnSnapshot } from '@studio/agent/protocol/backend-events';
import type {
	ClaudeModelCatalog,
	ClaudeRuntimeAction,
	ClaudeRuntimeState,
	ClaudeSessionSelection,
	ClaudeStudioTarget,
	CreateClaudeSessionRequest,
} from '@studio/agent/protocol/claude-code';

export { getClaudeSessionStoreRoot } from './sessions';

function isClaudeRuntimeEnabled(): boolean {
	return isClaudeRuntimeSurfaceEnabled( currentClaudeHost(), process.env );
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
		if ( action.type === 'disconnect' ) {
			await disconnectClaudeConnection( action.connectionId );
			return;
		}
		const result = await openClaudeNativeSignIn( action.connectionId );
		if ( result.state === 'user-action-needed' )
			throw new ClaudeSignInActionRequiredError( result.reason );
		return;
	}
	throw new Error( 'Invalid Claude Code connection action.' );
}

/** Sign-in could not open a terminal here; `reason` says what the user has to provide or do. */
export class ClaudeSignInActionRequiredError extends Error {
	constructor( readonly reason: ClaudeSignInActionReason ) {
		super( `claude-sign-in-action-required:${ reason }` );
		this.name = 'ClaudeSignInActionRequiredError';
	}
}

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
	siteId?: string | null
): Promise< ClaudeModelCatalog > {
	return getModelCatalog( connectionId, siteId, getSessionsDirectory() );
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
	const { target } = context;
	if (
		target.environment === 'live' &&
		! ( await getConnectedWpcomSitesForLocalSite( target.siteId ) ).some(
			( site ) => site.id === target.wpcomSiteId
		)
	) {
		throw new Error(
			'The live site this chat works on is no longer connected. Switch the chat to Local and send again.'
		);
	}
	return selected;
}

// The conversation as it is now, if it still has the turn's native binding.
async function loadBoundSession( root: string, snapshot: ClaudeBackendTurnSnapshot ) {
	if ( ! isClaudeRuntimeEnabled() ) return;
	const { workspace, selection } = snapshot;
	try {
		const { entries, summary } = await loadAiSession( root, workspace.conversationId );
		const session = resolveClaudeSession( entries );
		if (
			session &&
			summary.id === workspace.conversationId &&
			session.binding.connectionId === selection.connectionId &&
			session.binding.siteId === workspace.siteId &&
			session.binding.workingDirectory === workspace.workingDirectory &&
			session.binding.configDirectory === workspace.configDirectory
		)
			return session;
	} catch {
		// An unreadable conversation cannot confirm anything.
	}
}

/**
 * The connection revision a turn is sent with. A connection that no longer
 * exists has none, and a turn sent with 0 never starts.
 */
export async function getClaudeTurnConnectionRevision( connectionId: string ): Promise< number > {
	const connection = ( await getClaudeConnections() ).find( ( item ) => item.id === connectionId );
	return connection ? claudeConnectionRevision( connection ) : 0;
}

/** Whether a turn can start: the conversation still has its binding, selection and target. */
export async function verifyClaudeTurnSession(
	root: string,
	snapshot: ClaudeBackendTurnSnapshot
): Promise< boolean > {
	const session = await loadBoundSession( root, snapshot );
	return (
		!! session &&
		session.selection.model === snapshot.selection.model.modelId &&
		session.selection.effort === snapshot.effort &&
		isSameClaudeTarget( session.target, snapshot.target )
	);
}

/**
 * Whether a running turn may still execute: the conversation keeps its binding
 * and has the expected target. A model or effort change waits for the next turn
 * and does not stop this one; a target change does.
 */
export async function verifyClaudeTurnTarget(
	root: string,
	snapshot: ClaudeBackendTurnSnapshot,
	expected: ClaudeStudioTarget
): Promise< boolean > {
	const session = await loadBoundSession( root, snapshot );
	return !! session && isSameClaudeTarget( session.target, expected );
}
