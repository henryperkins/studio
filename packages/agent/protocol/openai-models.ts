import { __, sprintf } from '@wordpress/i18n';
import { AI_MODELS, isAiModelId } from '@studio/agent/protocol/models';
import { isStudioCustomEntryOfType } from '@studio/agent/protocol/sessions/entry-types';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

// Recorded with every model-list refresh, so a cached availability list can be
// told apart from one checked against a different catalog.
export const OPENAI_MODEL_CATALOG_VERSION = '2026-11-07';

export const OPENAI_REASONING_EFFORTS = [
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
] as const;
export type OpenAiReasoningEffort = ( typeof OPENAI_REASONING_EFFORTS )[ number ];

export const OPENAI_REASONING_MODES = [ 'standard', 'pro' ] as const;
export type OpenAiReasoningMode = ( typeof OPENAI_REASONING_MODES )[ number ];

type OpenAiCatalogModel = Extract< ( typeof AI_MODELS )[ number ], { family: 'openai' } >;
export type OpenAiModelId = OpenAiCatalogModel[ 'id' ];

export interface OpenAiModelCapabilities {
	/** The model name sent to OpenAI; Studio's own id stays stable in sessions. */
	apiModelId: string;
	/** Served by the Responses API, which Studio uses for every OpenAI turn. */
	responsesApi: boolean;
	/** Accepts function tools on the Responses API with reasoning enabled. */
	functionTools: boolean;
	/** Accepts image input, so screenshot tools may be offered. */
	imageInput: boolean;
	/** `reasoning.effort` values the model accepts, lowest first. */
	reasoningEfforts: readonly OpenAiReasoningEffort[];
	/** The documented default effort, when the documentation states one. */
	defaultReasoningEffort?: OpenAiReasoningEffort;
	/** `reasoning.mode` values the model accepts. */
	reasoningModes: readonly OpenAiReasoningMode[];
	contextWindow: number;
	maxInputTokens: number;
	maxOutputTokens: number;
	/** Where each value above was read, and when. */
	documentation: { modelPage: string; reasoningModes: string; checked: string };
}

const DOCS = 'https://developers.openai.com/api/docs';
// "GPT-5.6 and GPT-6 models support standard and pro reasoning modes in the
// Responses API." — the reasoning guide; the GPT-6 guide lists pro mode among
// the GPT-5.6 capabilities every GPT-6 model keeps.
const REASONING_MODES_DOCS = `${ DOCS }/guides/reasoning#reasoning-mode`;
const CHECKED = '2026-11-07';

// Values come from each model's page, not from the account's model list,
// which carries no capabilities. All four share the GPT-6 limits.
const GPT_6_LIMITS = {
	responsesApi: true,
	functionTools: true,
	imageInput: true,
	reasoningModes: OPENAI_REASONING_MODES,
	contextWindow: 1_050_000,
	maxInputTokens: 922_000,
	maxOutputTokens: 128_000,
} as const;

export const OPENAI_MODEL_CAPABILITIES: Readonly<
	Record< OpenAiModelId, OpenAiModelCapabilities >
