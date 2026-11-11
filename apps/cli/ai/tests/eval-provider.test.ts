// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createAgent } from '@studio/agent/node/agent';
import { createFakeHost } from '@studio/agent/node/tests/fake-host';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	installAcceptanceObserver,
	readObservedLines,
	type ObservedRequest,
} from 'cli/ai/chatgpt-acceptance-observer';
import {
	evalConnectionRef,
	readEvalProviderRequest,
	resolveEvalProviderPlan,
	summarizeExecutedRoute,
	type EvalProviderDeps,
	type EvalProviderRequest,
} from 'cli/ai/eval-provider';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ChatGptTurnHandle } from '@studio/agent/node/chatgpt/credential-broker';
import type { ConnectionRegistryEntry } from '@studio/agent/protocol/connections';

// Test values only; nothing here reaches OpenAI, Anthropic or WordPress.com.
const CONNECTION_ID = '7c1e8a41-6d3b-4c55-9b8e-3f2d7c1eb2f0';
const OTHER_CONNECTION_ID = '8d2f9b52-6d3b-4c55-9b8e-3f2d7c1eb2f1';
const CHATGPT_TOKEN = 'test-chatgpt-route-token';
const API_KEY = 'sk-proj-TESTONLY_eval_provider_aaaaaaaaaaaaaaaaaaaa';

const paths = vi.hoisted( () => ( { root: '' } ) );

vi.mock( '@studio/common/lib/well-known-paths', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/common/lib/well-known-paths') >();
	return {
		...actual,
		getConfigDirectory: () => path.join( paths.root, 'config' ),
		getAiPayloadsPath: () => path.join( paths.root, 'config', 'ai-payloads' ),
	};
} );

// No WordPress.com login, so Studio's separate image service is off.
vi.mock( '@studio/common/lib/shared-config', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/common/lib/shared-config') >() ),
	readAuthToken: async () => null,
} ) );

const broker = vi.hoisted( () => ( {
	connections: [] as ConnectionRegistryEntry[],
	begun: [] as string[],
} ) );

vi.mock( '@studio/agent/node/chatgpt/credential-broker', async ( importOriginal ) => {
	const actual =
		await importOriginal< typeof import('@studio/agent/node/chatgpt/credential-broker') >();
	return {
		...actual,
		listChatGptConnections: async () => broker.connections,
		beginChatGptTurn: async ( connectionId: string ): Promise< ChatGptTurnHandle > => {
			broker.begun.push( connectionId );
			const controller = new AbortController();
			return {
				connectionId,
				signal: controller.signal,
				getAccessToken: async () => CHATGPT_TOKEN,
				assertActive: async () => undefined,
				invalidateAccessToken: async () => undefined,
				end: () => undefined,
			};
		},
	};
} );

const connection = (
	overrides: Partial< ConnectionRegistryEntry > = {}
): ConnectionRegistryEntry => ( {
	connectionId: CONNECTION_ID,
	providerId: 'chatgpt-oauth',
	backend: 'pi',
	revision: 3,
	identity: { subject: 'test-subject' },
	authStatus: 'connected',
	...overrides,
} );

// What the global provider resolution would hand a turn: a saved OpenAI API
// key. A provider-selected run must never call it.
function legacyProviders( globalKey = API_KEY ) {
	const resolveEnv = vi.fn( async () => ( { STUDIO_OPENAI_API_KEY: globalKey } ) );
	const isReady = vi.fn( async () => true );
	return {
		resolveEnv,
		isReady,
		provider: vi.fn( ( id: string ) => ( {
			isReady: id === 'chatgpt-oauth' ? async () => false : isReady,
			resolveEnv:
				id === 'chatgpt-oauth' ? async () => ( { PATH: process.env.PATH ?? '' } ) : resolveEnv,
			supportsModel: ( model: string ) =>
				id === 'openai-api-key' ? model.startsWith( 'gpt-' ) : model === 'fast',
			defaultModel: id === 'openai-api-key' ? 'gpt-6-luna' : 'fast',
		} ) ) as unknown as EvalProviderDeps[ 'provider' ],
	};
}

