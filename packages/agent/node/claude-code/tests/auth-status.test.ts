import { describe, expect, it } from 'vitest';
import {
	assessClaudeAuth,
	buildClaudeEnvironment,
	compareClaudeExecutionAuth,
} from '../auth-status';

describe( 'Claude auth preflight', () => {
	it( 'rejects an inherited billing override without revealing its value', () => {
		const result = buildClaudeEnvironment( { PATH: 'safe', anthropic_api_key: 'sensitive' } );
		expect( result.conflicts ).toContain( 'ANTHROPIC_API_KEY' );
		expect( JSON.stringify( result.conflicts ) ).not.toContain( 'sensitive' );
	} );
	it( 'does not treat first-party alone as a signed-in subscription', () => {
		expect( assessClaudeAuth( { loggedIn: false, apiProvider: 'firstParty' } ).qualified ).toBe(
			false
		);
	} );
	it( 'rejects SDK auth identity changes', () => {
		expect(
			compareClaudeExecutionAuth( { email: 'a@example.test' }, { email: 'b@example.test' } )
		).toBe( false );
	} );
} );
