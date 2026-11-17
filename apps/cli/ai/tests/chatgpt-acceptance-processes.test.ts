// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptanceRunPaths } from 'cli/ai/acceptance-isolation';
import { windowsProcessTreeTools } from 'cli/ai/acceptance-process-tree';
import {
	createLiveAcceptanceProcesses,
	endRunningAcceptanceChildren,
	type TurnOptions,
} from 'cli/ai/chatgpt-acceptance';

/**
 * Real, short-lived Node processes started the way the runner starts its CLI
 * processes: a child that ignores the runner's interrupt and SIGTERM, and a
 * grandchild of its own that ignores SIGTERM too.
 *
 * The test itself never ends a process. Each one watches a marker file in the
 * test's own temporary folder and exits by itself once `afterEach` removes it
 * (or after a minute in any case), so whatever a test leaves running ends
 * without anything being ended by a PID that may meanwhile belong to another
 * process. Only the runner's code under test ends processes, through the
 * handles it holds.
 *
 * On Windows a Node child's ordinary children are in its kill-on-close job
 * and end with it however it ends, so the grandchild there is detached: a
 * descendant outside that job, which only the tree stop reaches. On POSIX it
 * stays in the child's process group, which is how the runner reaches it there.
 */
const PID_FILE_VARIABLE = 'STUDIO_ACCEPTANCE_PROCESS_TEST_PIDS';
const MARKER_VARIABLE = 'STUDIO_ACCEPTANCE_PROCESS_TEST_MARKER';
const SELF_EXIT_MS = 60_000;

// Exits once the marker named by its first argument is gone, or after a minute.
const UNTIL_MARKER_GONE = `const fs = require( 'node:fs' );
const marker = process.argv[ 1 ];
process.on( 'SIGTERM', () => {} );
setInterval( () => { if ( ! fs.existsSync( marker ) ) process.exit( 0 ); }, 100 );
setTimeout( () => process.exit( 0 ), ${ SELF_EXIT_MS } );`;

const CHILD_SCRIPT = `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const marker = process.env.${ MARKER_VARIABLE };
const grandchild = spawn( process.execPath, [ '-e', ${ JSON.stringify(
	UNTIL_MARKER_GONE
) }, marker ], {
	stdio: 'ignore',
	detached: process.platform === 'win32',
	windowsHide: true,
} );
process.on( 'SIGTERM', () => {} );
process.on( 'message', () => {} );
setInterval( () => { if ( ! fs.existsSync( marker ) ) process.exit( 0 ); }, 100 );
setTimeout( () => process.exit( 0 ), ${ SELF_EXIT_MS } );
fs.writeFileSync(
	process.env.${ PID_FILE_VARIABLE },
	JSON.stringify( { child: process.pid, grandchild: grandchild.pid } )
);
`;

// Whether a process with this id exists; signal 0 only checks, it delivers nothing.
function isRunning( pid: number ): boolean {
	try {
		process.kill( pid, 0 );
		return true;
	} catch ( error ) {
		return ( error as NodeJS.ErrnoException ).code === 'EPERM';
	}
}

async function waitUntilGone( pids: number[], timeoutMs = 10_000 ): Promise< number[] > {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const running = pids.filter( isRunning );
		if ( running.length === 0 || Date.now() >= deadline ) {
			return running;
		}
		await new Promise( ( resolve ) => setTimeout( resolve, 100 ) );
	}
}

