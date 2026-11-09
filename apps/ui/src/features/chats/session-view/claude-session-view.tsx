import {
	resolveClaudeSession,
	type ClaudeEffort,
	type ClaudeSessionSelection,
} from '@studio/agent/protocol/claude-code';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { __ } from '@wordpress/i18n';
import { useState } from 'react';
import { useAgentRun } from '@/data/agent-runs/use-agent-run';
import { useConnector } from '@/data/core';
import {
	saveSessionSettingChange,
	useEntriesWithSettingChanges,
} from '@/data/session-setting-changes';
import {
	Button,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Textarea,
} from '@/lib/ui';
import { ClaudeNewChat } from './claude-new-chat';
import { SessionFrame } from './session-frame';
import styles from './style.module.css';
import type { LoadedAiSession, SessionEntry } from '@/data/core';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';

export function ClaudeSessionView( { data }: { data: LoadedAiSession } ) {
	const sessionId = data.summary.id;
	const connector = useConnector();
	const client = useQueryClient();
	const entries = useEntriesWithSettingChanges( sessionId, data.entries ) ?? [];
	const [ prompt, setPrompt ] = useState( '' );
	const [ error, setError ] = useState( '' );
	const [ pendingModel, setPendingModel ] = useState< string >();
	const [ answered, setAnswered ] = useState< string[] >( [] );
	const run = useAgentRun( sessionId );
	let session: ReturnType< typeof resolveClaudeSession >;
	try {
		session = resolveClaudeSession( entries );
	} catch {
		session = undefined;
	}
	const catalog = useQuery( {
		queryKey: [ 'claude-models', session?.binding.connectionId, session?.binding.siteId ],
		queryFn: () =>
			connector.getClaudeModelCatalog( session!.binding.connectionId, session!.binding.siteId ),
		enabled: !! session,
	} );
	const active = useQuery( {
		queryKey: [ 'claude-active', sessionId ],
		queryFn: () => connector.getActiveAgentRuns(),
		enabled: !! sessionId,
	} );
	const events = ( data.claudeJournal ?? [] ).flat();
	const content = new Map< string, { index: number; sequence: number } >();
	const visible = new Set< number >();
	for ( const [ index, event ] of events.entries() ) {
		if ( event.type !== 'content.provisional' && event.type !== 'content.confirmed' ) {
			visible.add( index );
			continue;
		}
		const key = JSON.stringify( [ event.runId, event.turnId, event.messageId, event.blockId ] );
		const sequence = event.type === 'content.confirmed' ? Infinity : event.sequence;
		const current = content.get( key );
		if ( current && current.sequence >= sequence ) continue;
		if ( current ) visible.delete( current.index );
		visible.add( index );
		content.set( key, { index, sequence } );
	}
	const visibleEvents = events.filter( ( _event, index ) => visible.has( index ) );
	const latestTurn = data.claudeJournal?.[ ( data.claudeJournal?.length ?? 1 ) - 1 ] ?? [];
	const approvals = latestTurn.filter(
		( event ): event is Extract< BackendTurnEvent, { type: 'approval.requested' } > =>
			event.type === 'approval.requested'
	);
	const restored =
		active.data?.find( ( item ) => item.sessionId === sessionId )?.pendingClaudeApprovals ?? [];
	const pending = [ ...approvals, ...restored ].filter(
		( event, index, all ) =>
			all.findIndex(
				( item ) => item.requestId === event.requestId && item.runId === event.runId
			) === index &&
			! answered.includes( `${ event.runId }:${ event.requestId }` ) &&
			! latestTurn.some(
				( item ) =>
					item.runId === event.runId &&
					( item.type === 'turn.terminal' ||
						( item.type === 'approval.resolved' && item.requestId === event.requestId ) )
			) &&
			run.hasActiveRun
	);
	const models = catalog.data?.ok ? catalog.data.models : [];
	const selection = session?.selection;
	const selectedModel = models.find( ( item ) => item.id === ( pendingModel ?? selection?.model ) );
	const recovery = run.hasActiveRun ? undefined : data.claudeRecovery;
	const rebindRequired =
		!! recovery ||
		events.some(
			( event ) => event.type === 'turn.terminal' && event.outcome.code === 'rebind_required'
		);
	const save = ( next: ClaudeSessionSelection ) => {
		setPendingModel( undefined );
		const entry = {
			type: 'custom',
			id: crypto.randomUUID(),
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: 'studio.claude_selection',
			data: next,
		} as SessionEntry;
		void saveSessionSettingChange( {
			queryClient: client,
			sessionId,
			entry,
			write: () => connector.setClaudeSessionSelection( sessionId, next ),
		} ).catch( ( failure: Error ) => setError( failure.message ) );
	};
	const answer = (
		event: Extract< BackendTurnEvent, { type: 'approval.requested' } >,
		value: 'allow' | 'deny'
	) => {
		void connector.answerAgentQuestion( event.runId, { [ event.requestId ]: value } ).then(
			() => setAnswered( ( current ) => [ ...current, `${ event.runId }:${ event.requestId }` ] ),
			( failure: Error ) => setError( failure.message )
		);
	};
	return (
		<SessionFrame
			session={ data.summary }
			header={ <div className={ styles.header }>{ __( 'Claude Code Runtime' ) }</div> }
			composer={
				<div className={ styles.column }>
					{ session ? (
						<>
							<p>
								{ __( 'Local workspace:' ) } { session.binding.workingDirectory }
							</p>
							<Select
								items={ models.map( ( item ) => ( { value: item.id, label: item.displayName } ) ) }
								value={ pendingModel ?? selection?.model ?? null }
								onValueChange={ ( model ) => {
									const option = models.find( ( item ) => item.id === model );
									if ( ! option || ! selection ) return;
									if ( option.efforts.includes( selection.effort ) ) {
										save( { model: option.id, effort: selection.effort } );
									} else {
										setPendingModel( option.id );
									}
								} }
							>
								<SelectTrigger aria-label={ __( 'Claude model' ) }>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{ models.map( ( item ) => (
										<SelectItem key={ item.id } value={ item.id }>
											{ item.displayName }
										</SelectItem>
									) ) }
								</SelectContent>
							</Select>
							<Select
								items={ ( selectedModel?.efforts ?? [] ).map( ( value ) => ( {
									value,
									label: value,
								} ) ) }
								value={ pendingModel ? null : selection?.effort ?? null }
								onValueChange={ ( effort ) => {
									if ( effort && selectedModel )
										save( { model: selectedModel.id, effort: effort as ClaudeEffort } );
								} }
							>
								<SelectTrigger aria-label={ __( 'Claude effort' ) }>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{ ( selectedModel?.efforts ?? [] ).map( ( item ) => (
										<SelectItem key={ item } value={ item }>
											{ item }
										</SelectItem>
									) ) }
								</SelectContent>
							</Select>
							{ catalog.data?.ok === false && (
								<p role="alert">
									{ __( 'Claude Code is unavailable.' ) } { catalog.data.blockers.join( ', ' ) }
								</p>
							) }
							{ catalog.isError && (
								<p role="alert">{ __( 'Claude Code model capabilities could not be checked.' ) }</p>
							) }
							{ pendingModel && <p>{ __( 'Choose an effort for the selected model.' ) }</p> }
							<Textarea
								aria-label={ __( 'Message Claude' ) }
								value={ prompt }
								onChange={ ( event ) => setPrompt( event.target.value ) }
							/>
							<Button
								disabled={
									run.hasActiveRun ||
									rebindRequired ||
									!! pendingModel ||
									! prompt.trim() ||
									! selection ||
									! models.some(
										( item ) =>
											item.id === selection.model && item.efforts.includes( selection.effort )
									)
								}
								onClick={ () => {
									const text = prompt;
									const snapshot = selection!;
									setPrompt( '' );
									void run
										.sendMessage( text, { claudeSelection: snapshot } )
										.catch( ( failure: Error ) => {
											setPrompt( text );
											setError( failure.message );
										} );
								} }
							>
								{ __( 'Send' ) }
							</Button>
							{ run.hasActiveRun ? (
								<Button variant="outline" onClick={ () => void run.interrupt() }>
									{ __( 'Stop' ) }
								</Button>
							) : null }
						</>
					) : (
						<p role="alert">{ __( 'The Claude workspace binding could not be loaded.' ) }</p>
					) }
					{ error ? <p role="alert">{ error }</p> : null }
				</div>
			}
		>
			<div className={ styles.column } data-chat-transcript>
				{ visibleEvents.map( ( event, index ) => {
					if ( event.type === 'turn.prompt' ) return <p key={ index }>{ event.text }</p>;
					if ( event.type === 'content.confirmed' || event.type === 'content.provisional' )
						return <p key={ index }>{ event.text }</p>;
					if ( event.type === 'tool.started' ) return <p key={ index }>{ event.name }</p>;
					if ( event.type === 'tool.progress' || event.type === 'tool.result' )
						return <p key={ index }>{ event.message }</p>;
					if ( event.type === 'turn.terminal' )
						return (
							<p role="alert" key={ index }>
								{ event.outcome.message ??
									( event.outcome.status === 'success'
										? __( 'Completed' )
										: event.outcome.status ) }
							</p>
						);
					return null;
				} ) }
				{ pending.map( ( event ) => (
					<div key={ `${ event.runId }:${ event.requestId }` }>
						<p>{ event.description }</p>
						{ event.draft ? (
							<>
								<p>
									{ __( 'Site:' ) } { event.draft.siteName }
								</p>
								<p>
									{ __( 'Draft title:' ) } { event.draft.title }
								</p>
								{ event.draft.content !== undefined ? (
									<pre className={ styles.claudeDraftContent }>{ event.draft.content }</pre>
								) : null }
							</>
						) : null }
						<Button onClick={ () => answer( event, 'allow' ) }>{ __( 'Allow' ) }</Button>
						<Button variant="outline" onClick={ () => answer( event, 'deny' ) }>
							{ __( 'Deny' ) }
						</Button>
					</div>
				) ) }
				{ rebindRequired && session ? (
					<>
						<p role="alert">
							{ recovery === 'run-locked'
								? __(
										'A previous Claude run still holds the workspace lock. Confirm its native process has exited before starting a new chat.'
								  )
								: recovery === 'journal-unreadable'
								? __( 'Studio could not read this chat’s journal. Start a new chat to reconnect.' )
								: recovery === 'deletion-pending'
								? __( 'Delete this chat again to finish clearing its Studio history.' )
								: __(
										'The native session is unavailable. Start a new conversation to reconnect; this history will remain available.'
								  ) }
						</p>
						{ recovery !== 'deletion-pending' && (
							<ClaudeNewChat siteId={ session.binding.siteId } />
						) }
					</>
				) : null }
			</div>
		</SessionFrame>
	);
}
