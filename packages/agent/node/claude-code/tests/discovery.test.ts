import { describe, expect, it } from 'vitest';
import { inspectClaudeExecutable } from '../discovery';

describe( 'Claude executable selection', () => {
	it( 'rejects PATH names and command scripts before launch', async () => {
		expect( await inspectClaudeExecutable( 'claude' ) ).toMatchObject( { ok: false } );
		expect( await inspectClaudeExecutable( 'C:\\fake\\claude.cmd' ) ).toMatchObject( {
			ok: false,
		} );
	} );
} );
