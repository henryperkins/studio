import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { __ } from '@wordpress/i18n';
import { resolveClaudeSession } from '@studio/agent/protocol/claude-code';
import { loadAiSession } from '../sessions/store';
import { isStoredClaudeAttachment, withClaudeAttachmentLock } from './attachments';
import { checkClaudeNativePath, isInside, isSensitivePath } from './local-paths';
import {
	createNativeSessionStore,
	getClaudeAttachmentDirectory,
	getClaudeSessionStoreRoot,
} from './sessions';

async function attachmentBinding( sessionsRoot: string, sessionId: string ) {
	const { summary, entries } = await loadAiSession( sessionsRoot, sessionId );
	const session = resolveClaudeSession( entries );
	if ( summary.id !== sessionId || summary.backend !== 'claude-code' || ! session ) {
		throw new Error( __( 'Choose a Claude chat before attaching a file.' ) );
	}
	return session.binding;
}

async function openPickedFile(
	file: string,
	name: string,
	config: string,
	sessionsRoot: string,
	size: number
) {
	const rejected = () => new Error( __( 'Choose a regular file outside protected folders.' ) );
	if (
		! path.isAbsolute( file ) ||
		path.basename( file ) !== name ||
		isInside( sessionsRoot, file ) ||
		isInside( getClaudeSessionStoreRoot( sessionsRoot ), file )
	)
		throw rejected();
	const checked = await checkClaudeNativePath(
		'Read',
		file,
		[ path.dirname( file ) ],
		config,
		async () => false
	);
	if ( 'refusal' in checked || path.relative( checked.path, file ) ) throw rejected();
	const before = await lstat( file );
	if ( ! before.isFile() || before.nlink !== 1 || before.size !== size ) throw rejected();
	const handle = await open(
		file,
		constants.O_RDONLY | ( constants.O_NOFOLLOW ?? 0 ) | ( constants.O_NONBLOCK ?? 0 )
	);
	try {
		const actual = await handle.stat();
		if (
			! actual.isFile() ||
			actual.nlink !== 1 ||
			actual.ino !== before.ino ||
			actual.dev !== before.dev ||
			actual.size !== size ||
			path.relative( await realpath( file ), file )
		)
			throw rejected();
		return handle.createReadStream();
	} catch ( error ) {
		await handle.close();
		throw error;
	}
}

/** Writes only an attachment selected for this exact conversation. The raw HTTP body never supplies a host path. */
export async function stageClaudeAttachment(
	sessionsRoot: string,
	sessionId: string,
	name: string,
	size: number,
	source: Readable | Uint8Array | string
): Promise< string > {
	if (
		typeof name !== 'string' ||
		! name.trim() ||
		name === '.' ||
		name === '..' ||
		name !== path.posix.basename( name ) ||
		name !== path.win32.basename( name ) ||
		isSensitivePath( name ) ||
		// eslint-disable-next-line no-control-regex
		/[\u0000-\u001f\u007f]/u.test( name ) ||
		! Number.isSafeInteger( size ) ||
		size < 0
	) {
		throw new Error( __( 'This attachment has an invalid or protected filename or size.' ) );
	}
	const binding = await attachmentBinding( sessionsRoot, sessionId );
	const nativeRoot = getClaudeSessionStoreRoot( sessionsRoot );
	const store = createNativeSessionStore( nativeRoot );
	if ( await store.isPendingDeletion( sessionId ) )
		throw new Error( __( 'This chat is being deleted.' ) );
	const directory = getClaudeAttachmentDirectory( nativeRoot, sessionId );
	const extension = path.extname( name ).toLowerCase();
	const destination = path.join(
		directory,
		randomUUID() + ( /^\.[a-z0-9]{1,12}$/.test( extension ) ? extension : '' )
	);
	const partial = destination + '.partial';
	await mkdir( nativeRoot, { recursive: true, mode: 0o700 } );
	if ( path.relative( nativeRoot, await realpath( nativeRoot ) ) )
		throw new Error( __( 'The attachment folder is unavailable.' ) );
	await mkdir( directory, { recursive: true, mode: 0o700 } );
	if ( path.relative( directory, await realpath( directory ) ) )
		throw new Error( __( 'The attachment folder is unavailable.' ) );

	let received = 0;
	const count = new Transform( {
		transform( chunk: Buffer, _encoding, callback ) {
			received += chunk.length;
			if ( received > size )
				callback( new Error( __( 'The attachment size changed. Pick the file again.' ) ) );
			else callback( null, chunk );
		},
	} );
	const output = await open( partial, 'wx', 0o600 );
	let published = false;
	let markedAsDraft = false;
	try {
		if ( path.relative( partial, await realpath( partial ) ) )
			throw new Error( __( 'The attachment folder is unavailable.' ) );
		const input =
			typeof source === 'string'
				? await openPickedFile( source, name, binding.configDirectory, sessionsRoot, size )
				: source instanceof Uint8Array
				? Readable.from( [ source ] )
				: source;
		await pipeline( input, count, output.createWriteStream() );
		if ( received !== size )
			throw new Error( __( 'The file was only partially uploaded. Pick the file again.' ) );
		await attachmentBinding( sessionsRoot, sessionId );
		if (
			( await store.isPendingDeletion( sessionId ) ) ||
			path.relative( directory, await realpath( directory ) )
		)
			throw new Error( __( 'The attachment folder is unavailable.' ) );
		await writeFile( destination + '.draft', '', { flag: 'wx', mode: 0o600 } );
		markedAsDraft = true;
		await rename( partial, destination );
		published = true;
		if ( await store.isPendingDeletion( sessionId ) )
			throw new Error( __( 'This chat is being deleted.' ) );
		const saved = await lstat( destination );
		if (
			! saved.isFile() ||
			saved.nlink !== 1 ||
			saved.size !== size ||
			path.relative( destination, await realpath( destination ) )
		)
			throw new Error( __( 'The attachment folder is unavailable.' ) );
		return destination;
	} catch ( error ) {
		await output.close();
		if ( markedAsDraft ) await rm( destination + '.draft', { force: true } );
		await rm( published ? destination : partial, { force: true } );
		throw error;
	}
}

async function isDraftMarker( marker: string ): Promise< boolean > {
	try {
		const info = await lstat( marker );
		return info.isFile() && info.nlink === 1 && info.size === 0;
	} catch ( error ) {
		if ( ( error as NodeJS.ErrnoException ).code === 'ENOENT' ) return false;
		throw error;
	}
}

/** Discards only a draft published by this Studio version for this exact chat. */
export async function discardClaudeAttachment(
	root: string,
	id: string,
	file: string
): Promise< void > {
	await attachmentBinding( root, id );
	const nativeRoot = getClaudeSessionStoreRoot( root );
	const directory = getClaudeAttachmentDirectory( nativeRoot, id );
	if ( typeof file !== 'string' || ! ( await isStoredClaudeAttachment( directory, file ) ) ) return;
	const marker = file + '.draft';
	if ( ! ( await isDraftMarker( marker ) ) ) return;
	const journals = await createNativeSessionStore( nativeRoot ).readJournals( id );
	const name = path.basename( file );
	if (
		journals.some( ( events ) =>
			events.some(
				( event ) => event.type === 'turn.prompt' && event.stagedFiles?.includes( name )
			)
		)
	)
		return;
	await withClaudeAttachmentLock( directory, async () => {
		if (
			! ( await isDraftMarker( marker ) ) ||
			! ( await isStoredClaudeAttachment( directory, file ) )
		)
			return;
		await rm( file, { force: true } );
		await rm( marker, { force: true } );
	} );
}
