import { realpath } from 'fs/promises';
import path from 'path';
import { getSkillsRoot } from '../skills';

export function isInside( root: string, candidate: string ): boolean {
	const relative = path.relative( root, candidate );
	return (
		relative === '' ||
		( relative !== '..' &&
			! relative.startsWith( '..' + path.sep ) &&
			! path.isAbsolute( relative ) )
	);
}

function isSensitivePath( candidate: string ): boolean {
	return candidate
		.split( /[\\/]/ )
		.some( ( part ) =>
			/^(?:\.env(?:\..*)?|wp-config\.php|\.credentials(?:\..*)?|\.ssh|database|.*secret.*|.*credential.*|.*\.(?:pem|key|p12|pfx))$/i.test(
				part
			)
		);
}

/**
 * Whether a native file tool may reach an existing path: inside one of the
 * canonical roots, outside the native configuration and clear of files that
 * commonly hold credentials.
 */
export async function isAllowedNativePath(
	file: string,
	roots: readonly string[],
	configDirectory: string,
	allowRoot = false
): Promise< boolean > {
	if ( ! path.isAbsolute( file ) ) return false;
	try {
		const canonical = await realpath( file );
		return (
			roots.some(
				( root ) => isInside( root, canonical ) && ( allowRoot || canonical !== root )
			) &&
			! isInside( configDirectory, canonical ) &&
			! isSensitivePath( file ) &&
			! isSensitivePath( canonical )
		);
	} catch {
		return false;
	}
}

// Where a path, which may not exist yet, leads once its deepest existing part
// is resolved through every link, junction and short name; undefined when that
// part cannot be read.
async function resolveDeepest( file: string ): Promise< string | undefined > {
	if ( ! path.isAbsolute( file ) ) return;
	const missing: string[] = [];
	for ( let current = path.resolve( file ); ; current = path.dirname( current ) ) {
		try {
			return path.join( await realpath( current ), ...missing );
		} catch ( error ) {
			if (
				( error as NodeJS.ErrnoException ).code !== 'ENOENT' ||
				path.dirname( current ) === current
			)
				return;
			missing.unshift( path.basename( current ) );
		}
	}
}

/**
 * Whether a path, which may not exist yet, lies in a canonical root once its
 * deepest existing folder is resolved.
 */
export async function isInsideCanonicalRoot( root: string, file: string ): Promise< boolean > {
	const resolved = await resolveDeepest( file );
	return resolved !== undefined && isInside( root, resolved );
}

/**
 * Whether a host operation may write a file, which may not exist yet: once its
 * deepest existing folder is resolved, inside one of the canonical roots but
 * not a root itself, outside the native configuration, and clear of names
 * that commonly hold credentials.
 */
export async function isAllowedNewPath(
	file: string,
	roots: readonly string[],
	configDirectory: string
): Promise< boolean > {
	const resolved = await resolveDeepest( file );
	return (
		resolved !== undefined &&
		roots.some( ( root ) => isInside( root, resolved ) && resolved !== root ) &&
		! isInside( configDirectory, resolved ) &&
		! isSensitivePath( file ) &&
		! isSensitivePath( resolved )
	);
}

/**
 * Whether a folder holds only files Studio ships itself: it resolves inside
 * Studio's own bundled skills, which lie outside, and hold none of, the
 * folders `reachable` names, so nothing a conversation writes can be in it.
 */
export async function isBundledFolder(
	folder: string,
	reachable: readonly string[]
): Promise< boolean > {
	if ( ! path.isAbsolute( folder ) ) return false;
	try {
		const [ canonical, bundle ] = await Promise.all( [
			realpath( folder ),
			realpath( getSkillsRoot() ),
		] );
		return (
			isInside( bundle, canonical ) &&
			! reachable.some( ( root ) => isInside( root, bundle ) || isInside( bundle, root ) )
		);
	} catch {
		return false;
	}
}
