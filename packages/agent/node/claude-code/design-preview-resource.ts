import { WebRefusal } from './web-http';
import type { ClaudeWebPageOptions } from './web-call';

export const DESIGN_PREVIEW_URL = 'https://studio-design-preview.invalid/';
const policy = [
	"default-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
	'img-src https://studio-design-preview.invalid',
	"style-src 'unsafe-inline' https://fonts.googleapis.com/css2",
	'font-src https://fonts.gstatic.com',
	'sandbox',
].join( '; ' );

function isFontStylesheet( url: URL ) {
	const families = url.searchParams.getAll( 'family' );
	return (
		url.origin === 'https://fonts.googleapis.com' &&
		url.pathname === '/css2' &&
		! url.username &&
		! url.password &&
		! url.hash &&
		families.length > 0 &&
		families.length <= 8 &&
		families.every( ( family ) =>
			/^[a-z0-9 ][a-z0-9 .-]{0,64}(?::[a-z,]{1,24}@[0-9,.;-]{1,100})?$/i.test( family )
		) &&
		[ ...url.searchParams.keys() ].every( ( key ) => key === 'family' || key === 'display' ) &&
		[ 'auto', 'block', 'swap', 'fallback', 'optional' ].includes(
			url.searchParams.get( 'display' ) ?? 'auto'
		)
	);
}

// Only this call's in-memory document and rasters have this origin. Font bytes are
// brokered without site cookies. A missing font leaves the layout's fallback stack in use.
export function createDesignPreviewResponder(
	preview: NonNullable< ClaudeWebPageOptions[ 'designPreview' ] >,
	getFont: ( url: string, purpose: 'font-css' | 'font-file' ) => Promise< Response >,
	signal: AbortSignal
) {
	const fontAssets = new Set< string >();
	let fontRequests = 0;
	const resource = ( body: Buffer, mime: string, headers: Record< string, string > = {} ) => ( {
		responseCode: 200,
		responseHeaders: Object.entries( {
			'Content-Type': mime,
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
			...headers,
		} ).map( ( [ name, value ] ) => ( { name, value } ) ),
		body: body.toString( 'base64' ),
	} );
	return async ( href: string, type: string, mainFrame: boolean ) => {
		if ( mainFrame && type === 'Document' && href === DESIGN_PREVIEW_URL ) {
			return resource( Buffer.from( preview.html ), 'text/html; charset=utf-8', {
				'Content-Security-Policy': policy,
				'Referrer-Policy': 'no-referrer',
			} );
		}
		// Chromium requests a favicon for top-level documents, even offline.
		if ( href === DESIGN_PREVIEW_URL + 'favicon.ico' && type !== 'Document' )
			return { responseCode: 204, responseHeaders: [], body: '' };
		const image = preview.images.get( href );
		if ( image && type === 'Image' ) return resource( image.bytes, image.mime );
		const sheet = type === 'Stylesheet' && isFontStylesheet( new URL( href ) );
		const asset = type === 'Font' && fontAssets.has( href );
		if ( ! sheet && ! asset )
			throw new WebRefusal( 'design previews can only load their own images and Google Fonts' );
		const mime = sheet ? 'text/css' : 'font/woff2';
		let data = Buffer.alloc( 0 );
		if ( ++fontRequests <= 24 ) {
			try {
				const response = await getFont( href, sheet ? 'font-css' : 'font-file' );
				if ( response.ok ) {
					if ( sheet && /^text\/css\b/i.test( response.headers.get( 'Content-Type' ) ?? '' ) ) {
						const css = await response.text();
						for ( const match of css.matchAll(
							/url\(\s*['"]?(https:\/\/fonts\.gstatic\.com\/s\/[a-z0-9/._-]+)['"]?\s*\)/gi
						) ) {
							fontAssets.add( match[ 1 ] );
						}
						data = Buffer.from( css );
					} else if ( asset ) {
						const bytes = Buffer.from( await response.arrayBuffer() );
						if ( bytes.toString( 'ascii', 0, 4 ) === 'wOF2' ) data = bytes;
					}
				}
			} catch {
				signal.throwIfAborted();
			}
		}
		return resource( data, mime, { 'Access-Control-Allow-Origin': '*' } );
	};
}
