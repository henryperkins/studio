import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SESSIONS_QUERY_KEY } from '@/data/queries/use-sessions';
import { createFakeConnector, makeSession, makeSite } from '@/test/fake-connector';
import { renderApp } from '@/test/render';
import type { Connector, LoadedAiSession, SessionEntry } from '@/data/core';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';
import type { ClaudeSessionSelection } from '@studio/agent/protocol/claude-code';

vi.setConfig( { testTimeout: 30_000 } );

function deferred< T >() {
	let resolve!: ( value: T ) => void;
	let reject!: ( error: Error ) => void;
	const promise = new Promise< T >( ( done, fail ) => {
		resolve = done;
		reject = fail;
	} );
	return { promise, resolve, reject };
}

async function choose( label: string, name: string ) {
	fireEvent.click( screen.getByRole( 'combobox', { name: label } ) );
	const option = await screen.findByRole( 'option', { name } );
	fireEvent.pointerDown( option, { pointerType: 'mouse' } );
	fireEvent.click( option );
}

async function setupSession(
	selection: ClaudeSessionSelection = { model: 'model-a', effort: 'medium' },
	overrides: Partial< Connector > = {}
) {
	const entry = ( customType: string, data: unknown ) =>
		( {
			type: 'custom',
			id: crypto.randomUUID(),
			parentId: null,
			timestamp: new Date().toISOString(),
			customType,
			data,
		} ) as SessionEntry;
	const session: LoadedAiSession = {
		summary: makeSession( { id: 'claude-matrix', ownerSiteId: 'one', backend: 'claude-code' } ),
		entries: [
			entry( 'studio.claude_binding', {
				connectionId: 'c1',
				siteId: 'one',
				workingDirectory: '/sites/one',
				configDirectory: '/config',
			} ),
			entry( 'studio.claude_selection', selection ),
		],
		claudeJournal: [],
	};
	const connector = createFakeConnector(
		{
			sites: [ makeSite( { id: 'one' } ) ],
			sessions: [ session ],
			claudeRuntime: {
				enabled: true,
				connections: [
					{ id: 'c1', executablePath: 'C:\\Claude\\claude.exe', blockers: [], findings: [] },
				],
			},
			claudeModels: [
				{ id: 'model-a', displayName: 'Model A', efforts: [ 'low', 'medium', 'high' ] },
				{ id: 'model-b', displayName: 'Model B', efforts: [ 'max' ] },
			],
		},
		overrides
	);
	connector.continueSession.mockResolvedValue( { runId: 'run-1' } );
	const view = renderApp( { connector, path: '/sessions/claude-matrix' } );
	await screen.findByRole( 'textbox', { name: 'Message Claude' } );
	await waitFor( () =>
		expect( screen.getByRole( 'combobox', { name: 'Claude model' } ) ).toHaveTextContent(
			'Model A'
		)
	);
	const emit = ( event: BackendTurnEvent ) =>
		connector.emit( 'onAgentEvent', {
			sessionId: 'claude-matrix',
			runId: event.runId,
			event: { type: 'backend.event', timestamp: new Date().toISOString(), event },
		} );
	return { ...view, connector, session, emit };
}

