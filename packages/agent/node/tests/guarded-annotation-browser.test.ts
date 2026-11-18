import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium, type Page } from 'playwright';
import { expect, it } from 'vitest';
import { currentClaudeWebCall, runInClaudeWebCall } from '../claude-code/web-call';
import { withClaudeWebCall } from '../claude-code/web-transport';
import { annotateInBrowser } from '../inspector/inspector-inject';
import { NOTE_EDITOR_BINDING, NOTE_EDITOR_EVENT } from '../inspector/note-editor';
import type { AddressInfo } from 'node:net';

it.skipIf( ! existsSync( chromium.executablePath() ) ).each( [ 'light', 'dark' ] as const )(
	'collects a real Chromium pick and Send with draft text kept in the isolated Studio editor (%s)',
	async ( colorScheme ) => {
		const server = createServer( ( _req, res ) =>
			res.writeHead( 200, { 'Content-Type': 'text/html' } ).end( '<h1>Hello Studio</h1>' )
		);
		const pages: Page[] = [];
		const stop = new AbortController();
		try {
			server.listen( 0, '127.0.0.1' );
			await once( server, 'listening' );
			const origin = 'http://127.0.0.1:' + ( server.address() as AddressInfo ).port;
			const siteUrl = origin + '/';
			const scope = { targetOrigin: origin, signal: stop.signal, localSiteUrls: [ origin ] };
			const result = withClaudeWebCall( scope, () => {
				const call = currentClaudeWebCall()!;
				return runInClaudeWebCall(
					{
						...call,
						async newPage( settings, options ) {
							const page = await call.newPage(
								{ ...settings, colorScheme },
								{ ...options, headed: process.env.STUDIO_TEST_HEADED_BROWSER === '1' }
							);
							pages.push( page );
							return page;
						},
					},
					() => annotateInBrowser( siteUrl, 20_000 )
				);
			} );
			void result.catch( () => undefined );
			await expect.poll( () => pages.length, { timeout: 10_000 } ).toBe( 2 );
			const [ site, editor ] = pages;
			await site.locator( '#__studio-inspector-host' ).waitFor( { state: 'attached' } );
			await site.evaluate( ( name ) => {
				( window as Window & { seen?: unknown } ).seen = null;
				window.addEventListener( name, ( event ) => {
					( window as Window & { seen?: unknown } ).seen = ( event as CustomEvent ).detail;
				} );
			}, NOTE_EDITOR_EVENT );
			await site.getByRole( 'heading' ).click();
			const input = editor.getByRole( 'textbox' );
			await input.fill( 'A private note to Studio' );
			const picked = editor.waitForEvent( 'filechooser' );
			await editor.getByRole( 'button', { name: 'Attach image' } ).click();
			await (
				await picked
			).setFiles( {
				name: 'fixture.png',
				mimeType: 'image/png',
				buffer: Buffer.from(
					'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/0pgAAAAASUVORK5CYII=',
					'base64'
				),
			} );
			await editor.getByRole( 'img', { name: 'fixture.png' } ).waitFor();
			const selected = editor.locator( '.target' );
			await selected.waitFor( { state: 'visible' } );
			expect( await selected.textContent() ).toContain( siteUrl );
			expect(
				await site.evaluate( ( name ) => typeof Reflect.get( window, name ), NOTE_EDITOR_BINDING )
			).toBe( 'undefined' );
			expect( await site.evaluate( () => Reflect.get( window, 'seen' ) ) ).toBeNull();
			await editor.getByRole( 'button', { name: /Save annotation/ } ).click();
			const toolbar = editor.getByRole( 'toolbar' );
			expect(
				await toolbar.evaluate( ( element ) => getComputedStyle( element ).backgroundColor )
			).toBe( colorScheme === 'dark' ? 'rgb(47, 47, 47)' : 'rgb(255, 255, 255)' );
			await editor.getByRole( 'button', { name: 'Choose an element' } ).click();
			await editor.getByRole( 'button', { name: /Send 1 annotation/ } ).click();
			const notes = await result;
			expect( notes ).toMatchObject( [
				{
					comment: 'A private note to Studio',
					images: [ { name: 'fixture.png', mimeType: 'image/png' } ],
					url: siteUrl,
				},
			] );
			expect( pages.every( ( page ) => page.isClosed() ) ).toBe( true );
		} finally {
			stop.abort();
			server.closeAllConnections();
			await new Promise< void >( ( resolve ) => server.close( () => resolve() ) );
		}
	},
	35_000
);
