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

export interface OwnedProcessOptions {
	cwd?: string;
	env: NodeJS.ProcessEnv;
	/**
	 * Runs the keeper under a detached supervisor, which ends the owned tree if
	 * this process dies before shutting it down. The supervisor runs on
	 * `nodePath`. Without it, the tree is ended only by `shutdown`.
	 */
	supervise?: boolean;
}

export interface OwnedProcess {
	readonly child: ChildProcessWithoutNullStreams;
	/**
	 * Resolves true once the child's identity is verified and its keeper or
	 * supervisor runs; false when any of them could not be established.
	 */
	ready(): Promise< boolean >;
	/** The child's verified identity. */
	identity(): ProcessIdentity | undefined;
	/** The owned processes alive now, and whether any could not be decided. */
	inspect(): Promise< { live: ProcessIdentity[]; uncertain: boolean } >;
	/** Ends the child's input and, on POSIX, sends SIGTERM to its group. */
	requestShutdown(): Promise< void >;
	/** Whether the child (and on POSIX its whole group) exited within the bound. */
	waitForExit( timeoutMs: number ): Promise< boolean >;
	/** Kills whatever remains of the owned tree; true only when nothing owned is left. */
	terminate( timeoutMs?: number ): Promise< boolean >;
	/**
	 * `requestShutdown`, `waitForExit( graceMs )`, then `terminate`. Lets the
	 * keeper and supervisor go only when the tree is gone, so they still act if not.
	 */
	shutdown( options?: { graceMs?: number; timeoutMs?: number } ): Promise< boolean >;
}

const SUPERVISOR_LABEL = 'studio-owned-process-supervisor';

// The supervisor reads one line naming its keeper, starts it and relays lines
// both ways. A `release` line lets both end quietly. The end of its input,
// which the OS delivers whenever Studio's process exits, tells the keeper
// `gone`, so it ends the tree first.
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

function supervisorEnvironment( seams: OwnedProcessSeams ): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv =
		seams.platform === 'win32'
			? Object.fromEntries(
					Object.entries( seams.env ).filter( ( [ name ] ) => name.toUpperCase() === 'SYSTEMROOT' )
			  )
			: { PATH: '/usr/bin:/bin' };
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
		helper,
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
		/** Stops the keeper (and supervisor) from keeping this process alive. */
		detach() {
			helper.unref();
			( helper.stdin as unknown as Unreferenced ).unref?.();
			( helper.stdout as unknown as Unreferenced ).unref?.();
		},
		/** Lets the keeper end without touching the tree. */
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

/**
 * Spawns `command` as an owned process. On POSIX it leads a new session and
 * process group. On Windows it stays in the job object Node puts its children
 * in, so the OS ends it with this process, and a keeper tracks its
 * descendants (see owned-process-windows).
 */
export function spawnOwnedProcess(
	command: string,
	args: readonly string[],
	options: OwnedProcessOptions,
	overrides: Partial< OwnedProcessSeams > = {}
): OwnedProcess {
	const seams = seamsWith( overrides );
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

	let identity: ProcessIdentity | undefined;
	let keeper: ReturnType< typeof converse > | undefined;

	function startKeeper( helper: {
		command: string;
		args: string[];
		env: NodeJS.ProcessEnv;
		timeout: number;
	} ) {
		if ( ! options.supervise )
			return converse(
				seams.spawn( helper.command, helper.args, {
					env: helper.env,
					stdio: [ 'pipe', 'pipe', 'ignore' ],
					windowsHide: true,
				} )
			);
		const supervisor = converse(
			seams.spawn( seams.nodePath, [ '-e', SUPERVISOR_SOURCE, SUPERVISOR_LABEL ], {
				detached: true,
				stdio: [ 'pipe', 'pipe', 'ignore' ],
				windowsHide: true,
				env: supervisorEnvironment( seams ),
			} )
		);
		supervisor.send( JSON.stringify( helper ) );
		return supervisor;
	}

	const established = ( async () => {
		const pid = child.pid;
		if ( ! pid || ! unreaped() ) return false;
		let start: string | undefined;
		if ( windows ) {
			keeper = startKeeper( windowsKeeperCommand( pid, seams ) );
			const replies = await keeper.ask( undefined, /^(ready \d{1,19}|failed)$/, 30_000 );
			start = /^ready (\d{1,19})$/.exec( replies?.at( -1 ) ?? '' )?.[ 1 ];
		} else {
			const found = await probe( pid, seams );
			if ( found.state === 'running' ) start = found.start;
			if ( start && unreaped() && options.supervise ) {
				keeper = startKeeper( posixKeeperCommand( pid, start ) );
				if ( ( await keeper.ask( undefined, /^(ready|failed)$/, 30_000 ) )?.at( -1 ) !== 'ready' )
					start = undefined;
			}
		}
		// Read while this process had not reaped the child, so the PID could not name another process.
		if ( ! start || ! unreaped() ) {
			await keeper?.release();
			keeper = undefined;
			return false;
		}
		identity = { pid, start };
		keeper?.detach();
		return true;
	} )().catch( () => false );

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
		if ( windows ) return true;
		let state = await signalGroup( 0 );
		while ( state === 'sent' && seams.now() < deadline ) {
			await seams.delay( 50 );
			state = await signalGroup( 0 );
		}
		return state === 'empty';
	}

	async function terminate( timeoutMs = 10_000 ): Promise< boolean > {
		if ( failed ) return true;
		await established;
		if ( windows ) {
			if ( ! identity || ! keeper ) {
				if ( unreaped() ) child.kill( 'SIGKILL' );
				return false;
			}
			const replies = await keeper.ask(
				`reap ${ Math.max( 0, Math.round( timeoutMs ) ) }`,
				/^reaped (clean|dirty)$/,
				timeoutMs + 30_000
			);
			return replies?.at( -1 ) === 'reaped clean';
		}
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
			return { live, uncertain: replies.some( ( line ) => line.startsWith( 'uncertain ' ) ) };
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
		identity: () => identity,
		inspect,
		requestShutdown,
		waitForExit,
		terminate,
		async shutdown( { graceMs = 2_000, timeoutMs = 10_000 } = {} ) {
			await requestShutdown();
			await waitForExit( graceMs );
			const clean = await terminate( timeoutMs );
			if ( clean ) {
				await keeper?.release();
				keeper = undefined;
			}
			return clean;
		},
	};
}
