import { getConnectedWpcomSitesForLocalSite } from '@studio/common/lib/connected-sites';
import { arePathsEqual } from '@studio/common/lib/fs-utils';
import {
	deleteSharedSession,
	readSharedSession,
	readSharedSessions,
	updateSharedSession,
} from '@studio/common/lib/shared-config';
import { readSites } from '@studio/common/sites/site-path';
import { __ } from '@wordpress/i18n';
import {
	deleteAiSessionPlacement,
	hydrateAiSessionSummaryWithPlacement,
	readAiSessionPlacement,
	readAiSessionPlacements,
	setAiSessionSitePlacement,
	type AiSessionSitePlacement,
} from '@studio/agent/node/sessions/placement';
import {
	appendStudioEntry,
	createAiSession,
	deleteAiSession,
	listAiSessions,
	loadAiSession,
} from '@studio/agent/node/sessions/store';
import {
	resolveClaudeSession,
	isClaudeTargetAllowed,
	isSameClaudeTarget,
	type ClaudeStudioTarget,
} from '@studio/agent/protocol/claude-code';
import {
	deriveEffectiveEnvironment,
	pickLiveSite,
} from '@studio/agent/protocol/sessions/effective-site';
import { findAiSessionOwnerSite } from '@studio/agent/protocol/sessions/owner-site';
import {
	createNativeSessionStore,
	getClaudePromptLabel,
	getClaudeSessionStoreRoot,
} from '../claude-code/sessions';
import type { CreateAiSessionOptions } from '@studio/agent/node/sessions/store';
import type {
	AiSessionMetadata,
	AiSessionSummary,
	LoadedAiSession,
} from '@studio/agent/protocol/sessions/types';

/**
 * Session listing + creation, hydrated with the metadata that lives outside the
 * session JSONL: the archived, title and unread fields (shared config) and site
 * placement (app.json).
 */

// A local site a session can be bound to.
export interface SessionSite {
	id: string;
	name: string;
	path: string;
}

export function hydrateAiSessionSummary(
	summary: AiSessionSummary,
	metadata?: AiSessionMetadata,
	placement?: AiSessionSitePlacement
): AiSessionSummary {
	return hydrateAiSessionSummaryWithPlacement(
		{
			...summary,
			archived: metadata?.archived,
			title: metadata?.title,
			unread: metadata?.unread,
		},
		placement
	);
}

// Archives, renames, or marks a session read/unread, keeping only the known
// fields so a host can pass a request body straight through.
export async function updateHydratedAiSessionMetadata(
	rootDirectory: string,
	sessionIdOrPrefix: string,
	{ archived, title, unread }: AiSessionMetadata
): Promise< AiSessionSummary > {
	const { summary } = await loadAiSession( rootDirectory, sessionIdOrPrefix );
	const patch = Object.fromEntries(
		Object.entries( { archived, title, unread } ).filter( ( [ , value ] ) => value !== undefined )
	);
	const [ metadata, placement ] = await Promise.all( [
		updateSharedSession( summary.id, patch ),
		readAiSessionPlacement( summary.id ),
	] );
	return hydrateAiSessionSummary( summary, metadata, placement );
}

export async function listHydratedAiSessions(
	rootDirectory: string
): Promise< AiSessionSummary[] > {
	const [ sessions, metadata, placements ] = await Promise.all( [
		listAiSessions( rootDirectory ),
		readSharedSessions(),
		readAiSessionPlacements(),
	] );
	const store = createNativeSessionStore( getClaudeSessionStoreRoot( rootDirectory ) );
	const listed = await Promise.all(
		sessions.map( async ( session ) => {
			const summary = hydrateAiSessionSummary(
				session,
				metadata[ session.id ],
				placements[ session.id ]
			);
			if ( summary.backend !== 'claude-code' ) return summary;
			try {
				const activity = await store.readChatActivity( summary.id );
				if ( activity.firstPrompt ) summary.firstPrompt = activity.firstPrompt;
				if ( activity.updatedAt && activity.updatedAt > summary.updatedAt )
					summary.updatedAt = activity.updatedAt;
			} catch {
				// Keep unreadable chats accessible so they can be recovered.
			}
			return summary;
		} )
	);
	return listed.sort( ( a, b ) => Date.parse( b.updatedAt ) - Date.parse( a.updatedAt ) );
}

