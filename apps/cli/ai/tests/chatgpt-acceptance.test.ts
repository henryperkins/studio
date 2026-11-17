// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	ChatGptConnectionError,
	readChatGptAccount,
} from '@studio/agent/node/chatgpt/account-store';
import {
	createChatGptCredentialBroker,
	type ChatGptCredentialBroker,
	type ChatGptTokenClient,
} from '@studio/agent/node/chatgpt/credential-broker';
import { createChatGptSignInFlow } from '@studio/agent/node/chatgpt/oauth';
import { ChatGptSettingsError } from '@studio/agent/node/chatgpt/settings';
import { getChatGptVaultKeyAccounts } from '@studio/agent/node/chatgpt/state-directory';
import {
	createSigningKey,
	GRANTED_SCOPE,
	startFakeAuthorizationServer,
	type FakeAuthorizationServer,
	type SigningKey,
} from '@studio/agent/node/chatgpt/tests/fixtures/fake-authorization-server';
import { createChatGptTokenClient } from '@studio/agent/node/chatgpt/token-client';
import { createFakeCredentialStore } from '@studio/agent/node/tests/fake-credential-store';
import { CHATGPT_MODEL_CAPABILITIES } from '@studio/agent/protocol/chatgpt-models';
import { describeConnectionSelectionError } from '@studio/agent/protocol/connections';
import { credentialStoreKindFor } from '@studio/common/lib/os-credential-store';
import { getConfigDirectory } from '@studio/common/lib/well-known-paths';
import nock from 'nock';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { findUnsafeText, openAcceptanceEvidence } from 'cli/ai/acceptance-evidence';
import { acceptanceRunPaths, acceptanceStartsNewRun } from 'cli/ai/acceptance-isolation';
import {
	acceptancePlatform,
	acceptanceTurnExecArgv,
	askOwnerForSessionToken,
	classifyToolCall,
	classifyTurnFailure,
	createAcceptanceTokenService,
	digestTurnEvents,
	isToolResultPersisted,
	isWpCliReadCommand,
	parseChatGptAcceptanceArgs,
	parseWpPostList,
	PROVISION_STAGE_NAMES,
	RETIRE_STAGE_NAMES,
	runChatGptAcceptance,
	SAVED_STAGE_NAMES,
	SESSION_STAGE_NAMES,
	type AcceptanceTurn,
	type ChatGptAcceptanceDependencies,
	type ChatGptAcceptanceServices,
	type TimedEvent,
	type TurnOptions,
	type TurnResult,
} from 'cli/ai/chatgpt-acceptance';
import type { ObservedRequest } from 'cli/ai/chatgpt-acceptance-observer';

const REGISTRATION = '0d6b5a8e-3c1f-4e2a-9b7d-5f4c3a2b1e0d';
const SHA = '5c742434a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5';
// The default profile's vault key item, and one of another profile's.
const UNSCOPED_VAULT_KEY_ITEM = 'chatgpt-vault-key';
const VAULT_KEY_SUFFIX = '0123456789abcdef';
const SCOPED_VAULT_KEY_ITEM = `${ UNSCOPED_VAULT_KEY_ITEM }-${ VAULT_KEY_SUFFIX }`;
const signedOutText = new ChatGptConnectionError( 'signed-out' ).message;
const disconnectedText = describeConnectionSelectionError( {
	code: 'disconnected',
	providerId: 'chatgpt-oauth',
} );

const deferred = < T = void >() => {
	let resolve!: ( value: T ) => void;
	let reject!: ( error: unknown ) => void;
	const promise = new Promise< T >( ( settle, fail ) => {
		resolve = settle;
		reject = fail;
	} );
	return { promise, resolve, reject };
};

let clockMs = Date.UTC( 2026, 10, 11, 12 );
const at = ( offsetMs = 0 ) => clockMs + offsetMs;

const message = ( payload: Record< string, unknown >, receivedAt = at() ): TimedEvent => ( {
	receivedAt,
	event: { type: 'message', timestamp: '', message: payload } as never,
} );
const toolStart = ( id: string, toolName: string, args: unknown, receivedAt = at() ) =>
	message( { type: 'tool_execution_start', toolCallId: id, toolName, args }, receivedAt );
const toolEnd = ( id: string, toolName: string, details?: unknown, receivedAt = at() ) =>
	message(
		{
			type: 'tool_execution_end',
			toolCallId: id,
			toolName,
			isError: false,
			result: { content: [], details },
		},
		receivedAt
	);
const answered = ( text: string, receivedAt = at() ) =>
	message(
		{
			type: 'agent_end',
			messages: [ { role: 'assistant', stopReason: 'stop', content: [ { type: 'text', text } ] } ],
		},
		receivedAt
	);
const failedWith = ( text: string, receivedAt = at() ) =>
	message(
		{
			type: 'agent_end',
			messages: [ { role: 'assistant', stopReason: 'error', errorMessage: text, content: [] } ],
		},
		receivedAt
	);
// How the ChatGPT transport ends a turn whose own connection signal stopped it.
const interruptedWith = ( text: string, receivedAt = at() ) =>
	message(
		{
			type: 'agent_end',
			messages: [ { role: 'assistant', stopReason: 'aborted', errorMessage: text, content: [] } ],
		},
		receivedAt
	);
const cliError = ( text: string ): TimedEvent => ( {
	receivedAt: at(),
	event: { type: 'error', timestamp: '', message: text },
} );
const completed = ( status: 'success' | 'error', receivedAt = at() ): TimedEvent => ( {
	receivedAt,
	event: { type: 'turn.completed', status, sessionId: '', timestamp: '' } as never,
} );

let requestId = 0;
const routeRequest = ( overrides: Partial< ObservedRequest > = {} ): ObservedRequest => ( {
	kind: 'request',
	id: ++requestId,
	pid: 4242,
	startedAt: at(),
	host: 'chatgpt-route',
	endpoint: 'responses',
	bearer: 'jwt',
	model: 'gpt-6-luna',
	effort: 'medium',
	stream: true,
	store: false,
	outputCap: false,
	previousResponseId: false,
	tools: 30,
	inputItems: 3,
	userMessages: 1,
	assistantMessages: 0,
	functionCalls: 0,
	functionOutputs: 0,
	reasoningItems: 0,
	imageInputs: 0,
	imageToolOutputs: 0,
	...overrides,
} );

const turnResult = ( overrides: Partial< TurnResult > = {} ): TurnResult => ( {
	pid: 4242,
	exitCode: 0,
	startedAt: at(),
	exitedAt: at( 1_000 ),
	events: [ answered( 'Done.' ), completed( 'success' ) ],
	requests: [ routeRequest() ],
	responses: [],
	tokenAsks: 0,
	tokensHandedOut: 0,
	interruptedByRunner: false,
	...overrides,
} );

const finishedTurn = ( result: TurnResult, firstRequest = true ): AcceptanceTurn => ( {
	firstRequest: async () => firstRequest,
	result: Promise.resolve( result ),
	stop: async () => undefined,
} );

const BASELINE = JSON.stringify( [
	{ ID: 1, post_title: 'Hello world!', post_status: 'publish' },
] );

interface ScriptedCalls {
	log: string[];
	prompts: Record< string, string >;
}

/**
 * Services for the saved scenario that pass every stage, with each part
 * replaceable. Nothing here reaches a network, a browser, a keychain or a site.
 */
function scriptedServices(
	overrides: Partial< ChatGptAcceptanceServices > = {},
	turns: Partial< Record< string, ( options: TurnOptions ) => AcceptanceTurn > > = {},
	cli: Partial< Record< string, () => { exitCode: number | null; stdout: string } > > = {}
): {
	services: ChatGptAcceptanceServices;
	calls: ScriptedCalls;
	/** When the first sign-out began, on the services' clock. */
	signOutBegan: Promise< number >;
	notifySignedOut: ( began: number ) => void;
} {
	const calls: ScriptedCalls = { log: [], prompts: {} };
	let state: 'signed-in' | 'signed-out' | 'none' = 'none';
	let storage: 'vault' | 'session' = 'vault';
	let pendingStorage: 'vault' | 'session' = 'vault';
	let draftTitle = '';
	let draftContent = '';
	let posts = 0;
	const signedOut = deferred< number >();
	let pid = 100;
	const defaultTurns: Record< string, ( options: TurnOptions ) => AcceptanceTurn > = {
		draft: ( options ) => {
			draftTitle = options.prompt.match( /titled "([^"]+)"/ )?.[ 1 ] ?? '';
			draftContent = options.prompt.match( /content "([^"]+)"/ )?.[ 1 ] ?? '';
			return finishedTurn(
				turnResult( {
					pid: ++pid,
					events: [
						toolStart( 'a', 'wp_cli', {
							nameOrPath: 'ChatGPT Acceptance',
							command: 'option get blogname',
						} ),
						toolEnd( 'a', 'wp_cli' ),
						toolStart( 'b', 'wp_cli', {
							nameOrPath: 'ChatGPT Acceptance',
							command: `post create --post_status=draft --post_title="${ draftTitle }" --post_content="${ draftContent }"`,
						} ),
						toolEnd( 'b', 'wp_cli' ),
						answered( 'Created post 7.' ),
						completed( 'success' ),
					],
					requests: [ routeRequest(), routeRequest( { functionCalls: 1, functionOutputs: 1 } ) ],
				} )
			);
		},
		resume: () =>
			finishedTurn(
				turnResult( {
					pid: ++pid,
					events: [ answered( draftTitle.split( ' ' ).at( -1 ) ?? '' ), completed( 'success' ) ],
					requests: [
						routeRequest( {
							effort: 'low',
							inputItems: 9,
							assistantMessages: 1,
							functionCalls: 2,
						} ),
					],
				} )
			),
		// Stopped by its own turn handle about one watch poll after the sign-out began.
		'active-run': () => ( {
			firstRequest: async () => true,
			result: signedOut.promise.then( ( began ) =>
				turnResult( {
					pid: ++pid,
					exitCode: 0,
					startedAt: began - 5_000,
					exitedAt: began + 2_000,
					events: [
						toolStart(
							'c',
							'wp_cli',
							{ nameOrPath: 'ChatGPT Acceptance', command: 'plugin list' },
							began - 500
						),
						toolEnd( 'c', 'wp_cli', undefined, began + 300 ),
						interruptedWith( signedOutText, began + 1_800 ),
						completed( 'error', began + 1_900 ),
					],
					requests: [ routeRequest( { startedAt: began - 1_000, effort: 'low' } ) ],
				} )
			),
			stop: async () => undefined,
		} ),
		'after-sign-out': () =>
			finishedTurn(
				turnResult( {
					exitCode: 1,
					events: [ cliError( disconnectedText ) ],
					requests: [],
				} )
			),
	};
	const defaultCli: Record< string, () => { exitCode: number | null; stdout: string } > = {
		'site-create': () => ( { exitCode: 0, stdout: '' } ),
		'wp-post-list': () => ( {
			exitCode: 0,
			stdout:
				posts++ === 0
					? BASELINE
					: JSON.stringify( [
							...JSON.parse( BASELINE ),
							{ ID: 7, post_title: draftTitle, post_status: 'draft' },
					  ] ),
		} ),
		'wp-post-get': () => ( { exitCode: 0, stdout: `<!-- wp:paragraph -->${ draftContent }\n` } ),
		'site-stop': () => ( { exitCode: 0, stdout: '' } ),
		'site-delete': () => ( { exitCode: 0, stdout: '' } ),
		'daemon-stop': () => ( { exitCode: 0, stdout: '' } ),
		'wp-blogname': () => ( { exitCode: 0, stdout: '' } ),
	};
	let attempts = 0;
	// A renewal after the access token was dropped refreshes, rotating the grant.
	let accessTokenDropped = false;
	let refreshes = 0;
	const account = () =>
		state === 'none'
			? null
			: {
					registrationId: REGISTRATION,
					issuer: 'https://auth.openai.com',
					subject: 'test-subject',
					email: null,
					clientId: 'test-client',
					label: 'Test',
					revision: 1,
					logoutGeneration: state === 'signed-out' ? 1 : 0,
					storage,
					state,
					createdAt: '',
					updatedAt: '',
			  };
	const services: ChatGptAcceptanceServices = {
		clock: {
			now: () => Date.now(),
			sleep: ( ms, signal ) =>
				new Promise( ( resolve ) => {
					const timer = setTimeout( resolve, ms );
					signal?.addEventListener( 'abort', () => {
						clearTimeout( timer );
						resolve();
					} );
				} ),
		},
		countdownIntervalMs: 60 * 60_000,
		signIn: {
			timeoutMs: 600_000,
			begin: async ( _registrationId, options ) => {
				calls.log.push( `begin:${ options.storage }` );
				pendingStorage = options.storage;
				return { attemptId: `attempt-${ ++attempts }` };
			},
			wait: async () => {
				state = 'signed-in';
				storage = pendingStorage;
				return { ok: true, registrationId: REGISTRATION, label: 'Test', email: null };
			},
			cancel: () => {
				calls.log.push( 'cancel' );
				return true;
			},
		},
		broker: {
			getAccessToken: async () => {
				if ( accessTokenDropped ) {
					accessTokenDropped = false;
					refreshes++;
					calls.log.push( 'refresh' );
				}
				return 'test-access-token';
			},
			invalidateAccessToken: async () => {
				accessTokenDropped = true;
			},
			signOut: async () => {
				calls.log.push( 'sign-out' );
				signedOut.resolve( services.clock.now() );
				state = 'signed-out';
				return { localCleared: true, remoteRevocationConfirmed: true };
			},
			sessionForkEnvironment: () => ( {} ),
			askSessionToken: async () => false,
			readAccount: async () => account(),
			vaultRecordExists: () => state === 'signed-in' && storage === 'vault',
			vaultKeyItem: () => SCOPED_VAULT_KEY_ITEM,
			// As the broker does: kept while a saved sign-in still needs it.
			removeProfileVaultKey: async () => {
				calls.log.push( 'remove-vault-key' );
				return state === 'signed-in' && storage === 'vault' ? 'records-exist' : 'removed';
			},
			readModels: async ( connectionId, revision ) => ( {
				connectionId,
				revision,
				checkedAt: '',
				models: [ { id: 'gpt-6-luna', label: 'GPT-6 Luna' } ],
				lastError: null,
			} ),
		},
		tokens: {
			holdNextRefresh: () => ( { held: Promise.resolve( false ), release: () => undefined } ),
			refreshes: () => refreshes,
			probe: async ( which ) => {
				calls.log.push( `probe:${ which }` );
				return { tried: true, rejected: true, terminal: true };
			},
			revocations: () => ( { total: 1, confirmed: 1, rotatedRevoked: true } ),
			settle: async () => undefined,
		},
		sessions: {
			create: async ( site ) => {
				calls.log.push( site ? 'session:site' : 'session:global' );
				return `1d6b5a8e-3c1f-4e2a-9b7d-5f4c3a2b1e0${ calls.log.length % 10 }`;
			},
			select: async ( _sessionId, selection ) => {
				calls.log.push( `select:${ selection.reasoningEffort }` );
			},
			filePath: async () => null,
		},
		processes: {
			startTurn: ( options ) => {
				calls.log.push( `turn:${ options.label }` );
				calls.prompts[ options.label ] = options.prompt;
				return ( turns[ options.label ] ?? defaultTurns[ options.label ] )( options );
			},
			runCli: async ( label ) => {
				calls.log.push( `cli:${ label }` );
				return ( cli[ label ] ?? defaultCli[ label ] )();
			},
			stopOwned: async () => {
				calls.log.push( 'stop-owned' );
				return { stopped: 0, failed: 0 };
			},
		},
		buildPresent: () => true,
		credentialStoreKind: () => 'password-vault',
		secureStorageAvailable: async () => true,
		imageServiceConfigured: async () => false,
		...overrides,
	};
	return {
		services,
		calls,
		signOutBegan: signedOut.promise,
		notifySignedOut: ( began ) => signedOut.resolve( began ),
	};
}

