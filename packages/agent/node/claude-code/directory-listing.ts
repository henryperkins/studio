import { readdir, stat } from 'fs/promises';
import { Type } from 'typebox';
import { defineTool, READ_ONLY } from '../tools/define-tool';
import { hasOnlyKeys, plainData } from './plain-data';
import type { ClaudeExecutionPolicy } from './execution-policy';

const DIRECTORY_FIELDS = new Set( [ 'path', 'limit' ] );

export function isClaudeDirectoryListInput(
	value: unknown
): value is Record< string, unknown > & { path?: string; limit?: number } {
	const args = plainData( value );
	return (
		!! args &&
		hasOnlyKeys( args, DIRECTORY_FIELDS ) &&
		( args.path === undefined || ( typeof args.path === 'string' && args.path.length > 0 ) ) &&
		( args.limit === undefined ||
			( typeof args.limit === 'number' && Number.isSafeInteger( args.limit ) && args.limit > 0 ) )
	);
}

// Claude's pinned SDK has no LS built-in. Use the same directory formatter and
// truncation as Studio's Pi route, checking each file before asking for its type.
export function createClaudeDirectoryListing(
	resolve?: ClaudeExecutionPolicy[ 'resolveListingPath' ]
) {
	return defineTool(
		'Ls',
		'List the entries of a directory in this workspace, including subdirectories and dotfiles. Directory names end in /. Protected entries are omitted.',
		{
			path: Type.Optional(
				Type.String( {
					minLength: 1,
					description: 'Directory to list. Defaults to the current workspace.',
				} )
			),
			limit: Type.Optional(
				Type.Integer( {
					minimum: 1,
					description: 'Maximum number of entries to return. Defaults to 500.',
				} )
			),
		},
		async ( { path, limit }, { host: { callSignal } } ) => {
			if ( ! resolve ) throw new Error( 'Directory listing requires an active turn.' );
			const permitted = async ( file: string | undefined, entry = false ) => {
				callSignal?.throwIfAborted();
				const checked = await resolve( file, entry );
				if ( 'refusal' in checked ) throw new Error( checked.refusal );
				return checked.path;
			};
			const directory = await permitted( path );
			const { createLsTool } = await import( '@earendil-works/pi-coding-agent' );
			const listing = createLsTool( directory, {
				operations: {
					exists: async ( file ) => ( await permitted( file ) ) === directory,
					readdir: async ( file ) => readdir( await permitted( file ) ),
					stat: async ( file ) => stat( await permitted( file, file !== directory ) ),
				},
			} );
			const result = await listing.execute( 'Ls', { limit }, callSignal );
			return { content: result.content };
		},
		{ annotations: READ_ONLY }
	);
}
