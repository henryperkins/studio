import { act, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { createFakeConnector, makeSession } from '@/test/fake-connector';
import { renderWithProviders } from '@/test/render';
import { SESSIONS_QUERY_KEY, useSession } from './use-sessions';
import type { LoadedAiSession } from '@/data/core';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';

function Consumer() {
	useSession( 'claude-history' );
	return null;
}

function ClosedChat() {
	const [ open, setOpen ] = useState( false );
	useSession( open ? 'claude-history' : undefined );
	return <button onClick={ () => setOpen( true ) }>Open history</button>;
}

describe( 'Claude journal reads during live events', () => {
	it( 'retains an active event delivered before the first session read', async () => {
		const id = 'claude-history';
		const connector = createFakeConnector( {
			sessions: [ { summary: makeSession( { id, backend: 'claude-code' } ), entries: [] } ],
		} );
		const view = renderWithProviders( <ClosedChat />, { connector } );
		const open = await view.findByText( 'Open history' );
		act( () =>
			connector.emit( 'onAgentEvent', {
				sessionId: id,
				runId: 'run',
				event: { type: 'run.started', timestamp: new Date().toISOString() },
			} )
		);
		const event = {
			type: 'tool.result',
			runId: 'run',
			turnId: 'turn',
			toolCallId: 'call',
			isError: false,
			message: 'Finished',
		} as const;
		act( () =>
			connector.emit( 'onAgentEvent', {
				sessionId: id,
				runId: event.runId,
				event: { type: 'backend.event', timestamp: new Date().toISOString(), event },
			} )
		);
		await view.user.click( open );
		await waitFor( () =>
			expect(
				view.queryClient.getQueryData< LoadedAiSession >( [ ...SESSIONS_QUERY_KEY, id ] )
					?.claudeJournal
			).toEqual( [ [ event ] ] )
		);
		const timestamp = new Date().toISOString();
		act( () =>
			connector.emit( 'onAgentEvent', {
				sessionId: id,
				runId: event.runId,
				event: { type: 'run.exited', timestamp, status: 'success', code: 0 },
			} )
		);
		await waitFor( () =>
			expect( view.queryClient.getQueryState( [ ...SESSIONS_QUERY_KEY, id ] )?.fetchStatus ).toBe(
				'idle'
			)
		);
		const delayed = { ...event, toolCallId: 'late', message: 'Obsolete' };
		act( () =>
			connector.emit( 'onAgentEvent', {
				sessionId: id,
				runId: event.runId,
				event: { type: 'backend.event', timestamp, event: delayed },
			} )
		);
		expect(
			view.queryClient
				.getQueryData< LoadedAiSession >( [ ...SESSIONS_QUERY_KEY, id ] )
				?.claudeJournal?.flat() ?? []
		).not.toContainEqual( delayed );
	} );
	it.each( [ 'initial', 'refetch' ] )(
		'reconciles a %s snapshot without replaying actions or regressing confirmed output',
		async ( mode ) => {
			const id = 'claude-history';
			const ids = { runId: 'current', turnId: 'turn' };
			const block = { ...ids, messageId: 'reply', blockId: '0', blockType: 'text' as const };
			const confirmed: BackendTurnEvent = {
				...block,
				type: 'content.confirmed',
				text: 'Saved text',
			};
			const progress: BackendTurnEvent = {
				...ids,
				type: 'tool.progress',
				toolCallId: 'tool',
				message: 'Starting',
				update: true,
			};
			const later = { ...progress, message: 'Finishing' };
			const snapshot: LoadedAiSession = {
				summary: makeSession( { id, backend: 'claude-code' } ),
				entries: [],
				claudeJournal: [ [ confirmed, progress, later ] ],
			};
			const connector = createFakeConnector( { sessions: [ snapshot ] } );
			let finish!: ( value: LoadedAiSession ) => void;
			const delayed = new Promise< LoadedAiSession >( ( resolve ) => {
				finish = resolve;
			} );
			if ( mode === 'refetch' ) connector.getSession.mockResolvedValueOnce( snapshot );
			connector.getSession.mockReturnValue( delayed );
			const { queryClient } = renderWithProviders( <Consumer />, { connector } );
			const key = [ ...SESSIONS_QUERY_KEY, id ];
			if ( mode === 'refetch' ) {
				await waitFor( () => expect( queryClient.getQueryData( key ) ).toEqual( snapshot ) );
				void queryClient.invalidateQueries( { queryKey: key } );
			}
			await waitFor( () =>
				expect( connector.getSession ).toHaveBeenCalledTimes( mode === 'initial' ? 1 : 2 )
			);
			const timestamp = new Date().toISOString();
			act( () =>
				connector.emit( 'onAgentEvent', {
					sessionId: id,
					runId: ids.runId,
					event: { type: 'run.started', timestamp },
				} )
			);
			const emit = ( event: BackendTurnEvent ) =>
				connector.emit( 'onAgentEvent', {
					sessionId: id,
					runId: event.runId,
					event: { type: 'backend.event', timestamp, event },
				} );
			const task: BackendTurnEvent = {
				...ids,
				type: 'task.status',
				taskId: 'job',
				status: 'completed',
			};
			const prompt: BackendTurnEvent = {
				...ids,
				type: 'turn.prompt',
				text: 'User prompt',
				attachments: [ { kind: 'file', name: 'notes.txt' } ],
			};
			act( () => {
				emit( { ...block, type: 'content.provisional', sequence: 2, text: 'Older' } );
				emit( progress );
				emit( prompt );
				emit( task );
				emit( { ...task, status: 'running' } );
				emit( { ...ids, type: 'preview.reload' } );
				emit( { ...prompt, runId: 'other', text: 'Wrong owner' } );
				emit( {
					...ids,
					type: 'approval.requested',
					toolCallId: 'tool',
					requestId: 'approval',
					description: 'Private live detail',
					operation: {
						tool: 'test',
						operationClass: 'local-change',
						target: { environment: 'global' },
						args: 'private',
						localPaths: [],
					},
				} );
			} );
			await act( async () => finish( snapshot ) );
			await waitFor( () => expect( queryClient.getQueryState( key )?.fetchStatus ).toBe( 'idle' ) );
			const read = queryClient.getQueryData< LoadedAiSession >( key );
			expect( read?.claudeJournal ).toEqual( [ [ confirmed, progress, later, prompt, task ] ] );
			expect( connector.answerAgentQuestion ).not.toHaveBeenCalled();
		}
	);
} );
