import { getWpcomAiGatewayBaseUrl } from '@studio/agent/node';
import { getSecureStorageStatus } from '@studio/agent/node/openai-credentials';
import { fetchOpenAiModelList } from '@studio/agent/node/openai-model-list';
import {
	InvalidOpenAiApiKeyError,
	persistAnthropicApiKey,
	readAnthropicApiKey,
	readOpenAiApiKey,
	saveOpenAiApiKey,
} from '@studio/agent/node/settings-store';
import { DEFAULT_MODEL, type AiModelId } from '@studio/agent/protocol/models';
import {
	AI_PROVIDER_IDS,
	DEFAULT_AI_PROVIDER,
	getAiProviderModels,
	type AiProviderId,
} from '@studio/agent/protocol/providers';
import { validateAnthropicApiKey } from '@studio/common/lib/anthropic-key';
import { readAuthToken } from '@studio/common/lib/shared-config';
import { getStudioUserAgent as buildStudioUserAgent } from '@studio/common/lib/user-agent';
import { __, sprintf } from '@wordpress/i18n';
import { confirm, password } from 'cli/lib/prompts';
import { LoggerError } from 'cli/logger';

export const AI_PROVIDERS: Record< AiProviderId, string > = {
	wpcom: 'WordPress.com',
	'anthropic-api-key': 'Anthropic · API key',
	'openai-api-key': 'OpenAI · API key',
};

export type { AiProviderId };
export { DEFAULT_AI_PROVIDER };
// Fallback order when the configured provider is unavailable; declaration
// order of the canonical id list.
export const AI_PROVIDER_PRIORITY: readonly AiProviderId[] = AI_PROVIDER_IDS;

// The wpcom AI proxy maps feature slugs to upstream providers. The
// `studio-agent` lane accepts the capability-tier aliases (fast / balanced /
// strong) on the Chat Completions path and resolves each to an upstream
// model server-side.
const WPCOM_AI_FEATURE_HEADER = 'studio-agent';

export interface ResolveAiEnvironmentOptions {
	sessionId?: string;
}

export interface AiProviderDefinition {
	id: AiProviderId;
	autoFallbackWhenUnavailable: boolean;
	/**
	 * Whether Studio may pick this provider without the user choosing it: on a
	 * first run, or when another provider becomes unavailable mid-conversation.
	 */
	autoSelectable: boolean;
	// Derived from the provider's model families (see
	// `@studio/agent/protocol/providers`), kept on the definition so callers don't
	// have to filter AI_MODELS themselves.
	readonly availableModels: readonly AiModelId[];
	readonly defaultModel: AiModelId;
	supportsModel( model: AiModelId ): boolean;
	isVisible: () => Promise< boolean >;
	isReady: () => Promise< boolean >;
	prepare: ( options?: { force?: boolean } ) => Promise< void >;
	resolveEnv: ( options?: ResolveAiEnvironmentOptions ) => Promise< Record< string, string > >;
}

// Fills in `availableModels`, `defaultModel`, and `supportsModel` from the
// provider id's model families.
function defineProvider(
	partial: Omit< AiProviderDefinition, 'availableModels' | 'defaultModel' | 'supportsModel' >
): AiProviderDefinition {
	const availableModels = getAiProviderModels( partial.id ).map( ( model ) => model.id );
	return {
		...partial,
		availableModels,
		defaultModel: availableModels[ 0 ] ?? DEFAULT_MODEL,
		supportsModel( model ) {
			return availableModels.includes( model );
		},
	};
}

