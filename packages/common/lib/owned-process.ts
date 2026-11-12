import { execFile, spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	posixGroupMembers,
	posixKeeperCommand,
	probePosixProcess,
} from '@studio/common/lib/owned-process-posix';
import {
	probeWindowsProcess,
	windowsKeeperCommand,
} from '@studio/common/lib/owned-process-windows';
import type {
	ChildProcess,
	ChildProcessByStdio,
	ChildProcessWithoutNullStreams,
} from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/**
 * Processes Studio starts and must be able to end completely: the child, and
 * everything that descends from it by a mechanism the OS guarantees. Nothing
 * here signals a process by name or by a PID alone; each signal goes to a
 * process or group whose recorded start identity still holds at that moment.
 */

/**
 * A process as the OS identifies it: its PID and the start time the OS
 * recorded when it was created, which changes when the PID is reused. `start`
 * is opaque and compared exactly:
 * - Windows: the creation time as a FILETIME (100 ns since 1601, UTC);
 * - Linux: `linux:<boot id>:<start time in clock ticks since boot>`;
 * - macOS and other POSIX systems: `ps:<ps lstart in UTC>`, to the second.
 */
export interface ProcessIdentity {
	readonly pid: number;
	readonly start: string;
}

/**
 * Whether a recorded process is still that same live process: `alive`; `gone`
 * when no process has the PID, it has exited, or another process has it now;
 * `unknown` when the OS could not be read. An unknown identity is never gone.
 */
export type ProcessIdentityCheck = 'alive' | 'gone' | 'unknown';

export type ProcessProbe =
	| { state: 'running'; start: string }
	| { state: 'gone' }
	| { state: 'unknown' };

/** A helper command, run without a shell. */
export interface SupervisedCommand {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	timeout: number;
}

export interface OwnedProcessSeams {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	/** Runs a helper without a shell. Resolves with its exit code; rejects when it cannot run or times out. */
	run(
		file: string,
		args: readonly string[],
		options: { env: NodeJS.ProcessEnv; timeout: number }
	): Promise< { code: number | null; stdout: string } >;
	readFile( file: string ): Promise< string >;
	readdir( directory: string ): Promise< string[] >;
	kill( pid: number, signal: NodeJS.Signals | 0 ): void;
	spawn: typeof spawn;
	now(): number;
	delay( ms: number ): Promise< void >;
	/** The Node executable a supervisor runs on. */
	nodePath: string;
}

function runHelper(
	file: string,
	args: readonly string[],
	options: { env: NodeJS.ProcessEnv; timeout: number }
): Promise< { code: number | null; stdout: string } > {
	return new Promise( ( resolve, reject ) => {
		execFile(
			file,
			[ ...args ],
			{
				env: options.env,
				timeout: options.timeout,
				windowsHide: true,
				maxBuffer: 4 * 1024 * 1024,
				encoding: 'utf8',
			},
			( error, stdout ) => {
				if ( ! error ) return resolve( { code: 0, stdout } );
				const { code, killed } = error as { code?: unknown; killed?: boolean };
				if ( typeof code === 'number' && ! killed ) return resolve( { code, stdout } );
				reject( error );
			}
		);
	} );
}

function seamsWith( overrides: Partial< OwnedProcessSeams > ): OwnedProcessSeams {
	return {
		platform: process.platform,
		env: process.env,
		run: runHelper,
		readFile: ( file ) => readFile( file, 'utf8' ),
		readdir: ( directory ) => readdir( directory ),
		kill: ( pid, signal ) => void process.kill( pid, signal ),
		spawn,
		now: Date.now,
		delay: ( ms ) => sleep( ms ),
		nodePath: process.execPath,
		...overrides,
	};
}

function isPid( pid: number ): boolean {
	return Number.isSafeInteger( pid ) && pid > 0;
}

async function probe( pid: number, seams: OwnedProcessSeams ): Promise< ProcessProbe > {
	if ( ! isPid( pid ) ) return { state: 'unknown' };
	try {
		return seams.platform === 'win32'
			? await probeWindowsProcess( pid, seams )
			: await probePosixProcess( pid, seams );
	} catch {
		return { state: 'unknown' };
	}
}

/** The identity of the process that has `pid` now, or undefined when none does or it cannot be read. */
export async function readProcessIdentity(
	pid: number,
	overrides: Partial< OwnedProcessSeams > = {}
): Promise< ProcessIdentity | undefined > {
	const found = await probe( pid, seamsWith( overrides ) );
	return found.state === 'running' ? { pid, start: found.start } : undefined;
}

