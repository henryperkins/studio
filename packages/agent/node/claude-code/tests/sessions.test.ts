import { createHash, randomUUID } from 'crypto';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
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

it( 'keeps journal order across a restart even when filesystem creation times change', async () => {
	const fs = await import( 'fs/promises' );
	const { createHash } = await import( 'crypto' );
	const dir = await realpath( await mkdtemp( path.join( os.tmpdir(), 'claude-order-' ) ) );
	dirs.push( dir );
	const store = createNativeSessionStore( dir );
	const release = await store.lockTurn( 'chat' );
	await store.journal( 'chat', 'first' ).append( {
		type: 'turn.terminal',
		runId: 'one',
		turnId: 'first',
		outcome: { status: 'success' },
	} );
	await new Promise( ( resolve ) => setTimeout( resolve, 25 ) );
	await store.journal( 'chat', 'second' ).append( {
		type: 'turn.terminal',
		runId: 'two',
		turnId: 'second',
		outcome: { status: 'success' },
	} );
	await release();
	const hash = ( value: string ) => createHash( 'sha256' ).update( value ).digest( 'hex' );
	const file = path.join( dir, `${ hash( 'chat' ) }-${ hash( 'first' ) }.journal.jsonl` );
	const content = await fs.readFile( file );
	await new Promise( ( resolve ) => setTimeout( resolve, 25 ) );
	const replacement = path.join( dir, 'replacement' );
	await fs.writeFile( replacement, content );
	await fs.rm( file );
	await fs.rename( replacement, file );
	expect(
		( await createNativeSessionStore( dir ).readJournals( 'chat' ) ).map(
			( events ) => events[ 0 ].turnId
		)
	).toEqual( [ 'first', 'second' ] );
} );

it( 'never reclaims an old run lock while ownership is uncertain', async () => {
	const fs = await import( 'fs/promises' );
	const { createHash } = await import( 'crypto' );
	const dir = await realpath( await mkdtemp( path.join( os.tmpdir(), 'claude-old-lock-' ) ) );
	dirs.push( dir );
	const store = createNativeSessionStore( dir );
	const release = await store.lockTurn( 'chat' );
	const lock = path.join(
		dir,
		`${ createHash( 'sha256' ).update( 'chat' ).digest( 'hex' ) }.json.lock`
	);
	const old = new Date( Date.now() - 3 * 60 * 60 * 1000 );
	await fs.utimes( lock, old, old );
	await expect( store.lockTurn( 'chat' ) ).rejects.toThrow();
	await release();
} );

it( 'uses persisted journal ordinals after files are restored in a different order', async () => {
	const fs = await import( 'fs/promises' );
	const { createHash } = await import( 'crypto' );
	const dir = await realpath( await mkdtemp( path.join( os.tmpdir(), 'claude-restored-order-' ) ) );
	dirs.push( dir );
	const hash = ( value: string ) => createHash( 'sha256' ).update( value ).digest( 'hex' );
	const prefix = hash( 'chat' );
	const name = ( turn: string ) => `${ prefix }-${ hash( turn ) }.journal.jsonl`;
	await fs.writeFile(
		path.join( dir, name( 'second' ) ),
		JSON.stringify( {
			type: 'turn.terminal',
			runId: 'two',
			turnId: 'second',
			outcome: { status: 'success' },
		} ) + '\n'
	);
	await new Promise( ( resolve ) => setTimeout( resolve, 30 ) );
	await fs.writeFile(
		path.join( dir, name( 'first' ) ),
		JSON.stringify( {
			type: 'turn.terminal',
			runId: 'one',
			turnId: 'first',
			outcome: { status: 'success' },
		} ) + '\n'
	);
	await fs.writeFile(
		path.join( dir, `${ prefix }.journal-order.json` ),
		JSON.stringify( { version: 1, entries: [ name( 'first' ), name( 'second' ) ] } )
	);
	expect(
		( await createNativeSessionStore( dir ).readJournals( 'chat' ) ).map(
			( events ) => events[ 0 ].turnId
		)
	).toEqual( [ 'first', 'second' ] );
} );

it( 'preserves older journal files when recording a new ordinal', async () => {
	const fs = await import( 'fs/promises' );
	const { createHash } = await import( 'crypto' );
	const dir = await realpath( await mkdtemp( path.join( os.tmpdir(), 'claude-legacy-' ) ) );
	dirs.push( dir );
	const hash = ( value: string ) => createHash( 'sha256' ).update( value ).digest( 'hex' );
	const legacy = path.join( dir, `${ hash( 'chat' ) }-${ hash( 'old' ) }.journal.jsonl` );
	await fs.writeFile(
		legacy,
		JSON.stringify( {
			type: 'turn.terminal',
			runId: 'old',
			turnId: 'old',
			outcome: { status: 'interrupted' },
		} ) + '\n'
	);
	const store = createNativeSessionStore( dir );
	const release = await store.lockTurn( 'chat' );
	await store.journal( 'chat', 'new' ).append( {
		type: 'turn.terminal',
		runId: 'new',
		turnId: 'new',
		outcome: { status: 'success' },
	} );
	await release();
	expect( ( await store.readJournals( 'chat' ) ).map( ( events ) => events[ 0 ].turnId ) ).toEqual(
		[ 'old', 'new' ]
	);
	expect( await fs.readFile( legacy, 'utf8' ) ).toContain( 'old' );
} );