async function resolveAnthropicApiKey( options?: {
	force?: boolean;
} ): Promise< string | undefined > {
	const savedKey = await readAnthropicApiKey();
	if ( savedKey && ! options?.force ) {
		// Re-prompt only when Anthropic definitively rejects the saved key;
		// an unreachable API must not lock the user out of their provider.
		const validation = await validateAnthropicApiKey( savedKey );
		if ( validation.status !== 'invalid' ) {
			return savedKey;
		}
	}

	const apiKey = await password( {
		message: __( 'Enter your Anthropic API key (will be saved for future use):' ),
		mask: '*',
		validate: async ( value ) => {
			const trimmed = value.trim();
			if ( ! trimmed ) {
				return __( 'API key is required' );
			}
			const validation = await validateAnthropicApiKey( trimmed );
			return validation.status === 'invalid' ? validation.message : true;
		},
	} );

	const trimmedKey = apiKey.trim();
	await persistAnthropicApiKey( trimmedKey );
	return trimmedKey;
}

/**
 * The saved OpenAI key, or a prompt for one. The key goes to the system
 * keychain; without one, the user may keep it for this session only. A key
 * OpenAI rejects is never saved.
 */
async function resolveOpenAiApiKey( options?: { force?: boolean } ): Promise< void > {
	const saved = await readOpenAiApiKey().catch( () => null );
	if ( saved && ! options?.force ) {
		const list = await fetchOpenAiModelList( saved.key );
		if ( list.ok || list.error.kind !== 'authentication' ) {
			return;
		}
	}

	const secureStorage = await getSecureStorageStatus();
	if ( ! secureStorage.available ) {
		const useForSession = await confirm( {
			message: sprintf(
				/* translators: %s: why the system keychain can't be used. */
				__(
					'Studio can’t save the key to your system keychain (%s). Use a key for this session only? It is forgotten when Studio Code exits.'
				),
				secureStorage.reason
			),
			default: false,
		} );
		if ( ! useForSession ) {
			throw new LoggerError(
				__(
					'OpenAI needs an API key. Set up a system keychain, or use a key for this session only.'
				)
			);
		}
	}

	const apiKey = await password( {
		message: secureStorage.available
			? __( 'Enter your OpenAI API key (saved to your system keychain):' )
			: __( 'Enter your OpenAI API key (kept for this session only):' ),
		mask: '*',
		validate: ( value ) => ( value.trim() ? true : __( 'API key is required' ) ),
	} );

	try {
		await saveOpenAiApiKey( apiKey, {
			storage: secureStorage.available ? 'keychain' : 'session',
		} );
	} catch ( error ) {
		if ( error instanceof InvalidOpenAiApiKeyError ) {
			throw new LoggerError( error.message );
		}
		throw error;
	}
}

export function getStudioUserAgent(): string {
	return buildStudioUserAgent(
		typeof __STUDIO_CLI_VERSION__ === 'string' ? __STUDIO_CLI_VERSION__ : undefined
	);
}

async function hasValidWpcomAuth(): Promise< boolean > {
	const token = await readAuthToken();
	return token !== null;
}

function readInlineWpcomToken(): string | null {
	return process.env.STUDIO_WPCOM_TOKEN?.trim() || null;
}

export function hasInlineWpcomAuth(): boolean {
	return readInlineWpcomToken() !== null;
}

function createBaseEnvironment(): Record< string, string > {
	const env = { ...( process.env as Record< string, string > ) };

	delete env.ANTHROPIC_API_KEY;
	delete env.ANTHROPIC_AUTH_TOKEN;
	delete env.ANTHROPIC_BASE_URL;
	delete env.ANTHROPIC_CUSTOM_HEADERS;
	delete env.OPENAI_API_KEY;
	delete env.OPENAI_BASE_URL;
	delete env.STUDIO_OPENAI_API_KEY;
	delete env.STUDIO_OPENAI_SESSION_API_KEY;
	delete env.STUDIO_WPCOM_API_KEY;
	delete env.STUDIO_WPCOM_BASE_URL;
	delete env.STUDIO_WPCOM_DEFAULT_HEADERS;

	return env;
}

