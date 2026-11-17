// @vitest-environment node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	ChatGptConnectionError,
	readChatGptAccounts,
} from '@studio/agent/node/chatgpt/account-store';
import {
	beginChatGptTurn,
	listChatGptConnections,
	signOutChatGpt,
} from '@studio/agent/node/chatgpt/credential-broker';
import {
	beginChatGptSignIn,
	cancelChatGptSignIn,
	waitForChatGptSignIn,
} from '@studio/agent/node/chatgpt/oauth';
import { runStudioAgentTurn } from '@studio/agent/node/runtime';
import { createStudioSession, openStudioSession } from '@studio/agent/node/sessions/pi-session';
import { readAiSettings, readSelectedAiProvider } from '@studio/agent/node/settings-store';
import { readChatGptSessionSelection } from '@studio/agent/protocol/chatgpt';
import {
	createDisconnectedOpenAiSettings,
	getAiProviderModels,
	getEffectiveSessionProvider,
} from '@studio/agent/protocol/providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	resolveAiEnvironment,
	resolveInitialAiProvider,
	saveSelectedAiProvider,
} from 'cli/ai/auth';
import { runsOnChatGpt } from 'cli/ai/chatgpt';
import { getActiveSlashCommands } from 'cli/ai/slash-commands';
import { AiChatUI } from 'cli/ai/ui';
import { runCommand } from '../index';
import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent';
import type { ChatGptAccount } from '@studio/agent/node/chatgpt/account-store';
import type { StudioAgentTurnConfig } from '@studio/agent/node/runtime';
import type { AiProviderId } from '@studio/agent/protocol/providers';

vi.mock( '@studio/common/lib/shared-config', () => ( { readAuthToken: async () => null } ) );
const keychainChecks = vi.hoisted( () => vi.fn( async () => ( { available: true } ) ) );
vi.mock( '@studio/common/lib/os-credential-store', () => ( {
	createOsCredentialStore: () => ( { check: keychainChecks } ),
} ) );
vi.mock( '@studio/agent/node/settings-store', async ( original ) => ( {
	...( await original< object >() ),
	readAiSettings: vi.fn(),
	readSelectedAiProvider: vi.fn(),
} ) );
vi.mock( '@studio/agent/node/chatgpt/account-store', async ( original ) => ( {
	...( await original< object >() ),
	readChatGptAccounts: vi.fn(),
} ) );
vi.mock( '@studio/agent/node/chatgpt/credential-broker', () => ( {
	beginChatGptTurn: vi.fn(),
	listChatGptConnections: vi.fn(),
	signOutChatGpt: vi.fn(),
	getChatGptAccessToken: vi.fn(),
	invalidateChatGptAccessToken: vi.fn(),
} ) );
vi.mock( '@studio/agent/node/chatgpt/oauth', async ( original ) => ( {
	...( await original< object >() ),
	beginChatGptSignIn: vi.fn(),
	waitForChatGptSignIn: vi.fn(),
	cancelChatGptSignIn: vi.fn(),
} ) );
vi.mock( '@studio/agent/node/runtime', () => ( { runStudioAgentTurn: vi.fn() } ) );
vi.mock( 'cli/ai/host', () => ( { cliAgentHost: { sitesRoot: process.cwd() } } ) );
vi.mock( 'cli/lib/tos-notice', () => ( { maybeShowTosNotice: async () => {} } ) );
vi.mock( 'cli/lib/tracks', async ( original ) => ( {
	...( await original< object >() ),
	recordTracksEvent: vi.fn(),
} ) );
vi.mock( 'cli/ai/sessions/replay', () => ( { replaySessionHistory: vi.fn() } ) );
vi.mock( 'cli/ai/auth', () => ( {
	resolveInitialAiProvider: vi.fn( async () => 'openai-api-key' ),
	resolveUnavailableAiProvider: async () => undefined,
	isAiProviderReady: async () => true,
	getAvailableAiProviders: async () => [ 'wpcom', 'anthropic-api-key', 'openai-api-key' ],
	prepareAiProvider: async () => {},
	resolveAiEnvironment: vi.fn( async () => ( {} ) ),
	saveSelectedAiProvider: vi.fn(),
} ) );
vi.mock( 'cli/ai/providers', async () => {
	const { AI_PROVIDER_LABELS, getAiProviderDefaultModel } = await import(
		'@studio/agent/protocol/providers'
	);
	return {
		AI_PROVIDERS: { ...AI_PROVIDER_LABELS, 'openai-api-key': 'OpenAI · API key' },
		DEFAULT_AI_PROVIDER: 'wpcom',
		getStudioUserAgent: () => 'Studio CLI test',
		readConnectionRegistry: async () => ( {
			connections: await listChatGptConnections(),
			settings: null,
		} ),
		readOpenAiKeyForTurn: async () => null,
		getAiProviderDefinition: ( provider: AiProviderId ) => ( {
			defaultModel: getAiProviderDefaultModel( provider ),
			availableModels: getAiProviderModels( provider ).map( ( model ) => model.id ),
			supportsModel: ( model: string ) =>
				getAiProviderModels( provider ).some( ( item ) => item.id === model ),
		} ),
	};
} );
vi.mock( 'cli/ai/ui', () => ( { AiChatUI: class AiChatUI {} } ) );

