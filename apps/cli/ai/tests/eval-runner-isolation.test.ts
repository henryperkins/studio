// @vitest-environment node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { StudioAgentHost } from '@studio/agent/node/host';
import type { StudioAgentTurnConfig } from '@studio/agent/node/runtime';
import type { ConnectionRegistryEntry } from '@studio/agent/protocol/connections';

// Each case of a run reads the Studio profile the eval process starts with (the
// source: `DEV_CONFIG_DIR`, or `~/.studio`) and keeps everything it writes in a
// temporary profile of its own, which the runner's entry sets up before the
// runner, or any module it loads, is imported. These tests start each case from
// the entry, as `eval-runner.mjs` does, against a source profile in a scratch
// folder, with the real path helpers and the modules that fix a path when they
// load, and check that no file in the source changed. Nothing here reaches a
// model provider, WordPress.com, a real site or the system's trust store.

const CONNECTION_ID = '0d5e7a41-6d3b-4c55-9b8e-3f2d7c1eb2f0';
const WPCOM_LOGIN = {
	accessToken: 'test-wpcom-token',
	expiresIn: 3600,
	expirationTime: Date.now() + 3_600_000,
	id: 7,
	displayName: 'Test',
	email: '',
};

vi.mock( 'cli/lib/site-paths', async () => {
	const nodeOs = await import( 'node:os' );
	const nodePath = await import( 'node:path' );
	return {
		STUDIO_SITES_ROOT: nodePath.join( nodeOs.tmpdir(), 'studio-eval-isolation-test-sites-unused' ),
		getDefaultSitePath: ( name: string ) => name,
	};
} );
vi.mock( 'cli/ai/auth', () => ( {
	resolveInitialAiProvider: vi.fn(),
	resolveUnavailableAiProvider: vi.fn(),
	resolveAiEnvironment: vi.fn(),
} ) );
const sites = vi.hoisted( () => ( { create: [] as string[] } ) );
vi.mock( 'cli/commands/site/create', () => ( {
	runCommand: vi.fn( async ( sitePath: string ) => {
		sites.create.push( sitePath );
	} ),
} ) );
vi.mock( 'cli/lib/cli-config/sites', () => ( {
	getSiteByFolder: async ( folder: string ) => ( { id: 'seeded-site', path: folder } ),
} ) );
vi.mock( '@studio/common/lib/sync/sync-api', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/common/lib/sync/sync-api') >() ),
	fetchSyncableSites: vi.fn( async () => {
		throw new Error( 'reached WordPress.com' );
	} ),
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
// A fresh module registry for each case, as each `eval-runner.mjs` process
// has. A mocked module outlives `vi.resetModules()`, so the two mocks that load
// a module fixing a path are registered again each time: the certificate
// modules as they are, except that nothing is ever added to, or read from, the
// system's trust store; and the site delete command, which loads the
// certificate manager, as the real one does.
function freshModules() {
	vi.resetModules();
	vi.doMock( '@studio/common/lib/root-ca-trust', async ( importOriginal ) => ( {
		...( await importOriginal< typeof import('@studio/common/lib/root-ca-trust') >() ),
		trustRootCA: vi.fn( async () => undefined ),
		isRootCATrusted: vi.fn( async () => true ),
		hasUntrustedRootCA: vi.fn( async () => false ),
	} ) );
	vi.doMock( 'cli/commands/site/delete', async () => {
		await import( 'cli/lib/certificate-manager' );
		return { runCommand: vi.fn( async () => undefined ) };
	} );
}

// The WordPress.com client records what it would send: nothing leaves the machine.
const transport = vi.hoisted( () => ( {
	sent: [] as Array< { method: string; path: string; body?: Record< string, unknown > } >,
} ) );
vi.mock( '@studio/common/lib/wpcom-factory', () => {
	const send =
		( method: string ) =>
		async ( requestPath: string, _query?: unknown, body?: Record< string, unknown > ) => {
			transport.sent.push( { method, path: requestPath, body } );
			return {};
		};
	return {
		default: () => ( {
			req: { get: send( 'GET' ), post: send( 'POST' ), put: send( 'PUT' ), del: send( 'DELETE' ) },
		} ),
	};
} );
vi.mock( '@studio/common/lib/wpcom-xhr-request-factory', () => ( {
	default: () => {
		throw new Error( 'reached WordPress.com' );
	},
} ) );

const broker = vi.hoisted( () => ( { connections: [] as ConnectionRegistryEntry[] } ) );
vi.mock( '@studio/agent/node/chatgpt/credential-broker', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/agent/node/chatgpt/credential-broker') >() ),
	listChatGptConnections: async () => broker.connections,
	setChatGptTokenClient: vi.fn(),
} ) );

