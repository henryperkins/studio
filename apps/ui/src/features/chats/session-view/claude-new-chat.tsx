import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { __, sprintf } from '@wordpress/i18n';
import { useRef, useState } from 'react';
import { useConnector } from '@/data/core';
import { describeClaudeIssue } from '@/data/queries/claude-runtime';
import { primeSessionQueryData, SESSIONS_QUERY_KEY } from '@/data/queries/use-sessions';
import { ConnectionSwitchDialog, saveComposerDraft } from '@/features/composer';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/lib/ui';
import type { ClaudeEffort, CreateClaudeSessionRequest } from '@studio/agent/protocol/claude-code';

function Choice( {
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: string;
	options: Array< { value: string; label: string } >;
	onChange: ( value: string ) => void;
} ) {
	return (
		<Select
			value={ value || null }
			items={ options }
			onValueChange={ ( next, details ) => {
				if ( details.reason === 'none' ) {
					details.cancel();
					return;
				}
				if ( next ) onChange( next );
			} }
		>
			<SelectTrigger aria-label={ label }>
				<SelectValue placeholder={ label } />
			</SelectTrigger>
			<SelectContent>
				{ options.map( ( option ) => (
					<SelectItem key={ option.value } value={ option.value }>
						{ option.label }
					</SelectItem>
				) ) }
			</SelectContent>
		</Select>
	);
}

