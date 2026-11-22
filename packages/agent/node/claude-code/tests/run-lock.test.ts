import { createHash } from 'crypto';
import { mkdtemp, readFile, readdir, realpath, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeSessionStore } from '../sessions';

// The holder's atomic rewrite and the release's removal of the lock, each
// held at a chosen moment, so an interleaving can be produced on demand.
const gates = vi.hoisted( () => ( {
	// While set, the removal of the lock waits until a rewrite has started, or for a moment.
	unlink: false,
	rewriteStarted: undefined as undefined | ( () => void ),
	// While set, a rewrite waits for this before writing.
	rewrite: undefined as undefined | Promise< unknown >,
	// While set, the filesystem refuses hard links, as FAT, exFAT and some shares do.
	linkless: false,
	// Every file opened exclusively, and every one synced through its handle.
	exclusive: [] as string[],
	synced: [] as string[],
} ) );

vi.mock( 'atomically', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('atomically') >();
	return {
		...actual,
		writeFile: async ( ...args: Parameters< typeof actual.writeFile > ) => {
			if ( gates.rewrite && String( args[ 0 ] ).endsWith( '.json.lock' ) ) {
				gates.rewriteStarted?.();
				await gates.rewrite;
			}
			return actual.writeFile( ...args );
		},
	};
} );

vi.mock( 'fs/promises', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('fs/promises') >();
	const unlink = async ( file: Parameters< typeof actual.unlink >[ 0 ] ) => {
		if ( gates.unlink && String( file ).endsWith( '.json.lock' ) )
			await new Promise< void >( ( resolve ) => {
				gates.rewriteStarted = resolve;
				setTimeout( resolve, 200 );
			} );
		return actual.unlink( file );
	};
	const link = async ( ...args: Parameters< typeof actual.link > ) => {
		if ( gates.linkless )
			throw Object.assign( new Error( 'operation not permitted, link' ), { code: 'EPERM' } );
		return actual.link( ...args );
	};
	const open = async ( ...args: Parameters< typeof actual.open > ) => {
		const handle = await actual.open( ...args );
		const file = String( args[ 0 ] );
		if ( args[ 1 ] === 'wx' ) gates.exclusive.push( file );
		const sync = handle.sync.bind( handle );
		handle.sync = async () => {
			gates.synced.push( file );
			return sync();
		};
		return handle;
	};
	return { ...actual, default: { ...actual, unlink, link, open }, unlink, link, open };
} );

const dirs: string[] = [];
afterEach( async () => {
	gates.unlink = false;
	gates.rewrite = undefined;
	gates.rewriteStarted = undefined;
	gates.linkless = false;
	gates.exclusive = [];
	gates.synced = [];
	await Promise.all(
		dirs.splice( 0 ).map( ( dir ) => rm( dir, { recursive: true, force: true } ) )
	);
} );

const nativeSessionId = 'd8f40437-482c-4e07-8cac-2371e78bcaef';
const run = ( dir: string ) => ( {
	owner: { pid: 4321, start: '134389060548247995' },
	runId: 'run',
	turnId: 'turn',
	connection: { id: 'connection', revision: 3 },
	workspace: { siteId: 'site', workingDirectory: dir, configDirectory: dir },
} );

async function fixture() {
	const dir = await realpath( await mkdtemp( path.join( os.tmpdir(), 'claude-run-lock-' ) ) );
	dirs.push( dir );
	const file = path.join(
		dir,
		`${ createHash( 'sha256' ).update( 'chat' ).digest( 'hex' ) }.json.lock`
	);
	return { dir, file, store: createNativeSessionStore( dir ) };
}