export async function loadHydratedAiSession(
	rootDirectory: string,
	sessionIdOrPrefix: string
): Promise< LoadedAiSession > {
	const session = await loadAiSession( rootDirectory, sessionIdOrPrefix );
	const [ metadata, placement ] = await Promise.all( [
		readSharedSession( session.summary.id ),
		readAiSessionPlacement( session.summary.id ),
	] );
	const hydrated: LoadedAiSession = {
		...session,
		summary: hydrateAiSessionSummary( session.summary, metadata, placement ),
	};
	if ( session.summary.backend === 'claude-code' ) {
		const store = createNativeSessionStore( getClaudeSessionStoreRoot( rootDirectory ) );
		try {
			hydrated.claudeJournal = await store.readJournals( session.summary.id );
			for ( const turn of hydrated.claudeJournal ) {
				const prompt = turn.find( ( event ) => event.type === 'turn.prompt' );
				if ( prompt?.type === 'turn.prompt' ) {
					hydrated.summary.firstPrompt = getClaudePromptLabel( prompt );
					if ( hydrated.summary.firstPrompt ) break;
				}
			}
			if ( await store.isPendingDeletion( session.summary.id ) )
				hydrated.claudeRecovery = 'deletion-pending';
			else if ( await store.isTurnLocked( session.summary.id ) )
				hydrated.claudeRecovery = 'run-locked';
		} catch {
			hydrated.claudeRecovery = 'journal-unreadable';
		}
	}
	return hydrated;
}

// Match by id OR path: placements may hold either a stale path (site moved) or
// a stale id, and sidebar grouping is transitioning from path- to id-keyed —
// matching both ensures no session is left orphaned by a site deletion.
export async function deleteAiSessionsForSite(
	rootDirectory: string,
	site: Pick< SessionSite, 'id' | 'path' >
): Promise< string[] > {
	const placements = await readAiSessionPlacements();
	const sessionIds = Object.entries( placements )
		.filter(
			( [ , placement ] ) =>
				placement.siteId === site.id || arePathsEqual( placement.sitePath, site.path )
		)
		.map( ( [ sessionId ] ) => sessionId );

	for ( const sessionId of sessionIds ) {
		try {
			await deleteAiSession( rootDirectory, sessionId );
		} catch {
			// A placement can outlive its session file; still drop the metadata.
		}
		try {
			await deleteSharedSession( sessionId );
			await deleteAiSessionPlacement( sessionId );
		} catch {
			// Per-session best effort: one failed config write shouldn't
			// abandon cleanup of the remaining sessions.
		}
	}
	return sessionIds;
}

/**
 * Create a session. When a `site` is given, the session is bound to it
 * (recorded in the session file) and its placement is persisted so the UI shows
 * it under that site.
 */
export async function createHydratedAiSession(
	rootDirectory: string,
	options: { site?: SessionSite; claude?: CreateAiSessionOptions[ 'claude' ] } = {}
): Promise< AiSessionSummary > {
	const { site } = options;
	if ( ! site ) {
		return hydrateAiSessionSummary(
			await createAiSession( rootDirectory, options.claude ? { claude: options.claude } : {} )
		);
	}

	const created = await createAiSession( rootDirectory, {
		site: { id: site.id, name: site.name, path: site.path },
		claude: options.claude,
	} );
	const placement = await setAiSessionSitePlacement( created.id, {
		siteId: site.id,
		siteName: site.name,
		sitePath: site.path,
	} );
	return hydrateAiSessionSummary( created, undefined, placement );
}

/**
 * A session left on 'live' after its remote site was disconnected falls back to
 * its local owner site. The UI already derives that at render time; this records
 * it in the session so the CLI's next turn (prompt and tools) agrees.
 */
export async function reconcileSessionEnvironment(
	root: string,
	sessionId: string
): Promise< void > {
	const { summary } = await loadHydratedAiSession( root, sessionId );
	if ( summary.activeEnvironment !== 'live' ) {
		return;
	}
	const ownerSite = findAiSessionOwnerSite( await readSites(), summary );
	if ( ! ownerSite ) {
		return;
	}
	const connectedIds = new Set(
		( await getConnectedWpcomSitesForLocalSite( ownerSite.id ) ).map( ( site ) => site.id )
	);
	if (
		deriveEffectiveEnvironment( summary, ( blogId ) => connectedIds.has( blogId ) ) === 'live'
	) {
		return;
	}
	await appendStudioEntry( root, sessionId, 'studio.site_selected', {
		siteName: ownerSite.name,
		sitePath: ownerSite.path,
		siteId: ownerSite.id,
	} );
}

