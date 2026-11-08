import {
	OPENAI_MODEL_CATALOG_VERSION,
	OPENAI_MODEL_IDS,
	resolveOpenAiSessionSelection,
} from '@studio/agent/protocol/openai-models';
import { createDisconnectedOpenAiSettings } from '@studio/agent/protocol/providers';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getVisibleToasts } from '@/data/app-messages';
import {
	createFakeConnector,
	makeSession,
	makeSite,
	type FakeConnector,
} from '@/test/fake-connector';
import { renderApp } from '@/test/render';
import type { SessionEntry } from '@/data/core';
import type {
	AiSettings,
	OpenAiProviderSettings,
	OpenAiSessionSelection,
} from '@studio/agent/protocol/providers';

vi.setConfig( { testTimeout: 30_000 } );

const SITE_ID = 'openai-site';
const COMPOSER = { name: 'Message WordPress Studio' };

const pin = ( data: Record< string, unknown > ): SessionEntry =>
	( {
		type: 'custom',
		id: Math.random().toString( 36 ).slice( 2 ),
		parentId: null,
		timestamp: new Date( 0 ).toISOString(),
		customType: 'studio.session_context',
		data: { provider: 'openai-api-key', ...data },
	} ) as unknown as SessionEntry;

function settings( {
	hasOpenAiApiKey = true,
	openAi = {},
}: {
	hasOpenAiApiKey?: boolean;
	openAi?: Partial< OpenAiProviderSettings >;
} = {} ): AiSettings {
	return {
		provider: 'wpcom',
		hasAnthropicApiKey: false,
		anthropicApiKeyPreview: null,
		hasOpenAiApiKey,
		openAi: {
			...createDisconnectedOpenAiSettings(),
			keyStorage: hasOpenAiApiKey ? 'keychain' : null,
			keyHint: hasOpenAiApiKey ? '…wxyz' : null,
			models: {
				checkedAt: '2026-11-07T12:00:00.000Z',
				availableModelIds: [ ...OPENAI_MODEL_IDS ],
				catalogVersion: OPENAI_MODEL_CATALOG_VERSION,
				lastError: null,
			},
			...openAi,
		},
	};
}

// A saved chat on OpenAI, with no WordPress.com login at all.
async function setupChat( entries: SessionEntry[], aiSettings = settings() ) {
	const connector = createFakeConnector(
		{
			user: null,
			sites: [ makeSite( { id: SITE_ID, name: 'Example' } ) ],
			sessions: [
				{
					summary: makeSession( { id: 'chat', ownerSiteId: SITE_ID, firstPrompt: 'Hello' } ),
					entries,
				},
			],
		},
		{ getAiSettings: async () => aiSettings }
	);
	const view = renderApp( { connector, path: '/sessions/chat' } );
	await waitFor( () => expect( connector.getAiSettings ).toHaveBeenCalled() );
	await waitFor( () => expect( view.queryClient.isFetching() ).toBe( 0 ) );
	const input = await screen.findByRole( 'combobox', COMPOSER );
	return { ...view, connector, input };
}

function send( input: HTMLElement, text = 'Make the header blue' ) {
	fireEvent.change( input, { target: { value: text } } );
	fireEvent.keyDown( input, { key: 'Enter' } );
}

