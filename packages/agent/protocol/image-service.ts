/**
 * Studio's image service: generate_images makes images through WordPress.com's
 * AI proxy, signed in on its own, whichever provider the conversation's model
 * runs on. A ChatGPT or Claude plan neither pays for it nor signs Studio in to
 * it, and its credential is never used for the model.
 */

/** How Studio signs in to the image service. */
export type ImageServiceCredential = 'wordpress-com-login' | 'environment-token';

/** The WordPress.com account as Studio shows its sign-in: no token, no user ID. */
export interface ImageServiceAccount {
	displayName: string;
	email: string;
}

/** What the image service acts as. */
export interface ImageServiceUse {
	service: 'wordpress-com';
	credential: ImageServiceCredential;
	// Null for a token set in STUDIO_IMAGE_API_TOKEN: Studio doesn't know whose it is.
	account: ImageServiceAccount | null;
}

export type ImageServiceState =
	| ( ImageServiceUse & { available: true } )
	| {
			available: false;
			service: 'wordpress-com';
			// Studio has neither a WordPress.com login nor an image service token.
			reason: 'signed-out';
			// What sets it up: logging in to WordPress.com in Studio.
			setup: 'wordpress-com-login';
	  };

const isRecord = ( value: unknown ): value is Record< string, unknown > =>
	Boolean( value ) && typeof value === 'object' && ! Array.isArray( value );

function isImageServiceUse( value: unknown ): value is ImageServiceUse {
	if ( ! isRecord( value ) || value.service !== 'wordpress-com' ) {
		return false;
	}
	if ( value.credential === 'environment-token' ) {
		return value.account === null;
	}
	return (
		value.credential === 'wordpress-com-login' &&
		isRecord( value.account ) &&
		typeof value.account.displayName === 'string' &&
		typeof value.account.email === 'string'
	);
}

/**
 * The image service a tool's result says made it, from the result's details:
 * kept with the result for display, never sent to the model.
 */
export function getToolResultImageService( details: unknown ): ImageServiceUse | undefined {
	const service = isRecord( details ) ? details.studioService : undefined;
	return isImageServiceUse( service )
		? {
				service: service.service,
				credential: service.credential,
				account: service.account
					? { displayName: service.account.displayName, email: service.account.email }
					: null,
		  }
		: undefined;
}
