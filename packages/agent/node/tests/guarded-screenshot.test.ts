import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { withClaudeWebCall } from '../claude-code/web-transport';
import { bindTool } from '../tools/define-tool';
import { createTakeScreenshotTool } from '../tools/take-screenshot';
import { createFakeHost } from './fake-host';
import type { AddressInfo } from 'node:net';

it.skipIf( ! existsSync( chromium.executablePath() ) )(
	'persists an actual Chromium capture and leaves the sidecar unchanged when a second call stops',
	async () => {
		const directory = await realpath( await mkdtemp( path.join( tmpdir(), 'studio-captures-' ) ) );
		let received!: () => void;
		const waiting = new Promise< void >( ( resolve ) => {
			received = resolve;
		} );
		const server = createServer( ( req, res ) => {
			if ( req.url === '/wait' ) {
				received();
				return;
			}
			res.writeHead( 200, { 'Content-Type': 'text/html' } ).end( '<h1>Screenshot fixture</h1>' );
		} );
		try {
			server.listen( 0, '127.0.0.1' );
			await once( server, 'listening' );
			const url = 'http://127.0.0.1:' + ( server.address() as AddressInfo ).port;
			const host = createFakeHost();
			host.screenshotsDirectory = async () => directory;
			const tool = bindTool( createTakeScreenshotTool( { visionEnabled: false } ), host );
			const stop = new AbortController();
			const scope = { targetOrigin: url, localSiteUrls: [ url ], signal: stop.signal };
			const result = await withClaudeWebCall( scope, () => tool.rawHandler( { url } ) );
			const files = await readdir( directory );
			expect( files ).toHaveLength( 1 );
			expect( ( await readFile( path.join( directory, files[ 0 ] ) ) ).subarray( 0, 3 ) ).toEqual(
				Buffer.from( [ 255, 216, 255 ] )
			);
			expect( result.studioArtifacts ).toHaveLength( 1 );
			const pending = withClaudeWebCall( scope, () => tool.rawHandler( { url: url + '/wait' } ) );
			void pending.catch( () => undefined );
			await waiting;
			stop.abort( new Error( 'Stopped fixture' ) );
			await expect( pending ).rejects.toThrow( 'Stopped fixture' );
			expect( await readdir( directory ) ).toEqual( files );
		} finally {
			server.closeAllConnections();
			await new Promise< void >( ( resolve ) => server.close( () => resolve() ) );
			await rm( directory, { recursive: true, force: true } );
		}
	},
	40_000
);
