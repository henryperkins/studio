import { runStudioAgentTurn } from '@studio/agent/node/runtime';
import { resolveResumeSessionContext } from '@studio/agent/node/sessions/context';
import {
	createStudioSession,
	listStudioSessionFiles,
	openStudioSession,
} from '@studio/agent/node/sessions/pi-session';
import {
	readAiSettings,
	readAnthropicApiKey,
	readSelectedAiProvider,
} from '@studio/agent/node/settings-store';
import { createDisconnectedOpenAiSettings } from '@studio/agent/protocol/providers';
import { readAuthToken } from '@studio/common/lib/shared-config';
import { fetchStudioAssistantQuota } from '@studio/common/lib/studio-assistant-quota';
import { vi, type Mock } from 'vitest';
import {
	isAiProviderReady,
	resolveAiEnvironment,
	resolveInitialAiProvider,
	saveSelectedAiProvider,
} from 'cli/ai/auth';
import { JsonAdapter } from 'cli/ai/output-adapter';
import { readConnectionRegistry } from 'cli/ai/providers';
import { findSiteByFolder } from 'cli/lib/cli-config/sites';
import { disconnectFromDaemon } from 'cli/lib/daemon-client';
import { isSiteRunning } from 'cli/lib/site-utils';
import { recordTracksEvent, TRACKS_EVENTS } from 'cli/lib/tracks';
import { runCommand } from '../index';

vi.mock( '@studio/common/lib/shared-config', () => ( {
	readAuthToken: vi.fn(),
} ) );
// The quota-based wpcom default must never hit the network in tests.
vi.mock( '@studio/common/lib/studio-assistant-quota', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/common/lib/studio-assistant-quota') >() ),
	fetchStudioAssistantQuota: vi.fn().mockResolvedValue( null ),
} ) );
vi.mock( 'cli/lib/tracks', async ( importActual ) => {
	const actual = await importActual< typeof import('cli/lib/tracks') >();
	return { ...actual, recordTracksEvent: vi.fn() };
} );
vi.mock( 'cli/ai/auth', () => ( {
	resolveInitialAiProvider: vi.fn(),
	saveSelectedAiProvider: vi.fn(),
	getAvailableAiProviders: vi.fn( () => [ 'wpcom' ] ),
	isAiProviderReady: vi.fn(),
	prepareAiProvider: vi.fn(),
	resolveAiEnvironment: vi.fn(),
	resolveUnavailableAiProvider: vi.fn(),
} ) );
vi.mock( 'cli/ai/providers', () => ( {
	AI_PROVIDERS: { wpcom: 'WordPress.com', 'anthropic-api-key': 'Anthropic · API key' },
	DEFAULT_AI_PROVIDER: 'wpcom',
	getAiProviderDefinition: () => ( {
		supportsModel: () => true,
		defaultModel: 'claude-sonnet-5',
	} ),
	getStudioUserAgent: () => 'WordPressStudio',
	readConnectionRegistry: vi.fn( async () => ( { connections: [], settings: null } ) ),
	readOpenAiKeyForTurn: vi.fn( async () => null ),
} ) );
vi.mock( '@studio/agent/node/settings-store', () => ( {
	readAiSettings: vi.fn(),
	readAnthropicApiKey: vi.fn(),
	readOpenAiApiKey: vi.fn().mockResolvedValue( null ),
	readSelectedAiProvider: vi.fn().mockResolvedValue( 'wpcom' ),
} ) );
vi.mock( 'cli/lib/cli-config/sites', () => ( {
	findSiteByFolder: vi.fn(),
} ) );
vi.mock( 'cli/lib/site-utils', () => ( {
	isSiteRunning: vi.fn(),
} ) );
vi.mock( 'cli/lib/daemon-client', () => ( {
	disconnectFromDaemon: vi.fn().mockResolvedValue( undefined ),
} ) );
vi.mock( '@studio/agent/node/sessions/context', () => ( {
	resolveResumeSessionContext: vi.fn( () => ( { provider: undefined, model: undefined } ) ),
} ) );
vi.mock( '@studio/agent/node/sessions/pi-session', () => ( {
	createStudioSession: vi.fn(),
	openStudioSession: vi.fn(),
	listStudioSessionFiles: vi.fn(),
} ) );
vi.mock( 'cli/ai/sessions/replay', () => ( { replaySessionHistory: vi.fn() } ) );
vi.mock( '@studio/common/lib/well-known-paths', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/common/lib/well-known-paths') >() ),
	getSessionsDirectory: vi.fn(),
} ) );
vi.mock( '@studio/agent/node/runtime', () => ( {
	// A completed turn so the JSON single-turn path returns instead of looping.
	runStudioAgentTurn: vi.fn( () => ( {
		result: Promise.resolve(),
		interrupt: vi.fn(),
		hasTool: () => true,
	} ) ),
} ) );
vi.mock( 'cli/ai/slash-commands', () => ( { getActiveSlashCommands: vi.fn( () => [] ) } ) );
vi.mock( '@studio/agent/node/browser-utils', () => ( { closeSharedBrowser: vi.fn() } ) );
vi.mock( 'cli/commands/auth/login', () => ( { runCommand: vi.fn() } ) );
vi.mock( 'cli/ai/ui', () => ( { AiChatUI: class AiChatUI {} } ) );
vi.mock( 'cli/logger', () => ( {
	Logger: class {},
	LoggerError: class LoggerError extends Error {},
} ) );

