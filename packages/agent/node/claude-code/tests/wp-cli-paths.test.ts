import { link, mkdir, rename, symlink, writeFile } from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClaudeExecutionPolicy } from '../execution-policy';
import { checkWpCliPaths } from '../wp-cli-paths';
import { hasWpCliOverrides, inspectWpCliArgs } from '../wp-cli-rules';
import { createPolicyFixture } from './fixtures/execution-policy';
import type { WpCliFileArgument } from '../wp-cli-rules';

let fixture: Awaited< ReturnType< typeof createPolicyFixture > >;
const check = ( args: readonly string[], files: readonly WpCliFileArgument[] ) =>
	checkWpCliPaths( args, files, fixture.site, fixture.config, fixture.context.isStudioSite );
const inspectFiles = async ( args: string[] ) => {
	const result = inspectWpCliArgs( args );
	return 'refusal' in result ? result : check( args, result.files );
};

beforeEach( async () => {
	fixture = await createPolicyFixture();
	vi.stubEnv( 'HOME', fixture.parent );
	vi.stubEnv( 'USERPROFILE', fixture.parent );
} );
afterEach( async () => {
	vi.unstubAllEnvs();
	await fixture.cleanup();
} );

describe( 'WP-CLI file arguments on the selected site', () => {
	it( 'checks shipped eval-file data operands by the resolved script identity', async () => {
		const dir = path.join( fixture.site, 'tmp', 'taxonomist' );
		await mkdir( dir, { recursive: true } );
		const script = path.join( dir, 'apply-changes.php' );
		const data = path.join( fixture.site, 'suggestions.json' );
		const log = path.join( fixture.site, 'changes.tsv' );
		await writeFile( script, '' );
		await writeFile( data, '{}' );
		await symlink( dir, path.join( fixture.site, 'scripts' ), 'junction' );
		const spellings = [ script, 'scripts/apply-changes.php', './tmp/taxonomist/apply-changes.php' ];
		if ( process.platform === 'win32' ) spellings.push( script.toUpperCase() );
		for ( const spelling of spellings ) {
			const make = ( ...values: string[] ) => [ 'eval-file', spelling, '--quiet', ...values ];
			const checked = await inspectFiles( make( 'suggestions.json', 'changes.tsv', 'preview' ) );
			expect( checked, spelling ).toEqual( {
				args: [ 'eval-file', script, '--quiet', data, log, 'preview' ],
				paths: [ script, data, log ],
			} );
			for ( const args of [
				[],
				[ 'suggestions.json' ],
				[ 'suggestions.json', '../outside.tsv', 'preview' ],
			] )
				expect( await inspectFiles( make( ...args ) ), spelling ).toHaveProperty( 'refusal' );
		}
		await writeFile( path.join( fixture.site, 'other.php' ), '' );
		expect( await inspectFiles( [ 'eval-file', 'other.php', 'literal' ] ) ).toEqual( {
			args: [ 'eval-file', path.join( fixture.site, 'other.php' ), 'literal' ],
			paths: [ path.join( fixture.site, 'other.php' ) ],
		} );
	} );

	it( 'requires explicit paths for all shipped eval-file helpers', async () => {
		const dir = path.join( fixture.site, 'tmp', 'taxonomist' );
		await mkdir( dir, { recursive: true } );
		for ( const file of [ 'backup.php', 'export-posts.php', 'restore.php' ] ) {
			const script = path.join( dir, file );
			await writeFile( script, '' );
			expect( await inspectFiles( [ 'eval-file', script ] ), file ).toHaveProperty( 'refusal' );
		}
	} );

	it( 'keeps an importer author keyword literal only while the path is absent', async () => {
		const file = path.join( fixture.site, 'posts.xml' );
		await writeFile( file, '' );
		for ( const keyword of [ 'skip', 'create' ] ) {
			const args = [ 'import', 'posts.xml', '--authors=' + keyword ];
			expect( await inspectFiles( args ) ).toEqual( {
				args: [ 'import', file, args[ 2 ] ],
				paths: [ file ],
			} );
			await mkdir( path.join( fixture.site, keyword ) );
			expect( await inspectFiles( args ) ).toHaveProperty( 'refusal' );
		}
	} );
	it( 'replaces only file values, keeping attached options and multiple inputs in order', async () => {
		const dir = path.join( fixture.site, 'images' );
		await mkdir( dir );
		await symlink( dir, path.join( fixture.site, 'alias' ), 'junction' );
		await writeFile( path.join( dir, 'a.png' ), 'fixture' );
		await writeFile( path.join( dir, 'b.png' ), 'fixture' );
		const inputs = [ 'alias/a.png', 'alias/b.png' ];
		const checked = await check(
			[ 'media', 'import', ...inputs, '--porcelain' ],
			[
				{ index: 2, kind: 'read' },
				{ index: 3, kind: 'read' },
			]
		);
		const paths = [ path.join( dir, 'a.png' ), path.join( dir, 'b.png' ) ];
		expect( checked ).toEqual( { args: [ 'media', 'import', ...paths, '--porcelain' ], paths } );
		expect(
			await check(
				[ 'export', '--dir=alias' ],
				[ { index: 1, prefix: '--dir=', kind: 'write-directory' } ]
			)
		).toEqual( { args: [ 'export', '--dir=' + dir ], paths: [ dir ] } );
	} );

	it( 'checks missing destinations, traversals, links, file types and protected names', async () => {
		await symlink( fixture.other, path.join( fixture.site, 'external' ), 'junction' );
		const outside = path.join( fixture.other, 'fixture.txt' );
		await writeFile( outside, '' );
		await link( outside, path.join( fixture.site, 'alias.txt' ) );
		for ( const value of [
			'../other/fixture.txt',
			'sub/../filename',
			'external/fixture.txt',
			'alias.txt',
			'.env',
			'.',
			'C:drive-relative',
			'php://memory',
		] ) {
			expect( await check( [ value ], [ { index: 0, kind: 'write' } ] ), value ).toHaveProperty(
				'refusal'
			);
		}
		const file = path.join( fixture.site, 'new', 'backup.sql' );
		expect( await check( [ 'new/backup.sql' ], [ { index: 0, kind: 'write' } ] ) ).toEqual( {
			args: [ file ],
			paths: [ file ],
		} );
		expect( await check( [ 'new/backup.sql' ], [ { index: 0, kind: 'read' } ] ) ).toHaveProperty(
			'refusal'
		);
	} );

	it( 'allows an existing output directory but refuses core and protected output directories', async () => {
		await mkdir( path.join( fixture.site, 'wp-includes' ) );
		await mkdir( path.join( fixture.site, 'wp-content' ) );
		await mkdir( path.join( fixture.site, '.ssh' ) );
		const directory = [ { index: 0, kind: 'write-directory' } ] as const;
		expect( await check( [ '.' ], directory ) ).toEqual( {
			args: [ fixture.site ],
			paths: [ fixture.site ],
		} );
		for ( const value of [ 'wp-includes', '.ssh', 'missing' ] )
			expect( await check( [ value ], directory ), value ).toHaveProperty( 'refusal' );
	} );

	it( 'binds a disk export without --dir to the checked site directory', async () => {
		expect(
			await check( [ 'export' ], [ { index: 1, prefix: '--dir=', kind: 'write-directory' } ] )
		).toEqual( { args: [ 'export', '--dir=' + fixture.site ], paths: [ fixture.site ] } );
	} );

	it( 'refuses an output directory with a linked XML destination', async () => {
		const existing = path.join( fixture.other, 'shared.xml' );
		await writeFile( existing, 'fixture' );
		await link( existing, path.join( fixture.site, 'site.wordpress.2030-01-01.000.xml' ) );
		expect(
			await check(
				[ 'export', '--dir=.' ],
				[ { index: 1, prefix: '--dir=', kind: 'write-directory' } ]
			)
		).toHaveProperty( 'refusal' );
	} );

	it( 'keeps generated XML files in the output directory even when another site file is writable', async ( context ) => {
		const dir = path.join( fixture.site, 'exports' );
		await mkdir( dir );
		const target = path.join( fixture.site, 'separate.txt' );
		await writeFile( target, 'existing page' );
		try {
			await symlink( target, path.join( dir, 'one.xml' ), 'file' );
		} catch ( e ) {
			if ( process.platform === 'win32' && ( e as NodeJS.ErrnoException ).code === 'EPERM' )
				return context.skip();
			throw e;
		}
		const args = [ 'export', '--dir=exports', '--filename_format=one.xml' ];
		expect(
			await check( args, [ { index: 1, prefix: '--dir=', kind: 'write-directory' } ] )
		).toHaveProperty( 'refusal' );
	} );

	it( 'checks custom export filenames before they exist and checks existing linked outputs', async () => {
		const dir = [ { index: 1, prefix: '--dir=', kind: 'write-directory' } ] as const;
		for ( const format of [ '.env.{n}.xml', 'credentials.xml' ] )
			expect(
				await check( [ 'export', '--dir=.', '--filename_format=' + format ], dir )
			).toHaveProperty( 'refusal' );
		const other = path.join( fixture.other, 'harmless.xml' );
		await writeFile( other, 'fixture' );
		await link( other, path.join( fixture.site, 'ARCHIVE-002.xml' ) );
		const command = [ 'export', '--dir=.', '--filename_format=archive-{n}.xml' ];
		expect( await check( command, dir ) ).toHaveProperty( 'refusal' );
		expect(
			await check( [ 'export', '--dir=.', '--filename_format=other.xml' ], dir )
		).toHaveProperty( 'paths', [ fixture.site ] );
	} );
} );

