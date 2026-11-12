/**
 * @vitest-environment node
 */
import { execFile, fork, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	checkProcessIdentity,
	prepareProcessOwner,
	readProcessIdentity,
	type OwnedProcessOptions,
	type OwnedProcessSeams,
	type ProcessIdentity,
} from '@studio/common/lib/owned-process';
import { posixProbeScript } from '@studio/common/lib/owned-process-posix';
import type { ChildProcess } from 'node:child_process';

const exec = promisify( execFile );
const fixture = path.join( import.meta.dirname, 'fixtures', 'owned-process-fixture.mjs' );
const powershell = path.win32.join(
	process.env.SystemRoot ?? 'C:\\Windows',
	'System32',
	'WindowsPowerShell',
	'v1.0',
	'powershell.exe'
);
const LIFETIME = 45_000;
// The unrelated process outlives the whole suite, and still ends on its own.
const SENTINEL_LIFETIME = 300_000;
const POSIX_ONLY =
	'(POSIX only: process groups, SIGTERM and /proc or ps start times do not exist on Windows)';
const WINDOWS_ONLY =
	'(Windows only: the job keeper is the Windows mechanism; POSIX has no keeper to lose)';

// Prepares ownership and spawns at once, which the fakes below answer in order.
function spawnOwnedProcess(
	command: string,
	args: readonly string[],
	options: OwnedProcessOptions,
	seams: Partial< OwnedProcessSeams > = {}
) {
	return prepareProcessOwner( seams ).spawn( command, args, options );
}

function enoent( file: string ) {
	return Object.assign( new Error( `ENOENT: ${ file }` ), { code: 'ENOENT' } );
}

function errno( code: string ) {
	return Object.assign( new Error( code ), { code } );
}

const STAT_AFTER_COMM = 'S 1 41 41 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 987654 1000 10';
const BOOT = '6f1c1b6e-9a51-4c5d-8d1e-3b1a7c2f9e10';

function linuxFiles( files: Record< string, string | Error > ): Partial< OwnedProcessSeams > {
	return {
		platform: 'linux',
		readFile: async ( file ) => {
			const value = files[ file ];
			if ( value === undefined ) throw enoent( file );
			if ( value instanceof Error ) throw value;
			return value;
		},
	};
}

describe( 'process identity (injected seams)', () => {
	it( 'reads a Linux start time after the last parenthesis and qualifies it with the boot id', async () => {
		const seams = linuxFiles( {
			'/proc/41/stat': `41 (odd) S 1 2 3) name) ${ STAT_AFTER_COMM }`,
			'/proc/sys/kernel/random/boot_id': `${ BOOT }\n`,
		} );
		const identity = await readProcessIdentity( 41, seams );
		expect( identity ).toEqual( { pid: 41, start: `linux:${ BOOT }:987654` } );
		expect( await checkProcessIdentity( identity!, seams ) ).toBe( 'alive' );
		expect(
			await checkProcessIdentity( { pid: 41, start: `linux:${ BOOT }:987653` }, seams )
		).toBe( 'gone' );
		expect(
			await checkProcessIdentity( { pid: 41, start: `linux:another-boot:987654` }, seams )
		).toBe( 'gone' );
	} );

	it( 'treats a missing or zombie Linux process as gone and an unreadable one as unknown', async () => {
		const start = `linux:${ BOOT }:987654`;
		const boot = { '/proc/sys/kernel/random/boot_id': `${ BOOT }\n` };
		expect( await checkProcessIdentity( { pid: 41, start }, linuxFiles( boot ) ) ).toBe( 'gone' );
		expect(
			await checkProcessIdentity(
				{ pid: 41, start },
				linuxFiles( {
					...boot,
					'/proc/41/stat': `41 (a) Z 1 41 41 0 -1 0 0 0 0 0 0 0 0 0 0 0 1 0 987654`,
				} )
			)
		).toBe( 'gone' );
		expect(
			await checkProcessIdentity(
				{ pid: 41, start },
				linuxFiles( { ...boot, '/proc/41/stat': errno( 'EACCES' ) } )
			)
		).toBe( 'unknown' );
		expect(
			await checkProcessIdentity(
				{ pid: 41, start },
				linuxFiles( { '/proc/41/stat': `41 (a) ${ STAT_AFTER_COMM }` } )
			)
		).toBe( 'unknown' );
		expect(
			await checkProcessIdentity(
				{ pid: 41, start },
				linuxFiles( { ...boot, '/proc/41/stat': '41 (a) S 1 41' } )
			)
		).toBe( 'unknown' );
	} );

	it( 'reads a macOS start time from ps in UTC with the C locale', async () => {
		const calls: Array< { file: string; args: readonly string[]; env: NodeJS.ProcessEnv } > = [];
		let answer: { code: number | null; stdout: string } | Error = {
			code: 0,
			stdout: 'Ss   Wed Nov  1 10:30:54 2026\n',
		};
		const seams: Partial< OwnedProcessSeams > = {
			platform: 'darwin',
			run: async ( file, args, options ) => {
				calls.push( { file, args, env: options.env } );
				if ( answer instanceof Error ) throw answer;
				return answer;
			},
		};
		const identity = await readProcessIdentity( 41, seams );
		expect( identity ).toEqual( { pid: 41, start: 'ps:Wed Nov 1 10:30:54 2026' } );
		expect( calls[ 0 ] ).toMatchObject( {
			file: '/bin/ps',
			args: [ '-o', 'stat=', '-o', 'lstart=', '-p', '41' ],
			env: { TZ: 'UTC', LC_ALL: 'C' },
		} );
		answer = { code: 1, stdout: '' };
		expect( await checkProcessIdentity( identity!, seams ) ).toBe( 'gone' );
		answer = { code: 0, stdout: 'Z    Wed Nov  1 10:30:54 2026\n' };
		expect( await checkProcessIdentity( identity!, seams ) ).toBe( 'gone' );
		answer = { code: 0, stdout: 'S    Wed Nov  1 10:30:55 2026\n' };
		expect( await checkProcessIdentity( identity!, seams ) ).toBe( 'gone' );
		answer = { code: 0, stdout: 'S    not a date\n' };
		expect( await checkProcessIdentity( identity!, seams ) ).toBe( 'unknown' );
		answer = new Error( 'ps unavailable' );
		expect( await checkProcessIdentity( identity!, seams ) ).toBe( 'unknown' );
	} );

	it( 'reads a Windows creation time through trusted PowerShell and never guesses', async () => {
		const calls: Array< { file: string; args: readonly string[] } > = [];
		let answer: { code: number | null; stdout: string } | Error = {
			code: 0,
			stdout: 'start 134389060548247995\r\n',
		};
		const seams: Partial< OwnedProcessSeams > = {
			platform: 'win32',
			env: { SystemRoot: 'C:\\Windows' },
			run: async ( file, args ) => {
				calls.push( { file, args } );
				if ( answer instanceof Error ) throw answer;
				return answer;
			},
		};
		const identity = await readProcessIdentity( 4242, seams );
		expect( identity ).toEqual( { pid: 4242, start: '134389060548247995' } );
		expect( calls[ 0 ].file ).toBe(
			'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
		);
		expect( calls[ 0 ].args.slice( 0, 3 ) ).toEqual( [
			'-NoProfile',
			'-NonInteractive',
			'-EncodedCommand',
		] );
		answer = { code: 0, stdout: 'gone\r\n' };
		expect( await checkProcessIdentity( identity!, seams ) ).toBe( 'gone' );
		answer = { code: 0, stdout: 'start 134389060548247996\r\n' };
		expect( await checkProcessIdentity( identity!, seams ) ).toBe( 'gone' );
		for ( const unclear of [
			{ code: 0, stdout: 'unknown\r\n' },
			{ code: 0, stdout: 'start 12x\r\n' },
			{ code: 1, stdout: '' },
			new Error( 'PowerShell unavailable' ),
		] ) {
			answer = unclear;
			expect( await checkProcessIdentity( identity!, seams ) ).toBe( 'unknown' );
		}
	} );

	it( 'reports a malformed identity as unknown, not as gone', async () => {
		for ( const identity of [
			{ pid: 0, start: '1' },
			{ pid: -4, start: '1' },
			{ pid: 1.5, start: '1' },
			{ pid: 41, start: '' },
		] )
			expect( await checkProcessIdentity( identity, linuxFiles( {} ) ) ).toBe( 'unknown' );
		expect( await readProcessIdentity( 0, linuxFiles( {} ) ) ).toBeUndefined();
	} );
} );

