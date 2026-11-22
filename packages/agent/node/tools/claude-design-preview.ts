import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfigDirectory } from '@studio/common/lib/well-known-paths';
import { openBrowserToolFile } from '../claude-code/browser-tool-files';
import { DESIGN_PREVIEW_URL } from '../claude-code/design-preview-resource';
import { isAllowedNativePath, isJudgeable } from '../claude-code/local-paths';
import type { ClaudeWebCall } from '../claude-code/web-call';

export class DesignPreviewInputError extends Error {}

const rasterReference = /\b(src\s*=\s*|url\(\s*)(?:(["'])([^"'<>]+?)\2|([^\s"'<>)]*))/gi;

function rasterMime( file: string, bytes: Buffer ) {
	const extension = path.extname( file ).toLowerCase();
	if (
		extension === '.png' &&
		bytes.subarray( 0, 8 ).equals( Buffer.from( '89504e470d0a1a0a', 'hex' ) )
	)
		return 'image/png';
	if (
		[ '.jpg', '.jpeg' ].includes( extension ) &&
		bytes[ 0 ] === 255 &&
		bytes[ 1 ] === 216 &&
		bytes[ 2 ] === 255
	)
		return 'image/jpeg';
	if (
		extension === '.webp' &&
		bytes.toString( 'ascii', 0, 4 ) === 'RIFF' &&
		bytes.toString( 'ascii', 8, 12 ) === 'WEBP'
	)
		return 'image/webp';
	throw new DesignPreviewInputError(
		'A design preview image must contain a PNG, JPEG or WebP matching its extension.'
	);
}

async function prepareDesignPreview( html: string, call: ClaudeWebCall, directory: string ) {
	if ( Buffer.byteLength( html ) > 256 * 1024 )
		throw new DesignPreviewInputError( 'The design preview is too large.' );
	const urls = new Map< string, string >();
	const images = new Map< string, { mime: string; bytes: Buffer } >();
	let total = 0;
	for ( const match of html.matchAll( rasterReference ) ) {
		const reference: string = match[ 3 ] ?? match[ 4 ];
		if ( urls.has( reference ) || ! /^(?:file:\/\/|[a-z]:[\\/]|\/)/i.test( reference ) ) continue;
		call.check();
		const decoded = reference
			.replace( /&(?:amp|#38);/g, '&' )
			.replace( /&#(34|39|60|62);/g, ( _, code: string ) => String.fromCharCode( Number( code ) ) );
		const file = decoded.startsWith( 'file://' ) ? fileURLToPath( decoded ) : decoded;
		if (
			! isJudgeable( file ) ||
			/^[\\/]{2}/.test( file ) ||
			! /\.(?:png|jpe?g|webp)$/i.test( file )
		)
			throw new DesignPreviewInputError(
				'A design preview image must be a local PNG, JPEG or WebP.'
			);
		const sidecar = path.relative( directory, path.dirname( file ) ) === '';
		if (
			! sidecar &&
			( ! call.sitePath ||
				! ( await isAllowedNativePath( file, [ call.sitePath ], getConfigDirectory() ) ) )
		)
			throw new DesignPreviewInputError(
				'A design preview image must belong to the selected site or this conversation.'
			);
		const root = sidecar ? directory : call.sitePath!;
		if ( images.size >= 12 )
			throw new DesignPreviewInputError( 'The design preview has too many images.' );
		const opened = await openBrowserToolFile( root, file ).catch( () => {
			throw new DesignPreviewInputError(
				'The image changed or is not a regular file in the permitted directory.'
			);
		} );
		await using handle = opened.handle;
		const size = Number( opened.info.size );
		total += size;
		if ( size > 8 * 1024 * 1024 || total > 24 * 1024 * 1024 )
			throw new DesignPreviewInputError( 'The design preview images exceed the size limit.' );
		const bytes = Buffer.alloc( size + 1 );
		const { bytesRead } = await handle.read( bytes, 0, bytes.length, 0 );
		if ( bytesRead !== size )
			throw new DesignPreviewInputError( 'The design preview image changed while reading.' );
		call.check();
		const url = DESIGN_PREVIEW_URL + 'images/' + images.size;
		images.set( url, { mime: rasterMime( file, bytes ), bytes: bytes.subarray( 0, size ) } );
		urls.set( reference, url );
	}
	return {
		images,
		html: html.replace(
			rasterReference,
			( match: string, prefix: string, quote: string, quoted: string, unquoted: string ) => {
				const url = urls.get( quoted ?? unquoted );
				return url ? prefix + ( quote ?? '' ) + url + ( quote ?? '' ) : match;
			}
		),
	};
}

export async function captureClaudeDesignPreview(
	call: ClaudeWebCall,
	html: string,
	directory: string,
	viewport: { width: number; height: number }
) {
	const preview = await prepareDesignPreview( html, call, directory );
	call.check();
	const page = await call.newPage( { viewport }, { designPreview: preview } );
	try {
		await page.emulateMedia( { reducedMotion: 'reduce' } );
		await page.goto( DESIGN_PREVIEW_URL, { waitUntil: 'load', timeout: 15000 } );
		if ( preview.images.size ) {
			const valid = await page.evaluate(
				async ( urls ) => {
					for ( const url of urls ) {
						const image = new Image();
						image.src = url;
						try {
							await image.decode();
						} catch {
							return false;
						}
						if (
							! image.naturalWidth ||
							image.naturalWidth * image.naturalHeight > 32 * 1024 * 1024
						)
							return false;
					}
					return true;
				},
				[ ...preview.images.keys() ]
			);
			if ( ! valid )
				throw new DesignPreviewInputError(
					'Choose a decodable raster image no larger than 32 megapixels.'
				);
		}
		const contentHeight = await page.evaluate( async () => {
			await document.fonts.ready;
			return Math.ceil(
				Array.from( document.body.querySelectorAll( '*' ) ).reduce( ( bottom, element ) => {
					const rect = element.getBoundingClientRect();
					return rect.width > 0 && rect.height > 0
						? Math.max( bottom, rect.bottom + window.scrollY )
						: bottom;
				}, 0 )
			);
		} );
		call.check();
		return {
			buffer: await page.screenshot( { type: 'png', animations: 'disabled' } ),
			contentHeight,
		};
	} finally {
		await page.close();
	}
}
