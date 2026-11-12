// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readChatGptAccounts } from '@studio/agent/node/chatgpt/account-store';
import {
	beginChatGptSignIn as start,
	cancelChatGptSignIn as cancel,
	ChatGptSignInError,
	waitForChatGptSignIn as finish,
} from '@studio/agent/node/chatgpt/oauth';
import { createFakeCredentialStore } from '@studio/agent/node/tests/fake-credential-store';
import { writeFile } from 'atomically';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	beginChatGptSignIn,
	cancelChatGptSignIn,
	getChatGptSettings,
	recheckChatGptSettings,
	setAiProvider,
	waitForChatGptSignIn,
} from 'src/modules/user-settings/lib/ipc-handlers';
import type { IpcMainInvokeEvent } from 'electron';

// Each call stands for one run of the system keychain's tool.
const { keychainChecks } = vi.hoisted( () => ( { keychainChecks: vi.fn() } ) );
vi.mock( '@studio/common/lib/os-credential-store', async ( original ) => ( {
	...( await original< typeof import('@studio/common/lib/os-credential-store') >() ),
	createOsCredentialStore: () => {
		const { store } = createFakeCredentialStore();
		return {
			...store,
			check: () => {
				keychainChecks();
				return store.check();
			},
		};
	},
} ) );
vi.mock( '@studio/agent/node/chatgpt/oauth', async ( original ) => ( {
	...( await original< object >() ),
	beginChatGptSignIn: vi.fn(),
	waitForChatGptSignIn: vi.fn(),
	cancelChatGptSignIn: vi.fn(),
} ) );
// This app's tests write no files (`atomically` is mocked), so saved accounts come from here.
vi.mock( '@studio/agent/node/chatgpt/account-store', async ( original ) => {
	const actual = await original< typeof import('@studio/agent/node/chatgpt/account-store') >();
	return { ...actual, readChatGptAccounts: vi.fn( actual.readChatGptAccounts ) };
} );

const ID = 'f84d75a0-4e60-4168-a1ab-3134542c637a';
const ATTEMPT = 'b69a1ddf-d1a2-4ff6-b293-75c358ff42df';
const PRIVATE_HINT = 'TEST_ONLY_RETURNING_ID_TOKEN';
const PRIVATE_URL = `https://auth.example.test/authorize?id_token_hint=${ PRIVATE_HINT }`;
const event = {} as IpcMainInvokeEvent;
let configDir: string;
beforeEach( async () => {
	configDir = await mkdtemp( path.join( os.tmpdir(), 'studio-chatgpt-ipc-' ) );
	vi.stubEnv( 'DEV_CONFIG_DIR', configDir );
	vi.stubEnv( 'STUDIO_EXPERIMENTAL_CHATGPT', '1' );
} );
afterEach( async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await rm( configDir, { recursive: true, force: true } );
} );

describe( 'ChatGPT desktop IPC boundary', () => {
	it( 'lists saved accounts without their subject', async () => {
		vi.mocked( readChatGptAccounts ).mockResolvedValue( [
			{
				registrationId: ID,
				issuer: 'https://auth.example.test',
				subject: 'test-private-subject',
				email: 'someone@example.test',
				clientId: 'test-issued-client',
				label: 'someone@example.test',
				revision: 1,
				logoutGeneration: 0,
				storage: 'vault',
				state: 'signed-in',
				createdAt: '2026-11-10T00:00:00Z',
				updatedAt: '2026-11-10T00:00:00Z',
			},
		] );

		const settings = await getChatGptSettings();

		expect( settings.accounts ).toEqual( [
			expect.objectContaining( {
				connectionId: ID,
				identity: { verified: true, email: 'someone@example.test' },
				authStatus: 'connected',
			} ),
		] );
		expect( JSON.stringify( settings ) ).not.toContain( 'test-private-subject' );
		expect( JSON.stringify( settings ) ).not.toContain( 'subject' );
	} );

	it( 'answers repeated reads without the keychain’s tool, and runs it again on a recheck', async () => {
		vi.mocked( readChatGptAccounts ).mockResolvedValue( [] );
		await recheckChatGptSettings();
		keychainChecks.mockClear();

		for ( let poll = 0; poll < 3; poll++ ) {
			await getChatGptSettings();
		}
		expect( keychainChecks ).not.toHaveBeenCalled();

		await expect( recheckChatGptSettings() ).resolves.toEqual( {
			enabled: true,
			signInSupported: true,
			secureStorage: 'available',
			accounts: [],
		} );
		expect( keychainChecks ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'rejects ChatGPT as a global default before writing settings', async () => {
		await expect( setAiProvider( event, 'chatgpt-oauth' ) ).rejects.toThrow(
			'Choose a ChatGPT account in a new chat instead of setting a default provider.'
		);
		expect( writeFile ).not.toHaveBeenCalled();
	} );

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
