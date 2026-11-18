import { randomUUID } from 'node:crypto';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { isInside, isJudgeable } from './local-paths';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

const changed = () =>
	new Error( 'The browser tool file or its directory changed. Check the selected file and retry.' );
const samePath = ( file: string, canonical: string ) => path.relative( file, canonical ) === '';
const sameFile = ( a: BigIntStats, b: BigIntStats ) => a.ino === b.ino && a.dev === b.dev;

async function inspect( root: string, file: string, optional = false ) {
	if (
		! isJudgeable( file ) ||
		! isInside( root, file ) ||
		samePath( root, file ) ||
		! samePath( root, await realpath( root ) ) ||
		! samePath( path.dirname( file ), await realpath( path.dirname( file ) ) )
	)
		throw changed();
	const info = await lstat( file, { bigint: true } ).catch( ( error: NodeJS.ErrnoException ) => {
		if ( optional && error.code === 'ENOENT' ) return undefined;
		throw error;
	} );
	if (
		info &&
		( ! info.isFile() || info.nlink !== BigInt( 1 ) || ! samePath( file, await realpath( file ) ) )
	)
		throw changed();
	return info;
}

async function verifyHandle(
	handle: FileHandle,
	file: string,
	root: string,
	expected?: BigIntStats
) {
	const info = await inspect( root, file );
	const opened = await handle.stat( { bigint: true } );
	if (
		! info ||
		opened.nlink !== BigInt( 1 ) ||
		! sameFile( info, opened ) ||
		( expected && ! sameFile( expected, opened ) )
	)
		throw changed();
}

export async function openBrowserToolFile( root: string, file: string ) {
	const info = await inspect( root, file );
	if ( ! info ) throw changed();
	const handle = await open( file, 'r' );
	try {
		await verifyHandle( handle, file, root, info );
		return { info, handle };
	} catch ( error ) {
		await handle.close();
		throw error;
	}
}

export async function readBrowserToolFile( root: string, file: string ) {
	const opened = await openBrowserToolFile( root, file );
	await using handle = opened.handle;
	return { info: opened.info, bytes: await handle.readFile() };
}

export async function createBrowserFile(
	root: string,
	file: string,
	bytes: Buffer | string,
	check: () => void
) {
	if ( await inspect( root, file, true ) ) throw changed();
	check();
	await using handle = await open( file, 'wx' );
	const opened = await handle.stat( { bigint: true } );
	const discard = async () => {
		const info = await inspect( root, file, true );
		if ( info && sameFile( info, opened ) ) await rm( file );
	};
	try {
		await verifyHandle( handle, file, root );
		check();
		await handle.writeFile( bytes );
		check();
		return discard;
	} catch ( error ) {
		await discard();
		throw error;
	}
}

export async function writeBrowserToolFile(
	root: string,
	file: string,
	bytes: Buffer | string,
	check: () => void,
	previous?: Awaited< ReturnType< typeof readBrowserToolFile > >
) {
	check();
	const before = await inspect( root, file, true );
	if ( previous?.info && ( ! before || ! sameFile( before, previous.info ) ) ) throw changed();
	if ( ! before ) {
		return createBrowserFile( root, file, bytes, check );
	}

	const staged = path.join( path.dirname( file ), `.studio-${ randomUUID() }.tmp` );
	await using temp = await open( staged, 'wx', Number( before.mode ) & 0o777 );
	try {
		await verifyHandle( temp, staged, root );
		await temp.writeFile( bytes );
		const latest = await inspect( root, file );
		if ( ! latest || ! sameFile( before, latest ) ) throw changed();
		if ( previous ) {
			const current = await readBrowserToolFile( root, file );
			if ( ! current.bytes.equals( previous.bytes ) ) throw changed();
		}
		await verifyHandle( temp, staged, root );
		check();
		await rename( staged, file );
	} finally {
		const rest = await inspect( root, staged, true );
		if ( rest && sameFile( rest, await temp.stat( { bigint: true } ) ) ) await rm( staged );
	}
}
