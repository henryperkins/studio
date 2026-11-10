import { readChatGptSessionSelection } from '@studio/agent/protocol/chatgpt';
import { createDisconnectedOpenAiSettings } from '@studio/agent/protocol/providers';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getVisibleToasts } from '@/data/app-messages';
import { CHATGPT_SETTINGS_QUERY_KEY } from '@/data/queries/use-chatgpt-settings';
import { createFakeConnector, makeSession, makeSite } from '@/test/fake-connector';
import { renderApp } from '@/test/render';
import type { SessionEntry } from '@/data/core';
import type { ChatGptAccountView, ChatGptSessionSelection } from '@studio/agent/protocol/chatgpt';
import type { StudioSessionContextData } from '@studio/agent/protocol/sessions/entry-types';

vi.setConfig( { testTimeout: 30_000 } );
const A = 'f84d75a0-4e60-4168-a1ab-3134542c637a';
const B = '1c8e270b-9b5c-4687-b989-de052014b9e8';
const INITIAL: ChatGptSessionSelection = {
	connectionId: A,
	revision: 1,
	model: 'gpt-6-luna',
	reasoningEffort: 'medium',
};
const input = () => screen.getByRole( 'combobox', { name: 'Message WordPress Studio' } );
const reasoning = () => screen.getByRole( 'button', { name: 'Reasoning' } );
const pin = ( data: StudioSessionContextData ): SessionEntry => ( {
	type: 'custom',
	id: crypto.randomUUID(),
	parentId: null,
	timestamp: new Date().toISOString(),
	customType: 'studio.session_context',
	data: { provider: 'chatgpt-oauth', ...data },
} );
const account = ( connectionId: string, label: string ): ChatGptAccountView => ( {
	connectionId,
	providerId: 'chatgpt-oauth',
	backend: 'pi',
	revision: 1,
	identity: { subject: connectionId, email: 'same@example.test' },
	authStatus: 'connected',
	label,
	email: 'same@example.test',
	state: 'signed-in',
	storage: 'vault',
} );
function deferred< T >() {
	let resolve!: ( value: T ) => void;
	let reject!: ( error: Error ) => void;
	const promise = new Promise< T >( ( done, fail ) => {
		resolve = done;
		reject = fail;
	} );
	return { promise, resolve, reject };
}
async function setup( entries = [ pin( INITIAL ) ], withApi = false ) {
	const connector = createFakeConnector(
		{
			user: null,
			sites: [ makeSite( { id: 'one', running: true } ) ],
			chatGpt: {
				enabled: true,
				signInSupported: true,
				secureStorage: 'available',
				accounts: [ account( A, 'Personal' ), account( B, 'Work' ) ],
			},
			sessions: [
				{
					summary: makeSession( { id: 'chat', ownerSiteId: 'one', firstPrompt: 'Hello' } ),
					entries,
				},
			],
		},
		{
			getAiSettings: async () => ( {
				provider: 'wpcom',
				hasAnthropicApiKey: false,
				anthropicApiKeyPreview: null,
				hasOpenAiApiKey: withApi,
				openAi: createDisconnectedOpenAiSettings(),
			} ),
		}
	);
	connector.getSession.mockImplementation( async ( id ) =>
		structuredClone( connector.state.sessions.find( ( session ) => session.summary.id === id )! )
	);
	connector.getChatGptModels.mockImplementation( async ( connectionId, revision ) => ( {
		connectionId,
		revision,
		checkedAt: new Date().toISOString(),
		lastError: null,
		models: [
			{ id: 'gpt-6-luna', label: 'GPT-6 Luna' },
			{ id: 'gpt-6-astra', label: 'GPT-6 Astra' },
		],
	} ) );
	connector.setSessionProvider.mockImplementation( async ( id, provider, model ) => {
		connector.state.sessions
			.find( ( session ) => session.summary.id === id )!
			.entries.push( pin( { provider, model } ) );
	} );
	const runs: Array< {
		id: string;
		selection: ReturnType< typeof readChatGptSessionSelection >;
		entries: SessionEntry[];
	} > = [];
	connector.continueSession.mockImplementation( async ( id ) => {
		const entries = structuredClone(
			connector.state.sessions.find( ( item ) => item.summary.id === id )!.entries
		);
		runs.push( { id, entries, selection: readChatGptSessionSelection( entries ) } );
		return { runId: `run-${ runs.length }` };
	} );
	const view = renderApp( { connector, path: '/sessions/chat' } );
	await screen.findByRole( 'combobox', { name: 'Message WordPress Studio' } );
	await waitFor( () => expect( view.queryClient.isFetching() ).toBe( 0 ) );
	return { ...view, connector, runs };
}
async function chooseEffort( label: string ) {
	fireEvent.click( reasoning() );
	fireEvent.click(
		within( await screen.findByRole( 'group', { name: 'Reasoning effort' } ) ).getByRole(
			'menuitemradio',
			{ name: label }
		)
	);
}
async function chooseChatGpt( label = 'Personal', model = 'GPT-6 Luna' ) {
	fireEvent.click( screen.getByRole( 'button', { name: 'Model' } ) );
	const group = await screen.findByRole( 'group', { name: new RegExp( `ChatGPT · ${ label }` ) } );
	fireEvent.click( await within( group ).findByRole( 'option', { name: new RegExp( model ) } ) );
}
function send( text = 'New request' ) {
	fireEvent.change( input(), { target: { value: text } } );
	fireEvent.keyDown( input(), { key: 'Enter' } );
}

