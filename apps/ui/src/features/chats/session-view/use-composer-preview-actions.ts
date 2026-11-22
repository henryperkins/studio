import { useEffect, type RefObject } from 'react';
import { toast } from '@/data/app-messages';
import {
	getSiteAnnotations,
	hasAnnotationContent,
	removeAnnotations,
	stageAnnotations,
	subscribeAnnotationSend,
	annotationSubmission,
} from '@/features/annotations';
import {
	formatComposerTextQuote,
	watchComposerTextQuote,
} from '@/features/chats/composer-text-quote';
import type { SendMessageOptions } from '@/data/agent-runs/store';
import type { ComposerHandle } from '@/features/composer';

export function useComposerPreviewActions(
	composerRef: RefObject< ComposerHandle | null >,
	annotationSiteId: string | undefined,
	composerBusy: boolean,
	isChatReady: boolean,
	sendMessage: ( prompt: string, options?: SendMessageOptions ) => Promise< void >,
	keepAnnotationDraft = false
) {
	useEffect(
		() =>
			watchComposerTextQuote( ( text ) => {
				composerRef.current?.appendDraft( formatComposerTextQuote( text ) );
			} ),
		[ composerRef ]
	);
	// Notes sent from the preview land in the composer, then go out with its
	// draft, or alone when they were sent directly. Direct sends join the queue
	// while the agent works.
	useEffect( () => {
		if ( ! isChatReady || ! annotationSiteId ) return;
		return subscribeAnnotationSend( annotationSiteId, ( { noteIds } ) => {
			if ( ! noteIds ) stageAnnotations( annotationSiteId );
			if ( composerBusy && ! noteIds ) return;
			if ( ! noteIds ) {
				return composerRef.current?.send();
			}
			const notes = getSiteAnnotations( annotationSiteId ).notes.filter(
				( note ) => noteIds.includes( note.id ) && hasAnnotationContent( note )
			);
			try {
				const { prompt, options } = annotationSubmission( '', [], notes );
				return sendMessage(
					prompt,
					keepAnnotationDraft ? { ...options, annotationDraft: { text: '', notes } } : options
				)
					.then( () => removeAnnotations( annotationSiteId, noteIds ) )
					.catch( () => undefined );
			} catch ( error ) {
				toast.error( ( error as Error ).message );
			}
		} );
	}, [
		annotationSiteId,
		composerBusy,
		composerRef,
		isChatReady,
		keepAnnotationDraft,
		sendMessage,
	] );
}
