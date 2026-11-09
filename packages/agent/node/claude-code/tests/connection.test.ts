import { describe, expect, it } from 'vitest';
import { resolveClaudeConfigContext } from '../connection';

describe( 'Claude config context', () => {
	it( 'preserves default mode and blocks conflicting inherited directories', () => {
		expect( resolveClaudeConfigContext( undefined, {} ) ).toEqual( { mode: 'default' } );
		expect(
			resolveClaudeConfigContext( 'C:\\selected', { CLAUDE_CONFIG_DIR: 'C:\\other' } )
		).toEqual( { mode: 'conflict' } );
	} );
} );