describe( 'ChatGPT acceptance runner', () => {
	let base: string;
	let runDir: string;
	let printed: string[];
	let interrupt: ( () => void ) | null;
	const savedEnv = { ...process.env };

	const dependencies = (
		services?: ChatGptAcceptanceServices | ( () => Promise< ChatGptAcceptanceServices > ),
		overrides: Partial< ChatGptAcceptanceDependencies > = {}
	): ChatGptAcceptanceDependencies => ( {
		env: process.env,
		home: path.join( base, 'home' ),
		print: ( line ) => printed.push( line ),
		collectFacts: async () => ( {
			source: { sha: SHA, dirty: false },
			platform: { os: 'win32', release: '10.0.26320', arch: 'x64' },
			runtime: { node: '24.22.1', npm: '11.13.0' },
			build: { cliVersion: '1.7.3', buildId: 'a1b2c3d4e5f6' },
		} ),
		configDirectory: () => getConfigDirectory(),
		processManagerHome: () => process.env.STUDIO_PROCESS_MANAGER_HOME ?? '',
		onInterrupt: ( handler ) => {
			interrupt = handler;
			return () => {
				interrupt = null;
			};
		},
		createServices: async () => {
			if ( ! services ) {
				throw new Error( 'No services in this test.' );
			}
			return typeof services === 'function' ? services() : services;
		},
		...overrides,
	} );

	const records = () => openAcceptanceEvidence( runDir, 'chatgpt' ).readRecords();
	const stageOf = ( name: string ) => records().filter( ( record ) => record.stage === name );

	// Secrets appear nowhere; local identifiers only in state.json.
	function expectNothingUnsafe( secrets: string[] = [], identifiers: string[] = [] ) {
		const evidenceText = [ 'manifest.json', 'evidence.ndjson' ]
			.map( ( name ) => path.join( runDir, name ) )
			.filter( ( file ) => fs.existsSync( file ) )
			.map( ( file ) => fs.readFileSync( file, 'utf8' ) )
			.join( '\n' );
		const statePath = path.join( runDir, 'state.json' );
		const stateText = fs.existsSync( statePath ) ? fs.readFileSync( statePath, 'utf8' ) : '';
		const output = printed.join( '\n' );
		for ( const secret of secrets ) {
			expect( evidenceText ).not.toContain( secret );
			expect( output ).not.toContain( secret );
			expect( stateText ).not.toContain( secret );
		}
		for ( const identifier of identifiers ) {
			expect( evidenceText ).not.toContain( identifier );
			expect( output ).not.toContain( identifier );
		}
		for ( const line of printed ) {
			expect( findUnsafeText( line, { paths: true } ) ).toBeNull();
		}
		expect( evidenceText ).not.toMatch( /@|https?:\/\/|eyJ[\w-]+\.|Bearer\s/ );
	}

	beforeEach( () => {
		base = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-chatgpt-acceptance-' ) );
		runDir = path.join( base, 'run' );
		printed = [];
		interrupt = null;
		clockMs = Date.UTC( 2026, 10, 11, 12 );
	} );

	afterEach( () => {
		for ( const key of Object.keys( process.env ) ) {
			if ( ! ( key in savedEnv ) ) {
				delete process.env[ key ];
			}
		}
		Object.assign( process.env, savedEnv );
		fs.rmSync( base, { recursive: true, force: true, maxRetries: 5 } );
	} );

	describe( 'command line', () => {
		it( 'requires a scenario and an absolute run directory, and names the qualified choices', () => {
			expect( parseChatGptAcceptanceArgs( [ '--live' ] ) ).toMatchObject( {
				ok: false,
				problem: 'scenario-missing',
			} );
			expect(
				parseChatGptAcceptanceArgs( [ '--scenario', 'other', '--run-dir', runDir ] )
			).toMatchObject( { ok: false, problem: 'scenario-unknown' } );
			expect(
				parseChatGptAcceptanceArgs( [
					'--scenario',
					'saved',
					'--run-dir',
					runDir,
					'--gates',
					'T9',
				] )
			).toMatchObject( { ok: false, problem: 'gate-unknown' } );
			expect(
				parseChatGptAcceptanceArgs( [
					'--scenario',
					'session',
					'--run-dir',
					runDir,
					'--model',
					'x',
				] )
			).toMatchObject( { ok: false, problem: 'option-not-for-session' } );
			expect(
				parseChatGptAcceptanceArgs( [
					'--live',
					'--scenario',
					'saved',
					'--run-dir',
					runDir,
					'--gates',
					'T1,T3',
				] )
			).toEqual( {
				ok: true,
				options: {
					live: true,
					scenario: 'saved',
					runDir,
					model: 'gpt-6-luna',
					effort: 'medium',
					gates: [ 'T1', 'T3' ],
				},
			} );
		} );

		it( 'refuses a model or effort the route is not qualified for, with the reason', async () => {
			for ( const argv of [
				[ '--live', '--scenario', 'saved', '--run-dir', runDir, '--model', 'gpt-6.1-sol' ],
				[ '--live', '--scenario', 'saved', '--run-dir', runDir, '--effort', 'high' ],
			] ) {
				printed = [];
				const create = vi.fn();
				expect(
					await runChatGptAcceptance( argv, dependencies( undefined, { createServices: create } ) )
				).toBe( 2 );
				expect( create ).not.toHaveBeenCalled();
				expect( printed.join( '\n' ) ).toMatch( /isn’t qualified for use with a ChatGPT plan/ );
			}
			expect( fs.existsSync( runDir ) ).toBe( false );
		} );

		it( 'without --live, checks local prerequisites, prints the plan and runs nothing', async () => {
			const create = vi.fn();
			const code = await runChatGptAcceptance(
				[ '--scenario', 'saved', '--run-dir', runDir ],
				dependencies( undefined, { createServices: create } )
			);
			expect( code ).toBe( 2 );
			expect( create ).not.toHaveBeenCalled();
			expect( fs.existsSync( runDir ) ).toBe( false );
			const output = printed.join( '\n' );
			expect( output ).toMatch( /Dry check only/ );
			expect( output ).toMatch( /--live/ );
			for ( const stage of SAVED_STAGE_NAMES ) {
				expect( output ).toContain( stage );
			}
		} );

		it( 'refuses a run directory that is relative, not empty, or inside the Studio profile', async () => {
			fs.mkdirSync( runDir, { recursive: true } );
			fs.writeFileSync( path.join( runDir, 'left-over' ), '' );
			for ( const [ dir, pattern ] of [
				[ 'relative/run', /absolute/ ],
				[ runDir, /empty/ ],
				[ path.join( base, 'home', '.studio', 'run' ), /Studio profile/ ],
			] as const ) {
				printed = [];
				expect(
					await runChatGptAcceptance(
						[ '--live', '--scenario', 'saved', '--run-dir', dir ],
						dependencies()
					)
				).toBe( 2 );
				expect( printed.join( '\n' ) ).toMatch( pattern );
			}
		} );

		it( "refuses when the profile or process manager would resolve to the user's real Studio profile", async () => {
			const real = path.join( base, 'home', '.studio' );
			const create = vi.fn();
			expect(
				await runChatGptAcceptance(
					[ '--live', '--scenario', 'saved', '--run-dir', runDir ],
					dependencies( undefined, { createServices: create, configDirectory: () => real } )
				)
			).toBe( 2 );
			expect(
				await runChatGptAcceptance(
					[ '--live', '--scenario', 'saved', '--run-dir', runDir ],
					dependencies( undefined, {
						createServices: create,
						processManagerHome: () => path.join( real, 'daemon' ),
					} )
				)
			).toBe( 2 );
			expect( create ).not.toHaveBeenCalled();
			expect( printed.join( '\n' ) ).toMatch( /real Studio profile/ );
		} );

		it( 'refuses, without changing it, a real profile in which a child CLI would rename the process manager folder', async () => {
			const studio = path.join( base, 'home', '.studio' );
			fs.mkdirSync( path.join( studio, 'pm2' ), { recursive: true } );
			for ( const argv of [
				[ '--scenario', 'saved', '--run-dir', runDir ],
				[ '--live', '--scenario', 'saved', '--run-dir', runDir ],
			] ) {
				printed = [];
				const create = vi.fn();
				expect(
					await runChatGptAcceptance( argv, dependencies( undefined, { createServices: create } ) )
				).toBe( 2 );
				expect( create ).not.toHaveBeenCalled();
				expect( printed.join( '\n' ) ).toMatch( /\.studio.pm2/ );
				expect( printed.join( '\n' ) ).not.toMatch( /Dry check only/ );
			}
			expect( fs.existsSync( runDir ) ).toBe( false );
			expect( fs.readdirSync( studio ) ).toEqual( [ 'pm2' ] );

			fs.mkdirSync( path.join( studio, 'daemon' ) );
			printed = [];
			expect(
				await runChatGptAcceptance(
					[ '--scenario', 'saved', '--run-dir', runDir ],
					dependencies( undefined, { createServices: vi.fn() } )
				)
			).toBe( 2 );
			expect( printed.join( '\n' ) ).toMatch( /Dry check only/ );
		} );
	} );

	describe( 'session prerequisites', () => {
		const sessionArgs = () => [ '--live', '--scenario', 'session', '--run-dir', runDir ];

		it( 'refuses a run directory without that run’s saved manifest, or with an incompatible one', async () => {
			const create = vi.fn();
			fs.mkdirSync( runDir, { recursive: true } );
			expect(
				await runChatGptAcceptance(
					sessionArgs(),
					dependencies( undefined, { createServices: create } )
				)
			).toBe( 2 );
			expect( printed.join( '\n' ) ).toMatch( /no manifest/i );

			fs.writeFileSync( path.join( runDir, 'manifest.json' ), '{ not json' );
			printed = [];
			expect(
				await runChatGptAcceptance(
					sessionArgs(),
					dependencies( undefined, { createServices: create } )
				)
			).toBe( 2 );
			expect( printed.join( '\n' ) ).toMatch( /can’t read/ );

			fs.rmSync( path.join( runDir, 'manifest.json' ) );
			const evidence = openAcceptanceEvidence( runDir, 'chatgpt' );
			evidence.startRun( {
				scenario: 'saved',
				createdOn: '2026-11-11',
				source: { sha: 'f'.repeat( 40 ), dirty: false },
				platform: { os: 'win32', release: '10.0.26320', arch: 'x64' },
				runtime: { node: '24.22.1', npm: '11.13.0' },
				build: { cliVersion: '1.7.3', buildId: 'a1b2c3d4e5f6' },
				model: 'gpt-6-luna',
				effort: 'medium',
				gates: [],
			} );
			printed = [];
			expect(
				await runChatGptAcceptance(
					sessionArgs(),
					dependencies( undefined, { createServices: create } )
				)
			).toBe( 2 );
			expect( printed.join( '\n' ) ).toMatch( /different source/ );

			fs.rmSync( path.join( runDir, 'manifest.json' ) );
			openAcceptanceEvidence( runDir, 'chatgpt' ).startRun( {
				scenario: 'saved',
				createdOn: '2026-11-11',
				source: { sha: SHA, dirty: false },
				platform: { os: 'win32', release: '10.0.26320', arch: 'x64' },
				runtime: { node: '24.22.1', npm: '11.13.0' },
				build: { cliVersion: '1.7.3', buildId: 'a1b2c3d4e5f6' },
				model: 'gpt-6-luna',
				effort: 'medium',
				gates: [],
			} );
			printed = [];
			expect(
				await runChatGptAcceptance(
					sessionArgs(),
					dependencies( undefined, { createServices: create } )
				)
			).toBe( 2 );
			expect( printed.join( '\n' ) ).toMatch( /no ChatGPT registration/ );
			expect( create ).not.toHaveBeenCalled();
		} );
	} );

	describe( 'saved scenario with scripted services', () => {
		const savedArgs = ( ...extra: string[] ) => [
			'--live',
			'--scenario',
			'saved',
			'--run-dir',
			runDir,
			...extra,
		];

		it.each( [
			[ 'win32', 'password-vault' ],
			[ 'darwin', 'keychain' ],
			[ 'linux', 'secret-service' ],
			[ 'freebsd', null ],
		] as const )( 'names the system keychain Studio uses on %s', ( platform, kind ) => {
			expect( credentialStoreKindFor( platform ) ).toBe( kind );
		} );

		it( 'records which system keychain the run used and whether it answered, as booleans only', async () => {
			const { services } = scriptedServices( { credentialStoreKind: () => 'secret-service' } );

			expect( await runChatGptAcceptance( savedArgs(), dependencies( services ) ) ).toBe( 0 );

			expect( stageOf( 'prerequisites' )[ 0 ] ).toMatchObject( {
				status: 'passed',
				observations: {
					buildPresent: true,
					storePasswordVault: false,
					storeKeychain: false,
					storeSecretService: true,
					secureStorageAvailable: true,
					isolated: true,
				},
			} );
		} );

		it( 'runs every stage, records each before judging it, and cleans up after itself', async () => {
			const { services, calls } = scriptedServices();
			expect( await runChatGptAcceptance( savedArgs(), dependencies( services ) ) ).toBe( 0 );
			expect( records().map( ( record ) => [ record.stage, record.status ] ) ).toEqual( [
				...SAVED_STAGE_NAMES.map( ( stage ) => [
					stage,
					stage.startsWith( 'gate-' ) ? 'skipped' : 'passed',
				] ),
				[ 'cleanup', 'passed' ],
			] );
			expect( stageOf( 'draft-readback' )[ 0 ].observations ).toMatchObject( {
				newPosts: 1,
				statusDraft: true,
				titleMatches: true,
				contentMatches: true,
				otherPostsUnchanged: true,
			} );
			expect( stageOf( 'resume' )[ 0 ].observations ).toMatchObject( {
				freshProcess: true,
				markerRecovered: true,
				historyReplayed: true,
				requestsAtNewEffort: true,
			} );
			expect( stageOf( 'active-run-stops-on-sign-out' )[ 0 ].observations ).toMatchObject( {
				localCleared: true,
				remoteRevocationConfirmed: true,
				routeRequestsAfterSignOut: 0,
				toolStartsAfterSignOut: 0,
				reportedSignedOut: true,
				stoppedByTurnHandle: true,
				stopDelayS: 1.8,
				ownerInterruptSent: false,
			} );
			expect( calls.log ).toEqual(
				expect.arrayContaining( [ 'begin:vault', 'select:medium', 'select:low', 'stop-owned' ] )
			);
			// Signed out by its own stage, so cleanup has no registration left to sign out.
			expect( calls.log.filter( ( call ) => call === 'sign-out' ) ).toHaveLength( 1 );
			expect( calls.log ).toEqual(
				expect.arrayContaining( [ 'cli:site-stop', 'cli:site-delete', 'cli:daemon-stop' ] )
			);
			const manifest = openAcceptanceEvidence( runDir, 'chatgpt' ).readManifest();
			expect( manifest?.runs ).toEqual( [
				expect.objectContaining( {
					run: 1,
					scenario: 'saved',
					model: 'gpt-6-luna',
					effort: 'medium',
					source: { sha: SHA, dirty: false },
				} ),
			] );
			const state = openAcceptanceEvidence( runDir, 'chatgpt' ).readState();
			expect( state ).toMatchObject( { registrationId: REGISTRATION, effort: 'low' } );
			for ( const sub of [ 'profile', 'daemon', 'sites', 'observer' ] ) {
				expect( fs.existsSync( path.join( runDir, sub ) ) ).toBe( true );
			}
			expect( process.env.DEV_CONFIG_DIR ).toBe( acceptanceRunPaths( runDir ).profileDir );
			expectNothingUnsafe( [ 'test-access-token' ] );
		} );

		it( 'removes the run profile’s own vault key item after the sign-out, and records that it did', async () => {
			const { services, calls } = scriptedServices();
			expect( await runChatGptAcceptance( savedArgs(), dependencies( services ) ) ).toBe( 0 );
			expect( stageOf( 'prerequisites' )[ 0 ].observations ).toMatchObject( {
				vaultKeyScoped: true,
			} );
			// Only the suffix: the full item name reads like an opaque token.
			expect( openAcceptanceEvidence( runDir, 'chatgpt' ).readState() ).toMatchObject( {
				vaultKeySuffix: VAULT_KEY_SUFFIX,
			} );
			expect( calls.log.filter( ( call ) => call === 'remove-vault-key' ) ).toHaveLength( 1 );
			expect( calls.log.indexOf( 'sign-out' ) ).toBeLessThan(
				calls.log.indexOf( 'remove-vault-key' )
			);
			expect( records().at( -1 ) ).toMatchObject( {
				stage: 'cleanup',
				status: 'passed',
				observations: expect.objectContaining( { vaultKeyRemoved: true } ),
			} );
		} );

		it( 'fails cleanup, after its other steps, when the run profile’s vault key item stays', async () => {
			const { services, calls } = scriptedServices();
			services.broker.removeProfileVaultKey = async () => {
				calls.log.push( 'remove-vault-key' );
				throw new Error( 'The keychain went away.' );
			};
			expect( await runChatGptAcceptance( savedArgs(), dependencies( services ) ) ).toBe( 1 );
			expect( records().at( -1 ) ).toMatchObject( {
				stage: 'cleanup',
				status: 'failed',
				code: 'cleanup-failed',
				observations: expect.objectContaining( { vaultKeyRemoved: false, stepFailures: 1 } ),
			} );
			expect( calls.log.indexOf( 'cli:daemon-stop' ) ).toBeLessThan(
				calls.log.indexOf( 'remove-vault-key' )
			);
		} );

		it.each( [
			[ 'the unscoped item', () => UNSCOPED_VAULT_KEY_ITEM ],
			[
				'no item it can name',
				(): string => {
					throw new Error( 'unresolved' );
				},
			],
		] )(
			'blocks before any sign-in when the run profile would keep its vault key under %s',
			async ( _label, vaultKeyItem ) => {
				const { services, calls } = scriptedServices();
				services.broker.vaultKeyItem = vaultKeyItem;
				expect( await runChatGptAcceptance( savedArgs(), dependencies( services ) ) ).toBe( 1 );
				expect(
					records().map( ( record ) => [ record.stage, record.status, record.code ] )
				).toEqual( [
					[ 'prerequisites', 'blocked', 'vault-key-not-scoped' ],
					[ 'cleanup', 'passed', undefined ],
				] );
				expect( stageOf( 'prerequisites' )[ 0 ].observations ).toMatchObject( {
					vaultKeyScoped: false,
				} );
				expect( calls.log.some( ( call ) => call.startsWith( 'begin:' ) ) ).toBe( false );
				expect( calls.log ).not.toContain( 'remove-vault-key' );
			}
		);

		it( 'records an unexpected tool call, stops judging there, and still cleans up', async () => {
			const { services } = scriptedServices(
				{},
				{
					draft: () =>
						finishedTurn(
							turnResult( {
								events: [
									toolStart( 'x', 'wp_cli', {
										nameOrPath: 'ChatGPT Acceptance',
										command: 'post create --post_status=publish --post_title="x"',
									} ),
									toolEnd( 'x', 'wp_cli' ),
									answered( 'Published.' ),
									completed( 'success' ),
								],
							} )
						),
				}
			);
			expect( await runChatGptAcceptance( savedArgs(), dependencies( services ) ) ).toBe( 1 );
			expect( stageOf( 'draft-turn' )[ 0 ] ).toMatchObject( {
				status: 'failed',
				code: 'unexpected-tool-call',
				observations: expect.objectContaining( { unexpectedToolCalls: 1 } ),
			} );
		} );

		const failures: Array<
			[
				string,
				string,
				'failed' | 'blocked',
				() => ReturnType< typeof scriptedServices >,
				{ signOut: boolean; site: boolean },
			]
		> = [
			[
				'prerequisites',
				'secure-storage-unavailable',
				'blocked',
				() => scriptedServices( { secureStorageAvailable: async () => false } ),
				{ signOut: false, site: false },
			],
			[
				'sign-in',
				'denied',
				'failed',
				() => {
					const scripted = scriptedServices();
					scripted.services.signIn.wait = async () => ( {
						ok: false,
						code: 'denied',
						message: 'denied',
					} );
					return scripted;
				},
				{ signOut: false, site: false },
			],
			[
				're-sign-in',
				'identity-mismatch',
				'failed',
				() => {
					const scripted = scriptedServices();
					const original = scripted.services.signIn.wait;
					let waits = 0;
					scripted.services.signIn.wait = async ( attemptId ) =>
						++waits === 1
							? original( attemptId )
							: { ok: false, code: 'identity-mismatch', message: 'mismatch' };
					return scripted;
				},
				{ signOut: true, site: false },
			],
			[
				'model-discovery',
				'model-not-listed',
				'failed',
				() => {
					const scripted = scriptedServices();
					scripted.services.broker.readModels = async ( connectionId, revision ) => ( {
						connectionId,
						revision,
						checkedAt: '',
						models: [],
						lastError: null,
					} );
					return scripted;
				},
				{ signOut: true, site: false },
			],
			[
				'disposable-site',
				'site-create-failed',
				'failed',
				() => scriptedServices( {}, {}, { 'site-create': () => ( { exitCode: 1, stdout: '' } ) } ),
				{ signOut: true, site: true },
			],
			[
				'draft-turn',
				'usage-limit',
				'failed',
				() =>
					scriptedServices(
						{},
						{
							draft: () =>
								finishedTurn(
									turnResult( {
										events: [
											failedWith(
												'Limit reached (HTTP 429, subscription_sharing_usage_limit_exceeded)'
											),
											completed( 'error' ),
										],
									} )
								),
						}
					),
				{ signOut: true, site: true },
			],
			[
				'draft-turn',
				'no-site-read',
				'failed',
				() =>
					scriptedServices(
						{},
						{
							// Its own post create is the only WP-CLI call: nothing read the site.
							draft: ( options ) => {
								const title = options.prompt.match( /titled "([^"]+)"/ )?.[ 1 ] ?? '';
								return finishedTurn(
									turnResult( {
										events: [
											toolStart( 'a', 'wp_cli', {
												nameOrPath: 'ChatGPT Acceptance',
												command: `post create --post_status=draft --post_title="${ title }"`,
											} ),
											toolEnd( 'a', 'wp_cli' ),
											answered( 'Created post 7.' ),
											completed( 'success' ),
										],
									} )
								);
							},
						}
					),
				{ signOut: true, site: true },
			],
			[
				'draft-request-audit',
				'api-key-bearer',
				'failed',
				() =>
					scriptedServices(
						{},
						{
							draft: ( options ) => {
								const title = options.prompt.match( /titled "([^"]+)"/ )?.[ 1 ] ?? '';
								return finishedTurn(
									turnResult( {
										events: [
											toolStart( 'r', 'wp_cli', {
												nameOrPath: 'ChatGPT Acceptance',
												command: 'option get blogname',
											} ),
											toolEnd( 'r', 'wp_cli' ),
											toolStart( 'a', 'wp_cli', {
												nameOrPath: 'ChatGPT Acceptance',
												command: `post create --post_status=draft --post_title="${ title }"`,
											} ),
											toolEnd( 'a', 'wp_cli' ),
											answered( 'ok' ),
											completed( 'success' ),
										],
										requests: [ routeRequest( { host: 'openai-api', bearer: 'api-key' } ) ],
									} )
								);
							},
						}
					),
				{ signOut: true, site: true },
			],
			[
				'draft-readback',
				'draft-count',
				'failed',
				() =>
					scriptedServices(
						{},
						{},
						{ 'wp-post-list': () => ( { exitCode: 0, stdout: BASELINE } ) }
					),
				{ signOut: true, site: true },
			],
			[
				'effort-change',
				'settings-refused',
				'failed',
				() => {
					const scripted = scriptedServices();
					const original = scripted.services.sessions.select;
					scripted.services.sessions.select = async ( sessionId, selection ) => {
						if ( selection.reasoningEffort === 'low' ) {
							throw new ChatGptSettingsError( 'refused' );
						}
						return original( sessionId, selection );
					};
					return scripted;
				},
				{ signOut: true, site: true },
			],
			[
				'resume',
				'continuity-lost',
				'failed',
				() =>
					scriptedServices(
						{},
						{
							resume: () =>
								finishedTurn(
									turnResult( {
										pid: 999,
										events: [ answered( 'I do not know.' ), completed( 'success' ) ],
										requests: [ routeRequest( { effort: 'low', assistantMessages: 1 } ) ],
									} )
								),
						}
					),
				{ signOut: true, site: true },
			],
			[
				'active-run-stops-on-sign-out',
				'local-not-cleared',
				'failed',
				() => {
					const scripted = scriptedServices();
					const original = scripted.services.broker.signOut;
					scripted.services.broker.signOut = async ( id ) => ( {
						...( await original( id ) ),
						localCleared: false,
					} );
					return scripted;
				},
				{ signOut: false, site: true },
			],
			[
				'remote-revocation',
				'rotated-grant-usable',
				'failed',
				() => {
					const scripted = scriptedServices();
					scripted.services.tokens.probe = async () => ( {
						tried: true,
						rejected: false,
						terminal: false,
					} );
					return scripted;
				},
				{ signOut: false, site: true },
			],
			[
				'remote-revocation',
				'no-rotated-grant',
				'blocked',
				() => {
					const scripted = scriptedServices();
					scripted.services.tokens.probe = async () => ( {
						tried: false,
						rejected: false,
						terminal: false,
					} );
					return scripted;
				},
				{ signOut: false, site: true },
			],
			[
				'blocked-after-sign-out',
				'inference-after-sign-out',
				'failed',
				() =>
					scriptedServices(
						{},
						{
							'after-sign-out': () => finishedTurn( turnResult() ),
						}
					),
				{ signOut: false, site: true },
			],
		];

		it.each( failures )(
			'after %s fails with %s, keeps that record and cleans up what it owns',
			async ( stage, code, status, make, expected ) => {
				const { services, calls } = make();
				expect( await runChatGptAcceptance( savedArgs(), dependencies( services ) ) ).toBe( 1 );
				const all = records();
				const failedAt = all.findIndex( ( record ) => record.stage === stage );
				expect( all[ failedAt ] ).toMatchObject( { stage, status, code } );
				// Nothing is judged after the failure; cleanup is recorded last.
				expect( all.slice( failedAt + 1 ).map( ( record ) => record.stage ) ).toEqual( [
					'cleanup',
				] );
				expect( all.at( -1 ) ).toMatchObject( { stage: 'cleanup', status: 'passed' } );
				expect( calls.log ).toContain( 'stop-owned' );
				const signOuts = calls.log.filter( ( call ) => call === 'sign-out' ).length;
				const signedOutByStage = [
					'active-run-stops-on-sign-out',
					'remote-revocation',
					'blocked-after-sign-out',
				].includes( stage );
				expect( signOuts ).toBe( expected.signOut || signedOutByStage ? 1 : 0 );
				for ( const step of [ 'cli:site-stop', 'cli:site-delete', 'cli:daemon-stop' ] ) {
					expect( calls.log.includes( step ) ).toBe( expected.site );
				}
				expect( printed.join( '\n' ) ).toContain( stage );
				expectNothingUnsafe( [ 'test-access-token' ] );
			}
		);

		describe( 'an active run when the sign-out begins', () => {
			const before = ( began: number ) => [
				toolStart(
					'c',
					'wp_cli',
					{ nameOrPath: 'ChatGPT Acceptance', command: 'plugin list' },
					began - 500
				),
				toolEnd( 'c', 'wp_cli', undefined, began + 300 ),
			];
			// A sign-out whose remote revocation takes 4 s, with the turn's events stamped against it.
			function activeRun(
				events: ( began: number ) => TimedEvent[],
				requests: ( began: number ) => ObservedRequest[] = ( began ) => [
					routeRequest( { startedAt: began - 1_000, effort: 'low' } ),
				]
			) {
				let now = Date.UTC( 2026, 10, 11, 12 );
				const scripted = scriptedServices(
					{},
					{
						'active-run': () => ( {
							firstRequest: async () => true,
							result: scripted.signOutBegan.then( ( began ) =>
								turnResult( {
									pid: 900,
									startedAt: began - 5_000,
									exitedAt: began + 6_000,
									events: events( began ),
									requests: requests( began ),
								} )
							),
							stop: async () => undefined,
						} ),
					}
				);
				scripted.services.clock = { now: () => now, sleep: scripted.services.clock.sleep };
				const signOut = scripted.services.broker.signOut;
				scripted.services.broker.signOut = async ( id ) => {
					const result = await signOut( id );
					now += 4_000;
					return result;
				};
				return scripted;
			}

			const cases: Array<
				[
					string,
					( began: number ) => TimedEvent[],
					( ( began: number ) => ObservedRequest[] ) | undefined,
					{ status: string; code?: string; observations: Record< string, unknown > },
				]
			> = [
				[
					'stops by its own turn handle within the watch bound',
					( began ) => [
						...before( began ),
						toolStart(
							'd',
							'wp_cli',
							{ nameOrPath: 'ChatGPT Acceptance', command: 'theme list' },
							began + 1_200
						),
						interruptedWith( signedOutText, began + 1_800 ),
						completed( 'error', began + 1_900 ),
					],
					( began ) => [
						routeRequest( { startedAt: began - 1_000, effort: 'low' } ),
						routeRequest( { startedAt: began + 1_000, effort: 'low' } ),
					],
					{
						status: 'passed',
						observations: {
							endedBeforeSignOut: false,
							stopDelayS: 1.8,
							watchPollS: 2,
							toolStartsInWatchWindow: 1,
							toolStartsAfterSignOut: 0,
							routeRequestsInWatchWindow: 1,
							routeRequestsAfterSignOut: 0,
							reportedSignedOut: true,
							stoppedByTurnHandle: true,
							stoppedByBrokerErrorOnly: false,
						},
					},
				],
				[
					'stops on a signed-out error from the broker alone',
					( began ) => [
						...before( began ),
						failedWith( `${ signedOutText } (signed-out)`, began + 1_500 ),
						completed( 'error', began + 1_600 ),
					],
					undefined,
					{
						status: 'passed',
						observations: {
							reportedSignedOut: true,
							stoppedByTurnHandle: false,
							stoppedByBrokerErrorOnly: true,
						},
					},
				],
				[
					'completes successfully after the sign-out began',
					( began ) => [
						...before( began ),
						answered( 'All six commands ran.', began + 3_000 ),
						completed( 'success', began + 3_100 ),
					],
					undefined,
					{
						status: 'failed',
						code: 'completed-after-sign-out',
						observations: { endedSuccessfully: true, stopDelayS: 3 },
					},
				],
				[
					'stops for another reason after the sign-out began',
					( began ) => [
						...before( began ),
						failedWith(
							'Limit reached (HTTP 429, subscription_sharing_usage_limit_exceeded)',
							began + 1_500
						),
						completed( 'error', began + 1_600 ),
					],
					undefined,
					{
						status: 'failed',
						code: 'stopped-for-other-reason',
						observations: { reportedSignedOut: false, endedSuccessfully: false },
					},
				],
				[
					'starts a tool after the watch bound that never finishes',
					( began ) => [
						...before( began ),
						toolStart(
							'e',
							'wp_cli',
							{ nameOrPath: 'ChatGPT Acceptance', command: 'theme list' },
							began + 2_500
						),
						interruptedWith( signedOutText, began + 2_700 ),
						completed( 'error', began + 2_800 ),
					],
					undefined,
					{
						status: 'failed',
						code: 'tool-call-after-sign-out',
						observations: { toolStartsAfterSignOut: 1, toolRunsAfterSignOut: 0 },
					},
				],
				[
					'ended before the sign-out began',
					( began ) => [
						toolStart(
							'c',
							'wp_cli',
							{ nameOrPath: 'ChatGPT Acceptance', command: 'plugin list' },
							began - 3_000
						),
						toolEnd( 'c', 'wp_cli', undefined, began - 2_500 ),
						failedWith(
							'Limit reached (HTTP 429, subscription_sharing_usage_limit_exceeded)',
							began - 2_000
						),
						completed( 'error', began - 1_900 ),
					],
					( began ) => [ routeRequest( { startedAt: began - 4_000, effort: 'low' } ) ],
					{
						status: 'blocked',
						code: 'run-ended-before-sign-out',
						observations: { endedBeforeSignOut: true },
					},
				],
			];

			it.each( cases )( '%s', async ( _name, events, requests, expected ) => {
				const { services } = activeRun( events, requests );
				const code = await runChatGptAcceptance( savedArgs(), dependencies( services ) );
				expect( code ).toBe( expected.status === 'passed' ? 0 : 1 );
				const [ record ] = stageOf( 'active-run-stops-on-sign-out' );
				expect( record ).toMatchObject( {
					status: expected.status,
					...( expected.code ? { code: expected.code } : {} ),
					observations: expect.objectContaining( expected.observations ),
				} );
				expect( record.code === undefined ).toBe( expected.code === undefined );
				expectNothingUnsafe( [ 'test-access-token' ] );
			} );
		} );

		describe( 'the remote revocation of the grant a refresh rotated to before the sign-out', () => {
			it( 'forces a refresh before the sign-out, probes the rotated grant before the retired one, and finds no vault record', async () => {
				const { services, calls } = scriptedServices();
				expect( await runChatGptAcceptance( savedArgs(), dependencies( services ) ) ).toBe( 0 );
				expect( stageOf( 'refresh-before-sign-out' )[ 0 ] ).toMatchObject( {
					status: 'passed',
					observations: { refreshed: true },
				} );
				const { log } = calls;
				expect( log.indexOf( 'refresh' ) ).toBeGreaterThan( -1 );
				expect( log.indexOf( 'refresh' ) ).toBeLessThan( log.indexOf( 'sign-out' ) );
				expect( log.filter( ( call ) => call.startsWith( 'probe:' ) ) ).toEqual( [
					'probe:rotated',
					'probe:retired',
				] );
				expect( stageOf( 'remote-revocation' )[ 0 ] ).toMatchObject( {
					status: 'passed',
					observations: expect.objectContaining( {
						vaultRecordAfterSignOut: false,
						rotatedRevokedBySignOut: true,
						rotatedRefreshRejected: true,
						rejectionTerminal: true,
						retiredRefreshRejected: true,
					} ),
				} );
			} );

			const probing =
				( rejected: { rotated?: boolean; retired?: boolean } ) =>
				async ( which: 'retired' | 'rotated' ) => ( {
					tried: true,
					rejected: rejected[ which ] ?? true,
					terminal: rejected[ which ] ?? true,
				} );

			it.each( [
				[
					'refresh-before-sign-out',
					'refresh-not-forced',
					( services: ChatGptAcceptanceServices ) => {
						services.tokens.refreshes = () => 0;
					},
				],
				[
					'remote-revocation',
					'vault-record-left',
					( services: ChatGptAcceptanceServices ) => {
						// The broker said it cleared the record; the file says otherwise.
						services.broker.vaultRecordExists = () => true;
					},
				],
				[
					'remote-revocation',
					'rotated-grant-usable',
					( services: ChatGptAcceptanceServices ) => {
						services.tokens.probe = probing( { rotated: false } );
					},
				],
				[
					'remote-revocation',
					'rotated-not-revoked-by-sign-out',
					( services: ChatGptAcceptanceServices ) => {
						services.tokens.revocations = () => ( {
							total: 1,
							confirmed: 1,
							rotatedRevoked: false,
						} );
					},
				],
				[
					'remote-revocation',
					'retired-refresh-accepted',
					( services: ChatGptAcceptanceServices ) => {
						services.tokens.probe = probing( { retired: false } );
					},
				],
			] )( 'fails %s with %s, and still cleans up', async ( stage, code, change ) => {
				const { services } = scriptedServices();
				change( services );
				expect( await runChatGptAcceptance( savedArgs(), dependencies( services ) ) ).toBe( 1 );
				const all = records();
				const failedAt = all.findIndex( ( record ) => record.stage === stage );
				expect( all[ failedAt ] ).toMatchObject( { stage, status: 'failed', code } );
				expect( all.slice( failedAt + 1 ).map( ( record ) => record.stage ) ).toEqual( [
					'cleanup',
				] );
			} );
		} );

		it( 'keeps the original failure when cleanup also fails', async () => {
			const { services, calls } = scriptedServices(
				{},
				{},
				{
					'site-create': () => ( { exitCode: 1, stdout: '' } ),
					'site-stop': () => ( { exitCode: 1, stdout: '' } ),
				}
			);
			const signOut = services.broker.signOut;
			services.broker.signOut = async ( id ) => {
				await signOut( id );
				throw new Error(
					'The keychain went away at https://example.test with someone@example.com'
				);
			};
			expect( await runChatGptAcceptance( savedArgs(), dependencies( services ) ) ).toBe( 1 );
			expect( stageOf( 'disposable-site' )[ 0 ] ).toMatchObject( {
				status: 'failed',
				code: 'site-create-failed',
			} );
			expect( records().at( -1 ) ).toMatchObject( {
				stage: 'cleanup',
				status: 'failed',
				code: 'cleanup-failed',
				observations: expect.objectContaining( { signOutFailed: true, siteStopFailed: true } ),
			} );
			expect( calls.log ).toContain( 'cli:daemon-stop' );
			const summary = printed.join( '\n' );
			expect( summary.indexOf( 'site-create-failed' ) ).toBeLessThan(
				summary.lastIndexOf( 'cleanup-failed' )
			);
			expectNothingUnsafe();
		} );

		it( 'on an interrupt during sign-in, cancels the attempt and waits for it before cleaning up', async () => {
			const { services, calls } = scriptedServices();
			const outcome = deferred< { ok: false; code: 'cancelled'; message: string } >();
			services.signIn.wait = () => outcome.promise;
			services.signIn.cancel = () => {
				calls.log.push( 'cancel' );
				outcome.resolve( { ok: false, code: 'cancelled', message: 'cancelled' } );
				return true;
			};
			const running = runChatGptAcceptance( savedArgs(), dependencies( services ) );
			await vi.waitFor( () => expect( calls.log ).toContain( 'begin:vault' ) );
			await vi.waitFor( () => expect( interrupt ).not.toBeNull() );
			interrupt?.();
			expect( await running ).toBe( 130 );
			expect( stageOf( 'sign-in' )[ 0 ] ).toMatchObject( {
				status: 'failed',
				code: 'interrupted',
			} );
			expect( calls.log ).toContain( 'cancel' );
			expect( records().at( -1 )?.stage ).toBe( 'cleanup' );
		} );

		it( 'signs out a first sign-in that still commits after the interrupt cancelled it', async () => {
			const { services, calls } = scriptedServices();
			const signedIn = services.signIn.wait;
			const outcome = deferred< Awaited< ReturnType< typeof signedIn > > >();
			services.signIn.wait = () => outcome.promise;
			services.signIn.cancel = ( attemptId ) => {
				calls.log.push( 'cancel' );
				// The browser came back while the cancel was on its way: the attempt saves.
				void signedIn( attemptId ).then( outcome.resolve );
				return true;
			};
			const running = runChatGptAcceptance( savedArgs(), dependencies( services ) );
			await vi.waitFor( () => expect( calls.log ).toContain( 'begin:vault' ) );
			await vi.waitFor( () => expect( interrupt ).not.toBeNull() );
			interrupt?.();
			expect( await running ).toBe( 130 );
			expect( stageOf( 'sign-in' )[ 0 ] ).toMatchObject( {
				status: 'failed',
				code: 'interrupted',
			} );
			expect( calls.log.indexOf( 'cancel' ) ).toBeLessThan( calls.log.indexOf( 'sign-out' ) );
			expect( records().at( -1 ) ).toMatchObject( {
				stage: 'cleanup',
				status: 'passed',
				observations: expect.objectContaining( { testRegistrationSignedOut: true } ),
			} );
			expect( openAcceptanceEvidence( runDir, 'chatgpt' ).readState() ).toMatchObject( {
				registrationId: REGISTRATION,
				storage: 'vault',
			} );
		} );

		it( 'records a requested gate the image service can’t serve as blocked, never failed, and goes on', async () => {
			const { services } = scriptedServices();
			expect(
				await runChatGptAcceptance( savedArgs( '--gates', 'T3' ), dependencies( services ) )
			).toBe( 0 );
			expect( stageOf( 'gate-t3-image-service-row' )[ 0 ] ).toMatchObject( {
				status: 'blocked',
				code: 'image-service-not-configured',
			} );
			expect( stageOf( 'blocked-after-sign-out' )[ 0 ].status ).toBe( 'passed' );
		} );

		it( 'passes gate T1 only when the route takes an image tool result the reply then uses', async () => {
			let marker = '';
			const { services } = scriptedServices(
				{},
				{
					'gate-t1': () =>
						finishedTurn(
							turnResult( {
								events: [
									toolStart( 's', 'take_screenshot', { url: 'site' } ),
									toolEnd( 's', 'take_screenshot' ),
									answered( `The title reads ${ marker }.` ),
									completed( 'success' ),
								],
								requests: [
									routeRequest( { id: 1, effort: 'low' } ),
									routeRequest( { id: 2, effort: 'low', imageToolOutputs: 1, functionOutputs: 1 } ),
								],
								responses: [
									{
										kind: 'response',
										id: 2,
										pid: 4242,
										endedAt: at(),
										status: 200,
										reasoningOutputs: 0,
										functionCallOutputs: 0,
										completed: true,
										failed: false,
									},
								],
							} )
						),
				}
			);
			const runCli = services.processes.runCli;
			services.processes.runCli = async ( label, args ) => {
				if ( label === 'wp-blogname' ) {
					marker = args.at( -1 ) ?? '';
				}
				return runCli( label, args );
			};
			const startTurn = services.processes.startTurn;
			const toolImages: Record< string, boolean | undefined > = {};
			services.processes.startTurn = ( options ) => {
				toolImages[ options.label ] = options.toolImages;
				return startTurn( options );
			};
			expect(
				await runChatGptAcceptance( savedArgs( '--gates', 'T1' ), dependencies( services ) )
			).toBe( 0 );
			// Only the live check's own turn turns images in tool results on, through the override.
			expect( toolImages[ 'gate-t1' ] ).toBe( true );
			expect(
				Object.entries( toolImages ).filter( ( [ label, on ] ) => label !== 'gate-t1' && on )
			).toEqual( [] );
			expect( Object.keys( toolImages ).length ).toBeGreaterThan( 1 );
			expect( stageOf( 'gate-t1-image-tool-result' )[ 0 ] ).toMatchObject( {
				status: 'passed',
				observations: expect.objectContaining( {
					imageToolOutputsSent: 1,
					routeAcceptedImageResult: true,
					markerReadFromImage: true,
					otherToolCalls: 0,
				} ),
			} );
		} );

		it( 'loads the tool-image override into a turn’s CLI process only when the turn asks for it, after the observer', () => {
			const scripts = {
				observer: path.join( os.tmpdir(), 'cli', 'chatgpt-acceptance-observer.mjs' ),
				toolImages: path.join( os.tmpdir(), 'cli', 'chatgpt-acceptance-tool-images.mjs' ),
			};
			const imports = ( argv: string[] ) =>
				argv.filter( ( _arg, index ) => argv[ index - 1 ] === '--import' );

			expect( imports( acceptanceTurnExecArgv( scripts, {} ) ) ).toEqual( [
				pathToFileURL( scripts.observer ).href,
			] );
			expect( imports( acceptanceTurnExecArgv( scripts, { toolImages: false } ) ) ).toEqual( [
				pathToFileURL( scripts.observer ).href,
			] );
			expect( imports( acceptanceTurnExecArgv( scripts, { toolImages: true } ) ) ).toEqual( [
				pathToFileURL( scripts.observer ).href,
				pathToFileURL( scripts.toolImages ).href,
			] );
		} );

		it( 'passes gate T3 only when the service details arrive before the result is persisted', async () => {
			const imageTurn = ( persistedAtReceipt?: boolean | null ) => () =>
				finishedTurn(
					turnResult( {
						events: [
							toolStart( 'g', 'generate_images', { prompt: 'a plain blue square' } ),
							{
								...toolEnd( 'g', 'generate_images', { studioService: { service: 'images' } } ),
								...( persistedAtReceipt === undefined ? {} : { persistedAtReceipt } ),
							},
							answered( 'DONE' ),
							completed( 'success' ),
						],
					} )
				);
			const early = scriptedServices(
				{ imageServiceConfigured: async () => true },
				{ 'gate-t3': imageTurn( false ) }
			);
			expect(
				await runChatGptAcceptance( savedArgs( '--gates', 'T3' ), dependencies( early.services ) )
			).toBe( 0 );
			expect( stageOf( 'gate-t3-image-service-row' )[ 0 ] ).toMatchObject( {
				status: 'passed',
				observations: expect.objectContaining( {
					generateImagesCalls: 1,
					detailsDelivered: true,
					deliveredBeforePersisted: true,
				} ),
			} );

			fs.rmSync( runDir, { recursive: true, force: true } );
			const late = scriptedServices(
				{ imageServiceConfigured: async () => true },
				{ 'gate-t3': imageTurn( true ) }
			);
			expect(
				await runChatGptAcceptance( savedArgs( '--gates', 'T3' ), dependencies( late.services ) )
			).toBe( 1 );
			expect( stageOf( 'gate-t3-image-service-row' )[ 0 ] ).toMatchObject( {
				status: 'failed',
				code: 'details-only-after-persisting',
				observations: expect.objectContaining( { deliveredBeforePersisted: false } ),
			} );
			expect( stageOf( 'blocked-after-sign-out' )[ 0 ].status ).toBe( 'passed' );
		} );

		it.each( [
			[ 'the session file couldn’t be read when the result arrived', null ],
			[ 'no session file was named to read', undefined ],
		] )( 'fails gate T3, never passes it, when %s', async ( _label, persistedAtReceipt ) => {
			const { services } = scriptedServices(
				{ imageServiceConfigured: async () => true },
				{
					'gate-t3': () =>
						finishedTurn(
							turnResult( {
								events: [
									toolStart( 'g', 'generate_images', { prompt: 'a plain blue square' } ),
									{
										...toolEnd( 'g', 'generate_images', { studioService: { service: 'images' } } ),
										...( persistedAtReceipt === undefined ? {} : { persistedAtReceipt } ),
									},
									answered( 'DONE' ),
									completed( 'success' ),
								],
							} )
						),
				}
			);
			expect(
				await runChatGptAcceptance( savedArgs( '--gates', 'T3' ), dependencies( services ) )
			).toBe( 1 );
			expect( stageOf( 'gate-t3-image-service-row' )[ 0 ] ).toMatchObject( {
				status: 'failed',
				code: 'session-file-unreadable',
				observations: expect.objectContaining( {
					detailsDelivered: true,
					persistenceChecked: false,
					deliveredBeforePersisted: false,
				} ),
			} );
		} );

		it( 'blocks gate T2 when no reasoning item was produced, and fails it when one was dropped', async () => {
			const reasoningTurn = ( replayed: number, produced: number ) => () =>
				finishedTurn(
					turnResult( {
						events: [
							toolStart( 'i', 'site_info', { nameOrPath: 'ChatGPT Acceptance' } ),
							toolEnd( 'i', 'site_info' ),
							answered( '42' ),
							completed( 'success' ),
						],
						requests: [
							routeRequest( { id: 1, effort: 'low' } ),
							routeRequest( {
								id: 2,
								effort: 'low',
								reasoningItems: replayed,
								functionOutputs: 1,
							} ),
						],
						responses: [
							{
								kind: 'response',
								id: 1,
								pid: 4242,
								endedAt: at(),
								status: 200,
								reasoningOutputs: produced,
								functionCallOutputs: 1,
								completed: true,
								failed: false,
							},
							{
								kind: 'response',
								id: 2,
								pid: 4242,
								endedAt: at(),
								status: 200,
								reasoningOutputs: 0,
								functionCallOutputs: 0,
								completed: true,
								failed: false,
							},
						],
					} )
				);
			const blocked = scriptedServices( {}, { 'gate-t2': reasoningTurn( 0, 0 ) } );
			expect(
				await runChatGptAcceptance( savedArgs( '--gates', 'T2' ), dependencies( blocked.services ) )
			).toBe( 0 );
			expect( stageOf( 'gate-t2-reasoning-replay' )[ 0 ] ).toMatchObject( {
				status: 'blocked',
				code: 'no-reasoning-item',
			} );
			// At the run's starting effort, before the chat moves to the other one.
			const { log } = blocked.calls;
			expect( log.indexOf( 'select:medium' ) ).toBeLessThan( log.indexOf( 'turn:gate-t2' ) );
			expect( log.indexOf( 'turn:gate-t2' ) ).toBeLessThan( log.indexOf( 'select:low' ) );
			expect( SAVED_STAGE_NAMES.indexOf( 'gate-t2-reasoning-replay' ) ).toBeLessThan(
				SAVED_STAGE_NAMES.indexOf( 'effort-change' )
			);

			fs.rmSync( runDir, { recursive: true, force: true } );
			const dropped = scriptedServices( {}, { 'gate-t2': reasoningTurn( 0, 1 ) } );
			expect(
				await runChatGptAcceptance( savedArgs( '--gates', 'T2' ), dependencies( dropped.services ) )
			).toBe( 1 );
			expect( stageOf( 'gate-t2-reasoning-replay' )[ 0 ] ).toMatchObject( {
				status: 'failed',
				code: 'reasoning-not-replayed',
			} );
			// A failed optional gate doesn't stop the required stages after it.
			expect( stageOf( 'blocked-after-sign-out' )[ 0 ].status ).toBe( 'passed' );
		} );

		describe( 'gate T4: a read-only smoke turn per qualified model and effort', () => {
			// Numbered in the table's order: models, then each model's efforts.
			const pairs = Object.entries( CHATGPT_MODEL_CAPABILITIES )
				.flatMap( ( [ model, capability ] ) =>
					capability.reasoningEfforts.map( ( effort ) => ( { model, effort } ) )
				)
				.map( ( pair, index ) => ( { ...pair, label: `smoke-${ index + 1 }` } ) );
			const readyTurn =
				( effortOnWire?: string ) =>
				( options: TurnOptions ): AcceptanceTurn => {
					const pair = pairs.find( ( item ) => item.label === options.label );
					return finishedTurn(
						turnResult( {
							events: [ answered( 'READY' ), completed( 'success' ) ],
							requests: [
								routeRequest( {
									model: pair?.model,
									effort: effortOnWire ?? pair?.effort,
								} ),
							],
						} )
					);
				};

			it( 'is one stage per pair of the route’s table, skipped unless requested', async () => {
				expect( pairs.length ).toBeGreaterThan( 1 );
				for ( const { label } of pairs ) {
					expect( SAVED_STAGE_NAMES ).toContain( `gate-t4-${ label }` );
				}
				expect( SAVED_STAGE_NAMES.indexOf( 'model-discovery' ) ).toBeLessThan(
					SAVED_STAGE_NAMES.indexOf( `gate-t4-${ pairs[ 0 ].label }` )
				);
				expect(
					parseChatGptAcceptanceArgs( [
						'--scenario',
						'saved',
						'--run-dir',
						runDir,
						'--gates',
						'T4',
					] )
				).toMatchObject( { ok: true, options: { gates: [ 'T4' ] } } );
				printed = [];
				await runChatGptAcceptance(
					[ '--scenario', 'saved', '--run-dir', runDir ],
					dependencies( undefined, { createServices: vi.fn() } )
				);
				for ( const { label, model, effort } of pairs ) {
					expect( printed ).toContain(
						`  gate-t4-${ label } (optional: runs with --gates T4): ${ model } at ${ effort } effort`
					);
				}
				const { services, calls } = scriptedServices();
				expect( await runChatGptAcceptance( savedArgs(), dependencies( services ) ) ).toBe( 0 );
				for ( const { label } of pairs ) {
					expect( stageOf( `gate-t4-${ label }` )[ 0 ] ).toMatchObject( {
						status: 'skipped',
						code: 'not-requested',
					} );
				}
				expect( calls.log.filter( ( call ) => call.startsWith( 'turn:smoke-' ) ) ).toEqual( [] );
			} );

			it( 'smokes each pair in its own chat on the route, recording each separately', async () => {
				const turns = Object.fromEntries( pairs.map( ( { label } ) => [ label, readyTurn() ] ) );
				const { services, calls } = scriptedServices( {}, turns );
				expect(
					await runChatGptAcceptance( savedArgs( '--gates', 'T4' ), dependencies( services ) )
				).toBe( 0 );
				for ( const { label, effort } of pairs ) {
					expect( stageOf( `gate-t4-${ label }` ) ).toEqual( [
						expect.objectContaining( {
							status: 'passed',
							observations: expect.objectContaining( {
								modelListed: true,
								modelRequests: 1,
								apiKeyBearers: 0,
								otherProviderRequests: 0,
								allOnSelectedModel: true,
								allAtSelectedEffort: true,
								answeredReady: true,
								unexpectedToolCalls: 0,
							} ),
						} ),
					] );
					expect( calls.log ).toContain( `turn:${ label }` );
					expect( calls.log ).toContain( `select:${ effort }` );
					expect( calls.prompts[ label ] ).toMatch( /READY/ );
				}
				// Each pair in a chat of its own, with no site.
				expect(
					calls.log.filter( ( call ) => call === 'session:global' ).length
				).toBeGreaterThanOrEqual( pairs.length );
			} );

			it( 'fails a pair whose requests used another effort, blocks one the account does not list, and goes on', async () => {
				const [ substituted, ...rest ] = pairs;
				const turns = Object.fromEntries(
					pairs.map( ( { label } ) => [
						label,
						label === substituted.label ? readyTurn( 'xhigh' ) : readyTurn(),
					] )
				);
				const { services } = scriptedServices( {}, turns );
				expect(
					await runChatGptAcceptance( savedArgs( '--gates', 'T4' ), dependencies( services ) )
				).toBe( 1 );
				expect( stageOf( `gate-t4-${ substituted.label }` )[ 0 ] ).toMatchObject( {
					status: 'failed',
					code: 'effort-substituted',
				} );
				for ( const { label } of rest ) {
					expect( stageOf( `gate-t4-${ label }` )[ 0 ].status ).toBe( 'passed' );
				}
				expect( stageOf( 'blocked-after-sign-out' )[ 0 ].status ).toBe( 'passed' );

				// Each pair reads the account's list again: here the run's own model is
				// listed for discovery, and nothing is listed by the time the gate runs.
				fs.rmSync( runDir, { recursive: true, force: true } );
				const unlisted = scriptedServices( {}, turns );
				let reads = 0;
				unlisted.services.broker.readModels = async ( connectionId, revision ) => ( {
					connectionId,
					revision,
					checkedAt: '',
					models: reads++ === 0 ? [ { id: 'gpt-6-luna', label: 'GPT-6 Luna' } ] : [],
					lastError: null,
				} );
				expect(
					await runChatGptAcceptance(
						savedArgs( '--gates', 'T4' ),
						dependencies( unlisted.services )
					)
				).toBe( 0 );
				for ( const { label } of pairs ) {
					expect( stageOf( `gate-t4-${ label }` )[ 0 ] ).toMatchObject( {
						status: 'blocked',
						code: 'model-not-listed',
					} );
				}
				expect( unlisted.calls.log.filter( ( call ) => call.startsWith( 'turn:smoke-' ) ) ).toEqual(
					[]
				);
			} );
		} );
	} );

	describe( 'a dedicated eval profile: provision and retire', () => {
		const provisionArgs = () => [ '--live', '--scenario', 'provision', '--run-dir', runDir ];
		const retireArgs = () => [ '--live', '--scenario', 'retire', '--run-dir', runDir ];

		it( 'takes no model, effort or gates, and starts or continues a run as each scenario does', async () => {
			for ( const scenario of [ 'provision', 'retire' ] ) {
				expect(
					parseChatGptAcceptanceArgs( [
						'--scenario',
						scenario,
						'--run-dir',
						runDir,
						'--gates',
						'T1',
					] )
				).toMatchObject( { ok: false, problem: 'option-not-for-profile' } );
				expect(
					parseChatGptAcceptanceArgs( [ '--scenario', scenario, '--run-dir', runDir ] )
				).toMatchObject( { ok: true, options: { scenario, gates: [] } } );
			}
			expect( acceptanceStartsNewRun( 'provision' ) ).toBe( true );
			expect( acceptanceStartsNewRun( 'saved' ) ).toBe( true );
			expect( acceptanceStartsNewRun( 'retire' ) ).toBe( false );
			expect( acceptanceStartsNewRun( 'session' ) ).toBe( false );

			fs.mkdirSync( runDir, { recursive: true } );
			fs.writeFileSync( path.join( runDir, 'left-over' ), '' );
			expect( await runChatGptAcceptance( provisionArgs(), dependencies() ) ).toBe( 2 );
			expect( printed.join( '\n' ) ).toMatch( /empty/ );
		} );

		it( 'without --live, prints the provision plan and creates nothing', async () => {
			const create = vi.fn();
			expect(
				await runChatGptAcceptance(
					[ '--scenario', 'provision', '--run-dir', runDir ],
					dependencies( undefined, { createServices: create } )
				)
			).toBe( 2 );
			expect( create ).not.toHaveBeenCalled();
			expect( fs.existsSync( runDir ) ).toBe( false );
			const output = printed.join( '\n' );
			expect( output ).toMatch( /Dry check only/ );
			for ( const stage of PROVISION_STAGE_NAMES ) {
				expect( output ).toContain( stage );
			}
		} );

		it( 'provisions: signs one registration in to the run’s profile with secure storage and leaves it signed in', async () => {
			const { services, calls } = scriptedServices();
			expect( await runChatGptAcceptance( provisionArgs(), dependencies( services ) ) ).toBe( 0 );
			expect( records().map( ( record ) => [ record.stage, record.status ] ) ).toEqual( [
				...PROVISION_STAGE_NAMES.map( ( stage ) => [ stage, 'passed' ] ),
				[ 'cleanup', 'passed' ],
			] );
			expect( stageOf( 'profile-sign-in' )[ 0 ].observations ).toMatchObject( {
				signedIn: true,
				storedInVault: true,
				leftSignedIn: true,
			} );
			expect( calls.log.filter( ( call ) => call.startsWith( 'begin:' ) ) ).toEqual( [
				'begin:vault',
			] );
			expect( calls.log ).not.toContain( 'sign-out' );
			// The profile stays signed in for evals, so its vault key item stays too.
			expect( calls.log ).not.toContain( 'remove-vault-key' );
			expect( stageOf( 'prerequisites' )[ 0 ].observations ).toMatchObject( {
				vaultKeyScoped: true,
			} );
			expect( calls.log.some( ( call ) => call.startsWith( 'turn:' ) ) ).toBe( false );
			expect( calls.log.some( ( call ) => call.startsWith( 'cli:' ) ) ).toBe( false );
			expect( openAcceptanceEvidence( runDir, 'chatgpt' ).readState() ).toMatchObject( {
				registrationId: REGISTRATION,
				storage: 'vault',
				vaultKeySuffix: VAULT_KEY_SUFFIX,
			} );
			expect( openAcceptanceEvidence( runDir, 'chatgpt' ).readManifest()?.runs ).toEqual( [
				expect.objectContaining( { run: 1, scenario: 'provision', gates: [] } ),
			] );
			expect( process.env.DEV_CONFIG_DIR ).toBe( acceptanceRunPaths( runDir ).profileDir );
			expect( printed.join( '\n' ) ).toMatch( /STUDIO_EVAL_CHATGPT_PROFILE/ );
			expectNothingUnsafe( [ 'test-access-token' ] );
		} );

		it( 'signs a registration it signed in back out when provisioning fails', async () => {
			const { services, calls } = scriptedServices();
			services.broker.vaultRecordExists = () => false;
			expect( await runChatGptAcceptance( provisionArgs(), dependencies( services ) ) ).toBe( 1 );
			expect( stageOf( 'profile-sign-in' )[ 0 ] ).toMatchObject( {
				status: 'failed',
				code: 'vault-record-missing',
			} );
			expect( calls.log.filter( ( call ) => call === 'sign-out' ) ).toHaveLength( 1 );
			expect( calls.log.indexOf( 'sign-out' ) ).toBeLessThan(
				calls.log.indexOf( 'remove-vault-key' )
			);
			expect( stageOf( 'cleanup' )[ 0 ].observations ).toMatchObject( {
				testRegistrationSignedOut: true,
				vaultKeyRemoved: true,
			} );
		} );

		it( 'blocks before the sign-in when the run profile would keep its vault key under the unscoped item', async () => {
			const { services, calls } = scriptedServices();
			services.broker.vaultKeyItem = () => UNSCOPED_VAULT_KEY_ITEM;
			expect( await runChatGptAcceptance( provisionArgs(), dependencies( services ) ) ).toBe( 1 );
			expect( stageOf( 'prerequisites' )[ 0 ] ).toMatchObject( {
				status: 'blocked',
				code: 'vault-key-not-scoped',
			} );
			expect( stageOf( 'profile-sign-in' ) ).toEqual( [] );
			expect( calls.log.some( ( call ) => call.startsWith( 'begin:' ) ) ).toBe( false );
			expect( calls.log ).not.toContain( 'remove-vault-key' );
		} );

		describe( 'retire', () => {
			function provisioned() {
				fs.mkdirSync( runDir, { recursive: true } );
				const evidence = openAcceptanceEvidence( runDir, 'chatgpt' );
				evidence.startRun( {
					scenario: 'provision',
					createdOn: '2026-11-11',
					source: { sha: 'f'.repeat( 40 ), dirty: false },
					platform: { os: 'win32', release: '10.0.26320', arch: 'x64' },
					runtime: { node: '24.22.1', npm: '11.13.0' },
					build: { cliVersion: '1.7.3', buildId: 'a1b2c3d4e5f6' },
					model: 'gpt-6-luna',
					effort: 'medium',
					gates: [],
				} );
				evidence.writeState( { schemaVersion: 1, registrationId: REGISTRATION, storage: 'vault' } );
			}

			// Scripted services with the provisioned registration signed in.
			function signedIn( overrides: Partial< ChatGptAcceptanceServices[ 'broker' ] > = {} ) {
				const scripted = scriptedServices();
				const { services } = scripted;
				const signedInAccount = {
					registrationId: REGISTRATION,
					issuer: 'https://auth.openai.com',
					subject: 'test-subject',
					email: null,
					clientId: 'test-client',
					label: 'Test',
					revision: 1,
					logoutGeneration: 0,
					storage: 'vault' as const,
					state: 'signed-in' as const,
					createdAt: '',
					updatedAt: '',
				};
				let signedOut = false;
				services.broker = {
					...services.broker,
					readAccount: async () =>
						signedOut ? { ...signedInAccount, state: 'signed-out' as const } : signedInAccount,
					signOut: async () => {
						scripted.calls.log.push( 'sign-out' );
						signedOut = true;
						return { localCleared: true, remoteRevocationConfirmed: true };
					},
					removeProfileVaultKey: async () => {
						scripted.calls.log.push( 'remove-vault-key' );
						return signedOut ? 'removed' : 'records-exist';
					},
					...overrides,
				};
				return scripted;
			}

			it( 'refuses a run directory without a provisioned profile, before anything runs', async () => {
				const create = vi.fn();
				expect(
					await runChatGptAcceptance(
						retireArgs(),
						dependencies( undefined, { createServices: create } )
					)
				).toBe( 2 );
				fs.mkdirSync( runDir, { recursive: true } );
				printed = [];
				expect(
					await runChatGptAcceptance(
						retireArgs(),
						dependencies( undefined, { createServices: create } )
					)
				).toBe( 2 );
				expect( printed.join( '\n' ) ).toMatch( /no manifest/i );

				openAcceptanceEvidence( runDir, 'chatgpt' ).startRun( {
					scenario: 'saved',
					createdOn: '2026-11-11',
					source: { sha: SHA, dirty: false },
					platform: { os: 'win32', release: '10.0.26320', arch: 'x64' },
					runtime: { node: '24.22.1', npm: '11.13.0' },
					build: { cliVersion: '1.7.3', buildId: 'a1b2c3d4e5f6' },
					model: 'gpt-6-luna',
					effort: 'medium',
					gates: [],
				} );
				printed = [];
				expect(
					await runChatGptAcceptance(
						retireArgs(),
						dependencies( undefined, { createServices: create } )
					)
				).toBe( 2 );
				expect( printed.join( '\n' ) ).toMatch( /no dedicated eval profile/ );
				expect( create ).not.toHaveBeenCalled();
			} );

			it( 'signs the profile’s registration out, from any commit, and reports the remote revocation', async () => {
				provisioned();
				const { services, calls } = signedIn();
				expect( await runChatGptAcceptance( retireArgs(), dependencies( services ) ) ).toBe( 0 );
				expect( records().map( ( record ) => [ record.stage, record.status ] ) ).toEqual( [
					...RETIRE_STAGE_NAMES.map( ( stage ) => [ stage, 'passed' ] ),
					[ 'cleanup', 'passed' ],
				] );
				expect( stageOf( 'profile-sign-out' )[ 0 ].observations ).toMatchObject( {
					wasSignedIn: true,
					localCleared: true,
					remoteRevocationConfirmed: true,
					vaultKeyRemoved: true,
				} );
				expect( calls.log.filter( ( call ) => call === 'sign-out' ) ).toHaveLength( 1 );
				// Removed once, by the stage, after its sign-out: cleanup has nothing left to remove.
				expect( calls.log.filter( ( call ) => call === 'remove-vault-key' ) ).toHaveLength( 1 );
				expect( calls.log.indexOf( 'sign-out' ) ).toBeLessThan(
					calls.log.indexOf( 'remove-vault-key' )
				);
				expect( calls.log.some( ( call ) => call.startsWith( 'begin:' ) ) ).toBe( false );
				expectNothingUnsafe( [ 'test-access-token' ] );
			} );

			it( 'fails when the profile’s vault key item couldn’t be removed after the sign-out', async () => {
				provisioned();
				const kept = signedIn( { removeProfileVaultKey: async () => 'records-exist' } );
				expect( await runChatGptAcceptance( retireArgs(), dependencies( kept.services ) ) ).toBe(
					1
				);
				expect( stageOf( 'profile-sign-out' )[ 0 ] ).toMatchObject( {
					status: 'failed',
					code: 'vault-key-not-removed',
					observations: expect.objectContaining( { localCleared: true, vaultKeyRemoved: false } ),
				} );
				expect( records().at( -1 ) ).toMatchObject( {
					stage: 'cleanup',
					status: 'failed',
					observations: expect.objectContaining( { vaultKeyRemoved: false } ),
				} );

				const unreachable = signedIn( {
					removeProfileVaultKey: async () => {
						throw new Error( 'The keychain went away.' );
					},
				} );
				expect(
					await runChatGptAcceptance( retireArgs(), dependencies( unreachable.services ) )
				).toBe( 1 );
				expect( stageOf( 'profile-sign-out' )[ 1 ] ).toMatchObject( {
					status: 'failed',
					code: 'vault-key-not-removed',
				} );
			} );

			it( 'still removes the vault key item of a profile already signed out', async () => {
				provisioned();
				// Nothing saved needs the key any more.
				const { services, calls } = signedIn( {
					readAccount: async () => null,
					removeProfileVaultKey: async () => 'removed',
				} );
				expect( await runChatGptAcceptance( retireArgs(), dependencies( services ) ) ).toBe( 1 );
				expect( stageOf( 'profile-sign-out' )[ 0 ] ).toMatchObject( {
					status: 'blocked',
					code: 'already-signed-out',
				} );
				expect( calls.log ).not.toContain( 'sign-out' );
				expect( records().at( -1 ) ).toMatchObject( {
					stage: 'cleanup',
					status: 'passed',
					observations: expect.objectContaining( { vaultKeyRemoved: true } ),
				} );
			} );

			it( 'fails when the remote revocation is not confirmed, and blocks a profile already signed out', async () => {
				provisioned();
				const unconfirmed = signedIn( {
					signOut: async () => ( { localCleared: true, remoteRevocationConfirmed: false } ),
				} );
				expect(
					await runChatGptAcceptance( retireArgs(), dependencies( unconfirmed.services ) )
				).toBe( 1 );
				expect( stageOf( 'profile-sign-out' )[ 0 ] ).toMatchObject( {
					status: 'failed',
					code: 'remote-revocation-unconfirmed',
					observations: { localCleared: true, remoteRevocationConfirmed: false },
				} );

				const { services } = signedIn( {
					readAccount: async () => null,
				} );
				expect( await runChatGptAcceptance( retireArgs(), dependencies( services ) ) ).toBe( 1 );
				expect( stageOf( 'profile-sign-out' )[ 1 ] ).toMatchObject( {
					status: 'blocked',
					code: 'already-signed-out',
				} );
			} );
		} );
	} );

	describe( 'session scenario with scripted services', () => {
		const sessionArgs = () => [ '--live', '--scenario', 'session', '--run-dir', runDir ];

		// A saved run's manifest and state, and session services that pass every stage.
		function scriptedSession(
			turns: Partial< Record< string, ( options: TurnOptions ) => AcceptanceTurn > > = {}
		) {
			fs.mkdirSync( runDir, { recursive: true } );
			const evidence = openAcceptanceEvidence( runDir, 'chatgpt' );
			evidence.startRun( {
				scenario: 'saved',
				createdOn: '2026-11-11',
				source: { sha: SHA, dirty: false },
				platform: { os: 'win32', release: '10.0.26320', arch: 'x64' },
				runtime: { node: '24.22.1', npm: '11.13.0' },
				build: { cliVersion: '1.7.3', buildId: 'a1b2c3d4e5f6' },
				model: 'gpt-6-luna',
				effort: 'medium',
				gates: [],
			} );
			evidence.writeState( { schemaVersion: 1, registrationId: REGISTRATION, storage: 'vault' } );
			const notOffered = () =>
				finishedTurn(
					turnResult( {
						exitCode: 1,
						startedAt: at( 100 ),
						exitedAt: at( 400 ),
						events: [
							{ ...cliError( disconnectedText ), receivedAt: at( 250 ) },
							completed( 'error', at( 300 ) ),
						],
						requests: [],
					} )
				);
			const scripted = scriptedServices(
				{},
				{
					'offered-fork': () =>
						finishedTurn(
							turnResult( {
								tokenAsks: 1,
								tokensHandedOut: 1,
								events: [ answered( 'READY' ), completed( 'success' ) ],
							} )
						),
					unoffered: notOffered,
					'window-fork': notOffered,
					...turns,
				}
			);
			const { services, calls } = scripted;
			// The held refresh's renewal waits for the release, then finds the account signed out.
			let renewal: Promise< void > | null = null;
			services.tokens = {
				holdNextRefresh: () => {
					const gate = deferred();
					renewal = gate.promise;
					calls.log.push( 'hold' );
					return {
						held: Promise.resolve( true ),
						release: () => {
							calls.log.push( 'release' );
							gate.resolve();
						},
					};
				},
				refreshes: () => 0,
				probe: async () => ( { tried: true, rejected: true, terminal: true } ),
				revocations: () => ( { total: 1, confirmed: 1, rotatedRevoked: true } ),
				settle: async () => {
					calls.log.push( 'settle' );
				},
			};
			const readAccount = services.broker.readAccount;
			services.broker.getAccessToken = async ( id ) => {
				if ( renewal ) {
					await renewal;
					if ( ( await readAccount( id ) )?.state !== 'signed-in' ) {
						throw new ChatGptConnectionError( 'signed-out' );
					}
				}
				return 'test-access-token';
			};
			// The app still offers the session until the held refresh settles.
			let released = false;
			const hold = services.tokens.holdNextRefresh;
			services.tokens.holdNextRefresh = () => {
				const held = hold();
				return {
					...held,
					release: () => {
						released = true;
						held.release();
					},
				};
			};
			services.broker.sessionForkEnvironment = (): Record< string, string > =>
				released || ! renewal ? {} : { STUDIO_CHATGPT_SESSIONS_OFFERED: REGISTRATION };
			// The owner answers an ask in the window only once the held refresh settles.
			services.broker.askSessionToken = async ( _id, logoutGeneration ) => {
				calls.log.push( `ask:${ logoutGeneration }` );
				await renewal;
				return false;
			};
			return scripted;
		}

		it( 'runs every session stage and cleans up after itself', async () => {
			const { services, calls } = scriptedSession();
			expect( await runChatGptAcceptance( sessionArgs(), dependencies( services ) ) ).toBe( 0 );
			expect(
				records()
					.filter( ( record ) => record.run === 2 )
					.map( ( record ) => [ record.stage, record.status ] )
			).toEqual( [
				...SESSION_STAGE_NAMES.map( ( stage ) => [ stage, 'passed' ] ),
				[ 'cleanup', 'passed' ],
			] );
			expect( calls.log ).toEqual(
				expect.arrayContaining( [ 'begin:session', 'hold', 'release' ] )
			);
			expect( calls.log.filter( ( call ) => call === 'sign-out' ) ).toHaveLength( 1 );
			// The runner asks the owner in the window, with the generation the session was held at.
			const { log } = calls;
			expect( log.indexOf( 'sign-out' ) ).toBeLessThan( log.indexOf( 'ask:0' ) );
			expect( log.indexOf( 'ask:0' ) ).toBeLessThan( log.indexOf( 'release' ) );
			expect( stageOf( 'refresh-hold-across-sign-out' )[ 0 ].observations ).toMatchObject( {
				offerAdvertisedDuringWindow: true,
				windowDirectAskAnswered: true,
				windowDirectAskRefused: true,
				windowForkTokenAsks: 0,
				windowForkRouteRequests: 0,
				windowForkFallbackRequests: 0,
				windowForkSucceeded: false,
				windowForkReportedUnavailable: true,
			} );
			expectNothingUnsafe( [ 'test-access-token' ], [ REGISTRATION ] );
		} );

		it( 'records a system keychain it can’t use, without blocking a session-only run', async () => {
			const { services } = scriptedSession();
			services.credentialStoreKind = () => 'secret-service';
			services.secureStorageAvailable = async () => false;

			expect( await runChatGptAcceptance( sessionArgs(), dependencies( services ) ) ).toBe( 0 );

			expect( stageOf( 'prerequisites' ) ).toEqual( [
				expect.objectContaining( {
					run: 2,
					status: 'passed',
					observations: {
						buildPresent: true,
						storePasswordVault: false,
						storeKeychain: false,
						storeSecretService: true,
						secureStorageAvailable: false,
						isolated: true,
					},
				} ),
			] );
		} );

		const failures: Array<
			[
				string,
				string,
				'failed' | 'blocked',
				() => ReturnType< typeof scriptedSession >,
				{ signOut: boolean; cleanup?: Record< string, unknown > },
			]
		> = [
			[
				'returning-sign-in',
				'denied',
				'failed',
				() => {
					const scripted = scriptedSession();
					scripted.services.signIn.wait = async () => ( {
						ok: false,
						code: 'denied',
						message: 'denied',
					} );
					return scripted;
				},
				{ signOut: false },
			],
			[
				'no-persisted-record',
				'credential-record-persisted',
				'failed',
				() => {
					const scripted = scriptedSession();
					scripted.services.broker.vaultRecordExists = () => true;
					return scripted;
				},
				{ signOut: true, cleanup: { testRegistrationSignedOut: true } },
			],
			[
				'unoffered-process-fails',
				'inference-without-offer',
				'failed',
				() =>
					scriptedSession( {
						unoffered: () =>
							finishedTurn(
								turnResult( {
									exitCode: 0,
									events: [ answered( 'READY' ), completed( 'success' ) ],
								} )
							),
					} ),
				{ signOut: true, cleanup: { testRegistrationSignedOut: true } },
			],
			[
				'refresh-hold-across-sign-out',
				'refresh-not-held',
				'blocked',
				() => {
					const scripted = scriptedSession();
					const hold = scripted.services.tokens.holdNextRefresh;
					scripted.services.tokens.holdNextRefresh = () => ( {
						...hold(),
						held: Promise.resolve( false ),
					} );
					return scripted;
				},
				{
					signOut: true,
					cleanup: { heldRefreshReleased: true, testRegistrationSignedOut: true },
				},
			],
			[
				'refresh-hold-across-sign-out',
				'window-ask-got-token',
				'failed',
				() => {
					const scripted = scriptedSession();
					const ask = scripted.services.broker.askSessionToken;
					scripted.services.broker.askSessionToken = async ( id, generation ) => {
						await ask( id, generation );
						return true;
					};
					return scripted;
				},
				{ signOut: true },
			],
			[
				'refresh-hold-across-sign-out',
				'window-ask-unanswered',
				'failed',
				() => {
					const scripted = scriptedSession();
					scripted.services.broker.askSessionToken = async () => null;
					return scripted;
				},
				{ signOut: true },
			],
			[
				'refresh-hold-across-sign-out',
				'inference-during-window',
				'failed',
				() =>
					scriptedSession( {
						'window-fork': () =>
							finishedTurn(
								turnResult( {
									exitCode: 0,
									startedAt: at( 100 ),
									exitedAt: at( 900 ),
									events: [ answered( 'READY', at( 700 ) ), completed( 'success', at( 800 ) ) ],
									requests: [ routeRequest( { startedAt: at( 400 ) } ) ],
								} )
							),
					} ),
				{ signOut: true },
			],
			[
				'refresh-hold-across-sign-out',
				'window-fork-completed',
				'failed',
				() =>
					scriptedSession( {
						'window-fork': () =>
							finishedTurn(
								turnResult( {
									exitCode: 0,
									startedAt: at( 100 ),
									exitedAt: at( 600 ),
									events: [ answered( 'READY', at( 400 ) ), completed( 'success', at( 500 ) ) ],
									requests: [],
								} )
							),
					} ),
				{ signOut: true },
			],
		];

		it.each( failures )(
			'after %s fails with %s, keeps that record and cleans up what it owns',
			async ( stage, code, status, make, expected ) => {
				const { services, calls } = make();
				expect( await runChatGptAcceptance( sessionArgs(), dependencies( services ) ) ).toBe( 1 );
				const all = records().filter( ( record ) => record.run === 2 );
				const failedAt = all.findIndex( ( record ) => record.stage === stage );
				expect( all[ failedAt ] ).toMatchObject( { stage, status, code } );
				expect( all.slice( failedAt + 1 ).map( ( record ) => record.stage ) ).toEqual( [
					'cleanup',
				] );
				expect( all.at( -1 ) ).toMatchObject( {
					stage: 'cleanup',
					status: 'passed',
					observations: expect.objectContaining( expected.cleanup ?? {} ),
				} );
				expect( calls.log ).toContain( 'stop-owned' );
				expect( calls.log.filter( ( call ) => call === 'sign-out' ) ).toHaveLength(
					expected.signOut ? 1 : 0
				);
				expectNothingUnsafe( [ 'test-access-token' ], [ REGISTRATION ] );
			}
		);

		it( 'fails a window ask answered with a token even when the offer was no longer advertised', async () => {
			const { services } = scriptedSession();
			services.broker.sessionForkEnvironment = () => ( {} );
			services.broker.askSessionToken = async () => true;
			expect( await runChatGptAcceptance( sessionArgs(), dependencies( services ) ) ).toBe( 1 );
			expect( stageOf( 'refresh-hold-across-sign-out' )[ 0 ] ).toMatchObject( {
				status: 'failed',
				code: 'window-ask-got-token',
				observations: expect.objectContaining( {
					offerAdvertisedDuringWindow: false,
					windowDirectAskAnswered: true,
					windowDirectAskGotToken: true,
				} ),
			} );

			// Not advertised and not answered: nothing was handed out, so that alone passes.
			services.broker.askSessionToken = async () => null;
			expect( await runChatGptAcceptance( sessionArgs(), dependencies( services ) ) ).toBe( 0 );
			expect( stageOf( 'refresh-hold-across-sign-out' )[ 1 ] ).toMatchObject( {
				status: 'passed',
				observations: expect.objectContaining( {
					offerAdvertisedDuringWindow: false,
					windowDirectAskAnswered: false,
					windowDirectAskGotToken: false,
				} ),
			} );
		} );

		it( 'signs out a returning sign-in that still commits after the interrupt cancelled it', async () => {
			const { services, calls } = scriptedSession();
			const signedIn = services.signIn.wait;
			const outcome = deferred< Awaited< ReturnType< typeof signedIn > > >();
			services.signIn.wait = () => outcome.promise;
			services.signIn.cancel = ( attemptId ) => {
				calls.log.push( 'cancel' );
				void signedIn( attemptId ).then( outcome.resolve );
				return true;
			};
			const running = runChatGptAcceptance( sessionArgs(), dependencies( services ) );
			await vi.waitFor( () => expect( calls.log ).toContain( 'begin:session' ) );
			await vi.waitFor( () => expect( interrupt ).not.toBeNull() );
			interrupt?.();
			expect( await running ).toBe( 130 );
			expect( stageOf( 'returning-sign-in' )[ 0 ] ).toMatchObject( {
				status: 'failed',
				code: 'interrupted',
			} );
			expect( records().at( -1 ) ).toMatchObject( {
				stage: 'cleanup',
				status: 'passed',
				observations: expect.objectContaining( { testRegistrationSignedOut: true } ),
			} );
			expect( openAcceptanceEvidence( runDir, 'chatgpt' ).readState() ).toMatchObject( {
				registrationId: REGISTRATION,
				storage: 'session',
			} );
		} );

		it( 'stops waiting at once on an interrupt while a refresh is held, then releases it in cleanup', async () => {
			const { services, calls } = scriptedSession( {
				// A fork that is still running when the interrupt comes.
				'window-fork': () => ( {
					firstRequest: async () => false,
					result: new Promise( ( resolve ) =>
						setTimeout(
							() =>
								resolve(
									turnResult( {
										exitCode: 1,
										events: [ cliError( disconnectedText ) ],
										requests: [],
									} )
								),
							4_000
						)
					),
					stop: async () => undefined,
				} ),
			} );
			const running = runChatGptAcceptance( sessionArgs(), dependencies( services ) );
			await vi.waitFor( () => expect( calls.log ).toContain( 'turn:window-fork' ) );
			interrupt?.();
			expect(
				await Promise.race( [
					running,
					new Promise( ( resolve ) => setTimeout( () => resolve( 'still waiting' ), 2_000 ) ),
				] )
			).toBe( 130 );
			expect( calls.log.indexOf( 'release' ) ).toBeGreaterThan(
				calls.log.indexOf( 'turn:window-fork' )
			);
			expect( stageOf( 'refresh-hold-across-sign-out' )[ 0 ] ).toMatchObject( {
				status: 'failed',
				code: 'interrupted',
			} );
			expect( records().at( -1 ) ).toMatchObject( {
				stage: 'cleanup',
				status: 'passed',
				observations: expect.objectContaining( { heldRefreshReleased: true } ),
			} );
			expect( calls.log ).toContain( 'stop-owned' );
		} );
	} );

	describe( 'sign-in failure codes', () => {
		let signingKey: SigningKey;
		let fake: FakeAuthorizationServer;
		let broker: ChatGptCredentialBroker;
		let keychain: ReturnType< typeof createFakeCredentialStore >;

		beforeAll( async () => {
			signingKey = await createSigningKey( 'acceptance-key' );
		} );

		beforeEach( async () => {
			nock.enableNetConnect( '127.0.0.1' );
			process.env.DEV_CONFIG_DIR = acceptanceRunPaths( runDir ).profileDir;
			fake = await startFakeAuthorizationServer( signingKey );
			keychain = createFakeCredentialStore();
			broker = createChatGptCredentialBroker( {
				tokenClient: createChatGptTokenClient( { discoveryUrl: fake.discoveryUrl } ),
				credentialStore: keychain.store,
				timing: { turnSettleTimeoutMs: 50, revokeRetryDelaysMs: [ 1 ] },
			} );
		} );

		afterEach( async () => {
			await fake.close();
		} );

		it( 'keeps a timed-out returning sign-in’s code, which an assert-then-record harness lost', async () => {
			// The browser opens, and nobody finishes signing in.
			const flow = createChatGptSignInFlow( {
				discoveryUrl: fake.discoveryUrl,
				credentials: broker,
				openBrowser: async () => undefined,
				timeoutMs: 40,
			} );
			fs.mkdirSync( runDir, { recursive: true } );

			// The earlier harness: it asserted the outcome before recording it.
			const evidence = openAcceptanceEvidence( runDir, 'chatgpt' );
			const oldHarness = async () => {
				const { attemptId } = await flow.begin( undefined, { storage: 'session' } );
				const outcome = await flow.wait( attemptId );
				if ( ! outcome.ok ) {
					throw new Error( 'assertion-failed' );
				}
				evidence.record( {
					run: 1,
					scenario: 'session',
					stage: 'session-only-acceptance',
					status: 'passed',
					durationS: 0,
					observations: {},
				} );
			};
			await expect( oldHarness() ).rejects.toThrow( 'assertion-failed' );
			expect( evidence.readRecords() ).toEqual( [] );
			fs.rmSync( runDir, { recursive: true, force: true } );

			// The runner: the stage records the typed code first.
			const { services } = scriptedServices( {
				signIn: { ...flow, timeoutMs: 40 },
			} );
			expect(
				await runChatGptAcceptance(
					[ '--live', '--scenario', 'saved', '--run-dir', runDir ],
					dependencies( services )
				)
			).toBe( 1 );
			expect( stageOf( 'sign-in' )[ 0 ] ).toMatchObject( {
				status: 'failed',
				code: 'timed-out',
				observations: expect.objectContaining( {
					browserOpened: true,
					timedOut: true,
					timeoutS: 0.04,
				} ),
			} );
			expect( printed.join( '\n' ) ).toMatch( /stopped waiting/ );
			expectNothingUnsafe( fake.secrets() );
		} );

		it( 'says when the browser opened and how long remains, and makes a time-out legible', async () => {
			let now = 0;
			const sleeps: Array< { until: number; resolve: () => void } > = [];
			const outcome = deferred< { ok: false; code: 'timed-out'; message: string } >();
			const { services } = scriptedServices( {
				clock: {
					now: () => now,
					sleep: ( ms, signal ) =>
						new Promise( ( resolve ) => {
							const entry = { until: now + ms, resolve };
							sleeps.push( entry );
							signal?.addEventListener( 'abort', () => resolve() );
						} ),
				},
				countdownIntervalMs: 60_000,
			} );
			services.signIn.wait = () => outcome.promise;
			const running = runChatGptAcceptance(
				[ '--live', '--scenario', 'saved', '--run-dir', runDir ],
				dependencies( services )
			);
			await vi.waitFor( () => expect( printed.join( '\n' ) ).toMatch( /10 minutes/ ) );
			for ( let minute = 1; minute <= 9; minute++ ) {
				now = minute * 60_000;
				sleeps.filter( ( sleep ) => sleep.until <= now ).forEach( ( sleep ) => sleep.resolve() );
				await vi.waitFor( () =>
					expect( printed.join( '\n' ) ).toContain( `${ 10 - minute } minute` )
				);
			}
			now = 599_500;
			outcome.resolve( { ok: false, code: 'timed-out', message: 'timed out' } );
			expect( await running ).toBe( 1 );
			expect( stageOf( 'sign-in' )[ 0 ] ).toMatchObject( {
				code: 'timed-out',
				observations: expect.objectContaining( { completedAfterS: 599.5, timeoutS: 600 } ),
			} );
			expect( printed.join( '\n' ) ).toMatch( /599\.5 s after your browser opened/ );
		} );
	} );

	describe( 'both scenarios against the local authorization server', () => {
		let signingKey: SigningKey;
		let fake: FakeAuthorizationServer;
		let keychain: ReturnType< typeof createFakeCredentialStore >;
		const revoked = new Set< string >();
		const spent = new Set< string >();
		// Which grant each refresh token belongs to, and what this script issued.
		const family = new Map< string, number >();
		const issuedHere: string[] = [];

		beforeAll( async () => {
			signingKey = await createSigningKey( 'acceptance-key' );
		} );

		beforeEach( async () => {
			nock.enableNetConnect( '127.0.0.1' );
			fake = await startFakeAuthorizationServer( signingKey );
			revoked.clear();
			spent.clear();
			family.clear();
			issuedHere.length = 0;
			// Refresh tokens rotate and work once; revoked ones never work again; and
			// presenting a spent one revokes its whole grant, rotated tokens included.
			fake.script.token = ( form ) => {
				if ( form.get( 'grant_type' ) !== 'refresh_token' ) {
					return undefined;
				}
				const presented = form.get( 'refresh_token' ) ?? '';
				if ( ! family.has( presented ) ) {
					family.set( presented, family.size + 1 );
				}
				const grant = family.get( presented );
				if ( revoked.has( presented ) ) {
					return { status: 400, body: { error: 'invalid_grant' } };
				}
				if ( spent.has( presented ) ) {
					for ( const [ token, of ] of family ) {
						if ( of === grant ) {
							revoked.add( token );
						}
					}
					return { status: 400, body: { error: 'refresh_token_reused' } };
				}
				spent.add( presented );
				const serial = issuedHere.length / 2 + 1;
				const next = `test-rotated-refresh-token-${ serial }`;
				const access = `test-rotated-access-token-${ serial }`;
				issuedHere.push( next, access );
				family.set( next, grant! );
				return {
					status: 200,
					body: {
						access_token: access,
						refresh_token: next,
						token_type: 'Bearer',
						expires_in: 3600,
						scope: GRANTED_SCOPE,
					},
				};
			};
			fake.script.revoke = ( form ) => {
				revoked.add( form.get( 'token' ) ?? '' );
				return { status: 200 };
			};
			keychain = createFakeCredentialStore();
		} );

		afterEach( async () => {
			await fake.close();
		} );

		// The system browser: ChatGPT sends it straight back to the callback.
		const browser = async ( url: string ) => {
			const response = await fetch( url, { redirect: 'manual' } );
			void fetch( response.headers.get( 'location' )! ).then( ( reply ) => reply.text() );
		};

		function realServices( owner: { broker: ChatGptCredentialBroker | null } ) {
			const tokens = createAcceptanceTokenService(
				createChatGptTokenClient( { discoveryUrl: fake.discoveryUrl } )
			);
			const broker = createChatGptCredentialBroker( {
				tokenClient: tokens.client,
				credentialStore: keychain.store,
				timing: { turnSettleTimeoutMs: 50, revokeRetryDelaysMs: [ 1 ] },
			} );
			owner.broker = broker;
			const flow = createChatGptSignInFlow( {
				discoveryUrl: fake.discoveryUrl,
				credentials: broker,
				openBrowser: browser,
			} );
			const { services, notifySignedOut } = scriptedServices();
			const profileDir = acceptanceRunPaths( runDir ).profileDir;
			return {
				...services,
				signIn: { ...flow, timeoutMs: 10_000 },
				broker: {
					...services.broker,
					getAccessToken: ( id: string ) => broker.getAccessToken( id ),
					invalidateAccessToken: ( id: string, token: string ) =>
						broker.invalidateAccessToken( id, token ),
					signOut: async ( id: string ) => {
						const began = services.clock.now();
						const result = await broker.signOut( id );
						notifySignedOut( began );
						return result;
					},
					sessionForkEnvironment: () => broker.getSessionForkEnvironment(),
					askSessionToken: ( id: string, logoutGeneration: number ) =>
						askOwnerForSessionToken(
							( message, reply ) => broker.answerSessionTokenRequest( message, reply ),
							id,
							logoutGeneration
						),
					readAccount: ( id: string ) => readChatGptAccount( id ),
					vaultRecordExists: ( id: string ) =>
						fs.existsSync( path.join( profileDir, 'chatgpt-credentials', `${ id }.vault` ) ),
					vaultKeyItem: () => getChatGptVaultKeyAccounts().own,
					removeProfileVaultKey: () => broker.removeProfileVaultKey(),
				},
				tokens,
			} satisfies ChatGptAcceptanceServices;
		}

		// Every keychain item a run wrote, by name.
		function recordKeychainWrites(): string[] {
			const written: string[] = [];
			const set = keychain.store.set;
			keychain.store.set = async ( account, secret ) => {
				written.push( account );
				return set( account, secret );
			};
			return written;
		}

		// A turn the app forks: its own broker, asking the owner over an in-memory channel.
		function simulatedFork(
			owner: ChatGptCredentialBroker,
			options: TurnOptions,
			registrationId: string
		): AcceptanceTurn {
			let tokenAsks = 0;
			let tokensHandedOut = 0;
			const listeners = new Set< ( reply: unknown ) => void >();
			const channel = {
				connected: true,
				send: ( request: unknown, callback: ( error: Error | null ) => void ) => {
					const answeredHere = owner.answerSessionTokenRequest( request, ( reply ) => {
						if ( ( reply as { accessToken?: unknown } ).accessToken ) {
							tokensHandedOut++;
						}
						listeners.forEach( ( listener ) => listener( reply ) );
					} );
					if ( answeredHere ) {
						tokenAsks++;
					}
					callback( null );
					return true;
				},
				on: ( _event: 'message', listener: ( reply: unknown ) => void ) =>
					listeners.add( listener ),
				off: ( _event: 'message', listener: ( reply: unknown ) => void ) =>
					listeners.delete( listener ),
			};
			const neverUsed: ChatGptTokenClient = {
				refresh: async () => ( { ok: false, error: { kind: 'transient' } } ),
				revoke: async () => ( { ok: false, error: { kind: 'transient' } } ),
			};
			const fork = createChatGptCredentialBroker( {
				tokenClient: neverUsed,
				credentialStore: keychain.store,
			} );
			if ( options.offerSessions && options.ipc ) {
				fork.acceptSessionTokensFromParent( channel, { ...owner.getSessionForkEnvironment() } );
			}
			const startedAt = Date.now();
			const result = ( async (): Promise< TurnResult > => {
				const common = { pid: 7000, startedAt, responses: [], interruptedByRunner: false };
				const connection = ( await fork.listConnections() ).find(
					( item ) => item.connectionId === registrationId
				);
				if ( connection?.authStatus !== 'connected' ) {
					return {
						...common,
						exitCode: 1,
						exitedAt: Date.now(),
						events: [ cliError( disconnectedText ) ],
						requests: [],
						tokenAsks,
						tokensHandedOut,
					};
				}
				const turn = await fork.beginTurn( registrationId );
				try {
					await turn.getAccessToken();
					return {
						...common,
						exitCode: 0,
						exitedAt: Date.now(),
						events: [ answered( 'READY' ), completed( 'success' ) ],
						requests: [ routeRequest( { startedAt: Date.now() } ) ],
						tokenAsks,
						tokensHandedOut,
					};
				} catch ( error ) {
					const code = ( error as ChatGptConnectionError ).code;
					return {
						...common,
						exitCode: 1,
						exitedAt: Date.now(),
						events: [ failedWith( `${ new ChatGptConnectionError( code ).message } (${ code })` ) ],
						requests: [],
						tokenAsks,
						tokensHandedOut,
					};
				} finally {
					turn.end();
				}
			} )();
			return { firstRequest: async () => true, result, stop: async () => undefined };
		}

		it( 'runs saved, then session in the same run directory, with real sign-ins, sign-outs and a refresh held across one', async () => {
			const owner: { broker: ChatGptCredentialBroker | null } = { broker: null };
			const written = recordKeychainWrites();
			const saved = realServices( owner );
			expect(
				await runChatGptAcceptance(
					[ '--live', '--scenario', 'saved', '--run-dir', runDir ],
					dependencies( saved )
				)
			).toBe( 0 );
			const { registrationId, vaultKeySuffix } = openAcceptanceEvidence(
				runDir,
				'chatgpt'
			).readState() as {
				registrationId: string;
				vaultKeySuffix: string;
			};
			expect( ( await readChatGptAccount( registrationId ) )?.state ).toBe( 'signed-out' );
			// The run's profile keyed its record under an item of its own, never the
			// unscoped one, and removed that item again after its sign-out.
			expect( new Set( written ) ).toEqual(
				new Set( [ `${ UNSCOPED_VAULT_KEY_ITEM }-${ vaultKeySuffix }` ] )
			);
			expect( vaultKeySuffix ).toMatch( /^[0-9a-f]{16}$/ );
			expect( [ ...keychain.items.keys() ] ).toEqual( [] );
			expect( records().at( -1 ) ).toMatchObject( {
				stage: 'cleanup',
				status: 'passed',
				observations: expect.objectContaining( { vaultKeyRemoved: true } ),
			} );
			expect( stageOf( 'refresh-before-sign-out' )[ 0 ] ).toMatchObject( {
				status: 'passed',
				observations: { refreshed: true },
			} );
			expect( stageOf( 'remote-revocation' )[ 0 ] ).toMatchObject( {
				status: 'passed',
				observations: expect.objectContaining( {
					vaultRecordAfterSignOut: false,
					rotatedRevokedBySignOut: true,
					rotatedRefreshRejected: true,
					rejectionTerminal: true,
					retiredRefreshRejected: true,
				} ),
			} );

			// A new app session: a new broker, holding nothing yet.
			const session = realServices( owner );
			session.processes = {
				...session.processes,
				startTurn: ( options ) => simulatedFork( owner.broker!, options, registrationId ),
			};
			printed = [];
			expect(
				await runChatGptAcceptance(
					[ '--live', '--scenario', 'session', '--run-dir', runDir ],
					dependencies( session )
				)
			).toBe( 0 );
			const sessionRecords = records().filter( ( record ) => record.run === 2 );
			expect( sessionRecords.map( ( record ) => [ record.stage, record.status ] ) ).toEqual( [
				...SESSION_STAGE_NAMES.map( ( stage ) => [ stage, 'passed' ] ),
				[ 'cleanup', 'passed' ],
			] );
			expect( stageOf( 'no-persisted-record' )[ 0 ].observations ).toMatchObject( {
				storageSession: true,
				vaultRecordPresent: false,
			} );
			expect( stageOf( 'offered-fork-inference' )[ 0 ].observations ).toMatchObject( {
				tokensHandedOut: 1,
				modelRequests: 1,
			} );
			expect( stageOf( 'unoffered-process-fails' )[ 0 ].observations ).toMatchObject( {
				routeRequests: 0,
				tokenAsks: 0,
				reportedUnavailable: true,
			} );
			expect( stageOf( 'refresh-hold-across-sign-out' )[ 0 ].observations ).toMatchObject( {
				refreshHeld: true,
				generationAdvancedDuringHold: true,
				// The real owner, asked in the window, answers without a token.
				offerAdvertisedDuringWindow: true,
				windowDirectAskAnswered: true,
				windowDirectAskRefused: true,
				windowForkTokenAsks: 0,
				windowForkSucceeded: false,
				windowForkReportedUnavailable: true,
				windowForkTokensHandedOut: 0,
				windowForkRouteRequests: 0,
				heldRefreshRejectedSignedOut: true,
				offerGoneAfterSettle: true,
				localCleared: true,
				remoteRevocationConfirmed: true,
				rotatedRevokedBySignOut: true,
				retiredRefreshRejected: true,
				rotatedRefreshRejected: true,
			} );
			// The earlier saved run's records are still there, unchanged.
			expect( records().filter( ( record ) => record.run === 1 ) ).toHaveLength(
				SAVED_STAGE_NAMES.length + 1
			);
			expect( openAcceptanceEvidence( runDir, 'chatgpt' ).readManifest()?.runs ).toHaveLength( 2 );
			expect( ( await readChatGptAccount( registrationId ) )?.state ).toBe( 'signed-out' );
			expectNothingUnsafe( [ ...fake.secrets(), ...issuedHere ], [ registrationId ] );
		} );

		it( 'fails the saved run’s remote revocation when the sign-out leaves the grant a refresh rotated to usable', async () => {
			const owner: { broker: ChatGptCredentialBroker | null } = { broker: null };
			const saved = realServices( owner );
			const signOut = saved.broker.signOut;
			saved.broker.signOut = async ( id ) => {
				// From the sign-out on, the token service refuses every revocation.
				fake.script.revoke = () => ( { status: 400, body: { error: 'unsupported_token_type' } } );
				return signOut( id );
			};
			expect(
				await runChatGptAcceptance(
					[ '--live', '--scenario', 'saved', '--run-dir', runDir ],
					dependencies( saved )
				)
			).toBe( 1 );
			expect( stageOf( 'active-run-stops-on-sign-out' )[ 0 ] ).toMatchObject( {
				status: 'passed',
				observations: expect.objectContaining( {
					localCleared: true,
					remoteRevocationConfirmed: false,
				} ),
			} );
			expect( stageOf( 'remote-revocation' )[ 0 ] ).toMatchObject( {
				status: 'failed',
				code: 'rotated-grant-usable',
				observations: expect.objectContaining( {
					vaultRecordAfterSignOut: false,
					rotatedRevokedBySignOut: false,
					rotatedRefreshRejected: false,
				} ),
			} );
			expectNothingUnsafe( [ ...fake.secrets(), ...issuedHere ] );
		} );

		it( 'fails the refresh hold when the sign-out leaves the rotated grant usable, though a reuse would revoke the grant', async () => {
			const owner: { broker: ChatGptCredentialBroker | null } = { broker: null };
			expect(
				await runChatGptAcceptance(
					[ '--live', '--scenario', 'saved', '--run-dir', runDir ],
					dependencies( realServices( owner ) )
				)
			).toBe( 0 );
			const { registrationId } = openAcceptanceEvidence( runDir, 'chatgpt' ).readState() as {
				registrationId: string;
			};
			// From here the token service refuses every revocation the sign-out asks for.
			fake.script.revoke = () => ( { status: 400, body: { error: 'unsupported_token_type' } } );
			const session = realServices( owner );
			session.processes = {
				...session.processes,
				startTurn: ( options ) => simulatedFork( owner.broker!, options, registrationId ),
			};
			printed = [];
			expect(
				await runChatGptAcceptance(
					[ '--live', '--scenario', 'session', '--run-dir', runDir ],
					dependencies( session )
				)
			).toBe( 1 );
			expect( stageOf( 'refresh-hold-across-sign-out' )[ 0 ] ).toMatchObject( {
				status: 'failed',
				code: 'rotated-grant-usable',
				observations: expect.objectContaining( {
					rotatedRevokedBySignOut: false,
					rotatedRefreshRejected: false,
				} ),
			} );
			expectNothingUnsafe( [ ...fake.secrets(), ...issuedHere ], [ registrationId ] );
		} );

		it( 'signs out a session-only registration it signed in when a later session stage fails', async () => {
			const owner: { broker: ChatGptCredentialBroker | null } = { broker: null };
			expect(
				await runChatGptAcceptance(
					[ '--live', '--scenario', 'saved', '--run-dir', runDir ],
					dependencies( realServices( owner ) )
				)
			).toBe( 0 );
			const { registrationId } = openAcceptanceEvidence( runDir, 'chatgpt' ).readState() as {
				registrationId: string;
			};
			const session = realServices( owner );
			session.processes = {
				...session.processes,
				startTurn: ( options ) =>
					options.label === 'offered-fork'
						? finishedTurn(
								turnResult( {
									events: [ failedWith( 'broken' ), completed( 'error' ) ],
									requests: [],
								} )
						  )
						: simulatedFork( owner.broker!, options, registrationId ),
			};
			expect(
				await runChatGptAcceptance(
					[ '--live', '--scenario', 'session', '--run-dir', runDir ],
					dependencies( session )
				)
			).toBe( 1 );
			expect( stageOf( 'offered-fork-inference' )[ 0 ] ).toMatchObject( { status: 'failed' } );
			expect( ( await readChatGptAccount( registrationId ) )?.state ).toBe( 'signed-out' );
			expect( owner.broker!.getSessionForkEnvironment() ).toEqual( {} );
			expect( records().at( -1 ) ).toMatchObject( {
				stage: 'cleanup',
				status: 'passed',
				observations: expect.objectContaining( { testRegistrationSignedOut: true } ),
			} );
		} );

		it( 'keeps a provisioned profile’s own vault key item until retire removes it after the sign-out', async () => {
			const owner: { broker: ChatGptCredentialBroker | null } = { broker: null };
			const written = recordKeychainWrites();
			expect(
				await runChatGptAcceptance(
					[ '--live', '--scenario', 'provision', '--run-dir', runDir ],
					dependencies( realServices( owner ) )
				)
			).toBe( 0 );
			const { registrationId, vaultKeySuffix } = openAcceptanceEvidence(
				runDir,
				'chatgpt'
			).readState() as { registrationId: string; vaultKeySuffix: string };
			const item = `${ UNSCOPED_VAULT_KEY_ITEM }-${ vaultKeySuffix }`;
			expect( ( await readChatGptAccount( registrationId ) )?.state ).toBe( 'signed-in' );
			expect( [ ...keychain.items.keys() ] ).toEqual( [ item ] );

			printed = [];
			expect(
				await runChatGptAcceptance(
					[ '--live', '--scenario', 'retire', '--run-dir', runDir ],
					dependencies( realServices( owner ) )
				)
			).toBe( 0 );
			expect( stageOf( 'profile-sign-out' )[ 0 ] ).toMatchObject( {
				status: 'passed',
				observations: expect.objectContaining( { localCleared: true, vaultKeyRemoved: true } ),
			} );
			expect( ( await readChatGptAccount( registrationId ) )?.state ).toBe( 'signed-out' );
			expect( [ ...keychain.items.keys() ] ).toEqual( [] );
			expect( new Set( written ) ).toEqual( new Set( [ item ] ) );
			expectNothingUnsafe( [ ...fake.secrets(), ...issuedHere ], [ registrationId ] );
		} );
	} );
} );

