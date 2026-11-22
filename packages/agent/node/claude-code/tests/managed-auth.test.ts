import { describe, expect, it } from 'vitest';
import { assessClaudeAuth } from '../auth-status';

describe( 'Claude native account qualification', () => {
	it( 'rejects managed enterprise subscriptions even when native sign-in succeeds', () => {
		expect(
			assessClaudeAuth( {
				loggedIn: true,
				authMethod: 'claude.ai',
				apiProvider: 'firstParty',
				storedClaudeAiLogin: true,
				subscriptionType: 'enterprise',
			} ).qualified
		).toBe( false );
	} );
} );
