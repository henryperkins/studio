import { lstat, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { LOCKFILE_STALE_TIME, LOCKFILE_WAIT_TIME } from '@studio/common/constants';
import { lockFileAsync, unlockFileAsync } from '@studio/common/lib/lockfile';
import { __ } from '@wordpress/i18n';
import {
	validateStudioChatFiles,
	type StudioChatFileAttachment,
} from '@studio/agent/protocol/chat-files';
import { checkClaudeNativePath, isJudgeable } from './local-paths';

export class ClaudeAttachmentError extends Error {}

const storedName = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:\.[a-z0-9]{1,12})?$/;
const samePath = ( a: string, b: string ) => path.relative( a, b ) === '';

/** Only files Studio staged for this conversation are additional Read targets. */
export async function isStoredClaudeAttachment(
	directory: string,
	file: string
): Promise< boolean > {
	if (
		! isJudgeable( file ) ||
		! samePath( path.dirname( file ), directory ) ||
		! storedName.test( path.basename( file ) )
	)
		return false;
	try {
		const info = await lstat( file );
		return info.isFile() && info.nlink === 1 && samePath( file, await realpath( file ) );
	} catch {
		return false;
	}
}

export async function withClaudeAttachmentLock< T >(
	directory: string,
	action: () => Promise< T >
): Promise< T > {
	if ( ! samePath( await realpath( directory ), directory ) )
		throw new ClaudeAttachmentError( __( 'The attachment folder is unavailable.' ) );
	const lock = path.join( directory, '.attachments.lock' );
	await lockFileAsync( lock, { stale: LOCKFILE_STALE_TIME, wait: LOCKFILE_WAIT_TIME } );
	try {
		return await action();
	} finally {
		await unlockFileAsync( lock );
	}
}

/** Reserve before handing the run to the child. A synchronous launch failure restores only this caller's drafts. */
export async function startWithClaudeAttachments< T >(
	directory: string,
	files: readonly StudioChatFileAttachment[] | undefined,
	start: () => T
): Promise< T > {
	const selected = [
		...new Set(
			( files ?? [] )
				.map( ( file ) => file.path )
				.filter( ( file ) => samePath( path.dirname( file ), directory ) )
		),
	];
	if ( ! selected.length ) return start();
	return withClaudeAttachmentLock( directory, async () => {
		const reserved: string[] = [];
		try {
			for ( const file of selected ) {
				if ( ! ( await isStoredClaudeAttachment( directory, file ) ) )
					throw new ClaudeAttachmentError(
						__( 'This attachment is unavailable. Pick the file again.' )
					);
				try {
					await rename( file + '.draft', file + '.submitted' );
					reserved.push( file );
				} catch ( error ) {
					// Previously submitted files and files staged by older versions have no draft marker.
					if ( ( error as NodeJS.ErrnoException ).code !== 'ENOENT' ) throw error;
				}
			}
			return start();
		} catch ( error ) {
			for ( const file of reserved ) await rename( file + '.submitted', file + '.draft' );
			throw error;
		}
	} );
}

export async function prepareClaudeAttachments(
	files: StudioChatFileAttachment[] | undefined,
	directory: string,
	roots: string[],
	configDirectory: string
) {
	const stagedFiles: string[] = [];
	const lines: string[] = [];
	for ( const file of validateStudioChatFiles( files ) ) {
		let readable = file.path;
		if ( await isStoredClaudeAttachment( directory, file.path ) ) {
			stagedFiles.push( path.basename( file.path ) );
		} else {
			const checked = await checkClaudeNativePath(
				'Read',
				file.path,
				roots,
				configDirectory,
				async () => false
			);
			if ( 'refusal' in checked )
				throw new ClaudeAttachmentError(
					__( 'This attachment is outside the readable workspace. Pick the file in the composer.' )
				);
			readable = checked.path;
		}
		lines.push( JSON.stringify( { name: file.name, path: readable } ) );
	}
	await startWithClaudeAttachments( directory, files, () => undefined );
	return {
		stagedFiles,
		prompt: lines.length ? '\n\nAttached files (read them as needed):\n' + lines.join( '\n' ) : '',
	};
}
