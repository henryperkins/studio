import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { expect, it, vi } from 'vitest';
import { saveClaudeConnection } from '../connection';
import { discoverClaudeModels } from '../runtime';

const executable = process.env.STUDIO_TEST_NATIVE_CLAUDE_EXE;

it.runIf( process.platform === 'win32' && Boolean( executable ) )(
	'discovers model capabilities from a selected native Windows executable without sending input',
	async () => {
		const directory = await mkdtemp( path.join( os.tmpdir(), 'Studio Claude native Évidence ' ) );
		vi.stubEnv( 'STUDIO_EXPERIMENTAL_CLAUDE_CODE', '1' );
		vi.stubEnv( 'DEV_CONFIG_DIR', directory );
		try {
			await saveClaudeConnection( { id: 'native-startup-test', executablePath: executable! } );
			const result = await discoverClaudeModels( 'native-startup-test', directory );
			expect( result.ok ).toBe( true );
			if ( result.ok ) {
				expect( result.models.length ).toBeGreaterThan( 0 );
				expect( result.models.every( ( row ) => row.efforts.length > 0 ) ).toBe( true );
			}
		} finally {
			vi.unstubAllEnvs();
			await rm( directory, { recursive: true, force: true, maxRetries: 4 } );
		}
	},
	40_000
);
