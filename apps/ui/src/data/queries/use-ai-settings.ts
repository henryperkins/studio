import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useConnector } from '@/data/core';
import type {
	AiProviderId,
	AiSettings,
	OpenAiDefaultsUpdate,
	OpenAiKeyStorage,
} from '@studio/agent/protocol/providers';

const AI_SETTINGS_QUERY_KEY = [ 'ai-settings' ] as const;

export function useAiSettings() {
	const connector = useConnector();
	return useQuery( {
		queryKey: AI_SETTINGS_QUERY_KEY,
		queryFn: () => connector.getAiSettings(),
		staleTime: Infinity,
	} );
}

export function useSetAiProvider() {
	const connector = useConnector();
	const queryClient = useQueryClient();
	return useMutation( {
		mutationFn: ( provider: AiProviderId ) => connector.setAiProvider( provider ),
		onSuccess: ( settings ) => {
			queryClient.setQueryData< AiSettings >( AI_SETTINGS_QUERY_KEY, settings );
		},
	} );
}

export function useSaveAnthropicApiKey() {
	const connector = useConnector();
	const queryClient = useQueryClient();
	return useMutation( {
		mutationFn: ( key: string | null ) => connector.saveAnthropicApiKey( key ),
		onSuccess: ( settings ) => {
			queryClient.setQueryData< AiSettings >( AI_SETTINGS_QUERY_KEY, settings );
		},
	} );
}

// The key only travels in the request; the settings that come back carry its
// storage and last four characters.
export function useSaveOpenAiApiKey() {
	const connector = useConnector();
	const queryClient = useQueryClient();
	return useMutation( {
		mutationFn: ( { key, storage }: { key: string; storage: OpenAiKeyStorage } ) =>
			connector.saveOpenAiApiKey( key, storage ),
		onSuccess: ( settings ) => {
			queryClient.setQueryData< AiSettings >( AI_SETTINGS_QUERY_KEY, settings );
		},
		// A keychain that just failed may now read as unavailable.
		onError: () => {
			void queryClient.invalidateQueries( { queryKey: AI_SETTINGS_QUERY_KEY } );
		},
	} );
}

export function useRemoveOpenAiApiKey() {
	const connector = useConnector();
	const queryClient = useQueryClient();
	return useMutation( {
		mutationFn: () => connector.removeOpenAiApiKey(),
		onSuccess: ( settings ) => {
			queryClient.setQueryData< AiSettings >( AI_SETTINGS_QUERY_KEY, settings );
		},
		// A removal can fail after the session key is already gone.
		onError: () => {
			void queryClient.invalidateQueries( { queryKey: AI_SETTINGS_QUERY_KEY } );
		},
	} );
}

export function useRefreshOpenAiModels() {
	const connector = useConnector();
	const queryClient = useQueryClient();
	return useMutation( {
		mutationFn: () => connector.refreshOpenAiModels(),
		onSuccess: ( settings ) => {
			queryClient.setQueryData< AiSettings >( AI_SETTINGS_QUERY_KEY, settings );
		},
	} );
}

export function useSetOpenAiDefaults() {
	const connector = useConnector();
	const queryClient = useQueryClient();
	return useMutation( {
		mutationFn: ( update: OpenAiDefaultsUpdate ) => connector.setOpenAiDefaults( update ),
		onSuccess: ( settings ) => {
			queryClient.setQueryData< AiSettings >( AI_SETTINGS_QUERY_KEY, settings );
		},
	} );
}
