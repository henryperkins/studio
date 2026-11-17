import { readChatGptSessionSelection } from '@studio/agent/protocol/chatgpt';
import { createDisconnectedOpenAiSettings } from '@studio/agent/protocol/providers';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getVisibleToasts } from '@/data/app-messages';
import { ChatGptSettingsError, type AuthUser, type SessionEntry } from '@/data/core';
import {
	CHATGPT_MODELS_QUERY_KEY,
	CHATGPT_SETTINGS_QUERY_KEY,
} from '@/data/queries/use-chatgpt-settings';
import { createFakeConnector, makeSession, makeSite, TEST_USER } from '@/test/fake-connector';
import { renderApp } from '@/test/render';
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
// As Studio saves them: an account's label is its email.
const PERSONAL = 'personal@example.test';
const WORK = 'work@example.test';
const account = ( connectionId: string, label: string ): ChatGptAccountView => ( {
	connectionId,
	providerId: 'chatgpt-oauth',
	backend: 'pi',
	revision: 1,
	identity: { verified: true, email: label },
	authStatus: 'connected',
	label,
	email: label,
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
async function setup(
	entries = [ pin( INITIAL ) ],
	withApi = false,
	user: AuthUser | null = null,
	// The chat, or the site's new chat, which has no session until it starts.
	path = '/sessions/chat'
) {
	const connector = createFakeConnector(
		{
			user,
			sites: [ makeSite( { id: 'one', running: true } ) ],
			chatGpt: {
				enabled: true,
				signInSupported: true,
				secureStorage: 'available',
				accounts: [ account( A, PERSONAL ), account( B, WORK ) ],
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
		models: [ { id: 'gpt-6-luna', label: 'GPT-6 Luna' } ],
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
		prompt: string;
		options: Parameters< typeof connector.continueSession >[ 2 ];
	} > = [];
	connector.continueSession.mockImplementation( async ( id, prompt, options ) => {
		const entries = structuredClone(
			connector.state.sessions.find( ( item ) => item.summary.id === id )!.entries
		);
		runs.push( {
			id,
			entries,
			selection: readChatGptSessionSelection( entries ),
			prompt,
			options,
		} );
		return { runId: `run-${ runs.length }` };
	} );
	const view = renderApp( { connector, path } );
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
async function chooseChatGpt( label = PERSONAL, model = 'GPT-6 Luna' ) {
	fireEvent.click( screen.getByRole( 'button', { name: 'Model' } ) );
	const group = await screen.findByRole( 'group', { name: `ChatGPT plan · ${ label }` } );
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
		expect( screen.getByText( `ChatGPT plan · ${ PERSONAL }` ) ).toBeVisible();
		fireEvent.click( reasoning() );
		expect( screen.queryByRole( 'group', { name: 'Mode' } ) ).not.toBeInTheDocument();
		fireEvent.click(
			within( await screen.findByRole( 'group', { name: 'Reasoning effort' } ) ).getByRole(
				'menuitemradio',
				{ name: 'Low' }
			)
		);
		send();
		await waitFor( () => expect( runs ).toHaveLength( 1 ) );
		expect( runs[ 0 ].selection ).toEqual( { ...INITIAL, reasoningEffort: 'low' } );
		expect( connector.setSessionOpenAiSelection ).not.toHaveBeenCalled();
		expect( connector.setAiProvider ).not.toHaveBeenCalled();
	} );

	it( 'says images come from Studio’s WordPress.com image service as its account, not the ChatGPT plan', async () => {
		await setup( undefined, false, TEST_USER );

		expect(
			await screen.findByText(
				'Images: WordPress.com image service as Test User, not your ChatGPT plan'
			)
		).toBeVisible();
		expect( screen.getByText( `ChatGPT plan · ${ PERSONAL }` ) ).toBeVisible();
	} );

	it( 'says images are off without the image service, and opens where to set it up', async () => {
		const { connector } = await setup();

		expect(
			await screen.findByText(
				/Images: off\. They need Studio’s WordPress\.com image service, not your ChatGPT plan\./
			)
		).toBeVisible();
		fireEvent.click( screen.getByRole( 'button', { name: 'Set up image generation' } ) );

		const settings = await screen.findByRole( 'dialog', { name: 'Settings' } );
		const group = await within( settings ).findByRole( 'group', { name: 'ChatGPT plan' } );
		expect(
			await within( group ).findByRole( 'button', { name: 'Log in to WordPress.com' } )
		).toBeVisible();
		expect( connector.authenticate ).not.toHaveBeenCalled();
		expect( connector.beginChatGptSignIn ).not.toHaveBeenCalled();
	} );

	it( 'says in the picker when the account lists models Studio doesn’t support yet, naming and offering none of them', async () => {
		const { connector, runs, queryClient } = await setup();
		connector.getChatGptModels.mockImplementation( async ( connectionId, revision ) => ( {
			connectionId,
			revision,
			checkedAt: new Date().toISOString(),
			lastError: null,
			models: connectionId === A ? [ { id: 'gpt-6-luna', label: 'GPT-6 Luna' } ] : [],
			listsUnqualifiedModels: true,
		} ) );
		await act( () => queryClient.resetQueries( { queryKey: CHATGPT_MODELS_QUERY_KEY } ) );

		fireEvent.click( screen.getByRole( 'button', { name: 'Model' } ) );
		const personal = await screen.findByRole( 'group', { name: `ChatGPT plan · ${ PERSONAL }` } );
		const work = await screen.findByRole( 'group', { name: `ChatGPT plan · ${ WORK }` } );
		const sentence = 'Some models this account offers aren’t supported in Studio yet';
		await waitFor( () => expect( screen.getAllByRole( 'note' ) ).toHaveLength( 2 ) );
		const notes = screen.getAllByRole( 'note' );

		expect( notes ).toHaveLength( 2 );
		notes.forEach( ( note ) => expect( note ).toHaveTextContent( sentence ) );
		expect( notes[ 0 ] ).toHaveTextContent( PERSONAL );
		expect( notes[ 1 ] ).toHaveTextContent( WORK );
		notes.forEach( ( note ) => expect( note ).not.toHaveTextContent( /f84d75a0|1c8e270b/ ) );
		expect( screen.queryByRole( 'option', { name: /aren’t supported/ } ) ).not.toBeInTheDocument();
		expect( within( personal ).getAllByRole( 'option' ) ).toHaveLength( 1 );
		expect( within( work ).getAllByRole( 'option' ) ).toHaveLength( 1 );
		fireEvent.click( notes[ 0 ] );
		expect( connector.setSessionChatGptSelection ).not.toHaveBeenCalled();
		expect( runs ).toHaveLength( 0 );
	} );

	it( 'adds no note to the picker when the account lists only supported models', async () => {
		await setup();

		fireEvent.click( screen.getByRole( 'button', { name: 'Model' } ) );
		const personal = await screen.findByRole( 'group', { name: `ChatGPT plan · ${ PERSONAL }` } );

		expect( await within( personal ).findByRole( 'option', { name: /GPT-6 Luna/ } ) ).toBeVisible();
		expect( screen.queryByRole( 'note' ) ).not.toBeInTheDocument();
	} );

	it( 'names the chat’s account once, by its label, and its plan once on the Model button', async () => {
		await setup();
		const model = screen.getByRole( 'button', { name: 'Model' } );

		expect( model ).toHaveAccessibleDescription( `GPT-6 Luna · ChatGPT plan · ${ PERSONAL }` );
		expect( screen.getByText( `ChatGPT plan · ${ PERSONAL }` ) ).not.toHaveTextContent(
			A.slice( 0, 8 )
		);
		fireEvent.click( model );
		const personal = await screen.findByRole( 'group', { name: `ChatGPT plan · ${ PERSONAL }` } );
		const option = await within( personal ).findByRole( 'option', { name: /GPT-6 Luna/ } );
		expect( within( personal ).getByText( PERSONAL ) ).toBeVisible();
		expect( option ).toHaveTextContent( /ChatGPT plan/ );
		expect( option ).not.toHaveTextContent( PERSONAL );
	} );

	it( 'tells two accounts of the same label apart by the start of their ids', async () => {
		const { connector, queryClient } = await setup();
		connector.state.chatGpt.accounts = [ account( A, PERSONAL ), account( B, PERSONAL ) ];
		await act( () => queryClient.refetchQueries( { queryKey: CHATGPT_SETTINGS_QUERY_KEY } ) );

		expect(
			await screen.findByText( `ChatGPT plan · ${ PERSONAL } · ${ A.slice( 0, 8 ) }` )
		).toBeVisible();
		fireEvent.click( screen.getByRole( 'button', { name: 'Model' } ) );
		expect(
			await screen.findByRole( 'group', {
				name: `ChatGPT plan · ${ PERSONAL } · ${ A.slice( 0, 8 ) }`,
			} )
		).toBeVisible();
		expect(
			screen.getByRole( 'group', { name: `ChatGPT plan · ${ PERSONAL } · ${ B.slice( 0, 8 ) }` } )
		).toBeVisible();
		expect( screen.queryByRole( 'group', { name: new RegExp( A ) } ) ).not.toBeInTheDocument();
	} );

	it.each( [
		[ 'signed-out', 'Signed out' ],
		[ 'needs-sign-in', 'Needs sign-in' ],
	] as const )(
		'says in the picker that another account is %s, offering none of its models to choose',
		async ( state, badge ) => {
			const { connector, queryClient, runs } = await setup();
			connector.state.chatGpt.accounts[ 1 ] = {
				...account( B, WORK ),
				authStatus: 'disconnected',
				state,
			};
			await act( () => queryClient.refetchQueries( { queryKey: CHATGPT_SETTINGS_QUERY_KEY } ) );
			fireEvent.click( screen.getByRole( 'button', { name: 'Model' } ) );

			const work = await screen.findByRole( 'group', { name: `ChatGPT plan · ${ WORK }` } );
			const row = within( work ).getByRole( 'option' );
			expect( within( work ).getAllByRole( 'option' ) ).toHaveLength( 1 );
			expect( row ).toHaveTextContent( 'Sign in to this ChatGPT account in Settings' );
			// First, so a narrow picker cuts the instruction rather than the state.
			expect( row ).toHaveTextContent( new RegExp( `^${ badge }` ) );
			expect( row ).toHaveAttribute( 'aria-disabled', 'true' );
			fireEvent.click( row );
			fireEvent.keyDown( screen.getByRole( 'listbox', { name: 'Choose a model' } ), {
				key: 'End',
			} );
			expect( screen.getByRole( 'listbox', { name: 'Choose a model' } ) ).not.toHaveAttribute(
				'aria-activedescendant',
				row.id
			);
			expect(
				screen.queryByRole( 'dialog', { name: 'Start a new chat?' } )
			).not.toBeInTheDocument();
			expect( connector.getChatGptModels ).not.toHaveBeenCalledWith( B, 1 );
			expect( connector.setSessionChatGptSelection ).not.toHaveBeenCalled();
			expect( runs ).toHaveLength( 0 );
		}
	);

	it( 'sends attached images and documents with the turn on the pinned ChatGPT selection', async () => {
		const { runs } = await setup();
		fireEvent.change( screen.getByLabelText( 'Upload attachments' ), {
			target: {
				files: [
					new File( [ 'image-bytes' ], 'moodboard.png', { type: 'image/png' } ),
					new File( [ '# Brief' ], 'brief.md', { type: 'text/markdown' } ),
				],
			},
		} );
		await screen.findByRole( 'listitem', { name: /^moodboard\.png/ } );
		await screen.findByRole( 'listitem', { name: /^brief\.md/ } );
		send( 'Use these' );
		await waitFor( () => expect( runs ).toHaveLength( 1 ) );
		expect( runs[ 0 ].selection ).toEqual( INITIAL );
		expect( runs[ 0 ].prompt ).toBe( 'Use these' );
		expect( runs[ 0 ].options?.images ).toEqual( [
			expect.objectContaining( {
				name: 'moodboard.png',
				mimeType: 'image/png',
				dataBase64: btoa( 'image-bytes' ),
			} ),
		] );
		expect( runs[ 0 ].options?.files ).toEqual( [
			expect.objectContaining( { name: 'brief.md', path: expect.stringMatching( /brief\.md$/ ) } ),
		] );
	} );

	it( 'waits for the shown save and holds choices made after Send for the following turn', async () => {
		const { connector, runs } = await setup();
		const save = deferred< void >();
		const persist = connector.setSessionChatGptSelection.getMockImplementation()!;
		connector.setSessionChatGptSelection.mockImplementationOnce( async ( id, selection ) => {
			await save.promise;
			await persist( id, selection );
		} );
		await chooseEffort( 'Low' );
		send();
		await chooseEffort( 'Medium' );
		expect( runs ).toHaveLength( 0 );
		await act( async () => save.resolve() );
		await waitFor( () => expect( runs ).toHaveLength( 1 ) );
		expect( runs[ 0 ].selection?.reasoningEffort ).toBe( 'low' );
		expect( connector.setSessionChatGptSelection ).toHaveBeenCalledTimes( 1 );
		expect( reasoning() ).toHaveTextContent( 'Medium' );
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
		expect( runs[ 1 ].selection?.reasoningEffort ).toBe( 'medium' );
	} );

	it( 'takes back a failed save and keeps the waiting message unsent', async () => {
		const { connector, runs } = await setup();
		const save = deferred< void >();
		connector.setSessionChatGptSelection.mockReturnValueOnce( save.promise );
		await chooseEffort( 'Low' );
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
		const low = deferred< void >();
		const medium = deferred< void >();
		const read = deferred< void >();
		const persist = connector.setSessionChatGptSelection.getMockImplementation()!;
		connector.setSessionChatGptSelection
			.mockImplementationOnce( () => low.promise )
			.mockImplementationOnce( async ( id, selection ) => {
				await medium.promise;
				await persist( id, selection );
			} );
		await chooseEffort( 'Low' );
		await chooseEffort( 'Medium' );
		// A read from before the newest choice was saved, which saw the older one.
		connector.getSession.mockImplementationOnce( async () => {
			const stale = structuredClone( connector.state.sessions[ 0 ] );
			stale.entries.push( pin( { ...INITIAL, reasoningEffort: 'low' } ) );
			await read.promise;
			return stale;
		} );
		void queryClient.invalidateQueries( { queryKey: [ 'sessions', 'chat' ] } );
		await act( async () => low.reject( new Error( 'Old save failed.' ) ) );
		await waitFor( () =>
			expect( connector.setSessionChatGptSelection ).toHaveBeenCalledTimes( 2 )
		);
		await act( async () => medium.resolve() );
		expect( reasoning() ).toHaveTextContent( 'Medium' );
		await act( async () => read.resolve() );
		await waitFor( () => expect( queryClient.isFetching() ).toBe( 0 ) );
		expect( reasoning() ).toHaveTextContent( 'Medium' );
		send();
		await waitFor( () => expect( runs[ 0 ]?.selection?.reasoningEffort ).toBe( 'medium' ) );
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
			} else await chooseChatGpt( direction === 'between-accounts' ? WORK : PERSONAL );
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

	it( 'puts a chat with nothing in it yet on ChatGPT where it is, keeping what was typed', async () => {
		const { connector, runs } = await setup( [] );
		fireEvent.change( input(), { target: { value: 'Unsent idea' } } );
		await chooseChatGpt( WORK );

		await waitFor( () =>
			expect( connector.setSessionChatGptSelection ).toHaveBeenCalledExactlyOnceWith( 'chat', {
				...INITIAL,
				connectionId: B,
			} )
		);
		expect( screen.queryByRole( 'dialog', { name: 'Start a new chat?' } ) ).not.toBeInTheDocument();
		expect( connector.createSession ).not.toHaveBeenCalled();
		expect( input() ).toHaveValue( 'Unsent idea' );
		expect( await screen.findByText( `ChatGPT plan · ${ WORK }` ) ).toBeVisible();
		fireEvent.keyDown( input(), { key: 'Enter' } );
		await waitFor( () => expect( runs ).toHaveLength( 1 ) );
		expect( runs[ 0 ] ).toMatchObject( {
			id: 'chat',
			prompt: 'Unsent idea',
			selection: { ...INITIAL, connectionId: B },
		} );
	} );

	it( 'takes back a chat put on ChatGPT where it is when that can’t be saved, saying why', async () => {
		const { connector, runs } = await setup( [] );
		connector.setSessionChatGptSelection.mockRejectedValueOnce(
			new Error( 'Studio couldn’t save the model for this chat. Try again.' )
		);
		fireEvent.change( input(), { target: { value: 'Unsent idea' } } );
		await chooseChatGpt( WORK );

		await waitFor( () =>
			expect(
				getVisibleToasts().some( ( toast ) =>
					toast.title.includes( 'Studio couldn’t save the model for this chat. Try again.' )
				)
			).toBe( true )
		);
		await waitFor( () =>
			expect( screen.queryByText( `ChatGPT plan · ${ WORK }` ) ).not.toBeInTheDocument()
		);
		expect( input() ).toHaveValue( 'Unsent idea' );
		expect( connector.createSession ).not.toHaveBeenCalled();
		expect( runs ).toHaveLength( 0 );
	} );

	it( 'starts the site’s new chat on ChatGPT without asking, taking what was typed to it', async () => {
		const { connector, runs } = await setup( [], false, null, '/sites/one/new' );
		fireEvent.change( input(), { target: { value: 'Unsent idea' } } );
		await chooseChatGpt( WORK );

		await waitFor( () =>
			expect( connector.createSession ).toHaveBeenCalledExactlyOnceWith( 'one' )
		);
		const { id } = await connector.createSession.mock.results[ 0 ].value;
		await waitFor( () =>
			expect( connector.setSessionChatGptSelection ).toHaveBeenCalledExactlyOnceWith( id, {
				...INITIAL,
				connectionId: B,
			} )
		);
		expect( screen.queryByRole( 'dialog', { name: 'Start a new chat?' } ) ).not.toBeInTheDocument();
		expect( await screen.findByText( `ChatGPT plan · ${ WORK }` ) ).toBeVisible();
		await waitFor( () => expect( input() ).toHaveValue( 'Unsent idea' ) );
		fireEvent.keyDown( input(), { key: 'Enter' } );
		await waitFor( () => expect( runs ).toHaveLength( 1 ) );
		expect( runs[ 0 ] ).toMatchObject( {
			id,
			prompt: 'Unsent idea',
			selection: { ...INITIAL, connectionId: B },
		} );
		expect( connector.createSession ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'still asks to start a new chat once a chat without turns is pinned to another provider', async () => {
		const { connector } = await setup(
			[ pin( { provider: 'openai-api-key', model: 'gpt-6-luna' } ) ],
			true
		);
		await chooseChatGpt( WORK );

		expect( await screen.findByRole( 'dialog', { name: 'Start a new chat?' } ) ).toBeVisible();
		expect( connector.setSessionChatGptSelection ).not.toHaveBeenCalled();
	} );

	it( 'carries only an explicitly entered summary into the new composer', async () => {
		await setup();
		fireEvent.change( input(), { target: { value: 'Private draft' } } );
		await chooseChatGpt( WORK );
		const dialog = await screen.findByRole( 'dialog', { name: 'Start a new chat?' } );
		const target = `ChatGPT plan · ${ WORK } · GPT-6 Luna · Medium`;
		expect( within( dialog ).getByText( target ) ).toBeVisible();
		expect( dialog ).toHaveAccessibleDescription(
			expect.stringMatching( /^Changing the account or billing connection starts a new chat\./ )
		);
		expect( dialog ).toHaveAccessibleDescription( expect.stringContaining( target ) );
		fireEvent.change(
			within( dialog ).getByRole( 'textbox', { name: 'Context summary (optional)' } ),
			{ target: { value: 'Reviewed context' } }
		);
		fireEvent.click( within( dialog ).getByRole( 'button', { name: 'Start new chat' } ) );
		await waitFor( () => expect( input() ).toHaveValue( 'Reviewed context' ) );
	} );

	it.each( [
		'Studio couldn’t save the model for this chat. Try again.',
		'Choose a model this provider supports.',
	] )(
		'says only “%s” when the new chat’s provider can’t be saved, keeping the original chat',
		async ( message ) => {
			const { connector } = await setup( [ pin( INITIAL ) ], true );
			connector.setSessionProvider.mockRejectedValueOnce( new Error( message ) );
			fireEvent.click( screen.getByRole( 'button', { name: 'Model' } ) );
			fireEvent.click(
				within( await screen.findByRole( 'group', { name: 'Models' } ) ).getByRole( 'option', {
					name: /GPT-6 Luna/,
				} )
			);
			const dialog = await screen.findByRole( 'dialog', { name: 'Start a new chat?' } );
			fireEvent.click( within( dialog ).getByRole( 'button', { name: 'Start new chat' } ) );

			expect( await within( dialog ).findByText( message ) ).toBeVisible();
			expect( dialog ).not.toHaveTextContent( /settings\.lock|EEXIST|[A-Z]:\\/ );
			expect( connector.continueSession ).not.toHaveBeenCalled();
			expect(
				readChatGptSessionSelection(
					connector.state.sessions.find( ( session ) => session.summary.id === 'chat' )!.entries
				)
			).toEqual( INITIAL );
		}
	);

	it( 'keeps the original chat when the new connection cannot be saved', async () => {
		const { connector } = await setup();
		connector.setSessionChatGptSelection.mockRejectedValueOnce(
			new Error( 'The account signed out.' )
		);
		await chooseChatGpt( WORK );
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

	it( 'holds queued messages once a refreshed catalog drops the chat’s model, never switching to another', async () => {
		const { connector, queryClient, runs } = await setup();
		send( 'First request' );
		await waitFor( () => expect( runs ).toHaveLength( 1 ) );
		send( 'Queued private request' );
		await screen.findByText( 'Queued private request' );
		connector.getChatGptModels.mockImplementation( async ( connectionId, revision ) => ( {
			connectionId,
			revision,
			checkedAt: new Date().toISOString(),
			lastError: null,
			models: [],
		} ) );
		await act( async () => {
			await queryClient.invalidateQueries( { queryKey: CHATGPT_MODELS_QUERY_KEY } );
		} );
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
			expect(
				screen.getByText(
					'This model isn’t listed for the selected ChatGPT account. Choose another model.'
				)
			).toBeVisible()
		);
		expect( screen.getByText( 'Queued private request' ) ).toBeVisible();
		expect( runs ).toHaveLength( 1 );
		expect( connector.setSessionChatGptSelection ).not.toHaveBeenCalled();
		expect( readChatGptSessionSelection( connector.state.sessions[ 0 ].entries ) ).toEqual(
			INITIAL
		);
	} );

	it.each( [
		[
			'a model',
			{ model: 'gpt-6.1-sol' },
			'Studio doesn’t support the ChatGPT model “gpt-6.1-sol” yet: it isn’t qualified for use with a ChatGPT plan. Choose another model to continue.',
		],
		[
			'an effort',
			{ reasoningEffort: 'high' },
			'Studio doesn’t support “High” reasoning for gpt-6-luna with ChatGPT yet: it isn’t qualified for use with a ChatGPT plan. Choose one of: Low, Medium.',
		],
	] )(
		'explains and holds a recorded choice of %s the route isn’t qualified for, never replacing it',
		async ( _name, recorded, explanation ) => {
			const { connector, runs } = await setup( [ pin( { ...INITIAL, ...recorded } ) ] );
			expect( await screen.findByText( explanation ) ).toBeVisible();
			send( 'Held request' );
			await act( async () => {} );
			expect( runs ).toHaveLength( 0 );
			expect( connector.setSessionChatGptSelection ).not.toHaveBeenCalled();
			expect( readChatGptSessionSelection( connector.state.sessions[ 0 ].entries ) ).toEqual( {
				...INITIAL,
				...recorded,
			} );
		}
	);

	// As each app's connector reports a failed read (pinned in chatgpt-contracts.test.ts).
	it.each( [
		{
			host: 'Desktop, or studio ui with the server’s { error }',
			failure: () =>
				new ChatGptSettingsError( 'Studio couldn’t complete the ChatGPT action. Try again.' ),
			shown: 'Studio couldn’t complete the ChatGPT action. Try again.',
		},
		{
			host: 'studio ui with the server not answering',
			failure: () => new Error( 'GET /chatgpt failed (502): Bad Gateway' ),
			shown: 'Try again.',
		},
	] )(
		'says why the ChatGPT accounts couldn’t be checked in $host and retries from the notice, sending nothing meanwhile',
		async ( { failure, shown } ) => {
			const { connector, queryClient, runs } = await setup();
			connector.getChatGptSettings.mockRejectedValue( failure() );
			await act( () => queryClient.refetchQueries( { queryKey: CHATGPT_SETTINGS_QUERY_KEY } ) );

			expect(
				await screen.findByText( `Couldn’t check your ChatGPT accounts. ${ shown }` )
			).toBeVisible();
			expect( screen.queryByText( /GET \/chatgpt|Bad Gateway/ ) ).not.toBeInTheDocument();
			send( 'Held request' );
			await act( async () => {} );
			expect( runs ).toHaveLength( 0 );

			connector.getChatGptSettings.mockImplementation( async () =>
				structuredClone( connector.state.chatGpt )
			);
			fireEvent.click( screen.getByRole( 'button', { name: 'Retry' } ) );

			await waitFor( () =>
				expect(
					screen.queryByText( /Couldn’t check your ChatGPT accounts/ )
				).not.toBeInTheDocument()
			);
			expect( connector.recheckChatGptSettings ).toHaveBeenCalledTimes( 1 );
			send( 'Following request' );
			await waitFor( () => expect( runs ).toHaveLength( 1 ) );
			expect( runs[ 0 ].selection ).toEqual( INITIAL );
		}
	);

	it.each( [
		[
			'signed-out',
			'The ChatGPT account this chat runs on is signed out. Sign in to that account again to continue this chat; the conversation stays as it is.',
		],
		[
			'needs-sign-in',
			'The ChatGPT account this chat runs on needs you to sign in again. Sign in to that account again to continue this chat; the conversation stays as it is.',
		],
	] as const )(
		'says signing in again to its %s account continues the chat, and opens Settings on that account, not the first',
		async ( state, text ) => {
			const { connector, queryClient, runs } = await setup( [
				pin( { ...INITIAL, connectionId: B } ),
			] );
			connector.state.chatGpt.accounts[ 1 ] = {
				...account( B, WORK ),
				authStatus: 'disconnected',
				state,
			};
			await act( () => queryClient.refetchQueries( { queryKey: CHATGPT_SETTINGS_QUERY_KEY } ) );

			expect( await screen.findByText( text ) ).toBeVisible();
			expect( screen.queryByText( /Start a new chat/ ) ).not.toBeInTheDocument();
			send( 'Held request' );
			await act( async () => {} );
			expect( runs ).toHaveLength( 0 );
			fireEvent.click( screen.getByRole( 'button', { name: 'Manage ChatGPT' } ) );

			const dialog = await screen.findByRole( 'dialog', { name: 'Settings' } );
			const group = await within( dialog ).findByRole( 'group', { name: 'ChatGPT plan' } );
			expect(
				within( group ).getByRole( 'combobox', { name: 'Saved ChatGPT account' } )
			).toHaveTextContent( WORK );
			const signIn = within( group ).getByRole( 'button', { name: 'Sign in again' } );
			expect( signIn ).toHaveAttribute( 'data-variant', 'accent' );
			expect( within( group ).getByRole( 'button', { name: 'Add account' } ) ).toHaveAttribute(
				'data-variant',
				'outline'
			);
			await waitFor( () =>
				expect( document.querySelector( '[data-settings-match]' ) ).toHaveAccessibleName(
					'ChatGPT sign-in'
				)
			);
			fireEvent.click( signIn );
			await waitFor( () =>
				expect( connector.beginChatGptSignIn ).toHaveBeenCalledWith( B, { storage: 'vault' } )
			);
		}
	);

	it( 'keeps saying a new chat is needed once the connection has changed, and opens Settings on the chat’s account', async () => {
		const { connector, queryClient } = await setup( [ pin( { ...INITIAL, connectionId: B } ) ] );
		connector.state.chatGpt.accounts[ 1 ] = { ...account( B, WORK ), revision: 2 };
		await act( () => queryClient.refetchQueries( { queryKey: CHATGPT_SETTINGS_QUERY_KEY } ) );

		expect(
			await screen.findByText(
				'The ChatGPT connection this chat ran on has changed since, so the chat can’t continue. Start a new chat.'
			)
		).toBeVisible();
		fireEvent.click( screen.getByRole( 'button', { name: 'Manage ChatGPT' } ) );

		const dialog = await screen.findByRole( 'dialog', { name: 'Settings' } );
		const group = await within( dialog ).findByRole( 'group', { name: 'ChatGPT plan' } );
		expect(
			within( group ).getByRole( 'combobox', { name: 'Saved ChatGPT account' } )
		).toHaveTextContent( WORK );
		expect( within( group ).getByRole( 'button', { name: 'Add account' } ) ).toHaveAttribute(
			'data-variant',
			'accent'
		);
	} );

	it( 'holds a chat that ran on ChatGPT once ChatGPT plans are turned off, offering no ChatGPT account', async () => {
		const { connector, queryClient, runs } = await setup();
		connector.state.chatGpt = {
			enabled: false,
			signInSupported: false,
			secureStorage: 'unavailable',
			accounts: [],
		};
		await act( () => queryClient.refetchQueries( { queryKey: CHATGPT_SETTINGS_QUERY_KEY } ) );

		expect(
			await screen.findByText( 'ChatGPT plan connections are not enabled in this app.' )
		).toBeVisible();
		send( 'Held request' );
		await act( async () => {} );
		expect( runs ).toHaveLength( 0 );
		fireEvent.click( screen.getByRole( 'button', { name: 'Model' } ) );
		expect( await screen.findByRole( 'listbox', { name: 'Choose a model' } ) ).toBeVisible();
		expect( screen.queryByRole( 'group', { name: /^ChatGPT plan/ } ) ).not.toBeInTheDocument();
		expect( connector.getChatGptModels ).not.toHaveBeenCalledWith( B, 1 );
		expect( connector.setSessionChatGptSelection ).not.toHaveBeenCalled();
		expect( readChatGptSessionSelection( connector.state.sessions[ 0 ].entries ) ).toEqual(
			INITIAL
		);
	} );

	it( 'holds queued messages after the selected account disconnects, even with another account and an API key', async () => {
		const { connector, queryClient, runs } = await setup( [ pin( INITIAL ) ], true );
		send( 'First request' );
		await waitFor( () => expect( runs ).toHaveLength( 1 ) );
		send( 'Queued private request' );
		await screen.findByText( 'Queued private request' );
		connector.state.chatGpt.accounts[ 0 ] = {
			...account( A, PERSONAL ),
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
		await waitFor( () =>
			expect(
				screen.getByText( /The ChatGPT account this chat runs on is signed out\./ )
			).toBeVisible()
		);
		expect( screen.getByText( 'Queued private request' ) ).toBeVisible();
		expect( runs ).toHaveLength( 1 );
		expect( connector.setSessionProvider ).not.toHaveBeenCalled();
	} );
} );
