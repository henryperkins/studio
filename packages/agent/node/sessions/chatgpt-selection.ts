import {
	chatGptSettingsAction,
	validateChatGptSelection,
} from '@studio/agent/node/chatgpt/settings';
import {
	assertSessionSelection,
	withSessionSelection,
} from '@studio/agent/node/sessions/selection';
import { appendStudioEntry } from '@studio/agent/node/sessions/store';
import type { ChatGptSessionSelection } from '@studio/agent/protocol/chatgpt';

export function setSessionChatGptSelection(
	sessionsRoot: string,
	sessionId: string,
	input: unknown
): Promise< ChatGptSessionSelection > {
	return chatGptSettingsAction( () =>
		withSessionSelection( sessionsRoot, sessionId, async ( entries ) => {
			const selection = await validateChatGptSelection( input );
			const context = { provider: 'chatgpt-oauth' as const, ...selection };
			assertSessionSelection( entries, context );
			await appendStudioEntry( sessionsRoot, sessionId, 'studio.session_context', context );
			return selection;
		} )
	);
}