describe( 'stopping the CLI processes an acceptance run started', () => {
	const savedVariables = {
		[ PID_FILE_VARIABLE ]: process.env[ PID_FILE_VARIABLE ],
		[ MARKER_VARIABLE ]: process.env[ MARKER_VARIABLE ],
	};
	let base: string;
	let marker: string;
	let mainScript: string;
	let pidFile: string;
	let started: number[];

	const turnOptions = ( ipc: boolean ): TurnOptions => ( {
		label: 'process-test',
		sessionId: '1d6b5a8e-3c1f-4e2a-9b7d-5f4c3a2b1e00',
		prompt: 'unused',
		offerSessions: false,
		ipc,
		policy: { tools: [] },
	} );

	function processes( print: ( line: string ) => void = () => undefined ) {
		const scripts = {
			observer: path.join( base, 'observer.mjs' ),
			toolImages: path.join( base, 'tool-images.mjs' ),
		};
		fs.writeFileSync( scripts.observer, '' );
		fs.writeFileSync( scripts.toolImages, '' );
		return createLiveAcceptanceProcesses( {
			mainScript,
			scripts,
			paths: acceptanceRunPaths( path.join( base, 'run' ) ),
			print,
		} );
	}

	// The child's and grandchild's PIDs, once the child has started its grandchild.
	async function startedPids(): Promise< { child: number; grandchild: number } > {
		const deadline = Date.now() + 15_000;
		for (;;) {
			try {
				const pids = JSON.parse( fs.readFileSync( pidFile, 'utf8' ) ) as {
					child: number;
					grandchild: number;
				};
				fs.rmSync( pidFile );
				started.push( pids.child, pids.grandchild );
				return pids;
			} catch {
				if ( Date.now() >= deadline ) {
					throw new Error( 'The test child never reported its PIDs.' );
				}
				await new Promise( ( resolve ) => setTimeout( resolve, 50 ) );
			}
		}
	}

	beforeEach( () => {
		base = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-acceptance-processes-' ) );
		marker = path.join( base, 'running' );
		fs.writeFileSync( marker, '' );
		mainScript = path.join( base, 'child.mjs' );
		fs.writeFileSync( mainScript, CHILD_SCRIPT );
		pidFile = path.join( base, 'pids.json' );
		process.env[ PID_FILE_VARIABLE ] = pidFile;
		process.env[ MARKER_VARIABLE ] = marker;
		started = [];
	} );

	afterEach( async () => {
		// Everything this test started exits by itself without the marker.
		fs.rmSync( marker, { force: true } );
		await waitUntilGone( started, 15_000 );
		for ( const [ name, value ] of Object.entries( savedVariables ) ) {
			if ( value === undefined ) {
				delete process.env[ name ];
			} else {
				process.env[ name ] = value;
			}
		}
		fs.rmSync( base, { recursive: true, force: true, maxRetries: 5 } );
	}, 30_000 );

	it( 'ends a forked turn that ignores the interrupt together with its grandchild', async () => {
		const printed: string[] = [];
		const turn = processes( ( line ) => printed.push( line ) ).startTurn( turnOptions( true ) );
		const { child, grandchild } = await startedPids();
		expect( isRunning( child ) && isRunning( grandchild ) ).toBe( true );

		await turn.stop();

		expect( await waitUntilGone( [ child, grandchild ] ) ).toEqual( [] );
		expect( ( await turn.result ).pid ).toBe( child );
		// The tree could be listed: nothing to warn about.
		expect( printed ).toEqual( [] );
	}, 30_000 );

	it( 'ends a spawned turn, which has no channel for the interrupt, together with its grandchild', async () => {
		const owned = processes();
		const turn = owned.startTurn( turnOptions( false ) );
		const { child, grandchild } = await startedPids();

		expect( await owned.stopOwned() ).toEqual( { stopped: 1, failed: 0 } );

		expect( await waitUntilGone( [ child, grandchild ] ) ).toEqual( [] );
		await turn.result;
	}, 30_000 );

	it( 'ends a CLI command and its grandchild when cleanup stops what the run owns', async () => {
		const owned = processes();
		const running = owned.runCli( 'process-test', [] );
		const { child, grandchild } = await startedPids();

		expect( await owned.stopOwned() ).toEqual( { stopped: 1, failed: 0 } );

		expect( await waitUntilGone( [ child, grandchild ] ) ).toEqual( [] );
		expect( ( await running ).exitCode ).not.toBe( 0 );
	}, 30_000 );

	it( 'counts and stops only what its own run started, whatever another left running', async () => {
		const other = processes();
		const turn = other.startTurn( turnOptions( true ) );
		const { child, grandchild } = await startedPids();

		expect( await processes().stopOwned() ).toEqual( { stopped: 0, failed: 0 } );
		expect( isRunning( child ) && isRunning( grandchild ) ).toBe( true );

		expect( await other.stopOwned() ).toEqual( { stopped: 1, failed: 0 } );
		expect( await waitUntilGone( [ child, grandchild ] ) ).toEqual( [] );
		await turn.result;
	}, 30_000 );

	it( 'ends every running tree at once when the runner has to exit before cleanup', async () => {
		const turn = processes().startTurn( turnOptions( true ) );
		const { child, grandchild } = await startedPids();
		const onDescendantsMayRemain = vi.fn();

		endRunningAcceptanceChildren( onDescendantsMayRemain );

		expect( await waitUntilGone( [ child, grandchild ] ) ).toEqual( [] );
		expect( onDescendantsMayRemain ).not.toHaveBeenCalled();
		await turn.result;
	}, 30_000 );

	it( 'marks a tool result whose session file it couldn’t read as unknown, never as not yet persisted', async () => {
		// A turn that reports one finished tool call over IPC, then exits.
		fs.writeFileSync(
			mainScript,
			`process.send(
				{
					type: 'message',
					timestamp: '',
					message: { type: 'tool_execution_end', toolCallId: 'g', toolName: 'generate_images', isError: false, result: {} },
				},
				() => process.exit( 0 )
			);`
		);
		const turn = processes().startTurn( {
			...turnOptions( true ),
			persistenceFile: path.join( base, 'no-such-session.jsonl' ),
		} );
		const result = await turn.result;
		expect( result.events ).toHaveLength( 1 );
		expect( result.events[ 0 ].persistedAtReceipt ).toBeNull();
	}, 30_000 );

	describe.runIf( process.platform === 'win32' )( 'the Windows process table', () => {
		// A process of this test's own, held by its handle until it exits.
		async function startSleeper(): Promise< ChildProcess > {
			const sleeper = spawn( process.execPath, [ '-e', UNTIL_MARKER_GONE, marker ], {
				stdio: 'ignore',
				windowsHide: true,
			} );
			await new Promise( ( resolve ) => sleeper.once( 'spawn', resolve ) );
			started.push( sleeper.pid as number );
			return sleeper;
		}

		it( 'lists a process this test started, with this process as its parent', async () => {
			const sleeper = await startSleeper();
			const table = windowsProcessTreeTools.snapshot();
			expect( table ).not.toBeNull();
			const own = table?.find( ( entry ) => entry.pid === sleeper.pid );
			expect( own ).toMatchObject( { parentPid: process.pid } );
			expect( own?.createdAt ).toBeGreaterThan( BigInt( 0 ) );
		}, 30_000 );

		it( 'leaves a process alone when its creation time doesn’t match, and ends it on its own handle when it does', async () => {
			const sleeper = await startSleeper();
			const own = windowsProcessTreeTools
				.snapshot()
				?.find( ( entry ) => entry.pid === sleeper.pid );
			expect( own ).toBeDefined();
			if ( ! own ) {
				return;
			}
			const exited = new Promise( ( resolve ) => sleeper.once( 'exit', resolve ) );

			// One second later than the process really was created: not the same process.
			expect(
				windowsProcessTreeTools.end( [
					{ ...own, createdAt: own.createdAt + BigInt( 10_000_000 ) },
				] )
			).toEqual( [] );
			await new Promise( ( resolve ) => setTimeout( resolve, 500 ) );
			expect( sleeper.exitCode ).toBeNull();
			expect( sleeper.signalCode ).toBeNull();

			expect( windowsProcessTreeTools.end( [ own ] ) ).toEqual( [ sleeper.pid ] );
			await exited;
		}, 30_000 );
	} );
} );
