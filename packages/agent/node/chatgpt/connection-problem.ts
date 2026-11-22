import { readChatGptAccount } from '@studio/agent/node/chatgpt/account-store';
import {
	describeConnectionSelectionError,
	type ConnectionSelectionError,
} from '@studio/agent/protocol/connections';

/**
 * Why a turn can't run on a chat's ChatGPT connection. A disconnected chat
 * whose registration is still saved is worded for that account's state, as
 * the apps' notice and `/model` word it: signing in to it again continues the
 * chat. Without a saved registration, and for any other problem, the shared
 * text as it is.
 */
export async function describeChatGptConnectionProblem(
	error: ConnectionSelectionError
): Promise< string > {
	if ( error.code !== 'disconnected' ) {
		return describeConnectionSelectionError( error );
	}
	const saved = await readChatGptAccount( error.connectionId ).catch( () => null );
	return describeConnectionSelectionError( error, saved?.state );
}
