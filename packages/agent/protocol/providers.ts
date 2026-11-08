import {
	AI_MODELS,
	DEFAULT_MODEL,
	getAiModelFamily,
	PAID_DEFAULT_MODEL,
	readRecordedSessionModel,
	resolveSessionModel,
	type AiModelFamily,
	type AiModelId,
} from '@studio/agent/protocol/models';
import {
	getInitialOpenAiReasoningEffort,
	isOpenAiModelId,
	OPENAI_DEFAULT_MAX_OUTPUT_TOKENS,
	OPENAI_DEFAULT_MODEL,
	OPENAI_DEFAULT_REASONING_MODE,
	OPENAI_INITIAL_REASONING_EFFORT,
	OPENAI_MODEL_CAPABILITIES,
} from '@studio/agent/protocol/openai-models';
import { isStudioCustomEntryOfType } from '@studio/agent/protocol/sessions/entry-types';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { OpenAiErrorSummary } from '@studio/agent/protocol/openai-errors';
import type {
	OpenAiModelId,
	OpenAiReasoningEffort,
	OpenAiReasoningMode,
} from '@studio/agent/protocol/openai-models';
import type { StudioSessionContextData } from '@studio/agent/protocol/sessions/entry-types';

// The literal entries of AI_MODELS, so `id` stays the `AiModelId` union
// instead of widening to `string` for callers that key off it.
type AiProviderModel = ( typeof AI_MODELS )[ number ];

// Persisted in shared.json (`aiProvider`) and in session records, so treat the
// list as append-only: readers narrow with `isAiProviderId` and fall back to
// the default on values they don't know.
export const AI_PROVIDER_IDS = [
	'wpcom',
	'anthropic-api-key',
	'openai-api-key',
	'chatgpt-oauth',
] as const;

export type AiProviderId = ( typeof AI_PROVIDER_IDS )[ number ];

export const DEFAULT_AI_PROVIDER: AiProviderId = 'wpcom';

// Brand names, not translated.
export const AI_PROVIDER_LABELS: Record< AiProviderId, string > = {
	wpcom: 'WordPress.com',
	'anthropic-api-key': 'Anthropic API',
	'openai-api-key': 'OpenAI API',
	'chatgpt-oauth': 'ChatGPT',
};

// Which model families each provider can service. `wpcom` serves only the
// studio capability tiers (resolved to upstream models by the proxy);
// direct-API providers are restricted to their own family. ChatGPT serves
// none of AI_MODELS: each of its connections lists its own models.
const PROVIDER_MODEL_FAMILIES: Record< AiProviderId, readonly AiModelFamily[] > = {
	wpcom: [ 'studio' ],
	'anthropic-api-key': [ 'anthropic' ],
	'openai-api-key': [ 'openai' ],
	'chatgpt-oauth': [],
};

/**
 * The provider that serves a model family's catalog models; each family has
 * exactly one. A ChatGPT connection is never inferred from a family, even for
 * a model whose slug an OpenAI catalog model shares.
 */
export function getAiModelFamilyProvider( family: AiModelFamily ): AiProviderId {
	switch ( family ) {
		case 'studio':
			return 'wpcom';
		case 'anthropic':
			return 'anthropic-api-key';
		case 'openai':
			return 'openai-api-key';
	}
}

// Precomputed so callers get a stable reference (the composer calls this per
// render), mirroring MODEL_BY_ID in models.ts.
const PROVIDER_MODELS: ReadonlyMap< AiProviderId, readonly AiProviderModel[] > = new Map(
	AI_PROVIDER_IDS.map(
		( provider ) =>
			[
				provider,
				AI_MODELS.filter( ( model ) =>
					PROVIDER_MODEL_FAMILIES[ provider ].includes( model.family )
				),
			] as const
	)
);

export function isAiProviderId( value: string ): value is AiProviderId {
	return ( AI_PROVIDER_IDS as readonly string[] ).includes( value );
}

export function getAiProviderModels( provider: AiProviderId ): readonly AiProviderModel[] {
	return PROVIDER_MODELS.get( provider ) ?? [];
}

export function providerServesModel( provider: AiProviderId, model: AiModelId ): boolean {
	return getAiProviderModels( provider ).some( ( entry ) => entry.id === model );
}

/**
 * The fallback when no model was chosen or the provider can't serve the
 * requested one. On wpcom, the balanced tier when the paid tiers are unlocked;
 * everyone else (including callers without quota data) gets fast. On OpenAI,
 * the default saved in settings when the caller has it.
 */
