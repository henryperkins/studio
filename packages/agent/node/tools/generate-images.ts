import fs from 'fs/promises';
import path from 'path';
import { Type } from 'typebox';
import {
	composeImagePrompt,
	generateImages,
	type GenerateImageResult,
	IMAGE_ASPECT_RATIOS,
	IMAGE_STYLES,
	resolveImageService,
} from '@studio/agent/node/image-generation';
import { defineTool, REMOTE_CHANGE } from './define-tool';
import { wpCliMediaLibrary } from './media-library';
import { textResult } from './utils';
import type { MediaAttachment } from '@studio/agent/node/host';

const MAX_IMAGES_PER_CALL = 20;
const UPLOADS_DIR = path.sep + path.join( 'wp-content', 'uploads' ) + path.sep;

// Exported for tests. Generated files are jailed to the sites root like the
// pi Write tool, and must be PNGs — the only format the pipeline delivers.
export function resolveImageFilePath( sitesRoot: string, filePath: string ): string {
	const resolved = path.resolve( filePath );
	if ( resolved !== sitesRoot && ! resolved.startsWith( sitesRoot + path.sep ) ) {
		throw new Error(
			`Image path must be inside the Studio sites directory (${ sitesRoot }): ${ filePath }`
		);
	}
	if ( ! /\.png$/i.test( resolved ) ) {
		throw new Error( `Image path must end in .png: ${ filePath }` );
	}
	return resolved;
}

