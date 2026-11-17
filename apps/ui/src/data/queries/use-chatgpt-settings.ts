import {
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
	type QueryClient,
} from '@tanstack/react-query';
import { __, sprintf } from '@wordpress/i18n';
import { useCallback, useEffect, useState } from 'react';
import { ChatGptSettingsError, useConnector, type Connector } from '@/data/core';
import { useOpenSettings } from '@/data/use-open-settings';
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

// The saved account the ChatGPT settings open on, when a chat opens them for its own.
const accountsToOpen = new WeakMap< Connector, string >();

/**
 * Opens the AI settings on a chat's own ChatGPT account, revealing the setting
 * titled `focus` when given, rather than on whichever account is listed first.
 */
export function useOpenChatGptAccount() {
	const connector = useConnector();
	const openSettings = useOpenSettings();
	return useCallback(
		( connectionId: string, focus?: string ) => {
			accountsToOpen.set( connector, connectionId );
			openSettings( 'ai', undefined, focus );
		},
		[ connector, openSettings ]
	);
}

/** The account the ChatGPT settings were opened on, if a chat opened them; read once. */
export function useChatGptAccountToOpen(): string | undefined {
	const connector = useConnector();
	const [ connectionId ] = useState( () => accountsToOpen.get( connector ) );
	useEffect( () => {
		accountsToOpen.delete( connector );
	}, [ connector ] );
	return connectionId;
}

/**
 * A saved ChatGPT account as the UI names it: by its label, which is its email
 * unless the sign-in gave another, and by the start of its id as well only when
 * another saved account has the same label.
 */
export function nameChatGptAccount(
	account: ChatGptAccountView,
	accounts: ChatGptAccountView[]
): string {
	return accounts.some(
		( other ) => other.connectionId !== account.connectionId && other.label === account.label
	)
		? sprintf(
				/* translators: 1: a ChatGPT account's name, 2: the start of its id, telling it apart from another account of the same name. */
				__( '%1$s · %2$s' ),
				account.label,
				account.connectionId.slice( 0, 8 )
		  )
		: account.label;
}

/**
 * Why the last read of the ChatGPT accounts failed, as Settings and the composer
 * say it: in the host's own words when it gave them, which are translated and
 * name nothing private; never a transport line, such as the `studio ui` server
 * not answering.
 */
export function describeChatGptSettingsError( error: Error | null ): string {
	return sprintf(
		/* translators: %s: why the accounts couldn't be read, ending in a full stop. */
		__( 'Couldn’t check your ChatGPT accounts. %s' ),
		( error instanceof ChatGptSettingsError && error.message ) || __( 'Try again.' )
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

/** A saved account's model list, as its chats, the model picker and Settings read it. */
export function chatGptModelsQuery(
	connector: Connector,
	account: ChatGptAccountView | undefined,
	enabled = true
) {
	return queryOptions( {
		queryKey: [ ...CHATGPT_MODELS_QUERY_KEY, account?.connectionId, account?.revision ],
		queryFn: () => connector.getChatGptModels( account!.connectionId, account!.revision ),
		enabled: enabled && account?.authStatus === 'connected',
		staleTime: 60_000,
		retry: false,
		meta: { persist: false },
	} );
}

export function useChatGptModels( account: ChatGptAccountView | undefined, enabled = true ) {
	const connector = useConnector();
	return useQuery( chatGptModelsQuery( connector, account, enabled ) );
}

/**
 * Reads the accounts again after a sign-in or sign-out. The model list of the
 * account it changed goes, so a read from before can't restore it; the other
 * accounts' lists, which their open chats wait on, stay.
 */
export async function refreshChatGptSettings(
	queryClient: QueryClient,
	connectionId?: string
): Promise< void > {
	const models = connectionId
		? { queryKey: [ ...CHATGPT_MODELS_QUERY_KEY, connectionId ] }
		: undefined;
	await Promise.all( [
		queryClient.cancelQueries( { queryKey: CHATGPT_SETTINGS_QUERY_KEY } ),
		models ? queryClient.cancelQueries( models ) : undefined,
	] );
	if ( models ) {
		queryClient.removeQueries( models );
	}
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
