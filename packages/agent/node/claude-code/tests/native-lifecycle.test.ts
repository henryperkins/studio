import { execFile, fork, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { once } from 'events';
import { mkdir, mkdtemp, realpath, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import {
	checkProcessIdentity,
	prepareProcessOwner,
	readProcessIdentity,
} from '@studio/common/lib/owned-process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildClaudeEnvironment } from '../auth-status';
import { inspectClaudeExecutable, trustedPowerShellPath } from '../discovery';
import { recoverClaudeRun } from '../recovery';
import { createNativeSessionStore } from '../sessions';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';
import type { ProcessIdentity } from '@studio/common/lib/owned-process';

const executable = process.env.STUDIO_TEST_NATIVE_CLAUDE_LIFECYCLE_EXE;
const exec = promisify( execFile );
const LIFETIME = 45_000;
// The unrelated process outlives the whole suite, and still ends on its own.
const SENTINEL_LIFETIME = 300_000;

// An ES module bundle of a fixture, written under the repository's
// node_modules so its external packages resolve from there.
async function bundle( entry: string ): Promise< { file: string; remove: () => Promise< void > } > {
	const directory = path.resolve( 'node_modules/.studio-test-bundles', randomUUID() );
	const file = path.join( directory, path.basename( entry, '.ts' ) + '.mjs' );
	await exec( process.execPath, [
		path.resolve( 'node_modules/esbuild/bin/esbuild' ),
		path.resolve( entry ),
		'--bundle',
		'--platform=node',
		'--format=esm',
		'--outfile=' + file,
		'--log-level=silent',
		"--banner:js=import { createRequire as __studioRequire } from 'module'; const require = __studioRequire( import.meta.url );",
		'--external:@anthropic-ai/claude-agent-sdk/*',
		'--external:@modelcontextprotocol/sdk/*',
		'--external:@earendil-works/*',
		'--external:playwright*',
		'--external:chromium-bidi*',
	] );
	return {
		file,
		remove: () => rm( directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 } ),
	};
}

// The live descendants of a live process. Windows keeps a parent ID after the
// parent exits and reuses PIDs, so a child must also have started after its
// parent; POSIX re-parents orphans, so its parent IDs are always current.
async function descendantsOf( root: number ): Promise< number[] > {
	let rows: number[][];
	if ( process.platform === 'win32' ) {
		const script = `Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | Where-Object { $_.CreationDate } | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() }`;
		const { stdout } = await exec(
			trustedPowerShellPath(),
			[
				'-NoProfile',
				'-NonInteractive',
				'-EncodedCommand',
				Buffer.from( script, 'utf16le' ).toString( 'base64' ),
			],
			{ windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }
		);
		rows = stdout
			.trim()
			.split( /\r?\n/ )
			.map( ( line ) => line.trim().split( ' ' ).map( Number ) );
	} else {
		const { stdout } = await exec( 'ps', [ '-A', '-o', 'pid=', '-o', 'ppid=' ] );
		rows = stdout
			.trim()
			.split( '\n' )
			.map( ( line ) => [ ...line.trim().split( /\s+/ ).map( Number ), 0 ] );
	}
	const started = new Map( rows.map( ( [ pid, , start ] ) => [ pid, start ] ) );
	const ids = [ root ];
	for ( let grew = true; grew;  ) {
		grew = false;
		for ( const [ pid, ppid, start ] of rows )
			if (
				ids.includes( ppid ) &&
				! ids.includes( pid ) &&
				start >= ( started.get( ppid ) ?? 0 )
			) {
				ids.push( pid );
				grew = true;
			}
	}
	return ids.slice( 1 );
}

async function identities( pids: number[] ): Promise< ProcessIdentity[] > {
	const found = await Promise.all( pids.map( ( pid ) => readProcessIdentity( pid ) ) );
	return found.filter( ( identity ): identity is ProcessIdentity => !! identity );
}

async function goneWithin( targets: ProcessIdentity[], ms: number ): Promise< ProcessIdentity[] > {
	const deadline = Date.now() + ms;
	let alive = targets;
	while ( alive.length && Date.now() < deadline ) {
		const states = await Promise.all(
			alive.map( ( identity ) => checkProcessIdentity( identity ) )
		);
		alive = alive.filter( ( _identity, index ) => states[ index ] !== 'gone' );
		if ( alive.length ) await new Promise( ( resolve ) => setTimeout( resolve, 250 ) );
	}
	return alive;
}

// The Studio runtime with Node test processes for the native executable: it
// runs here natively on whichever OS runs the suite.
describe( 'native lifecycle with an owned process tree (Node test processes)', () => {
	const marker = `studio-p2-fixture-${ randomUUID() }`;
	const nativeFixture = path.resolve(
		'packages/common/lib/tests/fixtures/owned-process-fixture.mjs'
	);
	let root: string;
	let owner: Awaited< ReturnType< typeof bundle > >;
	let sentinel: ReturnType< typeof spawn >;
	let sentinelIdentity: ProcessIdentity;

	beforeAll( async () => {
		root = await realpath( await mkdtemp( path.join( os.tmpdir(), 'Studio Owned Lifecycle ' ) ) );
		owner = await bundle(
			'packages/agent/node/claude-code/tests/fixtures/offline-lifecycle-owner.ts'
		);
		sentinel = spawn(
			process.execPath,
			[ nativeFixture, 'leaf', marker, String( SENTINEL_LIFETIME ) ],
			{
				stdio: [ 'ignore', 'pipe', 'ignore' ],
				windowsHide: true,
			}
		);
		await once( sentinel.stdout!, 'data' );
		sentinelIdentity = ( await readProcessIdentity( sentinel.pid! ) )!;
		expect( sentinelIdentity ).toBeDefined();
	}, 60_000 );

	afterAll( async () => {
		// The test's own unreaped child.
		if ( sentinel && sentinel.exitCode === null && sentinel.signalCode === null )
			sentinel.kill( 'SIGKILL' );
		await owner?.remove();
		if ( root ) await rm( root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 } );
	} );

	async function interrupt( action: string ) {
		const directory = await realpath( await mkdtemp( path.join( root, action + ' ' ) ) );
		await Promise.all(
			[ 'site', 'config' ].map( ( name ) => mkdir( path.join( directory, name ) ) )
		);
		const runner = fork( owner.file, [ nativeFixture, marker, String( LIFETIME ), directory ], {
			env: { ...process.env, NODE_PATH: path.resolve( 'node_modules' ) },
			execArgv: [],
			stdio: [ 'ignore', 'ignore', 'ignore', 'ipc' ],
		} );
		const exited = once( runner, 'exit' );
		const messages: Array< Record< string, unknown > > = [];
		const arrived = ( type: string ) =>
			new Promise< Record< string, unknown > >( ( resolve, reject ) => {
				const found = messages.find( ( message ) => message.type === type );
				if ( found ) return resolve( found );
				const timer = setTimeout( () => reject( new Error( `No ${ type } message` ) ), 30_000 );
				runner.on( 'message', ( message: Record< string, unknown > ) => {
					if ( message.type === type ) {
						clearTimeout( timer );
						resolve( message );
					}
				} );
			} );
		runner.on( 'message', ( message: Record< string, unknown > ) => messages.push( message ) );
		try {
			const native = ( await arrived( 'native' ) ) as {
				native: number;
				shell: number;
				leaf: number;
			};
			await arrived( 'approval' );
			const descendants = await identities( await descendantsOf( runner.pid! ) );
			const pids = descendants.map( ( identity ) => identity.pid );
			for ( const pid of [ native.native, native.shell, native.leaf ] )
				expect( pids ).toContain( pid );
			if ( action === 'kill-owner' ) runner.kill( 'SIGKILL' );
			else runner.send( action );
			await exited;
			expect( await goneWithin( descendants, 20_000 ) ).toEqual( [] );
			expect( await checkProcessIdentity( sentinelIdentity ) ).toBe( 'alive' );
			const store = createNativeSessionStore( path.join( directory, 'store' ) );
			if ( action === 'kill-owner' ) {
				await expect( store.lockTurn( 'chat' ) ).rejects.toThrow();
				return;
			}
			const report = ( await arrived( 'done' ) ) as {
				events: BackendTurnEvent[];
				approvalCancelled: boolean;
				wpCli: number;
			};
			const terminals = report.events.filter( ( event ) => event.type === 'turn.terminal' );
			expect( terminals ).toEqual( [
				expect.objectContaining( {
					outcome: expect.objectContaining( {
						status: action === 'abort' ? 'interrupted' : 'unknown_process_exit',
					} ),
				} ),
			] );
			expect( report.approvalCancelled ).toBe( true );
			expect( report.wpCli ).toBe( 0 );
			expect( ( await store.readJournals( 'chat' ) ).at( -1 )?.at( -1 ) ).toEqual( terminals[ 0 ] );
			await (
				await store.lockTurn( 'chat' )
			)();
		} finally {
			// The test's own unreaped child; everything below it is the runtime's to end.
			if ( runner.exitCode === null && runner.signalCode === null ) runner.kill( 'SIGKILL' );
			await exited;
		}
	}

	it.each( [ 'close', 'abort', 'eof', 'kill-native', 'kill-owner' ] )(
		'leaves no owned process after %s, spares an unrelated one, and runs nothing the cancelled approval held',
		interrupt,
		90_000
	);

	it.skipIf( process.platform !== 'win32' )(
		'leaves no owned process when the job keeper dies, and ends the turn once, without success (Windows only: the job keeper is the Windows mechanism)',
		() => interrupt( 'kill-keeper' ),
		90_000
	);
} );

