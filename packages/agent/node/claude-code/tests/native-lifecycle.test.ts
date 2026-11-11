import { execFile, fork, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { once } from 'events';
import { mkdir, mkdtemp, realpath, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { checkProcessIdentity, readProcessIdentity } from '@studio/common/lib/owned-process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildClaudeEnvironment } from '../auth-status';
import { inspectClaudeExecutable, trustedPowerShellPath } from '../discovery';
import { createNativeSessionStore } from '../sessions';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';
import type { ProcessIdentity } from '@studio/common/lib/owned-process';

const executable = process.env.STUDIO_TEST_NATIVE_CLAUDE_LIFECYCLE_EXE;
const exec = promisify( execFile );
const LIFETIME = 45_000;

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
		sentinel = spawn( process.execPath, [ nativeFixture, 'leaf', marker, String( LIFETIME ) ], {
			stdio: [ 'ignore', 'pipe', 'ignore' ],
			windowsHide: true,
		} );
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

	it.each( [ 'close', 'abort', 'eof', 'kill-native', 'kill-owner' ] )(
		'leaves no owned process after %s, spares an unrelated one, and runs nothing the cancelled approval held',
		async ( action ) => {
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
				expect( ( await store.readJournals( 'chat' ) ).at( -1 )?.at( -1 ) ).toEqual(
					terminals[ 0 ]
				);
				await (
					await store.lockTurn( 'chat' )
				)();
			} finally {
				// The test's own unreaped child; everything below it is the runtime's to end.
				if ( runner.exitCode === null && runner.signalCode === null ) runner.kill( 'SIGKILL' );
				await exited;
			}
		},
		90_000
	);
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
