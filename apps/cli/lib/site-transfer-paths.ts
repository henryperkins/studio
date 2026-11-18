import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, mkdtemp, open, readdir, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import { __ } from '@wordpress/i18n';
import { LoggerError } from 'cli/logger';
import type { HostOperationOptions } from '@studio/agent/node';
import type { Archiver, ZipEntryData } from 'archiver';

type SiteTransfer = NonNullable< HostOperationOptions[ 'siteTransfer' ] > & {
	signal?: AbortSignal;
};

// The CLI host runs commands in-process. Concurrent ordinary CLI operations
// must keep their support for linked development plugins and themes.
const transfer = new AsyncLocalStorage< SiteTransfer & { canonicalTemp: string } >();

export function hasSiteTransferScope(): boolean {
	return transfer.getStore() !== undefined;
}

export function unsafeTransfer(): LoggerError {
	return new LoggerError(
		__(
			'Use an archive and site containing ordinary files and folders. This transfer cannot follow links or copy special files.'
		),
		undefined,
		'unsafe_site_transfer'
	);
}

async function plainPath( file: string, allowMissing: boolean ) {
	transfer.getStore()?.signal?.throwIfAborted();
	const stat = await lstat( file ).catch( ( error: NodeJS.ErrnoException ) => {
		if ( allowMissing && error.code === 'ENOENT' ) return undefined;
		throw error;
	} );
	if ( stat ) {
		const scope = transfer.getStore();
		// macOS exposes its system temporary folder through /var -> /private/var.
		// Only substitute that known prefix, leaving every component below it checked.
		const relativeTemp = path.relative( os.tmpdir(), file );
		const expected =
			scope &&
			scope.canonicalTemp !== os.tmpdir() &&
			relativeTemp !== '..' &&
			! relativeTemp.startsWith( '..' + path.sep ) &&
			! path.isAbsolute( relativeTemp )
				? path.join( scope.canonicalTemp, relativeTemp )
				: file;
		if (
			stat.isSymbolicLink() ||
			( ! stat.isDirectory() && ( ! stat.isFile() || stat.nlink !== 1 ) ) ||
			path.relative( expected, await realpath( file ) ) !== ''
		)
			throw unsafeTransfer();
	} else {
		const parent = path.dirname( file );
		if ( parent === file ) throw unsafeTransfer();
		await plainPath( parent, true );
	}
	return stat;
}

export async function checkTransferFile( file: string, allowMissing = false ): Promise< void > {
	if ( hasSiteTransferScope() ) await plainPath( file, allowMissing );
}

export async function createTransferDirectory( parent: string, prefix: string ) {
	await checkTransferFile( parent );
	const directory = await mkdtemp( path.join( await realpath( parent ), prefix ) );
	const initial = await lstat( directory, { bigint: true } );
	return {
		path: directory,
		async [ Symbol.asyncDispose ]() {
			const current = await lstat( directory, { bigint: true } ).catch(
				( error: NodeJS.ErrnoException ) => {
					if ( error.code !== 'ENOENT' ) throw error;
				}
			);
			if ( ! current ) return;
			if (
				! current.isDirectory() ||
				current.dev !== initial.dev ||
				current.ino !== initial.ino ||
				path.relative( directory, await realpath( directory ) ) !== ''
			)
				throw unsafeTransfer();
			await rm( directory, { recursive: true, force: true } );
		},
	};
}

// Check the opened identity before reading or truncating; another process may have replaced the path.
export async function openTransferFile( file: string, write = false ) {
	const initial = await plainPath( file, write );
	if ( initial && ! initial.isFile() ) throw unsafeTransfer();
	const handle = await open( file, write ? ( initial ? 'r+' : 'wx' ) : 'r' );
	try {
		const opened = await handle.stat();
		const current = await plainPath( file, false );
		if (
			! current?.isFile() ||
			opened.dev !== current.dev ||
			opened.ino !== current.ino ||
			opened.nlink !== 1 ||
			( initial && ( opened.dev !== initial.dev || opened.ino !== initial.ino ) )
		)
			throw unsafeTransfer();
		if ( write ) await handle.truncate();
		return handle;
	} catch ( error ) {
		await handle.close();
		throw error;
	}
}

