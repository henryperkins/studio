import type { LoadedAiSession } from '@/data/core';
import type { BackendTurnEvent, ClaudeJournalEvent } from '@studio/agent/protocol/backend-events';
import type { QueryClient } from '@tanstack/react-query';

export function claudeDisplayEventKey( event: ClaudeJournalEvent ) {
	let identity: unknown;
	switch ( event.type ) {
		case 'content.provisional':
		case 'content.confirmed':
			identity = [ 'block', event.messageId, event.blockId ];
			break;
		case 'tool.result':
			identity = [ event.type, event.toolCallId ];
			break;
		case 'native.call':
		case 'tool.started':
			identity = [ event.type, event.toolCallId ];
			break;
		case 'tool.progress':
			identity = [ event.type, event.toolCallId, event.update ? null : event.message ];
			break;
		case 'chat.artifact':
			identity = [ event.type, event.artifact.id ];
			break;
		case 'question.asked':
		case 'question.resolved':
		case 'approval.resolved':
			identity = [ event.type, event.requestId ];
			break;
		case 'turn.prompt':
		case 'turn.terminal':
		case 'turn.recovered':
			identity = event.type;
			break;
		case 'context.compacted':
			identity = [ event.type, event.eventId ];
			break;
		case 'task.status':
			identity = [ event.type, event.taskId, event.taskRunId ];
			break;
		default:
			return undefined;
	}
	return JSON.stringify( [ event.runId, event.turnId, identity ] );
}

type PendingRead = Map< string, BackendTurnEvent >;
const reads = new WeakMap< QueryClient, Map< string, Set< PendingRead > > >();
const active = new WeakMap< QueryClient, Map< string, PendingRead > >();
const retired = new WeakMap< QueryClient, Map< string, string > >();

function advances( next: BackendTurnEvent, prior: ClaudeJournalEvent ): boolean {
	if ( prior.type === 'content.provisional' )
		return (
			next.type === 'content.confirmed' ||
			( next.type === 'content.provisional' && next.sequence > prior.sequence )
		);
	if ( prior.type === 'native.call' && next.type === 'native.call' )
		return prior.state === 'started' && next.state !== 'started';
	if ( prior.type === 'task.status' && next.type === 'task.status' )
		return prior.status === 'running' && next.status !== 'running';
	return (
		prior.type === 'tool.progress' &&
		next.type === 'tool.progress' &&
		!! next.update &&
		prior.message !== next.message
	);
}

export function captureClaudeEventDuringRead(
	client: QueryClient,
	sessionId: string,
	event: BackendTurnEvent
) {
	const key = claudeDisplayEventKey( event );
	if ( ! key || retired.get( client )?.get( sessionId ) === event.runId ) return false;
	let sessions = active.get( client );
	if ( ! sessions ) active.set( client, ( sessions = new Map() ) );
	let stream = sessions.get( sessionId );
	if ( ! stream ) sessions.set( sessionId, ( stream = new Map() ) );
	for ( const capture of [ stream, ...( reads.get( client )?.get( sessionId ) ?? [] ) ] ) {
		const prior = capture.get( key );
		if ( ! prior || advances( event, prior ) ) capture.set( key, event );
	}
	return true;
}

export function forgetClaudeStream( client: QueryClient, sessionId: string, runId: string ) {
	active.get( client )?.delete( sessionId );
	let sessions = retired.get( client );
	if ( ! sessions ) retired.set( client, ( sessions = new Map() ) );
	sessions.set( sessionId, runId );
}

function reconcileRead( session: LoadedAiSession, incoming: PendingRead ): LoadedAiSession {
	if ( session.summary.backend !== 'claude-code' || ! incoming.size ) return session;
	const journal = ( session.claudeJournal ?? [] ).map( ( turn ) => turn.slice() );
	const existing = new Map< string, ClaudeJournalEvent >();
	const savedProgress = new Set< string >();
	const turns = new Map< string, ClaudeJournalEvent[] >();
	const closed = new Set< string >();
	const turnKey = ( event: ClaudeJournalEvent ) => JSON.stringify( [ event.runId, event.turnId ] );
	for ( const turn of journal ) {
		for ( const event of turn ) {
			turns.set( turnKey( event ), turn );
			if ( event.type === 'turn.terminal' || event.type === 'turn.recovered' )
				closed.add( turnKey( event ) );
			const key = claudeDisplayEventKey( event );
			if ( key ) existing.set( key, event );
			if ( event.type === 'tool.progress' && event.update ) {
				savedProgress.add( JSON.stringify( [ key, event.message ] ) );
			}
		}
	}
	for ( const [ key, event ] of incoming ) {
		const id = turnKey( event );
		const prior = existing.get( key );
		if (
			event.type === 'tool.progress' &&
			savedProgress.has( JSON.stringify( [ key, event.message ] ) )
		)
			continue;
		if ( closed.has( id ) || ( prior && ! advances( event, prior ) ) ) continue;
		let turn = turns.get( id );
		if ( ! turn ) {
			turn = [];
			turns.set( id, turn );
			journal.push( turn );
		}
		turn.push( event );
	}
	return { ...session, claudeJournal: journal };
}

// A snapshot may begin before a live event is journaled and finish after it has reached the UI.
export async function readSessionWithClaudeEvents(
	client: QueryClient,
	sessionId: string,
	read: () => Promise< LoadedAiSession >,
	signal: AbortSignal
) {
	const sessions = reads.get( client ) ?? new Map< string, Set< PendingRead > >();
	reads.set( client, sessions );
	const pending = sessions.get( sessionId ) ?? new Set< PendingRead >();
	sessions.set( sessionId, pending );
	const capture: PendingRead = new Map( active.get( client )?.get( sessionId ) );
	pending.add( capture );
	const finish = () => {
		pending.delete( capture );
		if ( ! pending.size && sessions.get( sessionId ) === pending ) sessions.delete( sessionId );
	};
	signal.addEventListener( 'abort', finish, { once: true } );
	try {
		return reconcileRead( await read(), capture );
	} finally {
		finish();
		signal.removeEventListener( 'abort', finish );
	}
}
