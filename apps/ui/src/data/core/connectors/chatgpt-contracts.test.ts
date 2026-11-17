import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIpcConnector } from './ipc';
import { createLocalConnector } from './local';
import type { ChatGptSettings } from '@studio/agent/protocol/chatgpt';

const ID = 'f84d75a0-4e60-4168-a1ab-3134542c637a';
const ATTEMPT = 'b69a1ddf-d1a2-4ff6-b293-75c358ff42df';
const SELECTION = {
	connectionId: ID,
	revision: 1,
	model: 'gpt-6-luna',
	reasoningEffort: 'medium' as const,
};
const SETTINGS: ChatGptSettings = {
	enabled: true,
	signInSupported: true,
	secureStorage: 'available',
	accounts: [],
};
beforeEach( () => vi.stubGlobal( 'ipcListener', { subscribe: vi.fn() } ) );
afterEach( () => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
} );

describe( 'ChatGPT connector contracts', () => {
	it( 'passes named settings and selection operations through Desktop IPC', async () => {
		const api = {
			getChatGptSettings: vi.fn( async () => SETTINGS ),
			recheckChatGptSettings: vi.fn( async () => SETTINGS ),
			beginChatGptSignIn: vi.fn( async () => ( { attemptId: ATTEMPT } ) ),
			waitForChatGptSignIn: vi.fn(),
			cancelChatGptSignIn: vi.fn(),
			signOutChatGpt: vi.fn(),
			getChatGptModels: vi.fn(),
			setAiSessionChatGptSelection: vi.fn(),
		};
		vi.stubGlobal( 'ipcApi', api );
		const connector = createIpcConnector();
		await expect( connector.getChatGptSettings() ).resolves.toEqual( SETTINGS );
		await expect( connector.recheckChatGptSettings() ).resolves.toEqual( SETTINGS );
		expect( api.getChatGptSettings ).toHaveBeenCalledExactlyOnceWith();
		expect( api.recheckChatGptSettings ).toHaveBeenCalledExactlyOnceWith();
		await expect( connector.beginChatGptSignIn( ID, { storage: 'session' } ) ).resolves.toEqual( {
			attemptId: ATTEMPT,
		} );
		await connector.waitForChatGptSignIn( ATTEMPT );
		await connector.cancelChatGptSignIn( ATTEMPT );
		await connector.signOutChatGpt( ID );
		await connector.getChatGptModels( ID, 1 );
		await connector.setSessionChatGptSelection( 'chat', SELECTION );
		expect( api.beginChatGptSignIn ).toHaveBeenCalledWith( ID, { storage: 'session' } );
		expect( api.waitForChatGptSignIn ).toHaveBeenCalledWith( ATTEMPT );
		expect( api.cancelChatGptSignIn ).toHaveBeenCalledWith( ATTEMPT );
		expect( api.signOutChatGpt ).toHaveBeenCalledWith( ID );
		expect( api.getChatGptModels ).toHaveBeenCalledWith( ID, 1 );
		expect( api.setAiSessionChatGptSelection ).toHaveBeenCalledWith( 'chat', SELECTION );
	} );

	it( 'uses the matching HTTP methods and request bodies in studio ui', async () => {
		const fetch = vi.fn( async () => new Response( JSON.stringify( SETTINGS ) ) );
		vi.stubGlobal( 'fetch', fetch );
		const connector = createLocalConnector( { apiBaseUrl: 'http://localhost:8081' } );
		await expect( connector.getChatGptSettings() ).resolves.toEqual( SETTINGS );
		await expect( connector.recheckChatGptSettings() ).resolves.toEqual( SETTINGS );
		expect( fetch ).toHaveBeenNthCalledWith(
			1,
			'http://localhost:8081/api/chatgpt',
			expect.not.objectContaining( { method: expect.anything() } )
		);
		expect( fetch ).toHaveBeenNthCalledWith(
			2,
			'http://localhost:8081/api/chatgpt/recheck',
			expect.objectContaining( { method: 'POST' } )
		);
		await connector.beginChatGptSignIn( ID, { storage: 'session' } );
		await connector.waitForChatGptSignIn( ATTEMPT );
		await connector.cancelChatGptSignIn( ATTEMPT );
		await connector.signOutChatGpt( ID );
		await connector.getChatGptModels( ID, 1 );
		await connector.setSessionChatGptSelection( 'chat/id', SELECTION );
		expect( fetch ).toHaveBeenCalledWith(
			'http://localhost:8081/api/chatgpt/sign-in',
			expect.objectContaining( {
				method: 'POST',
				body: JSON.stringify( { registrationId: ID, options: { storage: 'session' } } ),
			} )
		);
		expect( fetch ).toHaveBeenCalledWith(
			`http://localhost:8081/api/chatgpt/sign-in/${ ATTEMPT }`,
			expect.objectContaining( { method: 'DELETE' } )
		);
		expect( fetch ).toHaveBeenCalledWith(
			'http://localhost:8081/api/chatgpt/sign-out',
			expect.objectContaining( { method: 'POST', body: JSON.stringify( { connectionId: ID } ) } )
		);
		expect( fetch ).toHaveBeenCalledWith(
			'http://localhost:8081/api/chatgpt/models',
			expect.objectContaining( {
				method: 'POST',
				body: JSON.stringify( { connectionId: ID, revision: 1 } ),
			} )
		);
		expect( fetch ).toHaveBeenCalledWith(
			'http://localhost:8081/api/sessions/chat%2Fid/chatgpt-selection',
			expect.objectContaining( { method: 'POST', body: JSON.stringify( SELECTION ) } )
		);
	} );

	describe.each( [
		'Studio couldn’t save the model for this chat. Try again.',
		'Choose a model this provider supports.',
		'Choose a supported model.',
	] )( 'a session model or provider that wasn’t saved: %s', ( message ) => {
		it( 'reaches the renderer as the message alone through Desktop IPC', async () => {
			const envelope = ( channel: string ) =>
				new Error(
					`Error invoking remote method '${ channel }': ChatGptSettingsError: ${ message }`
				);
			vi.stubGlobal( 'ipcApi', {
				setAiSessionProvider: vi.fn( async () => {
					throw envelope( 'setAiSessionProvider' );
				} ),
				setAiSessionModel: vi.fn( async () => {
					throw envelope( 'setAiSessionModel' );
				} ),
			} );
			const connector = createIpcConnector();

			await expect(
				connector.setSessionProvider( 'chat', 'wpcom', 'balanced' )
			).rejects.toThrowError( new Error( message ) );
			await expect( connector.setSessionModel( 'chat', 'balanced' ) ).rejects.toThrowError(
				new Error( message )
			);
		} );

		it( 'reaches the page as the message alone from studio ui’s 400', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn( async () => new Response( JSON.stringify( { error: message } ), { status: 400 } ) )
			);
			const connector = createLocalConnector( { apiBaseUrl: 'http://localhost:8081' } );

			await expect(
				connector.setSessionProvider( 'chat', 'wpcom', 'balanced' )
			).rejects.toThrowError( new Error( message ) );
			await expect( connector.setSessionModel( 'chat', 'balanced' ) ).rejects.toThrowError(
				new Error( message )
			);
		} );
	} );

	it.each( [ 'localhost', '127.0.0.1', '[::1]', 'studio.local' ] )(
		'advertises callback support on %s',
		async ( hostname ) => {
			vi.stubGlobal(
				'fetch',
				vi.fn( async () => new Response( JSON.stringify( SETTINGS ) ) )
			);
			const connector = createLocalConnector( { apiBaseUrl: `http://${ hostname }:8081` } );
			await expect( connector.getChatGptSettings() ).resolves.toMatchObject( {
				signInSupported: true,
			} );
		}
	);

	it( 'refuses sign-in when the backend is on another computer', async () => {
		const fetch = vi.fn( async () => new Response( JSON.stringify( SETTINGS ) ) );
		vi.stubGlobal( 'fetch', fetch );
		const connector = createLocalConnector( { apiBaseUrl: 'http://studio.example.test:8081' } );
		await expect( connector.getChatGptSettings() ).resolves.toMatchObject( {
			signInSupported: false,
		} );
		await expect( connector.beginChatGptSignIn() ).rejects.toThrow( /localhost/ );
		expect( fetch ).toHaveBeenCalledTimes( 1 );
	} );
} );
