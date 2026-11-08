import { getAiModelLabel } from '@studio/agent/protocol/models';
import {
	describeOpenAiSettingsProblem,
	getInitialOpenAiReasoningEffort,
	getOpenAiModelCapabilities,
	getOpenAiReasoningEffortLabel,
	getOpenAiReasoningModeLabel,
	isOpenAiModelId,
	OPENAI_DEFAULT_REASONING_MODE,
	OPENAI_MODEL_IDS,
	resolveOpenAiSessionSelection,
	resolveOpenAiTurnSettings,
	type OpenAiModelCapabilities,
	type OpenAiModelId,
	type OpenAiReasoningEffort,
	type OpenAiReasoningMode,
	type OpenAiSelection,
	type OpenAiSettingsProblem,
	type OpenAiTurnSettings,
} from '@studio/agent/protocol/openai-models';
import { useQueryClient } from '@tanstack/react-query';
import { __, sprintf } from '@wordpress/i18n';
import { useCallback, useMemo } from 'react';
import { useConnector } from '@/data/core';
import { useAiSettings } from '@/data/queries/use-ai-settings';
import { SESSIONS_QUERY_KEY } from '@/data/queries/use-sessions';
import { useOpenSettings } from '@/data/use-open-settings';
import type { ComposerNotice } from './notice-tab';
import type { AiModelId, LoadedAiSession, SessionEntry } from '@/data/core';
import type {
	AiProviderId,
	OpenAiProviderSettings,
	OpenAiSessionSelection,
} from '@studio/agent/protocol/providers';

/** What a site's chat draft holds about reasoning before it becomes a session. */
export interface OpenAiDraftReasoning {
	reasoningEffort?: OpenAiReasoningEffort;
	reasoningMode?: OpenAiReasoningMode;
}

export interface OpenAiConversation {
	/** The conversation's model, effort and mode, before validation. */
	selection: OpenAiSelection;
	/** What the next turn sends, or null while the selection can't run. */
	settings: OpenAiTurnSettings | null;
	/** The capabilities of the selected model, when Studio knows it. */
	capabilities?: OpenAiModelCapabilities;
	/** Why the chat can't send, with a way to fix it. */
	notice?: ComposerNotice;
	changeReasoning( effort: OpenAiReasoningEffort, mode: OpenAiReasoningMode ): void;
}

// Optimistic mirror of the entry the backend appends, so the picker updates
// before the write lands.
function createSelectionEntry( selection: OpenAiSessionSelection ): SessionEntry {
	return {
		type: 'custom',
		id: Math.random().toString( 36 ).slice( 2, 10 ),
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: 'studio.session_context',
		data: { provider: 'openai-api-key', ...selection },
	} as unknown as SessionEntry;
}

// The model a correction offers instead of one that can't run: the default,
// unless the project's list rules it out too.
function pickReplacementModel( openAi: OpenAiProviderSettings ): OpenAiModelId | undefined {
	const available = openAi.models.availableModelIds;
	if ( ! available || available.includes( openAi.defaultModel ) ) {
		return openAi.defaultModel;
	}
	return OPENAI_MODEL_IDS.find( ( id ) => available.includes( id ) );
}

// Keeps the effort and mode when the replacement model supports them.
function fitSelection(
	model: OpenAiModelId,
	effort: string,
	mode: string
): OpenAiSessionSelection {
	const capabilities = getOpenAiModelCapabilities( model )!;
	return {
		model,
		reasoningEffort: ( capabilities.reasoningEfforts as readonly string[] ).includes( effort )
			? ( effort as OpenAiReasoningEffort )
			: getInitialOpenAiReasoningEffort( model ),
		reasoningMode: ( capabilities.reasoningModes as readonly string[] ).includes( mode )
			? ( mode as OpenAiReasoningMode )
			: OPENAI_DEFAULT_REASONING_MODE,
	};
}

/**
 * The OpenAI side of a chat: what it will send, why it can't, and how to change
 * its reasoning. A change made while a turn runs applies to the next turn.
 * Nothing here adjusts a choice on its own: a combination that can't run
 * blocks the chat, and its notice offers the fix for the user to apply.
 */