const A = 'f84d75a0-4e60-4168-a1ab-3134542c637a';
const B = '1c8e270b-9b5c-4687-b989-de052014b9e8';
const ATTEMPT = 'b69a1ddf-d1a2-4ff6-b293-75c358ff42df';
const INITIAL = { connectionId: A, revision: 1, model: 'gpt-6-luna', reasoningEffort: 'medium' };
const account = ( registrationId: string, label: string ): ChatGptAccount => ( {
	registrationId,
	label,
	email: 'same@example.test',
	subject: registrationId,
	issuer: 'https://auth.example.test',
	clientId: 'TEST_ONLY_CLIENT',
	storage: 'vault',
	state: 'signed-in',
	revision: 1,
	logoutGeneration: 0,
	createdAt: '2026-11-10T00:00:00Z',
	updatedAt: '2026-11-10T00:00:00Z',
} );
let root: string;
let runs: Array< { config: StudioAgentTurnConfig; entries: SessionEntry[]; sessionId: string } >;

beforeEach( async () => {
	root = await fs.mkdtemp( path.join( os.tmpdir(), 'studio-chatgpt-cli-' ) );
	vi.stubEnv( 'DEV_CONFIG_DIR', root );
	vi.stubEnv( 'STUDIO_EXPERIMENTAL_CHATGPT', '1' );
	vi.spyOn( process, 'exit' ).mockImplementation( () => undefined as never );
	vi.mocked( readSelectedAiProvider ).mockResolvedValue( 'openai-api-key' );
	vi.mocked( readAiSettings ).mockResolvedValue( {
		provider: 'openai-api-key',
		hasAnthropicApiKey: false,
		anthropicApiKeyPreview: null,
		hasOpenAiApiKey: false,
		openAi: { ...createDisconnectedOpenAiSettings(), defaultModel: 'gpt-6-luna' },
	} );
	vi.mocked( readChatGptAccounts ).mockResolvedValue( [
		account( A, 'Personal' ),
		account( B, 'Work' ),
	] );
	vi.mocked( listChatGptConnections ).mockResolvedValue(
		[ A, B ].map( ( connectionId ) => ( {
			connectionId,
			providerId: 'chatgpt-oauth',
			backend: 'pi',
			revision: 1,
			authStatus: 'connected',
			identity: { subject: connectionId },
		} ) )
	);
	vi.mocked( beginChatGptTurn ).mockImplementation( async ( connectionId ) => ( {
		connectionId,
		signal: new AbortController().signal,
		getAccessToken: async () => 'TEST_ONLY_ACCESS',
		invalidateAccessToken: async () => {},
		assertActive: async () => {},
		end: () => {},
	} ) );
	vi.spyOn( globalThis, 'fetch' ).mockImplementation(
		async () =>
			new Response(
				JSON.stringify( {
					models: [
						{ slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'list' },
						{ slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', visibility: 'list' },
					],
				} )
			)
	);
	runs = [];
	vi.mocked( runStudioAgentTurn ).mockImplementation( ( _host, config ) => {
		const session = config.session!;
		runs.push( {
			config,
			entries: structuredClone( session.getEntries() ),
			sessionId: session.getSessionId(),
		} );
		session.appendMessage( { role: 'user', content: config.prompt, timestamp: Date.now() } );
		config.onEvent?.( { type: 'agent_end', messages: [], willRetry: false } );
		return { result: Promise.resolve(), interrupt: async () => {}, hasTool: () => false };
	} );
} );
afterEach( async () => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.unstubAllEnvs();
	await fs.rm( root, { recursive: true, force: true } );
} );