describe( 'a run lock’s updates and its release', () => {
	it( 'never recreates the lock when an update races its release', async () => {
		const { dir, store } = await fixture();
		const lock = await store.lockRun( 'chat', run( dir ) );
		gates.unlink = true;
		const released = lock.release();
		gates.rewrite = released.catch( () => {} );
		const updated = lock.update( {
			stage: 'starting',
			session: { nativeSessionId, resume: false },
		} );
		const [ release, update ] = await Promise.allSettled( [ released, updated ] );
		expect( release.status ).toBe( 'fulfilled' );
		expect( update ).toMatchObject( {
			status: 'rejected',
			reason: { code: 'ERR_CLAUDE_RUN_LOCK_RELEASED' },
		} );
		expect( await store.inspectLock( 'chat' ) ).toEqual( { state: 'none' } );
	} );

	it( 'never overwrites a lock another holder took after the release', async () => {
		const { dir, file, store } = await fixture();
		const lock = await store.lockRun( 'chat', run( dir ) );
		gates.unlink = true;
		const released = lock.release();
		let successor: string | undefined;
		gates.rewrite = released
			.catch( () => {} )
			.then( async () => {
				gates.unlink = false;
				await createNativeSessionStore( dir ).lockRun( 'chat', {
					...run( dir ),
					runId: 'next-run',
					turnId: 'next-turn',
				} );
				successor = await readFile( file, 'utf8' );
			} );
		const updated = lock.update( {
			stage: 'starting',
			session: { nativeSessionId, resume: false },
		} );
		await Promise.allSettled( [ released, updated ] );
		await gates.rewrite;
		expect( successor ).toBeDefined();
		expect( await readFile( file, 'utf8' ) ).toBe( successor );
		await expect( updated ).rejects.toMatchObject( { code: 'ERR_CLAUDE_RUN_LOCK_RELEASED' } );
	} );

	it( 'refuses every update after its release with a typed error, and releases once', async () => {
		const { dir, store } = await fixture();
		const lock = await store.lockRun( 'chat', run( dir ) );
		await lock.release();
		await expect(
			lock.update( { stage: 'starting', session: { nativeSessionId, resume: false } } )
		).rejects.toMatchObject( { code: 'ERR_CLAUDE_RUN_LOCK_RELEASED' } );
		await expect( lock.release() ).rejects.toMatchObject( {
			code: 'ERR_CLAUDE_RUN_LOCK_RELEASED',
		} );
		expect( await store.inspectLock( 'chat' ) ).toEqual( { state: 'none' } );
	} );

	it( 'applies an update made before the release, then releases', async () => {
		const { dir, store } = await fixture();
		const lock = await store.lockRun( 'chat', run( dir ) );
		const updated = lock.update( {
			stage: 'starting',
			session: { nativeSessionId, resume: true },
		} );
		const released = lock.release();
		await expect( updated ).resolves.toBeUndefined();
		await expect( released ).resolves.toBeUndefined();
		expect( await store.inspectLock( 'chat' ) ).toEqual( { state: 'none' } );
	} );
} );

describe( 'a lock and a claim on a filesystem without hard links', () => {
	it( 'creates the lock exclusively, then writes and syncs it through that same handle', async () => {
		const { dir, file, store } = await fixture();
		gates.linkless = true;
		const lock = await store.lockRun( 'chat', run( dir ) );
		expect( JSON.parse( await readFile( file, 'utf8' ) ) ).toMatchObject( {
			purpose: 'run',
			stage: 'locked',
		} );
		expect( gates.exclusive ).toContain( file );
		expect( gates.synced ).toContain( file );
		expect( await readdir( dir ) ).toEqual( [ path.basename( file ) ] );
		await expect( store.lockRun( 'chat', run( dir ) ) ).rejects.toMatchObject( {
			code: 'EEXIST',
		} );
		await lock.release();
	} );

	it( 'creates a recovery claim the same way', async () => {
		const { dir, file, store } = await fixture();
		const lock = await store.lockRun( 'chat', run( dir ) );
		const { token } = JSON.parse( await readFile( file, 'utf8' ) ) as { token: string };
		gates.linkless = true;
		const claimant = { pid: 77, start: 'claimant' };
		expect(
			await store.claimRecovery( 'chat', token, claimant, async () => 'gone' )
		).toMatchObject( { state: 'claimed' } );
		const [ claim ] = ( await readdir( dir ) ).filter( ( name ) => name.includes( '.claim-' ) );
		expect( JSON.parse( await readFile( path.join( dir, claim ), 'utf8' ) ) ).toEqual( {
			version: 1,
			claimant,
		} );
		expect( gates.synced ).toContain( path.join( dir, claim ) );
		await lock.release();
	} );
} );
