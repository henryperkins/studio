// @vitest-environment node
import {
	beginChatGptSignIn as start,
	cancelChatGptSignIn as cancel,
	ChatGptSignInError,
	waitForChatGptSignIn as finish,
} from '@studio/agent/node/chatgpt/oauth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	beginChatGptSignIn,
	cancelChatGptSignIn,
	getChatGptSettings,
	waitForChatGptSignIn,
} from 'src/modules/user-settings/lib/ipc-handlers';
import type { IpcMainInvokeEvent } from 'electron';

vi.mock( '@studio/agent/node/chatgpt/oauth', async ( original ) => ( {
	...( await original< object >() ),
	beginChatGptSignIn: vi.fn(),
	waitForChatGptSignIn: vi.fn(),
	cancelChatGptSignIn: vi.fn(),
} ) );

const ID = 'f84d75a0-4e60-4168-a1ab-3134542c637a';
const ATTEMPT = 'b69a1ddf-d1a2-4ff6-b293-75c358ff42df';
const PRIVATE_HINT = 'TEST_ONLY_RETURNING_ID_TOKEN';
const PRIVATE_URL = `https://auth.example.test/authorize?id_token_hint=${ PRIVATE_HINT }`;
const event = {} as IpcMainInvokeEvent;
beforeEach( () => vi.stubEnv( 'STUDIO_EXPERIMENTAL_CHATGPT', '1' ) );
afterEach( () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
} );

describe( 'ChatGPT desktop IPC boundary', () => {
	it( 'projects returning sign-in results before they reach the renderer', async () => {
		vi.mocked( start ).mockResolvedValueOnce( {
			attemptId: ATTEMPT,
			authorizationUrl: PRIVATE_URL,
		} as never );
		await expect( beginChatGptSignIn( event, ID, { storage: 'session' } ) ).resolves.toEqual( {
			attemptId: ATTEMPT,
		} );
		expect( start ).toHaveBeenCalledExactlyOnceWith( ID, { storage: 'session' } );
		vi.mocked( finish ).mockResolvedValueOnce( {
			ok: true,
			registrationId: ID,
			label: 'Personal',
			email: 'test@example.test',
			idToken: PRIVATE_HINT,
		} as never );
		await expect( waitForChatGptSignIn( event, ATTEMPT ) ).resolves.toEqual( {
			ok: true,
			registrationId: ID,
			label: 'Personal',
			email: 'test@example.test',
		} );
	} );

	it.each( [ 'known', 'unknown' ] )(
		'rebuilds %s failures so Electron diagnostics receive no URL or ID token',
		async ( kind ) => {
			const error =
				kind === 'known' ? new ChatGptSignInError( 'browser-unavailable' ) : new Error();
			error.message = PRIVATE_URL;
			vi.mocked( start ).mockRejectedValueOnce( error );
			const result = await beginChatGptSignIn( event, ID ).catch( ( failure: Error ) => failure );
			expect( result ).toBeInstanceOf( Error );
			const diagnostics = ( result as Error ).stack;
			expect( diagnostics ).not.toContain( PRIVATE_HINT );
			expect( diagnostics ).not.toContain( PRIVATE_URL );
		}
	);

	it( 'sanitizes outcomes and invokes cancellation only with a valid attempt id', async () => {
		vi.mocked( finish ).mockResolvedValueOnce( {
			ok: false,
			code: 'permission-missing',
			message: PRIVATE_URL,
		} );
		await expect( waitForChatGptSignIn( event, ATTEMPT ) ).resolves.toEqual( {
			ok: false,
			code: 'permission-missing',
			message: new ChatGptSignInError( 'permission-missing' ).message,
		} );
		await expect( cancelChatGptSignIn( event, PRIVATE_URL ) ).rejects.toThrow(
			'Choose a saved ChatGPT account.'
		);
		expect( cancel ).not.toHaveBeenCalled();
		vi.mocked( cancel ).mockReturnValueOnce( true );
		await expect( cancelChatGptSignIn( event, ATTEMPT ) ).resolves.toBe( true );
		expect( cancel ).toHaveBeenCalledExactlyOnceWith( ATTEMPT );
	} );

	it( 'hides accounts and refuses sign-in unless the host explicitly enables it', async () => {
		vi.stubEnv( 'STUDIO_EXPERIMENTAL_CHATGPT', '' );
		await expect( getChatGptSettings() ).resolves.toMatchObject( { enabled: false, accounts: [] } );
		await expect( beginChatGptSignIn( event ) ).rejects.toThrow( /not enabled/ );
		expect( start ).not.toHaveBeenCalled();
	} );
} );
