import { lstat, mkdir, mkdtemp, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createBrowserFile, openBrowserToolFile } from '../claude-code/browser-tool-files';

const unsafe = () =>
	new Error( 'Use ordinary theme files and directories within the selected site.' );

async function samePath( file: string ) {
	return path.relative( file, await realpath( file ) ) === '';
}

export async function readThemeInput( site: string, file: string ): Promise< string | undefined > {
	const opened = await openBrowserToolFile( site, file ).catch(
		( error: NodeJS.ErrnoException ) => {
			if ( error.code !== 'ENOENT' ) throw unsafe();
			return undefined;
		}
	);
	if ( ! opened ) return undefined;
	await using handle = opened.handle;
	return handle.readFile( 'utf8' );
}

export async function stageClaudeTheme( site: string, slug: string, check: () => void ) {
	check();
	const parent = path.join( site, 'wp-content', 'themes' );
	const destination = path.join( parent, slug );
	if (
		! ( await samePath( parent ) ) ||
		! ( await stat( parent ) ).isDirectory() ||
		/^(con|prn|aux|nul|(?:com|lpt)[1-9])$/i.test( slug )
	)
		throw unsafe();
	const assertNew = async () => {
		const existing = await lstat( destination ).catch( ( error: NodeJS.ErrnoException ) => {
			if ( error.code !== 'ENOENT' ) throw error;
		} );
		if ( existing ) throw new Error( 'A theme with this slug already exists.' );
	};
	await assertNew();
	check();
	const temp = await mkdtemp( path.join( parent, '.studio-scaffold-' ) );
	const identity = await lstat( temp, { bigint: true } );
	let published = false;
	const verify = async () => {
		const current = await lstat( temp, { bigint: true } );
		if (
			! current.isDirectory() ||
			current.dev !== identity.dev ||
			current.ino !== identity.ino ||
			! ( await samePath( temp ) )
		)
			throw unsafe();
	};
	const directory = async ( relative: string ) => {
		check();
		await verify();
		let target = temp;
		for ( const part of relative.split( /[\\/]/ ).filter( Boolean ) ) {
			if (
				! /^[a-z0-9_-]+$/i.test( part ) ||
				/^(?:con|prn|aux|nul|(?:com|lpt)[1-9])$/i.test( part )
			)
				throw unsafe();
			target = path.join( target, part );
			await mkdir( target ).catch( ( error: NodeJS.ErrnoException ) => {
				if ( error.code !== 'EEXIST' ) throw error;
			} );
			if ( ! ( await samePath( target ) ) || ! ( await lstat( target ) ).isDirectory() )
				throw unsafe();
		}
		check();
		return target;
	};
	return {
		directory,
		async write( relative: string, data: Buffer | string ) {
			const name = path.basename( relative );
			if ( ! /^[a-z0-9_-]+\.(?:css|json|php|html|woff2)$/i.test( name ) ) throw unsafe();
			const dir = path.dirname( relative );
			const target = await directory( dir === '.' ? '' : dir );
			await verify();
			await createBrowserFile( temp, path.join( target, name ), data, check );
		},
		async publish() {
			await verify();
			await assertNew();
			check();
			await rename( temp, destination );
			published = true;
		},
		async [ Symbol.asyncDispose ]() {
			if ( ! published ) {
				await verify();
				await rm( temp, { recursive: true, force: true } );
			}
		},
	};
}
