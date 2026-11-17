import { getAiModelLabel, isAiModelId } from '@studio/agent/protocol/models';
import { getOpenAiReasoningEffortLabel } from '@studio/agent/protocol/openai-models';
import { AI_PROVIDER_LABELS } from '@studio/agent/protocol/providers';
import { useQueryClient } from '@tanstack/react-query';
import { __, sprintf } from '@wordpress/i18n';
import { useEffect, useRef, useState } from 'react';
import { useConnector } from '@/data/core';
import { primeSessionQueryData, SESSIONS_QUERY_KEY } from '@/data/queries/use-sessions';
import { useSiteChatDraft } from '@/data/queries/use-site-chat-draft';
import { saveSessionSettingChange } from '@/data/session-setting-changes';
import { getComposerDraft, saveComposerDraft } from './draft-store';
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
	// Whether the site's new chat is being started on a ChatGPT account, kept with
	// its draft, where every send from it looks.
	const siteDraft = useSiteChatDraft( ownerSiteId );
	const [ error, setError ] = useState( '' );
	const saving = useRef( false );
	const created = useRef< AiSessionSummary | null >( null );
	// The session the last start of the site's new chat created and couldn't
	// finish, with the account it was put on, once that was saved.
	const started = useRef< { summary: AiSessionSummary; pinned?: ChatGptSessionSelection } | null >(
		null
	);
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
	/**
	 * Puts a chat with nothing in it yet on a ChatGPT account where it is, as the
	 * backend allows and a model switch without turns does, with no new chat to
	 * confirm: a chat with a session is pinned in place; the site's new chat
	 * becomes one on the account, taking what was typed with it.
	 */
	const startInPlace = async (
		selection: ChatGptSessionSelection,
		sessionId: string | undefined,
		draft: { key?: string; environment: 'local' | 'live' }
	): Promise< void > => {
		const entry = createChatGptSelectionEntry( selection );
		if ( sessionId ) {
			await saveSessionSettingChange( {
				queryClient,
				sessionId,
				entry,
				write: () => connector.setSessionChatGptSelection( sessionId, selection ),
			} );
			return;
		}
		if ( ! onSwitchSession || saving.current || siteDraft.current().startingChatGpt ) return;
		saving.current = true;
		const { update: updateSiteDraft } = siteDraft;
		updateSiteDraft( { startingChatGpt: true } );
		const pin = async ( start: NonNullable< typeof started.current > ) => {
			await connector.setSessionChatGptSelection( start.summary.id, selection );
			start.pinned = selection;
		};
		try {
			// Each step stops once the composer is gone, leaving what was typed on the new chat.
			let start = started.current;
			if ( start ) {
				try {
					await pin( start );
				} catch ( failure ) {
					// On another account already, which the backend refuses as needing a
					// new chat: this attempt starts one instead, once.
					const elsewhere =
						start.pinned &&
						( start.pinned.connectionId !== selection.connectionId ||
							start.pinned.revision !== selection.revision );
					if ( ! elsewhere ) throw failure;
					start = started.current = null;
				}
				if ( ! mounted.current ) return;
			}
			if ( ! start ) {
				start = started.current = { summary: await connector.createSession( ownerSiteId ) };
				if ( ! mounted.current ) return;
				await pin( start );
				if ( ! mounted.current ) return;
			}
			const { summary } = start;
			if ( draft.environment === 'live' ) {
				await connector.setSessionEnvironment( summary.id, 'live' );
				if ( ! mounted.current ) return;
			}
			started.current = null;
			primeSessionQueryData( queryClient, summary, [ entry ] );
			// What was typed by now, the store having kept up with the composer.
			saveComposerDraft( summary.id, getComposerDraft( draft.key ) );
			saveComposerDraft( draft.key, { text: '', attachments: [] } );
			void queryClient.invalidateQueries( { queryKey: SESSIONS_QUERY_KEY, exact: true } );
			onSwitchSession( summary.id );
		} finally {
			saving.current = false;
			updateSiteDraft( { startingChatGpt: false } );
		}
	};
	return {
		request,
		confirm,
		startInPlace,
		inFlight,
		starting: !! siteDraft.draft.startingChatGpt,
		error,
		cancel: () => {
			if ( ! saving.current ) setTarget( null );
		},
		target:
			target?.provider === 'chatgpt-oauth'
				? sprintf(
						/* translators: 1: a ChatGPT account, 2: a model, 3: its reasoning effort, e.g. "Medium". */
						__( 'ChatGPT plan · %1$s · %2$s · %3$s' ),
						target.label,
						isAiModelId( target.selection.model )
							? getAiModelLabel( target.selection.model )
							: target.selection.model,
						getOpenAiReasoningEffortLabel( target.selection.reasoningEffort )
				  )
				: target
				? sprintf(
						/* translators: 1: the model's provider, 2: the model. */
						__( '%1$s · %2$s' ),
						AI_PROVIDER_LABELS[ target.provider ],
						getAiModelLabel( target.model )
				  )
				: undefined,
	};
}