export const generateImagesTool = defineTool(
	'generate_images',
	"Generate AI images (PNG) from text specs and write them to files inside a site. An image written under the site's wp-content/uploads/ is added to its media library; any other image, such as theme imagery in a theme's assets/images, stays where it is written. " +
		'Load the `imagery` skill FIRST — it defines how to write subjects and page context, which aspect ratio fits which layout slot, and where generated images go (theme assets or the media library). ' +
		'Batch every image a page or site needs into as few calls as possible; each call accepts up to ' +
		`${ MAX_IMAGES_PER_CALL } images and generates them concurrently. ` +
		"The call returns at once with each image's path, and for the media library its attachment ID and URL, while the images are generated in the background: the tools that render the site wait for them, and any that failed is reported with a later tool result. " +
		'Failures are reported per image: a safety-filtered image should be retried once with a rewritten subject; other failures should lead you to adapt the layout rather than leave a broken image reference.',
	{
		images: Type.Array(
			Type.Object( {
				path: Type.String( {
					description:
						"Absolute file path to write the generated PNG to. Must be inside the Studio sites directory and end in .png. Under a site's wp-content/uploads/, the image is imported into the media library: the file moves to the uploads folder WordPress picks, and the result gives that path, its attachment ID and its URL. Anywhere else, such as a theme's assets/images, the file stays at this path.",
				} ),
				subject: Type.String( {
					description:
						'What the image shows and from what point of view (composition, framing, vantage, mood). 1-3 sentences. Never ask for rendered text, and never restate the site-wide imageGrade here.',
				} ),
				pageContext: Type.Optional(
					Type.String( {
						description:
							'Where and how the image is used, in pictorial slot language (e.g. "full-frame editorial photograph with the left third kept as open, low-detail negative space"). Steers mood and composition; it is not drawn. Write in English.',
					} )
				),
				style: Type.Optional(
					Type.Enum( Object.fromEntries( IMAGE_STYLES.map( ( style ) => [ style, style ] ) ), {
						description: 'Rendering style. Defaults to photorealistic.',
					} )
				),
				aspectRatio: Type.Optional(
					Type.Enum(
						Object.fromEntries( IMAGE_ASPECT_RATIOS.map( ( ratio ) => [ ratio, ratio ] ) ),
						{
							description:
								'Canvas shape, matched to the layout slot (see the imagery skill). Defaults to landscape.',
						}
					)
				),
			} ),
			{ minItems: 1, maxItems: MAX_IMAGES_PER_CALL }
		),
		siteContext: Type.Optional(
			Type.String( {
				description:
					"One sentence of subject matter steering shared by all images (e.g. 'A neighborhood bakery selling sourdough and pastries.'). NEVER include the site or business name — a name in the prompt is what painted-in fake wordmarks stand in for.",
			} )
		),
		imageGrade: Type.Optional(
			Type.String( {
				description:
					'One site-wide photographic treatment applied to every image so they read as one series (e.g. "warm natural window light, soft muted color"). Keep it identical across calls for the same site.',
			} )
		),
	},
	async ( args, { host } ) => {
		const imageService = await resolveImageService();
		if ( ! imageService ) {
			throw new Error(
				'Image generation is not available in this session. Build the site without generated imagery.'
			);
		}

		const targets = args.images.map( ( image ) => ( {
			...image,
			resolvedPath: resolveImageFilePath( host.sitesRoot, image.path ),
		} ) );
		const libraryTargets = targets.filter( ( target ) =>
			target.resolvedPath.includes( UPLOADS_DIR )
		);
		const media = host.media ?? wpCliMediaLibrary( host );
		const site = libraryTargets.length
			? await media.siteContaining( libraryTargets.map( ( target ) => target.resolvedPath ) )
			: undefined;
		const attachments = new Map< string, MediaAttachment >();
		if ( site ) {
			const reserved = await media.reserve(
				site,
				libraryTargets.map( ( target ) => path.basename( target.resolvedPath ) )
			);
			libraryTargets.forEach( ( target, index ) =>
				attachments.set( target.resolvedPath, {
					...reserved[ index ],
					file: path.join( site.path, reserved[ index ].file ),
				} )
			);
		}

		const requests = targets.map( ( image ) => ( {
			prompt: composeImagePrompt( image, {
				siteContext: args.siteContext,
				imageGrade: args.imageGrade,
			} ),
			aspectRatio: image.aspectRatio,
		} ) );

		// A host made for one call stops the requests once that call is cancelled;
		// what was reserved is still completed or deleted below.
		const signal = host.callSignal;
		const generating = signal
			? generateImages( host.userAgent, imageService.token, requests, undefined, signal )
			: generateImages( host.userAgent, imageService.token, requests );
		const generation = generating
			.catch( ( error ): GenerateImageResult[] =>
				requests.map( () => ( { ok: false, error: String( error ) } ) )
			)
			.then( async ( results ) => {
				const failures: string[] = [];
				// A write that fails is reported, as the first to fail, only once every
				// other write has settled, so none lands after the work has ended.
				let failedWrite: { error: unknown } | undefined;
				await Promise.all(
					results.map( async ( result, index ) => {
						const target = targets[ index ];
						if ( ! result.ok || ! result.bytes ) {
							const hint = result.filtered
								? ' (safety filter — rewrite the subject to avoid the sensitive element and call generate_images again for this image)'
								: '';
							failures.push( `FAILED ${ target.path }: ${ result.error }${ hint }` );
							return;
						}
						const file = attachments.get( target.resolvedPath )?.file ?? target.resolvedPath;
						try {
							await fs.mkdir( path.dirname( file ), { recursive: true } );
							await fs.writeFile( file, result.bytes );
						} catch ( error ) {
							failedWrite ??= { error };
						}
					} )
				);
				if ( failedWrite ) throw failedWrite.error;
				if ( site ) {
					const ids = ( ok: boolean ) =>
						libraryTargets
							.filter( ( target ) => results[ targets.indexOf( target ) ].ok === ok )
							.map( ( target ) => attachments.get( target.resolvedPath )!.id );
					await media.finalize( site, ids( true ), ids( false ) );
				}
				return failures.length
					? `These images failed, and any attachment reserved for them was removed. Drop them from the markup or generate them again:\n${ failures.join(
							'\n'
					  ) }`
					: undefined;
			} );

		return {
			...textResult(
				[
					`Generating ${ targets.length } image${
						targets.length === 1 ? '' : 's'
					} in the background. Use them in the markup now:`,
					...targets.map( ( target ) => {
						const attachment = attachments.get( target.resolvedPath );
						return attachment
							? `- ${ attachment.file }, attachment ID ${ attachment.id }, URL ${ attachment.url }`
							: `- ${ target.path }`;
					} ),
				].join( '\n' )
			),
			pending: generation,
			studioService: { service: imageService.use.service, credential: imageService.use.credential },
		};
	},
	{
		promptSnippet:
			'Generate AI images (PNG) from text specs into a site: images under its wp-content/uploads/ are added to the media library, others (theme imagery) stay files. Batch all the images a page needs into one call. Load the `imagery` skill first for spec-writing rules and file placement.',
		annotations: REMOTE_CHANGE,
	}
);
