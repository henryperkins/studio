import {
	OPENAI_MODEL_CATALOG_VERSION,
	OPENAI_MODEL_IDS,
} from '@studio/agent/protocol/openai-models';
import { createDisconnectedOpenAiSettings } from '@studio/agent/protocol/providers';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createFakeConnector, makeSession, makeSite } from '@/test/fake-connector';
import { renderApp } from '@/test/render';
import type { SessionEntry } from '@/data/core';
import type { AiSettings, OpenAiProviderSettings } from '@studio/agent/protocol/providers';

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
