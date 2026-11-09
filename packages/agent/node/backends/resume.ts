import fs from 'fs/promises';
import path from 'path';
import type {
	ClaudeBackendSessionBinding,
	ClaudeBackendSessionRef,
} from '@studio/agent/protocol/backend-sessions';

/** Evidence from native transcript discovery. Requested SDK options alone are not evidence. */
export interface ClaudeTranscriptCandidate {
	nativeSessionId: string;
	workingDirectory?: string;
	configDirectory?: string;
	transcriptPath?: string;
}

export type ClaudeResumeResolution =
	| { status: 'ready'; session: ClaudeBackendSessionRef }
	| { status: 'missing' | 'ambiguous' | 'rebind-required' };

async function canonicalPath(
	value: string | undefined,
	kind: 'directory' | 'file'
): Promise< string | undefined > {
	if ( ! value || ! path.isAbsolute( value ) ) {
		return;
	}
	try {
		const resolved = await fs.realpath( value );
		const info = await fs.stat( resolved );
		if ( kind === 'directory' ? info.isDirectory() : info.isFile() ) {
			return resolved;
		}
	} catch {
		// Unreadable paths cannot establish provenance.
	}
}

function isInside( directory: string, file: string ): boolean {
	const prefix = directory.endsWith( path.sep ) ? directory : directory + path.sep;
	return file.startsWith( prefix );
}

export async function resolveClaudeResume(
	recorded: ClaudeBackendSessionRef,
	current: ClaudeBackendSessionBinding,
	candidates: readonly ClaudeTranscriptCandidate[] | undefined
): Promise< ClaudeResumeResolution > {
	if (
		! recorded.nativeSessionId ||
		! recorded.connectionId ||
		! recorded.conversationId ||
		! recorded.siteId ||
		recorded.connectionId !== current.connectionId ||
		recorded.conversationId !== current.conversationId ||
		recorded.siteId !== current.siteId ||
		candidates === undefined
	) {
		return { status: 'rebind-required' };
	}

	const [ workingDirectory, configDirectory ] = await Promise.all( [
		canonicalPath( current.workingDirectory, 'directory' ),
		canonicalPath( current.configDirectory, 'directory' ),
	] );
	// Recorded paths are already canonical. Resolving them again would authorize
	// a different directory if the original path were replaced with a link.
	if (
		! workingDirectory ||
		! configDirectory ||
		workingDirectory !== recorded.workingDirectory ||
		configDirectory !== recorded.configDirectory
	) {
		return { status: 'rebind-required' };
	}

	const matching = candidates.filter(
		( candidate ) => candidate.nativeSessionId === recorded.nativeSessionId
	);
	if ( ! matching.length ) {
		return { status: 'missing' };
	}

	const transcripts = new Set< string >();
	for ( const candidate of matching ) {
		const [ candidateWorkspace, candidateConfig, transcript ] = await Promise.all( [
			canonicalPath( candidate.workingDirectory, 'directory' ),
			canonicalPath( candidate.configDirectory, 'directory' ),
			canonicalPath( candidate.transcriptPath, 'file' ),
		] );
		if (
			! transcript ||
			candidateWorkspace !== workingDirectory ||
			candidateConfig !== configDirectory ||
			! isInside( configDirectory, transcript )
		) {
			return { status: 'rebind-required' };
		}
		transcripts.add( transcript );
	}
	if ( transcripts.size !== 1 ) {
		return { status: 'ambiguous' };
	}
	const [ transcriptPath ] = transcripts;
	if ( recorded.transcriptPath && recorded.transcriptPath !== transcriptPath ) {
		return { status: 'rebind-required' };
	}

	return {
		status: 'ready',
		session: {
			backend: 'claude-code',
			nativeSessionId: recorded.nativeSessionId,
			connectionId: current.connectionId,
			conversationId: current.conversationId,
			siteId: current.siteId,
			workingDirectory,
			configDirectory,
			transcriptPath,
		},
	};
}