describe( 'OpenAI chats', () => {
	it( 'run without WordPress.com, showing the model and reasoning they use', async () => {
		const { connector, input } = await setupChat( [
			pin( { model: 'gpt-6-astra', reasoningEffort: 'xhigh', reasoningMode: 'pro' } ),
		] );

		expect( screen.getByRole( 'button', { name: 'Model' } ) ).toHaveTextContent( 'GPT-6 Astra' );
		expect( screen.getByRole( 'button', { name: 'Model' } ) ).toHaveAccessibleDescription(
			/OpenAI API/
		);
		expect( screen.getByRole( 'button', { name: 'Reasoning' } ) ).toHaveTextContent(
			'Extra high · Pro'
		);
		expect( screen.queryByRole( 'button', { name: 'Connect' } ) ).not.toBeInTheDocument();

		send( input );

		await waitFor( () =>
			expect( connector.continueSession ).toHaveBeenCalledWith(
				'chat',
				'Make the header blue',
				expect.anything()
			)
		);
	} );

	it( 'changes reasoning for the next message only through the chat’s own entry', async () => {
		const { connector } = await setupChat( [
			pin( { model: 'gpt-6-astra', reasoningEffort: 'xhigh', reasoningMode: 'pro' } ),
		] );

		fireEvent.click( screen.getByRole( 'button', { name: 'Reasoning' } ) );
		const efforts = await screen.findByRole( 'group', { name: 'Reasoning effort' } );
		// Astra has no "None" effort, so none is offered.
		expect(
			within( efforts ).queryByRole( 'menuitemradio', { name: 'None' } )
		).not.toBeInTheDocument();
		fireEvent.click( within( efforts ).getByRole( 'menuitemradio', { name: 'Low' } ) );

		await waitFor( () =>
			expect( connector.setSessionOpenAiSelection ).toHaveBeenCalledWith( 'chat', {
				model: 'gpt-6-astra',
				reasoningEffort: 'low',
				reasoningMode: 'pro',
			} )
		);
		expect( screen.getByRole( 'button', { name: 'Reasoning' } ) ).toHaveTextContent( 'Low · Pro' );
		expect( connector.setAiProvider ).not.toHaveBeenCalled();
	} );

	async function chooseEffort( label: string ) {
		fireEvent.click( screen.getByRole( 'button', { name: 'Reasoning' } ) );
		fireEvent.click(
			within( await screen.findByRole( 'group', { name: 'Reasoning effort' } ) ).getByRole(
				'menuitemradio',
				{ name: label }
			)
		);
	}
	const MEDIUM = { model: 'gpt-6.1-sol', reasoningEffort: 'medium', reasoningMode: 'standard' };

	it( 'sends only once the reasoning change shown is saved', async () => {
		const { connector, input } = await setupChat( [ pin( MEDIUM ) ] );
		let finishSave!: () => void;
		connector.setSessionOpenAiSelection.mockImplementationOnce(
			() => new Promise< void >( ( resolve ) => ( finishSave = resolve ) )
		);

		await chooseEffort( 'High' );
		await waitFor( () =>
			expect( screen.getByRole( 'button', { name: 'Reasoning' } ) ).toHaveTextContent( 'High' )
		);
		send( input );

		// Sent now, the turn would read the Medium still on disk.
		await act( () => new Promise( ( resolve ) => setTimeout( resolve, 50 ) ) );
		expect( connector.continueSession ).not.toHaveBeenCalled();

		act( () => finishSave() );
		await waitFor( () => expect( connector.continueSession ).toHaveBeenCalled() );
	} );

	it( 'doesn’t send when the reasoning change fails to save, and says so', async () => {
		const { connector, input } = await setupChat( [ pin( MEDIUM ) ] );
		connector.setSessionOpenAiSelection.mockRejectedValueOnce( new Error( 'Disk full.' ) );

		await chooseEffort( 'High' );
		send( input );

		await waitFor( () =>
			expect(
				getVisibleToasts()
					.filter( ( toast ) => toast.intent === 'error' )
					.map( ( toast ) => toast.title )
			).toContainEqual( expect.stringMatching( /reasoning change wasn’t saved.*Disk full/ ) )
		);
		expect( connector.continueSession ).not.toHaveBeenCalled();
		// The picker shows what the chat still uses.
		await waitFor( () =>
			expect( screen.getByRole( 'button', { name: 'Reasoning' } ) ).toHaveTextContent( 'Medium' )
		);
	} );

	it( 'saves reasoning changes one at a time, in the order they were made', async () => {
		const { connector, input } = await setupChat( [ pin( MEDIUM ) ] );
		const saves: Array< () => void > = [];
		connector.setSessionOpenAiSelection.mockImplementation(
			() => new Promise< void >( ( resolve ) => saves.push( resolve ) )
		);

		await chooseEffort( 'High' );
		await chooseEffort( 'Low' );
		send( input );

		await waitFor( () => expect( connector.setSessionOpenAiSelection ).toHaveBeenCalledTimes( 1 ) );
		// The second save waits for the first, so the older choice can't land last.
		act( () => saves[ 0 ]() );
		await waitFor( () => expect( connector.setSessionOpenAiSelection ).toHaveBeenCalledTimes( 2 ) );
		expect( connector.setSessionOpenAiSelection.mock.calls[ 1 ][ 1 ] ).toMatchObject( {
			reasoningEffort: 'low',
		} );
		expect( connector.continueSession ).not.toHaveBeenCalled();

		act( () => saves[ 1 ]() );
		await waitFor( () => expect( connector.continueSession ).toHaveBeenCalled() );
		await waitFor( () =>
			expect( screen.getByRole( 'button', { name: 'Reasoning' } ) ).toHaveTextContent( 'Low' )
		);
	} );

	const reasoningButton = () => screen.getByRole( 'button', { name: 'Reasoning' } );
	const settle = () => act( () => new Promise( ( resolve ) => setTimeout( resolve, 50 ) ) );

	// The chat as the backend keeps it: a save appends its pin, a read returns
	// what is on disk when it starts, and a turn runs with the latest pin.
	function persistedChat( connector: FakeConnector ) {
		const read = () => connector.state.sessions[ 0 ];
		connector.getSession.mockImplementation( async () => ( {
			...read(),
			entries: [ ...read().entries ],
		} ) );
		const efforts: string[] = [];
		connector.continueSession.mockImplementation( async () => {
			efforts.push( resolveOpenAiSessionSelection( read().entries, MEDIUM ).reasoningEffort );
			return { runId: `run-${ efforts.length }` };
		} );
		return {
			read,
			persist( selection: OpenAiSessionSelection ) {
				connector.state.sessions[ 0 ] = {
					...read(),
					entries: [ ...read().entries, pin( { ...selection } ) ],
				};
			},
			// The effort each turn ran with.
			efforts,
		};
	}

	it( 'keeps a newer choice when an older one fails and the chat reloads meanwhile', async () => {
		const { connector, input, queryClient } = await setupChat( [ pin( MEDIUM ) ] );
		const chat = persistedChat( connector );
		const saves: Array< {
			selection: OpenAiSessionSelection;
			resolve: () => void;
			reject: ( error: Error ) => void;
		} > = [];
		connector.setSessionOpenAiSelection.mockImplementation(
			( _id, selection ) =>
				new Promise< void >( ( resolve, reject ) => saves.push( { selection, resolve, reject } ) )
		);

		await chooseEffort( 'High' );
		await chooseEffort( 'Low' );
		await waitFor( () => expect( saves ).toHaveLength( 1 ) );
		// High fails while Low waits, and a reload reads the Medium still on disk.
		await act( async () => {
			saves[ 0 ].reject( new Error( 'Disk full.' ) );
			await queryClient.invalidateQueries( { queryKey: [ 'sessions', 'chat' ] } );
		} );
		expect( reasoningButton() ).toHaveTextContent( 'Low' );

		await waitFor( () => expect( saves ).toHaveLength( 2 ) );
		act( () => {
			chat.persist( saves[ 1 ].selection );
			saves[ 1 ].resolve();
		} );
		await settle();
		expect( reasoningButton() ).toHaveTextContent( 'Low' );

		send( input );
		await waitFor( () => expect( chat.efforts ).toEqual( [ 'low' ] ) );
		expect( reasoningButton() ).toHaveTextContent( 'Low' );
	} );

	it( 'keeps a saved choice when a reload that started before the save lands after it', async () => {
		const { connector, input, queryClient } = await setupChat( [ pin( MEDIUM ) ] );
		const chat = persistedChat( connector );
		let finishSave: ( () => void ) | undefined;
		connector.setSessionOpenAiSelection.mockImplementationOnce(
			( _id, selection ) =>
				new Promise< void >( ( resolve ) => {
					finishSave = () => {
						chat.persist( selection );
						resolve();
					};
				} )
		);
		await chooseEffort( 'Low' );
		await waitFor( () => expect( finishSave ).toBeDefined() );

		// This reload reads Medium while Low saves, and lands after Low is saved.
		let finishRead: ( () => void ) | undefined;
		connector.getSession.mockImplementationOnce( async () => {
			const onDisk = { ...chat.read(), entries: [ ...chat.read().entries ] };
			await new Promise< void >( ( resolve ) => ( finishRead = resolve ) );
			return onDisk;
		} );
		void queryClient.invalidateQueries( { queryKey: [ 'sessions', 'chat' ] } );
		await waitFor( () => expect( finishRead ).toBeDefined() );
		act( () => finishSave!() );
		await settle();
		act( () => finishRead!() );
		await settle();
		expect( reasoningButton() ).toHaveTextContent( 'Low' );

		send( input );
		await waitFor( () => expect( chat.efforts ).toEqual( [ 'low' ] ) );
		// A later reload agrees with what was shown.
		await act( () => queryClient.invalidateQueries( { queryKey: [ 'sessions', 'chat' ] } ) );
		expect( reasoningButton() ).toHaveTextContent( 'Low' );
	} );

	it( 'falls back to the last saved choice when a newer one fails, during a reload', async () => {
		const { connector, input, queryClient } = await setupChat( [ pin( MEDIUM ) ] );
		const chat = persistedChat( connector );
		connector.setSessionOpenAiSelection
			.mockImplementationOnce( async ( _id, selection ) => chat.persist( selection ) )
			.mockRejectedValueOnce( new Error( 'Disk full.' ) );
		// A reload under way throughout, which the saved choice waits out.
		let finishRead: ( () => void ) | undefined;
		connector.getSession.mockImplementationOnce( async () => {
			const onDisk = { ...chat.read(), entries: [ ...chat.read().entries ] };
			await new Promise< void >( ( resolve ) => ( finishRead = resolve ) );
			return onDisk;
		} );
		void queryClient.invalidateQueries( { queryKey: [ 'sessions', 'chat' ] } );
		await waitFor( () => expect( finishRead ).toBeDefined() );

		await chooseEffort( 'High' );
		await chooseEffort( 'Low' );
		await waitFor( () => expect( connector.setSessionOpenAiSelection ).toHaveBeenCalledTimes( 2 ) );
		await settle();
		expect( reasoningButton() ).toHaveTextContent( 'High' );

		// The failure was shown and taken back, so it doesn't hold this message.
		send( input );
		await waitFor( () => expect( chat.efforts ).toEqual( [ 'high' ] ) );
		act( () => finishRead!() );
		await settle();
		expect( reasoningButton() ).toHaveTextContent( 'High' );
	} );

	it( 'writes a model change made while a reasoning change saves after it', async () => {
		const { connector } = await setupChat( [ pin( MEDIUM ) ] );
		let finishSave: ( () => void ) | undefined;
		connector.setSessionOpenAiSelection.mockImplementationOnce(
			() => new Promise< void >( ( resolve ) => ( finishSave = resolve ) )
		);

		await chooseEffort( 'High' );
		fireEvent.click( screen.getByRole( 'button', { name: 'Model' } ) );
		fireEvent.click( await screen.findByRole( 'option', { name: /GPT-6 Luna/ } ) );

		// Shown at once, but written only after the change made before it.
		await waitFor( () =>
			expect( screen.getByRole( 'button', { name: 'Model' } ) ).toHaveTextContent( 'GPT-6 Luna' )
		);
		await settle();
		expect( connector.setSessionModel ).not.toHaveBeenCalled();
		act( () => finishSave!() );
		await waitFor( () =>
			expect( connector.setSessionModel ).toHaveBeenCalledWith( 'chat', 'gpt-6-luna' )
		);
	} );

	it( 'keeps a reasoning change made after sending out of the turn it sent', async () => {
		const { connector, input } = await setupChat( [ pin( MEDIUM ) ] );
		const chat = persistedChat( connector );
		let finishHigh: ( () => void ) | undefined;
		connector.setSessionOpenAiSelection
			.mockImplementationOnce(
				( _id, selection ) =>
					new Promise< void >( ( resolve ) => {
						finishHigh = () => {
							chat.persist( selection );
							resolve();
						};
					} )
			)
			.mockImplementation( async ( _id, selection ) => chat.persist( selection ) );

		// High is still saving when the message is sent; Low is picked before its turn starts.
		await chooseEffort( 'High' );
		send( input );
		await chooseEffort( 'Low' );
		act( () => finishHigh!() );
		await waitFor( () => expect( chat.efforts ).toEqual( [ 'high' ] ) );
		await settle();
		expect( connector.setSessionOpenAiSelection ).toHaveBeenCalledTimes( 1 );
		expect( reasoningButton() ).toHaveTextContent( 'Low' );

		// Low is written once that turn ends, and the next message uses it.
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
		await waitFor( () => expect( connector.setSessionOpenAiSelection ).toHaveBeenCalledTimes( 2 ) );
		expect( connector.setSessionOpenAiSelection.mock.calls[ 1 ][ 1 ] ).toMatchObject( {
			reasoningEffort: 'low',
		} );
		send( input, 'And the footer' );
		await waitFor( () => expect( chat.efforts ).toEqual( [ 'high', 'low' ] ) );
	} );

	it( 'stays on OpenAI, visibly disconnected, after its key is removed', async () => {
		const { connector, input } = await setupChat(
			[ pin( { model: 'gpt-6.1-sol', reasoningEffort: 'medium', reasoningMode: 'standard' } ) ],
			settings( { hasOpenAiApiKey: false } )
		);

		expect(
			await screen.findByText( /OpenAI isn’t connected\. Connect it to continue this chat/ )
		).toBeVisible();
		// No connected provider to pick from, but the chat still shows it is on OpenAI.
		expect( screen.queryByRole( 'button', { name: 'Model' } ) ).not.toBeInTheDocument();
		expect( screen.getByRole( 'button', { name: 'Reasoning' } ) ).toHaveTextContent( 'Medium' );
		send( input );

		expect( connector.continueSession ).not.toHaveBeenCalled();
		expect( connector.setSessionProvider ).not.toHaveBeenCalled();
	} );

	it( 'blocks an effort the model lacks until the user applies the offered fix', async () => {
		const { connector, input } = await setupChat( [
			pin( { model: 'gpt-6-astra', reasoningEffort: 'none', reasoningMode: 'standard' } ),
		] );

		expect(
			await screen.findByText( 'GPT-6 Astra doesn’t support “None” reasoning.' )
		).toBeVisible();
		send( input );
		expect( connector.continueSession ).not.toHaveBeenCalled();

		fireEvent.click( screen.getByRole( 'button', { name: 'Use Medium' } ) );

		await waitFor( () =>
			expect( connector.setSessionOpenAiSelection ).toHaveBeenCalledWith( 'chat', {
				model: 'gpt-6-astra',
				reasoningEffort: 'medium',
				reasoningMode: 'standard',
			} )
		);
		await waitFor( () =>
			expect( screen.queryByText( /doesn’t support “None” reasoning/ ) ).not.toBeInTheDocument()
		);
		send( input );
		await waitFor( () => expect( connector.continueSession ).toHaveBeenCalled() );
	} );

	it( 'reports a model Studio dropped instead of quietly using another', async () => {
		const { connector, input } = await setupChat( [
			pin( { model: 'gpt-5.6-sol', reasoningEffort: 'medium', reasoningMode: 'standard' } ),
		] );

		expect(
			await screen.findByText( /doesn’t support the OpenAI model “gpt-5\.6-sol”/ )
		).toBeVisible();
		send( input );
		expect( connector.continueSession ).not.toHaveBeenCalled();

		fireEvent.click( screen.getByRole( 'button', { name: 'Use GPT-6.1 Sol' } ) );
		await waitFor( () =>
			expect( connector.setSessionOpenAiSelection ).toHaveBeenCalledWith( 'chat', {
				model: 'gpt-6.1-sol',
				reasoningEffort: 'medium',
				reasoningMode: 'standard',
			} )
		);
	} );

	it( 'lists OpenAI models, marking those the project doesn’t list', async () => {
		await setupChat(
			[ pin( { model: 'gpt-6.1-sol', reasoningEffort: 'medium', reasoningMode: 'standard' } ) ],
			settings( {
				openAi: {
					models: {
						checkedAt: '2026-11-07T12:00:00.000Z',
						availableModelIds: [ 'gpt-6.1-sol', 'gpt-6-luna' ],
						catalogVersion: OPENAI_MODEL_CATALOG_VERSION,
						lastError: null,
					},
				},
			} )
		);

		fireEvent.click( screen.getByRole( 'button', { name: 'Model' } ) );

		const luna = await screen.findByRole( 'option', { name: /GPT-6 Luna/ } );
		expect( luna ).not.toHaveAttribute( 'aria-disabled', 'true' );
		const astra = screen.getByRole( 'option', { name: /GPT-6 Astra/ } );
		expect( astra ).toHaveAttribute( 'aria-disabled', 'true' );
		expect( astra ).toHaveTextContent( /Not in your OpenAI project/ );
	} );

	it( 'starts a new chat with the reasoning picked in its draft', async () => {
		const connector = createFakeConnector(
			{ user: null, sites: [ makeSite( { id: SITE_ID, name: 'Example' } ) ] },
			{
				getAiSettings: async () => ( { ...settings(), provider: 'openai-api-key' } ),
			}
		);
		renderApp( { connector, path: `/sites/${ SITE_ID }/new` } );
		const input = await screen.findByRole( 'combobox', COMPOSER );
		const reasoning = await screen.findByRole( 'button', { name: 'Reasoning' } );
		await waitFor( () => expect( reasoning ).toHaveTextContent( 'Medium' ) );

		fireEvent.click( reasoning );
		fireEvent.click(
			within( await screen.findByRole( 'group', { name: 'Reasoning effort' } ) ).getByRole(
				'menuitemradio',
				{ name: 'High' }
			)
		);
		await waitFor( () => expect( reasoning ).toHaveTextContent( 'High' ) );
		// A draft has no session yet; nothing is written until it is sent.
		expect( connector.setSessionOpenAiSelection ).not.toHaveBeenCalled();

		send( input );

		await waitFor( () => expect( connector.continueSession ).toHaveBeenCalled() );
		const [ sessionId ] = connector.continueSession.mock.calls[ 0 ];
		expect( connector.setSessionOpenAiSelection ).toHaveBeenCalledWith( sessionId, {
			model: 'gpt-6.1-sol',
			reasoningEffort: 'high',
			reasoningMode: 'standard',
		} );
		expect( connector.setSessionProvider ).not.toHaveBeenCalled();
	} );
} );