it( 'rejects corrupt journal order without overwriting it', async () => {
	const fs = await import( 'fs/promises' );
	const { createHash } = await import( 'crypto' );
	const dir = await realpath( await mkdtemp( path.join( os.tmpdir(), 'claude-corrupt-' ) ) );
	dirs.push( dir );
	const manifest = path.join(
		dir,
		`${ createHash( 'sha256' ).update( 'chat' ).digest( 'hex' ) }.journal-order.json`
	);
	await fs.writeFile( manifest, '{broken' );
	const store = createNativeSessionStore( dir );
	const release = await store.lockTurn( 'chat' );
	await expect(
		store.journal( 'chat', 'new' ).append( {
			type: 'turn.terminal',
			runId: 'new',
			turnId: 'new',
			outcome: { status: 'error' },
		} )
	).rejects.toThrow();
	await release();
	expect( await fs.readFile( manifest, 'utf8' ) ).toBe( '{broken' );
} );

it( 'does not remove a replacement lock owned by a different run', async () => {
	const fs = await import( 'fs/promises' );
	const { createHash } = await import( 'crypto' );
	const dir = await realpath( await mkdtemp( path.join( os.tmpdir(), 'claude-lock-owner-' ) ) );
	dirs.push( dir );
	const store = createNativeSessionStore( dir );
	const release = await store.lockTurn( 'chat' );
	const lock = path.join(
		dir,
		`${ createHash( 'sha256' ).update( 'chat' ).digest( 'hex' ) }.json.lock`
	);
	await fs.writeFile( lock, 'different-owner' );
	await expect( release() ).rejects.toThrow();
	expect( await fs.readFile( lock, 'utf8' ) ).toBe( 'different-owner' );
} );

it( 'retains the run lock when its owner process exits without proving the native child stopped', async () => {
	const fs = await import( 'fs/promises' );
	const { execFile } = await import( 'child_process' );
	const { promisify } = await import( 'util' );
	const dir = await realpath( await mkdtemp( path.join( os.tmpdir(), 'claude-exit-lock-' ) ) );
	dirs.push( dir );
	const output = path.join( dir, 'session-store.cjs' );
	await promisify( execFile )( process.execPath, [
		path.resolve( 'node_modules/esbuild/bin/esbuild' ),
		path.resolve( 'packages/agent/node/claude-code/sessions.ts' ),
		'--bundle',
		'--platform=node',
		'--format=cjs',
		'--outfile=' + output,
		'--log-level=silent',
	] );
	await promisify( execFile )( process.execPath, [
		'-e',
		"const {createNativeSessionStore}=require(process.argv[1]);createNativeSessionStore(process.argv[2]).lockTurn('chat').then(()=>process.exit(0))",
		output,
		dir,
	] );
	await expect( createNativeSessionStore( dir ).lockTurn( 'chat' ) ).rejects.toThrow();
	const files = await fs.readdir( dir );
	expect( files.some( ( name ) => name.endsWith( '.json.lock' ) ) ).toBe( true );
} );

