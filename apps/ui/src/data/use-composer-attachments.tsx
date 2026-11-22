import { STUDIO_CHAT_MAX_FILES } from '@studio/agent/protocol/chat-files';
import { STUDIO_CHAT_MAX_IMAGES } from '@studio/agent/protocol/chat-images';
import {
	getComposerClipboardFiles,
	mergeComposerAttachments,
	prepareComposerAttachments,
	toComposerSendAttachments,
	type ComposerAttachment,
	type ComposerSendAttachments,
} from '@studio/agent/protocol/composer-attachments';
import { __, sprintf } from '@wordpress/i18n';
import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AgentRunContext } from '@/data/agent-runs/context';
import { getComposerDraft, publishComposerDraft } from '@/data/composer-drafts';
import { useConnector } from '@/data/core';

export { toComposerSendAttachments };
export type { ComposerAttachment, ComposerSendAttachments };

interface UploadStatus {
	pending: number;
	error: string | null;
}
const idle: UploadStatus = { pending: 0, error: null };
const uploads = new Map< string, UploadStatus >();
const uploadListeners = new Set< () => void >();
function subscribeUpload( notify: () => void ) {
	uploadListeners.add( notify );
	return () => {
		uploadListeners.delete( notify );
	};
}
function updateUpload( sessionId: string, change: ( current: UploadStatus ) => UploadStatus ) {
	const next = change( uploads.get( sessionId ) ?? idle );
	if ( next.pending || next.error ) uploads.set( sessionId, next );
	else uploads.delete( sessionId );
	uploadListeners.forEach( ( notify ) => notify() );
}

export function useComposerAttachments(
	initialAttachments: ComposerAttachment[] = [],
	claudeSessionId?: string
) {
	const connector = useConnector();
	const discardClaudeFiles = useContext( AgentRunContext )?.discardClaudeFiles;
	const status = useSyncExternalStore( subscribeUpload, () =>
		claudeSessionId ? uploads.get( claudeSessionId ) ?? idle : idle
	);
	const [ error, setError ] = useState< string | null >( null );
	const [ attachments, setAttachments ] = useState< ComposerAttachment[] >( initialAttachments );
	const attachmentsRef = useRef< ComposerAttachment[] >( initialAttachments );

	const setTrackedAttachments = useCallback( ( next: ComposerAttachment[] ) => {
		attachmentsRef.current = next;
		setAttachments( next );
	}, [] );

	const removeAttachment = useCallback(
		( id: string ) => {
			setError( null );
			const current = attachmentsRef.current;
			const next = current.filter( ( item ) => item.id !== id );
			setTrackedAttachments( next );
			if ( claudeSessionId ) {
				publishComposerDraft( claudeSessionId, {
					...getComposerDraft( claudeSessionId ),
					attachments: next,
				} );
				const removed = current.find( ( item ) => item.id === id );
				if ( removed?.kind === 'file' ) discardClaudeFiles?.( claudeSessionId, [ removed.path ] );
			}
		},
		[ claudeSessionId, discardClaudeFiles, setTrackedAttachments ]
	);

	const restore = useCallback(
		(
			items: ComposerAttachment[] | ( ( current: ComposerAttachment[] ) => ComposerAttachment[] )
		) => {
			setError( null );
			setTrackedAttachments(
				typeof items === 'function' ? items( attachmentsRef.current ) : items
			);
		},
		[ setTrackedAttachments ]
	);

	// `reserved` attachments travel in the same message from elsewhere, so they
	// count against the limits without joining this list.
	const addFiles = useCallback(
		async ( incoming: FileList | File[], reserved: ComposerAttachment[] = [] ) => {
			const list = Array.from( incoming );
			if ( list.length === 0 ) {
				return;
			}
			const messages = {
				imageTooLarge: __( 'Images must be 5 MB or smaller' ),
				imageReadFailed: __( 'Failed to read the attached image' ),
				fileAttachFailed: __( 'This file could not be attached' ),
				maxImages: sprintf(
					/* translators: %d: maximum number of images. */
					__( 'You can attach up to %d images' ),
					STUDIO_CHAT_MAX_IMAGES
				),
				totalImagesTooLarge: __( 'Attached images are too large to send together' ),
				maxFiles: sprintf(
					/* translators: %d: maximum number of files. */
					__( 'You can attach up to %d files' ),
					STUDIO_CHAT_MAX_FILES
				),
			};

			if ( claudeSessionId )
				updateUpload( claudeSessionId, ( current ) => ( {
					pending: current.pending + 1,
					error: current.pending ? current.error : null,
				} ) );
			let failure: string | null = null;
			const staged: string[] = [];
			const existing = () =>
				claudeSessionId ? getComposerDraft( claudeSessionId ).attachments : attachmentsRef.current;
			try {
				const prepared = await prepareComposerAttachments( list, {
					resolveFilePath: async ( file ) => {
						if ( ! claudeSessionId ) return connector.getFilePath( file );
						const path = await connector.stageClaudeChatFile( claudeSessionId, file );
						staged.push( path );
						return path;
					},
					messages,
					existingAttachments: [ ...reserved, ...existing() ],
				} );
				failure = prepared.error ?? null;
				if ( ! prepared.attachments.length ) return;
				const merged = mergeComposerAttachments(
					[ ...reserved, ...existing() ],
					prepared.attachments,
					messages
				);
				failure = merged.error ?? failure;
				const attachments = merged.attachments.slice( reserved.length );
				if ( claudeSessionId ) {
					publishComposerDraft( claudeSessionId, {
						...getComposerDraft( claudeSessionId ),
						attachments,
					} );
				} else {
					setTrackedAttachments( attachments );
				}
			} catch {
				failure = messages.fileAttachFailed;
			} finally {
				if ( claudeSessionId && staged.length ) discardClaudeFiles?.( claudeSessionId, staged );
				if ( claudeSessionId )
					updateUpload( claudeSessionId, ( current ) => ( {
						pending: current.pending - 1,
						error: failure ?? current.error,
					} ) );
				else setError( failure );
			}
		},
		[ connector, claudeSessionId, discardClaudeFiles, setTrackedAttachments ]
	);

	const onPaste = useCallback(
		( event: React.ClipboardEvent ) => {
			const files = getComposerClipboardFiles( event.clipboardData );
			if ( files.length === 0 ) {
				return;
			}
			event.preventDefault();
			void addFiles( files );
		},
		[ addFiles ]
	);

	return {
		error: claudeSessionId ? status.error : error,
		preparing: status.pending > 0,
		clearError: () =>
			claudeSessionId
				? updateUpload( claudeSessionId, ( current ) => ( { ...current, error: null } ) )
				: setError( null ),
		setError,
		attachments,
		addFiles,
		removeAttachment,
		restore,
		pasteHandlers: { onPaste },
	};
}

