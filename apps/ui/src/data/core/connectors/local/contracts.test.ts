import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalConnector } from './index';

describe( 'createLocalConnector server contracts', () => {
	const fetchMock = vi.fn();
	const connector = () => createLocalConnector( { apiBaseUrl: 'http://localhost:8081' } );

	beforeEach( () => {
		vi.clearAllMocks();
		vi.stubGlobal( 'fetch', fetchMock );
	} );

	afterEach( () => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	} );

	it( 'streams only the picked File to its conversation-specific upload', async () => {
		const local = connector();
		const file = new File( [ 'notes' ], 'large notes.txt' );
		fetchMock.mockResolvedValueOnce(
			new Response( JSON.stringify( { path: '/studio/session/file.txt' } ) )
		);
		await expect( local.stageClaudeChatFile( 'chat one', file ) ).resolves.toBe(
			'/studio/session/file.txt'
		);
		expect( fetchMock ).toHaveBeenCalledWith(
			'http://localhost:8081/api/sessions/chat%20one/claude-attachments?name=large+notes.txt&size=5',
			expect.objectContaining( {
				method: 'POST',
				body: file,
				headers: expect.objectContaining( { 'Content-Type': 'application/octet-stream' } ),
			} )
		);
		fetchMock.mockResolvedValueOnce( new Response( null, { status: 204 } ) );
		await local.discardClaudeChatFile( 'chat one', '/studio/session/file.txt' );
		expect( fetchMock ).toHaveBeenLastCalledWith(
			'http://localhost:8081/api/sessions/chat%20one/claude-attachments',
			expect.objectContaining( {
				method: 'DELETE',
				body: JSON.stringify( { path: '/studio/session/file.txt' } ),
			} )
		);
	} );

	it( 'distinguishes global and site catalogs and recovers the requested Claude chat', async () => {
		fetchMock.mockImplementation(
			async () => new Response( JSON.stringify( { status: 'blocked', reason: 'owner-alive' } ) )
		);
		const local = connector();
		await local.getClaudeModelCatalog( 'test account' );
		await local.getClaudeModelCatalog( 'test account', 'local site' );
		await expect( local.recoverClaudeSession( 'chat one' ) ).resolves.toEqual( {
			status: 'blocked',
			reason: 'owner-alive',
		} );
		expect( fetchMock.mock.calls.map( ( [ url ] ) => url ) ).toEqual( [
			'http://localhost:8081/api/claude-code/test%20account/models',
			'http://localhost:8081/api/claude-code/test%20account/models/local%20site',
			'http://localhost:8081/api/sessions/chat%20one/claude-recovery',
		] );
		expect( fetchMock.mock.calls[ 2 ][ 1 ].method ).toBe( 'POST' );
	} );

	it( 'waits for the server to delete all previews and propagates failures', async () => {
		fetchMock.mockResolvedValueOnce( new Response( null, { status: 204 } ) );
		await expect( connector().deleteAllSnapshots() ).resolves.toBeUndefined();
		expect( fetchMock ).toHaveBeenCalledWith(
			'http://localhost:8081/api/snapshots',
			expect.objectContaining( { method: 'DELETE' } )
		);
		fetchMock.mockResolvedValueOnce(
			new Response( JSON.stringify( { error: 'Preview deletion failed' } ), { status: 500 } )
		);
		await expect( connector().deleteAllSnapshots() ).rejects.toThrow( 'Preview deletion failed' );
	} );

	it( 'remembers the AI provider through the shared settings endpoint', async () => {
		fetchMock.mockResolvedValue(
			new Response( JSON.stringify( { provider: 'anthropic-api-key', hasAnthropicApiKey: true } ) )
		);
		await expect( connector().setAiProvider( 'anthropic-api-key' ) ).resolves.toMatchObject( {
			provider: 'anthropic-api-key',
		} );
		expect( fetchMock ).toHaveBeenCalledWith(
			'http://localhost:8081/api/ai-settings/provider',
			expect.objectContaining( {
				method: 'PUT',
				body: JSON.stringify( { provider: 'anthropic-api-key' } ),
			} )
		);
	} );

	it( 'saves and clears custom titles through the existing session metadata endpoint', async () => {
		fetchMock.mockResolvedValue(
			new Response( JSON.stringify( { id: 'chat-1', title: 'Homepage polish' } ) )
		);
		const local = connector();
		await expect(
			local.updateSessionMetadata( 'chat-1', { title: 'Homepage polish' } )
		).resolves.toMatchObject( { title: 'Homepage polish' } );
		expect( fetchMock ).toHaveBeenLastCalledWith(
			'http://localhost:8081/api/sessions/chat-1',
			expect.objectContaining( {
				method: 'PATCH',
				body: JSON.stringify( { title: 'Homepage polish' } ),
			} )
		);
		fetchMock.mockResolvedValue( new Response( JSON.stringify( { id: 'chat-1' } ) ) );
		await local.updateSessionMetadata( 'chat-1', { title: '' } );
		expect( fetchMock ).toHaveBeenLastCalledWith(
			'http://localhost:8081/api/sessions/chat-1',
			expect.objectContaining( { method: 'PATCH', body: JSON.stringify( { title: '' } ) } )
		);
	} );

	it( 'forwards app-wide skill reads, installs and removals to the local server', async () => {
		fetchMock.mockImplementation( async ( input ) =>
			String( input ).endsWith( '/api/skills' )
				? new Response( JSON.stringify( [ { id: 'studio-cli', installed: true } ] ) )
				: new Response( null, { status: 204 } )
		);
		const local = connector();
		await expect( local.getWordPressSkillsStatusAllSites() ).resolves.toEqual( [
			{ id: 'studio-cli', installed: true },
		] );
		await local.installWordPressSkillToAllSites( 'studio-cli' );
		await local.removeWordPressSkillFromAllSites( 'studio-cli' );
		expect( fetchMock ).toHaveBeenCalledWith(
			'http://localhost:8081/api/skills/studio-cli',
			expect.objectContaining( { method: 'POST' } )
		);
		expect( fetchMock ).toHaveBeenCalledWith(
			'http://localhost:8081/api/skills/studio-cli',
			expect.objectContaining( { method: 'DELETE' } )
		);
	} );

	it( 'uses the CLI copy-token redirect when the server has no OAuth client', async () => {
		fetchMock.mockImplementation( async ( input ) =>
			String( input ).includes( '/auth/login-url' )
				? new Response( JSON.stringify( { url: null } ) )
				: new Response( JSON.stringify( { id: 1 } ) )
		);
		const open = vi.spyOn( window, 'open' ).mockReturnValue( null );
		vi.spyOn( window, 'prompt' ).mockReturnValue( '  test-token  ' );
		await connector().authenticate();
		const url = new URL( String( open.mock.calls.at( -1 )![ 0 ] ) );
		expect( url.searchParams.get( 'redirect_uri' ) ).toBe(
			'https://developer.wordpress.com/copy-oauth-token'
		);
		expect( fetchMock ).toHaveBeenLastCalledWith(
			'http://localhost:8081/api/auth/login',
			expect.objectContaining( { method: 'POST', body: JSON.stringify( { token: 'test-token' } ) } )
		);
	} );

	it( 'does not store a token when the paste flow is cancelled', async () => {
		fetchMock.mockResolvedValue( new Response( JSON.stringify( { url: null } ) ) );
		vi.spyOn( window, 'open' ).mockReturnValue( null );
		vi.spyOn( window, 'prompt' ).mockReturnValue( null );
		await connector().authenticate();
		expect( fetchMock ).not.toHaveBeenCalledWith(
			'http://localhost:8081/api/auth/login',
			expect.anything()
		);
	} );

	it( 'persists session environments through the local server', async () => {
		fetchMock.mockResolvedValue( new Response( null, { status: 204 } ) );
		await expect( connector().setSessionEnvironment( 'chat', 'live' ) ).resolves.toBeUndefined();
		expect( fetchMock ).toHaveBeenCalledWith(
			'http://localhost:8081/api/sessions/chat/environment',
			expect.objectContaining( {
				method: 'POST',
				body: JSON.stringify( { environment: 'live' } ),
			} )
		);
	} );
} );
