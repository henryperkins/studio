import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSameClaudeAccount } from '../auth-status';
import { readClaudeAccountStatus, resolveClaudeConfigContext } from '../connection';

describe( 'Claude config context', () => {
	it( 'preserves default mode and blocks conflicting inherited directories', () => {
		expect( resolveClaudeConfigContext( undefined, {} ) ).toEqual( { mode: 'default' } );
		expect(
			resolveClaudeConfigContext( 'C:\\selected', { CLAUDE_CONFIG_DIR: 'C:\\other' } )
		).toEqual( { mode: 'conflict' } );
	} );
} );

describe( 'Claude account status', () => {
	afterEach( () => vi.unstubAllEnvs() );
	// Inherited routing variables would make every read unverifiable.
	const isolate = () => {
		for ( const name of Object.keys( process.env ) )
			if ( /^(ANTHROPIC_|AWS_|GOOGLE_|AZURE_|CLAUDE_)|_PROXY$/i.test( name ) )
				vi.stubEnv( name, '' );
	};
	const signedIn = {
		loggedIn: true,
		authMethod: 'claude.ai',
		apiProvider: 'firstParty',
		storedClaudeAiLogin: true,
		subscriptionType: 'max',
		email: 'user@example.com',
		orgName: 'Studio',
	};
	const read = ( run: Parameters< typeof readClaudeAccountStatus >[ 3 ] ) =>
		readClaudeAccountStatus( 'claude', process.cwd(), undefined, run );

	it( 'reads the signed-in account through `claude auth status`', async () => {
		isolate();
		const run = vi.fn( async () => ( { stdout: JSON.stringify( signedIn ) } ) );
		await expect( read( run ) ).resolves.toEqual( {
			state: 'signed-in',
			identity: { email: 'user@example.com', organization: 'Studio', subscriptionType: 'max' },
		} );
		expect( run ).toHaveBeenCalledWith(
			'claude',
			[ 'auth', 'status', '--json' ],
			expect.objectContaining( { timeout: expect.any( Number ) } )
		);
	} );

	it( 'tells a signed-out or unqualified account apart from a status it could not read', async () => {
		isolate();
		const signedOut = Object.assign( new Error( 'exit 1' ), {
			code: 1,
			stdout: JSON.stringify( { loggedIn: false } ),
		} );
		await expect(
			read( async () => {
				throw signedOut;
			} )
		).resolves.toEqual( { state: 'not-qualified' } );
		await expect(
			read( async () => ( { stdout: JSON.stringify( { ...signedIn, authMethod: 'api-key' } ) } ) )
		).resolves.toEqual( { state: 'not-qualified' } );
		for ( const failure of [
			async () => ( { stdout: 'not json' } ),
			async () => {
				throw Object.assign( new Error( 'timed out' ), { killed: true, code: null } );
			},
			async () => {
				throw Object.assign( new Error( 'exit 2' ), { code: 2, stdout: '' } );
			},
		] )
			await expect( read( failure ) ).resolves.toEqual( { state: 'unavailable' } );
		vi.stubEnv( 'ANTHROPIC_BASE_URL', 'https://gateway.example' );
		await expect( read( async () => ( { stdout: JSON.stringify( signedIn ) } ) ) ).resolves.toEqual(
			{ state: 'unavailable' }
		);
	} );

	it( 'compares accounts by address, organization and plan', () => {
		const account = { email: 'User@Example.com', organization: 'Studio', subscriptionType: 'max' };
		expect(
			isSameClaudeAccount( account, {
				...account,
				email: 'user@example.com',
				subscriptionType: 'Claude Max',
			} )
		).toBe( true );
		expect( isSameClaudeAccount( account, { ...account, email: 'other@example.com' } ) ).toBe(
			false
		);
		expect( isSameClaudeAccount( account, { ...account, organization: 'Other' } ) ).toBe( false );
		expect( isSameClaudeAccount( account, { ...account, subscriptionType: 'pro' } ) ).toBe( false );
		expect( isSameClaudeAccount( { ...account, email: undefined }, account ) ).toBe( false );
	} );
} );