describe( 'the general WP-CLI host call', () => {
	it( 'shows inline draft content only when it will supply the body', async () => {
		const policy = createClaudeExecutionPolicy( {
			...fixture.context,
			uncertainAfterRecovery: true,
		} );
		const guarded = policy.guardHost( fixture.host, 'draft' );
		const options = [ '--post_title=Fixture', '--post_status=draft', '--post_content=Inline' ];
		await writeFile( path.join( fixture.site, 'body.html' ), 'From a file' );
		for ( const file of [ [], [ 'body.html' ] ] ) {
			const args = [ 'post', 'create', ...file, ...options ];
			expect(
				await policy.authorizeStudioCall( {
					host: fixture.host,
					name: 'wp_cli',
					args: { nameOrPath: 'site', command: args.join( ' ' ) },
					toolCallId: 'draft',
				} )
			).toBe( true );
			await guarded.sites.wpCli( fixture.localSite, args );
			const request = vi.mocked( fixture.context.approve ).mock.lastCall?.[ 0 ];
			expect( request?.operation.draft?.title ).toBe( 'Fixture' );
			expect( request?.operation.draft?.content ).toBe( file.length ? undefined : 'Inline' );
		}
	} );
	it( 'refuses a newly shadowed author keyword at the PHP spawn', async () => {
		await writeFile( path.join( fixture.site, 'posts.xml' ), '' );
		const toolCallId = 'import';
		const host = fixture.policy.guardHost( fixture.host, toolCallId );
		const command = 'import posts.xml --authors=skip';
		expect(
			await fixture.policy.authorizeStudioCall( {
				host: fixture.host,
				name: 'wp_cli',
				args: { nameOrPath: 'site', command },
				toolCallId,
			} )
		).toBe( true );
		const spawned = vi.fn();
		vi.mocked( fixture.host.sites.wpCli ).mockImplementation( async ( _site, _args, options ) => {
			await writeFile( path.join( fixture.site, 'skip' ), '' );
			await options?.beforeSpawn?.();
			spawned();
			return { exitCode: 0, stdout: '', stderr: '' };
		} );
		await expect( host.sites.wpCli( fixture.localSite, command.split( ' ' ) ) ).rejects.toThrow(
			'Denied'
		);
		expect( spawned ).not.toHaveBeenCalled();
	} );
	it( 'refuses an original file operand retargeted before the PHP spawn', async () => {
		const first = path.join( fixture.site, 'first' );
		const second = path.join( fixture.site, 'second' );
		const alias = path.join( fixture.site, 'alias' );
		for ( const folder of [ first, second ] ) {
			await mkdir( folder );
			await writeFile( path.join( folder, 'page.html' ), 'fixture' );
		}
		await symlink( first, alias, 'junction' );
		const toolCallId = 'post';
		const host = fixture.policy.guardHost( fixture.host, toolCallId );
		const command = 'post update 2 alias/page.html';
		expect(
			await fixture.policy.authorizeStudioCall( {
				host: fixture.host,
				name: 'wp_cli',
				args: { nameOrPath: 'site', command },
				toolCallId,
			} )
		).toBe( true );
		const spawned = vi.fn();
		vi.mocked( fixture.host.sites.wpCli ).mockImplementation( async ( _site, args, options ) => {
			expect( args ).toContain( path.join( first, 'page.html' ) );
			await rename( alias, path.join( fixture.site, 'old-alias' ) );
			await symlink( second, alias, 'junction' );
			await options?.beforeSpawn?.();
			spawned();
			return { exitCode: 0, stdout: '', stderr: '' };
		} );
		await expect( host.sites.wpCli( fixture.localSite, command.split( ' ' ) ) ).rejects.toThrow(
			'Denied'
		);
		expect( spawned ).not.toHaveBeenCalled();
		expect( fixture.policy.takeRefusals( toolCallId ).join( ' ' ) ).toMatch( /checked location/i );
	} );

	it( 'keeps general WP-CLI out of a different admitted tool’s host', async () => {
		const toolCallId = 'other-tool';
		const guardedHost = fixture.policy.guardHost( fixture.host, toolCallId );
		expect(
			await fixture.policy.authorizeStudioCall( {
				host: fixture.host,
				name: 'site_info',
				args: { nameOrPath: 'site' },
				toolCallId,
			} )
		).toBe( true );
		await expect(
			guardedHost.sites.wpCli( fixture.localSite, [ 'plugin', 'list' ] )
		).rejects.toThrow( 'Denied' );
		expect( fixture.host.sites.wpCli ).not.toHaveBeenCalled();
	} );
} );

