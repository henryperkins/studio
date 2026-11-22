import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** A theme.json `fontFace` entry. */
export interface ThemeFontFace {
	fontFamily: string;
	fontStyle: string;
	fontWeight: string;
	src: string[];
	unicodeRange?: string;
}

interface StylesheetFace {
	family: string;
	style: string;
	weights: number[];
	url: string;
	unicodeRange?: string;
	subset?: string;
}

interface GuardedFontDownload {
	get(
		url: string,
		options: { purpose: 'font-css' | 'font-file'; userAgent?: string }
	): Promise< Response >;
	files: Map< string, Buffer >;
}

// Google Fonts only serves woff2 files split into unicode-range subsets to
// browsers it recognizes; other clients get one full TrueType file per weight.
const BROWSER_USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const slugify = ( name: string ) =>
	name
		.toLowerCase()
		.replace( /[^a-z0-9]+/g, '-' )
		.replace( /^-+|-+$/g, '' );

async function fetchOk( url: string, init?: RequestInit ): Promise< Response > {
	const response = await fetch( url, init );
	if ( ! response.ok ) {
		throw new Error( `${ url } responded with HTTP ${ response.status }` );
	}
	return response;
}

/**
 * Reads the @font-face rules of a Google Fonts stylesheet. Weights that share a
 * file — a variable font — come back as one face.
 */
function parseFontFaces( css: string ): StylesheetFace[] {
	const faces = new Map< string, StylesheetFace >();
	for ( const [ , subset, body ] of css.matchAll(
		/(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g
	) ) {
		const read = ( property: string ) =>
			body.match( new RegExp( `${ property }:\\s*([^;]+);` ) )?.[ 1 ].trim();
		const url = body.match( /url\(\s*['"]?([^'")]+)['"]?\s*\)/ )?.[ 1 ];
		const family = read( 'font-family' )?.replace( /^['"]|['"]$/g, '' );
		if ( ! url || ! family ) {
			continue;
		}
		const style = read( 'font-style' ) ?? 'normal';
		const weight = Number( read( 'font-weight' ) ?? 400 );
		const face = faces.get( `${ url } ${ style }` );
		if ( face ) {
			face.weights.push( weight );
		} else {
			faces.set( `${ url } ${ style }`, {
				family,
				style,
				weights: [ weight ],
				url,
				unicodeRange: read( 'unicode-range' ),
				subset,
			} );
		}
	}
	return [ ...faces.values() ];
}

/**
 * Downloads the font files behind a Google Fonts stylesheet URL into the theme's
 * assets/fonts directory and returns the theme.json `fontFace` entries, keyed by
 * family name, pointing at them.
 */
export async function downloadThemeFonts(
	stylesheetUrl: string,
	themeDir: string,
	guard?: GuardedFontDownload
): Promise< Record< string, ThemeFontFace[] > > {
	const response = guard
		? await guard.get( stylesheetUrl, { purpose: 'font-css', userAgent: BROWSER_USER_AGENT } )
		: await fetchOk( stylesheetUrl, {
				headers: { 'User-Agent': BROWSER_USER_AGENT },
		  } );
	if ( ! response.ok ) throw new Error( 'The font stylesheet is unavailable.' );
	const faces = parseFontFaces( await response.text() ).map( ( face ) => {
		const min = Math.min( ...face.weights );
		const max = Math.max( ...face.weights );
		const familySlug = slugify( face.family );
		if (
			guard &&
			( ! familySlug ||
				/^(?:con|prn|aux|nul|(?:com|lpt)[1-9])$/i.test( familySlug ) ||
				! /^(normal|italic|oblique)$/.test( face.style ) ||
				face.weights.some(
					( weight ) => ! Number.isInteger( weight ) || weight < 1 || weight > 1000
				) )
		) {
			throw new Error( 'The font stylesheet contains an unsupported face.' );
		}
		const fileName = [
			familySlug,
			min === max ? min : `${ min }-${ max }`,
			face.style === 'normal' ? undefined : face.style,
			face.subset,
		]
			.filter( Boolean )
			.join( '-' );
		return {
			...face,
			fontWeight: min === max ? String( min ) : `${ min } ${ max }`,
			file: path.posix.join( 'assets', 'fonts', familySlug, `${ fileName }.woff2` ),
		};
	} );
	if ( ! faces.length ) {
		throw new Error( `${ stylesheetUrl } declares no font files` );
	}

	if ( guard ) {
		if (
			faces.length > 96 ||
			new Set( faces.map( ( face ) => face.file.toLowerCase() ) ).size !== faces.length
		) {
			throw new Error( 'The font stylesheet exceeds its supported file set.' );
		}
		let bytes = 0;
		for ( const face of faces ) {
			const font = await guard.get( face.url, { purpose: 'font-file' } );
			if ( ! font.ok ) throw new Error( 'A font file is unavailable.' );
			const data = Buffer.from( await font.arrayBuffer() );
			bytes += data.byteLength;
			if (
				data.length < 48 ||
				data.toString( 'ascii', 0, 4 ) !== 'wOF2' ||
				data.readUInt32BE( 8 ) !== data.length ||
				bytes > 32 * 1024 * 1024
			) {
				throw new Error( 'The downloaded font data is unsupported.' );
			}
			guard.files.set( face.file, data );
		}
	} else
		await Promise.all(
			faces.map( async ( face ) => {
				const data = Buffer.from( await ( await fetchOk( face.url ) ).arrayBuffer() );
				await mkdir( path.join( themeDir, path.dirname( face.file ) ), { recursive: true } );
				await writeFile( path.join( themeDir, face.file ), data );
			} )
		);

	const fonts: Record< string, ThemeFontFace[] > = Object.create( null );
	for ( const face of faces ) {
		( fonts[ face.family ] ??= [] ).push( {
			fontFamily: face.family,
			fontStyle: face.style,
			fontWeight: face.fontWeight,
			src: [ `file:./${ face.file }` ],
			...( face.unicodeRange && { unicodeRange: face.unicodeRange } ),
		} );
	}
	return fonts;
}