const profileUse = vi.hoisted( () => ( { used: [] as string[] } ) );

function deps( overrides: Partial< EvalProviderDeps > = {} ): EvalProviderDeps {
	return {
		isChatGptEnabled: () => true,
		listChatGptConnections: async () => {
			// Read from the dedicated profile, never before it is in use.
			expect( profileUse.used ).toEqual( [ path.join( paths.root, 'dedicated' ) ] );
			return broker.connections;
		},
		provider: legacyProviders().provider,
		home: path.join( paths.root, 'home' ),
		configDirectory: () => path.join( paths.root, 'config' ),
		useChatGptProfile: ( directory ) => {
			profileUse.used.push( directory );
		},
		...overrides,
	};
}

let replyCount = 0;
function textReply( text: string ): Response {
	const id = `msg_${ ++replyCount }`;
	const events = [
		{
			type: 'response.created',
			response: { id: `resp_${ id }`, status: 'in_progress', output: [] },
		},
		{
			type: 'response.output_item.added',
			output_index: 0,
			item: { type: 'message', id, role: 'assistant', content: [], status: 'in_progress' },
		},
		{ type: 'response.output_text.delta', output_index: 0, item_id: id, delta: text },
		{
			type: 'response.output_item.done',
			output_index: 0,
			item: {
				type: 'message',
				id,
				role: 'assistant',
				status: 'completed',
				content: [ { type: 'output_text', text, annotations: [] } ],
			},
		},
		{
			type: 'response.completed',
			response: {
				id: `resp_${ id }`,
				status: 'completed',
				output: [],
				usage: {
					input_tokens: 900,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens: 20,
					output_tokens_details: { reasoning_tokens: 0 },
					total_tokens: 920,
				},
			},
		},
	];
	return new Response(
		events
			.map( ( event ) => `event: ${ event.type }\ndata: ${ JSON.stringify( event ) }\n\n` )
			.join( '' ),
		{ status: 200, headers: { 'content-type': 'text/event-stream' } }
	);
}

interface SeenRequest {
	url: string;
	authorization: string | null;
	model?: unknown;
}

