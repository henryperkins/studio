import { createHash } from 'node:crypto';
import http from 'node:http';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from 'jose';
import type { AddressInfo } from 'node:net';

/**
 * A local stand-in for OpenAI's authorization server, on 127.0.0.1: its
 * discovery document, key set, authorize page, and token and revocation
 * endpoints, answering as Sign in with ChatGPT documents them. Each test
 * scripts how it misbehaves. Everything it issues is an obvious placeholder,
 * except ID tokens, which are real JWTs signed with keys a test generated.
 */

export const TEST_ISSUER = 'https://auth.openai.com';
export const GRANTED_SCOPE =
	'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const REGISTRATION_CLIENT_ID = 'dynamic_agent_client';

type PrivateKey = Awaited< ReturnType< typeof generateKeyPair > >[ 'privateKey' ];

export interface SigningKey {
	kid: string;
	privateKey: PrivateKey;
	/** The public half, as the key set publishes it. */
	jwk: JWK;
}

export async function createSigningKey( kid: string ): Promise< SigningKey > {
	const { privateKey, publicKey } = await generateKeyPair( 'RS256' );
	return {
		kid,
		privateKey,
		jwk: { ...( await exportJWK( publicKey ) ), kid, alg: 'RS256', use: 'sig' },
	};
}

export function signIdToken( claims: JWTPayload, key: SigningKey ): Promise< string > {
	return new SignJWT( claims )
		.setProtectedHeader( { alg: 'RS256', kid: key.kid, typ: 'JWT' } )
		.sign( key.privateKey );
}

export interface TestAccount {
	subject: string;
	email: string;
}

export interface IssuedTokens {
	accessToken: string;
	refreshToken: string;
	idToken?: string;
}

type Reply = ( status: number, body?: unknown, headers?: http.OutgoingHttpHeaders ) => void;

interface Answer {
	status: number;
	body?: unknown;
}

/** How the server misbehaves; a test sets what it needs. */
export interface FakeAuthorizationServerScript {
	/** Answers discovery instead of the server's own document, which it is given. */
	discovery?: ( document: Record< string, string > ) => Answer;
	/** The client a first sign-in is issued: a new one each time by default. */
	issueClient?: () => string;
	/** Rewrites the parameters the browser is sent back to the callback with. */
	callback?: ( params: Record< string, string > ) => Record< string, string >;
	/** Rewrites an ID token's claims before it is signed. */
	idTokenClaims?: ( claims: JWTPayload ) => JWTPayload;
	/** Signs an ID token some other way than with the current key. */
	signIdToken?: ( claims: JWTPayload ) => Promise< string >;
	/** The scope a token response grants; null leaves it out. */
	grantedScope?: string | null;
	expiresIn?: number;
	/** Answers a token request instead of the server's own logic, unless it returns undefined. */
	token?: ( form: URLSearchParams ) => Answer | undefined;
	/** Holds every token response this long. */
	tokenDelayMs?: number;
	/** Holds every key set response this long. */
	jwksDelayMs?: number;
	revoke?: ( form: URLSearchParams ) => Answer;
}

export interface FakeAuthorizationServer {
	readonly url: string;
	readonly discoveryUrl: string;
	/** Who the browser signs in as. */
	account: TestAccount;
	script: FakeAuthorizationServerScript;
	/** The key ID tokens are signed with, and the key set published. */
	signingKey: SigningKey;
	keys: SigningKey[];
	readonly authorizeRequests: URLSearchParams[];
	readonly tokenRequests: URLSearchParams[];
	readonly revokeRequests: URLSearchParams[];
	/** What each successful token response carried, in order. */
	readonly issued: IssuedTokens[];
	/** Requests answered; `tokenResponses` counts token responses sent, late ones too. */
	readonly counts: { discovery: number; jwks: number; tokenResponses: number };
	/** Every code, token, verifier, nonce and ID token hint it issued or was shown. */
	secrets(): string[];
	close(): Promise< void >;
}