export function getAiProviderDefaultModel(
	provider: AiProviderId,
	options?: { canUsePaidModels?: boolean; openAiDefaultModel?: OpenAiModelId }
): AiModelId {
	if ( provider === 'wpcom' && options?.canUsePaidModels ) {
		return PAID_DEFAULT_MODEL;
	}
	if ( provider === 'openai-api-key' ) {
		return options?.openAiDefaultModel ?? OPENAI_DEFAULT_MODEL;
	}
	return getAiProviderModels( provider )[ 0 ]?.id ?? DEFAULT_MODEL;
}

/**
 * `resolveSessionModel` constrained to what the provider can serve: a
 * recorded model it no longer offers snaps to the provider's default.
 * OpenAI conversations resolve through `resolveOpenAiSessionSelection`
 * instead, which reports a dropped model rather than replacing it.
 */
export function resolveSessionModelForProvider(
	entries: SessionEntry[],
	provider: AiProviderId,
	options?: { canUsePaidModels?: boolean; openAiDefaultModel?: OpenAiModelId }
): AiModelId {
	const defaultModel = getAiProviderDefaultModel( provider, options );
	const model = resolveSessionModel( entries, defaultModel );
	return providerServesModel( provider, model ) ? model : defaultModel;
}

/**
 * The record a session is pinned by: the latest `studio.session_context`
 * entry naming a provider Studio knows. Only explicit switches record one
 * (per-turn records carry just the model), so pins survive fallback runs;
 * OpenAI's and ChatGPT's per-turn records may carry theirs, since those never
 * fall back. Undefined when never pinned.
 */
export function readSessionPin(
	entries: SessionEntry[]
): ( StudioSessionContextData & { provider: AiProviderId } ) | undefined {
	for ( let index = entries.length - 1; index >= 0; index -= 1 ) {
		const entry = entries[ index ];
		if ( isStudioCustomEntryOfType( entry, 'studio.session_context' ) ) {
			const data = entry.data;
			if ( data?.provider && isAiProviderId( data.provider ) ) {
				return { ...data, provider: data.provider };
			}
		}
	}
	return undefined;
}

/**
 * The provider a session is pinned to (see `readSessionPin`). Undefined when
 * never pinned — callers fall back to the saved global selection.
 */
export function resolveSessionProvider( entries: SessionEntry[] ): AiProviderId | undefined {
	return readSessionPin( entries )?.provider;
}

// The pi provider ids of Studio's OpenAI, Anthropic and ChatGPT models. The
// runtime takes them from here, so the replies it records always match this
// reader. ChatGPT's is Studio's own transport, not pi's built-in `openai-codex`.
export const OPENAI_PI_PROVIDER = 'studio-openai';
export const ANTHROPIC_PI_PROVIDER = 'anthropic';
export const CHATGPT_PI_PROVIDER = 'studio-chatgpt';

/**
 * The provider a conversation's latest reply came from, read from the pi
 * provider id pi records on it, so it holds even for a model Studio no longer
 * offers. Undefined before the first reply. Any other provider reads as
 * WordPress.com.
 */
export function readLastReplyProvider( entries: SessionEntry[] ): AiProviderId | undefined {
	for ( let index = entries.length - 1; index >= 0; index -= 1 ) {
		const entry = entries[ index ];
		if ( entry.type !== 'message' ) {
			continue;
		}
		const { role, provider } = entry.message as { role?: unknown; provider?: unknown };
		if ( role !== 'assistant' ) {
			continue;
		}
		if ( provider === OPENAI_PI_PROVIDER ) {
			return 'openai-api-key';
		}
		if ( provider === CHATGPT_PI_PROVIDER ) {
			return 'chatgpt-oauth';
		}
		return provider === ANTHROPIC_PI_PROVIDER ? 'anthropic-api-key' : DEFAULT_AI_PROVIDER;
	}
	return undefined;
}

export interface ConversationProviderInput {
	/** The provider the conversation is pinned to, if any. */
	pinnedProvider?: AiProviderId;
	/** The latest model the conversation recorded that Studio still offers. */
	recordedModel?: AiModelId;
	/** The provider the latest reply came from (see `readLastReplyProvider`). */
	lastReplyProvider?: AiProviderId;
	/** The provider new conversations use. */
	globalProvider?: AiProviderId;
	hasAnthropicApiKey: boolean;
}

