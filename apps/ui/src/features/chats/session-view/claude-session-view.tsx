import {
	resolveClaudeSession,
	isSameClaudeTarget,
	type ClaudeEffort,
	type ClaudeSessionSelection,
	type ClaudeStudioTarget,
} from '@studio/agent/protocol/claude-code';
import { findAiSessionOwnerSite } from '@studio/agent/protocol/sessions/owner-site';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { __ } from '@wordpress/i18n';
import { useRef, useState } from 'react';
import { claudeDisplayEventKey } from '@/data/agent-runs/claude-journal-read';
import { useAgentRun } from '@/data/agent-runs/use-agent-run';
import { toast } from '@/data/app-messages';
import { useConnector } from '@/data/core';
import { describeClaudeIssue } from '@/data/queries/claude-runtime';
import { useSites } from '@/data/queries/use-sites';
import {
	saveSessionSettingChange,
	useEntriesWithSettingChanges,
} from '@/data/session-setting-changes';
import { useOptionalSessionPreviewUI } from '@/data/use-session-ui';
import { restoreStagedAnnotations } from '@/features/annotations';
import { Composer, type ComposerHandle } from '@/features/composer';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/lib/ui';
import { ClaudeApprovalCard } from './claude-approval-card';
import { ClaudeConnectionActions, ClaudeRecoveryAction } from './claude-conversation-actions';
import { ClaudeQuestionBatch } from './claude-question-batch';
import { ClaudeTargetControls, useClaudeTargetChange } from './claude-target-controls';
import { ClaudeTranscriptEvent, projectClaudeTranscript } from './claude-transcript';
import { QueuedPrompts } from './queued-prompts';
import { SessionFrame } from './session-frame';
import { SessionHeader } from './session-header';
import styles from './style.module.css';
import { useComposerPreviewActions } from './use-composer-preview-actions';
import { useSessionCommands } from './use-session-commands';
import type { QueuedPrompt, SendMessageOptions } from '@/data/agent-runs/store';
import type { LoadedAiSession, SessionEntry } from '@/data/core';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';
import type { ReactNode } from 'react';

