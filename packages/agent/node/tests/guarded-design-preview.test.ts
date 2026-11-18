import { existsSync } from 'node:fs';
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDesignPreviewResponder } from '../claude-code/design-preview-resource';
import { currentClaudeWebCall, runInClaudeWebCall } from '../claude-code/web-call';
import { withClaudeWebCall } from '../claude-code/web-transport';
import { bindTool } from '../tools/define-tool';
import { createPresentDesignOptionsTool } from '../tools/present-design-options';
import { createFakeHost } from './fake-host';

let root: string;
let site: string;
let sidecar: string;
const stop = () => new AbortController();
const png = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/0pgAAAAASUVORK5CYII=',
	'base64'
);
beforeEach( async () => {
	root = await realpath( await mkdtemp( path.join( tmpdir(), 'studio-claude-design-' ) ) );
	site = path.join( root, 'site' );
	sidecar = path.join( root, 'conversation.screenshots' );
	await Promise.all( [ mkdir( site ), mkdir( sidecar ) ] );
} );
afterEach( async () => {
	await rm( root, { recursive: true, force: true } );
} );

const question = 'Which look should I build?';
const options = [
	{
		label: 'Broadsheet',
		description: 'Warm paper and serif headlines.',
		preview:
			'<style>*{margin:0}main{box-sizing:border-box;padding:80px;height:100vh;background:#f8efda;color:#342117;font:72px Georgia}</style><main>Studio Journal</main>',
	},
	{
		label: 'Midnight',
		description: 'An ink blue layout with oversized type.',
		preview:
			'<style>*{margin:0}main{box-sizing:border-box;padding:80px;height:100vh;background:#15253a;color:#ecf8f4;font:80px system-ui}</style><main>Studio Journal</main>',
	},
];
type Ask = NonNullable<
	NonNullable< Parameters< typeof createPresentDesignOptionsTool >[ 0 ] >[ 'onAskUser' ]
>;

function present(
	choices: typeof options,
	onAskUser: Ask,
	controller = stop(),
	inspect?: ( page: Page ) => void
) {
	const host = { ...createFakeHost(), screenshotsDirectory: async () => sidecar };
	const scope = {
		targetOrigin: null,
		signal: controller.signal,
		sitePath: site,
		localSiteUrls: [],
	};
	return withClaudeWebCall( scope, () => {
		const call = currentClaudeWebCall()!;
		return runInClaudeWebCall(
			{
				...call,
				async newPage( settings, pageOptions ) {
					const page = await call.newPage( settings, pageOptions );
					inspect?.( page );
					return page;
				},
			},
			() =>
				bindTool( createPresentDesignOptionsTool( { onAskUser } ), host ).rawHandler( {
					catalog: 'layouts',
					question,
					options: choices,
				} )
		);
	} );
}

it.skipIf( ! existsSync( chromium.executablePath() ) )(
	'shows the ordered 1200x900 PNGs, blocks scripts and cross-origin images, and returns just the answer',
	async () => {
		const image = path.join( site, 'cover image.png' );
		await writeFile( image, png );
		const requests: string[] = [];
		let loaded = false;
		const choices = options.map( ( option, i ) => ( {
			...option,
			preview:
				option.preview +
				( i === 0
					? '<script>document.title="unexpected"</script><img id="local" src="' +
					  pathToFileURL( image ).href +
					  '"><img src="https://outside.invalid/pixel.png">'
					: '' ),
		} ) );
		const answer = await present(
			choices,
			async ( questions, publish ) => {
				publish?.();
				const picks = questions[ 0 ].options!;
				expect( picks.map( ( pick ) => pick.label ) ).toEqual( [
					'Broadsheet',
					'Midnight',
					'Show other options',
				] );
				for ( const option of picks.slice( 0, 2 ) ) {
					const bytes = await readFile( option.image! );
					expect( [ bytes.readUInt32BE( 16 ), bytes.readUInt32BE( 20 ) ] ).toEqual( [ 1200, 900 ] );
				}
				return { [ question ]: 'Midnight' };
			},
			stop(),
			( page ) => {
				page.on( 'response', ( response ) => requests.push( response.url() ) );
				page.on( 'load', async () => {
					if ( await page.locator( '#local' ).count() ) {
						loaded = await page.evaluate(
							() =>
								document.title === '' &&
								( document.querySelector( '#local' ) as HTMLImageElement ).naturalWidth === 1
						);
					}
				} );
			}
		);
		expect( answer.content ).toEqual( [
			{ type: 'text', text: 'The user picked option 2: Midnight' },
		] );
		expect( loaded ).toBe( true );
		expect( requests.some( ( url ) => url.includes( 'outside.invalid' ) ) ).toBe( false );
		expect( await readdir( sidecar ) ).toHaveLength( 2 );
	},
	30000
);