interface FakeChild extends EventEmitter {
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

function fakeChild( pid: number | undefined ): FakeChild {
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

function exitChild( child: FakeChild, code = 0 ) {
	child.exitCode = code;
	child.emit( 'exit', code, null );
}

// A spawn seam: the Windows keeper (PowerShell) and the POSIX supervisor
// (`-e`, whose first line names its keeper) are helpers; anything else is the
// owned process. `keeper` gives the lines a keeper writes when it starts
// (undefined) and in answer to each line it reads; null makes it exit.
type KeeperScript = ( line: string | undefined ) => string[] | null;
function fakeSpawn( owned: FakeChild, keeper: KeeperScript = () => [] ) {
	const calls: Array< {
		command: string;
		args: readonly string[];
		options: Record< string, unknown >;
	} > = [];
	const helpers: Array< { child: FakeChild; lines: string[] } > = [];
	const spawnSeam = ( (
		command: string,
		args: readonly string[],
		options: Record< string, unknown >
	) => {
		calls.push( { command, args, options } );
		if ( args[ 0 ] !== '-e' && ! /powershell\.exe$/i.test( command ) ) return owned;
		const child = fakeChild( 9000 + helpers.length );
		const record = { child, lines: [] as string[] };
		helpers.push( record );
		const reply = ( line: string | undefined ) => {
			const out = keeper( line );
			setImmediate( () => {
				if ( out === null ) return exitChild( child, 1 );
				for ( const item of out ) child.stdout.write( item + '\n' );
			} );
		};
		let configured = args[ 0 ] !== '-e';
		if ( configured ) reply( undefined );
		let buffer = '';
		child.stdin.setEncoding( 'utf8' );
		child.stdin.on( 'data', ( chunk: string ) => {
			buffer += chunk;
			for ( let end = buffer.indexOf( '\n' ); end >= 0; end = buffer.indexOf( '\n' ) ) {
				const line = buffer.slice( 0, end );
				buffer = buffer.slice( end + 1 );
				record.lines.push( line );
				if ( configured ) reply( line );
				else {
					configured = true;
					reply( undefined );
				}
			}
		} );
		child.stdin.on( 'finish', () => setImmediate( () => exitChild( child ) ) );
		return child;
	} ) as unknown as OwnedProcessSeams[ 'spawn' ];
	return { spawn: spawnSeam, calls, helpers };
}

describe( 'POSIX group ownership (injected seams)', () => {
	const leaderStat = `500 (claude) S 1 500 500 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 777 1000 10`;
	// Reads `files` live, so a test can change what /proc shows after the fact.
	function posix( files: Record< string, string | Error >, kill: OwnedProcessSeams[ 'kill' ] ) {
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

	it( 'starts the process in its own group, asks the whole group to stop, then kills only that group', async () => {
		const child = fakeChild( 500 );
		const { spawn: spawnSeam, calls } = fakeSpawn( child );
		const signals: Array< [ number, NodeJS.Signals | 0 ] > = [];
		let groupAlive = true;
		const owned = spawnOwnedProcess(
			'/opt/claude',
			[ '--print' ],
			{ cwd: '/site', env: { PATH: '/bin' } },
			{
				...posix( { '/proc/500/stat': leaderStat }, ( pid, signal ) => {
					signals.push( [ pid, signal ] );
					if ( signal === 'SIGKILL' ) groupAlive = false;
					if ( signal === 0 && ! groupAlive ) throw errno( 'ESRCH' );
				} ),
				spawn: spawnSeam,
			}
		);
		expect( calls[ 0 ] ).toMatchObject( {
			command: '/opt/claude',
			args: [ '--print' ],
			options: { cwd: '/site', detached: true, stdio: 'pipe' },
		} );
		expect( await owned.ready() ).toBe( true );
		expect( owned.identity() ).toEqual( { pid: 500, start: `linux:${ BOOT }:777` } );
		let stdinEnded = false;
		child.stdin.on( 'finish', () => {
			stdinEnded = true;
		} );
		expect( await owned.shutdown( { graceMs: 0, timeoutMs: 1000 } ) ).toBe( true );
		expect( stdinEnded ).toBe( true );
		expect( signals.filter( ( [ , signal ] ) => signal !== 0 ) ).toEqual( [
			[ -500, 'SIGTERM' ],
			[ -500, 'SIGKILL' ],
		] );
		expect( signals.every( ( [ pid ] ) => pid === -500 ) ).toBe( true );
	} );

	it( 'leaves a group alone once its leader was reaped and another process holds the ID', async () => {
		const child = fakeChild( 500 );
		const { spawn: spawnSeam } = fakeSpawn( child );
		const files: Record< string, string > = { '/proc/500/stat': leaderStat };
		const signals: Array< [ number, NodeJS.Signals | 0 ] > = [];
		const owned = spawnOwnedProcess(
			'/opt/claude',
			[],
			{ env: {} },
			{
				...posix( files, ( pid, signal ) => void signals.push( [ pid, signal ] ) ),
				spawn: spawnSeam,
			}
		);
		expect( await owned.ready() ).toBe( true );
		exitChild( child );
		files[ '/proc/500/stat' ] = leaderStat.replace( ' 777 ', ' 901 ' );
		expect( await owned.terminate( 1000 ) ).toBe( true );
		expect( signals ).toEqual( [] );
	} );

	it( 'kills an orphaned group whose leader is gone, and stops when the group is empty', async () => {
		const child = fakeChild( 500 );
		const { spawn: spawnSeam } = fakeSpawn( child );
		const files: Record< string, string > = { '/proc/500/stat': leaderStat };
		const signals: Array< [ number, NodeJS.Signals | 0 ] > = [];
		let members = 1;
		const owned = spawnOwnedProcess(
			'/opt/claude',
			[],
			{ env: {} },
			{
				...posix( files, ( pid, signal ) => {
					signals.push( [ pid, signal ] );
					if ( signal === 'SIGKILL' ) members = 0;
					if ( signal === 0 && ! members ) throw errno( 'ESRCH' );
				} ),
				spawn: spawnSeam,
			}
		);
		expect( await owned.ready() ).toBe( true );
		exitChild( child );
		delete files[ '/proc/500/stat' ];
		expect( await owned.terminate( 1000 ) ).toBe( true );
		expect( signals.filter( ( [ , signal ] ) => signal !== 0 ) ).toEqual( [ [ -500, 'SIGKILL' ] ] );
	} );

	it( 'does not signal a reaped group it cannot verify, and reports the tree as not stopped', async () => {
		const child = fakeChild( 500 );
		const { spawn: spawnSeam } = fakeSpawn( child );
		const files: Record< string, string | Error > = { '/proc/500/stat': leaderStat };
		const signals: Array< [ number, NodeJS.Signals | 0 ] > = [];
		const owned = spawnOwnedProcess(
			'/opt/claude',
			[],
			{ env: {} },
			{
				...posix( files, ( pid, signal ) => void signals.push( [ pid, signal ] ) ),
				spawn: spawnSeam,
			}
		);
		expect( await owned.ready() ).toBe( true );
		exitChild( child );
		files[ '/proc/500/stat' ] = errno( 'EACCES' );
		expect( await owned.terminate( 1000 ) ).toBe( false );
		expect( signals ).toEqual( [] );
	} );

	it( 'reports an identity it could not read as not ready and the tree as not stopped', async () => {
		const child = fakeChild( 500 );
		const { spawn: spawnSeam } = fakeSpawn( child );
		const signals: Array< [ number, NodeJS.Signals | 0 ] > = [];
		const owned = spawnOwnedProcess(
			'/opt/claude',
			[],
			{ env: {} },
			{
				...posix( { '/proc/500/stat': errno( 'EACCES' ) }, ( pid, signal ) => {
					signals.push( [ pid, signal ] );
					if ( signal === 'SIGKILL' ) setImmediate( () => exitChild( child ) );
				} ),
				spawn: spawnSeam,
			}
		);
		expect( await owned.ready() ).toBe( false );
		expect( owned.identity() ).toBeUndefined();
		expect( await owned.shutdown( { graceMs: 0, timeoutMs: 200 } ) ).toBe( false );
		// Only while the leader was unreaped, so its group ID could not name anything else.
		expect( signals.filter( ( [ , signal ] ) => signal !== 0 ) ).toEqual( [
			[ -500, 'SIGTERM' ],
			[ -500, 'SIGKILL' ],
		] );
	} );

	it( 'starts a detached supervisor with the group and the leader identity, and releases it after a clean stop', async () => {
		const child = fakeChild( 500 );
		const {
			spawn: spawnSeam,
			calls,
			helpers,
		} = fakeSpawn( child, ( line ) => ( line === undefined ? [ 'ready' ] : [] ) );
		let alive = true;
		const owned = spawnOwnedProcess(
			'/opt/claude',
			[],
			{ env: {}, supervise: true },
			{
				...posix( { '/proc/500/stat': leaderStat }, ( _pid, signal ) => {
					if ( signal === 'SIGKILL' ) alive = false;
					if ( signal === 0 && ! alive ) throw errno( 'ESRCH' );
				} ),
				spawn: spawnSeam,
			}
		);
		expect( await owned.ready() ).toBe( true );
		expect( calls[ 1 ] ).toMatchObject( {
			command: '/usr/bin/node',
			args: [ '-e', expect.any( String ), 'studio-owned-process-supervisor' ],
			options: { detached: true },
		} );
		expect( JSON.parse( helpers[ 0 ].lines[ 0 ] ) ).toMatchObject( {
			command: '/bin/sh',
			args: [ '-c', expect.any( String ), 'sh', '500', `linux:${ BOOT }:777` ],
		} );
		expect( await owned.shutdown( { graceMs: 0, timeoutMs: 1000 } ) ).toBe( true );
		expect( helpers[ 0 ].lines.slice( 1 ) ).toEqual( [ 'release' ] );
	} );

	it( 'is not ready when its supervisor cannot start its keeper', async () => {
		const child = fakeChild( 500 );
		const { spawn: spawnSeam } = fakeSpawn( child, () => [ 'failed' ] );
		const owned = spawnOwnedProcess(
			'/opt/claude',
			[],
			{ env: {}, supervise: true },
			{ ...posix( { '/proc/500/stat': leaderStat }, () => {} ), spawn: spawnSeam }
		);
		expect( await owned.ready() ).toBe( false );
	} );
} );

describe( 'Windows job ownership (injected seams)', () => {
	const START = '134389060548247995';
	const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
	const seams = {
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
	const decode = ( args: readonly string[] ) =>
		Buffer.from( args[ 3 ], 'base64' ).toString( 'utf16le' );
	// A keeper that answers like the real one, with `overrides` for some lines.
	const keeperAnswering =
		(
			overrides: Record< string, readonly string[] | null | ( () => string[] | null ) > = {}
		): KeeperScript =>
		( line ) => {
			const key = line ?? 'start';
			if ( key in overrides ) {
				const answer = overrides[ key ];
				return typeof answer === 'function' ? answer() : answer && [ ...answer ];
			}
			if ( line === undefined ) return [ 'prepared' ];
			if ( line.startsWith( 'own ' ) ) return [ `assigned ${ START }` ];
			if ( line === 'confirm' ) return [ `ready ${ START } in-job` ];
			if ( line.startsWith( 'reap ' ) ) return [ 'reaped clean' ];
			if ( line === 'children' ) return [ 'children 0' ];
			if ( line === 'active' ) return [ 'active 0' ];
			return [];
		};

	it( 'prepares the job before the process exists, assigns it at once and ends the tree through the job', async () => {
		const child = fakeChild( 4242 );
		const { spawn: spawnSeam, calls, helpers } = fakeSpawn( child, keeperAnswering() );
		const owner = prepareProcessOwner( { ...seams, spawn: spawnSeam } );
		expect( calls ).toHaveLength( 1 );
		expect( calls[ 0 ].command ).toBe( POWERSHELL );
		expect( calls[ 0 ].options ).toMatchObject( {
			windowsHide: true,
			env: { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp' },
		} );
		expect( calls[ 0 ].options.env ).not.toHaveProperty( 'PATH' );
		expect( calls[ 0 ].options.detached ).toBeFalsy();
		const script = decode( calls[ 0 ].args );
		expect( script ).toContain( 'Add-Type -TypeDefinition $source' );
		// Kill on close is the job's only limit: no breakaway flag is ever set.
		expect( script ).toContain( 'info.Basic.LimitFlags = KillOnJobClose;' );
		expect( script.match( /LimitFlags =/g ) ).toHaveLength( 1 );
		expect( await owner.prepared() ).toBe( true );
		const owned = owner.spawn( 'C:\\claude.exe', [ '--print' ], { env: {} } );
		expect( calls[ 1 ] ).toMatchObject( {
			command: 'C:\\claude.exe',
			options: { detached: false, windowsHide: true, stdio: 'pipe' },
		} );
		expect( await owned.ready() ).toBe( true );
		expect( owned.identity() ).toEqual( { pid: 4242, start: START } );
		expect( helpers[ 0 ].lines ).toEqual( [ 'own 4242', 'confirm' ] );
		expect( await owned.shutdown( { graceMs: 0, timeoutMs: 1000 } ) ).toBe( true );
		expect( helpers[ 0 ].lines.slice( 2 ) ).toEqual( [ 'reap 1000', 'release' ] );
		expect( child.killed ).toEqual( [] );
	} );

	it( 'gives the keeper the same script for every run, with no input in it', async () => {
		const scripts = [ 1, 2 ].map( () => {
			const { spawn: spawnSeam, calls } = fakeSpawn( fakeChild( 1 ), keeperAnswering() );
			prepareProcessOwner( { ...seams, spawn: spawnSeam } );
			return decode( calls[ 0 ].args );
		} );
		expect( scripts[ 0 ] ).toBe( scripts[ 1 ] );
	} );

	it.each( [
		[
			'a keeper that cannot compile its job code',
			{ start: [ 'failed keeper 0' ] },
			'keeper-unavailable',
		],
		[ 'a keeper that cannot create the job', { start: [ 'failed job 1450' ] }, 'job-unavailable' ],
		[ 'a keeper that exits at once', { start: null }, 'keeper-unavailable' ],
	] as const )( 'is not prepared, and says why, for %s', async ( _name, overrides, failure ) => {
		const { spawn: spawnSeam } = fakeSpawn( fakeChild( 4242 ), keeperAnswering( overrides ) );
		const owner = prepareProcessOwner( { ...seams, spawn: spawnSeam } );
		expect( await owner.prepared() ).toBe( false );
		expect( owner.failure() ).toBe( failure );
	} );

	it.each( [
		[ 'denied', 'failed assign 5 ' + START, 'job-assignment-denied' ],
		[ 'refused otherwise', 'failed assign 1 ' + START, 'job-assignment-failed' ],
	] as const )(
		'fails closed when the assignment is %s, ends the child through its own handle and checks it left no child',
		async ( _name, answer, failure ) => {
			const child = fakeChild( 4242 );
			child.kill = ( signal: NodeJS.Signals = 'SIGTERM' ) => {
				child.killed.push( signal );
				setImmediate( () => exitChild( child, 1 ) );
				return true;
			};
			const { spawn: spawnSeam, helpers } = fakeSpawn(
				child,
				keeperAnswering( { 'own 4242': [ answer ] } )
			);
			const owned = prepareProcessOwner( { ...seams, spawn: spawnSeam } ).spawn(
				'C:\\claude.exe',
				[],
				{
					env: {},
				}
			);
			expect( await owned.ready() ).toBe( false );
			expect( owned.failure() ).toBe( failure );
			expect( owned.identity() ).toBeUndefined();
			expect( await owned.shutdown( { graceMs: 0, timeoutMs: 1000 } ) ).toBe( true );
			expect( child.killed ).toEqual( [ 'SIGKILL' ] );
			expect( helpers[ 0 ].lines ).toEqual( [ 'own 4242', 'children', 'release' ] );
		}
	);

	it.each( [
		[ 'cannot be limited', 'failed limit 87', 'job-unverified' ],
		[ 'does not show the process', 'failed verify 0', 'job-unverified' ],
		[ 'finds a child already outside it', 'failed outside 1', 'job-incomplete' ],
	] as const )( 'fails closed when the job %s', async ( _name, answer, failure ) => {
		const child = fakeChild( 4242 );
		const { spawn: spawnSeam } = fakeSpawn( child, keeperAnswering( { confirm: [ answer ] } ) );
		const owned = prepareProcessOwner( { ...seams, spawn: spawnSeam } ).spawn(
			'C:\\claude.exe',
			[],
			{
				env: {},
			}
		);
		expect( await owned.ready() ).toBe( false );
		expect( owned.failure() ).toBe( failure );
	} );

	it( 'trusts an assignment only if the child was still unreaped when it was reported, and then kills nothing', async () => {
		const child = fakeChild( 4242 );
		const { spawn: spawnSeam, helpers } = fakeSpawn(
			child,
			keeperAnswering( {
				'own 4242': () => {
					exitChild( child );
					return [ `assigned ${ START }` ];
				},
			} )
		);
		const owned = prepareProcessOwner( { ...seams, spawn: spawnSeam } ).spawn(
			'C:\\claude.exe',
			[],
			{
				env: {},
			}
		);
		expect( await owned.ready() ).toBe( false );
		expect( owned.failure() ).toBe( 'process-exited' );
		expect( helpers[ 0 ].lines ).toEqual( [ 'own 4242', 'release' ] );
		expect( helpers[ 0 ].lines ).not.toContain( 'confirm' );
	} );

	it( 'counts a tree as ended when its keeper died after confirming, once the child is gone', async () => {
		const child = fakeChild( 4242 );
		const { spawn: spawnSeam } = fakeSpawn( child, keeperAnswering( { 'reap 1000': null } ) );
		const owned = prepareProcessOwner( { ...seams, spawn: spawnSeam } ).spawn(
			'C:\\claude.exe',
			[],
			{
				env: {},
			}
		);
		expect( await owned.ready() ).toBe( true );
		setImmediate( () => exitChild( child, 1 ) );
		expect( await owned.terminate( 1000 ) ).toBe( true );
	} );

	it( 'reports a dirty reap as not stopped', async () => {
		const { spawn: spawnSeam } = fakeSpawn(
			fakeChild( 4242 ),
			keeperAnswering( { 'reap 1000': [ 'reaped dirty' ] } )
		);
		const owned = prepareProcessOwner( { ...seams, spawn: spawnSeam } ).spawn(
			'C:\\claude.exe',
			[],
			{
				env: {},
			}
		);
		expect( await owned.ready() ).toBe( true );
		expect( await owned.terminate( 1000 ) ).toBe( false );
	} );

	it( 'lists the live members of the job', async () => {
		const { spawn: spawnSeam } = fakeSpawn(
			fakeChild( 4242 ),
			keeperAnswering( {
				inspect: [ `live 4242 ${ START }`, 'live 4300 134389060548250000', 'inspected' ],
			} )
		);
		const owned = prepareProcessOwner( { ...seams, spawn: spawnSeam } ).spawn(
			'C:\\claude.exe',
			[],
			{
				env: {},
			}
		);
		expect( await owned.ready() ).toBe( true );
		expect( await owned.inspect() ).toEqual( {
			live: [
				{ pid: 4242, start: START },
				{ pid: 4300, start: '134389060548250000' },
			],
			uncertain: false,
		} );
	} );

	it( 'starts no supervisor on Windows, where the job ends with this process', async () => {
		const { spawn: spawnSeam, calls } = fakeSpawn( fakeChild( 4242 ), keeperAnswering() );
		const owned = prepareProcessOwner( { ...seams, spawn: spawnSeam } ).spawn(
			'C:\\claude.exe',
			[],
			{
				env: {},
				supervise: true,
			}
		);
		expect( await owned.ready() ).toBe( true );
		expect( calls.map( ( call ) => call.command ) ).toEqual( [ POWERSHELL, 'C:\\claude.exe' ] );
	} );

	it( 'ends the keeper of an owner that never spawned', async () => {
		const { spawn: spawnSeam, helpers } = fakeSpawn( fakeChild( 4242 ), keeperAnswering() );
		const owner = prepareProcessOwner( { ...seams, spawn: spawnSeam } );
		expect( await owner.prepared() ).toBe( true );
		await owner.dispose();
		expect( helpers[ 0 ].lines ).toEqual( [ 'release' ] );
	} );
} );

// Real processes from here on: they run natively on whichever OS runs the suite.

// The live descendants of a live process. Windows keeps a parent ID after the
// parent exits and reuses PIDs, so a child must also have started after its
// parent; POSIX re-parents orphans, so its parent IDs are always current.
async function descendantsOf( root: number ): Promise< number[] > {
	let rows: number[][];
	if ( process.platform === 'win32' ) {
		const script = `Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | Where-Object { $_.CreationDate } | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() }`;
		const { stdout } = await exec(
			powershell,
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

function firstLine( stream: NodeJS.ReadableStream ): Promise< string > {
	return new Promise( ( resolve, reject ) => {
		let buffer = '';
		stream.setEncoding( 'utf8' );
		stream.on( 'data', ( chunk: string ) => {
			buffer += chunk;
			const end = buffer.indexOf( '\n' );
			if ( end >= 0 ) resolve( buffer.slice( 0, end ).trim() );
		} );
		stream.once( 'end', () => reject( new Error( 'No ready line' ) ) );
	} );
}

// A fixture tree spawned once its job exists, as the runtime spawns.
async function ownedTree( args: string[], seams: Partial< OwnedProcessSeams > = {} ) {
	const owner = prepareProcessOwner( seams );
	expect( await owner.prepared() ).toBe( true );
	return owner.spawn( process.execPath, [ fixture, ...args ], { env: process.env } );
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

// Whether the process with `pid`, which the test saw start, has exited.
async function exitedOnItsOwn( pid: number, ms: number ): Promise< boolean > {
	const deadline = Date.now() + ms;
	while ( Date.now() < deadline ) {
		if ( ! ( await readProcessIdentity( pid ) ) ) return true;
		await new Promise( ( resolve ) => setTimeout( resolve, 250 ) );
	}
	return false;
}

function startLeaf( marker: string, lifetime = LIFETIME ) {
	const leaf = spawn( process.execPath, [ fixture, 'leaf', marker, String( lifetime ) ], {
		stdio: [ 'ignore', 'pipe', 'ignore' ],
		windowsHide: true,
	} );
	return { leaf, ready: firstLine( leaf.stdout ) };
}

describe( 'owned process trees (real processes)', () => {
	const marker = `studio-p2-fixture-${ randomUUID() }`;
	let sentinel: ReturnType< typeof startLeaf >[ 'leaf' ];
	let sentinelIdentity: ProcessIdentity;
	let root: string;
	let bundle: string;

	beforeAll( async () => {
		const started = startLeaf( marker, SENTINEL_LIFETIME );
		sentinel = started.leaf;
		await started.ready;
		sentinelIdentity = ( await readProcessIdentity( sentinel.pid! ) )!;
		expect( sentinelIdentity ).toBeDefined();
		root = await realpath( await mkdtemp( path.join( os.tmpdir(), 'studio-owned-process-' ) ) );
		bundle = path.join( root, 'owned-process.mjs' );
		await exec( process.execPath, [
			path.resolve( 'node_modules/esbuild/bin/esbuild' ),
			path.resolve( 'packages/common/lib/owned-process.ts' ),
			'--bundle',
			'--platform=node',
			'--format=esm',
			'--outfile=' + bundle,
			'--log-level=silent',
		] );
	}, 60_000 );

	afterAll( async () => {
		if ( sentinel && sentinel.exitCode === null ) sentinel.kill( 'SIGKILL' );
		if ( root ) await rm( root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 } );
	} );

	it( 'identifies a live process, then reports it gone, and a fabricated start as another process', async () => {
		const { leaf, ready } = startLeaf( marker );
		try {
			await ready;
			const identity = ( await readProcessIdentity( leaf.pid! ) )!;
			expect( identity.pid ).toBe( leaf.pid );
			expect( await checkProcessIdentity( identity ) ).toBe( 'alive' );
			expect(
				await checkProcessIdentity( { pid: identity.pid, start: `${ identity.start }0` } )
			).toBe( 'gone' );
			const exited = once( leaf, 'exit' );
			leaf.kill( 'SIGKILL' );
			await exited;
			expect( await goneWithin( [ identity ], 10_000 ) ).toEqual( [] );
		} finally {
			if ( leaf.exitCode === null && leaf.signalCode === null ) leaf.kill( 'SIGKILL' );
		}
	}, 60_000 );

	it( 'terminates the owned child and its shell grandchild within the bound and spares an unrelated process', async () => {
		const owned = await ownedTree( [ 'tree', marker, String( LIFETIME ), 'ignore-eof' ] );
		let tree: ProcessIdentity[] = [];
		try {
			expect( await owned.ready() ).toBe( true );
			const [ , treePid, shellPid, leafPid ] = ( await firstLine( owned.child.stdout ) ).split(
				' '
			);
			tree = await identities( [ Number( treePid ), Number( shellPid ), Number( leafPid ) ] );
			expect( tree ).toHaveLength( 3 );
			const inspected = await owned.inspect();
			expect( inspected.uncertain ).toBe( false );
			for ( const identity of tree ) expect( inspected.live ).toContainEqual( identity );
			const started = Date.now();
			expect( await owned.shutdown( { graceMs: 500 } ) ).toBe( true );
			expect( Date.now() - started ).toBeLessThan( 20_000 );
			expect( await goneWithin( tree, 5_000 ) ).toEqual( [] );
			expect( await checkProcessIdentity( sentinelIdentity ) ).toBe( 'alive' );
		} finally {
			if ( owned.child.exitCode === null && owned.child.signalCode === null )
				owned.child.kill( 'SIGKILL' );
		}
	}, 60_000 );

	it( 'ends the owned tree through its supervisor when the owner dies, and the supervisor exits too', async () => {
		const owner = fork( fixture, [ 'owner', marker, String( LIFETIME ), bundle ], {
			execArgv: [],
			stdio: [ 'ignore', 'ignore', 'ignore', 'ipc' ],
		} );
		const exited = once( owner, 'exit' );
		try {
			const [ report ] = ( await once( owner, 'message' ) ) as [
				{ ready: boolean; tree: number; shell: number; leaf: number; tracked: number[] },
			];
			expect( report.ready ).toBe( true );
			expect( report.tracked ).toEqual(
				expect.arrayContaining( [ report.tree, report.shell, report.leaf ] )
			);
			const descendants = await identities( await descendantsOf( owner.pid! ) );
			for ( const pid of [ report.tree, report.shell, report.leaf ] )
				expect( descendants.map( ( identity ) => identity.pid ) ).toContain( pid );
			owner.kill( 'SIGKILL' );
			await exited;
			expect( await goneWithin( descendants, 20_000 ) ).toEqual( [] );
			expect( await checkProcessIdentity( sentinelIdentity ) ).toBe( 'alive' );
		} finally {
			if ( owner.exitCode === null && owner.signalCode === null ) owner.kill( 'SIGKILL' );
		}
	}, 60_000 );

	it( 'shuts down cleanly from the owner and releases the supervisor', async () => {
		const owner = fork( fixture, [ 'owner', marker, String( LIFETIME ), bundle ], {
			execArgv: [],
			stdio: [ 'ignore', 'ignore', 'ignore', 'ipc' ],
		} );
		const exited = once( owner, 'exit' );
		try {
			const [ report ] = ( await once( owner, 'message' ) ) as [ { ready: boolean } ];
			expect( report.ready ).toBe( true );
			const descendants = await identities( await descendantsOf( owner.pid! ) );
			owner.send( 'shutdown' );
			const [ result ] = ( await once( owner, 'message' ) ) as [ { clean: boolean } ];
			expect( result.clean ).toBe( true );
			await exited;
			expect( await goneWithin( descendants, 10_000 ) ).toEqual( [] );
			expect( await checkProcessIdentity( sentinelIdentity ) ).toBe( 'alive' );
		} finally {
			if ( owner.exitCode === null && owner.signalCode === null ) owner.kill( 'SIGKILL' );
		}
	}, 60_000 );

	it.skipIf( process.platform === 'win32' )(
		`computes the same start identity in the supervisor shell as in Node ${ POSIX_ONLY }`,
		async () => {
			const { leaf, ready } = startLeaf( marker );
			try {
				await ready;
				const { stdout } = await exec( '/bin/sh', [
					'-c',
					`${ posixProbeScript() }\nprobe "$1"`,
					'sh',
					String( leaf.pid ),
				] );
				expect( stdout ).toBe( ( await readProcessIdentity( leaf.pid! ) )!.start );
			} finally {
				leaf.kill( 'SIGKILL' );
			}
		},
		60_000
	);

	it( 'still ends the shell grandchild after the child exits on its own and orphans it', async () => {
		// Without `ignore-eof` the tree exits at EOF. On Windows its own job then
		// kills the shell, leaving the leaf with a parent that no longer exists;
		// on POSIX the leaf also ignores the group's SIGTERM.
		const owned = await ownedTree( [ 'tree', marker, String( LIFETIME ) ] );
		try {
			expect( await owned.ready() ).toBe( true );
			const [ , treePid, shellPid, leafPid ] = ( await firstLine( owned.child.stdout ) ).split(
				' '
			);
			const tree = await identities( [ Number( treePid ), Number( shellPid ), Number( leafPid ) ] );
			expect( tree ).toHaveLength( 3 );
			const inspected = await owned.inspect();
			for ( const identity of tree ) expect( inspected.live ).toContainEqual( identity );
			const exited = once( owned.child, 'exit' );
			owned.child.stdin.end();
			await exited;
			const [ , shell, leaf ] = tree;
			if ( process.platform === 'win32' )
				expect( await goneWithin( [ shell ], 10_000 ) ).toEqual( [] );
			expect( await checkProcessIdentity( leaf ) ).toBe( 'alive' );
			expect( await owned.shutdown( { graceMs: 500 } ) ).toBe( true );
			expect( await goneWithin( tree, 5_000 ) ).toEqual( [] );
			expect( await checkProcessIdentity( sentinelIdentity ) ).toBe( 'alive' );
		} finally {
			if ( owned.child.exitCode === null && owned.child.signalCode === null )
				owned.child.kill( 'SIGKILL' );
		}
	}, 60_000 );

	it( 'ends a grandchild whose parent exited at once (a double fork)', async () => {
		const owned = await ownedTree( [ 'tree', marker, String( LIFETIME ), 'ignore-eof' ] );
		try {
			expect( await owned.ready() ).toBe( true );
			const next = lines( owned.child.stdout );
			const [ , treePid, shellPid, leafPid ] = ( await next() ).split( ' ' );
			const tree = await identities( [ Number( treePid ), Number( shellPid ), Number( leafPid ) ] );
			owned.child.stdin.write( 'fork\n' );
			const [ , middlePid, orphanPid ] = ( await next() ).split( ' ' );
			const orphan = ( await readProcessIdentity( Number( orphanPid ) ) )!;
			expect( orphan ).toBeDefined();
			expect( await exitedOnItsOwn( Number( middlePid ), 10_000 ) ).toBe( true );
			expect( await checkProcessIdentity( orphan ) ).toBe( 'alive' );
			expect( await owned.shutdown( { graceMs: 500 } ) ).toBe( true );
			expect( await goneWithin( [ ...tree, orphan ], 5_000 ) ).toEqual( [] );
			expect( await checkProcessIdentity( sentinelIdentity ) ).toBe( 'alive' );
		} finally {
			if ( owned.child.exitCode === null && owned.child.signalCode === null )
				owned.child.kill( 'SIGKILL' );
		}
	}, 60_000 );

	it( 'ends a child started after the tree was first seen', async () => {
		const owned = await ownedTree( [ 'tree', marker, String( LIFETIME ), 'ignore-eof' ] );
		try {
			expect( await owned.ready() ).toBe( true );
			const next = lines( owned.child.stdout );
			const [ , treePid, shellPid, leafPid ] = ( await next() ).split( ' ' );
			const tree = await identities( [ Number( treePid ), Number( shellPid ), Number( leafPid ) ] );
			owned.child.stdin.write( 'spawn\n' );
			const [ , latePid ] = ( await next() ).split( ' ' );
			// Ended at once, with nothing else looking for it first.
			expect( await owned.terminate() ).toBe( true );
			const late = { pid: Number( latePid ), start: 'unread' };
			expect( await checkProcessIdentity( { ...late, start: 'unread' } ) ).toBe( 'gone' );
			expect( await goneWithin( tree, 5_000 ) ).toEqual( [] );
			expect( await checkProcessIdentity( sentinelIdentity ) ).toBe( 'alive' );
		} finally {
			if ( owned.child.exitCode === null && owned.child.signalCode === null )
				owned.child.kill( 'SIGKILL' );
		}
	}, 60_000 );

	it.skipIf( process.platform !== 'win32' )(
		`ends the whole tree when its keeper dies, and counts that as ended ${ WINDOWS_ONLY }`,
		async () => {
			const helpers: ChildProcess[] = [];
			const owned = await ownedTree( [ 'tree', marker, String( LIFETIME ), 'ignore-eof' ], {
				spawn: ( ( ...args: Parameters< typeof spawn > ) => {
					const started = spawn( ...args );
					helpers.push( started );
					return started;
				} ) as typeof spawn,
			} );
			try {
				expect( await owned.ready() ).toBe( true );
				const [ , treePid, shellPid, leafPid ] = ( await firstLine( owned.child.stdout ) ).split(
					' '
				);
				const tree = await identities( [
					Number( treePid ),
					Number( shellPid ),
					Number( leafPid ),
				] );
				expect( tree ).toHaveLength( 3 );
				const keeper = helpers[ 0 ];
				expect( keeper.spawnargs[ 0 ] ).toMatch( /powershell\.exe$/i );
				// The test's own unreaped child.
				keeper.kill( 'SIGKILL' );
				expect( await goneWithin( tree, 10_000 ) ).toEqual( [] );
				expect( await owned.terminate() ).toBe( true );
				expect( await checkProcessIdentity( sentinelIdentity ) ).toBe( 'alive' );
			} finally {
				if ( owned.child.exitCode === null && owned.child.signalCode === null )
					owned.child.kill( 'SIGKILL' );
			}
		},
		60_000
	);

	it.skipIf( process.platform !== 'win32' )(
		`reports a process Windows will not let the keeper open as not owned, and leaves no keeper ${ WINDOWS_ONLY }`,
		async () => {
			// A stand-in for the child that names the System process, which a user's keeper cannot open.
			const system = Object.assign( new EventEmitter(), {
				pid: 4,
				exitCode: 0,
				signalCode: null,
				stdin: new PassThrough(),
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: () => true,
			} );
			const helpers: ChildProcess[] = [];
			const owned = spawnOwnedProcess(
				'unused',
				[],
				{ env: process.env },
				{
					spawn: ( ( command: string, ...rest: unknown[] ) => {
						if ( command === 'unused' ) return system;
						const started = ( spawn as ( ...args: unknown[] ) => ChildProcess )( command, ...rest );
						helpers.push( started );
						return started;
					} ) as unknown as typeof spawn,
				}
			);
			expect( await owned.ready() ).toBe( false );
			expect( owned.failure() ).toBe( 'process-unavailable' );
			expect( await owned.shutdown( { graceMs: 0 } ) ).toBe( false );
			if ( helpers[ 0 ].exitCode === null ) await once( helpers[ 0 ], 'exit' );
		},
		60_000
	);
} );
