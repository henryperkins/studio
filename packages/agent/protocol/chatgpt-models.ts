import { __, sprintf } from '@wordpress/i18n';
import {
	getOpenAiReasoningEffortLabel,
	isOpenAiReasoningEffort,
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
	/** Accepts images the user attaches to a message. */
	imageInput: boolean;
	/**
	 * Accepts images in tool results (screenshots, image files read). Off, the
	 * tools still run and return their text without the image, as for a model
	 * that can't view images.
	 */
	toolImageInput: boolean;
}

/**
 * The budget compaction keeps a ChatGPT conversation under. The route
 * documents no context window, so this is Studio's own, as on its other
 * providers.
 */
export const CHATGPT_LOCAL_CONTEXT_BUDGET = 200_000;

/**
 * The ChatGPT-route models Studio supports, by the slug the route lists them
 * under, with what each is qualified for on this route: by the route's own
 * documentation or a request it was seen to complete. The route's model list
 * carries no capabilities (SIWC "Models and inference"), and the OpenAI API
 * catalog describes another route, so nothing here comes from either: a
 * listed model is offered only when it is here, and only with what is here.
 * Sources for each value are in the readiness ledger's G2 record.
 */
export const CHATGPT_MODEL_CAPABILITIES: Readonly< Record< string, ChatGptModelCapabilities > > =
	Object.freeze( {
		// Low and medium completed in a captured run; the other efforts were never
		// sent. Attached images: the route takes images when the model accepts
		// them (SIWC "Preview limitations"), which this model's page states.
		// Images in tool results: no source names them for this route and no
		// request carrying one was seen, so off until gate T1 observes one accepted.
		'gpt-6-luna': Object.freeze( {
			reasoningEfforts: Object.freeze( [ 'low', 'medium' ] as const ),
			reasoningModes: Object.freeze( [ 'standard' ] as const ),
			imageInput: true,
			toolImageInput: false,
		} ),
	} );

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
				__(
					'Studio doesn’t support the ChatGPT model “%s” yet: it isn’t qualified for use with a ChatGPT plan. Choose another model to continue.'
				),
				problem.model
			);
		case 'unsupported-effort':
			return sprintf(
				/* translators: 1: ChatGPT model id, 2: the requested reasoning effort, 3: comma-separated list of supported efforts. */
				__(
					'Studio doesn’t support “%2$s” reasoning for %1$s with ChatGPT yet: it isn’t qualified for use with a ChatGPT plan. Choose one of: %3$s.'
				),
				problem.model,
				isOpenAiReasoningEffort( problem.effort )
					? getOpenAiReasoningEffortLabel( problem.effort )
					: problem.effort,
				problem.supported.map( getOpenAiReasoningEffortLabel ).join( ', ' )
			);
	}
}