describe( 'acceptance turn digests', () => {
	it( 'classifies a turn’s failure into typed codes, never keeping its text', () => {
		expect( classifyTurnFailure( `${ signedOutText } (signed-out)` ) ).toEqual( [ 'signed-out' ] );
		expect( classifyTurnFailure( disconnectedText ) ).toEqual( [ 'connection-disconnected' ] );
		expect(
			classifyTurnFailure(
				`${ new ChatGptConnectionError( 'session-unavailable' ).message } (session-unavailable)`
			)
		).toEqual( [ 'session-unavailable' ] );
		expect(
			classifyTurnFailure( 'Limit (HTTP 429, subscription_sharing_usage_limit_exceeded)' )
		).toEqual( [ 'usage-limit' ] );
		expect( classifyTurnFailure( 'Something else entirely' ) ).toEqual( [] );
	} );

	it.each( [ undefined, 'signed-in', 'signed-out', 'needs-sign-in' ] as const )(
		'classifies the disconnected connection’s text for an account %s as before, in a turn’s digest too',
		( state ) => {
			const text = describeConnectionSelectionError(
				{ code: 'disconnected', providerId: 'chatgpt-oauth' },
				state
			);
			expect( classifyTurnFailure( text ) ).toEqual( [ 'connection-disconnected' ] );
			// What blocked-after-sign-out, unoffered and the window fork read.
			expect( digestTurnEvents( [ cliError( text ) ] ).failureCodes ).toEqual( [
				'connection-disconnected',
			] );
		}
	);

	it.each( [ 'changed', 'unsupported' ] as const )(
		'classifies the %s connection’s text alone, whatever the account’s state',
		( code ) => {
			for ( const state of [ undefined, 'signed-out', 'needs-sign-in' ] as const ) {
				expect(
					classifyTurnFailure(
						describeConnectionSelectionError( { code, providerId: 'chatgpt-oauth' }, state )
					)
				).toEqual( [ `connection-${ code }` ] );
			}
		}
	);

	it( 'never takes another code’s text for a disconnected connection', () => {
		for ( const code of [ 'signed-out', 'needs-sign-in', 'session-unavailable' ] as const ) {
			expect( classifyTurnFailure( new ChatGptConnectionError( code ).message ) ).toEqual( [
				code,
			] );
		}
	} );

	it( 'collects tool calls, the final answer, failure codes and how the turn ended', () => {
		const digest = digestTurnEvents( [
			toolStart( '1', 'wp_cli', { command: 'option get blogname' }, 10 ),
			toolEnd( '1', 'wp_cli', { studioService: { service: 'wpcom' } }, 20 ),
			failedWith( `${ signedOutText } (signed-out)` ),
			completed( 'error' ),
		] );
		expect( digest ).toMatchObject( {
			toolCalls: [
				{
					id: '1',
					name: 'wp_cli',
					startedAt: 10,
					endedAt: 20,
					isError: false,
					hasStudioService: true,
				},
			],
			failureCodes: [ 'signed-out' ],
			status: 'error',
		} );
	} );

	it( 'reads an interrupted ending: how it stopped, its typed codes and when it arrived', () => {
		expect(
			digestTurnEvents( [
				message( { type: 'agent_end', willRetry: true, messages: [] }, 10 ),
				interruptedWith( signedOutText, 30 ),
				completed( 'error', 40 ),
			] )
		).toMatchObject( {
			stopReason: 'aborted',
			failureCodes: [ 'signed-out' ],
			endedAt: 30,
			status: 'error',
			finalText: '',
		} );
		expect( digestTurnEvents( [ completed( 'error', 40 ) ] ) ).toMatchObject( {
			stopReason: null,
			endedAt: 40,
		} );
	} );

	it( 'allows only the named test mutation on the test site', () => {
		const policy = {
			site: { name: 'ChatGPT Acceptance', path: '/run/sites/a' },
			draftTitle: 'T 1',
			tools: [ 'wp_cli' ],
		};
		expect(
			classifyToolCall( policy, 'wp_cli', {
				nameOrPath: 'ChatGPT Acceptance',
				command: 'post create --post_status=draft --post_title="T 1"',
			} )
		).toBe( 'allowed' );
		expect(
			classifyToolCall( policy, 'wp_cli', {
				nameOrPath: '/run/sites/a',
				command: 'option get blogname',
			} )
		).toBe( 'allowed' );
		for ( const command of [
			'plugin list',
			'user list --fields=ID',
			'post list --post_type=page',
			'post meta get 1 color',
			'theme mod get header_textcolor',
			'plugin auto-updates status --all',
			'plugin path hello',
			'core version',
		] ) {
			expect(
				classifyToolCall( policy, 'wp_cli', { nameOrPath: 'ChatGPT Acceptance', command } )
			).toBe( 'allowed' );
			expect( isWpCliReadCommand( command ) ).toBe( true );
		}
		// Writes whose later words happen to be read verbs.
		for ( const command of [
			'option update status x',
			'plugin install path',
			'post update 1 --post_title=list',
			'user create get reader',
			'post create --post_title="T 1"',
		] ) {
			expect( isWpCliReadCommand( command ) ).toBe( false );
		}
		for ( const command of [ 'option update status x', 'plugin install path' ] ) {
			expect(
				classifyToolCall( policy, 'wp_cli', { nameOrPath: 'ChatGPT Acceptance', command } )
			).toBe( 'unexpected' );
		}
		for ( const [ name, args ] of [
			[ 'wp_cli', { nameOrPath: 'Other Site', command: 'option get blogname' } ],
			[
				'wp_cli',
				{
					nameOrPath: 'ChatGPT Acceptance',
					command: 'post create --post_status=publish --post_title="T 1"',
				},
			],
			[ 'wp_cli', { nameOrPath: 'ChatGPT Acceptance', command: 'post delete 1 --force' } ],
			[ 'wp_cli', { nameOrPath: 'ChatGPT Acceptance', command: 'plugin install hello-dolly' } ],
			[
				'wp_cli',
				{ nameOrPath: 'ChatGPT Acceptance', command: 'post create --post_title="Another"' },
			],
			[ 'site_delete', { nameOrPath: 'ChatGPT Acceptance' } ],
			[ 'Bash', { command: 'ls' } ],
		] as const ) {
			expect( classifyToolCall( policy, name, args ) ).toBe( 'unexpected' );
		}
	} );

	it( 'describes the platform with a release the manifest accepts, or null when it can’t read one', () => {
		for ( const release of [ '10.0.26320', '6.8.0-45-generic', '24.1.0' ] ) {
			expect( acceptancePlatform( release ).release ).toBe( release );
		}
		for ( const release of [ '6.1.0+rpt-rpi-v8', 'Darwin 24', '', 'unknown' ] ) {
			expect( acceptancePlatform( release ).release ).toBeNull();
		}
		const runDir = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-acceptance-platform-' ) );
		try {
			expect(
				openAcceptanceEvidence( runDir, 'chatgpt' ).startRun( {
					scenario: 'saved',
					createdOn: '2026-11-11',
					source: { sha: SHA, dirty: false },
					platform: acceptancePlatform( '6.1.0+rpt-rpi-v8' ),
					runtime: { node: '24.22.1', npm: '11.13.0' },
					build: { cliVersion: '1.7.3', buildId: 'a1b2c3d4e5f6' },
					model: 'gpt-6-luna',
					effort: 'medium',
					gates: [],
				} )
			).toBe( 1 );
		} finally {
			fs.rmSync( runDir, { recursive: true, force: true } );
		}
	} );

	it( 'asks the session owner as a forked turn would, keeping only whether a token came back', async () => {
		const asked: unknown[] = [];
		const answering =
			( accessToken: string | null ) =>
			( message: unknown, reply: ( message: unknown ) => void ) => {
				asked.push( message );
				setTimeout( () => reply( { type: 'studio.chatgpt-session-token', accessToken } ), 5 );
				return true;
			};
		expect( await askOwnerForSessionToken( answering( null ), REGISTRATION, 3 ) ).toBe( false );
		expect(
			await askOwnerForSessionToken( answering( 'test-access-token' ), REGISTRATION, 3 )
		).toBe( true );
		expect( await askOwnerForSessionToken( () => false, REGISTRATION, 3 ) ).toBeNull();
		expect( asked[ 0 ] ).toMatchObject( {
			type: 'studio.chatgpt-session-token.request',
			connectionId: REGISTRATION,
			logoutGeneration: 3,
		} );
	} );

	it( 'sees a tool result in a session file only once its tool result entry is written', () => {
		const dir = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-acceptance-session-file-' ) );
		const file = path.join( dir, 'session.jsonl' );
		try {
			// A file it can't read says nothing either way.
			expect( isToolResultPersisted( file, 'call-1' ) ).toBeNull();
			expect( isToolResultPersisted( dir, 'call-1' ) ).toBeNull();
			fs.writeFileSync(
				file,
				[
					JSON.stringify( {
						type: 'message',
						message: { role: 'assistant', content: [ { type: 'toolCall', id: 'call-1' } ] },
					} ),
					'not json, but it names call-1',
				].join( '\n' )
			);
			expect( isToolResultPersisted( file, 'call-1' ) ).toBe( false );
			fs.appendFileSync(
				file,
				'\r\n' +
					JSON.stringify( {
						type: 'message',
						message: { role: 'toolResult', toolCallId: 'call-1' },
					} )
			);
			expect( isToolResultPersisted( file, 'call-1' ) ).toBe( true );
			expect( isToolResultPersisted( file, 'call-2' ) ).toBe( false );
		} finally {
			fs.rmSync( dir, { recursive: true, force: true } );
		}
	} );

	it( 'reads WP-CLI post lists and refuses anything else', () => {
		expect( parseWpPostList( BASELINE ) ).toEqual( [
			{ id: 1, title: 'Hello world!', status: 'publish' },
		] );
		expect( parseWpPostList( 'Error: not a site' ) ).toBeNull();
		expect( parseWpPostList( '[{"ID":"x"}]' ) ).toBeNull();
	} );
} );

