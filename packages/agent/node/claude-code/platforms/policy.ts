import type {
	ClaudeFileAccess,
	ClaudeManagedPolicyFinding,
	ClaudeManagedPolicySource,
} from '../platform';
import type { PlatformPath } from 'path';

/** The documented file-based policy entries in a managed settings directory. */
export function managedPolicyFiles(
	directory: string,
	pathModule: PlatformPath
): ClaudeManagedPolicySource[] {
	return [
		{
			kind: 'settings-file',
			scope: 'machine',
			location: pathModule.join( directory, 'managed-settings.json' ),
		},
		{
			kind: 'settings-directory',
			scope: 'machine',
			location: pathModule.join( directory, 'managed-settings.d' ),
		},
		{
			kind: 'mcp-file',
			scope: 'machine',
			location: pathModule.join( directory, 'managed-mcp.json' ),
		},
	];
}

/**
 * Whether each location exists, by its directory entry alone: a symlink counts
 * as deployed wherever it leads, and no file is opened or read.
 */
export async function findPolicyLocations(
	sources: ClaudeManagedPolicySource[],
	files: ClaudeFileAccess
): Promise< Pick< ClaudeManagedPolicyFinding, 'present' | 'unreadable' > > {
	const present: ClaudeManagedPolicySource[] = [];
	const unreadable: ClaudeManagedPolicySource[] = [];
	for ( const source of sources ) {
		try {
			await files.lstat( source.location );
			present.push( source );
		} catch ( error ) {
			const code = ( error as { code?: unknown } ).code;
			if ( code !== 'ENOENT' && code !== 'ENOTDIR' ) unreadable.push( source );
		}
	}
	return { present, unreadable };
}

export function policyFinding(
	checked: ClaudeManagedPolicySource[],
	present: ClaudeManagedPolicySource[],
	unreadable: ClaudeManagedPolicySource[]
): ClaudeManagedPolicyFinding {
	let state: ClaudeManagedPolicyFinding[ 'state' ] = 'absent';
	if ( present.length ) state = 'present';
	else if ( unreadable.length ) state = 'unverifiable';
	return { state, present, unreadable, checked };
}
