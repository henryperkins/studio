import { __, sprintf } from '@wordpress/i18n';
import {
	getOpenAiReasoningEffortLabel,
	isOpenAiReasoningEffort,
	OPENAI_MODEL_CAPABILITIES,
	type OpenAiModelId,
	type OpenAiReasoningEffort,
	type OpenAiReasoningMode,
} from '@studio/agent/protocol/openai-models';

/** What a model accepts on the ChatGPT route, as far as Studio knows. */
export interface ChatGptModelCapabilities {
	/** `reasoning.effort` values the model accepts, lowest first. */
	reasoningEfforts: readonly OpenAiReasoningEffort[];
	/**
	 * `reasoning.mode` values Studio sends on this route. Only the effort is
	 * sent, and the route's mode support is undocumented, so this is standard.
	 */
	reasoningModes: readonly OpenAiReasoningMode[];
	/** Accepts image input, so screenshot tools may be offered. */
	imageInput: boolean;
}

// The API catalog's values for the model of the same name, without what only
// the API takes: its model name and output cap (this route takes no
// `max_output_tokens`), and its context limits.
function seedFromApiCatalog( model: OpenAiModelId ): ChatGptModelCapabilities {
	const { reasoningEfforts, imageInput } = OPENAI_MODEL_CAPABILITIES[ model ];
	return { reasoningEfforts, reasoningModes: [ 'standard' ], imageInput };
}

/**
 * The ChatGPT-route models Studio supports, by the slug the route lists them
 * under. The route's model list carries no capabilities (SIWC "Models and
 * inference"), so a listed model is offered only when it is here: Studio
 * never guesses what a model accepts.
 */
export const CHATGPT_MODEL_CAPABILITIES: Readonly< Record< string, ChatGptModelCapabilities > > = {
	'gpt-6.1-sol': seedFromApiCatalog( 'gpt-6.1-sol' ),
	'gpt-6-astra': seedFromApiCatalog( 'gpt-6-astra' ),
	'gpt-6.1-terra': seedFromApiCatalog( 'gpt-6.1-terra' ),
	'gpt-6-luna': seedFromApiCatalog( 'gpt-6-luna' ),
};

export function getChatGptModelCapabilities( slug: string ): ChatGptModelCapabilities | undefined {
	return Object.prototype.hasOwnProperty.call( CHATGPT_MODEL_CAPABILITIES, slug )
		? CHATGPT_MODEL_CAPABILITIES[ slug ]
		: undefined;
}

/** The effort a ChatGPT turn uses when the conversation recorded none. */
export function getDefaultChatGptReasoningEffort( modelId: string ): OpenAiReasoningEffort {
	const capabilities = getChatGptModelCapabilities( modelId );
	if ( ! capabilities ) {
		return 'medium';
	}
	return capabilities.reasoningEfforts.includes( 'medium' )
		? 'medium'
		: capabilities.reasoningEfforts[ 0 ];
}

export type ChatGptReasoningProblem =
	| { code: 'unknown-model'; model: string }
	| {
			code: 'unsupported-effort';
			model: string;
			effort: string;
			supported: readonly OpenAiReasoningEffort[];
	  };

/**
 * Checks one model and effort against the ChatGPT capability table. Nothing
 * is adjusted: an effort the model doesn't list is a problem to show, never
 * a nearby effort sent instead.
 */
export function resolveChatGptReasoning(
	model: string,
	effort: string
): { ok: true; effort: OpenAiReasoningEffort } | { ok: false; problem: ChatGptReasoningProblem } {
	const capabilities = getChatGptModelCapabilities( model );
	if ( ! capabilities ) {
		return { ok: false, problem: { code: 'unknown-model', model } };
	}
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
	return { ok: true, effort };
}

export function describeChatGptReasoningProblem( problem: ChatGptReasoningProblem ): string {
	switch ( problem.code ) {
		case 'unknown-model':
			return sprintf(
				/* translators: %s: a ChatGPT model id Studio does not support. */
				__( 'Studio doesn’t support the ChatGPT model “%s”. Choose another model to continue.' ),
				problem.model
			);
		case 'unsupported-effort':
			return sprintf(
				/* translators: 1: ChatGPT model id, 2: the requested reasoning effort, 3: comma-separated list of supported efforts. */
				__( '%1$s doesn’t support “%2$s” reasoning with ChatGPT. Choose one of: %3$s.' ),
				problem.model,
				isOpenAiReasoningEffort( problem.effort )
					? getOpenAiReasoningEffortLabel( problem.effort )
					: problem.effort,
				problem.supported.map( getOpenAiReasoningEffortLabel ).join( ', ' )
			);
	}
}
