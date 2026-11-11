import { useQuery } from '@tanstack/react-query';
import { useConnector } from '@/data/core';
import { useAuthUser } from '@/data/queries/use-auth-user';

/**
 * Studio's image service, which acts as the WordPress.com login unless a token
 * is set for it: read again whenever that account changes.
 */
export function useImageService( enabled = true ) {
	const connector = useConnector();
	const { data: user } = useAuthUser();
	return useQuery( {
		queryKey: [ 'image-service', user?.id ?? null ],
		queryFn: () => connector.getImageServiceState(),
		enabled,
		retry: false,
		meta: { persist: false },
	} );
}