// The resolved message of `type` from a forked test process.
function nextMessage(
	child: ReturnType< typeof fork >,
	type: string
): Promise< Record< string, unknown > > {
	return new Promise( ( resolve, reject ) => {
		const timer = setTimeout( () => reject( new Error( `No ${ type } message` ) ), 30_000 );
		const listen = ( message: Record< string, unknown > ) => {
			if ( message?.type !== type ) return;
			clearTimeout( timer );
			child.off( 'message', listen );
			resolve( message );
		};
		child.on( 'message', listen );
	} );
}

// Reads a stream line by line: each call resolves with the next line.
function lines( stream: NodeJS.ReadableStream ): () => Promise< string > {
	const ready: string[] = [];
	const waiting: Array< ( line: string ) => void > = [];
	let buffer = '';
	stream.setEncoding( 'utf8' );
	stream.on( 'data', ( chunk: string ) => {
		buffer += chunk;
		for ( let end = buffer.indexOf( '\n' ); end >= 0; end = buffer.indexOf( '\n' ) ) {
			const line = buffer.slice( 0, end ).trim();
			buffer = buffer.slice( end + 1 );
			const waiter = waiting.shift();
			if ( waiter ) waiter( line );
			else ready.push( line );
		}
	} );
	return () =>
		new Promise( ( resolve ) => {
			const line = ready.shift();
			if ( line !== undefined ) resolve( line );
			else waiting.push( resolve );
		} );
}

