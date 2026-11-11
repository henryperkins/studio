// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evalConnectionRef } from 'cli/ai/eval-provider';
import { readEvalRunnerInput, runEval as runEvalUntyped } from 'cli/ai/eval-runner';
import type { AgentSessionEvent, SessionManager } from '@earendil-works/pi-coding-agent';
import type { StudioAgentTurnConfig } from '@studio/agent/node/runtime';
import type { ConnectionRegistryEntry } from '@studio/agent/protocol/connections';

// Test values only; nothing here reaches a model provider or a site.
const CONNECTION_ID = '7c1e8a41-6d3b-4c55-9b8e-3f2d7c1eb2f0';
const API_KEY = 'sk-proj-TESTONLY_eval_runner_bbbbbbbbbbbbbbbbbbbbbb';

const paths = vi.hoisted( () => ( { root: '' } ) );

vi.mock( '@studio/common/lib/well-known-paths', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/common/lib/well-known-paths') >();
	const config = () =>
		process.env.E2E_SHARED_CONFIG_PATH && process.env.E2E
			? process.env.E2E_SHARED_CONFIG_PATH
			: path.join( paths.root, 'profile' );
	return {
		...actual,
		getConfigDirectory: config,
		getSharedConfigPath: () => path.join( config(), 'shared.json' ),
	};
} );

const legacy = vi.hoisted( () => ( {
	resolveInitialAiProvider: vi.fn(),
	resolveUnavailableAiProvider: vi.fn(),
	resolveAiEnvironment: vi.fn(),
} ) );
vi.mock( 'cli/ai/auth', () => legacy );

const sites = vi.hoisted( () => ( {
	create: vi.fn( async () => undefined ),
	remove: vi.fn( async () => undefined ),
} ) );
vi.mock( 'cli/commands/site/create', () => ( { runCommand: sites.create } ) );
vi.mock( 'cli/commands/site/delete', () => ( { runCommand: sites.remove } ) );
vi.mock( 'cli/lib/cli-config/core', () => ( {
	readCliConfig: async () => ( { sites: [], snapshots: [] } ),
	saveCliConfig: async () => undefined,
	lockCliConfig: async () => undefined,
	unlockCliConfig: async () => undefined,
} ) );
vi.mock( 'cli/ai/eval-outcome', () => ( {
	fingerprintSites: async () => [],
	captureTurnOutcome: async () => ( {
		sites: [],
		requestSiteChanged: null,
		otherSitesChanged: [],
		otherSitesRemoved: [],
	} ),
} ) );
vi.mock( '@studio/agent/node/image-generation', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/agent/node/image-generation') >() ),
	isImageGenerationAvailable: async () => false,
} ) );

const broker = vi.hoisted( () => ( {
	connections: [] as ConnectionRegistryEntry[],
	setTokenClient: vi.fn(),
} ) );
vi.mock( '@studio/agent/node/chatgpt/credential-broker', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/agent/node/chatgpt/credential-broker') >() ),
	listChatGptConnections: async () => broker.connections,
	setChatGptTokenClient: broker.setTokenClient,
} ) );

// The agent the runner drives: records each turn's configuration and, like a
// runtime, makes its model requests with global fetch and emits its events.
interface FakeTurnBehavior {
	request?: { url: string; authorization: string; body: Record< string, unknown > };
	replyProvider: string;
}
const agent = vi.hoisted( () => ( {
	turns: [] as Array< StudioAgentTurnConfig & { entriesAtStart: unknown[] } >,
	behavior: null as FakeTurnBehavior | null,
} ) );
vi.mock( '@studio/agent/node', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/agent/node') >();
	return {
		...actual,
		createAgent: () => ( {
			runTurn: ( config: StudioAgentTurnConfig ) => {
				agent.turns.push( {
					...config,
					entriesAtStart: ( config.session as SessionManager ).getEntries(),
				} );
				const result = ( async () => {
					const behavior = agent.behavior;
					if ( behavior?.request ) {
						await fetch( behavior.request.url, {
							method: 'POST',
							headers: { authorization: behavior.request.authorization },
							body: JSON.stringify( behavior.request.body ),
						} );
					}
					const message = {
						role: 'assistant',
						content: [ { type: 'text', text: 'READY' } ],
						api: 'openai-responses',
						provider: behavior?.replyProvider ?? 'studio-wpcom',
						model: 'gpt-6-luna',
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: 'stop',
						timestamp: Date.now(),
					};
					config.onEvent( { type: 'message_end', message } as unknown as AgentSessionEvent );
					config.onEvent( {
						type: 'agent_end',
						messages: [ message ],
					} as unknown as AgentSessionEvent );
				} )();
				return { result, interrupt: async () => undefined, hasTool: () => false };
			},
		} ),
	};
} );

