import { __, sprintf } from '@wordpress/i18n';
import type {
	ImageServiceAccount,
	ImageServiceRecord,
	ImageServiceState,
} from '@studio/agent/protocol/image-service';

/** The account as Studio's account menu names it. */
function formatImageServiceAccount( { displayName, email }: ImageServiceAccount ): string {
	return displayName
		? sprintf(
				/* translators: 1: a WordPress.com account's display name, 2: its email address. */
				__( '%1$s (%2$s)' ),
				displayName,
				email
		  )
		: email;
}

/** Which service made a tool result's images: never the account it acted as. */
export function describeImageServiceUse( _record: ImageServiceRecord ): string {
	return __( 'Made with Studio’s WordPress.com image service.' );
}

/**
 * What the image service is to a conversation on a subscription plan: a
 * separate WordPress.com service, the account it acts as, or what sets it up.
 */
export function describeImageService( state: ImageServiceState, subscription: string ): string {
	if ( ! state.available ) {
		return sprintf(
			/* translators: %s: the plan the chat's model runs on, e.g. "ChatGPT plan". */
			__(
				'Studio makes images with its WordPress.com image service, separate from your %s. Log in to WordPress.com to use it; until then, chats can’t generate images.'
			),
			subscription
		);
	}
	if ( ! state.account ) {
		return sprintf(
			/* translators: %s: the plan the chat's model runs on, e.g. "ChatGPT plan". */
			__(
				'Studio makes images with its WordPress.com image service, with the token set for it. It’s separate from your %s, which isn’t used for images.'
			),
			subscription
		);
	}
	return sprintf(
		/* translators: 1: the WordPress.com account, 2: the plan the chat's model runs on, e.g. "ChatGPT plan". */
		__(
			'Studio makes images with its WordPress.com image service, as %1$s. It’s separate from your %2$s, which isn’t used for images.'
		),
		formatImageServiceAccount( state.account ),
		subscription
	);
}
