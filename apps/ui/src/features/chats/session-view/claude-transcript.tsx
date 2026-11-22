import {
	DESIGN_SYSTEM_PREVIEW_PATH,
	getLocalMediaPath,
	isRenderableMediaWidget,
	isStudioChatArtifactData,
} from '@studio/agent/protocol/chat-artifacts';
import { getClaudeUncertainOperationDescription } from '@studio/agent/protocol/claude-code';
import { __, sprintf } from '@wordpress/i18n';
import { claudeDisplayEventKey } from '@/data/agent-runs/claude-journal-read';
import { ToolLink } from '@/features/chats/tool-link';
import { AppearanceIcon } from '@/lib/icons';
import { claudeMediaPath } from './claude-media-path';
import { claudeSitePreviewPaths } from './claude-preview-path';
import { ChatArtifact } from './conversation';
import { UserTurn, AssistantText } from './conversation/message';
import { ToolUseRow } from './conversation/trace';
import type { BackendTurnEvent, ClaudeJournalEvent } from '@studio/agent/protocol/backend-events';

const callKey = ( event: { runId: string; turnId: string; toolCallId: string } ) =>
	JSON.stringify( [ event.runId, event.turnId, event.toolCallId ] );

export function projectClaudeTranscript( events: ClaudeJournalEvent[] ) {
	const results = new Map< string, Extract< BackendTurnEvent, { type: 'tool.result' } > >();
	const starts = new Set< string >();
	const rows: ClaudeJournalEvent[] = [];
	const seen = new Map< string, number >();
	for ( const event of events ) {
		const key = claudeDisplayEventKey( event );
		if ( ! key ) continue;
		if ( event.type === 'tool.result' ) results.set( callKey( event ), event );
		if ( event.type === 'native.call' || event.type === 'tool.started' )
			starts.add( callKey( event ) );
		const index = seen.get( key );
		if ( index === undefined ) {
			seen.set( key, rows.length );
			rows.push( event );
		} else {
			const prior = rows[ index ];
			if (
				prior.type === 'native.call' &&
				prior.state !== 'started' &&
				event.type === 'native.call' &&
				event.state === 'started'
			)
				continue;
			if (
				prior.type === 'content.confirmed' ||
				( prior.type === 'content.provisional' &&
					event.type === 'content.provisional' &&
					prior.sequence >= event.sequence ) ||
				( prior.type === 'task.status' &&
					prior.status !== 'running' &&
					event.type === 'task.status' &&
					event.status === 'running' )
			)
				continue;
			rows[ index ] = event;
		}
	}
	const textGroups = new Map<
		string,
		Extract< ClaudeJournalEvent, { type: 'content.confirmed' | 'content.provisional' } >[]
	>();
	for ( const row of rows ) {
		if (
			( row.type !== 'content.confirmed' && row.type !== 'content.provisional' ) ||
			row.blockType !== 'text' ||
			! row.text.trim()
		)
			continue;
		const key = JSON.stringify( [ row.runId, row.turnId, row.messageId ] );
		const group = textGroups.get( key );
		if ( group ) group.push( row );
		else textGroups.set( key, [ row ] );
	}
	const replies = new Map< ClaudeJournalEvent, { text: string; copy?: string } >();
	for ( const group of textGroups.values() ) {
		const text = group.map( ( block ) => block.text.trim() ).join( '\n\n' );
		for ( const block of group )
			replies.set( block, {
				text,
				copy: block === group.at( -1 ) && block.type === 'content.confirmed' ? text : undefined,
			} );
	}
	return {
		replies,
		rows: rows.filter( ( e ) => e.type !== 'tool.result' || ! starts.has( callKey( e ) ) ),
		results,
	};
}

function toolResultLabel( result: { message?: string; skillName?: string; isError: boolean } ) {
	if ( result.message ) return result.message;
	if ( result.isError ) return __( 'Tool failed.' );
	if ( result.skillName )
		return sprintf(
			/* translators: %s: name of the Studio skill loaded for the turn. */
			__( 'Loaded skill: %s' ),
			result.skillName
		);
	return __( 'Completed' );
}

