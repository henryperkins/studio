import { createWriteStream } from 'fs';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { ZipArchive } from 'archiver';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as bundled from 'cli/lib/dependency-management/paths';
import { runWpCliCommand, type WpCliResponse } from 'cli/lib/run-wp-cli-command';
import { archiveSiteContent, listArchiveEntries } from '../archive';
import { DefaultExporter } from '../import-export/export/exporters/default-exporter';
import { BackupHandlerTarGz } from '../import-export/import/handlers/backup-handler-tar-gz';
import { BackupHandlerZip } from '../import-export/import/handlers/backup-handler-zip';
import { WxrImporter } from '../import-export/import/importers/wxr-importer';
import { preparePreviewArchive } from '../preview-archive';
import { checkSiteTransferTree, copyTransferFile, withSiteTransfer } from '../site-transfer-paths';
import type { SiteData } from 'cli/lib/cli-config/core';

vi.mock( 'cli/lib/run-wp-cli-command' );

function mockCommandResult() {
	return {
		response: {
			exitCode: Promise.resolve( 0 ),
			stdoutText: Promise.resolve( '[]' ),
			stderrText: Promise.resolve( '' ),
		} as WpCliResponse,
		[ Symbol.dispose ]: vi.fn(),
	};
}

describe( 'file links in a bounded site transfer', () => {
	let parent: string;
	let site: string;
	let outside: string;

	beforeEach( async () => {
		parent = await realpath( await mkdtemp( path.join( os.tmpdir(), 'studio-transfer-' ) ) );
		site = path.join( parent, 'site' );
		outside = path.join( parent, 'elsewhere' );
		await mkdir( path.join( site, 'wp-content', 'languages' ), { recursive: true } );
		await mkdir( outside );
		await writeFile( path.join( outside, 'example' ), 'original' );
	} );
	afterEach( async () => {
		vi.restoreAllMocks();
		await rm( parent, { recursive: true, force: true } );
	} );

	it( 'isolates simultaneous previews and preserves a pre-existing temporary archive after refusal', async () => {
		vi.spyOn( os, 'tmpdir' ).mockReturnValue( parent );
		vi.spyOn( Date, 'now' ).mockReturnValue( 1234 );
		const existing = path.join( parent, 'site-1234.zip' );
		await writeFile( existing, 'earlier preview' );
		let first = '';
		let second = '';
		await expect(
			withSiteTransfer( { site }, async () => {
				await using preview = await preparePreviewArchive( site );
				await using other = await preparePreviewArchive( site );
				first = preview.path;
				second = other.path;
				expect( path.dirname( first ) ).not.toBe( path.dirname( second ) );
				await writeFile( first, 'one' );
				await writeFile( second, 'two' );
				throw new Error( 'preview refused' );
			} )
		).rejects.toThrow( 'preview refused' );
		expect( await readFile( existing, 'utf8' ) ).toBe( 'earlier preview' );
		for ( const file of [ first, second ] ) {
			await expect( realpath( path.dirname( file ) ) ).rejects.toMatchObject( { code: 'ENOENT' } );
		}
	} );

	it.each( [ 'backup.zip', 'languages/backup.zip' ] )(
		'excludes its own output at wp-content/%s from a real site backup',
		async ( name ) => {
			vi.spyOn( os, 'tmpdir' ).mockReturnValue( parent );
			vi.mocked( runWpCliCommand ).mockResolvedValue( mockCommandResult() );
			const backup = path.join( site, 'wp-content', name );
			await writeFile( path.join( site, 'wp-content', 'languages', 'plain.txt' ), 'example' );
			const exporter = new DefaultExporter( {
				site: { id: 'fixture', name: 'Fixture', path: site, port: 8080 } as SiteData,
				backupFile: backup,
				phpVersion: '8.3',
				includes: { wpContent: true, database: false },
			} );
			await withSiteTransfer( { site, archive: backup }, () => exporter.export() );
			const entries = await new BackupHandlerZip().listFiles( {
				path: backup,
				type: 'application/zip',
			} );
			expect( entries.sort() ).toEqual( [ 'meta.json', 'wp-content/languages/plain.txt' ] );
		}
	);

	it( 'stages WXR in its own directory and leaves an existing staging-path junction alone', async () => {
		const oldStaging = path.join( site, '.studio-wxr-import' );
		await symlink( outside, oldStaging, 'junction' );
		const wxr = path.join( parent, 'content.xml' );
		const driver = path.join( parent, 'driver.php' );
		const plugin = path.join( parent, 'bundled-plugin' );
		await writeFile( wxr, '<rss />' );
		await writeFile( driver, 'fixture driver' );
		await mkdir( plugin );
		await writeFile( path.join( plugin, 'plugin.php' ), 'fixture plugin' );
		vi.spyOn( bundled, 'getBundledWxrImportScriptPath' ).mockReturnValue( driver );
		vi.spyOn( bundled, 'getBundledWordPressImporterPath' ).mockReturnValue( plugin );
		let staging = '';
		vi.mocked( runWpCliCommand ).mockImplementationOnce( async ( _site, argv ) => {
			const stagedDriver = path.join( site, argv[ 2 ] );
			const stagedXml = path.join( site, argv[ 3 ] );
			staging = path.dirname( stagedDriver );
			expect( path.dirname( staging ) ).toBe( site );
			expect( staging ).not.toBe( oldStaging );
			expect( await readFile( stagedDriver, 'utf8' ) ).toBe( 'fixture driver' );
			expect( await readFile( stagedXml, 'utf8' ) ).toBe( '<rss />' );
			return mockCommandResult();
		} );
		const importer = new WxrImporter( {
			extractionDirectory: parent,
			sqlFiles: [],
			wpConfig: '',
			wpContentFiles: [],
			wpContentDirectory: '',
			wxrFiles: [ wxr ],
		} );
		await withSiteTransfer( { site }, () =>
			importer.import( { id: 'fixture', path: site } as SiteData )
		);
		expect( await readFile( path.join( oldStaging, 'example' ), 'utf8' ) ).toBe( 'original' );
		await expect( realpath( staging ) ).rejects.toMatchObject( { code: 'ENOENT' } );
	} );

	it( 'refuses an external directory link in a preserved import destination', async () => {
		await symlink( outside, path.join( site, 'wp-content', 'languages', 'linked' ), 'junction' );
		await expect(
			withSiteTransfer( { site }, () => checkSiteTransferTree( site ) )
		).rejects.toThrow( /link/i );
		expect( await readFile( path.join( outside, 'example' ), 'utf8' ) ).toBe( 'original' );
	} );

	it( 'refuses an archive operand or a configuration file that shares another file’s contents by hard link', async () => {
		const archive = path.join( parent, 'backup.sql' );
		await link( path.join( outside, 'example' ), archive );
		await expect(
			withSiteTransfer( { site, archive }, () => checkSiteTransferTree( site ) )
		).rejects.toThrow( /link/i );
		await link( path.join( outside, 'example' ), path.join( site, 'wp-config.php' ) );
		await expect(
			withSiteTransfer( { site }, () => checkSiteTransferTree( site ) )
		).rejects.toThrow( /link/i );
	} );

	it( 'rejects a hard-link archive entry before extraction', async () => {
		const input = path.join( parent, 'source' );
		const archive = path.join( parent, 'backup.tar' );
		const extraction = path.join( parent, 'extraction' );
		await mkdir( input );
		await mkdir( extraction );
		await writeFile( path.join( input, 'first' ), 'fixture' );
		await link( path.join( input, 'first' ), path.join( input, 'second' ) );
		await tar.c( { file: archive, cwd: input }, [ 'first', 'second' ] );
		const file = { path: archive, type: 'application/tar' };
		const handler = new BackupHandlerTarGz();
		await expect(
			withSiteTransfer( { site }, () => handler.extractFiles( file, extraction ) )
		).rejects.toThrow( /link/i );
		await expect( readFile( path.join( extraction, 'first' ) ) ).rejects.toMatchObject( {
			code: 'ENOENT',
		} );
		await expect( handler.listFiles( file ) ).resolves.toContain( 'second' );
	} );

	it( 'keeps ordinary preview support for linked plugins and rechecks a restricted preview as it lists files', async () => {
		const plugins = path.join( site, 'wp-content', 'plugins' );
		await mkdir( plugins );
		const list = () => listArchiveEntries( site, { onWpcom: false } );
		await expect(
			withSiteTransfer( { site }, async () => {
				await symlink( outside, path.join( plugins, 'demo' ), 'junction' );
				return list();
			} )
		).rejects.toThrow( /link/i );
		await expect( list() ).resolves.toContainEqual( {
			name: 'wp-content/plugins/demo/example',
			sourcePath: path.join( outside, 'example' ),
		} );
	} );

	it( 'exports and restores ordinary preview file bytes', async () => {
		const archive = path.join( parent, 'preview.zip' );
		const contents = Buffer.from( [ 0, 1, 127, 255 ] );
		await writeFile( path.join( site, 'wp-content', 'languages', 'ordinary.bin' ), contents );
		const extraction = path.join( parent, 'restored' );
		await mkdir( extraction );
		await withSiteTransfer( { site }, async () => {
			await archiveSiteContent( site, archive, { onWpcom: false } );
			await new BackupHandlerZip().extractFiles(
				{ path: archive, type: 'application/zip' },
				extraction
			);
			const source = path.join( extraction, 'wp-content', 'languages', 'ordinary.bin' );
			const destination = path.join( site, 'wp-content', 'restored.bin' );
			await copyTransferFile( source, destination );
			expect( await readFile( destination ) ).toEqual( contents );
			const occupied = path.join( site, 'wp-content', 'languages', 'existing' );
			await link( path.join( outside, 'example' ), occupied );
			await expect( copyTransferFile( source, occupied ) ).rejects.toThrow( /link/i );
			expect( await readFile( path.join( outside, 'example' ), 'utf8' ) ).toBe( 'original' );
		} );
	} );

	it( 'refuses a ZIP entry marked as a symbolic link and accepts plain archive files', async () => {
		const zip = new ZipArchive();
		const output = path.join( parent, 'backup.zip' );
		const finished = pipeline( zip, createWriteStream( output ) );
		zip.append( 'ordinary', { name: 'wp-content/plain.txt' } );
		zip.symlink( 'wp-content/link', 'plain.txt' );
		await zip.finalize();
		await finished;
		const handler = new BackupHandlerZip();
		const file = { path: output, type: 'application/zip' };
		await expect(
			withSiteTransfer( { site, archive: output }, () => handler.listFiles( file ) )
		).rejects.toThrow( /link/i );
		await expect( handler.listFiles( file ) ).resolves.toContain( 'wp-content/plain.txt' );
	} );
} );
