import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	isAllowedNativePath,
	isInsideCanonicalRoot,
	isOutsideReach,
	resolveAllowedNewPath,
	resolveAllowedPath,
} from '../local-paths';

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
	it( 'passes every check, which gives the path it judged', async () => {
		const inside = path.join( site, 'inside.txt' );
		expect( await isAllowedNativePath( inside, [ site ], config ) ).toBe( true );
		expect( await resolveAllowedPath( inside, [ site ], config ) ).toBe( inside );
		const created = path.join( site, 'new', 'new.zip' );
		expect( await resolveAllowedNewPath( created, [ site ], config ) ).toBe( created );
		expect( await isInsideCanonicalRoot( site, path.join( site, 'tmp', 'new.php' ) ) ).toBe( true );
	} );
} );

describe( 'a file of Studio’s own, out of the conversation’s reach', () => {
	it( 'resolves, existing or not, outside every folder the turn reaches', async () => {
		const studio = path.join( scratch, 'studio' );
		await mkdir( studio );
		await writeFile( path.join( studio, 'shared.json' ), '{}' );
		expect( await isOutsideReach( path.join( studio, 'shared.json' ), [ site ] ) ).toBe( true );
		expect( await isOutsideReach( path.join( studio, 'missing.json' ), [ site ] ) ).toBe( true );
		expect( await isOutsideReach( path.join( site, 'inside.txt' ), [ site ] ) ).toBe( false );
		expect( await isOutsideReach( path.join( studio, 'shared.json' ), [ site, scratch ] ) ).toBe(
			false
		);
	} );

	it( 'is not one whose folder leads into a folder the turn reaches, nor a path no check can judge', async () => {
		const linked = path.join( scratch, 'linked' );
		await symlink( site, linked, 'junction' );
		expect( await isOutsideReach( path.join( linked, 'inside.txt' ), [ site ] ) ).toBe( false );
		expect( await isOutsideReach( path.join( linked, 'missing.json' ), [ site ] ) ).toBe( false );
		expect( await isOutsideReach( 'shared.json', [ site ] ) ).toBe( false );
		expect(
			await isOutsideReach( [ scratch, 'studio', '..', 'shared.json' ].join( path.sep ), [ site ] )
		).toBe( false );
	} );
} );

describe( 'a path with a `..` segment', () => {
	// Joined by hand: `path.join` would collapse the `..` before any check saw it.
	const through = ( separator: string, ...parts: string[] ) => [ site, ...parts ].join( separator );

	it( 'is refused by every check, by either separator, even where it would lead inside', async () => {
		await mkdir( path.join( site, 'sub' ) );
		for ( const separator of [ path.sep, '/' ] ) {
			expect(
				await isAllowedNativePath(
					through( separator, 'sub', '..', 'inside.txt' ),
					[ site ],
					config
				),
				separator
			).toBe( false );
			expect(
				await resolveAllowedNewPath(
					through( separator, 'sub', '..', 'new.zip' ),
					[ site ],
					config
				),
				separator
			).toBeUndefined();
			expect(
				await resolveAllowedNewPath(
					through( separator, 'sub', 'new', '..', 'x.zip' ),
					[ site ],
					config
				),
				separator
			).toBeUndefined();
			expect(
				await isInsideCanonicalRoot( site, through( separator, 'sub', '..', 'tmp', 'x.php' ) ),
				separator
			).toBe( false );
			expect(
				await isInsideCanonicalRoot( site, through( separator, 'sub', '..' ) ),
				separator
			).toBe( false );
		}
	} );

	it( 'is a whole segment: a name that only starts or ends with dots is a name', async () => {
		for ( const name of [ '..backup.zip', 'backup..zip' ] )
			expect( await resolveAllowedNewPath( path.join( site, name ), [ site ], config ) ).toBe(
				path.join( site, name )
			);
	} );
} );

describe.runIf( process.platform === 'win32' )( 'on Windows, a colon after the drive', () => {
	it( 'refuses a path that names a stream, of a file that exists or of one that does not', async () => {
		await writeFile( path.join( site, 'inside.txt:s' ), 'stream' );
		expect( await isAllowedNativePath( path.join( site, 'inside.txt:s' ), [ site ], config ) ).toBe(
			false
		);
		for ( const name of [ 'new.zip:s', 'inside.txt:s' ] )
			expect(
				await resolveAllowedNewPath( path.join( site, name ), [ site ], config )
			).toBeUndefined();
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
				await resolveAllowedNewPath(
					`${ prefix }${ path.join( site, 'new.zip' ) }`,
					[ site ],
					config
				)
			).toBeUndefined();
		}
	} );

	it( 'leaves a plain drive path alone, with either separator, and gives it with the system’s', async () => {
		expect( site ).toMatch( /^[a-z]:\\/i );
		const forward = ( file: string ) => file.split( path.sep ).join( '/' );
		const created = path.join( site, 'new.zip' );
		expect( await resolveAllowedNewPath( forward( created ), [ site ], config ) ).toBe( created );
		const inside = path.join( site, 'inside.txt' );
		expect( await resolveAllowedPath( forward( inside ), [ site ], config ) ).toBe( inside );
	} );
} );
