import { once } from 'node:events';
import { link, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { requestWebHop } from '@studio/agent/node/claude-code/web-http';
import nock from 'nock';
import { expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';

it( 'validates the configured Studio CA and hostname on the selected TLS connection', async () => {
	const dir = await realpath( await mkdtemp( path.join( tmpdir(), 'studio-web-tls-' ) ) );
	const certFile = path.join( dir, 'certificates', 'studio-ca.crt' );
	let listener: Server | undefined;
	try {
		vi.stubEnv( 'DEV_CONFIG_DIR', dir );
		vi.resetModules();
		vi.doMock( '@studio/common/lib/root-ca-trust', () => ( {
			ROOT_CA_CERT_PATH: certFile,
			trustRootCA: vi.fn(),
		} ) );
		const { generateSiteCertificate } = await import( 'cli/lib/certificate-manager' );
		const credentials = await generateSiteCertificate( 'fixture.local' );
		listener = createServer( credentials, ( _req, res ) => res.end( 'verified' ) );
		listener.listen( 0, '127.0.0.1' );
		await once( listener, 'listening' );
		nock.enableNetConnect(
			( host ) => host === '127.0.0.1:' + ( listener!.address() as AddressInfo ).port
		);
		const url = new URL( 'https://fixture.local:' + ( listener.address() as AddressInfo ).port );
		const signal = new AbortController().signal;
		const request = () =>
			requestWebHop(
				url,
				{ targetOrigin: url.origin, localSiteUrls: [ url.origin ], signal },
				{ method: 'GET', purpose: 'page' },
				signal,
				async () => [ { address: '127.0.0.1', family: 4 } ]
			);
		expect( ( await request() ).body.toString() ).toBe( 'verified' );
		url.hostname = 'another.local';
		await expect( request() ).rejects.toThrow( /hostname|certificate/i );
		url.hostname = 'fixture.local';
		const secondName = path.join( dir, 'fixture-ca-copy' );
		await link( certFile, secondName );
		await expect( request() ).rejects.toThrow( /file|directory/i );
		await rm( secondName );
		await writeFile( certFile, Buffer.alloc( 64 * 1024 + 1 ) );
		await expect( request() ).rejects.toThrow( /certificate size/i );
		await writeFile( certFile, '' );
		await expect( request() ).rejects.toThrow( /certificate/i );
	} finally {
		nock.disableNetConnect();
		if ( listener ) {
			listener.closeAllConnections();
			await new Promise< void >( ( resolve ) => listener!.close( () => resolve() ) );
		}
		vi.doUnmock( '@studio/common/lib/root-ca-trust' );
		vi.unstubAllEnvs();
		await rm( dir, { recursive: true, force: true } );
	}
}, 30000 );
