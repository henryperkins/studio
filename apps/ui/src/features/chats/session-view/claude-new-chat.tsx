import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { __ } from '@wordpress/i18n';
import { useState } from 'react';
import { useConnector } from '@/data/core';
import { primeSessionQueryData, SESSIONS_QUERY_KEY } from '@/data/queries/use-sessions';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/lib/ui';
import type { ClaudeEffort } from '@studio/agent/protocol/claude-code';

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
			onValueChange={ ( next ) => {
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

export function ClaudeNewChat( { siteId }: { siteId: string } ) {
	const connector = useConnector();
	const client = useQueryClient();
	const navigate = useNavigate();
	const [ open, setOpen ] = useState( false );
	const [ connectionId, setConnectionId ] = useState( '' );
	const [ model, setModel ] = useState( '' );
	const [ effort, setEffort ] = useState< ClaudeEffort | '' >( '' );
	const state = useQuery( {
		queryKey: [ 'claude-runtime' ],
		queryFn: () => connector.getClaudeRuntimeState(),
	} );
	const catalog = useQuery( {
		queryKey: [ 'claude-models', connectionId, siteId ],
		queryFn: () => connector.getClaudeModelCatalog( connectionId, siteId ),
		enabled: open && !! connectionId,
	} );
	const create = useMutation( {
		mutationFn: () =>
			connector.createClaudeSession( {
				siteId,
				connectionId,
				selection: { model, effort: effort as ClaudeEffort },
			} ),
		onSuccess: ( summary ) => {
			primeSessionQueryData( client, summary );
			void client.invalidateQueries( { queryKey: SESSIONS_QUERY_KEY } );
			void navigate( { to: '/sessions/$sessionId', params: { sessionId: summary.id } } );
		},
	} );
	if ( ! state.data?.enabled ) return null;
	const models = catalog.data?.ok ? catalog.data.models : [];
	const selected = models.find( ( item ) => item.id === model );
	return (
		<div>
			<Button variant="outline" onClick={ () => setOpen( ! open ) }>
				{ __( 'New Claude Code chat' ) }
			</Button>
			{ open ? (
				<div>
					<p>
						{ __( 'This chat works on this local site using the selected Claude Code runtime.' ) }
					</p>
					<Choice
						label={ __( 'Claude connection' ) }
						value={ connectionId }
						options={ state.data.connections.map( ( c ) => ( {
							value: c.id,
							label: c.executablePath,
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
									{ blocker }
								</p>
						  ) )
						: null }
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
					{ create.error ? <p role="alert">{ create.error.message }</p> : null }
					<Button
						disabled={
							! connectionId ||
							! selected ||
							! effort ||
							! selected.efforts.includes( effort ) ||
							create.isPending
						}
						onClick={ () => create.mutate() }
					>
						{ __( 'Create Claude chat' ) }
					</Button>
				</div>
			) : null }
		</div>
	);
}
