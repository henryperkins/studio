import { LOCKFILE_STALE_TIME, LOCKFILE_WAIT_TIME } from '@studio/common/constants';
import { __ } from '@wordpress/i18n';
import { lockChatGptFile } from '@studio/agent/node/chatgpt/account-store';
import { ChatGptSettingsError } from '@studio/agent/node/chatgpt/settings';
import {
	appendModelChangeEntry,
	appendStudioEntry,
	loadAiSession,
	readPiFileEntries,
} from '@studio/agent/node/sessions/store';
import { canPinChatGptInPlace } from '@studio/agent/protocol/chatgpt';
import { isAiModelId } from '@studio/agent/protocol/models';
import {
	getEffectiveSessionProvider,
	isAiProviderId,
	providerServesModel,
	readSessionPin,
} from '@studio/agent/protocol/providers';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { StudioSessionContextData } from '@studio/agent/protocol/sessions/entry-types';

/**
 * Serializes connection checks and writes across the two application hosts.
 * Only a known message leaves it: a lock or file error names a path in the
 * user's home, so the hosts are told only that the choice wasn't saved. The
 * original stays the error's `cause` and goes to the host's log.
 */
export async function withSessionSelection< T >(
	sessionsRoot: string,
	sessionId: string,
	write: ( entries: SessionEntry[] ) => Promise< T >
): Promise< T > {
	try {
		const { summary } = await loadAiSession( sessionsRoot, sessionId );
		if ( summary.backend === 'claude-code' ) {
			throw new ChatGptSettingsError(
				__( 'Start a new chat to change the runtime or billing connection.' )
			);
		}
		// Retried while Windows refuses a lockfile another process is letting go.
		const release = await lockChatGptFile( `${ summary.filePath }.settings.lock`, {
			stale: LOCKFILE_STALE_TIME,
			wait: LOCKFILE_WAIT_TIME,
		} );
		try {
			return await write( await readPiFileEntries( summary.filePath ) );
		} finally {
			// A lock left behind goes stale; it never undoes a choice already saved.
			await release().catch( ( error: unknown ) =>
				logSelectionFailure( 'Failed to release the model selection lock of a chat:', error )
			);
		}
	} catch ( error ) {
		if ( error instanceof ChatGptSettingsError ) {
			throw error;
		}
		logSelectionFailure( 'Failed to save the model selection for a chat:', error );
		throw Object.assign(
			new ChatGptSettingsError( __( 'Studio couldn’t save the model for this chat. Try again.' ) ),
			{ cause: error }
		);
	}
}

// Desktop writes the console to its log file; the studio ui server's console is
// its terminal. A system error (a held lock, a file the system refused) or a chat
// that's gone is expected; anything else is a defect and is logged with its stack,
// Node's own argument and assertion errors among them, whose string code alone
// doesn't make them a system error.
function logSelectionFailure( context: string, error: unknown ): void {
	if (
		error instanceof Error &&
		( isSystemError( error ) || error.message.startsWith( 'Code session not found:' ) )
	) {
		console.warn( `[session-selection] ${ context }`, error.message );
		return;
	}
	console.error( `[session-selection] ${ context }`, error );
}

// As Node raises a call the system refused: with the errno and the system call.
function isSystemError( error: Error ): boolean {
	return (
		( 'errno' in error && typeof error.errno === 'number' ) ||
		( 'syscall' in error && typeof error.syscall === 'string' )
	);
}

function needsNewChat(): never {
	throw new ChatGptSettingsError(
		__( 'Start a new chat to change the ChatGPT account or billing connection.' )
	);
}

export function assertSessionSelection(
	entries: SessionEntry[],
	selection: StudioSessionContextData
): void {
	const current = getEffectiveSessionProvider( entries );
	if ( current === 'chatgpt-oauth' ) {
		const pin = readSessionPin( entries );
		if (
			selection.provider !== 'chatgpt-oauth' ||
			! pin?.connectionId ||
			pin.connectionId !== selection.connectionId ||
			pin.revision !== selection.revision
		) {
			needsNewChat();
		}
	} else if ( selection.provider === 'chatgpt-oauth' && ! canPinChatGptInPlace( entries ) ) {
		needsNewChat();
	}
}

export function appendSessionSelection(
	sessionsRoot: string,
	sessionId: string,
	selection: StudioSessionContextData
): Promise< void > {
	return withSessionSelection( sessionsRoot, sessionId, async ( entries ) => {
		assertSessionSelection( entries, selection );
		await appendStudioEntry( sessionsRoot, sessionId, 'studio.session_context', selection );
	} );
}

export async function setSessionProvider(
	sessionsRoot: string,
	sessionId: string,
	provider: string,
	model: string
): Promise< void > {
	if (
		! isAiProviderId( provider ) ||
		! isAiModelId( model ) ||
		! providerServesModel( provider, model )
	) {
		throw new ChatGptSettingsError( __( 'Choose a model this provider supports.' ) );
	}
	await appendSessionSelection( sessionsRoot, sessionId, { provider, model } );
}

export async function setSessionModel(
	sessionsRoot: string,
	sessionId: string,
	model: string
): Promise< void > {
	if ( ! isAiModelId( model ) ) {
		throw new ChatGptSettingsError( __( 'Choose a supported model.' ) );
	}
	await withSessionSelection( sessionsRoot, sessionId, async ( entries ) => {
		if ( getEffectiveSessionProvider( entries ) === 'chatgpt-oauth' ) {
			throw new ChatGptSettingsError(
				__( 'Choose the model and effort for this ChatGPT account together.' )
			);
		}
		await appendModelChangeEntry( sessionsRoot, sessionId, '', model );
	} );
}
