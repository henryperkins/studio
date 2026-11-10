// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ChatGptConnectionError,
	readChatGptAccounts,
} from '@studio/agent/node/chatgpt/account-store';
import {
	beginChatGptTurn,
	listChatGptConnections,
	signOutChatGpt,
} from '@studio/agent/node/chatgpt/credential-broker';
import {
	beginChatGptSignIn,
	cancelChatGptSignIn,
	ChatGptSignInError,
	waitForChatGptSignIn,
} from '@studio/agent/node/chatgpt/oauth';
import {
	disconnectChatGpt,
	finishChatGptSignIn,
	readChatGptModels,
	readChatGptSettings,
	startChatGptSignIn,
	stopChatGptSignIn,
	validateChatGptSelection,
} from '@studio/agent/node/chatgpt/settings';
import type { ChatGptAccount } from '@studio/agent/node/chatgpt/account-store';
import type { ChatGptTurnHandle } from '@studio/agent/node/chatgpt/credential-broker';

vi.mock( '@studio/common/lib/os-credential-store', () => ( {
	createOsCredentialStore: () => ( { check: async () => ( { available: true } ) } ),
} ) );
vi.mock( '@studio/agent/node/chatgpt/account-store', async ( original ) => ( {
	...( await original< object >() ),
	readChatGptAccounts: vi.fn(),
} ) );
vi.mock( '@studio/agent/node/chatgpt/credential-broker', () => ( {
	beginChatGptTurn: vi.fn(),
	listChatGptConnections: vi.fn(),
	signOutChatGpt: vi.fn(),
	getChatGptAccessToken: vi.fn(),
	invalidateChatGptAccessToken: vi.fn(),
} ) );
vi.mock( '@studio/agent/node/chatgpt/oauth', async ( original ) => ( {
	...( await original< object >() ),
	beginChatGptSignIn: vi.fn(),
	waitForChatGptSignIn: vi.fn(),
	cancelChatGptSignIn: vi.fn(),
} ) );

const ID = 'f84d75a0-4e60-4168-a1ab-3134542c637a';
const ATTEMPT = 'b69a1ddf-d1a2-4ff6-b293-75c358ff42df';
const PRIVATE_URL = 'https://auth.example.test/authorize?id_token_hint=TEST_ONLY_PRIVATE_HINT';
const ACCOUNT: ChatGptAccount = {
	registrationId: ID,
	issuer: 'https://auth.example.test',
	subject: 'test-subject',
	email: 'test@example.test',
	clientId: 'test-issued-client',
	label: 'Personal',
	revision: 1,
	logoutGeneration: 0,
	storage: 'vault',
	state: 'signed-in',
	createdAt: '2026-11-10T00:00:00Z',
	updatedAt: '2026-11-10T00:00:00Z',
};
const SELECTION = { connectionId: ID, revision: 1, model: 'gpt-6-luna', reasoningEffort: 'medium' };
let turn: ChatGptTurnHandle;

beforeEach( () => {
	vi.stubEnv( 'STUDIO_EXPERIMENTAL_CHATGPT', '1' );
	vi.mocked( readChatGptAccounts ).mockResolvedValue( [ ACCOUNT ] );
	vi.mocked( listChatGptConnections ).mockResolvedValue( [
		{
			connectionId: ID,
			providerId: 'chatgpt-oauth',
			backend: 'pi',
			revision: 1,
			authStatus: 'connected',
			identity: { subject: 'test-subject' },
		},
	] );
	turn = {
		connectionId: ID,
		signal: new AbortController().signal,
		getAccessToken: vi.fn().mockResolvedValue( 'TEST_ONLY_ACCESS' ),
		invalidateAccessToken: vi.fn(),
		assertActive: vi.fn(),
		end: vi.fn(),
	};
	vi.mocked( beginChatGptTurn ).mockResolvedValue( turn );
} );
afterEach( () => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.unstubAllEnvs();
} );