describe( 'acceptance token service', () => {
	function memoryTokens() {
		let serial = 0;
		const live = new Set< string >( [ 'refresh-0' ] );
		const revokedTokens = new Set< string >();
		const inner: ChatGptTokenClient = {
			refresh: async ( { refreshToken } ) => {
				if ( ! live.has( refreshToken ) ) {
					return { ok: false, error: { kind: 'terminal', code: 'invalid_grant', status: 400 } };
				}
				live.delete( refreshToken );
				const next = `refresh-${ ++serial }`;
				live.add( next );
				return {
					ok: true,
					value: {
						accessToken: `access-${ serial }`,
						refreshToken: next,
						tokenType: 'Bearer',
						expiresIn: 3600,
					},
				};
			},
			revoke: async ( { refreshToken } ) => {
				live.delete( refreshToken );
				revokedTokens.add( refreshToken );
				return { ok: true, value: undefined };
			},
		};
		return { inner, live, revokedTokens };
	}

	const request = ( refreshToken: string, signal = new AbortController().signal ) => ( {
		clientId: 'client',
		refreshToken,
		signal,
	} );

	it( 'holds the next successful refresh in memory until released', async () => {
		const { inner } = memoryTokens();
		const tokens = createAcceptanceTokenService( inner );
		const hold = tokens.holdNextRefresh();
		let settled = false;
		const refreshing = tokens.client.refresh( request( 'refresh-0' ) ).then( ( result ) => {
			settled = true;
			return result;
		} );
		expect( await hold.held ).toBe( true );
		await new Promise( ( resolve ) => setImmediate( resolve ) );
		expect( settled ).toBe( false );
		hold.release();
		expect( ( await refreshing ).ok ).toBe( true );
	} );

	it( 'probes the retired and rotated refresh tokens, and revokes anything a probe unexpectedly issues', async () => {
		const { inner, live } = memoryTokens();
		const tokens = createAcceptanceTokenService( inner );
		// Before any refresh there is nothing to probe.
		expect( await tokens.probe( 'rotated' ) ).toEqual( {
			tried: false,
			rejected: false,
			terminal: false,
		} );
		expect( tokens.refreshes() ).toBe( 0 );
		await tokens.client.refresh( request( 'refresh-0' ) );
		expect( tokens.refreshes() ).toBe( 1 );
		expect( await tokens.probe( 'retired' ) ).toEqual( {
			tried: true,
			rejected: true,
			terminal: true,
		} );
		// The rotated token still works: the probe says so and leaves nothing usable behind.
		expect( await tokens.probe( 'rotated' ) ).toEqual( {
			tried: true,
			rejected: false,
			terminal: false,
		} );
		expect( live.size ).toBe( 0 );
		// A probe's own refresh isn't one the broker made.
		expect( tokens.refreshes() ).toBe( 1 );
	} );

	it( 'revokes a held result the broker gave up on, so no grant is left usable', async () => {
		const { inner, live } = memoryTokens();
		const tokens = createAcceptanceTokenService( inner );
		const hold = tokens.holdNextRefresh();
		const controller = new AbortController();
		const refreshing = tokens.client.refresh( request( 'refresh-0', controller.signal ) );
		await hold.held;
		controller.abort();
		hold.release();
		await refreshing;
		expect( live.size ).toBe( 0 );
		await tokens.settle();
	} );
} );
