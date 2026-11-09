// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatGptConnectionError } from '@studio/agent/node/chatgpt/account-store';
import {
	applyChatGptModelList,
	CHATGPT_MODEL_CAPABILITIES,
	describeChatGptReasoningProblem,
	fetchChatGptModels,
	resolveChatGptReasoning,
	type ChatGptModelListResult,
} from '@studio/agent/node/chatgpt/models';
import { CHATGPT_UNAVAILABLE_RETRY_DELAYS_MS } from '@studio/agent/node/chatgpt/route';
import { OPENAI_MODEL_CAPABILITIES, isOpenAiModelId } from '@studio/agent/protocol/openai-models';
import type { ChatGptModelAvailability } from '@studio/agent/protocol/connections';

/*
 * The ChatGPT route's model list, read through a mocked `fetch`: nothing here
 * reaches OpenAI. Tokens are test strings, never real ones.
 */

const broker = vi.hoisted( () => ( {
	tokens: new Map< string, string >(),
	failure: null as Error | null,
} ) );

vi.mock( '@studio/agent/node/chatgpt/credential-broker', () => ( {
	getChatGptAccessToken: async ( connectionId: string ) => {
		if ( broker.failure ) {
			throw broker.failure;
		}
		const token = broker.tokens.get( connectionId );
		if ( ! token ) {
			throw new Error( `No test token for ${ connectionId }` );
		}
		return token;
	},
} ) );

const MODELS_URL = 'https://api.openai.com/v1/models';
const ACCOUNT_A = 'registration-a';
const ACCOUNT_B = 'registration-b';
const TOKEN_A = 'test-access-token-for-account-a';
const TOKEN_B = 'test-access-token-for-account-b';

function json( body: unknown, init: ResponseInit = {} ): Response {
	return new Response( JSON.stringify( body ), {
		status: 200,
		...init,
		headers: { 'content-type': 'application/json', ...init.headers },
	} );
}

// A body that delivers some bytes, then fails, as a dropped connection does.
// The failure waits for the next read: erroring a stream discards what it
// hasn't delivered yet.
function brokenBody( start: string ): Response {
	const bytes = new TextEncoder().encode( start );
	let sent = false;
	return new Response(
		new ReadableStream< Uint8Array >( {
			pull( controller ) {
				if ( sent ) {
					controller.error( new TypeError( 'terminated' ) );
					return;
				}
				sent = true;
				controller.enqueue( bytes );
			},
		} ),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	);
}

const listed = ( slug: string, displayName: string, extra: Record< string, unknown > = {} ) => ( {
	slug,
	display_name: displayName,
	visibility: 'list',
	...extra,
} );

function captureFetch(
	respond: ( url: string, init?: RequestInit ) => Response | Promise< Response >
) {
	const spy = vi
		.spyOn( globalThis, 'fetch' )
		.mockImplementation( async ( input, init ) =>
			respond( input instanceof Request ? input.url : String( input ), init )
		);
	return {
		spy,
		request( index = 0 ) {
			const [ url, init ] = spy.mock.calls[ index ];
			return { url: String( url ), init: init!, headers: new Headers( init?.headers ) };
		},
	};
}

function failureOf( result: ChatGptModelListResult ) {
	if ( result.ok ) {
		throw new Error( 'Expected the model list to fail.' );
	}
	return result.error;
}

beforeEach( () => {
	broker.tokens = new Map( [
		[ ACCOUNT_A, TOKEN_A ],
		[ ACCOUNT_B, TOKEN_B ],
	] );
	broker.failure = null;
} );

afterEach( () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
} );

