import { fireEvent, screen, waitFor } from '@testing-library/react';
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
} );