describe( 'ChatGPT chats', () => {
	it( 'runs without either API key, showing the selected registration and billing route', async () => {
		const { connector, runs } = await setup();
		expect( screen.getByRole( 'button', { name: 'Model' } ) ).toHaveTextContent( 'GPT-6 Luna' );
		expect( screen.getByRole( 'button', { name: 'Model' } ) ).toHaveAccessibleDescription(
			/ChatGPT plan/
		);
		expect( screen.getByText( /ChatGPT plan · Personal/ ) ).toHaveTextContent( A.slice( 0, 8 ) );
		fireEvent.click( reasoning() );
		expect( screen.queryByRole( 'group', { name: 'Mode' } ) ).not.toBeInTheDocument();
		fireEvent.click(
			within( await screen.findByRole( 'group', { name: 'Reasoning effort' } ) ).getByRole(
				'menuitemradio',
				{ name: 'High' }
			)
		);
		send();
		await waitFor( () => expect( runs ).toHaveLength( 1 ) );
		expect( runs[ 0 ].selection ).toEqual( { ...INITIAL, reasoningEffort: 'high' } );
		expect( connector.setSessionOpenAiSelection ).not.toHaveBeenCalled();
		expect( connector.setAiProvider ).not.toHaveBeenCalled();
	} );

	it( 'waits for the shown save and holds choices made after Send for the following turn', async () => {
		const { connector, runs } = await setup();
		const save = deferred< void >();
		const persist = connector.setSessionChatGptSelection.getMockImplementation()!;
		connector.setSessionChatGptSelection.mockImplementationOnce( async ( id, selection ) => {
			await save.promise;
			await persist( id, selection );
		} );
		await chooseEffort( 'High' );
		send();
		await chooseEffort( 'Low' );
		expect( runs ).toHaveLength( 0 );
		await act( async () => save.resolve() );
		await waitFor( () => expect( runs ).toHaveLength( 1 ) );
		expect( runs[ 0 ].selection?.reasoningEffort ).toBe( 'high' );
		expect( connector.setSessionChatGptSelection ).toHaveBeenCalledTimes( 1 );
		expect( reasoning() ).toHaveTextContent( 'Low' );
		act( () =>
			connector.emit( 'onAgentEvent', {
				sessionId: 'chat',
				runId: 'run-1',
				event: {
					type: 'run.exited',
					timestamp: new Date().toISOString(),
					status: 'success',
					code: 0,
				},
			} )
		);
		await waitFor( () =>
			expect( connector.setSessionChatGptSelection ).toHaveBeenCalledTimes( 2 )
		);
		send( 'Following request' );
		await waitFor( () => expect( runs ).toHaveLength( 2 ) );
		expect( runs[ 1 ].selection?.reasoningEffort ).toBe( 'low' );
	} );

	it( 'takes back a failed save and keeps the waiting message unsent', async () => {
		const { connector, runs } = await setup();
		const save = deferred< void >();
		connector.setSessionChatGptSelection.mockReturnValueOnce( save.promise );
		await chooseEffort( 'High' );
		send();
		await act( async () => save.reject( new Error( 'Disk full.' ) ) );
		await waitFor( () => expect( reasoning() ).toHaveTextContent( 'Medium' ) );
		expect( runs ).toHaveLength( 0 );
		expect( getVisibleToasts().some( ( toast ) => toast.title.includes( 'Disk full.' ) ) ).toBe(
			true
		);
	} );

	it( 'preserves a newer successful choice across an older failure and a late stale refetch', async () => {
		const { connector, queryClient, runs } = await setup();
		const high = deferred< void >();
		const low = deferred< void >();
		const read = deferred< void >();
		const persist = connector.setSessionChatGptSelection.getMockImplementation()!;
		connector.setSessionChatGptSelection
			.mockImplementationOnce( () => high.promise )
			.mockImplementationOnce( async ( id, selection ) => {
				await low.promise;
				await persist( id, selection );
			} );
		await chooseEffort( 'High' );
		await chooseEffort( 'Low' );
		connector.getSession.mockImplementationOnce( async () => {
			const stale = structuredClone( connector.state.sessions[ 0 ] );
			await read.promise;
			return stale;
		} );
		void queryClient.invalidateQueries( { queryKey: [ 'sessions', 'chat' ] } );
		await act( async () => high.reject( new Error( 'Old save failed.' ) ) );
		await waitFor( () =>
			expect( connector.setSessionChatGptSelection ).toHaveBeenCalledTimes( 2 )
		);
		await act( async () => low.resolve() );
		expect( reasoning() ).toHaveTextContent( 'Low' );
		await act( async () => read.resolve() );
		await waitFor( () => expect( queryClient.isFetching() ).toBe( 0 ) );
		expect( reasoning() ).toHaveTextContent( 'Low' );
		send();
		await waitFor( () => expect( runs[ 0 ]?.selection?.reasoningEffort ).toBe( 'low' ) );
	} );

	it.each( [ 'to-chatgpt', 'from-chatgpt', 'between-accounts' ] as const )(
		'starts a fresh chat for %s without transferring the draft or history, including identical model slugs',
		async ( direction ) => {
			const oldPin =
				direction === 'to-chatgpt'
					? pin( {
							provider: 'openai-api-key',
							model: 'gpt-6-luna',
							reasoningEffort: 'medium',
							reasoningMode: 'standard',
					  } )
					: pin( INITIAL );
			const oldPrompt: SessionEntry = {
				type: 'custom',
				id: 'old-prompt',
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: 'studio.user_prompt',
				data: { text: 'Previous private prompt', source: 'prompt' },
			};
			const { connector, runs } = await setup( [ oldPin, oldPrompt ], true );
			fireEvent.change( input(), { target: { value: 'Unreviewed old draft' } } );
			if ( direction === 'from-chatgpt' ) {
				fireEvent.click( screen.getByRole( 'button', { name: 'Model' } ) );
				fireEvent.click(
					within( await screen.findByRole( 'group', { name: 'Models' } ) ).getByRole( 'option', {
						name: /GPT-6 Luna/,
					} )
				);
			} else await chooseChatGpt( direction === 'between-accounts' ? 'Work' : 'Personal' );
			const dialog = await screen.findByRole( 'dialog', { name: 'Start a new chat?' } );
			expect( connector.createSession ).not.toHaveBeenCalled();
			expect(
				within( dialog ).getByRole( 'textbox', { name: 'Context summary (optional)' } )
			).toHaveValue( '' );
			fireEvent.click( within( dialog ).getByRole( 'button', { name: 'Start new chat' } ) );
			await waitFor( () =>
				expect(
					screen.queryByRole( 'dialog', { name: 'Start a new chat?' } )
				).not.toBeInTheDocument()
			);
			await waitFor( () => expect( input() ).toHaveValue( '' ) );
			const newId = connector.createSession.mock.results[ 0 ].value;
			const { id } = await newId;
			expect( id ).not.toBe( 'chat' );
			expect(
				connector.state.sessions.find( ( session ) => session.summary.id === 'chat' )!.entries
			).toEqual( [ oldPin, oldPrompt ] );
			if ( direction === 'from-chatgpt' )
				expect( connector.setSessionProvider ).toHaveBeenCalledWith(
					id,
					'openai-api-key',
					'gpt-6-luna'
				);
			else
				expect( connector.setSessionChatGptSelection ).toHaveBeenCalledWith( id, {
					...INITIAL,
					connectionId: direction === 'between-accounts' ? B : A,
				} );
			send( 'Only the new message' );
			await waitFor( () => expect( runs ).toHaveLength( 1 ) );
			expect( runs[ 0 ].id ).toBe( id );
			expect( JSON.stringify( runs[ 0 ].entries ) ).not.toContain( 'Previous private prompt' );
		}
	);

	it( 'carries only an explicitly entered summary into the new composer', async () => {
		await setup();
		fireEvent.change( input(), { target: { value: 'Private draft' } } );
		await chooseChatGpt( 'Work' );
		const dialog = await screen.findByRole( 'dialog', { name: 'Start a new chat?' } );
		fireEvent.change(
			within( dialog ).getByRole( 'textbox', { name: 'Context summary (optional)' } ),
			{ target: { value: 'Reviewed context' } }
		);
		fireEvent.click( within( dialog ).getByRole( 'button', { name: 'Start new chat' } ) );
		await waitFor( () => expect( input() ).toHaveValue( 'Reviewed context' ) );
	} );

	it( 'keeps the original chat when the new connection cannot be saved', async () => {
		const { connector } = await setup();
		connector.setSessionChatGptSelection.mockRejectedValueOnce(
			new Error( 'The account signed out.' )
		);
		await chooseChatGpt( 'Work' );
		fireEvent.click(
			within( await screen.findByRole( 'dialog', { name: 'Start a new chat?' } ) ).getByRole(
				'button',
				{ name: 'Start new chat' }
			)
		);
		expect( await screen.findByText( 'The account signed out.' ) ).toBeVisible();
		expect( connector.continueSession ).not.toHaveBeenCalled();
		expect(
			readChatGptSessionSelection( connector.state.sessions[ 0 ].entries )?.connectionId
		).toBe( A );
	} );

	it( 'holds queued messages after the selected account disconnects, even with another account and an API key', async () => {
		const { connector, queryClient, runs } = await setup( [ pin( INITIAL ) ], true );
		send( 'First request' );
		await waitFor( () => expect( runs ).toHaveLength( 1 ) );
		send( 'Queued private request' );
		await screen.findByText( 'Queued private request' );
		connector.state.chatGpt.accounts[ 0 ] = {
			...account( A, 'Personal' ),
			authStatus: 'disconnected',
			state: 'signed-out',
		};
		await act( async () => {
			await queryClient.invalidateQueries( { queryKey: CHATGPT_SETTINGS_QUERY_KEY } );
		} );
		act( () =>
			connector.emit( 'onAgentEvent', {
				sessionId: 'chat',
				runId: 'run-1',
				event: { type: 'run.interrupted', timestamp: new Date().toISOString() },
			} )
		);
		await waitFor( () => expect( screen.getByText( /ChatGPT isn’t connected/ ) ).toBeVisible() );
		expect( screen.getByText( 'Queued private request' ) ).toBeVisible();
		expect( runs ).toHaveLength( 1 );
		expect( connector.setSessionProvider ).not.toHaveBeenCalled();
	} );
} );
