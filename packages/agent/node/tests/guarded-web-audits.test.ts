import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { validateBlocks } from '../block-validator';
import { withClaudeWebCall } from '../claude-code/web-transport';
import { auditPerformance } from '../performance-audit';
import { auditSeo } from '../seo-audit';
import { bindTool } from '../tools/define-tool';
import { inspectDesignTool } from '../tools/inspect-design';
import { createFakeHost } from './fake-host';
import type { AddressInfo } from 'node:net';

it.skipIf( ! existsSync( chromium.executablePath() ) )(
	'runs design, SEO, performance and editor reads in isolated Chromium calls on the selected origin',
	async () => {
		const requests: string[] = [];
		const script = gzipSync( '/*' + 'a'.repeat( 8192 ) + '*/' );
		const server = createServer( ( req, res ) => {
			const route = req.url ?? '/';
			requests.push( route );
			if ( route.startsWith( '/studio-auto-login?' ) ) {
				res
					.writeHead( 302, {
						Location: '/wp-admin/post-new.php',
						'Set-Cookie': 'session=fixture; Path=/wp-admin; HttpOnly',
					} )
					.end();
			} else if ( route === '/wp-admin/post-new.php' && req.headers.cookie === 'session=fixture' ) {
				res.writeHead( 200, { 'Content-Type': 'text/html' } )
					.end( `<title>Editor fixture</title><script>
				window.wp={blocks:{getBlockTypes:()=>['paragraph'],getBlockType:()=>({}),
					parse:(html)=>[{name:'core/paragraph', isValid:html.includes('selected content')}]}}</script>` );
			} else if ( route === '/weight.js' ) {
				res
					.writeHead( 200, { 'Content-Type': 'text/javascript', 'Content-Encoding': 'gzip' } )
					.end( script );
			} else if ( route === '/robots.txt' ) {
				res.writeHead( 200, { 'Content-Type': 'text/plain' } ).end( 'User-agent: *\nDisallow: /' );
			} else if ( route === '/sitemap.xml' ) {
				res.writeHead( 200, { 'Content-Type': 'text/xml' } ).end( '<urlset/>' );
			} else if ( route === '/sitemap_index.xml' ) {
				res.writeHead( 404 ).end();
			} else {
				res
					.writeHead( 200, { 'Content-Type': 'text/html' } )
					.end(
						'<title>Local fixture</title><h1>Studio design</h1><script src="/weight.js"></script>'
					);
			}
		} );
		try {
			server.listen( 0, '127.0.0.1' );
			await once( server, 'listening' );
			const url = 'http://127.0.0.1:' + ( server.address() as AddressInfo ).port;
			const scope = {
				targetOrigin: url,
				localSiteUrls: [ url ],
				signal: new AbortController().signal,
			};
			const inspect = bindTool( inspectDesignTool, createFakeHost() );
			const design = await withClaudeWebCall( scope, () =>
				inspect.rawHandler( { url, selectors: [ 'h1' ] } )
			);
			expect( design.content ).toEqual(
				expect.arrayContaining( [
					expect.objectContaining( {
						type: 'text',
						text: expect.stringContaining( 'Studio design' ),
					} ),
				] )
			);
			const seo = await withClaudeWebCall( scope, () => auditSeo( url ) );
			expect( seo.metrics?.resources ).toMatchObject( {
				robotsTxtFound: true,
				robotsTxtBlocksAll: true,
				sitemapFound: true,
			} );
			expect( requests ).toEqual(
				expect.arrayContaining( [ '/robots.txt', '/sitemap.xml', '/sitemap_index.xml' ] )
			);
			const perf = await withClaudeWebCall( scope, () => auditPerformance( url ) );
			expect( perf.metrics?.domElements ).toBeGreaterThan( 0 );
			expect( perf.metrics?.scripts ).toMatchObject( { count: 1, totalBytes: script.length } );
			expect( perf.measurementNote ).toContain( 'encoded response body' );
			expect( requests.some( ( request ) => request.startsWith( '/studio-auto-login' ) ) ).toBe(
				false
			);
			const editor = await withClaudeWebCall( scope, () =>
				validateBlocks( 'selected content', url )
			);
			expect( editor ).toMatchObject( { totalBlocks: 1, validBlocks: 1 } );
			expect( requests ).toContain( '/wp-admin/post-new.php' );
		} finally {
			server.closeAllConnections();
			await new Promise< void >( ( resolve ) => server.close( () => resolve() ) );
		}
	},
	40_000
);
