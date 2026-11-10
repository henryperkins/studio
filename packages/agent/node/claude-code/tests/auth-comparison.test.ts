import { describe, expect, it } from 'vitest';
import { compareClaudeExecutionAuth } from '../auth-status';

describe( 'SDK authentication comparison', () => {
	it( 'blocks absent identity evidence even when the SDK claims first party', () => {
		expect(
			compareClaudeExecutionAuth( { email: 'test@example.test' }, { apiProvider: 'firstParty' } )
		).toBe( false );
	} );
} );
