// @vitest-environment node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	readGlobalInstructionsFile,
	writeGlobalInstructions,
} from '@studio/agent/node/global-instructions';
import { addConnectedWpcomSite } from '@studio/common/lib/connected-sites';
import { getMuPlugins } from '@studio/common/lib/mu-plugins';
import { getConfigDirectory } from '@studio/common/lib/well-known-paths';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { readEvalRunnerInput, runEval } from 'cli/ai/eval-runner';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { StudioAgentHost } from '@studio/agent/node/host';
import type { StudioAgentTurnConfig } from '@studio/agent/node/runtime';
import type { ConnectionRegistryEntry } from '@studio/agent/protocol/connections';

// Each case of a run reads the Studio profile the eval process starts with (the
// source: `DEV_CONFIG_DIR`, or `~/.studio`) and keeps everything it writes in a
// temporary profile of its own. These tests run the parity config's
// global-instructions and push cases against a source profile in a scratch
// folder, with the real path helpers, and check that no file in it changed.
// Nothing here reaches a model provider, WordPress.com or a real site.

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
vi.mock( 'cli/commands/site/create', () => ( { runCommand: vi.fn( async () => undefined ) } ) );
vi.mock( 'cli/commands/site/delete', () => ( { runCommand: vi.fn( async () => undefined ) } ) );
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
} ) );
vi.mock( '@studio/agent/node', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/agent/node') >();
	return {
		...actual,
		createAgent: ( { host }: { host: StudioAgentHost } ) => ( {
			runTurn: ( config: StudioAgentTurnConfig ) => {
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

const dedicated = { dir: '' };
beforeAll( () => {
	dedicated.dir = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-eval-isolation-dedicated-' ) );
} );
afterAll( () => {
	fs.rmSync( dedicated.dir, { recursive: true, force: true, maxRetries: 5 } );
} );

describe( 'each eval case keeps to a profile of its own', () => {
	const savedEnv = { ...process.env };
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
			'STUDIO_IMAGE_API_TOKEN',
		] ) {
			delete process.env[ name ];
		}
		process.env.STUDIO_EVAL_SESSION_DIR = path.join( root, 'sessions' );
		process.env.STUDIO_EXPERIMENTAL_CHATGPT = '1';
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
		fs.rmSync( root, { recursive: true, force: true, maxRetries: 5 } );
	} );

	const selection = () => ( {
		STUDIO_EVAL_PROVIDER: 'chatgpt-oauth',
		STUDIO_EVAL_CONNECTION: CONNECTION_ID,
		STUDIO_EVAL_CHATGPT_PROFILE: dedicated.dir,
		STUDIO_EVAL_MODEL: 'gpt-6-luna',
	} );
	const run = ( vars: Record< string, unknown > ) =>
		runEval(
			readEvalRunnerInput(
				[ 'node', 'eval-runner.mjs', String( vars.prompt ), '', JSON.stringify( { vars } ) ],
				selection()
			)
		) as Promise< Record< string, unknown > >;

	// What a turn of each case does with the config it finds, through the real
	// helpers: reads the seeded instructions, writes instructions and a site
	// connection, and starts a site's mu-plugins as a site start does.
	async function runBothCases() {
		const seen: Array< { configDirectory: string; instructions: string | null } > = [];
		agent.act = async () => {
			seen.push( {
				configDirectory: getConfigDirectory(),
				instructions: await readGlobalInstructionsFile(),
			} );
			await writeGlobalInstructions( 'A turn changed these.' );
			await getMuPlugins();
		};
		const instructions = await run( parityCase( 'parity-global-instructions' ) );

		agent.act = async ( { host } ) => {
			seen.push( { configDirectory: getConfigDirectory(), instructions: null } );
			const site = {
				id: 'parity-site-push-approved',
				name: 'Eval Site Push Approved',
				path: path.join( root, 'push-site' ),
				url: 'http://localhost:8883',
				phpVersion: '8.3',
			};
			await host.sync.push( site, 'all', 'https://myprod.wordpress.com', () => undefined );
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
			await getMuPlugins();
		};
		const push = await run( parityCase( 'parity-push-approved' ) );
		return { instructions, push, seen };
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
		for ( const { configDirectory } of seen ) {
			expect( path.resolve( configDirectory ) ).not.toBe( path.resolve( source ) );
			expect( fs.existsSync( configDirectory ) ).toBe( false );
		}
		expect( snapshot( source ) ).toEqual( before );
		expect( process.env.DEV_CONFIG_DIR ).toBe( source );
		expect( process.env.E2E_SHARED_CONFIG_PATH ).toBeUndefined();
	} );

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
		for ( const { configDirectory } of seen ) {
			expect( path.resolve( configDirectory ) ).not.toBe( path.resolve( source ) );
		}
		expect( snapshot( source ) ).toEqual( before );
		expect( process.env.DEV_CONFIG_DIR ).toBeUndefined();
	} );

	it( 'gives a case the source profile’s downloads as links and its own mu-plugins folder', async () => {
		const source = path.join( root, 'source-profile' );
		makeSourceProfile( source );
		process.env.DEV_CONFIG_DIR = source;
		let caseEntries: fs.Dirent[] = [];
		agent.act = async () => {
			caseEntries = fs.readdirSync( getConfigDirectory(), { withFileTypes: true } );
		};
		await run( parityCase( 'parity-identity' ) );
		const links = caseEntries.filter( ( entry ) => entry.isSymbolicLink() ).map( ( e ) => e.name );
		expect( links ).toEqual( [ 'server-files' ] );
		expect( caseEntries.map( ( entry ) => entry.name ) ).not.toContain( 'mu-plugins' );
	} );
} );
