import { mkdtemp, realpath, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, expect, it } from 'vitest';
import { createNativeSessionStore } from '../sessions';

const dirs: string[] = [];
afterEach( async () => {
	await Promise.all(
		dirs.splice( 0 ).map( ( dir ) => rm( dir, { recursive: true, force: true } ) )
	);
} );
it( 'persists an explicit native id before sending and refuses to overwrite the conversation', async () => {
	const dir = await realpath( await mkdtemp( path.join( os.tmpdir(), 'claude-store-' ) ) );
	dirs.push( dir );
	const store = createNativeSessionStore( dir );
	const binding = {
		backend: 'claude-code' as const,
		connectionId: 'connection',
		conversationId: 'conversation',
		siteId: 'site',
		workingDirectory: dir,
		configDirectory: dir,
		nativeSessionId: 'd8f40437-482c-4e07-8cac-2371e78bcaef',
	};
	await store.create( binding );
	expect( await store.load( 'conversation' ) ).toEqual( binding );
	await expect(
		store.create( { ...binding, nativeSessionId: 'f1cfaf4c-7303-4707-9bc6-0f37f5b7d7ba' } )
	).rejects.toThrow();
	expect( await store.load( 'conversation' ) ).toEqual( binding );
} );

it( 'excludes concurrent processes for one conversation until the run releases its lock', async () => {
	const dir = await realpath( await mkdtemp( path.join( os.tmpdir(), 'claude-lock-' ) ) );
	dirs.push( dir );
	const store = createNativeSessionStore( dir );
	const release = await store.lockTurn( 'conversation' );
	await expect( store.lockTurn( 'conversation' ) ).rejects.toThrow();
	await release();
	const releaseAgain = await store.lockTurn( 'conversation' );
	await releaseAgain();
} );

it( 'discovers native transcripts independently and rejects duplicate copies', async () => {
	const fs = await import( 'fs/promises' );
	const dir = await realpath( await mkdtemp( path.join( os.tmpdir(), 'claude-projects-' ) ) );
	dirs.push( dir );
	const projects = path.join( dir, 'projects' );
	await fs.mkdir( path.join( projects, 'a' ), { recursive: true } );
	const id = 'd8f40437-482c-4e07-8cac-2371e78bcaef';
	const record = {
		backend: 'claude-code' as const,
		connectionId: 'connection',
		conversationId: 'conversation',
		siteId: 'site',
		workingDirectory: dir,
		configDirectory: dir,
		nativeSessionId: id,
	};
	await fs.writeFile(
		path.join( projects, 'a', `${ id }.jsonl` ),
		JSON.stringify( { sessionId: id, cwd: dir } ) + '\n'
	);
	const store = createNativeSessionStore( path.join( dir, 'store' ) );
	expect( ( await store.resolve( record, record, projects ) ).status ).toBe( 'ready' );
	await fs.mkdir( path.join( projects, 'b' ) );
	await fs.copyFile(
		path.join( projects, 'a', `${ id }.jsonl` ),
		path.join( projects, 'b', `${ id }.jsonl` )
	);
	expect( ( await store.resolve( record, record, projects ) ).status ).toBe( 'ambiguous' );
} );

it( 'keeps the display journal separate from the native binding and preserves terminal status', async () => {
	const dir = await realpath( await mkdtemp( path.join( os.tmpdir(), 'claude-journal-' ) ) );
	dirs.push( dir );
	const store = createNativeSessionStore( dir );
	const journal = store.journal( 'conversation', 'turn' );
	await journal.append( {
		type: 'content.confirmed',
		runId: 'run',
		turnId: 'turn',
		messageId: 'message',
		blockId: '0',
		blockType: 'text',
		text: 'Hello',
	} );
	await journal.append( {
		type: 'turn.terminal',
		runId: 'run',
		turnId: 'turn',
		outcome: { status: 'unknown_process_exit' },
	} );
	expect( await journal.read() ).toMatchObject( [
		{ type: 'content.confirmed', text: 'Hello' },
		{ type: 'turn.terminal', outcome: { status: 'unknown_process_exit' } },
	] );
	expect( await store.load( 'conversation' ) ).toBeUndefined();
} );

it( 'lists a conversation’s display journals without mixing in other conversations', async () => {
	const dir = await realpath( await mkdtemp( path.join( os.tmpdir(), 'claude-list-' ) ) );
	dirs.push( dir );
	const store = createNativeSessionStore( dir );
	await store.journal( 'chat', 'turn1' ).append( {
		type: 'turn.terminal',
		runId: 'run1',
		turnId: 'turn1',
		outcome: { status: 'interrupted' },
	} );
	await store.journal( 'other', 'turn2' ).append( {
		type: 'turn.terminal',
		runId: 'run2',
		turnId: 'turn2',
		outcome: { status: 'error' },
	} );
	expect( await store.readJournals( 'chat' ) ).toMatchObject( [
		[ { turnId: 'turn1', outcome: { status: 'interrupted' } } ],
	] );
} );
