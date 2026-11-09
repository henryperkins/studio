import { __, sprintf } from '@wordpress/i18n';
import { readLatestRecordedModelId } from '@studio/agent/protocol/models';
import {
	AI_PROVIDER_LABELS,
	getAiProviderDefaultModel,
	getEffectiveSessionProvider,
	readSessionPin,
	resolveSessionModelForProvider,
	type AiProviderId,
	type AiSettings,
} from '@studio/agent/protocol/providers';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { ChatGptErrorSummary } from '@studio/agent/protocol/chatgpt-errors';
import type { StudioSessionContextData } from '@studio/agent/protocol/sessions/entry-types';

/**
 * A model as the provider that serves it names it: the same slug under the
 * OpenAI API and under ChatGPT is two models, billed two ways.
 */
export interface ProviderModelRef {
	providerId: AiProviderId;
	modelId: string;
}

/**
 * What a conversation runs on: a connection, a model of the connection's
 * provider, and the connection's configuration revision it ran under.
 */
export interface ConnectionSelection {
	connectionId: string;
	model: ProviderModelRef;
	revision: number;
}

/** The agent runtime a connection's turns run in: Studio's pi agent, or Claude Code. */
export type ConnectionBackend = 'pi' | 'claude-code';

/** Whether a connection can run a turn now: signed in, with usable credentials. */
export type ConnectionAuthStatus = 'connected' | 'disconnected';

/**
 * Who a connection signs in as, to show and to tell accounts apart. Never a
 * credential, nor anything derived from one.
 */
export interface ConnectionIdentity {
	/** The account's stable identifier as the provider verified it, such as an ID token's `sub`. */
	subject: string;
	/** Display only: two accounts can share an email or a name. */
	email?: string;
	displayName?: string;
}

export interface ConnectionRegistryEntry {
	/** Opaque: compared whole, never parsed. */
	connectionId: string;
	providerId: AiProviderId;
	backend: ConnectionBackend;
	/**
	 * The connection's configuration revision. A conversation records the one
	 * it ran under, and doesn't continue under another.
	 */
	revision: number;
	/** Null until the connection has verified who it signs in as. */
	identity: ConnectionIdentity | null;
	/** Read as disconnected without a verified identity. */
	authStatus: ConnectionAuthStatus;
}

/**
 * The connections conversations can run on, at one moment. WordPress.com,
 * Anthropic and OpenAI each have one implicit connection, named after the
 * provider and at revision 0, which isn't listed: their rules read `settings`,
 * as `getEffectiveSessionProvider` does.
 */
export interface ConnectionRegistry {
	/** Connections with a sign-in of their own, such as ChatGPT accounts. */
	connections: readonly ConnectionRegistryEntry[];
	/** The saved default provider and whether an Anthropic key is saved; null reads as neither. */
	settings: Pick< AiSettings, 'provider' | 'hasAnthropicApiKey' > | null;
}

export type ConnectionSelectionError =
	// The connection is gone, or signed out.
	| { code: 'disconnected'; providerId: AiProviderId; connectionId: string }
	// The connection's configuration changed since the conversation ran on it.
	| {
			code: 'changed';
			providerId: AiProviderId;
			connectionId: string;
			recordedRevision: number;
			currentRevision: number;
	  }
	// The conversation's record names no connection its provider can run on.
	| { code: 'unsupported'; providerId: AiProviderId; connectionId?: string };

export type ConnectionSelectionResult =
	| { ok: true; selection: ConnectionSelection }
	| { ok: false; error: ConnectionSelectionError };

/**
 * What one ChatGPT connection's model list said. Apart from
 * `OpenAiModelAvailability`, which narrows AI_MODELS for an API key: each
 * ChatGPT connection lists models of its own.
 */
export interface ChatGptModelAvailability {
	connectionId: string;
	/** The connection's revision when the list was read; the list says nothing for another. */
	revision: number;
	/** When the list was last read successfully, or null. */
	checkedAt: string | null;
	/** The listed models Studio supports, in the list's order, or null while unknown. */
	models: Array< { id: string; label: string } > | null;
	/** Why the latest read failed, or null. A failed read keeps the list read at the same revision. */
	lastError: ChatGptErrorSummary | null;
}

