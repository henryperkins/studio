// Fakes for the OS seams of owned-process: a spawned child, a Windows job
// keeper or POSIX supervisor that answers the real protocol line by line, and
// Linux /proc readings. Shared by the owned-process and runtime tests so both
// drive the real ownership logic without starting any process.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { OwnedProcessSeams } from '@studio/common/lib/owned-process';

export interface FakeChild extends EventEmitter {
	pid: number | undefined;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	stdin: PassThrough;
	stdout: PassThrough;
	stderr: PassThrough;
	killed: NodeJS.Signals[];
	kill( signal?: NodeJS.Signals ): boolean;
	unref(): void;
}

export function fakeChild( pid: number | undefined ): FakeChild {
	const child = new EventEmitter() as FakeChild;
	Object.assign( child, {
		pid,
		exitCode: null,
		signalCode: null,
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		killed: [],
		unref: () => {},
	} );
	child.kill = ( signal: NodeJS.Signals = 'SIGTERM' ) => {
		child.killed.push( signal );
		return true;
	};
	return child;
}

// Exits like a real child: `exit`, then its output ends and `close` follows.
export function exitChild( child: FakeChild, code = 0 ) {
	child.exitCode = code;
	child.emit( 'exit', code, null );
	child.stdout.end();
	child.emit( 'close', code, null );
}

// The lines a keeper writes when it starts (undefined) and in answer to each
// line it reads; null makes it exit.
export type KeeperScript = ( line: string | undefined ) => string[] | null;

const PROTOCOL = /^(own |confirm$|end-tree$|active$|inspect$|reap |self$|release$)/;

/**
 * A spawn seam: the Windows keeper (PowerShell) and the POSIX supervisor
 * (`-e`, whose first line names its keeper) are helpers; anything else is the
 * owned process. A first keeper line that is not part of the protocol is
 * kept as its `input` (its script). `owned` may be a function, which runs at
 * the spawn and may throw as a failed spawn does.
 */
export function fakeSpawn(
	owned: FakeChild | ( () => FakeChild ),
	keeper: KeeperScript = () => []
) {
	const calls: Array< {
		command: string;
		args: readonly string[];
		options: Record< string, unknown >;
	} > = [];
	const helpers: Array< { child: FakeChild; lines: string[]; input?: string } > = [];
	const spawnSeam = ( (
		command: string,
		args: readonly string[],
		options: Record< string, unknown >
	) => {
		calls.push( { command, args, options } );
		if ( args[ 0 ] !== '-e' && ! /powershell\.exe$/i.test( command ) )
			return typeof owned === 'function' ? owned() : owned;
		const child = fakeChild( 9000 + helpers.length );
		const record: { child: FakeChild; lines: string[]; input?: string } = { child, lines: [] };
		helpers.push( record );
		const reply = ( line: string | undefined ) => {
			const out = keeper( line );
			setImmediate( () => {
				if ( child.exitCode !== null ) return;
				if ( out === null ) return exitChild( child, 1 );
				for ( const item of out ) child.stdout.write( item + '\n' );
			} );
		};
		// The supervisor starts once its first line names its keeper.
		const supervisor = args[ 0 ] === '-e';
		let configured = ! supervisor;
		if ( configured ) reply( undefined );
		let first = true;
		let buffer = '';
		child.stdin.setEncoding( 'utf8' );
		child.stdin.on( 'data', ( chunk: string ) => {
			buffer += chunk;
			for ( let end = buffer.indexOf( '\n' ); end >= 0; end = buffer.indexOf( '\n' ) ) {
				const line = buffer.slice( 0, end );
				buffer = buffer.slice( end + 1 );
				if ( first && ! supervisor && ! PROTOCOL.test( line ) ) record.input = line;
				else record.lines.push( line );
				first = false;
				if ( line === record.input ) continue;
				if ( configured ) reply( line );
				else {
					configured = true;
					reply( undefined );
				}
			}
		} );
		child.stdin.on( 'finish', () =>
			setImmediate( () => {
				if ( child.exitCode === null ) exitChild( child );
			} )
		);
		return child;
	} ) as unknown as OwnedProcessSeams[ 'spawn' ];
	return { spawn: spawnSeam, calls, helpers };
}

export const WINDOWS_START = '134389060548247995';
// The start the first keeper a fake spawn starts (PID 9000) reports for itself.
export const KEEPER_START = '134389060541000000';

// A keeper that answers like the real one, with `overrides` for some lines.
export function keeperAnswering(
	overrides: Record< string, readonly string[] | null | ( () => string[] | null ) > = {}
): KeeperScript {
	return ( line ) => {
		const key = line ?? 'start';
		if ( key in overrides ) {
			const answer = overrides[ key ];
			return typeof answer === 'function' ? answer() : answer && [ ...answer ];
		}
		if ( line === undefined ) return [ 'prepared' ];
		if ( line.startsWith( 'own ' ) ) return [ `assigned ${ WINDOWS_START }` ];
		if ( line === 'confirm' ) return [ `ready ${ WINDOWS_START } in-job` ];
		if ( line.startsWith( 'reap ' ) ) return [ 'reaped clean' ];
		if ( line === 'end-tree' ) return [ 'ended 1' ];
		if ( line === 'active' ) return [ 'active 0' ];
		if ( line === 'self' ) return [ `self ${ KEEPER_START }` ];
		return [];
	};
}

export const windowsSeams = {
	platform: 'win32',
	env: { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', PATH: 'C:\\elsewhere' },
	nodePath: 'C:\\node\\node.exe',
	kill: () => {
		throw new Error( 'Windows ownership must never signal a bare PID' );
	},
	run: async () => {
		throw new Error( 'The keeper reads identities itself' );
	},
	delay: () => new Promise< void >( ( resolve ) => setImmediate( resolve ) ),
} satisfies Partial< OwnedProcessSeams >;

export const BOOT = '6f1c1b6e-9a51-4c5d-8d1e-3b1a7c2f9e10';

export function enoent( file: string ) {
	return Object.assign( new Error( `ENOENT: ${ file }` ), { code: 'ENOENT' } );
}

export function errno( code: string ) {
	return Object.assign( new Error( code ), { code } );
}

// Linux seams that read `files` live, so a test can change what /proc shows
// after the fact, and record every signal through `kill`.
export function linuxSeams(
	files: Record< string, string | Error >,
	kill: OwnedProcessSeams[ 'kill' ]
) {
	return {
		platform: 'linux',
		readFile: async ( file: string ) => {
			const value = file === '/proc/sys/kernel/random/boot_id' ? `${ BOOT }\n` : files[ file ];
			if ( value === undefined ) throw enoent( file );
			if ( value instanceof Error ) throw value;
			return value;
		},
		kill,
		nodePath: '/usr/bin/node',
		delay: () => new Promise< void >( ( resolve ) => setImmediate( resolve ) ),
	} satisfies Partial< OwnedProcessSeams >;
}

export const LEADER_STAT = `500 (claude) S 1 500 500 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 777 1000 10`;