it.skipIf( ! existsSync( chromium.executablePath() ) ).each( [ false, true ] )(
	'Stop keeps exactly the previews that the host published (published = %s)',
	async ( published ) => {
		const controller = stop();
		await expect(
			present(
				options,
				async ( _, publish ) => {
					if ( published ) publish?.();
					controller.abort( new Error( 'Stopped' ) );
					throw controller.signal.reason;
				},
				controller
			)
		).rejects.toThrow( 'Stopped' );
		expect( await readdir( sidecar ) ).toHaveLength( published ? 2 : 0 );
	},
	30000
);

it.skipIf( ! existsSync( chromium.executablePath() ) )(
	'discards earlier PNGs if a later preview fails the frame check',
	async () => {
		const ask = vi.fn();
		await expect(
			present( [ options[ 0 ], { ...options[ 1 ], preview: '<p>Too short</p>' } ], ask )
		).rejects.toThrow( 'leaving the bottom empty' );
		expect( ask ).not.toHaveBeenCalled();
		expect( await readdir( sidecar ) ).toEqual( [] );
	},
	30000
);

it.skipIf( ! existsSync( chromium.executablePath() ) )(
	'renders a DESIGN.md board with a conversation image and accepts a request to redraw',
	async () => {
		const image = path.join( sidecar, 'saved & private.png' );
		await writeFile( image, png );
		const markdown =
			'---\nname: Studio Journal\ndescription: An independent journal\ncolors:\n  primary: "#098d9e"\n  background: "#fff"\n  text: "#111"\ntypography:\n  body: {fontFamily: system-ui, fontSize: 16px}\n---\n## Overview\nA restrained journal.';
		const choices = options.map( ( entry ) => ( { ...entry, preview: markdown, image } ) );
		const result = await present( choices, async ( _, publish ) => {
			publish?.();
			return { [ question ]: 'Show other options' };
		} );
		expect( result.content ).toEqual( [
			{ type: 'text', text: 'The user answered: Show other options' },
		] );
		expect( await readdir( sidecar ) ).toHaveLength( 3 );
	},
	30000
);

it.skipIf( ! existsSync( chromium.executablePath() ) )(
	'Stop during the second render closes Chromium and removes the first unpublished PNG',
	async () => {
		const controller = stop();
		const pages: Page[] = [];
		const ask = vi.fn();
		await expect(
			present( options, ask, controller, ( page ) => {
				pages.push( page );
				if ( pages.length === 2 ) controller.abort( new Error( 'Stopped' ) );
			} )
		).rejects.toThrow( 'Stopped' );
		expect( ask ).not.toHaveBeenCalled();
		expect( pages.every( ( page ) => page.isClosed() ) ).toBe( true );
		expect( await readdir( sidecar ) ).toEqual( [] );
	},
	30000
);

it( 'refuses foreign files, linked files, oversized images, and mismatched raster formats before opening the preview', async () => {
	const outside = path.join( root, 'foreign.png' );
	await writeFile( outside, png );
	const linked = path.join( site, 'linked.png' );
	await link( outside, linked );
	const bad = path.join( site, 'bad.jpg' );
	await writeFile( bad, png );
	const large = path.join( site, 'large.png' );
	await writeFile( large, Buffer.alloc( 8 * 1024 * 1024 + 1 ) );
	for ( const [ file, expected ] of [
		[ outside, 'must belong' ],
		[ linked, 'changed' ],
		[ large, 'size limit' ],
		[ bad, 'matching its extension' ],
	] ) {
		const choices = [
			{ ...options[ 0 ], preview: '<img src="' + pathToFileURL( file ).href + '">' },
			options[ 1 ],
		];
		await expect( present( choices, vi.fn() ) ).rejects.toThrow( expected );
	}
} );

it( 'brokers only the font files referenced by an allowed Google Fonts stylesheet, with a fallback when offline', async () => {
	const asset = 'https://fonts.gstatic.com/s/test/font.woff2';
	const css = 'https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap';
	const get = vi
		.fn()
		.mockResolvedValueOnce(
			new Response( '@font-face{src:url(' + asset + ')}', {
				headers: { 'Content-Type': 'text/css' },
			} )
		)
		.mockResolvedValueOnce( new Response( 'wOF2data' ) )
		.mockRejectedValue( new Error( 'offline' ) );
	const respond = createDesignPreviewResponder(
		{ html: '', images: new Map() },
		get,
		stop().signal
	);
	await expect( respond( asset, 'Font', true ) ).rejects.toThrow( 'Google Fonts' );
	await respond( css, 'Stylesheet', true );
	expect( ( await respond( asset, 'Font', true ) ).body ).toBe(
		Buffer.from( 'wOF2data' ).toString( 'base64' )
	);
	expect( ( await respond( css, 'Stylesheet', true ) ).body ).toBe( '' );
	await expect( respond( css + '&text=private', 'Stylesheet', true ) ).rejects.toThrow(
		'Google Fonts'
	);
} );