describe( 'eval provider selection', () => {
	let fetchSpy: ReturnType< typeof vi.spyOn >;
	let seen: SeenRequest[];

	beforeEach( () => {
		paths.root = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-eval-provider-' ) );
		fs.mkdirSync( path.join( paths.root, 'config' ), { recursive: true } );
		fs.mkdirSync( path.join( paths.root, 'dedicated' ), { recursive: true } );
		fs.mkdirSync( path.join( paths.root, 'home', '.studio' ), { recursive: true } );
		profileUse.used = [];
		broker.connections = [ connection() ];
		broker.begun = [];
		seen = [];
		fetchSpy = vi.spyOn( globalThis, 'fetch' ).mockImplementation( async ( input, init ) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			const headers = new Headers( init?.headers );
			let model: unknown;
			try {
				model = JSON.parse( String( init?.body ?? '{}' ) ).model;
			} catch {
				model = undefined;
			}
			seen.push( { url, authorization: headers.get( 'authorization' ), model } );
			return textReply( 'READY' );
		} );
	} );

	afterEach( () => {
		fetchSpy.mockRestore();
		fs.rmSync( paths.root, { recursive: true, force: true, maxRetries: 5 } );
	} );

	describe( 'reading the selection', () => {
		it( 'leaves the default path alone when nothing names a provider, whatever the model', () => {
			expect( readEvalProviderRequest( { env: {}, vars: {} } ) ).toBeNull();
			// A model alone never selects a billing route: it stays on the default path.
			expect(
				readEvalProviderRequest( { env: { STUDIO_EVAL_MODEL: 'gpt-6-luna' }, vars: {} } )
			).toBeNull();
			expect( readEvalProviderRequest( { env: {}, vars: { model: 'gpt-6-luna' } } ) ).toBeNull();
		} );

		it( 'takes the provider from the environment or the case, and the connection only from the environment', () => {
			expect(
				readEvalProviderRequest( {
					env: {
						STUDIO_EVAL_PROVIDER: 'chatgpt-oauth',
						STUDIO_EVAL_CONNECTION: CONNECTION_ID,
						STUDIO_EVAL_CHATGPT_PROFILE: '/profiles/eval',
						STUDIO_EVAL_EFFORT: 'low',
						STUDIO_EVAL_MODEL: 'gpt-6-luna',
					},
					vars: { chatGptProfile: '/somewhere/else' },
				} )
			).toEqual( {
				ok: true,
				request: {
					provider: 'chatgpt-oauth',
					connectionId: CONNECTION_ID,
					chatGptProfile: '/profiles/eval',
					model: 'gpt-6-luna',
					effort: 'low',
				},
			} );
			expect(
				readEvalProviderRequest( {
					env: { STUDIO_EVAL_CONNECTION: CONNECTION_ID },
					vars: { provider: 'chatgpt-oauth', model: 'gpt-6-luna', connection: OTHER_CONNECTION_ID },
				} )
			).toEqual( {
				ok: true,
				request: { provider: 'chatgpt-oauth', connectionId: CONNECTION_ID, model: 'gpt-6-luna' },
			} );
		} );

		it.each( [
			[
				'provider-conflict',
				{ STUDIO_EVAL_PROVIDER: 'chatgpt-oauth' },
				{ provider: 'openai-api-key' },
			],
			[ 'provider-unknown', { STUDIO_EVAL_PROVIDER: 'chatgpt' }, {} ],
			[ 'provider-required', {}, { requireProvider: true } ],
			[ 'selection-without-provider', { STUDIO_EVAL_CONNECTION: CONNECTION_ID }, {} ],
			[ 'selection-without-provider', { STUDIO_EVAL_EFFORT: 'low' }, {} ],
			[ 'selection-without-provider', { STUDIO_EVAL_CHATGPT_PROFILE: '/profiles/eval' }, {} ],
		] )( 'refuses %s', ( code, env, vars ) => {
			const result = readEvalProviderRequest( { env, vars } );
			expect( result ).toMatchObject( { ok: false, failure: { code } } );
			expect( result?.ok === false && result.failure.message ).toMatch( /\w/ );
		} );
	} );

	// One row per provider: a selected eval runs on its own route even when a
	// paid API key is the global provider, whatever its model is called. The
	// Claude side adds its row here.
	describe.each( [
		{
			name: 'a ChatGPT-selected eval with a model the OpenAI API also lists',
			request: {
				provider: 'chatgpt-oauth',
				connectionId: CONNECTION_ID,
				model: 'gpt-6-luna',
				effort: 'low',
			} satisfies EvalProviderRequest,
			runs: true,
			wireModel: 'gpt-6-luna',
		},
		{
			name: 'a ChatGPT-selected eval with an OpenAI API model the route is not qualified for',
			request: {
				provider: 'chatgpt-oauth',
				connectionId: CONNECTION_ID,
				model: 'gpt-6.1-sol',
			} satisfies EvalProviderRequest,
			runs: false,
			code: 'model-not-qualified',
		},
	] )( '$name', ( row ) => {
		it( 'never resolves or falls back to the global API-key provider', async () => {
			const legacy = legacyProviders();
			const resolved = await resolveEvalProviderPlan(
				{ ...row.request, chatGptProfile: path.join( paths.root, 'dedicated' ) },
				deps( { provider: legacy.provider } )
			);
			expect( legacy.resolveEnv ).not.toHaveBeenCalled();
			expect( legacy.isReady ).not.toHaveBeenCalled();
			if ( ! row.runs ) {
				expect( resolved ).toMatchObject( { ok: false, failure: { code: row.code } } );
				expect( fetchSpy ).not.toHaveBeenCalled();
				expect( broker.begun ).toEqual( [] );
				return;
			}
			if ( ! resolved.ok ) {
				throw new Error( resolved.failure.message );
			}
			const { plan } = resolved;
			expect( plan.env ).not.toHaveProperty( 'STUDIO_OPENAI_API_KEY' );
			expect( plan.env ).not.toHaveProperty( 'ANTHROPIC_API_KEY' );
			expect( plan.turn.connection ).toEqual( {
				connectionId: CONNECTION_ID,
				model: { providerId: 'chatgpt-oauth', modelId: 'gpt-6-luna' },
				revision: 3,
			} );
			expect( plan.requested ).toEqual( {
				kind: 'chatgpt-oauth',
				backend: 'chatgpt-route',
				subscription: true,
				connectionRef: evalConnectionRef( CONNECTION_ID ),
				model: 'gpt-6-luna',
				wireModel: row.wireModel,
				effort: 'low',
			} );

			// The real agent session runs the plan, with an API key planted in its
			// environment as well: every request goes over the ChatGPT route with
			// the connection's token.
			const sitesRoot = path.join( paths.root, 'sites' );
			const sessionDir = path.join( paths.root, 'sessions' );
			fs.mkdirSync( sitesRoot, { recursive: true } );
			fs.mkdirSync( sessionDir, { recursive: true } );
			const session = SessionManager.create( sitesRoot, sessionDir );
			session.appendCustomEntry( 'studio.session_context', plan.sessionContext );
			const observerFile = path.join( paths.root, 'requests.ndjson' );
			const uninstall = installAcceptanceObserver( observerFile );
			const events: AgentSessionEvent[] = [];
			try {
				const turn = createAgent( { host: createFakeHost( sitesRoot ) } ).runTurn( {
					prompt: 'Reply with the single word READY.',
					env: { ...plan.env, STUDIO_OPENAI_API_KEY: API_KEY, OPENAI_API_KEY: API_KEY },
					session,
					onEvent: ( event ) => events.push( event ),
					...plan.turn,
				} );
				await turn.result;
			} finally {
				uninstall();
			}
			expect( seen.length ).toBeGreaterThan( 0 );
			for ( const request of seen ) {
				expect( request.url ).toBe( 'https://api.openai.com/v1/responses' );
				expect( request.authorization ).toBe( `Bearer ${ CHATGPT_TOKEN }` );
				expect( request.model ).toBe( 'gpt-6-luna' );
			}
			expect( broker.begun ).toEqual( [ CONNECTION_ID ] );

			const replies = events.flatMap( ( event ) =>
				event.type === 'message_end' && event.message.role === 'assistant'
					? [ event.message as { provider?: unknown; model?: unknown } ]
					: []
			);
			const executed = summarizeExecutedRoute( {
				requests: readObservedLines( observerFile ).filter(
					( line ): line is ObservedRequest => line.kind === 'request'
				),
				replies,
				entries: session.getEntries(),
			} );
			expect( executed ).toMatchObject( {
				kind: 'chatgpt-oauth',
				backend: 'chatgpt-route',
				apiKeyBearers: 0,
				connectionRef: plan.requested.connectionRef,
				models: [ 'gpt-6-luna' ],
				efforts: [ 'low' ],
				replyKinds: [ 'chatgpt-oauth' ],
			} );
			expect( executed.modelRequests ).toBe( seen.length );
			expect( JSON.stringify( executed ) ).not.toContain( CHATGPT_TOKEN );
			expect( JSON.stringify( executed ) ).not.toContain( CONNECTION_ID );
		} );
	} );

	describe( 'refusals', () => {
		const chatGpt = ( overrides: Partial< EvalProviderRequest > = {} ): EvalProviderRequest => ( {
			provider: 'chatgpt-oauth',
			connectionId: CONNECTION_ID,
			model: 'gpt-6-luna',
			...overrides,
		} );
		// The rows are listed before any test makes its folders.
		const withProfile = ( request: EvalProviderRequest ): EvalProviderRequest =>
			request.provider === 'chatgpt-oauth'
				? { chatGptProfile: path.join( paths.root, 'dedicated' ), ...request }
				: request;

		it.each( [
			[ 'experimental-flag-off', chatGpt(), { isChatGptEnabled: () => false } ],
			[ 'connection-required', chatGpt( { connectionId: undefined } ), {} ],
			[ 'connection-unknown', chatGpt( { connectionId: OTHER_CONNECTION_ID } ), {} ],
			[
				'connection-signed-out',
				chatGpt(),
				{ listChatGptConnections: async () => [ connection( { authStatus: 'disconnected' } ) ] },
			],
			[
				'connection-signed-out',
				chatGpt(),
				{ listChatGptConnections: async () => [ connection( { identity: null } ) ] },
			],
			[
				'connection-unsupported',
				chatGpt(),
				{ listChatGptConnections: async () => [ connection( { backend: 'claude-code' } ) ] },
			],
			[
				'connection-state-unavailable',
				chatGpt(),
				{
					listChatGptConnections: async () => {
						throw new Error( 'unreadable' );
					},
				},
			],
			[ 'model-not-qualified', chatGpt( { model: 'gpt-6.1-sol' } ), {} ],
			[ 'model-not-qualified', chatGpt( { model: 'fast' } ), {} ],
			[ 'effort-not-qualified', chatGpt( { effort: 'high' } ), {} ],
			[
				'connection-not-applicable',
				{ provider: 'openai-api-key', connectionId: CONNECTION_ID } as EvalProviderRequest,
				{},
			],
			[
				'effort-not-applicable',
				{ provider: 'openai-api-key', effort: 'low' } as EvalProviderRequest,
				{},
			],
			[
				'model-provider-mismatch',
				{ provider: 'openai-api-key', model: 'claude-sonnet-5' } as EvalProviderRequest,
				{},
			],
			[
				'profile-not-applicable',
				{ provider: 'openai-api-key', chatGptProfile: '/profiles/eval' } as EvalProviderRequest,
				{},
			],
		] as Array< [ string, EvalProviderRequest, Partial< EvalProviderDeps > ] > )(
			'refuses %s before any model request',
			async ( code, request, overrides ) => {
				const result = await resolveEvalProviderPlan( withProfile( request ), deps( overrides ) );
				expect( result ).toMatchObject( { ok: false, failure: { code } } );
				expect( result.ok === false && result.failure.message ).toMatch( /\w/ );
				expect( fetchSpy ).not.toHaveBeenCalled();
				expect( broker.begun ).toEqual( [] );
			}
		);

		it( 'refuses a legacy provider that is not ready rather than running elsewhere', async () => {
			const notReady = vi.fn( async () => false );
			const resolveEnv = vi.fn();
			const result = await resolveEvalProviderPlan(
				{ provider: 'anthropic-api-key', model: 'claude-sonnet-5' },
				deps( {
					provider: () => ( {
						isReady: notReady,
						resolveEnv,
						supportsModel: () => true,
						defaultModel: 'claude-sonnet-5',
					} ),
				} )
			);
			expect( result ).toMatchObject( { ok: false, failure: { code: 'provider-not-ready' } } );
			expect( resolveEnv ).not.toHaveBeenCalled();
			expect( fetchSpy ).not.toHaveBeenCalled();
		} );

		it( 'plans an explicitly selected legacy provider on its own key, never the global one', async () => {
			const result = await resolveEvalProviderPlan(
				{ provider: 'openai-api-key', model: 'gpt-6-luna' },
				deps()
			);
			expect( result ).toMatchObject( {
				ok: true,
				plan: {
					requested: {
						kind: 'openai-api-key',
						backend: 'openai-api',
						subscription: false,
						connectionRef: 'openai-api-key',
						wireModel: 'gpt-6-luna',
						effort: null,
					},
					turn: { model: 'gpt-6-luna' },
				},
			} );
			expect( result.ok && result.plan.turn ).not.toHaveProperty( 'connection' );
		} );
	} );

	describe( 'the executed route comes from the run', () => {
		const request = ( overrides: Partial< ObservedRequest > ): ObservedRequest => ( {
			kind: 'request',
			id: 1,
			pid: 1,
			startedAt: 0,
			host: 'chatgpt-route',
			endpoint: 'responses',
			bearer: 'jwt',
			model: 'gpt-6-luna',
			effort: 'low',
			...overrides,
		} );
		const pinned = ( connectionId: string ) => {
			const session = SessionManager.inMemory( paths.root );
			session.appendCustomEntry( 'studio.session_context', {
				provider: 'chatgpt-oauth',
				connectionId,
				revision: 3,
				model: 'gpt-6-luna',
				reasoningEffort: 'low',
			} );
			return session.getEntries();
		};

		it( 'names the API route when the requests carried an API key, whatever was asked for', () => {
			expect(
				summarizeExecutedRoute( {
					requests: [ request( { host: 'openai-api', bearer: 'api-key' } ) ],
					replies: [ { provider: 'studio-openai', model: 'gpt-6-luna' } ],
					entries: pinned( CONNECTION_ID ),
				} )
			).toMatchObject( {
				kind: 'openai-api-key',
				backend: 'openai-api',
				apiKeyBearers: 1,
				connectionRef: 'openai-api-key',
				replyKinds: [ 'openai-api-key' ],
			} );
		} );

		it( 'reads the connection from the conversation record the runtime checked, not from the request', () => {
			expect(
				summarizeExecutedRoute( {
					requests: [ request( {} ) ],
					replies: [ { provider: 'studio-chatgpt', model: 'gpt-6-luna' } ],
					entries: pinned( OTHER_CONNECTION_ID ),
				} ).connectionRef
			).toBe( evalConnectionRef( OTHER_CONNECTION_ID ) );
			expect( evalConnectionRef( OTHER_CONNECTION_ID ) ).not.toBe(
				evalConnectionRef( CONNECTION_ID )
			);
			expect( evalConnectionRef( CONNECTION_ID ) ).toMatch( /^conn-[0-9a-f]{12}$/ );
		} );

		it( 'tells which user message each request belongs to', () => {
			const executed = summarizeExecutedRoute( {
				requests: [
					request( { id: 1, startedAt: 1_000, imageInputs: 1 } ),
					request( { id: 2, startedAt: 2_500, imageInputs: 1 } ),
					request( { id: 3, startedAt: 3_000 } ),
				],
				replies: [],
				entries: [],
				turnStartedAt: [ 900, 2_400 ],
			} );
			expect( executed.requests.map( ( item ) => [ item.turn, item.imageInputs ] ) ).toEqual( [
				[ 0, 1 ],
				[ 1, 1 ],
				[ 1, undefined ],
			] );
		} );

		it( 'reports a mix, no request at all, and keeps the image service apart from inference', () => {
			expect(
				summarizeExecutedRoute( {
					requests: [
						request( {} ),
						request( { id: 2, host: 'wpcom-ai-proxy', bearer: 'opaque' } ),
					],
					replies: [],
					entries: [],
				} )
			).toMatchObject( { kind: 'mixed', backend: 'mixed', modelRequests: 2 } );
			expect( summarizeExecutedRoute( { requests: [], replies: [], entries: [] } ) ).toMatchObject(
				{ kind: 'none', backend: 'none', modelRequests: 0, connectionRef: null }
			);
			expect(
				summarizeExecutedRoute( {
					requests: [
						request( {} ),
						request( {
							id: 2,
							host: 'wpcom-ai-proxy',
							endpoint: 'images',
							bearer: 'opaque',
							model: undefined,
						} ),
						request( { id: 3, host: 'wpcom', endpoint: 'other', model: undefined } ),
					],
					replies: [],
					entries: pinned( CONNECTION_ID ),
				} )
			).toMatchObject( {
				kind: 'chatgpt-oauth',
				modelRequests: 1,
				imageServiceRequests: 1,
			} );
		} );
	} );

	describe( 'the dedicated ChatGPT test profile', () => {
		const chatGpt = ( chatGptProfile?: string ): EvalProviderRequest => ( {
			provider: 'chatgpt-oauth',
			connectionId: CONNECTION_ID,
			model: 'gpt-6-luna',
			...( chatGptProfile === undefined ? {} : { chatGptProfile } ),
		} );
		const refused = async (
			request: EvalProviderRequest,
			code: string,
			overrides: Partial< EvalProviderDeps > = {}
		) => {
			const listed = vi.fn( async () => broker.connections );
			const result = await resolveEvalProviderPlan(
				request,
				deps( { listChatGptConnections: listed, ...overrides } )
			);
			expect( result ).toMatchObject( { ok: false, failure: { code } } );
			expect( result.ok === false && result.failure.message ).toMatch( /\w/ );
			// Refused before any ChatGPT state was read or pointed anywhere.
			expect( listed ).not.toHaveBeenCalled();
			expect( profileUse.used ).toEqual( [] );
			expect( fetchSpy ).not.toHaveBeenCalled();
		};

		it( 'is required, as an absolute path to a directory that exists', async () => {
			await refused( chatGpt(), 'profile-required' );
			await refused( chatGpt( 'relative/profile' ), 'profile-relative' );
			await refused( chatGpt( path.join( paths.root, 'missing' ) ), 'profile-not-found' );
			const file = path.join( paths.root, 'a-file' );
			fs.writeFileSync( file, '' );
			await refused( chatGpt( file ), 'profile-not-found' );
		} );

		it( 'is never the Studio profile, inside it, or a link that resolves into it', async () => {
			const studio = path.join( paths.root, 'home', '.studio' );
			await refused( chatGpt( studio ), 'profile-in-studio-profile' );
			fs.mkdirSync( path.join( studio, 'eval' ) );
			await refused( chatGpt( path.join( studio, 'eval' ) ), 'profile-in-studio-profile' );
			const link = path.join( paths.root, 'looks-dedicated' );
			fs.symlinkSync( studio, link, process.platform === 'win32' ? 'junction' : 'dir' );
			try {
				await refused( chatGpt( link ), 'profile-in-studio-profile' );
			} finally {
				fs.unlinkSync( link );
			}
		} );

		it( 'is never the directory this process keeps its own Studio config in', async () => {
			const dedicated = path.join( paths.root, 'dedicated' );
			await refused( chatGpt( dedicated ), 'profile-is-config-directory', {
				configDirectory: () => dedicated,
			} );
			await refused( chatGpt( dedicated ), 'profile-is-config-directory', {
				configDirectory: () => path.join( dedicated, 'nested' ),
			} );
		} );

		it( 'is put in use for this process before its connections are read, and must hold the selected one', async () => {
			const dedicated = path.join( paths.root, 'dedicated' );
			expect( ( await resolveEvalProviderPlan( chatGpt( dedicated ), deps() ) ).ok ).toBe( true );
			expect( profileUse.used ).toEqual( [ dedicated ] );

			profileUse.used = [];
			expect(
				await resolveEvalProviderPlan(
					chatGpt( dedicated ),
					deps( {
						useChatGptProfile: () => {
							throw new Error( 'in use' );
						},
					} )
				)
			).toMatchObject( { ok: false, failure: { code: 'profile-unavailable' } } );

			profileUse.used = [];
			broker.connections = [];
			expect( await resolveEvalProviderPlan( chatGpt( dedicated ), deps() ) ).toMatchObject( {
				ok: false,
				failure: { code: 'connection-unknown' },
			} );
		} );
	} );
} );
