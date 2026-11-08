import { password } from '@inquirer/prompts';
import {
	getSecureStorageStatus,
	OpenAiSessionKeyUnavailableError,
} from '@studio/agent/node/openai-credentials';
import {
	persistAnthropicApiKey,
	readAnthropicApiKey,
	readOpenAiApiKey,
	readSelectedAiProvider,
	saveOpenAiApiKey,
} from '@studio/agent/node/settings-store';
import { SecureStorageError } from '@studio/common/lib/os-credential-store';
import { readAuthToken } from '@studio/common/lib/shared-config';
import { vi } from 'vitest';
import {
	getAvailableAiProviders,
	isAiProviderReady,
	prepareAiProvider,
	resolveAiEnvironment,
	resolveInitialAiProvider,
	resolveUnavailableAiProvider,
} from 'cli/ai/auth';
import { getAiProviderDefinition } from 'cli/ai/providers';
import { LoggerError } from 'cli/logger';

vi.mock( '@inquirer/prompts', () => ( {
	password: vi.fn(),
} ) );

vi.mock( '@studio/common/lib/shared-config', () => ( {
	readAuthToken: vi.fn(),
} ) );

vi.mock( '@studio/agent/node/openai-credentials', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/agent/node/openai-credentials') >() ),
	getSecureStorageStatus: vi.fn(),
} ) );

vi.mock( '@studio/agent/node/settings-store', () => ( {
	readAnthropicApiKey: vi.fn(),
	readOpenAiApiKey: vi.fn(),
	readSelectedAiProvider: vi.fn(),
	persistAnthropicApiKey: vi.fn(),
	persistSelectedAiProvider: vi.fn(),
	saveOpenAiApiKey: vi.fn(),
	InvalidOpenAiApiKeyError: class InvalidOpenAiApiKeyError extends Error {},
} ) );

const OPENAI_KEY = 'sk-proj-TESTONLY_cli_cccccccccccccccccccccccccccccccc';

