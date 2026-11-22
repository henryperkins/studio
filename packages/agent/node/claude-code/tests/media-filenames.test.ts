import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { reserveExclusiveAttachmentsArgs } from '../../tools/media-library';

const phpAvailable = spawnSync( 'php', [ '-n', '-v' ] ).status === 0;
const runPhp = promisify( execFile );

// As in WordPress, choosing a filename observes the directory but does not create a file.
const uploadsApi = `function wp_upload_dir() { return array( 'path' => getenv('TEST_UPLOADS'), 'url' => 'http://localhost/uploads' ); }
function wp_normalize_path($s) { return str_replace(chr(92), '/', $s); }
function trailingslashit($s) { return rtrim($s, '/') . '/'; }
function wp_basename($s) { return basename($s); }
function wp_unique_filename($dir, $name) {
    $candidate = $name;
    for ($i = 1; file_exists($dir . '/' . $candidate); ++$i) $candidate = basename($name,'.png') . '-' . $i . '.png';
    return $candidate;
}
function wp_insert_attachment() { static $id = 0; return ++$id; }
function is_wp_error($v) { return false; }
function wp_get_attachment_url($id) { return 'http://localhost/uploads/' . $id; }
function wp_json_encode($v) { return json_encode($v); }`;

it.skipIf( ! phpAvailable )(
	'claims distinct files for equal names across concurrent calls and creates none through an external uploads link',
	async () => {
		const root = await mkdtemp( path.join( os.tmpdir(), 'studio-media-claims-' ) );
		const site = path.join( root, 'site' );
		const uploads = path.join( site, 'uploads' );
		const outside = path.join( root, 'outside' );
		try {
			await mkdir( uploads, { recursive: true } );
			await mkdir( outside );
			const [ , command ] = reserveExclusiveAttachmentsArgs( [ 'hero.png', 'hero.png' ], site );
			const reserve = async ( folder: string ) => {
				const { stdout } = await runPhp( 'php', [ '-n', '-r', uploadsApi + command ], {
					env: { ...process.env, TEST_UPLOADS: folder },
				} );
				return JSON.parse( stdout.trim().split( '\n' ).at( -1 )! );
			};
			const batches = await Promise.all( [ reserve( uploads ), reserve( uploads ) ] );
			const files = batches.flat().map( ( entry ) => entry.file );
			expect( new Set( files ).size ).toBe( 4 );
			for ( const file of files )
				expect( ( await stat( path.join( site, file ) ) ).size ).toBe( 0 );
			const link = path.join( site, 'linked' );
			await symlink( outside, link, 'junction' );
			expect( await reserve( link ) ).toMatchObject( { error: 'uploads-folder', reserved: [] } );
			expect( await readdir( outside ) ).toEqual( [] );
		} finally {
			await rm( root, { recursive: true, force: true } );
		}
	}
);
