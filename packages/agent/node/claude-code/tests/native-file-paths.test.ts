import { realpath as checkedRealpath } from 'fs/promises';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkClaudeNativePath, getClaudeSensitiveReadDenyRules } from '../local-paths';

vi.mock( 'fs/promises', { spy: true } );

let scratch: string;
let site: string;
let config: string;
let profile: string;
const check = ( tool: string, file: string, roots = [ site ] ) =>
	checkClaudeNativePath( tool, file, roots, config, async ( folder ) => folder === site );

beforeEach( async () => {
	scratch = await realpath( await mkdtemp( path.join( os.tmpdir(), 'studio-native-files-' ) ) );
	site = path.join( scratch, 'site' );
	config = path.join( scratch, 'native-config' );
	profile = path.join( scratch, 'studio-profile' );
	vi.stubEnv( 'DEV_CONFIG_DIR', profile );
	await Promise.all( [ site, config, profile ].map( ( dir ) => mkdir( dir ) ) );
} );

afterEach( async () => {
	vi.mocked( checkedRealpath ).mockReset();
	vi.unstubAllEnvs();
	await rm( scratch, { recursive: true, force: true } );
} );

describe( 'native search and file paths', () => {
	it.each( [ 'Grep', 'Glob', 'Ls' ] )(
		'%s anchors a relative root to the working directory of the turn',
		async ( tool ) => {
			const cwd = path.join( scratch, 'other-workspace' );
			const nested = path.join( cwd, 'nested' );
			await mkdir( nested, { recursive: true } );
			const invoke = ( input: string ) =>
				checkClaudeNativePath( tool, input, [ site, cwd ], config, async () => false, cwd );
			expect( await invoke( '.' ) ).toEqual( { path: cwd } );
			expect( await invoke( 'nested' ) ).toEqual( { path: nested } );
			expect( await invoke( 'nested/../nested' ) ).toHaveProperty( 'refusal' );
			expect( await invoke( 'C:nested' ) ).toHaveProperty( 'refusal' );
			expect(
				await checkClaudeNativePath(
					'Write',
					'nested',
					[ site, cwd ],
					config,
					async () => false,
					cwd
				)
			).toHaveProperty( 'refusal' );
		}
	);
	it.runIf( process.platform === 'win32' )(
		'refuses an unselected network share without asking Windows to resolve it',
		async () => {
			const file = '//foreign-share.invalid/work/request.txt';
			vi.mocked( checkedRealpath )
				.mockClear()
				.mockRejectedValue( new Error( 'simulated unavailable share' ) );
			expect( await check( 'Read', file ) ).toHaveProperty( 'refusal' );
			expect( checkedRealpath ).not.toHaveBeenCalled();
		}
	);
	it.each( [ 'Glob', 'Grep', 'Ls' ] )(
		'%s checks both the root and explicit search paths',
		async ( tool ) => {
			expect( await check( tool, site ) ).toEqual( { path: site } );
			expect( await check( tool, scratch ) ).toHaveProperty( 'refusal' );
			const linked = path.join( site, 'elsewhere' );
			await symlink( scratch, linked, 'junction' );
			expect( await check( tool, linked ) ).toMatchObject( {
				refusal: expect.stringMatching( /link/i ),
			} );
		}
	);

	it.each( [ 'Read', 'Grep', 'LsEntry' ] )(
		'%s refuses a multiply-linked file but can use it once it has a single name',
		async ( tool ) => {
			const original = path.join( scratch, 'sample.txt' );
			const alias = path.join( site, 'copy.txt' );
			await writeFile( original, 'sample' );
			await link( original, alias );
			expect( await check( tool, alias ) ).toMatchObject( {
				refusal: expect.stringMatching( /hard link/i ),
			} );
			const subdir = path.join( site, 'content' );
			await mkdir( path.join( subdir, 'nested' ), { recursive: true } );
			if ( tool === 'Read' )
				expect( await check( tool, subdir ) ).toMatchObject( {
					refusal: expect.stringMatching( /regular file/i ),
				} );
			else expect( await check( tool, subdir ) ).toEqual( { path: subdir } );
			await rm( original );
			expect( await check( tool, alias ) ).toEqual( { path: alias } );
		}
	);

	it( 'accepts an explicit ordinary file for Grep, and directories for Glob and Ls', async () => {
		const file = path.join( site, 'note.txt' );
		await writeFile( file, 'text' );
		expect( await check( 'Read', site ) ).toHaveProperty( 'refusal' );
		expect( await check( 'Grep', file ) ).toEqual( { path: file } );
		for ( const name of [ 'Glob', 'Ls' ] )
			expect( await check( name, file ) ).toHaveProperty( 'refusal' );
	} );

	it.each( [ 'Write', 'Edit' ] )(
		'%s checks new paths, actual links and WordPress core',
		async ( name ) => {
			const wpContent = path.join( site, 'wp-content' );
			const core = path.join( site, 'wp-includes' );
			await mkdir( core );
			await mkdir( wpContent );
			const coreFile = path.join( core, 'loader.php' );
			await writeFile( coreFile, 'original' );
			const good = path.join( wpContent, 'themes', 'nested', 'style.css' );
			expect( await check( name, good ) ).toEqual( { path: good } );
			expect( await check( name, site ) ).toHaveProperty( 'refusal' );
			const foreign = path.join( site, 'external' );
			await symlink( scratch, foreign, 'junction' );
			expect( await check( name, path.join( foreign, 'new.txt' ) ) ).toMatchObject( {
				refusal: expect.stringMatching( /link/i ),
			} );
			const linkedCore = path.join( site, 'linked-core' );
			await symlink( core, linkedCore, 'junction' );
			expect( await check( name, path.join( linkedCore, 'loader.php' ) ) ).toMatchObject( {
				refusal: expect.stringMatching( /wp-content/i ),
			} );
			expect( await check( name, path.join( site, 'index.php' ) ) ).toHaveProperty( 'refusal' );
			expect( await check( name, path.join( wpContent, '.env.local' ) ) ).toHaveProperty(
				'refusal'
			);
			const dangling = path.join( site, 'unfinished' );
			const missing = path.join( scratch, 'missing' );
			await mkdir( missing );
			await symlink( missing, dangling, 'junction' );
			await rm( missing, { recursive: true } );
			expect( await check( name, path.join( dangling, 'file.txt' ) ) ).toHaveProperty( 'refusal' );
			const alias = path.join( site, 'ordinary.txt' );
			await link( coreFile, alias );
			expect( await check( name, alias ) ).toMatchObject( {
				refusal: expect.stringMatching( /hard link/i ),
			} );
		}
	);

	it.each( [ 'Read', 'Glob', 'Grep', 'Ls', 'Write', 'Edit' ] )(
		'%s protects native and Studio configuration',
		async ( name ) => {
			const subdir = path.join( profile, 'data' );
			await mkdir( subdir );
			const file = [ 'Glob', 'Grep', 'Ls' ].includes( name ) ? subdir : path.join( subdir, 'file' );
			if ( file !== subdir ) await writeFile( file, 'original' );
			expect( await check( name, file, [ subdir ] ) ).toHaveProperty( 'refusal' );
			expect( await check( name, config, [ config ] ) ).toHaveProperty( 'refusal' );
		}
	);

	it( 'refuses search and write when a Studio store resolves into the searched or writable folder', async () => {
		vi.stubEnv( 'DEV_CONFIG_DIR', path.join( scratch, 'linked-profile' ) );
		await symlink( site, process.env.DEV_CONFIG_DIR!, 'junction' );
		expect( await check( 'Glob', site ) ).toHaveProperty( 'refusal' );
		expect( await check( 'Write', path.join( site, 'new' ) ) ).toHaveProperty( 'refusal' );
	} );

	it( 'keeps the dedicated global workspace usable within Studio’s own profile', async () => {
		const global = path.join( profile, 'sessions.claude-code', 'global-workspace' );
		await mkdir( global, { recursive: true } );
		if ( process.platform === 'win32' ) vi.stubEnv( 'DEV_CONFIG_DIR', profile.toUpperCase() );
		expect( await check( 'Glob', global, [ global ] ) ).toEqual( { path: global } );
		const file = path.join( global, 'new' );
		expect( await check( 'Write', file, [ global ] ) ).toEqual( { path: file } );
	} );

	it.runIf( process.platform === 'win32' )(
		'refuses device names and ambiguous components, including in a missing parent',
		async () => {
			for ( const name of [
				'CON',
				'NUL.txt',
				'COM1',
				'LPT².backup',
				'CONOUT$',
				'con .txt',
				'new.',
				'dir ',
				'name:stream',
			] ) {
				expect( await check( 'Write', path.join( site, name, 'file' ) ), name ).toMatchObject( {
					refusal: expect.stringMatching( /Windows/i ),
				} );
			}
			expect(
				await check( 'Write', [ site, 'folder', '..', 'file' ].join( path.sep ) )
			).toHaveProperty( 'refusal' );
		}
	);

	it( 'supplies native Read deny rules for sensitive entries and their descendants', () => {
		const rules = getClaudeSensitiveReadDenyRules();
		const globs = rules.map( ( rule ) => /^Read\((.+)\)$/.exec( rule )![ 1 ] );
		const matches = ( file: string ) =>
			globs.some( ( glob ) => path.posix.matchesGlob( file, glob ) );
		for ( const file of [
			'.env',
			'nested/.Env.PROD',
			'data/Database/post.sql',
			'folder/.credentials',
			'.mySECRET',
			'wp-config.PHP',
			'site/key.pFx',
		] ) {
			expect( matches( file ), file ).toBe( true );
		}
		expect( matches( 'wp-content/themes/style.css' ) ).toBe( false );
	} );
} );