function terminal( prompts: string[], answers: string[] ) {
	return Object.assign( new AiChatUI(), {
		activeSite: null,
		onInterrupt: null,
		start: vi.fn(),
		stop: vi.fn(),
		showWelcome: vi.fn(),
		showInfo: vi.fn(),
		showError: vi.fn(),
		setStatusMessage: vi.fn(),
		showCapabilities: vi.fn(),
		showOnboarding: vi.fn(),
		clearTranscript: vi.fn(),
		addUserMessage: vi.fn(),
		beginAgentTurn: vi.fn(),
		endAgentTurn: vi.fn(),
		handleEvent: vi.fn(),
		hasErrorBeenSurfaced: () => false,
		setBusy: vi.fn(),
		waitForInput: vi.fn( async () => prompts.shift() ?? '/exit' ),
		askUser: vi.fn( async ( questions: Parameters< AiChatUI[ 'askUser' ] >[ 0 ] ) => {
			const answer = answers.shift();
			expect(
				questions[ 0 ].options.some( ( option: { label: string } ) => option.label === answer )
			).toBe( true );
			return { [ questions[ 0 ].question ]: answer! };
		} ),
	} );
}

async function previousChat( provider: AiProviderId = 'chatgpt-oauth', connectionId = A ) {
	const session = await createStudioSession( root );
	session.appendCustomEntry( 'studio.session_context', {
		provider,
		...INITIAL,
		connectionId,
		...( provider === 'openai-api-key' ? { reasoningMode: 'standard' } : {} ),
	} );
	session.appendMessage( {
		role: 'user',
		content: 'Previous private conversation',
		timestamp: Date.now(),
	} );
	return session;
}
const resume = ( session: SessionManager ) =>
	( {
		summary: { id: session.getSessionId(), filePath: session.getSessionFile() },
		entries: session.getEntries(),
	} ) as never;