export function useOpenAiConversation( {
	provider,
	sessionId,
	entries,
	model,
	draft,
	onDraftChange,
}: {
	provider: AiProviderId;
	sessionId?: string;
	entries?: SessionEntry[];
	// The model a draft shows; sessions read theirs from their entries.
	model: AiModelId;
	draft: OpenAiDraftReasoning;
	onDraftChange: ( patch: OpenAiDraftReasoning & { model?: AiModelId } ) => void;
} ): OpenAiConversation | undefined {
	const { data: aiSettings } = useAiSettings();
	const connector = useConnector();
	const queryClient = useQueryClient();
	const openSettings = useOpenSettings();
	const openAi = aiSettings?.openAi;
	const isOpenAi = provider === 'openai-api-key' && !! openAi;

	const selection = useMemo( (): OpenAiSelection | undefined => {
		if ( ! isOpenAi ) {
			return undefined;
		}
		const defaults = {
			model: openAi.defaultModel,
			reasoningEffort: openAi.defaultReasoningEffort,
			reasoningMode: openAi.defaultReasoningMode,
		};
		if ( sessionId ) {
			return resolveOpenAiSessionSelection( entries ?? [], defaults );
		}
		return {
			model: isOpenAiModelId( model ) ? model : defaults.model,
			reasoningEffort: draft.reasoningEffort ?? defaults.reasoningEffort,
			reasoningMode: draft.reasoningMode ?? defaults.reasoningMode,
		};
	}, [ draft.reasoningEffort, draft.reasoningMode, entries, isOpenAi, model, openAi, sessionId ] );

	const apply = useCallback(
		( next: OpenAiSessionSelection ) => {
			if ( ! sessionId ) {
				onDraftChange( {
					model: next.model,
					reasoningEffort: next.reasoningEffort,
					reasoningMode: next.reasoningMode,
				} );
				return;
			}
			const queryKey = [ ...SESSIONS_QUERY_KEY, sessionId ];
			queryClient.setQueryData< LoadedAiSession >( queryKey, ( previous ) =>
				previous
					? {
							...previous,
							entries: [ ...( previous.entries ?? [] ), createSelectionEntry( next ) ],
					  }
					: previous
			);
			void connector.setSessionOpenAiSelection( sessionId, next ).catch( () => {
				void queryClient.invalidateQueries( { queryKey } );
			} );
		},
		[ connector, onDraftChange, queryClient, sessionId ]
	);

	return useMemo( () => {
		if ( ! isOpenAi || ! selection ) {
			return undefined;
		}
		const capabilities = getOpenAiModelCapabilities( selection.model );
		const result = resolveOpenAiTurnSettings( {
			...selection,
			maxOutputTokens: openAi.maxOutputTokens,
			availableModelIds: openAi.models.availableModelIds,
		} );
		const changeReasoning = ( effort: OpenAiReasoningEffort, mode: OpenAiReasoningMode ) => {
			if ( capabilities ) {
				apply( {
					model: selection.model as OpenAiModelId,
					reasoningEffort: effort,
					reasoningMode: mode,
				} );
			}
		};
		const notice = ! aiSettings?.hasOpenAiApiKey
			? {
					message: __(
						'OpenAI isn’t connected. Connect it to continue this chat, or start a new chat with another provider.'
					),
					action: { label: __( 'Connect' ), onClick: () => openSettings( 'ai' ) },
			  }
			: result.ok
			? undefined
			: {
					message: describeOpenAiSettingsProblem( result.problem, { brief: true } ),
					action: getCorrection( result.problem ),
			  };

		function getCorrection( problem: OpenAiSettingsProblem ): ComposerNotice[ 'action' ] {
			if ( ! openAi || ! selection ) {
				return undefined;
			}
			if ( problem.code === 'invalid-max-output-tokens' ) {
				return { label: __( 'Open Settings' ), onClick: () => openSettings( 'ai' ) };
			}
			if ( problem.code === 'unknown-model' || problem.code === 'model-not-available' ) {
				const replacement = pickReplacementModel( openAi );
				if ( ! replacement || replacement === selection.model ) {
					return { label: __( 'Open Settings' ), onClick: () => openSettings( 'ai' ) };
				}
				return {
					label: sprintf(
						/* translators: %s: OpenAI model name. */
						__( 'Use %s' ),
						getAiModelLabel( replacement )
					),
					onClick: () =>
						apply(
							fitSelection( replacement, selection.reasoningEffort, selection.reasoningMode )
						),
				};
			}
			const model = problem.model;
			if ( problem.code === 'unsupported-effort' ) {
				const effort = getInitialOpenAiReasoningEffort( model );
				return {
					label: sprintf(
						/* translators: %s: reasoning effort, e.g. "Medium". */
						__( 'Use %s' ),
						getOpenAiReasoningEffortLabel( effort )
					),
					onClick: () => apply( fitSelection( model, effort, selection.reasoningMode ) ),
				};
			}
			return {
				label: sprintf(
					/* translators: %s: reasoning mode, e.g. "Standard". */
					__( 'Use %s' ),
					getOpenAiReasoningModeLabel( OPENAI_DEFAULT_REASONING_MODE )
				),
				onClick: () =>
					apply( fitSelection( model, selection.reasoningEffort, OPENAI_DEFAULT_REASONING_MODE ) ),
			};
		}

		return {
			selection,
			settings: result.ok ? result.settings : null,
			capabilities,
			notice,
			changeReasoning,
		};
	}, [ aiSettings?.hasOpenAiApiKey, apply, isOpenAi, openAi, openSettings, selection ] );
}
