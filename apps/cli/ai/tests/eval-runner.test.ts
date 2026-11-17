// @vitest-environment node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getChatGptStateDirectory } from '@studio/agent/node/chatgpt/state-directory';
import { wpcomRequestTool } from '@studio/agent/node/tools/wpcom-request';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { findUnsafeRecord, openAcceptanceEvidence } from 'cli/ai/acceptance-evidence';
import { isolateCaseProfile } from 'cli/ai/eval-case-profile';
import { evalConnectionRef } from 'cli/ai/eval-provider';
import { readEvalRunnerInput, runEval as runCase, writeCaseSummary } from 'cli/ai/eval-runner';
import { cliAgentHost } from 'cli/ai/host';
import type { AgentSessionEvent, SessionManager } from '@earendil-works/pi-coding-agent';
import type { StudioAgentHost } from '@studio/agent/node/host';
import type { StudioAgentTurnConfig } from '@studio/agent/node/runtime';
import type { ConnectionRegistryEntry } from '@studio/agent/protocol/connections';

// Test values only; nothing here reaches a model provider or a site.
const CONNECTION_ID = '7c1e8a41-6d3b-4c55-9b8e-3f2d7c1eb2f0';
const API_KEY = 'sk-proj-TESTONLY_eval_runner_bbbbbbbbbbbbbbbbbbbbbb';
const WPCOM_LOGIN = {
	accessToken: 'test-wpcom-token',
	expiresIn: 3600,
	expirationTime: Date.now() + 3_600_000,
	id: 1,
	displayName: 'Test',
	email: '',
};

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

// This file loads the runner once for many cases, so the paths modules fix when
// they load can't name each case's folders: these stand in for them, named in
// the case's own profile and process manager home, as the runner's entry gives
// them. eval-runner-isolation.test.ts starts each case from the entry, with the
// real ones.
vi.mock( 'cli/ai/eval-fixed-paths', () => ( {
	pathsFixedAtLoad: () => {
		const profile = process.env.DEV_CONFIG_DIR ?? '';
		return {
			payloadDescriptions: [ `stored in ${ path.join( profile, 'tmp', 'ai-payloads' ) }` ],
			rootCaCertificate: path.join( profile, 'certificates', 'studio-ca.crt' ),
			processManagerHome: process.env.STUDIO_PROCESS_MANAGER_HOME ?? '',
		};
	},
} ) );

const removal = vi.hoisted( () => ( { failObserverFile: false } ) );
vi.mock( 'node:fs/promises', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('node:fs/promises') >();
	return {
		...actual,
		rm: async (
			target: Parameters< typeof actual.rm >[ 0 ],
			options?: Parameters< typeof actual.rm >[ 1 ]
		) => {
			if ( removal.failObserverFile && String( target ).includes( 'studio-eval-requests-' ) ) {
				throw new Error( 'observer file is held open' );
			}
			return actual.rm( target, options );
		},
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
// The account's WordPress.com sites as the sites endpoint lists them, and the
// connections a case seeds: nothing here reaches WordPress.com.
const wpcom = vi.hoisted( () => ( {
	sites: vi.fn(),
	connected: [] as Array< { localSiteId: string; site: Record< string, unknown > } >,
} ) );
vi.mock( '@studio/common/lib/sync/sync-api', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/common/lib/sync/sync-api') >() ),
	fetchSyncableSites: wpcom.sites,
} ) );
vi.mock( '@studio/common/lib/connected-sites', () => ( {
	addConnectedWpcomSite: async ( localSiteId: string, site: Record< string, unknown > ) => {
		wpcom.connected.push( { localSiteId, site } );
		return [];
	},
} ) );
vi.mock( 'cli/lib/cli-config/sites', () => ( {
	getSiteByFolder: async ( folder: string ) => ( { id: 'seeded-site', path: folder } ),
} ) );

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