describe( 'Claude Code chat', () => {
	it( 'shows its journal and recovery without the Pi composer', async () => {
		const entry = ( id: string, customType: string, data: unknown ) =>
			( {
				type: 'custom',
				id,
				customType,
				data,
				parentId: null,
				timestamp: new Date().toISOString(),
			} ) as SessionEntry;
		const connector = createFakeConnector(
			{
				sites: [ makeSite( { id: 'one' } ) ],
				sessions: [
					{
						summary: makeSession( { id: 'claude', ownerSiteId: 'one', backend: 'claude-code' } ),
						entries: [
							entry( 'binding', 'studio.claude_binding', {
								connectionId: 'c1',
								siteId: 'one',
								workingDirectory: '/sites/one',
								configDirectory: '/config',
							} ),
							entry( 'selection', 'studio.claude_selection', {
								model: 'model-a',
								effort: 'medium',
							} ),
						],
						claudeJournal: [
							[
								{ type: 'turn.prompt', runId: 'run', turnId: 'turn', text: 'Inspect my site' },
								{
									type: 'turn.terminal',
									runId: 'run',
									turnId: 'turn',
									outcome: {
										status: 'error',
										code: 'rebind_required',
										message: 'Native session unavailable',
									},
								},
							],
						],
					},
				],
			},
			{
				getClaudeRuntimeState: async () => ( { enabled: true, connections: [] } ),
				getClaudeModelCatalog: async () => ( {
					ok: true,
					models: [ { id: 'model-a', displayName: 'Model A', efforts: [ 'medium' ] } ],
				} ),
			}
		);
		renderApp( { connector, path: '/sessions/claude' } );
		expect( await screen.findByText( 'Inspect my site' ) ).toBeVisible();
		expect( screen.getByText( 'Native session unavailable' ) ).toBeVisible();
		expect( screen.getByText( /Start a new conversation to reconnect/ ) ).toBeVisible();
		expect( await screen.findByRole( 'button', { name: 'New Claude Code chat' } ) ).toBeVisible();
		expect( screen.getByLabelText( 'Message Claude' ) ).toBeVisible();
		expect( screen.queryByRole( 'combobox', { name: /environment/i } ) ).not.toBeInTheDocument();
	} );
} );

