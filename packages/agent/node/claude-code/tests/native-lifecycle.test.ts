import { execFile, fork } from 'child_process';
import { once } from 'events';
import { mkdir, mkdtemp, realpath, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildClaudeEnvironment } from '../auth-status';
import { inspectClaudeExecutable, trustedPowerShellPath } from '../discovery';
import { createNativeSessionStore } from '../sessions';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';

const executable = process.env.STUDIO_TEST_NATIVE_CLAUDE_LIFECYCLE_EXE;
const exec = promisify( execFile );

describe.runIf( process.platform === 'win32' && !! executable )(
	'offline native Windows lifecycle',
	() => {
		let root: string;
		let fixture: string;
		beforeAll( async () => {
			expect( await inspectClaudeExecutable( executable! ) ).toMatchObject( {
				ok: true,
				version: '2.1.319',
				architecture: 'x64',
			} );
			root = await realpath(
				await mkdtemp( path.join( os.tmpdir(), 'Studio Claude Lifecycle Évidence ' ) )
			);
			fixture = path.join( root, 'native-lifecycle.cjs' );
			await exec( process.execPath, [
				path.resolve( 'node_modules/esbuild/bin/esbuild' ),
				path.resolve(
					'packages/agent/node/claude-code/tests/fixtures/native-lifecycle-process.ts'
				),
				'--bundle',
				'--platform=node',
				'--format=cjs',
				'--outfile=' + fixture,
				'--log-level=silent',
				'--external:@anthropic-ai/claude-agent-sdk/*',
				'--external:@earendil-works/*',
			] );
		}, 30_000 );
		afterAll( async () => {
			if ( root )
				await rm( root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 } );
		} );

		async function powershell( script: string ) {
			const { stdout } = await exec(
				trustedPowerShellPath(),
				[
					'-NoProfile',
					'-NonInteractive',
					'-EncodedCommand',
					Buffer.from( script, 'utf16le' ).toString( 'base64' ),
				],
				{ windowsHide: true, timeout: 20_000 }
			);
			return JSON.parse( stdout );
		}

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
				const owner = fork( fixture, [ executable!, directory ], {
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
				let descendants: number[] = [];
				try {
					await ready;
					expect( nativePid ).toBeGreaterThan( 0 );
					descendants = await powershell(
						`$all=Get-CimInstance Win32_Process; $ids=@(${ owner.pid }); do { $next=@($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | ForEach-Object { [int]$_.ProcessId }); $ids += $next } while($next.Count); ConvertTo-Json -Compress -InputObject @($ids | Where-Object { $_ -ne ${ owner.pid } })`
					);
					expect( descendants ).toContain( nativePid );
					if ( action === 'kill-owner' ) owner.kill( 'SIGKILL' );
					else owner.send( action );
					await exited;
					const remaining = await powershell(
						`$alive=@(); foreach($id in @(${ descendants.join(
							','
						) })) { $p=Get-Process -Id $id -ErrorAction SilentlyContinue; if($p -and -not $p.WaitForExit(10000)) { $alive += $id } }; ConvertTo-Json -Compress -InputObject @($alive)`
					);
					expect( remaining ).toEqual( [] );
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
					if ( owner.exitCode === null && owner.signalCode === null ) owner.kill( 'SIGKILL' );
					for ( const pid of new Set(
						[ ...descendants, nativePid ].filter( ( pid ): pid is number => !! pid )
					) ) {
						try {
							process.kill( pid, 'SIGKILL' );
						} catch {
							/* Already exited. */
						}
					}
					await exited;
				}
			},
			60_000
		);
	}
);