// The ChatGPT route's capability table, as a test sets it: whether its model
// takes images in tool results.
const table = vi.hoisted( () => ( { toolImages: false } ) );
vi.mock( '@studio/agent/protocol/chatgpt-models', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/agent/protocol/chatgpt-models') >();
	return {
		...actual,
		getChatGptModelCapabilities: ( slug: string ) => {
			const capabilities = actual.getChatGptModelCapabilities( slug );
			return capabilities && { ...capabilities, toolImageInput: table.toolImages };
		},
	};
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
	remoteGuard?: { code: string | null; blocked: unknown[]; allowed?: unknown[] };
	imageService?: { configured: boolean };
	attachments?: unknown[];
	turns?: Array< Record< string, unknown > >;
	questions?: Array< { answer: string } >;
	uiEvents?: { artifacts: unknown[]; previewReloads: number };
	compactions?: number;
}
// The environment the runner's entry sets up for a case, before and after the case ran.
const ENTRY_ENVIRONMENT = [
	'E2E',
	'E2E_CLI_CONFIG_PATH',
	'E2E_SHARED_CONFIG_PATH',
	'DEV_CONFIG_DIR',
	'STUDIO_PROCESS_MANAGER_HOME',
] as const;
const environment = () =>
	Object.fromEntries( ENTRY_ENVIRONMENT.map( ( name ) => [ name, process.env[ name ] ] ) );
const lastCase = {
	prepared: {} as Record< string, unknown >,
	after: {} as Record< string, unknown >,
};

