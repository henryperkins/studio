// @vitest-environment node
import fs from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createChatGptAccount } from '@studio/agent/node/chatgpt/account-store';
import { listChatGptConnections } from '@studio/agent/node/chatgpt/credential-broker';
import {
	beginChatGptSignIn,
	cancelChatGptSignIn,
	ChatGptSignInError,
	waitForChatGptSignIn,
} from '@studio/agent/node/chatgpt/oauth';
import { createAiSession, loadAiSession } from '@studio/agent/node/sessions/store';
import { createFakeCredentialStore } from '@studio/agent/node/tests/fake-credential-store';
import { readChatGptSessionSelection } from '@studio/agent/protocol/chatgpt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startLocalServer, type LocalServer } from '../index';

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
// As the lockfile package gives up once another process has held a session's selection lock past the wait.
const { selectionLock } = vi.hoisted( () => ( { selectionLock: { held: false } } ) );
vi.mock( '@studio/common/lib/lockfile', async ( original ) => {
	const actual = await original< typeof import('@studio/common/lib/lockfile') >();
	return {
		...actual,
		lockFileAsync: async ( ...args: Parameters< typeof actual.lockFileAsync > ) => {
			if ( selectionLock.held && args[ 0 ].endsWith( '.settings.lock' ) ) {
				throw Object.assign( new Error( `EEXIST: file already exists, open '${ args[ 0 ] }'` ), {
					code: 'EEXIST',
				} );
			}
			return actual.lockFileAsync( ...args );
		},
	};
} );
vi.mock( '@studio/agent/node/chatgpt/oauth', async ( original ) => ( {
	...( await original< object >() ),
	beginChatGptSignIn: vi.fn(),
	waitForChatGptSignIn: vi.fn(),
	cancelChatGptSignIn: vi.fn(),
} ) );
vi.mock( '@studio/agent/node/chatgpt/credential-broker', async ( original ) => ( {
	...( await original< object >() ),
	listChatGptConnections: vi.fn(),
} ) );
const ID = 'f84d75a0-4e60-4168-a1ab-3134542c637a';
const ATTEMPT = 'b69a1ddf-d1a2-4ff6-b293-75c358ff42df';
const PRIVATE_HINT = 'TEST_ONLY_PRIVATE_RETURNING_ID_TOKEN';
const PRIVATE_URL = `https://auth.example.test/authorize?id_token_hint=${ PRIVATE_HINT }`;
const SELECTION = { connectionId: ID, revision: 1, model: 'gpt-6-luna', reasoningEffort: 'low' };
let root: string;
let server: LocalServer;

const request = ( route: string, body?: unknown, method = 'POST', headers = {} ) =>
	fetch( `${ server.url }/api${ route }`, {
		method,
		headers: { 'Content-Type': 'application/json', ...headers },
		...( body === undefined ? {} : { body: JSON.stringify( body ) } ),
	} );

beforeEach( async () => {
	selectionLock.held = false;
	root = await fs.mkdtemp( path.join( os.tmpdir(), 'studio-chatgpt-http-' ) );
	vi.stubEnv( 'DEV_CONFIG_DIR', root );
	vi.stubEnv( 'STUDIO_EXPERIMENTAL_CHATGPT', '1' );
	server = await startLocalServer( {
		cliBinary: path.join( root, 'cli.mjs' ),
		sessionsRoot: root,
		sitesRoot: root,
		port: 0,
	} );
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
} );
afterEach( async () => {
	await server.close();
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.unstubAllEnvs();
	await fs.rm( root, { recursive: true, force: true } );
} );

