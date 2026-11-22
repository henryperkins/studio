import { __ } from '@wordpress/i18n';
import { useLogin } from '@/data/queries/use-auth-user';
import { useImageService } from '@/data/queries/use-image-service';
import { describeImageService, type SubscriptionPlan } from '@/features/image-service';
import { useOffline } from '@/lib/hooks';
import { Badge, Button } from '@/lib/ui';
import { SettingsRow } from './rows';

/**
 * Image generation in a subscription plan's settings: Studio's separate
 * WordPress.com image service, the account it acts as, or a login to set it up.
 */
export function ImageServiceSettingsRow( { plan }: { plan: SubscriptionPlan } ) {
	const imageService = useImageService();
	const isOffline = useOffline();
	const { promptRef, ...login } = useLogin( {
		source: 'settings',
		analytics: { placement: 'settings_ai', intent: 'build' },
	} );
	const state = imageService.data;

	return (
		<SettingsRow
			title={ __( 'Image generation' ) }
			badge={
				state?.available ? (
					<Badge size="xs" variant="muted">
						{ __( 'WordPress.com' ) }
					</Badge>
				) : null
			}
			description={
				imageService.isError
					? __( 'Couldn’t check image generation.' )
					: state
					? describeImageService( state, plan )
					: __( 'Checking image generation…' )
			}
			error={ login.error?.message }
		>
			{ imageService.isError ? (
				<Button variant="outline" onClick={ () => void imageService.refetch() }>
					{ __( 'Retry' ) }
				</Button>
			) : state && ! state.available ? (
				<Button
					variant="outline"
					ref={ promptRef }
					disabled={ isOffline || login.isPending }
					loading={ login.isPending }
					loadingAnnouncement={ __( 'Logging in' ) }
					onClick={ () => login.mutate() }
				>
					{ __( 'Log in to WordPress.com' ) }
				</Button>
			) : null }
		</SettingsRow>
	);
}