describe( 'ChatGPT interactive CLI', () => {
	it.each( [ 'openai-api-key', 'chatgpt-oauth' ] as const )(
		'starts a new file when moving from %s to a different ChatGPT connection',
		async ( provider ) => {
			const old = await previousChat( provider );
			const original = await fs.readFile( old.getSessionFile()!, 'utf8' );
			const ui = terminal(
				[ '/chatgpt', 'New request' ],
				[
					'Select saved account',
					`Work · ${ B }`,
					'GPT-6 Luna · gpt-6-luna',
					'Low',
					'Start new chat',
				]
			);
			await runCommand( { adapter: ui, resumeSession: resume( old ) } );
			expect( ui.showError ).not.toHaveBeenCalled();
			expect( runs ).toHaveLength( 1 );
			expect( runs[ 0 ].sessionId ).not.toBe( old.getSessionId() );
			expect( readChatGptSessionSelection( runs[ 0 ].entries ) ).toEqual( {
				...INITIAL,
				connectionId: B,
				reasoningEffort: 'low',
			} );
			expect( JSON.stringify( runs[ 0 ].entries ) ).not.toContain(
				'Previous private conversation'
			);
			expect( await fs.readFile( old.getSessionFile()!, 'utf8' ) ).toBe( original );
			expect( runs[ 0 ].config.openAi ).toBeUndefined();
			expect( saveSelectedAiProvider ).not.toHaveBeenCalled();
		}
	);

	it( 'creates a new API conversation when leaving ChatGPT with the same model slug', async () => {
		const old = await previousChat();
		const original = await fs.readFile( old.getSessionFile()!, 'utf8' );
		const ui = terminal( [ '/provider', 'New API request' ], [ 'OpenAI · API key' ] );
		await runCommand( { adapter: ui, resumeSession: resume( old ) } );
		expect( ui.showError ).not.toHaveBeenCalled();
		expect( runs ).toHaveLength( 1 );
		expect( runs[ 0 ].sessionId ).not.toBe( old.getSessionId() );
		expect( getEffectiveSessionProvider( runs[ 0 ].entries ) ).toBe( 'openai-api-key' );
		expect( runs[ 0 ].config.openAi?.model ).toBe( 'gpt-6-luna' );
		expect( runs[ 0 ].config.connection ).toBeUndefined();
		expect( JSON.stringify( runs[ 0 ].entries ) ).not.toContain( 'Previous private conversation' );
		expect( await fs.readFile( old.getSessionFile()!, 'utf8' ) ).toBe( original );
	} );

	it( 'keeps model and effort changes on the same account in the same file across resume', async () => {
		const old = await previousChat();
		const ui = terminal(
			[ '/model', 'First request', '/reasoning', 'Second request' ],
			[ 'GPT-6 Luna · gpt-6-luna', 'Low', 'Medium' ]
		);
		await runCommand( { adapter: ui, resumeSession: resume( old ) } );
		expect( ui.showError ).not.toHaveBeenCalled();
		expect( runs ).toHaveLength( 2 );
		expect( runs.map( ( run ) => run.sessionId ) ).toEqual( [
			old.getSessionId(),
			old.getSessionId(),
		] );
		expect( runs.map( ( run ) => run.config.chatGpt?.reasoningEffort ) ).toEqual( [
			'low',
			'medium',
		] );
		expect( runs[ 1 ].config.connection?.model.modelId ).toBe( 'gpt-6-luna' );
		const reopened = await openStudioSession( root, old.getSessionFile()! );
		expect( readChatGptSessionSelection( reopened.getEntries() ) ).toEqual( {
			...INITIAL,
			reasoningEffort: 'medium',
		} );
		expect( ui.clearTranscript ).not.toHaveBeenCalled();
	} );

	it( 'offers only the listed models and efforts the route is qualified for', async () => {
		const old = await previousChat();
		const ui = terminal( [ '/model', '/exit' ], [ 'GPT-6 Luna · gpt-6-luna', 'Low' ] );
		await runCommand( { adapter: ui, resumeSession: resume( old ) } );
		const offered = vi
			.mocked( ui.askUser )
			.mock.calls.map( ( [ questions ] ) =>
				questions[ 0 ].options.map( ( option: { label: string } ) => option.label )
			);
		// The account also lists GPT-6 Astra, which isn't qualified on this route.
		expect( offered ).toEqual( [ [ 'GPT-6 Luna · gpt-6-luna' ], [ 'Low', 'Medium' ] ] );
	} );

	it( 'runs a turn with attached images and files on the chat’s pinned connection, model and effort', async () => {
		const old = await previousChat();
		const image = {
			id: 'image-1',
			name: 'moodboard.png',
			mimeType: 'image/png' as const,
			size: 11,
			dataBase64: 'aW1hZ2UtYnl0ZXM=',
		};
		const brief = path.join( root, 'brief.md' );
		const ui = terminal( [], [] );
		await runCommand( {
			adapter: ui,
			resumeSession: resume( old ),
			initialMessage: 'Use these',
			initialImages: [ image ],
			initialFiles: [ { id: 'file-1', name: 'brief.md', path: brief } ],
		} );
		expect( ui.showError ).not.toHaveBeenCalled();
		expect( runs ).toHaveLength( 1 );
		const { config } = runs[ 0 ];
		expect( config.images ).toEqual( [ image ] );
		expect( config.prompt ).toBe(
			`Use these\n\nAttached files (read them as needed):\n- ${ brief }`
		);
		expect( config.connection ).toEqual( {
			connectionId: A,
			revision: 1,
			model: { providerId: 'chatgpt-oauth', modelId: 'gpt-6-luna' },
		} );
		expect( config.chatGpt ).toEqual( { reasoningEffort: 'medium' } );
		expect( config.openAi ).toBeUndefined();
	} );

	it( 'preserves the account on /clear while dropping the previous conversation', async () => {
		const old = await previousChat();
		await runCommand( {
			adapter: terminal( [ '/clear', 'New request' ], [] ),
			resumeSession: resume( old ),
		} );
		expect( runs ).toHaveLength( 1 );
		expect( runs[ 0 ].sessionId ).not.toBe( old.getSessionId() );
		expect( readChatGptSessionSelection( runs[ 0 ].entries ) ).toEqual( INITIAL );
		expect( JSON.stringify( runs[ 0 ].entries ) ).not.toContain( 'Previous private conversation' );
	} );

	it( 'keeps the original conversation when an account switch is canceled', async () => {
		const old = await previousChat();
		const ui = terminal(
			[ '/chatgpt', 'Still here' ],
			[ 'Select saved account', `Work · ${ B }`, 'GPT-6 Luna · gpt-6-luna', 'Low', 'Cancel' ]
		);
		await runCommand( { adapter: ui, resumeSession: resume( old ) } );
		expect( runs[ 0 ].sessionId ).toBe( old.getSessionId() );
		expect( runs[ 0 ].config.connection?.connectionId ).toBe( A );
		expect( ui.clearTranscript ).not.toHaveBeenCalled();
	} );

	it( 'hides /chatgpt when disabled and refuses existing ChatGPT turns before model discovery', async () => {
		vi.stubEnv( 'STUDIO_EXPERIMENTAL_CHATGPT', '' );
		expect( getActiveSlashCommands().some( ( command ) => command.name === 'chatgpt' ) ).toBe(
			false
		);
		const ui = terminal( [ 'New request' ], [] );
		await runCommand( { adapter: ui, resumeSession: resume( await previousChat() ) } );
		expect( ui.showError ).toHaveBeenCalledWith(
			'ChatGPT plan connections are not enabled in this app.'
		);
		expect( runs ).toHaveLength( 0 );
		expect( resolveAiEnvironment ).not.toHaveBeenCalled();
		expect( listChatGptConnections ).not.toHaveBeenCalled();
	} );

	it( 'keeps a ChatGPT chat chosen on a first run when an API key is set afterwards', async () => {
		vi.mocked( readSelectedAiProvider ).mockResolvedValue( undefined );
		// A first run offers to choose how to connect only off OpenAI and ChatGPT.
		vi.mocked( resolveInitialAiProvider ).mockResolvedValueOnce( 'wpcom' );
		const ui = terminal(
			[ '/chatgpt', '/api-key', 'New request' ],
			[
				'Select saved account',
				`Personal · ${ A }`,
				'GPT-6 Luna · gpt-6-luna',
				'Low',
				'Start new chat',
			]
		);
		const answer = ui.askUser;
		// The first run's "Choose how to connect" is closed without a choice.
		ui.askUser = vi.fn( async ( questions: Parameters< typeof answer >[ 0 ] ) =>
			questions[ 0 ].question === 'Choose how to connect' ? {} : answer( questions )
		);

		await runCommand( { adapter: ui } );

		expect( ui.showOnboarding ).toHaveBeenCalled();
		expect( ui.showError ).not.toHaveBeenCalled();
		expect( saveSelectedAiProvider ).not.toHaveBeenCalled();
		expect( runs ).toHaveLength( 1 );
		expect( runs[ 0 ].config.connection?.connectionId ).toBe( A );
		expect( readChatGptSessionSelection( runs[ 0 ].entries ) ).toMatchObject( {
			connectionId: A,
			reasoningEffort: 'low',
		} );
	} );

	it( 'leaves a conversation that ran on ChatGPT when switching provider, pinned there or only by its last reply', () => {
		const reply = {
			type: 'message',
			id: 'reply',
			parentId: null,
			timestamp: new Date( 0 ).toISOString(),
			message: { role: 'assistant', content: [], provider: 'studio-chatgpt', model: 'x' },
		} as unknown as SessionEntry;
		const pin = {
			type: 'custom',
			id: 'pin',
			parentId: null,
			timestamp: new Date( 0 ).toISOString(),
			customType: 'studio.session_context',
			data: { provider: 'chatgpt-oauth', connectionId: A, revision: 1 },
		} as unknown as SessionEntry;

		expect( runsOnChatGpt( 'chatgpt-oauth', [] ) ).toBe( true );
		expect( runsOnChatGpt( 'wpcom', [ reply ] ) ).toBe( true );
		expect( runsOnChatGpt( 'chatgpt-oauth', [ reply ] ) ).toBe( true );
		expect( runsOnChatGpt( 'wpcom', [ pin ] ) ).toBe( true );
		expect( runsOnChatGpt( 'openai-api-key', [] ) ).toBe( false );
	} );

	it( 'with ChatGPT off, says so at /chatgpt and offers only signing out of the saved sign-ins', async () => {
		vi.stubEnv( 'STUDIO_EXPERIMENTAL_CHATGPT', '' );
		vi.mocked( signOutChatGpt ).mockResolvedValueOnce( {
			localCleared: true,
			remoteRevocationConfirmed: true,
		} );
		const ui = terminal( [ '/chatgpt' ], [ 'Sign out', `Personal · ${ A }` ] );

		await runCommand( { adapter: ui } );

		expect( ui.showInfo ).toHaveBeenCalledWith(
			'ChatGPT plan connections are not enabled in this app.'
		);
		expect(
			vi.mocked( ui.askUser ).mock.calls[ 0 ][ 0 ][ 0 ].options.map( ( option ) => option.label )
		).toEqual( [ 'Sign out' ] );
		expect( signOutChatGpt ).toHaveBeenCalledExactlyOnceWith( A );
		expect( ui.showInfo ).toHaveBeenCalledWith(
			'Signed out locally. Remote revocation confirmed.'
		);
		expect( beginChatGptSignIn ).not.toHaveBeenCalled();
		expect( listChatGptConnections ).not.toHaveBeenCalled();
		expect( runs ).toHaveLength( 0 );
		// It stays out of the command list while ChatGPT is off.
		expect( getActiveSlashCommands().some( ( command ) => command.name === 'chatgpt' ) ).toBe(
			false
		);
	} );

	it.each( [
		[ 'none saved', async () => [] ],
		[
			'only a signed-out one',
			async () => [ { ...account( A, 'Personal' ), state: 'signed-out' } ],
		],
		[
			'an accounts file it can’t read',
			async () => {
				throw new ChatGptConnectionError( 'accounts-unreadable' );
			},
		],
	] )(
		'with ChatGPT off and no saved sign-in (%s), leaves /chatgpt to the agent as a prompt, as before ChatGPT',
		async ( _name, accounts ) => {
			vi.stubEnv( 'STUDIO_EXPERIMENTAL_CHATGPT', '' );
			vi.mocked( readChatGptAccounts ).mockImplementation( accounts as () => Promise< [] > );
			const ui = terminal( [ '/chatgpt' ], [] );

			await runCommand( { adapter: ui } );

			expect( ui.showError ).not.toHaveBeenCalled();
			expect( ui.showInfo ).not.toHaveBeenCalledWith(
				'ChatGPT plan connections are not enabled in this app.'
			);
			expect( ui.askUser ).not.toHaveBeenCalled();
			expect( runs ).toHaveLength( 1 );
			expect( runs[ 0 ].config.prompt ).toBe( '/chatgpt' );
			// Only the accounts index decides: no connection, keychain or sign-in is read.
			expect( readChatGptAccounts ).toHaveBeenCalledTimes( 1 );
			expect( listChatGptConnections ).not.toHaveBeenCalled();
			expect( keychainChecks ).not.toHaveBeenCalled();
			expect( beginChatGptSignIn ).not.toHaveBeenCalled();
			expect( signOutChatGpt ).not.toHaveBeenCalled();
		}
	);

	it.each( [
		[ 'an unknown recorded effort', { reasoningEffort: 'future-effort' }, 'future-effort' ],
		[
			'a recorded effort the route isn’t qualified for',
			{ reasoningEffort: 'high' },
			'Studio doesn’t support “High” reasoning for gpt-6-luna with ChatGPT yet',
		],
		[
			'a recorded model the route isn’t qualified for',
			{ model: 'gpt-6.1-sol' },
			'Studio doesn’t support the ChatGPT model “gpt-6.1-sol” yet',
		],
	] )( 'does not silently replace %s', async ( _name, recorded, explanation ) => {
		const old = await previousChat();
		old.appendCustomEntry( 'studio.session_context', {
			provider: 'chatgpt-oauth',
			...INITIAL,
			...recorded,
		} );
		const ui = terminal( [ 'New request' ], [] );
		await runCommand( { adapter: ui, resumeSession: resume( old ) } );
		expect( ui.showError ).toHaveBeenCalledWith( expect.stringContaining( explanation ) );
		expect( runs ).toHaveLength( 0 );
		expect( resolveAiEnvironment ).not.toHaveBeenCalled();
	} );

	it( 'does not choose another account after sign-out', async () => {
		vi.mocked( signOutChatGpt ).mockImplementationOnce( async () => {
			vi.mocked( listChatGptConnections ).mockResolvedValue( [
				{
					connectionId: B,
					providerId: 'chatgpt-oauth',
					backend: 'pi',
					revision: 1,
					authStatus: 'connected',
					identity: { subject: B },
				},
			] );
			return { localCleared: true, remoteRevocationConfirmed: false };
		} );
		const ui = terminal( [ '/chatgpt', 'Private follow-up' ], [ 'Sign out', `Personal · ${ A }` ] );
		await runCommand( { adapter: ui, resumeSession: resume( await previousChat() ) } );
		expect( signOutChatGpt ).toHaveBeenCalledExactlyOnceWith( A );
		expect( ui.showInfo ).toHaveBeenCalledWith(
			expect.stringContaining( 'Remote revocation wasn’t confirmed' )
		);
		expect( ui.showError ).toHaveBeenCalledWith(
			expect.stringContaining( 'ChatGPT isn’t connected' )
		);
		expect( runs ).toHaveLength( 0 );
		expect( saveSelectedAiProvider ).not.toHaveBeenCalled();
	} );

	it( 'cancels returning sign-in from the terminal without exposing its URL', async () => {
		const privateUrl =
			'https://auth.example.test/authorize?id_token_hint=TEST_ONLY_PRIVATE_ID_TOKEN';
		const ui = terminal(
			[ '/chatgpt' ],
			[ 'Sign in again', `Personal · ${ A }`, 'This app session' ]
		);
		vi.mocked( beginChatGptSignIn ).mockResolvedValueOnce( {
			attemptId: ATTEMPT,
			authorizationUrl: privateUrl,
		} as never );
		vi.mocked( waitForChatGptSignIn ).mockImplementationOnce( async () => {
			( ui.onInterrupt as ( () => void ) | null )?.();
			return { ok: false, code: 'cancelled', message: 'Signing in was cancelled.' };
		} );
		vi.mocked( cancelChatGptSignIn ).mockReturnValueOnce( true );
		await runCommand( { adapter: ui, resumeSession: resume( await previousChat() ) } );
		expect( beginChatGptSignIn ).toHaveBeenCalledWith(
			A,
			{ storage: 'session' },
			{ storageChosen: expect.any( Function ) }
		);
		expect( cancelChatGptSignIn ).toHaveBeenCalledWith( ATTEMPT );
		expect( ui.showInfo ).toHaveBeenCalledWith( 'Signing in to ChatGPT was cancelled.' );
		expect( JSON.stringify( [ ui.showInfo.mock.calls, ui.showError.mock.calls ] ) ).not.toContain(
			privateUrl
		);
		expect( ui.onInterrupt ).toBeNull();
	} );
} );
