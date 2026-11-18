import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { loadAiSession } from '@studio/agent/node/sessions/store';

export async function claudeScreenshotDirectory(
	sessionsRoot: string,
	conversationId: string,
	create = true
): Promise< string > {
	const { summary } = await loadAiSession( sessionsRoot, conversationId );
	const root = await realpath( sessionsRoot );
	const relative = path.relative( sessionsRoot, summary.filePath );
	const file = path.join( root, relative );
	if (
		summary.id !== conversationId ||
		summary.backend !== 'claude-code' ||
		! relative.endsWith( '.jsonl' ) ||
		relative.startsWith( '..' + path.sep ) ||
		path.isAbsolute( relative ) ||
		( await realpath( file ) ) !== file ||
		( await lstat( file ) ).nlink !== 1
	) {
		throw new Error( 'The screenshot directory for this conversation is unavailable.' );
	}
	const directory = file.slice( 0, -'.jsonl'.length ) + '.screenshots';
	if ( create ) {
		await mkdir( directory, { mode: 0o700 } ).catch( ( error: NodeJS.ErrnoException ) => {
			if ( error.code !== 'EEXIST' ) throw error;
		} );
	}
	if (
		( await realpath( directory ) ) !== directory ||
		! ( await lstat( directory ) ).isDirectory()
	) {
		throw new Error( 'The screenshot directory for this conversation is unavailable.' );
	}
	return directory;
}
