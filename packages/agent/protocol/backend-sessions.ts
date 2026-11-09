export interface PiBackendSessionRef {
	backend: 'pi';
	filePath: string;
}

export interface ClaudeBackendSessionBinding {
	connectionId: string;
	conversationId: string;
	siteId: string;
	workingDirectory: string;
	configDirectory: string;
}

export interface ClaudeBackendSessionRef extends ClaudeBackendSessionBinding {
	backend: 'claude-code';
	nativeSessionId: string;
	/** Canonical path of the native transcript, once independently verified. */
	transcriptPath?: string;
}

export type BackendSessionRef = PiBackendSessionRef | ClaudeBackendSessionRef;