/**
 * The provider a conversation runs on.
 *
 * OpenAI and ChatGPT never fall back: a conversation pinned to either, or
 * unpinned and last run there, stays there when its key or connection is
 * missing (and shows as disconnected). The OpenAI default applies only to
 * conversations that haven't run on another provider yet. Nothing else puts
 * a conversation on ChatGPT: not the saved default, and not a model's family.
 *
 * Otherwise the pre-existing rules hold: the pin, then the saved global
 * selection, with WordPress.com whenever no Anthropic key is saved.
 */
export function resolveConversationProvider( input: ConversationProviderInput ): AiProviderId {
	const { pinnedProvider, recordedModel, lastReplyProvider, hasAnthropicApiKey } = input;
	if ( pinnedProvider === 'openai-api-key' || pinnedProvider === 'chatgpt-oauth' ) {
		return pinnedProvider;
	}
	// One that ran on ChatGPT stays there even when no record names its
	// connection: its turns then fail, rather than move.
	if ( ! pinnedProvider && lastReplyProvider === 'chatgpt-oauth' ) {
		return lastReplyProvider;
	}
	// As the saved default, ChatGPT reads as unset.
	const globalProvider =
		input.globalProvider === 'chatgpt-oauth' ? undefined : input.globalProvider;
	const recordedProvider = recordedModel
		? getAiModelFamilyProvider( getAiModelFamily( recordedModel ) )
		: undefined;
	// One that ran on OpenAI stays there, even on a model Studio dropped since:
	// its turns then fail with a fix to apply, rather than move.
	if (
		! pinnedProvider &&
		( recordedProvider === 'openai-api-key' || lastReplyProvider === 'openai-api-key' )
	) {
		return 'openai-api-key';
	}
	if ( ! pinnedProvider && globalProvider === 'openai-api-key' ) {
		// One that ran elsewhere keeps its provider: it never moves to OpenAI on
		// its own. One without a reply yet starts on the default.
		const ranOn = recordedProvider ?? lastReplyProvider;
		if ( ! ranOn ) {
			return globalProvider;
		}
		return ranOn === 'anthropic-api-key' && ! hasAnthropicApiKey ? DEFAULT_AI_PROVIDER : ranOn;
	}
	if ( ! hasAnthropicApiKey ) {
		return DEFAULT_AI_PROVIDER;
	}
	return pinnedProvider ?? globalProvider ?? DEFAULT_AI_PROVIDER;
}

/**
 * The provider a conversation effectively runs on (see
 * `resolveConversationProvider`). Missing or unloaded settings read as
 * WordPress.com, except for a conversation already on OpenAI or ChatGPT.
 * `resolveConnectionSelection` also names the connection and checks it.
 */
export function getEffectiveSessionProvider(
	entries: SessionEntry[],
	settings?: Pick< AiSettings, 'provider' | 'hasAnthropicApiKey' > | null
): AiProviderId {
	return resolveConversationProvider( {
		pinnedProvider: resolveSessionProvider( entries ),
		recordedModel: readRecordedSessionModel( entries ),
		lastReplyProvider: readLastReplyProvider( entries ),
		globalProvider: settings?.provider,
		hasAnthropicApiKey: settings?.hasAnthropicApiKey ?? false,
	} );
}

/** Whether a provider has what it needs to run a turn. */
export function isAiProviderConnected(
	provider: AiProviderId,
	options: {
		hasWpcomAuth: boolean;
		settings?: Pick< AiSettings, 'hasAnthropicApiKey' | 'hasOpenAiApiKey' > | null;
	}
): boolean {
	switch ( provider ) {
		case 'wpcom':
			return options.hasWpcomAuth;
		case 'anthropic-api-key':
			return options.settings?.hasAnthropicApiKey ?? false;
		case 'openai-api-key':
			return options.settings?.hasOpenAiApiKey ?? false;
		// Each ChatGPT conversation's own connection is checked instead (see
		// `resolveConnectionSelection`), so the provider is never offered whole.
		case 'chatgpt-oauth':
			return false;
	}
}

/** Where an OpenAI key is kept: the system keychain, or this app session's memory. */
export type OpenAiKeyStorage = 'keychain' | 'session';

export interface OpenAiModelAvailability {
	/** When the account's model list was last read successfully, or null. */
	checkedAt: string | null;
	/**
	 * Catalog models that list included, or null while unknown — never read, or
	 * the key can't list models. Inclusion doesn't prove a request will succeed.
	 */
	availableModelIds: OpenAiModelId[] | null;
	/** The catalog version the list was checked against. */
	catalogVersion: string | null;
	/** Why the latest refresh failed. A failed refresh keeps the previous list. */
	lastError: OpenAiErrorSummary | null;
}

