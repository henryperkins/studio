import { getAgentEndFailure } from '@studio/agent/protocol/json-events';
import { isAiModelId } from '@studio/agent/protocol/models';
import {
	describeOpenAiSettingsProblem,
	getInitialOpenAiReasoningEffort,
	isOpenAiModelId,
	OPENAI_DEFAULT_MAX_OUTPUT_TOKENS,
	OPENAI_DEFAULT_REASONING_MODE,
	resolveOpenAiTurnSettings,
} from '@studio/agent/protocol/openai-models';
import { providerServesModel } from '@studio/agent/protocol/providers';
import { getAgentEndTurnResult } from '@studio/agent/protocol/session-events';
import { runStudioAgentTurn } from '../runtime';
import type { StudioAgentHost } from '../host';
import type { StudioAgentTurnConfig } from '../runtime';
import type {
	BackendTurnOutcome,
	PiBackendTurnSnapshot,
} from '@studio/agent/protocol/backend-events';
import type { OpenAiTurnSettings } from '@studio/agent/protocol/openai-models';

// Existing callers own Pi's event stream, session manager, and turn result.
export const runPiAgentTurn = runStudioAgentTurn;

export interface PiBackendTurnHandlers {
	backend: 'pi';
	config: Omit< StudioAgentTurnConfig, 'model' | 'openAi' >;
	openAi?: Pick< OpenAiTurnSettings, 'reasoningMode' | 'maxOutputTokens' >;
}

export function runPiBackendTurn(
	host: StudioAgentHost,
	snapshot: PiBackendTurnSnapshot,
	{ config, openAi: openAiOptions }: PiBackendTurnHandlers
) {
	const { providerId, modelId } = snapshot.selection.model;
	if ( ! isAiModelId( modelId ) || ! providerServesModel( providerId, modelId ) ) {
		return failPiTurn( `Unknown ${ providerId } model: ${ modelId }` );
	}

	let openAi: OpenAiTurnSettings | undefined;
	if ( isOpenAiModelId( modelId ) ) {
		const settings = resolveOpenAiTurnSettings( {
			model: modelId,
			reasoningEffort: snapshot.effort ?? getInitialOpenAiReasoningEffort( modelId ),
			reasoningMode: openAiOptions?.reasoningMode ?? OPENAI_DEFAULT_REASONING_MODE,
			maxOutputTokens: openAiOptions?.maxOutputTokens ?? OPENAI_DEFAULT_MAX_OUTPUT_TOKENS,
		} );
		if ( ! settings.ok ) {
			return failPiTurn( describeOpenAiSettingsProblem( settings.problem ) );
		}
		openAi = settings.settings;
	}

	let outcome: BackendTurnOutcome | undefined;
	const handle = runPiAgentTurn( host, {
		...config,
		model: modelId,
		openAi,
		onEvent: ( event ) => {
			if ( event.type === 'agent_end' && ! event.willRetry ) {
				const { interrupted, success } = getAgentEndTurnResult( event );
				if ( interrupted ) {
					outcome = { status: 'interrupted' };
				} else if ( success ) {
					outcome = { status: 'success' };
				} else {
					outcome = { status: 'error', message: getAgentEndFailure( event )?.message };
				}
			}
			config.onEvent( event );
		},
	} );
	return {
		interrupt: handle.interrupt,
		result: handle.result.then(
			(): BackendTurnOutcome => outcome ?? { status: 'unknown_process_exit' },
			(): BackendTurnOutcome => ( { status: 'error' } )
		),
	};
}

function failPiTurn( message: string ) {
	return {
		result: Promise.resolve< BackendTurnOutcome >( { status: 'error', message } ),
		interrupt: async () => {},
	};
}