describe( 'ChatGPT application settings facade', () => {
	it( 'defaults off without reading any accounts or opening the browser', async () => {
		vi.stubEnv( 'STUDIO_EXPERIMENTAL_CHATGPT', '' );
		await expect( readChatGptSettings() ).resolves.toEqual( {
			enabled: false,
			signInSupported: false,
			accounts: [],
			secureStorage: 'unavailable',
		} );
		await expect( startChatGptSignIn() ).rejects.toThrow( /not enabled/ );
		await expect( validateChatGptSelection( SELECTION ) ).rejects.toThrow( /not enabled/ );
		expect( readChatGptAccounts ).not.toHaveBeenCalled();
		expect( beginChatGptSignIn ).not.toHaveBeenCalled();
	} );

	it( 'projects only renderer-safe account fields and treats a stale registry as disconnected', async () => {
		vi.mocked( readChatGptAccounts ).mockResolvedValue( [ { ...ACCOUNT, revision: 2 } ] );
		const settings = await readChatGptSettings();
		expect( settings.accounts[ 0 ] ).toEqual( {
			connectionId: ID,
			providerId: 'chatgpt-oauth',
			backend: 'pi',
			revision: 2,
			identity: { subject: ACCOUNT.subject, email: ACCOUNT.email },
			authStatus: 'disconnected',
			label: ACCOUNT.label,
			email: ACCOUNT.email,
			storage: 'vault',
			state: 'signed-in',
		} );
		expect( JSON.stringify( settings ) ).not.toContain( ACCOUNT.clientId );
	} );

	it( 'returns only an attempt id for a returning sign-in', async () => {
		vi.mocked( beginChatGptSignIn ).mockResolvedValue( {
			attemptId: ATTEMPT,
			authorizationUrl: PRIVATE_URL,
		} as never );
		await expect(
			startChatGptSignIn( ID, { storage: 'session', reconsent: true } )
		).resolves.toEqual( { attemptId: ATTEMPT } );
		expect( beginChatGptSignIn ).toHaveBeenCalledWith( ID, {
			storage: 'session',
			reconsent: true,
		} );
	} );

	it( 'refuses a remote callback host before beginning sign-in', async () => {
		await expect( startChatGptSignIn( undefined, {}, false ) ).rejects.toThrow( /localhost/ );
		expect( beginChatGptSignIn ).not.toHaveBeenCalled();
	} );

	it.each( [
		null,
		[],
		{ storage: 'plaintext' },
		{ reconsent: 'yes' },
		{ authorizationUrl: PRIVATE_URL },
	] )( 'rejects invalid sign-in options without echoing them: %j', async ( options ) => {
		await expect( startChatGptSignIn( ID, options ) ).rejects.toThrow( 'Choose how to keep' );
		expect( beginChatGptSignIn ).not.toHaveBeenCalled();
	} );

	it( 'rebuilds known failures from their code and hides unknown errors', async () => {
		const error = new ChatGptSignInError( 'browser-unavailable' );
		error.message = PRIVATE_URL;
		vi.mocked( beginChatGptSignIn )
			.mockRejectedValueOnce( error )
			.mockRejectedValueOnce( new Error( PRIVATE_URL ) );
		for ( let index = 0; index < 2; index++ ) {
			await expect( startChatGptSignIn() ).rejects.not.toThrow( PRIVATE_URL );
		}
		vi.mocked( waitForChatGptSignIn ).mockResolvedValue( {
			ok: false,
			code: 'permission-missing',
			message: PRIVATE_URL,
		} );
		expect( await finishChatGptSignIn( ATTEMPT ) ).toEqual( {
			ok: false,
			code: 'permission-missing',
			message: new ChatGptSignInError( 'permission-missing' ).message,
		} );
	} );

	it( 'returns only verified identity after sign-in and only revocation status after sign-out', async () => {
		vi.mocked( waitForChatGptSignIn ).mockResolvedValue( {
			ok: true,
			registrationId: ID,
			label: 'Personal',
			email: ACCOUNT.email,
			idToken: 'TEST_ONLY',
		} as never );
		await expect( finishChatGptSignIn( ATTEMPT ) ).resolves.toEqual( {
			ok: true,
			registrationId: ID,
			label: 'Personal',
			email: ACCOUNT.email,
		} );
		vi.mocked( signOutChatGpt ).mockResolvedValue( {
			localCleared: true,
			remoteRevocationConfirmed: false,
			refreshToken: 'TEST_ONLY',
		} as never );
		await expect( disconnectChatGpt( ID ) ).resolves.toEqual( {
			localCleared: true,
			remoteRevocationConfirmed: false,
		} );
		expect( signOutChatGpt ).toHaveBeenCalledExactlyOnceWith( ID );
	} );

	it( 'validates cancellation and sanitizes unexpected cancellation errors', async () => {
		await expect( stopChatGptSignIn( PRIVATE_URL ) ).rejects.toThrow( 'Choose a saved' );
		expect( cancelChatGptSignIn ).not.toHaveBeenCalled();
		vi.mocked( cancelChatGptSignIn ).mockImplementationOnce( () => {
			throw new Error( PRIVATE_URL );
		} );
		await expect( stopChatGptSignIn( ATTEMPT ) ).rejects.toThrow( 'Studio couldn’t complete' );
	} );

	it( 'lists models through a turn handle and releases it', async () => {
		const fetch = vi.spyOn( globalThis, 'fetch' ).mockResolvedValue(
			new Response(
				JSON.stringify( {
					models: [ { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'list' } ],
				} )
			)
		);
		const result = await readChatGptModels( ID, 1 );
		expect( result ).toMatchObject( {
			connectionId: ID,
			revision: 1,
			models: [ { id: 'gpt-6-luna', label: 'GPT-6 Luna' } ],
		} );
		expect( turn.getAccessToken ).toHaveBeenCalled();
		expect( new Headers( fetch.mock.calls[ 0 ][ 1 ]?.headers ).get( 'Authorization' ) ).toBe(
			'Bearer TEST_ONLY_ACCESS'
		);
		expect( turn.assertActive ).toHaveBeenCalled();
		expect( turn.end ).toHaveBeenCalledOnce();
	} );

	it( 'rejects model discovery when sign-out occurs before the response lands', async () => {
		vi.spyOn( globalThis, 'fetch' ).mockResolvedValue(
			new Response( JSON.stringify( { models: [] } ) )
		);
		vi.mocked( turn.assertActive ).mockRejectedValue( new ChatGptConnectionError( 'signed-out' ) );
		await expect( readChatGptModels( ID, 1 ) ).rejects.toThrow( /sign/i );
		expect( turn.end ).toHaveBeenCalledOnce();
	} );

	it.each( [
		{ ...SELECTION, revision: 2 },
		{ ...SELECTION, revision: -1 },
		{ ...SELECTION, reasoningEffort: 'unknown' },
		{ ...SELECTION, maxOutputTokens: 5000 },
		{ ...SELECTION, reasoningMode: 'pro' },
	] )( 'rejects stale or unsupported selections: %j', async ( selection ) => {
		await expect( validateChatGptSelection( selection ) ).rejects.toThrow();
	} );
} );
