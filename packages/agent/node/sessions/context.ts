import { readRecordedSessionModel, type AiModelId } from '@studio/agent/protocol/models';
import { isAiProviderId, readLastReplyProvider } from '@studio/agent/protocol/providers';
import { isStudioCustomEntryOfType } from '@studio/agent/protocol/sessions/entry-types';
import type { AiProviderId } from '@studio/agent/protocol/providers';
import type { LoadedAiSession } from '@studio/agent/protocol/sessions/types';

export interface ResumeSessionContext {
	sessionId?: string;
	provider?: AiProviderId;
	model?: AiModelId;
	/** The provider the session's latest reply came from, even on a model Studio dropped. */
	lastReplyProvider?: AiProviderId;
}

// Resolve provider/model for resume from the most recent `model_change` /
// `studio.session_context` entries.
export function resolveResumeSessionContext( resumeSession?: {
	summary: Pick< LoadedAiSession[ 'summary' ], 'id' >;
	entries: LoadedAiSession[ 'entries' ];
} ): ResumeSessionContext {
	if ( ! resumeSession ) {
		return {};
	}

	const context: ResumeSessionContext = {};
	if ( resumeSession.summary.id ) {
		context.sessionId = resumeSession.summary.id;
	}

	// Unset when the session recorded no (still-offered) model, so the caller
	// applies its provider-appropriate default instead of pinning a dead id.
	context.model = readRecordedSessionModel( resumeSession.entries );
	context.lastReplyProvider = readLastReplyProvider( resumeSession.entries );

	for ( let index = resumeSession.entries.length - 1; index >= 0; index -= 1 ) {
		const entry = resumeSession.entries[ index ];

		if ( isStudioCustomEntryOfType( entry, 'studio.session_context' ) ) {
			const data = entry.data;
			if ( data?.provider && isAiProviderId( data.provider ) ) {
				context.provider = data.provider;
				break;
			}
		}
	}

	return context;
}
