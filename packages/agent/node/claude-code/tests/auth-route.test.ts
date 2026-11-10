import { describe, expect, it } from 'vitest';
import { compareClaudeExecutionAuth } from '../auth-status';

describe( 'SDK billing route comparison', () => {
	const native = { email: 'test@example.test', subscriptionType: 'max' };
	const sdk = { email: native.email, subscriptionType: 'Claude Max', apiProvider: 'firstParty' };

	it( 'rejects an unexpected SDK token source even when account email matches', () => {
		expect(
			compareClaudeExecutionAuth( native, {
				...sdk,
				tokenSource: 'environment',
			} )
		).toBe( false );
	} );

	it( 'accepts the observed first-party account with a matching native plan', () => {
		expect( compareClaudeExecutionAuth( native, sdk ) ).toBe( true );
	} );

	it.each( [ undefined, '', 'Enterprise', 'Claude Pro' ] )(
		'blocks matching email without the expected SDK subscription signal (%s)',
		( subscriptionType ) => {
			expect( compareClaudeExecutionAuth( native, { ...sdk, subscriptionType } ) ).toBe( false );
		}
	);

	it( 'blocks an empty reported API key source', () => {
		expect( compareClaudeExecutionAuth( native, { ...sdk, apiKeySource: '' } ) ).toBe( false );
	} );
} );