// Recovery with the real OS checks, through the same calls Studio makes. It
// is retried while a process it waits for may still be ending, such as a
// console host that outlives its last client by moments; a blocked recovery
// changes nothing.
async function recoverWithin(
	store: ReturnType< typeof createNativeSessionStore >,
	binding: Parameters< typeof recoverClaudeRun >[ 1 ],
	ms: number
) {
	const deadline = Date.now() + ms;
	let result = await recoverClaudeRun( store, binding );
	while (
		result.status === 'blocked' &&
		[ 'native-alive', 'guardian-alive', 'descendants-alive', 'descendants-unverifiable' ].includes(
			result.reason
		) &&
		Date.now() < deadline
	) {
		await new Promise( ( resolve ) => setTimeout( resolve, 500 ) );
		result = await recoverClaudeRun( store, binding );
	}
	return result;
}

describe( 'recovery once the owner is gone (Node test processes)', () => {
	const marker = `studio-c4a-fixture-${ randomUUID() }`;
	const nativeFixture = path.resolve(
		'packages/common/lib/tests/fixtures/owned-process-fixture.mjs'
	);
	let root: string;
	let owner: Awaited< ReturnType< typeof bundle > >;
	let sentinel: ReturnType< typeof spawn >;
	let sentinelIdentity: ProcessIdentity;

	beforeAll( async () => {
		root = await realpath( await mkdtemp( path.join( os.tmpdir(), 'Studio Owned Recovery ' ) ) );
		owner = await bundle(
			'packages/agent/node/claude-code/tests/fixtures/offline-lifecycle-owner.ts'
		);
		sentinel = spawn(
			process.execPath,
			[ nativeFixture, 'leaf', marker, String( SENTINEL_LIFETIME ) ],
			{ stdio: [ 'ignore', 'pipe', 'ignore' ], windowsHide: true }
		);
		await once( sentinel.stdout!, 'data' );
		sentinelIdentity = ( await readProcessIdentity( sentinel.pid! ) )!;
		expect( sentinelIdentity ).toBeDefined();
	}, 60_000 );

	afterAll( async () => {
		// The test's own unreaped child.
		if ( sentinel && sentinel.exitCode === null && sentinel.signalCode === null )
			sentinel.kill( 'SIGKILL' );
		await owner?.remove();
		if ( root ) await rm( root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 } );
	} );

	async function conversation( name: string ) {
		const directory = await realpath( await mkdtemp( path.join( root, name + ' ' ) ) );
		await Promise.all(
			[ 'site', 'config' ].map( ( folder ) => mkdir( path.join( directory, folder ) ) )
		);
		const binding = {
			connectionId: 'offline',
			conversationId: 'chat',
			siteId: 'site',
			workingDirectory: path.join( directory, 'site' ),
			configDirectory: path.join( directory, 'config' ),
		};
		const store = createNativeSessionStore( path.join( directory, 'store' ) );
		const lock = ( ownerIdentity: ProcessIdentity ) =>
			store.lockRun( 'chat', {
				owner: ownerIdentity,
				runId: 'run',
				turnId: 'turn',
				connection: { id: 'offline', revision: 1 },
				workspace: {
					siteId: 'site',
					workingDirectory: binding.workingDirectory,
					configDirectory: binding.configDirectory,
				},
			} );
		return { directory, binding, store, lock };
	}

	// The identity of a fixture process that has exited.
	async function exitedIdentity(): Promise< ProcessIdentity > {
		const leaf = spawn( process.execPath, [ nativeFixture, 'leaf', marker, String( LIFETIME ) ], {
			stdio: [ 'ignore', 'pipe', 'ignore' ],
			windowsHide: true,
		} );
		await once( leaf.stdout!, 'data' );
		const identity = ( await readProcessIdentity( leaf.pid! ) )!;
		const exited = once( leaf, 'exit' );
		// The test's own unreaped child.
		leaf.kill( 'SIGKILL' );
		await exited;
		expect( await goneWithin( [ identity ], 10_000 ) ).toEqual( [] );
		return identity;
	}

	it( 'recovers the same conversation once the process that ran its turn has died, and not while it lives', async () => {
		const { directory, binding, store } = await conversation( 'owner death' );
		const runner = fork( owner.file, [ nativeFixture, marker, String( LIFETIME ), directory ], {
			env: { ...process.env, NODE_PATH: path.resolve( 'node_modules' ) },
			execArgv: [],
			stdio: [ 'ignore', 'ignore', 'ignore', 'ipc' ],
		} );
		const exited = once( runner, 'exit' );
		try {
			await nextMessage( runner, 'approval' );
			// The approval reaches the journal moments after it is asked.
			const deadline = Date.now() + 10_000;
			while (
				! ( await store.readJournals( 'chat' ) )
					.flat()
					.some( ( event ) => event.type === 'approval.requested' ) &&
				Date.now() < deadline
			)
				await new Promise( ( resolve ) => setTimeout( resolve, 100 ) );
			const [ requested ] = ( await store.readJournals( 'chat' ) )
				.flat()
				.filter( ( event ) => event.type === 'approval.requested' );
			expect( requested ).toBeDefined();
			const descendants = await identities( await descendantsOf( runner.pid! ) );
			const locked = await store.inspectLock( 'chat' );
			expect( locked ).toMatchObject( { state: 'run', record: { stage: 'owned' } } );
			expect( await recoverClaudeRun( store, binding ) ).toEqual( {
				status: 'blocked',
				reason: 'owner-alive',
				runId: 'run',
				turnId: 'turn',
			} );
			expect( await store.inspectLock( 'chat' ) ).toEqual( locked );
			runner.kill( 'SIGKILL' );
			await exited;
			expect( await goneWithin( descendants, 20_000 ) ).toEqual( [] );
			expect( await recoverWithin( store, binding, 15_000 ) ).toEqual( {
				status: 'recovered',
				runId: 'run',
				turnId: 'turn',
				recordedTerminal: true,
				invalidatedApprovals: [ ( requested as { requestId: string } ).requestId ],
				// The tool call was authorized and journaled; the draft it asked for
				// was waiting for its approval.
				uncertainOperations: [
					expect.objectContaining( {
						tool: 'wp_cli',
						operationClass: 'command',
						evidence: 'authorized',
					} ),
					expect.objectContaining( {
						requestId: ( requested as { requestId: string } ).requestId,
						tool: 'sites.wpCli',
						evidence: 'requested',
						resolved: false,
					} ),
				],
			} );
			const events = ( await store.readJournals( 'chat' ) ).flat();
			expect( events.filter( ( event ) => event.type === 'turn.terminal' ) ).toHaveLength( 1 );
			expect( events.some( ( event ) => event.type === 'turn.prompt' ) ).toBe( true );
			expect( await store.inspectLock( 'chat' ) ).toEqual( { state: 'none' } );
			const session = ( await store.load( 'chat' ) )!;
			expect(
				(
					await store.resolve( session, binding, path.join( binding.configDirectory, 'projects' ) )
				).status
			).toBe( 'ready' );
			await (
				await store.lockTurn( 'chat' )
			)();
			expect( await checkProcessIdentity( sentinelIdentity ) ).toBe( 'alive' );
		} finally {
			// The test's own unreaped child; everything below it is the runtime's to end.
			if ( runner.exitCode === null && runner.signalCode === null ) runner.kill( 'SIGKILL' );
			await exited;
		}
	}, 120_000 );

	it( 'treats a live process holding the owner’s PID with another start as another process, and leaves it running', async () => {
		const { store, binding, lock } = await conversation( 'recycled owner' );
		const held = await lock( sentinelIdentity );
		expect( await recoverClaudeRun( store, binding ) ).toMatchObject( {
			status: 'blocked',
			reason: 'owner-alive',
		} );
		await held.release();
		await lock( { pid: sentinelIdentity.pid, start: `${ sentinelIdentity.start }0` } );
		expect( await recoverClaudeRun( store, binding ) ).toEqual( {
			status: 'recovered',
			runId: 'run',
			turnId: 'turn',
			recordedTerminal: true,
			invalidatedApprovals: [],
			uncertainOperations: [],
		} );
		expect( await checkProcessIdentity( sentinelIdentity ) ).toBe( 'alive' );
	}, 60_000 );

	it( 'stays blocked while a process that may descend from the native process runs, and recovers once it has ended', async () => {
		const { store, binding, lock } = await conversation( 'live descendant' );
		const [ deadOwner, deadGuardian ] = [ await exitedIdentity(), await exitedIdentity() ];
		const processOwner = prepareProcessOwner();
		expect( await processOwner.prepared() ).toBe( true );
		const owned = processOwner.spawn(
			process.execPath,
			[ nativeFixture, 'tree', marker, String( LIFETIME ), 'ignore-eof' ],
			{ env: process.env }
		);
		let shutDown = false;
		try {
			expect( await owned.ready() ).toBe( true );
			const native = owned.identity()!;
			const next = lines( owned.child.stdout );
			await next();
			owned.child.stdin.write( 'spawn\n' );
			const [ , latePid ] = ( await next() ).split( ' ' );
			const late = ( await readProcessIdentity( Number( latePid ) ) )!;
			expect( late ).toBeDefined();
			// The test's own unreaped child. Its late child outlives it, still held by the job.
			const exited = once( owned.child, 'exit' );
			owned.child.kill( 'SIGKILL' );
			await exited;
			expect( await goneWithin( [ native ], 10_000 ) ).toEqual( [] );
			const held = await lock( deadOwner );
			await held.update( {
				stage: 'starting',
				session: { nativeSessionId: randomUUID(), resume: false },
			} );
			await held.update( { stage: 'owned', processes: { native, guardian: deadGuardian } } );
			const locked = await store.inspectLock( 'chat' );
			expect( await recoverClaudeRun( store, binding ) ).toEqual( {
				status: 'blocked',
				reason: process.platform === 'win32' ? 'descendants-alive' : 'descendants-unverifiable',
				runId: 'run',
				turnId: 'turn',
			} );
			expect( await store.inspectLock( 'chat' ) ).toEqual( locked );
			expect( await checkProcessIdentity( late ) ).toBe( 'alive' );
			shutDown = true;
			expect( await owned.shutdown( { graceMs: 0 } ) ).toBe( true );
			expect( await goneWithin( [ late ], 10_000 ) ).toEqual( [] );
			expect( await recoverWithin( store, binding, 15_000 ) ).toMatchObject( {
				status: 'recovered',
			} );
			expect( await checkProcessIdentity( sentinelIdentity ) ).toBe( 'alive' );
		} finally {
			if ( owned.child.exitCode === null && owned.child.signalCode === null )
				owned.child.kill( 'SIGKILL' );
			if ( ! shutDown ) await owned.shutdown( { graceMs: 0 } );
		}
	}, 120_000 );
} );

