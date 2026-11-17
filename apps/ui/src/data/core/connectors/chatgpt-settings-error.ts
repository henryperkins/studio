/**
 * A ChatGPT settings read or recheck that the host refused with the shared
 * module's own message (its `ChatGptSettingsError`), which is sanitized and
 * translated, so the UI may show it. Every other failure, such as the
 * `studio ui` server not answering, reaches the UI as a plain error whose
 * message it doesn't show.
 */
export class ChatGptSettingsError extends Error {
	constructor( message: string ) {
		super( message );
		this.name = 'ChatGptSettingsError';
	}
}