describe( 'AI auth helpers', () => {
	beforeEach( () => {
		vi.resetAllMocks();
		vi.stubGlobal( '__STUDIO_CLI_VERSION__', '1.2.3' );
		delete process.env.WPCOM_AI_PROXY_BASE_URL;
	} );

	afterEach( () => {
		vi.unstubAllGlobals();
	} );

	it( 'uses the saved Anthropic API key when provider is Anthropic API key', async () => {
		vi.mocked( readAnthropicApiKey ).mockResolvedValue( 'saved-key' );

		const env = await resolveAiEnvironment( 'anthropic-api-key' );

		expect( env.ANTHROPIC_API_KEY ).toBe( 'saved-key' );
		expect( env.ANTHROPIC_BASE_URL ).toBeUndefined();
		expect( env.ANTHROPIC_AUTH_TOKEN ).toBeUndefined();
		expect( persistAnthropicApiKey ).not.toHaveBeenCalled();
	} );

	it( 'requires a saved Anthropic API key in API key mode', async () => {
		vi.mocked( readAnthropicApiKey ).mockResolvedValue( undefined );

		await expect( resolveAiEnvironment( 'anthropic-api-key' ) ).rejects.toBeInstanceOf(
			LoggerError
		);
		expect( password ).not.toHaveBeenCalled();
	} );

	it( 'prompts for the API key immediately when preparing the API key provider', async () => {
		vi.mocked( readAnthropicApiKey ).mockResolvedValue( undefined );
		vi.mocked( password ).mockResolvedValue( 'prompted-key' );

		await prepareAiProvider( 'anthropic-api-key' );

		expect( password ).toHaveBeenCalledOnce();
		expect( persistAnthropicApiKey ).toHaveBeenCalledWith( 'prompted-key' );
	} );

	it( 'turns a keychain that fails while saving the OpenAI key into a message for the chat', async () => {
		vi.mocked( readOpenAiApiKey ).mockResolvedValue( null );
		vi.mocked( getSecureStorageStatus ).mockResolvedValue( { available: true } );
		vi.mocked( password ).mockResolvedValue( OPENAI_KEY );
		vi.mocked( saveOpenAiApiKey ).mockRejectedValue(
			new SecureStorageError( 'Couldn’t open the system keychain: locked' )
		);

		const preparing = prepareAiProvider( 'openai-api-key', { force: true } );

		await expect( preparing ).rejects.toBeInstanceOf( LoggerError );
		await expect( preparing ).rejects.toThrow( 'Couldn’t open the system keychain: locked' );
	} );

	it( 'can force re-entering the API key even when one is already saved', async () => {
		vi.mocked( readAnthropicApiKey ).mockResolvedValue( 'saved-key' );
		vi.mocked( password ).mockResolvedValue( 'updated-key' );

		await prepareAiProvider( 'anthropic-api-key', { force: true } );

		expect( password ).toHaveBeenCalledOnce();
		expect( persistAnthropicApiKey ).toHaveBeenCalledWith( 'updated-key' );
	} );

	it( 'configures the WP.com gateway environment', async () => {
		vi.mocked( readAuthToken ).mockResolvedValue( {
			accessToken: 'wpcom-token',
			displayName: 'User',
			email: 'user@example.com',
			expiresIn: 3600,
			expirationTime: Date.now() + 3600_000,
			id: 1,
		} );

		const env = await resolveAiEnvironment( 'wpcom' );

		expect( env.STUDIO_WPCOM_BASE_URL ).toBe(
			'https://public-api.wordpress.com/wpcom/v2/ai-api-proxy/v1'
		);
		expect( env.STUDIO_WPCOM_API_KEY ).toBe( 'wpcom-token' );
		expect( JSON.parse( env.STUDIO_WPCOM_DEFAULT_HEADERS! ) ).toEqual( {
			'User-Agent': 'WordPressStudio/1.2.3',
			'X-WPCOM-AI-Feature': 'studio-agent',
		} );
		expect( env.ANTHROPIC_API_KEY ).toBeUndefined();
	} );

	it( 'includes the Studio AI session ID header when provided', async () => {
		vi.mocked( readAuthToken ).mockResolvedValue( {
			accessToken: 'wpcom-token',
			displayName: 'User',
			email: 'user@example.com',
			expiresIn: 3600,
			expirationTime: Date.now() + 3600_000,
			id: 1,
		} );

		const env = await resolveAiEnvironment( 'wpcom', { sessionId: 'session-abc' } );

		expect( JSON.parse( env.STUDIO_WPCOM_DEFAULT_HEADERS! ) ).toEqual( {
			'User-Agent': 'WordPressStudio/1.2.3',
			'X-WPCOM-AI-Feature': 'studio-agent',
			'X-WPCOM-Session-ID': 'session-abc',
		} );
	} );

	it( 'prefers the saved provider', async () => {
		vi.mocked( readSelectedAiProvider ).mockResolvedValue( 'anthropic-api-key' );
		vi.mocked( readAnthropicApiKey ).mockResolvedValue( 'key' );

		await expect( resolveInitialAiProvider() ).resolves.toBe( 'anthropic-api-key' );
		expect( readAuthToken ).not.toHaveBeenCalled();
	} );

	it( 'defaults to WP.com when no provider is saved and a valid WP.com token exists', async () => {
		vi.mocked( readSelectedAiProvider ).mockResolvedValue( undefined );
		vi.mocked( readAuthToken ).mockResolvedValue( {
			accessToken: 'wpcom-token',
			displayName: 'User',
			email: 'user@example.com',
			expiresIn: 3600,
			expirationTime: Date.now() + 3600_000,
			id: 1,
		} );

		await expect( resolveInitialAiProvider() ).resolves.toBe( 'wpcom' );
	} );

	it( 'falls back to default provider when no other auth is available', async () => {
		vi.mocked( readSelectedAiProvider ).mockResolvedValue( undefined );
		vi.mocked( readAuthToken ).mockResolvedValue( null );

		await expect( resolveInitialAiProvider() ).resolves.toBe( 'wpcom' );
	} );

	it( 'reports WordPress.com readiness based on WP.com auth state', async () => {
		vi.mocked( readAuthToken ).mockResolvedValue( {
			accessToken: 'wpcom-token',
			displayName: 'User',
			email: 'user@example.com',
			expiresIn: 3600,
			expirationTime: Date.now() + 3600_000,
			id: 1,
		} );

		await expect( isAiProviderReady( 'wpcom' ) ).resolves.toBe( true );

		vi.mocked( readAuthToken ).mockResolvedValue( null );
		await expect( isAiProviderReady( 'wpcom' ) ).resolves.toBe( false );
	} );

	describe( 'OpenAI', () => {
		afterEach( () => {
			delete process.env.OPENAI_API_KEY;
			delete process.env.STUDIO_OPENAI_API_KEY;
		} );

		it( 'hands the saved key to the runtime only, never to this process’s environment', async () => {
			vi.mocked( readOpenAiApiKey ).mockResolvedValue( { key: OPENAI_KEY, storage: 'keychain' } );
			process.env.OPENAI_API_KEY = 'sk-proj-TESTONLY_ambient';

			const env = await resolveAiEnvironment( 'openai-api-key' );

			expect( env.STUDIO_OPENAI_API_KEY ).toBe( OPENAI_KEY );
			// An ambient key is dropped from the copy, not used.
			expect( env.OPENAI_API_KEY ).toBeUndefined();
			expect( env.ANTHROPIC_API_KEY ).toBeUndefined();
			expect( process.env.STUDIO_OPENAI_API_KEY ).toBeUndefined();
			expect( JSON.stringify( process.env ) ).not.toContain( OPENAI_KEY );
		} );

		it.each( [
			[ 'a keychain without the key', { available: true } as const ],
			[
				'no keychain on this machine',
				{ available: false, reason: 'none', absent: true } as const,
			],
		] )( 'fails a turn as disconnected with %s', async ( _case, keychain ) => {
			vi.mocked( readOpenAiApiKey ).mockResolvedValue( null );
			vi.mocked( getSecureStorageStatus ).mockResolvedValue( keychain );

			await expect( resolveAiEnvironment( 'openai-api-key' ) ).rejects.toThrow(
				/OpenAI isn’t connected/
			);
		} );

		it( 'says so when the keychain that may hold the key can’t be reached', async () => {
			vi.mocked( readOpenAiApiKey ).mockResolvedValue( null );
			vi.mocked( getSecureStorageStatus ).mockResolvedValue( {
				available: false,
				reason: 'no D-Bus session',
			} );

			const resolving = resolveAiEnvironment( 'openai-api-key' );

			await expect( resolving ).rejects.toBeInstanceOf( LoggerError );
			await expect( resolving ).rejects.toThrow(
				/couldn’t reach the system keychain to read the OpenAI API key \(no D-Bus session\)/
			);
		} );

		it( 'passes on a keychain error rather than reporting no key', async () => {
			vi.mocked( readOpenAiApiKey ).mockRejectedValue(
				new SecureStorageError( 'Couldn’t read the system keychain: locked' )
			);

			const resolving = resolveAiEnvironment( 'openai-api-key' );

			await expect( resolving ).rejects.toBeInstanceOf( LoggerError );
			await expect( resolving ).rejects.toThrow( 'Couldn’t read the system keychain: locked' );
		} );

		it( 'fails a turn that can’t get the app’s session key, saying why', async () => {
			vi.mocked( readOpenAiApiKey ).mockRejectedValue( new OpenAiSessionKeyUnavailableError() );

			const resolving = resolveAiEnvironment( 'openai-api-key' );

			await expect( resolving ).rejects.toBeInstanceOf( LoggerError );
			await expect( resolving ).rejects.toThrow(
				/couldn’t get the OpenAI key kept for this session/
			);
		} );

		it( 'is ready with a key, and never falls back without one', async () => {
			vi.mocked( readOpenAiApiKey ).mockResolvedValue( null );
			vi.mocked( readAuthToken ).mockResolvedValue( null );
			vi.mocked( readAnthropicApiKey ).mockResolvedValue( 'saved-key' );

			await expect( isAiProviderReady( 'openai-api-key' ) ).resolves.toBe( false );
			await expect( resolveUnavailableAiProvider( 'openai-api-key' ) ).resolves.toBeUndefined();

			vi.mocked( readSelectedAiProvider ).mockResolvedValue( 'openai-api-key' );
			await expect( resolveInitialAiProvider() ).resolves.toBe( 'openai-api-key' );

			vi.mocked( readOpenAiApiKey ).mockResolvedValue( { key: OPENAI_KEY, storage: 'session' } );
			await expect( isAiProviderReady( 'openai-api-key' ) ).resolves.toBe( true );
		} );

		it( 'is never picked for a conversation automatically', async () => {
			vi.mocked( readOpenAiApiKey ).mockResolvedValue( { key: OPENAI_KEY, storage: 'keychain' } );
			vi.mocked( readAuthToken ).mockResolvedValue( null );
			vi.mocked( readAnthropicApiKey ).mockResolvedValue( undefined );
			vi.mocked( readSelectedAiProvider ).mockResolvedValue( undefined );

			// A logged-out WordPress.com conversation doesn't move to OpenAI…
			await expect( resolveUnavailableAiProvider( 'wpcom' ) ).resolves.toBeUndefined();
			// …and a first run doesn't start on it.
			await expect( resolveInitialAiProvider() ).resolves.toBe( 'wpcom' );
		} );
	} );

	describe( 'ChatGPT', () => {
		const wpcomToken = () => ( {
			accessToken: 'wpcom-token',
			displayName: 'User',
			email: 'user@example.com',
			expiresIn: 3600,
			expirationTime: Date.now() + 3600_000,
			id: 1,
		} );
		const makeReady = ( { wpcom = false, anthropic = false } ) => {
			vi.mocked( readAuthToken ).mockResolvedValue( wpcom ? wpcomToken() : null );
			vi.mocked( readAnthropicApiKey ).mockResolvedValue( anthropic ? 'saved-key' : undefined );
			vi.mocked( readOpenAiApiKey ).mockResolvedValue( null );
		};

		it.each( [ 'wpcom', 'anthropic-api-key' ] as const )(
			'never falls back from a disconnected chat while %s is ready',
			async ( ready ) => {
				makeReady( { wpcom: ready === 'wpcom', anthropic: ready === 'anthropic-api-key' } );
				await expect( isAiProviderReady( ready ) ).resolves.toBe( true );

				await expect( isAiProviderReady( 'chatgpt-oauth' ) ).resolves.toBe( false );
				await expect( resolveUnavailableAiProvider( 'chatgpt-oauth' ) ).resolves.toBeUndefined();
			}
		);

		it.each( [
			[ 'WordPress.com when it is ready', 'wpcom', { wpcom: true } ],
			[ 'Anthropic when only its key is', 'anthropic-api-key', { anthropic: true } ],
			[ 'WordPress.com when nothing is ready', 'wpcom', {} ],
		] as const )(
			'starts a chat on %s, never on a saved ChatGPT default',
			async ( _label, expected, ready ) => {
				makeReady( ready );
				vi.mocked( readSelectedAiProvider ).mockResolvedValue( 'chatgpt-oauth' );

				await expect( resolveInitialAiProvider() ).resolves.toBe( expected );
			}
		);

		it( 'is never offered as a provider to choose', async () => {
			await expect( getAvailableAiProviders() ).resolves.not.toContain( 'chatgpt-oauth' );
		} );

		it( 'is never picked for a conversation automatically, even once shown and ready', async () => {
			const chatGpt = getAiProviderDefinition( 'chatgpt-oauth' );
			const isVisible = vi.spyOn( chatGpt, 'isVisible' ).mockResolvedValue( true );
			const isReady = vi.spyOn( chatGpt, 'isReady' ).mockResolvedValue( true );
			onTestFinished( () => {
				isVisible.mockRestore();
				isReady.mockRestore();
			} );
			makeReady( {} );
			vi.mocked( readSelectedAiProvider ).mockResolvedValue( undefined );

			// A logged-out WordPress.com conversation doesn't move to ChatGPT…
			await expect( resolveUnavailableAiProvider( 'wpcom' ) ).resolves.toBeUndefined();
			// …and a first run doesn't start on it.
			await expect( resolveInitialAiProvider() ).resolves.toBe( 'wpcom' );
		} );

		it( 'fails a turn as disconnected rather than run it', async () => {
			makeReady( { wpcom: true, anthropic: true } );

			const resolving = resolveAiEnvironment( 'chatgpt-oauth' );

			await expect( resolving ).rejects.toBeInstanceOf( LoggerError );
			await expect( resolving ).rejects.toThrow(
				'ChatGPT isn’t connected, so this chat can’t continue. Start a new chat with another provider.'
			);
		} );
	} );

	it( 'resolves a fallback provider only for providers that auto-fallback', async () => {
		vi.mocked( readAuthToken ).mockResolvedValue( null );
		vi.mocked( readAnthropicApiKey ).mockResolvedValue( 'saved-key' );

		await expect( resolveUnavailableAiProvider( 'wpcom' ) ).resolves.toBe( 'anthropic-api-key' );
		await expect( resolveUnavailableAiProvider( 'anthropic-api-key' ) ).resolves.toBeUndefined();
	} );
} );
