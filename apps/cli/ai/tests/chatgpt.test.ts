import { readChatGptSettings, startChatGptSignIn } from '@studio/agent/node/chatgpt/settings';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runChatGptCommand } from 'cli/ai/chatgpt';
import type { SlashCommandContext } from 'cli/ai/slash-commands';

vi.mock( '@studio/agent/node/chatgpt/settings', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/agent/node/chatgpt/settings') >();
	return {
		...actual,
		readChatGptSettings: vi.fn(),
		startChatGptSignIn: vi.fn(),
		finishChatGptSignIn: vi.fn(),
		stopChatGptSignIn: vi.fn(),
	};
} );

function makeUi() {
	return {
		showInfo: vi.fn(),
		showError: vi.fn(),
		setBusy: vi.fn(),
		// Start signing in, then choose no way to keep it.
		askUser: vi.fn().mockResolvedValueOnce( { plan: 'Start sign-in' } ).mockResolvedValueOnce( {} ),
		onInterrupt: null,
	};
}

function makeCtx( ui: ReturnType< typeof makeUi > ): SlashCommandContext {
	return {
		ui: ui as unknown as SlashCommandContext[ 'ui' ],
		currentModel: 'claude-sonnet-5' as SlashCommandContext[ 'currentModel' ],
		currentProvider: 'wpcom' as SlashCommandContext[ 'currentProvider' ],
		showCapabilitiesOnConnect: false,
		switchProvider: vi.fn(),
		prepareProviderSelection: vi.fn(),
		maybeAutoSwitchProvider: vi.fn(),
		persistSessionContext: vi.fn(),
		clearSession: vi.fn(),
		getSessionEntries: vi.fn().mockResolvedValue( [] ),
		persistOpenAiReasoning: vi.fn(),
		selectChatGpt: vi.fn(),
	};
}

// The standalone CLI declares no system packages, so `/chatgpt` is where its users learn what saving a sign-in needs.
describe( 'signing in with /chatgpt where secure storage is unavailable', () => {
	const platform = process.platform;

	afterEach( () => {
		Object.defineProperty( process, 'platform', { value: platform } );
		vi.clearAllMocks();
	} );

	async function startSigningIn(
		host: NodeJS.Platform,
		secureStorage: 'available' | 'unavailable'
	) {
		Object.defineProperty( process, 'platform', { value: host } );
		vi.mocked( readChatGptSettings ).mockResolvedValue( {
			enabled: true,
			signInSupported: true,
			secureStorage,
			accounts: [],
		} );
		const ui = makeUi();
		await runChatGptCommand( makeCtx( ui ) );
		const offered = ui.askUser.mock.calls[ 1 ][ 0 ][ 0 ].options.map(
			( option: { label: string } ) => option.label
		);
		return { ui, offered };
	}

	it( 'tells a Linux user what keeping a sign-in in secure storage needs', async () => {
		const { ui, offered } = await startSigningIn( 'linux', 'unavailable' );

		expect( offered ).toEqual( [ 'This app session' ] );
		expect( ui.showInfo ).toHaveBeenCalledTimes( 1 );
		const [ note ] = ui.showInfo.mock.calls[ 0 ];
		expect( note ).toMatch( /secret-tool/ );
		expect( note ).toMatch( /libsecret-tools/ );
		expect( note ).toMatch( /Secret Service/ );
		expect( note ).toMatch( /unlocked/ );
		expect( startChatGptSignIn ).not.toHaveBeenCalled();
	} );

	it.each( [
		[ 'linux', 'available' ],
		[ 'win32', 'unavailable' ],
		[ 'darwin', 'unavailable' ],
	] as const )(
		'says nothing of it on %s with secure storage %s',
		async ( host, secureStorage ) => {
			const { ui } = await startSigningIn( host, secureStorage );

			expect( ui.showInfo ).not.toHaveBeenCalled();
		}
	);
} );

describe( 'changing the model of a chat whose ChatGPT account isn’t connected', () => {
	const ID = 'f84d75a0-4e60-4168-a1ab-3134542c637a';

	afterEach( () => vi.clearAllMocks() );

	it.each( [
		[ 'signed-out', 'The ChatGPT account this chat runs on is signed out.' ],
		[ 'needs-sign-in', 'The ChatGPT account this chat runs on needs you to sign in again.' ],
	] as const )(
		'says signing in to its %s account again continues the chat, as Studio’s composer does',
		async ( state, opening ) => {
			vi.mocked( readChatGptSettings ).mockResolvedValue( {
				enabled: true,
				signInSupported: true,
				secureStorage: 'available',
				accounts: [
					{
						connectionId: ID,
						providerId: 'chatgpt-oauth',
						backend: 'pi',
						revision: 1,
						identity: { verified: true },
						authStatus: 'disconnected',
						label: 'Personal',
						email: null,
						storage: 'vault',
						state,
					},
				],
			} );
			const ui = makeUi();
			const ctx = makeCtx( ui );
			vi.mocked( ctx.getSessionEntries ).mockResolvedValue( [
				{
					type: 'custom',
					id: 'pin',
					parentId: null,
					timestamp: new Date().toISOString(),
					customType: 'studio.session_context',
					data: {
						provider: 'chatgpt-oauth',
						connectionId: ID,
						revision: 1,
						chatGpt: { model: 'gpt-6-luna', reasoningEffort: 'medium' },
					},
				},
			] );

			await runChatGptCommand( ctx, 'model' );

			expect( ui.showError ).toHaveBeenCalledExactlyOnceWith(
				`${ opening } Sign in to that account again to continue this chat; the conversation stays as it is.`
			);
			expect( ui.askUser ).not.toHaveBeenCalled();
		}
	);
} );
