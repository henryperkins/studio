import { getDefaultChatGptReasoningEffort } from './chatgpt-models';
import { readSessionPin } from './providers';
import type { ConnectionRegistryEntry } from './connections';
import type { OpenAiReasoningEffort } from './openai-models';
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

/** Keeps an unsupported stored effort visible until the user changes it. */
export function readChatGptSessionSelection( entries: SessionEntry[] ) {
	const pin = readSessionPin( entries );
	if ( pin?.provider !== 'chatgpt-oauth' ) return undefined;
	return {
		connectionId: pin.connectionId ?? '',
		revision: pin.revision ?? -1,
		model: pin.model ?? '',
		reasoningEffort: pin.reasoningEffort ?? getDefaultChatGptReasoningEffort( pin.model ?? '' ),
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
	| 'save-failed';

export type ChatGptSignInOutcome =
	| { ok: true; registrationId: string; label: string; email: string | null }
	| { ok: false; code: ChatGptSignInFailureCode; message: string };

export interface ChatGptSignOutResult {
	localCleared: boolean;
	remoteRevocationConfirmed: boolean;
}
