import { createHash } from 'node:crypto';
import { validateAnthropicApiKey } from '@studio/common/lib/anthropic-key';
import { readCliConfigFileRaw } from '@studio/common/lib/cli-config-file';
import { readSharedConfig, updateSharedConfig } from '@studio/common/lib/shared-config';
import { __ } from '@wordpress/i18n';
import {
	getSecureStorageStatus,
	readOpenAiKeySource,
	storeOpenAiKey,
	deleteOpenAiKey,
	type OpenAiKeySource,
} from '@studio/agent/node/openai-credentials';
import {
	fetchOpenAiModelList,
	type OpenAiModelListResult,
} from '@studio/agent/node/openai-model-list';
import {
	describeOpenAiError,
	type OpenAiErrorKind,
	OpenAiErrorSummary,
} from '@studio/agent/protocol/openai-errors';
import {
	describeOpenAiSettingsProblem,
	getInitialOpenAiReasoningEffort,
	isOpenAiModelId,
	isOpenAiReasoningEffort,
	isOpenAiReasoningMode,
	OPENAI_DEFAULT_MAX_OUTPUT_TOKENS,
	OPENAI_DEFAULT_MODEL,
	OPENAI_DEFAULT_REASONING_MODE,
	OPENAI_MODEL_CAPABILITIES,
	OPENAI_MODEL_CATALOG_VERSION,
	OPENAI_MODEL_IDS,
	resolveOpenAiTurnSettings,
	type OpenAiModelId,
	type OpenAiReasoningEffort,
	type OpenAiReasoningMode,
} from '@studio/agent/protocol/openai-models';
import {
	DEFAULT_AI_PROVIDER,
	isAiProviderId,
	type AiProviderId,
	type AiSettings,
	type OpenAiDefaultsUpdate,
	type OpenAiKeyStorage,
	type OpenAiModelAvailability,
	type OpenAiProviderSettings,
} from '@studio/agent/protocol/providers';

/** A key Anthropic definitively rejected; carries a user-facing message. */
export class InvalidAnthropicApiKeyError extends Error {
	constructor( message: string ) {
		super( message );
		this.name = 'InvalidAnthropicApiKeyError';
	}
}

/** A key that isn't an OpenAI API key, or that OpenAI rejected; never stored. */
export class InvalidOpenAiApiKeyError extends Error {
	constructor( message: string ) {
		super( message );
		this.name = 'InvalidOpenAiApiKeyError';
	}
}

/** An OpenAI setting that can't be applied; carries a user-facing message. */
export class OpenAiSettingsError extends Error {
	constructor( message: string ) {
		super( message );
		this.name = 'OpenAiSettingsError';
	}
}

/**
 * Reads and writes the AI provider settings in `~/.studio/shared.json`, the
 * Desktop↔CLI shared state (where the WordPress.com auth token also lives).
 * Earlier builds stored both fields in the CLI-owned `cli.json`; reads fall
 * back to it so existing setups keep working, writes always target shared.json.
 */

interface AiProviderConfig {
	aiProvider?: string;
	anthropicApiKey?: string;
}

// Plain settings in shared.json; the OpenAI key itself is never among them.
// Read as unknown and validated here, like every value another build may write.
interface OpenAiConfig {
	openaiDefaultModel?: unknown;
	openaiDefaultReasoningEffort?: unknown;
	openaiDefaultReasoningMode?: unknown;
	openaiMaxOutputTokens?: unknown;
	openaiModels?: unknown;
}

async function readLegacyCliConfigFields(): Promise< AiProviderConfig > {
	try {
		const { aiProvider, anthropicApiKey } = await readCliConfigFileRaw();
		return {
			aiProvider: typeof aiProvider === 'string' ? aiProvider : undefined,
			anthropicApiKey: typeof anthropicApiKey === 'string' ? anthropicApiKey : undefined,
		};
	} catch {
		return {};
	}
}

async function readAiProviderConfig(): Promise< AiProviderConfig > {
	const { aiProvider, anthropicApiKey } = await readSharedConfig();
	if ( aiProvider !== undefined || anthropicApiKey !== undefined ) {
		return { aiProvider, anthropicApiKey };
	}
	return readLegacyCliConfigFields();
}

