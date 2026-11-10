import { getAiModelLabel, isAiModelId } from '@studio/agent/protocol/models';
import { getOpenAiReasoningEffortLabel } from '@studio/agent/protocol/openai-models';
import { AI_PROVIDER_LABELS } from '@studio/agent/protocol/providers';
import { useQueryClient } from '@tanstack/react-query';
import { __ } from '@wordpress/i18n';
import { useEffect, useRef, useState } from 'react';
import { useConnector } from '@/data/core';
import { primeSessionQueryData, SESSIONS_QUERY_KEY } from '@/data/queries/use-sessions';
import { saveComposerDraft } from './draft-store';
import { createChatGptSelectionEntry } from './use-chatgpt-conversation';
import type { AiModelId, AiSessionSummary, SessionEntry } from '@/data/core';
import type { ChatGptSessionSelection } from '@studio/agent/protocol/chatgpt';
import type { AiProviderId } from '@studio/agent/protocol/providers';

type ConnectionTarget =
	| { provider: 'chatgpt-oauth'; selection: ChatGptSessionSelection; label: string }
	| { provider: Exclude< AiProviderId, 'chatgpt-oauth' >; model: AiModelId };

export function useConnectionSwitch(
	ownerSiteId?: string,
	onSwitchSession?: ( id: string ) => void
) {
	const connector = useConnector();
	const queryClient = useQueryClient();
	const [ target, setTarget ] = useState< ConnectionTarget | null >( null );
	const [ inFlight, setInFlight ] = useState( false );
	const [ error, setError ] = useState( '' );
	const saving = useRef( false );
	const created = useRef< AiSessionSummary | null >( null );
	const mounted = useRef( true );
	useEffect( () => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, [] );
	const request = ( next: ConnectionTarget ) => {
		if ( ! onSwitchSession || saving.current ) return;
		setError( '' );
		created.current = null;
		setTarget( next );
	};
	const confirm = async ( summaryText: string ) => {
		if ( ! target || ! onSwitchSession || saving.current ) return;
		saving.current = true;
		setInFlight( true );
		setError( '' );
		try {
			const summary = created.current ?? ( await connector.createSession( ownerSiteId ) );
			created.current = summary;
			let entry: SessionEntry;
			if ( target.provider === 'chatgpt-oauth' ) {
				await connector.setSessionChatGptSelection( summary.id, target.selection );
				entry = createChatGptSelectionEntry( target.selection );
			} else {
				await connector.setSessionProvider( summary.id, target.provider, target.model );
				entry = {
					type: 'custom',
					id: crypto.randomUUID(),
					parentId: null,
					timestamp: new Date().toISOString(),
					customType: 'studio.session_context',
					data: { provider: target.provider, model: target.model },
				};
			}
			primeSessionQueryData( queryClient, summary, [ entry ] );
			saveComposerDraft( summary.id, { text: summaryText.trim(), attachments: [] } );
			void queryClient.invalidateQueries( { queryKey: SESSIONS_QUERY_KEY, exact: true } );
			if ( mounted.current ) {
				setTarget( null );
				onSwitchSession( summary.id );
			}
		} catch ( failure ) {
			if ( mounted.current )
				setError(
					failure instanceof Error ? failure.message : __( 'Couldn’t start this chat. Try again.' )
				);
		} finally {
			saving.current = false;
			if ( mounted.current ) setInFlight( false );
		}
	};
	return {
		request,
		confirm,
		inFlight,
		error,
		cancel: () => {
			if ( ! saving.current ) setTarget( null );
		},
		target:
			target?.provider === 'chatgpt-oauth'
				? `${ __( 'ChatGPT plan' ) } · ${ target.label } · ${
						isAiModelId( target.selection.model )
							? getAiModelLabel( target.selection.model )
							: target.selection.model
				  } · ${ getOpenAiReasoningEffortLabel( target.selection.reasoningEffort ) }`
				: target
				? `${ AI_PROVIDER_LABELS[ target.provider ] } · ${ getAiModelLabel( target.model ) }`
				: undefined,
	};
}