> = {
	'gpt-6.1-sol': {
		...GPT_6_LIMITS,
		apiModelId: 'gpt-6.1-sol',
		reasoningEfforts: [ 'low', 'medium', 'high', 'xhigh', 'max' ],
		defaultReasoningEffort: 'medium',
		documentation: {
			modelPage: `${ DOCS }/models/gpt-6.1-sol`,
			reasoningModes: REASONING_MODES_DOCS,
			checked: CHECKED,
		},
	},
	'gpt-6-astra': {
		...GPT_6_LIMITS,
		apiModelId: 'gpt-6-astra',
		// The model page states no default; `none` answers HTTP 400.
		reasoningEfforts: [ 'low', 'medium', 'high', 'xhigh', 'max' ],
		documentation: {
			modelPage: `${ DOCS }/models/gpt-6-astra`,
			reasoningModes: REASONING_MODES_DOCS,
			checked: CHECKED,
		},
	},
	'gpt-6.1-terra': {
		...GPT_6_LIMITS,
		apiModelId: 'gpt-6.1-terra',
		reasoningEfforts: [ 'none', 'low', 'medium', 'high', 'xhigh', 'max' ],
		defaultReasoningEffort: 'medium',
		documentation: {
			modelPage: `${ DOCS }/models/gpt-6.1-terra`,
			reasoningModes: REASONING_MODES_DOCS,
			checked: CHECKED,
		},
	},
	'gpt-6-luna': {
		...GPT_6_LIMITS,
		apiModelId: 'gpt-6-luna',
		reasoningEfforts: [ 'none', 'low', 'medium', 'high', 'xhigh', 'max' ],
		defaultReasoningEffort: 'medium',
		documentation: {
			modelPage: `${ DOCS }/models/gpt-6-luna`,
			reasoningModes: REASONING_MODES_DOCS,
			checked: CHECKED,
		},
	},
};

export const OPENAI_MODEL_IDS = AI_MODELS.filter(
	( model ): model is OpenAiCatalogModel => model.family === 'openai'
).map( ( model ) => model.id );

// Near-flagship quality at a lower cost than Astra; the GPT-6 guide's
// "balanced speed, cost, and intelligence" pick.
export const OPENAI_DEFAULT_MODEL: OpenAiModelId = 'gpt-6.1-sol';
export const OPENAI_INITIAL_REASONING_EFFORT: OpenAiReasoningEffort = 'medium';
export const OPENAI_DEFAULT_REASONING_MODE: OpenAiReasoningMode = 'standard';

// Reasoning tokens count toward `max_output_tokens`, so the cap bounds both.
// Studio's default matches its other providers and stays above the 25,000
// tokens the reasoning guide suggests reserving when starting out.
export const OPENAI_DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
export const OPENAI_MIN_MAX_OUTPUT_TOKENS = 1_024;

export function isOpenAiModelId( value: string ): value is OpenAiModelId {
	return Object.prototype.hasOwnProperty.call( OPENAI_MODEL_CAPABILITIES, value );
}

export function getOpenAiModelCapabilities( id: string ): OpenAiModelCapabilities | undefined {
	return isOpenAiModelId( id ) ? OPENAI_MODEL_CAPABILITIES[ id ] : undefined;
}

export function isOpenAiReasoningEffort( value: string ): value is OpenAiReasoningEffort {
	return ( OPENAI_REASONING_EFFORTS as readonly string[] ).includes( value );
}

export function isOpenAiReasoningMode( value: string ): value is OpenAiReasoningMode {
	return ( OPENAI_REASONING_MODES as readonly string[] ).includes( value );
}

/**
 * The effort a model starts with when nothing was chosen: medium where the
 * model supports it, else its documented default, else its lowest effort.
 */
export function getInitialOpenAiReasoningEffort( model: OpenAiModelId ): OpenAiReasoningEffort {
	const capabilities = OPENAI_MODEL_CAPABILITIES[ model ];
	if ( capabilities.reasoningEfforts.includes( OPENAI_INITIAL_REASONING_EFFORT ) ) {
		return OPENAI_INITIAL_REASONING_EFFORT;
	}
	return capabilities.defaultReasoningEffort ?? capabilities.reasoningEfforts[ 0 ];
}

/** Everything one OpenAI turn sends, fixed when the turn starts. */
export interface OpenAiTurnSettings {
	model: OpenAiModelId;
	apiModelId: string;
	reasoningEffort: OpenAiReasoningEffort;
	reasoningMode: OpenAiReasoningMode;
	maxOutputTokens: number;
}

export type OpenAiSettingsProblem =
	| { code: 'unknown-model'; model: string }
	| { code: 'model-not-available'; model: OpenAiModelId }
	| {
			code: 'unsupported-effort';
			model: OpenAiModelId;
			effort: string;
			supported: readonly OpenAiReasoningEffort[];
	  }
	| {
			code: 'unsupported-mode';
			model: OpenAiModelId;
			mode: string;
			supported: readonly OpenAiReasoningMode[];
	  }
	| {
			code: 'invalid-max-output-tokens';
			model: OpenAiModelId;
			value: number;
			min: number;
			max: number;
	  };