export async function copyTransferFile( from: string, to: string ): Promise< void > {
	await using source = await openTransferFile( from );
	await using dest = await openTransferFile( to, true );
	await pipeline( source.createReadStream(), dest.createWriteStream(), {
		signal: transfer.getStore()?.signal,
	} );
}

/** Archiver.file opens a path later. In a bounded transfer give it the already checked file handle. */
export async function appendTransferFile(
	archive: Archiver,
	file: string,
	entry: ZipEntryData,
	exclude?: { dev: bigint; ino: bigint }
): Promise< void > {
	if ( ! hasSiteTransferScope() ) {
		if ( exclude ) {
			const source = await stat( file, { bigint: true } );
			if ( source.dev === exclude.dev && source.ino === exclude.ino ) return;
		}
		archive.file( file, entry );
		return;
	}
	await using handle = await openTransferFile( file );
	if ( exclude ) {
		const source = await handle.stat( { bigint: true } );
		if ( source.dev === exclude.dev && source.ino === exclude.ino ) return;
	}
	const opened = await handle.stat();
	const data = handle.createReadStream( { signal: transfer.getStore()?.signal } );
	const fail = ( error: Error ) => data.destroy( error );
	archive.once( 'error', fail );
	try {
		archive.append( data, { ...entry, stats: opened } );
		await finished( data, { cleanup: true } );
	} finally {
		archive.off( 'error', fail );
		data.destroy();
	}
}

export async function checkSiteTransferTree( site: string, includeCore = false ): Promise< void > {
	const scope = transfer.getStore();
	if ( ! scope ) return;
	if ( path.relative( scope.site, site ) !== '' ) throw unsafeTransfer();
	await plainPath( site, false );
	if ( scope.archive ) await plainPath( scope.archive, true );
	for ( const file of [
		'wp-config.php',
		'wp-config-sample.php',
		'wp-includes/version.php',
		'.deployignore',
	] ) {
		await plainPath( path.join( site, file ), true );
	}
	const content = path.join( site, 'wp-content' );
	const directories = [ includeCore ? site : content ];
	while ( directories.length ) {
		const directory = directories.pop()!;
		const directoryStat = await plainPath( directory, directory === content );
		if ( ! directoryStat ) continue;
		for ( const name of await readdir( directory ) ) {
			const file = path.join( directory, name );
			const stat = await plainPath( file, false );
			if ( stat?.isDirectory() ) directories.push( file );
		}
	}
}

export async function withSiteTransfer< T >(
	scope: SiteTransfer,
	run: () => Promise< T >
): Promise< T > {
	return transfer.run( { ...scope, canonicalTemp: await realpath( os.tmpdir() ) }, async () => {
		await checkSiteTransferTree( scope.site );
		return run();
	} );
}

export function isPlainTransferEntry( name: string, ordinaryFileOrDirectory = true ): boolean {
	if ( ! hasSiteTransferScope() ) return true;
	return (
		ordinaryFileOrDirectory &&
		!! name &&
		! /^[\\/]/.test( name ) &&
		! name.includes( '\0' ) &&
		! /[:\\]/.test( name ) &&
		name
			.split( '/' )
			.every(
				( part ) =>
					part !== '..' &&
					( part === '.' ||
						( ! /[. ]$/.test( part ) &&
							! /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|(?:com|lpt)[1-9¹²³]) *(?:\.|$)/i.test(
								part
							) ) )
			)
	);
}

export function requirePlainTransferEntry( name: string, ordinaryFileOrDirectory = true ): void {
	if ( ! isPlainTransferEntry( name, ordinaryFileOrDirectory ) ) throw unsafeTransfer();
}
