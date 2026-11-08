import { __, sprintf } from '@wordpress/i18n';
import type { Connector } from '@/data/core';
import type { OpenAiSessionSelection } from '@studio/agent/protocol/providers';

/**
 * A chat's OpenAI model and reasoning changes, saved one at a time in the
 * order they were made, so an older choice can't land after a newer one.
 * A message sent while one is saving waits for it, so its turn runs with the
 * choice the composer showed, and isn't sent when that save fails.
 */
const latestSaves = new Map< string, Promise< void > >();

export function saveSessionOpenAiSelection(
	connector: Pick< Connector, 'setSessionOpenAiSelection' >,
	sessionId: string,
	selection: OpenAiSessionSelection
): Promise< void > {
	const previous = latestSaves.get( sessionId ) ?? Promise.resolve();
	const save = previous
		.catch( () => undefined )
		.then( () => connector.setSessionOpenAiSelection( sessionId, selection ) );
	latestSaves.set( sessionId, save );
	// Once settled, a failure has been undone and shown where the change was
	// made; it doesn't hold up messages sent after that.
	const forget = () => {
		if ( latestSaves.get( sessionId ) === save ) {
			latestSaves.delete( sessionId );
		}
	};
	save.then( forget, forget );
	return save;
}

/**
 * Settles when the changes still saving at the time of the call are saved,
 * and rejects when the latest of them fails. Call it when the message is sent.
 */
export function waitForSessionOpenAiSelection( sessionId: string ): Promise< void > {
	const save = latestSaves.get( sessionId );
	if ( ! save ) {
		return Promise.resolve();
	}
	return save.catch( ( error: unknown ) => {
		throw new Error(
			sprintf(
				/* translators: %s: why saving the change failed. */
				__( 'The reasoning change wasn’t saved, so the message wasn’t sent. %s' ),
				error instanceof Error ? error.message : String( error )
			)
		);
	} );
}

export function resetOpenAiSelectionSavesForTests(): void {
	latestSaves.clear();
}
