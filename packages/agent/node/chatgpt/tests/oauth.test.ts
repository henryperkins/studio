// @vitest-environment node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { base64url, SignJWT, type JWTPayload } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	getChatGptHostId,
	readChatGptAccount,
	readChatGptAccounts,
} from '@studio/agent/node/chatgpt/account-store';
import {
	CHATGPT_TERMINAL_REFRESH_ERRORS,
	createChatGptCredentialBroker,
	type ChatGptCredentialBroker,
	type ChatGptSignIn,
	type ChatGptTokenRequest,
} from '@studio/agent/node/chatgpt/credential-broker';
import {
	CHATGPT_SIGN_IN_TIMEOUT_MS,
	ChatGptSignInError,
	createChatGptSignInFlow,
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
	type SigningKey,
} from './fixtures/fake-authorization-server';
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

const sleep = ( ms: number ) => new Promise( ( resolve ) => setTimeout( resolve, ms ) );

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

	function startFlow( options: ChatGptSignInFlowOptions = {} ) {
		const created = createChatGptSignInFlow( {
			discoveryUrl: fake.discoveryUrl,
			credentials: {
				saveSignIn: ( signIn ) => {
					saves.push( signIn );
					return broker.saveSignIn( signIn );
				},
				readIdTokenHint: ( registrationId ) => broker.readIdTokenHint( registrationId ),
			},
			openBrowser,
			...options,
		} );
		flows.push( created );
		return created;
	}

	async function begin(
		registrationId?: string,
		options?: ChatGptSignInOptions,
		using: ChatGptSignInFlow = flow
	) {
		const before = opened.length;
		const started = await using.begin( registrationId, options );
		begun.push( started.attemptId );
		// The caller gets the attempt id alone; the URL went to the browser.
		expect( started ).toEqual( { attemptId: expect.stringMatching( UUID ) } );
		expect( opened ).toHaveLength( before + 1 );
		return { attemptId: started.attemptId, url: opened[ before ] };
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
			expect( fake.counts ).toEqual( { discovery: 1, jwks: 1 } );
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
			await sleep( 400 );
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
			await sleep( 600 );
			await expectUntouched( existing );
		} );

		it( 'reports an attempt it doesn’t know', async () => {
			expect( await flow.wait( 'test-unknown-attempt' ) ).toEqual( failed( 'unknown-attempt' ) );
			expect( flow.cancel( 'test-unknown-attempt' ) ).toBe( false );
		} );
	} );

	describe( 'the system browser', () => {
		it( 'is sent the URL, which, with the ID token it carries, reaches nothing returned, thrown or shown', async () => {
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

			const urls = opened.slice( -3 );
			expect( urls.map( ( url ) => new URL( url ).searchParams.get( 'id_token_hint' ) ) ).toEqual( [
				fake.issued[ 0 ].idToken,
				fake.issued[ 1 ].idToken,
				fake.issued[ 1 ].idToken,
			] );
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
			expect( await deliver( await authorize( sentTo ) ) ).toEqual( { status: 0, page: '' } );
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
			await deliver( await authorize( installed[ 0 ] ) );
			expect( ( await appFlow.wait( attemptId ) ).ok ).toBe( true );
		} );

		it( 'goes on with an attempt whose callback came before the opener reported failing', async () => {
			fake.script.tokenDelayMs = 200;
			const late = startFlow( {
				openBrowser: async ( url ) => {
					void deliver( await authorize( url ) );
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

		it( 'revokes at discovery’s revocation endpoint, confirmed by a 200, retried only after a server error', async () => {
			const client = createChatGptTokenClient( { discoveryUrl: fake.discoveryUrl } );

			const confirmed = await client.revoke( request() );
			fake.script.revoke = () => ( { status: 503 } );
			const unavailable = await client.revoke( request() );
			fake.script.revoke = () => ( { status: 400, body: { error: 'invalid_client' } } );
			const refused = await client.revoke( request() );

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
	} );
} );
