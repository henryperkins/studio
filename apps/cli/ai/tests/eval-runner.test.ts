// @vitest-environment node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getChatGptStateDirectory } from '@studio/agent/node/chatgpt/state-directory';
import { wpcomRequestTool } from '@studio/agent/node/tools/wpcom-request';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { evalConnectionRef } from 'cli/ai/eval-provider';
import { readEvalRunnerInput, runEval as runEvalUntyped } from 'cli/ai/eval-runner';
import type { AgentSessionEvent, SessionManager } from '@earendil-works/pi-coding-agent';
import type { StudioAgentHost } from '@studio/agent/node/host';
import type { StudioAgentTurnConfig } from '@studio/agent/node/runtime';
import type { ConnectionRegistryEntry } from '@studio/agent/protocol/connections';

// Test values only; nothing here reaches a model provider or a site.
const CONNECTION_ID = '7c1e8a41-6d3b-4c55-9b8e-3f2d7c1eb2f0';
const API_KEY = 'sk-proj-TESTONLY_eval_runner_bbbbbbbbbbbbbbbbbbbbbb';
const WPCOM_LOGIN = { accessToken: 'test-wpcom-token', id: 1, displayName: 'Test', email: '' };

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
const imageService = vi.hoisted( () => ( { configured: false } ) );
vi.mock( '@studio/agent/node/image-generation', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/agent/node/image-generation') >() ),
	isImageGenerationAvailable: async () => imageService.configured,
} ) );

// The real host's remote operations must never run under `remote: mock`.
vi.mock( 'cli/ai/host', async () => {
	const { createFakeHost } = await import( '@studio/agent/node/tests/fake-host' );
	const host = createFakeHost();
	for ( const operation of [ 'push', 'pull' ] as const ) {
		host.sync[ operation ] = vi.fn( async () => {
			throw new Error( 'reached the real remote' );
		} );
	}
	return { cliAgentHost: host };
} );

const broker = vi.hoisted( () => ( {
	connections: [] as ConnectionRegistryEntry[],
	setTokenClient: vi.fn(),
	// Where the ChatGPT store read its connections from, each time it was asked.
	readFrom: [] as string[],
} ) );
vi.mock( '@studio/agent/node/chatgpt/credential-broker', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/agent/node/chatgpt/credential-broker') >() ),
	listChatGptConnections: async () => {
		broker.readFrom.push( getChatGptStateDirectory() );
		return broker.connections;
	},
	setChatGptTokenClient: broker.setTokenClient,
} ) );

