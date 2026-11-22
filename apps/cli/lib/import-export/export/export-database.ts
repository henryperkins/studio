import path from 'path';
import { DEFAULT_PHP_VERSION } from '@studio/common/constants';
import { generateBackupFilename } from '@studio/common/lib/generate-backup-filename';
import { parseJsonFromPhpOutput } from '@studio/common/lib/php-output-parser';
import { __, sprintf } from '@wordpress/i18n';
import { move } from 'fs-extra';
import { runWpCliCommand } from 'cli/lib/run-wp-cli-command';
import {
	checkTransferFile,
	createTransferDirectory,
	hasSiteTransferScope,
	requirePlainTransferEntry,
} from 'cli/lib/site-transfer-paths';
import { replaceMysql8OnlyCollations } from 'cli/lib/sqlite-collations';
import { summarizeWpCliStderr } from 'cli/lib/wp-cli-stderr';
import { LoggerError } from 'cli/logger';
import type { SiteData } from 'cli/lib/cli-config/core';

async function createDatabaseExportError(
	message: string,
	stderrText: Promise< string >
): Promise< LoggerError > {
	const stderr = ( await stderrText ).trim();
	if ( ! stderr ) {
		return new LoggerError( message, undefined, 'database_export' );
	}
	console.error( message, stderr );
	return new LoggerError( message, new Error( summarizeWpCliStderr( stderr ) ), 'database_export' );
}

export async function exportDatabaseToFile(
	site: SiteData,
	finalDestination: string
): Promise< void > {
	await using scratch = hasSiteTransferScope()
		? await createTransferDirectory( site.path, '.studio-sql-' )
		: undefined;
	const tempFileName = scratch
		? path.posix.join( path.basename( scratch.path ), 'database.sql' )
		: `${ generateBackupFilename( 'db-export' ) }.sql`;
	const tempFilePath = path.join( site.path, tempFileName );

	// Exports don't start the site, so the start-time collation fix may not have run yet.
	await replaceMysql8OnlyCollations( site.path );

	// Execute the command to export directly to a temp file in the site directory (cwd).
	await checkTransferFile( tempFilePath, true );
	await using command = await runWpCliCommand(
		site,
		[ 'sqlite', 'export', tempFileName, '--enable-ast-driver', '--skip-plugins', '--skip-themes' ],
		{
			requireSqliteCliCommand: true,
			phpVersion: DEFAULT_PHP_VERSION,
		}
	);

	const exitCode = await command.response.exitCode;
	if ( exitCode !== 0 ) {
		throw await createDatabaseExportError(
			__( 'Database export failed' ),
			command.response.stderrText
		);
	}

	await checkTransferFile( tempFilePath );
	await checkTransferFile( finalDestination, true );
	await move( tempFilePath, finalDestination );
}

export async function exportDatabaseToMultipleFiles(
	site: SiteData,
	finalDestinationDir: string
): Promise< string[] > {
	await replaceMysql8OnlyCollations( site.path );

	await using command = await runWpCliCommand(
		site,
		[
			'sqlite',
			'tables',
			'--format=json',
			'--enable-ast-driver',
			'--skip-plugins',
			'--skip-themes',
		],
		{
			requireSqliteCliCommand: true,
			phpVersion: DEFAULT_PHP_VERSION,
		}
	);

	const tablesStdout = await command.response.stdoutText;
	const exitCode = await command.response.exitCode;
	if ( exitCode !== 0 ) {
		throw await createDatabaseExportError(
			__( 'Database export failed' ),
			command.response.stderrText
		);
	}

	let tables;

	try {
		tables = parseJsonFromPhpOutput( tablesStdout );
	} catch ( error ) {
		console.error(
			sprintf( __( 'Could not get list of database tables. The WP CLI output: %s' ), tablesStdout )
		);
		throw new LoggerError(
			__( 'Could not get list of database tables to export.' ),
			undefined,
			'database_export'
		);
	}

	const tmpFiles: string[] = [];
	await using scratch = hasSiteTransferScope()
		? await createTransferDirectory( site.path, '.studio-sql-' )
		: undefined;

	for ( const table of tables ) {
		if ( table === 'wp_users' || table === 'wp_usermeta' ) {
			// Skip the wp_users and wp_usermeta tables as they are not needed
			continue;
		}

		const fileName = `${ table }.sql`;
		requirePlainTransferEntry( fileName, ! fileName.includes( '/' ) );
		const tempFileName = scratch
			? path.posix.join( path.basename( scratch.path ), fileName )
			: fileName;
		const tempFilePath = path.join( site.path, tempFileName );
		await checkTransferFile( tempFilePath, true );

		// Execute the command to export directly to a temporary file in the project directory
		await using command = await runWpCliCommand(
			site,
			[
				'sqlite',
				'export',
				tempFileName,
				`--tables=${ table }`,
				'--enable-ast-driver',
				'--skip-plugins',
				'--skip-themes',
			],
			{
				requireSqliteCliCommand: true,
				phpVersion: DEFAULT_PHP_VERSION,
			}
		);

		const exitCode = await command.response.exitCode;
		if ( exitCode !== 0 ) {
			throw await createDatabaseExportError(
				sprintf( __( 'Database export failed for table %s' ), table ),
				command.response.stderrText
			);
		}

		const finalDestination = path.join( finalDestinationDir, fileName );
		await checkTransferFile( tempFilePath );
		await checkTransferFile( finalDestination, true );
		await move( tempFilePath, finalDestination );

		tmpFiles.push( finalDestination );
	}

	return tmpFiles;
}
