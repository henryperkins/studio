/**
 * @vitest-environment node
 */
import { execFile, fork, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	checkOwnedTreeEnded,
	checkProcessGroup,
	checkProcessIdentity,
	prepareProcessOwner,
	readProcessIdentity,
	type OwnedProcessOptions,
	type OwnedProcessSeams,
	type ProcessIdentity,
} from '@studio/common/lib/owned-process';
import { posixKeeperCommand, posixProbeScript } from '@studio/common/lib/owned-process-posix';
import { windowsKeeperCommand } from '@studio/common/lib/owned-process-windows';
import {
	BOOT,
	enoent,
	errno,
	exitChild,
	fakeChild,
	fakeSpawn,
	KEEPER_START,
	keeperAnswering,
	LEADER_STAT,
	linuxSeams,
	WINDOWS_START,
	windowsSeams,
} from './fixtures/owned-process-seams';
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

const STAT_AFTER_COMM = 'S 1 41 41 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 987654 1000 10';

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

describe( 'POSIX group ownership (injected seams)', () => {
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
				...linuxSeams( { '/proc/500/stat': LEADER_STAT }, ( pid, signal ) => {
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
		const files: Record< string, string > = { '/proc/500/stat': LEADER_STAT };
		const signals: Array< [ number, NodeJS.Signals | 0 ] > = [];
		const owned = spawnOwnedProcess(
			'/opt/claude',
			[],
			{ env: {} },
			{
				...linuxSeams( files, ( pid, signal ) => void signals.push( [ pid, signal ] ) ),
				spawn: spawnSeam,
			}
		);
		expect( await owned.ready() ).toBe( true );
		exitChild( child );
		files[ '/proc/500/stat' ] = LEADER_STAT.replace( ' 777 ', ' 901 ' );
		expect( await owned.terminate( 1000 ) ).toBe( true );
		expect( signals ).toEqual( [] );
	} );

	it( 'kills an orphaned group whose leader is gone, and stops when the group is empty', async () => {
		const child = fakeChild( 500 );
		const { spawn: spawnSeam } = fakeSpawn( child );
		const files: Record< string, string > = { '/proc/500/stat': LEADER_STAT };
		const signals: Array< [ number, NodeJS.Signals | 0 ] > = [];
		let members = 1;
		const owned = spawnOwnedProcess(
			'/opt/claude',
			[],
			{ env: {} },
			{
				...linuxSeams( files, ( pid, signal ) => {
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
		const files: Record< string, string | Error > = { '/proc/500/stat': LEADER_STAT };
		const signals: Array< [ number, NodeJS.Signals | 0 ] > = [];
		const owned = spawnOwnedProcess(
			'/opt/claude',
			[],
			{ env: {} },
			{
				...linuxSeams( files, ( pid, signal ) => void signals.push( [ pid, signal ] ) ),
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
				...linuxSeams( { '/proc/500/stat': errno( 'EACCES' ) }, ( pid, signal ) => {
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
				...linuxSeams( { '/proc/500/stat': LEADER_STAT }, ( _pid, signal ) => {
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
			{ ...linuxSeams( { '/proc/500/stat': LEADER_STAT }, () => {} ), spawn: spawnSeam }
		);
		expect( await owned.ready() ).toBe( false );
	} );
	it( 'reports a leader that is already a zombie as exited', async () => {
		const child = fakeChild( 500 );
		const { spawn: spawnSeam } = fakeSpawn( child );
		const owned = spawnOwnedProcess(
			'/opt/claude',
			[],
			{ env: {} },
			{
				...linuxSeams( { '/proc/500/stat': LEADER_STAT.replace( ' S ', ' Z ' ) }, () => {} ),
				spawn: spawnSeam,
			}
		);
		expect( await owned.ready() ).toBe( false );
		expect( owned.failure() ).toBe( 'process-exited' );
	} );

	it( 'reports a process that did not start, with nothing to signal', async () => {
		const signals: Array< [ number, NodeJS.Signals | 0 ] > = [];
		const { spawn: spawnSeam } = fakeSpawn( fakeChild( undefined ) );
		const owned = spawnOwnedProcess(
			'/opt/missing',
			[],
			{ env: {} },
			{
				...linuxSeams( {}, ( pid, signal ) => void signals.push( [ pid, signal ] ) ),
				spawn: spawnSeam,
			}
		);
		expect( await owned.ready() ).toBe( false );
		expect( owned.failure() ).toBe( 'spawn-failed' );
		expect( await owned.shutdown( { graceMs: 0 } ) ).toBe( true );
		expect( signals ).toEqual( [] );
	} );

	it.each( [
		[ 'is empty', true ],
		[ 'still has members', false ],
	] )(
		'after a leader was reaped before its identity was read, counts its group as ended only when the group %s, and never signals it',
		async ( _name, empty ) => {
			const child = fakeChild( 500 );
			const { spawn: spawnSeam } = fakeSpawn( child );
			const signals: Array< [ number, NodeJS.Signals | 0 ] > = [];
			const owned = spawnOwnedProcess(
				'/opt/claude',
				[],
				{ env: {}, supervise: true },
				{
					...linuxSeams( {}, ( pid, signal ) => {
						signals.push( [ pid, signal ] );
						if ( signal === 0 && empty ) throw errno( 'ESRCH' );
					} ),
					readFile: async ( file: string ) => {
						// The leader exits, and is reaped, while its identity is read.
						if ( child.exitCode === null ) exitChild( child );
						throw enoent( file );
					},
					spawn: spawnSeam,
				}
			);
			expect( await owned.ready() ).toBe( false );
			expect( owned.failure() ).toBe( 'process-exited' );
			expect( await owned.shutdown( { graceMs: 0, timeoutMs: 200 } ) ).toBe( empty );
			expect( signals.filter( ( [ , signal ] ) => signal !== 0 ) ).toEqual( [] );
			expect( signals.every( ( [ pid ] ) => pid === -500 ) ).toBe( true );
		}
	);
} );

// A POSIX shell for the shell probe and keeper: /bin/sh, or on Windows the sh
// that Git for Windows installs, which reads the same fake /proc and stub ps.
function posixShell(): string | undefined {
	if ( process.platform !== 'win32' ) return '/bin/sh';
	const candidate = path.win32.join(
		process.env.ProgramFiles ?? 'C:\\Program Files',
		'Git',
		'bin',
		'sh.exe'
	);
	return existsSync( candidate ) ? candidate : undefined;
}
const SHELL = posixShell();
// The path a shell given by `posixShell` sees for a local path.
const shellPath = ( local: string ) =>
	process.platform === 'win32'
		? '/' + local[ 0 ].toLowerCase() + local.slice( 2 ).split( path.sep ).join( '/' )
		: local;

describe.skipIf( ! SHELL )(
	'POSIX shell probe and keeper (injected /proc and ps, run by a POSIX shell; skipped without one)',
	() => {
		let root: string;
		beforeAll( async () => {
			root = await realpath( await mkdtemp( path.join( os.tmpdir(), 'studio-shell-probe-' ) ) );
			await mkdir( path.join( root, 'stub' ) );
			await writeFile(
				path.join( root, 'stub', 'ps' ),
				'#!/bin/sh\n[ -n "$PS_OUT" ] && printf \'%s\\n\' "$PS_OUT"\nexit "$PS_CODE"\n',
				{ mode: 0o755 }
			);
		} );
		afterAll( async () => {
			if ( root )
				await rm( root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 } );
		} );

		// A fake proc filesystem: `self` selects the Linux probe; `stat` of
		// null leaves the process out; an Error makes its stat unreadable.
		async function procRoot(
			name: string,
			files: { self: boolean; stat?: string | null | Error; boot?: boolean }
		) {
			const proc = path.join( root, name );
			await mkdir( proc );
			if ( files.self ) {
				await mkdir( path.join( proc, 'self' ) );
				await writeFile( path.join( proc, 'self', 'stat' ), `1 (sh) ${ STAT_AFTER_COMM }` );
			}
			if ( files.boot !== false ) {
				await mkdir( path.join( proc, 'sys', 'kernel', 'random' ), { recursive: true } );
				await writeFile( path.join( proc, 'sys', 'kernel', 'random', 'boot_id' ), `${ BOOT }\n` );
			}
			if ( files.stat instanceof Error )
				await mkdir( path.join( proc, '41', 'stat' ), { recursive: true } );
			else if ( typeof files.stat === 'string' ) {
				await mkdir( path.join( proc, '41' ) );
				await writeFile( path.join( proc, '41', 'stat' ), files.stat );
			}
			return proc;
		}

		async function shellProbe( proc: string, ps: { out?: string; code?: number } = {} ) {
			const { stdout } = await exec(
				SHELL!,
				[
					'-c',
					`PATH="$2:$PATH"\nproc=$1\n${ posixProbeScript() }\nprobe 41\nprintf ' rc=%s' $?`,
					'sh',
					shellPath( proc ),
					shellPath( path.join( root, 'stub' ) ),
				],
				{ env: { ...process.env, PS_OUT: ps.out ?? '', PS_CODE: String( ps.code ?? 0 ) } }
			);
			const found = / rc=(\d)$/.exec( stdout );
			return { token: stdout.slice( 0, found!.index ), rc: Number( found![ 1 ] ) };
		}

		const RC = { running: 0, gone: 1, unknown: 2 } as const;

		// What Node's probe reads for PID 41 through `seams`.
		async function nodeProbe( seams: Partial< OwnedProcessSeams > ) {
			const identity = await readProcessIdentity( 41, seams );
			if ( identity ) return { state: 'running' as const, start: identity.start };
			const check = await checkProcessIdentity( { pid: 41, start: 'none' }, seams );
			return { state: check === 'unknown' ? ( 'unknown' as const ) : ( 'gone' as const ) };
		}

		it.each( [
			[ 'a running process', { stat: `41 (a b) ${ STAT_AFTER_COMM }` }, 'running' ],
			[ 'no process', { stat: null }, 'gone' ],
			[ 'a zombie', { stat: `41 (a) ${ STAT_AFTER_COMM.replace( /^S/, 'Z' ) }` }, 'gone' ],
			[ 'a dead process', { stat: `41 (a) ${ STAT_AFTER_COMM.replace( /^S/, 'X' ) }` }, 'gone' ],
			[ 'an unreadable stat', { stat: errno( 'EISDIR' ) }, 'unknown' ],
			[ 'a missing boot id', { stat: `41 (a) ${ STAT_AFTER_COMM }`, boot: false }, 'unknown' ],
			[ 'a short stat', { stat: '41 (a) S 1 41' }, 'unknown' ],
			[
				'a start time that is not a number',
				{ stat: `41 (a) ${ STAT_AFTER_COMM.replace( '987654', '98x654' ) }` },
				'unknown',
			],
		] as const )( 'classifies %s on Linux as Node does', async ( name, files, state ) => {
			const proc = await procRoot( `linux ${ name }`, { self: true, ...files } );
			const node = await nodeProbe(
				linuxFiles( {
					...( files.stat === null ? {} : { '/proc/41/stat': files.stat } ),
					...( 'boot' in files ? {} : { '/proc/sys/kernel/random/boot_id': `${ BOOT }\n` } ),
				} )
			);
			expect( node.state ).toBe( state );
			const shell = await shellProbe( proc );
			expect( shell.rc ).toBe( RC[ state ] );
			if ( node.state === 'running' ) expect( shell.token ).toBe( node.start );
		} );

		it.each( [
			[ 'a running process', { out: 'Ss   Wed Nov  1 10:30:54 2026', code: 0 }, 'running' ],
			[ 'no process', { out: '', code: 1 }, 'gone' ],
			[ 'a zombie', { out: 'Z    Wed Nov  1 10:30:54 2026', code: 0 }, 'gone' ],
			[ 'ps failing', { out: '', code: 2 }, 'unknown' ],
			[ 'ps failing with output', { out: 'ps: illegal option', code: 1 }, 'unknown' ],
			[ 'empty output', { out: '', code: 0 }, 'unknown' ],
			[ 'an unreadable start time', { out: 'S    not a date', code: 0 }, 'unknown' ],
		] as const )( 'classifies %s from ps as Node does', async ( name, ps, state ) => {
			const proc = await procRoot( `ps ${ name }`, { self: false, boot: false } );
			const node = await nodeProbe( {
				platform: 'darwin',
				run: async () => ( { code: ps.code, stdout: ps.out ? ps.out + '\n' : '' } ),
			} );
			expect( node.state ).toBe( state );
			const shell = await shellProbe( proc, ps );
			expect( shell.rc ).toBe( RC[ state ] );
			if ( node.state === 'running' ) expect( shell.token ).toBe( node.start );
		} );

		it.each( [
			[ 'is still the leader', { stat: `41 (a) ${ STAT_AFTER_COMM }` }, true ],
			[ 'is gone, leaving the group', { stat: null }, true ],
			[
				'is another process now',
				{ stat: `41 (a) ${ STAT_AFTER_COMM.replace( '987654', '987655' ) }` },
				false,
			],
			[ 'cannot be read', { stat: errno( 'EACCES' ) }, false ],
			[ 'has no readable boot id', { stat: `41 (a) ${ STAT_AFTER_COMM }`, boot: false }, false ],
		] as const )(
			'has the keeper signal the group when the owner is gone only if its leader %s',
			async ( name, files, signalled ) => {
				const proc = await procRoot( `keeper ${ name }`, { self: true, ...files } );
				const log = path.join( root, `keeper ${ name }.log` );
				await writeFile( log, '' );
				const keeper = posixKeeperCommand( 41, `linux:${ BOOT }:987654` );
				const script = keeper.args[ 1 ];
				expect( script.startsWith( 'proc=/proc\n' ) ).toBe( true );
				// The keeper's own `kill` is replaced by one that records it; `kill -0` finds no group.
				const stubbed = script.replace(
					'proc=/proc\n',
					`proc='${ shellPath( proc ) }'\nkill() { printf '%s\\n' "$*" >> '${ shellPath(
						log
					) }'; [ "$1" != -0 ]; }\n`
				);
				const run = execFile( SHELL!, [ '-c', stubbed, 'sh', '41', keeper.args[ 4 ] ] );
				run.stdin!.end( 'gone\n' );
				const [ code ] = await once( run, 'exit' );
				expect( code ).toBe( 0 );
				const signals = ( await readFile( log, 'utf8' ) )
					.split( '\n' )
					.filter( ( line ) => line && ! line.startsWith( '-0 ' ) );
				expect( signals ).toEqual( signalled ? [ '-s TERM -- -41', '-s KILL -- -41' ] : [] );
			}
		);
	}
);

describe( 'Windows job ownership (injected seams)', () => {
	const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
	const decode = ( args: readonly string[] ) =>
		Buffer.from( args[ 3 ], 'base64' ).toString( 'utf16le' );
	const keeperScript = ( input: string | undefined ) =>
		Buffer.from( input ?? '', 'base64' ).toString( 'utf8' );
	// A child that exits when it is killed through its own handle.
	function killableChild() {
		const child = fakeChild( 4242 );
		child.kill = ( signal: NodeJS.Signals = 'SIGTERM' ) => {
			child.killed.push( signal );
			setImmediate( () => exitChild( child, 1 ) );
			return true;
		};
		return child;
	}

	it( 'prepares the job before the process exists, assigns it at once and ends the tree through the job', async () => {
		const child = fakeChild( 4242 );
		const { spawn: spawnSeam, calls, helpers } = fakeSpawn( child, keeperAnswering() );
		const owner = prepareProcessOwner( { ...windowsSeams, spawn: spawnSeam } );
		expect( calls ).toHaveLength( 1 );
		expect( calls[ 0 ].command ).toBe( POWERSHELL );
		expect( calls[ 0 ].options ).toMatchObject( {
			windowsHide: true,
			env: { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp' },
		} );
		expect( calls[ 0 ].options.env ).not.toHaveProperty( 'PATH' );
		expect( calls[ 0 ].options.detached ).toBeFalsy();
		expect( await owner.prepared() ).toBe( true );
		const script = keeperScript( helpers[ 0 ].input );
		expect( script ).toContain( 'Add-Type -TypeDefinition $source' );
		// Kill on close is the job's only limit: no breakaway flag is ever set.
		expect( script ).toContain( 'info.Basic.LimitFlags = KillOnJobClose;' );
		expect( script.match( /LimitFlags =/g ) ).toHaveLength( 1 );
		const owned = owner.spawn( 'C:\\claude.exe', [ '--print' ], { env: {} } );
		expect( calls[ 1 ] ).toMatchObject( {
			command: 'C:\\claude.exe',
			options: { detached: false, windowsHide: true, stdio: 'pipe' },
		} );
		expect( await owned.ready() ).toBe( true );
		expect( owned.identity() ).toEqual( { pid: 4242, start: WINDOWS_START } );
		expect( helpers[ 0 ].lines ).toEqual( [ 'own 4242', 'confirm' ] );
		expect( await owned.shutdown( { graceMs: 0, timeoutMs: 1000 } ) ).toBe( true );
		expect( helpers[ 0 ].lines.slice( 2 ) ).toEqual( [ 'reap 1000', 'release' ] );
		expect( child.killed ).toEqual( [] );
	} );

	it( 'starts the keeper with a short command line and sends its script as its first line of input', async () => {
		const { spawn: spawnSeam, calls, helpers } = fakeSpawn( fakeChild( 1 ), keeperAnswering() );
		const owner = prepareProcessOwner( { ...windowsSeams, spawn: spawnSeam } );
		expect( await owner.prepared() ).toBe( true );
		// Windows caps a command line at 32,767 characters; the keeper's stays far below.
		const commandLine = [ calls[ 0 ].command, ...calls[ 0 ].args ].join( ' ' );
		expect( commandLine.length ).toBeLessThan( 2_000 );
		expect( decode( calls[ 0 ].args ) ).not.toContain( 'Add-Type' );
		expect( decode( calls[ 0 ].args ) ).toContain( "'FullLanguage'" );
		expect( helpers[ 0 ].input ).toMatch( /^[A-Za-z0-9+/]+=*$/ );
		expect( keeperScript( helpers[ 0 ].input ) ).toContain( 'Add-Type -TypeDefinition $source' );
	} );

	it( 'gives the keeper the same script for every run, with no input in it', async () => {
		const runs = await Promise.all(
			[ 1, 2 ].map( async () => {
				const { spawn: spawnSeam, calls, helpers } = fakeSpawn( fakeChild( 1 ), keeperAnswering() );
				await prepareProcessOwner( { ...windowsSeams, spawn: spawnSeam } ).prepared();
				return [ decode( calls[ 0 ].args ), helpers[ 0 ].input ];
			} )
		);
		expect( runs[ 0 ] ).toEqual( runs[ 1 ] );
	} );

	it.each( [
		[
			'a keeper that cannot compile its job code',
			{ start: [ 'failed keeper 0' ] },
			'keeper-unavailable',
		],
		[
			'a keeper outside Full Language mode',
			{ start: [ 'failed keeper language' ] },
			'keeper-blocked',
		],
		[ 'a keeper that cannot create the job', { start: [ 'failed job 1450' ] }, 'job-unavailable' ],
		[ 'a keeper that exits at once', { start: null }, 'keeper-unavailable' ],
	] as const )( 'is not prepared, and says why, for %s', async ( _name, overrides, failure ) => {
		const { spawn: spawnSeam } = fakeSpawn( fakeChild( 4242 ), keeperAnswering( overrides ) );
		const owner = prepareProcessOwner( { ...windowsSeams, spawn: spawnSeam } );
		expect( await owner.prepared() ).toBe( false );
		expect( owner.failure() ).toBe( failure );
	} );

	it( 'reports a keeper that does not answer in time as timed out, not as unavailable', async () => {
		vi.useFakeTimers( { toFake: [ 'setTimeout', 'clearTimeout' ] } );
		try {
			const { spawn: spawnSeam } = fakeSpawn( fakeChild( 4242 ), keeperAnswering( { start: [] } ) );
			const owner = prepareProcessOwner( { ...windowsSeams, spawn: spawnSeam } );
			const prepared = owner.prepared();
			await vi.advanceTimersByTimeAsync( 60_000 );
			expect( await prepared ).toBe( false );
			expect( owner.failure() ).toBe( 'keeper-timeout' );

			const late = fakeSpawn( fakeChild( 4242 ), keeperAnswering( { 'own 4242': [] } ) );
			const owned = prepareProcessOwner( { ...windowsSeams, spawn: late.spawn } ).spawn(
				'C:\\claude.exe',
				[],
				{ env: {} }
			);
			const ready = owned.ready();
			await vi.advanceTimersByTimeAsync( 30_000 );
			expect( await ready ).toBe( false );
			expect( owned.failure() ).toBe( 'keeper-timeout' );
		} finally {
			vi.useRealTimers();
		}
	} );

	it( 'reports a process that did not start, with nothing left to end', async () => {
		const unstarted = fakeSpawn( fakeChild( undefined ), keeperAnswering() );
		const owned = prepareProcessOwner( { ...windowsSeams, spawn: unstarted.spawn } ).spawn(
			'C:\\missing.exe',
			[],
			{ env: {} }
		);
		expect( await owned.ready() ).toBe( false );
		expect( owned.failure() ).toBe( 'spawn-failed' );
		expect( await owned.shutdown( { graceMs: 0 } ) ).toBe( true );
	} );

	it( 'releases the keeper when the spawn throws before any process exists', async () => {
		const throwing = fakeSpawn( () => {
			throw Object.assign( new Error( 'spawn EINVAL' ), { code: 'EINVAL' } );
		}, keeperAnswering() );
		const owner = prepareProcessOwner( { ...windowsSeams, spawn: throwing.spawn } );
		expect( await owner.prepared() ).toBe( true );
		expect( () => owner.spawn( 'C:\\claude.exe', [], { env: {} } ) ).toThrow( 'EINVAL' );
		await owner.dispose();
		expect( throwing.helpers[ 0 ].lines ).toEqual( [ 'release' ] );
		expect( throwing.helpers[ 0 ].child.exitCode ).not.toBeNull();
	} );

	it( 'ends the keeper of an owner disposed while its job is still being prepared', async () => {
		const { spawn: spawnSeam, helpers } = fakeSpawn(
			fakeChild( 4242 ),
			keeperAnswering( { start: [] } )
		);
		const owner = prepareProcessOwner( { ...windowsSeams, spawn: spawnSeam } );
		await owner.dispose();
		expect( helpers[ 0 ].lines ).toEqual( [ 'release' ] );
		expect( helpers[ 0 ].child.exitCode ).not.toBeNull();
	} );

	it.each( [
		[ 'denied', 'failed assign 5 ' + WINDOWS_START, 'job-assignment-denied' ],
		[ 'refused otherwise', 'failed assign 1 ' + WINDOWS_START, 'job-assignment-failed' ],
	] as const )(
		'fails closed when the assignment is %s: ends the child and its provable tree, and never reports the tree as stopped',
		async ( _name, answer, failure ) => {
			const child = killableChild();
			const { spawn: spawnSeam, helpers } = fakeSpawn(
				child,
				// The keeper finds nothing left to end, which is also what a
				// grandchild whose parent already exited looks like.
				keeperAnswering( { 'own 4242': [ answer ], 'end-tree': [ 'ended 0' ] } )
			);
			const owned = prepareProcessOwner( { ...windowsSeams, spawn: spawnSeam } ).spawn(
				'C:\\claude.exe',
				[],
				{ env: {} }
			);
			expect( await owned.ready() ).toBe( false );
			expect( owned.failure() ).toBe( failure );
			expect( owned.identity() ).toBeUndefined();
			expect( await owned.shutdown( { graceMs: 0, timeoutMs: 1000 } ) ).toBe( false );
			expect( child.killed ).toEqual( [ 'SIGKILL' ] );
			expect( helpers[ 0 ].lines ).toEqual( [ 'own 4242', 'end-tree', 'release' ] );
		}
	);

	it( 'ends no tree through a handle opened after its child was reaped', async () => {
		const child = fakeChild( 4242 );
		const { spawn: spawnSeam, helpers } = fakeSpawn(
			child,
			keeperAnswering( {
				'own 4242': () => {
					exitChild( child );
					return [ 'failed assign 5 ' + WINDOWS_START ];
				},
			} )
		);
		const owned = prepareProcessOwner( { ...windowsSeams, spawn: spawnSeam } ).spawn(
			'C:\\claude.exe',
			[],
			{ env: {} }
		);
		expect( await owned.ready() ).toBe( false );
		expect( await owned.shutdown( { graceMs: 0, timeoutMs: 1000 } ) ).toBe( false );
		expect( helpers[ 0 ].lines ).toEqual( [ 'own 4242', 'release' ] );
		expect( child.killed ).toEqual( [] );
	} );

	it.each( [
		[ 'cannot be limited', 'failed limit 87', 'job-unverified' ],
		[ 'does not show the process', 'failed verify 0', 'job-unverified' ],
		[ 'finds a child already outside it', 'failed outside 1', 'job-incomplete' ],
	] as const )(
		'fails closed when the job %s: ends the provable tree, then the job, and never reports the tree as stopped',
		async ( _name, answer, failure ) => {
			const child = killableChild();
			const { spawn: spawnSeam, helpers } = fakeSpawn(
				child,
				keeperAnswering( { confirm: [ answer ], 'end-tree': [ 'ended 0' ] } )
			);
			const owned = prepareProcessOwner( { ...windowsSeams, spawn: spawnSeam } ).spawn(
				'C:\\claude.exe',
				[],
				{ env: {} }
			);
			expect( await owned.ready() ).toBe( false );
			expect( owned.failure() ).toBe( failure );
			expect( await owned.shutdown( { graceMs: 0, timeoutMs: 1000 } ) ).toBe( false );
			expect( helpers[ 0 ].lines ).toEqual( [
				'own 4242',
				'confirm',
				'end-tree',
				'reap 1000',
				'release',
			] );
		}
	);

	it.each( [
		[ 'failed open 87', 'process-exited' ],
		[ 'failed open 5', 'process-unavailable' ],
		[ 'failed start 0', 'identity-unavailable' ],
	] as const )( 'reports %s as %s, and the tree as not stopped', async ( answer, failure ) => {
		const child = killableChild();
		const { spawn: spawnSeam, helpers } = fakeSpawn(
			child,
			keeperAnswering( { 'own 4242': [ answer ] } )
		);
		const owned = prepareProcessOwner( { ...windowsSeams, spawn: spawnSeam } ).spawn(
			'C:\\claude.exe',
			[],
			{ env: {} }
		);
		expect( await owned.ready() ).toBe( false );
		expect( owned.failure() ).toBe( failure );
		expect( await owned.shutdown( { graceMs: 0, timeoutMs: 1000 } ) ).toBe( false );
		expect( helpers[ 0 ].lines ).toEqual( [ 'own 4242', 'release' ] );
	} );

	it( 'trusts an assignment only if the child was still unreaped when it was reported, and then kills nothing', async () => {
		const child = fakeChild( 4242 );
		const { spawn: spawnSeam, helpers } = fakeSpawn(
			child,
			keeperAnswering( {
				'own 4242': () => {
					exitChild( child );
					return [ `assigned ${ WINDOWS_START }` ];
				},
			} )
		);
		const owned = prepareProcessOwner( { ...windowsSeams, spawn: spawnSeam } ).spawn(
			'C:\\claude.exe',
			[],
			{ env: {} }
		);
		expect( await owned.ready() ).toBe( false );
		expect( owned.failure() ).toBe( 'process-exited' );
		expect( await owned.shutdown( { graceMs: 0, timeoutMs: 1000 } ) ).toBe( false );
		expect( helpers[ 0 ].lines ).toEqual( [ 'own 4242', 'release' ] );
		expect( child.killed ).toEqual( [] );
	} );

	it( 'counts a tree as ended when its keeper died after confirming, once the child is gone', async () => {
		const child = fakeChild( 4242 );
		const { spawn: spawnSeam } = fakeSpawn( child, keeperAnswering( { 'reap 1000': null } ) );
		const owned = prepareProcessOwner( { ...windowsSeams, spawn: spawnSeam } ).spawn(
			'C:\\claude.exe',
			[],
			{ env: {} }
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
		const owned = prepareProcessOwner( { ...windowsSeams, spawn: spawnSeam } ).spawn(
			'C:\\claude.exe',
			[],
			{ env: {} }
		);
		expect( await owned.ready() ).toBe( true );
		expect( await owned.terminate( 1000 ) ).toBe( false );
	} );

	it( 'lists the live members of the job', async () => {
		const { spawn: spawnSeam } = fakeSpawn(
			fakeChild( 4242 ),
			keeperAnswering( {
				inspect: [ `live 4242 ${ WINDOWS_START }`, 'live 4300 134389060548250000', 'inspected' ],
			} )
		);
		const owned = prepareProcessOwner( { ...windowsSeams, spawn: spawnSeam } ).spawn(
			'C:\\claude.exe',
			[],
			{ env: {} }
		);
		expect( await owned.ready() ).toBe( true );
		expect( await owned.inspect() ).toEqual( {
			live: [
				{ pid: 4242, start: WINDOWS_START },
				{ pid: 4300, start: '134389060548250000' },
			],
			uncertain: false,
		} );
	} );

	it( 'starts no supervisor on Windows, where the job ends with this process', async () => {
		const { spawn: spawnSeam, calls } = fakeSpawn( fakeChild( 4242 ), keeperAnswering() );
		const owned = prepareProcessOwner( { ...windowsSeams, spawn: spawnSeam } ).spawn(
			'C:\\claude.exe',
			[],
			{ env: {}, supervise: true }
		);
		expect( await owned.ready() ).toBe( true );
		expect( calls.map( ( call ) => call.command ) ).toEqual( [ POWERSHELL, 'C:\\claude.exe' ] );
	} );

	it( 'ends the keeper of an owner that never spawned', async () => {
		const { spawn: spawnSeam, helpers } = fakeSpawn( fakeChild( 4242 ), keeperAnswering() );
		const owner = prepareProcessOwner( { ...windowsSeams, spawn: spawnSeam } );
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

// A Windows `run` seam that answers the identity probe from `processes`
// (missing: gone) and the child listing from `children`, keyed by PID.
function windowsRun(
	processes: Record< number, string >,
	children: Record< number, readonly string[] | 'fail' | 'cut' > = {}
) {
	const scripts: string[] = [];
	const run: OwnedProcessSeams[ 'run' ] = async ( _file, args ) => {
		const script = Buffer.from( args[ 3 ], 'base64' ).toString( 'utf16le' );
		scripts.push( script );
		const parent = /\$parentId = \[long\](\d+)/.exec( script );
		if ( parent ) {
			const listed = children[ Number( parent[ 1 ] ) ] ?? [];
			if ( listed === 'fail' ) return { code: 1, stdout: '' };
			if ( listed === 'cut' ) return { code: 0, stdout: 'child 77 134389060548248000\r\n' };
			return {
				code: 0,
				stdout: [ ...listed, 'listed' ].map( ( line ) => line + '\r\n' ).join( '' ),
			};
		}
		const pid = Number( /\$rootId = \[long\](\d+)/.exec( script )![ 1 ] );
		const start = processes[ pid ];
		if ( start === undefined ) return { code: 0, stdout: 'gone\r\n' };
		if ( start === 'unknown' ) return { code: 0, stdout: 'unknown\r\n' };
		return { code: 0, stdout: `start ${ start }\r\n` };
	};
	return { run, scripts };
}

describe( 'what a recovery can prove of a tree once its owner is gone (injected seams)', () => {
	const native = { pid: 4242, start: WINDOWS_START };
	const keeper = { pid: 9000, start: KEEPER_START };

	it( 'reads the job keeper as the guardian of a confirmed tree, and none before', async () => {
		const child = fakeChild( 4242 );
		const { spawn: spawnSeam, helpers } = fakeSpawn( child, keeperAnswering() );
		const owner = prepareProcessOwner( { ...windowsSeams, spawn: spawnSeam } );
		const owned = owner.spawn( 'C:\\claude.exe', [], { env: {} } );
		expect( await owned.ready() ).toBe( true );
		expect( await owned.guardian() ).toEqual( keeper );
		expect( helpers[ 0 ].lines ).toEqual( [ 'own 4242', 'confirm', 'self' ] );

		const unconfirmed = fakeSpawn(
			fakeChild( 4242 ),
			keeperAnswering( { 'own 4242': [ 'failed assign 5 1' ], 'end-tree': [ 'ended 0' ] } )
		);
		const refused = prepareProcessOwner( { ...windowsSeams, spawn: unconfirmed.spawn } ).spawn(
			'C:\\claude.exe',
			[],
			{ env: {} }
		);
		expect( await refused.ready() ).toBe( false );
		expect( await refused.guardian() ).toBeUndefined();
		expect( unconfirmed.helpers[ 0 ].lines ).not.toContain( 'self' );

		const unreadable = fakeSpawn( fakeChild( 4242 ), keeperAnswering( { self: [ 'self -1' ] } ) );
		const blind = prepareProcessOwner( { ...windowsSeams, spawn: unreadable.spawn } ).spawn(
			'C:\\claude.exe',
			[],
			{ env: {} }
		);
		expect( await blind.ready() ).toBe( true );
		expect( await blind.guardian() ).toBeUndefined();
	} );

	it( 'reads the POSIX supervisor as the guardian of a supervised group, and none without one', async () => {
		const files: Record< string, string > = {
			'/proc/500/stat': LEADER_STAT,
			'/proc/9000/stat': LEADER_STAT.replace( ' 777 ', ' 778 ' ),
		};
		const supervised = fakeSpawn( fakeChild( 500 ), () => [ 'ready' ] );
		const owned = prepareProcessOwner( {
			...linuxSeams( files, () => {} ),
			spawn: supervised.spawn,
		} ).spawn( '/opt/claude', [], { env: {}, supervise: true } );
		expect( await owned.ready() ).toBe( true );
		expect( await owned.guardian() ).toEqual( { pid: 9000, start: `linux:${ BOOT }:778` } );

		const plain = fakeSpawn( fakeChild( 500 ) );
		const alone = prepareProcessOwner( {
			...linuxSeams( files, () => {} ),
			spawn: plain.spawn,
		} ).spawn( '/opt/claude', [], { env: {} } );
		expect( await alone.ready() ).toBe( true );
		expect( await alone.guardian() ).toBeUndefined();
	} );

	describe( 'a POSIX process group', () => {
		const leader = { pid: 500, start: `linux:${ BOOT }:777` };

		it.each( [
			[ 'empty when no process is in it', errno( 'ESRCH' ), LEADER_STAT, 'empty' ],
			[ 'its leader’s while the leader is that same process', undefined, LEADER_STAT, 'alive' ],
			[
				'its leader’s when the leader is that same process another user runs',
				errno( 'EPERM' ),
				LEADER_STAT,
				'alive',
			],
			[ 'undecided when it has members and its leader is gone', undefined, undefined, 'unknown' ],
			[
				'undecided when it has members and another process has its leader’s ID',
				undefined,
				LEADER_STAT.replace( ' 777 ', ' 901 ' ),
				'unknown',
			],
			[
				'undecided when its leader cannot be read',
				undefined,
				errno( 'EACCES' ) as unknown as string,
				'unknown',
			],
			[ 'undecided when the kernel says neither', errno( 'EINVAL' ), LEADER_STAT, 'unknown' ],
		] as const )( 'is %s', async ( _name, failure, stat, expected ) => {
			const signals: Array< [ number, NodeJS.Signals | 0 ] > = [];
			const files: Record< string, string | Error > = {};
			if ( stat !== undefined ) files[ '/proc/500/stat' ] = stat;
			expect(
				await checkProcessGroup(
					leader,
					linuxSeams( files, ( pid, signal ) => {
						signals.push( [ pid, signal ] );
						if ( failure ) throw failure;
					} )
				)
			).toBe( expected );
			expect( signals ).toEqual( [ [ -500, 0 ] ] );
		} );

		it( 'is undecided on Windows, and for an identity that names no process', async () => {
			const kill = vi.fn();
			expect( await checkProcessGroup( leader, { ...windowsSeams, kill } ) ).toBe( 'unknown' );
			expect( await checkProcessGroup( { pid: 0, start: 'x' }, linuxSeams( {}, kill ) ) ).toBe(
				'unknown'
			);
			expect( await checkProcessGroup( { pid: 500, start: '' }, linuxSeams( {}, kill ) ) ).toBe(
				'unknown'
			);
			expect( kill ).not.toHaveBeenCalled();
		} );
	} );

	describe( 'a Windows tree, which the job held', () => {
		it( 'is ended only when its native process and keeper are gone and nothing names the native process as its parent', async () => {
			const { run, scripts } = windowsRun( {} );
			expect(
				await checkOwnedTreeEnded( { native, guardian: keeper }, { ...windowsSeams, run } )
			).toEqual( { state: 'ended' } );
			const listing = scripts.find( ( script ) => script.includes( 'Get-CimInstance' ) );
			expect( listing ).toContain( '$parentId = [long]4242' );
			expect( listing ).toContain( '-Filter "ParentProcessId = $parentId"' );
		} );

		it.each( [
			[ 'its native process is running', { 4242: WINDOWS_START }, {}, 'alive', 'native' ],
			[ 'its native process cannot be read', { 4242: 'unknown' }, {}, 'unknown', 'native' ],
			[ 'its keeper is running', { 9000: KEEPER_START }, {}, 'alive', 'guardian' ],
			[ 'its keeper cannot be read', { 9000: 'unknown' }, {}, 'unknown', 'guardian' ],
			[
				'a process created after the native process names it as its parent',
				{},
				{ 4242: [ 'child 77 134389060548248000' ] },
				'alive',
				'descendant',
			],
			[
				'a process created in the same microsecond names it as its parent',
				{},
				{ 4242: [ 'child 77 134389060548247990' ] },
				'alive',
				'descendant',
			],
			[ 'the processes cannot be listed', {}, { 4242: 'fail' }, 'unknown', 'descendant' ],
			[ 'the listing was cut short', {}, { 4242: 'cut' }, 'unknown', 'descendant' ],
		] as const )( 'is not ended when %s', async ( _name, processes, children, state, which ) => {
			const { run } = windowsRun( { ...processes }, { ...children } );
			expect(
				await checkOwnedTreeEnded( { native, guardian: keeper }, { ...windowsSeams, run } )
			).toEqual( { state, process: which } );
		} );

		it( 'treats a process with the native process’s ID and another start as another process', async () => {
			const { run } = windowsRun(
				{ 4242: '134389070000000000', 9000: '134389070000000001' },
				{ 4242: [ 'child 78 134389060548240000' ] }
			);
			expect(
				await checkOwnedTreeEnded( { native, guardian: keeper }, { ...windowsSeams, run } )
			).toEqual( { state: 'ended' } );
		} );

		it( 'is never ended without a keeper to show the job was closed', async () => {
			const { run } = windowsRun( {} );
			expect( await checkOwnedTreeEnded( { native }, { ...windowsSeams, run } ) ).toEqual( {
				state: 'unknown',
				process: 'guardian',
			} );
		} );
	} );

	describe( 'a POSIX tree, which its group held', () => {
		const leader = { pid: 500, start: `linux:${ BOOT }:777` };
		const supervisor = { pid: 9000, start: `linux:${ BOOT }:778` };

		it( 'is ended once its group is empty and its supervisor is gone, signalling nothing', async () => {
			const signals: Array< [ number, NodeJS.Signals | 0 ] > = [];
			const seams = linuxSeams( {}, ( pid, signal ) => {
				signals.push( [ pid, signal ] );
				throw errno( 'ESRCH' );
			} );
			expect(
				await checkOwnedTreeEnded( { native: leader, guardian: supervisor }, seams )
			).toEqual( { state: 'ended' } );
			expect( await checkOwnedTreeEnded( { native: leader }, seams ) ).toEqual( {
				state: 'ended',
			} );
			expect( signals.every( ( [ pid, signal ] ) => pid === -500 && signal === 0 ) ).toBe( true );
		} );

		it.each( [
			[ 'its leader is running', { '/proc/500/stat': LEADER_STAT }, 'ESRCH', 'alive', 'native' ],
			[
				'its supervisor is running',
				{ '/proc/9000/stat': LEADER_STAT.replace( ' 777 ', ' 778 ' ) },
				'ESRCH',
				'alive',
				'guardian',
			],
			[ 'its group still has members', {}, undefined, 'unknown', 'descendant' ],
		] as const )( 'is not ended when %s', async ( _name, files, failure, state, which ) => {
			const seams = linuxSeams( { ...files }, () => {
				if ( failure ) throw errno( failure );
			} );
			expect(
				await checkOwnedTreeEnded( { native: leader, guardian: supervisor }, seams )
			).toEqual( { state, process: which } );
		} );
	} );
} );

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

	it( 'ends the owned tree when the owner dies (through the job on Windows, the supervisor on POSIX), and leaves no helper behind', async () => {
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
					`proc=/proc\n${ posixProbeScript() }\nprobe "$1"`,
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
			const late = await readProcessIdentity( Number( latePid ) );
			expect( late ).toBeDefined();
			expect( await owned.terminate() ).toBe( true );
			expect( await goneWithin( [ late! ], 5_000 ) ).toEqual( [] );
			expect( await goneWithin( tree, 5_000 ) ).toEqual( [] );
			expect( await checkProcessIdentity( sentinelIdentity ) ).toBe( 'alive' );
		} finally {
			if ( owned.child.exitCode === null && owned.child.signalCode === null )
				owned.child.kill( 'SIGKILL' );
		}
	}, 60_000 );

	// Polls until the tree check gives `expected`, which a console host that
	// outlives its last client by moments may delay.
	async function treeCheckWithin(
		processes: Parameters< typeof checkOwnedTreeEnded >[ 0 ],
		ms: number
	): Promise< Awaited< ReturnType< typeof checkOwnedTreeEnded > > > {
		const deadline = Date.now() + ms;
		let found = await checkOwnedTreeEnded( processes );
		while ( found.state !== 'ended' && Date.now() < deadline ) {
			await new Promise( ( resolve ) => setTimeout( resolve, 250 ) );
			found = await checkOwnedTreeEnded( processes );
		}
		return found;
	}

	it.skipIf( process.platform !== 'win32' )(
		`proves a tree ended only once its native process, its keeper and every process naming the native process as its parent are gone ${ WINDOWS_ONLY }`,
		async () => {
			const owned = await ownedTree( [ 'tree', marker, String( LIFETIME ), 'ignore-eof' ] );
			try {
				expect( await owned.ready() ).toBe( true );
				const native = owned.identity()!;
				const keeper = ( await owned.guardian() )!;
				expect( keeper ).toBeDefined();
				expect( keeper.pid ).not.toBe( native.pid );
				expect( await checkProcessIdentity( keeper ) ).toBe( 'alive' );
				const next = lines( owned.child.stdout );
				await next();
				expect( await checkOwnedTreeEnded( { native, guardian: keeper } ) ).toEqual( {
					state: 'alive',
					process: 'native',
				} );
				owned.child.stdin.write( 'spawn\n' );
				const [ , latePid ] = ( await next() ).split( ' ' );
				const late = ( await readProcessIdentity( Number( latePid ) ) )!;
				expect( late ).toBeDefined();
				// The test's own unreaped child. The late child is outside its Node
				// job, and the keeper still holds ours, so it outlives the native process.
				const exited = once( owned.child, 'exit' );
				owned.child.kill( 'SIGKILL' );
				await exited;
				expect( await goneWithin( [ native ], 10_000 ) ).toEqual( [] );
				expect( await checkProcessIdentity( late ) ).toBe( 'alive' );
				expect( await checkOwnedTreeEnded( { native, guardian: keeper } ) ).toEqual( {
					state: 'alive',
					process: 'guardian',
				} );
				// A live process with the keeper's ID and another start is not the keeper.
				const recycled = { pid: keeper.pid, start: `${ keeper.start }0` };
				expect( await checkOwnedTreeEnded( { native, guardian: recycled } ) ).toEqual( {
					state: 'alive',
					process: 'descendant',
				} );
				expect( await owned.shutdown( { graceMs: 0 } ) ).toBe( true );
				expect( await goneWithin( [ late, keeper ], 10_000 ) ).toEqual( [] );
				expect( await treeCheckWithin( { native, guardian: keeper }, 10_000 ) ).toEqual( {
					state: 'ended',
				} );
				expect( await checkProcessIdentity( sentinelIdentity ) ).toBe( 'alive' );
			} finally {
				if ( owned.child.exitCode === null && owned.child.signalCode === null )
					owned.child.kill( 'SIGKILL' );
			}
		},
		90_000
	);

	it.skipIf( process.platform === 'win32' )(
		`counts a group as ended only when the kernel shows it empty ${ POSIX_ONLY }`,
		async () => {
			const owned = await ownedTree( [ 'tree', marker, String( LIFETIME ), 'ignore-eof' ] );
			try {
				expect( await owned.ready() ).toBe( true );
				const native = owned.identity()!;
				const [ , , , leafPid ] = ( await firstLine( owned.child.stdout ) ).split( ' ' );
				const leaf = ( await readProcessIdentity( Number( leafPid ) ) )!;
				expect( await checkProcessGroup( native ) ).toBe( 'alive' );
				// The test's own unreaped child: its shell and leaf stay in its group.
				const exited = once( owned.child, 'exit' );
				owned.child.kill( 'SIGKILL' );
				await exited;
				expect( await checkProcessIdentity( leaf ) ).toBe( 'alive' );
				expect( await checkProcessGroup( native ) ).toBe( 'unknown' );
				expect( await checkOwnedTreeEnded( { native } ) ).toEqual( {
					state: 'unknown',
					process: 'descendant',
				} );
				expect( await owned.terminate() ).toBe( true );
				expect( await checkProcessGroup( native ) ).toBe( 'empty' );
				expect( await checkOwnedTreeEnded( { native } ) ).toEqual( { state: 'ended' } );
				expect( await checkProcessIdentity( sentinelIdentity ) ).toBe( 'alive' );
			} finally {
				if ( owned.child.exitCode === null && owned.child.signalCode === null )
					owned.child.kill( 'SIGKILL' );
			}
		},
		60_000
	);

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

	// The job keeper driven directly, as Studio drives it after a failed
	// assignment, so its tree walk runs natively. It owns a fixture tree that
	// is the test's own unreaped child, so the keeper's handle is that
	// child's; its job still holds the tree, so the test can end whatever the
	// walk leaves.
	function keeperOwningTree() {
		const command = windowsKeeperCommand( { env: process.env } as OwnedProcessSeams );
		const keeper = spawn( command.command, command.args, {
			env: command.env,
			stdio: [ 'pipe', 'pipe', 'ignore' ],
			windowsHide: true,
		} );
		const reply = lines( keeper.stdout );
		const answer = ( line?: string ) => {
			if ( line !== undefined ) keeper.stdin.write( line + '\n' );
			return Promise.race( [
				reply(),
				new Promise< string >( ( _resolve, reject ) =>
					setTimeout( () => reject( new Error( `No answer to ${ line }` ) ), 20_000 ).unref()
				),
			] );
		};
		keeper.stdin.write( command.input + '\n' );
		let tree: ChildProcess | undefined;
		let assigned = false;
		return {
			answer,
			// Starts the tree once the job exists, so it is assigned before it
			// starts its shell and the job holds everything it starts.
			async own() {
				expect( await answer() ).toBe( 'prepared' );
				const started = spawn(
					process.execPath,
					[ fixture, 'tree', marker, String( LIFETIME ), 'ignore-eof' ],
					{ stdio: 'pipe', windowsHide: true }
				);
				tree = started;
				expect( await answer( `own ${ started.pid }` ) ).toMatch( /^assigned \d+$/ );
				assigned = true;
				const next = lines( started.stdout );
				const [ , treePid, shellPid, leafPid ] = ( await next() ).split( ' ' );
				return { root: started, treePid, shellPid, leafPid, next };
			},
			async close() {
				if ( assigned && keeper.exitCode === null ) await answer( 'reap 5000' ).catch( () => {} );
				const exited = once( keeper, 'exit' );
				if ( keeper.exitCode === null ) keeper.stdin.end( 'release\n' );
				await exited;
				if ( tree && tree.exitCode === null && tree.signalCode === null ) tree.kill( 'SIGKILL' );
			},
		};
	}

	it.skipIf( process.platform !== 'win32' )(
		`ends a tree through the keeper's handles, the shell's child included ${ WINDOWS_ONLY }`,
		async () => {
			const driven = keeperOwningTree();
			try {
				const { root, treePid, shellPid, leafPid, next } = await driven.own();
				root.stdin.write( 'spawn\n' );
				const [ , latePid ] = ( await next() ).split( ' ' );
				const tree = await identities( [ treePid, shellPid, leafPid, latePid ].map( Number ) );
				expect( tree ).toHaveLength( 4 );
				expect( await driven.answer( 'end-tree' ) ).toMatch( /^ended [1-9]\d*$/ );
				// The shell's child is outside the tree's own Node job and outlives
				// the tree (the next test shows it), so only the walk ends it here.
				expect( await goneWithin( tree, 5_000 ) ).toEqual( [] );
				expect( await checkProcessIdentity( sentinelIdentity ) ).toBe( 'alive' );
			} finally {
				await driven.close();
			}
		},
		60_000
	);

	it.skipIf( process.platform !== 'win32' )(
		`leaves alone a process whose parent exited before the keeper held it ${ WINDOWS_ONLY }`,
		async () => {
			const driven = keeperOwningTree();
			try {
				const { root, shellPid, leafPid } = await driven.own();
				const [ shell, leaf ] = await identities( [ shellPid, leafPid ].map( Number ) );
				// The test's own unreaped child. Its own Node job ends the shell
				// with it; the shell's child outlives both, with a parent nothing
				// holds, which is what a grandchild whose parent exited looks like.
				root.kill( 'SIGKILL' );
				expect( await goneWithin( [ shell ], 10_000 ) ).toEqual( [] );
				expect( await checkProcessIdentity( leaf ) ).toBe( 'alive' );
				expect( await driven.answer( 'end-tree' ) ).toMatch( /^ended \d+$/ );
				expect( await goneWithin( [ leaf ], 2_000 ) ).toEqual( [ leaf ] );
				// The job still holds it.
				expect( await driven.answer( 'reap 5000' ) ).toBe( 'reaped clean' );
				expect( await goneWithin( [ leaf ], 5_000 ) ).toEqual( [] );
				expect( await checkProcessIdentity( sentinelIdentity ) ).toBe( 'alive' );
			} finally {
				await driven.close();
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

describe.skipIf( process.platform !== 'win32' )(
	`the keeper's tree walk, compiled and run by Windows PowerShell ${ WINDOWS_ONLY }`,
	() => {
		it( 'takes a process into the walk only when it was created after the parent it names, never in the same tick', async () => {
			const keeper = Buffer.from(
				windowsKeeperCommand( { env: process.env } as OwnedProcessSeams ).input!,
				'base64'
			).toString( 'utf8' );
			const source = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/.exec( keeper )?.[ 1 ];
			expect( source ).toBeDefined();
			// The walk asks this rule, and only this rule, about start times.
			const walk = /static List<IntPtr> Descendants[\s\S]*?\n\t\t}\n/.exec( source! )?.[ 0 ];
			expect( walk ).toContain( 'CreatedAfter(started, parentStarted)' );
			expect( walk ).not.toMatch( /started\s*>=?\s*parentStarted/ );
			const directory = await mkdtemp( path.join( os.tmpdir(), 'studio-keeper-walk-' ) );
			try {
				const file = path.join( directory, 'job.cs' );
				await writeFile( file, source! );
				const script = [
					`Add-Type -Path '${ file.replace( /'/g, "''" ) }'`,
					"foreach ($pair in @(@(5, 5), @(6, 5), @(4, 5), @(0, 0))) { '{0} {1} {2}' -f $pair[0], $pair[1], [StudioOwned.Job]::CreatedAfter([long]$pair[0], [long]$pair[1]) }",
				].join( '\n' );
				const { stdout } = await exec(
					powershell,
					[
						'-NoProfile',
						'-NonInteractive',
						'-EncodedCommand',
						Buffer.from( script, 'utf16le' ).toString( 'base64' ),
					],
					{ windowsHide: true, timeout: 60_000 }
				);
				expect( stdout.trim().split( /\r?\n/ ) ).toEqual( [
					'5 5 False',
					'6 5 True',
					'4 5 False',
					'0 0 False',
				] );
			} finally {
				await rm( directory, { recursive: true, force: true } );
			}
		}, 90_000 );
	}
);
