import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFakeConnector, makeSite } from '@/test/fake-connector';
import { renderApp } from '@/test/render';

async function setupChat( siteId?: string ) {
	const connector = createFakeConnector( {
		sites: [ makeSite( { id: 'local', name: 'Example' } ) ],
		claudeRuntime: {
			enabled: true,
			connections: [ { id: 'account', executablePath: '/bin/claude', blockers: [], findings: [] } ],
		},
		claudeModels: [ { id: 'test-model', displayName: 'Test model', efforts: [ 'medium' ] } ],
	} );
	const summary = await connector.createClaudeSession( {
		siteId,
		connectionId: 'account',
		selection: { model: 'test-model', effort: 'medium' },
	} );
	const loaded = connector.state.sessions.find( ( chat ) => chat.summary.id === summary.id )!;
	const open = () => renderApp( { connector, path: '/sessions/' + summary.id } );
	return { connector, loaded, open, summary };
}

describe( 'Claude chat placement and recovery', () => {
	it( 'looks up the saved global chat in the global workspace and offers a fresh Studio chat', async () => {
		const { connector, open } = await setupChat();
		open();
		await waitFor( () =>
			expect( connector.getClaudeModelCatalog ).toHaveBeenCalledWith( 'account', undefined )
		);
		expect( await screen.findByText( /Global workspace:/ ) ).toBeVisible();
		expect( screen.getByRole( 'combobox', { name: 'Acting site' } ) ).toHaveTextContent(
			'All of Studio'
		);
		fireEvent.click( screen.getByRole( 'combobox', { name: 'Acting site' } ) );
		const local = await screen.findByRole( 'option', { name: 'Example' } );
		fireEvent.pointerDown( local, { pointerType: 'mouse' } );
		fireEvent.click( local );
		expect(
			await screen.findByRole( 'combobox', { name: 'Acting environment' } )
		).toHaveTextContent( 'Example · Local' );
		expect( screen.getByText( /Global workspace:/ ) ).toBeVisible();
		fireEvent.click( screen.getByRole( 'combobox', { name: 'Acting site' } ) );
		const global = await screen.findByRole( 'option', { name: 'All of Studio' } );
		fireEvent.pointerDown( global, { pointerType: 'mouse' } );
		fireEvent.click( global );
		await waitFor( () =>
			expect(
				screen.queryByRole( 'combobox', { name: 'Acting environment' } )
			).not.toBeInTheDocument()
		);
		fireEvent.click( screen.getByText( 'Start with another connection' ) );
		fireEvent.click( await screen.findByRole( 'button', { name: 'New Studio chat' } ) );
		expect( screen.getByRole( 'textbox', { name: 'Context summary (optional)' } ) ).toHaveValue(
			''
		);
		fireEvent.change( screen.getByRole( 'textbox', { name: 'Context summary (optional)' } ), {
			target: { value: 'Only my reviewed summary' },
		} );
		fireEvent.click( screen.getByRole( 'button', { name: 'Start new chat' } ) );
		await waitFor( () =>
			expect( connector.createSession ).toHaveBeenCalledExactlyOnceWith( undefined )
		);
		expect( connector.continueSession ).not.toHaveBeenCalled();
	} );

	it( 'shows why recovery was refused and reopens the same global chat after retry', async () => {
		const { connector, loaded, open, summary } = await setupChat();
		loaded.claudeRecovery = 'run-locked';
		connector.recoverClaudeSession.mockResolvedValueOnce( {
			status: 'blocked',
			reason: 'owner-alive',
		} );
		connector.recoverClaudeSession.mockImplementationOnce( async () => {
			connector.state.sessions = connector.state.sessions.map( ( chat ) =>
				chat.summary.id === summary.id ? { ...chat, claudeRecovery: undefined } : chat
			);
			return {
				status: 'recovered',
				runId: 'previous',
				turnId: 'turn',
				recordedTerminal: true,
				invalidatedApprovals: [],
				uncertainOperations: [],
			};
		} );
		open();
		fireEvent.click( await screen.findByRole( 'button', { name: 'Recover this chat' } ) );
		expect(
			await screen.findByText( /Studio process that ran the last turn is still running/ )
		).toBeVisible();
		fireEvent.click( screen.getByRole( 'button', { name: 'Recover this chat' } ) );
		await waitFor( () =>
			expect(
				screen.queryByRole( 'button', { name: 'Recover this chat' } )
			).not.toBeInTheDocument()
		);
		expect( connector.recoverClaudeSession.mock.calls ).toEqual( [
			[ summary.id ],
			[ summary.id ],
		] );
		expect( connector.continueSession ).not.toHaveBeenCalled();
		expect( connector.answerAgentQuestion ).not.toHaveBeenCalled();
	} );

	it( 'displays the bound workspace and switches the acting environment through the existing site operation', async () => {
		const { connector, open, summary } = await setupChat( 'local' );
		connector.getConnectedWpcomSites.mockResolvedValue( [
			{
				id: 42,
				localSiteId: 'local',
				name: 'Public site',
				url: 'https://public.example',
				isStaging: false,
				isPressable: false,
				syncSupport: 'syncable',
				lastPullTimestamp: null,
				lastPushTimestamp: null,
			},
		] );
		open();
		const target = await screen.findByRole( 'combobox', { name: 'Acting site' } );
		expect( target ).toHaveTextContent( 'Example · Local' );
		fireEvent.click( target );
		const live = await screen.findByRole( 'option', { name: /public.example/ } );
		await act( async () => {
			fireEvent.pointerDown( live, { pointerType: 'mouse' } );
			fireEvent.click( live );
		} );
		await waitFor( () =>
			expect( connector.setClaudeSessionTarget ).toHaveBeenCalledExactlyOnceWith(
				summary.id,
				{ environment: 'local', siteId: 'local' },
				{ environment: 'live', siteId: 'local', wpcomSiteId: 42 }
			)
		);
		expect( connector.createClaudeSession ).toHaveBeenCalledTimes( 1 );
	} );
} );
