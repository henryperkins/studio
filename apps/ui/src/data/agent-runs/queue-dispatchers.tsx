import { readChatGptSessionSelection } from '@studio/agent/protocol/chatgpt';
import { resolveChatGptReasoning } from '@studio/agent/protocol/chatgpt-models';
import { matchesClaudeSendContext, resolveClaudeSession } from '@studio/agent/protocol/claude-code';
import { resolveConnectionSelection } from '@studio/agent/protocol/connections';
import { getEffectiveSessionProvider } from '@studio/agent/protocol/providers';
import { __ } from '@wordpress/i18n';
import { useEffect, useSyncExternalStore } from 'react';
import { useConnector } from '@/data/core';
import { useAiSettings } from '@/data/queries/use-ai-settings';
import { useChatGptModels, useChatGptSettings } from '@/data/queries/use-chatgpt-settings';
import { useIsOutOfAiCredits } from '@/data/queries/use-is-out-of-ai-credits';
import { useSession } from '@/data/queries/use-sessions';
import {
	useEntriesWithSettingChanges,
	waitForSessionSettingChanges,
} from '@/data/session-setting-changes';
import { useAgentRunStore } from './context';
import { initialAgentRunState } from './store';

// One dispatcher per session with queued prompts, so a queue keeps draining
// after its chat is closed.
export function QueueDispatchers() {
	const store = useAgentRunStore();
	const ids = useSyncExternalStore( store.stateStore.subscribe, () =>
		Object.entries( store.stateStore.getState() )
			.filter( ( [ , state ] ) => state.queuedPrompts.length > 0 )
			.map( ( [ sessionId ] ) => sessionId )
			.join( ' ' )
	);
	return ids
		? ids
				.split( ' ' )
				.map( ( sessionId ) => <QueueDispatcher key={ sessionId } sessionId={ sessionId } /> )
		: null;
}

function QueueDispatcher( { sessionId }: { sessionId: string } ) {
	const { stateStore } = useAgentRunStore();
	const next = useSyncExternalStore(
		stateStore.subscribe,
		() => stateStore.getState()[ sessionId ]?.queuedPrompts[ 0 ]
	);
	return next?.claudeSelection || next?.claudeContext ? (
		<ClaudeQueueDispatcher sessionId={ sessionId } />
	) : (
		<StandardQueueDispatcher sessionId={ sessionId } />
	);
}

function ClaudeQueueDispatcher( { sessionId }: { sessionId: string } ) {
	const connector = useConnector();
	const { stateStore, dispatchSession, startRun } = useAgentRunStore();
	const state = useSyncExternalStore(
		stateStore.subscribe,
		() => stateStore.getState()[ sessionId ] ?? initialAgentRunState
	);
	const next = state.phase === 'idle' ? state.queuedPrompts[ 0 ] : undefined;
	useEffect( () => {
		if ( ! next || next.failure ) return;
		let cancelled = false;
		const current = () =>
			! cancelled &&
			stateStore.getState()[ sessionId ]?.phase === 'idle' &&
			stateStore.getState()[ sessionId ]?.queuedPrompts[ 0 ] === next;
		const paused = __( 'This queued message needs review. Edit it to send again.' );
		const dispatch = async () => {
			await waitForSessionSettingChanges( sessionId );
			if ( ! current() ) return;
			const saved = await connector.getSession( sessionId );
			const context = resolveClaudeSession( saved.entries );
			const captured = next.claudeContext;
			const selected = next.claudeSelection;
			if (
				! context ||
				! captured ||
				! selected ||
				saved.claudeRecovery ||
				! matchesClaudeSendContext( context, captured ) ||
				selected.model !== context.selection.model ||
				selected.effort !== context.selection.effort
			) {
				throw new Error( paused );
			}
			const [ runtime, catalog ] = await Promise.all( [
				connector.getClaudeRuntimeState(),
				connector.getClaudeModelCatalog(
					captured.connectionId,
					context.binding.siteId ?? undefined
				),
			] );
			const model = catalog.ok && catalog.models.find( ( item ) => item.id === selected.model );
			if (
				! runtime.enabled ||
				! runtime.connections.some(
					( connection ) =>
						connection.id === captured.connectionId &&
						! connection.blockers.length &&
						( captured.revision === undefined ||
							captured.revision === ( connection.revision ?? 1 ) )
				) ||
				! model ||
				! model.efforts.includes( selected.effort ) ||
				( next.images?.length && ! model.imageInput )
			) {
				throw new Error( paused );
			}
			if ( ! current() ) return;
			dispatchSession( sessionId, { type: 'queue_shift' } );
			const { id: _id, prompt, failure: _failure, ...options } = next;
			await startRun( sessionId, prompt, options ).catch( () => {
				dispatchSession( sessionId, {
					type: 'queue_restore',
					prompt: { ...next, failure: paused },
				} );
			} );
		};
		void dispatch().catch( () => {
			if ( current() )
				dispatchSession( sessionId, { type: 'queue_failed', id: next.id, failure: paused } );
		} );
		return () => {
			cancelled = true;
		};
	}, [ connector, dispatchSession, next, sessionId, startRun, stateStore ] );
	return null;
}