/** Whether `identity` is still the same live process. */
export async function checkProcessIdentity(
	identity: ProcessIdentity,
	overrides: Partial< OwnedProcessSeams > = {}
): Promise< ProcessIdentityCheck > {
	if ( ! isPid( identity.pid ) || ! identity.start ) return 'unknown';
	const found = await probe( identity.pid, seamsWith( overrides ) );
	if ( found.state === 'unknown' ) return 'unknown';
	return found.state === 'running' && found.start === identity.start ? 'alive' : 'gone';
}

/** Why Studio could not take ownership of a process tree. */
export type OwnershipFailure =
	/** The Windows keeper did not start: PowerShell or Add-Type failed or was blocked. */
	| 'keeper-unavailable'
	/** Windows could not create the job object. */
	| 'job-unavailable'
	/** The keeper could not open the process. */
	| 'process-unavailable'
	/** The process exited before its ownership was confirmed. */
	| 'process-exited'
	/** Windows refused to put the process in the job (access denied). */
	| 'job-assignment-denied'
	| 'job-assignment-failed'
	/** The job could not be limited, or the process is not shown in it. */
	| 'job-unverified'
	/** The process already had a child outside the job when it was assigned. */
	| 'job-incomplete'
	/** POSIX: the process's start identity could not be read. */
	| 'identity-unavailable'
	/** POSIX: the supervisor or its keeper did not start. */
	| 'supervisor-unavailable';

export interface OwnedProcessOptions {
	cwd?: string;
	env: NodeJS.ProcessEnv;
	/**
	 * POSIX: runs a detached supervisor, on `nodePath`, that ends the group if
	 * this process dies before shutting it down. Windows needs none: the job
	 * ends with this process.
	 */
	supervise?: boolean;
}

export interface OwnedProcess {
	readonly child: ChildProcessWithoutNullStreams;
	/**
	 * Resolves true once the child's identity is verified and the child is
	 * owned (in the job on Windows; supervised on POSIX when asked for);
	 * false when that could not be established, with `failure` saying why.
	 */
	ready(): Promise< boolean >;
	failure(): OwnershipFailure | undefined;
	/** The child's verified identity. */
	identity(): ProcessIdentity | undefined;
	/** The owned processes alive now, and whether any could not be decided. */
	inspect(): Promise< { live: ProcessIdentity[]; uncertain: boolean } >;
	/** Ends the child's input and, on POSIX, sends SIGTERM to its group. */
	requestShutdown(): Promise< void >;
	/** Whether the child and everything owned with it exited within the bound. */
	waitForExit( timeoutMs: number ): Promise< boolean >;
	/** Kills whatever remains of the owned tree; true only when nothing owned is left. */
	terminate( timeoutMs?: number ): Promise< boolean >;
	/**
	 * `requestShutdown`, `waitForExit( graceMs )`, then `terminate`. Lets the
	 * keeper or supervisor go only when the tree is gone, so it still acts if not.
	 */
	shutdown( options?: { graceMs?: number; timeoutMs?: number } ): Promise< boolean >;
}

/**
 * Ownership made ready before the process exists. On Windows its keeper
 * creates the job first, so the process is assigned within moments of its
 * creation; on POSIX there is nothing to prepare.
 */
export interface ProcessOwner {
	prepared(): Promise< boolean >;
	failure(): OwnershipFailure | undefined;
	/** Spawns the one process this owner owns. */
	spawn( command: string, args: readonly string[], options: OwnedProcessOptions ): OwnedProcess;
	/** Ends the keeper of an owner that never spawned. */
	dispose(): Promise< void >;
}

const SUPERVISOR_LABEL = 'studio-owned-process-supervisor';

