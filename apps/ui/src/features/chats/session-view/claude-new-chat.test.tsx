import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getComposerDraft, saveComposerDraft } from '@/features/composer';
import { createFakeConnector, makeSession, makeSite } from '@/test/fake-connector';
import { renderApp } from '@/test/render';

async function choose( label: string, name: string ) {
	fireEvent.click( screen.getByRole( 'combobox', { name: label } ) );
	const option = await screen.findByRole( 'option', { name } );
	fireEvent.pointerDown( option, { pointerType: 'mouse' } );
	fireEvent.click( option );
}

async function setup( existingChat = false ) {
	const connector = createFakeConnector( {
		sites: [ makeSite( { id: 'one' } ) ],
		sessions: existingChat
			? [ { summary: makeSession( { id: 'original', ownerSiteId: 'one' } ), entries: [] } ]
			: [],
		claudeRuntime: {
			enabled: true,
			connections: [
				{
					id: 'c1',
					executablePath: 'C:\\Personal\\claude.exe',
					authMethod: 'claude.ai',
					blockers: [],
					findings: [ 'workspace-model-check-required' ],
				},
				{ id: 'c2', executablePath: 'C:\\Work\\claude.exe', blockers: [], findings: [] },
			],
		},
		claudeModels: [
			{ id: 'model-a', displayName: 'Model A', efforts: [ 'medium', 'high' ] },
			{ id: 'model-b', displayName: 'Model B', efforts: [ 'max' ] },
		],
	} );
	const view = renderApp( {
		connector,
		path: existingChat ? '/sessions/original' : '/sites/one/new',
	} );
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
		expect( await screen.findByRole( 'combobox', { name: 'Message Claude' } ) ).toBeVisible();
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
		expect( await screen.findByText( /Sign in to a Claude subscription/ ) ).toBeVisible();
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

	it( 'checks models in the global workspace and clears the previous selection when switching', async () => {
		const { connector } = await setup();
		await choose( 'Claude connection', 'C:\\Personal\\claude.exe' );
		await choose( 'Claude model', 'Model A' );
		await choose( 'Claude effort', 'high' );
		await choose( 'Claude workspace', 'Global workspace' );
		expect( connector.getClaudeModelCatalog ).toHaveBeenCalledWith( 'c1', undefined );
		expect( screen.getByRole( 'button', { name: 'Create Claude chat' } ) ).toBeDisabled();
		await choose( 'Claude model', 'Model B' );
		await choose( 'Claude effort', 'max' );
		fireEvent.click( screen.getByRole( 'button', { name: 'Create Claude chat' } ) );
		await waitFor( () =>
			expect( connector.createClaudeSession ).toHaveBeenCalledExactlyOnceWith( {
				connectionId: 'c1',
				siteId: undefined,
				selection: { model: 'model-b', effort: 'max' },
			} )
		);
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

	it( 'creates a fresh chat from an existing session with only the reviewed summary', async () => {
		saveComposerDraft( 'original', { text: 'Private draft', attachments: [] } );
		const { connector } = await setup( true );
		await choose( 'Claude connection', 'C:\\Personal\\claude.exe' );
		await choose( 'Claude model', 'Model A' );
		await choose( 'Claude effort', 'high' );
		fireEvent.click( screen.getByRole( 'button', { name: 'Create Claude chat' } ) );
		const review = await screen.findByRole( 'dialog', { name: 'Start a new chat?' } );
		expect( within( review ).getByText( /Personal.*This site.*Model A.*high/ ) ).toBeVisible();
		const context = within( review ).getByRole( 'textbox', { name: 'Context summary (optional)' } );
		expect( context ).toHaveValue( '' );
		expect( connector.createClaudeSession ).not.toHaveBeenCalled();
		fireEvent.change( context, { target: { value: 'Reviewed context' } } );
		fireEvent.click( within( review ).getByRole( 'button', { name: 'Start new chat' } ) );
		await waitFor( () => expect( connector.createClaudeSession ).toHaveBeenCalledTimes( 1 ) );
		const { id } = await connector.createClaudeSession.mock.results[ 0 ].value;
		await waitFor( () =>
			expect( getComposerDraft( id ) ).toEqual( { text: 'Reviewed context', attachments: [] } )
		);
		expect( getComposerDraft( 'original' ).text ).toBe( 'Private draft' );
		expect( connector.continueSession ).not.toHaveBeenCalled();
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

	it( 'requires a new review if the selected connection signs in again during confirmation', async () => {
		const { connector, queryClient } = await setup( true );
		await choose( 'Claude connection', 'C:\\Personal\\claude.exe' );
		await choose( 'Claude model', 'Model A' );
		await choose( 'Claude effort', 'high' );
		fireEvent.click( screen.getByRole( 'button', { name: 'Create Claude chat' } ) );
		const review = await screen.findByRole( 'dialog', { name: 'Start a new chat?' } );
		const confirm = within( review ).getByRole( 'button', { name: 'Start new chat' } );
		expect( confirm ).toBeEnabled();
		connector.getClaudeRuntimeState.mockResolvedValue( {
			enabled: true,
			connections: [
				{
					id: 'c1',
					executablePath: 'C:\\Personal\\claude.exe',
					revision: 2,
					blockers: [],
					findings: [],
				},
			],
		} );
		await act( () => queryClient.invalidateQueries( { queryKey: [ 'claude-runtime' ] } ) );
		await waitFor( () => expect( confirm ).toBeDisabled() );
		fireEvent.click( confirm );
		expect( connector.createClaudeSession ).not.toHaveBeenCalled();
		expect( within( review ).getByRole( 'button', { name: 'Cancel' } ) ).toBeEnabled();
	} );
} );
