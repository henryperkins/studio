import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { __, sprintf } from '@wordpress/i18n';
import { useConnector, type Connector } from '@/data/core';
import type { ChatGptAccountView, ChatGptSettings } from '@studio/agent/protocol/chatgpt';

export const CHATGPT_SETTINGS_QUERY_KEY = [ 'chatgpt-settings' ] as const;
export const CHATGPT_MODELS_QUERY_KEY = [ 'chatgpt-models' ] as const;

export function useChatGptSettings() {
	const connector = useConnector();
	return useQuery( {
		queryKey: CHATGPT_SETTINGS_QUERY_KEY,
		queryFn: () => connector.getChatGptSettings(),
		refetchInterval: ( query ) => ( query.state.data?.enabled ? 5_000 : false ),
		retry: false,
		meta: { persist: false },
	} );
}

/** Why the last read of the ChatGPT accounts failed, as Settings and the composer say it. */
export function describeChatGptSettingsError( error: Error | null ): string {
	return sprintf(
		/* translators: %s: why the accounts couldn't be read, ending in a full stop. */
		__( 'Couldn’t check your ChatGPT accounts. %s' ),
		error?.message || __( 'Try again.' )
	);
}

/**
 * Has the host check the system keychain again, which a polled read never
 * does, and shows what it found. When that fails, a read says why.
 */
async function recheckChatGptSettings(
	queryClient: QueryClient,
	connector: Connector
): Promise< void > {
	await queryClient.cancelQueries( { queryKey: CHATGPT_SETTINGS_QUERY_KEY } );
	try {
		queryClient.setQueryData< ChatGptSettings >(
			CHATGPT_SETTINGS_QUERY_KEY,
			await connector.recheckChatGptSettings()
		);
	} catch {
		await queryClient.refetchQueries( { queryKey: CHATGPT_SETTINGS_QUERY_KEY } );
	}
}

/** For a user's action only: opening the ChatGPT settings, or asking to retry. */
export function useRecheckChatGptSettings() {
	const connector = useConnector();
	const queryClient = useQueryClient();
	return useMutation( { mutationFn: () => recheckChatGptSettings( queryClient, connector ) } );
}

export function useChatGptModels( account: ChatGptAccountView | undefined, enabled = true ) {
	const connector = useConnector();
	return useQuery( {
		queryKey: [ ...CHATGPT_MODELS_QUERY_KEY, account?.connectionId, account?.revision ],
		queryFn: () => connector.getChatGptModels( account!.connectionId, account!.revision ),
		enabled: enabled && account?.authStatus === 'connected',
		staleTime: 60_000,
		retry: false,
		meta: { persist: false },
	} );
}

/** A pre-action read must not restore a connection or catalog after sign-out. */
export async function refreshChatGptSettings( queryClient: QueryClient ): Promise< void > {
	await Promise.all( [
		queryClient.cancelQueries( { queryKey: CHATGPT_SETTINGS_QUERY_KEY } ),
		queryClient.cancelQueries( { queryKey: CHATGPT_MODELS_QUERY_KEY } ),
	] );
	queryClient.removeQueries( { queryKey: CHATGPT_MODELS_QUERY_KEY } );
	await queryClient.invalidateQueries( { queryKey: CHATGPT_SETTINGS_QUERY_KEY } );
}

export async function holdChatGptConnection(
	queryClient: QueryClient,
	connectionId: string
): Promise< void > {
	await queryClient.cancelQueries( { queryKey: CHATGPT_SETTINGS_QUERY_KEY } );
	queryClient.setQueryData< ChatGptSettings >( CHATGPT_SETTINGS_QUERY_KEY, ( current ) =>
		current
			? {
					...current,
					accounts: current.accounts.map( ( account ) =>
						account.connectionId === connectionId
							? { ...account, authStatus: 'disconnected' }
							: account
					),
			  }
			: current
	);
}