// The POSIX supervisor reads one line naming its keeper, starts it and relays
// lines both ways. A `release` line lets both end quietly. The end of its
// input, which the OS delivers whenever Studio's process exits, tells the
// keeper `gone`, so it ends the group first.
const SUPERVISOR_SOURCE = [
	"'use strict';",
	"const { spawn } = require( 'child_process' );",
	"let keeper; let buffer = ''; let ending = false; let timeout = 60000;",
	'function end( gone ) {',
	'	if ( ending ) return;',
	'	ending = true;',
	'	if ( ! keeper ) process.exit( 0 );',
	"	if ( gone ) try { keeper.stdin.write( 'gone ' + ( Date.now() + 1 ) + '\\n' ); } catch {}",
	'	try { keeper.stdin.end(); } catch {}',
	'	setTimeout( () => { try { keeper.kill(); } catch {} process.exit( 0 ); }, timeout );',
	'}',
	"process.stdout.on( 'error', () => {} );",
	"process.stdin.setEncoding( 'utf8' );",
	"process.stdin.on( 'data', ( chunk ) => {",
	'	buffer += chunk;',
	"	for ( let index = buffer.indexOf( '\\n' ); index >= 0; index = buffer.indexOf( '\\n' ) ) {",
	'		const line = buffer.slice( 0, index );',
	'		buffer = buffer.slice( index + 1 );',
	'		if ( ! keeper ) {',
	'			const config = JSON.parse( line );',
	'			timeout = config.timeout;',
	"			keeper = spawn( config.command, config.args, { env: config.env, stdio: [ 'pipe', 'pipe', 'ignore' ], windowsHide: true } );",
	"			keeper.stdin.on( 'error', () => {} );",
	"			keeper.stdout.on( 'data', ( data ) => { try { process.stdout.write( data ); } catch {} } );",
	"			keeper.on( 'exit', () => process.exit( 0 ) );",
	"			keeper.on( 'error', () => process.exit( 1 ) );",
	"		} else if ( line === 'release' ) {",
	"			try { keeper.stdin.write( 'release\\n' ); } catch {}",
	'			end( false );',
	"		} else try { keeper.stdin.write( line + '\\n' ); } catch {}",
	'	}',
	'} );',
	"process.stdin.on( 'end', () => end( true ) );",
	"process.stdin.on( 'error', () => end( true ) );",
].join( '\n' );

function supervisorEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
	if ( process.versions.electron ) env.ELECTRON_RUN_AS_NODE = '1';
	return env;
}

function exitedWithin( child: ChildProcess, ms: number ): Promise< boolean > {
	if ( child.exitCode !== null || child.signalCode !== null ) return Promise.resolve( true );
	return new Promise( ( resolve ) => {
		const done = ( value: boolean ) => {
			clearTimeout( timer );
			child.off( 'exit', onExit );
			resolve( value );
		};
		const onExit = () => done( true );
		const timer = setTimeout( () => done( false ), Math.max( 0, ms ) );
		child.once( 'exit', onExit );
	} );
}

interface Unreferenced {
	unref?(): void;
}

// A line-by-line conversation with a keeper, directly or through its supervisor.
function converse( helper: ChildProcessByStdio< Writable, Readable, null > ) {
	const lines: string[] = [];
	let buffer = '';
	let ended = false;
	let wake: ( () => void ) | undefined;
	let turn = Promise.resolve();
	helper.once( 'error', () => {} );
	helper.stdin.on( 'error', () => {} );
	helper.stdout.setEncoding( 'utf8' );
	helper.stdout.on( 'data', ( chunk: string ) => {
		buffer += chunk;
		for ( let end = buffer.indexOf( '\n' ); end >= 0; end = buffer.indexOf( '\n' ) ) {
			lines.push( buffer.slice( 0, end ).replace( /\r$/, '' ) );
			buffer = buffer.slice( end + 1 );
		}
		wake?.();
	} );
	const stop = () => {
		ended = true;
		wake?.();
	};
	helper.once( 'exit', stop );
	helper.once( 'error', stop );

	function collect( last: RegExp, timeoutMs: number ): Promise< string[] | undefined > {
		return new Promise( ( resolve ) => {
			const collected: string[] = [];
			const finish = ( value: string[] | undefined ) => {
				clearTimeout( timer );
				wake = undefined;
				resolve( value );
			};
			const timer = setTimeout( () => finish( undefined ), timeoutMs );
			wake = () => {
				while ( lines.length ) {
					const line = lines.shift()!;
					collected.push( line );
					if ( last.test( line ) ) return finish( collected );
				}
				if ( ended ) finish( undefined );
			};
			wake();
		} );
	}

	return {
		/** Whether the helper has exited. */
		ended: () => ended,
		send( line: string ) {
			try {
				helper.stdin.write( line + '\n' );
			} catch {
				// The helper is gone; the next question finds that out.
			}
		},
		/** Sends `line`, if any, and collects the replies up to one matching `last`. */
		ask( line: string | undefined, last: RegExp, timeoutMs: number ) {
			const asked = turn.then( () => {
				if ( ended ) return undefined;
				if ( line !== undefined )
					try {
						helper.stdin.write( line + '\n' );
					} catch {
						return undefined;
					}
				return collect( last, timeoutMs );
			} );
			turn = asked.then( () => undefined );
			return asked;
		},
		/** Stops the helper from keeping this process alive. */
		detach() {
			helper.unref();
			( helper.stdin as unknown as Unreferenced ).unref?.();
			( helper.stdout as unknown as Unreferenced ).unref?.();
		},
		/** Ends the helper, which closes whatever it holds. */
		async release() {
			if ( helper.exitCode !== null || helper.signalCode !== null ) return;
			const gone = exitedWithin( helper, 5_000 );
			try {
				helper.stdin.end( 'release\n' );
			} catch {
				// It already stopped reading.
			}
			// This process's own unreaped child: its PID cannot name another process.
			if ( ! ( await gone ) && helper.exitCode === null && helper.signalCode === null )
				helper.kill();
		},
	};
}

