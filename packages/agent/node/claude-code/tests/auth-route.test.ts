import { describe, expect, it } from 'vitest';
import { compareClaudeExecutionAuth } from '../auth-status';

describe( 'SDK billing route comparison', () => {
	it( 'rejects an unexpected SDK token source even when account email matches', () => {
		const preflight = { email: 'test@example.test' };
		expect(
			compareClaudeExecutionAuth( preflight, {
				email: 'test@example.test',
				apiProvider: 'firstParty',
				tokenSource: 'environment',
			} )
		).toBe( false );
	} );
	it( 'accepts the observed first-party account when the matching email is present', () => {
		expect(
			compareClaudeExecutionAuth(
				{ email: 'test@example.test' },
				{ email: 'test@example.test', apiProvider: 'firstParty' }
			)
		).toBe( true );
	} );
} );
