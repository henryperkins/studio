export interface PiBackendSessionRef {
	backend: 'pi';
	filePath: string;
}

/** A Claude conversation's native identity. It never changes for a conversation. */
export interface ClaudeBackendSessionBinding {
	connectionId: string;
	conversationId: string;
	/**
	 * The local site whose folder is the native workspace, or null for the
	 * dedicated global workspace. Not the Studio target a turn acts on.
	 */
	siteId: string | null;
	workingDirectory: string;
	configDirectory: string;
}

export interface ClaudeBackendSessionRef extends ClaudeBackendSessionBinding {
	backend: 'claude-code';
	nativeSessionId: string;
	/** Canonical path of the native transcript, once independently verified. */
	transcriptPath?: string;
	/**
	 * Hash of the Claude account the conversation runs on. Another account
	 * cannot continue it. Absent on conversations created before accounts were
	 * recorded, until their next verified turn.
	 */
	accountKey?: string;
}

export type BackendSessionRef = PiBackendSessionRef | ClaudeBackendSessionRef;
