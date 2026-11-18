import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanup } from 'cli/lib/archive';
import { createTransferDirectory, hasSiteTransferScope } from 'cli/lib/site-transfer-paths';

export async function preparePreviewArchive( siteFolder: string ) {
	const name = `${ path.basename( siteFolder ) }-${ Date.now() }.zip`;
	if ( hasSiteTransferScope() ) {
		const directory = await createTransferDirectory(
			await realpath( os.tmpdir() ),
			'studio-preview-'
		);
		return { ...directory, path: path.join( directory.path, name ) };
	}
	const archivePath = path.join( os.tmpdir(), name );
	return { path: archivePath, [ Symbol.asyncDispose ]: () => cleanup( archivePath ) };
}
