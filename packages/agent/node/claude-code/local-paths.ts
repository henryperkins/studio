import { lstat, realpath, stat } from 'fs/promises';
import path from 'path';
import {
	getAppConfigPath,
	getCliConfigPath,
	getConfigDirectory,
	getSessionsDirectory,
	getSharedConfigPath,
} from '@studio/common/lib/well-known-paths';
import { getFileWriteRefusal } from '../runtime/tool-safety';
import { getSkillsRoot } from '../skills';
import { getClaudeGlobalWorkspace, getClaudeSessionStoreRoot } from './sessions';

export function isInside( root: string, candidate: string ): boolean {
	const relative = path.relative( root, candidate );
	return (
		relative === '' ||
		( relative !== '..' &&
			! relative.startsWith( '..' + path.sep ) &&
			! path.isAbsolute( relative ) )
	);
}

const sensitiveNames = [
	'.env',
	'.env.*',
	'wp-config.php',
	'.ssh',
	'database',
	'*secret*',
	'*credential*',
	'*.pem',
	'*.key',
	'*.p12',
	'*.pfx',
];
const sensitiveComponents = sensitiveNames.map(
	( name ) =>
		new RegExp( '^' + name.replace( /\./g, '\\.' ).replace( /\*/g, '[\\s\\S]*' ) + '$', 'i' )
);

function isSensitivePath( candidate: string ): boolean {
	return candidate
		.split( /[\\/]/ )
		.some( ( part ) => sensitiveComponents.some( ( name ) => name.test( part ) ) );
}

/** Deny matching files and entire matching directories even on case-sensitive volumes. */
export function getClaudeSensitiveReadDenyRules(): string[] {
	return sensitiveNames.flatMap( ( name ) => {
		const pattern = name.replace(
			/[a-z]/g,
			( letter ) => `[${ letter }${ letter.toUpperCase() }]`
		);
		const spellings = pattern.startsWith( '*' ) ? [ pattern, '.' + pattern ] : [ pattern ];
		return spellings.flatMap( ( entry ) => [ `Read(**/${ entry })`, `Read(**/${ entry }/**)` ] );
	} );
}

// Whether a path is one these checks judge: absolute, with no `..` segment by
// either separator, and on Windows with no colon but the drive's. A check
// collapses `..` before it resolves anything, while macOS and Linux resolve it
// after following the link before it, so a path judged inside could lead out.
// On Windows a colon anywhere but the drive names an NTFS stream or a device:
// `link:s.zip` opens a stream of whatever `link` leads to, though neither
// `realpath` nor `lstat` of that name finds anything to resolve.
export function isJudgeable( file: string ): boolean {
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

const nativeRefusals = {
	path: 'Use an absolute path inside the conversation’s folders without a parent traversal.',
	link: 'This link cannot be resolved inside the conversation’s folders. Use a file or folder directly inside them.',
	hardLink:
		'Choose a file with only one hard link. This file also has another name, which may be outside the conversation.',
	windows:
		'Choose a plain Windows filename without a reserved device name, stream, trailing dot or trailing space.',
	protected:
		'Choose a path outside native or Studio configuration and files that may hold credentials.',
	folder: 'Choose an existing directory inside the conversation’s folders.',
	file: 'Choose a regular file inside the conversation’s folders.',
	core: 'A WordPress update replaces this Studio site’s core files. Make the change in wp-content/ in a theme or plugin.',
};

function isReservedWindowsPath( file: string ): boolean {
	if (
		/^[\\/]{2}[?.][\\/]/.test( file ) ||
		file.replace( /^[a-z]:(?=[\\/])/i, '' ).includes( ':' )
	)
		return true;
	return file
		.split( /[\\/]/ )
		.some(
			( part ) =>
				part !== '.' &&
				part !== '..' &&
				( /[. ]$/.test( part ) ||
					/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|(?:com|lpt)[1-9¹²³]) *(?:\.|$)/i.test(
						part
					) )
		);
}

