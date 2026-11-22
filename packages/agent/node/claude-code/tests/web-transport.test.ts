import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { afterEach, expect, it, vi } from 'vitest';
import { currentClaudeWebCall } from '../web-call';
import * as webHttp from '../web-http';
import { publicWebAddress } from '../web-http';
import { hasClaudeChromium, withClaudeWebCall } from '../web-transport';
import type { RequestListener, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from 'playwright';

const servers: Server[] = [];
async function fixture( handle: RequestListener, connected?: () => void ): Promise< string > {
	const server = createServer( handle );
	if ( connected ) server.on( 'connection', connected );
	servers.push( server );
	server.listen( 0, '127.0.0.1' );
	await once( server, 'listening' );
	return 'http://127.0.0.1:' + ( server.address() as AddressInfo ).port;
}
afterEach( async () => {
	vi.restoreAllMocks();
	for ( const server of servers.splice( 0 ) ) {
		server.closeAllConnections();
		await new Promise< void >( ( resolve ) => server.close( () => resolve() ) );
	}
} );
const controller = () => new AbortController();
const scope = ( targetOrigin: string | null, signal = controller().signal ) => ( {
	targetOrigin,
	localSiteUrls: targetOrigin ? [ targetOrigin ] : [],
	signal,
} );
const browserTest = it.skipIf( ! existsSync( chromium.executablePath() ) );

browserTest(
	'Chromium’s process proxy policy publishes no ICE candidates during a local-only offer',
	async () => {
		await withClaudeWebCall( scope( null ), async () => {
			const guardedPage = await currentClaudeWebCall()!.newPage();
			// Exercise the browser process policy independently of the guarded page's API restrictions.
			const context = await guardedPage.context().browser()!.newContext( { offline: true } );
			const page = await context.newPage();
			const candidates = await page.evaluate( async () => {
				const seen: string[] = [];
				let peer: RTCPeerConnection | undefined;
				try {
					peer = new RTCPeerConnection( { iceServers: [] } );
					peer.onicecandidate = ( event ) => {
						if ( event.candidate ) seen.push( event.candidate.type ?? 'candidate' );
					};
					peer.createDataChannel( 'fixture' );
					await peer.setLocalDescription( await peer.createOffer() );
					await new Promise( ( resolve ) => setTimeout( resolve, 800 ) );
				} catch ( error ) {
					// Chromium may reject creation outright when the connection allowlist disables WebRTC.
					if ( ! ( error instanceof DOMException ) ) throw error;
				} finally {
					peer?.close();
				}
				return seen;
			} );
			expect( candidates ).toEqual( [] );
			await context.close();
		} );
	},
	30000
);

browserTest.each( [ 'worker', 'service worker', 'socket', 'WebRTC', 'WebTransport' ] )(
	'refuses an unbrokered browser %s without contacting the listener',
	async ( kind ) => {
		const received: string[] = [];
		const site = await fixture( ( req, res ) => {
			received.push( req.url! );
			res.writeHead( 200, { 'Content-Type': 'text/html' } ).end( '<title>Channel fixture</title>' );
		} );
		await expect(
			withClaudeWebCall( scope( site ), async () => {
				const page = await currentClaudeWebCall()!.newPage();
				await page.goto( site );
				await page.evaluate( ( channel ) => {
					if ( channel === 'worker' ) new Worker( '/worker.js' );
					else if ( channel === 'WebRTC' ) new RTCPeerConnection( { iceServers: [] } ).close();
					else if ( channel === 'WebTransport' )
						new WebTransport( 'https://' + location.host + '/transport' ).close();
					else if ( channel === 'service worker' )
						void navigator.serviceWorker.register( '/worker.js' ).catch( () => {} );
					else new WebSocket( 'ws://' + location.host + '/socket' );
				}, kind );
				await page.waitForTimeout( 1200 );
			} )
		).rejects.toThrow( 'Studio refused' );
		expect( received ).not.toContain( '/worker.js' );
		expect( received ).not.toContain( '/socket' );
		expect( received ).not.toContain( '/transport' );
	},
	30000
);

browserTest(
	'isolates a public subframe embedded on the selected site',
	async () => {
		const received: string[] = [];
		const site = await fixture( ( req, res ) => {
			received.push( req.url! );
			res
				.writeHead( 200, { 'Content-Type': 'text/html' } )
				.end( '<iframe src="http://public.example/frame"></iframe>' );
		} );
		const realHop = webHttp.requestWebHop;
		vi.spyOn( webHttp, 'requestWebHop' ).mockImplementation( async ( ...args ) => {
			if ( args[ 0 ].hostname !== 'public.example' ) return realHop( ...args );
			return {
				status: 200,
				headers: { 'content-type': 'text/html' },
				body: Buffer.from( '<img src="' + site + '/private">' ),
			};
		} );
		await expect(
			withClaudeWebCall( scope( site ), async () => {
				const page = await currentClaudeWebCall()!.newPage();
				await page.goto( site, { waitUntil: 'networkidle' } );
			} )
		).rejects.toThrow( 'Studio refused' );
		expect( received ).not.toContain( '/private' );
	},
	30000
);

it( 'classifies only routable unicast addresses as public', () => {
	for ( const address of [
		'127.0.0.1',
		'0.0.0.0',
		'10.1.2.3',
		'100.64.1.3',
		'192.168.0.1',
		'169.254.1.1',
		'224.0.0.1',
		'::1',
		'::ffff:7f00:1',
		'fe80::1',
		'fc00::1',
		'2001:db8::1',
	] )
		expect( publicWebAddress( address ) ).toBe( false );
	for ( const address of [ '8.8.8.8', '2606:4700:4700::1111' ] )
		expect( publicWebAddress( address ) ).toBe( true );
} );

browserTest(
	'Chromium follows a checked same-site redirect and reads an allowed secondary resource',
	async () => {
		const received: string[] = [];
		expect( await hasClaudeChromium() ).toBe( true );
		const scriptBytes = gzipSync( 'document.title="checked resource"' );
		let acceptedEncoding: string | undefined;
		const site = await fixture( ( req, res ) => {
			received.push( req.url! );
			if ( req.url === '/start' ) {
				res.writeHead( 302, { Location: '/page' } ).end();
				return;
			}
			if ( req.url === '/page' ) {
				res
					.writeHead( 200, { 'Content-Type': 'text/html' } )
					.end( '<title>Studio fixture</title><script src="/read.js"></script>' );
				return;
			}
			if ( req.url === '/read.js' ) {
				acceptedEncoding = String( req.headers[ 'accept-encoding' ] );
				res
					.writeHead( 200, {
						'Content-Type': 'application/javascript',
						'Content-Encoding': 'gzip',
					} )
					.end( scriptBytes );
				return;
			}
			res.writeHead( 404 ).end();
		} );
		await withClaudeWebCall( scope( site ), async () => {
			const page = await currentClaudeWebCall()!.newPage( {}, { documentOrigin: site } );
			await page.goto( site + '/start', { waitUntil: 'load', timeout: 12000 } );
			expect( page.url() ).toBe( site + '/page' );
			expect( await page.title() ).toBe( 'checked resource' );
			const script = currentClaudeWebCall()!.networkMeasurements!().find(
				( m ) => m.url === site + '/read.js'
			);
			expect( script?.resourceType ).toBe( 'Script' );
			expect( script?.mainDocument ).toBe( false );
			expect(
				currentClaudeWebCall()!.networkMeasurements!()
					.filter( ( m ) => m.mainDocument )
					.map( ( m ) => m.url )
			).toEqual( [ site + '/start', site + '/page' ] );
			expect( script?.wireBytes ).toBe( scriptBytes.length );
			expect( script!.firstByteMs ).toBeGreaterThan( 0 );
		} );
		expect( received ).toEqual( expect.arrayContaining( [ '/start', '/page', '/read.js' ] ) );
		expect( acceptedEncoding ).toContain( 'gzip' );
	},
	30000
);

browserTest.each( [ 'redirect', 'asset' ] )(
	'isolates another origin on a real Chromium %s request',
	async ( kind ) => {
		const deniedConnection = vi.fn();
		const selectedConnection = vi.fn();
		const other = await fixture( ( _req, res ) => res.end( 'fixture' ), deniedConnection );
		const site = await fixture( ( _req, res ) => {
			if ( kind === 'redirect' ) res.writeHead( 302, { Location: other + '/fixture' } ).end();
			else
				res
					.writeHead( 200, { 'Content-Type': 'text/html' } )
					.end( '<img src="' + other + '/fixture">' );
		}, selectedConnection );
		await expect(
			withClaudeWebCall( scope( site ), async () => {
				const page = await currentClaudeWebCall()!.newPage();
				await page.goto( site, { waitUntil: 'load' } );
			} )
		).rejects.toThrow( 'Studio refused' );
		expect( selectedConnection ).toHaveBeenCalled();
		expect( deniedConnection ).not.toHaveBeenCalled();
	},
	30000
);

browserTest(
	'Stop closes Chromium and its in-flight HTTP connection',
	async () => {
		let notifyStarted!: () => void;
		let notifyClosed!: () => void;
		const started = new Promise< void >( ( resolve ) => ( notifyStarted = resolve ) );
		const closed = new Promise< void >( ( resolve ) => ( notifyClosed = resolve ) );
		const site = await fixture( ( _req, res ) => {
			notifyStarted();
			res.once( 'close', notifyClosed );
		} );
		const stop = controller();
		let page: Page | undefined;
		const run = withClaudeWebCall( scope( site, stop.signal ), async () => {
			page = await currentClaudeWebCall()!.newPage();
			await page.goto( site );
		} );
		try {
			await Promise.race( [ started, run ] );
			stop.abort( new Error( 'Stopped by test' ) );
			await expect( run ).rejects.toThrow( 'Stopped by test' );
			await closed;
			expect( page?.isClosed() ).toBe( true );
		} finally {
			stop.abort();
		}
	},
	30000
);

browserTest(
	'rolls back results when Stop arrives during browser shutdown',
	async () => {
		const stop = controller();
		const rollback = vi.fn();
		const transfer = vi.fn();
		const run = withClaudeWebCall(
			{ ...scope( null, stop.signal ), onDiscard: transfer },
			async () => {
				const call = currentClaudeWebCall()!;
				const page = await call.newPage();
				const browser = page.context().browser()!;
				const close = browser.close.bind( browser );
				vi.spyOn( browser, 'close' ).mockImplementation( async () => {
					await close();
					stop.abort( new Error( 'Stopped during shutdown' ) );
				} );
				call.onDiscard( rollback );
				return 'pending result';
			}
		);
		await expect( run ).rejects.toThrow( 'Stopped during shutdown' );
		expect( rollback ).toHaveBeenCalledOnce();
		expect( transfer ).not.toHaveBeenCalled();
	},
	30000
);

it( 'hands rollbacks to the bridge after a successful call', async () => {
	const rollback = vi.fn();
	const transfer = vi.fn();
	const result = await withClaudeWebCall( { ...scope( null ), onDiscard: transfer }, async () => {
		currentClaudeWebCall()!.onDiscard( rollback );
		return 'result';
	} );
	expect( result ).toBe( 'result' );
	expect( rollback ).not.toHaveBeenCalled();
	expect( transfer ).toHaveBeenCalledWith( rollback );
} );

it( 'checks direct SEO redirects and font destinations before connection', async () => {
	let hits = 0;
	const other = await fixture( ( _req, res ) => {
		hits++;
		res.end();
	} );
	const site = await fixture( ( _req, res ) =>
		res.writeHead( 302, { Location: other + '/fixture' } ).end()
	);
	for ( const purpose of [ 'seo', 'font-css', 'font-file' ] as const ) {
		await expect(
			withClaudeWebCall( scope( site ), () =>
				currentClaudeWebCall()!.get(
					purpose === 'seo' ? site + '/robots.txt' : other + '/fixture',
					{ purpose }
				)
			)
		).rejects.toThrow( 'Studio refused' );
	}
	expect( hits ).toBe( 0 );
} );

it( 'returns an ordinary missing resource but latches an interrupted or upgraded connection', async () => {
	let mode = 'missing';
	const site = await fixture( ( _req, res ) => {
		if ( mode === 'missing' ) res.writeHead( 404 ).end();
		else if ( mode === 'upgrade' )
			res.writeHead( 101, { Connection: 'Upgrade', Upgrade: 'fixture' } ).end();
		else res.destroy();
	} );
	const read = () =>
		withClaudeWebCall( scope( site ), async () => {
			const reply = await currentClaudeWebCall()!
				.get( site + '/robots.txt', { purpose: 'seo' } )
				.catch( () => undefined );
			return reply?.status;
		} );
	expect( await read() ).toBe( 404 );
	for ( mode of [ 'interrupt', 'upgrade' ] )
		await expect( read() ).rejects.toThrow( 'Studio refused' );
} );

it( 'reads a compressed audit resource within its decoded size limit', async () => {
	let body = Buffer.from( 'User-agent: *' );
	const site = await fixture( ( _request, response ) => {
		response
			.writeHead( 200, { 'Content-Encoding': 'gzip', 'Content-Type': 'text/plain' } )
			.end( gzipSync( body ) );
	} );
	const read = () =>
		withClaudeWebCall( scope( site ), () =>
			currentClaudeWebCall()!.get( site + '/robots.txt', { purpose: 'seo' } )
		);
	expect( await ( await read() ).text() ).toBe( 'User-agent: *' );
	body = Buffer.alloc( 2 * 1024 * 1024 + 1 );
	await expect( read() ).rejects.toThrow( 'size limit' );
} );

browserTest.each( [ 'resource', 'frame' ] )(
	'prevents a public document from contacting the selected site (%s)',
	async ( kind ) => {
		let hits = 0;
		const site = await fixture( ( _req, res ) => {
			hits++;
			res.end();
		} );
		const realHop = webHttp.requestWebHop;
		// Supply the external document offline. Chromium executes its markup; the selected site's listener is real.
		vi.spyOn( webHttp, 'requestWebHop' ).mockImplementation( async ( ...args ) => {
			const [ url ] = args;
			if ( url.hostname !== 'public.example' ) return realHop( ...args );
			const html =
				kind === 'frame' && url.pathname === '/'
					? '<iframe src="/article"></iframe>'
					: '<img src="' + site + '/private">';
			return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from( html ) };
		} );
		await expect(
			withClaudeWebCall( scope( site ), async () => {
				const page = await currentClaudeWebCall()!.newPage();
				await page.goto( 'http://public.example', { waitUntil: 'networkidle' } );
			} )
		).rejects.toThrow( 'public document' );
		expect( hits ).toBe( 0 );
	},
	30000
);