describe.runIf( process.platform === 'win32' && !! executable )(
	'offline native Windows lifecycle',
	() => {
		let root: string;
		let fixture: Awaited< ReturnType< typeof bundle > >;
		beforeAll( async () => {
			expect( await inspectClaudeExecutable( executable! ) ).toMatchObject( {
				ok: true,
				version: '2.1.319',
				architecture: 'x64',
			} );
			root = await realpath(
				await mkdtemp( path.join( os.tmpdir(), 'Studio Claude Lifecycle Évidence ' ) )
			);
			fixture = await bundle(
				'packages/agent/node/claude-code/tests/fixtures/native-lifecycle-process.ts'
			);
		}, 30_000 );
		afterAll( async () => {
			await fixture?.remove();
			if ( root )
				await rm( root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 } );
		} );

		it.each( [ 'close', 'abort', 'eof', 'kill-native', 'kill-owner' ] )(
			'leaves no orphan process after %s',
			async ( action ) => {
				const directory = await realpath( await mkdtemp( path.join( root, action + ' ' ) ) );
				await Promise.all(
					[ 'home', 'config', 'appdata', 'localappdata', 'temp' ].map( ( name ) =>
						mkdir( path.join( directory, name ) )
					)
				);
				const env = {
					...buildClaudeEnvironment( process.env ).env,
					NODE_PATH: path.resolve( 'node_modules' ),
					DEV_CONFIG_DIR: path.join( directory, 'studio-config' ),
					HOME: path.join( directory, 'home' ),
					USERPROFILE: path.join( directory, 'home' ),
					APPDATA: path.join( directory, 'appdata' ),
					LOCALAPPDATA: path.join( directory, 'localappdata' ),
					CLAUDE_CONFIG_DIR: path.join( directory, 'config' ),
				};
				const owner = fork( fixture.file, [ executable!, directory ], {
					env,
					execArgv: [],
					stdio: [ 'ignore', 'ignore', 'ignore', 'ipc' ],
				} );
				const exited = once( owner, 'exit' );
				let nativePid: number | undefined;
				let finish!: ( message: { events: BackendTurnEvent[]; userMessages: number } ) => void;
				const done = new Promise< { events: BackendTurnEvent[]; userMessages: number } >(
					( resolve ) => {
						finish = resolve;
					}
				);
				const ready = new Promise< void >( ( resolve, reject ) => {
					const timer = setTimeout(
						() => reject( new Error( 'Native initialization timed out' ) ),
						20_000
					);
					owner.on(
						'message',
						( message: {
							type: string;
							pid?: number;
							events: BackendTurnEvent[];
							userMessages: number;
						} ) => {
							if ( message.type === 'spawned' ) nativePid = message.pid;
							if ( message.type === 'ready' ) {
								clearTimeout( timer );
								resolve();
							}
							if ( message.type === 'done' ) finish( message );
						}
					);
					owner.once( 'exit', () => {
						clearTimeout( timer );
						reject( new Error( 'Native owner exited before initialization' ) );
					} );
				} );
				try {
					await ready;
					expect( nativePid ).toBeGreaterThan( 0 );
					const descendants = await identities( await descendantsOf( owner.pid! ) );
					expect( descendants.map( ( identity ) => identity.pid ) ).toContain( nativePid );
					if ( action === 'kill-owner' ) owner.kill( 'SIGKILL' );
					else owner.send( action );
					await exited;
					expect( await goneWithin( descendants, 20_000 ) ).toEqual( [] );
					const store = createNativeSessionStore( path.join( directory, 'store' ) );
					if ( action === 'kill-owner' ) await expect( store.lockTurn( 'chat' ) ).rejects.toThrow();
					else {
						const report = await done;
						expect( report.userMessages ).toBe( 0 );
						expect( report.events ).toHaveLength( 1 );
						expect( report.events[ 0 ] ).toMatchObject( {
							type: 'turn.terminal',
							outcome: { status: action === 'abort' ? 'interrupted' : 'error' },
						} );
						expect( await store.readJournals( 'chat' ) ).toEqual( [ report.events ] );
						await (
							await store.lockTurn( 'chat' )
						)();
					}
				} finally {
					// Only the test's own unreaped child is signalled here.
					if ( owner.exitCode === null && owner.signalCode === null ) owner.kill( 'SIGKILL' );
					await exited;
				}
			},
			60_000
		);
	}
);
