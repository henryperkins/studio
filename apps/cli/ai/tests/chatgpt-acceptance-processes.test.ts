// @vitest-environment node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acceptanceRunPaths } from 'cli/ai/acceptance-isolation';
import {
	createLiveAcceptanceProcesses,
	endRunningAcceptanceChildren,
	type TurnOptions,
} from 'cli/ai/chatgpt-acceptance';

/**
 * Real, short-lived Node processes started the way the runner starts its CLI
 * processes: a child that ignores the runner's interrupt and SIGTERM, and a
 * grandchild of its own that ignores SIGTERM too. Each exits by itself within
 * a minute, and `afterEach` ends any this test started that is still running,
 * by its exact PID, so nothing is left whatever the outcome.
 *
 * On Windows a Node child's ordinary children are in its kill-on-close job
 * and end with it however it ends, so the grandchild there is detached: a
 * descendant outside that job, which only a tree kill by the child's PID,
 * made while the child still runs, reaches. On POSIX it stays in the child's
 * process group, which is how the runner reaches it there.
 */
const PID_FILE_VARIABLE = 'STUDIO_ACCEPTANCE_PROCESS_TEST_PIDS';
const SELF_EXIT_MS = 60_000;

const CHILD_SCRIPT = `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const grandchild = spawn(
	process.execPath,
	[ '-e', 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), ${ SELF_EXIT_MS }); setInterval(() => {}, 1000);' ],
	{ stdio: 'ignore', detached: process.platform === 'win32', windowsHide: true }
);
process.on( 'SIGTERM', () => {} );
process.on( 'message', () => {} );
setTimeout( () => process.exit( 0 ), ${ SELF_EXIT_MS } );
setInterval( () => {}, 1000 );
fs.writeFileSync(
	process.env.${ PID_FILE_VARIABLE },
	JSON.stringify( { child: process.pid, grandchild: grandchild.pid } )
);
`;

function isRunning( pid: number ): boolean {
	try {
		process.kill( pid, 0 );
		return true;
	} catch ( error ) {
		return ( error as NodeJS.ErrnoException ).code === 'EPERM';
	}
}

// Ends a process this test started, by its exact PID only.
function endStartedProcess( pid: number ): void {
	if ( ! isRunning( pid ) ) {
		return;
	}
	if ( process.platform === 'win32' ) {
		spawnSync( 'taskkill', [ '/PID', String( pid ), '/T', '/F' ], {
			windowsHide: true,
			stdio: 'ignore',
			timeout: 10_000,
		} );
	} else {
		try {
			process.kill( pid, 'SIGKILL' );
		} catch {
			// Gone meanwhile.
		}
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
	const savedPidFile = process.env[ PID_FILE_VARIABLE ];
	let base: string;
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

	function processes() {
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
		mainScript = path.join( base, 'child.mjs' );
		fs.writeFileSync( mainScript, CHILD_SCRIPT );
		pidFile = path.join( base, 'pids.json' );
		process.env[ PID_FILE_VARIABLE ] = pidFile;
		started = [];
	} );

	afterEach( async () => {
		for ( const pid of started ) {
			endStartedProcess( pid );
		}
		await waitUntilGone( started );
		if ( savedPidFile === undefined ) {
			delete process.env[ PID_FILE_VARIABLE ];
		} else {
			process.env[ PID_FILE_VARIABLE ] = savedPidFile;
		}
		fs.rmSync( base, { recursive: true, force: true, maxRetries: 5 } );
	} );

	it( 'ends a forked turn that ignores the interrupt together with its grandchild', async () => {
		const turn = processes().startTurn( turnOptions( true ) );
		const { child, grandchild } = await startedPids();
		expect( isRunning( child ) && isRunning( grandchild ) ).toBe( true );

		await turn.stop();

		expect( await waitUntilGone( [ child, grandchild ] ) ).toEqual( [] );
		expect( ( await turn.result ).pid ).toBe( child );
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

	it( 'ends every running tree at once when the runner has to exit before cleanup', async () => {
		const turn = processes().startTurn( turnOptions( true ) );
		const { child, grandchild } = await startedPids();

		endRunningAcceptanceChildren();

		expect( await waitUntilGone( [ child, grandchild ] ) ).toEqual( [] );
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
		started.push( ...( result.pid === undefined ? [] : [ result.pid ] ) );
		expect( result.events ).toHaveLength( 1 );
		expect( result.events[ 0 ].persistedAtReceipt ).toBeNull();
	}, 30_000 );
} );
