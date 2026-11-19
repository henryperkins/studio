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
							version: '2.1.320',
							supportedVersions: [ '2.1.319' ],
							blockers: [ 'version-unqualified' ],
							findings: [ 'project-settings-present' ],
						},
					],
				} ),
			}
		);
		renderApp( { connector, path: '/sites/one?settings=ai' } );
		expect( await screen.findByText( /Select a supported Claude Code version/ ) ).toBeVisible();
		expect( screen.getByText( /Detected configuration: .claude\/settings.json/ ) ).toBeVisible();
		expect( screen.getByText( /Detected Claude Code version 2.1.320/ ) ).toBeVisible();
		expect( screen.getByText( /Supported on this computer: 2.1.319/ ) ).toBeVisible();
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
		connector.configureClaudeRuntime.mockRejectedValueOnce(
			new Error( 'Invalid Claude connection' )
		);
		renderApp( { connector, path: '/sites/one?settings=ai' } );
		const executable = await screen.findByRole( 'textbox', { name: 'Claude executable path' } );
		const config = screen.getByRole( 'textbox', {
			name: 'Claude configuration directory (optional)',
		} );
		fireEvent.change( executable, { target: { value: 'C:\\Missing Claude\\claude.exe' } } );
		fireEvent.change( config, { target: { value: 'C:\\Studio Évidence\\config' } } );
		fireEvent.click( screen.getByRole( 'button', { name: 'Add runtime' } ) );
		expect( await screen.findByText( /Select the full path to the native/ ) ).toBeVisible();
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
		expect( screen.queryByText( /Select the full path to the native/ ) ).not.toBeInTheDocument();
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
			expect(
				within( group ).getByText(
					authMethod === 'none' ? /Signed out of Claude Code/ : /reports API key authentication/
				)
			).toBeVisible();
			expect( within( group ).getByText( /Sign in to a Claude subscription/ ) ).toBeVisible();
			fireEvent.click(
				within( group ).getByRole( 'button', { name: 'Sign in with Claude Code' } )
			);
			await waitFor( () =>
				expect( connector.configureClaudeRuntime ).toHaveBeenCalledExactlyOnceWith( {
					type: 'sign-in',
					connectionId: 'c1',
				} )
			);
			expect(
				await within( group ).findByText( /Complete or cancel sign-in in the Claude Code terminal/ )
			).toBeVisible();
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
		const { queryClient } = renderApp( { connector, path: '/sites/one?settings=ai' } );
		const group = await screen.findByRole( 'group', { name: 'Claude Code Runtime' } );
		expect( within( group ).getByText( /reports Claude.ai authentication/ ) ).toBeVisible();
		queryClient.setQueryData( [ 'claude-models', 'c1', 'one' ], { ok: true, models: [] } );
		connector.getClaudeRuntimeState.mockResolvedValue( {
			enabled: true,
			connections: [
				{ ...connection, authMethod: 'apiKey', blockers: [ 'native-auth-unqualified' ] },
			],
		} );
		fireEvent.click( within( group ).getByRole( 'button', { name: 'Recheck status' } ) );
		expect( await within( group ).findByText( /reports API key authentication/ ) ).toBeVisible();
		expect( within( group ).getByText( /Sign in to a Claude subscription/ ) ).toBeVisible();
		expect(
			within( group ).queryByText( /reports Claude.ai authentication/ )
		).not.toBeInTheDocument();
		expect( queryClient.getQueryState( [ 'claude-models', 'c1', 'one' ] )?.isInvalidated ).toBe(
			true
		);
		expect( connector.configureClaudeRuntime ).not.toHaveBeenCalled();
	} );

	it( 'offers a retry when the first settings read fails and shows the separate image service account', async () => {
		const connector = createFakeConnector( {
			sites: [ makeSite( { id: 'one' } ) ],
			claudeRuntime: { enabled: true, connections: [] },
			imageService: {
				available: true,
				service: 'wordpress-com',
				credential: 'wordpress-com-login',
				account: { displayName: 'Image Account', email: 'image@example.test' },
			},
		} );
		connector.getClaudeRuntimeState.mockRejectedValue( new Error( 'Offline' ) );
		renderApp( { connector, path: '/sites/one?settings=ai' } );
		const group = await screen.findByRole( 'group', { name: 'Claude Code Runtime' } );
		expect( await within( group ).findByRole( 'alert' ) ).toHaveTextContent( /could not read/ );
		connector.getClaudeRuntimeState.mockResolvedValue( { enabled: true, connections: [] } );
		fireEvent.click( within( group ).getByRole( 'button', { name: 'Recheck status' } ) );
		expect(
			await within( group ).findByText(
				/WordPress.com image service as Image Account \(image@example.test\)/
			)
		).toBeVisible();
		expect( within( group ).queryByRole( 'alert' ) ).not.toBeInTheDocument();
	} );

	it( 'explains a terminal launch failure at the saved connection and lets the user retry', async () => {
		const connector = createFakeConnector( {
			sites: [ makeSite( { id: 'one' } ) ],
			imageService: {
				available: false,
				service: 'wordpress-com',
				reason: 'signed-out',
				setup: 'wordpress-com-login',
			},
			claudeRuntime: {
				enabled: true,
				connections: [ { id: 'c1', executablePath: '/opt/claude', findings: [], blockers: [] } ],
			},
		} );
		connector.configureClaudeRuntime.mockRejectedValueOnce(
			new Error( 'Error invoking remote method: Error: claude-sign-in-action-required:no-terminal' )
		);
		renderApp( { connector, path: '/sites/one?settings=ai' } );
		const group = await screen.findByRole( 'group', { name: 'Claude Code Runtime' } );
		await within( group ).findByText(
			/Log in to WordPress.com to generate images in Claude chats/
		);
		const button = within( group ).getByRole( 'button', { name: 'Sign in with Claude Code' } );
		fireEvent.click( button );
		const message = await within( group ).findByText( /Allow Studio to open a terminal/ );
		expect( message.closest( 'form' ) ).toBeNull();
		fireEvent.click( button );
		expect( await within( group ).findByText( /Complete or cancel sign-in/ ) ).toBeVisible();
	} );
} );