/** Checks the destination used by the SDK, including a new file's nearest existing parent. */
export async function checkClaudeNativePath(
	tool: string,
	file: string,
	roots: readonly string[],
	configDirectory: string,
	isStudioSite: ( folder: string ) => Promise< boolean >,
	workingDirectory?: string
): Promise< { path: string } | { refusal: string } > {
	const outputDirectory = tool === 'WpCliWriteDirectory';
	const writes = tool === 'Write' || tool === 'Edit' || outputDirectory;
	const requiresFile = tool === 'Write' || tool === 'Edit' || tool === 'Read';
	const requiresFolder = outputDirectory || tool === 'Glob' || tool === 'Ls';
	const search = requiresFolder || tool === 'Grep';
	if ( process.platform === 'win32' ) {
		if ( isReservedWindowsPath( file ) ) return { refusal: nativeRefusals.windows };
		// Resolving an unselected UNC share would initiate a network request.
		if ( /^[\\/]/.test( file ) ) {
			const selectedShare =
				/^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test( file ) &&
				roots.some( ( root ) => isInside( root, file ) );
			if ( ! selectedShare ) return { refusal: nativeRefusals.path };
		}
	}
	if (
		! path.isAbsolute( file ) &&
		search &&
		workingDirectory &&
		path.isAbsolute( workingDirectory )
	) {
		if ( ! file || file.split( /[\\/]/ ).includes( '..' ) || /^[a-z]:/i.test( file ) )
			return { refusal: nativeRefusals.path };
		file = path.join( workingDirectory, file );
	}
	if ( ! isJudgeable( file ) ) return { refusal: nativeRefusals.path };
	const resolved = await resolveDeepest( file );
	if ( ! resolved ) return { refusal: nativeRefusals.link };
	if ( ! roots.some( ( root ) => isInside( root, resolved ) ) ) {
		return {
			refusal: roots.some( ( root ) => isInside( root, file ) )
				? nativeRefusals.link
				: nativeRefusals.path,
		};
	}
	if (
		( requiresFile || tool === 'LsEntry' ) &&
		roots.some( ( root ) => path.relative( root, resolved ) === '' )
	)
		return { refusal: nativeRefusals.file };
	if (
		isSensitivePath( file ) ||
		isSensitivePath( resolved ) ||
		isInside( configDirectory, resolved )
	)
		return { refusal: nativeRefusals.protected };
	let info;
	try {
		info = await stat( resolved );
	} catch ( error ) {
		if ( ! writes || ! isMissing( error ) )
			return { refusal: requiresFolder ? nativeRefusals.folder : nativeRefusals.file };
	}
	if ( requiresFolder && ! info?.isDirectory() ) return { refusal: nativeRefusals.folder };
	if ( info && ! info.isFile() && ( requiresFile || ! info.isDirectory() ) )
		return { refusal: nativeRefusals.file };
	if ( info?.isFile() && info.nlink > 1 ) return { refusal: nativeRefusals.hardLink };
	const recursive = ( tool === 'Glob' || tool === 'Grep' ) && info?.isDirectory();
	if ( recursive && isInside( resolved, configDirectory ) )
		return { refusal: nativeRefusals.protected };

	const sessions = getSessionsDirectory();
	const nativeStore = getClaudeSessionStoreRoot( sessions );
	const global = getClaudeGlobalWorkspace( nativeStore );
	const studioRoots = await Promise.all(
		[ getConfigDirectory(), sessions, nativeStore ].map( resolveDeepest )
	);
	if (
		studioRoots.some(
			( root ) =>
				! root || isInside( root, resolved ) || ( recursive && isInside( resolved, root ) )
		)
	) {
		// The global conversation works in its own designated subfolder of Studio's store.
		const canonicalGlobal = await resolveDeepest( global );
		if (
			! isInside( global, resolved ) ||
			! roots.some( ( root ) => path.relative( root, global ) === '' ) ||
			! canonicalGlobal ||
			path.relative( global, canonicalGlobal ) !== ''
		)
			return { refusal: nativeRefusals.protected };
	}
	const stores = [ getSharedConfigPath(), getCliConfigPath(), getAppConfigPath() ];
	const reach = writes ? roots : [ resolved ];
	if (
		! ( await Promise.all( stores.map( ( store ) => isOutsideReach( store, reach ) ) ) ).every(
			Boolean
		)
	)
		return { refusal: nativeRefusals.protected };
	if (
		writes &&
		// An export names its directory; WordPress chooses the file name under it.
		( await getFileWriteRefusal(
			'Write',
			{ path: outputDirectory ? path.join( resolved, 'export.xml' ) : resolved },
			roots[ 0 ],
			isStudioSite
		) )
	)
		return { refusal: nativeRefusals.core };
	return { path: resolved };
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