function readForm( request: http.IncomingMessage ): Promise< URLSearchParams > {
	return new Promise( ( resolve, reject ) => {
		let body = '';
		request.setEncoding( 'utf8' );
		request.on( 'data', ( chunk: string ) => ( body += chunk ) );
		request.on( 'end', () => resolve( new URLSearchParams( body ) ) );
		request.on( 'error', reject );
	} );
}

export async function startFakeAuthorizationServer(
	signingKey: SigningKey
): Promise< FakeAuthorizationServer > {
	const secrets = new Set< string >();
	const codes = new Map<
		string,
		{
			clientId: string;
			redirectUri: string;
			resource: string;
			codeChallenge: string;
			nonce: string;
			account: TestAccount;
		}
	>();
	let clients = 0;
	let serial = 0;
	const keep = ( ...values: Array< string | null | undefined > ) => {
		for ( const value of values ) {
			if ( value ) {
				secrets.add( value );
			}
		}
	};

	const server = http.createServer( ( request, response ) => {
		const reply: Reply = ( status, body, headers = {} ) => {
			const text =
				body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify( body );
			response.writeHead( status, { 'content-type': 'application/json', ...headers } );
			response.end( text );
		};
		const url = new URL( request.url ?? '/', fake.url );
		switch ( url.pathname ) {
			case '/.well-known/openid-configuration': {
				fake.counts.discovery++;
				const document = {
					issuer: TEST_ISSUER,
					authorization_endpoint: `${ fake.url }/api/accounts/authorize`,
					token_endpoint: `${ fake.url }/api/accounts/oauth/token`,
					revocation_endpoint: `${ fake.url }/api/accounts/oauth/revoke`,
					jwks_uri: `${ fake.url }/.well-known/jwks.json`,
				};
				const answer = fake.script.discovery?.( document ) ?? { status: 200, body: document };
				reply( answer.status, answer.body );
				return;
			}
			case '/.well-known/jwks.json': {
				fake.counts.jwks++;
				const keys = fake.keys.map( ( key ) => key.jwk );
				setTimeout( () => reply( 200, { keys } ), fake.script.jwksDelayMs ?? 0 );
				return;
			}
			case '/api/accounts/authorize':
				authorize( url.searchParams, reply );
				return;
			case '/api/accounts/oauth/token':
				void readForm( request )
					.then( ( form ) => token( form, reply ) )
					.catch( () => reply( 500 ) );
				return;
			case '/api/accounts/oauth/revoke':
				void readForm( request ).then( ( form ) => {
					fake.revokeRequests.push( form );
					keep( form.get( 'token' ) );
					const answer = fake.script.revoke?.( form ) ?? { status: 200 };
					reply( answer.status, answer.body );
				} );
				return;
			default:
				reply( 404 );
		}
	} );

	// The browser's view: sign in as `account`, then go back to the redirect URI.
	function authorize( query: URLSearchParams, reply: Reply ) {
		fake.authorizeRequests.push( query );
		keep( query.get( 'nonce' ), query.get( 'id_token_hint' ) );
		const redirectUri = query.get( 'redirect_uri' ) ?? '';
		let clientId = query.get( 'client_id' ) ?? '';
		const params: Record< string, string > = { state: query.get( 'state' ) ?? '' };
		// A first sign-in registers a client; signing in again keeps the account's.
		if ( clientId === REGISTRATION_CLIENT_ID ) {
			clientId = fake.script.issueClient?.() ?? `test-issued-client-${ ++clients }`;
			params.client_id = clientId;
		}
		const code = `test-auth-code-${ ++serial }`;
		keep( code );
		codes.set( code, {
			clientId,
			redirectUri,
			resource: query.get( 'resource' ) ?? '',
			codeChallenge: query.get( 'code_challenge' ) ?? '',
			nonce: query.get( 'nonce' ) ?? '',
			account: { ...fake.account },
		} );
		params.code = code;
		params.scope = 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke';
		const location = new URL( redirectUri );
		for ( const [ name, value ] of Object.entries( fake.script.callback?.( params ) ?? params ) ) {
			location.searchParams.set( name, value );
		}
		reply( 302, undefined, { location: location.toString() } );
	}

	async function token( form: URLSearchParams, reply: Reply ): Promise< void > {
		fake.tokenRequests.push( form );
		keep( form.get( 'code' ), form.get( 'code_verifier' ), form.get( 'refresh_token' ) );
		const answer = await answerToken( form );
		setTimeout( () => {
			reply( answer.status, answer.body );
			fake.counts.tokenResponses++;
		}, fake.script.tokenDelayMs ?? 0 );
	}

	async function answerToken( form: URLSearchParams ): Promise< Answer > {
		const scripted = fake.script.token?.( form );
		if ( scripted ) {
			return scripted;
		}
		if ( form.get( 'grant_type' ) === 'refresh_token' ) {
			return { status: 200, body: issue() };
		}
		if ( form.get( 'grant_type' ) !== 'authorization_code' ) {
			return { status: 400, body: { error: 'unsupported_grant_type' } };
		}
		const code = form.get( 'code' ) ?? '';
		const issuedFor = codes.get( code );
		// A code works once, for the client, redirect URI, resource and verifier it was issued to.
		codes.delete( code );
		const challenge = createHash( 'sha256' )
			.update( form.get( 'code_verifier' ) ?? '' )
			.digest( 'base64url' );
		if (
			! issuedFor ||
			form.get( 'client_id' ) !== issuedFor.clientId ||
			form.get( 'redirect_uri' ) !== issuedFor.redirectUri ||
			form.get( 'resource' ) !== issuedFor.resource ||
			challenge !== issuedFor.codeChallenge
		) {
			return { status: 400, body: { error: 'invalid_grant' } };
		}
		const now = Math.floor( Date.now() / 1000 );
		const claims: JWTPayload = {
			iss: TEST_ISSUER,
			sub: issuedFor.account.subject,
			aud: [ issuedFor.clientId ],
			nonce: issuedFor.nonce,
			email: issuedFor.account.email,
			email_verified: true,
			iat: now,
			exp: now + 3600,
		};
		const finalClaims = fake.script.idTokenClaims?.( claims ) ?? claims;
		const idToken = await ( fake.script.signIdToken?.( finalClaims ) ??
			signIdToken( finalClaims, fake.signingKey ) );
		return { status: 200, body: issue( idToken ) };
	}

	function issue( idToken?: string ) {
		const n = ++serial;
		const tokens: IssuedTokens = {
			accessToken: `test-access-token-${ n }`,
			refreshToken: `test-refresh-token-${ n }`,
			...( idToken ? { idToken } : {} ),
		};
		fake.issued.push( tokens );
		keep( tokens.accessToken, tokens.refreshToken, idToken );
		const scope = fake.script.grantedScope === undefined ? GRANTED_SCOPE : fake.script.grantedScope;
		return {
			access_token: tokens.accessToken,
			refresh_token: tokens.refreshToken,
			...( idToken ? { id_token: idToken } : {} ),
			token_type: 'Bearer',
			expires_in: fake.script.expiresIn ?? 3600,
			...( scope === null ? {} : { scope } ),
		};
	}

	await new Promise< void >( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
	const { port } = server.address() as AddressInfo;
	const url = `http://127.0.0.1:${ port }`;
	const fake: FakeAuthorizationServer = {
		url,
		discoveryUrl: `${ url }/.well-known/openid-configuration`,
		account: { subject: 'test-subject-1', email: 'someone@example.com' },
		script: {},
		signingKey,
		keys: [ signingKey ],
		authorizeRequests: [],
		tokenRequests: [],
		revokeRequests: [],
		issued: [],
		counts: { discovery: 0, jwks: 0, tokenResponses: 0 },
		secrets: () => [ ...secrets ],
		close: () =>
			new Promise< void >( ( resolve ) => {
				server.closeAllConnections();
				server.close( () => resolve() );
			} ),
	};
	return fake;
}