const AI_PROVIDER_DEFINITIONS: Record< AiProviderId, AiProviderDefinition > = {
	wpcom: defineProvider( {
		id: 'wpcom',
		autoFallbackWhenUnavailable: true,
		autoSelectable: true,
		isVisible: async () => true,
		isReady: async () => hasInlineWpcomAuth() || ( await hasValidWpcomAuth() ),
		prepare: async () => {
			if ( hasInlineWpcomAuth() || ( await hasValidWpcomAuth() ) ) {
				return;
			}

			throw new LoggerError( __( 'WordPress.com login required. Use /login to authenticate.' ) );
		},
		resolveEnv: async ( options ) => {
			const inlineToken = readInlineWpcomToken();
			const accessToken = inlineToken ?? ( await readAuthToken() )?.accessToken;
			if ( ! accessToken ) {
				throw new LoggerError( __( 'WordPress.com login required. Use /login to authenticate.' ) );
			}
			const env = createBaseEnvironment();
			const gatewayBaseUrl = getWpcomAiGatewayBaseUrl();

			// The studio capability tiers speak the OpenAI Chat Completions
			// dialect, so the base URL carries the /v1 prefix (the request path
			// becomes /v1/chat/completions). The vars are Studio-namespaced
			// because this family has no direct-API provider — nothing but this
			// function should be able to satisfy it.
			env.STUDIO_WPCOM_BASE_URL = `${ gatewayBaseUrl.replace( /\/+$/, '' ) }/v1`;
			env.STUDIO_WPCOM_API_KEY = accessToken;
			const headers: Record< string, string > = {
				'User-Agent': getStudioUserAgent(),
				'X-WPCOM-AI-Feature': WPCOM_AI_FEATURE_HEADER,
			};
			if ( options?.sessionId ) {
				headers[ 'X-WPCOM-Session-ID' ] = options.sessionId;
			}
			env.STUDIO_WPCOM_DEFAULT_HEADERS = JSON.stringify( headers );

			return env;
		},
	} ),
	'anthropic-api-key': defineProvider( {
		id: 'anthropic-api-key',
		autoFallbackWhenUnavailable: false,
		autoSelectable: true,
		isVisible: async () => true,
		isReady: async () => {
			return Boolean( await readAnthropicApiKey() );
		},
		prepare: async ( options ) => {
			await resolveAnthropicApiKey( options );
		},
		resolveEnv: async () => {
			const apiKey = await readAnthropicApiKey();
			if ( ! apiKey ) {
				throw new LoggerError(
					__(
						'Anthropic API key required. Switch to Anthropic · API key with /provider to save one.'
					)
				);
			}

			const env = createBaseEnvironment();
			env.ANTHROPIC_API_KEY = apiKey;
			return env;
		},
	} ),
	// Never falls back: a conversation on OpenAI without a key fails its turn
	// with a disconnected error rather than running somewhere else.
	'openai-api-key': defineProvider( {
		id: 'openai-api-key',
		autoFallbackWhenUnavailable: false,
		// A conversation's contents only go to OpenAI when the user chose it.
		autoSelectable: false,
		isVisible: async () => true,
		isReady: async () => Boolean( await readOpenAiApiKey().catch( () => null ) ),
		prepare: async ( options ) => {
			await resolveOpenAiApiKey( options );
		},
		resolveEnv: async () => {
			const source = await readOpenAiApiKey().catch( () => null );
			if ( ! source ) {
				throw new LoggerError(
					__(
						'OpenAI isn’t connected, so this chat can’t continue. Add an OpenAI API key in Settings → AI (or with /openai-key in Studio Code), or start a new chat with another provider.'
					)
				);
			}
			// Only the runtime's provider resolution reads this copy; the agent's
			// tools run with the process environment, which never holds the key.
			const env = createBaseEnvironment();
			env.STUDIO_OPENAI_API_KEY = source.key;
			return env;
		},
	} ),
};

export function getAiProviderDefinition( provider: AiProviderId ): AiProviderDefinition {
	return AI_PROVIDER_DEFINITIONS[ provider ];
}