// The agent the runner drives: each turn does what `act` says with the real
// config helpers, then replies on the ChatGPT route.
const agent = vi.hoisted( () => ( {
	act: null as null | ( ( turn: { host: StudioAgentHost } ) => Promise< void > ),
	turns: 0,
} ) );
vi.mock( '@studio/agent/node', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/agent/node') >();
	return {
		...actual,
		createAgent: ( { host }: { host: StudioAgentHost } ) => ( {
			runTurn: ( config: StudioAgentTurnConfig ) => {
				agent.turns += 1;
				const result = ( async () => {
					await agent.act?.( { host } );
					const message = {
						role: 'assistant',
						content: [ { type: 'text', text: 'READY' } ],
						api: 'openai-responses',
						provider: 'studio-chatgpt',
						model: 'studio-chatgpt:gpt-6-luna',
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

type WpcomHandler =
	( typeof import('@studio/agent/node/tools/wpcom-request') )[ 'wpcomRequestTool' ][ 'handler' ];

// What the stand-in for the runner's `main` saw: the real `wpcom_request`
// handler before the case wrapped it, and the case's result.
const harness = vi.hoisted( () => ( {
	done: false,
	result: undefined as unknown,
	error: undefined as unknown,
	wpcomHandler: null as WpcomHandler | null,
} ) );

const parityCases = (
	parse(
		fs.readFileSync(
			path.resolve(
				import.meta.dirname,
				'../../../../scripts/eval/subscription-parity.config.yaml'
			),
			'utf8'
		)
	) as {
		defaultTest: { vars: Record< string, unknown > };
		tests: Array< { vars: Record< string, unknown > } >;
	}
 ).tests;
const parityCase = ( caseId: string ) => {
	const found = parityCases.find( ( test ) => test.vars.caseId === caseId );
	if ( ! found ) {
		throw new Error( `no parity case ${ caseId }` );
	}
	return { requireProvider: true, remote: 'mock', ...found.vars };
};
const argvFor = ( vars: Record< string, unknown > ) => [
	'node',
	'eval-runner.mjs',
	String( vars.prompt ),
	'',
	JSON.stringify( { vars } ),
];

// Every file and folder under `dir`, with each file's hash and each link's target.
function snapshot( dir: string ): Record< string, string > {
	const found: Record< string, string > = {};
	const walk = ( folder: string, relative: string ) => {
		for ( const entry of fs.readdirSync( folder, { withFileTypes: true } ) ) {
			const full = path.join( folder, entry.name );
			const name = relative ? `${ relative }/${ entry.name }` : entry.name;
			if ( entry.isSymbolicLink() ) {
				found[ name ] = `link ${ fs.readlinkSync( full ) }`;
			} else if ( entry.isDirectory() ) {
				found[ `${ name }/` ] = 'folder';
				walk( full, name );
			} else {
				found[ name ] = createHash( 'sha256' ).update( fs.readFileSync( full ) ).digest( 'hex' );
			}
		}
	};
	walk( dir, '' );
	return found;
}

// Every file of the source as it was, and anything new only under a linked download cache.
function expectSourceKept( before: Record< string, string >, after: Record< string, string > ) {
	for ( const [ name, hash ] of Object.entries( before ) ) {
		expect( after[ name ], name ).toBe( hash );
	}
	const added = Object.keys( after ).filter( ( name ) => ! ( name in before ) );
	for ( const name of added ) {
		expect( name ).toMatch( /^(server-files|php-bin|import-runtime)\// );
	}
	return added;
}

function makeSourceProfile( dir: string ): void {
	fs.mkdirSync( path.join( dir, 'knowledge' ), { recursive: true } );
	fs.writeFileSync(
		path.join( dir, 'shared.json' ),
		JSON.stringify( { version: 1, aiProvider: 'wpcom', authToken: WPCOM_LOGIN } )
	);
	fs.writeFileSync(
		path.join( dir, 'knowledge', 'instructions.md' ),
		'The owner’s own instructions.'
	);
	for ( const download of [ 'server-files', 'mu-plugins' ] ) {
		fs.mkdirSync( path.join( dir, download ) );
		fs.writeFileSync( path.join( dir, download, 'kept.txt' ), download );
	}
}

const isInside = ( folder: string, file: string ) => {
	const relative = path.relative( path.resolve( folder ), path.resolve( file ) );
	return relative !== '' && ! relative.startsWith( '..' ) && ! path.isAbsolute( relative );
};

const dedicated = { dir: '' };
beforeAll( () => {
	dedicated.dir = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-eval-isolation-dedicated-' ) );
} );
afterAll( () => {
	fs.rmSync( dedicated.dir, { recursive: true, force: true, maxRetries: 5 } );
} );

describe( 'each eval case keeps to a profile of its own', () => {
	const savedEnv = { ...process.env };
	const savedArgv = process.argv;
	let root: string;
	let fetchSpy: ReturnType< typeof vi.spyOn >;

	beforeEach( () => {
		root = fs.realpathSync( fs.mkdtempSync( path.join( os.tmpdir(), 'studio-eval-isolation-' ) ) );
		fs.mkdirSync( path.join( root, 'tmp' ) );
		for ( const name of [ 'TEMP', 'TMP', 'TMPDIR' ] ) {
			process.env[ name ] = path.join( root, 'tmp' );
		}
		for ( const name of [
			'DEV_CONFIG_DIR',
			'E2E',
			'E2E_SHARED_CONFIG_PATH',
			'E2E_CLI_CONFIG_PATH',
			'E2E_SITES_ROOT',
			'STUDIO_PROCESS_MANAGER_HOME',
			'STUDIO_IMAGE_API_TOKEN',
		] ) {
			delete process.env[ name ];
		}
		Object.assign( process.env, {
			STUDIO_EVAL_SESSION_DIR: path.join( root, 'sessions' ),
			STUDIO_EXPERIMENTAL_CHATGPT: '1',
			// A range the test names, so the entry claims no ports.
			STUDIO_BASE_PORT: '29900',
			STUDIO_EVAL_PROVIDER: 'chatgpt-oauth',
			STUDIO_EVAL_CONNECTION: CONNECTION_ID,
			STUDIO_EVAL_CHATGPT_PROFILE: dedicated.dir,
			STUDIO_EVAL_MODEL: 'gpt-6-luna',
		} );
		broker.connections = [
			{
				connectionId: CONNECTION_ID,
				providerId: 'chatgpt-oauth',
				backend: 'pi',
				revision: 1,
				identity: { subject: 'test-subject' },
				authStatus: 'connected',
			},
		];
		agent.act = null;
		agent.turns = 0;
		sites.create = [];
		transport.sent = [];
		fetchSpy = vi
			.spyOn( globalThis, 'fetch' )
			.mockImplementation( async () => new Response( '{}', { status: 200 } ) );
		freshModules();
	} );

	afterEach( () => {
		fetchSpy.mockRestore();
		for ( const mocked of [
			'cli/ai/eval-runner',
			'@studio/common/lib/root-ca-trust',
			'cli/commands/site/delete',
		] ) {
			vi.doUnmock( mocked );
		}
		process.argv = savedArgv;
		for ( const key of Object.keys( process.env ) ) {
			if ( ! ( key in savedEnv ) ) {
				delete process.env[ key ];
			}
		}
		Object.assign( process.env, savedEnv );
		fs.rmSync( root, { recursive: true, force: true, maxRetries: 5 } );
	} );

	// Runs one case as `eval-runner.mjs` does: the entry first, which imports the
	// runner. The runner's own `main` ends the process, so a stand-in runs the
	// case with the runner's own input reader and keeps the result.
	async function runFromEntry( vars: Record< string, unknown > ) {
		freshModules();
		Object.assign( harness, {
			done: false,
			result: undefined,
			error: undefined,
			wpcomHandler: null,
		} );
		vi.doMock( 'cli/ai/eval-runner', async ( importOriginal ) => {
			const actual = await importOriginal< typeof import('cli/ai/eval-runner') >();
			return {
				...actual,
				main: async () => {
					const { wpcomRequestTool } = await import( '@studio/agent/node/tools/wpcom-request' );
					harness.wpcomHandler = wpcomRequestTool.handler;
					try {
						harness.result = await actual.runEval( actual.readEvalRunnerInput() );
					} catch ( error ) {
						harness.error = error;
					} finally {
						harness.done = true;
					}
				},
			};
		} );
		process.argv = argvFor( vars );
		// The environment the process starts with, as the next case's process starts with it again.
		const startedWith = { ...process.env };
		await import( 'cli/ai/eval-runner-entry' );
		await vi.waitFor( () => expect( harness.done ).toBe( true ), {
			timeout: 90_000,
			interval: 50,
		} );
		for ( const key of Object.keys( process.env ) ) {
			if ( ! ( key in startedWith ) ) {
				delete process.env[ key ];
			}
		}
		Object.assign( process.env, startedWith );
		if ( harness.error ) {
			throw harness.error;
		}
		return harness.result as Record< string, unknown >;
	}

	interface Seen {
		configDirectory: string;
		instructions: string | null;
		payloadFolder?: string;
		rootCaCertificate: string;
	}

	// What a turn of each case does with the config it finds, through the real
	// helpers and the modules loaded with the runner: reads the seeded
	// instructions, writes instructions and a site connection, starts a site's
	// mu-plugins, makes a site certificate, downloads into Studio's server files
	// and, with a login, stages a `wpcom_request` payload file where the tool's
	// description says and sends it.
	async function turnTouchingEverything(
		seen: Seen[],
		{ stagePayload }: { stagePayload: boolean }
	) {
		const paths = await import( '@studio/common/lib/well-known-paths' );
		const { readGlobalInstructionsFile, writeGlobalInstructions } = await import(
			'@studio/agent/node/global-instructions'
		);
		const { getMuPlugins } = await import( '@studio/common/lib/mu-plugins' );
		const { wpcomRequestTool } = await import( '@studio/agent/node/tools/wpcom-request' );
		const { ROOT_CA_CERT_PATH } = await import( '@studio/common/lib/root-ca-trust' );
		const certificates = await import( 'cli/lib/certificate-manager' );
		const entry: Seen = {
			configDirectory: paths.getConfigDirectory(),
			instructions: await readGlobalInstructionsFile(),
			rootCaCertificate: ROOT_CA_CERT_PATH,
		};
		seen.push( entry );
		await writeGlobalInstructions( 'A turn changed these.' );
		await getMuPlugins();
		await certificates.generateSiteCertificate( 'eval-isolation.local' );
		fs.writeFileSync( path.join( paths.getServerFilesPath(), 'downloaded-by-case.txt' ), 'new' );
		if ( stagePayload ) {
			const properties = wpcomRequestTool.parameters.properties as Record<
				string,
				{ description?: string }
			>;
			// The tool's own example: { "content": "<payload folder>/home.html" }.
			const payloadFile = properties.bodyFiles.description?.match( /"content": "([^"]+)"/ )?.[ 1 ];
			if ( ! payloadFile || ! harness.wpcomHandler ) {
				throw new Error( 'wpcom_request names no payload file' );
			}
			entry.payloadFolder = path.dirname( payloadFile );
			fs.mkdirSync( entry.payloadFolder, { recursive: true } );
			fs.writeFileSync( payloadFile, '<p>Staged by the turn.</p>' );
			await harness.wpcomHandler(
				{ siteId: 4242, method: 'POST', path: '/posts/1', bodyFiles: { content: payloadFile } },
				{ host: undefined as unknown as StudioAgentHost, onProgress: () => undefined }
			);
		}
	}

	async function runBothCases() {
		const seen: Seen[] = [];
		agent.act = () => turnTouchingEverything( seen, { stagePayload: false } );
		const instructions = await runFromEntry( parityCase( 'parity-global-instructions' ) );

		agent.act = async ( { host } ) => {
			await turnTouchingEverything( seen, { stagePayload: true } );
			const site = {
				id: 'parity-site-push-approved',
				name: 'Eval Site Push Approved',
				path: path.join( root, 'push-site' ),
				url: 'http://localhost:8883',
				phpVersion: '8.3',
			};
			await host.sync.push( site, 'all', 'https://myprod.wordpress.com', () => undefined );
			const { addConnectedWpcomSite } = await import( '@studio/common/lib/connected-sites' );
			await addConnectedWpcomSite( site.id, {
				id: 114,
				localSiteId: site.id,
				name: 'Another Site',
				url: 'https://another.wordpress.com',
				isStaging: false,
				isPressable: false,
				syncSupport: 'already-connected',
				lastPullTimestamp: null,
				lastPushTimestamp: null,
			} );
		};
		const push = await runFromEntry( parityCase( 'parity-push-approved' ) );
		return { instructions, push, seen };
	}

	function expectOwnProfiles( seen: Seen[], source: string ) {
		expect( seen ).toHaveLength( 2 );
		for ( const { configDirectory, rootCaCertificate } of seen ) {
			expect( path.resolve( configDirectory ) ).not.toBe( path.resolve( source ) );
			expect( path.basename( configDirectory ) ).toMatch( /^studio-eval-config-/ );
			expect( isInside( configDirectory, rootCaCertificate ) ).toBe( true );
			expect( fs.existsSync( configDirectory ) ).toBe( false );
		}
		const [ , push ] = seen;
		expect( push.payloadFolder ).toBeDefined();
		expect( isInside( push.configDirectory, push.payloadFolder ?? '' ) ).toBe( true );
		// The tool's own check at call time took the file from the folder its description names.
		expect( transport.sent ).toContainEqual(
			expect.objectContaining( {
				method: 'POST',
				body: expect.objectContaining( { content: '<p>Staged by the turn.</p>' } ),
			} )
		);
	}

	it( 'leaves every file of the source profile as it was with DEV_CONFIG_DIR pointing at it', async () => {
		const source = path.join( root, 'source-profile' );
		makeSourceProfile( source );
		process.env.DEV_CONFIG_DIR = source;
		const before = snapshot( source );

		const { instructions, push, seen } = await runBothCases();

		expect( instructions ).toMatchObject( { success: true } );
		expect( push ).toMatchObject( {
			success: true,
			remoteCalls: [ expect.objectContaining( { operation: 'push' } ) ],
		} );
		// The turn read the case's own seeded instructions, in a profile of its own.
		expect( seen[ 0 ].instructions ).toContain( 'STUDIO-EVAL-TOKEN-7319' );
		expectOwnProfiles( seen, source );
		expect( expectSourceKept( before, snapshot( source ) ) ).toEqual( [
			'server-files/downloaded-by-case.txt',
		] );
	}, 180_000 );

	it( 'leaves every file of ~/.studio as it was with DEV_CONFIG_DIR unset', async () => {
		const home = path.join( root, 'home' );
		const source = path.join( home, '.studio' );
		makeSourceProfile( source );
		process.env.HOME = process.env.USERPROFILE = home;
		const before = snapshot( source );

		const { instructions, push, seen } = await runBothCases();

		expect( instructions ).toMatchObject( { success: true } );
		expect( push ).toMatchObject( { success: true } );
		expect( seen[ 0 ].instructions ).toContain( 'STUDIO-EVAL-TOKEN-7319' );
		expectOwnProfiles( seen, source );
		expect( expectSourceKept( before, snapshot( source ) ) ).toEqual( [
			'server-files/downloaded-by-case.txt',
		] );
	}, 180_000 );

	it( 'gives a case the source profile’s downloads as links and its own mu-plugins folder', async () => {
		const source = path.join( root, 'source-profile' );
		makeSourceProfile( source );
		process.env.DEV_CONFIG_DIR = source;
		let caseEntries: fs.Dirent[] = [];
		agent.act = async () => {
			const { getConfigDirectory } = await import( '@studio/common/lib/well-known-paths' );
			caseEntries = fs.readdirSync( getConfigDirectory(), { withFileTypes: true } );
		};
		await runFromEntry( parityCase( 'parity-identity' ) );
		const links = caseEntries.filter( ( entry ) => entry.isSymbolicLink() ).map( ( e ) => e.name );
		expect( links ).toEqual( [ 'server-files' ] );
		expect( caseEntries.map( ( entry ) => entry.name ) ).not.toContain( 'mu-plugins' );
	}, 120_000 );

	describe( 'a runner whose modules loaded on the owner’s profile', () => {
		const caseFolders = () =>
			fs
				.readdirSync( path.join( root, 'tmp' ) )
				.filter( ( name ) => /^studio-eval-(config|registry)-/.test( name ) );

		it( 'refuses the case before any site or turn when the profile was set after the modules loaded', async () => {
			const source = path.join( root, 'source-profile' );
			makeSourceProfile( source );
			process.env.DEV_CONFIG_DIR = source;
			const before = snapshot( source );
			const vars = parityCase( 'parity-push-approved' );
			// The runner, and with it every module that fixes a path, loads first ...
			const runner = await import( 'cli/ai/eval-runner' );
			// ... and only then is the process pointed at the case's own folders.
			const { isolateCaseProfile } = await import( 'cli/ai/eval-case-profile' );
			const { isolateCaseProcessManager } = await import( 'cli/ai/eval-case-daemon' );
			isolateCaseProcessManager( argvFor( vars ), process.env );
			isolateCaseProfile( process.env );
			agent.act = vi.fn( async () => undefined );

			const result = await runner.runEval( runner.readEvalRunnerInput( argvFor( vars ) ) );

			expect( result ).toMatchObject( {
				success: false,
				refusal: { code: 'case-profile-not-isolated' },
				providerRoute: { failure: { code: 'case-profile-not-isolated' } },
			} );
			expect( agent.turns ).toBe( 0 );
			expect( sites.create ).toEqual( [] );
			expect( snapshot( source ) ).toEqual( before );
			expect( caseFolders() ).toEqual( [] );
		}, 120_000 );

		it( 'refuses the case when the runner was started without its entry', async () => {
			const source = path.join( root, 'source-profile' );
			makeSourceProfile( source );
			process.env.DEV_CONFIG_DIR = source;
			const before = snapshot( source );
			const runner = await import( 'cli/ai/eval-runner' );

			const result = await runner.runEval(
				runner.readEvalRunnerInput( argvFor( parityCase( 'parity-identity' ) ) )
			);

			expect( result ).toMatchObject( {
				success: false,
				refusal: {
					code: 'case-profile-not-isolated',
					message: expect.stringContaining( 'without the entry' ),
				},
			} );
			expect( agent.turns ).toBe( 0 );
			expect( snapshot( source ) ).toEqual( before );
		}, 120_000 );

		it( 'refuses a case that names a provider when its process manager was set after the CLI’s paths loaded', async () => {
			const source = path.join( root, 'source-profile' );
			makeSourceProfile( source );
			process.env.DEV_CONFIG_DIR = source;
			const vars = parityCase( 'parity-identity' );
			const { isolateCaseProfile } = await import( 'cli/ai/eval-case-profile' );
			isolateCaseProfile( process.env );
			process.env.STUDIO_PROCESS_MANAGER_HOME = path.join( root, 'owners-daemon' );
			const runner = await import( 'cli/ai/eval-runner' );
			const { isolateCaseProcessManager } = await import( 'cli/ai/eval-case-daemon' );
			isolateCaseProcessManager( argvFor( vars ), process.env );

			const result = await runner.runEval( runner.readEvalRunnerInput( argvFor( vars ) ) );

			expect( result ).toMatchObject( {
				success: false,
				refusal: { code: 'process-manager-not-isolated' },
			} );
			expect( agent.turns ).toBe( 0 );
			expect( caseFolders() ).toEqual( [] );
		}, 120_000 );
	} );
} );