export type OpenAiTurnSettingsResult =
	| { ok: true; settings: OpenAiTurnSettings }
	| { ok: false; problem: OpenAiSettingsProblem };

export interface OpenAiTurnSettingsInput {
	model: string;
	reasoningEffort: string;
	reasoningMode: string;
	maxOutputTokens: number;
	/**
	 * The catalog models the account's model list included, or null when the
	 * list is unknown (never read, or the key may not list models). Only a
	 * known list can rule a model out.
	 */
	availableModelIds?: readonly string[] | null;
}

/**
 * Validates one combination of model, effort, mode and output cap against the
 * catalog. Nothing is adjusted: an unsupported value comes back as a problem
 * for the caller to show, never as a nearby supported value.
 */
export function resolveOpenAiTurnSettings(
	input: OpenAiTurnSettingsInput
): OpenAiTurnSettingsResult {
	if ( ! isOpenAiModelId( input.model ) ) {
		return { ok: false, problem: { code: 'unknown-model', model: input.model } };
	}
	const model = input.model;
	const capabilities = OPENAI_MODEL_CAPABILITIES[ model ];
	if ( input.availableModelIds && ! input.availableModelIds.includes( model ) ) {
		return { ok: false, problem: { code: 'model-not-available', model } };
	}
	const effort = input.reasoningEffort;
	if ( ! isOpenAiReasoningEffort( effort ) || ! capabilities.reasoningEfforts.includes( effort ) ) {
		return {
			ok: false,
			problem: {
				code: 'unsupported-effort',
				model,
				effort,
				supported: capabilities.reasoningEfforts,
			},
		};
	}
	const mode = input.reasoningMode;
	if ( ! isOpenAiReasoningMode( mode ) || ! capabilities.reasoningModes.includes( mode ) ) {
		return {
			ok: false,
			problem: { code: 'unsupported-mode', model, mode, supported: capabilities.reasoningModes },
		};
	}
	const maxOutputTokens = input.maxOutputTokens;
	if (
		! Number.isInteger( maxOutputTokens ) ||
		maxOutputTokens < OPENAI_MIN_MAX_OUTPUT_TOKENS ||
		maxOutputTokens > capabilities.maxOutputTokens
	) {
		return {
			ok: false,
			problem: {
				code: 'invalid-max-output-tokens',
				model,
				value: maxOutputTokens,
				min: OPENAI_MIN_MAX_OUTPUT_TOKENS,
				max: capabilities.maxOutputTokens,
			},
		};
	}
	return {
		ok: true,
		settings: {
			model,
			apiModelId: capabilities.apiModelId,
			reasoningEffort: effort,
			reasoningMode: mode,
			maxOutputTokens,
		},
	};
}

/** The model, effort and mode a conversation chose, before validation. */
export interface OpenAiSelection {
	model: string;
	reasoningEffort: string;
	reasoningMode: string;
}

/**
 * A conversation's own choices layered over the global defaults. The latest
 * recorded model wins, verbatim, so a model Studio dropped surfaces as a
 * problem instead of quietly becoming the default. Effort and mode come from
 * the latest entry that set each.
 */
