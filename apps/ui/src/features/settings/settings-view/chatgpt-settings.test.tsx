import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeConnector, makeSite } from '@/test/fake-connector';
import { renderApp } from '@/test/render';
import type { Connector } from '@/data/core';
import type {
	ChatGptAccountView,
	ChatGptSettings,
	ChatGptSignInOutcome,
} from '@studio/agent/protocol/chatgpt';

const ACCOUNT_A = 'f84d75a0-4e60-4168-a1ab-3134542c637a';
const ACCOUNT_B = '1c8e270b-9b5c-4687-b989-de052014b9e8';
const ATTEMPT = 'b69a1ddf-d1a2-4ff6-b293-75c358ff42df';

function account( connectionId = ACCOUNT_A, label = 'Personal' ): ChatGptAccountView {
	return {
		connectionId,
		providerId: 'chatgpt-oauth',
		backend: 'pi',
		revision: 1,
		identity: { subject: connectionId, email: 'same@example.test' },
		authStatus: 'connected',
		label,
		email: 'same@example.test',
		storage: 'vault',
		state: 'signed-in',
	};
}

function deferred< T >() {
	let resolve!: ( value: T ) => void;
	const promise = new Promise< T >( ( done ) => ( resolve = done ) );
	return { promise, resolve };
}

async function openSettings(
	initial: Partial< ChatGptSettings > = {},
	overrides: Partial< Connector > = {}
) {
	const settings: ChatGptSettings = {
		enabled: true,
		signInSupported: true,
		secureStorage: 'available',
		accounts: [],
		...initial,
	};
	const outcome = deferred< ChatGptSignInOutcome >();
	const connector = createFakeConnector(
		{ sites: [ makeSite( { id: 'one' } ) ], user: null },
		{
			getChatGptSettings: async () => structuredClone( settings ),
			beginChatGptSignIn: async () => ( { attemptId: ATTEMPT } ),
			waitForChatGptSignIn: () => outcome.promise,
			cancelChatGptSignIn: async () => {
				outcome.resolve( { ok: false, code: 'cancelled', message: 'Signing in was cancelled.' } );
				return true;
			},
			getChatGptModels: async ( connectionId, revision ) => ( {
				connectionId,
				revision,
				checkedAt: '2026-11-10T10:00:00Z',
				models: [ { id: 'gpt-6-luna', label: 'GPT-6 Luna' } ],
				lastError: null,
			} ),
			signOutChatGpt: async ( connectionId ) => {
				settings.accounts = settings.accounts.map( ( item ) =>
					item.connectionId === connectionId
						? { ...item, state: 'signed-out', authStatus: 'disconnected' }
						: item
				);
				return { localCleared: true, remoteRevocationConfirmed: true };
			},
			...overrides,
		}
	);
	const view = renderApp( { connector, path: '/sites/one?settings=ai' } );
	await screen.findByRole( 'dialog', { name: 'Settings' } );
	return { ...view, connector, settings, outcome };
}

beforeEach( () => localStorage.clear() );