describe( 'AI runCommand — Desktop (JSON mode) provider default', () => {
	let stdoutSpy: ReturnType< typeof vi.spyOn >;

	beforeEach( () => {
		vi.clearAllMocks();
		( createStudioSession as Mock ).mockResolvedValue( {
			appendCustomEntry: vi.fn( () => 'entry-id' ),
			getSessionId: () => 'session-id',
			getEntries: () => [],
		} );
		( readAuthToken as Mock ).mockResolvedValue( null );
		// Silence the NDJSON the adapter writes to stdout.
		stdoutSpy = vi.spyOn( process.stdout, 'write' ).mockImplementation( () => true );
	} );

	afterEach( () => {
		stdoutSpy.mockRestore();
	} );

	it( 'defaults to the wpcom provider on first run when none is configured', async () => {
		( readSelectedAiProvider as Mock ).mockResolvedValue( undefined );
		( resolveInitialAiProvider as Mock ).mockResolvedValue( 'wpcom' );

		await runCommand( { adapter: new JsonAdapter(), initialMessage: 'hello' } );

		expect( runStudioAgentTurn ).toHaveBeenCalled();
		expect( saveSelectedAiProvider ).toHaveBeenCalledTimes( 1 );
		expect( saveSelectedAiProvider ).toHaveBeenCalledWith( 'wpcom' );
	} );

	it( 'waits for the quota-based default before pinning wpcom on first run', async () => {
		( readSelectedAiProvider as Mock ).mockResolvedValue( undefined );
		( resolveInitialAiProvider as Mock ).mockResolvedValue( 'wpcom' );
		( readAuthToken as Mock ).mockResolvedValue( { accessToken: 'wpcom-token' } );
		( fetchStudioAssistantQuota as Mock ).mockImplementation(
			() =>
				new Promise( ( resolve ) =>
					setTimeout( () => resolve( { purchasedRemaining: 100_000 } ), 10 )
				)
		);
		const appendCustomEntry = vi.fn( ( _type: string, _data: { provider?: string } ) => 'id' );
		( createStudioSession as Mock ).mockResolvedValue( {
			appendCustomEntry,
			getSessionId: () => 'session-id',
			getEntries: () => [],
		} );

		await runCommand( { adapter: new JsonAdapter(), initialMessage: 'hello' } );

		const pin = appendCustomEntry.mock.calls.find(
			( [ type, data ] ) => type === 'studio.session_context' && data.provider !== undefined
		);
		expect( pin?.[ 1 ] ).toMatchObject( { provider: 'wpcom', model: 'balanced' } );
	} );

	it( 'does not override an already-configured provider', async () => {
		( readSelectedAiProvider as Mock ).mockResolvedValue( 'anthropic-api-key' );
		( readAnthropicApiKey as Mock ).mockResolvedValue( 'saved-key' );
		( resolveInitialAiProvider as Mock ).mockResolvedValue( 'anthropic-api-key' );

		await runCommand( { adapter: new JsonAdapter(), initialMessage: 'hello' } );

		expect( runStudioAgentTurn ).toHaveBeenCalled();
		expect( saveSelectedAiProvider ).not.toHaveBeenCalled();
	} );
} );

describe( 'AI runCommand — resume by id restores session model', () => {
	let stdoutSpy: ReturnType< typeof vi.spyOn >;

	beforeEach( () => {
		vi.clearAllMocks();
		( readAuthToken as Mock ).mockResolvedValue( null );
		( readSelectedAiProvider as Mock ).mockResolvedValue( 'wpcom' );
		( resolveInitialAiProvider as Mock ).mockResolvedValue( 'wpcom' );
		stdoutSpy = vi.spyOn( process.stdout, 'write' ).mockImplementation( () => true );
	} );

	afterEach( () => {
		stdoutSpy.mockRestore();
	} );

	it( 'uses the model recorded in the session rather than DEFAULT_MODEL', async () => {
		// Build a minimal session whose entries record a model_change to a
		// non-default model — the same shape that `resolveSessionModel` reads.
		const sessionEntries = [
			{
				type: 'model_change',
				id: 'e1',
				parentId: null,
				timestamp: '2024-01-01T00:00:00Z',
				modelId: 'claude-opus-5',
			},
		];
		const mockSm = {
			appendCustomEntry: vi.fn( () => 'entry-id' ),
			getSessionId: () => 'resume-id-123',
			getEntries: () => sessionEntries,
		};

		( listStudioSessionFiles as Mock ).mockResolvedValue( [ '/sessions/session-1.jsonl' ] );
		( openStudioSession as Mock ).mockResolvedValue( mockSm );
		// The run reads the recorded model from the session's context when it starts.
		const { resolveResumeSessionContext: readContext } = await vi.importActual<
			typeof import('@studio/agent/node/sessions/context')
		>( '@studio/agent/node/sessions/context' );
		( resolveResumeSessionContext as Mock ).mockImplementationOnce( readContext );

		await runCommand( {
			adapter: new JsonAdapter(),
			initialMessage: 'hello',
			resumeSessionId: 'resume-id-123',
		} );

		expect( runStudioAgentTurn ).toHaveBeenCalledTimes( 1 );
		const callArgs = ( runStudioAgentTurn as Mock ).mock.calls[ 0 ][ 1 ] as { model: string };
		expect( callArgs.model ).toBe( 'claude-opus-5' );
	} );

	it( 'chooses the provider from the conversation it names', async () => {
		const sessionEntries = [
			{
				type: 'custom',
				id: 'e1',
				parentId: null,
				timestamp: '2024-01-01T00:00:00Z',
				customType: 'studio.session_context',
				data: { provider: 'openai-api-key', model: 'gpt-6.1-sol' },
			},
		];
		( listStudioSessionFiles as Mock ).mockResolvedValue( [ '/sessions/session-1.jsonl' ] );
		( openStudioSession as Mock ).mockResolvedValue( {
			appendCustomEntry: vi.fn( () => 'entry-id' ),
			getSessionId: () => 'resume-id-123',
			getEntries: () => sessionEntries,
		} );
		( resolveResumeSessionContext as Mock ).mockImplementationOnce(
			( session?: { entries: unknown[] } ) =>
				session?.entries === sessionEntries
					? { provider: 'openai-api-key', model: 'gpt-6.1-sol' }
					: { provider: undefined, model: undefined }
		);
		( readAiSettings as Mock ).mockResolvedValue( {
			provider: 'wpcom',
			hasAnthropicApiKey: false,
			hasOpenAiApiKey: true,
			openAi: { ...createDisconnectedOpenAiSettings(), keyStorage: 'keychain' },
		} );
		( isAiProviderReady as Mock ).mockResolvedValue( true );
		( resolveAiEnvironment as Mock ).mockResolvedValue( { STUDIO_OPENAI_API_KEY: 'sk-test' } );

		await runCommand( {
			adapter: new JsonAdapter(),
			initialMessage: 'hello',
			resumeSessionId: 'resume-id-123',
		} );

		expect( resolveResumeSessionContext ).toHaveBeenCalledWith( {
			summary: { id: 'resume-id-123' },
			entries: sessionEntries,
		} );
		expect( resolveAiEnvironment ).toHaveBeenCalledWith( 'openai-api-key', expect.anything() );
	} );

	it( 'tells a JSON client when the conversation it names can’t be found', async () => {
		( listStudioSessionFiles as Mock ).mockResolvedValue( [] );
		const previousExitCode = process.exitCode;
		onTestFinished( () => {
			process.exitCode = previousExitCode;
		} );

		const adapter = new JsonAdapter();
		const showError = vi.spyOn( adapter, 'showError' );
		const emitTurnCompleted = vi.spyOn( adapter, 'emitTurnCompleted' );

		await runCommand( { adapter, initialMessage: 'hello', resumeSessionId: 'missing-id' } );

		expect( showError ).toHaveBeenCalledWith( expect.stringContaining( 'missing-id' ) );
		expect( emitTurnCompleted ).toHaveBeenCalledWith( 'error', '' );
		expect( process.exitCode ).toBe( 1 );
		expect( runStudioAgentTurn ).not.toHaveBeenCalled();
	} );
} );

