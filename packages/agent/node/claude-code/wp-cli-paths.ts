import { lstat, readdir, realpath } from 'fs/promises';
import path from 'path';
import { checkClaudeNativePath } from './local-paths';
import { WP_CLI_EVAL_FILES } from './wp-cli-command-table';
import { wpCliOption } from './wp-cli-rules';
import type { WpCliFileArgument } from './wp-cli-rules';

const FILE_TOOLS = {
	read: 'Read',
	write: 'Write',
	directory: 'Ls',
	'write-directory': 'WpCliWriteDirectory',
};

async function scriptFileArguments(
	site: string,
	script: string,
	indices: readonly number[]
): Promise< WpCliFileArgument[] | { refusal: string } > {
	let files: WpCliFileArgument[] | undefined;
	for ( const [ name, operands ] of Object.entries( WP_CLI_EVAL_FILES ) ) {
		let installed: string;
		try {
			installed = await realpath( path.join( site, name ) );
		} catch ( error ) {
			if ( [ 'ENOENT', 'ENOTDIR' ].includes( ( error as NodeJS.ErrnoException ).code ?? '' ) )
				continue;
			return { refusal: 'Studio could not check the installed site script.' };
		}
		if ( path.relative( installed, script ) !== '' ) continue;
		if ( files ) return { refusal: 'The installed site scripts resolve to the same file.' };
		files = [];
		for ( const { position, kind } of operands ) {
			const index = indices[ position ];
			if ( index === undefined )
				return { refusal: 'Provide explicit file arguments for this site script.' };
			files.push( { index, kind } );
		}
	}
	return files ?? [];
}

async function isAbsent( file: string ): Promise< boolean > {
	try {
		await lstat( file );
		return false;
	} catch ( error ) {
		return ( error as NodeJS.ErrnoException ).code === 'ENOENT';
	}
}

// WP-CLI substitutes site, date and sequence number. The literal ends of a
// custom template bound the existing filenames that could be overwritten.
function exportMayWrite( template?: string ): ( entry: string ) => boolean {
	if ( ! template )
		return ( entry ) => /\.wordpress\.\d{4}-\d{2}-\d{2}\.\d{3,}\.xml$/i.test( entry );
	const parts = template.split( /\{(?:site|date|n)\}/ );
	if ( parts.length === 1 ) return ( entry ) => entry.toLowerCase() === template;
	return ( entry ) =>
		entry.toLowerCase().startsWith( parts[ 0 ] ) &&
		entry.toLowerCase().endsWith( parts[ parts.length - 1 ] );
}

async function checkExportDirectory(
	directory: string,
	args: readonly string[],
	checkFile: ( name: string ) => Promise< { path: string } | { refusal: string } >
): Promise< { refusal: string } | undefined > {
	const template = wpCliOption( args, 'filename_format' );
	if ( template ) {
		const example = template
			.replace( /\{site\}/g, 'site' )
			.replace( /\{date\}/g, '2000-01-01' )
			.replace( /\{n\}/g, '000' );
		const output = await checkFile( path.join( directory, example ) );
		if ( 'refusal' in output ) return output;
	}
	let entries: string[];
	try {
		entries = await readdir( directory );
	} catch {
		return { refusal: 'Choose an existing export directory that Studio can inspect.' };
	}
	const mayWrite = exportMayWrite( template?.toLowerCase() );
	for ( const entry of entries ) {
		if ( ! mayWrite( entry ) ) continue;
		const name = path.join( directory, entry );
		const output = await checkFile( name );
		if ( 'refusal' in output ) return output;
		if ( path.relative( name, output.path ) !== '' )
			return {
				refusal:
					'An export output name points to a different file. Choose a directory with plain XML output files.',
			};
	}
}

/** Binds each file operand to the selected site, preserving every other WP-CLI argument. */
export async function checkWpCliPaths(
	input: readonly string[],
	files: readonly WpCliFileArgument[],
	site: string,
	config: string,
	isStudioSite: ( folder: string ) => Promise< boolean >
): Promise< { args: string[]; paths: string[] } | { refusal: string } > {
	const args = [ ...input ];
	const paths: string[] = [];
	let implicitDirectory: string | undefined;
	const pending = [ ...files ];
	for ( const { index, prefix = '', kind, reservedPath, evalArgs } of pending ) {
		const argument = input[ index ];
		const defaultExport =
			index === input.length && prefix === '--dir=' && kind === 'write-directory';
		const name = defaultExport
			? site
			: argument?.startsWith( prefix )
			? argument.slice( prefix.length )
			: undefined;
		if (
			! name ||
			name === '-' ||
			name.includes( '\0' ) ||
			name.split( /[\\/]/ ).includes( '..' ) ||
			( ! path.isAbsolute( name ) && /^(?:[a-z][a-z0-9+.-]*:|[~\\])/i.test( name ) )
		)
			return {
				refusal:
					'Use a file or directory in the selected site, without a parent traversal or stream.',
			};
		const absolute = path.isAbsolute( name ) ? name : path.join( site, name );
		if ( reservedPath ) {
			// The importer tries a local mapping file before recognizing its keyword.
			if ( ! ( await isAbsent( absolute ) ) )
				return {
					refusal:
						'A site path shadows the import author option. Choose an explicit author mapping file.',
				};
			continue;
		}
		const checked = await checkClaudeNativePath(
			FILE_TOOLS[ kind ],
			absolute,
			[ site ],
			config,
			isStudioSite
		);
		if ( 'refusal' in checked ) return checked;
		if ( evalArgs ) {
			const more = await scriptFileArguments( site, checked.path, evalArgs );
			if ( 'refusal' in more ) return more;
			pending.push( ...more );
		}
		if ( kind === 'write-directory' ) {
			const denied = await checkExportDirectory( checked.path, input, ( file ) =>
				checkClaudeNativePath( 'Write', file, [ site ], config, isStudioSite )
			);
			if ( denied ) return denied;
		}
		if ( defaultExport ) implicitDirectory = prefix + checked.path;
		else args[ index ] = prefix + checked.path;
		paths.push( checked.path );
	}
	if ( implicitDirectory ) {
		const end = args.indexOf( '--' );
		args.splice( end === -1 ? args.length : end, 0, implicitDirectory );
	}
	return { args, paths };
}
