import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
	disconnectClaudeConnection,
	getClaudeConnections,
	saveClaudeConnection,
} from '../connection';

describe( 'Claude connection identity', () => {
	it( 'does not reuse an existing connection ID for a different executable', async () => {
		const dir = await mkdtemp( path.join( os.tmpdir(), 'studio-claude-id-' ) );
		const old = process.env.DEV_CONFIG_DIR;
		process.env.DEV_CONFIG_DIR = dir;
		try {
			await saveClaudeConnection( { id: 'same', executablePath: path.join( dir, 'one.exe' ) } );
			await expect(
				saveClaudeConnection( { id: 'same', executablePath: path.join( dir, 'two.exe' ) } )
			).rejects.toThrow();
			expect( await getClaudeConnections() ).toEqual( [
				{ id: 'same', executablePath: path.join( dir, 'one.exe' ) },
			] );
			await disconnectClaudeConnection( 'same' );
			await expect(
				saveClaudeConnection( { id: 'same', executablePath: path.join( dir, 'two.exe' ) } )
			).rejects.toThrow();
		} finally {
			if ( old === undefined ) delete process.env.DEV_CONFIG_DIR;
			else process.env.DEV_CONFIG_DIR = old;
			await rm( dir, { recursive: true, force: true } );
		}
	} );
} );