export function ClaudeNewChat( {
	siteId,
	fromExistingChat = false,
}: {
	siteId?: string;
	fromExistingChat?: boolean;
} ) {
	const connector = useConnector();
	const client = useQueryClient();
	const navigate = useNavigate();
	const [ open, setOpen ] = useState( false );
	const [ globalWorkspace, setGlobalWorkspace ] = useState( false );
	const workspaceSiteId = globalWorkspace ? undefined : siteId;
	const [ reviewing, setReviewing ] = useState< {
		request: CreateClaudeSessionRequest;
		revision: number;
		label: string;
	} >();
	const creating = useRef( false );
	const [ connectionId, setConnectionId ] = useState( '' );
	const [ model, setModel ] = useState( '' );
	const [ effort, setEffort ] = useState< ClaudeEffort | '' >( '' );
	const state = useQuery( {
		queryKey: [ 'claude-runtime' ],
		queryFn: () => connector.getClaudeRuntimeState(),
	} );
	const catalog = useQuery( {
		queryKey: [ 'claude-models', connectionId, workspaceSiteId ],
		queryFn: () => connector.getClaudeModelCatalog( connectionId, workspaceSiteId ),
		enabled: open && !! connectionId,
	} );
	const create = useMutation( {
		mutationFn: ( { request }: { request: CreateClaudeSessionRequest; context?: string } ) =>
			connector.createClaudeSession( request ),
		onSuccess: ( summary, { context } ) => {
			if ( context ) saveComposerDraft( summary.id, { text: context.trim(), attachments: [] } );
			setReviewing( undefined );
			primeSessionQueryData( client, summary );
			void client.invalidateQueries( { queryKey: SESSIONS_QUERY_KEY } );
			void navigate( { to: '/sessions/$sessionId', params: { sessionId: summary.id } } );
		},
		onSettled: () => {
			creating.current = false;
		},
	} );
	if ( ! state.data?.enabled ) return null;
	const connection = state.data.connections.find( ( item ) => item.id === connectionId );
	const available =
		state.isSuccess &&
		! state.isFetching &&
		connection?.blockers.length === 0 &&
		catalog.isSuccess &&
		! catalog.isFetching &&
		catalog.data.ok;
	const models = catalog.data?.ok ? catalog.data.models : [];
	const selected = models.find( ( item ) => item.id === model );
	const ready = available && !! selected && !! effort && selected.efforts.includes( effort );
	const reviewed =
		ready &&
		reviewing?.revision === ( connection?.revision ?? 1 ) &&
		reviewing.request.siteId === workspaceSiteId &&
		reviewing.request.connectionId === connectionId &&
		reviewing.request.selection.model === model &&
		reviewing.request.selection.effort === effort;
	const start = ( request: CreateClaudeSessionRequest, context?: string ) => {
		if ( creating.current || ! ready || ( reviewing && ! reviewed ) ) return;
		creating.current = true;
		create.mutate( { request, context } );
	};
	const connectionLabel = ( c: { executablePath: string; configDirectory?: string } ) =>
		c.configDirectory ? `${ c.executablePath } · ${ c.configDirectory }` : c.executablePath;
	return (
		<div>
			<Button variant="outline" onClick={ () => setOpen( ! open ) }>
				{ __( 'New Claude Code chat' ) }
			</Button>
			{ open ? (
				<div role="group" aria-label={ __( 'New Claude Code conversation' ) }>
					{ siteId && (
						<Choice
							label={ __( 'Claude workspace' ) }
							value={ globalWorkspace ? 'global' : 'site' }
							options={ [
								{ value: 'site', label: __( 'This site' ) },
								{ value: 'global', label: __( 'Global workspace' ) },
							] }
							onChange={ ( value ) => {
								setGlobalWorkspace( value === 'global' );
								setModel( '' );
								setEffort( '' );
							} }
						/>
					) }
					{ ! workspaceSiteId && <p>{ __( 'This chat starts in Studio’s global workspace.' ) }</p> }
					<Choice
						label={ __( 'Claude connection' ) }
						value={ connectionId }
						options={ state.data.connections.map( ( c ) => ( {
							value: c.id,
							label: connectionLabel( c ),
						} ) ) }
						onChange={ ( value ) => {
							setConnectionId( value );
							setModel( '' );
							setEffort( '' );
						} }
					/>
					{ catalog.data && ! catalog.data.ok
						? catalog.data.blockers.map( ( blocker ) => (
								<p role="alert" key={ blocker }>
									{ describeClaudeIssue( blocker ) }
								</p>
						  ) )
						: null }
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
					{ connectionId && ( state.isError || ! connection || connection.blockers.length > 0 ) ? (
						<p role="alert">
							{ __( 'Claude Code is unavailable. Recheck its status in Settings.' ) }
						</p>
					) : null }
					<Choice
						label={ __( 'Claude model' ) }
						value={ model }
						options={ models.map( ( item ) => ( { value: item.id, label: item.displayName } ) ) }
						onChange={ ( value ) => {
							setModel( value );
							setEffort( '' );
						} }
					/>
					<Choice
						label={ __( 'Claude effort' ) }
						value={ effort }
						options={ ( selected?.efforts ?? [] ).map( ( value ) => ( { value, label: value } ) ) }
						onChange={ ( value ) => setEffort( value as ClaudeEffort ) }
					/>
					{ create.error && ! reviewing ? <p role="alert">{ create.error.message }</p> : null }
					<Button
						disabled={ ! ready || create.isPending }
						onClick={ () => {
							if ( ! ready || ! connection ) return;
							const request = {
								connectionId,
								siteId: workspaceSiteId,
								selection: { model, effort },
							};
							if ( fromExistingChat ) {
								create.reset();
								setReviewing( {
									request,
									revision: connection.revision ?? 1,
									label: sprintf(
										/* translators: 1: runtime path and configuration, 2: workspace, 3: model, 4: effort. */
										__( '%1$s · %2$s · %3$s (%4$s)' ),
										connectionLabel( connection ),
										workspaceSiteId ? __( 'This site' ) : __( 'Global workspace' ),
										selected.displayName,
										effort
									),
								} );
							} else start( request );
						} }
					>
						{ __( 'Create Claude chat' ) }
					</Button>
					{ reviewing && (
						<ConnectionSwitchDialog
							target={ reviewing.label }
							inFlight={ create.isPending }
							confirmDisabled={ ! reviewed }
							error={
								reviewed
									? create.error?.message
									: __(
											'The connection or available models changed. Cancel and check your selection.'
									  )
							}
							onCancel={ () => setReviewing( undefined ) }
							onConfirm={ ( context ) => start( reviewing.request, context ) }
						/>
					) }
				</div>
			) : null }
		</div>
	);
}
