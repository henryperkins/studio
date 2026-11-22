import { mkdir, mkdtemp } from 'fs/promises';
import os from 'os';
import path from 'path';
import { currentClaudeWebCall } from './claude-code/web-call';
import type { StudioAgentHost } from '@studio/agent/node/host';

/**
 * The directory screenshot captures are saved to. The `studio code` command
 * points its host at a per-session sidecar directory (`<session>.screenshots/`
 * next to the session JSONL) so screenshots referenced by persisted chat
 * artifacts survive OS temp cleanup and are removed together with the session.
 * Hosts without one fall back to a throwaway temp directory.
 */
export async function resolveScreenshotDirectory( host: StudioAgentHost ): Promise< string > {
	const call = currentClaudeWebCall();
	if ( call ) {
		call.check();
		const directory = await host.screenshotsDirectory?.();
		if ( ! directory || ! path.isAbsolute( directory ) )
			throw new Error( 'The screenshot directory for this conversation is unavailable.' );
		return directory;
	}
	try {
		const directory = await host.screenshotsDirectory?.();
		if ( directory ) {
			await mkdir( directory, { recursive: true } );
			return directory;
		}
	} catch ( error ) {
		// Fall through to the temp directory so the capture still succeeds, but
		// say so: files there are purged by the OS, so persisted artifacts will
		// eventually show as unavailable and this line is the only clue why.
		console.warn( '[screenshots] falling back to a temporary directory:', error );
	}
	return mkdtemp( path.join( os.tmpdir(), 'studio-screenshot-' ) );
}