describe( 'ChatGPT HTTP boundary', () => {
	it( 'lists saved accounts without their subject', async () => {
		await createChatGptAccount( ID, {
			issuer: 'https://auth.example.test',
			subject: 'test-private-subject',
			email: 'someone@example.test',
			clientId: 'test-issued-client',
			storage: 'vault',
		} );

		const response = await request( '/chatgpt', undefined, 'GET' );
		const text = await response.text();

		expect( response.status ).toBe( 200 );
		expect( JSON.parse( text ).accounts ).toEqual( [
			expect.objectContaining( {
				connectionId: ID,
				identity: { verified: true, email: 'someone@example.test' },
			} ),
		] );
		expect( text ).not.toContain( 'test-private-subject' );
		expect( text ).not.toContain( 'subject' );
	} );

	it( 'answers repeated reads without the keychain’s tool, and runs it again on a recheck', async () => {
		await request( '/chatgpt/recheck', {} );
		keychainChecks.mockClear();

		for ( let poll = 0; poll < 3; poll++ ) {
			expect( ( await request( '/chatgpt', undefined, 'GET' ) ).status ).toBe( 200 );
		}
		expect( keychainChecks ).not.toHaveBeenCalled();
		const rechecked = await request( '/chatgpt/recheck', {} );

		expect( rechecked.status ).toBe( 200 );
		expect( await rechecked.json() ).toEqual( {
			enabled: true,
			signInSupported: true,
			secureStorage: 'available',
			accounts: [],
		} );
		expect( keychainChecks ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'rejects a global ChatGPT default with a settings error and preserves the saved provider', async () => {
		const configPath = path.join( root, 'shared.json' );
		const config = JSON.stringify( { version: 1, aiProvider: 'wpcom', locale: 'es' } );
		await fs.writeFile( configPath, config );

		const response = await request( '/ai-settings/provider', { provider: 'chatgpt-oauth' }, 'PUT' );

		expect( response.status ).toBe( 400 );
		expect( await response.json() ).toEqual( {
			error: 'Choose a ChatGPT account in a new chat instead of setting a default provider.',
		} );
		expect( await fs.readFile( configPath, 'utf8' ) ).toBe( config );
		expect( listChatGptConnections ).not.toHaveBeenCalled();
	} );

	it( 'returns only the attempt id for a returning sign-in and non-secret completion', async () => {
		vi.mocked( beginChatGptSignIn ).mockResolvedValueOnce( {
			attemptId: ATTEMPT,
			authorizationUrl: PRIVATE_URL,
		} as never );
		const response = await request( '/chatgpt/sign-in', {
			registrationId: ID,
			options: { storage: 'session' },
		} );
		expect( response.status ).toBe( 200 );
		expect( await response.json() ).toEqual( { attemptId: ATTEMPT } );
		expect( beginChatGptSignIn ).toHaveBeenCalledExactlyOnceWith(
			ID,
			{ storage: 'session' },
			{ storageChosen: expect.any( Function ) }
		);
		vi.mocked( waitForChatGptSignIn ).mockResolvedValueOnce( {
			ok: true,
			registrationId: ID,
			label: 'Personal',
			email: 'test@example.test',
			idToken: PRIVATE_HINT,
		} as never );
		const completed = await request( `/chatgpt/sign-in/${ ATTEMPT }`, undefined, 'GET' );
		expect( await completed.json() ).toEqual( {
			ok: true,
			registrationId: ID,
			label: 'Personal',
			email: 'test@example.test',
		} );
	} );

	it.each( [ 'known', 'unknown' ] )(
		'sanitizes %s sign-in failures before HTTP serialization and diagnostics',
		async ( kind ) => {
			const logs = vi.spyOn( console, 'error' ).mockImplementation( () => {} );
			const error =
				kind === 'known' ? new ChatGptSignInError( 'browser-unavailable' ) : new Error();
			error.message = PRIVATE_URL;
			vi.mocked( beginChatGptSignIn ).mockRejectedValueOnce( error );
			const response = await request( '/chatgpt/sign-in', { registrationId: ID } );
			expect( response.status ).toBe( 400 );
			const text = await response.text();
			expect( text ).not.toContain( PRIVATE_HINT );
			expect( text ).not.toContain( PRIVATE_URL );
			expect( JSON.stringify( logs.mock.calls ) ).not.toContain( PRIVATE_HINT );
		}
	);

	it( 'sanitizes a denied outcome and routes cancellation by attempt id', async () => {
		vi.mocked( waitForChatGptSignIn ).mockResolvedValueOnce( {
			ok: false,
			code: 'denied',
			message: PRIVATE_URL,
		} );
		const denied = await request( `/chatgpt/sign-in/${ ATTEMPT }`, undefined, 'GET' );
		expect( await denied.json() ).toEqual( {
			ok: false,
			code: 'denied',
			message: new ChatGptSignInError( 'denied' ).message,
		} );
		vi.mocked( cancelChatGptSignIn ).mockReturnValueOnce( true );
		const cancelled = await request( `/chatgpt/sign-in/${ ATTEMPT }`, undefined, 'DELETE' );
		expect( await cancelled.json() ).toBe( true );
		expect( cancelChatGptSignIn ).toHaveBeenCalledExactlyOnceWith( ATTEMPT );
	} );

	it( 'retains origin and hostname protection on the sign-in routes', async () => {
		expect(
			(
				await request( '/chatgpt/sign-in', {}, 'POST', {
					Origin: 'https://untrusted.example.test',
				} )
			).status
		).toBe( 403 );
		const status = await new Promise< number | undefined >( ( resolve, reject ) => {
			const req = httpRequest(
				`${ server.url }/api/chatgpt/sign-in`,
				{ method: 'POST', headers: { Host: 'untrusted.example.test' } },
				( response ) => {
					response.resume();
					response.on( 'end', () => resolve( response.statusCode ) );
				}
			);
			req.on( 'error', reject );
			req.end();
		} );
		expect( status ).toBe( 403 );
		expect( beginChatGptSignIn ).not.toHaveBeenCalled();
	} );

	it( 'rejects disabled sign-in and selection without exposing any accounts', async () => {
		vi.stubEnv( 'STUDIO_EXPERIMENTAL_CHATGPT', '' );
		const settings = await request( '/chatgpt', undefined, 'GET' );
		expect( await settings.json() ).toEqual( {
			enabled: false,
			signInSupported: false,
			secureStorage: 'unavailable',
			accounts: [],
		} );
		keychainChecks.mockClear();
		expect( await ( await request( '/chatgpt/recheck', {} ) ).json() ).toEqual(
			await ( await request( '/chatgpt', undefined, 'GET' ) ).json()
		);
		expect( keychainChecks ).not.toHaveBeenCalled();
		expect( ( await request( '/chatgpt/sign-in', {} ) ).status ).toBe( 400 );
		expect( beginChatGptSignIn ).not.toHaveBeenCalled();
		const { id } = await createAiSession( root );
		expect( ( await request( `/sessions/${ id }/chatgpt-selection`, SELECTION ) ).status ).toBe(
			400
		);
		expect( listChatGptConnections ).not.toHaveBeenCalled();
	} );

	it( 'persists a validated choice and rejects generic endpoints that would repin ChatGPT history', async () => {
		const { id } = await createAiSession( root );
		expect( ( await request( `/sessions/${ id }/chatgpt-selection`, SELECTION ) ).status ).toBe(
			204
		);
		const requests = await Promise.all( [
			request( `/sessions/${ id }/provider`, { provider: 'openai-api-key', model: 'gpt-6-luna' } ),
			request( `/sessions/${ id }/openai-selection`, {
				model: 'gpt-6-luna',
				reasoningEffort: 'medium',
				reasoningMode: 'standard',
			} ),
			request( `/sessions/${ id }/model`, { model: 'gpt-6-astra' } ),
		] );
		expect( requests.map( ( response ) => response.status ) ).toEqual( [ 400, 400, 400 ] );
		expect( readChatGptSessionSelection( ( await loadAiSession( root, id ) ).entries ) ).toEqual(
			SELECTION
		);
	} );

	it( 'answers a chat’s model or provider choice whose lock stays held with a 400 naming no path', async () => {
		const { id } = await createAiSession( root );
		selectionLock.held = true;

		const responses = await Promise.all( [
			request( `/sessions/${ id }/provider`, { provider: 'wpcom', model: 'balanced' } ),
			request( `/sessions/${ id }/model`, { model: 'fast' } ),
			request( `/sessions/${ id }/chatgpt-selection`, SELECTION ),
		] );

		for ( const response of responses ) {
			expect( response.status ).toBe( 400 );
			const text = await response.text();
			expect( JSON.parse( text ) ).toEqual( {
				error: 'Studio couldn’t save the model for this chat. Try again.',
			} );
			expect( text ).not.toMatch( /settings\.lock|EEXIST|studio-chatgpt-http/ );
		}
		expect(
			( await loadAiSession( root, id ) ).entries.filter(
				( entry ) => entry.type === 'custom' || entry.type === 'model_change'
			)
		).toEqual( [] );
	} );

	it( 'answers a choice for a chat it can’t read with a 400 naming no path', async () => {
		const response = await request( '/sessions/missing-chat/provider', {
			provider: 'wpcom',
			model: 'balanced',
		} );

		expect( response.status ).toBe( 400 );
		expect( await response.json() ).toEqual( {
			error: 'Studio couldn’t save the model for this chat. Try again.',
		} );
	} );

	it( 'refuses a model or effort the route isn’t qualified for, keeping the saved choice', async () => {
		const { id } = await createAiSession( root );
		await request( `/sessions/${ id }/chatgpt-selection`, SELECTION );

		const refused = await Promise.all( [
			request( `/sessions/${ id }/chatgpt-selection`, { ...SELECTION, model: 'gpt-6.1-sol' } ),
			request( `/sessions/${ id }/chatgpt-selection`, { ...SELECTION, reasoningEffort: 'high' } ),
		] );

		expect( refused.map( ( response ) => response.status ) ).toEqual( [ 400, 400 ] );
		const messages = await Promise.all(
			refused.map( async ( response ) => JSON.stringify( await response.json() ) )
		);
		expect( messages[ 0 ] ).toContain( 'isn’t qualified for use with a ChatGPT plan' );
		expect( messages[ 1 ] ).toContain( 'isn’t qualified for use with a ChatGPT plan' );
		expect( readChatGptSessionSelection( ( await loadAiSession( root, id ) ).entries ) ).toEqual(
			SELECTION
		);
	} );
} );
