import { getDefaultChatGptReasoningEffort } from './chatgpt-models';
import { readSessionPin } from './providers';
import type { ConnectionRegistryEntry } from './connections';
import type { OpenAiReasoningEffort } from './openai-models';
import type { StudioSessionContextData } from './sessions/entry-types';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

export type ChatGptCredentialStorage = 'vault' | 'session';
export type ChatGptAccountState = 'signed-in' | 'signed-out' | 'needs-sign-in';

/** The account information application surfaces may display. Never credentials. */
export interface ChatGptAccountView extends ConnectionRegistryEntry {
	providerId: 'chatgpt-oauth';
	backend: 'pi';
	label: string;
	email: string | null;
	storage: ChatGptCredentialStorage;
	state: ChatGptAccountState;
}

export interface ChatGptSettings {
	enabled: boolean;
	/** The browser and the callback listener are on the same machine. */
	signInSupported: boolean;
	secureStorage: 'available' | 'unavailable';
	accounts: ChatGptAccountView[];
}

export interface ChatGptSessionSelection {
	connectionId: string;
	revision: number;
	model: string;
	reasoningEffort: OpenAiReasoningEffort;
}

const asString = ( value: unknown ) => ( typeof value === 'string' ? value : undefined );

/**
 * The `studio.session_context` record of a ChatGPT selection. Its model and
 * effort go under `chatGpt`, never in the fields every provider's records
 * share, so a build that doesn't know ChatGPT finds nothing there to act on.
 */
export function toChatGptSessionContext(
	selection: Pick< ChatGptSessionSelection, 'connectionId' | 'revision' | 'model' > & {
		reasoningEffort: string;
	}
): StudioSessionContextData {
	return {
		provider: 'chatgpt-oauth',
		connectionId: selection.connectionId,
		revision: selection.revision,
		chatGpt: { model: selection.model, reasoningEffort: selection.reasoningEffort },
	};
}

/** A ChatGPT record's model and effort, as written now or before they moved under `chatGpt`. */
export function readChatGptContextChoice( record: StudioSessionContextData | undefined ): {
	model?: string;
	reasoningEffort?: string;
} {
	const chatGpt = typeof record?.chatGpt === 'object' ? record.chatGpt : undefined;
	return {
		model: asString( chatGpt?.model ) ?? asString( record?.model ),
		reasoningEffort: asString( chatGpt?.reasoningEffort ) ?? asString( record?.reasoningEffort ),
	};
}

/** Keeps an unsupported stored effort visible until the user changes it. */
export function readChatGptSessionSelection( entries: SessionEntry[] ) {
	const pin = readSessionPin( entries );
	if ( pin?.provider !== 'chatgpt-oauth' ) return undefined;
	const { model = '', reasoningEffort } = readChatGptContextChoice( pin );
	return {
		connectionId: pin.connectionId ?? '',
		revision: pin.revision ?? -1,
		model,
		reasoningEffort: reasoningEffort ?? getDefaultChatGptReasoningEffort( model ),
	};
}

export interface ChatGptSignInOptions {
	reconsent?: boolean;
	storage?: ChatGptCredentialStorage;
}

export interface ChatGptSignInStart {
	attemptId: string;
}

export type ChatGptSignInFailureCode =
	| 'unknown-attempt'
	| 'not-found'
	| 'accounts-unreadable'
	| 'discovery-failed'
	| 'callback-unavailable'
	| 'browser-unavailable'
	| 'cancelled'
	| 'timed-out'
	| 'denied'
	| 'authorization-failed'
	| 'registration-incomplete'
	| 'client-mismatch'
	| 'code-rejected'
	| 'token-exchange-failed'
	| 'id-token-invalid'
	| 'identity-mismatch'
	| 'permission-missing'
	| 'vault-unavailable'
	| 'vault-key-unreadable'
	| 'save-failed';

export type ChatGptSignInOutcome =
	| { ok: true; registrationId: string; label: string; email: string | null }
	| { ok: false; code: ChatGptSignInFailureCode; message: string };

export interface ChatGptSignOutResult {
	localCleared: boolean;
	remoteRevocationConfirmed: boolean;
}
