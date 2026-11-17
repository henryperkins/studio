import { __ } from '@wordpress/i18n';
import { clsx } from 'clsx';
import { Button } from '@/lib/ui';
import { describeImageServiceNote, type SubscriptionPlan } from '../describe-image-service';
import styles from './style.module.css';
import type { ImageServiceState } from '@studio/agent/protocol/image-service';

/**
 * One quiet line for a chat on a subscription plan: images come from Studio's
 * WordPress.com image service, not the plan, and from which account; or, when
 * the service isn't set up, that images are off and where to set it up.
 */
export function ImageServiceNote( {
	state,
	plan,
	onSetUp,
	className,
}: {
	state: ImageServiceState;
	// The plan the chat's model runs on.
	plan: SubscriptionPlan;
	onSetUp: () => void;
	className?: string;
} ) {
	if ( ! state.available ) {
		return (
			<div className={ clsx( styles.note, className ) }>
				{ describeImageServiceNote( state, plan ) }{ ' ' }
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
			{ describeImageServiceNote( state, plan ) }
		</div>
	);
}
