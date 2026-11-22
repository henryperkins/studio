import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { withSiteTransfer } from 'cli/lib/site-transfer-paths';
import { exportDatabaseToFile, exportDatabaseToMultipleFiles } from '../export/export-database';
import { SQLImporter } from '../import/importers/importer';
import type { SiteData } from 'cli/lib/cli-config/core';

vi.mock( '@studio/common/lib/generate-backup-filename', () => ( {
	generateBackupFilename: () => 'existing',
} ) );
vi.mock( 'cli/lib/sqlite-integration', () => ( { keepSqliteIntegrationUpdated: vi.fn() } ) );
vi.mock( '../import/update-site-url', () => ( { updateSiteUrl: vi.fn() } ) );
vi.mock( 'cli/lib/run-wp-cli-command', () => ( {
	runWpCliCommand: async ( site: SiteData, [ , command, file ]: string[] ) => {
		let exitCode = 0;
		if ( command === 'export' ) await writeFile( path.join( site.path, file ), 'exported SQL' );
		if ( command === 'import' ) {
			const sql = await readFile( path.join( site.path, file ), 'utf8' );
			exitCode = sql === 'import SQL' ? 0 : 1;
		}
		return {
			response: {
				exitCode: Promise.resolve( exitCode ),
				stdoutText: Promise.resolve( '["wp_posts"]' ),
				stderrText: Promise.resolve( '' ),
			},
			[ Symbol.dispose ]() {},
		};
	},
} ) );

describe( 'SQL staging during a scoped site transfer', () => {
	let root: string;
	let site: SiteData;
	beforeEach( async () => {
		root = await realpath( await mkdtemp( path.join( os.tmpdir(), 'studio-transfer-sql-' ) ) );
		site = { path: path.join( root, 'site' ), phpVersion: '8.3' } as SiteData;
		await mkdir( site.path );
		for ( const file of [ 'existing.sql', 'wp_posts.sql' ] ) {
			await writeFile( path.join( site.path, file ), 'user file' );
		}
	} );
	afterEach( async () => {
		await rm( root, { recursive: true, force: true } );
	} );

	async function expectSiteFilesPreserved() {
		expect( ( await readdir( site.path ) ).sort() ).toEqual( [ 'existing.sql', 'wp_posts.sql' ] );
		for ( const file of [ 'existing.sql', 'wp_posts.sql' ] ) {
			expect( await readFile( path.join( site.path, file ), 'utf8' ) ).toBe( 'user file' );
		}
	}

	it( 'exports whole databases and individual tables without claiming existing site files', async () => {
		await withSiteTransfer( { site: site.path }, async () => {
			await exportDatabaseToFile( site, path.join( root, 'whole.sql' ) );
			expect( await exportDatabaseToMultipleFiles( site, root ) ).toEqual( [
				path.join( root, 'wp_posts.sql' ),
			] );
		} );
		for ( const file of [ 'whole.sql', 'wp_posts.sql' ] ) {
			expect( await readFile( path.join( root, file ), 'utf8' ) ).toBe( 'exported SQL' );
		}
		await expectSiteFilesPreserved();
	} );

	it.each( [ true, false ] )(
		'cleans only its own SQL import staging files on success or failure, success=%s',
		async ( success ) => {
			const input = path.join( root, 'incoming.sql' );
			await writeFile( input, success ? 'import SQL' : 'fail import' );
			const importer = new SQLImporter( {
				extractionDirectory: root,
				wpContentDirectory: '',
				wpConfig: '',
				wpContentFiles: [],
				sqlFiles: [ input ],
			} );
			const result = withSiteTransfer( { site: site.path }, () => importer.import( site ) );
			if ( success ) await expect( result ).resolves.toBeDefined();
			else await expect( result ).rejects.toThrow( 'Database import failed' );
			await expectSiteFilesPreserved();
		}
	);
} );