type Conversation = ReturnType< typeof converse >;

const WINDOWS_FAILURES: ReadonlyArray< [ RegExp, OwnershipFailure ] > = [
	[ /^failed open /, 'process-unavailable' ],
	[ /^failed assign 5 /, 'job-assignment-denied' ],
	[ /^failed assign /, 'job-assignment-failed' ],
	[ /^failed (limit|verify) /, 'job-unverified' ],
	[ /^failed outside /, 'job-incomplete' ],
];

/**
 * Prepares ownership for one process. On Windows this starts the keeper, which
 * creates the job; `prepared` resolves once it exists.
 */
export function prepareProcessOwner( overrides: Partial< OwnedProcessSeams > = {} ): ProcessOwner {
	const seams = seamsWith( overrides );
	let keeper: Conversation | undefined;
	let failure: OwnershipFailure | undefined;
	let prepared: Promise< boolean > = Promise.resolve( true );
	if ( seams.platform === 'win32' ) {
		try {
			const helper = windowsKeeperCommand( seams );
			keeper = converse(
				seams.spawn( helper.command, helper.args, {
					env: helper.env,
					stdio: [ 'pipe', 'pipe', 'ignore' ],
					windowsHide: true,
				} )
			);
			keeper.detach();
			prepared = keeper.ask( undefined, /^(prepared|failed .*)$/, 60_000 ).then( ( replies ) => {
				const last = replies?.at( -1 );
				if ( last === 'prepared' ) return true;
				failure = last?.startsWith( 'failed job ' ) ? 'job-unavailable' : 'keeper-unavailable';
				return false;
			} );
		} catch {
			failure = 'keeper-unavailable';
			prepared = Promise.resolve( false );
		}
	}
	let used = false;
	return {
		prepared: () => prepared,
		failure: () => failure,
		spawn( command, args, options ) {
			if ( used ) throw new Error( 'An owner owns one process' );
			used = true;
			return ownProcess( command, args, options, seams, keeper, prepared, () => failure );
		},
		async dispose() {
			if ( ! used ) await keeper?.release();
		},
	};
}