describe( 'ChatGPT account settings', () => {
	it( 'shows a pending sign-in and cancels it without connecting an account', async () => {
		const { connector } = await openSettings();
		fireEvent.click( await screen.findByRole( 'button', { name: 'Start sign-in' } ) );
		expect(
			await screen.findByRole( 'status', { name: 'ChatGPT sign-in status' } )
		).toHaveTextContent( /Complete sign-in in your browser/ );
		fireEvent.click( screen.getByRole( 'button', { name: 'Cancel sign-in' } ) );
		await waitFor( () => expect( connector.cancelChatGptSignIn ).toHaveBeenCalledWith( ATTEMPT ) );
		expect( await screen.findByText( 'Signing in was cancelled.' ) ).toBeVisible();
		expect( screen.queryByText( 'Connected' ) ).not.toBeInTheDocument();
		expect( connector.openExternalUrl ).not.toHaveBeenCalled();
	} );

	it.each( [ 'denied', 'permission-missing' ] as const )(
		'keeps the saved account when a new sign-in ends with %s',
		async ( code ) => {
			const { connector, outcome } = await openSettings( { accounts: [ account() ] } );
			fireEvent.click( await screen.findByRole( 'button', { name: 'Add account' } ) );
			await waitFor( () => expect( connector.waitForChatGptSignIn ).toHaveBeenCalled() );
			await act( async () =>
				outcome.resolve( { ok: false, code, message: 'Access was not granted.' } )
			);
			expect( await screen.findByText( 'Access was not granted.' ) ).toBeVisible();
			expect( screen.getByRole( 'combobox', { name: 'Saved ChatGPT account' } ) ).toHaveTextContent(
				'Personal'
			);
			expect( screen.getByText( 'Connected' ) ).toBeVisible();
			expect( connector.signOutChatGpt ).not.toHaveBeenCalled();
		}
	);

	it( 'selects registrations with the same email, reauthenticates and signs out only the selected one', async () => {
		const { connector, outcome } = await openSettings( {
			accounts: [ account(), account( ACCOUNT_B, 'Work' ) ],
		} );
		fireEvent.click( await screen.findByRole( 'combobox', { name: 'Saved ChatGPT account' } ) );
		const option = await screen.findByRole( 'option', { name: /Work/ } );
		fireEvent.pointerDown( option, { pointerType: 'mouse' } );
		fireEvent.click( option );
		fireEvent.click( screen.getByRole( 'button', { name: 'Sign in again' } ) );
		await waitFor( () =>
			expect( connector.beginChatGptSignIn ).toHaveBeenCalledWith( ACCOUNT_B, { storage: 'vault' } )
		);
		await act( async () =>
			outcome.resolve( {
				ok: true,
				registrationId: ACCOUNT_B,
				label: 'Work',
				email: 'same@example.test',
			} )
		);
		fireEvent.click( await screen.findByRole( 'button', { name: 'Sign out' } ) );
		await waitFor( () =>
			expect( connector.signOutChatGpt ).toHaveBeenCalledExactlyOnceWith( ACCOUNT_B )
		);
		expect( await screen.findByText( /Remote revocation confirmed/ ) ).toBeVisible();
		expect( screen.getByText( 'Signed out' ) ).toBeVisible();
	} );

	it( 'requires an explicit session-only choice when secure storage is unavailable', async () => {
		const { connector } = await openSettings( { secureStorage: 'unavailable' } );
		const start = await screen.findByRole( 'button', { name: 'Start sign-in' } );
		expect( start ).toBeDisabled();
		fireEvent.click( screen.getByRole( 'combobox', { name: 'Keep ChatGPT sign-in' } ) );
		const option = await screen.findByRole( 'option', { name: 'This app session' } );
		fireEvent.pointerDown( option, { pointerType: 'mouse' } );
		fireEvent.click( option );
		fireEvent.click( start );
		await waitFor( () =>
			expect( connector.beginChatGptSignIn ).toHaveBeenCalledWith( undefined, {
				storage: 'session',
			} )
		);
	} );

	it( 'explains callback-host restrictions and keeps sign-in unavailable', async () => {
		const { connector } = await openSettings( { signInSupported: false } );
		expect( await screen.findByText( /Open Studio on localhost/ ) ).toBeVisible();
		expect( screen.getByRole( 'button', { name: 'Start sign-in' } ) ).toBeDisabled();
		expect( connector.beginChatGptSignIn ).not.toHaveBeenCalled();
	} );

	it( 'refreshes the selected account’s models and offers no output cap or unsupported mode', async () => {
		const { connector } = await openSettings( { accounts: [ account() ] } );
		const group = await screen.findByRole( 'group', { name: 'ChatGPT plan' } );
		fireEvent.click( within( group ).getByRole( 'button', { name: 'Refresh models' } ) );
		await waitFor( () =>
			expect( connector.getChatGptModels ).toHaveBeenCalledWith( ACCOUNT_A, 1 )
		);
		expect( await within( group ).findByText( /GPT-6 Luna/ ) ).toBeVisible();
		expect( within( group ).queryByRole( 'spinbutton' ) ).not.toBeInTheDocument();
		expect( within( group ).queryByRole( 'combobox', { name: /mode/i } ) ).not.toBeInTheDocument();
	} );

	it( 'cancels an attempt that finishes starting after Settings closes', async () => {
		const beginning = deferred< { attemptId: string } >();
		const { connector, unmount } = await openSettings(
			{},
			{ beginChatGptSignIn: () => beginning.promise }
		);
		fireEvent.click( await screen.findByRole( 'button', { name: 'Start sign-in' } ) );
		await waitFor( () => expect( connector.beginChatGptSignIn ).toHaveBeenCalled() );
		unmount();
		await act( async () => beginning.resolve( { attemptId: ATTEMPT } ) );
		await waitFor( () => expect( connector.cancelChatGptSignIn ).toHaveBeenCalledWith( ATTEMPT ) );
	} );
} );
