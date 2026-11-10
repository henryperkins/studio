import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { updateSharedSession } from '@studio/common/lib/shared-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteOpenAiKey, storeOpenAiKey } from '@studio/agent/node/openai-credentials';
import { createAgentRunManager } from '@studio/agent/node/run-manager';

vi.mock( 'node:child_process', () => {
	const forkMock = vi.fn();
	return { fork: forkMock, default: { fork: forkMock } };
} );
vi.mock( '@studio/agent/node/agent-stats', () => ( {
	recordAgentSend: vi.fn(),
	recordAgentRun: vi.fn(),
} ) );
vi.mock( '@studio/agent/node/sessions/placement', () => ( {
	getCreatedSiteFromArtifact: vi.fn(),
	setAiSessionSitePlacement: vi.fn(),
} ) );
vi.mock( '@studio/common/lib/error-reporting', () => ( { captureException: vi.fn() } ) );
// Never the real system keychain from a unit test.
vi.mock( '@studio/common/lib/os-credential-store', async ( importOriginal ) => {
	const items = new Map< string, string >();
	return {
		...( await importOriginal< typeof import('@studio/common/lib/os-credential-store') >() ),
		createOsCredentialStore: () => ( {
			check: async () => ( { available: true } ),
			get: async ( account: string ) => items.get( account ) ?? null,
			set: async ( account: string, secret: string ) => void items.set( account, secret ),
			delete: async ( account: string ) => void items.delete( account ),
		} ),
	};
} );
vi.mock( '@studio/common/lib/shared-config', () => ( {
	updateSharedSession: vi.fn().mockResolvedValue( undefined ),
} ) );
const chatGptBroker = vi.hoisted( () => ( {
	forkEnvironment: {} as Record< string, string >,
	invalidations: [] as unknown[],
} ) );
vi.mock( '@studio/agent/node/chatgpt/credential-broker', () => ( {
	getChatGptSessionForkEnvironment: () => chatGptBroker.forkEnvironment,
	answerChatGptSessionTokenRequest: (
		message: unknown,
		reply: ( message: unknown ) => void
	): boolean => {
		if (
			typeof message !== 'object' ||
			message === null ||
			( message as { type?: unknown } ).type !== 'studio.chatgpt-session-token.request'
		) {
			return false;
		}
		const { requestId, connectionId } = message as { requestId?: unknown; connectionId?: unknown };
		reply( {
			type: 'studio.chatgpt-session-token',
			requestId,
			connectionId,
			accessToken: 'test-access-token-run-manager',
			expiresAt: Date.now() + 3_600_000,
		} );
		return true;
	},
	answerChatGptSessionTokenInvalidation: ( message: unknown ): boolean => {
		if (
			typeof message !== 'object' ||
			message === null ||
			( message as { type?: unknown } ).type !== 'studio.chatgpt-session-token.invalidate'
		) {
			return false;
		}
		chatGptBroker.invalidations.push( message );
		return true;
	},
	beginChatGptTurn: vi.fn(),
	listChatGptConnections: async () => [],
} ) );

const mockFork = vi.mocked( fork );

function createChild() {
	const child = new EventEmitter() as EventEmitter & { kill: () => void; send: () => void };
	child.kill = vi.fn();
	child.send = vi.fn();
	return child;
}

function getForkEnv( callIndex = 0 ): NodeJS.ProcessEnv {
	const options = mockFork.mock.calls[ callIndex ][ 2 ] as { env: NodeJS.ProcessEnv };
	return options.env;
}

describe( 'createAgentRunManager fork environment', () => {
	beforeEach( () => {
		vi.clearAllMocks();
		mockFork.mockReset();
		mockFork.mockImplementation( () => createChild() as never );
	} );

	// Without this, desktop chat is attributed to `channel: studio-cli`.
	it( 'passes the resolved tracks origin to the CLI child', () => {
		const manager = createAgentRunManager( {
			cliBinary: '/cli.mjs',
			surface: 'desktop',
			emit: vi.fn(),
			getTracksOrigin: () => 'studio-ui:v2',
		} );

		manager.startAgentRun( { sessionId: 'session-1', prompt: 'hello' } );

		expect( getForkEnv().STUDIO_TRACKS_ORIGIN ).toBe( 'studio-ui:v2' );
	} );

	// The user can switch renderer without restarting.
	it( 'resolves the origin per run rather than once', () => {
		let uiVersion = 'v1';
		const manager = createAgentRunManager( {
			cliBinary: '/cli.mjs',
			surface: 'desktop',
			emit: vi.fn(),
			getTracksOrigin: () => `studio-ui:${ uiVersion }`,
		} );

		manager.startAgentRun( { sessionId: 'session-1', prompt: 'hello' } );
		expect( getForkEnv().STUDIO_TRACKS_ORIGIN ).toBe( 'studio-ui:v1' );

		uiVersion = 'v2';
		manager.startAgentRun( { sessionId: 'session-2', prompt: 'hello again' } );

		expect( getForkEnv( 1 ).STUDIO_TRACKS_ORIGIN ).toBe( 'studio-ui:v2' );
	} );

	// `studio ui` instead sets `STUDIO_TRACKS_ORIGIN` on its own process, which the fork inherits.
	it( 'omits the origin when the host does not supply one', () => {
		const manager = createAgentRunManager( {
			cliBinary: '/cli.mjs',
			surface: 'cliui',
			emit: vi.fn(),
		} );

		manager.startAgentRun( { sessionId: 'session-1', prompt: 'hello' } );

		expect( getForkEnv().STUDIO_TRACKS_ORIGIN ).toBeUndefined();
	} );
} );

