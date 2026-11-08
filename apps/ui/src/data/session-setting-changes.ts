import { __, sprintf } from '@wordpress/i18n';
import { useMemo, useSyncExternalStore } from 'react';
import { SESSIONS_QUERY_KEY } from '@/data/queries/use-sessions';
import type { LoadedAiSession, SessionEntry } from '@/data/core';
import type { QueryClient } from '@tanstack/react-query';

/**
 * A chat's model, provider and reasoning changes. Each is written after the
 * ones made before it, so an older choice can't land after a newer one. A
 * message sent while one is saving waits for it, so its turn runs with the
 * choice the composer showed, and isn't sent when that save fails.
 *
 * A change stays out of the session cache until it is written: a reload of
 * the chat that read the file before the write would otherwise replace it.
 * Once every change made together has settled, and no reload that might have
 * read the file before them is under way, the written ones join the cache and
 * the failed ones are gone, so the chat shows what its file holds.
 *
 * A change made after a message is sent is written once that message's turn
 * ends. The turn reads the chat's settings when it starts and records them
 * afterwards; written any earlier, the change could end up in that turn or be
 * overwritten by its record.
 */

interface Change {
	entry: SessionEntry;
	status: 'saving' | 'saved' | 'failed';
}

interface SessionChanges {
	queryClient: QueryClient;
	changes: Change[];
	// What the chat shows on top of its cache: every change that didn't fail.
	shown: SessionEntry[];
	tail: Promise< void >;
}

const NO_ENTRIES: SessionEntry[] = [];
const sessions = new Map< string, SessionChanges >();
const listeners = new Set< () => void >();
// Per chat, the end of the turn last sent; later changes are written after it.
const holds = new Map< string, Promise< void > >();

function notify(): void {
	for ( const listener of listeners ) {
		listener();
	}
}

function update( state: SessionChanges ): void {
	state.shown = state.changes
		.filter( ( change ) => change.status !== 'failed' )
		.map( ( change ) => change.entry );
	notify();
}

// Settles once no fetch of the query is running or paused.
function whenNotFetching(
	queryClient: QueryClient,
	queryKey: readonly unknown[]
): Promise< void > {
	const fetching = () =>
		( queryClient.getQueryState( queryKey )?.fetchStatus ?? 'idle' ) !== 'idle';
	if ( ! fetching() ) {
		return Promise.resolve();
	}
	return new Promise( ( resolve ) => {
		const unsubscribe = queryClient.getQueryCache().subscribe( () => {
			if ( ! fetching() ) {
				unsubscribe();
				resolve();
			}
		} );
	} );
}

async function merge( sessionId: string, state: SessionChanges ): Promise< void > {
	const count = state.changes.length;
	const saved = state.changes
		.filter( ( change ) => change.status === 'saved' )
		.map( ( change ) => change.entry );
	const queryKey = [ ...SESSIONS_QUERY_KEY, sessionId ];
	if ( saved.length > 0 ) {
		// A reload already under way may have read the file before these were
		// written; whatever it brings lands first.
		await whenNotFetching( state.queryClient, queryKey );
	}
	// A change made meanwhile carries these with it when it settles.
	if ( sessions.get( sessionId ) !== state || state.changes.length !== count ) {
		return;
	}
	if ( saved.length > 0 ) {
		state.queryClient.setQueryData< LoadedAiSession >( queryKey, ( previous ) =>
			previous ? { ...previous, entries: [ ...( previous.entries ?? [] ), ...saved ] } : previous
		);
	}
	sessions.delete( sessionId );
	notify();
}

function settle(
	sessionId: string,
	state: SessionChanges,
	change: Change,
	status: 'saved' | 'failed'
): void {
	change.status = status;
	if ( sessions.get( sessionId ) !== state ) {
		return;
	}
	update( state );
	if ( state.changes.every( ( item ) => item.status !== 'saving' ) ) {
		void merge( sessionId, state );
	}
}

/**
 * Shows `entry` in the chat at once and writes it once the chat's earlier
 * changes are written. Rejects when the write fails; the entry is then gone.
 */
export function saveSessionSettingChange( {
	queryClient,
	sessionId,
	entry,
	write,
}: {
	queryClient: QueryClient;
	sessionId: string;
	entry: SessionEntry;
	write: () => Promise< unknown >;
} ): Promise< void > {
	let state = sessions.get( sessionId );
	if ( ! state ) {
		state = { queryClient, changes: [], shown: NO_ENTRIES, tail: Promise.resolve() };
		sessions.set( sessionId, state );
	}
	const change: Change = { entry, status: 'saving' };
	state.changes.push( change );
	update( state );
	const hold = holds.get( sessionId );
	const save = state.tail
		.catch( () => undefined )
		.then( () => hold )
		.then( async () => {
			await write();
		} );
	state.tail = save;
	const current = state;
	save.then(
		() => settle( sessionId, current, change, 'saved' ),
		() => settle( sessionId, current, change, 'failed' )
	);
	return save;
}

function subscribe( listener: () => void ): () => void {
	listeners.add( listener );
	return () => {
		listeners.delete( listener );
	};
}

/** The chat's entries with its changes that haven't joined the cache yet. */
export function useEntriesWithSettingChanges(
	sessionId: string | undefined,
	entries: SessionEntry[] | undefined
): SessionEntry[] | undefined {
	const shown = useSyncExternalStore(
		subscribe,
		() => ( sessionId && sessions.get( sessionId )?.shown ) || NO_ENTRIES
	);
	return useMemo(
		() => ( entries && shown.length > 0 ? [ ...entries, ...shown ] : entries ),
		[ entries, shown ]
	);
}

/**
 * Settles when the changes still saving at the time of the call are saved,
 * and rejects when the latest of them fails. Call it when the message is sent.
 * A failure that already settled was taken back and shown where the change
 * was made; it doesn't hold up messages sent after that.
 */
export function waitForSessionSettingChanges( sessionId: string ): Promise< void > {
	const state = sessions.get( sessionId );
	if ( ! state || state.changes.every( ( change ) => change.status !== 'saving' ) ) {
		return Promise.resolve();
	}
	return state.tail.catch( ( error: unknown ) => {
		throw new Error(
			sprintf(
				/* translators: %s: why saving the change failed. */
				__( 'The model or reasoning change wasn’t saved, so the message wasn’t sent. %s' ),
				error instanceof Error ? error.message : String( error )
			)
		);
	} );
}

/**
 * Holds the chat's changes made from now on until `turnEnded` settles. Call it
 * when a message is sent, after `waitForSessionSettingChanges`.
 */
export function holdSessionSettingChanges( sessionId: string, turnEnded: Promise< void > ): void {
	const previous = holds.get( sessionId );
	const hold = previous
		? Promise.all( [ previous, turnEnded ] ).then( () => undefined )
		: turnEnded;
	holds.set( sessionId, hold );
	const forget = () => {
		if ( holds.get( sessionId ) === hold ) {
			holds.delete( sessionId );
		}
	};
	hold.then( forget, forget );
}

export function resetSessionSettingChangesForTests(): void {
	sessions.clear();
	holds.clear();
}
