// @vitest-environment node
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { base64url, SignJWT, type JWTPayload } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ChatGptConnectionError,
	getChatGptHostId,
	readChatGptAccount,
	readChatGptAccounts,
	readRetainedChatGptClientId,
} from '@studio/agent/node/chatgpt/account-store';
import {
	CHATGPT_TERMINAL_REFRESH_ERRORS,
	createChatGptCredentialBroker,
	type ChatGptCredentialBroker,
	type ChatGptSignIn,
	type ChatGptTokenRequest,
} from '@studio/agent/node/chatgpt/credential-broker';
import { openLoopbackPeerLookup } from '@studio/agent/node/chatgpt/loopback-peer';
import {
	CHATGPT_SIGN_IN_TIMEOUT_MS,
	ChatGptSignInError,
	createChatGptSignInFlow,
	type ChatGptSignInFailureCode,
	type ChatGptSignInFlow,
	type ChatGptSignInFlowOptions,
	type ChatGptSignInOptions,
	type ChatGptSignInOutcome,
} from '@studio/agent/node/chatgpt/oauth';
import { createChatGptTokenClient } from '@studio/agent/node/chatgpt/token-client';
import {
	createFakeCredentialStore,
	type FakeCredentialStore,
} from '../../tests/fake-credential-store';
import {
	createSigningKey,
	GRANTED_SCOPE,
	signIdToken,
	startFakeAuthorizationServer,
	type FakeAuthorizationServer,
	type FakeAuthorizationServerScript,
	type SigningKey,
} from './fixtures/fake-authorization-server';
import {
	INITIAL_UID_MAP,
	OTHER_UID,
	OVERFLOW_UID_FILE,
	OWN_UID,
	TCP6_FILE,
	TCP_FILE,
	UID_MAP_FILE,
	at,
	createFakeProc,
	hex4,
	mapped,
	systemError,
	tcp6Row,
	tcp6Table,
	tcpRow,
	tcpTable,
	v4,
	type FakeProc,
} from './fixtures/proc-net-tcp';
import type {
	LoopbackConnection,
	LoopbackPeerOwner,
} from '@studio/agent/node/chatgpt/loopback-peer';
import type { AddressInfo } from 'node:net';

const systemKeychain = vi.hoisted( () => ( { current: null as FakeCredentialStore | null } ) );

// The app's own broker reaches the system keychain: never the real one from a test.
vi.mock( '@studio/common/lib/os-credential-store', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/common/lib/os-credential-store') >();
	return { ...actual, createOsCredentialStore: () => systemKeychain.current!.store };
} );

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const REQUESTED_SCOPE =
	'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RANDOM = /^[\w-]{43,128}$/;
const CALLBACK = /^http:\/\/127\.0\.0\.1:(\d+)\/auth\/callback$/;
// What the browser opener is given: the attempt's listener and a one-time path, nothing else.
const START = /^http:\/\/127\.0\.0\.1:(\d+)\/([\w-]{43})$/;

const sleep = ( ms: number ) => new Promise( ( resolve ) => setTimeout( resolve, ms ) );
const nextTurn = () => new Promise( ( resolve ) => setImmediate( resolve ) );

async function until( condition: () => boolean, timeoutMs = 5_000 ): Promise< void > {
	const deadline = Date.now() + timeoutMs;
	while ( ! condition() ) {
		if ( Date.now() > deadline ) {
			throw new Error( 'The condition never held.' );
		}
		await sleep( 5 );
	}
}

