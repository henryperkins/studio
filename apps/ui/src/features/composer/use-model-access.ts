import { aiModelRequiresPaidCredits, getAiModelFamily } from '@studio/agent/protocol/models';
import {
	AI_PROVIDER_IDS,
	getEffectiveSessionProvider,
	isAiProviderConnected,
} from '@studio/agent/protocol/providers';
import { canUsePaidAiModels } from '@studio/common/lib/studio-assistant-quota';
import { useCallback, useMemo } from 'react';
import { useAiSettings } from '@/data/queries/use-ai-settings';
import { useStudioAssistantQuota } from '@/data/queries/use-assistant-quota';
import { useAuthUser } from '@/data/queries/use-auth-user';
import type { AiModelId, SessionEntry } from '@/data/core';
import type { AiProviderId } from '@studio/agent/protocol/providers';

// Why a listed model can't be picked: the paid WordPress.com tiers before any
// credits were bought, or an OpenAI model the project's model list lacks.
export type ModelLockReason = 'credits' | 'not-in-project';

// The provider the chat is on, the providers it can use, and which models are
// out of reach.
export function useModelAccess( {
	sessionId,
	entries,
	provider,
}: {
	sessionId?: string;
	entries?: SessionEntry[];
	provider?: AiProviderId;
} ) {
	const { data: aiSettings } = useAiSettings();
	const sessionProvider = useMemo(
		() => provider ?? getEffectiveSessionProvider( entries ?? [], aiSettings ),
		[ entries, aiSettings, provider ]
	);

	// The paid tiers are listed but disabled for accounts that have never
	// bought credits; Automatticians are exempt.
	const { data: quota } = useStudioAssistantQuota( { refetchOnWindowFocus: 'always' } );
	const { data: authUser } = useAuthUser();
	// Connected providers are available in saved chats and site drafts.
	const providers = AI_PROVIDER_IDS.filter(
		( id ) =>
			isAiProviderConnected( id, { hasWpcomAuth: !! authUser, settings: aiSettings } ) &&
			( !! sessionId || !! provider || id === sessionProvider )
	);
	const canUsePaidTiers = canUsePaidAiModels( quota, authUser?.email );
	const availableOpenAiModels = aiSettings?.openAi.models.availableModelIds;
	const getModelLockReason = useCallback(
		( id: AiModelId ): ModelLockReason | undefined => {
			if ( aiModelRequiresPaidCredits( id ) && ! canUsePaidTiers ) {
				return 'credits';
			}
			if (
				getAiModelFamily( id ) === 'openai' &&
				availableOpenAiModels &&
				! ( availableOpenAiModels as readonly string[] ).includes( id )
			) {
				return 'not-in-project';
			}
			return undefined;
		},
		[ availableOpenAiModels, canUsePaidTiers ]
	);
	const isModelLocked = useCallback(
		( id: AiModelId ) => getModelLockReason( id ) !== undefined,
		[ getModelLockReason ]
	);

	return { sessionProvider, providers, isModelLocked, getModelLockReason };
}
