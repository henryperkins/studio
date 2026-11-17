import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatGptSettingsError, type Connector } from '@/data/core';
import {
	CHATGPT_MODELS_QUERY_KEY,
	CHATGPT_SETTINGS_QUERY_KEY,
} from '@/data/queries/use-chatgpt-settings';
import { createFakeConnector, makeSite } from '@/test/fake-connector';
import { renderApp } from '@/test/render';
import type {
	ChatGptAccountView,
	ChatGptSettings,
	ChatGptSignInOutcome,
} from '@studio/agent/protocol/chatgpt';

const ACCOUNT_A = 'f84d75a0-4e60-4168-a1ab-3134542c637a';
const ACCOUNT_B = '1c8e270b-9b5c-4687-b989-de052014b9e8';
const ATTEMPT = 'b69a1ddf-d1a2-4ff6-b293-75c358ff42df';

// A settings read failing as each app's connector reports it (each connector's
// side is pinned in chatgpt-contracts.test.ts): the shared module's own message,
// which is shown, or a transport failure, which isn't.
const MODULE_REASON = 'Studio couldn’t complete the ChatGPT action. Try again.';
const READ_FAILURES = [
	{
		host: 'Desktop',
		failure: () => new ChatGptSettingsError( MODULE_REASON ),
		shown: MODULE_REASON,
	},
	{
		host: 'studio ui, with the server’s { error }',
		failure: () => new ChatGptSettingsError( MODULE_REASON ),
		shown: MODULE_REASON,
	},
	{
		host: 'studio ui, with the server not answering',
		failure: () => new Error( 'GET /chatgpt failed (502): Bad Gateway' ),
		shown: 'Try again.',
	},
	{
		host: 'studio ui, with the page offline',
		failure: () => new TypeError( 'Failed to fetch' ),
		shown: 'Try again.',
	},
];

// The whole text, where `toHaveTextContent` with a string matches any part of it.
const exactly = ( text: string ) =>
	new RegExp( `^${ text.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) }$` );

// As Studio saves them: labelled with the email, a second registration of it numbered.
const EMAIL = 'same@example.test';
const SECOND = 'same@example.test (2)';