describe( 'AI runCommand — active site banner running state', () => {
	let stdoutSpy: ReturnType< typeof vi.spyOn >;

	const dispatched = () =>
		( runStudioAgentTurn as Mock ).mock.calls[ 0 ][ 1 ] as {
			prompt: string;
			activeSite?: { running: boolean };
		};

	beforeEach( () => {
		vi.clearAllMocks();
		( createStudioSession as Mock ).mockResolvedValue( {
			appendCustomEntry: vi.fn( () => 'entry-id' ),
			getSessionId: () => 'session-id',
			getEntries: () => [],
		} );
		( readAuthToken as Mock ).mockResolvedValue( null );
		( readSelectedAiProvider as Mock ).mockResolvedValue( 'wpcom' );
		( resolveInitialAiProvider as Mock ).mockResolvedValue( 'wpcom' );
		stdoutSpy = vi.spyOn( process.stdout, 'write' ).mockImplementation( () => true );
	} );

	afterEach( () => {
		stdoutSpy.mockRestore();
	} );

	it( 'reports the site as running when the daemon says it is', async () => {
		( findSiteByFolder as Mock ).mockResolvedValue( {
			id: 'site-1',
			name: 'My Site',
			path: '/sites/my-site',
		} );
		( isSiteRunning as Mock ).mockResolvedValue( true );

		await runCommand( {
			adapter: new JsonAdapter(),
			initialMessage: 'hello',
			activeSite: { name: 'My Site', path: '/sites/my-site' },
		} );

		// The site rides to the runtime, which states it in the system prompt;
		// the user message stays exactly what the user typed.
		expect( dispatched().prompt ).toBe( 'hello' );
		expect( dispatched().activeSite ).toMatchObject( {
			name: 'My Site',
			path: '/sites/my-site',
			running: true,
		} );
	} );

	// STU-2040 regression guard: the per-turn isSiteRunning check opens a
	// DaemonBus socket; without a disconnect the headless (--json) process
	// never exits after the turn, and the desktop UI hangs in "working".
	it( 'closes the daemon socket after the per-turn running check so headless runs can exit', async () => {
		( findSiteByFolder as Mock ).mockResolvedValue( {
			id: 'site-1',
			name: 'My Site',
			path: '/sites/my-site',
		} );
		( isSiteRunning as Mock ).mockResolvedValue( true );

		await runCommand( {
			adapter: new JsonAdapter(),
			initialMessage: 'hello',
			activeSite: { name: 'My Site', path: '/sites/my-site' },
		} );

		expect( disconnectFromDaemon ).toHaveBeenCalled();
		const checkOrder = ( isSiteRunning as Mock ).mock.invocationCallOrder[ 0 ];
		const disconnectOrder = ( disconnectFromDaemon as Mock ).mock.invocationCallOrder[ 0 ];
		expect( disconnectOrder ).toBeGreaterThan( checkOrder );
	} );

	it( 'treats a site missing from the CLI config as stopped', async () => {
		( findSiteByFolder as Mock ).mockResolvedValue( undefined );

		await runCommand( {
			adapter: new JsonAdapter(),
			initialMessage: 'hello',
			activeSite: { name: 'Gone', path: '/sites/gone' },
		} );

		expect( isSiteRunning ).not.toHaveBeenCalled();
		expect( dispatched().activeSite?.running ).toBe( false );
	} );

	it( 'skips the daemon check for remote sites', async () => {
		await runCommand( {
			adapter: new JsonAdapter(),
			initialMessage: 'hello',
			activeSite: {
				name: 'Live',
				path: '',
				remote: true,
				url: 'https://example.wordpress.com',
				wpcomSiteId: 123,
			},
		} );

		expect( findSiteByFolder ).not.toHaveBeenCalled();
		expect( isSiteRunning ).not.toHaveBeenCalled();
		expect( dispatched().prompt ).toBe( 'hello' );
		expect( dispatched().activeSite ).toMatchObject( { remote: true, wpcomSiteId: 123 } );
	} );
} );