describe( 'the versioned run lock', () => {
	const owner = { pid: 4321, start: '134389060548247995' };
	const nativeSessionId = 'd8f40437-482c-4e07-8cac-2371e78bcaef';
	const hash = ( value: string ) => createHash( 'sha256' ).update( value ).digest( 'hex' );
	async function lockFixture() {
		const dir = await realpath( await mkdtemp( path.join( os.tmpdir(), 'claude-run-lock-' ) ) );
		dirs.push( dir );
		return {
			dir,
			file: path.join( dir, `${ hash( 'chat' ) }.json.lock` ),
			store: createNativeSessionStore( dir ),
			run: {
				owner,
				runId: 'run',
				turnId: 'turn',
				connection: { id: 'connection', revision: 3 },
				workspace: { siteId: 'site', workingDirectory: dir, configDirectory: dir },
			},
		};
	}

	it( 'names its owner, run, connection and binding from the start, and moves through its stages atomically', async () => {
		const { dir, file, store, run } = await lockFixture();
		const lock = await store.lockRun( 'chat', run );
		const first = JSON.parse( await readFile( file, 'utf8' ) );
		expect( first ).toEqual( {
			version: 2,
			purpose: 'run',
			token: expect.stringMatching( /^[0-9a-f-]{36}$/ ),
			conversationId: 'chat',
			platform: process.platform,
			owner,
			createdAt: expect.any( String ),
			runId: 'run',
			turnId: 'turn',
			connection: { id: 'connection', revision: 3 },
			workspace: { siteId: 'site', workingDirectory: dir, configDirectory: dir },
			stage: 'locked',
		} );
		await expect( store.lockRun( 'chat', run ) ).rejects.toMatchObject( { code: 'EEXIST' } );
		await expect( store.lockTurn( 'chat' ) ).rejects.toMatchObject( { code: 'EEXIST' } );
		const session = { nativeSessionId, resume: false };
		await lock.update( { stage: 'starting', session } );
		expect( JSON.parse( await readFile( file, 'utf8' ) ) ).toEqual( {
			...first,
			stage: 'starting',
			session,
		} );
		const processes = {
			native: { pid: 77, start: '134389060548248000' },
			guardian: { pid: 78, start: '134389060541000000' },
		};
		await lock.update( { stage: 'owned', processes } );
		const owned = { ...first, stage: 'owned', session, processes };
		expect( JSON.parse( await readFile( file, 'utf8' ) ) ).toEqual( owned );
		expect( await store.inspectLock( 'chat' ) ).toEqual( {
			state: 'run',
			record: owned,
			raw: await readFile( file, 'utf8' ),
		} );
		expect( ( await readdir( dir ) ).filter( ( name ) => name !== path.basename( file ) ) ).toEqual(
			[]
		);
		await lock.release();
		expect( await store.inspectLock( 'chat' ) ).toEqual( { state: 'none' } );
	} );

	it( 'refuses to move or release a lock that is no longer its own, and leaves that lock as it is', async () => {
		const { file, store, run } = await lockFixture();
		const lock = await store.lockRun( 'chat', run );
		await writeFile( file, 'different-owner' );
		await expect(
			lock.update( { stage: 'starting', session: { nativeSessionId, resume: true } } )
		).rejects.toThrow( 'Run lock ownership changed' );
		await expect( lock.release() ).rejects.toThrow( 'Run lock ownership changed' );
		expect( await readFile( file, 'utf8' ) ).toBe( 'different-owner' );
	} );

	it( 'takes no lock from a creation that never completed, and leaves its file alone', async () => {
		const { dir, file, store, run } = await lockFixture();
		const partial = `${ file }.${ randomUUID() }.tmp`;
		await writeFile( partial, '{"version":2,"purp' );
		expect( await store.inspectLock( 'chat' ) ).toEqual( { state: 'none' } );
		const lock = await store.lockRun( 'chat', run );
		await lock.release();
		expect( await readdir( dir ) ).toEqual( [ path.basename( partial ) ] );
	} );

	it( 'reads a lock written before locks named their owner as legacy, a deletion as held, and anything else as unreadable', async () => {
		const { file, store, run } = await lockFixture();
		await writeFile( file, randomUUID() );
		expect( await store.inspectLock( 'chat' ) ).toEqual( { state: 'legacy' } );
		await rm( file );
		const lock = await store.lockRun( 'chat', run );
		await lock.update( { stage: 'starting', session: { nativeSessionId, resume: false } } );
		const record = JSON.parse( await readFile( file, 'utf8' ) );
		for ( const content of [
			'',
			'{broken',
			'different-owner',
			JSON.stringify( { ...record, version: 3 } ),
			JSON.stringify( { ...record, purpose: 'other' } ),
			JSON.stringify( { ...record, owner: { pid: 0, start: 'x' } } ),
			JSON.stringify( { ...record, owner: { pid: 4321, start: '' } } ),
			JSON.stringify( { ...record, connection: { id: 'connection', revision: '3' } } ),
			JSON.stringify( { ...record, workspace: { ...record.workspace, workingDirectory: 'site' } } ),
			JSON.stringify( { ...record, stage: 'owned' } ),
			JSON.stringify( { ...record, stage: 'locked' } ),
			JSON.stringify( { ...record, session: { nativeSessionId: 'not-a-uuid', resume: false } } ),
		] ) {
			await writeFile( file, content );
			expect( await store.inspectLock( 'chat' ) ).toEqual( { state: 'unreadable' } );
		}
		await rm( file );
		const release = await store.lockTurn( 'chat' );
		expect( await store.inspectLock( 'chat' ) ).toEqual( { state: 'held' } );
		await release();
	} );
} );

it( 'reads approvals journaled before they named their operation as display-only legacy events', async () => {
	const dir = await realpath( await mkdtemp( path.join( os.tmpdir(), 'claude-store-' ) ) );
	dirs.push( dir );
	const store = createNativeSessionStore( dir );
	const ids = { runId: 'run', turnId: 'turn', toolCallId: 'tool', requestId: 'request' };
	const draft = { siteName: 'Site', title: 'Draft', content: 'Body' };
	const journal = store.journal( 'conversation', 'turn' );
	await journal.append( { type: 'turn.prompt', runId: 'run', turnId: 'turn', text: 'Hello' } );
	await journal.append( {
		type: 'approval.requested',
		...ids,
		description: 'Create a draft post on the current local site',
		draft,
	} as unknown as Parameters< typeof journal.append >[ 0 ] );
	await journal.append( { type: 'approval.resolved', ...ids } );
	const [ events ] = await store.readJournals( 'conversation' );
	expect( events ).toEqual( [
		{ type: 'turn.prompt', runId: 'run', turnId: 'turn', text: 'Hello' },
		{
			type: 'approval.legacy',
			...ids,
			description: 'Create a draft post on the current local site',
			draft,
		},
		{ type: 'approval.resolved', ...ids },
	] );
	expect( await journal.read() ).toEqual( events );
} );
