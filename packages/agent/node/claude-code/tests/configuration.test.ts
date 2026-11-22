import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { inspectClaudeConfiguration } from '../connection';

describe( 'Claude configuration qualification', () => {
	it( 'blocks inherited project hooks without returning their contents', async () => {
		const dir = await mkdtemp( path.join( os.tmpdir(), 'studio-claude-' ) );
		try {
			await mkdir( path.join( dir, '.claude' ) );
			await writeFile(
				path.join( dir, '.claude', 'settings.json' ),
				JSON.stringify( { hooks: { secret: 'private command' } } )
			);
			const result = await inspectClaudeConfiguration( dir, dir );
			expect( result.findings ).toContain( 'project-settings-present' );
			expect( result.blockers ).toEqual( [] );
			expect( JSON.stringify( result ) ).not.toContain( 'private command' );
		} finally {
			await rm( dir, { recursive: true, force: true } );
		}
	} );
} );
