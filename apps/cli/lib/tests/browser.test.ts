import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openBrowser } from 'cli/lib/browser';

const { spawnMock } = vi.hoisted( () => ( { spawnMock: vi.fn() } ) );

vi.mock( 'child_process', () => ( { spawn: spawnMock, default: { spawn: spawnMock } } ) );

const URL = 'http://127.0.0.1:1/test-only';

// The system's URL opener, answering as it would on this host.
function opener( answer: ( child: EventEmitter ) => void ) {
	spawnMock.mockImplementation( () => {
		const child = new EventEmitter();
		process.nextTick( () => answer( child ) );
		return child;
	} );
}

function onPlatform( platform: NodeJS.Platform ) {
	Object.defineProperty( process, 'platform', { value: platform } );
}

// A ChatGPT sign-in reads a rejection here as `browser-unavailable`: the user has to act.
describe( 'opening the system browser on a host without one', () => {
	const platform = process.platform;

	afterEach( () => {
		onPlatform( platform );
		spawnMock.mockReset();
	} );

	it.each( [ 'linux', 'darwin', 'win32' ] as const )(
		'fails on %s when the opener isn’t installed',
		async ( host ) => {
			onPlatform( host );
			opener( ( child ) =>
				child.emit( 'error', Object.assign( new Error( 'spawn ENOENT' ), { code: 'ENOENT' } ) )
			);

			await expect( openBrowser( URL ) ).rejects.toThrow( 'spawn ENOENT' );
		}
	);

	// xdg-open exits 3 when it finds no browser (headless, no $BROWSER), 4 when opening failed.
	it.each( [ 3, 4 ] )( 'fails on Linux when xdg-open exits %i', async ( code ) => {
		onPlatform( 'linux' );
		opener( ( child ) => child.emit( 'exit', code ) );

		await expect( openBrowser( URL ) ).rejects.toThrow( 'Failed to open browser' );
		expect( spawnMock ).toHaveBeenCalledWith( 'xdg-open', expect.any( Array ) );
	} );

	it( 'fails on a platform it has no opener for, starting nothing', async () => {
		onPlatform( 'freebsd' );

		await expect( openBrowser( URL ) ).rejects.toThrow( 'Unsupported platform' );
		expect( spawnMock ).not.toHaveBeenCalled();
	} );

	it( 'succeeds once the opener has handed the page on', async () => {
		onPlatform( 'linux' );
		opener( ( child ) => child.emit( 'exit', 0 ) );

		await expect( openBrowser( URL ) ).resolves.toBeUndefined();
	} );
} );

// What reaches PowerShell when the Windows opener runs it.
describe( 'opening the system browser on Windows', () => {
	const platform = process.platform;
	// Everything PowerShell would run or expand, and a quote to break out of a string with.
	const marker = path.join( os.tmpdir(), `studio-opener-test-${ randomUUID() }` );
	const HOSTILE = `http://127.0.0.1:1/$(New-Item -ItemType File -Path '${ marker }-1')?a=\`$(New-Item -ItemType File -Path "${ marker }-2")&b="'&c=$env:PATH;x`;

	// The command the opener starts, captured instead of run.
	async function capture( url: string ) {
		onPlatform( 'win32' );
		opener( ( child ) => child.emit( 'exit', 0 ) );
		await openBrowser( url );
		const [ command, args, options ] = spawnMock.mock.calls[ 0 ] as [
			string,
			string[],
			{ env?: NodeJS.ProcessEnv } | undefined,
		];
		return { command, args, env: options?.env };
	}

	afterEach( () => {
		onPlatform( platform );
		spawnMock.mockReset();
		for ( const suffix of [ '-1', '-2' ] ) {
			fs.rmSync( `${ marker }${ suffix }`, { force: true } );
		}
	} );

	it( 'puts nothing of the address in the command it starts', async () => {
		const { command, args, env } = await capture( HOSTILE );

		expect( command.toLowerCase() ).toBe( 'powershell' );
		const commandLine = args.join( ' ' );
		for ( const piece of [ '127.0.0.1', '$(', '`', '"', "'", '&', marker ] ) {
			expect( commandLine ).not.toContain( piece );
		}
		// The address travels in the environment, exactly as given.
		expect( Object.values( env ?? {} ) ).toContain( HOSTILE );
	} );

	// Runs the captured command in Windows PowerShell, with Start-Process
	// standing in to print what it was given instead of opening a browser.
	it.runIf( platform === 'win32' )(
		'runs nothing in the address as PowerShell code, and hands it over exactly',
		async () => {
			const { command, args, env } = await capture( HOSTILE );
			const real = await vi.importActual< typeof import('child_process') >( 'child_process' );
			const at = args.indexOf( '-Command' ) + 1;

			const result = real.spawnSync(
				command,
				[
					...args.slice( 0, at ),
					'function Start-Process { param([string]$FilePath) [Console]::Out.Write($FilePath) };',
					...args.slice( at ),
				],
				{ env: env ?? process.env, encoding: 'utf8', windowsHide: true, timeout: 60_000 }
			);

			expect( result.stdout ).toBe( HOSTILE );
			expect( fs.existsSync( `${ marker }-1` ) ).toBe( false );
			expect( fs.existsSync( `${ marker }-2` ) ).toBe( false );
		},
		90_000
	);
} );