function account( connectionId = ACCOUNT_A, label = EMAIL ): ChatGptAccountView {
	return {
		connectionId,
		providerId: 'chatgpt-oauth',
		backend: 'pi',
		revision: 1,
		identity: { verified: true, email: EMAIL },
		authStatus: 'connected',
		label,
		email: EMAIL,
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
			recheckChatGptSettings: async () => structuredClone( settings ),
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
afterEach( () => vi.restoreAllMocks() );

describe( 'ChatGPT account settings', () => {
	it( 'shows a pending sign-in and cancels it without connecting an account', async () => {
		const { connector } = await openSettings();
		const group = await screen.findByRole( 'group', { name: 'ChatGPT plan' } );
		// Mounted, and empty, before there is anything to announce.
		const status = within( group ).getByRole( 'status', { name: 'ChatGPT sign-in status' } );
		expect( status ).toBeEmptyDOMElement();
		fireEvent.click( await screen.findByRole( 'button', { name: 'Start sign-in' } ) );
		await waitFor( () => expect( status ).toHaveTextContent( /Complete sign-in in your browser/ ) );
		expect( within( group ).getByRole( 'status', { name: 'ChatGPT sign-in status' } ) ).toBe(
			status
		);
		fireEvent.click( screen.getByRole( 'button', { name: 'Cancel sign-in' } ) );
		await waitFor( () => expect( connector.cancelChatGptSignIn ).toHaveBeenCalledWith( ATTEMPT ) );
		expect( await within( group ).findByRole( 'alert' ) ).toHaveTextContent(
			'Signing in was cancelled.'
		);
		expect( within( group ).getAllByText( 'Signing in was cancelled.' ) ).toHaveLength( 1 );
		expect( status ).toBeEmptyDOMElement();
		expect( screen.queryByText( 'Connected' ) ).not.toBeInTheDocument();
		expect( connector.openExternalUrl ).not.toHaveBeenCalled();
	} );

	it.each( [
		[ 'cancelled', 'Signing in to ChatGPT was cancelled.' ],
		[ 'timed-out', 'Signing in to ChatGPT took too long, so Studio stopped waiting. Try again.' ],
		[
			'browser-unavailable',
			'Studio couldn’t open your web browser to sign in to ChatGPT. Try again.',
		],
		[
			'denied',
			'You didn’t allow WordPress Studio to use your ChatGPT account, so nothing was saved.',
		],
	] as const )(
		'says a sign-in that ended %s as an error, in the status region’s place for the next attempt',
		async ( code, message ) => {
			const { connector, outcome } = await openSettings();
			const group = await screen.findByRole( 'group', { name: 'ChatGPT plan' } );
			const status = within( group ).getByRole( 'status', { name: 'ChatGPT sign-in status' } );
			fireEvent.click( await screen.findByRole( 'button', { name: 'Start sign-in' } ) );
			await waitFor( () => expect( connector.waitForChatGptSignIn ).toHaveBeenCalled() );
			await act( async () => outcome.resolve( { ok: false, code, message } ) );

			expect( await within( group ).findByRole( 'alert' ) ).toHaveTextContent( message );
			expect( status ).toBeEmptyDOMElement();

			connector.waitForChatGptSignIn.mockImplementationOnce( () => new Promise( () => {} ) );
			fireEvent.click( screen.getByRole( 'button', { name: 'Start sign-in' } ) );
			await waitFor( () =>
				expect( status ).toHaveTextContent( /Complete sign-in in your browser/ )
			);
			expect( within( group ).getByRole( 'status', { name: 'ChatGPT sign-in status' } ) ).toBe(
				status
			);
			expect( within( group ).queryByRole( 'alert' ) ).not.toBeInTheDocument();
		}
	);

	it( 'says why cancelling failed, as an error, and keeps the attempt open', async () => {
		const { connector } = await openSettings();
		connector.cancelChatGptSignIn.mockRejectedValueOnce(
			new Error( 'Studio couldn’t complete the ChatGPT action. Try again.' )
		);
		const group = await screen.findByRole( 'group', { name: 'ChatGPT plan' } );
		fireEvent.click( await screen.findByRole( 'button', { name: 'Start sign-in' } ) );
		await waitFor( () => expect( connector.waitForChatGptSignIn ).toHaveBeenCalled() );
		fireEvent.click( screen.getByRole( 'button', { name: 'Cancel sign-in' } ) );

		expect( await within( group ).findByRole( 'alert' ) ).toHaveTextContent(
			'Studio couldn’t complete the ChatGPT action. Try again.'
		);
		expect( within( group ).getByRole( 'button', { name: 'Cancel sign-in' } ) ).toBeEnabled();
		expect(
			within( group ).getByRole( 'status', { name: 'ChatGPT sign-in status' } )
		).toHaveTextContent( /Complete sign-in in your browser/ );
	} );

	it( 'drops a failed cancel’s error once the same attempt connects the account', async () => {
		const { connector, outcome } = await openSettings();
		connector.cancelChatGptSignIn.mockRejectedValueOnce(
			new Error( 'Studio couldn’t complete the ChatGPT action. Try again.' )
		);
		const group = await screen.findByRole( 'group', { name: 'ChatGPT plan' } );
		fireEvent.click( await screen.findByRole( 'button', { name: 'Start sign-in' } ) );
		await waitFor( () => expect( connector.waitForChatGptSignIn ).toHaveBeenCalled() );
		fireEvent.click( screen.getByRole( 'button', { name: 'Cancel sign-in' } ) );
		await within( group ).findByRole( 'alert' );

		await act( async () =>
			outcome.resolve( { ok: true, registrationId: ACCOUNT_A, label: EMAIL, email: EMAIL } )
		);

		await waitFor( () =>
			expect(
				within( group ).getByRole( 'status', { name: 'ChatGPT sign-in status' } )
			).toHaveTextContent( exactly( 'ChatGPT account connected.' ) )
		);
		expect( within( group ).queryByRole( 'alert' ) ).not.toBeInTheDocument();
	} );

	it.each( [ 'while the accounts are read again', 'once they have been' ] as const )(
		'says nothing of a cancel that fails after the attempt connected the account, %s',
		async ( when ) => {
			const { connector, outcome } = await openSettings();
			let failCancel!: ( error: Error ) => void;
			connector.cancelChatGptSignIn.mockImplementationOnce(
				() => new Promise( ( _, fail ) => ( failCancel = fail ) )
			);
			const group = await screen.findByRole( 'group', { name: 'ChatGPT plan' } );
			const status = within( group ).getByRole( 'status', { name: 'ChatGPT sign-in status' } );
			fireEvent.click( await screen.findByRole( 'button', { name: 'Start sign-in' } ) );
			await waitFor( () => expect( connector.waitForChatGptSignIn ).toHaveBeenCalled() );
			fireEvent.click( screen.getByRole( 'button', { name: 'Cancel sign-in' } ) );
			await waitFor( () =>
				expect( connector.cancelChatGptSignIn ).toHaveBeenCalledWith( ATTEMPT )
			);
			// The read that follows the outcome, held so the cancel can fail before it ends.
			const reread = deferred< void >();
			const read = connector.getChatGptSettings.getMockImplementation()!;
			const reads = connector.getChatGptSettings.mock.calls.length;
			connector.getChatGptSettings.mockImplementation( async () => {
				await reread.promise;
				return read();
			} );

			await act( async () =>
				outcome.resolve( { ok: true, registrationId: ACCOUNT_A, label: EMAIL, email: EMAIL } )
			);
			await waitFor( () =>
				expect( connector.getChatGptSettings.mock.calls.length ).toBeGreaterThan( reads )
			);
			if ( when === 'once they have been' ) {
				await act( async () => reread.resolve() );
				await waitFor( () =>
					expect( status ).toHaveTextContent( exactly( 'ChatGPT account connected.' ) )
				);
			}
			await act( async () =>
				failCancel( new Error( 'Studio couldn’t complete the ChatGPT action. Try again.' ) )
			);
			await act( async () => reread.resolve() );

			await waitFor( () =>
				expect( status ).toHaveTextContent( exactly( 'ChatGPT account connected.' ) )
			);
			expect( within( group ).queryByRole( 'alert' ) ).not.toBeInTheDocument();
		}
	);

	it( 'says a sign-out that couldn’t clear the sign-in as an error', async () => {
		const { connector } = await openSettings( { accounts: [ account() ] } );
		connector.signOutChatGpt.mockResolvedValueOnce( {
			localCleared: false,
			remoteRevocationConfirmed: false,
		} );
		const group = await screen.findByRole( 'group', { name: 'ChatGPT plan' } );
		fireEvent.click( await within( group ).findByRole( 'button', { name: 'Sign out' } ) );

		expect( await within( group ).findByRole( 'alert' ) ).toHaveTextContent(
			'Studio couldn’t clear this sign-in. Try signing out again.'
		);
		expect(
			within( group ).getByRole( 'status', { name: 'ChatGPT sign-in status' } )
		).toBeEmptyDOMElement();
		expect( connector.signOutChatGpt ).toHaveBeenCalledExactlyOnceWith( ACCOUNT_A );
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
				EMAIL
			);
			expect( screen.getByText( 'Connected' ) ).toBeVisible();
			expect( connector.signOutChatGpt ).not.toHaveBeenCalled();
		}
	);

	it( 'selects registrations with the same email, reauthenticates and signs out only the selected one', async () => {
		const { connector, outcome } = await openSettings( {
			accounts: [ account(), account( ACCOUNT_B, SECOND ) ],
		} );
		fireEvent.click( await screen.findByRole( 'combobox', { name: 'Saved ChatGPT account' } ) );
		const option = await screen.findByRole( 'option', { name: SECOND } );
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
				label: SECOND,
				email: EMAIL,
			} )
		);
		fireEvent.click( await screen.findByRole( 'button', { name: 'Sign out' } ) );
		await waitFor( () =>
			expect( connector.signOutChatGpt ).toHaveBeenCalledExactlyOnceWith( ACCOUNT_B )
		);
		expect( await screen.findByText( /Remote revocation confirmed/ ) ).toBeVisible();
		expect( screen.getByText( 'Signed out' ) ).toBeVisible();
	} );

	it( 'names each saved account once, by its label, without the start of its id', async () => {
		await openSettings( { accounts: [ account(), account( ACCOUNT_B, SECOND ) ] } );
		const group = await screen.findByRole( 'group', { name: 'ChatGPT plan' } );
		const select = within( group ).getByRole( 'combobox', { name: 'Saved ChatGPT account' } );

		expect( select ).toHaveTextContent( exactly( EMAIL ) );
		expect( within( group ).getAllByText( EMAIL ) ).toHaveLength( 1 );
		expect( group ).not.toHaveTextContent( ACCOUNT_A.slice( 0, 8 ) );
		fireEvent.click( select );
		expect( await screen.findByRole( 'option', { name: EMAIL } ) ).toBeVisible();
		expect( screen.getByRole( 'option', { name: SECOND } ) ).toBeVisible();
	} );

	it( 'says the account’s email under its label only when the label isn’t it', async () => {
		await openSettings( { accounts: [ account( ACCOUNT_A, 'Work' ) ] } );
		const group = await screen.findByRole( 'group', { name: 'ChatGPT plan' } );

		expect(
			within( group ).getByRole( 'combobox', { name: 'Saved ChatGPT account' } )
		).toHaveTextContent( exactly( 'Work' ) );
		expect( within( group ).getByText( EMAIL ) ).toBeVisible();
	} );

	it( 'tells saved accounts of the same label apart by the start of their ids', async () => {
		await openSettings( { accounts: [ account(), account( ACCOUNT_B ) ] } );
		const group = await screen.findByRole( 'group', { name: 'ChatGPT plan' } );
		const select = within( group ).getByRole( 'combobox', { name: 'Saved ChatGPT account' } );

		expect( select ).toHaveTextContent( exactly( `${ EMAIL } · ${ ACCOUNT_A.slice( 0, 8 ) }` ) );
		fireEvent.click( select );
		expect(
			await screen.findByRole( 'option', { name: `${ EMAIL } · ${ ACCOUNT_B.slice( 0, 8 ) }` } )
		).toBeVisible();
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

	it( 'refreshes local sign-out and explains unconfirmed remote revocation', async () => {
		const { connector, settings } = await openSettings( { accounts: [ account() ] } );
		connector.signOutChatGpt.mockImplementationOnce( async () => {
			settings.accounts = [ { ...account(), state: 'signed-out', authStatus: 'disconnected' } ];
			return { localCleared: true, remoteRevocationConfirmed: false };
		} );
		fireEvent.click( await screen.findByRole( 'button', { name: 'Sign out' } ) );

		expect(
			await screen.findByRole( 'status', { name: 'ChatGPT sign-in status' } )
		).toHaveTextContent(
			'Signed out locally. Remote revocation wasn’t confirmed; you can remove Studio in your ChatGPT account settings.'
		);
		expect( await screen.findByText( 'Signed out' ) ).toBeVisible();
		expect( screen.getByRole( 'button', { name: 'Refresh models' } ) ).toBeDisabled();
		expect( screen.queryByText( 'Connected' ) ).not.toBeInTheDocument();
		expect( connector.signOutChatGpt ).toHaveBeenCalledExactlyOnceWith( ACCOUNT_A );
	} );

	describe( 'model lists the open chats rely on', () => {
		const ACCOUNT_C = '0b1f5f6e-1f43-4f5b-9b2b-5f0d8f1f2a3c';
		const catalog = ( connectionId: string ) => [ ...CHATGPT_MODELS_QUERY_KEY, connectionId, 1 ];
		async function withCatalogs() {
			const view = await openSettings( { accounts: [ account(), account( ACCOUNT_B, SECOND ) ] } );
			await screen.findByRole( 'group', { name: 'ChatGPT plan' } );
			for ( const id of [ ACCOUNT_A, ACCOUNT_B ] ) {
				view.queryClient.setQueryData( catalog( id ), {
					connectionId: id,
					revision: 1,
					checkedAt: '2026-11-10T10:00:00Z',
					models: [ { id: 'gpt-6-luna', label: 'GPT-6 Luna' } ],
					lastError: null,
				} );
			}
			return view;
		}

		it( 'drops only the signed-out account’s model list', async () => {
			const { connector, queryClient } = await withCatalogs();
			fireEvent.click( screen.getByRole( 'button', { name: 'Sign out' } ) );

			await waitFor( () =>
				expect( connector.signOutChatGpt ).toHaveBeenCalledExactlyOnceWith( ACCOUNT_A )
			);
			await waitFor( () =>
				expect( queryClient.getQueryData( catalog( ACCOUNT_A ) ) ).toBeUndefined()
			);
			expect( queryClient.getQueryData( catalog( ACCOUNT_B ) ) ).toBeDefined();
		} );

		it( 'drops only the model list of the account signed in to again', async () => {
			const { connector, queryClient, outcome } = await withCatalogs();
			fireEvent.click( screen.getByRole( 'button', { name: 'Sign in again' } ) );
			await waitFor( () => expect( connector.waitForChatGptSignIn ).toHaveBeenCalled() );
			await act( async () =>
				outcome.resolve( { ok: true, registrationId: ACCOUNT_A, label: EMAIL, email: EMAIL } )
			);

			await waitFor( () =>
				expect( queryClient.getQueryData( catalog( ACCOUNT_A ) ) ).toBeUndefined()
			);
			expect( queryClient.getQueryData( catalog( ACCOUNT_B ) ) ).toBeDefined();
		} );

		it( 'keeps every saved account’s model list when another account is added', async () => {
			const { connector, queryClient, outcome } = await withCatalogs();
			fireEvent.click( screen.getByRole( 'button', { name: 'Add account' } ) );
			await waitFor( () => expect( connector.waitForChatGptSignIn ).toHaveBeenCalled() );
			await act( async () =>
				outcome.resolve( { ok: true, registrationId: ACCOUNT_C, label: EMAIL, email: EMAIL } )
			);

			await screen.findByText( 'ChatGPT account connected.' );
			await waitFor( () => expect( queryClient.isFetching() ).toBe( 0 ) );
			expect( queryClient.getQueryData( catalog( ACCOUNT_A ) ) ).toBeDefined();
			expect( queryClient.getQueryData( catalog( ACCOUNT_B ) ) ).toBeDefined();
		} );
	} );

	it( 'checks secure storage again when the ChatGPT settings open, never on a polled read, and shows what it found', async () => {
		const host = { secureStorage: 'unavailable' as ChatGptSettings[ 'secureStorage' ] };
		const read = (): ChatGptSettings => ( {
			enabled: true,
			signInSupported: true,
			secureStorage: host.secureStorage,
			accounts: [],
		} );
		const { connector, queryClient } = await openSettings(
			{ secureStorage: 'unavailable' },
			{
				getChatGptSettings: async () => read(),
				recheckChatGptSettings: async () => {
					host.secureStorage = 'available';
					return read();
				},
			}
		);

		expect(
			await screen.findByText( /Secure storage keeps your sign-in across restarts/ )
		).toBeVisible();
		expect( screen.getByRole( 'button', { name: 'Start sign-in' } ) ).toBeEnabled();
		for ( let poll = 0; poll < 3; poll++ ) {
			await act( () => queryClient.refetchQueries( { queryKey: CHATGPT_SETTINGS_QUERY_KEY } ) );
		}
		expect( connector.recheckChatGptSettings ).toHaveBeenCalledTimes( 1 );
		expect( connector.getChatGptSettings.mock.calls.length ).toBeGreaterThan( 3 );
	} );

	it.each( READ_FAILURES )(
		'shows nothing about ChatGPT while no read has said it is on, when the read fails in $host',
		async ( { failure } ) => {
			const logged = vi.spyOn( console, 'error' );
			const { connector } = await openSettings(
				{},
				{
					getChatGptSettings: async () => {
						throw failure();
					},
				}
			);

			await screen.findAllByRole( 'group', { name: 'Providers' } );
			await waitFor( () => expect( connector.getChatGptSettings ).toHaveBeenCalled() );
			await act( async () => {} );

			expect( screen.queryByRole( 'group', { name: 'ChatGPT plan' } ) ).not.toBeInTheDocument();
			expect( screen.queryByText( /ChatGPT accounts/ ) ).not.toBeInTheDocument();
			expect( screen.queryByText( failure().message, { exact: false } ) ).not.toBeInTheDocument();
			expect( connector.recheckChatGptSettings ).not.toHaveBeenCalled();
			expect( logged ).not.toHaveBeenCalled();
		}
	);

	it.each( READ_FAILURES )(
		'keeps the last known accounts, marked as possibly out of date, with the reason and a retry when a read fails in $host',
		async ( { failure, shown } ) => {
			const { connector, queryClient, settings } = await openSettings( {
				accounts: [ account() ],
			} );
			const group = await screen.findByRole( 'group', { name: 'ChatGPT plan' } );
			await within( group ).findByText( 'Connected' );
			connector.getChatGptSettings.mockRejectedValue( failure() );
			await act( () => queryClient.refetchQueries( { queryKey: CHATGPT_SETTINGS_QUERY_KEY } ) );

			const alert = await within( group ).findByRole( 'alert' );
			expect( alert ).toHaveTextContent( `Couldn’t check your ChatGPT accounts. ${ shown }` );
			expect( group ).not.toHaveTextContent( /GET \/chatgpt|Bad Gateway|Failed to fetch/ );
			expect( within( group ).getByText( /This status may be out of date\./ ) ).toBeVisible();
			expect(
				within( group ).getByRole( 'combobox', { name: 'Saved ChatGPT account' } )
			).toHaveTextContent( EMAIL );

			connector.getChatGptSettings.mockImplementation( async () => structuredClone( settings ) );
			fireEvent.click( within( group ).getByRole( 'button', { name: 'Retry' } ) );

			await waitFor( () =>
				expect(
					within( group ).queryByText( /Couldn’t check your ChatGPT accounts/ )
				).not.toBeInTheDocument()
			);
			expect( within( group ).queryByText( /may be out of date/ ) ).not.toBeInTheDocument();
			expect( within( group ).getByText( 'Connected' ) ).toBeVisible();
			expect( connector.recheckChatGptSettings ).toHaveBeenCalledTimes( 2 );
		}
	);

	it( 'keeps the reason and the retry when the retry fails too', async () => {
		const { connector, queryClient } = await openSettings( { accounts: [ account() ] } );
		const group = await screen.findByRole( 'group', { name: 'ChatGPT plan' } );
		await within( group ).findByText( 'Connected' );
		connector.getChatGptSettings.mockRejectedValue( new ChatGptSettingsError( 'First reason.' ) );
		await act( () => queryClient.refetchQueries( { queryKey: CHATGPT_SETTINGS_QUERY_KEY } ) );
		await within( group ).findByRole( 'alert' );
		connector.recheckChatGptSettings.mockRejectedValue(
			new ChatGptSettingsError( 'Recheck reason.' )
		);
		connector.getChatGptSettings.mockRejectedValue( new ChatGptSettingsError( 'Second reason.' ) );

		fireEvent.click( within( group ).getByRole( 'button', { name: 'Retry' } ) );

		await waitFor( () =>
			expect( within( group ).getByRole( 'alert' ) ).toHaveTextContent(
				'Couldn’t check your ChatGPT accounts. Second reason.'
			)
		);
		expect( within( group ).getByRole( 'button', { name: 'Retry' } ) ).toBeEnabled();
		expect( within( group ).getByText( /This status may be out of date\./ ) ).toBeVisible();
	} );

	it.each( [ 'signed-out', 'needs-sign-in' ] as const )(
		'makes signing in again to a %s account the primary action, ahead of adding an account',
		async ( state ) => {
			const { connector } = await openSettings( {
				accounts: [ { ...account(), authStatus: 'disconnected', state } ],
			} );
			const group = await screen.findByRole( 'group', { name: 'ChatGPT plan' } );
			const again = await within( group ).findByRole( 'button', { name: 'Sign in again' } );
			const add = within( group ).getByRole( 'button', { name: 'Add account' } );

			expect( again ).toHaveAttribute( 'data-variant', 'accent' );
			expect( add ).toHaveAttribute( 'data-variant', 'outline' );
			expect(
				again.compareDocumentPosition( add ) & Node.DOCUMENT_POSITION_FOLLOWING
			).toBeTruthy();
			fireEvent.click( again );
			await waitFor( () =>
				expect( connector.beginChatGptSignIn ).toHaveBeenCalledExactlyOnceWith( ACCOUNT_A, {
					storage: 'vault',
				} )
			);
		}
	);

	it( 'keeps adding an account the primary action while the chosen account is connected', async () => {
		await openSettings( { accounts: [ account() ] } );
		const group = await screen.findByRole( 'group', { name: 'ChatGPT plan' } );

		expect( await within( group ).findByRole( 'button', { name: 'Add account' } ) ).toHaveAttribute(
			'data-variant',
			'accent'
		);
		expect( within( group ).getByRole( 'button', { name: 'Sign in again' } ) ).toHaveAttribute(
			'data-variant',
			'outline'
		);
	} );

	it.each( [
		[ 'needs signing in again', 'needs-sign-in' ],
		[ 'is signed in for another app session only', 'signed-in' ],
	] as const )( 'badges an account that %s “Needs sign-in”', async ( _case, state ) => {
		await openSettings( { accounts: [ { ...account(), authStatus: 'disconnected', state } ] } );
		const group = await screen.findByRole( 'group', { name: 'ChatGPT plan' } );

		expect( await within( group ).findByText( 'Needs sign-in' ) ).toBeVisible();
		expect( within( group ).queryByText( 'Connected' ) ).not.toBeInTheDocument();
		expect( within( group ).queryByText( 'Signed out' ) ).not.toBeInTheDocument();
	} );

	it( 'says an account kept for this app session only, offering where to keep the next sign-in', async () => {
		await openSettings( { accounts: [ { ...account(), storage: 'session' } ] } );
		const group = await screen.findByRole( 'group', { name: 'ChatGPT plan' } );

		expect(
			await within( group ).findByText(
				'This account is signed in only for this app session. Choose where to keep your next sign-in.'
			)
		).toBeVisible();
		expect(
			within( group ).getByRole( 'combobox', { name: 'Keep ChatGPT sign-in' } )
		).toBeEnabled();
	} );

	it( 'offers no sign-in or model check while offline, and signing in again once back online', async () => {
		const online = vi.spyOn( navigator, 'onLine', 'get' ).mockReturnValue( false );
		const { connector } = await openSettings( {
			accounts: [ { ...account(), authStatus: 'disconnected', state: 'signed-out' } ],
		} );
		const group = await screen.findByRole( 'group', { name: 'ChatGPT plan' } );

		expect(
			await within( group ).findByRole( 'button', { name: 'Sign in again' } )
		).toBeDisabled();
		expect( within( group ).getByRole( 'button', { name: 'Add account' } ) ).toBeDisabled();
		expect( within( group ).getByRole( 'button', { name: 'Refresh models' } ) ).toBeDisabled();
		fireEvent.click( within( group ).getByRole( 'button', { name: 'Sign in again' } ) );
		expect( connector.beginChatGptSignIn ).not.toHaveBeenCalled();

		online.mockReturnValue( true );
		act( () => {
			window.dispatchEvent( new Event( 'online' ) );
		} );
		await waitFor( () =>
			expect( within( group ).getByRole( 'button', { name: 'Sign in again' } ) ).toBeEnabled()
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

	it( 'says when the account lists models Studio doesn’t support yet, without naming them', async () => {
		await openSettings(
			{ accounts: [ account() ] },
			{
				getChatGptModels: async ( connectionId, revision ) => ( {
					connectionId,
					revision,
					checkedAt: '2026-11-10T10:00:00Z',
					models: [ { id: 'gpt-6-luna', label: 'GPT-6 Luna' } ],
					listsUnqualifiedModels: true,
					lastError: null,
				} ),
			}
		);
		const group = await screen.findByRole( 'group', { name: 'ChatGPT plan' } );
		fireEvent.click( within( group ).getByRole( 'button', { name: 'Refresh models' } ) );

		expect(
			await within( group ).findByText(
				'This account lists GPT-6 Luna. Some models this account offers aren’t supported in Studio yet.'
			)
		).toBeVisible();
	} );

	it( 'explains that images use a separate WordPress.com service and logs in to it from here', async () => {
		const { connector } = await openSettings();
		const group = await screen.findByRole( 'group', { name: 'ChatGPT plan' } );

		expect(
			await within( group ).findByText(
				/WordPress\.com image service, separate from your ChatGPT plan\. Log in to WordPress\.com to use it/
			)
		).toBeVisible();
		fireEvent.click( within( group ).getByRole( 'button', { name: 'Log in to WordPress.com' } ) );

		await waitFor( () => expect( connector.authenticate ).toHaveBeenCalledTimes( 1 ) );
		expect(
			await within( group ).findByText(
				/WordPress\.com image service, as Test User \(test@example\.test\)\. It’s separate from your ChatGPT plan/
			)
		).toBeVisible();
		expect(
			within( group ).queryByRole( 'button', { name: 'Log in to WordPress.com' } )
		).not.toBeInTheDocument();
		expect( connector.beginChatGptSignIn ).not.toHaveBeenCalled();
	} );

	it( 'says a token set for the image service is in use, naming no account', async () => {
		await openSettings(
			{},
			{
				getImageServiceState: async () => ( {
					available: true,
					service: 'wordpress-com',
					credential: 'environment-token',
					account: null,
				} ),
			}
		);
		const group = await screen.findByRole( 'group', { name: 'ChatGPT plan' } );

		expect(
			await within( group ).findByText( /image service, with the token set for it\./ )
		).toBeVisible();
	} );

	it( 'offers a retry when the image service can’t be checked', async () => {
		let fail = true;
		const { connector } = await openSettings(
			{},
			{
				getImageServiceState: async () => {
					if ( fail ) throw new Error( 'Offline' );
					return {
						available: false,
						service: 'wordpress-com',
						reason: 'signed-out',
						setup: 'wordpress-com-login',
					};
				},
			}
		);
		const group = await screen.findByRole( 'group', { name: 'ChatGPT plan' } );

		expect( await within( group ).findByText( 'Couldn’t check image generation.' ) ).toBeVisible();
		fail = false;
		fireEvent.click( within( group ).getByRole( 'button', { name: 'Retry' } ) );
		await waitFor( () => expect( connector.getImageServiceState ).toHaveBeenCalledTimes( 2 ) );
		expect(
			await within( group ).findByText( /Log in to WordPress\.com to use it/ )
		).toBeVisible();
	} );

	it( 'shows no image service row while ChatGPT plans are off', async () => {
		const { connector } = await openSettings( { enabled: false } );

		await screen.findAllByRole( 'group', { name: 'Providers' } );
		await waitFor( () => expect( connector.getChatGptSettings ).toHaveBeenCalled() );
		expect( screen.queryByText( 'Image generation' ) ).not.toBeInTheDocument();
		expect( connector.getImageServiceState ).not.toHaveBeenCalled();
		expect( connector.recheckChatGptSettings ).not.toHaveBeenCalled();
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
