import { getClaudeRecoveryBlockedMessage } from '@studio/agent/protocol/claude-code';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { __ } from '@wordpress/i18n';
import { useState } from 'react';
import { useConnector } from '@/data/core';
import { openNewSession, SESSIONS_QUERY_KEY } from '@/data/queries/use-sessions';
import { ConnectionSwitchDialog, saveComposerDraft } from '@/features/composer';
import { Button } from '@/lib/ui';
import { ClaudeNewChat } from './claude-new-chat';

export function ClaudeRecoveryAction( { sessionId }: { sessionId: string } ) {
	const connector = useConnector();
	const client = useQueryClient();
	const action = useMutation( {
		mutationFn: () => connector.recoverClaudeSession( sessionId ),
		onSuccess: () => client.invalidateQueries( { queryKey: [ ...SESSIONS_QUERY_KEY, sessionId ] } ),
	} );
	return (
		<>
			<Button variant="outline" disabled={ action.isPending } onClick={ () => action.mutate() }>
				{ action.isPending ? __( 'Checking the previous run…' ) : __( 'Recover this chat' ) }
			</Button>
			{ action.data?.status === 'blocked' && (
				<p role="status">{ getClaudeRecoveryBlockedMessage( action.data.reason ) }</p>
			) }
			{ action.error && (
				<p role="alert">{ __( 'Studio could not check the previous run. Try again.' ) }</p>
			) }
		</>
	);
}

export function ClaudeConnectionActions( {
	siteId,
	expanded,
}: {
	siteId?: string;
	expanded: boolean;
} ) {
	const connector = useConnector();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [ switching, setSwitching ] = useState( false );
	const create = useMutation( {
		mutationFn: async ( text: string ) => {
			const summary = await openNewSession( { connector, queryClient }, siteId );
			if ( text.trim() ) saveComposerDraft( summary.id, { text: text.trim(), attachments: [] } );
			return summary;
		},
		onSuccess: ( summary ) => {
			setSwitching( false );
			void navigate( { to: '/sessions/$sessionId', params: { sessionId: summary.id } } );
		},
	} );
	return (
		<details open={ expanded || undefined }>
			<summary>{ __( 'Start with another connection' ) }</summary>
			<ClaudeNewChat siteId={ siteId } fromExistingChat />
			<Button
				variant="outline"
				onClick={ () => {
					create.reset();
					setSwitching( true );
				} }
			>
				{ __( 'New Studio chat' ) }
			</Button>
			{ switching && (
				<ConnectionSwitchDialog
					target={ __( 'Studio chat using the provider in Settings' ) }
					inFlight={ create.isPending }
					error={ create.error?.message }
					onCancel={ () => setSwitching( false ) }
					onConfirm={ ( text ) => create.mutate( text ) }
				/>
			) }
		</details>
	);
}