// Files dragged anywhere over `target`. The depth count keeps the state steady
// while the pointer crosses child elements; a drop or cancel anywhere resets it.
export function useFileDrop(
	target: HTMLElement | null,
	onFiles: ( files: FileList, transfer: DataTransfer ) => void
) {
	const [ isDragging, setIsDragging ] = useState( false );

	useEffect( () => {
		if ( ! target ) {
			return;
		}
		let depth = 0;
		const reset = () => {
			depth = 0;
			setIsDragging( false );
		};
		const onWindowKeyDown = ( event: KeyboardEvent ) => {
			if ( event.key === 'Escape' ) {
				reset();
			}
		};
		const hasFiles = ( event: DragEvent ) =>
			Array.from( event.dataTransfer?.types ?? [] ).includes( 'Files' );
		const onDragEnter = ( event: DragEvent ) => {
			if ( hasFiles( event ) ) {
				event.stopPropagation();
				depth += 1;
				setIsDragging( true );
			}
		};
		const onDragOver = ( event: DragEvent ) => {
			if ( hasFiles( event ) ) {
				event.stopPropagation();
				event.preventDefault();
			}
		};
		const onDragLeave = ( event: DragEvent ) => {
			if ( hasFiles( event ) ) {
				event.stopPropagation();
				depth = Math.max( 0, depth - 1 );
				setIsDragging( depth > 0 );
			}
		};
		const onDrop = ( event: DragEvent ) => {
			if ( ! hasFiles( event ) ) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			reset();
			if ( event.dataTransfer?.files.length ) {
				onFiles( event.dataTransfer.files, event.dataTransfer );
			}
		};
		const listeners = {
			dragenter: onDragEnter,
			dragover: onDragOver,
			dragleave: onDragLeave,
			drop: onDrop,
		};
		const windowListeners = { drop: reset, dragend: reset, blur: reset, keydown: onWindowKeyDown };
		for ( const [ type, listener ] of Object.entries( listeners ) ) {
			target.addEventListener( type, listener as EventListener );
		}
		for ( const [ type, listener ] of Object.entries( windowListeners ) ) {
			window.addEventListener( type, listener as EventListener );
		}
		return () => {
			for ( const [ type, listener ] of Object.entries( listeners ) ) {
				target.removeEventListener( type, listener as EventListener );
			}
			for ( const [ type, listener ] of Object.entries( windowListeners ) ) {
				window.removeEventListener( type, listener as EventListener );
			}
		};
	}, [ target, onFiles ] );

	return isDragging;
}