// The agent the runner drives: records each turn's configuration and, like a
// runtime, makes its model requests with global fetch and emits its events.
interface FakeTurnBehavior {
	request?: { url: string; authorization: string; body: Record< string, unknown > };
	replyProvider: string;
	// What the turn does with its host and config before it replies.
	act?: ( turn: { config: StudioAgentTurnConfig; host: StudioAgentHost } ) => Promise< void >;
	// Tool calls the reply asks for, on the first turn only.
	toolCalls?: Array< { name: string; arguments: Record< string, unknown > } >;
}
const agent = vi.hoisted( () => ( {
	turns: [] as Array< StudioAgentTurnConfig & { entriesAtStart: unknown[]; host: unknown } >,
	behavior: null as FakeTurnBehavior | null,
	created: 0,
} ) );
vi.mock( '@studio/agent/node', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/agent/node') >();
	return {
		...actual,
		createAgent: ( { host }: { host: StudioAgentHost } ) => ( {
			created: ++agent.created,
			runTurn: ( config: StudioAgentTurnConfig ) => {
				agent.turns.push( {
					...config,
					entriesAtStart: ( config.session as SessionManager ).getEntries(),
					host,
				} );
				const first = agent.turns.length === 1;
				const result = ( async () => {
					const behavior = agent.behavior;
					await behavior?.act?.( { config, host } );
					if ( behavior?.request ) {
						await fetch( behavior.request.url, {
							method: 'POST',
							headers: { authorization: behavior.request.authorization },
							body: JSON.stringify( behavior.request.body ),
						} );
					}
					const message = {
						role: 'assistant',
						content: [
							{ type: 'text', text: 'READY' },
							...( first
								? ( behavior?.toolCalls ?? [] ).map( ( call, index ) => ( {
										type: 'toolCall',
										id: `call-${ index }`,
										name: call.name,
										arguments: call.arguments,
								  } ) )
								: [] ),
						],
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
	stoppedAt?: unknown;
	remoteCalls?: unknown[];
	remoteGuard?: { code: string | null; blocked: unknown[] };
	imageService?: { configured: boolean };
	attachments?: unknown[];
	turns?: Array< Record< string, unknown > >;
	questions?: Array< { answer: string } >;
	uiEvents?: { artifacts: unknown[]; previewReloads: number };
	compactions?: number;
}
const runEval = async ( ...args: Parameters< typeof runEvalUntyped > ) =>
	( await runEvalUntyped( ...args ) ) as RunReport;

const input = ( vars: Record< string, unknown > = {}, env: NodeJS.ProcessEnv = {} ) =>
	readEvalRunnerInput(
		[ 'node', 'eval-runner.mjs', 'Reply READY.', '', JSON.stringify( { vars } ) ],
		env
	);

// One dedicated ChatGPT profile for the whole file: a process keeps its ChatGPT
// state in one directory once it has used it.
const dedicated = { dir: '' };
beforeAll( () => {
	dedicated.dir = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-eval-dedicated-' ) );
} );
afterAll( () => {
	fs.rmSync( dedicated.dir, { recursive: true, force: true, maxRetries: 5 } );
} );

// The runner's temporary folders and files, in the test's own temporary folder.
const leftovers = () =>
	fs
		.readdirSync( path.join( paths.root, 'tmp' ) )
		.filter( ( name ) => /^studio-eval-(config|registry|requests)-/.test( name ) );

describe( 'eval runner provider selection', () => {
	const savedEnv = { ...process.env };
	let fetchSpy: ReturnType< typeof vi.spyOn >;

	beforeEach( () => {
		paths.root = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-eval-runner-' ) );
		fs.mkdirSync( path.join( paths.root, 'tmp' ) );
		for ( const name of [ 'TEMP', 'TMP', 'TMPDIR' ] ) {
			process.env[ name ] = path.join( paths.root, 'tmp' );
		}
		const profile = path.join( paths.root, 'profile' );
		fs.mkdirSync( path.join( profile, 'chatgpt-credentials' ), { recursive: true } );
		fs.writeFileSync(
			path.join( profile, 'shared.json' ),
			JSON.stringify( { version: 1, aiProvider: 'openai-api-key', authToken: WPCOM_LOGIN } )
		);
		fs.writeFileSync( path.join( profile, 'chatgpt-accounts.json' ), '{}' );
		broker.readFrom = [];
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
		agent.created = 0;
		imageService.configured = false;
		sites.create.mockReset().mockImplementation( async () => undefined );
		sites.remove.mockReset().mockImplementation( async () => undefined );
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
					STUDIO_EVAL_CHATGPT_PROFILE: dedicated.dir,
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
				{ STUDIO_EVAL_CONNECTION: CONNECTION_ID, STUDIO_EVAL_CHATGPT_PROFILE: dedicated.dir }
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
		[ 'profile-required', { STUDIO_EVAL_CHATGPT_PROFILE: '' } ],
		[ 'profile-in-studio-profile', { STUDIO_EVAL_CHATGPT_PROFILE: 'HOME_STUDIO' } ],
	] as Array< [ string, NodeJS.ProcessEnv ] > )(
		'refuses %s with its code, before any site, turn or model request',
		async ( code, env ) => {
			if ( env.STUDIO_EXPERIMENTAL_CHATGPT === '' ) {
				delete process.env.STUDIO_EXPERIMENTAL_CHATGPT;
			}
			// The user's own Studio profile, under a home directory of the test's.
			const studio = path.join( paths.root, 'home', '.studio' );
			fs.mkdirSync( studio, { recursive: true } );
			process.env.USERPROFILE = process.env.HOME = path.join( paths.root, 'home' );
			const result = await runEval(
				input(
					{},
					{
						STUDIO_EVAL_PROVIDER: 'chatgpt-oauth',
						STUDIO_EVAL_CONNECTION: CONNECTION_ID,
						STUDIO_EVAL_CHATGPT_PROFILE: dedicated.dir,
						STUDIO_EVAL_MODEL: 'gpt-6-luna',
						...env,
						...( env.STUDIO_EVAL_CHATGPT_PROFILE === 'HOME_STUDIO'
							? { STUDIO_EVAL_CHATGPT_PROFILE: studio }
							: {} ),
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
			expect( leftovers() ).toEqual( [] );
		}
	);

	it( 'refuses a parity case run without a provider instead of falling back to the global one', async () => {
		const result = await runEval( input( { requireProvider: true } ) );
		expect( result ).toMatchObject( { success: false, refusal: { code: 'provider-required' } } );
		expect( agent.turns ).toEqual( [] );
		expect( legacy.resolveInitialAiProvider ).not.toHaveBeenCalled();
	} );

	describe( 'what a parity case sets up and captures', () => {
		const chatGptEnv = () => ( {
			STUDIO_EVAL_PROVIDER: 'chatgpt-oauth',
			STUDIO_EVAL_CONNECTION: CONNECTION_ID,
			STUDIO_EVAL_CHATGPT_PROFILE: dedicated.dir,
			STUDIO_EVAL_MODEL: 'gpt-6-luna',
		} );

		it( 'reads the ChatGPT connection in the dedicated profile itself: nothing of it in the case profile, linked or copied', async () => {
			const seenInTurn: Array< { stateDirectory: string; caseEntries: string[] } > = [];
			agent.behavior = {
				replyProvider: 'studio-chatgpt',
				act: async () => {
					const caseDir = process.env.E2E_SHARED_CONFIG_PATH ?? '';
					seenInTurn.push( {
						stateDirectory: getChatGptStateDirectory(),
						caseEntries: fs.readdirSync( caseDir ),
					} );
				},
			};
			const result = await runEval( input( {}, chatGptEnv() ) );
			expect( result.success ).toBe( true );
			expect( broker.readFrom ).toEqual( [ dedicated.dir ] );
			expect( seenInTurn ).toHaveLength( 1 );
			expect( seenInTurn[ 0 ].stateDirectory ).toBe( dedicated.dir );
			expect( seenInTurn[ 0 ].caseEntries.filter( ( name ) => /chatgpt/i.test( name ) ) ).toEqual(
				[]
			);
			// The source profile is untouched, and nothing points into it.
			expect( fs.readdirSync( path.join( paths.root, 'profile' ) ).sort() ).toEqual( [
				'chatgpt-accounts.json',
				'chatgpt-credentials',
				'shared.json',
			] );
			expect( leftovers() ).toEqual( [] );
			expect( process.env.E2E_SHARED_CONFIG_PATH ).toBeUndefined();
			expect( process.env.E2E_CLI_CONFIG_PATH ).toBeUndefined();
		} );

		const base64url = ( value: unknown ) =>
			Buffer.from( JSON.stringify( value ) ).toString( 'base64url' );
		// Obviously fake, unsigned tokens shaped like the route's bearer.
		const fakeJwt = ( payload: Record< string, unknown > ) =>
			`${ base64url( { alg: 'none' } ) }.${ base64url( payload ) }.test-signature`;
		const claims = {
			email: 'eval-person@example.test',
			'https://api.openai.com/auth': { chatgpt_account_id: 'test-account-id' },
		};

		it.each( [
			[ 'the selected identity', fakeJwt( { sub: 'test-subject', ...claims } ), true ],
			[ 'another identity', fakeJwt( { sub: 'test-other-subject', ...claims } ), false ],
			[ 'an undecodable bearer', 'test-opaque-route-token', 'unverified' ],
		] as const )(
			'compares a bearer for %s with the selected registration in memory, and reports only the result',
			async ( _name, token, expected ) => {
				agent.behavior = {
					request: {
						url: 'https://api.openai.com/v1/responses',
						authorization: `Bearer ${ token }`,
						body: { model: 'gpt-6-luna', reasoning: { effort: 'medium' } },
					},
					replyProvider: 'studio-chatgpt',
				};
				const result = await runEval( input( {}, chatGptEnv() ) );
				expect( result.providerRoute?.executed ).toMatchObject( {
					kind: 'chatgpt-oauth',
					connectionMatchesBearer: expected,
				} );
				const text = JSON.stringify( result );
				for ( const derived of [
					token,
					'test-subject',
					'test-other-subject',
					'eval-person',
					'test-account-id',
					token.split( '.' )[ 1 ] ?? token,
					createHash( 'sha256' ).update( 'test-subject' ).digest( 'hex' ).slice( 0, 12 ),
				] ) {
					expect( text ).not.toContain( derived );
				}
			}
		);

		it( 'restores fetch and removes its temporary folders when a run fails partway, at any stage', async () => {
			agent.behavior = { replyProvider: 'studio-chatgpt' };
			// A bystander site that can't be deleted makes the run throw after its turns.
			sites.remove.mockImplementationOnce( ( () => undefined ) as never );
			await expect( runEval( input( {}, chatGptEnv() ) ) ).rejects.toThrow();
			expect( globalThis.fetch ).toBe( fetchSpy );
			expect( leftovers() ).toEqual( [] );

			// Setup failing before any turn: the bystander sites it made are deleted too.
			sites.remove.mockClear();
			sites.create
				.mockImplementationOnce( async () => undefined )
				.mockImplementationOnce( async () => undefined )
				.mockImplementationOnce( async () => {
					throw new Error( 'site create failed' );
				} );
			await expect(
				runEval( input( { seed: { activeSite: { name: 'Fails' } } }, chatGptEnv() ) )
			).rejects.toThrow( 'site create failed' );
			expect( globalThis.fetch ).toBe( fetchSpy );
			expect( leftovers() ).toEqual( [] );
			expect( sites.remove.mock.calls.length ).toBeGreaterThanOrEqual( 2 );

			// A refusal after the case's profile was made.
			const refused = await runEval( input( { imageService: 'required' }, chatGptEnv() ) );
			expect( refused ).toMatchObject( { refusal: { code: 'image-service-not-configured' } } );
			expect( leftovers() ).toEqual( [] );
			expect( globalThis.fetch ).toBe( fetchSpy );
		} );

		it( 'removes the links to Studio downloads as links, leaving what they point to', async () => {
			const downloads = path.join( paths.root, 'profile', 'server-files' );
			fs.mkdirSync( downloads );
			fs.writeFileSync( path.join( downloads, 'kept.txt' ), 'kept' );
			agent.behavior = { replyProvider: 'studio-wpcom' };
			await runEval( input() );
			expect( leftovers() ).toEqual( [] );
			expect( fs.readFileSync( path.join( downloads, 'kept.txt' ), 'utf8' ) ).toBe( 'kept' );
		} );

		it( 'records every remote operation under remote: mock, never reaching the real host', async () => {
			agent.behavior = {
				replyProvider: 'studio-wpcom',
				act: async ( { host } ) => {
					const site = {
						id: 'site-1',
						name: 'Parity Site',
						path: '/sites/parity',
						url: 'http://localhost:8881',
						phpVersion: '8.3',
					};
					await host.sync.push( site, 'all', 'https://myprod.wordpress.com', () => undefined );
					await host.previews.create( site, () => undefined );
				},
			};
			const result = await runEval( input( { remote: 'mock' } ) );
			expect( result.success ).toBe( true );
			expect( result.remoteCalls ).toEqual( [
				{
					operation: 'push',
					site: 'Parity Site',
					target: 'https://myprod.wordpress.com',
					options: 'all',
				},
				{ operation: 'preview-create', site: 'Parity Site' },
			] );
		} );

		describe( 'WordPress.com under remote: mock', () => {
			const site = 'https://public-api.wordpress.com/rest/v1.1/sites/113/posts/new';
			const images = 'https://public-api.wordpress.com/wpcom/v2/ai-api-proxy/v1/images/generations';
			const sentToNetwork = () =>
				fetchSpy.mock.calls.map(
					( [ url, init ]: [ unknown, RequestInit | undefined ] ) =>
						`${ init?.method ?? 'GET' } ${ String( url ) }`
				);

			it( 'records a write through wpcom_request instead of sending it, and the case stays green', async () => {
				agent.behavior = {
					replyProvider: 'studio-wpcom',
					act: async ( { host } ) => {
						await wpcomRequestTool.handler(
							{ siteId: 113, method: 'POST', path: '/posts', body: { title: 'Hi' } },
							{ host, onProgress: () => undefined }
						);
					},
				};
				const result = await runEval( input( { remote: 'mock' } ) );
				expect( result.success ).toBe( true );
				expect( result.remoteCalls ).toEqual( [
					{ operation: 'wpcom-request', method: 'POST', site: '113', target: '/posts' },
				] );
				expect( result.remoteGuard ).toEqual( { code: null, blocked: [] } );
				expect( sentToNetwork() ).toEqual( [] );
			} );

			it( 'fails the case with its code on a write sent around the mock, which never leaves the process', async () => {
				agent.behavior = {
					replyProvider: 'studio-wpcom',
					act: async () => {
						await fetch( site, { method: 'POST', body: '{}' } ).catch( () => undefined );
						await fetch( 'https://public-api.wordpress.com/rest/v1.1/me' );
					},
				};
				const result = await runEval( input( { remote: 'mock' } ) );
				expect( result ).toMatchObject( {
					success: false,
					error: expect.stringMatching( /^wpcom-write-under-mock/ ),
					remoteGuard: {
						code: 'wpcom-write-under-mock',
						blocked: [ { method: 'POST', host: 'wpcom', endpoint: 'other', via: 'fetch' } ],
					},
				} );
				// Reads still reach WordPress.com.
				expect( sentToNetwork() ).toEqual( [
					'GET https://public-api.wordpress.com/rest/v1.1/me',
				] );
				expect( globalThis.fetch ).toBe( fetchSpy );
			} );

			it( 'lets the image service write only in a case labelled imageService: required', async () => {
				imageService.configured = true;
				agent.behavior = {
					replyProvider: 'studio-wpcom',
					act: async () => {
						await fetch( images, { method: 'POST', body: '{}' } ).catch( () => undefined );
					},
				};
				const labelled = await runEval( input( { remote: 'mock', imageService: 'required' } ) );
				expect( labelled.remoteGuard ).toEqual( { code: null, blocked: [] } );
				expect( sentToNetwork() ).toEqual( [ `POST ${ images }` ] );

				fetchSpy.mockClear();
				const unlabelled = await runEval( input( { remote: 'mock' } ) );
				expect( unlabelled.remoteGuard ).toMatchObject( {
					code: 'wpcom-write-under-mock',
					blocked: [ { host: 'wpcom-ai-proxy', endpoint: 'images' } ],
				} );
				expect( sentToNetwork() ).toEqual( [] );
			} );

			it( 'guards every selected case, and leaves an unselected case without remote as it was', async () => {
				let fetchInTurn: unknown;
				agent.behavior = {
					replyProvider: 'studio-chatgpt',
					act: async () => {
						fetchInTurn = globalThis.fetch;
						await fetch( site, { method: 'POST' } ).catch( () => undefined );
					},
				};
				const selected = await runEval( input( {}, chatGptEnv() ) );
				expect( selected.remoteGuard ).toMatchObject( { code: 'wpcom-write-under-mock' } );
				expect( selected.remoteCalls ).toEqual( [] );

				fetchSpy.mockClear();
				const unselected = await runEval( input() );
				expect( fetchInTurn ).toBe( fetchSpy );
				expect( unselected ).not.toHaveProperty( 'remoteGuard' );
				expect( unselected ).not.toHaveProperty( 'remoteCalls' );
				expect( sentToNetwork() ).toEqual( [ `POST ${ site }` ] );
			} );
		} );

		it( 'refuses remote: staging without a designated staging site, before any site or turn', async () => {
			const result = await runEval( input( { remote: 'staging' } ) );
			expect( result ).toMatchObject( {
				success: false,
				refusal: { code: 'staging-not-designated' },
			} );
			expect( agent.turns ).toEqual( [] );
			expect( sites.create ).not.toHaveBeenCalled();
		} );

		it( 'refuses imageService: required while the image service is off', async () => {
			const result = await runEval( input( { imageService: 'required' } ) );
			expect( result ).toMatchObject( {
				success: false,
				refusal: { code: 'image-service-not-configured' },
			} );
			expect( agent.turns ).toEqual( [] );
		} );

		it( 'runs imageService: off without the WordPress.com login, and refuses when the service stays on', async () => {
			let caseShared: unknown;
			agent.behavior = {
				replyProvider: 'studio-wpcom',
				act: async () => {
					caseShared = JSON.parse(
						fs.readFileSync(
							path.join( process.env.E2E_SHARED_CONFIG_PATH ?? '', 'shared.json' ),
							'utf8'
						)
					);
				},
			};
			const result = await runEval( input( { imageService: 'off' } ) );
			expect( result.imageService ).toEqual( { configured: false } );
			expect( caseShared ).toMatchObject( { version: 1 } );
			expect( caseShared ).not.toHaveProperty( 'authToken' );

			agent.turns = [];
			imageService.configured = true;
			expect( await runEval( input( { imageService: 'off' } ) ) ).toMatchObject( {
				refusal: { code: 'image-service-still-configured' },
			} );
			expect( agent.turns ).toEqual( [] );
		} );

		it( 'attaches fixture images and documents to the first message only', async () => {
			const result = await runEval(
				input( {
					attachments: [ { fixture: 'red-swatch.png' }, { fixture: 'project-brief.md' } ],
					followUps: [ { prompt: 'And now?' } ],
				} )
			);
			const [ first, second ] = agent.turns;
			expect( first.images ).toEqual( [
				expect.objectContaining( { name: 'red-swatch.png', mimeType: 'image/png' } ),
			] );
			expect( first.prompt ).toMatch( /Attached files[\s\S]*project-brief\.md/ );
			expect( second.images ).toBeUndefined();
			expect( second.prompt ).toBe( 'And now?' );
			expect( result.attachments ).toEqual( [
				{ fixture: 'red-swatch.png', kind: 'image' },
				{ fixture: 'project-brief.md', kind: 'file' },
			] );
			expect(
				await runEval( input( { attachments: [ { fixture: 'missing.png' } ] } ) )
			).toMatchObject( { refusal: { code: 'fixture-missing' } } );
		} );

		it( 'reopens the conversation from its file for a follow-up marked reopen', async () => {
			agent.behavior = { replyProvider: 'studio-chatgpt' };
			const result = await runEval(
				input( { followUps: [ { prompt: 'What was it?', reopen: true } ] }, chatGptEnv() )
			);
			const [ first, second ] = agent.turns;
			expect( second.session ).not.toBe( first.session );
			expect( ( second.session as SessionManager ).getSessionFile() ).toBe(
				( first.session as SessionManager ).getSessionFile()
			);
			expect( agent.created ).toBe( 2 );
			expect( result.turns?.map( ( turn ) => turn.reopened ) ).toEqual( [ false, true ] );
			// The reopened conversation still names its connection before the turn.
			expect( JSON.stringify( second.entriesAtStart ) ).toContain( 'studio.session_context' );
		} );

		it( 'goes on after a stop only with resumeAfterStop', async () => {
			const stopAt = [ { tool: 'wp_cli', input: { command: '^post create' } } ];
			agent.behavior = {
				replyProvider: 'studio-wpcom',
				toolCalls: [ { name: 'wp_cli', arguments: { command: 'post create --post_title=A' } } ],
			};
			const stopped = await runEval(
				input( { stopAt, followUps: [ { prompt: 'Never mind. Reply STOPPED.' } ] } )
			);
			expect( stopped.stoppedAt ).toMatchObject( { toolName: 'wp_cli', index: 0 } );
			expect( agent.turns ).toHaveLength( 1 );

			agent.turns = [];
			const resumed = await runEval(
				input( {
					stopAt,
					resumeAfterStop: true,
					followUps: [ { prompt: 'Never mind. Reply STOPPED.' } ],
				} )
			);
			expect( resumed.stoppedAt ).toMatchObject( { toolName: 'wp_cli' } );
			expect( agent.turns ).toHaveLength( 2 );
			expect( resumed.turns?.[ 1 ] ).toMatchObject( { toolCallsStart: 1 } );
		} );

		it( 'answers @first with the first option of the question', async () => {
			agent.behavior = {
				replyProvider: 'studio-wpcom',
				act: async ( { config } ) => {
					await config.onAskUser?.( [
						{
							question: 'Which direction?',
							options: [
								{ label: 'Warm and rustic', description: '' },
								{ label: 'Cool and minimal', description: '' },
							],
						},
					] );
				},
			};
			const result = await runEval( input( { answers: [ { label: '@first' } ] } ) );
			expect( result.questions ).toEqual( [
				expect.objectContaining( { answer: 'Warm and rustic' } ),
			] );
		} );

		it( 'seeds history as replies on the selected route, and refuses it without a selection', async () => {
			const history = [
				{ role: 'user', text: 'The codename is AURORA-7.' },
				{ role: 'assistant', text: 'Noted.', contextTokens: 190000 },
			];
			agent.behavior = { replyProvider: 'studio-chatgpt' };
			await runEval( input( { seed: { history } }, chatGptEnv() ) );
			const entries = JSON.stringify( agent.turns[ 0 ].entriesAtStart );
			expect( entries ).toContain( 'AURORA-7' );
			expect( entries ).toContain( '"provider":"studio-chatgpt"' );
			expect( entries ).toContain( '"input":190000' );

			agent.turns = [];
			expect( await runEval( input( { seed: { history } } ) ) ).toMatchObject( {
				refusal: { code: 'history-needs-provider' },
			} );
			expect( agent.turns ).toEqual( [] );
		} );

		it( 'records what the turn showed the Studio UI, its turns and its compactions', async () => {
			agent.behavior = {
				replyProvider: 'studio-wpcom',
				act: async ( { config, host } ) => {
					await host.ui?.showArtifact( {
						version: 1,
						id: 'artifact-1',
						widgets: [ { type: 'media', widgetProps: { src: 'x' } } ],
					} );
					host.ui?.reloadPreview();
					( config.session as SessionManager ).appendCompaction( 'Summary.', null, 190000 );
				},
			};
			const result = await runEval( input( { ui: true } ) );
			expect( result.uiEvents ).toEqual( {
				artifacts: [ { id: 'artifact-1', widgets: [ 'media' ] } ],
				previewReloads: 1,
			} );
			expect( result.compactions ).toBe( 1 );
			expect( result.turns ).toEqual( [
				expect.objectContaining( {
					reopened: false,
					toolCallsStart: 0,
					textSegmentsStart: 0,
					questionsStart: 0,
				} ),
			] );
		} );
	} );
} );
