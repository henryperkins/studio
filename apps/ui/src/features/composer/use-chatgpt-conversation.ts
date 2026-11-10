import { readChatGptSessionSelection } from '@studio/agent/protocol/chatgpt';
import {
	describeChatGptReasoningProblem,
	getChatGptModelCapabilities,
	resolveChatGptReasoning,
} from '@studio/agent/protocol/chatgpt-models';
import {
	describeConnectionSelectionError,
	resolveConnectionSelection,
} from '@studio/agent/protocol/connections';
import { useQueryClient } from '@tanstack/react-query';
import { __, sprintf } from '@wordpress/i18n';
import { toast } from '@/data/app-messages';
import { useConnector } from '@/data/core';
import { useChatGptModels, useChatGptSettings } from '@/data/queries/use-chatgpt-settings';
import { saveSessionSettingChange } from '@/data/session-setting-changes';
import { useOpenSettings } from '@/data/use-open-settings';
import type { ComposerNotice } from './notice-tab';
import type { SessionEntry } from '@/data/core';
import type { ChatGptSessionSelection } from '@studio/agent/protocol/chatgpt';
import type { AiProviderId } from '@studio/agent/protocol/providers';

export function createChatGptSelectionEntry( selection: ChatGptSessionSelection ): SessionEntry {
	return {
		type: 'custom',
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: 'studio.session_context',
		data: { provider: 'chatgpt-oauth', ...selection },
	};
}

export function useChatGptConversation( {
	provider,
	sessionId,
	entries = [],
}: {
	provider: AiProviderId;
	sessionId?: string;
	entries?: SessionEntry[];
} ) {
	const connector = useConnector();
	const queryClient = useQueryClient();
	const settings = useChatGptSettings();
	const openSettings = useOpenSettings();
	const selection = readChatGptSessionSelection( entries );
	const account = settings.data?.accounts.find(
		( item ) =>
			item.connectionId === selection?.connectionId && item.revision === selection.revision
	);
	const models = useChatGptModels(
		account,
		provider === 'chatgpt-oauth' && !! settings.data?.enabled
	);
	if ( provider !== 'chatgpt-oauth' ) return undefined;
	const connection = resolveConnectionSelection( entries, {
		connections: settings.data?.accounts ?? [],
		settings: null,
	} );
	const reasoning = selection
		? resolveChatGptReasoning( selection.model, selection.reasoningEffort )
		: undefined;
	const capabilities = selection ? getChatGptModelCapabilities( selection.model ) : undefined;
	let problem: string | undefined;
	if ( settings.isPending ) {
		problem = __( 'Checking the ChatGPT connection…' );
	} else if ( settings.isError ) {
		problem = __( 'Couldn’t check the ChatGPT connection. Open Settings to retry.' );
	} else if ( ! settings.data?.enabled ) {
		problem = __( 'ChatGPT plan connections are not enabled in this app.' );
	} else if ( ! selection || ! connection.ok ) {
		problem = describeConnectionSelectionError(
			connection.ok ? { code: 'unsupported', providerId: 'chatgpt-oauth' } : connection.error
		);
	} else if ( ! reasoning?.ok ) {
		problem = reasoning
			? describeChatGptReasoningProblem( reasoning.problem )
			: __( 'Choose a ChatGPT model and reasoning effort.' );
	} else if ( ! models.data?.models ) {
		problem = models.error?.message ?? __( 'Checking this account’s ChatGPT models…' );
	} else if ( ! models.data.models.some( ( model ) => model.id === selection.model ) ) {
		problem = __(
			'This model isn’t listed for the selected ChatGPT account. Choose another model.'
		);
	}
	const notice: ComposerNotice | undefined = problem
		? {
				message: problem,
				action: { label: __( 'Manage ChatGPT' ), onClick: () => openSettings( 'ai' ) },
		  }
		: undefined;
	const changeSelection = ( next: ChatGptSessionSelection ) => {
		if ( ! sessionId ) return;
		const result = resolveChatGptReasoning( next.model, next.reasoningEffort );
		if ( ! result.ok ) {
			toast.error( describeChatGptReasoningProblem( result.problem ) );
			return;
		}
		void saveSessionSettingChange( {
			queryClient,
			sessionId,
			entry: createChatGptSelectionEntry( next ),
			write: () => connector.setSessionChatGptSelection( sessionId, next ),
		} ).catch( ( error: unknown ) =>
			toast.error(
				sprintf(
					/* translators: %s: why the choice could not be saved. */
					__( 'The ChatGPT model or reasoning change wasn’t saved. %s' ),
					error instanceof Error ? error.message : __( 'Try again.' )
				),
				{ id: `chat-send-${ sessionId }` }
			)
		);
	};
	return {
		selection,
		account,
		capabilities,
		notice,
		changeSelection,
		connected: connection.ok && !! settings.data?.enabled,
	};
}

export type ChatGptConversation = NonNullable< ReturnType< typeof useChatGptConversation > >;
