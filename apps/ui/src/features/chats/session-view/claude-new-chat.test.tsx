import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFakeConnector, makeSite } from '@/test/fake-connector';
import { renderApp } from '@/test/render';

async function choose( label: string, name: string ) {
	fireEvent.click( screen.getByRole( 'combobox', { name: label } ) );
	const option = await screen.findByRole( 'option', { name } );
	fireEvent.pointerDown( option, { pointerType: 'mouse' } );
	fireEvent.click( option );
}

async function setup() {
	const connector = createFakeConnector( {
		sites: [ makeSite( { id: 'one' } ) ],
		claudeRuntime: {
			enabled: true,
			connections: [
				{ id: 'c1', executablePath: 'C:\\Personal\\claude.exe', blockers: [], findings: [] },
				{ id: 'c2', executablePath: 'C:\\Work\\claude.exe', blockers: [], findings: [] },
			],
		},
		claudeModels: [
			{ id: 'model-a', displayName: 'Model A', efforts: [ 'medium', 'high' ] },
			{ id: 'model-b', displayName: 'Model B', efforts: [ 'max' ] },
		],
	} );
	const view = renderApp( { connector, path: '/sites/one/new' } );
	fireEvent.click( await screen.findByRole( 'button', { name: 'New Claude Code chat' } ) );
	return { ...view, connector };
}

describe( 'new Claude Code chat', () => {
	it( 'requires an explicit connection, model and supported effort before creating a site-scoped chat', async () => {
		const { connector } = await setup();
		const create = screen.getByRole( 'button', { name: 'Create Claude chat' } );
		expect( create ).toBeDisabled();
		await choose( 'Claude connection', 'C:\\Personal\\claude.exe' );
		await choose( 'Claude model', 'Model A' );
		await choose( 'Claude effort', 'high' );
		await choose( 'Claude model', 'Model B' );
		expect( create ).toBeDisabled();
		fireEvent.click( screen.getByRole( 'combobox', { name: 'Claude effort' } ) );
		const maximum = await screen.findByRole( 'option', { name: 'max' } );
		expect( screen.queryByRole( 'option', { name: 'high' } ) ).not.toBeInTheDocument();
		fireEvent.pointerDown( maximum, { pointerType: 'mouse' } );
		fireEvent.click( maximum );
		fireEvent.click( create );
		await waitFor( () =>
			expect( connector.createClaudeSession ).toHaveBeenCalledExactlyOnceWith( {
				connectionId: 'c1',
				siteId: 'one',
				selection: { model: 'model-b', effort: 'max' },
			} )
		);
		expect( await screen.findByRole( 'textbox', { name: 'Message Claude' } ) ).toBeVisible();
		expect( connector.createSession ).not.toHaveBeenCalled();
	} );

	it( 'clears the previous model and effort when the selected connection changes', async () => {
		const { connector } = await setup();
		await choose( 'Claude connection', 'C:\\Personal\\claude.exe' );
		await choose( 'Claude model', 'Model A' );
		await choose( 'Claude effort', 'high' );
		connector.getClaudeModelCatalog.mockResolvedValueOnce( {
			ok: false,
			blockers: [ 'native-auth-unqualified' ],
		} );
		await choose( 'Claude connection', 'C:\\Work\\claude.exe' );
		expect( await screen.findByText( 'native-auth-unqualified' ) ).toBeVisible();
		expect( screen.getByRole( 'combobox', { name: 'Claude model' } ) ).toHaveTextContent(
			'Claude model'
		);
		expect( screen.getByRole( 'combobox', { name: 'Claude effort' } ) ).toHaveTextContent(
			'Claude effort'
		);
		expect( screen.getByRole( 'button', { name: 'Create Claude chat' } ) ).toBeDisabled();
		expect( connector.createClaudeSession ).not.toHaveBeenCalled();
	} );

	it( 'blocks a previously valid choice when refreshing its catalog fails', async () => {
		const { connector, queryClient } = await setup();
		await choose( 'Claude connection', 'C:\\Personal\\claude.exe' );
		await choose( 'Claude model', 'Model A' );
		await choose( 'Claude effort', 'high' );
		expect( screen.getByRole( 'button', { name: 'Create Claude chat' } ) ).toBeEnabled();
		connector.getClaudeModelCatalog.mockRejectedValue( new Error( 'Runtime unavailable.' ) );
		await act( async () => {
			await queryClient.invalidateQueries( { queryKey: [ 'claude-models' ] } );
		} );
		await waitFor( () =>
			expect( screen.getByRole( 'button', { name: 'Create Claude chat' } ) ).toBeDisabled()
		);
		expect(
			await screen.findByText( 'Claude Code model capabilities could not be checked.' )
		).toBeVisible();
		expect( connector.createClaudeSession ).not.toHaveBeenCalled();
	} );

	it( 'blocks creation when the selected connection is removed after model discovery', async () => {
		const { connector, queryClient } = await setup();
		await choose( 'Claude connection', 'C:\\Personal\\claude.exe' );
		await choose( 'Claude model', 'Model A' );
		await choose( 'Claude effort', 'high' );
		connector.getClaudeRuntimeState.mockResolvedValue( { enabled: true, connections: [] } );
		await act( async () => {
			await queryClient.invalidateQueries( { queryKey: [ 'claude-runtime' ] } );
		} );
		await waitFor( () =>
			expect( screen.getByRole( 'button', { name: 'Create Claude chat' } ) ).toBeDisabled()
		);
		expect( connector.createClaudeSession ).not.toHaveBeenCalled();
	} );

	it( 'holds creation while a previously successful catalog is being rechecked', async () => {
		const { connector, queryClient } = await setup();
		await choose( 'Claude connection', 'C:\\Personal\\claude.exe' );
		await choose( 'Claude model', 'Model A' );
		await choose( 'Claude effort', 'high' );
		let finish!: ( value: Awaited< ReturnType< typeof connector.getClaudeModelCatalog > > ) => void;
		connector.getClaudeModelCatalog.mockReturnValueOnce(
			new Promise( ( resolve ) => {
				finish = resolve;
			} )
		);
		let refresh!: Promise< void >;
		act( () => {
			refresh = queryClient.invalidateQueries( { queryKey: [ 'claude-models' ] } );
		} );
		await waitFor( () =>
			expect( screen.getByRole( 'button', { name: 'Create Claude chat' } ) ).toBeDisabled()
		);
		expect( connector.createClaudeSession ).not.toHaveBeenCalled();
		await act( async () => {
			finish( { ok: true, models: connector.state.claudeModels } );
			await refresh;
		} );
		await waitFor( () =>
			expect( screen.getByRole( 'button', { name: 'Create Claude chat' } ) ).toBeEnabled()
		);
	} );
} );