describe( 'Claude selection and approval recovery', () => {
	it( 'requires a supported effort when changing to an incompatible model', async () => {
		const { connector } = await setupSession();
		fireEvent.change( screen.getByRole( 'textbox', { name: 'Message Claude' } ), {
			target: { value: 'Inspect the site' },
		} );
		await choose( 'Claude model', 'Model B' );
		expect( screen.getByText( 'Choose an effort for the selected model.' ) ).toBeVisible();
		expect( screen.getByRole( 'button', { name: 'Send' } ) ).toBeDisabled();
		expect( connector.setClaudeSessionSelection ).not.toHaveBeenCalled();
		fireEvent.click( screen.getByRole( 'combobox', { name: 'Claude effort' } ) );
		const maximum = await screen.findByRole( 'option', { name: 'max' } );
		expect( screen.queryByRole( 'option', { name: 'medium' } ) ).not.toBeInTheDocument();
		fireEvent.pointerDown( maximum, { pointerType: 'mouse' } );
		fireEvent.click( maximum );
		await waitFor( () =>
			expect( connector.setClaudeSessionSelection ).toHaveBeenCalledExactlyOnceWith(
				'claude-matrix',
				{ model: 'model-b', effort: 'max' }
			)
		);
		expect( screen.getByRole( 'button', { name: 'Send' } ) ).toBeEnabled();
		expect( screen.queryByRole( 'spinbutton' ) ).not.toBeInTheDocument();
	} );

	it( 'holds a saved unsupported effort until the user explicitly chooses a supported one', async () => {
		const { connector } = await setupSession( { model: 'model-a', effort: 'max' } );
		fireEvent.change( screen.getByRole( 'textbox', { name: 'Message Claude' } ), {
			target: { value: 'Inspect the site' },
		} );
		expect( screen.getByRole( 'button', { name: 'Send' } ) ).toBeDisabled();
		expect( connector.setClaudeSessionSelection ).not.toHaveBeenCalled();
		await choose( 'Claude effort', 'high' );
		await waitFor( () =>
			expect( connector.setClaudeSessionSelection ).toHaveBeenCalledWith( 'claude-matrix', {
				model: 'model-a',
				effort: 'high',
			} )
		);
		expect( screen.getByRole( 'button', { name: 'Send' } ) ).toBeEnabled();
	} );

	it.each( [ 'model', 'effort' ] )(
		'does not replace a selected %s when refreshed options remove it',
		async ( field ) => {
			const { connector, queryClient } = await setupSession();
			if ( field === 'model' ) {
				await choose( 'Claude model', 'Model B' );
				await choose( 'Claude effort', 'max' );
			} else await choose( 'Claude effort', 'high' );
			await waitFor( () => expect( connector.setClaudeSessionSelection ).toHaveBeenCalledOnce() );
			connector.setClaudeSessionSelection.mockClear();
			fireEvent.change( screen.getByRole( 'textbox', { name: 'Message Claude' } ), {
				target: { value: 'Hold this until I choose again' },
			} );
			fireEvent.click( screen.getByRole( 'combobox', { name: `Claude ${ field }` } ) );
			await screen.findByRole( 'option', { name: field === 'model' ? 'Model B' : 'high' } );
			connector.getClaudeModelCatalog.mockResolvedValue( {
				ok: true,
				models: [ { id: 'model-a', displayName: 'Model A', efforts: [ 'medium' ] } ],
			} );
			await act( async () => {
				await queryClient.invalidateQueries( { queryKey: [ 'claude-models' ] } );
			} );
			expect( connector.setClaudeSessionSelection ).not.toHaveBeenCalled();
			expect( screen.getByRole( 'button', { name: 'Send' } ) ).toBeDisabled();
			expect( screen.getByRole( 'textbox', { name: 'Message Claude' } ) ).toHaveValue(
				'Hold this until I choose again'
			);
			expect( connector.continueSession ).not.toHaveBeenCalled();
		}
	);

	it.each( [ 'native-auth-unqualified', 'native-runtime-unqualified', 'connection-not-found' ] )(
		'holds the prompt when rechecking the runtime reports %s',
		async ( blocker ) => {
			const { connector, queryClient } = await setupSession();
			const prompt = screen.getByRole( 'textbox', { name: 'Message Claude' } );
			fireEvent.change( prompt, { target: { value: 'Private unsent prompt' } } );
			connector.getClaudeModelCatalog.mockResolvedValue( { ok: false, blockers: [ blocker ] } );
			await act( async () => {
				await queryClient.invalidateQueries( { queryKey: [ 'claude-models' ] } );
			} );
			expect( await screen.findByText( new RegExp( blocker ) ) ).toBeVisible();
			expect( screen.getByRole( 'button', { name: 'Send' } ) ).toBeDisabled();
			expect( prompt ).toHaveValue( 'Private unsent prompt' );
			expect( connector.setSessionProvider ).not.toHaveBeenCalled();
			expect( connector.continueSession ).not.toHaveBeenCalled();
		}
	);

	it( 'holds the prompt after a failed catalog refresh instead of using stale capabilities', async () => {
		const { connector, queryClient } = await setupSession();
		fireEvent.change( screen.getByRole( 'textbox', { name: 'Message Claude' } ), {
			target: { value: 'Private unsent prompt' },
		} );
		connector.getClaudeModelCatalog.mockRejectedValue( new Error( 'Runtime unavailable.' ) );
		await act( async () => {
			await queryClient.invalidateQueries( { queryKey: [ 'claude-models' ] } );
		} );
		expect(
			await screen.findByText( 'Claude Code model capabilities could not be checked.' )
		).toBeVisible();
		expect( screen.getByRole( 'button', { name: 'Send' } ) ).toBeDisabled();
		expect( connector.continueSession ).not.toHaveBeenCalled();
	} );

	it.each( [ 'removed', 'blocked', 'unreachable' ] )(
		'holds the prompt when the selected connection becomes %s',
		async ( condition ) => {
			const { connector, queryClient } = await setupSession();
			const prompt = screen.getByRole( 'textbox', { name: 'Message Claude' } );
			fireEvent.change( prompt, { target: { value: 'Keep this prompt' } } );
			if ( condition === 'unreachable' )
				connector.getClaudeRuntimeState.mockRejectedValue( new Error( 'Offline' ) );
			else
				connector.getClaudeRuntimeState.mockResolvedValue( {
					enabled: true,
					connections:
						condition === 'removed'
							? []
							: [
									{
										id: 'c1',
										executablePath: 'C:\\Claude\\claude.exe',
										blockers: [ 'native-auth-unqualified' ],
										findings: [],
									},
							  ],
				} );
			await act( async () => {
				await queryClient.invalidateQueries( { queryKey: [ 'claude-runtime' ] } );
			} );
			expect(
				await screen.findByText( 'Claude Code is unavailable. Recheck its status in Settings.' )
			).toBeVisible();
			expect( screen.getByRole( 'button', { name: 'Send' } ) ).toBeDisabled();
			expect( prompt ).toHaveValue( 'Keep this prompt' );
			expect( connector.continueSession ).not.toHaveBeenCalled();
		}
	);

	it( 'preserves the latest successful save across an earlier failure and stale session refetch', async () => {
		const { connector, queryClient, session } = await setupSession();
		const first = deferred< void >();
		const second = deferred< void >();
		const stale = deferred< LoadedAiSession >();
		const oldSession = structuredClone( session );
		connector.setClaudeSessionSelection
			.mockImplementationOnce( () => first.promise )
			.mockImplementationOnce( () => second.promise );
		await choose( 'Claude effort', 'high' );
		await choose( 'Claude effort', 'low' );
		connector.getSession.mockImplementationOnce( () => stale.promise );
		let refresh!: Promise< void >;
		act( () => {
			refresh = queryClient.invalidateQueries( {
				queryKey: [ ...SESSIONS_QUERY_KEY, 'claude-matrix' ],
			} );
		} );
		await act( async () => first.reject( new Error( 'First save failed.' ) ) );
		await waitFor( () => expect( connector.setClaudeSessionSelection ).toHaveBeenCalledTimes( 2 ) );
		await act( async () => second.resolve() );
		expect( screen.getByRole( 'combobox', { name: 'Claude effort' } ) ).toHaveTextContent( 'low' );
		await act( async () => {
			stale.resolve( oldSession );
			await refresh;
		} );
		expect( screen.getByRole( 'combobox', { name: 'Claude effort' } ) ).toHaveTextContent( 'low' );
		fireEvent.change( screen.getByRole( 'textbox', { name: 'Message Claude' } ), {
			target: { value: 'Use the saved choice' },
		} );
		fireEvent.click( screen.getByRole( 'button', { name: 'Send' } ) );
		await waitFor( () =>
			expect( connector.continueSession ).toHaveBeenCalledWith(
				'claude-matrix',
				'Use the saved choice',
				expect.objectContaining( { claudeSelection: { model: 'model-a', effort: 'low' } } )
			)
		);
	} );

	it( 'restores an unsent prompt when its captured setting save fails', async () => {
		const { connector } = await setupSession();
		const save = deferred< void >();
		connector.setClaudeSessionSelection.mockImplementationOnce( () => save.promise );
		await choose( 'Claude effort', 'high' );
		const prompt = screen.getByRole( 'textbox', { name: 'Message Claude' } );
		fireEvent.change( prompt, { target: { value: 'Do not send with the old effort' } } );
		fireEvent.click( screen.getByRole( 'button', { name: 'Send' } ) );
		await act( async () => save.reject( new Error( 'Latest save failed.' ) ) );
		await waitFor( () => expect( prompt ).toHaveValue( 'Do not send with the old effort' ) );
		expect( screen.getByRole( 'combobox', { name: 'Claude effort' } ) ).toHaveTextContent(
			'medium'
		);
		expect( connector.continueSession ).not.toHaveBeenCalled();
	} );

	it( 'holds setting changes during an active tool and uses them only for the next turn', async () => {
		const { connector, emit } = await setupSession();
		const prompt = screen.getByRole( 'textbox', { name: 'Message Claude' } );
		fireEvent.change( prompt, { target: { value: 'First turn' } } );
		fireEvent.click( screen.getByRole( 'button', { name: 'Send' } ) );
		await waitFor( () => expect( connector.continueSession ).toHaveBeenCalledOnce() );
		act( () =>
			emit( {
				type: 'tool.started',
				runId: 'run-1',
				turnId: 'turn-1',
				toolCallId: 'tool',
				name: 'wp_cli',
			} )
		);
		await choose( 'Claude effort', 'high' );
		expect( connector.setClaudeSessionSelection ).not.toHaveBeenCalled();
		expect( connector.continueSession ).toHaveBeenLastCalledWith(
			'claude-matrix',
			'First turn',
			expect.objectContaining( { claudeSelection: { model: 'model-a', effort: 'medium' } } )
		);
		act( () =>
			connector.emit( 'onAgentEvent', {
				sessionId: 'claude-matrix',
				runId: 'run-1',
				event: {
					type: 'run.exited',
					timestamp: new Date().toISOString(),
					status: 'success',
					code: 0,
				},
			} )
		);
		await waitFor( () =>
			expect( connector.setClaudeSessionSelection ).toHaveBeenCalledWith( 'claude-matrix', {
				model: 'model-a',
				effort: 'high',
			} )
		);
		fireEvent.change( prompt, { target: { value: 'Second turn' } } );
		fireEvent.click( screen.getByRole( 'button', { name: 'Send' } ) );
		await waitFor( () =>
			expect( connector.continueSession ).toHaveBeenLastCalledWith(
				'claude-matrix',
				'Second turn',
				expect.objectContaining( { claudeSelection: { model: 'model-a', effort: 'high' } } )
			)
		);
	} );

	const approval = {
		type: 'approval.requested',
		runId: 'restored-run',
		turnId: 'restored-turn',
		requestId: 'request-1',
		toolCallId: 'tool-1',
		description: 'Create a restored draft',
		draft: { siteName: 'My site', title: 'Restored draft', content: 'Exact restored content' },
	} as const;
	const active = () => [
		{
			sessionId: 'claude-matrix',
			runId: 'restored-run',
			startedAt: 1,
			phase: 'running' as const,
			pendingClaudeApprovals: [ approval ],
		},
	];

	it( 'restores and deduplicates pending approvals on reload and answers only their original run', async () => {
		const { connector, emit } = await setupSession( undefined, {
			getActiveAgentRuns: async () => active(),
		} );
		expect( await screen.findByText( 'Exact restored content' ) ).toBeVisible();
		act( () => emit( approval ) );
		expect( screen.getAllByRole( 'button', { name: 'Allow' } ) ).toHaveLength( 1 );
		fireEvent.click( screen.getByRole( 'button', { name: 'Allow' } ) );
		await waitFor( () =>
			expect( connector.answerAgentQuestion ).toHaveBeenCalledExactlyOnceWith( 'restored-run', {
				'request-1': 'allow',
			} )
		);
		await waitFor( () =>
			expect( screen.queryByRole( 'button', { name: 'Allow' } ) ).not.toBeInTheDocument()
		);
	} );

	it( 'does not show a stale restored approval while a newer run is active', async () => {
		const { connector, queryClient, emit } = await setupSession( undefined, {
			getActiveAgentRuns: async () => active(),
		} );
		await screen.findByRole( 'button', { name: 'Allow' } );
		await act( async () => {
			connector.emit( 'onAgentEvent', {
				sessionId: 'claude-matrix',
				runId: 'restored-run',
				event: {
					type: 'run.exited',
					timestamp: new Date().toISOString(),
					status: 'error',
					code: 1,
				},
			} );
			await queryClient.invalidateQueries( {
				queryKey: [ ...SESSIONS_QUERY_KEY, 'claude-matrix' ],
			} );
		} );
		act( () => {
			connector.emit( 'onAgentEvent', {
				sessionId: 'claude-matrix',
				runId: 'new-run',
				event: { type: 'run.started', timestamp: new Date().toISOString() },
			} );
			emit( { type: 'turn.prompt', runId: 'new-run', turnId: 'new-turn', text: 'A newer turn' } );
		} );
		expect( await screen.findByText( 'A newer turn' ) ).toBeVisible();
		expect( screen.queryByRole( 'button', { name: 'Allow' } ) ).not.toBeInTheDocument();
		expect( connector.answerAgentQuestion ).not.toHaveBeenCalled();
	} );

	it( 'recovers pending approvals after reconnecting when their live event was missed', async () => {
		const { connector } = await setupSession();
		connector.getActiveAgentRuns.mockResolvedValue( active() );
		act( () => connector.emit( 'onConnectionRestored' ) );
		expect( await screen.findByRole( 'button', { name: 'Allow' } ) ).toBeVisible();
		expect( screen.getByText( 'Exact restored content' ) ).toBeVisible();
	} );

	it( 'removes an approval resolved while disconnected even if the journal still contains its request', async () => {
		const { connector, session, emit } = await setupSession( undefined, {
			getActiveAgentRuns: async () => active(),
		} );
		act( () => emit( approval ) );
		await screen.findByRole( 'button', { name: 'Allow' } );
		connector.getSession.mockResolvedValue( { ...session, claudeJournal: [ [ approval ] ] } );
		connector.getActiveAgentRuns.mockResolvedValue( [
			{ ...active()[ 0 ], pendingClaudeApprovals: [] },
		] );
		await act( async () => connector.emit( 'onConnectionRestored' ) );
		await waitFor( () =>
			expect( screen.queryByRole( 'button', { name: 'Allow' } ) ).not.toBeInTheDocument()
		);
		expect( connector.answerAgentQuestion ).not.toHaveBeenCalled();
	} );

	it( 'does not resurrect a resolved approval from a delayed reconnect snapshot', async () => {
		const { connector, emit } = await setupSession( undefined, {
			getActiveAgentRuns: async () => active(),
		} );
		await screen.findByRole( 'button', { name: 'Allow' } );
		const snapshot = deferred< Awaited< ReturnType< Connector[ 'getActiveAgentRuns' ] > > >();
		connector.getActiveAgentRuns.mockReturnValueOnce( snapshot.promise );
		act( () => connector.emit( 'onConnectionRestored' ) );
		act( () =>
			emit( {
				type: 'approval.resolved',
				runId: approval.runId,
				turnId: approval.turnId,
				requestId: approval.requestId,
				toolCallId: approval.toolCallId,
			} )
		);
		await act( async () => snapshot.resolve( active() ) );
		expect( screen.queryByRole( 'button', { name: 'Allow' } ) ).not.toBeInTheDocument();
		expect( connector.answerAgentQuestion ).not.toHaveBeenCalled();
	} );
} );