export function ClaudeSessionView( {
	data,
	headerStart,
	hideHeader,
}: {
	data: LoadedAiSession;
	headerStart?: ReactNode;
	hideHeader?: boolean;
} ) {
	const sessionId = data.summary.id;
	const connector = useConnector();
	const client = useQueryClient();
	const entries = useEntriesWithSettingChanges( sessionId, data.entries ) ?? [];
	const composerRef = useRef< ComposerHandle >( null );
	const [ frameNode, setFrameNode ] = useState< HTMLDivElement | null >( null );
	const [ error, setError ] = useState( '' );
	const [ pendingModel, setPendingModel ] = useState< string >();
	const [ answered, setAnswered ] = useState< string[] >( [] );
	const run = useAgentRun( sessionId );
	const sites = useSites();
	let session: ReturnType< typeof resolveClaudeSession >;
	try {
		session = resolveClaudeSession( entries );
	} catch {
		session = undefined;
	}
	const workspaceSiteId = session?.binding.siteId ?? undefined;
	const ownerSite = findAiSessionOwnerSite( sites.data, data.summary );
	const changeTarget = useClaudeTargetChange( sessionId );
	const catalog = useQuery( {
		queryKey: [ 'claude-models', session?.binding.connectionId, workspaceSiteId ],
		queryFn: () =>
			connector.getClaudeModelCatalog( session!.binding.connectionId, workspaceSiteId ),
		enabled: !! session,
	} );
	const state = useQuery( {
		queryKey: [ 'claude-runtime' ],
		queryFn: () => connector.getClaudeRuntimeState(),
	} );
	const connection = state.data?.enabled
		? state.data.connections.find( ( item ) => item.id === session?.binding.connectionId )
		: undefined;
	const available =
		state.isSuccess &&
		! state.isFetching &&
		connection?.blockers.length === 0 &&
		catalog.isSuccess &&
		! catalog.isFetching &&
		catalog.data.ok;
	const events = ( data.claudeJournal ?? [] ).flat();
	const questionKey = ( event: { runId: string; turnId: string; requestId: string } ) =>
		JSON.stringify( [ event.runId, event.turnId, event.requestId ] );
	const liveQuestions = new Set( run.pendingClaudeQuestions.map( questionKey ) );
	const resolutions = new Map<
		string,
		Extract< BackendTurnEvent, { type: 'question.resolved' } >
	>();
	const terminal = new Map<
		string,
		Extract< BackendTurnEvent, { type: 'turn.terminal' } >[ 'outcome' ][ 'status' ]
	>();
	const transcript = [ ...events, ...run.pendingClaudeQuestions ];
	const { rows: visibleEvents, results, replies } = projectClaudeTranscript( transcript );
	for ( const event of visibleEvents ) {
		if ( event.type === 'question.resolved' ) resolutions.set( questionKey( event ), event );
		if ( event.type === 'turn.terminal' ) terminal.set( event.runId, event.outcome.status );
	}
	const pending = run.pendingClaudeApprovals.filter(
		( event ) =>
			state.data?.enabled &&
			event.runId === run.runId &&
			! answered.includes( `${ event.runId }:${ event.requestId }` ) &&
			! events.some(
				( item ) =>
					item.runId === event.runId &&
					( item.type === 'turn.terminal' ||
						( item.type === 'approval.resolved' && item.requestId === event.requestId ) )
			) &&
			run.hasActiveRun &&
			! run.isInterrupting
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
	const ready = !! (
		available &&
		! rebindRequired &&
		! pendingModel &&
		! changeTarget.isPending &&
		selection &&
		selectedModel?.efforts.includes( selection.effort )
	);
	const annotationSiteId =
		session?.target.environment === 'local' ? session.target.siteId : undefined;
	const { sendMessage } = run;
	const send = async ( text: string, options?: SendMessageOptions ) => {
		if ( ! ready || ! session )
			throw new Error( __( 'Check the Claude connection, target and model before sending.' ) );
		if ( options?.images?.length && selectedModel?.imageInput !== true ) {
			const message = __( 'Choose a model that supports images before sending these attachments' );
			toast.error( message );
			throw new Error( message );
		}
		await sendMessage( text, {
			...options,
			claudeSelection: session.selection,
			claudeContext: {
				connectionId: session.binding.connectionId,
				revision: connection?.revision ?? 1,
				target: session.target,
			},
		} );
	};
	useComposerPreviewActions( composerRef, annotationSiteId, run.hasActiveRun, ready, send, true );
	const visibleSiteId = useOptionalSessionPreviewUI()?.siteId;
	const previewSiteId =
		annotationSiteId && annotationSiteId === visibleSiteId ? annotationSiteId : null;
	useSessionCommands( sessionId, previewSiteId );
	const editQueued = ( item: QueuedPrompt ) => {
		const notes = item.annotationDraft?.notes ?? [];
		if ( notes.length ) {
			const previous = item.claudeContext?.target;
			if (
				! annotationSiteId ||
				previous?.environment !== 'local' ||
				previous.siteId !== annotationSiteId
			) {
				toast.error( __( 'Switch back to the annotated local site to edit this message.' ) );
				return;
			}
			if ( ! restoreStagedAnnotations( annotationSiteId, notes ) ) return;
		}
		const noteImages = new Set(
			notes.flatMap( ( note ) => note.images.map( ( image ) => image.id ) )
		);
		composerRef.current?.replaceDraft( item.annotationDraft?.text ?? item.prompt, {
			files: item.files,
			images: item.images?.filter( ( image ) => ! noteImages.has( image.id ) ),
		} );
		run.removeQueuedPrompt( item.id );
	};
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
	const siteNameOf = ( target: ClaudeStudioTarget ) =>
		target.environment === 'global'
			? undefined
			: sites.data?.find( ( site ) => site.id === target.siteId )?.name;
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
			rootRef={ setFrameNode }
			session={ data.summary }
			header={
				hideHeader ? null : (
					<SessionHeader
						start={ headerStart }
						site={ ownerSite }
						siteName={ data.summary.ownerSiteName ?? __( 'Global chat' ) }
					/>
				)
			}
			composer={
				<div className={ `${ styles.column } ${ styles.claudeComposer }` }>
					{ session ? (
						<>
							<p>
								{ workspaceSiteId ? __( 'Local workspace:' ) : __( 'Global workspace:' ) }{ ' ' }
								{ session.binding.workingDirectory }
							</p>
							{ ! rebindRequired && (
								<ClaudeTargetControls
									workspaceSiteId={ workspaceSiteId }
									target={ session.target }
									sites={ sites.data ?? [] }
									sitesPending={ sites.isPending }
									disabled={ run.hasActiveRun || changeTarget.isPending }
									onChange={ ( next ) =>
										changeTarget.mutate( { expected: session.target, target: next } )
									}
								/>
							) }
							<Select
								items={ models.map( ( item ) => ( { value: item.id, label: item.displayName } ) ) }
								value={ pendingModel ?? selection?.model ?? null }
								onValueChange={ ( model, details ) => {
									// Option-list changes can restore an initial value without user input.
									if ( details.reason === 'none' ) {
										details.cancel();
										return;
									}
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
								onValueChange={ ( effort, details ) => {
									if ( details.reason === 'none' ) {
										details.cancel();
										return;
									}
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
								<p role="alert">{ catalog.data.blockers.map( describeClaudeIssue ).join( ' ' ) }</p>
							) }
							{ catalog.isError && (
								<p role="alert">{ __( 'Claude Code model capabilities could not be checked.' ) }</p>
							) }
							{ ( catalog.isError || catalog.data?.ok === false ) && (
								<Button
									variant="outline"
									disabled={ catalog.isFetching }
									onClick={ () => void catalog.refetch() }
								>
									{ __( 'Recheck models' ) }
								</Button>
							) }
							{ state.isError ||
							( state.isSuccess && ( ! connection || connection.blockers.length > 0 ) ) ? (
								<p role="alert">
									{ __( 'Claude Code is unavailable. Recheck its status in Settings.' ) }
								</p>
							) : null }
							{ pendingModel && <p>{ __( 'Choose an effort for the selected model.' ) }</p> }
							<QueuedPrompts
								prompts={ run.queuedPrompts }
								onEdit={ editQueued }
								onRemove={ ( id ) => run.removeQueuedPrompt( id, true ) }
							/>
							<Composer
								ref={ composerRef }
								draftKey={ sessionId }
								sessionId={ sessionId }
								ariaLabel={ __( 'Message Claude' ) }
								placeholder={ __( 'Message Claude' ) }
								busy={ run.hasActiveRun }
								isInterrupting={ run.isInterrupting }
								claude={ { model: selectedModel, canSend: ready } }
								onSend={ send }
								onInterrupt={ run.interrupt }
								ownerSiteId={ workspaceSiteId }
								dropTarget={ frameNode }
								annotationSiteId={ annotationSiteId }
							/>
						</>
					) : (
						<p role="alert">{ __( 'The Claude workspace binding could not be loaded.' ) }</p>
					) }
					{ error ? <p role="alert">{ error }</p> : null }
				</div>
			}
		>
			<div className={ styles.column } data-chat-transcript>
				{ visibleEvents.map( ( event ) => {
					if ( event.type === 'question.asked' ) {
						const key = questionKey( event );
						return (
							<ClaudeQuestionBatch
								key={ key }
								request={ event }
								sessionId={ sessionId }
								sessionFile={ data.summary.filePath }
								resolution={ resolutions.get( key ) }
								active={
									!! state.data?.enabled &&
									run.runId === event.runId &&
									run.isRunning &&
									! run.isInterrupting &&
									! terminal.has( event.runId ) &&
									liveQuestions.has( key )
								}
								cancelled={
									( run.runId === event.runId && run.isInterrupting ) ||
									terminal.get( event.runId ) === 'interrupted'
								}
							/>
						);
					}
					return (
						<ClaudeTranscriptEvent
							key={ claudeDisplayEventKey( event ) }
							event={ event }
							reply={ replies.get( event ) }
							results={ results }
							sessionId={ sessionId }
							sessionFile={ data.summary.filePath }
							sitePreview={
								session &&
								event.type === 'chat.artifact' &&
								( event.target
									? isSameClaudeTarget( event.target, session.target )
									: session.binding.siteId === previewSiteId )
									? previewSiteId
									: null
							}
							running={
								run.isRunning && run.runId === event.runId && ! terminal.has( event.runId )
							}
						/>
					);
				} ) }
				{ pending.map( ( event ) => (
					<ClaudeApprovalCard
						key={ `${ event.runId }:${ event.requestId }` }
						request={ event }
						siteName={ siteNameOf( event.operation.target ) }
						onAllow={ () => answer( event, 'allow' ) }
						onDeny={ () => answer( event, 'deny' ) }
					/>
				) ) }
				{ rebindRequired && session ? (
					<>
						<p role="alert">
							{ recovery === 'run-locked'
								? __(
										'A previous Claude run still holds the workspace lock. Recover this chat to check whether the run has ended.'
								  )
								: recovery === 'journal-unreadable'
								? __( 'Studio could not read this chat’s journal. Start a new chat to reconnect.' )
								: recovery === 'deletion-pending'
								? __( 'Delete this chat again to finish clearing its Studio history.' )
								: __(
										'The native session is unavailable. Start a new conversation to reconnect; this history will remain available.'
								  ) }
						</p>
						{ recovery === 'run-locked' && <ClaudeRecoveryAction sessionId={ sessionId } /> }
					</>
				) : null }
				{ session && ! run.hasActiveRun && recovery !== 'deletion-pending' && (
					<ClaudeConnectionActions siteId={ workspaceSiteId } expanded={ rebindRequired } />
				) }
			</div>
		</SessionFrame>
	);
}