function ownProcess(
	command: string,
	args: readonly string[],
	options: OwnedProcessOptions,
	seams: OwnedProcessSeams,
	jobKeeper: Conversation | undefined,
	prepared: Promise< boolean >,
	preparationFailure: () => OwnershipFailure | undefined
): OwnedProcess {
	const windows = seams.platform === 'win32';
	const child = seams.spawn( command, [ ...args ], {
		cwd: options.cwd,
		env: options.env,
		detached: ! windows,
		stdio: 'pipe',
		windowsHide: true,
	} ) as ChildProcessWithoutNullStreams;
	const failed = ! child.pid;
	child.once( 'error', () => {} );
	// Until this process reaps the child, its PID cannot name any other process.
	const unreaped = () => ! failed && child.exitCode === null && child.signalCode === null;
	// The keeper reads this once its job exists, and assigns at once.
	if ( jobKeeper && child.pid ) jobKeeper.send( `own ${ child.pid }` );

	let identity: ProcessIdentity | undefined;
	let failure: OwnershipFailure | undefined;
	let keeper: Conversation | undefined = jobKeeper;
	// Windows: whether the keeper holds a handle to the child, and whether it
	// put the child in the job after Studio confirmed it was its own.
	let opened = false;
	let confirmed = false;

	async function establishWindows( pid: number ): Promise< boolean > {
		if ( ! keeper || ! ( await prepared ) ) {
			failure = preparationFailure() ?? 'keeper-unavailable';
			return false;
		}
		const assigned = (
			await keeper.ask( undefined, /^(assigned \d{1,19}|failed .*)$/, 30_000 )
		)?.at( -1 );
		const start = /^assigned (\d{1,19})$/.exec( assigned ?? '' )?.[ 1 ];
		opened = !! start || /^failed assign \d+ \d+$/.test( assigned ?? '' );
		if ( ! start ) {
			failure =
				WINDOWS_FAILURES.find( ( [ pattern ] ) => pattern.test( assigned ?? '' ) )?.[ 1 ] ??
				'keeper-unavailable';
			return false;
		}
		// The keeper opened the PID while this process had not reaped the child,
		// so the handle is the child's. Otherwise nothing proves it: the keeper
		// ends without having set kill-on-close, so it kills nothing.
		if ( ! unreaped() ) {
			failure = 'process-exited';
			opened = false;
			await keeper.release();
			keeper = undefined;
			return false;
		}
		const ready = (
			await keeper.ask( 'confirm', /^(ready \d{1,19} in-job|failed .*)$/, 30_000 )
		)?.at( -1 );
		// Kill-on-close is set unless the keeper said otherwise or went quiet.
		confirmed = !! ready && ! ready.startsWith( 'failed limit ' );
		if ( ready !== `ready ${ start } in-job` ) {
			failure =
				WINDOWS_FAILURES.find( ( [ pattern ] ) => pattern.test( ready ?? '' ) )?.[ 1 ] ??
				'keeper-unavailable';
			return false;
		}
		identity = { pid, start };
		return true;
	}

	async function establishPosix( pid: number ): Promise< boolean > {
		const found = await probe( pid, seams );
		if ( found.state !== 'running' || ! unreaped() ) {
			failure = found.state === 'running' ? 'process-exited' : 'identity-unavailable';
			return false;
		}
		if ( options.supervise ) {
			const supervisor = converse(
				seams.spawn( seams.nodePath, [ '-e', SUPERVISOR_SOURCE, SUPERVISOR_LABEL ], {
					detached: true,
					stdio: [ 'pipe', 'pipe', 'ignore' ],
					windowsHide: true,
					env: supervisorEnvironment(),
				} )
			);
			keeper = supervisor;
			supervisor.send( JSON.stringify( posixKeeperCommand( pid, found.start ) ) );
			if (
				( await supervisor.ask( undefined, /^(ready|failed)$/, 30_000 ) )?.at( -1 ) !== 'ready'
			) {
				failure = 'supervisor-unavailable';
				await supervisor.release();
				keeper = undefined;
				return false;
			}
			supervisor.detach();
		}
		if ( ! unreaped() ) {
			failure = 'process-exited';
			return false;
		}
		identity = { pid, start: found.start };
		return true;
	}

	const established = ( async () => {
		const pid = child.pid;
		if ( ! pid ) return false;
		return windows ? establishWindows( pid ) : establishPosix( pid );
	} )().catch( () => {
		failure ??= windows ? 'keeper-unavailable' : 'identity-unavailable';
		return false;
	} );

	// POSIX: signals the child's group, if it is still the child's. 'empty'
	// when the group no longer exists, 'unknown' when that cannot be told.
	async function signalGroup(
		signal: NodeJS.Signals | 0
	): Promise< 'sent' | 'empty' | 'unknown' > {
		const pgid = child.pid;
		if ( failed || ! pgid ) return 'empty';
		if ( ! unreaped() ) {
			if ( ! identity ) return 'unknown';
			const leader = await probe( pgid, seams );
			if ( leader.state === 'unknown' ) return 'unknown';
			// POSIX reuses a group's ID as a PID only once the group has no members.
			if ( leader.state === 'running' && leader.start !== identity.start ) return 'empty';
		}
		try {
			seams.kill( -pgid, signal );
			return 'sent';
		} catch ( error ) {
			return ( error as NodeJS.ErrnoException ).code === 'ESRCH' ? 'empty' : 'unknown';
		}
	}

	async function requestShutdown(): Promise< void > {
		try {
			if ( ! child.stdin.writableEnded ) child.stdin.end();
		} catch {
			// The child already closed its input.
		}
		if ( ! windows ) await signalGroup( 'SIGTERM' );
	}

	async function waitForExit( timeoutMs: number ): Promise< boolean > {
		const deadline = seams.now() + timeoutMs;
		if ( ! failed && ! ( await exitedWithin( child, timeoutMs ) ) ) return false;
		if ( windows ) {
			if ( ! keeper || ! identity ) return true;
			while ( true ) {
				const count = ( await keeper.ask( 'active', /^active -?\d+$/, 10_000 ) )?.at( -1 );
				if ( count === 'active 0' ) return true;
				if ( ! count || seams.now() >= deadline ) return false;
				await seams.delay( 50 );
			}
		}
		let state = await signalGroup( 0 );
		while ( state === 'sent' && seams.now() < deadline ) {
			await seams.delay( 50 );
			state = await signalGroup( 0 );
		}
		return state === 'empty';
	}

	// Windows: whether the child's live children, in the job or not, are none.
	async function noChildren(): Promise< boolean > {
		if ( ! keeper || ! opened ) return false;
		return (
			( await keeper.ask( 'children', /^children -?\d+$/, 20_000 ) )?.at( -1 ) === 'children 0'
		);
	}

	async function terminateWindows( timeoutMs: number ): Promise< boolean > {
		if ( confirmed && keeper ) {
			const reaped = (
				await keeper.ask(
					`reap ${ Math.max( 0, Math.round( timeoutMs ) ) }`,
					/^reaped (clean|dirty)$/,
					timeoutMs + 30_000
				)
			)?.at( -1 );
			// A keeper that has ended closed the job, and kill-on-close ended
			// everything in it; what is left to see is the child itself.
			if ( ! reaped && keeper.ended() ) return !! identity && exitedWithin( child, 5_000 );
			if ( reaped !== 'reaped clean' ) return false;
			if ( identity ) return true;
		}
		// The child is not, or not provably, in a kill-on-close job: only the
		// child itself can be ended, through this process's own handle, and
		// then its children must be none.
		if ( unreaped() ) child.kill( 'SIGKILL' );
		await exitedWithin( child, 5_000 );
		return noChildren();
	}

	async function terminate( timeoutMs = 10_000 ): Promise< boolean > {
		if ( failed ) return true;
		await established;
		if ( windows ) return terminateWindows( timeoutMs );
		const deadline = seams.now() + timeoutMs;
		let state = await signalGroup( 'SIGKILL' );
		while ( state === 'sent' && seams.now() < deadline ) {
			await seams.delay( 50 );
			state = await signalGroup( 0 );
			if ( state === 'sent' ) state = await signalGroup( 'SIGKILL' );
		}
		return state === 'empty';
	}

	async function inspect(): Promise< { live: ProcessIdentity[]; uncertain: boolean } > {
		if ( failed ) return { live: [], uncertain: false };
		await established;
		if ( ! identity ) return { live: [], uncertain: true };
		if ( windows ) {
			const replies = keeper && ( await keeper.ask( 'inspect', /^inspected$/, 30_000 ) );
			if ( ! replies ) return { live: [], uncertain: true };
			const live: ProcessIdentity[] = [];
			for ( const line of replies ) {
				const found = /^live (\d+) (\d{1,19})$/.exec( line );
				if ( found ) live.push( { pid: Number( found[ 1 ] ), start: found[ 2 ] } );
			}
			return { live, uncertain: replies.includes( 'uncertain' ) };
		}
		const state = await signalGroup( 0 );
		if ( state !== 'sent' ) return { live: [], uncertain: state === 'unknown' };
		const members = await posixGroupMembers( identity.pid, seams );
		if ( ! members ) return { live: [], uncertain: true };
		const found = await Promise.all( members.map( ( pid ) => probe( pid, seams ) ) );
		return {
			live: found.flatMap( ( item, index ) =>
				item.state === 'running' ? [ { pid: members[ index ], start: item.start } ] : []
			),
			uncertain: found.some( ( item ) => item.state === 'unknown' ),
		};
	}

	return {
		child,
		ready: () => established,
		failure: () => failure,
		identity: () => identity,
		inspect,
		requestShutdown,
		waitForExit,
		terminate,
		async shutdown( { graceMs = 2_000, timeoutMs = 10_000 } = {} ) {
			await requestShutdown();
			await waitForExit( graceMs );
			const clean = await terminate( timeoutMs );
			// Releasing the Windows keeper closes the job, which ends anything
			// still in it once kill-on-close is set; a POSIX supervisor is kept
			// to try again when this process exits.
			if ( clean || windows ) {
				await keeper?.release();
				keeper = undefined;
			}
			return clean;
		},
	};
}
