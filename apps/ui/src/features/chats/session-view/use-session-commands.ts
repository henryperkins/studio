import {
	DESIGN_SYSTEM_PREVIEW_PATH,
	isStudioChatArtifactData,
} from '@studio/agent/protocol/chat-artifacts';
import { useEffect } from 'react';
import { useAgentRunStore } from '@/data/agent-runs/context';
import { useConnector } from '@/data/core';
import { useSessionUIDispatch } from '@/data/use-session-ui';
import { claudeSitePreviewPaths } from './claude-preview-path';

// Bridge from the chat event stream to SessionUI state. Add a new agent → UI
// behavior by handling its event type here and dispatching the matching
// action defined in `use-session-ui`.
export function useSessionCommands(
	sessionId: string | undefined,
	claudeSiteId?: string | null
): void {
	const connector = useConnector();
	const { stateStore } = useAgentRunStore();
	const dispatch = useSessionUIDispatch();

	useEffect( () => {
		return connector.onAgentEvent( ( payload ) => {
			if ( payload.sessionId !== sessionId ) return;
			const event = payload.event;
			if ( claudeSiteId !== undefined ) {
				if ( ! claudeSiteId || ! sessionId || event.type !== 'backend.event' ) return;
				const command = event.event;
				if ( command.type !== 'preview.reload' && command.type !== 'chat.artifact' ) return;
				const owner = stateStore.getState()[ sessionId ];
				if (
					owner?.phase !== 'running' ||
					owner.isInterrupting ||
					owner.runId !== payload.runId ||
					command.runId !== payload.runId ||
					command.target?.environment !== 'local' ||
					command.target.siteId !== claudeSiteId
				)
					return;
				if ( command.type === 'preview.reload' ) {
					dispatch( { type: 'preview/reload' } );
				} else if ( isStudioChatArtifactData( command.artifact ) ) {
					const [ path ] = claudeSitePreviewPaths( command.artifact.widgets, claudeSiteId );
					if ( path && path !== DESIGN_SYSTEM_PREVIEW_PATH ) {
						dispatch( { type: 'preview/navigate', path } );
					}
				}
				return;
			}
			// The preview is a browser: it shows a page as it loaded, so it shows
			// the agent's changes once the agent asks for a reload.
			if ( event.type === 'preview.reload' ) {
				dispatch( { type: 'preview/reload' } );
				return;
			}
			if ( event.type === 'chat.artifact' && isStudioChatArtifactData( event.artifact ) ) {
				const previewPath = getSitePreviewArtifactPath( event.artifact );
				// A design system change shows a button in the chat instead: jumping
				// away from the front end hides what the change looks like on the site.
				if ( previewPath && previewPath !== DESIGN_SYSTEM_PREVIEW_PATH ) {
					dispatch( { type: 'preview/navigate', path: previewPath } );
				}
			}
		} );
	}, [ connector, sessionId, dispatch, claudeSiteId, stateStore ] );
}

function getSitePreviewArtifactPath( artifact: {
	widgets: Array< { type: string; widgetProps: Record< string, unknown > } >;
} ): string | null {
	const widget = artifact.widgets.find(
		( candidate ) =>
			candidate.type === 'site-preview' && typeof candidate.widgetProps.path === 'string'
	);
	return typeof widget?.widgetProps.path === 'string' ? widget.widgetProps.path : null;
}
