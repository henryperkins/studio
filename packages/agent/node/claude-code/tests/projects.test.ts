import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { resolveClaudeProjectsDirectory } from '../connection';

describe( 'Claude projects directory', () => {
	it( 'accepts a missing projects directory only at the expected config location', async () => {
		const config = await mkdtemp( path.join( os.tmpdir(), 'studio-claude-projects-' ) );
		try {
			expect(
				await resolveClaudeProjectsDirectory( config, path.join( config, 'projects' ) )
			).toBe( path.join( config, 'projects' ) );
			await expect(
				resolveClaudeProjectsDirectory( config, path.join( config, 'other' ) )
			).rejects.toThrow();
		} finally {
			await rm( config, { recursive: true, force: true } );
		}
	} );
} );