describe( 'createAgentRunManager OpenAI session keys', () => {
	const KEY = 'sk-proj-TESTONLY_session_dddddddddddddddddddddddd';
	const REQUEST = { type: 'studio.openai-session-key.request' };

	function startRun() {
		const child = Object.assign( createChild(), { connected: true } );
		mockFork.mockImplementation( () => child as never );
		const emit = vi.fn();
		const manager = createAgentRunManager( { cliBinary: '/cli.mjs', surface: 'desktop', emit } );
		manager.startAgentRun( { sessionId: 'session-1', prompt: 'hello' } );
		return { child, emit };
	}

	beforeEach( () => {
		vi.clearAllMocks();
		mockFork.mockReset();
	} );

	afterEach( async () => {
		await deleteOpenAiKey();
	} );

	it( 'gives a session-only key to the forked turn over IPC, never in its environment or arguments', async () => {
		await storeOpenAiKey( KEY, 'session' );
		const { child, emit } = startRun();

		expect( getForkEnv().STUDIO_OPENAI_SESSION_KEY_OFFERED ).toBe( '1' );
		expect( JSON.stringify( getForkEnv() ) ).not.toContain( KEY );
		expect( JSON.stringify( mockFork.mock.calls[ 0 ][ 1 ] ) ).not.toContain( KEY );

		child.emit( 'message', REQUEST );

		expect( child.send ).toHaveBeenCalledWith( { type: 'studio.openai-session-key', key: KEY } );
		// The request is between the app and its turn; the UI never sees it.
		expect( JSON.stringify( emit.mock.calls ) ).not.toContain( 'openai-session-key' );
	} );

	it( 'offers nothing when the key lives in the keychain, and answers a request with none', () => {
		const { child } = startRun();

		expect( getForkEnv() ).not.toHaveProperty( 'STUDIO_OPENAI_SESSION_KEY_OFFERED' );
		child.emit( 'message', REQUEST );
		expect( child.send ).toHaveBeenCalledWith( { type: 'studio.openai-session-key', key: null } );
	} );

	it( 'does not offer or send the OpenAI session key to a Claude run', async () => {
		await storeOpenAiKey( KEY, 'session' );
		const child = Object.assign( createChild(), { connected: true } );
		mockFork.mockImplementation( () => child as never );
		const emit = vi.fn();
		const manager = createAgentRunManager( { cliBinary: '/cli.mjs', surface: 'desktop', emit } );
		manager.startAgentRun( {
			sessionId: 'claude-session',
			prompt: 'hello',
			claudeSelection: { model: 'sonnet', effort: 'medium' },
		} );
		child.emit( 'message', REQUEST );
		expect( getForkEnv() ).not.toHaveProperty( 'STUDIO_OPENAI_SESSION_KEY_OFFERED' );
		expect( child.send ).not.toHaveBeenCalled();
		expect( emit ).not.toHaveBeenCalled();
		child.emit( 'exit', 1 );
	} );
} );

