import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { getLocalMediaMimeType } from '@studio/common/lib/media-mime';
import { resolveMigratedAiSessionsPath } from '@studio/agent/node/sessions/root-migration';
import { openBrowserToolFile } from './claude-code/browser-tool-files';
import { claudeScreenshotDirectory } from './claude-code/screenshot-directory';

export async function openClaudeScreenshot(
	sessionsRoot: string,
	conversationId: string,
	requested: string
) {
	if (
		! /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test( conversationId ) ||
		! path.isAbsolute( requested )
	)
		return null;
	const name = path.basename( requested );
	if ( ! /^[a-z0-9_-]+\.(?:png|jpe?g|webp)$/i.test( name ) ) return null;
	const directory = await claudeScreenshotDirectory( sessionsRoot, conversationId, false ).catch(
		() => null
	);
	if ( ! directory ) return null;
	const relative = path.relative( sessionsRoot, requested );
	const canonicalRoot = await realpath( sessionsRoot );
	if ( path.relative( directory, path.join( canonicalRoot, path.dirname( relative ) ) ) !== '' )
		return null;
	const opened = await openBrowserToolFile( directory, path.join( directory, name ) ).catch(
		() => null
	);
	return (
		opened && {
			handle: opened.handle,
			size: Number( opened.info.size ),
			mimeType: getLocalMediaMimeType( name ),
			root: sessionsRoot,
		}
	);
}

// Raster formats only: an SVG served from the `studio ui` API origin could run
// scripts there, and the UI only renders local media as <img>.
const LOCAL_MEDIA_MIME_TYPES = new Set( [
	'image/png',
	'image/jpeg',
	'image/webp',
	'image/gif',
	'image/avif',
] );

/**
 * Resolves an image the agent wrote (screenshots in the sessions folder,
 * generated images in a site) when its path lies inside one of `roots`, or null.
 * Symlinks are followed, so a theme or uploads folder linked in from elsewhere
 * still works. Session screenshots must remain plain files in their sidecar.
 * A path under a pre-migration sessions folder resolves to its new
 * location.
 */
export async function openLocalMediaFile( requested: string, roots: string[] ) {
	const mimeType = getLocalMediaMimeType( requested );
	if ( ! LOCAL_MEDIA_MIME_TYPES.has( mimeType ) ) {
		return null;
	}
	for ( const candidate of new Set( [ requested, resolveMigratedAiSessionsPath( requested ) ] ) ) {
		for ( const root of roots ) {
			const file = path.resolve( root, candidate );
			const relative = path.relative( root, file );
			if (
				! relative ||
				relative === '..' ||
				relative.startsWith( `..${ path.sep }` ) ||
				path.isAbsolute( relative )
			) {
				continue;
			}
			const isScreenshot = relative
				.split( path.sep )
				.some( ( component ) => component.toLowerCase().endsWith( '.screenshots' ) );
			if ( isScreenshot ) {
				if ( ! path.dirname( relative ).toLowerCase().endsWith( '.screenshots' ) ) return null;
				const canonicalRoot = await realpath( root ).catch( () => null );
				if ( ! canonicalRoot ) continue;
				const opened = await openBrowserToolFile(
					canonicalRoot,
					path.join( canonicalRoot, relative )
				).catch( () => null );
				if ( opened )
					return { handle: opened.handle, mimeType, size: Number( opened.info.size ), root };
				continue;
			}
			const handle = await open( file, constants.O_RDONLY | constants.O_NONBLOCK ).catch(
				() => null
			);
			if ( ! handle ) continue;
			try {
				const info = await handle.stat();
				if ( info.isFile() ) return { handle, mimeType, size: info.size, root };
			} catch ( error ) {
				await handle.close();
				throw error;
			}
			await handle.close();
		}
	}
	return null;
}
