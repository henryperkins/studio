import { appendStudioEntry } from '@studio/agent/node/sessions/store';
import { OpenAiSettingsError } from '@studio/agent/node/settings-store';
import {
	describeOpenAiSettingsProblem,
	OPENAI_DEFAULT_MAX_OUTPUT_TOKENS,
	resolveOpenAiTurnSettings,
} from '@studio/agent/protocol/openai-models';
import type { OpenAiSessionSelection } from '@studio/agent/protocol/providers';

/**
 * Pins a conversation to OpenAI with a model, effort and mode, in one entry
 * the CLI reads at the start of the next turn. A combination the model
 * doesn't support is refused, not adjusted.
 */
export async function setSessionOpenAiSelection(
	sessionsRoot: string,
	sessionId: string,
	selection: { model: unknown; reasoningEffort: unknown; reasoningMode: unknown }
): Promise< OpenAiSessionSelection > {
	const { model, reasoningEffort, reasoningMode } = selection;
	if (
		typeof model !== 'string' ||
		typeof reasoningEffort !== 'string' ||
		typeof reasoningMode !== 'string'
	) {
		throw new OpenAiSettingsError( 'An OpenAI selection needs a model, an effort and a mode.' );
	}
	const result = resolveOpenAiTurnSettings( {
		model,
		reasoningEffort,
		reasoningMode,
		// Only the selection is checked here; the cap comes from settings per turn.
		maxOutputTokens: OPENAI_DEFAULT_MAX_OUTPUT_TOKENS,
	} );
	if ( ! result.ok ) {
		throw new OpenAiSettingsError( describeOpenAiSettingsProblem( result.problem ) );
	}
	const pinned: OpenAiSessionSelection = {
		model: result.settings.model,
		reasoningEffort: result.settings.reasoningEffort,
		reasoningMode: result.settings.reasoningMode,
	};
	await appendStudioEntry( sessionsRoot, sessionId, 'studio.session_context', {
		provider: 'openai-api-key',
		...pinned,
	} );
	return pinned;
}
