import type { ComposerAttachment } from '@studio/agent/protocol/composer-attachments';

interface ComposerDraft {
	text: string;
	attachments: ComposerAttachment[];
}

const listeners = new Map< string, Set< ( draft: ComposerDraft ) => void > >();
const draftsBySessionId = new Map< string, ComposerDraft >();

export function getComposerDraft( sessionId: string | undefined ): ComposerDraft {
	return (
		( sessionId ? draftsBySessionId.get( sessionId ) : undefined ) ?? {
			text: '',
			attachments: [],
		}
	);
}

export function saveComposerDraft( sessionId: string | undefined, draft: ComposerDraft ): void {
	if ( ! sessionId ) {
		return;
	}

	draftsBySessionId.delete( sessionId );
	if ( ! draft.text && draft.attachments.length === 0 ) {
		return;
	}

	draftsBySessionId.set( sessionId, draft );
}

export function clearComposerDrafts(): void {
	draftsBySessionId.clear();
}
export function publishComposerDraft( sessionId: string, draft: ComposerDraft ) {
	saveComposerDraft( sessionId, draft );
	listeners.get( sessionId )?.forEach( ( notify ) => notify( draft ) );
}

export function subscribeToComposerDraft(
	sessionId: string,
	notify: ( draft: ComposerDraft ) => void
) {
	const group = listeners.get( sessionId ) ?? new Set();
	group.add( notify );
	listeners.set( sessionId, group );
	return () => {
		group.delete( notify );
		if ( ! group.size ) listeners.delete( sessionId );
	};
}