describe( 'fetchChatGptModels', () => {
	it( 'asks GET /v1/models with the connection’s token and nothing else', async () => {
		const http = captureFetch( () => json( { models: [] } ) );

		await fetchChatGptModels( ACCOUNT_A );

		expect( http.spy ).toHaveBeenCalledTimes( 1 );
		const { url, init, headers } = http.request();
		expect( url ).toBe( MODELS_URL );
		expect( init.method ).toBe( 'GET' );
		expect( init.redirect ).toBe( 'error' );
		expect( init.body ).toBeUndefined();
		expect( [ ...headers.keys() ] ).toEqual( [ 'authorization' ] );
		expect( headers.get( 'authorization' ) ).toBe( `Bearer ${ TOKEN_A }` );
	} );

	it( 'lists the account’s displayed models in the server’s order, provider-qualified', async () => {
		captureFetch( () =>
			json( {
				models: [
					listed( 'gpt-6-luna', 'GPT-6 Luna', { context_window: 1 } ),
					listed( 'gpt-6.1-sol', 'GPT-6.1 Sol' ),
					listed( 'gpt-6-astra', 'GPT-6 Astra' ),
				],
			} )
		);

		const result = await fetchChatGptModels( ACCOUNT_A );

		expect( result ).toEqual( {
			ok: true,
			models: [
				{
					providerId: 'chatgpt-oauth',
					modelId: 'gpt-6-luna',
					label: 'GPT-6 Luna',
					capabilities: CHATGPT_MODEL_CAPABILITIES[ 'gpt-6-luna' ],
				},
				{
					providerId: 'chatgpt-oauth',
					modelId: 'gpt-6.1-sol',
					label: 'GPT-6.1 Sol',
					capabilities: CHATGPT_MODEL_CAPABILITIES[ 'gpt-6.1-sol' ],
				},
				{
					providerId: 'chatgpt-oauth',
					modelId: 'gpt-6-astra',
					label: 'GPT-6 Astra',
					capabilities: CHATGPT_MODEL_CAPABILITIES[ 'gpt-6-astra' ],
				},
			],
		} );
	} );

	it( 'leaves out models the server doesn’t mean to display', async () => {
		captureFetch( () =>
			json( {
				models: [
					listed( 'gpt-6-luna', 'GPT-6 Luna', { visibility: 'hide' } ),
					listed( 'gpt-6.1-terra', 'GPT-6.1 Terra', { visibility: undefined } ),
					listed( 'gpt-6.1-sol', 'GPT-6.1 Sol' ),
				],
			} )
		);

		const result = await fetchChatGptModels( ACCOUNT_A );

		expect( result.ok && result.models.map( ( model ) => model.modelId ) ).toEqual( [
			'gpt-6.1-sol',
		] );
	} );

	it( 'hides a model whose capabilities Studio doesn’t know, never guessing them', async () => {
		captureFetch( () =>
			json( {
				models: [
					listed( 'gpt-7-nova', 'GPT-7 Nova', { reasoning_efforts: [ 'low' ] } ),
					listed( 'gpt-6-luna', 'GPT-6 Luna' ),
					{ display_name: 'No slug', visibility: 'list' },
					'not a model',
				],
			} )
		);

		const result = await fetchChatGptModels( ACCOUNT_A );

		expect( result.ok && result.models.map( ( model ) => model.modelId ) ).toEqual( [
			'gpt-6-luna',
		] );
	} );

	it( 'reads a genuinely empty list as an empty result, not a failure', async () => {
		captureFetch( () => json( { models: [] } ) );

		await expect( fetchChatGptModels( ACCOUNT_A ) ).resolves.toEqual( { ok: true, models: [] } );
	} );

	it.each( [
		[ 'malformed JSON', () => new Response( '{"models": [', { status: 200 } ) ],
		[ 'the public API’s `data` envelope', () => json( { data: [ { id: 'gpt-6.1-sol' } ] } ) ],
		[ 'a `models` that isn’t an array', () => json( { models: { slug: 'gpt-6.1-sol' } } ) ],
		[ 'a null `models`', () => json( { models: null } ) ],
	] )( 'fails on %s rather than reporting an empty list', async ( _name, respond ) => {
		captureFetch( respond );

		const error = failureOf( await fetchChatGptModels( ACCOUNT_A ) );

		expect( error.kind ).toBe( 'invalid-response' );
	} );

	it( 'fails on a body that breaks partway, never returning a shorter list', async () => {
		captureFetch( () => brokenBody( '{"models":[{"slug":"gpt-6-luna","display_name":"GPT' ) );

		const error = failureOf( await fetchChatGptModels( ACCOUNT_A ) );

		expect( error.kind ).toBe( 'interrupted' );
	} );

	it( 'keeps a detail-only error’s status, text and request id, and never the token', async () => {
		captureFetch( () =>
			json(
				{ detail: `Country, region, or territory not supported (${ TOKEN_A })` },
				{ status: 403, headers: { 'x-request-id': 'req_models_403' } }
			)
		);

		const error = failureOf( await fetchChatGptModels( ACCOUNT_A ) );

		expect( error ).toMatchObject( {
			kind: 'forbidden',
			status: 403,
			requestId: 'req_models_403',
		} );
		expect( error.detail ).toContain( 'Country, region, or territory not supported' );
		expect( JSON.stringify( error ) ).not.toContain( TOKEN_A );
	} );

	it( 'keeps a structured detail as text', async () => {
		captureFetch( () =>
			json(
				{ detail: [ { loc: [ 'header', 'authorization' ], msg: 'field required' } ] },
				{ status: 422 }
			)
		);

		const error = failureOf( await fetchChatGptModels( ACCOUNT_A ) );

		expect( error ).toMatchObject( { kind: 'invalid-request', status: 422 } );
		expect( error.detail ).toContain( 'field required' );
	} );

	it.each( [
		[ 401, 'subscription_sharing_invalid_user', 'authorization' ],
		[ 403, 'subscription_sharing_user_not_eligible', 'forbidden' ],
		[ 429, 'subscription_sharing_usage_limit_exceeded', 'usage-limit' ],
		[ 400, 'subscription_sharing_unsupported_capability', 'unsupported-capability' ],
	] as const )( 'classifies HTTP %s %s as %s', async ( status, code, kind ) => {
		const http = captureFetch( () =>
			json(
				{ error: { code, param: 'model', message: `Rejected ${ TOKEN_A }` } },
				{ status, headers: { 'x-request-id': 'req_1' } }
			)
		);

		const error = failureOf( await fetchChatGptModels( ACCOUNT_A ) );

		expect( error ).toMatchObject( { kind, status, code, requestId: 'req_1' } );
		expect( JSON.stringify( error ) ).not.toContain( TOKEN_A );
		// None of these is repeated.
		expect( http.spy ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'tries a 503 again a bounded number of times, then reports it unavailable', async () => {
		vi.useFakeTimers( { toFake: [ 'setTimeout', 'clearTimeout' ] } );
		const http = captureFetch( () =>
			json( { detail: 'Direct routing is unavailable.' }, { status: 503 } )
		);

		const pending = fetchChatGptModels( ACCOUNT_A );
		await vi.advanceTimersByTimeAsync(
			CHATGPT_UNAVAILABLE_RETRY_DELAYS_MS.reduce( ( total, delay ) => total + delay, 0 )
		);
		const error = failureOf( await pending );

		expect( error ).toMatchObject( { kind: 'unavailable', status: 503 } );
		expect( http.spy ).toHaveBeenCalledTimes( CHATGPT_UNAVAILABLE_RETRY_DELAYS_MS.length + 1 );
	} );

	it( 'reports a sign-in the broker can’t use without contacting OpenAI', async () => {
		broker.failure = new ChatGptConnectionError( 'needs-sign-in' );
		const http = captureFetch( () => json( { models: [] } ) );

		const error = failureOf( await fetchChatGptModels( ACCOUNT_A ) );

		expect( error ).toMatchObject( { kind: 'credentials', code: 'needs-sign-in' } );
		expect( error.detail ).toBe( new ChatGptConnectionError( 'needs-sign-in' ).message );
		expect( http.spy ).not.toHaveBeenCalled();
	} );

	it( 'reports a network failure as one, with no token in it', async () => {
		vi.spyOn( globalThis, 'fetch' ).mockRejectedValue(
			Object.assign( new TypeError( 'fetch failed' ), {
				cause: new Error( `getaddrinfo ENOTFOUND api.openai.com ${ TOKEN_A }` ),
			} )
		);

		const error = failureOf( await fetchChatGptModels( ACCOUNT_A ) );

		expect( error.kind ).toBe( 'network' );
		expect( error.detail ).toContain( 'ENOTFOUND' );
		expect( error.detail ).not.toContain( TOKEN_A );
	} );

	it( 'reports a canceled read as canceled', async () => {
		const controller = new AbortController();
		vi.spyOn( globalThis, 'fetch' ).mockImplementation( async () => {
			controller.abort();
			throw Object.assign( new Error( 'This operation was aborted' ), { name: 'AbortError' } );
		} );

		const error = failureOf( await fetchChatGptModels( ACCOUNT_A, controller.signal ) );

		expect( error.kind ).toBe( 'cancelled' );
	} );

	it( 'uses an injected token source instead of the broker', async () => {
		const http = captureFetch( () => json( { models: [] } ) );

		await fetchChatGptModels( ACCOUNT_A, undefined, {
			getAccessToken: async () => 'test-injected-token',
		} );

		expect( http.request().headers.get( 'authorization' ) ).toBe( 'Bearer test-injected-token' );
	} );

	describe( 'switching accounts', () => {
		it( 'reads each connection’s list with that connection’s own token', async () => {
			const http = captureFetch( ( _url, init ) =>
				new Headers( init?.headers ).get( 'authorization' ) === `Bearer ${ TOKEN_A }`
					? json( { models: [ listed( 'gpt-6.1-sol', 'GPT-6.1 Sol' ) ] } )
					: json( { models: [ listed( 'gpt-6-luna', 'GPT-6 Luna' ) ] } )
			);

			const a = await fetchChatGptModels( ACCOUNT_A );
			const b = await fetchChatGptModels( ACCOUNT_B );

			expect( http.request( 0 ).headers.get( 'authorization' ) ).toBe( `Bearer ${ TOKEN_A }` );
			expect( http.request( 1 ).headers.get( 'authorization' ) ).toBe( `Bearer ${ TOKEN_B }` );
			expect( a.ok && a.models.map( ( model ) => model.modelId ) ).toEqual( [ 'gpt-6.1-sol' ] );
			expect( b.ok && b.models.map( ( model ) => model.modelId ) ).toEqual( [ 'gpt-6-luna' ] );
		} );

		const goodList: ChatGptModelListResult = {
			ok: true,
			models: [
				{
					providerId: 'chatgpt-oauth',
					modelId: 'gpt-6.1-sol',
					label: 'GPT-6.1 Sol',
					capabilities: CHATGPT_MODEL_CAPABILITIES[ 'gpt-6.1-sol' ],
				},
			],
		};
		const failed: ChatGptModelListResult = {
			ok: false,
			error: { kind: 'unavailable', status: 503 },
		};

		it( 'records a successful read for its own registration and revision', () => {
			expect(
				applyChatGptModelList(
					null,
					{ connectionId: ACCOUNT_A, revision: 1 },
					goodList,
					'2026-11-08T10:00:00.000Z'
				)
			).toEqual( {
				connectionId: ACCOUNT_A,
				revision: 1,
				checkedAt: '2026-11-08T10:00:00.000Z',
				models: [ { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' } ],
				lastError: null,
			} );
		} );

		it( 'keeps the last good list through a failed read of the same registration', () => {
			const good = applyChatGptModelList(
				null,
				{ connectionId: ACCOUNT_A, revision: 1 },
				goodList,
				'2026-11-08T10:00:00.000Z'
			);

			expect(
				applyChatGptModelList( good, { connectionId: ACCOUNT_A, revision: 1 }, failed )
			).toEqual< ChatGptModelAvailability >( {
				...good,
				lastError: { kind: 'unavailable', status: 503 },
			} );
		} );

		it( 'never shows one registration’s list for another', () => {
			const good = applyChatGptModelList(
				null,
				{ connectionId: ACCOUNT_A, revision: 1 },
				goodList,
				'2026-11-08T10:00:00.000Z'
			);

			expect(
				applyChatGptModelList( good, { connectionId: ACCOUNT_B, revision: 1 }, failed )
			).toEqual( {
				connectionId: ACCOUNT_B,
				revision: 1,
				checkedAt: null,
				models: null,
				lastError: { kind: 'unavailable', status: 503 },
			} );
			// A registration signed in again under another issued client is another
			// registration's list too.
			expect(
				applyChatGptModelList( good, { connectionId: ACCOUNT_A, revision: 2 }, failed ).models
			).toBeNull();
		} );
	} );
} );

describe( 'CHATGPT_MODEL_CAPABILITIES', () => {
	it( 'is seeded from the OpenAI API catalog for the same slugs, without API-only fields', () => {
		const slugs = Object.keys( CHATGPT_MODEL_CAPABILITIES );
		expect( slugs.length ).toBeGreaterThan( 0 );
		for ( const slug of slugs ) {
			expect( isOpenAiModelId( slug ) ).toBe( true );
			const api = OPENAI_MODEL_CAPABILITIES[ slug as keyof typeof OPENAI_MODEL_CAPABILITIES ];
			expect( CHATGPT_MODEL_CAPABILITIES[ slug ] ).toEqual( {
				reasoningEfforts: api.reasoningEfforts,
				reasoningModes: api.reasoningModes,
				imageInput: api.imageInput,
			} );
		}
	} );
} );

describe( 'resolveChatGptReasoning', () => {
	it( 'accepts an effort the model lists', () => {
		expect( resolveChatGptReasoning( 'gpt-6.1-terra', 'none' ) ).toEqual( {
			ok: true,
			effort: 'none',
		} );
	} );

	it( 'refuses an effort the model doesn’t list, never offering a nearby one instead', () => {
		const result = resolveChatGptReasoning( 'gpt-6-astra', 'none' );

		expect( result ).toEqual( {
			ok: false,
			problem: {
				code: 'unsupported-effort',
				model: 'gpt-6-astra',
				effort: 'none',
				supported: CHATGPT_MODEL_CAPABILITIES[ 'gpt-6-astra' ].reasoningEfforts,
			},
		} );
		expect( ! result.ok && describeChatGptReasoningProblem( result.problem ) ).toBe(
			'gpt-6-astra doesn’t support “None” reasoning with ChatGPT. Choose one of: Low, Medium, High, Extra high, Max.'
		);
	} );

	it( 'refuses a model Studio has no capabilities for', () => {
		const result = resolveChatGptReasoning( 'gpt-7-nova', 'medium' );

		expect( result ).toEqual( {
			ok: false,
			problem: { code: 'unknown-model', model: 'gpt-7-nova' },
		} );
		expect( ! result.ok && describeChatGptReasoningProblem( result.problem ) ).toBe(
			'Studio doesn’t support the ChatGPT model “gpt-7-nova”. Choose another model to continue.'
		);
	} );
} );