/** The saved Anthropic API key, for processes that need the raw value. */
export async function readAnthropicApiKey(): Promise< string | undefined > {
	return ( await readAiProviderConfig() ).anthropicApiKey;
}

/** The saved provider selection, or undefined when none was ever chosen. */
export async function readSelectedAiProvider(): Promise< AiProviderId | undefined > {
	const { aiProvider } = await readAiProviderConfig();
	return aiProvider !== undefined && isAiProviderId( aiProvider ) ? aiProvider : undefined;
}

const KEY_PREFIX_LENGTH = 16;
const KEY_SUFFIX_LENGTH = 4;

// Enough to recognise the key, never enough to use it; a short key shows
// only its tail so most of it is not echoed back.
function previewKey( key: string ): string {
	if ( key.length <= KEY_PREFIX_LENGTH + KEY_SUFFIX_LENGTH ) {
		return `...${ key.slice( -KEY_SUFFIX_LENGTH ) }`;
	}
	return `${ key.slice( 0, KEY_PREFIX_LENGTH ) }...${ key.slice( -KEY_SUFFIX_LENGTH ) }`;
}

const OPENAI_ERROR_KINDS: readonly OpenAiErrorKind[] = [
	'authentication',
	'permission',
	'model-unavailable',
	'invalid-request',
	'rate-limit',
	'quota',
	'server',
	'network',
	'cancelled',
	'interrupted',
	'unknown',
];

function readStoredError( value: unknown ): OpenAiErrorSummary | null {
	if ( ! value || typeof value !== 'object' ) {
		return null;
	}
	const { kind, status, code, detail } = value as Record< string, unknown >;
	if (
		typeof kind !== 'string' ||
		! ( OPENAI_ERROR_KINDS as readonly string[] ).includes( kind )
	) {
		return null;
	}
	return {
		kind: kind as OpenAiErrorKind,
		...( typeof status === 'number' ? { status } : {} ),
		...( typeof code === 'string' ? { code } : {} ),
		...( typeof detail === 'string' ? { detail } : {} ),
	};
}

const NO_MODEL_LIST: OpenAiModelAvailability = {
	checkedAt: null,
	availableModelIds: null,
	catalogVersion: null,
	lastError: null,
};

// Which key a stored model list came from, without storing the key: a short
// SHA-256 digest that can't be turned back into it.
function fingerprintOpenAiKey( key: string ): string {
	return createHash( 'sha256' ).update( key ).digest( 'hex' ).slice( 0, 16 );
}

// The list another key produced says nothing about this key's project, and one
// checked against another catalog version can't speak for models added since:
// either reads as unknown until the next refresh.
function readStoredAvailability(
	value: unknown,
	activeKey: string | null | undefined
): OpenAiModelAvailability {
	if ( ! value || typeof value !== 'object' || ! activeKey ) {
		return NO_MODEL_LIST;
	}
	const { checkedAt, availableModelIds, catalogVersion, lastError, keyFingerprint } =
		value as Record< string, unknown >;
	if ( keyFingerprint !== fingerprintOpenAiKey( activeKey ) ) {
		return NO_MODEL_LIST;
	}
	const isCurrent = catalogVersion === OPENAI_MODEL_CATALOG_VERSION;
	return {
		checkedAt: typeof checkedAt === 'string' ? checkedAt : null,
		availableModelIds:
			isCurrent && Array.isArray( availableModelIds )
				? OPENAI_MODEL_IDS.filter( ( id ) => availableModelIds.includes( id ) )
				: null,
		catalogVersion: typeof catalogVersion === 'string' ? catalogVersion : null,
		lastError: readStoredError( lastError ),
	};
}

/**
 * What a model-list result says about availability, stored with the
 * fingerprint of the key it was read with. A failure keeps the previous list
 * and records why; only a successful list replaces it.
 */