export function ClaudeTranscriptEvent( {
	event,
	reply,
	results,
	running,
	sessionId,
	sessionFile,
	sitePreview,
}: {
	event: ClaudeJournalEvent;
	reply?: { text: string; copy?: string };
	results: ReturnType< typeof projectClaudeTranscript >[ 'results' ];
	running: boolean;
	sessionId: string;
	sessionFile: string;
	sitePreview: string | null;
} ) {
	switch ( event.type ) {
		case 'turn.prompt': {
			if ( ! event.visualAnnotations?.length )
				return <UserTurn text={ event.text } attachments={ event.attachments } />;
			const noteImages = new Set(
				event.visualAnnotations.flatMap( ( note ) => note.imageIds ?? [] )
			);
			return (
				<>
					{ event.visualAnnotations.map( ( note, index ) => (
						<UserTurn
							key={ index }
							text={ note.comment }
							annotation={ note }
							attachments={ event.attachments?.filter( ( a ) =>
								a.kind === 'image' && noteImages.has( a.id )
									? note.imageIds?.includes( a.id )
									: index === 0
							) }
						/>
					) ) }
				</>
			);
		}
		case 'content.provisional':
		case 'content.confirmed':
			return event.blockType === 'reasoning' ? (
				<details>
					<summary>{ __( 'Reasoning' ) }</summary>
					<p>{ event.text }</p>
				</details>
			) : (
				<AssistantText
					text={ event.text }
					messageText={ reply?.text ?? event.text }
					copyText={ reply?.copy }
					inlineImages={ false }
					streaming={ running && event.type === 'content.provisional' }
				/>
			);
		case 'native.call':
		case 'tool.started': {
			const reported =
				event.type === 'native.call' && event.state !== 'started'
					? { isError: event.state === 'failed', message: undefined, imageService: undefined }
					: undefined;
			const result = results.get( callKey( event ) ) ?? reported;
			return (
				<ToolUseRow
					name={ event.name }
					isRunning={ running }
					result={
						result && {
							text: toolResultLabel( result ),
							isError: result.isError,
							imageService: result.imageService,
						}
					}
				/>
			);
		}
		case 'tool.result':
			return <p>{ toolResultLabel( event ) }</p>;
		case 'tool.progress':
			return <p role="status">{ event.message }</p>;
		case 'context.compacted':
			return <p>{ __( 'Claude compacted the conversation context.' ) }</p>;
		case 'task.status': {
			const labels = {
				running: __( 'Background task running' ),
				completed: __( 'Background task completed' ),
				stopped: __( 'Background task stopped' ),
				failed: __( 'Background task failed' ),
			};
			return <p role="status">{ labels[ event.status ] }</p>;
		}
		case 'approval.resolved':
			return <p>{ __( 'Approval request closed.' ) }</p>;
		case 'turn.recovered':
			return (
				<div role="status">
					<p>{ __( 'Studio recovered this conversation.' ) }</p>
					{ event.invalidatedApprovals.length > 0 && (
						<p>{ __( 'Pending approval requests from the interrupted turn expired.' ) }</p>
					) }
					{ event.uncertainOperations.length > 0 && (
						<>
							<p>{ __( 'Check whether these operations finished before repeating them.' ) }</p>
							<ul>
								{ event.uncertainOperations.map( ( op, i ) => (
									<li key={ i }>{ getClaudeUncertainOperationDescription( op ) }</li>
								) ) }
							</ul>
						</>
					) }
				</div>
			);
		case 'chat.artifact': {
			if ( ! isStudioChatArtifactData( event.artifact ) ) return null;
			const media = event.artifact.widgets.flatMap( ( widget ) => {
				const path = claudeMediaPath( sessionFile, getLocalMediaPath( widget ) );
				return isRenderableMediaWidget( widget ) && path
					? [
							{
								...widget,
								widgetProps: { ...widget.widgetProps, source: { type: 'local', path } },
							},
					  ]
					: [];
			} );
			const paths = new Set( claudeSitePreviewPaths( event.artifact.widgets, sitePreview ) );
			return (
				<>
					<ChatArtifact widgets={ media } claudeSessionId={ sessionId } />
					{ sitePreview &&
						[ ...paths ].map( ( p ) => (
							<ToolLink key={ p } icon={ <AppearanceIcon aria-hidden="true" /> } path={ p }>
								{ p === DESIGN_SYSTEM_PREVIEW_PATH
									? __( 'Open design system' )
									: sprintf( __( 'Open preview for %s' ), p ) }
							</ToolLink>
						) ) }
				</>
			);
		}
		case 'turn.terminal': {
			const labels = {
				success: __( 'Completed' ),
				error: __( 'Turn failed' ),
				interrupted: __( 'Stopped' ),
				max_turns: __( 'Turn limit reached' ),
				budget_exceeded: __( 'Budget limit reached' ),
				deferred: __( 'Turn deferred' ),
				unknown_process_exit: __( 'Claude exited unexpectedly' ),
			};
			return (
				<p role={ event.outcome.status === 'success' ? 'status' : 'alert' }>
					{ event.outcome.message ?? labels[ event.outcome.status ] }
				</p>
			);
		}
		default:
			return null;
	}
}
