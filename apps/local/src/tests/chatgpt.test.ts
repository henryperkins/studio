// @vitest-environment node
import fs from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { listChatGptConnections } from '@studio/agent/node/chatgpt/credential-broker';
import {
	beginChatGptSignIn,
	cancelChatGptSignIn,
	ChatGptSignInError,
	waitForChatGptSignIn,
} from '@studio/agent/node/chatgpt/oauth';
import { createAiSession, loadAiSession } from '@studio/agent/node/sessions/store';
import { readChatGptSessionSelection } from '@studio/agent/protocol/chatgpt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startLocalServer, type LocalServer } from '../index';

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
const SELECTION = { connectionId: ID, revision: 1, model: 'gpt-6-luna', reasoningEffort: 'high' };
let root: string;
let server: LocalServer;

const request = ( route: string, body?: unknown, method = 'POST', headers = {} ) =>
	fetch( `${ server.url }/api${ route }`, {
		method,
		headers: { 'Content-Type': 'application/json', ...headers },
		...( body === undefined ? {} : { body: JSON.stringify( body ) } ),
	} );

beforeEach( async () => {
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
		expect( beginChatGptSignIn ).toHaveBeenCalledExactlyOnceWith( ID, { storage: 'session' } );
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
} );