/**
 * Points the chat's next turn at its owner site, locally or on its connected
 * WordPress.com site. Recorded as the same `studio.site_selected` entry the
 * agent writes, so the CLI resumes on it. A Claude chat keeps its native
 * workspace and history: one started on a site can only switch between that site
 * and its live site.
 */
export async function setSessionEnvironment(
	root: string,
	sessionId: string,
	environment: 'local' | 'live'
): Promise< void > {
	const { summary, entries } = await loadHydratedAiSession( root, sessionId );
	const claude = resolveClaudeSession( entries );
	if ( summary.backend === 'claude-code' && ! claude )
		throw new Error( 'The Claude Code workspace binding is missing.' );
	const ownerSite = findAiSessionOwnerSite( await readSites(), summary );
	if ( ! ownerSite ) {
		throw new Error( 'This chat is not attached to a site.' );
	}
	if ( claude && claude.binding.siteId !== null && claude.binding.siteId !== ownerSite.id ) {
		throw new Error(
			'This Claude chat works in the folder of the site it started on. Start a new chat to work on another site.'
		);
	}
	const remote =
		environment === 'live'
			? pickLiveSite( await getConnectedWpcomSitesForLocalSite( ownerSite.id ) )
			: undefined;
	if ( environment === 'live' && ! remote )
		throw new Error( 'This site is not connected to a WordPress.com site.' );
	if ( claude ) {
		const target: ClaudeStudioTarget = remote
			? { environment: 'live', siteId: ownerSite.id, wpcomSiteId: remote.id }
			: { environment: 'local', siteId: ownerSite.id };
		await setClaudeSessionTarget( root, summary.id, claude.target, target );
		return;
	}
	await recordSiteTarget( root, sessionId, ownerSite, remote );
}

async function recordSiteTarget(
	root: string,
	sessionId: string,
	site: SessionSite,
	remote?: { id: number; url: string } | null
) {
	await appendStudioEntry( root, sessionId, 'studio.site_selected', {
		siteName: site.name,
		sitePath: site.path,
		siteId: site.id,
		...( remote && { remote: true, url: remote.url, wpcomSiteId: remote.id } ),
	} );
}

/** Serializes a user target change with other changes, runs, and deletion. */
export async function setClaudeSessionTarget(
	root: string,
	id: string,
	expected: ClaudeStudioTarget,
	target: ClaudeStudioTarget
) {
	const previous = await loadAiSession( root, id );
	if ( previous.summary.id !== id || previous.summary.backend !== 'claude-code' )
		throw new Error( __( 'Choose a Claude chat to change its target.' ) );
	const store = createNativeSessionStore( getClaudeSessionStoreRoot( root ) );
	const release = await store.lockTurn( id, 'target' ).catch( ( error: NodeJS.ErrnoException ) => {
		if ( error.code === 'EEXIST' )
			throw new Error(
				__( 'Wait for the current operation to finish before changing the target.' )
			);
		throw error;
	} );
	try {
		const { entries } = await loadAiSession( root, id );
		const context = resolveClaudeSession( entries );
		if (
			! context ||
			! expected ||
			! isClaudeTargetAllowed( context.binding.siteId, expected ) ||
			! isSameClaudeTarget( context.target, expected ) ||
			( await store.isPendingDeletion( id ) )
		)
			throw new Error(
				__( 'The site for this chat changed. Review the current target and try again.' )
			);
		if ( ! isClaudeTargetAllowed( context.binding.siteId, target ) )
			throw new Error( __( 'Choose a target within this chat’s workspace.' ) );
		if ( target.environment === 'global' ) {
			await appendStudioEntry( root, id, 'studio.claude_target_cleared', {} );
			return;
		}
		const site = ( await readSites() ).find( ( item ) => item.id === target.siteId );
		if ( ! site ) throw new Error( __( 'This local site is unavailable.' ) );
		const remote =
			target.environment === 'live'
				? ( await getConnectedWpcomSitesForLocalSite( site.id ) ).find(
						( item ) => item.id === target.wpcomSiteId
				  )
				: undefined;
		if ( target.environment === 'live' && ! remote )
			throw new Error( __( 'This live site is no longer connected.' ) );
		await recordSiteTarget( root, id, site, remote );
	} finally {
		await release();
	}
}