const LEGACY_CONNECTION_REVISION = 0;

/**
 * The connection, model and revision a conversation runs on, or why it can't
 * run.
 *
 * A conversation on ChatGPT (see `getEffectiveSessionProvider`) never moves:
 * a connection that is missing, signed out or changed is an error, never a
 * fallback, and so is a conversation no ChatGPT record names a connection
 * for, such as one with only a reply from ChatGPT. Its connection and model
 * come from the latest ChatGPT record alone; entries that name no provider
 * don't speak for ChatGPT.
 *
 * Every other conversation resolves as `getEffectiveSessionProvider` does, to
 * its provider's implicit connection, with the model today's readers give:
 * the one it recorded (verbatim on OpenAI, so a dropped model surfaces as a
 * problem), or the provider's built-in default when it recorded none.
 */
export function resolveConnectionSelection(
	entries: SessionEntry[],
	registry: ConnectionRegistry
): ConnectionSelectionResult {
	const providerId = getEffectiveSessionProvider( entries, registry.settings );
	if ( providerId === 'chatgpt-oauth' ) {
		return resolveChatGptConnection( readSessionPin( entries ), registry.connections );
	}
	const modelId =
		providerId === 'openai-api-key'
			? readLatestRecordedModelId( entries ) ?? getAiProviderDefaultModel( providerId )
			: resolveSessionModelForProvider( entries, providerId );
	return {
		ok: true,
		selection: {
			connectionId: providerId,
			model: { providerId, modelId },
			revision: LEGACY_CONNECTION_REVISION,
		},
	};
}

function resolveChatGptConnection(
	record: StudioSessionContextData | undefined,
	connections: readonly ConnectionRegistryEntry[]
): ConnectionSelectionResult {
	const providerId = 'chatgpt-oauth';
	const connectionId = record?.provider === providerId ? record.connectionId : undefined;
	const revision = record?.revision;
	const modelId = record?.model;
	if ( typeof connectionId !== 'string' || ! connectionId ) {
		return { ok: false, error: { code: 'unsupported', providerId } };
	}
	if (
		typeof revision !== 'number' ||
		! Number.isInteger( revision ) ||
		typeof modelId !== 'string' ||
		! modelId
	) {
		return { ok: false, error: { code: 'unsupported', providerId, connectionId } };
	}
	const connection = connections.find( ( entry ) => entry.connectionId === connectionId );
	if ( ! connection ) {
		return { ok: false, error: { code: 'disconnected', providerId, connectionId } };
	}
	// Studio's ChatGPT route is its own pi transport.
	if ( connection.providerId !== providerId || connection.backend !== 'pi' ) {
		return { ok: false, error: { code: 'unsupported', providerId, connectionId } };
	}
	if ( connection.revision !== revision ) {
		return {
			ok: false,
			error: {
				code: 'changed',
				providerId,
				connectionId,
				recordedRevision: revision,
				currentRevision: connection.revision,
			},
		};
	}
	if ( connection.authStatus !== 'connected' || ! connection.identity?.subject ) {
		return { ok: false, error: { code: 'disconnected', providerId, connectionId } };
	}
	return { ok: true, selection: { connectionId, model: { providerId, modelId }, revision } };
}

/** What went wrong with a conversation's connection, and what the user can do. */
export function describeConnectionSelectionError(
	error: Pick< ConnectionSelectionError, 'code' | 'providerId' >
): string {
	const provider = AI_PROVIDER_LABELS[ error.providerId ];
	switch ( error.code ) {
		case 'disconnected':
			return sprintf(
				/* translators: %s: AI provider name, e.g. "ChatGPT". */
				__(
					'%s isn’t connected, so this chat can’t continue. Start a new chat with another provider.'
				),
				provider
			);
		case 'changed':
			return sprintf(
				/* translators: %s: AI provider name, e.g. "ChatGPT". */
				__(
					'The %s connection this chat ran on has changed since, so the chat can’t continue. Start a new chat.'
				),
				provider
			);
		case 'unsupported':
			return sprintf(
				/* translators: %s: AI provider name, e.g. "ChatGPT". */
				__(
					'This chat doesn’t name a %s connection Studio can use, so it can’t continue. Start a new chat.'
				),
				provider
			);
	}
}