// The fields of a run's result these tests read.
interface RunReport {
	success?: boolean;
	error?: unknown;
	model?: string;
	refusal?: { code: string };
	providerRoute?: {
		requested: { kind: string } | null;
		executed?: Record< string, unknown >;
		failure?: { code: string };
	};
}
const runEval = async ( ...args: Parameters< typeof runEvalUntyped > ) =>
	( await runEvalUntyped( ...args ) ) as RunReport;

const input = ( vars: Record< string, unknown > = {}, env: NodeJS.ProcessEnv = {} ) =>
	readEvalRunnerInput(
		[ 'node', 'eval-runner.mjs', 'Reply READY.', '', JSON.stringify( { vars } ) ],
		env
	);

describe( 'eval runner provider selection', () => {
	const savedEnv = { ...process.env };
	let fetchSpy: ReturnType< typeof vi.spyOn >;

	beforeEach( () => {
		paths.root = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-eval-runner-' ) );
		const profile = path.join( paths.root, 'profile' );
		fs.mkdirSync( path.join( profile, 'chatgpt-credentials' ), { recursive: true } );
		fs.writeFileSync(
			path.join( profile, 'shared.json' ),
			JSON.stringify( { version: 1, aiProvider: 'openai-api-key' } )
		);
		fs.writeFileSync( path.join( profile, 'chatgpt-accounts.json' ), '{}' );
		for ( const name of [
			'DEV_CONFIG_DIR',
			'E2E',
			'E2E_SHARED_CONFIG_PATH',
			'E2E_CLI_CONFIG_PATH',
		] ) {
			delete process.env[ name ];
		}
		process.env.STUDIO_EVAL_SESSION_DIR = path.join( paths.root, 'sessions' );
		process.env.STUDIO_EXPERIMENTAL_CHATGPT = '1';
		broker.connections = [
			{
				connectionId: CONNECTION_ID,
				providerId: 'chatgpt-oauth',
				backend: 'pi',
				revision: 2,
				identity: { subject: 'test-subject' },
				authStatus: 'connected',
			},
		];
		agent.turns = [];
		agent.behavior = null;
		// The global provider is OpenAI with a saved key.
		legacy.resolveInitialAiProvider.mockResolvedValue( 'openai-api-key' );
		legacy.resolveUnavailableAiProvider.mockResolvedValue( undefined );
		legacy.resolveAiEnvironment.mockResolvedValue( { STUDIO_OPENAI_API_KEY: API_KEY } );
		fetchSpy = vi
			.spyOn( globalThis, 'fetch' )
			.mockImplementation( async () => new Response( '{}', { status: 200 } ) );
	} );

	afterEach( () => {
		fetchSpy.mockRestore();
		for ( const key of Object.keys( process.env ) ) {
			if ( ! ( key in savedEnv ) ) {
				delete process.env[ key ];
			}
		}
		Object.assign( process.env, savedEnv );
		fs.rmSync( paths.root, { recursive: true, force: true, maxRetries: 5 } );
	} );

	it( 'runs an unselected eval exactly as before: the global provider, the model alone, no route report', async () => {
		const result = await runEval( input( { model: 'gpt-6-luna' } ) );
		expect( legacy.resolveInitialAiProvider ).toHaveBeenCalledTimes( 1 );
		expect( legacy.resolveAiEnvironment ).toHaveBeenCalledWith( 'openai-api-key' );
		expect( agent.turns ).toHaveLength( 1 );
		const [ turn ] = agent.turns;
		expect( turn.model ).toBe( 'gpt-6-luna' );
		expect( turn ).not.toHaveProperty( 'connection' );
		expect( turn ).not.toHaveProperty( 'chatGpt' );
		expect( turn.env?.STUDIO_OPENAI_API_KEY ).toBe( API_KEY );
		expect( result ).not.toHaveProperty( 'providerRoute' );
		expect( broker.setTokenClient ).not.toHaveBeenCalled();
	} );

	it( 'runs a ChatGPT-selected eval on the connection, never the global API key, and pins the conversation first', async () => {
		agent.behavior = {
			request: {
				url: 'https://api.openai.com/v1/responses',
				authorization: 'Bearer test-chatgpt-route-token',
				body: { model: 'gpt-6-luna', reasoning: { effort: 'low' }, store: false, stream: true },
			},
			replyProvider: 'studio-chatgpt',
		};
		const result = await runEval(
			input(
				{ followUps: [ { prompt: 'Again.' } ] },
				{
					STUDIO_EVAL_PROVIDER: 'chatgpt-oauth',
					STUDIO_EVAL_CONNECTION: CONNECTION_ID,
					STUDIO_EVAL_MODEL: 'gpt-6-luna',
					STUDIO_EVAL_EFFORT: 'low',
				}
			)
		);
		expect( legacy.resolveInitialAiProvider ).not.toHaveBeenCalled();
		expect( legacy.resolveAiEnvironment ).not.toHaveBeenCalled();
		expect( broker.setTokenClient ).toHaveBeenCalledTimes( 1 );
		expect( agent.turns ).toHaveLength( 2 );
		for ( const turn of agent.turns ) {
			expect( turn.connection ).toEqual( {
				connectionId: CONNECTION_ID,
				model: { providerId: 'chatgpt-oauth', modelId: 'gpt-6-luna' },
				revision: 2,
			} );
			expect( turn.chatGpt ).toEqual( { reasoningEffort: 'low' } );
			expect( turn.env ).not.toHaveProperty( 'STUDIO_OPENAI_API_KEY' );
			// Each turn starts on a conversation that names its connection, as the CLI writes it.
			expect( JSON.stringify( turn.entriesAtStart ) ).toContain( 'studio.session_context' );
		}
		expect( result.providerRoute ).toMatchObject( {
			requested: {
				kind: 'chatgpt-oauth',
				backend: 'chatgpt-route',
				connectionRef: evalConnectionRef( CONNECTION_ID ),
				model: 'gpt-6-luna',
				effort: 'low',
			},
			executed: {
				kind: 'chatgpt-oauth',
				backend: 'chatgpt-route',
				connectionRef: evalConnectionRef( CONNECTION_ID ),
				modelRequests: 2,
				apiKeyBearers: 0,
				replyKinds: [ 'chatgpt-oauth' ],
			},
		} );
		expect( result.model ).toBe( 'gpt-6-luna' );
		expect( JSON.stringify( result ) ).not.toContain( CONNECTION_ID );
		expect( JSON.stringify( result ) ).not.toContain( 'test-chatgpt-route-token' );
	} );

	it( 'reports the route the run actually took, so a run that ends up on an API key is caught', async () => {
		agent.behavior = {
			request: {
				url: 'https://api.openai.com/v1/responses',
				authorization: `Bearer ${ API_KEY }`,
				body: { model: 'gpt-6-luna', reasoning: { effort: 'low' } },
			},
			replyProvider: 'studio-openai',
		};
		const result = await runEval(
			input(
				{ provider: 'chatgpt-oauth', model: 'gpt-6-luna', effort: 'low' },
				{ STUDIO_EVAL_CONNECTION: CONNECTION_ID }
			)
		);
		expect( result.providerRoute?.requested?.kind ).toBe( 'chatgpt-oauth' );
		expect( result.providerRoute?.executed ).toMatchObject( {
			kind: 'openai-api-key',
			backend: 'openai-api',
			apiKeyBearers: 1,
			replyKinds: [ 'openai-api-key' ],
		} );
		expect( JSON.stringify( result ) ).not.toContain( API_KEY );
	} );

	it.each( [
		[ 'experimental-flag-off', { STUDIO_EXPERIMENTAL_CHATGPT: '' } ],
		[ 'connection-required', { STUDIO_EVAL_CONNECTION: '' } ],
		[ 'connection-unknown', { STUDIO_EVAL_CONNECTION: '9e3f0c63-6d3b-4c55-9b8e-3f2d7c1eb2f9' } ],
		[ 'model-not-qualified', { STUDIO_EVAL_MODEL: 'gpt-6.1-sol' } ],
		[ 'effort-not-qualified', { STUDIO_EVAL_EFFORT: 'high' } ],
		[ 'provider-unknown', { STUDIO_EVAL_PROVIDER: 'chatgpt-plan' } ],
	] as Array< [ string, NodeJS.ProcessEnv ] > )(
		'refuses %s with its code, before any site, turn or model request',
		async ( code, env ) => {
			if ( env.STUDIO_EXPERIMENTAL_CHATGPT === '' ) {
				delete process.env.STUDIO_EXPERIMENTAL_CHATGPT;
			}
			const result = await runEval(
				input(
					{},
					{
						STUDIO_EVAL_PROVIDER: 'chatgpt-oauth',
						STUDIO_EVAL_CONNECTION: CONNECTION_ID,
						STUDIO_EVAL_MODEL: 'gpt-6-luna',
						...env,
					}
				)
			);
			expect( result ).toMatchObject( {
				success: false,
				refusal: { code },
				providerRoute: { failure: { code } },
			} );
			expect( result.error ).toMatch( /\w/ );
			expect( agent.turns ).toEqual( [] );
			expect( sites.create ).not.toHaveBeenCalled();
			expect( fetchSpy ).not.toHaveBeenCalled();
			expect( legacy.resolveAiEnvironment ).not.toHaveBeenCalled();
		}
	);

	it( 'refuses a parity case run without a provider instead of falling back to the global one', async () => {
		const result = await runEval( input( { requireProvider: true } ) );
		expect( result ).toMatchObject( { success: false, refusal: { code: 'provider-required' } } );
		expect( agent.turns ).toEqual( [] );
		expect( legacy.resolveInitialAiProvider ).not.toHaveBeenCalled();
	} );
} );
