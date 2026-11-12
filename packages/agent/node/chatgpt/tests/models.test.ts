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
import { describeChatGptError } from '@studio/agent/protocol/chatgpt-errors';
import type { ChatGptModelAvailability } from '@studio/agent/protocol/connections';
import type { OpenAiModelCapabilities, OpenAiModelId } from '@studio/agent/protocol/openai-models';

/*
 * The ChatGPT route's model list, read through a mocked `fetch`: nothing here
 * reaches OpenAI. Tokens are test strings, never real ones.
 */

const broker = vi.hoisted( () => ( {
	tokens: new Map< string, string >(),
	failure: null as Error | null,
	invalidate: vi.fn< ( connectionId: string, rejectedAccessToken: string ) => Promise< void > >(),
} ) );

vi.mock( '@studio/agent/node/chatgpt/credential-broker', () => ( {
	invalidateChatGptAccessToken: broker.invalidate,
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
	broker.invalidate.mockReset().mockResolvedValue( undefined );
} );

it( 'invalidates the model request’s rejected token when a newer token is already available', async () => {
	const http = captureFetch( () => {
		broker.tokens.set( ACCOUNT_A, 'test-access-token-renewed' );
		return json( { error: 'invalid_token' }, { status: 401 } );
	} );

	const result = await fetchChatGptModels( ACCOUNT_A );

	expect( failureOf( result ).kind ).toBe( 'authorization' );
	expect( broker.invalidate ).toHaveBeenCalledExactlyOnceWith( ACCOUNT_A, TOKEN_A );
	expect( http.spy ).toHaveBeenCalledTimes( 1 );
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

	it( 'lists the account’s displayed models Studio qualifies, provider-qualified, by the route’s name', async () => {
		captureFetch( () =>
			json( {
				models: [
					listed( 'gpt-6.1-sol', 'GPT-6.1 Sol' ),
					listed( 'gpt-6-luna', 'GPT-6 Luna', { context_window: 1 } ),
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
			],
			listsUnqualifiedModels: true,
		} );
	} );

	it( 'says only whether the account lists models Studio hasn’t qualified, never which', async () => {
		captureFetch( () =>
			json( {
				models: [
					listed( 'gpt-6-luna', 'GPT-6 Luna' ),
					listed( 'gpt-6.1-sol', 'GPT-6.1 Sol', { visibility: 'hide' } ),
					{ display_name: 'No slug', visibility: 'list' },
				],
			} )
		);
		const qualifiedOnly = await fetchChatGptModels( ACCOUNT_A );
		captureFetch( () =>
			json( {
				models: [ listed( 'gpt-7-nova', 'GPT-7 Nova' ), listed( 'gpt-6-luna', 'GPT-6 Luna' ) ],
			} )
		);
		const withUnqualified = await fetchChatGptModels( ACCOUNT_A );

		expect( qualifiedOnly ).not.toHaveProperty( 'listsUnqualifiedModels' );
		expect( withUnqualified ).toMatchObject( { ok: true, listsUnqualifiedModels: true } );
		expect( JSON.stringify( withUnqualified ) ).not.toMatch( /nova/i );
		expect(
			applyChatGptModelList(
				null,
				{ connectionId: ACCOUNT_A, revision: 1 },
				withUnqualified,
				'2026-11-08T10:00:00.000Z'
			)
		).toEqual( {
			connectionId: ACCOUNT_A,
			revision: 1,
			checkedAt: '2026-11-08T10:00:00.000Z',
			models: [ { id: 'gpt-6-luna', label: 'GPT-6 Luna' } ],
			listsUnqualifiedModels: true,
			lastError: null,
		} );
	} );

	it.each( [ 'hide', undefined ] )(
		'leaves out a model whose visibility is %s',
		async ( visibility ) => {
			captureFetch( () =>
				json( { models: [ listed( 'gpt-6-luna', 'GPT-6 Luna', { visibility } ) ] } )
			);

			await expect( fetchChatGptModels( ACCOUNT_A ) ).resolves.toEqual( {
				ok: true,
				models: [],
			} );
		}
	);

	it( 'hides a model whose capabilities Studio doesn’t know, never guessing them', async () => {
		captureFetch( () =>
			json( {
				models: [
					listed( 'gpt-7-nova', 'GPT-7 Nova', { reasoning_efforts: [ 'low' ] } ),
					// In the OpenAI API catalog, but not qualified on this route.
					listed( 'gpt-6.1-sol', 'GPT-6.1 Sol' ),
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

	it( 'reports a lock or file the broker couldn’t use with a fixed message, never its path', async () => {
		const home = [ '', 'home', 'someone', '.studio', 'chatgpt-credentials', 'x.lock' ].join( '/' );
		broker.failure = Object.assign(
			new Error( `EPERM: operation not permitted, open '${ home }'` ),
			{ code: 'EPERM', path: home }
		);
		const http = captureFetch( () => json( { models: [] } ) );

		const error = failureOf( await fetchChatGptModels( ACCOUNT_A ) );

		expect( error ).toEqual( { kind: 'credentials' } );
		expect( describeChatGptError( error ) ).toBe(
			'Studio couldn’t use your ChatGPT sign-in for this request.'
		);
		expect( JSON.stringify( error ) ).not.toMatch( /someone|EPERM|lock/ );
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
					? json( { models: [ listed( 'gpt-6-luna', 'Luna for A' ) ] } )
					: json( { models: [ listed( 'gpt-6-luna', 'Luna for B' ) ] } )
			);

			const a = await fetchChatGptModels( ACCOUNT_A );
			const b = await fetchChatGptModels( ACCOUNT_B );

			expect( http.request( 0 ).headers.get( 'authorization' ) ).toBe( `Bearer ${ TOKEN_A }` );
			expect( http.request( 1 ).headers.get( 'authorization' ) ).toBe( `Bearer ${ TOKEN_B }` );
			expect( a.ok && a.models.map( ( model ) => model.label ) ).toEqual( [ 'Luna for A' ] );
			expect( b.ok && b.models.map( ( model ) => model.label ) ).toEqual( [ 'Luna for B' ] );
		} );

		const goodList: ChatGptModelListResult = {
			ok: true,
			models: [
				{
					providerId: 'chatgpt-oauth',
					modelId: 'gpt-6-luna',
					label: 'GPT-6 Luna',
					capabilities: CHATGPT_MODEL_CAPABILITIES[ 'gpt-6-luna' ],
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
				models: [ { id: 'gpt-6-luna', label: 'GPT-6 Luna' } ],
				lastError: null,
			} );
		} );

		it( 'keeps the last good list through a failed read of the same registration', () => {
			const good = applyChatGptModelList(
				null,
				{ connectionId: ACCOUNT_A, revision: 1 },
				{ ...goodList, listsUnqualifiedModels: true } as ChatGptModelListResult,
				'2026-11-08T10:00:00.000Z'
			);
			expect( good.listsUnqualifiedModels ).toBe( true );

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

// What the route is qualified for (ledger section A, "G2 record"): gpt-6-luna
// at the efforts a captured run completed, with attached images per the route's
// documentation. Images in tool results stay off until gate T1 observes the
// route accept one. Every other model and effort is unknown, so unavailable.
const QUALIFIED_ROUTE_CAPABILITIES = {
	'gpt-6-luna': {
		reasoningEfforts: [ 'low', 'medium' ],
		reasoningModes: [ 'standard' ],
		imageInput: true,
		toolImageInput: false,
	},
};

describe( 'CHATGPT_MODEL_CAPABILITIES', () => {
	it( 'offers only what the route is qualified for', () => {
		expect( CHATGPT_MODEL_CAPABILITIES ).toEqual( QUALIFIED_ROUTE_CAPABILITIES );
	} );

	it( 'is frozen, so nothing can widen it at run time', () => {
		expect( Object.isFrozen( CHATGPT_MODEL_CAPABILITIES ) ).toBe( true );
		for ( const capabilities of Object.values( CHATGPT_MODEL_CAPABILITIES ) ) {
			expect( Object.isFrozen( capabilities ) ).toBe( true );
			expect( Object.isFrozen( capabilities.reasoningEfforts ) ).toBe( true );
		}
	} );
} );

describe( 'the ChatGPT route’s controls, whatever the OpenAI API catalog says', () => {
	type ApiCatalog = Readonly< Record< OpenAiModelId, OpenAiModelCapabilities > >;

	// Every API model with every effort, no image input, a longer context, and
	// a model the API catalog alone knows.
	const widenApiCatalog = ( catalog: ApiCatalog ): ApiCatalog => {
		const edited = Object.fromEntries(
			Object.entries( catalog ).map( ( [ id, capabilities ] ) => [
				id,
				{
					...capabilities,
					reasoningEfforts: [ 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max' ],
					reasoningModes: [ 'standard', 'pro' ],
					imageInput: false,
					contextWindow: 2_000_000,
					maxInputTokens: 1_900_000,
				},
			] )
		);
		return {
			...edited,
			'gpt-7-nova': { ...edited[ 'gpt-6-luna' ], apiModelId: 'gpt-7-nova' },
		} as unknown as ApiCatalog;
	};

	afterEach( () => {
		vi.doUnmock( '@studio/agent/protocol/openai-models' );
		vi.resetModules();
	} );

	// The route's controls as a fresh import sees them, with the API catalog
	// edited or left alone.
	async function routeControls( editApiCatalog?: ( catalog: ApiCatalog ) => ApiCatalog ) {
		vi.resetModules();
		if ( editApiCatalog ) {
			vi.doMock( '@studio/agent/protocol/openai-models', async ( importOriginal ) => {
				const actual =
					await importOriginal< typeof import('@studio/agent/protocol/openai-models') >();
				return {
					...actual,
					OPENAI_MODEL_CAPABILITIES: editApiCatalog( actual.OPENAI_MODEL_CAPABILITIES ),
				};
			} );
		}
		const protocol = await import( '@studio/agent/protocol/chatgpt-models' );
		const models = await import( '@studio/agent/node/chatgpt/models' );
		const transport = await import( '@studio/agent/node/runtime/chatgpt-transport' );
		const apiSlugs = [ 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-7-nova' ];
		vi.spyOn( globalThis, 'fetch' ).mockImplementation( async () =>
			json( { models: apiSlugs.map( ( slug ) => listed( slug, slug ) ) } )
		);
		const catalog = await models.fetchChatGptModels( ACCOUNT_A, undefined, {
			getAccessToken: async () => 'test-injected-token',
		} );
		return {
			table: protocol.CHATGPT_MODEL_CAPABILITIES,
			listed: catalog.ok ? catalog.models.map( ( model ) => model.modelId ) : catalog.error,
			efforts: Object.fromEntries(
				apiSlugs.map( ( slug ) => [
					slug,
					[ 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max' ].filter(
						( effort ) => protocol.resolveChatGptReasoning( slug, effort ).ok
					),
				] )
			),
			defaultEffort: protocol.getDefaultChatGptReasoningEffort( 'gpt-6-luna' ),
			piModel: ( () => {
				const model = transport.buildChatGptModel( {
					providerId: 'chatgpt-oauth',
					modelId: 'gpt-6-luna',
				} );
				return {
					input: model.input,
					contextWindow: model.contextWindow,
					thinkingLevelMap: model.thinkingLevelMap,
				};
			} )(),
		};
	}

	it( 'stay the route-qualified ones when the API catalog changes', async () => {
		const unchanged = await routeControls();
		const edited = await routeControls( widenApiCatalog );

		expect( edited ).toEqual( unchanged );
		expect( unchanged.table ).toEqual( QUALIFIED_ROUTE_CAPABILITIES );
		expect( unchanged.listed ).toEqual( [ 'gpt-6-luna' ] );
		expect( unchanged.efforts ).toEqual( {
			'gpt-6.1-sol': [],
			'gpt-6-astra': [],
			'gpt-6.1-terra': [],
			'gpt-6-luna': [ 'low', 'medium' ],
			'gpt-7-nova': [],
		} );
		expect( unchanged.piModel ).toEqual( {
			input: [ 'text', 'image' ],
			contextWindow: 200_000,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: 'low',
				medium: 'medium',
				high: null,
				xhigh: null,
				max: null,
			},
		} );
	} );

	it( 'ignore an API catalog that drops every model', async () => {
		const unchanged = await routeControls();
		const emptied = await routeControls( () => ( {} ) as ApiCatalog );

		expect( emptied ).toEqual( unchanged );
	} );
} );

describe( 'resolveChatGptReasoning', () => {
	it.each( [ 'low', 'medium' ] )( 'accepts %s, an effort the model lists', ( effort ) => {
		expect( resolveChatGptReasoning( 'gpt-6-luna', effort ) ).toEqual( { ok: true, effort } );
	} );

	it( 'refuses an effort the model doesn’t list, saying it isn’t qualified, never offering a nearby one instead', () => {
		const result = resolveChatGptReasoning( 'gpt-6-luna', 'high' );

		expect( result ).toEqual( {
			ok: false,
			problem: {
				code: 'unsupported-effort',
				model: 'gpt-6-luna',
				effort: 'high',
				supported: [ 'low', 'medium' ],
			},
		} );
		expect( ! result.ok && describeChatGptReasoningProblem( result.problem ) ).toBe(
			'Studio doesn’t support “High” reasoning for gpt-6-luna with ChatGPT yet: it isn’t qualified for use with a ChatGPT plan. Choose one of: Low, Medium.'
		);
	} );

	it.each( [ 'gpt-7-nova', 'gpt-6.1-sol' ] )(
		'refuses %s, a model Studio has no route-qualified capabilities for, saying so',
		( model ) => {
			const result = resolveChatGptReasoning( model, 'medium' );

			expect( result ).toEqual( { ok: false, problem: { code: 'unknown-model', model } } );
			expect( ! result.ok && describeChatGptReasoningProblem( result.problem ) ).toBe(
				`Studio doesn’t support the ChatGPT model “${ model }” yet: it isn’t qualified for use with a ChatGPT plan. Choose another model to continue.`
			);
		}
	);
} );
