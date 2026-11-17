import { lstat, realpath } from 'fs/promises';
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

// Whether a path is one these checks judge: absolute, with no `..` segment by
// either separator, and on Windows with no colon but the drive's. A check
// collapses `..` before it resolves anything, while macOS and Linux resolve it
// after following the link before it, so a path judged inside could lead out.
// On Windows a colon anywhere but the drive names an NTFS stream or a device:
// `link:s.zip` opens a stream of whatever `link` leads to, though neither
// `realpath` nor `lstat` of that name finds anything to resolve.
function isJudgeable( file: string ): boolean {
	return (
		path.isAbsolute( file ) &&
		! file.split( /[\\/]/ ).includes( '..' ) &&
		( process.platform !== 'win32' || ! file.replace( /^[a-z]:(?=[\\/])/i, '' ).includes( ':' ) )
	);
}

/**
 * The path an existing file resolves to through every link, junction and short
 * name, when a native file tool or a host operation may reach it: inside one of
 * the canonical roots, outside the native configuration and clear of files
 * that commonly hold credentials. Undefined otherwise.
 */
export async function resolveAllowedPath(
	file: string,
	roots: readonly string[],
	configDirectory: string,
	allowRoot = false
): Promise< string | undefined > {
	if ( ! isJudgeable( file ) ) return;
	let canonical: string;
	try {
		canonical = await realpath( file );
	} catch {
		return;
	}
	return roots.some(
		( root ) => isInside( root, canonical ) && ( allowRoot || canonical !== root )
	) &&
		! isInside( configDirectory, canonical ) &&
		! isSensitivePath( file ) &&
		! isSensitivePath( canonical )
		? canonical
		: undefined;
}

/** Whether a native file tool may reach an existing path (`resolveAllowedPath`). */
export async function isAllowedNativePath(
	file: string,
	roots: readonly string[],
	configDirectory: string,
	allowRoot = false
): Promise< boolean > {
	return ( await resolveAllowedPath( file, roots, configDirectory, allowRoot ) ) !== undefined;
}

const isMissing = ( error: unknown ) => ( error as NodeJS.ErrnoException )?.code === 'ENOENT';

// Where a path, which may not exist yet, leads once its deepest existing part
// is resolved through every link, junction and short name; undefined when that
// part cannot be read. A link whose target does not exist is there, not
// missing: a write would follow it wherever it points, so it is refused.
async function resolveDeepest( file: string ): Promise< string | undefined > {
	if ( ! isJudgeable( file ) ) return;
	const missing: string[] = [];
	for ( let current = path.resolve( file ); ; current = path.dirname( current ) ) {
		try {
			return path.join( await realpath( current ), ...missing );
		} catch ( error ) {
			if ( ! isMissing( error ) || path.dirname( current ) === current ) return;
		}
		try {
			await lstat( current );
			return;
		} catch ( error ) {
			if ( ! isMissing( error ) ) return;
		}
		missing.unshift( path.basename( current ) );
	}
}

/**
 * Whether a file Studio keeps for itself is out of the conversation's reach:
 * once its deepest existing part is resolved, it lies outside every folder
 * `reachable` names. A file that does not exist yet counts by where it would
 * be; a path no check can judge does not count.
 */
export async function isOutsideReach(
	file: string,
	reachable: readonly string[]
): Promise< boolean > {
	const resolved = await resolveDeepest( file );
	return resolved !== undefined && ! reachable.some( ( root ) => isInside( root, resolved ) );
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
 * The path a file, which may not exist yet, resolves to once its deepest
 * existing folder is resolved, when a host operation may write it: inside one
 * of the canonical roots but not a root itself, outside the native
 * configuration, and clear of names that commonly hold credentials. Undefined
 * otherwise.
 */
export async function resolveAllowedNewPath(
	file: string,
	roots: readonly string[],
	configDirectory: string
): Promise< string | undefined > {
	const resolved = await resolveDeepest( file );
	return resolved !== undefined &&
		roots.some( ( root ) => isInside( root, resolved ) && resolved !== root ) &&
		! isInside( configDirectory, resolved ) &&
		! isSensitivePath( file ) &&
		! isSensitivePath( resolved )
		? resolved
		: undefined;
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