function toStoredAvailability(
	result: OpenAiModelListResult,
	previous: OpenAiModelAvailability,
	key: string
): OpenAiModelAvailability & { keyFingerprint: string } {
	const keyFingerprint = fingerprintOpenAiKey( key );
	if ( ! result.ok ) {
		return { ...previous, lastError: result.error, keyFingerprint };
	}
	return {
		checkedAt: new Date().toISOString(),
		availableModelIds: OPENAI_MODEL_IDS.filter( ( id ) =>
			result.modelIds.includes( OPENAI_MODEL_CAPABILITIES[ id ].apiModelId )
		),
		catalogVersion: OPENAI_MODEL_CATALOG_VERSION,
		lastError: null,
		keyFingerprint,
	};
}

/**
 * The defaults for new OpenAI conversations. A saved value Studio can't use
 * (a model it dropped, an effort the model lacks) gives way to the built-in
 * default here; conversations themselves never change this way.
 */
function readOpenAiDefaults(
	config: OpenAiConfig,
	availability: OpenAiModelAvailability
): Pick<
	OpenAiProviderSettings,
	'defaultModel' | 'defaultReasoningEffort' | 'defaultReasoningMode' | 'maxOutputTokens'
> {
	const available = availability.availableModelIds;
	const storedModel = config.openaiDefaultModel;
	const defaultModel: OpenAiModelId =
		typeof storedModel === 'string' && isOpenAiModelId( storedModel )
			? storedModel
			: available?.length && ! available.includes( OPENAI_DEFAULT_MODEL )
			? available[ 0 ]
			: OPENAI_DEFAULT_MODEL;
	const capabilities = OPENAI_MODEL_CAPABILITIES[ defaultModel ];

	const storedEffort = config.openaiDefaultReasoningEffort;
	const defaultReasoningEffort: OpenAiReasoningEffort =
		typeof storedEffort === 'string' &&
		isOpenAiReasoningEffort( storedEffort ) &&
		capabilities.reasoningEfforts.includes( storedEffort )
			? storedEffort
			: getInitialOpenAiReasoningEffort( defaultModel );

	const storedMode = config.openaiDefaultReasoningMode;
	const defaultReasoningMode: OpenAiReasoningMode =
		typeof storedMode === 'string' &&
		isOpenAiReasoningMode( storedMode ) &&
		capabilities.reasoningModes.includes( storedMode )
			? storedMode
			: OPENAI_DEFAULT_REASONING_MODE;

	const storedMax = config.openaiMaxOutputTokens;
	const maxOutputTokens =
		typeof storedMax === 'number' &&
		resolveOpenAiTurnSettings( {
			model: defaultModel,
			reasoningEffort: defaultReasoningEffort,
			reasoningMode: defaultReasoningMode,
			maxOutputTokens: storedMax,
		} ).ok
			? storedMax
			: OPENAI_DEFAULT_MAX_OUTPUT_TOKENS;

	return { defaultModel, defaultReasoningEffort, defaultReasoningMode, maxOutputTokens };
}

function toAiSettings(
	config: AiProviderConfig,
	openAiConfig: OpenAiConfig,
	openAiKey: OpenAiKeySource | null,
	secureStorageAvailable: boolean
): AiSettings {
	const key = config.anthropicApiKey;
	const models = readStoredAvailability( openAiConfig.openaiModels, openAiKey?.key );
	return {
		provider:
			config.aiProvider !== undefined && isAiProviderId( config.aiProvider )
				? config.aiProvider
				: DEFAULT_AI_PROVIDER,
		hasAnthropicApiKey: Boolean( key ),
		anthropicApiKeyPreview: key ? previewKey( key ) : null,
		hasOpenAiApiKey: Boolean( openAiKey ),
		openAi: {
			keyStorage: openAiKey?.storage ?? null,
			keyHint: openAiKey ? `…${ openAiKey.key.slice( -KEY_SUFFIX_LENGTH ) }` : null,
			secureStorage: secureStorageAvailable ? 'available' : 'unavailable',
			...readOpenAiDefaults( openAiConfig, models ),
			models,
		},
	};
}

async function readOpenAiConfig(): Promise< OpenAiConfig > {
	const {
		openaiDefaultModel,
		openaiDefaultReasoningEffort,
		openaiDefaultReasoningMode,
		openaiMaxOutputTokens,
		openaiModels,
	} = await readSharedConfig();
	return {
		openaiDefaultModel,
		openaiDefaultReasoningEffort,
		openaiDefaultReasoningMode,
		openaiMaxOutputTokens,
		openaiModels,
	};
}