// Runs a case as its own `eval-runner.mjs` process would: the entry first makes
// the case's profile and registry from the test's source profile, and, for a
// case that names a provider, its own process manager home; the environment is
// then as the process started, as the next case's process starts.
async function runEvalUntyped( given: Parameters< typeof runCase >[ 0 ] ) {
	const startedWith = environment();
	for ( const name of ENTRY_ENVIRONMENT ) {
		delete process.env[ name ];
	}
	process.env.DEV_CONFIG_DIR = path.join( paths.root, 'profile' );
	isolateCaseProfile( process.env );
	if ( given.provider?.ok ) {
		process.env.STUDIO_PROCESS_MANAGER_HOME = fs.realpathSync(
			fs.mkdtempSync( path.join( os.tmpdir(), 'studio-eval-daemon-' ) )
		);
	}
	lastCase.prepared = environment();
	try {
		return await runCase( given );
	} finally {
		lastCase.after = environment();
		for ( const [ name, value ] of Object.entries( startedWith ) ) {
			if ( value === undefined ) {
				delete process.env[ name ];
			} else {
				process.env[ name ] = value;
			}
		}
	}
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
		wpcom.sites.mockReset().mockResolvedValue( [] );
		wpcom.connected = [];
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

	it( 'keeps an unselected result as its readers know it: every field and timing as before, new fields only added', async () => {
		const result = ( await runEvalUntyped( input( { model: 'gpt-6-luna' } ) ) ) as Record<
			string,
			unknown
		>;
		const beforeG4a = [
			'success',
			'error',
			'timedOut',
			'stoppedAt',
			'model',
			'numTurns',
			'stopReason',
			'errorMessage',
			'usage',
			'sessionFile',
			'phaseTimingsMs',
			'timing',
			'requests',
			'turnDurationsMs',
			'toolCalls',
			'toolResults',
			'toolEvents',
			'firstToolError',
			'textSegments',
			'questions',
			'inspections',
			'outcome',
		];
		const added = [ 'turns', 'compactions' ];
		expect( Object.keys( result ).sort() ).toEqual( [ ...beforeG4a, ...added ].sort() );
		expect( Object.keys( result.phaseTimingsMs as object ).sort() ).toEqual( [
			'first_assistant_message_ms',
			'resolve_ai_environment_ms',
			'resolve_initial_provider_ms',
			'resolve_unavailable_provider_ms',
			'start_ai_agent_ms',
			'total_eval_ms',
		] );
		expect( result ).toMatchObject( { success: true, model: 'gpt-6-luna', error: null } );
	} );

	it( 'resolves an unavailable global provider as before: its replacement, or the global one', async () => {
		legacy.resolveUnavailableAiProvider.mockResolvedValue( 'wpcom' );
		await runEval( input() );
		expect( legacy.resolveUnavailableAiProvider ).toHaveBeenCalledWith( 'openai-api-key' );
		expect( legacy.resolveAiEnvironment ).toHaveBeenCalledWith( 'wpcom' );

		legacy.resolveAiEnvironment.mockClear();
		legacy.resolveUnavailableAiProvider.mockResolvedValue( undefined );
		await runEval( input() );
		expect( legacy.resolveAiEnvironment ).toHaveBeenCalledWith( 'openai-api-key' );
		expect( broker.setTokenClient ).not.toHaveBeenCalled();
		expect( broker.readFrom ).toEqual( [] );
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
			expect( lastCase.after ).toEqual( lastCase.prepared );
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

		it( 'writes a provider-qualified case’s sanitized summary, and none for a case that selects no provider', async () => {
			agent.behavior = {
				request: {
					url: 'https://api.openai.com/v1/responses',
					authorization: `Bearer ${ fakeJwt( { sub: 'test-subject', ...claims } ) }`,
					body: { model: 'gpt-6-luna', reasoning: { effort: 'medium' } },
				},
				replyProvider: 'studio-chatgpt',
			};
			const summaries = path.join( paths.root, 'summaries' );
			const facts = () => ( {
				source: { sha: '0123456789abcdef0123456789abcdef01234567', dirty: false },
				platform: { os: 'linux', release: null, arch: 'x64' },
				runtime: { node: '24.22.1', npm: null },
				build: { cliVersion: '0.0.0', buildId: null },
			} );
			const selected = input( { caseId: 'parity-identity' }, chatGptEnv() );
			const written = writeCaseSummary( selected, await runEvalUntyped( selected ), {
				env: { STUDIO_EVAL_SUMMARY_DIR: summaries },
				facts,
			} );
			const runDirectory = path.join( summaries, 'chatgpt-oauth', 'parity-identity' );
			expect( written?.location ).toEqual( {
				directory: runDirectory,
				run: 1,
				stage: 'parity-identity',
			} );
			expect( written?.record ).toMatchObject( {
				run: 1,
				scenario: 'eval-route-chatgpt-oauth',
				stage: 'parity-identity',
				status: 'passed',
				observations: {
					judgesCaseChecks: false,
					everyCheckRecorded: false,
					modelRequests: 1,
					bearerMatches: true,
					guardRefused: 0,
				},
			} );
			expect( findUnsafeRecord( written?.record ) ).toBeNull();
			expect(
				openAcceptanceEvidence( runDirectory, 'chatgpt-oauth' ).readManifest()?.runs[ 0 ]
			).toMatchObject( { model: 'gpt-6-luna', effort: 'medium', source: facts().source } );
			for ( const file of fs.readdirSync( runDirectory ) ) {
				const text = fs.readFileSync( path.join( runDirectory, file ), 'utf8' );
				for ( const value of [ CONNECTION_ID, 'test-subject', 'eval-person', paths.root ] ) {
					expect( text ).not.toContain( value );
				}
			}

			// The var a configuration sets when every one of its checks writes a record.
			const declared = input(
				{ caseId: 'parity-identity', everyCheckRecorded: true },
				chatGptEnv()
			);
			expect(
				writeCaseSummary( declared, await runEvalUntyped( declared ), {
					env: { STUDIO_EVAL_SUMMARY_DIR: summaries },
					facts,
				} )?.record.observations
			).toMatchObject( { everyCheckRecorded: true } );

			// A run that threw: the runner's main writes it with what it caught.
			expect(
				writeCaseSummary(
					selected,
					{ success: false, error: 'it threw' },
					{ env: { STUDIO_EVAL_SUMMARY_DIR: summaries }, threw: true, facts }
				)?.record
			).toMatchObject( { run: 3, status: 'failed', code: 'run-failed' } );

			const elsewhere = path.join( paths.root, 'no-summaries' );
			const unselected = input( { caseId: 'identity' } );
			expect(
				writeCaseSummary( unselected, await runEvalUntyped( unselected ), {
					env: { STUDIO_EVAL_SUMMARY_DIR: elsewhere },
					facts,
				} )
			).toBeNull();
			expect( fs.existsSync( elsewhere ) ).toBe( false );
		} );

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

		it( 'still restores the environment and removes the case folders when removing the observer file throws', async () => {
			agent.behavior = { replyProvider: 'studio-chatgpt' };
			const stderr = vi.spyOn( process.stderr, 'write' ).mockImplementation( () => true );
			removal.failObserverFile = true;
			let result: unknown;
			try {
				result = await runEval( input( {}, chatGptEnv() ) );
			} finally {
				removal.failObserverFile = false;
			}
			const warned = stderr.mock.calls.map( ( call ) => String( call[ 0 ] ) ).join( '' );
			stderr.mockRestore();
			expect( result ).not.toHaveProperty( 'refusal' );
			expect( warned ).toMatch( /studio-eval warning: could not remove the request observer file/ );
			expect( lastCase.after ).toEqual( lastCase.prepared );
			expect(
				fs
					.readdirSync( path.join( paths.root, 'tmp' ) )
					.filter( ( name ) => /^studio-eval-(config|registry)-/.test( name ) )
			).toEqual( [] );
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
			expect( wpcom.sites ).not.toHaveBeenCalled();
		} );

		describe( 'a designated staging site', () => {
			const designated = {
				STUDIO_EVAL_STAGING_SITE_ID: '4242',
				STUDIO_EVAL_STAGING_SITE_URL: 'https://staging-4242.wpcomstaging.com',
			};
			const listed = ( overrides: Record< string, unknown > = {} ) => ( {
				id: 4242,
				localSiteId: '',
				name: 'Parity staging',
				url: 'https://staging-4242.wpcomstaging.com/',
				isStaging: true,
				isPressable: false,
				environmentType: 'staging',
				syncSupport: 'syncable',
				lastPullTimestamp: null,
				lastPushTimestamp: null,
				...overrides,
			} );
			const stagingCase = () =>
				input( { remote: 'staging', seed: { activeSite: { name: 'Parity Staging Source' } } } );

			it.each( [
				[ 'is not among the account’s sites', [ listed( { id: 9 } ) ] ],
				[ 'WordPress.com does not list as a staging site', [ listed( { isStaging: false } ) ] ],
				[ 'has another address', [ listed( { url: 'https://myprod.wordpress.com' } ) ] ],
			] )( 'is refused when the site %s, before any site or turn', async ( _name, sitesList ) => {
				Object.assign( process.env, designated );
				wpcom.sites.mockResolvedValue( sitesList );
				expect( await runEval( stagingCase() ) ).toMatchObject( {
					success: false,
					refusal: { code: 'staging-not-confirmed' },
				} );
				expect( wpcom.sites ).toHaveBeenCalledWith( 'test-wpcom-token' );
				expect( agent.turns ).toEqual( [] );
				expect( sites.create ).not.toHaveBeenCalled();
			} );

			it( 'is refused when WordPress.com can’t be asked', async () => {
				Object.assign( process.env, designated );
				wpcom.sites.mockRejectedValue( new Error( 'offline' ) );
				expect( await runEval( stagingCase() ) ).toMatchObject( {
					refusal: { code: 'staging-not-confirmed' },
				} );
				expect( agent.turns ).toEqual( [] );
			} );

			it( 'runs connected to the site as WordPress.com lists it, with the write guard on', async () => {
				Object.assign( process.env, designated );
				wpcom.sites.mockResolvedValue( [ listed() ] );
				agent.behavior = { replyProvider: 'studio-wpcom' };
				const result = await runEval( stagingCase() );
				expect( result.success ).toBe( true );
				expect( result.remoteCalls ).toEqual( [] );
				expect( result.remoteGuard ).toEqual( { code: null, blocked: [], allowed: [] } );
				expect( wpcom.connected ).toEqual( [
					{
						localSiteId: 'seeded-site',
						site: expect.objectContaining( {
							id: 4242,
							isStaging: true,
							url: 'https://staging-4242.wpcomstaging.com/',
							syncSupport: 'already-connected',
						} ),
					},
				] );
			} );

			const pushSite = {
				id: 'site-1',
				name: 'Parity Staging Source',
				path: '/sites/parity',
				url: 'http://localhost:8881',
				phpVersion: '8.3',
			};
			const sentToNetwork = () =>
				fetchSpy.mock.calls.map(
					( [ url, init ]: [ unknown, RequestInit | undefined ] ) =>
						`${ init?.method ?? 'GET' } ${ String( url ) }`
				);

			it.each( [
				[
					'through wpcom_request',
					async ( host: StudioAgentHost ) => {
						await wpcomRequestTool
							.handler(
								{ siteId: 113, method: 'POST', path: '/posts', body: { title: 'Hi' } },
								{ host, onProgress: () => undefined }
							)
							.catch( () => undefined );
					},
				],
				[
					'through a raw request',
					async () => {
						await fetch( 'https://public-api.wordpress.com/rest/v1.1/sites/113/posts/new', {
							method: 'POST',
						} ).catch( () => undefined );
					},
				],
				[
					'through a push with another remote',
					async ( host: StudioAgentHost ) => {
						await host.sync
							.push( pushSite, 'all', 'https://myprod.wordpress.com', () => undefined )
							.catch( () => undefined );
					},
				],
			] )(
				'refuses a write to another site of the account %s, and fails the case',
				async ( _channel, write ) => {
					Object.assign( process.env, designated );
					wpcom.sites.mockResolvedValue( [ listed() ] );
					agent.behavior = { replyProvider: 'studio-wpcom', act: ( { host } ) => write( host ) };
					const result = await runEval( stagingCase() );
					expect( result ).toMatchObject( {
						success: false,
						error: expect.stringMatching( /^wpcom-write-outside-staging/ ),
						remoteGuard: {
							code: 'wpcom-write-outside-staging',
							blocked: [ expect.objectContaining( { code: 'wpcom-write-outside-staging' } ) ],
							allowed: [],
						},
					} );
					expect(
						sentToNetwork().filter( ( sent: string ) => ! sent.startsWith( 'GET' ) )
					).toEqual( [] );
					expect( cliAgentHost.sync.push ).not.toHaveBeenCalled();
					expect( JSON.stringify( result.remoteGuard ) ).not.toMatch( /113|myprod|public-api/ );
				}
			);

			const api = 'https://public-api.wordpress.com';
			// The real tool's transport, sending to the address WordPress.com's client
			// composes, through fetch: the spied fetch never sends anything.
			const transport = vi.fn(
				async ( args: { siteId: number; method: string; path: string; apiNamespace?: string } ) => {
					const namespace = args.apiNamespace ?? 'wp/v2';
					await fetch(
						`${ api }/${ namespace || 'rest/v1.1' }/sites/${ args.siteId }${ args.path }`,
						{
							method: args.method,
						}
					);
					return { content: [ { type: 'text' as const, text: '{}' } ], details: {} };
				}
			);
			async function runWithTransport( act: FakeTurnBehavior[ 'act' ] ) {
				const original = wpcomRequestTool.handler;
				transport.mockClear();
				wpcomRequestTool.handler = transport as unknown as typeof wpcomRequestTool.handler;
				agent.behavior = { replyProvider: 'studio-wpcom', act };
				try {
					return await runEval( stagingCase() );
				} finally {
					wpcomRequestTool.handler = original;
				}
			}

			it.each( [
				[
					'a reblog onto another site',
					{ path: '/posts/7/reblogs/new', apiNamespace: '', body: { destination_site_id: 113 } },
				],
				[ 'a follow', { path: '/follows/new', apiNamespace: '' } ],
				[ 'a like', { path: '/posts/7/likes/new', apiNamespace: '' } ],
			] )(
				'refuses %s addressed through the staging site before it is sent, and fails the case',
				async ( _name, request ) => {
					Object.assign( process.env, designated );
					wpcom.sites.mockResolvedValue( [ listed() ] );
					const result = await runWithTransport( async ( { host } ) => {
						await wpcomRequestTool
							.handler(
								{ siteId: 4242, method: 'POST', ...request },
								{ host, onProgress: () => undefined }
							)
							.catch( () => undefined );
						await fetch( `${ api }/rest/v1.1/sites/4242${ request.path }`, {
							method: 'POST',
						} ).catch( () => undefined );
					} );
					expect( result ).toMatchObject( {
						success: false,
						error: expect.stringMatching( /^wpcom-write-outside-staging/ ),
						remoteGuard: {
							code: 'wpcom-write-outside-staging',
							blocked: [
								expect.objectContaining( { via: 'fetch' } ),
								expect.objectContaining( { via: 'fetch' } ),
							],
							allowed: [],
						},
					} );
					expect( result.remoteCalls ).toEqual( [
						expect.objectContaining( { operation: 'wpcom-request', designated: false } ),
					] );
					expect( transport ).toHaveBeenCalledTimes( 1 );
					expect(
						sentToNetwork().filter( ( sent: string ) => ! sent.startsWith( 'GET' ) )
					).toEqual( [] );
				}
			);

			it( 'lets the push’s two requests and a wp/v2 write to the designated site through, and records them', async () => {
				Object.assign( process.env, designated );
				wpcom.sites.mockResolvedValue( [ listed() ] );
				const upload = `${ api }/rest/v1.1/studio-file-uploads/4242`;
				const importArchive = `${ api }/wpcom/v2/sites/4242/studio-app/sync/import/initiate`;
				vi.mocked( cliAgentHost.sync.push ).mockImplementationOnce( async () => {
					// As the push sends them: the archive's upload, then its import.
					await fetch( upload, { method: 'POST' } );
					await fetch( importArchive, { method: 'POST' } );
					return listed() as never;
				} );
				const result = await runWithTransport( async ( { host } ) => {
					await wpcomRequestTool.handler(
						{ siteId: 4242, method: 'POST', path: '/posts/7', body: { title: 'Hi' } },
						{ host, onProgress: () => undefined }
					);
					await host.sync.push( pushSite, 'all', '4242', () => undefined );
				} );
				expect( result ).toMatchObject( {
					success: true,
					remoteGuard: {
						code: null,
						blocked: [],
						allowed: [
							{ method: 'POST', via: 'fetch' },
							{ method: 'POST', via: 'fetch' },
							{ method: 'POST', via: 'fetch' },
						],
					},
				} );
				expect( result.remoteCalls ).toEqual( [
					expect.objectContaining( { operation: 'wpcom-request', designated: true } ),
					expect.objectContaining( { operation: 'push', designated: true } ),
				] );
				expect( cliAgentHost.sync.push ).toHaveBeenCalledTimes( 1 );
				expect( sentToNetwork() ).toEqual( [
					`POST ${ api }/wp/v2/sites/4242/posts/7`,
					`POST ${ upload }`,
					`POST ${ importArchive }`,
				] );
			} );
		} );

		describe( 'a case judged on images a tool returns to the model', () => {
			afterEach( () => {
				table.toolImages = false;
			} );

			it( 'is blocked on the ChatGPT route while its capability table leaves tool images off, before any site or turn', async () => {
				agent.behavior = { replyProvider: 'studio-chatgpt' };
				const result = ( await runEvalUntyped(
					input( { needsToolImages: true }, chatGptEnv() )
				) ) as RunReport & { blocked?: { code: string; message: string } };
				expect( result ).toMatchObject( {
					success: false,
					blocked: { code: 'tool-images-not-qualified' },
					providerRoute: {
						requested: { kind: 'chatgpt-oauth', model: 'gpt-6-luna' },
						blocked: { code: 'tool-images-not-qualified' },
					},
				} );
				expect( result ).not.toHaveProperty( 'refusal' );
				expect( agent.turns ).toEqual( [] );
				expect( sites.create ).not.toHaveBeenCalled();
				expect( fetchSpy ).not.toHaveBeenCalled();
				expect( leftovers() ).toEqual( [] );
			} );

			it( 'runs on the ChatGPT route once the table says its model takes tool images', async () => {
				table.toolImages = true;
				agent.behavior = { replyProvider: 'studio-chatgpt' };
				const result = ( await runEvalUntyped(
					input( { needsToolImages: true }, chatGptEnv() )
				) ) as RunReport & { blocked?: unknown };
				expect( result.blocked ).toBeUndefined();
				expect( result.success ).toBe( true );
				expect( agent.turns ).toHaveLength( 1 );
			} );

			it( 'runs as before on a route the table does not cover, and without the var', async () => {
				agent.behavior = { replyProvider: 'studio-wpcom' };
				expect( await runEval( input( { needsToolImages: true } ) ) ).not.toHaveProperty(
					'blocked'
				);
				agent.behavior = { replyProvider: 'studio-chatgpt' };
				expect( await runEval( input( {}, chatGptEnv() ) ) ).not.toHaveProperty( 'blocked' );
				expect( agent.turns ).toHaveLength( 2 );
			} );
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

		it( 'runs imageService: unused with the WordPress.com login kept, and fails the case if an image is made', async () => {
			imageService.configured = true;
			const images = 'https://public-api.wordpress.com/wpcom/v2/ai-api-proxy/v1/images/generations';
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
					await fetch( images, { method: 'POST', body: '{}' } ).catch( () => undefined );
				},
			};
			const result = await runEval( input( { remote: 'mock', imageService: 'unused' } ) );
			expect( result.refusal ).toBeUndefined();
			expect( caseShared ).toHaveProperty( 'authToken' );
			expect( result.remoteGuard ).toMatchObject( {
				code: 'wpcom-write-under-mock',
				blocked: [ { host: 'wpcom-ai-proxy', endpoint: 'images' } ],
			} );
			expect( result.imageService ).toEqual( { configured: true } );
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