// A port nothing listens on.
async function closedPort(): Promise< number > {
	const server = http.createServer();
	await new Promise< void >( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
	const { port } = server.address() as AddressInfo;
	await new Promise( ( resolve ) => server.close( resolve ) );
	return port;
}

/**
 * A GET from a socket of its own, so a test knows the port it comes from
 * before it is sent; status 0 when the connection is dropped unanswered.
 */
async function requestFrom(
	url: string,
	beforeSending: ( localPort: number ) => void = () => undefined
): Promise< { status: number; location?: string; page: string } > {
	const target = new URL( url );
	const socket = net.connect( Number( target.port ), target.hostname );
	let text = '';
	socket.setEncoding( 'utf8' );
	socket.on( 'data', ( chunk: string ) => ( text += chunk ) );
	socket.on( 'error', () => undefined );
	const closed = new Promise( ( resolve ) => socket.on( 'close', resolve ) );
	await once( socket, 'connect' );
	beforeSending( socket.localPort! );
	socket.write(
		`GET ${ target.pathname }${ target.search } HTTP/1.1\r\nHost: ${ target.host }\r\n\r\n`
	);
	await closed;
	const [ head, ...body ] = text.split( '\r\n\r\n' );
	return {
		status: Number( /^HTTP\/1\.1 (\d{3}) /.exec( head )?.[ 1 ] ?? 0 ),
		location: /\r\nlocation: ([^\r\n]*)/i.exec( head )?.[ 1 ],
		page: body.join( '\r\n\r\n' ),
	};
}

const failed = ( code: string ) => ( { ok: false, code, message: expect.any( String ) } );

describe( 'Signing in to ChatGPT', () => {
	let signingKey: SigningKey;
	// The same key id as the published key, but another key: its signatures don't verify.
	let impostorKey: SigningKey;
	// A key id the key set never publishes.
	let unpublishedKey: SigningKey;
	let configDir: string;
	let previousConfigDir: string | undefined;
	let keychain: FakeCredentialStore;
	let fake: FakeAuthorizationServer;
	let broker: ChatGptCredentialBroker;
	let flow: ChatGptSignInFlow;
	const flows: ChatGptSignInFlow[] = [];
	const begun: string[] = [];
	const logged: unknown[][] = [];
	// Each sign-in the test flows asked the broker to save.
	const saves: ChatGptSignIn[] = [];
	// The system browser: each URL a test flow sent it to, in order.
	const opened: string[] = [];
	const openBrowser = async ( url: string ) => {
		opened.push( url );
	};

	const credentialsDir = () => path.join( configDir, 'chatgpt-credentials' );
	const vaultFiles = () =>
		fs.existsSync( credentialsDir() )
			? fs
					.readdirSync( credentialsDir() )
					.filter( ( name ) => name.includes( '.vault' ) )
					.sort()
			: [];

	function startBroker() {
		return createChatGptCredentialBroker( {
			tokenClient: createChatGptTokenClient( { discoveryUrl: fake.discoveryUrl } ),
			credentialStore: keychain.store,
			timing: { turnSettleTimeoutMs: 200, revokeRetryDelaysMs: [ 1, 1 ] },
		} );
	}

	// Every flow here follows Linux's rules, the strictest, whatever machine runs
	// the tests, with a socket-table lookup that finds each request this user's;
	// a test that needs another platform or answer says so.
	function startFlow( options: ChatGptSignInFlowOptions = {} ) {
		const created = createChatGptSignInFlow( {
			discoveryUrl: fake.discoveryUrl,
			credentials: {
				saveSignIn: ( signIn ) => {
					saves.push( signIn );
					return broker.saveSignIn( signIn );
				},
				readIdTokenHint: ( registrationId ) => broker.readIdTokenHint( registrationId ),
				checkVaultKey: () => broker.checkVaultKey(),
			},
			openBrowser,
			platform: 'linux',
			loopbackPeers: () => ( {
				ownerOf: async () => 'same-user',
				close: async () => undefined,
			} ),
			...options,
		} );
		flows.push( created );
		return created;
	}

	// The browser at the start address it was given: Studio sends it on to the authorize page.
	async function follow( startUrl: string ): Promise< string > {
		const response = await fetch( startUrl, { redirect: 'manual' } );
		expect( response.status ).toBe( 302 );
		return response.headers.get( 'location' )!;
	}

	async function begin(
		registrationId?: string,
		options?: ChatGptSignInOptions,
		using: ChatGptSignInFlow = flow
	) {
		const before = opened.length;
		const started = await using.begin( registrationId, options );
		begun.push( started.attemptId );
		// The caller gets the attempt id alone; the start address went to the browser.
		expect( started ).toEqual( { attemptId: expect.stringMatching( UUID ) } );
		expect( opened ).toHaveLength( before + 1 );
		const startUrl = opened[ before ];
		expect( startUrl ).toMatch( START );
		return { attemptId: started.attemptId, startUrl, url: await follow( startUrl ) };
	}

	// The browser at the authorize page: ChatGPT sends it back to the callback.
	async function authorize( authorizationUrl: string ): Promise< string > {
		const response = await fetch( authorizationUrl, { redirect: 'manual' } );
		expect( response.status ).toBe( 302 );
		return response.headers.get( 'location' )!;
	}

	// The browser at the callback; status 0 when nothing listens there.
	async function deliver( callbackUrl: string, init: RequestInit = {} ) {
		try {
			const response = await fetch( callbackUrl, { redirect: 'manual', ...init } );
			return { status: response.status, page: await response.text() };
		} catch {
			return { status: 0, page: '' };
		}
	}

	async function signIn(
		registrationId?: string,
		options?: ChatGptSignInOptions,
		using: ChatGptSignInFlow = flow
	) {
		const start = await begin( registrationId, options, using );
		const callbackUrl = await authorize( start.url );
		const delivery = await deliver( callbackUrl );
		const outcome = await using.wait( start.attemptId );
		return { start, callbackUrl, delivery, outcome };
	}

	const registrationOf = ( outcome: ChatGptSignInOutcome ) => {
		expect( outcome.ok ).toBe( true );
		return ( outcome as { registrationId: string } ).registrationId;
	};

	async function snapshot() {
		return {
			accounts: await readChatGptAccounts(),
			vault: vaultFiles().map( ( name ) => [
				name,
				fs.readFileSync( path.join( credentialsDir(), name ), 'utf8' ),
			] ),
		};
	}

	// A registration signed in before the attempt a test makes fail.
	async function signInExisting() {
		const registrationId = registrationOf( ( await signIn() ).outcome );
		const accessToken = await broker.getAccessToken( registrationId );
		return { registrationId, accessToken, saved: saves.length, before: await snapshot() };
	}

	// Nothing of the failed attempt was even offered to the broker to save.
	async function expectUntouched( existing: Awaited< ReturnType< typeof signInExisting > > ) {
		expect( saves ).toHaveLength( existing.saved );
		expect( await snapshot() ).toEqual( existing.before );
		await expect( broker.getAccessToken( existing.registrationId ) ).resolves.toBe(
			existing.accessToken
		);
	}

	function expectNoSecrets( ...values: unknown[] ) {
		const secrets = fake.secrets();
		for ( const value of values ) {
			const text =
				value instanceof Error
					? `${ value.message }\n${ value.stack }\n${ JSON.stringify( value ) }`
					: typeof value === 'string'
					? value
					: JSON.stringify( value );
			for ( const secret of secrets ) {
				expect( text ).not.toContain( secret );
			}
			expect( text ).not.toMatch( /test-(access|refresh)-token|test-auth-code|eyJ/ );
		}
	}

	const query = ( index: number ) => Object.fromEntries( fake.authorizeRequests[ index ] );
	const tokenForm = ( index: number ) => Object.fromEntries( fake.tokenRequests[ index ] );

	beforeAll( async () => {
		signingKey = await createSigningKey( 'test-key-1' );
		impostorKey = await createSigningKey( 'test-key-1' );
		unpublishedKey = await createSigningKey( 'test-key-unpublished' );
	} );

	beforeEach( async () => {
		configDir = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-chatgpt-oauth-' ) );
		previousConfigDir = process.env.DEV_CONFIG_DIR;
		process.env.DEV_CONFIG_DIR = configDir;
		keychain = createFakeCredentialStore();
		systemKeychain.current = keychain;
		saves.splice( 0 );
		opened.splice( 0 );
		fake = await startFakeAuthorizationServer( signingKey );
		broker = startBroker();
		flow = startFlow();
		for ( const method of [ 'log', 'info', 'warn', 'error', 'debug' ] as const ) {
			vi.spyOn( console, method ).mockImplementation( ( ...args: unknown[] ) => {
				logged.push( args );
			} );
		}
	} );

	afterEach( async () => {
		for ( const attemptId of begun.splice( 0 ) ) {
			for ( const created of flows ) {
				created.cancel( attemptId );
			}
		}
		flows.splice( 0 );
		vi.restoreAllMocks();
		await fake.close();
		if ( previousConfigDir === undefined ) {
			delete process.env.DEV_CONFIG_DIR;
		} else {
			process.env.DEV_CONFIG_DIR = previousConfigDir;
		}
		fs.rmSync( configDir, { recursive: true, force: true, maxRetries: 5 } );
		// Nothing is ever logged, so no secret can be.
		expect( logged.splice( 0 ) ).toEqual( [] );
	} );

	describe( 'a new registration', () => {
		it( 'registers through discovery’s endpoints with PKCE, a loopback callback and a verified ID token', async () => {
			const { start, callbackUrl, delivery, outcome } = await signIn();

			const authorizeRequest = query( 0 );
			const redirectUri = authorizeRequest.redirect_uri;
			expect( redirectUri ).toMatch( CALLBACK );
			expect( authorizeRequest ).toEqual( {
				client_id: 'dynamic_agent_client',
				ext_agent_host_id: await getChatGptHostId(),
				agent_name_hint: 'WordPress Studio',
				response_type: 'code',
				redirect_uri: redirectUri,
				scope: REQUESTED_SCOPE,
				resource: RESOURCE,
				state: expect.stringMatching( RANDOM ),
				nonce: expect.stringMatching( RANDOM ),
				code_challenge_method: 'S256',
				code_challenge: expect.stringMatching( /^[\w-]{43}$/ ),
			} );
			expect( await getChatGptHostId() ).toMatch( /^urn:uuid:/ );
			const authorizationUrl = new URL( start.url );
			expect( `${ authorizationUrl.origin }${ authorizationUrl.pathname }` ).toBe(
				`${ fake.url }/api/accounts/authorize`
			);

			expect( fake.tokenRequests ).toHaveLength( 1 );
			const exchange = tokenForm( 0 );
			expect( exchange ).toEqual( {
				grant_type: 'authorization_code',
				client_id: 'test-issued-client-1',
				code: expect.stringMatching( /^test-auth-code-/ ),
				code_verifier: expect.stringMatching( RANDOM ),
				redirect_uri: redirectUri,
				resource: RESOURCE,
			} );
			expect( createHash( 'sha256' ).update( exchange.code_verifier ).digest( 'base64url' ) ).toBe(
				authorizeRequest.code_challenge
			);

			expect( outcome ).toEqual( {
				ok: true,
				registrationId: expect.stringMatching( UUID ),
				label: 'someone@example.com',
				email: 'someone@example.com',
			} );
			const registrationId = registrationOf( outcome );
			expect( await readChatGptAccount( registrationId ) ).toMatchObject( {
				issuer: ISSUER,
				subject: 'test-subject-1',
				email: 'someone@example.com',
				clientId: 'test-issued-client-1',
				storage: 'vault',
				state: 'signed-in',
				revision: 1,
			} );
			await expect( broker.getAccessToken( registrationId ) ).resolves.toBe(
				fake.issued[ 0 ].accessToken
			);
			await expect( broker.readIdTokenHint( registrationId ) ).resolves.toBe(
				fake.issued[ 0 ].idToken
			);

			expect( delivery.status ).toBe( 200 );
			expectNoSecrets( outcome, delivery.page );
			// The listener closed with the attempt.
			expect( await deliver( callbackUrl ) ).toEqual( { status: 0, page: '' } );
			expect( fake.counts ).toEqual( { discovery: 1, jwks: 1, tokenResponses: 1 } );
		} );

		it( 'keeps a sign-in in this app’s memory only, when asked to', async () => {
			const { outcome } = await signIn( undefined, { storage: 'session' } );

			const registrationId = registrationOf( outcome );
			expect( ( await readChatGptAccount( registrationId ) )?.storage ).toBe( 'session' );
			expect( vaultFiles() ).toEqual( [] );
			await expect( broker.getAccessToken( registrationId ) ).resolves.toBe(
				fake.issued[ 0 ].accessToken
			);
		} );

		it( 'gives every new sign-in a registration of its own, even for the same account', async () => {
			const first = registrationOf( ( await signIn() ).outcome );
			const second = registrationOf( ( await signIn() ).outcome );

			expect( first ).not.toBe( second );
			expect( ( await readChatGptAccounts() ).map( ( account ) => account.clientId ) ).toEqual( [
				'test-issued-client-1',
				'test-issued-client-2',
			] );
		} );

		it( 'keeps the client a failed first sign-in was issued, so the next one registers through it', async () => {
			fake.script.token = () => ( { status: 400, body: { error: 'invalid_grant' } } );
			const first = await signIn();
			expect( first.outcome ).toEqual( failed( 'code-rejected' ) );
			expect( await readChatGptAccounts() ).toEqual( [] );
			expect( await readRetainedChatGptClientId() ).toBe( 'test-issued-client-1' );

			fake.script.token = undefined;
			const second = await signIn();
			expect( query( 1 ) ).toMatchObject( { client_id: 'test-issued-client-1' } );
			expect( query( 1 ) ).not.toHaveProperty( 'agent_name_hint' );
			expect( tokenForm( 1 ).client_id ).toBe( 'test-issued-client-1' );
			const registrationId = registrationOf( second.outcome );
			expect( ( await readChatGptAccount( registrationId ) )?.clientId ).toBe(
				'test-issued-client-1'
			);

			// Claimed by the registration: a later first sign-in registers anew.
			expect( await readRetainedChatGptClientId() ).toBeNull();
			const third = await signIn();
			expect( query( 2 ).client_id ).toBe( 'dynamic_agent_client' );
			expect( ( await readChatGptAccount( registrationOf( third.outcome ) ) )?.clientId ).toBe(
				'test-issued-client-2'
			);
		} );

		it( 'refuses a callback naming another client than the one a first sign-in kept', async () => {
			fake.script.token = () => ( { status: 400, body: { error: 'invalid_grant' } } );
			await signIn();
			fake.script.token = undefined;
			fake.script.callback = ( params ) => ( {
				...params,
				client_id: 'test-issued-client-99',
			} );

			const { outcome } = await signIn();

			expect( outcome ).toEqual( failed( 'client-mismatch' ) );
			expect( fake.tokenRequests ).toHaveLength( 1 );
			expect( await readChatGptAccounts() ).toEqual( [] );
			expect( await readRetainedChatGptClientId() ).toBe( 'test-issued-client-1' );
		} );
	} );

	describe( 'a returning sign-in', () => {
		it( 'signs in again with the registration’s issued client, its ID token as the hint', async () => {
			const existing = await signInExisting();

			const { outcome } = await signIn( existing.registrationId );

			expect( query( 1 ) ).toEqual( {
				client_id: 'test-issued-client-1',
				ext_agent_host_id: await getChatGptHostId(),
				id_token_hint: fake.issued[ 0 ].idToken,
				response_type: 'code',
				redirect_uri: expect.stringMatching( CALLBACK ),
				scope: REQUESTED_SCOPE,
				resource: RESOURCE,
				state: expect.stringMatching( RANDOM ),
				nonce: expect.stringMatching( RANDOM ),
				code_challenge_method: 'S256',
				code_challenge: expect.stringMatching( /^[\w-]{43}$/ ),
			} );
			expect( tokenForm( 1 ).client_id ).toBe( 'test-issued-client-1' );
			expect( outcome ).toEqual( {
				ok: true,
				registrationId: existing.registrationId,
				label: 'someone@example.com',
				email: 'someone@example.com',
			} );
			expect( await readChatGptAccounts() ).toHaveLength( 1 );
			expect( ( await readChatGptAccount( existing.registrationId ) )?.revision ).toBe( 1 );
			await expect( broker.getAccessToken( existing.registrationId ) ).resolves.toBe(
				fake.issued[ 1 ].accessToken
			);
			expectNoSecrets( outcome );
		} );

		it( 'sends the saved email as the hint once signed out, and asks for consent again only when told to', async () => {
			const existing = await signInExisting();
			await broker.signOut( existing.registrationId );

			const { outcome } = await signIn( existing.registrationId, { reconsent: true } );

			expect( query( 1 ) ).toMatchObject( {
				client_id: 'test-issued-client-1',
				login_hint: 'someone@example.com',
				prompt: 'consent',
			} );
			for ( const name of [ 'id_token_hint', 'agent_name_hint', 'force_reconsent' ] ) {
				expect( query( 1 ) ).not.toHaveProperty( name );
			}
			expect( query( 0 ) ).not.toHaveProperty( 'prompt' );
			expect( outcome ).toMatchObject( { ok: true, registrationId: existing.registrationId } );
			expect( ( await readChatGptAccount( existing.registrationId ) )?.state ).toBe( 'signed-in' );
		} );

		it( 'signs a saved account that was signed out in again for this app session only', async () => {
			const existing = await signInExisting();
			await broker.signOut( existing.registrationId );

			const { outcome } = await signIn( existing.registrationId, { storage: 'session' } );

			expect( query( 1 ) ).toMatchObject( {
				client_id: 'test-issued-client-1',
				login_hint: 'someone@example.com',
			} );
			expect( query( 1 ) ).not.toHaveProperty( 'id_token_hint' );
			expect( outcome ).toEqual( {
				ok: true,
				registrationId: existing.registrationId,
				label: 'someone@example.com',
				email: 'someone@example.com',
			} );
			expect( await readChatGptAccount( existing.registrationId ) ).toMatchObject( {
				state: 'signed-in',
				storage: 'session',
				revision: 1,
				logoutGeneration: 1,
			} );
			expect( vaultFiles() ).toEqual( [] );
			await expect( broker.getAccessToken( existing.registrationId ) ).resolves.toBe(
				fake.issued[ 1 ].accessToken
			);
			// Offered to this app's forks; any other process has nothing to use.
			expect( broker.getSessionForkEnvironment() ).toEqual( {
				STUDIO_CHATGPT_SESSIONS_OFFERED: existing.registrationId,
			} );
			await expect( startBroker().getAccessToken( existing.registrationId ) ).rejects.toMatchObject(
				{ code: 'session-unavailable' }
			);
			expectNoSecrets( outcome );
		} );

		it( 'keeps a registration kept in memory there when it signs in again without being told otherwise', async () => {
			const registrationId = registrationOf(
				( await signIn( undefined, { storage: 'session' } ) ).outcome
			);
			// Most likely why it was kept out of the vault.
			keychain.state.available = false;

			const again = await signIn( registrationId );
			const reconsented = await signIn( registrationId, { reconsent: true } );
			const unreadable = await signIn( registrationId, {
				storage: 'test-no-such-storage',
			} as unknown as ChatGptSignInOptions );

			for ( const { outcome } of [ again, reconsented, unreadable ] ) {
				expect( outcome ).toMatchObject( { ok: true, registrationId } );
			}
			expect( ( await readChatGptAccount( registrationId ) )?.storage ).toBe( 'session' );
			expect( vaultFiles() ).toEqual( [] );
			await expect( broker.getAccessToken( registrationId ) ).resolves.toBe(
				fake.issued[ 3 ].accessToken
			);
		} );

		it( 'moves a registration between the vault and memory only when a sign-in says so', async () => {
			const registrationId = registrationOf( ( await signIn() ).outcome );

			await signIn( registrationId );
			const keptInVault = await readChatGptAccount( registrationId );
			const vaultedFiles = vaultFiles();
			await signIn( registrationId, { storage: 'session' } );
			const keptInMemory = await readChatGptAccount( registrationId );
			const memoryFiles = vaultFiles();
			await signIn( registrationId, { storage: 'vault' } );

			expect( keptInVault?.storage ).toBe( 'vault' );
			expect( vaultedFiles ).toEqual( [ `${ registrationId }.vault` ] );
			expect( keptInMemory?.storage ).toBe( 'session' );
			expect( memoryFiles ).toEqual( [] );
			expect( ( await readChatGptAccount( registrationId ) )?.storage ).toBe( 'vault' );
			expect( vaultFiles() ).toEqual( [ `${ registrationId }.vault` ] );
			await expect( broker.getAccessToken( registrationId ) ).resolves.toBe(
				fake.issued[ 3 ].accessToken
			);
		} );

		it( 'won’t begin for a registration Studio doesn’t have', async () => {
			const error = await flow.begin( '00000000-0000-4000-8000-000000000000' ).catch( ( e ) => e );

			expect( error ).toBeInstanceOf( ChatGptSignInError );
			expect( error.code ).toBe( 'not-found' );
			expect( fake.counts.discovery ).toBe( 0 );
		} );
	} );

	describe( 'a sign-in that fails changes no registration', () => {
		it( 'refuses a callback whose state isn’t the attempt’s, and keeps waiting for the real one', async () => {
			const existing = await signInExisting();
			const start = await begin();
			const callbackUrl = await authorize( start.url );
			const forged = new URL( callbackUrl );
			forged.searchParams.set( 'state', 'test-forged-state' );
			const missing = new URL( callbackUrl );
			missing.searchParams.delete( 'state' );
			const doubled = new URL( callbackUrl );
			doubled.searchParams.append( 'state', 'test-forged-state' );

			for ( const url of [ forged, missing, doubled ] ) {
				const delivery = await deliver( url.toString() );
				expect( delivery.status ).toBe( 400 );
				expectNoSecrets( delivery.page );
			}

			expect( fake.tokenRequests ).toHaveLength( 1 );
			await expectUntouched( existing );
			const delivery = await deliver( callbackUrl );
			expect( delivery.status ).toBe( 200 );
			expect( ( await flow.wait( start.attemptId ) ).ok ).toBe( true );
		} );

		it( 'completes an attempt once, so a replayed callback exchanges nothing', async () => {
			const start = await begin();
			const callbackUrl = await authorize( start.url );

			const deliveries = await Promise.all( [ deliver( callbackUrl ), deliver( callbackUrl ) ] );

			expect( deliveries.filter( ( delivery ) => delivery.status === 200 ) ).toHaveLength( 1 );
			expect( ( await flow.wait( start.attemptId ) ).ok ).toBe( true );
			const after = await snapshot();
			expect( await deliver( callbackUrl ) ).toEqual( { status: 0, page: '' } );
			expect( fake.tokenRequests ).toHaveLength( 1 );
			expect( await snapshot() ).toEqual( after );
		} );

		it( 'stops at a denial without exchanging anything', async () => {
			const existing = await signInExisting();
			fake.script.callback = ( params ) => ( {
				state: params.state,
				error: 'access_denied',
				error_description: 'test-denial-detail',
			} );

			const { delivery, outcome } = await signIn();

			expect( outcome ).toEqual( failed( 'denied' ) );
			expect( fake.tokenRequests ).toHaveLength( 1 );
			expect( delivery.page ).not.toContain( 'test-denial-detail' );
			expect( delivery.page ).not.toContain( 'access_denied' );
			await expectUntouched( existing );
		} );

		it( 'stops at any other error ChatGPT sends back', async () => {
			const existing = await signInExisting();
			fake.script.callback = ( params ) => ( { ...params, error: 'server_error' } );

			const { outcome } = await signIn();

			expect( outcome ).toEqual( failed( 'authorization-failed' ) );
			expect( fake.tokenRequests ).toHaveLength( 1 );
			await expectUntouched( existing );
		} );

		it.each( [
			[
				'without an issued client',
				( { client_id: _clientId, ...params }: Record< string, string > ) => params,
			],
			[
				'naming the registration client',
				( params: Record< string, string > ) => ( {
					...params,
					client_id: 'dynamic_agent_client',
				} ),
			],
		] )( 'treats a new registration’s callback %s as incomplete', async ( _name, callback ) => {
			const existing = await signInExisting();
			fake.script.callback = callback;

			const { outcome } = await signIn();

			expect( outcome ).toEqual( failed( 'registration-incomplete' ) );
			expect( fake.tokenRequests ).toHaveLength( 1 );
			await expectUntouched( existing );
		} );

		it( 'discards a code the token endpoint rejects', async () => {
			const existing = await signInExisting();
			fake.script.token = () => ( { status: 400, body: { error: 'invalid_grant' } } );

			const { outcome } = await signIn();

			expect( outcome ).toEqual( failed( 'code-rejected' ) );
			await expectUntouched( existing );
		} );

		it.each( [
			[ 'fails', () => ( { status: 500, body: { detail: 'test-detail' } } ) ],
			[
				'answers without an ID token',
				() => ( {
					status: 200,
					body: {
						access_token: 'test-access-token-x',
						refresh_token: 'test-refresh-token-x',
						token_type: 'Bearer',
						expires_in: 3600,
						scope: GRANTED_SCOPE,
					},
				} ),
			],
		] )( 'saves nothing when the token endpoint %s', async ( _name, token ) => {
			const existing = await signInExisting();
			fake.script.token = token;

			const { outcome } = await signIn();

			expect( outcome ).toEqual( failed( 'token-exchange-failed' ) );
			expectNoSecrets( outcome );
			await expectUntouched( existing );
		} );

		const unsigned = async ( claims: JWTPayload ) =>
			`${ base64url.encode( JSON.stringify( { alg: 'none', typ: 'JWT' } ) ) }.${ base64url.encode(
				JSON.stringify( claims )
			) }.`;
		const hmac = ( claims: JWTPayload ) =>
			new SignJWT( claims )
				.setProtectedHeader( { alg: 'HS256', kid: 'test-key-1' } )
				.sign( new TextEncoder().encode( 'test-hmac-secret-0123456789abcdef' ) );
		const now = () => Math.floor( Date.now() / 1000 );

		it.each<
			[
				string,
				{
					claims?: ( claims: JWTPayload ) => JWTPayload;
					sign?: () => ( claims: JWTPayload ) => Promise< string >;
				},
			]
		>( [
			[ 'another nonce', { claims: ( claims ) => ( { ...claims, nonce: 'test-other-nonce' } ) } ],
			[ 'no nonce', { claims: ( { nonce: _nonce, ...claims } ) => claims } ],
			[
				'another audience',
				{ claims: ( claims ) => ( { ...claims, aud: [ 'test-other-client' ] } ) },
			],
			[
				'another issuer',
				{ claims: ( claims ) => ( { ...claims, iss: 'https://auth.example.com' } ) },
			],
			[ 'an expiry in the past', { claims: ( claims ) => ( { ...claims, exp: now() - 3600 } ) } ],
			[ 'no expiry', { claims: ( { exp: _exp, ...claims } ) => claims } ],
			[ 'no issue time', { claims: ( { iat: _iat, ...claims } ) => claims } ],
			[
				'an issue time far in the future',
				{ claims: ( claims ) => ( { ...claims, iat: now() + 3600 } ) },
			],
			[ 'no subject', { claims: ( { sub: _sub, ...claims } ) => claims } ],
			[
				'a signature that doesn’t verify',
				{ sign: () => ( claims ) => signIdToken( claims, impostorKey ) },
			],
			[ 'no signature', { sign: () => unsigned } ],
			[ 'an HMAC signature', { sign: () => hmac } ],
		] )( 'refuses an ID token with %s', async ( _name, { claims, sign } ) => {
			const existing = await signInExisting();
			fake.script.idTokenClaims = claims;
			fake.script.signIdToken = sign?.();

			const { delivery, outcome } = await signIn();

			expect( outcome ).toEqual( failed( 'id-token-invalid' ) );
			expectNoSecrets( outcome, delivery.page );
			await expectUntouched( existing );
		} );

		it( 'accepts an audience given as a single string', async () => {
			fake.script.idTokenClaims = ( claims ) => ( { ...claims, aud: 'test-issued-client-1' } );

			expect( ( await signIn() ).outcome.ok ).toBe( true );
		} );

		it( 'saves nothing without the permission to use the plan', async () => {
			const existing = await signInExisting();
			fake.script.grantedScope = 'openid profile email offline_access resource.invoke';

			const { outcome } = await signIn();
			fake.script.grantedScope = null;
			const unscoped = await signIn();

			expect( outcome ).toEqual( failed( 'permission-missing' ) );
			expect( unscoped.outcome ).toEqual( failed( 'permission-missing' ) );
			await expectUntouched( existing );
		} );

		it( 'saves nothing when the keychain can’t be reached', async () => {
			const existing = await signInExisting();
			// Another process, which hasn't read the vault's key yet.
			const elsewhere = startFlow( { credentials: startBroker() } );
			keychain.state.available = false;

			const { outcome } = await signIn( existing.registrationId, undefined, elsewhere );
			const added = await signIn( undefined, undefined, elsewhere );

			expect( query( 1 ) ).toMatchObject( { login_hint: 'someone@example.com' } );
			expect( outcome ).toEqual( failed( 'vault-unavailable' ) );
			expect( added.outcome ).toEqual( failed( 'vault-unavailable' ) );
			// The new registration's grant goes; the account's own one is left to its saved session.
			expect( fake.revokeRequests.map( ( form ) => Object.fromEntries( form ) ) ).toEqual( [
				{
					token: fake.issued[ 2 ].refreshToken,
					token_type_hint: 'refresh_token',
					client_id: 'test-issued-client-2',
				},
			] );
			keychain.state.available = true;
			await expectUntouched( existing );
		} );

		describe( 'on a returning sign-in', () => {
			it( 'refuses a callback for another client', async () => {
				const existing = await signInExisting();
				fake.script.callback = ( params ) => ( {
					...params,
					client_id: 'test-issued-client-other',
				} );

				const { outcome } = await signIn( existing.registrationId );

				expect( outcome ).toEqual( failed( 'client-mismatch' ) );
				expect( fake.tokenRequests ).toHaveLength( 1 );
				await expectUntouched( existing );
			} );

			it( 'refuses another account', async () => {
				const existing = await signInExisting();
				fake.account = { subject: 'test-subject-2', email: 'other@example.com' };

				const { outcome } = await signIn( existing.registrationId );

				expect( outcome ).toEqual( failed( 'identity-mismatch' ) );
				expect( fake.tokenRequests ).toHaveLength( 2 );
				await expectUntouched( existing );
			} );

			it( 'keeps the record as it was when the plan permission is missing', async () => {
				const existing = await signInExisting();
				fake.script.grantedScope = 'openid profile email offline_access resource.invoke';

				const { outcome } = await signIn( existing.registrationId, { reconsent: true } );

				expect( outcome ).toEqual( failed( 'permission-missing' ) );
				await expectUntouched( existing );
			} );

			it( 'keeps the record as it was after a denial or an ID token that doesn’t verify', async () => {
				const existing = await signInExisting();
				fake.script.callback = ( params ) => ( { state: params.state, error: 'access_denied' } );
				const denied = await signIn( existing.registrationId );
				fake.script.callback = undefined;
				fake.script.idTokenClaims = ( claims ) => ( { ...claims, nonce: 'test-other-nonce' } );
				const unverified = await signIn( existing.registrationId );

				expect( denied.outcome ).toEqual( failed( 'denied' ) );
				expect( unverified.outcome ).toEqual( failed( 'id-token-invalid' ) );
				await expectUntouched( existing );
			} );
		} );

		describe( 'on a returning sign-in for this app session only, after a sign-out', () => {
			type Ending = 'callback' | 'cancel' | 'none';
			// Each way the attempt can end badly, set up once the account is signed out.
			const endings: Array<
				[ string, ChatGptSignInFailureCode, Ending, () => ChatGptSignInFlow | void ]
			> = [
				[ 'no callback in time', 'timed-out', 'none', () => startFlow( { timeoutMs: 150 } ) ],
				[ 'a cancel', 'cancelled', 'cancel', () => undefined ],
				[
					'a denial',
					'denied',
					'callback',
					() => {
						fake.script.callback = ( params ) => ( {
							state: params.state,
							error: 'access_denied',
						} );
					},
				],
				[
					'another error sent back',
					'authorization-failed',
					'callback',
					() => {
						fake.script.callback = ( params ) => ( { ...params, error: 'server_error' } );
					},
				],
				[
					'a callback for another client',
					'client-mismatch',
					'callback',
					() => {
						fake.script.callback = ( params ) => ( {
							...params,
							client_id: 'test-issued-client-other',
						} );
					},
				],
				[
					'a rejected code',
					'code-rejected',
					'callback',
					() => {
						fake.script.token = () => ( { status: 400, body: { error: 'invalid_grant' } } );
					},
				],
				[
					'a failed exchange',
					'token-exchange-failed',
					'callback',
					() => {
						fake.script.token = () => ( { status: 500, body: { detail: 'test-detail' } } );
					},
				],
				[
					'an ID token that doesn’t verify',
					'id-token-invalid',
					'callback',
					() => {
						fake.script.idTokenClaims = ( claims ) => ( { ...claims, nonce: 'test-other-nonce' } );
					},
				],
				[
					'another account',
					'identity-mismatch',
					'callback',
					() => {
						fake.account = { subject: 'test-subject-2', email: 'other@example.com' };
					},
				],
				[
					'no permission to use the plan',
					'permission-missing',
					'callback',
					() => {
						fake.script.grantedScope = 'openid profile email offline_access resource.invoke';
					},
				],
				[
					'a sign-out overtaking the save',
					'save-failed',
					'callback',
					() =>
						startFlow( {
							credentials: {
								saveSignIn: async () => {
									throw new ChatGptConnectionError( 'signed-out' );
								},
								readIdTokenHint: ( id ) => broker.readIdTokenHint( id ),
								checkVaultKey: () => broker.checkVaultKey(),
							},
						} ),
				],
				[
					'a save failing with an error that quotes a URL and a token',
					'save-failed',
					'callback',
					() =>
						startFlow( {
							credentials: {
								saveSignIn: async () => {
									throw new Error(
										`test-save-failure ${ fake.url }/auth/callback?code=test-auth-code-0 test-refresh-token-0`
									);
								},
								readIdTokenHint: ( id ) => broker.readIdTokenHint( id ),
								checkVaultKey: () => broker.checkVaultKey(),
							},
						} ),
				],
			];

			it.each( endings )(
				'ends after %s with the typed code %s, holding no URL or token, and restores nothing',
				async ( _name, code, ending, arrange ) => {
					const existing = await signInExisting();
					await broker.signOut( existing.registrationId );
					const using = arrange() ?? flow;

					const start = await begin( existing.registrationId, { storage: 'session' }, using );
					const urls = [ start.startUrl, start.url ];
					if ( ending === 'callback' ) {
						const callbackUrl = await authorize( start.url );
						urls.push( callbackUrl );
						await deliver( callbackUrl );
					} else if ( ending === 'cancel' ) {
						expect( using.cancel( start.attemptId ) ).toBe( true );
					}
					const outcome = await using.wait( start.attemptId );

					expect( outcome ).toEqual( {
						ok: false,
						code,
						message: new ChatGptSignInError( code ).message,
					} );
					const text = JSON.stringify( outcome );
					expect( text ).not.toMatch( /https?:|127\.0\.0\.1|auth\/callback/ );
					for ( const url of urls ) {
						expect( text ).not.toContain( url );
					}
					expectNoSecrets( outcome );
					// Nothing of the signed-out account came back, in memory or on disk.
					expect( await readChatGptAccount( existing.registrationId ) ).toMatchObject( {
						state: 'signed-out',
						storage: 'vault',
						logoutGeneration: 1,
					} );
					expect( vaultFiles() ).toEqual( [] );
					expect( broker.getSessionForkEnvironment() ).toEqual( {} );
					await expect( broker.getAccessToken( existing.registrationId ) ).rejects.toMatchObject( {
						code: 'signed-out',
					} );
				}
			);
		} );
	} );

	describe( 'the callback listener', () => {
		it( 'listens on 127.0.0.1 alone, on a port the system picks, so a busy port never fails a sign-in', async () => {
			const blocker = http.createServer();
			await new Promise< void >( ( resolve ) => blocker.listen( 0, '127.0.0.1', resolve ) );
			const busyPort = ( blocker.address() as AddressInfo ).port;
			const listen = vi.spyOn( http.Server.prototype, 'listen' );
			listen.mockImplementationOnce( function ( this: http.Server ) {
				process.nextTick( () =>
					this.emit(
						'error',
						Object.assign( new Error( `listen EADDRINUSE: 127.0.0.1:${ busyPort }` ), {
							code: 'EADDRINUSE',
						} )
					)
				);
				return this;
			} );
			try {
				const first = await begin();
				const second = await begin();

				expect( listen.mock.calls.map( ( [ options ] ) => options ) ).toEqual( [
					{ port: 0, host: '127.0.0.1' },
					{ port: 0, host: '127.0.0.1' },
					{ port: 0, host: '127.0.0.1' },
				] );
				const ports = [ first, second ].map( ( start ) =>
					Number( CALLBACK.exec( new URL( start.url ).searchParams.get( 'redirect_uri' )! )![ 1 ] )
				);
				expect( new Set( [ ...ports, busyPort ] ).size ).toBe( 3 );
				expect( await deliver( `http://[::1]:${ ports[ 0 ] }/auth/callback` ) ).toEqual( {
					status: 0,
					page: '',
				} );
				for ( const start of [ first, second ] ) {
					await deliver( await authorize( start.url ) );
					expect( ( await flow.wait( start.attemptId ) ).ok ).toBe( true );
				}
			} finally {
				await new Promise( ( resolve ) => blocker.close( resolve ) );
			}
		} );

		it( 'gives up listening after a few tries, its error holding nothing of the ID token it read', async () => {
			const existing = await signInExisting();
			const listen = vi.spyOn( http.Server.prototype, 'listen' );
			listen.mockImplementation( function ( this: http.Server ) {
				process.nextTick( () =>
					this.emit(
						'error',
						Object.assign( new Error( 'listen EADDRINUSE' ), { code: 'EADDRINUSE' } )
					)
				);
				return this;
			} );

			const error = await flow.begin( existing.registrationId ).catch( ( e ) => e );
			const tries = listen.mock.calls.length;
			listen.mockRestore();

			expect( error ).toBeInstanceOf( ChatGptSignInError );
			expect( error.code ).toBe( 'callback-unavailable' );
			expect( tries ).toBe( 3 );
			expect( fake.secrets() ).toContain( fake.issued[ 0 ].idToken );
			expectNoSecrets( error );
			await expectUntouched( existing );
		} );

		it( 'answers only a GET of its callback path, addressed to 127.0.0.1, and goes on waiting', async () => {
			const start = await begin();
			const callbackUrl = new URL( await authorize( start.url ) );
			const otherPath = new URL( callbackUrl );
			otherPath.pathname = '/callback';
			const rebound = await new Promise< number >( ( resolve, reject ) => {
				http
					.get(
						callbackUrl,
						{ headers: { host: `attacker.example:${ callbackUrl.port }` } },
						( response ) => {
							response.resume();
							resolve( response.statusCode ?? 0 );
						}
					)
					.on( 'error', reject );
			} );

			expect( ( await deliver( otherPath.toString() ) ).status ).toBe( 404 );
			expect( ( await deliver( callbackUrl.toString(), { method: 'POST' } ) ).status ).toBe( 405 );
			expect( rebound ).toBe( 400 );
			expect( fake.tokenRequests ).toHaveLength( 0 );
			expect( ( await deliver( callbackUrl.toString() ) ).status ).toBe( 200 );
			expect( ( await flow.wait( start.attemptId ) ).ok ).toBe( true );
		} );

		it( 'closes when an attempt is cancelled, and changes nothing', async () => {
			const existing = await signInExisting();
			const start = await begin();
			const callbackUrl = await authorize( start.url );

			expect( flow.cancel( start.attemptId ) ).toBe( true );

			expect( await flow.wait( start.attemptId ) ).toEqual( failed( 'cancelled' ) );
			expect( flow.cancel( start.attemptId ) ).toBe( false );
			expect( await deliver( callbackUrl ) ).toEqual( { status: 0, page: '' } );
			expect( fake.tokenRequests ).toHaveLength( 1 );
			await expectUntouched( existing );
		} );

		it( 'cancels an attempt mid-exchange, so the tokens that arrive after are never saved', async () => {
			const existing = await signInExisting();
			fake.script.tokenDelayMs = 300;
			const start = await begin();
			const delivered = deliver( await authorize( start.url ) );
			await until( () => fake.tokenRequests.length === 2 );

			expect( flow.cancel( start.attemptId ) ).toBe( true );

			expect( await flow.wait( start.attemptId ) ).toEqual( failed( 'cancelled' ) );
			const delivery = await delivered;
			expect( delivery.status ).toBe( 200 );
			expectNoSecrets( delivery.page );
			// The late tokens arrive, with a turn for anything they could set off.
			await until( () => fake.counts.tokenResponses === 2 );
			await nextTurn();
			await expectUntouched( existing );
		} );

		it( 'cancels an attempt while its ID token is being verified, so it is never saved', async () => {
			const existing = await signInExisting();
			// The ID token names a key the cached set lacks, so verifying it fetches the set again.
			const rotated = await createSigningKey( 'test-key-2' );
			fake.keys = [ signingKey, rotated ];
			fake.signingKey = rotated;
			fake.script.jwksDelayMs = 300;
			const start = await begin();
			const delivered = deliver( await authorize( start.url ) );
			await until( () => fake.counts.jwks === 2 );

			expect( flow.cancel( start.attemptId ) ).toBe( true );

			expect( await flow.wait( start.attemptId ) ).toEqual( failed( 'cancelled' ) );
			expect( ( await delivered ).status ).toBe( 200 );
			await expectUntouched( existing );
		} );

		it( 'gives up after a bounded wait, closing the listener, even while a code is being exchanged', async () => {
			expect( CHATGPT_SIGN_IN_TIMEOUT_MS ).toBe( 10 * 60_000 );
			const existing = await signInExisting();
			const quick = startFlow( { timeoutMs: 150 } );
			const waiting = await begin( undefined, undefined, quick );
			const waitingCallback = await authorize( waiting.url );
			const started = Date.now();

			expect( await quick.wait( waiting.attemptId ) ).toEqual( failed( 'timed-out' ) );
			expect( Date.now() - started ).toBeLessThan( 2_000 );
			expect( await deliver( waitingCallback ) ).toEqual( { status: 0, page: '' } );
			expect( quick.cancel( waiting.attemptId ) ).toBe( false );

			fake.script.tokenDelayMs = 500;
			const exchanging = await begin( undefined, undefined, quick );
			void deliver( await authorize( exchanging.url ) );
			expect( await quick.wait( exchanging.attemptId ) ).toEqual( failed( 'timed-out' ) );
			await until( () => fake.counts.tokenResponses === 2 );
			await nextTurn();
			await expectUntouched( existing );
		} );

		it( 'reports an attempt it doesn’t know', async () => {
			expect( await flow.wait( 'test-unknown-attempt' ) ).toEqual( failed( 'unknown-attempt' ) );
			expect( flow.cancel( 'test-unknown-attempt' ) ).toBe( false );
		} );

		it( 'keeps a second sign-in apart from one still pending: neither’s callback completes the other, and cancelling one leaves the other', async () => {
			const existing = await signInExisting();
			const first = await begin( existing.registrationId );
			const second = await begin( existing.registrationId );
			const firstCallback = new URL( await authorize( first.url ) );
			const secondCallback = new URL( await authorize( second.url ) );
			expect( firstCallback.port ).not.toBe( secondCallback.port );

			// Each listener refuses the other attempt's answer, and both go on waiting.
			for ( const [ answer, port ] of [
				[ firstCallback, secondCallback.port ],
				[ secondCallback, firstCallback.port ],
			] as const ) {
				const misdelivered = new URL( answer );
				misdelivered.port = port;
				const delivery = await deliver( misdelivered.toString() );
				expect( delivery.status ).toBe( 400 );
				expectNoSecrets( delivery.page );
			}
			expect( fake.tokenRequests ).toHaveLength( 1 );

			expect( flow.cancel( first.attemptId ) ).toBe( true );
			expect( await flow.wait( first.attemptId ) ).toEqual( failed( 'cancelled' ) );
			expect( await deliver( firstCallback.toString() ) ).toEqual( { status: 0, page: '' } );
			await expectUntouched( existing );

			expect( ( await deliver( secondCallback.toString() ) ).status ).toBe( 200 );
			expect( await flow.wait( second.attemptId ) ).toMatchObject( {
				ok: true,
				registrationId: existing.registrationId,
			} );
			expect( fake.tokenRequests ).toHaveLength( 2 );
			await expect( broker.getAccessToken( existing.registrationId ) ).resolves.toBe(
				fake.issued[ 1 ].accessToken
			);
		} );

		it( 'names only its own 127.0.0.1 listener as the callback, whatever is chosen or set in the environment', async () => {
			const previousHost = process.env.HOST;
			process.env.HOST = '0.0.0.0';
			try {
				const registrationId = registrationOf( ( await signIn() ).outcome );
				await signIn( undefined, { storage: 'session' } );
				await signIn( registrationId, { storage: 'session' } );
				await signIn( registrationId, { storage: 'vault', reconsent: true } );
				await broker.signOut( registrationId );
				await signIn( registrationId );
			} finally {
				if ( previousHost === undefined ) {
					delete process.env.HOST;
				} else {
					process.env.HOST = previousHost;
				}
			}

			expect( fake.authorizeRequests ).toHaveLength( 5 );
			const advertised = fake.authorizeRequests.map(
				( query ) => query.get( 'redirect_uri' ) ?? ''
			);
			for ( const redirectUri of advertised ) {
				expect( redirectUri ).toMatch( CALLBACK );
			}
			// The token exchange names the same callback the browser was sent to.
			expect( fake.tokenRequests.map( ( form ) => form.get( 'redirect_uri' ) ) ).toEqual(
				advertised
			);
			// Each was a listener of its own, closed with its attempt.
			expect( new Set( advertised ).size ).toBe( advertised.length );
			for ( const redirectUri of advertised ) {
				expect( await deliver( redirectUri ) ).toEqual( { status: 0, page: '' } );
			}
		} );
	} );

	describe( 'the tokens a failed sign-in was issued', () => {
		const withoutPlan = 'openid profile email offline_access resource.invoke';
		const revoked = () => fake.revokeRequests.map( ( form ) => Object.fromEntries( form ) );
		const revocationOf = ( issued: number, clientId: string ) => ( {
			token: fake.issued[ issued ].refreshToken,
			token_type_hint: 'refresh_token',
			client_id: clientId,
		} );

		it.each< [ string, ( script: FakeAuthorizationServerScript ) => void ] >( [
			[
				'lacks the permission to use the plan',
				( script ) => {
					script.grantedScope = withoutPlan;
				},
			],
			[
				'brings an ID token that doesn’t verify',
				( script ) => {
					script.idTokenClaims = ( claims ) => ( { ...claims, nonce: 'test-other-nonce' } );
				},
			],
		] )(
			'are revoked, with its issued client, when a new registration %s',
			async ( _name, misbehave ) => {
				const existing = await signInExisting();
				misbehave( fake.script );

				const { outcome } = await signIn();

				expect( outcome.ok ).toBe( false );
				expect( revoked() ).toEqual( [ revocationOf( 1, 'test-issued-client-2' ) ] );
				await expectUntouched( existing );
			}
		);

		it( 'are revoked when another account signs in to a registration', async () => {
			const existing = await signInExisting();
			fake.account = { subject: 'test-subject-2', email: 'other@example.com' };

			const { outcome } = await signIn( existing.registrationId );

			expect( outcome ).toEqual( failed( 'identity-mismatch' ) );
			expect( revoked() ).toEqual( [ revocationOf( 1, 'test-issued-client-1' ) ] );
			await expectUntouched( existing );
		} );

		it( 'are left when the other account is saved under the same client on another registration', async () => {
			// Two registrations can share an issued client: the second account
			// is saved under the first's client too.
			const existing = await signInExisting();
			fake.script.issueClient = () => 'test-issued-client-1';
			fake.account = { subject: 'test-subject-2', email: 'other@example.com' };
			const second = await signIn();
			expect( second.outcome.ok ).toBe( true );
			const before = await snapshot();

			// Signing that account in to the first registration fails as
			// another account, but its grant may be the second registration's.
			const { outcome } = await signIn( existing.registrationId );

			expect( outcome ).toEqual( failed( 'identity-mismatch' ) );
			expect( fake.revokeRequests ).toEqual( [] );
			expect( await snapshot() ).toEqual( before );
		} );

		it( 'are left when the registration’s own account signs in, or one that can’t be verified, so its session goes on', async () => {
			const existing = await signInExisting();
			fake.script.grantedScope = withoutPlan;
			const unpermitted = await signIn( existing.registrationId );
			fake.script.grantedScope = undefined;
			fake.script.idTokenClaims = ( claims ) => ( { ...claims, nonce: 'test-other-nonce' } );
			const unverified = await signIn( existing.registrationId );

			expect( unpermitted.outcome ).toEqual( failed( 'permission-missing' ) );
			expect( unverified.outcome ).toEqual( failed( 'id-token-invalid' ) );
			expect( fake.revokeRequests ).toEqual( [] );
			await expectUntouched( existing );
		} );

		it( 'are left when a registration Studio has already uses the client they were issued to', async () => {
			const existing = await signInExisting();
			fake.script.issueClient = () => 'test-issued-client-1';
			fake.script.grantedScope = withoutPlan;

			const { outcome } = await signIn();

			expect( outcome ).toEqual( failed( 'permission-missing' ) );
			expect( fake.revokeRequests ).toEqual( [] );
			await expectUntouched( existing );
		} );

		it( 'are revoked when a new registration is cancelled while its ID token is verified', async () => {
			const existing = await signInExisting();
			const rotated = await createSigningKey( 'test-key-2' );
			fake.keys = [ signingKey, rotated ];
			fake.signingKey = rotated;
			fake.script.jwksDelayMs = 300;
			const start = await begin();
			const delivered = deliver( await authorize( start.url ) );
			await until( () => fake.counts.jwks === 2 );

			expect( flow.cancel( start.attemptId ) ).toBe( true );
			await delivered;

			expect( await flow.wait( start.attemptId ) ).toEqual( failed( 'cancelled' ) );
			expect( revoked() ).toEqual( [ revocationOf( 1, 'test-issued-client-2' ) ] );
			await expectUntouched( existing );
		} );

		it( 'leave the outcome as it is when revoking them fails', async () => {
			const existing = await signInExisting();
			fake.script.grantedScope = withoutPlan;
			fake.script.revoke = () => ( { status: 503 } );

			const { outcome } = await signIn();

			expect( outcome ).toEqual( failed( 'permission-missing' ) );
			expect( revoked() ).toEqual( [ revocationOf( 1, 'test-issued-client-2' ) ] );
			await expectUntouched( existing );
		} );
	} );

	describe( 'the system browser', () => {
		it( 'is sent only the start address, and the URL it leads to, with the ID token it carries, reaches nothing returned, thrown or shown', async () => {
			const existing = await signInExisting();

			const signedIn = await signIn( existing.registrationId );
			fake.script.callback = ( params ) => ( { state: params.state, error: 'access_denied' } );
			const denied = await signIn( existing.registrationId );
			const refusing = startFlow( {
				openBrowser: async ( url ) => {
					opened.push( url );
					throw new Error( `test-opener-failure ${ url }` );
				},
			} );
			const error = await refusing.begin( existing.registrationId ).catch( ( e ) => e );

			const sent = opened.slice( -3 );
			for ( const url of sent ) {
				expect( url ).toMatch( START );
			}
			// The ID token reached the authorization endpoint alone, by way of the start address.
			expect(
				fake.authorizeRequests.slice( -2 ).map( ( query ) => query.get( 'id_token_hint' ) )
			).toEqual( [ fake.issued[ 0 ].idToken, fake.issued[ 1 ].idToken ] );
			const urls = [ ...sent, signedIn.start.url, denied.start.url ];
			expect( error ).toBeInstanceOf( ChatGptSignInError );
			expect( error.code ).toBe( 'browser-unavailable' );
			const caught = [
				signedIn.outcome,
				signedIn.delivery.page,
				denied.outcome,
				denied.delivery.page,
				error,
			];
			expectNoSecrets( ...caught );
			for ( const value of caught ) {
				const text =
					value instanceof Error
						? `${ value.message }\n${ value.stack }\n${ JSON.stringify( value ) }`
						: JSON.stringify( value );
				for ( const url of urls ) {
					expect( text ).not.toContain( url );
				}
			}
		} );

		it( 'fails an attempt whose browser can’t be opened, closing its listener, and changes nothing', async () => {
			const existing = await signInExisting();
			let sentTo = '';
			const refusing = startFlow( {
				openBrowser: async ( url ) => {
					sentTo = url;
					throw new Error( 'test-no-browser' );
				},
			} );

			const error = await refusing.begin().catch( ( e ) => e );

			expect( error ).toBeInstanceOf( ChatGptSignInError );
			expect( error.code ).toBe( 'browser-unavailable' );
			expect( sentTo ).toMatch( START );
			expect( await deliver( sentTo ) ).toEqual( { status: 0, page: '' } );
			expect( fake.tokenRequests ).toHaveLength( 1 );
			await expectUntouched( existing );
		} );

		it( 'won’t begin, listen or ask for discovery without a browser to open, and opens the one installed', async () => {
			// A fresh module, as in an app before its startup installs the opener.
			vi.resetModules();
			const app = await import( '@studio/agent/node/chatgpt/oauth' );
			const listen = vi.spyOn( http.Server.prototype, 'listen' );
			const appFlow = app.createChatGptSignInFlow( {
				discoveryUrl: fake.discoveryUrl,
				credentials: broker,
				// As every flow here: never this machine's own platform or socket tables.
				platform: 'linux',
				loopbackPeers: () => ( { ownerOf: async () => 'same-user', close: async () => undefined } ),
			} );
			flows.push( appFlow );

			const error = await appFlow.begin().catch( ( e ) => e );

			expect( error ).toBeInstanceOf( app.ChatGptSignInError );
			expect( error.code ).toBe( 'browser-unavailable' );
			expect( listen ).not.toHaveBeenCalled();
			expect( fake.counts.discovery ).toBe( 0 );

			const installed: string[] = [];
			app.setChatGptBrowserOpener( async ( url ) => {
				installed.push( url );
			} );
			const { attemptId } = await appFlow.begin();
			begun.push( attemptId );
			expect( installed ).toHaveLength( 1 );
			expect( installed[ 0 ] ).toMatch( START );
			await deliver( await authorize( await follow( installed[ 0 ] ) ) );
			expect( ( await appFlow.wait( attemptId ) ).ok ).toBe( true );
		} );

		it( 'goes on with an attempt whose callback came before the opener reported failing', async () => {
			fake.script.tokenDelayMs = 200;
			const late = startFlow( {
				openBrowser: async ( url ) => {
					void deliver( await authorize( await follow( url ) ) );
					await until( () => fake.tokenRequests.length === 1 );
					throw new Error( 'test-late-opener-failure' );
				},
			} );

			const { attemptId } = await late.begin();
			begun.push( attemptId );

			expect( ( await late.wait( attemptId ) ).ok ).toBe( true );
		} );

		it( 'returns once the attempt has ended when the browser never answers', async () => {
			const hanging = startFlow( {
				timeoutMs: 150,
				openBrowser: () => new Promise< void >( () => undefined ),
			} );

			const started = await hanging.begin();
			begun.push( started.attemptId );

			expect( started ).toEqual( { attemptId: expect.stringMatching( UUID ) } );
			expect( await hanging.wait( started.attemptId ) ).toEqual( failed( 'timed-out' ) );
		} );
	} );

	// A process's command line can be read by others on the machine, so the
	// browser opener is given an address on the attempt's own listener, which
	// sends the browser on to the authorization URL once.
	describe( 'the start address', () => {
		// Begins an attempt, leaving the start address unused.
		async function beginUnfollowed(
			registrationId?: string,
			options?: ChatGptSignInOptions,
			using: ChatGptSignInFlow = flow
		) {
			const before = opened.length;
			const { attemptId } = await using.begin( registrationId, options );
			begun.push( attemptId );
			expect( opened ).toHaveLength( before + 1 );
			return { attemptId, startUrl: opened[ before ] };
		}

		// A raw request, so its Host header can be any.
		function request( url: string, init: { method?: string; host?: string } = {} ) {
			return new Promise< { status: number; location?: string; page: string } >(
				( resolve, reject ) => {
					const sent = http.request(
						url,
						{
							method: init.method ?? 'GET',
							...( init.host ? { headers: { host: init.host } } : {} ),
						},
						( response ) => {
							let page = '';
							response.setEncoding( 'utf8' );
							response.on( 'data', ( chunk: string ) => ( page += chunk ) );
							response.on( 'end', () =>
								resolve( {
									status: response.statusCode ?? 0,
									location: response.headers.location,
									page,
								} )
							);
						}
					);
					sent.on( 'error', reject );
					sent.end();
				}
			);
		}

		it.each< [ string, 'vault' | 'session', 'new' | 'id-token' | 'email' ] >( [
			[ 'a new registration', 'vault', 'new' ],
			[ 'a new registration', 'session', 'new' ],
			[ 'a registration signed in again with its ID token as the hint', 'vault', 'id-token' ],
			[ 'a registration signed in again with its ID token as the hint', 'session', 'id-token' ],
			[ 'a signed-out registration signed in again with its email as the hint', 'vault', 'email' ],
			[
				'a signed-out registration signed in again with its email as the hint',
				'session',
				'email',
			],
		] )(
			'is all the browser opener gets for %s, kept in %s, and leads to the same authorization request',
			async ( _name, storage, kind ) => {
				let registrationId: string | undefined;
				if ( kind !== 'new' ) {
					registrationId = registrationOf( ( await signIn() ).outcome );
					if ( kind === 'email' ) {
						await broker.signOut( registrationId );
					}
				}
				const asked = fake.authorizeRequests.length;

				const { attemptId, startUrl } = await beginUnfollowed( registrationId, { storage } );
				const authorizationUrl = await follow( startUrl );
				const callbackUrl = await authorize( authorizationUrl );

				const sent = Object.fromEntries( fake.authorizeRequests[ asked ] );
				expect( sent ).toMatchObject( {
					redirect_uri: expect.stringMatching( CALLBACK ),
					state: expect.stringMatching( RANDOM ),
					nonce: expect.stringMatching( RANDOM ),
					code_challenge: expect.stringMatching( /^[\w-]{43}$/ ),
					ext_agent_host_id: await getChatGptHostId(),
				} );
				if ( kind === 'new' ) {
					expect( sent.client_id ).toBe( 'dynamic_agent_client' );
				} else {
					expect( sent.client_id ).toBe( 'test-issued-client-1' );
				}
				if ( kind === 'id-token' ) {
					expect( sent.id_token_hint ).toBe( fake.issued[ 0 ].idToken );
				}
				if ( kind === 'email' ) {
					expect( sent.login_hint ).toBe( 'someone@example.com' );
				}
				// The same listener, at a path only Studio chose, and nothing of the request.
				const [ , port ] = START.exec( startUrl )!;
				expect( new URL( sent.redirect_uri ).port ).toBe( port );
				for ( const name of [
					'state',
					'nonce',
					'code_challenge',
					'id_token_hint',
					'login_hint',
					'client_id',
					'ext_agent_host_id',
					'redirect_uri',
				] ) {
					if ( sent[ name ] ) {
						expect( startUrl ).not.toContain( sent[ name ] );
					}
				}
				const authorization = new URL( authorizationUrl );
				expect( startUrl ).not.toContain( authorization.pathname );
				expect( startUrl ).not.toContain( authorization.search.slice( 1 ) );
				expect( startUrl ).not.toContain( 'authorize' );

				await deliver( callbackUrl );
				expect( ( await flow.wait( attemptId ) ).ok ).toBe( true );
			}
		);

		it( 'sends the browser on once, uncached and without a referrer, and refuses anything else without the URL', async () => {
			const { attemptId, startUrl } = await beginUnfollowed();
			const start = new URL( startUrl );
			const at = ( pathname: string ) => `${ start.origin }${ pathname }`;
			const guessed = randomBytes( 32 ).toString( 'base64url' );

			// None of these uses the address up.
			const refusals = [
				[ 400, await request( startUrl, { host: `attacker.example:${ start.port }` } ) ],
				[ 400, await request( startUrl, { host: `localhost:${ start.port }` } ) ],
				[ 405, await request( startUrl, { method: 'POST' } ) ],
				[ 405, await request( startUrl, { method: 'HEAD' } ) ],
				[ 404, await request( at( `/${ guessed }` ) ) ],
				[ 404, await request( at( `${ start.pathname }/` ) ) ],
				[ 404, await request( at( `${ start.pathname }x` ) ) ],
				[ 404, await request( at( start.pathname.toUpperCase() ) ) ],
				[ 404, await request( at( '/' ) ) ],
			] as const;
			const response = await fetch( startUrl, { redirect: 'manual' } );
			const location = response.headers.get( 'location' )!;
			const again = await request( startUrl );

			expect( response.status ).toBe( 302 );
			expect( response.headers.get( 'cache-control' ) ).toBe( 'no-store' );
			expect( response.headers.get( 'referrer-policy' ) ).toBe( 'no-referrer' );
			expect( await response.text() ).toBe( '' );
			expect( location.startsWith( `${ fake.url }/api/accounts/authorize?` ) ).toBe( true );
			expect( fake.authorizeRequests ).toHaveLength( 0 );
			const query = new URL( location ).searchParams;
			const values = [
				'state',
				'nonce',
				'code_challenge',
				'client_id',
				'ext_agent_host_id',
				'redirect_uri',
			].map( ( name ) => query.get( name )! );
			for ( const [ status, refused ] of [ ...refusals, [ 400, again ] as const ] ) {
				expect( refused.status ).toBe( status );
				expect( refused.location ).toBeUndefined();
				expect( refused.page ).not.toMatch( /authorize|https?:/ );
				for ( const value of values ) {
					expect( refused.page ).not.toContain( value );
				}
			}

			// The attempt goes on, and its address goes with it.
			await deliver( await authorize( location ) );
			expect( ( await flow.wait( attemptId ) ).ok ).toBe( true );
			expect( await deliver( startUrl ) ).toEqual( { status: 0, page: '' } );
		} );

		it( 'ends with its attempt, cancelled or timed out, before it was used', async () => {
			const cancelled = await beginUnfollowed();
			expect( flow.cancel( cancelled.attemptId ) ).toBe( true );
			const quick = startFlow( { timeoutMs: 100 } );
			const timedOut = await beginUnfollowed( undefined, undefined, quick );
			expect( await quick.wait( timedOut.attemptId ) ).toEqual( failed( 'timed-out' ) );

			for ( const { startUrl } of [ cancelled, timedOut ] ) {
				expect( await deliver( startUrl ) ).toEqual( { status: 0, page: '' } );
			}
			expect( fake.authorizeRequests ).toHaveLength( 0 );
		} );

		it.each( [ 'completed', 'been cancelled', 'timed out' ] as const )(
			'closes a connection that sent part of a request once the sign-in has %s, the final page still whole',
			async ( ending ) => {
				const using = startFlow( { timeoutMs: ending === 'timed out' ? 300 : 60_000 } );
				const start = await begin( undefined, undefined, using );
				const address = new URL( start.startUrl );
				const partial = net.connect( Number( address.port ), address.hostname );
				partial.on( 'error', () => undefined );
				const closed = new Promise< number >( ( resolve ) =>
					partial.on( 'close', () => resolve( Date.now() ) )
				);
				await once( partial, 'connect' );
				const connectedAt = Date.now();
				// Headers begun, never ended: such a connection is held, not idle.
				partial.write( `GET /auth/callback HTTP/1.1\r\nHost: ${ address.host }\r\n` );

				if ( ending === 'completed' ) {
					const delivery = await deliver( await authorize( start.url ) );
					expect( delivery.status ).toBe( 200 );
					expect( delivery.page ).toMatch( /^<!doctype html>[\s\S]*<\/p>\n$/ );
					expect( ( await using.wait( start.attemptId ) ).ok ).toBe( true );
				} else if ( ending === 'been cancelled' ) {
					expect( using.cancel( start.attemptId ) ).toBe( true );
					expect( await using.wait( start.attemptId ) ).toEqual( failed( 'cancelled' ) );
				} else {
					expect( await using.wait( start.attemptId ) ).toEqual( failed( 'timed-out' ) );
				}
				const endedAt = Date.now();
				const closedAt = await closed;

				// Soon after the attempt ended, however long the sign-in itself took,
				// and never by the 10 seconds a held connection otherwise keeps.
				expect( closedAt - endedAt ).toBeLessThan( 5_000 );
				expect( closedAt - connectedAt ).toBeLessThan( 10_000 );
			}
		);

		it.each< NodeJS.Platform >( [ 'linux', 'darwin', 'win32' ] )(
			'on %s, is served on 8 connections at most, each closed when it sends no request within 10 seconds, and one beyond doesn’t use it up',
			async ( platform ) => {
				const createServer = vi.spyOn( http, 'createServer' );
				const capped = startFlow( { platform } );
				const { attemptId, startUrl } = await beginUnfollowed( undefined, undefined, capped );
				const server = createServer.mock.results.at( -1 )!.value as http.Server & {
					connectionsCheckingInterval: number;
				};
				let connected = 0;
				server.on( 'connection', ( socket: net.Socket ) => {
					connected++;
					socket.on( 'close', () => connected-- );
				} );
				const start = new URL( startUrl );

				const idle = await Promise.all(
					Array.from( { length: 8 }, async () => {
						const socket = net.connect( Number( start.port ), start.hostname );
						socket.on( 'error', () => undefined );
						await once( socket, 'connect' );
						return socket;
					} )
				);
				await until( () => connected === 8 );
				const beyond = await requestFrom( startUrl );
				for ( const socket of idle ) {
					socket.destroy();
				}
				await until( () => connected === 0 );

				expect( server.maxConnections ).toBe( 8 );
				// Checked every second, from the moment a connection is accepted.
				expect( server.headersTimeout ).toBe( 10_000 );
				expect( server.requestTimeout ).toBe( 10_000 );
				expect( server.connectionsCheckingInterval ).toBe( 1_000 );
				expect( beyond ).toEqual( { status: 0, location: undefined, page: '' } );
				await deliver( await authorize( await follow( startUrl ) ) );
				expect( ( await capped.wait( attemptId ) ).ok ).toBe( true );
			}
		);

		// Another user on a Linux machine can read the start address from the
		// opener's command line: the listener answers only its own user.
		describe( 'on Linux', () => {
			// A flow whose socket-table lookup gives these answers, in order.
			function linuxFlow(
				answers: Array< LoopbackPeerOwner | Error | Promise< LoopbackPeerOwner > >
			) {
				const queue = [ ...answers ];
				const owner = vi.fn( async ( _connection: LoopbackConnection ) => {
					const next = queue.shift();
					if ( next === undefined ) {
						throw new Error( 'test-unexpected-owner-lookup' );
					}
					if ( next instanceof Error ) {
						throw next;
					}
					return next;
				} );
				const close = vi.fn( async () => undefined );
				const linux = startFlow( {
					platform: 'linux',
					loopbackPeers: () => ( { ownerOf: owner, close } ),
				} );
				return { flow: linux, owner, close };
			}

			// Another user's request is told the link isn't valid; one that couldn't
			// be checked, to reload the page, which works.
			const PAGES = {
				invalid: /This sign-in link isn’t valid\./,
				reload: /Reload this page to try again\./,
			};

			function expectNothingDisclosed(
				refused: { status: number; location?: string | null; page: string },
				location: string,
				page: keyof typeof PAGES
			) {
				expect( refused.status ).toBe( 400 );
				expect( refused.location ?? undefined ).toBeUndefined();
				expect( refused.page ).not.toMatch( /authorize|https?:|code=|state=/ );
				const query = new URL( location ).searchParams;
				for ( const name of [ 'state', 'nonce', 'code_challenge', 'client_id', 'redirect_uri' ] ) {
					expect( refused.page ).not.toContain( query.get( name )! );
				}
				expect( refused.page ).toMatch( PAGES[ page ] );
				expect( refused.page ).not.toMatch( PAGES[ page === 'invalid' ? 'reload' : 'invalid' ] );
			}

			it.each< [ string, LoopbackPeerOwner | Error, keyof typeof PAGES ] >( [
				[ 'another user', 'other-user', 'invalid' ],
				[ 'an owner whose socket tables can’t be read', 'unreadable', 'reload' ],
				[ 'an owner the lookup failed to find', new Error( 'test-lookup-failure' ), 'reload' ],
			] )(
				'refuses a request from %s without disclosing anything, leaving the address and the attempt to the browser',
				async ( _name, refusal, page ) => {
					const { flow: linux, owner } = linuxFlow( [
						refusal,
						'same-user',
						refusal,
						'same-user',
					] );
					const { attemptId, startUrl } = await beginUnfollowed( undefined, undefined, linux );
					const listenerPort = Number( new URL( startUrl ).port );

					const intruded = await request( startUrl );
					const response = await fetch( startUrl, { redirect: 'manual' } );
					const location = response.headers.get( 'location' )!;
					const callbackUrl = await authorize( location );
					const intrudedCallback = await deliver( callbackUrl );
					const exchangedBefore = fake.tokenRequests.length;
					const delivered = await deliver( callbackUrl );

					expectNothingDisclosed( intruded, location, page );
					expect( response.status ).toBe( 302 );
					expect( location.startsWith( `${ fake.url }/api/accounts/authorize?` ) ).toBe( true );
					expectNothingDisclosed( intrudedCallback, location, page );
					expect( exchangedBefore ).toBe( 0 );
					expect( delivered.status ).toBe( 200 );
					expect( ( await linux.wait( attemptId ) ).ok ).toBe( true );
					expect( owner ).toHaveBeenCalledTimes( 4 );
					for ( const [ connection ] of owner.mock.calls ) {
						expect( connection ).toEqual( {
							remoteAddress: '127.0.0.1',
							remotePort: expect.any( Number ),
							localAddress: '127.0.0.1',
							localPort: listenerPort,
						} );
					}
				}
			);

			it.each< LoopbackPeerOwner >( [ 'same-user', 'root', 'unknown' ] )(
				'lets a request whose owner is %s through, as before, and closes the tables with the attempt',
				async ( answer ) => {
					const { flow: linux, owner, close } = linuxFlow( [ answer, answer ] );

					const { outcome } = await signIn( undefined, undefined, linux );

					expect( outcome.ok ).toBe( true );
					expect( owner ).toHaveBeenCalledTimes( 2 );
					expect( close ).toHaveBeenCalledTimes( 1 );
				}
			);

			it( 'closes the tables with an attempt that ends before any request', async () => {
				const cancelled = linuxFlow( [] );
				const { attemptId } = await beginUnfollowed( undefined, undefined, cancelled.flow );
				expect( cancelled.close ).not.toHaveBeenCalled();
				expect( cancelled.flow.cancel( attemptId ) ).toBe( true );
				const timedOut = linuxFlow( [] );
				const quick = startFlow( {
					timeoutMs: 100,
					platform: 'linux',
					loopbackPeers: () => ( { ownerOf: timedOut.owner, close: timedOut.close } ),
				} );
				const late = await beginUnfollowed( undefined, undefined, quick );

				expect( await quick.wait( late.attemptId ) ).toEqual( failed( 'timed-out' ) );
				expect( cancelled.close ).toHaveBeenCalledTimes( 1 );
				expect( timedOut.close ).toHaveBeenCalledTimes( 1 );
			} );

			it.each< NodeJS.Platform >( [ 'darwin', 'win32' ] )(
				'opens no socket table and asks nothing on %s, which keeps other users from reading the opener’s arguments',
				async ( platform ) => {
					const owner = vi.fn( async () => 'other-user' as const );
					const peers = vi.fn( () => ( { ownerOf: owner, close: async () => undefined } ) );
					const other = startFlow( { platform, loopbackPeers: peers } );

					const { outcome } = await signIn( undefined, undefined, other );

					expect( outcome.ok ).toBe( true );
					expect( peers ).not.toHaveBeenCalled();
					expect( owner ).not.toHaveBeenCalled();
				}
			);

			it.each( [ 'closes', 'resets' ] )(
				'leaves the address to the browser when a client %s its connection before its lookup settles',
				async ( how ) => {
					let settle: ( owner: LoopbackPeerOwner ) => void = () => undefined;
					const unsettled = new Promise< LoopbackPeerOwner >( ( resolve ) => ( settle = resolve ) );
					const { flow: linux, owner } = linuxFlow( [ unsettled, 'same-user', 'same-user' ] );
					const createServer = vi.spyOn( http, 'createServer' );
					const { attemptId, startUrl } = await beginUnfollowed( undefined, undefined, linux );
					const server = createServer.mock.results.at( -1 )!.value as http.Server;
					const accepted: net.Socket[] = [];
					server.on( 'connection', ( socket: net.Socket ) => accepted.push( socket ) );
					const start = new URL( startUrl );
					const client = net.connect( Number( start.port ), start.hostname );
					client.on( 'error', () => undefined );
					await once( client, 'connect' );

					client.write( `GET ${ start.pathname } HTTP/1.1\r\nHost: ${ start.host }\r\n\r\n` );
					await until( () => owner.mock.calls.length === 1 );
					if ( how === 'closes' ) {
						client.destroy();
					} else {
						client.resetAndDestroy();
					}
					await until( () => accepted.length === 1 && ! accepted[ 0 ].writable );
					settle( 'same-user' );
					await nextTurn();

					const location = await follow( startUrl );
					await deliver( await authorize( location ) );
					expect( ( await linux.wait( attemptId ) ).ok ).toBe( true );
					expect( owner ).toHaveBeenCalledTimes( 3 );
				}
			);

			// Through the reader itself, over stand-in /proc files the test scripts.
			describe( 'reading the socket tables', () => {
				const CONTAINER_UID_MAP = '         0     100000      65536\n';
				const busy = new Map< string, string >();

				function linuxProc( files: Record< string, string > = {} ) {
					return createFakeProc( {
						[ TCP_FILE ]: tcpTable(),
						[ TCP6_FILE ]: tcp6Table(),
						[ OVERFLOW_UID_FILE ]: '65534\n',
						[ UID_MAP_FILE ]: INITIAL_UID_MAP,
						...files,
					} );
				}

				function procFlow(
					proc: FakeProc,
					{
						lookupTimeoutMs,
						...options
					}: ChatGptSignInFlowOptions & { lookupTimeoutMs?: number } = {}
				) {
					return startFlow( {
						platform: 'linux',
						loopbackPeers: () =>
							openLoopbackPeerLookup( {
								open: proc.open,
								uid: OWN_UID,
								littleEndian: true,
								...( lookupTimeoutMs ? { timeoutMs: lookupTimeoutMs } : {} ),
							} ),
						...options,
					} );
				}

				// Lists the socket a request is about to come from as `uid`'s, in one table.
				const listedAs =
					( proc: FakeProc, startUrl: string, uid: number, file = TCP_FILE ) =>
					( localPort: number ) => {
						const listener = Number( new URL( startUrl ).port );
						proc.content.set(
							TCP_FILE,
							file === TCP_FILE
								? tcpTable( tcpRow( 1, at( localPort ), at( listener ), { uid } ) )
								: tcpTable()
						);
						proc.content.set(
							TCP6_FILE,
							file === TCP6_FILE
								? tcp6Table(
										tcp6Row(
											1,
											`${ mapped( 1 ) }:${ hex4( localPort ) }`,
											`${ mapped( 1 ) }:${ hex4( listener ) }`,
											uid
										)
								  )
								: tcp6Table()
						);
					};

				// Lists the request's socket as `uid`'s at the very end of a busy host's
				// table, over the 4 MiB an earlier bound refused.
				const listedLastAs =
					( proc: FakeProc, startUrl: string, uid: number, file = TCP_FILE ) =>
					( localPort: number ) => {
						const listener = Number( new URL( startUrl ).port );
						let others = busy.get( file );
						if ( ! others ) {
							const rows = Array.from( { length: 40_000 }, ( _, slot ) =>
								file === TCP_FILE
									? tcpRow( slot + 10, at( 20_000 + slot, v4( 9 ) ), at( 443, 'C0A80001' ), {
											uid: OTHER_UID,
									  } )
									: tcp6Row(
											slot + 10,
											`${ mapped( 9 ) }:${ hex4( 20_000 + slot ) }`,
											`${ mapped( 9 ) }:01BB`,
											OTHER_UID
									  )
							);
							others = file === TCP_FILE ? tcpTable( ...rows ) : tcp6Table( ...rows );
							busy.set( file, others );
						}
						const row =
							file === TCP_FILE
								? tcpRow( 1, at( localPort ), at( listener ), { uid } )
								: tcp6Row(
										1,
										`${ mapped( 1 ) }:${ hex4( localPort ) }`,
										`${ mapped( 1 ) }:${ hex4( listener ) }`,
										uid
								  );
						proc.content.set( TCP_FILE, tcpTable() );
						proc.content.set( TCP6_FILE, tcp6Table() );
						proc.content.set( file, `${ others }${ row }\n` );
						expect( Buffer.byteLength( proc.content.get( file )! ) ).toBeGreaterThan(
							5 * 1024 * 1024
						);
					};

				it( 'opens the tables as its listener starts, before the browser, reads them again for each request, and closes them with the attempt', async () => {
					const proc = linuxProc();
					const openWhenBrowsing: string[][] = [];
					const linux = procFlow( proc, {
						openBrowser: async ( url ) => {
							openWhenBrowsing.push( [ ...proc.opens ] );
							opened.push( url );
						},
					} );
					const { attemptId, startUrl } = await beginUnfollowed( undefined, undefined, linux );
					const mine = listedAs( proc, startUrl, OWN_UID );

					const intruded = await requestFrom( startUrl, listedAs( proc, startUrl, OTHER_UID ) );
					const location = ( await requestFrom( startUrl, mine ) ).location!;
					const delivered = await requestFrom( await authorize( location ), mine );

					expect( openWhenBrowsing ).toEqual( [
						expect.arrayContaining( [ TCP_FILE, TCP6_FILE ] ),
					] );
					expectNothingDisclosed( intruded, location, 'invalid' );
					expect( delivered.status ).toBe( 200 );
					expect( await linux.wait( attemptId ) ).toMatchObject( { ok: true } );
					for ( const file of [ TCP_FILE, TCP6_FILE ] ) {
						expect( proc.opens.filter( ( opened ) => opened === file ) ).toHaveLength( 1 );
						expect(
							proc.reads.filter( ( read ) => read.file === file && read.position === 0 )
						).toHaveLength( 3 );
					}
					await until(
						() => proc.closes.includes( TCP_FILE ) && proc.closes.includes( TCP6_FILE )
					);
				} );

				const FAILURES: Array< {
					name: string;
					fail: ( proc: FakeProc, file: string ) => void;
					lookupTimeoutMs?: number;
					recoverMs?: number;
				} > = [
					...[ 'EMFILE', 'ENFILE', 'ENOMEM', 'EIO' ].map( ( code ) => ( {
						name: `a read failing with ${ code }`,
						fail: ( proc: FakeProc, file: string ) =>
							proc.failNextRead( file, systemError( code ) ),
					} ) ),
					{
						name: 'a read slower than a lookup may take',
						fail: ( proc, file ) => proc.failNextRead( file, { stallMs: 300 } ),
						lookupTimeoutMs: 100,
						recoverMs: 300,
					},
					{
						name: 'a read failing in a way it doesn’t expect',
						fail: ( proc, file ) =>
							proc.failNextRead( file, new TypeError( 'test-unexpected-read' ) ),
					},
					{
						name: 'a read failing partway through the table',
						fail: ( proc, file ) =>
							proc.failNextRead( file, { failAfter: 1, error: systemError( 'EIO' ) } ),
					},
					{
						name: 'a table in a layout it doesn’t know',
						fail: ( proc, file ) => proc.failNextRead( file, { text: 'not a socket table\n' } ),
					},
				];
				const CASES = FAILURES.flatMap( ( failure ) =>
					[ TCP_FILE, TCP6_FILE ].flatMap( ( file ) =>
						( [ 'start address', 'callback' ] as const ).map( ( kind ) => ( {
							...failure,
							file,
							kind,
						} ) )
					)
				);

				it.each( CASES )(
					'refuses the $kind for $name in $file, though its owner is this user, leaving the address and the attempt to the browser',
					async ( { fail, file, kind, lookupTimeoutMs, recoverMs } ) => {
						const proc = linuxProc();
						const linux = procFlow( proc, { lookupTimeoutMs } );
						const { attemptId, startUrl } = await beginUnfollowed( undefined, undefined, linux );
						const mine = listedAs( proc, startUrl, OWN_UID );
						let target = startUrl;
						let location: string | undefined;
						if ( kind === 'callback' ) {
							location = ( await requestFrom( startUrl, mine ) ).location!;
							target = await authorize( location );
						}

						fail( proc, file );
						const refused = await requestFrom( target, mine );
						await sleep( recoverMs ?? 0 );
						const exchangedBefore = fake.tokenRequests.length;
						const answered = await requestFrom( target, mine );
						if ( kind === 'start address' ) {
							location = answered.location!;
							expect( ( await requestFrom( await authorize( location ), mine ) ).status ).toBe(
								200
							);
						}

						expect( answered.status ).toBe( kind === 'start address' ? 302 : 200 );
						// Told to reload, which, as `answered` shows, works.
						expectNothingDisclosed( refused, location!, 'reload' );
						expect( exchangedBefore ).toBe( 0 );
						expect( await linux.wait( attemptId ) ).toMatchObject( { ok: true } );
					}
				);

				it.each( [ 'ENOENT', 'EACCES' ] )(
					'decides from the other table when the kernel hides one with %s',
					async ( code ) => {
						const proc = linuxProc();
						proc.failNextOpen( TCP_FILE, systemError( code ) );
						const linux = procFlow( proc );
						const { attemptId, startUrl } = await beginUnfollowed( undefined, undefined, linux );

						// Listed in the table it can read: another user is refused, this one let through.
						const intruded = await requestFrom(
							startUrl,
							listedAs( proc, startUrl, OTHER_UID, TCP6_FILE )
						);
						const response = await requestFrom(
							startUrl,
							listedAs( proc, startUrl, OWN_UID, TCP6_FILE )
						);
						// Listed only where the kernel hides it, with the other table hidden too: let through.
						proc.failNextRead( TCP6_FILE, systemError( code ) );
						const delivered = await requestFrom(
							await authorize( response.location! ),
							listedAs( proc, startUrl, OTHER_UID, TCP_FILE )
						);

						expectNothingDisclosed( intruded, response.location!, 'invalid' );
						expect( response.status ).toBe( 302 );
						expect( delivered.status ).toBe( 200 );
						expect( await linux.wait( attemptId ) ).toMatchObject( { ok: true } );
					}
				);

				it.each( [ TCP_FILE, TCP6_FILE ] )(
					'finds the request’s row at the end of a busy host’s %s, over 4 MiB: another user refused, this user let through',
					async ( file ) => {
						const proc = linuxProc();
						const linux = procFlow( proc );
						const { attemptId, startUrl } = await beginUnfollowed( undefined, undefined, linux );
						const mine = listedLastAs( proc, startUrl, OWN_UID, file );

						const intruded = await requestFrom(
							startUrl,
							listedLastAs( proc, startUrl, OTHER_UID, file )
						);
						const response = await requestFrom( startUrl, mine );
						const delivered = await requestFrom( await authorize( response.location! ), mine );

						expectNothingDisclosed( intruded, response.location!, 'invalid' );
						expect( response.status ).toBe( 302 );
						expect( delivered.status ).toBe( 200 );
						expect( await linux.wait( attemptId ) ).toMatchObject( { ok: true } );
					}
				);

				it( 'refuses a request listed as the overflow uid where every uid is mapped, the initial user namespace', async () => {
					const proc = linuxProc();
					const linux = procFlow( proc );
					const { attemptId, startUrl } = await beginUnfollowed( undefined, undefined, linux );
					const mine = listedAs( proc, startUrl, OWN_UID );

					const nobody = await requestFrom( startUrl, listedAs( proc, startUrl, 65534 ) );
					const location = ( await requestFrom( startUrl, mine ) ).location!;
					await requestFrom( await authorize( location ), mine );

					expectNothingDisclosed( nobody, location, 'invalid' );
					expect( await linux.wait( attemptId ) ).toMatchObject( { ok: true } );
				} );

				it( 'lets a request listed as the overflow uid through under another uid map, where it proves no owner', async () => {
					const proc = linuxProc( { [ UID_MAP_FILE ]: CONTAINER_UID_MAP } );
					const linux = procFlow( proc );
					const { attemptId, startUrl } = await beginUnfollowed( undefined, undefined, linux );
					const nobody = listedAs( proc, startUrl, 65534 );

					const response = await requestFrom( startUrl, nobody );
					const delivered = await requestFrom( await authorize( response.location! ), nobody );

					expect( response.status ).toBe( 302 );
					expect( delivered.status ).toBe( 200 );
					expect( await linux.wait( attemptId ) ).toMatchObject( { ok: true } );
				} );
			} );
		} );
	} );

	// Saved sign-ins whose key the keychain says it doesn't have: the user hears
	// so before the browser opens, not after finishing ChatGPT's page.
	describe( 'a sign-in to keep in secure storage while the saved sign-ins’ key can’t be read', () => {
		async function savedUnderUnreadableKey() {
			const existing = await signInExisting();
			keychain.items.clear();
			return existing;
		}

		async function expectRefusedBeforeTheBrowser( starting: () => Promise< unknown > ) {
			const listen = vi.spyOn( http.Server.prototype, 'listen' );
			const openedBefore = opened.length;
			const discoveries = fake.counts.discovery;

			const error = await starting().then(
				() => null,
				( failure: unknown ) => failure
			);

			expect( error ).toBeInstanceOf( ChatGptSignInError );
			expect( error ).toMatchObject( {
				code: 'vault-key-unreadable',
				message: new ChatGptSignInError( 'vault-key-unreadable' ).message,
			} );
			expect( listen ).not.toHaveBeenCalled();
			expect( opened ).toHaveLength( openedBefore );
			expect( fake.counts.discovery ).toBe( discoveries );
			expect( keychain.items.size ).toBe( 0 );
			listen.mockRestore();
		}

		it.each< [ string, 'new' | 'saved' | 'saved, kept where it was' ] >( [
			[ 'a new registration', 'new' ],
			[ 'a saved registration', 'saved' ],
			[ 'a saved registration with no storage chosen', 'saved, kept where it was' ],
		] )( 'is refused for %s before any listener, discovery or browser', async ( _name, kind ) => {
			const existing = await savedUnderUnreadableKey();
			const registrationId = kind === 'new' ? undefined : existing.registrationId;
			const options: ChatGptSignInOptions =
				kind === 'saved, kept where it was' ? {} : { storage: 'vault' };

			await expectRefusedBeforeTheBrowser( () => flow.begin( registrationId, options ) );

			expect( saves ).toHaveLength( existing.saved );
			expect( await snapshot() ).toEqual( existing.before );
		} );

		it( 'is refused by the app’s own sign-in, which the CLI and the Desktop app both start', async () => {
			await savedUnderUnreadableKey();
			vi.resetModules();
			const app = await import( '@studio/agent/node/chatgpt/oauth' );
			const appFlow = app.createChatGptSignInFlow( {
				discoveryUrl: fake.discoveryUrl,
				openBrowser,
			} );
			flows.push( appFlow );

			const listen = vi.spyOn( http.Server.prototype, 'listen' );
			const error = await appFlow.begin( undefined, { storage: 'vault' } ).catch( ( e ) => e );

			expect( error ).toBeInstanceOf( app.ChatGptSignInError );
			expect( error.code ).toBe( 'vault-key-unreadable' );
			expect( listen ).not.toHaveBeenCalled();
		} );

		it( 'goes on as before when the key can be read, or no saved sign-in needs one', async () => {
			// No saved sign-in: the first makes the key.
			expect( ( await signIn( undefined, { storage: 'vault' } ) ).outcome.ok ).toBe( true );
			// Saved sign-ins, and their key there.
			expect( ( await signIn( undefined, { storage: 'vault' } ) ).outcome.ok ).toBe( true );
			expect( keychain.items.size ).toBe( 1 );
		} );

		it( 'asks the keychain nothing before the browser for a first sign-in, while no sign-in is saved', async () => {
			const get = vi.spyOn( keychain.store, 'get' );
			const listen = vi.spyOn( http.Server.prototype, 'listen' );

			const { attemptId, url } = await begin( undefined, { storage: 'vault' } );

			expect( get ).not.toHaveBeenCalled();
			expect( listen ).toHaveBeenCalledTimes( 1 );
			expect( opened ).toHaveLength( 1 );
			await deliver( await authorize( url ) );
			expect( ( await flow.wait( attemptId ) ).ok ).toBe( true );
			// The save, after the browser, made the key.
			expect( get ).toHaveBeenCalled();
			expect( keychain.items.size ).toBe( 1 );
		} );

		it( 'leaves a sign-in for this app session only to go on', async () => {
			await savedUnderUnreadableKey();

			const { outcome } = await signIn( undefined, { storage: 'session' } );

			expect( outcome.ok ).toBe( true );
			expect( keychain.items.size ).toBe( 0 );
		} );

		it( 'is still refused when saving, if the key becomes unreadable after the attempt began', async () => {
			const existing = await signInExisting();
			const start = await begin( undefined, { storage: 'vault' } );
			keychain.items.clear();

			await deliver( await authorize( start.url ) );

			expect( await flow.wait( start.attemptId ) ).toEqual( failed( 'vault-key-unreadable' ) );
			expect( await snapshot() ).toEqual( existing.before );
			expect( keychain.items.size ).toBe( 0 );
		} );
	} );

	describe( 'discovery and keys', () => {
		it.each( [
			[
				'names another issuer',
				( document: Record< string, string > ) => ( {
					status: 200,
					body: { ...document, issuer: 'https://auth.example.com' },
				} ),
			],
			[ 'fails', () => ( { status: 500, body: { detail: 'test-detail' } } ) ],
			[ 'isn’t JSON', () => ( { status: 200, body: 'test-not-json' } ) ],
			[
				'lacks the key set',
				( { jwks_uri: _jwks, ...document }: Record< string, string > ) => ( {
					status: 200,
					body: document,
				} ),
			],
			[
				'lacks the revocation endpoint',
				( { revocation_endpoint: _revocation, ...document }: Record< string, string > ) => ( {
					status: 200,
					body: document,
				} ),
			],
			[
				'names an endpoint that isn’t a URL',
				( document: Record< string, string > ) => ( {
					status: 200,
					body: { ...document, token_endpoint: 'test-not-a-url' },
				} ),
			],
			[
				'names an endpoint another way than it was served',
				( document: Record< string, string > ) => ( {
					status: 200,
					body: { ...document, token_endpoint: document.token_endpoint.replace( 'http:', 'ftp:' ) },
				} ),
			],
		] )( 'won’t begin, or listen, when discovery %s', async ( _name, discovery ) => {
			fake.script.discovery = discovery;
			const listen = vi.spyOn( http.Server.prototype, 'listen' );

			const error = await flow.begin().catch( ( e ) => e );

			expect( error ).toBeInstanceOf( ChatGptSignInError );
			expect( error.code ).toBe( 'discovery-failed' );
			expect( listen ).not.toHaveBeenCalled();
			expect( fake.authorizeRequests ).toHaveLength( 0 );
		} );

		it( 'won’t begin when discovery can’t be reached', async () => {
			const unreachable = startFlow( {
				discoveryUrl: `http://127.0.0.1:${ await closedPort() }/.well-known/openid-configuration`,
			} );

			const error = await unreachable.begin().catch( ( e ) => e );

			expect( error ).toBeInstanceOf( ChatGptSignInError );
			expect( error.code ).toBe( 'discovery-failed' );
		} );

		it( 'uses only discovery’s endpoints, whatever a callback names', async () => {
			const decoy: string[] = [];
			const decoyServer = http.createServer( ( request, response ) => {
				decoy.push( request.url ?? '' );
				response.end();
			} );
			await new Promise< void >( ( resolve ) => decoyServer.listen( 0, '127.0.0.1', resolve ) );
			const decoyUrl = `http://127.0.0.1:${ ( decoyServer.address() as AddressInfo ).port }`;
			fake.script.callback = ( params ) => ( {
				...params,
				iss: decoyUrl,
				token_endpoint: `${ decoyUrl }/token`,
				jwks_uri: `${ decoyUrl }/jwks`,
			} );
			try {
				expect( ( await signIn() ).outcome.ok ).toBe( true );
				expect( decoy ).toEqual( [] );
				expect( fake.tokenRequests ).toHaveLength( 1 );
			} finally {
				await new Promise( ( resolve ) => decoyServer.close( resolve ) );
			}
		} );

		it( 'keeps the key set, and fetches it again once for a key it hasn’t seen', async () => {
			await signIn();
			await signIn();
			expect( fake.counts.jwks ).toBe( 1 );

			const rotated = await createSigningKey( 'test-key-2' );
			fake.keys = [ rotated ];
			fake.signingKey = rotated;
			expect( ( await signIn() ).outcome.ok ).toBe( true );
			expect( fake.counts.jwks ).toBe( 2 );

			fake.script.signIdToken = ( claims ) => signIdToken( claims, unpublishedKey );
			expect( ( await signIn() ).outcome ).toEqual( failed( 'id-token-invalid' ) );
			expect( fake.counts.jwks ).toBe( 3 );
		} );
	} );

	describe( 'the token client', () => {
		const request = ( overrides: Partial< ChatGptTokenRequest > = {} ): ChatGptTokenRequest => ( {
			clientId: 'test-issued-client-1',
			refreshToken: 'test-refresh-token-held',
			signal: new AbortController().signal,
			...overrides,
		} );

		it( 'refreshes at discovery’s token endpoint with the issued client, without asking for scopes', async () => {
			const client = createChatGptTokenClient( { discoveryUrl: fake.discoveryUrl } );

			const result = await client.refresh( request() );
			await client.refresh( request() );

			expect( result ).toEqual( {
				ok: true,
				value: {
					accessToken: fake.issued[ 0 ].accessToken,
					refreshToken: fake.issued[ 0 ].refreshToken,
					tokenType: 'Bearer',
					expiresIn: 3600,
					scope: GRANTED_SCOPE,
				},
			} );
			expect( tokenForm( 0 ) ).toEqual( {
				grant_type: 'refresh_token',
				client_id: 'test-issued-client-1',
				refresh_token: 'test-refresh-token-held',
				resource: RESOURCE,
			} );
			expect( fake.counts.discovery ).toBe( 1 );
		} );

		it.each( CHATGPT_TERMINAL_REFRESH_ERRORS )(
			'reads %s as a refresh token that can’t be used again, in either error shape',
			async ( code ) => {
				const client = createChatGptTokenClient( { discoveryUrl: fake.discoveryUrl } );

				fake.script.token = () => ( {
					status: 400,
					body: { error: code, error_description: 'test' },
				} );
				const oauthShape = await client.refresh( request() );
				fake.script.token = () => ( { status: 401, body: { error: { code, message: 'test' } } } );
				const objectShape = await client.refresh( request() );

				expect( oauthShape ).toEqual( {
					ok: false,
					error: { kind: 'terminal', code, status: 400 },
				} );
				expect( objectShape ).toEqual( {
					ok: false,
					error: { kind: 'terminal', code, status: 401 },
				} );
			}
		);

		it.each( CHATGPT_TERMINAL_REFRESH_ERRORS )(
			'reads a server error as a failure that may pass, even one that carries %s',
			async ( code ) => {
				const client = createChatGptTokenClient( { discoveryUrl: fake.discoveryUrl } );

				fake.script.token = () => ( { status: 503, body: { error: code } } );
				const oauthShape = await client.refresh( request() );
				fake.script.token = () => ( { status: 500, body: { error: { code } } } );
				const objectShape = await client.refresh( request() );

				expect( oauthShape ).toEqual( {
					ok: false,
					error: { kind: 'transient', code, status: 503 },
				} );
				expect( objectShape ).toEqual( {
					ok: false,
					error: { kind: 'transient', code, status: 500 },
				} );
			}
		);

		it( 'reads anything else as a failure that may pass, keeping the credentials', async () => {
			const client = createChatGptTokenClient( { discoveryUrl: fake.discoveryUrl } );
			const answers = [
				{ status: 503, body: { error: 'server_error' } },
				{ status: 401, body: { detail: 'test-detail' } },
				{ status: 400, body: { error: 'invalid_client' } },
				{ status: 429, body: { error: { code: 'rate_limit_exceeded' } } },
				{ status: 200, body: { token_type: 'Bearer' } },
			];
			const results = [];
			for ( const answer of answers ) {
				fake.script.token = () => answer;
				results.push( await client.refresh( request() ) );
			}
			const aborted = new AbortController();
			aborted.abort();
			fake.script.token = undefined;
			results.push( await client.refresh( request( { signal: aborted.signal } ) ) );

			expect( results ).toEqual( [
				{ ok: false, error: { kind: 'transient', code: 'server_error', status: 503 } },
				{ ok: false, error: { kind: 'transient', status: 401 } },
				{ ok: false, error: { kind: 'transient', code: 'invalid_client', status: 400 } },
				{ ok: false, error: { kind: 'transient', code: 'rate_limit_exceeded', status: 429 } },
				{ ok: false, error: { kind: 'transient', code: 'invalid_response', status: 200 } },
				{ ok: false, error: { kind: 'transient' } },
			] );
		} );

		it( 'reads an endpoint it can’t reach, or discovery that fails, as a failure that may pass', async () => {
			const port = await closedPort();
			fake.script.discovery = ( document ) => ( {
				status: 200,
				body: {
					...document,
					token_endpoint: `http://127.0.0.1:${ port }/token`,
					revocation_endpoint: `http://127.0.0.1:${ port }/revoke`,
				},
			} );
			const unreachable = createChatGptTokenClient( { discoveryUrl: fake.discoveryUrl } );
			const undiscovered = createChatGptTokenClient( {
				discoveryUrl: `http://127.0.0.1:${ port }/.well-known/openid-configuration`,
			} );

			expect( await unreachable.refresh( request() ) ).toEqual( {
				ok: false,
				error: { kind: 'transient' },
			} );
			expect( await unreachable.revoke( request() ) ).toEqual( {
				ok: false,
				error: { kind: 'transient' },
			} );
			for ( const result of [
				await undiscovered.refresh( request() ),
				await undiscovered.revoke( request() ),
			] ) {
				expect( result ).toEqual( {
					ok: false,
					error: { kind: 'transient', code: 'discovery_failed' },
				} );
			}
		} );

		it( 'revokes at discovery’s revocation endpoint, confirmed by a 200, retried only after a server error or a rate limit', async () => {
			const client = createChatGptTokenClient( { discoveryUrl: fake.discoveryUrl } );

			const confirmed = await client.revoke( request() );
			fake.script.revoke = () => ( { status: 503 } );
			const unavailable = await client.revoke( request() );
			fake.script.revoke = () => ( { status: 400, body: { error: 'invalid_client' } } );
			const refused = await client.revoke( request() );
			fake.script.revoke = () => ( { status: 429, body: { error: 'rate_limit_exceeded' } } );
			const limited = await client.revoke( request() );

			expect( confirmed ).toEqual( { ok: true, value: undefined } );
			expect( Object.fromEntries( fake.revokeRequests[ 0 ] ) ).toEqual( {
				token: 'test-refresh-token-held',
				token_type_hint: 'refresh_token',
				client_id: 'test-issued-client-1',
			} );
			expect( unavailable ).toEqual( { ok: false, error: { kind: 'transient', status: 503 } } );
			expect( refused ).toEqual( {
				ok: false,
				error: { kind: 'terminal', code: 'invalid_client', status: 400 },
			} );
			expect( limited ).toEqual( {
				ok: false,
				error: { kind: 'transient', code: 'rate_limit_exceeded', status: 429 },
			} );
		} );

		it( 'renews and revokes a sign-in’s tokens for the credential broker', async () => {
			fake.script.expiresIn = 60;
			const registrationId = registrationOf( ( await signIn() ).outcome );

			const renewed = await broker.getAccessToken( registrationId );

			expect( renewed ).toBe( fake.issued[ 1 ].accessToken );
			expect( tokenForm( 1 ) ).toEqual( {
				grant_type: 'refresh_token',
				client_id: 'test-issued-client-1',
				refresh_token: fake.issued[ 0 ].refreshToken,
				resource: RESOURCE,
			} );
			expect( await broker.signOut( registrationId ) ).toEqual( {
				localCleared: true,
				remoteRevocationConfirmed: true,
			} );
			expect( Object.fromEntries( fake.revokeRequests[ 0 ] ) ).toEqual( {
				token: fake.issued[ 1 ].refreshToken,
				token_type_hint: 'refresh_token',
				client_id: 'test-issued-client-1',
			} );
		} );

		it( 'has the credential broker try a rate-limited revocation again, until it is confirmed', async () => {
			const registrationId = registrationOf( ( await signIn() ).outcome );
			let answered = 0;
			fake.script.revoke = () =>
				answered++ === 0
					? { status: 429, body: { error: 'rate_limit_exceeded' } }
					: { status: 200 };

			expect( await broker.signOut( registrationId ) ).toEqual( {
				localCleared: true,
				remoteRevocationConfirmed: true,
			} );
			expect( fake.revokeRequests ).toHaveLength( 2 );
		} );
	} );
} );