function StandardQueueDispatcher( { sessionId }: { sessionId: string } ) {
	const { stateStore, dispatchSession, startRun } = useAgentRunStore();
	const state = useSyncExternalStore(
		stateStore.subscribe,
		() => stateStore.getState()[ sessionId ] ?? initialAgentRunState
	);
	const { data: session } = useSession( sessionId );
	const entries = useEntriesWithSettingChanges( sessionId, session?.entries );
	const { data: aiSettings, isPending: isAiSettingsPending } = useAiSettings();
	const isOutOfCredits = useIsOutOfAiCredits();
	const provider = getEffectiveSessionProvider( entries ?? [], aiSettings );
	const chatGptSettings = useChatGptSettings();
	const chatGpt = readChatGptSessionSelection( entries ?? [] );
	const account = chatGptSettings.data?.accounts.find(
		( item ) => item.connectionId === chatGpt?.connectionId && item.revision === chatGpt.revision
	);
	const models = useChatGptModels(
		account,
		provider === 'chatgpt-oauth' && !! chatGptSettings.data?.enabled
	);
	const heldChatGpt =
		provider === 'chatgpt-oauth' &&
		( ! chatGptSettings.data?.enabled ||
			chatGptSettings.isError ||
			! chatGpt ||
			! resolveConnectionSelection( entries ?? [], {
				connections: chatGptSettings.data.accounts,
				settings: aiSettings ?? null,
			} ).ok ||
			! resolveChatGptReasoning( chatGpt.model, chatGpt.reasoningEffort ).ok ||
			! models.data?.models?.some( ( model ) => model.id === chatGpt.model ) );
	// Holding rather than clearing: a balance spent mid-run leaves the queued
	// prompt visible and it dispatches on its own once a top-up refreshes the
	// quota, instead of being silently dropped or sent to a certain rejection.
	const held =
		! session || isAiSettingsPending || heldChatGpt || ( isOutOfCredits && provider === 'wpcom' );
	const next = state.phase === 'idle' && ! held ? state.queuedPrompts[ 0 ] : undefined;

	useEffect( () => {
		const live = stateStore.getState()[ sessionId ];
		if ( ! next || live?.phase !== 'idle' || live.queuedPrompts[ 0 ] !== next ) {
			return;
		}
		dispatchSession( sessionId, { type: 'queue_shift' } );
		const { id: _id, prompt, ...options } = next;
		// On failure, drop the whole queue so a broken backend doesn't cascade errors.
		startRun( sessionId, prompt, options ).catch( () =>
			dispatchSession( sessionId, { type: 'queue_clear' } )
		);
	}, [ dispatchSession, next, sessionId, startRun, stateStore ] );

	return null;
}
