import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAiSession } from '../../sessions/store';
import { startWithClaudeAttachments } from '../attachments';
import {
	createNativeSessionStore,
	getClaudeAttachmentDirectory,
	getClaudeSessionStoreRoot,
} from '../sessions';
import { discardClaudeAttachment, stageClaudeAttachment } from '../stage-attachment';

let directory: string, root: string, id: string, otherId: string;
beforeEach( async () => {
	directory = await realpath( await mkdtemp( path.join( os.tmpdir(), 'studio-picked-files-' ) ) );
	vi.stubEnv( 'DEV_CONFIG_DIR', path.join( directory, 'studio' ) );
	root = path.join( directory, 'studio', 'sessions' );
	const binding = {
		connectionId: 'account',
		siteId: null,
		workingDirectory: directory,
		configDirectory: path.join( directory, 'claude' ),
	};
	await mkdir( binding.configDirectory );
	const draft = {
		claude: { binding, selection: { model: 'claude-model', effort: 'medium' as const } },
	};
	id = ( await createAiSession( root, draft ) ).id;
	otherId = ( await createAiSession( root, draft ) ).id;
} );
afterEach( async () => {
	vi.unstubAllEnvs();
	await rm( directory, { recursive: true, force: true } );
} );

it( 'streams a file larger than the JSON budget into only the selected conversation and accepts empty files', async () => {
	const chunk = Buffer.alloc( 1024 * 1024, 17 );
	const file = await stageClaudeAttachment(
		root,
		id,
		'Design notes.MD',
		13 * chunk.length,
		Readable.from( Array( 13 ).fill( chunk ) )
	);
	expect( path.dirname( file ) ).toBe(
		getClaudeAttachmentDirectory( getClaudeSessionStoreRoot( root ), id )
	);
	expect( path.extname( file ) ).toBe( '.md' );
	expect( ( await readFile( file ) ).length ).toBe( 13 * chunk.length );
	const empty = await stageClaudeAttachment( root, otherId, 'Empty', 0, Readable.from( [] ) );
	expect( path.dirname( empty ) ).not.toBe( path.dirname( file ) );
	expect( await readFile( empty ) ).toHaveLength( 0 );
	await expect(
		stageClaudeAttachment( root, id.slice( 0, -1 ), 'text.txt', 0, Readable.from( [] ) )
	).rejects.toThrow();
	const pi = ( await createAiSession( root ) ).id;
	await expect(
		stageClaudeAttachment( root, pi, 'text.txt', 0, Readable.from( [] ) )
	).rejects.toThrow();
} );

it( 'removes unfinished bytes and refuses a filename that reaches a protected file', async () => {
	for ( const bytes of [ 1, 3 ] ) {
		await expect(
			stageClaudeAttachment( root, id, 'notes.txt', 2, Readable.from( [ Buffer.alloc( bytes ) ] ) )
		).rejects.toThrow();
	}
	const failed = Readable.from(
		( async function* () {
			yield Buffer.from( 'a' );
			throw Error( 'Picker disconnected' );
		} )()
	);
	await expect( stageClaudeAttachment( root, id, 'notes.txt', 2, failed ) ).rejects.toThrow(
		'Picker disconnected'
	);
	const folder = getClaudeAttachmentDirectory( getClaudeSessionStoreRoot( root ), id );
	expect( await readdir( folder ) ).toEqual( [] );
	for ( const name of [ '../hello.txt', 'C:\\hello.txt', '.env', 'wp-config.php' ] ) {
		await expect(
			stageClaudeAttachment( root, id, name, 0, Readable.from( [] ) )
		).rejects.toThrow();
	}
} );

it( 'reclaims only unsent files owned by the requested conversation', async () => {
	const pick = () => stageClaudeAttachment( root, id, 'notes.md', 5, Readable.from( [ 'notes' ] ) );
	const unsent = await pick();
	await discardClaudeAttachment( root, otherId, unsent );
	expect( await readFile( unsent, 'utf8' ) ).toBe( 'notes' );
	await discardClaudeAttachment( root, id, unsent );
	await discardClaudeAttachment( root, id, unsent );
	await expect( readFile( unsent ) ).rejects.toMatchObject( { code: 'ENOENT' } );
	const legacy = await pick();
	await rm( legacy + '.draft' );
	await discardClaudeAttachment( root, id, legacy );
	expect( await readFile( legacy, 'utf8' ) ).toBe( 'notes' );
	const submitted = await pick();
	await createNativeSessionStore( getClaudeSessionStoreRoot( root ) )
		.journal( id, 'turn' )
		.append( {
			type: 'turn.prompt',
			runId: 'run',
			turnId: 'turn',
			text: 'See file',
			stagedFiles: [ path.basename( submitted ) ],
		} );
	await discardClaudeAttachment( root, id, submitted );
	expect( await readFile( submitted, 'utf8' ) ).toBe( 'notes' );
} );

it( 'reserves attachments during the host handoff and releases them if launch fails', async () => {
	const file = await stageClaudeAttachment( root, id, 'draft.md', 1, Readable.from( [ 'x' ] ) );
	const selected = [ { id: 'file', name: 'draft.md', path: file } ];
	const directory = path.dirname( file );
	await expect(
		startWithClaudeAttachments( directory, selected, () => {
			throw new Error( 'launch failed' );
		} )
	).rejects.toThrow( 'launch failed' );
	expect( await readFile( file + '.draft', 'utf8' ) ).toBe( '' );
	let discard: Promise< void > | undefined;
	expect(
		await startWithClaudeAttachments( directory, selected, () => {
			discard = discardClaudeAttachment( root, id, file );
			return 'run';
		} )
	).toBe( 'run' );
	await discard;
	await discardClaudeAttachment( root, id, file );
	expect( await readFile( file, 'utf8' ) ).toBe( 'x' );
	const removed = await stageClaudeAttachment( root, id, 'other.md', 1, Readable.from( [ 'y' ] ) );
	await discardClaudeAttachment( root, id, removed );
	const launch = vi.fn();
	await expect(
		startWithClaudeAttachments( directory, [ { ...selected[ 0 ], path: removed } ], launch )
	).rejects.toThrow( 'Pick the file again' );
	expect( launch ).not.toHaveBeenCalled();
} );

it( 'copies the selected regular desktop file and rejects links and the native configuration', async () => {
	const selected = path.join( directory, 'selected.txt' );
	await writeFile( selected, 'notes' );
	const staged = await stageClaudeAttachment( root, id, 'selected.txt', 5, selected );
	expect( await readFile( staged, 'utf8' ) ).toBe( 'notes' );
	const alias = path.join( directory, 'alias.txt' );
	await link( selected, alias );
	await expect( stageClaudeAttachment( root, id, 'alias.txt', 5, alias ) ).rejects.toThrow();
	const privateFile = path.join( directory, 'claude', 'profile.json' );
	await writeFile( privateFile, '{}' );
	await expect(
		stageClaudeAttachment( root, id, 'profile.json', 2, privateFile )
	).rejects.toThrow();
	await expect( stageClaudeAttachment( root, id, 'innocent.txt', 5, selected ) ).rejects.toThrow();
} );