describe( 'bundled WP-CLI global configuration', () => {
	it( 'resolves a relative PHP HOME from the selected site directory', async () => {
		vi.stubEnv( 'HOME', 'wp-home' );
		const config = path.join( fixture.site, 'wp-home', '.wp-cli' );
		expect( await hasWpCliOverrides( fixture.site ) ).toBe( false );
		await mkdir( config, { recursive: true } );
		await writeFile( path.join( config, 'config.yml' ), '' );
		expect( await hasWpCliOverrides( fixture.site ) ).toBe( true );
	} );

	it.each( [ '', '0' ] )(
		'uses HOMEDRIVE and HOMEPATH when PHP treats HOME=%j as false',
		async ( home ) => {
			const fallback = path.join( fixture.other, 'wp-home' );
			const root = path.parse( fallback ).root;
			vi.stubEnv( 'HOME', home );
			vi.stubEnv( 'HOMEDRIVE', root );
			vi.stubEnv( 'HOMEPATH', fallback.slice( root.length ) );
			const config = path.join( fallback, '.wp-cli' );
			expect( await hasWpCliOverrides( fixture.site ) ).toBe( false );
			await mkdir( config, { recursive: true } );
			await writeFile( path.join( config, 'config.yml' ), '' );
			expect( await hasWpCliOverrides( fixture.site ) ).toBe( true );
		}
	);
} );
