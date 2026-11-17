import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAllowedNativePath, isAllowedNewPath, isInsideCanonicalRoot } from '../local-paths';

// The checks a path Studio reads or writes for a conversation passes, on a
// scratch folder of this test's own: `site` is the conversation's folder.

let scratch: string;
let site: string;
let config: string;

beforeEach( async () => {
	scratch = await realpath( await mkdtemp( path.join( os.tmpdir(), 'studio-local-paths-' ) ) );
	site = path.join( scratch, 'site' );
	config = path.join( scratch, 'config' );
	await mkdir( site );
	await mkdir( config );
	await writeFile( path.join( site, 'inside.txt' ), 'inside' );
} );

afterEach( async () => {
	await rm( scratch, { recursive: true, force: true } );
} );

describe( 'a path in the conversation’s folder', () => {
	it( 'passes every check', async () => {
		expect( await isAllowedNativePath( path.join( site, 'inside.txt' ), [ site ], config ) ).toBe(
			true
		);
		expect( await isAllowedNewPath( path.join( site, 'new.zip' ), [ site ], config ) ).toBe( true );
		expect( await isInsideCanonicalRoot( site, path.join( site, 'tmp', 'new.php' ) ) ).toBe( true );
	} );
} );

describe.runIf( process.platform === 'win32' )( 'on Windows, a colon after the drive', () => {
	it( 'refuses a path that names a stream, of a file that exists or of one that does not', async () => {
		await writeFile( path.join( site, 'inside.txt:s' ), 'stream' );
		expect( await isAllowedNativePath( path.join( site, 'inside.txt:s' ), [ site ], config ) ).toBe(
			false
		);
		expect( await isAllowedNewPath( path.join( site, 'new.zip:s' ), [ site ], config ) ).toBe(
			false
		);
		expect( await isAllowedNewPath( path.join( site, 'inside.txt:s' ), [ site ], config ) ).toBe(
			false
		);
		expect( await isInsideCanonicalRoot( site, path.join( site, 'tmp:s', 'new.php' ) ) ).toBe(
			false
		);
	} );

	it( 'refuses a device path, whose drive comes after a prefix', async () => {
		for ( const prefix of [ '\\\\?\\', '\\\\.\\' ] ) {
			expect(
				await isAllowedNativePath(
					`${ prefix }${ path.join( site, 'inside.txt' ) }`,
					[ site ],
					config
				)
			).toBe( false );
			expect(
				await isAllowedNewPath( `${ prefix }${ path.join( site, 'new.zip' ) }`, [ site ], config )
			).toBe( false );
		}
	} );

	it( 'leaves a plain drive path alone, with either separator', async () => {
		expect( site ).toMatch( /^[a-z]:\\/i );
		const forward = path.join( site, 'new.zip' ).replaceAll( '\\', '/' );
		expect( await isAllowedNewPath( forward, [ site ], config ) ).toBe( true );
		expect(
			await isAllowedNativePath(
				path.join( site, 'inside.txt' ).replaceAll( '\\', '/' ),
				[ site ],
				config
			)
		).toBe( true );
	} );
} );
