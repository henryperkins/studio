import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { inspectClaudeConfiguration } from '../configuration';

describe( 'Claude routing settings', () => {
	it.each( [
		{ apiKeyHelper: 'secret helper' },
		{ env: { ANTHROPIC_BASE_URL: 'private endpoint' } },
	] )( 'blocks a routing override without returning its value', async ( contents ) => {
		const dir = await mkdtemp( path.join( os.tmpdir(), 'studio-claude-settings-' ) );
		try {
			await mkdir( path.join( dir, '.claude' ) );
			await writeFile( path.join( dir, '.claude', 'settings.json' ), JSON.stringify( contents ) );
			const result = await inspectClaudeConfiguration( dir, dir );
			expect( result.blockers ).toContain( 'settings-routing-override' );
			expect( JSON.stringify( result ) ).not.toContain( 'private endpoint' );
			expect( JSON.stringify( result ) ).not.toContain( 'secret helper' );
		} finally {
			await rm( dir, { recursive: true, force: true } );
		}
	} );
} );
