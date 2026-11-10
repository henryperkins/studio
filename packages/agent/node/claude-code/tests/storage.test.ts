import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { readSharedConfig } from '@studio/common/lib/shared-config';
import { afterEach, describe, expect, it } from 'vitest';
import { disconnectClaudeConnection, saveClaudeConnection } from '../connection';

const old = process.env.DEV_CONFIG_DIR;
afterEach( () => {
	if ( old === undefined ) delete process.env.DEV_CONFIG_DIR;
	else process.env.DEV_CONFIG_DIR = old;
} );
describe( 'Claude connection storage', () => {
	it( 'detaches only Studio metadata, leaving native credentials untouched', async () => {
		const dir = await mkdtemp( path.join( os.tmpdir(), 'studio-claude-storage-' ) );
		process.env.DEV_CONFIG_DIR = dir;
		try {
			const credentialPath = path.join( dir, 'native-credentials-fixture' );
			await writeFile( credentialPath, 'untouched' );
			await saveClaudeConnection( { id: 'first', executablePath: path.join( dir, 'claude.exe' ) } );
			await saveClaudeConnection( {
				id: 'second',
				executablePath: path.join( dir, 'claude.exe' ),
			} );
			await disconnectClaudeConnection( 'first' );
			expect( ( await readSharedConfig() ).claudeConnections ).toEqual( [
				{ id: 'second', executablePath: path.join( dir, 'claude.exe' ) },
			] );
			expect( await readFile( credentialPath, 'utf8' ) ).toBe( 'untouched' );
		} finally {
			await rm( dir, { recursive: true, force: true } );
		}
	} );
} );