export async function readAiSettings(): Promise< AiSettings > {
	const [ config, openAiConfig, secureStorage, openAiKey ] = await Promise.all( [
		readAiProviderConfig(),
		readOpenAiConfig(),
		getSecureStorageStatus(),
		// A keychain that can't be read right now reads as no key.
		readOpenAiKeySource().catch( () => null ),
	] );
	return toAiSettings( config, openAiConfig, openAiKey, secureStorage.available );
}

async function updateAiProviderConfig( update: AiProviderConfig ): Promise< AiSettings > {
	// Carry the legacy cli.json values over on first write so a partial update
	// (e.g. only aiProvider) doesn't orphan the other field there.
	const config = { ...( await readAiProviderConfig() ), ...update };
	await updateSharedConfig( config );
	return readAiSettings();
}

/**
 * Stores or clears the Anthropic API key. A key Anthropic rejects is not
 * stored; an unverifiable one (offline, Anthropic outage) is. Clearing the key
 * falls back to WordPress.com, since the Anthropic provider needs one.
 */
export async function saveAnthropicApiKey( key: string | null ): Promise< AiSettings > {
	const trimmed = key === null ? null : key.trim();

	if ( trimmed ) {
		const validation = await validateAnthropicApiKey( trimmed );
		if ( validation.status === 'invalid' ) {
			throw new InvalidAnthropicApiKeyError( validation.message );
		}
	}

	return updateAiProviderConfig(
		trimmed
			? { anthropicApiKey: trimmed }
			: { anthropicApiKey: undefined, aiProvider: DEFAULT_AI_PROVIDER }
	);
}

/**
 * Selects the provider for new conversations. Switching to Anthropic or OpenAI
 * refuses a key the provider rejects, but accepts an unverifiable one.
 * Existing sessions keep the provider recorded in their session context.
 */
export async function setAiProvider( provider: AiProviderId ): Promise< AiSettings > {
	if ( provider === 'openai-api-key' ) {
		const source = await readOpenAiKeySource();
		if ( ! source ) {
			throw new OpenAiSettingsError( __( 'Add an OpenAI API key first.' ) );
		}
		const list = await fetchOpenAiModelList( source.key );
		if ( ! list.ok && list.error.kind === 'authentication' ) {
			throw new InvalidOpenAiApiKeyError( describeOpenAiError( list.error ) );
		}
	}
	if ( provider === 'anthropic-api-key' ) {
		const anthropicApiKey = await readAnthropicApiKey();
		if ( ! anthropicApiKey ) {
			throw new InvalidAnthropicApiKeyError( 'Add an Anthropic API key first.' );
		}
		const validation = await validateAnthropicApiKey( anthropicApiKey );
		if ( validation.status === 'invalid' ) {
			throw new InvalidAnthropicApiKeyError( validation.message );
		}
	}

	return updateAiProviderConfig( { aiProvider: provider } );
}

/** Persists the provider without validation — for flows that already ran it. */
export async function persistSelectedAiProvider( provider: AiProviderId ): Promise< void > {
	await updateAiProviderConfig( { aiProvider: provider } );
}

/** Persists the key without validation — for flows that already ran it. */
export async function persistAnthropicApiKey( key: string ): Promise< void > {
	await updateAiProviderConfig( { anthropicApiKey: key } );
}

// One OpenAI key or model-list change at a time in this process, so a save,
// a removal and a refresh can't leave the model list of one key beside another.
let pendingOpenAiChange: Promise< unknown > = Promise.resolve();
function serializeOpenAiChange< T >( change: () => Promise< T > ): Promise< T > {
	const next = pendingOpenAiChange.then( change, change );
	pendingOpenAiChange = next.catch( () => undefined );
	return next;
}

// Project (`sk-proj-`), service account (`sk-svcacct-`) and legacy user keys.
const OPENAI_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{16,}$/;

/**
 * Saves an OpenAI API key, to the system keychain unless `storage` is
 * `session`. The key is checked against OpenAI first: one OpenAI rejects is
 * not stored. A key that can't list models (missing permission, rate limit,
 * offline) is stored, with the reason kept beside the model list. A keychain
 * that isn't available fails the save with `SecureStorageError` — the key is
 * never written anywhere else instead.
 */
