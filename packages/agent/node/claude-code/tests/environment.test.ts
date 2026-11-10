import { describe, expect, it } from 'vitest';
import { buildClaudeEnvironment } from '../auth-status';

describe( 'Claude child environment', () => {
	it( 'reports but never passes inherited provider secrets, preserving OS essentials', () => {
		const result = buildClaudeEnvironment( {
			Path: 'path-value',
			ANTHROPIC_API_KEY: 'secret',
			OTHER_SECRET: 'private',
			USERPROFILE: 'profile',
		} );
		expect( result.conflicts ).toContain( 'ANTHROPIC_API_KEY' );
		expect( result.env ).toEqual( { Path: 'path-value', USERPROFILE: 'profile' } );
	} );
} );