it( 'uses the checked address for the connection and preserves the original Host header', async () => {
	let actualHost = '';
	const site = new URL(
		await fixture( ( req, res ) => {
			actualHost = req.headers.host ?? '';
			res.end( 'fixture' );
		} )
	);
	site.hostname = 'selected.example';
	const resolver = vi.fn( async () => [ { address: '127.0.0.1', family: 4 } ] );
	const reply = await webHttp.requestWebHop(
		site,
		scope( site.origin ),
		{ purpose: 'page', method: 'GET' },
		controller().signal,
		resolver
	);
	expect( reply.body.toString() ).toBe( 'fixture' );
	expect( actualHost ).toBe( site.host );
	expect( resolver ).toHaveBeenCalledTimes( 1 );
	await expect(
		webHttp.requestWebHop(
			site,
			scope( site.origin ),
			{ purpose: 'page', method: 'GET' },
			controller().signal,
			async () => [
				{ address: '127.0.0.1', family: 4 },
				{ address: '8.8.8.8', family: 4 },
			]
		)
	).rejects.toThrow( 'exclusively to loopback' );
	await expect(
		webHttp.requestWebHop(
			site,
			scope( null ),
			{ purpose: 'page', method: 'GET' },
			controller().signal,
			async () => [
				{ address: '8.8.8.8', family: 4 },
				{ address: '127.0.0.1', family: 4 },
			]
		)
	).rejects.toThrow( 'public address' );
} );

