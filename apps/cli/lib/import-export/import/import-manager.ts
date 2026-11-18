import fs from 'fs';
import os from 'os';
import path from 'path';
import {
	BackupExtractEvents,
	ImporterEvents,
	ValidatorEvents,
} from '@studio/common/lib/import-export-events';
import { __ } from '@wordpress/i18n';
import { SiteData } from 'cli/lib/cli-config/core';
import {
	checkSiteTransferTree,
	copyTransferFile,
	hasSiteTransferScope,
} from 'cli/lib/site-transfer-paths';
import { resetSqliteJournalModeToRollback } from 'cli/lib/sqlite-journal-mode';
import { LoggerError } from 'cli/logger';
import { ImportExportEventEmitter } from '../events';
import { BackupHandlerFactory } from './handlers/backup-handler-factory';
import {
	Importer,
	ImporterResult,
	JetpackImporter,
	LocalImporter,
	PlaygroundImporter,
	SQLImporter,
	WpressImporter,
} from './importers/importer';
import { WxrImporter } from './importers/wxr-importer';
import { BackupArchiveInfo, NewImporter } from './types';
import { JetpackValidator } from './validators/jetpack-validator';
import { LocalValidator } from './validators/local-validator';
import { PlaygroundValidator } from './validators/playground-validator';
import { SqlValidator } from './validators/sql-validator';
import { Validator } from './validators/validator';
import { WpressValidator } from './validators/wpress-validator';
import { XmlValidator } from './validators/xml-validator';

interface ImporterOption {
	validator: Validator;
	importer: NewImporter;
}

function selectImporter(
	allFiles: string[],
	extractionDirectory: string,
	options: ImporterOption[]
): Importer | null {
	for ( const { validator, importer } of options ) {
		if ( validator.canHandle( allFiles ) ) {
			const files = validator.parseBackupContents( allFiles, extractionDirectory );
			return new importer( files );
		}
	}
	return null;
}

class BackupImporter extends ImportExportEventEmitter implements Importer {
	constructor(
		private backupFile: BackupArchiveInfo,
		private importerOptions: ImporterOption[]
	) {
		super();
	}

	async import( site: SiteData ): Promise< ImporterResult > {
		if ( ! hasSiteTransferScope() ) return this.importArchive( site, this.backupFile );
		// The handlers reopen the archive during detection, validation and extraction.
		// All three must consume the same file that passed the link checks.
		const directory = await fs.promises.mkdtemp( path.join( os.tmpdir(), 'studio_import-' ) );
		try {
			const archive = {
				...this.backupFile,
				path: path.join( directory, path.basename( this.backupFile.path ) ),
			};
			await copyTransferFile( this.backupFile.path, archive.path );
			return await this.importArchive( site, archive );
		} finally {
			await fs.promises.rm( directory, { recursive: true, force: true } );
		}
	}

	private async importArchive(
		site: SiteData,
		archive: BackupArchiveInfo
	): Promise< ImporterResult > {
		const backupHandler = BackupHandlerFactory.create( archive );
		if ( ! backupHandler ) {
			throw new LoggerError(
				__( 'No suitable backup handler found for the provided backup file' ),
				undefined,
				'no_backup_handler'
			);
		}

		const extractionDirectory = await fs.promises.mkdtemp(
			path.join( os.tmpdir(), 'studio_backup' )
		);

		try {
			const fileList = await backupHandler.listFiles( archive );
			this.emit( ValidatorEvents.IMPORT_VALIDATION_START );
			const importer = selectImporter( fileList, extractionDirectory, this.importerOptions );

			if ( ! importer ) {
				throw new LoggerError(
					__( 'No suitable importer found for the provided backup contents' ),
					undefined,
					'no_importer_found'
				);
			}
			this.emit( ValidatorEvents.IMPORT_VALIDATION_COMPLETE );

			for ( const eventName of Object.values( BackupExtractEvents ) ) {
				backupHandler.on( eventName, ( data ) => this.emit( eventName, data ) );
			}

			for ( const eventName of Object.values( ImporterEvents ) ) {
				importer.on( eventName, ( data ) => this.emit( eventName, data ) );
			}

			try {
				await backupHandler.extractFiles( archive, extractionDirectory );
			} catch ( error ) {
				// Tag extraction failures for analytics at the single funnel every backup handler
				// passes through, so the `extract` code is attached in both IPC and logger modes.
				// Errors that already carry a code (e.g. the wpress handler's `file_not_found`)
				// keep their more specific one.
				if ( error instanceof LoggerError && error.code ) {
					throw error;
				}
				throw new LoggerError( __( 'Failed to extract backup' ), error, 'extract' );
			}

			await checkSiteTransferTree( site.path );
			const result = await importer.import( site );

			// Normalize the freshly written database before the caller restarts the
			// server: the single point every importer and both `import` and `pull`
			// funnel through. Site start does the same conversion, but doing it here
			// keeps the imported database ready for whoever opens it first.
			await resetSqliteJournalModeToRollback( site.path );

			return result;
		} finally {
			await fs.promises.rm( extractionDirectory, { recursive: true } );
		}
	}
}

export function getImporter( backupFile: BackupArchiveInfo, options: ImporterOption[] ): Importer {
	return new BackupImporter( backupFile, options );
}

export const DEFAULT_IMPORTER_OPTIONS: ImporterOption[] = [
	{ validator: new PlaygroundValidator(), importer: PlaygroundImporter },
	{ validator: new JetpackValidator(), importer: JetpackImporter },
	{ validator: new LocalValidator(), importer: LocalImporter },
	{ validator: new SqlValidator(), importer: SQLImporter },
	{ validator: new XmlValidator(), importer: WxrImporter },
	{ validator: new WpressValidator(), importer: WpressImporter },
];
