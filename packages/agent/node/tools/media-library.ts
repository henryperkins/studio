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

/** Claim each uploads filename before another reservation can choose it. */
export function reserveExclusiveAttachmentsArgs( names: string[], site: string ): string[] {
	return evalWithData(
		`$upload = wp_upload_dir();
$root = realpath( $data['site'] );
$directory = realpath( $upload['path'] );
$prefix = $root ? trailingslashit( wp_normalize_path( $root ) ) : '';
$folder = $directory ? wp_normalize_path( $directory ) : '';
$reserved = array();
$unconfirmed = 0;
$error = '';
$inside = PHP_OS_FAMILY === 'Windows'
	? strncasecmp( $folder . '/', $prefix, strlen( $prefix ) ) === 0
	: strncmp( $folder . '/', $prefix, strlen( $prefix ) ) === 0;
if ( ! $root || ! $directory || ! is_dir( $directory ) || ! $inside ) {
	$error = 'uploads-folder';
} else {
	foreach ( $data['names'] as $index => $name ) {
		$claim = false;
		for ( $attempt = 0; $attempt < 20; ++$attempt ) {
			clearstatcache();
			$name_on_disk = wp_unique_filename( $directory, $name );
			if ( $name_on_disk !== wp_basename( $name_on_disk ) || ! preg_match( '/\\.png$/iD', $name_on_disk ) ) break;
			$file = $directory . '/' . $name_on_disk;
			$claim = @fopen( $file, 'x' );
			if ( $claim || ( ! file_exists( $file ) && ! is_link( $file ) ) ) break;
		}
		if ( ! $claim ) { $error = 'claim'; break; }
		fclose( $claim );
		try {
			$id = wp_insert_attachment( array( 'guid' => $upload['url'] . '/' . $name_on_disk, 'post_mime_type' => 'image/png', 'post_title' => pathinfo( $name_on_disk, PATHINFO_FILENAME ), 'post_content' => '', 'post_status' => 'inherit' ), $file, 0, true );
		} catch ( Throwable $exception ) {
			$id = false;
			++$unconfirmed;
		}
		if ( is_wp_error( $id ) || ! $id ) {
			if ( ! @unlink( $file ) ) $unconfirmed = 1;
			$error = 'insert';
			break;
		}
		echo "studio-media-reserved:$index:$id:" . base64_encode( $name ) . "\\n";
		$reserved[] = array( 'id' => $id, 'file' => substr( wp_normalize_path( $file ), strlen( $prefix ) ), 'url' => wp_get_attachment_url( $id ) );
	}
}
echo wp_json_encode( $error === '' ? $reserved : array( 'error' => $error, 'reserved' => $reserved, 'unconfirmedFiles' => $unconfirmed ) );`,
		{ names, site }
	);
}

/**
 * The WP-CLI arguments that complete the attachments whose images were
 * written and delete the others.
 */
export function finalizeAttachmentsArgs( ready: number[], failed: number[] ): string[] {
	return evalWithData( FINALIZE_ATTACHMENTS, { ready, failed } );
}

/** Reports each settled reservation independently, even if a later one fails. */
export function verifiedFinalizeAttachmentsArgs(
	ready: number[],
	failed: number[],
	possiblyCompleted: number[]
): string[] {
	const php = `require_once ABSPATH . 'wp-admin/includes/image.php';
foreach ( $data['ready'] as $id ) {
	$file = get_attached_file( $id );
	if ( ! $file || ! is_file( $file ) || 'attachment' !== get_post_type( $id ) ) continue;
	$metadata = wp_generate_attachment_metadata( $id, $file );
	if ( empty( $metadata['file'] ) || empty( $metadata['width'] ) || empty( $metadata['height'] ) ) continue;
	wp_update_attachment_metadata( $id, $metadata );
	if ( wp_get_attachment_metadata( $id, true ) === $metadata ) echo "studio-media-settled:$id\\n";
}
foreach ( $data['failed'] as $id ) {
	// A missing row by itself cannot confirm that WordPress removed the file on an earlier try.
	if ( 'attachment' !== get_post_type( $id ) ) continue;
	$file = get_attached_file( $id );
	if ( ! $file ) continue;
	$metadata = wp_get_attachment_metadata( $id, true );
	if ( in_array( $id, $data['possiblyCompleted'] ?? array(), true ) && is_file( $file )
		&& ! empty( $metadata['file'] ) && ! empty( $metadata['width'] ) && ! empty( $metadata['height'] ) ) {
		echo "studio-media-settled:$id\\n";
		continue;
	}
	$files = array( $file );
	if ( ! empty( $metadata['original_image'] ) ) $files[] = dirname( $file ) . '/' . wp_basename( $metadata['original_image'] );
	foreach ( $metadata['sizes'] ?? array() as $size ) {
		if ( ! empty( $size['file'] ) ) $files[] = dirname( $file ) . '/' . wp_basename( $size['file'] );
	}
	if ( ! wp_delete_attachment( $id, true ) || get_post( $id ) ) continue;
	foreach ( $files as $path ) {
		clearstatcache( true, $path );
		if ( ! is_readable( dirname( $path ) ) || file_exists( $path ) || is_link( $path ) ) continue 2;
	}
	echo "studio-media-settled:$id\\n";
}`;
	return evalWithData( php, {
		ready,
		failed,
		...( possiblyCompleted.length ? { possiblyCompleted } : {} ),
	} );
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