export function resolveOpenAiSessionSelection(
	entries: SessionEntry[],
	defaults: OpenAiSelection
): OpenAiSelection {
	let model: string | undefined;
	let reasoningEffort: string | undefined;
	let reasoningMode: string | undefined;
	for ( let index = entries.length - 1; index >= 0; index -= 1 ) {
		const entry = entries[ index ];
		if ( model === undefined && entry.type === 'model_change' ) {
			const modelId = ( entry as { modelId?: unknown } ).modelId;
			model = typeof modelId === 'string' ? modelId : undefined;
		}
		if ( isStudioCustomEntryOfType( entry, 'studio.session_context' ) ) {
			const data = entry.data;
			if ( model === undefined && typeof data?.model === 'string' ) {
				model = data.model;
			}
			if ( reasoningEffort === undefined && typeof data?.reasoningEffort === 'string' ) {
				reasoningEffort = data.reasoningEffort;
			}
			if ( reasoningMode === undefined && typeof data?.reasoningMode === 'string' ) {
				reasoningMode = data.reasoningMode;
			}
		}
		if ( model !== undefined && reasoningEffort !== undefined && reasoningMode !== undefined ) {
			break;
		}
	}
	return {
		model: model ?? defaults.model,
		reasoningEffort: reasoningEffort ?? defaults.reasoningEffort,
		reasoningMode: reasoningMode ?? defaults.reasoningMode,
	};
}

// Translated at call time: module-level `__()` is banned.
export function getOpenAiReasoningEffortLabel( effort: OpenAiReasoningEffort ): string {
	switch ( effort ) {
		case 'none':
			return __( 'None' );
		case 'minimal':
			return __( 'Minimal' );
		case 'low':
			return __( 'Low' );
		case 'medium':
			return __( 'Medium' );
		case 'high':
			return __( 'High' );
		case 'xhigh':
			return __( 'Extra high' );
		case 'max':
			return __( 'Max' );
	}
}

export function getOpenAiReasoningModeLabel( mode: OpenAiReasoningMode ): string {
	return mode === 'pro' ? __( 'Pro' ) : __( 'Standard' );
}

function getModelLabel( model: string ): string {
	return isAiModelId( model )
		? AI_MODELS.find( ( entry ) => entry.id === model )?.label ?? model
		: model;
}

function listLabels< T extends string >( values: readonly T[], label: ( value: T ) => string ) {
	return values.map( label ).join( ', ' );
}

/** What went wrong and how to fix it, for the composer and the CLI. */
export function describeOpenAiSettingsProblem( problem: OpenAiSettingsProblem ): string {
	switch ( problem.code ) {
		case 'unknown-model':
			return sprintf(
				/* translators: %s: an OpenAI model id Studio does not support. */
				__( 'Studio doesn’t support the OpenAI model “%s”. Choose another model to continue.' ),
				problem.model
			);
		case 'model-not-available':
			return sprintf(
				/* translators: %s: OpenAI model name. */
				__(
					'%s isn’t in your OpenAI project’s model list. Choose another model, or refresh the list in Settings.'
				),
				getModelLabel( problem.model )
			);
		case 'unsupported-effort':
			return sprintf(
				/* translators: 1: OpenAI model name, 2: the requested reasoning effort, 3: comma-separated list of supported efforts. */
				__( '%1$s doesn’t support “%2$s” reasoning. Choose one of: %3$s.' ),
				getModelLabel( problem.model ),
				isOpenAiReasoningEffort( problem.effort )
					? getOpenAiReasoningEffortLabel( problem.effort )
					: problem.effort,
				listLabels( problem.supported, getOpenAiReasoningEffortLabel )
			);
		case 'unsupported-mode':
			return sprintf(
				/* translators: 1: OpenAI model name, 2: the requested reasoning mode, 3: comma-separated list of supported modes. */
				__( '%1$s doesn’t support the “%2$s” reasoning mode. Choose one of: %3$s.' ),
				getModelLabel( problem.model ),
				isOpenAiReasoningMode( problem.mode )
					? getOpenAiReasoningModeLabel( problem.mode )
					: problem.mode,
				listLabels( problem.supported, getOpenAiReasoningModeLabel )
			);
		case 'invalid-max-output-tokens':
			return sprintf(
				/* translators: 1: OpenAI model name, 2: minimum token count, 3: maximum token count. */
				__(
					'The output token limit for %1$s must be a whole number from %2$s to %3$s. Change it in Settings.'
				),
				getModelLabel( problem.model ),
				problem.min.toLocaleString(),
				problem.max.toLocaleString()
			);
	}
}