export function saveOpenAiApiKey(
	key: string,
	options: { storage?: OpenAiKeyStorage } = {}
): Promise< AiSettings > {
	const trimmed = key.trim();
	if ( trimmed.startsWith( 'sk-admin-' ) ) {
		return Promise.reject(
			new InvalidOpenAiApiKeyError(
				__( 'Admin keys can’t send requests to models. Use a project API key.' )
			)
		);
	}
	if ( ! OPENAI_KEY_PATTERN.test( trimmed ) ) {
		return Promise.reject(
			new InvalidOpenAiApiKeyError(
				__( 'That doesn’t look like an OpenAI API key. OpenAI keys start with “sk-”.' )
			)
		);
	}
	return serializeOpenAiChange( async () => {
		const list = await fetchOpenAiModelList( trimmed );
		if ( ! list.ok && list.error.kind === 'authentication' ) {
			throw new InvalidOpenAiApiKeyError( describeOpenAiError( list.error ) );
		}
		await storeOpenAiKey( trimmed, options.storage ?? 'keychain' );
		// The previous key's list says nothing about this key's project.
		await updateSharedConfig( {
			openaiModels: toStoredAvailability( list, NO_MODEL_LIST, trimmed ),
		} );
		return readAiSettings();
	} );
}

/**
 * Removes the OpenAI key from the keychain and this session. New conversations
 * go back to WordPress.com; existing OpenAI conversations stay on OpenAI and
 * show as disconnected.
 */
export function removeOpenAiApiKey(): Promise< AiSettings > {
	return serializeOpenAiChange( async () => {
		await deleteOpenAiKey();
		await updateSharedConfig( { openaiModels: undefined } );
		const { aiProvider } = await readAiProviderConfig();
		if ( aiProvider === 'openai-api-key' ) {
			return updateAiProviderConfig( { aiProvider: DEFAULT_AI_PROVIDER } );
		}
		return readAiSettings();
	} );
}

/** Reads the project's model list again; a failure keeps the previous list. */
export function refreshOpenAiModels(): Promise< AiSettings > {
	return serializeOpenAiChange( async () => {
		const source = await readOpenAiKeySource();
		if ( ! source ) {
			throw new OpenAiSettingsError( __( 'Add an OpenAI API key first.' ) );
		}
		const list = await fetchOpenAiModelList( source.key );
		const previous = readStoredAvailability(
			( await readOpenAiConfig() ).openaiModels,
			source.key
		);
		await updateSharedConfig( {
			openaiModels: toStoredAvailability( list, previous, source.key ),
		} );
		return readAiSettings();
	} );
}

/**
 * Changes the defaults for new OpenAI conversations. The resulting
 * combination must be one the model supports; nothing is adjusted to fit.
 */
export async function setOpenAiDefaults( update: OpenAiDefaultsUpdate ): Promise< AiSettings > {
	const { openAi } = await readAiSettings();
	const next = {
		model: update.model ?? openAi.defaultModel,
		reasoningEffort: update.reasoningEffort ?? openAi.defaultReasoningEffort,
		reasoningMode: update.reasoningMode ?? openAi.defaultReasoningMode,
		maxOutputTokens: update.maxOutputTokens ?? openAi.maxOutputTokens,
	};
	const result = resolveOpenAiTurnSettings( {
		...next,
		availableModelIds: openAi.models.availableModelIds,
	} );
	if ( ! result.ok ) {
		throw new OpenAiSettingsError( describeOpenAiSettingsProblem( result.problem ) );
	}
	await updateSharedConfig( {
		openaiDefaultModel: result.settings.model,
		openaiDefaultReasoningEffort: result.settings.reasoningEffort,
		openaiDefaultReasoningMode: result.settings.reasoningMode,
		openaiMaxOutputTokens: result.settings.maxOutputTokens,
	} );
	return readAiSettings();
}

/** The OpenAI key, for the process that runs a turn. Never sent to a UI. */
export async function readOpenAiApiKey(): Promise< OpenAiKeySource | null > {
	return readOpenAiKeySource();
}
