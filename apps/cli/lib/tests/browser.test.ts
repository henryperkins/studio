import { EventEmitter } from 'events';
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