describe( 'createAgentRunManager ChatGPT session tokens', () => {
	const CONNECTION_ID = '11111111-2222-4333-8444-555555555555';

	function startRun() {
		const child = Object.assign( createChild(), { connected: true } );
		mockFork.mockImplementation( () => child as never );
		const emit = vi.fn();
		const manager = createAgentRunManager( { cliBinary: '/cli.mjs', surface: 'desktop', emit } );
		manager.startAgentRun( { sessionId: 'session-1', prompt: 'hello' } );
		return { child, emit };
	}

	beforeEach( () => {
		vi.clearAllMocks();
		mockFork.mockReset();
		chatGptBroker.forkEnvironment = {};
		chatGptBroker.invalidations = [];
	} );

	it( 'offers session registrations in the fork environment, never a token', () => {
		chatGptBroker.forkEnvironment = { STUDIO_CHATGPT_SESSIONS_OFFERED: CONNECTION_ID };
		startRun();

		expect( getForkEnv().STUDIO_CHATGPT_SESSIONS_OFFERED ).toBe( CONNECTION_ID );
		expect( JSON.stringify( getForkEnv() ) ).not.toContain( 'test-access-token' );
	} );

	it( 'offers nothing when no session registration is held', () => {
		startRun();

		expect( getForkEnv() ).not.toHaveProperty( 'STUDIO_CHATGPT_SESSIONS_OFFERED' );
	} );

	it( 'answers a child token request over IPC and does not forward it as an event', () => {
		const { child, emit } = startRun();

		child.emit( 'message', {
			type: 'studio.chatgpt-session-token.request',
			requestId: 'request-1',
			connectionId: CONNECTION_ID,
		} );

		expect( child.send ).toHaveBeenCalledWith(
			expect.objectContaining( {
				type: 'studio.chatgpt-session-token',
				requestId: 'request-1',
				connectionId: CONNECTION_ID,
			} )
		);
		expect( JSON.stringify( emit.mock.calls ) ).not.toContain( 'chatgpt-session-token' );
	} );

	it( 'takes a child token invalidation without forwarding it as an event', () => {
		const { child, emit } = startRun();
		const message = {
			type: 'studio.chatgpt-session-token.invalidate',
			connectionId: CONNECTION_ID,
		};

		child.emit( 'message', message );

		expect( chatGptBroker.invalidations ).toEqual( [ message ] );
		expect( JSON.stringify( emit.mock.calls ) ).not.toContain( 'chatgpt-session-token' );
	} );
} );

