import { __, sprintf } from '@wordpress/i18n';
import type {
	ImageServiceAccount,
	ImageServiceRecord,
	ImageServiceState,
} from '@studio/agent/protocol/image-service';

/** The subscription plan a chat's model runs on. Each says its own sentences, translated whole. */
export type SubscriptionPlan = 'chatgpt';

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

const SETTINGS_SENTENCES: Record<
	SubscriptionPlan,
	{ signedOut: () => string; token: () => string; account: ( account: string ) => string }
> = {
	chatgpt: {
		signedOut: () =>
			__(
				'Studio makes images with its WordPress.com image service, separate from your ChatGPT plan. Log in to WordPress.com to use it; until then, chats can’t generate images.'
			),
		token: () =>
			__(
				'Studio makes images with its WordPress.com image service, with the token set for it. It’s separate from your ChatGPT plan, which isn’t used for images.'
			),
		account: ( account ) =>
			sprintf(
				/* translators: %s: the WordPress.com account. */
				__(
					'Studio makes images with its WordPress.com image service, as %s. It’s separate from your ChatGPT plan, which isn’t used for images.'
				),
				account
			),
	},
};

/**
 * What the image service is to a conversation on a subscription plan: a
 * separate WordPress.com service, the account it acts as, or what sets it up.
 */
export function describeImageService( state: ImageServiceState, plan: SubscriptionPlan ): string {
	const sentences = SETTINGS_SENTENCES[ plan ];
	if ( ! state.available ) {
		return sentences.signedOut();
	}
	return state.account
		? sentences.account( formatImageServiceAccount( state.account ) )
		: sentences.token();
}

const NOTE_SENTENCES: Record<
	SubscriptionPlan,
	{ off: () => string; token: () => string; account: ( account: string ) => string }
> = {
	chatgpt: {
		off: () =>
			__( 'Images: off. They need Studio’s WordPress.com image service, not your ChatGPT plan.' ),
		token: () =>
			__( 'Images: WordPress.com image service with its own token, not your ChatGPT plan' ),
		account: ( account ) =>
			sprintf(
				/* translators: %s: a WordPress.com account's name. */
				__( 'Images: WordPress.com image service as %s, not your ChatGPT plan' ),
				account
			),
	},
};

/** The composer's one line on the image service, for a chat on a subscription plan. */
export function describeImageServiceNote(
	state: ImageServiceState,
	plan: SubscriptionPlan
): string {
	const sentences = NOTE_SENTENCES[ plan ];
	if ( ! state.available ) {
		return sentences.off();
	}
	return state.account
		? sentences.account( state.account.displayName || state.account.email )
		: sentences.token();
}