describe( 'AI runCommand — Tracks events', () => {
	beforeEach( () => {
		vi.clearAllMocks();
		( createStudioSession as Mock ).mockResolvedValue( {
			appendCustomEntry: vi.fn( () => 'entry-id' ),
			getSessionId: () => 'session-id',
			getEntries: () => [],
			getSessionFile: () => '/sessions/session-id.jsonl',
		} );
		( readSelectedAiProvider as Mock ).mockResolvedValue( 'wpcom' );
		( resolveInitialAiProvider as Mock ).mockResolvedValue( 'wpcom' );
		( recordTracksEvent as Mock ).mockResolvedValue( undefined );
	} );

	const eventNames = () =>
		( recordTracksEvent as Mock ).mock.calls.map( ( [ name ] ) => name as string );

	// JSON mode exits right after the turn, so both events must be awaited rather than
	// fire-and-forget — the wrapper does async work (opt-out check, install id) before the request is
	// even issued. The mock defers past a microtask so a `void` call would still be in flight when
	// the command returns, the way it would be lost to process exit in a real headless run.
	it( 'records both chat events before a headless run returns', async () => {
		const settled: string[] = [];
		( recordTracksEvent as Mock ).mockImplementation( async ( name: string ) => {
			await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
			settled.push( name );
		} );

		await runCommand( { adapter: new JsonAdapter(), initialMessage: 'hello' } );

		expect( eventNames() ).toEqual( [
			TRACKS_EVENTS.CODE_MESSAGE_SENT,
			TRACKS_EVENTS.CODE_TURN_COMPLETED,
		] );
		expect( settled ).toEqual( [
			TRACKS_EVENTS.CODE_MESSAGE_SENT,
			TRACKS_EVENTS.CODE_TURN_COMPLETED,
		] );
		const calls = ( recordTracksEvent as Mock ).mock.calls;
		expect( calls[ 0 ][ 1 ].turn_id ).toEqual( expect.any( String ) );
		expect( calls[ 1 ][ 1 ].turn_id ).toBe( calls[ 0 ][ 1 ].turn_id );
	} );

	it( 'reports the turn outcome and the resolved provider and model', async () => {
		await runCommand( { adapter: new JsonAdapter(), initialMessage: 'hello' } );

		const [ , props ] = ( recordTracksEvent as Mock ).mock.calls.find(
			( [ name ] ) => name === TRACKS_EVENTS.CODE_TURN_COMPLETED
		) as [ string, Record< string, unknown > ];
		// `interrupted` because the mocked runtime resolves without an `agent_end` event, which is what
		// promotes the status — the point here is that the recorded outcome tracks `turnState`.
		expect( props ).toMatchObject( {
			outcome: 'interrupted',
			provider: 'wpcom',
			model_family: 'studio',
			ai_session_id: 'session-id',
			client: 'studio-code',
		} );
		expect( props.duration_ms ).toBeTypeOf( 'number' );
	} );

	it( 'returns the same turn identity and edit count used by Tracks', async () => {
		const adapter = new JsonAdapter();
		const emit = vi.spyOn( adapter, 'emitTurnCompleted' );
		const turnId = crypto.randomUUID();
		await runCommand( { adapter, initialMessage: 'hello', initialTurnId: turnId } );
		const props = ( recordTracksEvent as Mock ).mock.calls.find(
			( [ name ] ) => name === TRACKS_EVENTS.CODE_TURN_COMPLETED
		)![ 1 ];
		expect( props.turn_id ).toBe( turnId );
		expect( emit ).toHaveBeenCalledWith( expect.any( String ), 'session-id', undefined, {
			turnId,
			edits: props.edits,
		} );
	} );

	it( 'does not accept arbitrary text as a correlation identifier', async () => {
		await runCommand( {
			adapter: new JsonAdapter(),
			initialMessage: 'hello',
			initialTurnId: 'private-input',
		} );
		const props = ( recordTracksEvent as Mock ).mock.calls[ 0 ][ 1 ];
		expect( props.turn_id ).toMatch( /^[0-9a-f-]{36}$/ );
		expect( JSON.stringify( ( recordTracksEvent as Mock ).mock.calls ) ).not.toContain(
			'private-input'
		);
	} );

	it.each( [
		[ undefined, false, 0 ],
		[ 'Read', false, 0 ],
		[ 'Write', true, 0 ],
		[ 'Edit', false, 1 ],
	] as const )(
		'returns successful-turn edit evidence for %s (failed=%s)',
		async ( toolName, isError, expectedEdits ) => {
			( runStudioAgentTurn as Mock ).mockImplementationOnce(
				( _host: unknown, { onEvent }: { onEvent: ( event: unknown ) => void } ) => {
					if ( toolName )
						onEvent( {
							type: 'tool_execution_end',
							toolCallId: 'tool-1',
							toolName,
							result: {},
							isError,
						} );
					onEvent( { type: 'agent_end', messages: [] } );
					return { result: Promise.resolve(), interrupt: vi.fn(), hasTool: () => true };
				}
			);
			const adapter = new JsonAdapter();
			const emit = vi.spyOn( adapter, 'emitTurnCompleted' );
			const turnId = crypto.randomUUID();
			await runCommand( { adapter, initialMessage: 'hello', initialTurnId: turnId } );
			expect( emit ).toHaveBeenCalledWith( 'success', 'session-id', undefined, {
				turnId,
				edits: expectedEdits,
			} );
			expect( recordTracksEvent ).toHaveBeenCalledWith(
				TRACKS_EVENTS.CODE_TURN_COMPLETED,
				expect.objectContaining( { turn_id: turnId, edits: expectedEdits, outcome: 'success' } )
			);
		}
	);

	it( 'adds the turn stats gathered from the agent events', async () => {
		( runStudioAgentTurn as Mock ).mockImplementationOnce(
			( _host: unknown, { onEvent }: { onEvent: ( event: unknown ) => void } ) => {
				onEvent( {
					type: 'tool_execution_end',
					toolCallId: '1',
					toolName: 'Edit',
					result: {},
					isError: false,
				} );
				return { result: Promise.resolve(), interrupt: vi.fn(), hasTool: () => true };
			}
		);

		await runCommand( { adapter: new JsonAdapter(), initialMessage: 'hello' } );

		const [ , props ] = ( recordTracksEvent as Mock ).mock.calls.find(
			( [ name ] ) => name === TRACKS_EVENTS.CODE_TURN_COMPLETED
		) as [ string, Record< string, unknown > ];
		expect( props ).toMatchObject( { tool_calls: 1, edits: 1, site_kind: 'none' } );
	} );

	// One call sits on the turn's critical path, the other in a `finally` where a rejection would
	// mask the turn's own error. Analytics must never break the chat.
	it( 'completes the turn even when recording fails', async () => {
		( recordTracksEvent as Mock ).mockRejectedValue( new Error( 'shared.json is locked' ) );

		await expect(
			runCommand( { adapter: new JsonAdapter(), initialMessage: 'hello' } )
		).resolves.toBeUndefined();
		expect( runStudioAgentTurn ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'completes the turn even when gathering the turn stats fails', async () => {
		( runStudioAgentTurn as Mock ).mockImplementationOnce(
			( _host: unknown, { onEvent }: { onEvent: ( event: unknown ) => void } ) => {
				// The failed tool makes the stats look up its name, which throws.
				onEvent( {
					type: 'tool_execution_end',
					toolCallId: '1',
					toolName: 'wp_cli',
					result: {},
					isError: true,
				} );
				return {
					result: Promise.resolve(),
					interrupt: vi.fn(),
					hasTool: () => {
						throw new Error( 'session disposed' );
					},
				};
			}
		);

		const adapter = new JsonAdapter();
		const endAgentTurn = vi.spyOn( adapter, 'endAgentTurn' );
		const showError = vi.spyOn( adapter, 'showError' );

		await expect( runCommand( { adapter, initialMessage: 'hello' } ) ).resolves.toBeUndefined();
		expect( endAgentTurn ).toHaveBeenCalledTimes( 1 );
		expect( showError ).not.toHaveBeenCalled();
		expect(
			( recordTracksEvent as Mock ).mock.calls.some(
				( [ name ] ) => name === TRACKS_EVENTS.CODE_TURN_COMPLETED
			)
		).toBe( false );
	} );
} );

describe( 'AI runCommand — pinned provider falls back when unusable', () => {
	let stdoutSpy: ReturnType< typeof vi.spyOn >;

	beforeEach( () => {
		vi.clearAllMocks();
		( readAuthToken as Mock ).mockResolvedValue( null );
		( readSelectedAiProvider as Mock ).mockResolvedValue( 'wpcom' );
		( resolveInitialAiProvider as Mock ).mockResolvedValue( 'wpcom' );
		( openStudioSession as Mock ).mockResolvedValue( {
			appendCustomEntry: vi.fn( () => 'entry-id' ),
			getSessionId: () => 'pinned-session',
			getEntries: () => [],
		} );
		stdoutSpy = vi.spyOn( process.stdout, 'write' ).mockImplementation( () => true );
	} );

	afterEach( () => {
		stdoutSpy.mockRestore();
	} );

	const resumeSession = {
		summary: { id: 'pinned-session', filePath: '/sessions/pinned.jsonl' },
		entries: [],
	} as never;

	it( 'runs on WordPress.com when the pinned provider has no key', async () => {
		( resolveResumeSessionContext as Mock ).mockReturnValue( {
			provider: 'anthropic-api-key',
			model: 'claude-sonnet-5',
		} );
		( isAiProviderReady as Mock ).mockResolvedValue( false );

		await runCommand( { adapter: new JsonAdapter(), initialMessage: 'hello', resumeSession } );

		expect( resolveAiEnvironment ).toHaveBeenCalledWith( 'wpcom', expect.anything() );
	} );

	it( 'never rewrites the pin on disk during a fallback run', async () => {
		const appendCustomEntry = vi.fn(
			( _type: string, _data: { provider?: string } ) => 'entry-id'
		);
		( openStudioSession as Mock ).mockResolvedValue( {
			appendCustomEntry,
			getSessionId: () => 'pinned-session',
			getEntries: () => [],
		} );
		( resolveResumeSessionContext as Mock ).mockReturnValue( {
			provider: 'anthropic-api-key',
			model: 'claude-sonnet-5',
		} );
		( isAiProviderReady as Mock ).mockResolvedValue( false );

		await runCommand( { adapter: new JsonAdapter(), initialMessage: 'hello', resumeSession } );

		const contextWrites = appendCustomEntry.mock.calls.filter(
			( [ type ] ) => type === 'studio.session_context'
		);
		expect( contextWrites.length ).toBeGreaterThan( 0 );
		// Per-turn records carry only the model; a provider here would clobber the pin.
		expect( contextWrites.every( ( [ , data ] ) => data.provider === undefined ) ).toBe( true );
	} );

	it( 'keeps the pin when no global provider was ever saved (Desktop first run)', async () => {
		( readSelectedAiProvider as Mock ).mockResolvedValue( undefined );
		( resolveResumeSessionContext as Mock ).mockReturnValue( {
			provider: 'anthropic-api-key',
			model: 'claude-sonnet-5',
		} );
		( isAiProviderReady as Mock ).mockResolvedValue( true );

		await runCommand( { adapter: new JsonAdapter(), initialMessage: 'hello', resumeSession } );

		expect( resolveAiEnvironment ).toHaveBeenCalledWith( 'anthropic-api-key', expect.anything() );
		// The Desktop wpcom default must not overwrite the pin on disk.
		expect( saveSelectedAiProvider ).not.toHaveBeenCalled();
	} );
} );

describe( 'AI runCommand — OpenAI conversations', () => {
	let stdoutSpy: ReturnType< typeof vi.spyOn >;
	let entries: unknown[];
	let appendCustomEntry: Mock;

	const contextEntry = ( data: Record< string, unknown > ) => ( {
		type: 'custom',
		id: Math.random().toString( 36 ).slice( 2 ),
		parentId: null,
		timestamp: new Date( 0 ).toISOString(),
		customType: 'studio.session_context',
		data,
	} );
	const resumeSession = {
		summary: { id: 'openai-session', filePath: '/sessions/openai.jsonl' },
		entries: [],
	} as never;
	const openAiSettings = ( overrides: Record< string, unknown > = {} ) => ( {
		provider: 'wpcom',
		hasAnthropicApiKey: false,
		anthropicApiKeyPreview: null,
		hasOpenAiApiKey: true,
		openAi: { ...createDisconnectedOpenAiSettings(), keyStorage: 'keychain', ...overrides },
	} );
	const turnConfig = () => ( runStudioAgentTurn as Mock ).mock.calls.at( -1 )?.[ 1 ];

	beforeEach( () => {
		vi.clearAllMocks();
		entries = [];
		appendCustomEntry = vi.fn( ( customType: string, data: unknown ) => {
			entries.push( { type: 'custom', customType, data } );
			return 'entry-id';
		} );
		( openStudioSession as Mock ).mockResolvedValue( {
			appendCustomEntry,
			getSessionId: () => 'openai-session',
			getEntries: () => entries,
		} );
		( readAuthToken as Mock ).mockResolvedValue( null );
		( readSelectedAiProvider as Mock ).mockResolvedValue( 'wpcom' );
		( resolveInitialAiProvider as Mock ).mockResolvedValue( 'wpcom' );
		( readAiSettings as Mock ).mockResolvedValue( openAiSettings() );
		( isAiProviderReady as Mock ).mockResolvedValue( true );
		( resolveAiEnvironment as Mock ).mockResolvedValue( { STUDIO_OPENAI_API_KEY: 'sk-test' } );
		( resolveResumeSessionContext as Mock ).mockReturnValue( {
			provider: 'openai-api-key',
			model: 'gpt-6.1-sol',
		} );
		stdoutSpy = vi.spyOn( process.stdout, 'write' ).mockImplementation( () => true );
	} );

	afterEach( () => {
		stdoutSpy.mockRestore();
		process.exitCode = undefined;
	} );

	it( 'starts a new OpenAI conversation on the model chosen in Settings', async () => {
		( resolveResumeSessionContext as Mock ).mockReturnValue( {
			provider: undefined,
			model: undefined,
		} );
		( resolveInitialAiProvider as Mock ).mockResolvedValue( 'openai-api-key' );
		( readAiSettings as Mock ).mockResolvedValue(
			openAiSettings( { defaultModel: 'gpt-6-luna' } )
		);
		( createStudioSession as Mock ).mockResolvedValue( {
			appendCustomEntry,
			getSessionId: () => 'new-session',
			getEntries: () => entries,
		} );
		const adapter = new JsonAdapter();
		const shown: unknown[] = [];
		Object.defineProperty( adapter, 'currentModel', {
			get: () => shown.at( -1 ),
			set: ( model ) => shown.push( model ),
		} );

		await runCommand( { adapter, initialMessage: 'hello' } );

		// Before the first turn too, so /reasoning and /clear record the right one.
		expect( shown[ 0 ] ).toBe( 'gpt-6-luna' );
		expect( turnConfig()?.openAi ).toMatchObject( { model: 'gpt-6-luna' } );
	} );

	it( 'keeps a chat that ran on OpenAI there on the app’s first run, pin or not', async () => {
		( readSelectedAiProvider as Mock ).mockResolvedValue( undefined );
		( resolveResumeSessionContext as Mock ).mockReturnValue( {
			provider: undefined,
			model: undefined,
			lastReplyProvider: 'openai-api-key',
		} );
		entries.push( contextEntry( { model: 'gpt-6.1-sol', reasoningEffort: 'medium' } ) );

		await runCommand( { adapter: new JsonAdapter(), initialMessage: 'hello', resumeSession } );

		expect( resolveAiEnvironment ).toHaveBeenCalledWith( 'openai-api-key', expect.anything() );
		expect( saveSelectedAiProvider ).not.toHaveBeenCalled();
		expect( appendCustomEntry ).not.toHaveBeenCalledWith(
			'studio.session_context',
			expect.objectContaining( { provider: 'wpcom' } )
		);
	} );

	it( 'stays on OpenAI without a key, failing the turn as disconnected', async () => {
		( isAiProviderReady as Mock ).mockResolvedValue( false );
		( resolveAiEnvironment as Mock ).mockRejectedValue( new Error( 'OpenAI isn’t connected' ) );
		entries.push( contextEntry( { provider: 'openai-api-key', model: 'gpt-6.1-sol' } ) );
		const adapter = new JsonAdapter();
		const showError = vi.spyOn( adapter, 'showError' );

		await runCommand( { adapter, initialMessage: 'hello', resumeSession } );

		expect( resolveAiEnvironment ).toHaveBeenCalledWith( 'openai-api-key', expect.anything() );
		expect( resolveAiEnvironment ).not.toHaveBeenCalledWith( 'wpcom', expect.anything() );
		expect( runStudioAgentTurn ).not.toHaveBeenCalled();
		expect( showError ).toHaveBeenCalledWith( 'OpenAI isn’t connected' );
	} );

	it( 'runs with the model, effort and mode the conversation recorded', async () => {
		entries.push(
			contextEntry( {
				provider: 'openai-api-key',
				model: 'gpt-6-astra',
				reasoningEffort: 'xhigh',
				reasoningMode: 'pro',
			} )
		);
		( readAiSettings as Mock ).mockResolvedValue( openAiSettings( { maxOutputTokens: 64_000 } ) );

		await runCommand( { adapter: new JsonAdapter(), initialMessage: 'hello', resumeSession } );

		expect( turnConfig() ).toMatchObject( {
			model: 'gpt-6-astra',
			openAi: {
				model: 'gpt-6-astra',
				apiModelId: 'gpt-6-astra',
				reasoningEffort: 'xhigh',
				reasoningMode: 'pro',
				maxOutputTokens: 64_000,
			},
		} );
		// Already pinned: the per-turn record carries only the model.
		expect( appendCustomEntry ).toHaveBeenCalledWith( 'studio.session_context', {
			model: 'gpt-6-astra',
		} );
	} );

	it( 'pins the defaults on a conversation’s first OpenAI turn', async () => {
		entries.push( contextEntry( { provider: 'openai-api-key', model: 'gpt-6.1-sol' } ) );
		( readAiSettings as Mock ).mockResolvedValue(
			openAiSettings( { defaultReasoningEffort: 'high' } )
		);

		await runCommand( { adapter: new JsonAdapter(), initialMessage: 'hello', resumeSession } );

		expect( turnConfig()?.openAi ).toMatchObject( {
			reasoningEffort: 'high',
			reasoningMode: 'standard',
		} );
		expect( appendCustomEntry ).toHaveBeenCalledWith( 'studio.session_context', {
			provider: 'openai-api-key',
			model: 'gpt-6.1-sol',
			reasoningEffort: 'high',
			reasoningMode: 'standard',
		} );
	} );

	it( 'fixes the settings when the turn starts; a change made during it applies next turn', async () => {
		entries.push(
			contextEntry( {
				provider: 'openai-api-key',
				model: 'gpt-6-luna',
				reasoningEffort: 'medium',
				reasoningMode: 'standard',
			} )
		);
		( runStudioAgentTurn as Mock ).mockImplementationOnce( () => {
			// The user picks another effort while the turn runs.
			entries.push(
				contextEntry( { provider: 'openai-api-key', model: 'gpt-6-luna', reasoningEffort: 'none' } )
			);
			return { result: Promise.resolve(), interrupt: vi.fn(), hasTool: () => true };
		} );

		await runCommand( { adapter: new JsonAdapter(), initialMessage: 'first', resumeSession } );
		expect( turnConfig()?.openAi?.reasoningEffort ).toBe( 'medium' );

		await runCommand( { adapter: new JsonAdapter(), initialMessage: 'second', resumeSession } );
		expect( turnConfig()?.openAi?.reasoningEffort ).toBe( 'none' );
	} );

	it.each( [
		[
			{ model: 'gpt-6-astra', reasoningEffort: 'none' },
			/GPT-6 Astra doesn’t support “None” reasoning\. Choose one of: Low, Medium, High, Extra high, Max\./,
		],
		[ { model: 'gpt-5.6-sol' }, /doesn’t support the OpenAI model “gpt-5\.6-sol”/ ],
	] )( 'blocks %j with a way to fix it, before contacting OpenAI', async ( data, message ) => {
		entries.push( contextEntry( { provider: 'openai-api-key', ...data } ) );
		const adapter = new JsonAdapter();
		const showError = vi.spyOn( adapter, 'showError' );

		await runCommand( { adapter, initialMessage: 'hello', resumeSession } );

		expect( runStudioAgentTurn ).not.toHaveBeenCalled();
		expect( resolveAiEnvironment ).not.toHaveBeenCalled();
		expect( showError ).toHaveBeenCalledWith( expect.stringMatching( message ) );
	} );

	it( 'runs a ChatGPT turn on its recorded connection and slug, recording the turn', async () => {
		vi.stubEnv( 'STUDIO_EXPERIMENTAL_CHATGPT', '1' );
		onTestFinished( () => {
			vi.unstubAllEnvs();
		} );
		( resolveResumeSessionContext as Mock ).mockReturnValue( {
			provider: 'chatgpt-oauth',
			model: undefined,
		} );
		( readConnectionRegistry as Mock ).mockResolvedValue( {
			connections: [
				{
					connectionId: 'conn-1',
					providerId: 'chatgpt-oauth',
					backend: 'pi',
					revision: 1,
					identity: { subject: 'test-subject-1' },
					authStatus: 'connected',
				},
			],
			settings: null,
		} );
		( resolveAiEnvironment as Mock ).mockResolvedValue( {} );
		entries.push(
			contextEntry( {
				provider: 'chatgpt-oauth',
				connectionId: 'conn-1',
				revision: 1,
				model: 'gpt-6-luna',
				reasoningEffort: 'high',
			} )
		);

		await runCommand( { adapter: new JsonAdapter(), initialMessage: 'hello', resumeSession } );

		expect( resolveAiEnvironment ).toHaveBeenCalledWith( 'chatgpt-oauth', expect.anything() );
		expect( turnConfig() ).toMatchObject( {
			connection: {
				connectionId: 'conn-1',
				model: { providerId: 'chatgpt-oauth', modelId: 'gpt-6-luna' },
				revision: 1,
			},
			chatGpt: { reasoningEffort: 'high' },
		} );
		expect( turnConfig()?.openAi ).toBeUndefined();
		expect( appendCustomEntry ).toHaveBeenCalledWith( 'studio.session_context', {
			provider: 'chatgpt-oauth',
			connectionId: 'conn-1',
			revision: 1,
			model: 'gpt-6-luna',
			reasoningEffort: 'high',
		} );
	} );

	it( 'keeps a conversation that ran on WordPress.com there when OpenAI is the default', async () => {
		( readSelectedAiProvider as Mock ).mockResolvedValue( 'openai-api-key' );
		( resolveResumeSessionContext as Mock ).mockReturnValue( {
			provider: undefined,
			model: 'fast',
		} );
		( resolveAiEnvironment as Mock ).mockResolvedValue( {} );

		await runCommand( { adapter: new JsonAdapter(), initialMessage: 'hello', resumeSession } );

		expect( resolveAiEnvironment ).toHaveBeenCalledWith( 'wpcom', expect.anything() );
		expect( turnConfig()?.openAi ).toBeUndefined();
	} );

	it( 'doesn’t ask how to connect when a terminal first resumes an OpenAI conversation', async () => {
		// No provider was ever saved: a terminal's first run.
		( readSelectedAiProvider as Mock ).mockResolvedValue( undefined );
		entries.push( contextEntry( { provider: 'openai-api-key', model: 'gpt-6.1-sol' } ) );
		const json = new JsonAdapter();
		const askUser = vi
			.spyOn( json, 'askUser' )
			.mockResolvedValue( { connect: 'WordPress.com (recommended)' } );
		// An interactive adapter: anything but the JSON one.
		const terminal = new Proxy( json, { getPrototypeOf: () => Object.prototype } );

		// The turn runs; only then would the chat loop need the real terminal UI.
		await expect(
			runCommand( { adapter: terminal, initialMessage: 'hello', resumeSession } )
		).rejects.toThrow( 'Interactive mode requires AiChatUI adapter' );

		expect( askUser ).not.toHaveBeenCalled();
		expect( resolveAiEnvironment ).toHaveBeenCalledWith( 'openai-api-key', expect.anything() );
		expect(
			appendCustomEntry.mock.calls.some(
				( [ type, data ] ) => type === 'studio.session_context' && data.provider === 'wpcom'
			)
		).toBe( false );
	} );

	it( 'keeps an old conversation whose model Studio no longer offers off OpenAI', async () => {
		( readSelectedAiProvider as Mock ).mockResolvedValue( 'openai-api-key' );
		// As it resolves with OpenAI saved as the default.
		( resolveInitialAiProvider as Mock ).mockResolvedValue( 'openai-api-key' );
		// Its replies came from WordPress.com, on a model this build dropped.
		( resolveResumeSessionContext as Mock ).mockReturnValue( {
			provider: undefined,
			model: undefined,
			lastReplyProvider: 'wpcom',
		} );
		( resolveAiEnvironment as Mock ).mockResolvedValue( {} );

		await runCommand( { adapter: new JsonAdapter(), initialMessage: 'hello', resumeSession } );

		expect( resolveAiEnvironment ).toHaveBeenCalledWith( 'wpcom', expect.anything() );
		expect( turnConfig()?.openAi ).toBeUndefined();
		expect(
			appendCustomEntry.mock.calls.some(
				( [ type, data ] ) =>
					type === 'studio.session_context' && data.provider === 'openai-api-key'
			)
		).toBe( false );
	} );
} );

describe( 'AI runCommand — ChatGPT conversations', () => {
	beforeEach( () => vi.stubEnv( 'STUDIO_EXPERIMENTAL_CHATGPT', '1' ) );
	afterEach( () => vi.unstubAllEnvs() );
	let stdoutSpy: ReturnType< typeof vi.spyOn >;
	let entries: unknown[];
	let appendCustomEntry: Mock;

	const CONNECTION_ID = 'chatgpt-connection-1';
	const chatGptRecord = () => ( {
		type: 'custom',
		id: Math.random().toString( 36 ).slice( 2 ),
		parentId: null,
		timestamp: new Date( 0 ).toISOString(),
		customType: 'studio.session_context',
		data: {
			provider: 'chatgpt-oauth',
			connectionId: CONNECTION_ID,
			revision: 1,
			model: 'gpt-6.1-sol',
		},
	} );
	const resumeSession = () =>
		( {
			summary: { id: 'chatgpt-session', filePath: '/sessions/chatgpt.jsonl' },
			entries,
		} ) as never;
	// The conversation's own entries choose its provider, as in a real run.
	const readOwnContext = async () => {
		const { resolveResumeSessionContext: readContext } = await vi.importActual<
			typeof import('@studio/agent/node/sessions/context')
		>( '@studio/agent/node/sessions/context' );
		( resolveResumeSessionContext as Mock ).mockImplementationOnce( readContext );
	};

	beforeEach( () => {
		vi.clearAllMocks();
		entries = [ chatGptRecord() ];
		appendCustomEntry = vi.fn( ( customType: string, data: unknown ) => {
			entries.push( { type: 'custom', customType, data } );
			return 'entry-id';
		} );
		( openStudioSession as Mock ).mockResolvedValue( {
			appendCustomEntry,
			getSessionId: () => 'chatgpt-session',
			getEntries: () => entries,
		} );
		( readAuthToken as Mock ).mockResolvedValue( null );
		( readSelectedAiProvider as Mock ).mockResolvedValue( 'wpcom' );
		( resolveInitialAiProvider as Mock ).mockResolvedValue( 'wpcom' );
		( isAiProviderReady as Mock ).mockResolvedValue( false );
		( resolveAiEnvironment as Mock ).mockResolvedValue( {} );
		stdoutSpy = vi.spyOn( process.stdout, 'write' ).mockImplementation( () => true );
	} );

	afterEach( () => {
		stdoutSpy.mockRestore();
		process.exitCode = undefined;
	} );

	it( 'stays on ChatGPT when its connection is gone, failing the turn as disconnected', async () => {
		await readOwnContext();
		const adapter = new JsonAdapter();
		const showError = vi.spyOn( adapter, 'showError' );

		await runCommand( { adapter, initialMessage: 'hello', resumeSession: resumeSession() } );

		expect( showError ).toHaveBeenCalledWith(
			'ChatGPT isn’t connected, so this chat can’t continue. Start a new chat with another provider.'
		);
		// Neither WordPress.com, where an unusable pin falls back, nor the API
		// key its model's family names.
		expect( resolveAiEnvironment ).not.toHaveBeenCalled();
		expect( runStudioAgentTurn ).not.toHaveBeenCalled();
		expect( appendCustomEntry ).not.toHaveBeenCalled();
		expect( saveSelectedAiProvider ).not.toHaveBeenCalled();
	} );

	it( 'blocks a resumed ChatGPT turn while the experimental feature is disabled', async () => {
		vi.stubEnv( 'STUDIO_EXPERIMENTAL_CHATGPT', '' );
		await readOwnContext();
		const adapter = new JsonAdapter();
		const showError = vi.spyOn( adapter, 'showError' );
		await runCommand( { adapter, initialMessage: 'hello', resumeSession: resumeSession() } );
		expect( showError ).toHaveBeenCalledWith(
			'ChatGPT plan connections are not enabled in this app.'
		);
		expect( readConnectionRegistry ).not.toHaveBeenCalled();
		expect( runStudioAgentTurn ).not.toHaveBeenCalled();
	} );

	it( 'never sends an OpenAI model recorded under ChatGPT to the OpenAI API key', async () => {
		( readSelectedAiProvider as Mock ).mockResolvedValue( 'openai-api-key' );
		( isAiProviderReady as Mock ).mockResolvedValue( true );
		( resolveResumeSessionContext as Mock ).mockReturnValueOnce( {
			provider: 'chatgpt-oauth',
			model: 'gpt-6.1-sol',
			lastReplyProvider: 'chatgpt-oauth',
		} );
		const adapter = new JsonAdapter();
		const showError = vi.spyOn( adapter, 'showError' );

		await runCommand( { adapter, initialMessage: 'hello', resumeSession: resumeSession() } );

		expect( resolveAiEnvironment ).not.toHaveBeenCalled();
		expect( showError ).toHaveBeenCalledWith(
			expect.stringContaining( 'ChatGPT isn’t connected' )
		);
	} );

	it( 'fails the turn when the connection changed since the chat ran on it', async () => {
		await readOwnContext();
		vi.mocked( readConnectionRegistry ).mockResolvedValueOnce( {
			connections: [
				{
					connectionId: CONNECTION_ID,
					providerId: 'chatgpt-oauth',
					backend: 'pi',
					revision: 2,
					identity: { subject: 'test-subject-1' },
					authStatus: 'connected',
				},
			],
			settings: null,
		} );
		const adapter = new JsonAdapter();
		const showError = vi.spyOn( adapter, 'showError' );

		await runCommand( { adapter, initialMessage: 'hello', resumeSession: resumeSession() } );

		expect( showError ).toHaveBeenCalledWith(
			'The ChatGPT connection this chat ran on has changed since, so the chat can’t continue. Start a new chat.'
		);
		expect( resolveAiEnvironment ).not.toHaveBeenCalled();
		expect( runStudioAgentTurn ).not.toHaveBeenCalled();
	} );

	// Undefined: no provider was ever saved, a first run, which would otherwise
	// pin the chat to WordPress.com.
	it.each( [ 'wpcom', 'openai-api-key', undefined ] )(
		'fails a chat that ran on ChatGPT with no record, rather than run it elsewhere (saved: %s)',
		async ( saved ) => {
			entries = [
				{ type: 'message', message: { role: 'user', content: 'Hello', timestamp: 0 } },
				{
					type: 'message',
					message: { role: 'assistant', content: [], provider: 'studio-chatgpt', timestamp: 0 },
				},
			];
			( readSelectedAiProvider as Mock ).mockResolvedValue( saved );
			( resolveInitialAiProvider as Mock ).mockResolvedValue( saved ?? 'wpcom' );
			( isAiProviderReady as Mock ).mockResolvedValue( true );
			await readOwnContext();
			const adapter = new JsonAdapter();
			const showError = vi.spyOn( adapter, 'showError' );

			await runCommand( { adapter, initialMessage: 'hello', resumeSession: resumeSession() } );

			expect( showError ).toHaveBeenCalledWith(
				'This chat doesn’t name a ChatGPT connection Studio can use, so it can’t continue. Start a new chat.'
			);
			expect( resolveAiEnvironment ).not.toHaveBeenCalled();
			expect( runStudioAgentTurn ).not.toHaveBeenCalled();
			expect( appendCustomEntry ).not.toHaveBeenCalled();
			expect( saveSelectedAiProvider ).not.toHaveBeenCalled();
		}
	);

	it( 'doesn’t ask how to connect when a terminal first resumes a ChatGPT conversation', async () => {
		// No provider was ever saved: a terminal's first run.
		( readSelectedAiProvider as Mock ).mockResolvedValue( undefined );
		await readOwnContext();
		const json = new JsonAdapter();
		const askUser = vi
			.spyOn( json, 'askUser' )
			.mockResolvedValue( { connect: 'WordPress.com (recommended)' } );
		// An interactive adapter: anything but the JSON one.
		const terminal = new Proxy( json, { getPrototypeOf: () => Object.prototype } );

		// The turn fails; only then would the chat loop need the real terminal UI.
		await expect(
			runCommand( { adapter: terminal, initialMessage: 'hello', resumeSession: resumeSession() } )
		).rejects.toThrow( 'Interactive mode requires AiChatUI adapter' );

		expect( askUser ).not.toHaveBeenCalled();
		expect( appendCustomEntry ).not.toHaveBeenCalled();
		expect( resolveAiEnvironment ).not.toHaveBeenCalled();
	} );
} );