export interface OpenAiProviderSettings {
	/** Where the key is kept, or null when there is none. */
	keyStorage: OpenAiKeyStorage | null;
	/** The key's last four characters, so the user can recognise it. */
	keyHint: string | null;
	/**
	 * Why the keychain couldn't return its key just now (a locked item, say), or
	 * null. A key may still be saved there, though none can be used.
	 */
	keyError: string | null;
	/** Whether this machine's system keychain can keep a key. */
	secureStorage: 'available' | 'unavailable';
	/** Defaults for new OpenAI conversations. */
	defaultModel: OpenAiModelId;
	defaultReasoningEffort: OpenAiReasoningEffort;
	defaultReasoningMode: OpenAiReasoningMode;
	/** The output cap for every OpenAI turn; reasoning tokens count toward it. */
	maxOutputTokens: number;
	models: OpenAiModelAvailability;
}

/** A change to the defaults for new OpenAI conversations; omitted fields stay. */
export interface OpenAiDefaultsUpdate {
	model?: string;
	reasoningEffort?: string;
	reasoningMode?: string;
	maxOutputTokens?: number;
}

/**
 * The defaults an update asks for, for `resolveOpenAiTurnSettings` to check.
 * A model change keeps the current effort and mode when the model has them and
 * otherwise takes the model's starting ones; a value the update gives is
 * taken as given.
 */
export function applyOpenAiDefaultsUpdate(
	current: Pick<
		OpenAiProviderSettings,
		'defaultModel' | 'defaultReasoningEffort' | 'defaultReasoningMode' | 'maxOutputTokens'
	>,
	update: OpenAiDefaultsUpdate
): { model: string; reasoningEffort: string; reasoningMode: string; maxOutputTokens: number } {
	const model = update.model ?? current.defaultModel;
	let reasoningEffort: string = current.defaultReasoningEffort;
	let reasoningMode: string = current.defaultReasoningMode;
	// A model Studio doesn't know keeps them, for resolveOpenAiTurnSettings to refuse.
	if ( isOpenAiModelId( model ) ) {
		const capabilities = OPENAI_MODEL_CAPABILITIES[ model ];
		if ( ! capabilities.reasoningEfforts.includes( current.defaultReasoningEffort ) ) {
			reasoningEffort = getInitialOpenAiReasoningEffort( model );
		}
		if ( ! capabilities.reasoningModes.includes( current.defaultReasoningMode ) ) {
			reasoningMode = OPENAI_DEFAULT_REASONING_MODE;
		}
	}
	return {
		model,
		reasoningEffort: update.reasoningEffort ?? reasoningEffort,
		reasoningMode: update.reasoningMode ?? reasoningMode,
		maxOutputTokens: update.maxOutputTokens ?? current.maxOutputTokens,
	};
}

/** The model, effort and mode one OpenAI conversation uses. */
export interface OpenAiSessionSelection {
	model: OpenAiModelId;
	reasoningEffort: OpenAiReasoningEffort;
	reasoningMode: OpenAiReasoningMode;
}

/** OpenAI settings with no key saved and nothing chosen yet. */
export function createDisconnectedOpenAiSettings(): OpenAiProviderSettings {
	return {
		keyStorage: null,
		keyHint: null,
		keyError: null,
		secureStorage: 'available',
		defaultModel: OPENAI_DEFAULT_MODEL,
		defaultReasoningEffort: OPENAI_INITIAL_REASONING_EFFORT,
		defaultReasoningMode: OPENAI_DEFAULT_REASONING_MODE,
		maxOutputTokens: OPENAI_DEFAULT_MAX_OUTPUT_TOKENS,
		models: { checkedAt: null, availableModelIds: null, catalogVersion: null, lastError: null },
	};
}

/**
 * The AI provider settings exposed to the settings UI. API keys never leave
 * the server — only their presence and a short hint for display.
 */
export interface AiSettings {
	provider: AiProviderId;
	hasAnthropicApiKey: boolean;
	/** Truncated key for display (`sk-ant-…abcd`), or null when none is saved. */
	anthropicApiKeyPreview: string | null;
	hasOpenAiApiKey: boolean;
	openAi: OpenAiProviderSettings;
}