describe( 'createAgentRunManager ChatGPT turn watching', () => {
	function startWatchedRun(
		resolveChatGptConnectionId: ( sessionId: string ) => Promise< string | null >,
		beginChatGptTurn: ( connectionId: string ) => Promise< {
			signal: AbortSignal;
			end: () => void;
		} >
	) {
		const child = Object.assign( createChild(), { connected: true } );
		mockFork.mockImplementation( () => child as never );
		const emit = vi.fn();
		const manager = createAgentRunManager( {
			cliBinary: '/cli.mjs',
			surface: 'desktop',
			emit,
			resolveChatGptConnectionId,
			beginChatGptTurn,
		} );
		const { runId } = manager.startAgentRun( { sessionId: 'session-1', prompt: 'hello' } );
		return { child, emit, manager, runId };
	}

	beforeEach( () => {
		vi.clearAllMocks();
		mockFork.mockReset();
		chatGptBroker.forkEnvironment = {};
		chatGptBroker.invalidations = [];
	} );

	it( 'interrupts the run when its ChatGPT connection is signed out', async () => {
		const controller = new AbortController();
		const end = vi.fn();
		const beginChatGptTurn = vi.fn( async () => ( { signal: controller.signal, end } ) );
		const { child, emit } = startWatchedRun( async () => 'connection-1', beginChatGptTurn );

		await vi.waitFor( () => expect( beginChatGptTurn ).toHaveBeenCalledWith( 'connection-1' ) );
		controller.abort( new Error( 'signed out' ) );

		expect( child.send ).toHaveBeenCalledWith( { type: 'interrupt' } );
		expect( JSON.stringify( emit.mock.calls ) ).toContain( 'run.interrupting' );
	} );

	it( 'does not begin a ChatGPT turn for a non-ChatGPT run', async () => {
		const beginChatGptTurn = vi.fn();
		startWatchedRun( async () => null, beginChatGptTurn );

		await new Promise( ( resolve ) => setImmediate( resolve ) );
		expect( beginChatGptTurn ).not.toHaveBeenCalled();
	} );

	it( 'ends the turn handle when the run exits', async () => {
		const end = vi.fn();
		const beginChatGptTurn = vi.fn( async () => ( {
			signal: new AbortController().signal,
			end,
		} ) );
		const { child } = startWatchedRun( async () => 'connection-1', beginChatGptTurn );
		await vi.waitFor( () => expect( beginChatGptTurn ).toHaveBeenCalled() );

		child.emit( 'exit', 0 );

		expect( end ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'still starts the run when beginning the ChatGPT turn fails', async () => {
		const beginChatGptTurn = vi.fn( async () => {
			throw new Error( 'disconnected' );
		} );
		const { child, runId } = startWatchedRun( async () => 'connection-1', beginChatGptTurn );

		expect( runId ).toBeTruthy();
		await vi.waitFor( () => expect( beginChatGptTurn ).toHaveBeenCalled() );
		child.emit( 'exit', 0 );
	} );
} );

describe( 'createAgentRunManager active runs', () => {
	const question = { question: 'Which layout?', options: [ { label: 'Grid', description: '' } ] };

	it( 'lists the questions a run is waiting on until they are answered', async () => {
		const child = Object.assign( createChild(), { connected: true } );
		mockFork.mockImplementation( () => child as never );
		const manager = createAgentRunManager( {
			cliBinary: '/cli.mjs',
			surface: 'cliui',
			emit: vi.fn(),
		} );
		const { runId } = manager.startAgentRun( { sessionId: 'session-1', prompt: 'hello' } );

		child.emit( 'message', { type: 'question.asked', timestamp: '', questions: [ question ] } );
		await vi.waitFor( () =>
			expect( manager.listActiveAgentRuns()[ 0 ].pendingQuestions ).toEqual( [ question ] )
		);

		manager.answerAgentRun( runId, { 'Which layout?': 'Grid' } );
		expect( manager.listActiveAgentRuns()[ 0 ].pendingQuestions ).toEqual( [] );
	} );

	it( 'marks the chat unread when a turn finishes, before reporting the exit', async () => {
		const child = createChild();
		mockFork.mockImplementation( () => child as never );
		const emit = vi.fn();
		const manager = createAgentRunManager( { cliBinary: '/cli.mjs', surface: 'cliui', emit } );
		manager.startAgentRun( { sessionId: 'session-1', prompt: 'hello' } );

		child.emit( 'exit', 0 );

		await vi.waitFor( () =>
			expect( emit ).toHaveBeenCalledWith(
				expect.objectContaining( {
					event: expect.objectContaining( {
						event: expect.objectContaining( { type: 'run.exited' } ),
					} ),
				} )
			)
		);
		expect( updateSharedSession ).toHaveBeenCalledWith( 'session-1', { unread: true } );
	} );
} );

it( 'passes the exact dispatched turn ID through the existing input payload', () => {
	const child = createChild();
	mockFork.mockReturnValueOnce( child as never );
	const manager = createAgentRunManager( {
		cliBinary: '/cli.mjs',
		surface: 'desktop',
		emit: vi.fn(),
	} );
	const turnId = crypto.randomUUID();
	manager.startAgentRun( { sessionId: 'correlated', prompt: 'hello', turnId } );
	const args = mockFork.mock.calls.at( -1 )![ 1 ] as string[];
	const input = args[ args.indexOf( '--input-payload' ) + 1 ];
	expect( JSON.parse( fs.readFileSync( input, 'utf8' ) ) ).toMatchObject( {
		prompt: 'hello',
		turnId,
	} );
	child.emit( 'exit', 0 );
} );

it( 'scopes Claude approvals and treats an exit without a terminal event as unknown', async () => {
	const child = Object.assign( createChild(), { connected: true } );
	mockFork.mockReturnValueOnce( child as never );
	const emit = vi.fn();
	const manager = createAgentRunManager( { cliBinary: '/cli.mjs', surface: 'desktop', emit } );
	const { runId } = manager.startAgentRun( {
		sessionId: 'claude',
		prompt: 'hello',
		turnId: 'turn',
		claudeSelection: { model: 'model', effort: 'high' },
	} );
	const approval = {
		type: 'approval.requested',
		runId,
		turnId: 'turn',
		requestId: 'req',
		toolCallId: 'tool',
		description: 'Approve',
	};
	child.emit( 'message', {
		type: 'backend.event',
		timestamp: '',
		event: { ...approval, runId: 'wrong' },
	} );
	child.emit( 'message', { type: 'backend.event', timestamp: '', event: approval } );
	await vi.waitFor( () =>
		expect( manager.listActiveAgentRuns()[ 0 ].pendingClaudeApprovals ).toEqual( [ approval ] )
	);
	manager.answerAgentRun( runId, { req: 'allow' } );
	manager.answerAgentRun( runId, { req: 'allow' } );
	expect( child.send ).toHaveBeenCalledTimes( 1 );
	child.emit( 'exit', 0 );
	await vi.waitFor( () =>
		expect( emit ).toHaveBeenCalledWith(
			expect.objectContaining( {
				event: expect.objectContaining( {
					event: expect.objectContaining( {
						type: 'backend.event',
						event: expect.objectContaining( {
							type: 'turn.terminal',
							outcome: { status: 'unknown_process_exit' },
						} ),
					} ),
				} ),
			} )
		)
	);
} );
