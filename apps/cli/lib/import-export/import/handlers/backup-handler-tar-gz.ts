import fs from 'fs';
import zlib from 'zlib';
import { isGzipFile } from '@studio/common/lib/archive-format';
import { ImportEvents } from '@studio/common/lib/import-export-events';
import * as tar from 'tar';
import { isPlainTransferEntry, unsafeTransfer } from 'cli/lib/site-transfer-paths';
import { ImportExportEventEmitter } from '../../events';
import { BackupArchiveInfo } from '../types';
import { BackupHandler, isFileAllowed } from './backup-handler-factory';

export class BackupHandlerTarGz extends ImportExportEventEmitter implements BackupHandler {
	async listFiles( backup: BackupArchiveInfo ): Promise< string[] > {
		const filesSet = new Set< string >();
		let invalidEntry = false;
		await tar.t( {
			file: backup.path,
			onReadEntry: ( entry ) => {
				if (
					! isPlainTransferEntry(
						entry.path,
						[ 'File', 'OldFile', 'Directory', 'ContiguousFile' ].includes( entry.type )
					)
				) {
					invalidEntry = true;
					return;
				}
				if ( isFileAllowed( entry.path ) ) {
					let path = entry.path;
					if ( entry.path.startsWith( '/' ) ) {
						path = path.slice( 1 );
					}
					filesSet.add( path );
				}
			},
		} );
		if ( invalidEntry ) throw unsafeTransfer();
		return Array.from( filesSet );
	}

	async extractFiles( file: BackupArchiveInfo, extractionDirectory: string ): Promise< void > {
		let totalSize: number;
		let processedSize = 0;
		let processedFiles = 0;
		let currentFile = '';

		try {
			totalSize = fs.statSync( file.path ).size;
		} catch ( error ) {
			this.emit( ImportEvents.BACKUP_EXTRACT_ERROR, error );
			throw error;
		}

		const fileList = await this.listFiles( file );
		const totalFiles = fileList.length;
		let invalidEntry = false;

		return new Promise< void >( ( resolve, reject ) => {
			this.emit( ImportEvents.BACKUP_EXTRACT_START );
			const readStream = fs
				.createReadStream( file.path )
				.on( 'data', ( chunk ) => {
					processedSize += chunk.length;
					this.emit( ImportEvents.BACKUP_EXTRACT_PROGRESS, {
						progress: processedSize / totalSize,
						processedFiles,
						totalFiles,
						currentFile,
						extractedBytes: processedSize,
						totalBytes: totalSize,
					} );
				} )
				.on( 'error', ( error ) => {
					this.emit( ImportEvents.BACKUP_EXTRACT_ERROR, error );
					reject( error );
				} );

			const onGunzipError = ( error: Error ) => {
				this.emit( ImportEvents.BACKUP_EXTRACT_ERROR, error );
				reject( error );
			};

			const tarStream = isGzipFile( file.path )
				? readStream.pipe( zlib.createGunzip().on( 'error', onGunzipError ) )
				: readStream;

			tarStream
				.pipe(
					tar.extract( {
						cwd: extractionDirectory,
						filter: ( name, entry ) => {
							if (
								! isPlainTransferEntry(
									name,
									'type' in entry &&
										[ 'File', 'OldFile', 'Directory', 'ContiguousFile' ].includes( entry.type )
								)
							)
								invalidEntry = true;
							return ! invalidEntry;
						},
						onwarn: ( _code, message ) => {
							this.emit( ImportEvents.BACKUP_EXTRACT_WARNING, message );
						},
						onReadEntry: ( entry ) => {
							if ( isFileAllowed( entry.path ) ) {
								currentFile = entry.path;
								processedFiles++;
								this.emit( ImportEvents.BACKUP_EXTRACT_FILE_START, {
									currentFile,
									processedFiles,
									totalFiles,
								} );
							}
						},
					} )
				)
				.on( 'error', reject )
				.on( 'finish', () => {
					if ( invalidEntry ) {
						reject( unsafeTransfer() );
						return;
					}
					this.emit( ImportEvents.BACKUP_EXTRACT_COMPLETE );
					resolve();
				} );
		} );
	}
}
