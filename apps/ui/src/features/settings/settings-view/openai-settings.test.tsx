import {
	OPENAI_MODEL_CATALOG_VERSION,
	OPENAI_MODEL_IDS,
} from '@studio/agent/protocol/openai-models';
import { createDisconnectedOpenAiSettings } from '@studio/agent/protocol/providers';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAppMessagesForTests } from '@/data/app-messages';
import { createFakeConnector, makeSite } from '@/test/fake-connector';
import { renderApp } from '@/test/render';
import type { Connector } from '@/data/core';
import type { AiSettings, OpenAiProviderSettings } from '@studio/agent/protocol/providers';

vi.setConfig( { testTimeout: 30_000 } );

// A test key only; nothing here reaches OpenAI.
const KEY = 'sk-proj-TESTONLY_ui_gggggggggggggggggggggggggggwxyz';

beforeEach( () => {
	resetAppMessagesForTests();
	localStorage.clear();
} );

function connectedSettings( openAi: Partial< OpenAiProviderSettings > = {} ): AiSettings {
	return {
		provider: 'wpcom',
		hasAnthropicApiKey: false,
		anthropicApiKeyPreview: null,
		hasOpenAiApiKey: true,
		openAi: {
			...createDisconnectedOpenAiSettings(),
			keyStorage: 'keychain',
			keyHint: '…wxyz',
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

async function openProviders( overrides: Partial< Connector > = {} ) {
	const connector = createFakeConnector(
		{ sites: [ makeSite( { id: 'one' } ) ], user: null },
		overrides
	);
	const view = renderApp( { connector, path: '/sites/one?settings=ai' } );
	await screen.findByRole( 'dialog', { name: 'Settings' } );
	return { ...view, connector };
}

const openAiRow = () =>
	waitFor( () => {
		const row = document.querySelector< HTMLElement >( '[data-setting-id="openai-provider"]' );
		if ( ! row ) {
			throw new Error( 'No OpenAI row' );
		}
		return row;
	} );

async function choose( combobox: string, option: string ) {
	fireEvent.click( await screen.findByRole( 'combobox', { name: combobox } ) );
	const item = await screen.findByRole( 'option', { name: option } );
	fireEvent.pointerDown( item, { pointerType: 'mouse' } );
	fireEvent.click( item );
}

function expectKeyNowhere() {
	expect( document.body ).not.toHaveTextContent( new RegExp( KEY ) );
	for ( const input of document.querySelectorAll( 'input' ) ) {
		expect( input.value ).not.toContain( KEY );
	}
}

async function enterKey( saveLabel = 'Save', explanation?: RegExp ) {
	const connect = await within( await openAiRow() ).findByRole( 'button', {
		name: /^(Connect|Manage)$/,
	} );
	await waitFor( () => expect( connect ).toBeEnabled() );
	fireEvent.click( connect );
	const input = await screen.findByLabelText( 'OpenAI API key', { selector: 'input' } );
	if ( explanation ) {
		expect( screen.getByText( explanation ) ).toBeVisible();
	}
	expect( input ).toHaveAttribute( 'type', 'password' );
	expect( input ).toHaveAttribute( 'autocomplete', 'off' );
	fireEvent.change( input, { target: { value: `  ${ KEY }  ` } } );
	fireEvent.click(
		within( screen.getByRole( 'form', { name: 'OpenAI connection' } ) ).getByRole( 'button', {
			name: saveLabel,
		} )
	);
	return input as HTMLInputElement;
}

const modelMenu = () => screen.getByRole( 'combobox', { name: 'Default OpenAI model' } );
const effortMenu = () => screen.getByRole( 'combobox', { name: 'Reasoning effort' } );

// Connects a key and saves GPT-6 Luna with no reasoning, an effort GPT-6 Astra lacks.
async function chooseLunaWithNoReasoning() {
	await enterKey();
	await choose( 'Default OpenAI model', 'GPT-6 Luna' );
	await waitFor( () => expect( modelMenu() ).toHaveTextContent( 'GPT-6 Luna' ) );
	await choose( 'Reasoning effort', 'None' );
	await waitFor( () => expect( effortMenu() ).toHaveTextContent( 'None' ) );
}

describe( 'OpenAI settings', () => {
	it( 'connects a key without WordPress.com, keeping only its last characters on screen', async () => {
		const { connector } = await openProviders();

		await enterKey();

		await waitFor( () =>
			expect( connector.saveOpenAiApiKey ).toHaveBeenCalledWith( KEY, 'keychain' )
		);
		await waitFor( () =>
			expect( screen.queryByLabelText( 'OpenAI API key' ) ).not.toBeInTheDocument()
		);
		const row = await openAiRow();
		expect( within( row ).getByText( 'Connected' ) ).toBeVisible();
		expect( within( row ).getByText( /ending …wxyz/ ) ).toBeVisible();
		expect( within( row ).getByRole( 'button', { name: 'Manage' } ) ).toBeVisible();
		expect( await screen.findByRole( 'button', { name: 'Refresh' } ) ).toBeVisible();
		expect(
			screen.getByText( /out of its settings, chats and logs.*doesn’t isolate it/ )
		).toBeVisible();
		expect(
			screen.getByText( /Image generation in chats uses your WordPress\.com/ )
		).toBeVisible();
		expectKeyNowhere();
		expect( connector.authenticate ).not.toHaveBeenCalled();
	} );

	it( 'offers a key for this session only when the machine has no keychain', async () => {
		let settings = connectedSettings( { secureStorage: 'unavailable' } );
		settings = {
			...settings,
			hasOpenAiApiKey: false,
			openAi: { ...settings.openAi, keyStorage: null, keyHint: null },
		};
		const { connector } = await openProviders( {
			getAiSettings: async () => settings,
			saveOpenAiApiKey: async ( _key, storage ) => {
				settings = connectedSettings( { secureStorage: 'unavailable', keyStorage: storage } );
				return settings;
			},
		} );

		await enterKey(
			'Use for this session',
			/keychain isn’t available.*kept only until Studio quits/
		);

		await waitFor( () =>
			expect( connector.saveOpenAiApiKey ).toHaveBeenCalledWith( KEY, 'session' )
		);
		expect( await within( await openAiRow() ).findByText( 'This session only' ) ).toBeVisible();
		expect(
			await screen.findByText( /keeps this key in memory until it quits.*doesn’t isolate the key/ )
		).toBeVisible();
		expect( screen.queryByText( /keeps your key in the system keychain/ ) ).not.toBeInTheDocument();
		expectKeyNowhere();
	} );

	it( 'shows why OpenAI refused a key, without keeping the key in the field', async () => {
		const { connector } = await openProviders();
		connector.saveOpenAiApiKey.mockRejectedValueOnce(
			new Error( 'OpenAI didn’t accept the API key. Replace it in Settings → AI. (HTTP 401)' )
		);

		const input = await enterKey();

		expect( await screen.findByText( /OpenAI didn’t accept the API key/ ) ).toBeVisible();
		expect( input ).toHaveValue( '' );
		expect( screen.queryByRole( 'button', { name: 'Refresh' } ) ).not.toBeInTheDocument();
		expectKeyNowhere();
	} );

	it( 'removes the key', async () => {
		const { connector } = await openProviders();
		await enterKey();
		await screen.findByRole( 'button', { name: 'Refresh' } );

		fireEvent.click( await within( await openAiRow() ).findByRole( 'button', { name: 'Manage' } ) );
		fireEvent.click( await screen.findByRole( 'button', { name: 'Remove key' } ) );

		await waitFor( () => expect( connector.removeOpenAiApiKey ).toHaveBeenCalled() );
		expect(
			await within( await openAiRow() ).findByRole( 'button', { name: 'Connect' } )
		).toBeVisible();
		expect( screen.queryByRole( 'button', { name: 'Refresh' } ) ).not.toBeInTheDocument();
	} );

	it( 'shows why a key couldn’t be removed, and reloads what is left', async () => {
		const { connector } = await openProviders();
		await enterKey();
		await screen.findByRole( 'button', { name: 'Refresh' } );
		connector.removeOpenAiApiKey.mockRejectedValueOnce(
			new Error(
				'Studio couldn’t reach the system keychain to remove the key. Couldn’t open the system keychain: locked'
			)
		);
		const reads = connector.getAiSettings.mock.calls.length;

		fireEvent.click( await within( await openAiRow() ).findByRole( 'button', { name: 'Manage' } ) );
		fireEvent.click( await screen.findByRole( 'button', { name: 'Remove key' } ) );

		expect( await screen.findByText( /couldn’t reach the system keychain/ ) ).toBeVisible();
		await waitFor( () =>
			expect( connector.getAiSettings.mock.calls.length ).toBeGreaterThan( reads )
		);
	} );

	it( 'explains a key that can’t list models, and refreshes the list', async () => {
		const { connector } = await openProviders( {
			getAiSettings: async () =>
				connectedSettings( {
					models: {
						checkedAt: null,
						availableModelIds: null,
						catalogVersion: null,
						lastError: { kind: 'permission', status: 403, code: 'missing_scope' },
					},
				} ),
		} );

		expect( await screen.findByText( /doesn’t have permission/ ) ).toBeVisible();
		expect( screen.getByText( /hasn’t confirmed which models/ ) ).toBeVisible();
		fireEvent.click( screen.getByRole( 'button', { name: 'Refresh' } ) );
		await waitFor( () => expect( connector.refreshOpenAiModels ).toHaveBeenCalled() );
	} );

	it( 'saves defaults the model supports, keeping the effort when it can', async () => {
		const { connector } = await openProviders();
		await enterKey();
		await screen.findByRole( 'button', { name: 'Refresh' } );

		await choose( 'Default OpenAI model', 'GPT-6 Astra' );
		await waitFor( () =>
			expect( connector.setOpenAiDefaults ).toHaveBeenCalledWith( { model: 'gpt-6-astra' } )
		);

		// Astra has no "None" effort.
		fireEvent.click( await screen.findByRole( 'combobox', { name: 'Reasoning effort' } ) );
		expect( await screen.findByRole( 'option', { name: 'Max' } ) ).toBeVisible();
		expect( screen.queryByRole( 'option', { name: 'None' } ) ).not.toBeInTheDocument();
		fireEvent.keyDown( document.activeElement!, { key: 'Escape' } );

		await choose( 'Reasoning effort', 'Max' );
		await waitFor( () =>
			expect( connector.setOpenAiDefaults ).toHaveBeenLastCalledWith( { reasoningEffort: 'max' } )
		);
		await choose( 'Reasoning mode', 'Pro' );
		await waitFor( () =>
			expect( connector.setOpenAiDefaults ).toHaveBeenLastCalledWith( { reasoningMode: 'pro' } )
		);
	} );

	it( 'keeps an effort another app saved when only the model changes here', async () => {
		const { connector } = await openProviders();
		await enterKey();
		expect( await screen.findByRole( 'combobox', { name: 'Reasoning effort' } ) ).toHaveTextContent(
			'Medium'
		);

		// Another app saves High while this one still shows Medium.
		await connector.setOpenAiDefaults( { reasoningEffort: 'high' } );
		await choose( 'Default OpenAI model', 'GPT-6 Astra' );

		await waitFor( () => expect( modelMenu() ).toHaveTextContent( 'GPT-6 Astra' ) );
		expect( effortMenu() ).toHaveTextContent( 'High' );
	} );

	it( 'gives a new model its starting effort when it lacks the saved one', async () => {
		const { connector } = await openProviders();
		await chooseLunaWithNoReasoning();

		await choose( 'Default OpenAI model', 'GPT-6 Astra' );

		await waitFor( () => expect( modelMenu() ).toHaveTextContent( 'GPT-6 Astra' ) );
		expect( effortMenu() ).toHaveTextContent( 'Medium' );
		expect( connector.setOpenAiDefaults ).toHaveBeenLastCalledWith( { model: 'gpt-6-astra' } );
	} );

	it( 'keeps an effort another app saved over the starting one this view would pick', async () => {
		const { connector } = await openProviders();
		await chooseLunaWithNoReasoning();

		// Another app saves High, which Astra has, while this one still shows None, which it lacks.
		await connector.setOpenAiDefaults( { reasoningEffort: 'high' } );
		await choose( 'Default OpenAI model', 'GPT-6 Astra' );

		await waitFor( () => expect( modelMenu() ).toHaveTextContent( 'GPT-6 Astra' ) );
		expect( effortMenu() ).toHaveTextContent( 'High' );
	} );

	it( 'says why the keychain couldn’t return the key, and still offers to remove it', async () => {
		const reason = 'Couldn’t read from the system keychain: User interaction is not allowed.';
		const { connector } = await openProviders( {
			getAiSettings: async () => ( {
				...connectedSettings( { keyStorage: null, keyHint: null, keyError: reason } ),
				hasOpenAiApiKey: false,
			} ),
		} );

		const row = await openAiRow();
		expect(
			await within( row ).findByText( /couldn’t read the key from the system keychain/ )
		).toHaveTextContent( reason );
		fireEvent.click( within( row ).getByRole( 'button', { name: 'Manage' } ) );
		fireEvent.click( await screen.findByRole( 'button', { name: 'Remove key' } ) );

		await waitFor( () => expect( connector.removeOpenAiApiKey ).toHaveBeenCalled() );
	} );

	it( 'keeps the output token limit within the model’s documented maximum', async () => {
		const { connector } = await openProviders();
		await enterKey();
		const limit = await screen.findByRole( 'spinbutton', { name: 'Output token limit' } );
		expect( limit ).toHaveValue( 32_000 );
		expect( limit ).toHaveAttribute( 'max', '128000' );
		expect( screen.getByText( /Reasoning tokens count toward it/ ) ).toBeVisible();

		fireEvent.change( limit, { target: { value: '200000' } } );
		fireEvent.keyDown( limit, { key: 'Enter' } );

		await waitFor( () =>
			expect( connector.setOpenAiDefaults ).toHaveBeenCalledWith( { maxOutputTokens: 200_000 } )
		);
		expect(
			await screen.findByText( /must be a whole number from 1,024 to 128,000/ )
		).toBeVisible();
	} );

	it( 'marks models the project doesn’t list as unavailable', async () => {
		await openProviders( {
			getAiSettings: async () =>
				connectedSettings( {
					models: {
						checkedAt: '2026-11-07T12:00:00.000Z',
						availableModelIds: [ 'gpt-6.1-sol' ],
						catalogVersion: OPENAI_MODEL_CATALOG_VERSION,
						lastError: null,
					},
				} ),
		} );

		expect( await screen.findByText( /Your project lists GPT-6\.1 Sol\./ ) ).toBeVisible();
		fireEvent.click( await screen.findByRole( 'combobox', { name: 'Default OpenAI model' } ) );
		expect(
			await screen.findByRole( 'option', { name: 'GPT-6 Astra (not in your project)' } )
		).toHaveAttribute( 'aria-disabled', 'true' );
	} );

	it( 'lets new chats default to OpenAI once it is connected', async () => {
		const { connector } = await openProviders();
		await enterKey();
		await screen.findByRole( 'button', { name: 'Refresh' } );

		await choose( 'Default provider', 'OpenAI API' );

		await waitFor( () =>
			expect( connector.setAiProvider ).toHaveBeenCalledWith( 'openai-api-key' )
		);
	} );
} );