it( 'shows the exact draft scope and denies the pending request by its ID', async () => {
	const entry = ( id: string, customType: string, data: unknown ) =>
		( {
			type: 'custom',
			id,
			customType,
			data,
			parentId: null,
			timestamp: new Date().toISOString(),
		} ) as SessionEntry;
	const connector = createFakeConnector(
		{
			sites: [ makeSite( { id: 'one' } ) ],
			sessions: [
				{
					summary: makeSession( {
						id: 'approval-chat',
						ownerSiteId: 'one',
						backend: 'claude-code',
					} ),
					entries: [
						entry( 'binding', 'studio.claude_binding', {
							connectionId: 'c1',
							siteId: 'one',
							workingDirectory: '/sites/one',
							configDirectory: '/config',
						} ),
						entry( 'selection', 'studio.claude_selection', { model: 'model-a', effort: 'medium' } ),
					],
				},
			],
		},
		{
			getClaudeModelCatalog: async () => ( {
				ok: true,
				models: [ { id: 'model-a', displayName: 'Model A', efforts: [ 'medium' ] } ],
			} ),
		}
	);
	renderApp( { connector, path: '/sessions/approval-chat' } );
	await screen.findByLabelText( 'Message Claude' );
	act( () => {
		connector.emit( 'onAgentEvent', {
			sessionId: 'approval-chat',
			runId: 'run',
			event: { type: 'run.started', timestamp: new Date().toISOString() },
		} );
		connector.emit( 'onAgentEvent', {
			sessionId: 'approval-chat',
			runId: 'run',
			event: {
				type: 'backend.event',
				timestamp: new Date().toISOString(),
				event: {
					type: 'approval.requested',
					runId: 'run',
					turnId: 'turn',
					requestId: 'request-1',
					toolCallId: 'tool',
					description: 'Create a draft',
					draft: { siteName: 'My site', title: 'Draft title', content: 'Draft content' },
				},
			},
		} );
	} );
	expect( await screen.findByText( 'Draft content' ) ).toBeVisible();
	fireEvent.click( screen.getByRole( 'button', { name: 'Deny' } ) );
	await waitFor( () =>
		expect( connector.answerAgentQuestion ).toHaveBeenCalledWith( 'run', { 'request-1': 'deny' } )
	);
	await waitFor( () =>
		expect( screen.queryByRole( 'button', { name: 'Deny' } ) ).not.toBeInTheDocument()
	);
} );
