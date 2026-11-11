import { __, sprintf } from '@wordpress/i18n';
import { clsx } from 'clsx';
import { Button } from '@/lib/ui';
import styles from './style.module.css';
import type { ImageServiceState } from '@studio/agent/protocol/image-service';

/**
 * One quiet line for a chat on a subscription plan: images come from Studio's
 * WordPress.com image service, not the plan, and from which account; or, when
 * the service isn't set up, that images are off and where to set it up.
 */
export function ImageServiceNote( {
	state,
	subscription,
	onSetUp,
	className,
}: {
	state: ImageServiceState;
	// The plan the chat's model runs on, e.g. "ChatGPT plan".
	subscription: string;
	onSetUp: () => void;
	className?: string;
} ) {
	if ( ! state.available ) {
		return (
			<div className={ clsx( styles.note, className ) }>
				{ sprintf(
					/* translators: %s: the plan the chat's model runs on, e.g. "ChatGPT plan". */
					__( 'Images: off. They need Studio’s WordPress.com image service, not your %s.' ),
					subscription
				) }{ ' ' }
				<Button
					variant="inline-link"
					size="inline"
					aria-label={ __( 'Set up image generation' ) }
					onClick={ onSetUp }
				>
					{ __( 'Set up' ) }
				</Button>
			</div>
		);
	}
	return (
		<div className={ clsx( styles.note, className ) }>
			{ state.account
				? sprintf(
						/* translators: 1: a WordPress.com account's name, 2: the plan the chat's model runs on, e.g. "ChatGPT plan". */
						__( 'Images: WordPress.com image service as %1$s, not your %2$s' ),
						state.account.displayName || state.account.email,
						subscription
				  )
				: sprintf(
						/* translators: %s: the plan the chat's model runs on, e.g. "ChatGPT plan". */
						__( 'Images: WordPress.com image service with its own token, not your %s' ),
						subscription
				  ) }
		</div>
	);
}
