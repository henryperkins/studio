import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createFakeConnector, makeSite } from '@/test/fake-connector';
import { renderApp } from '@/test/render';

describe( 'Claude Code runtime settings', () => {
	it( 'shows connection findings and disconnects without logging out', async () => {
		const configure = vi.fn( async () => {} );
		const connector = createFakeConnector(
			{ sites: [ makeSite( { id: 'one' } ) ] },
			{
				configureClaudeRuntime: configure,
				getClaudeRuntimeState: async () => ( {
					enabled: true,
					connections: [
						{
							id: 'c1',
							executablePath: 'C:\\Claude\\claude.exe',
							version: '1.0',
							blockers: [ 'Sign in required' ],
							findings: [ 'Billing route cannot be verified' ],
						},
					],
				} ),
			}
		);
		renderApp( { connector, path: '/sites/one?settings=ai' } );
		expect( await screen.findByText( 'Sign in required' ) ).toBeVisible();
		expect( screen.getByText( 'Billing route cannot be verified' ) ).toBeVisible();
		expect( screen.getByText( /Account information is not verified/ ) ).toBeVisible();
		fireEvent.click( screen.getByRole( 'button', { name: 'Disconnect Claude runtime' } ) );
		await waitFor( () =>
			expect( configure ).toHaveBeenCalledWith( {
				type: 'disconnect',
				connectionId: 'c1',
			} )
		);
	} );

	it( 'keeps the entered paths when saving a missing executable fails and allows a retry', async () => {
		const connector = createFakeConnector( {
			sites: [ makeSite( { id: 'one' } ) ],
			claudeRuntime: { enabled: true, connections: [] },
		} );
		connector.configureClaudeRuntime.mockRejectedValueOnce( new Error( 'Executable not found.' ) );
		renderApp( { connector, path: '/sites/one?settings=ai' } );
		const executable = await screen.findByRole( 'textbox', { name: 'Claude executable path' } );
		const config = screen.getByRole( 'textbox', {
			name: 'Claude configuration directory (optional)',
		} );
		fireEvent.change( executable, { target: { value: 'C:\\Missing Claude\\claude.exe' } } );
		fireEvent.change( config, { target: { value: 'C:\\Studio Évidence\\config' } } );
		fireEvent.click( screen.getByRole( 'button', { name: 'Add runtime' } ) );
		expect( await screen.findByText( 'Executable not found.' ) ).toBeVisible();
		expect( executable ).toHaveValue( 'C:\\Missing Claude\\claude.exe' );
		expect( config ).toHaveValue( 'C:\\Studio Évidence\\config' );
		fireEvent.change( executable, { target: { value: 'C:\\Claude\\claude.exe' } } );
		fireEvent.click( screen.getByRole( 'button', { name: 'Add runtime' } ) );
		await waitFor( () =>
			expect( connector.configureClaudeRuntime ).toHaveBeenLastCalledWith( {
				type: 'save',
				executablePath: 'C:\\Claude\\claude.exe',
				configDirectory: 'C:\\Studio Évidence\\config',
			} )
		);
		expect( await screen.findByText( 'C:\\Claude\\claude.exe' ) ).toBeVisible();
		expect( screen.queryByText( 'Executable not found.' ) ).not.toBeInTheDocument();
	} );

	it.each( [ 'none', 'apiKey' ] )(
		'shows unqualified %s authentication and opens native sign-in explicitly',
		async ( authMethod ) => {
			const connector = createFakeConnector( {
				sites: [ makeSite( { id: 'one' } ) ],
				claudeRuntime: {
					enabled: true,
					connections: [
						{
							id: 'c1',
							executablePath: 'C:\\Claude\\claude.exe',
							authMethod,
							blockers: [ 'native-auth-unqualified' ],
							findings: [],
						},
					],
				},
			} );
			renderApp( { connector, path: '/sites/one?settings=ai' } );
			const group = await screen.findByRole( 'group', { name: 'Claude Code Runtime' } );
			expect( within( group ).getByText( authMethod ) ).toBeVisible();
			expect( within( group ).getByText( 'native-auth-unqualified' ) ).toBeVisible();
			fireEvent.click(
				within( group ).getByRole( 'button', { name: 'Sign in with Claude Code' } )
			);
			await waitFor( () =>
				expect( connector.configureClaudeRuntime ).toHaveBeenCalledExactlyOnceWith( {
					type: 'sign-in',
					connectionId: 'c1',
				} )
			);
		}
	);

	it( 'refreshes the runtime findings when its account or billing method changes', async () => {
		const connection = {
			id: 'c1',
			executablePath: 'C:\\Claude\\claude.exe',
			authMethod: 'claude.ai',
			blockers: [] as string[],
			findings: [] as string[],
		};
		const connector = createFakeConnector( {
			sites: [ makeSite( { id: 'one' } ) ],
			claudeRuntime: { enabled: true, connections: [ connection ] },
		} );
		renderApp( { connector, path: '/sites/one?settings=ai' } );
		const group = await screen.findByRole( 'group', { name: 'Claude Code Runtime' } );
		expect( within( group ).getByText( 'claude.ai' ) ).toBeVisible();
		connector.getClaudeRuntimeState.mockResolvedValue( {
			enabled: true,
			connections: [
				{ ...connection, authMethod: 'apiKey', blockers: [ 'native-auth-unqualified' ] },
			],
		} );
		fireEvent.click( within( group ).getByRole( 'button', { name: 'Recheck status' } ) );
		expect( await within( group ).findByText( 'apiKey' ) ).toBeVisible();
		expect( within( group ).getByText( 'native-auth-unqualified' ) ).toBeVisible();
		expect( within( group ).queryByText( 'claude.ai' ) ).not.toBeInTheDocument();
		expect( connector.configureClaudeRuntime ).not.toHaveBeenCalled();
	} );
} );
