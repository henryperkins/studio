import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { readSharedConfig } from '@studio/common/lib/shared-config';
import { afterEach, describe, expect, it } from 'vitest';
import {
	claudeConnectionRevision,
	disconnectClaudeConnection,
	getClaudeConnections,
	markClaudeConnectionReestablished,
	saveClaudeConnection,
} from '../connection';

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

	it( 'moves a connection to a new revision each time it is re-established', async () => {
		const dir = await mkdtemp( path.join( os.tmpdir(), 'studio-claude-storage-' ) );
		process.env.DEV_CONFIG_DIR = dir;
		try {
			const executablePath = path.join( dir, 'claude.exe' );
			await saveClaudeConnection( { id: 'native', executablePath } );
			await saveClaudeConnection( { id: 'other', executablePath } );
			const revisions = async () =>
				( await getClaudeConnections() ).map( ( item ) => claudeConnectionRevision( item ) );
			expect( await revisions() ).toEqual( [ 1, 1 ] );
			await markClaudeConnectionReestablished( 'native' );
			expect( await revisions() ).toEqual( [ 2, 1 ] );
			await markClaudeConnectionReestablished( 'native' );
			expect( await revisions() ).toEqual( [ 3, 1 ] );
			await expect( markClaudeConnectionReestablished( 'missing' ) ).rejects.toThrow();
		} finally {
			await rm( dir, { recursive: true, force: true } );
		}
	} );
} );