browserTest(
	'keeps editor login cookies on site and refuses public requests from the signed-in page',
	async () => {
		const cookies: string[] = [];
		let external = false;
		const site = await fixture( ( req, res ) => {
			if ( req.url?.startsWith( '/studio-auto-login' ) ) {
				res
					.writeHead( 302, {
						Location: '/wp-admin/edit.php',
						'Set-Cookie': 'test_editor=fixture; Path=/; HttpOnly',
					} )
					.end();
				return;
			}
			cookies.push( req.headers.cookie ?? '' );
			res
				.writeHead( 200, { 'Content-Type': 'text/html' } )
				.end(
					'<title>editor</title>' + ( external ? '<img src="http://public.example/pixel">' : '' )
				);
		} );
		const realHop = webHttp.requestWebHop;
		let publicHeaders: unknown;
		vi.spyOn( webHttp, 'requestWebHop' ).mockImplementation( async ( ...args ) => {
			if ( args[ 0 ].hostname !== 'public.example' ) return realHop( ...args );
			publicHeaders = args[ 2 ].headers;
			return { status: 200, headers: {}, body: Buffer.from( '' ) };
		} );
		const login = site + '/studio-auto-login?redirect_to=/wp-admin/edit.php';
		await withClaudeWebCall( scope( site ), async () => {
			const page = await currentClaudeWebCall()!.newPage(
				{},
				{ documentOrigin: site, allowAutoLogin: true }
			);
			await page.goto( login );
			expect( page.url() ).toBe( site + '/wp-admin/edit.php' );
		} );
		expect( cookies ).toContain( 'test_editor=fixture' );
		external = true;
		await expect(
			withClaudeWebCall( scope( site ), async () => {
				const page = await currentClaudeWebCall()!.newPage(
					{},
					{ documentOrigin: site, allowAutoLogin: true }
				);
				await page.goto( login );
			} )
		).rejects.toThrow( 'authenticated browsing' );
		expect( publicHeaders ).toBeUndefined();
		await expect(
			withClaudeWebCall( scope( site ), async () => {
				const page = await currentClaudeWebCall()!.newPage();
				await page.goto( login );
			} )
		).rejects.toThrow( 'automatic sign-in' );
	},
	30000
);

browserTest(
	'refuses a local file document in the guarded browser',
	async () => {
		const dir = await mkdtemp( path.join( tmpdir(), 'studio-browser-file-' ) );
		try {
			const file = path.join( dir, 'fixture.html' );
			await writeFile( file, '<title>local fixture</title>' );
			await expect(
				withClaudeWebCall( scope( null ), async () => {
					const page = await currentClaudeWebCall()!.newPage();
					await page.goto( pathToFileURL( file ).href );
				} )
			).rejects.toThrow();
		} finally {
			await rm( dir, { recursive: true, force: true } );
		}
	},
	30000
);

browserTest(
	'refuses an attachment response before rendering or saving it',
	async () => {
		const site = await fixture( ( _req, res ) =>
			res
				.writeHead( 200, {
					'Content-Type': 'text/html',
					'Content-Disposition': 'attachment; filename="fixture.html"',
				} )
				.end( '<title>attachment</title>' )
		);
		await expect(
			withClaudeWebCall( scope( site ), async () => {
				const page = await currentClaudeWebCall()!.newPage();
				await page.goto( site );
			} )
		).rejects.toThrow( 'cannot download' );
	},
	30000
);
