import path from 'path';
import { runWpCli } from './utils';
import type {
	HostSite,
	MediaAttachment,
	StudioAgentHost,
	StudioAgentMediaLibrary,
} from '@studio/agent/node/host';

// Media-library images get their attachment before they are generated, so the
// result can give their IDs and URLs right away.
const RESERVE_ATTACHMENTS = `$upload = wp_upload_dir();
$reserved = array();
foreach ( $data as $name ) {
	$filename = wp_unique_filename( $upload['path'], $name );
	$id = wp_insert_attachment( array( 'guid' => $upload['url'] . '/' . $filename, 'post_mime_type' => 'image/png', 'post_title' => pathinfo( $filename, PATHINFO_FILENAME ), 'post_content' => '', 'post_status' => 'inherit' ), $upload['path'] . '/' . $filename );
	$reserved[] = array( 'id' => $id, 'file' => substr( $upload['path'], strlen( ABSPATH ) ) . '/' . $filename, 'url' => wp_get_attachment_url( $id ) );
}
echo wp_json_encode( $reserved );`;

const FINALIZE_ATTACHMENTS = `require_once ABSPATH . 'wp-admin/includes/image.php';
foreach ( $data['ready'] as $id ) {
	wp_update_attachment_metadata( $id, wp_generate_attachment_metadata( $id, get_attached_file( $id ) ) );
}
foreach ( $data['failed'] as $id ) {
	wp_delete_attachment( $id, true );
}`;

// The WP-CLI arguments that run `php` with `data` decoded into `$data`: the
// code is Studio's own, and the data reaches it only as base64-encoded JSON.
function evalWithData( php: string, data: unknown ): string[] {
	const encoded = Buffer.from( JSON.stringify( data ) ).toString( 'base64' );
	return [ 'eval', `$data = json_decode( base64_decode( '${ encoded }' ), true );\n${ php }` ];
}

/** The WP-CLI arguments that reserve an attachment for each file name. */
export function reserveAttachmentsArgs( names: string[] ): string[] {
	return evalWithData( RESERVE_ATTACHMENTS, names );
}

/**
 * The WP-CLI arguments that complete the attachments whose images were
 * written and delete the others.
 */
export function finalizeAttachmentsArgs( ready: number[], failed: number[] ): string[] {
	return evalWithData( FINALIZE_ATTACHMENTS, { ready, failed } );
}

/** The attachments a reservation's output lists, in the order of its names. */
export function readReservedAttachments( output: string ): MediaAttachment[] {
	return JSON.parse( output.trim().split( '\n' ).pop() ?? '[]' );
}

/**
 * The media library as any host runs it: WP-CLI `eval` commands through
 * `sites.wpCli`, on the site among every site the host lists whose folder
 * holds the files.
 */
export function wpCliMediaLibrary( host: StudioAgentHost ): StudioAgentMediaLibrary {
	return {
		siteContaining: async ( files ): Promise< HostSite > => {
			const sites = await host.sites.all();
			const site = sites.find( ( candidate ) =>
				files.every( ( file ) => file.startsWith( path.resolve( candidate.path ) + path.sep ) )
			);
			if ( ! site ) {
				throw new Error( 'Images under wp-content/uploads must all be inside one Studio site.' );
			}
			return site;
		},
		reserve: async ( site, names ) =>
			readReservedAttachments( await runWpCli( host, site, reserveAttachmentsArgs( names ) ) ),
		finalize: async ( site, ready, failed ) => {
			await runWpCli( host, site, finalizeAttachmentsArgs( ready, failed ) );
		},
	};
}
