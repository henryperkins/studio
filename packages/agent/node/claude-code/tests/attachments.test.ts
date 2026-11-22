import { randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { isStoredClaudeAttachment, prepareClaudeAttachments } from '../attachments';
import { createNativeSessionStore, getClaudeAttachmentDirectory } from '../sessions';

let root: string, workspace: string, directory: string;
beforeEach( async () => {
	root = await realpath( await mkdtemp( path.join( tmpdir(), 'studio-chat-files-' ) ) );
	workspace = path.join( root, 'site' );
	directory = getClaudeAttachmentDirectory( root, 'conversation' );
	await mkdir( workspace );
	await mkdir( directory );
} );
afterEach( async () => {
	await rm( root, { recursive: true, force: true } );
} );
const pick = ( file: string ) => ( { id: 'file', name: 'Brief.md', path: file } );
const prepare = ( file: string ) =>
	prepareClaudeAttachments(
		[ pick( file ) ],
		directory,
		[ workspace ],
		path.join( root, 'config' )
	);

it( 'reopens a staged file for its conversation and removes it when the conversation is deleted', async () => {
	const file = path.join( directory, randomUUID() + '.md' );
	await writeFile( file, 'Original brief' );
	expect( ( await prepare( file ) ).prompt ).toContain(
		JSON.stringify( { name: 'Brief.md', path: file } )
	);
	expect(
		await isStoredClaudeAttachment( getClaudeAttachmentDirectory( root, 'another' ), file )
	).toBe( false );
	await expect(
		prepareClaudeAttachments(
			[ pick( file ) ],
			getClaudeAttachmentDirectory( root, 'another' ),
			[ workspace ],
			path.join( root, 'config' )
		)
	).rejects.toThrow( 'Pick the file' );
	await createNativeSessionStore( root ).clearConversation( 'conversation', async () => {} );
	await expect( readFile( file ) ).rejects.toMatchObject( { code: 'ENOENT' } );
} );
it( 'admits existing workspace files and refuses unselected files, protected paths, directories and hard links', async () => {
	const owned = path.join( workspace, 'notes.txt' );
	const external = path.join( root, 'external.txt' );
	const protectedFile = path.join( workspace, '.env' );
	await Promise.all(
		[ owned, external, protectedFile ].map( ( file ) => writeFile( file, 'test' ) )
	);
	expect( ( await prepare( owned ) ).prompt ).toContain( JSON.stringify( owned ) );
	const alias = path.join( directory, randomUUID() + '.txt' );
	await link( external, alias );
	for ( const file of [
		external,
		protectedFile,
		directory,
		alias,
		path.join( workspace, 'missing' ),
	] )
		await expect( prepare( file ) ).rejects.toThrow( 'Pick the file' );
} );
