import { escapeClaudeApprovalText } from '@studio/agent/protocol/claude-code';
import { SKIPPED_QUESTION } from '@studio/agent/protocol/tools';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { describeClaudeIssue } from '@/data/queries/claude-runtime';
import { SESSIONS_QUERY_KEY } from '@/data/queries/use-sessions';
import {
	changeAnnotation,
	getSiteAnnotations,
	pickAnnotation,
	requestAnnotationSend,
} from '@/features/annotations';
import { clearComposerDrafts } from '@/features/composer';
import { createFakeConnector, makeSession, makeSite } from '@/test/fake-connector';
import { renderApp } from '@/test/render';
import type { Connector, LoadedAiSession, SessionEntry } from '@/data/core';
import type {
	BackendApprovalOperation,
	BackendTurnEvent,
} from '@studio/agent/protocol/backend-events';
import type { ClaudeSessionSelection } from '@studio/agent/protocol/claude-code';

vi.setConfig( { testTimeout: 30_000 } );
beforeEach( clearComposerDrafts );

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
	overrides: Partial< Connector > = {},
	claudeJournal: LoadedAiSession[ 'claudeJournal' ] = []
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
		claudeJournal,
	};
	const connector = createFakeConnector(
		{
			sites: [ makeSite( { id: 'one' } ) ],
			sessions: [ session ],
			claudeRuntime: {
				enabled: true,
				connections: [
					{
						id: 'c1',
						executablePath: 'C:\\Claude\\claude.exe',
						authMethod: 'claude.ai',
						blockers: [],
						findings: [ 'workspace-model-check-required' ],
					},
				],
			},
			claudeModels: [
				{ id: 'model-a', displayName: 'Model A', efforts: [ 'low', 'medium', 'high' ] },
				{ id: 'model-b', displayName: 'Model B', efforts: [ 'max' ] },
			],
		},
		overrides
	);
	let runCount = 0;
	connector.continueSession.mockImplementation( async ( sessionId, text, options ) => {
		const runId = `run-${ ++runCount }`;
		const timestamp = new Date().toISOString();
		connector.emit( 'onAgentEvent', {
			sessionId,
			runId,
			event: { type: 'run.started', timestamp },
		} );
		if ( options?.turnId ) {
			connector.emit( 'onAgentEvent', {
				sessionId,
				runId,
				event: {
					type: 'backend.event',
					timestamp,
					event: { type: 'turn.prompt', runId, turnId: options.turnId, text },
				},
			} );
		}
		return { runId };
	} );
	const view = renderApp( { connector, path: '/sessions/claude-matrix' } );
	await screen.findByRole( 'combobox', { name: 'Message Claude' } );
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
	it( 'renders a reopened prompt, Markdown, tool outcome and eligible preview without loading model-supplied image URLs', async () => {
		const ids = { runId: 'r', turnId: 't' };
		await setupSession( undefined, {}, [
			[
				{
					...ids,
					type: 'turn.prompt',
					text: 'Use this brief',
					attachments: [ { kind: 'file', name: 'brief.md' } ],
				},
				{
					...ids,
					type: 'content.confirmed',
					messageId: 'm',
					blockId: '0',
					blockType: 'text',
					text: '## Site review\n\n![remote](https://example.test/pixel)',
				},
				{ ...ids, type: 'tool.started', toolCallId: 'a', name: 'wp_cli' },
				{
					...ids,
					type: 'tool.result',
					toolCallId: 'a',
					message: 'Site check failed',
					isError: true,
				},
				{
					...ids,
					type: 'chat.artifact',
					target: { environment: 'local', siteId: 'one' },
					artifact: {
						version: 1,
						id: 'preview',
						widgets: [ { type: 'site-preview', widgetProps: { path: 'studio:design-system' } } ],
					},
				},
				{ ...ids, type: 'task.status', taskId: 'a', status: 'completed' },
				{ ...ids, type: 'turn.terminal', outcome: { status: 'success' } },
			],
		] );
		expect( screen.getByText( 'brief.md' ) ).toBeVisible();
		expect( screen.getByRole( 'heading', { name: 'Site review' } ) ).toBeVisible();
		expect( screen.getByText( 'Site check failed' ) ).toBeVisible();
		expect( screen.getByRole( 'button', { name: 'Open design system' } ) ).toBeVisible();
		expect( screen.getByText( 'Background task completed' ) ).toBeVisible();
		expect( screen.queryByRole( 'img', { name: 'remote' } ) ).not.toBeInTheDocument();
	} );
	it( 'reopens only local screenshots in this conversation', async () => {
		const media = ( source: string, alt: string ) => ( {
			type: 'media',
			widgetProps: { mediaKind: 'image', source: { type: 'local', path: source }, alt },
		} );
		const { connector } = await setupSession( undefined, {}, [
			[
				{
					type: 'chat.artifact',
					runId: 'run',
					turnId: 'turn',
					artifact: {
						version: 1,
						id: 'capture',
						widgets: [
							media( '/old/sessions/claude-matrix.screenshots/shot.png', 'Home page' ),
							media( '/sessions/other.screenshots/other.png', 'Other session' ),
							{
								type: 'media',
								widgetProps: {
									mediaKind: 'image',
									url: 'https://example.test/remote.png',
									alt: 'Remote screenshot',
								},
							},
						],
					},
				},
			],
		] );
		expect( await screen.findByRole( 'img', { name: 'Home page' } ) ).toBeVisible();
		expect( connector.readLocalMediaFile ).toHaveBeenCalledExactlyOnceWith(
			'/sessions/claude-matrix.screenshots/shot.png',
			'claude-matrix'
		);
		expect( screen.queryByAltText( 'Other session' ) ).not.toBeInTheDocument();
		expect( screen.queryByAltText( 'Remote screenshot' ) ).not.toBeInTheDocument();
	} );

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

describe( 'Claude composer', () => {
	function edit( text: string ) {
		const input = screen.getByRole( 'combobox', { name: 'Message Claude' } );
		fireEvent.change( input, { target: { value: text } } );
		return input;
	}

	async function startTurn() {
		const setup = await setupSession();
		fireEvent.keyDown( edit( 'First turn' ), { key: 'Enter' } );
		await screen.findByRole( 'button', { name: 'Stop response' } );
		await waitFor( () => expect( setup.connector.continueSession ).toHaveBeenCalledOnce() );
		return setup;
	}

	function finishTurn( connector: Awaited< ReturnType< typeof setupSession > >[ 'connector' ] ) {
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
	}

	it( 'holds a text draft across remount while its file is staging and lets the user resolve a failed upload', async () => {
		const view = await setupSession();
		const file = new File( [ 'notes' ], 'notes.txt', { type: 'text/plain' } );
		const staging = deferred< string >();
		view.connector.stageClaudeChatFile.mockReturnValueOnce( staging.promise );
		fireEvent.change( screen.getByLabelText( 'Upload attachments' ), {
			target: { files: [ file ] },
		} );
		fireEvent.keyDown( edit( 'Wait for my notes' ), { key: 'Enter' } );
		expect( view.connector.continueSession ).not.toHaveBeenCalled();
		view.unmount();
		renderApp( { connector: view.connector, path: '/sessions/claude-matrix' } );
		expect( await screen.findByText( 'Preparing attachments…' ) ).toBeVisible();
		const input = screen.getByRole( 'combobox', { name: 'Message Claude' } );
		expect( input ).toHaveValue( 'Wait for my notes' );
		await act( async () => staging.reject( new Error( 'Upload interrupted' ) ) );
		await screen.findByText( 'This file could not be attached' );
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( view.connector.continueSession ).not.toHaveBeenCalled();
		fireEvent.click( screen.getByRole( 'button', { name: 'Dismiss' } ) );
		fireEvent.keyDown( input, { key: 'Enter' } );
		await waitFor( () =>
			expect( view.connector.continueSession ).toHaveBeenCalledWith(
				'claude-matrix',
				'Wait for my notes',
				expect.objectContaining( { files: [] } )
			)
		);
	} );

	it( 'recovers a staged file into its own draft when it finishes while the chat is closed', async () => {
		const view = await setupSession();
		const staging = deferred< string >();
		view.connector.stageClaudeChatFile.mockReturnValueOnce( staging.promise );
		edit( 'Review the file' );
		fireEvent.change( screen.getByLabelText( 'Upload attachments' ), {
			target: {
				files: [ new File( [ 'notes' ], 'notes.txt', { type: 'text/plain' } ) ],
			},
		} );
		await screen.findByText( 'Preparing attachments…' );
		view.unmount();
		await act( async () => staging.resolve( '/sessions/claude-matrix.attachments/id/notes.txt' ) );
		renderApp( { connector: view.connector, path: '/sessions/claude-matrix' } );
		expect( await screen.findByText( 'notes.txt' ) ).toBeVisible();
		expect( screen.getByRole( 'combobox', { name: 'Message Claude' } ) ).toHaveValue(
			'Review the file'
		);
	} );

	it( 'restores a rejected send alongside text entered after submission', async () => {
		const { connector } = await setupSession();
		const submission = deferred< { runId: string } >();
		connector.continueSession.mockReturnValueOnce( submission.promise );
		fireEvent.keyDown( edit( 'Original' ), { key: 'Enter' } );
		await waitFor( () => expect( connector.continueSession ).toHaveBeenCalledTimes( 1 ) );
		const input = edit( 'Follow-up draft' );
		await act( async () => submission.reject( new Error( 'Connection changed' ) ) );
		await waitFor( () => expect( input ).toHaveValue( 'Original\n\nFollow-up draft' ) );
	} );

	it( 'stages a picked file once and preserves its private reference through queue, edit and send', async () => {
		const { connector } = await startTurn();
		const staged = '/sessions/claude-matrix.attachments/attachment/notes.txt';
		const file = new File( [ 'notes' ], 'notes.txt', { type: 'text/plain' } );
		connector.stageClaudeChatFile.mockResolvedValue( staged );
		fireEvent.change( screen.getByLabelText( 'Upload attachments' ), {
			target: { files: [ file ] },
		} );
		await screen.findByText( 'notes.txt' );
		fireEvent.click( screen.getByRole( 'button', { name: 'Queue message' } ) );
		fireEvent.click( await screen.findByRole( 'button', { name: 'Edit queued message' } ) );
		await screen.findByText( 'notes.txt' );
		finishTurn( connector );
		const input = edit( 'Edited turn' );
		await waitFor( () =>
			expect( screen.getByRole( 'button', { name: 'Send message' } ) ).not.toHaveAttribute(
				'aria-disabled',
				'true'
			)
		);
		fireEvent.keyDown( input, { key: 'Enter' } );
		await waitFor( () =>
			expect( connector.continueSession ).toHaveBeenCalledWith(
				'claude-matrix',
				'Edited turn',
				expect.objectContaining( {
					claudeContext: {
						connectionId: 'c1',
						revision: 1,
						target: { environment: 'local', siteId: 'one' },
					},
					claudeSelection: { model: 'model-a', effort: 'medium' },
					files: [
						{
							id: expect.any( String ),
							name: 'notes.txt',
							path: staged,
							mimeType: 'text/plain',
							size: file.size,
						},
					],
				} )
			)
		);
		expect( connector.stageClaudeChatFile ).toHaveBeenCalledExactlyOnceWith(
			'claude-matrix',
			file
		);
		expect( connector.discardClaudeChatFile ).not.toHaveBeenCalled();
	} );

	it( 'discards explicitly removed private files only after their final draft or queue reference is gone', async () => {
		const { connector } = await startTurn();
		const path = '/private/conversation/notes.txt';
		const pick = async () => {
			fireEvent.change( screen.getByLabelText( 'Upload attachments' ), {
				target: { files: [ new File( [ 'draft' ], 'notes.txt', { type: 'text/plain' } ) ] },
			} );
			await screen.findByRole( 'button', { name: 'Remove attachment' } );
		};
		connector.stageClaudeChatFile.mockResolvedValue( path );
		await pick();
		fireEvent.click( screen.getByRole( 'button', { name: 'Remove attachment' } ) );
		await waitFor( () =>
			expect( connector.discardClaudeChatFile ).toHaveBeenCalledExactlyOnceWith(
				'claude-matrix',
				path
			)
		);
		connector.discardClaudeChatFile.mockClear();
		await pick();
		fireEvent.click( screen.getByRole( 'button', { name: 'Queue message' } ) );
		await screen.findByRole( 'button', { name: 'Remove queued message' } );
		await pick();
		fireEvent.click( screen.getByRole( 'button', { name: 'Remove queued message' } ) );
		expect( connector.discardClaudeChatFile ).not.toHaveBeenCalled();
		fireEvent.click( screen.getByRole( 'button', { name: 'Queue message' } ) );
		fireEvent.click( await screen.findByRole( 'button', { name: 'Remove queued message' } ) );
		await waitFor( () =>
			expect( connector.discardClaudeChatFile ).toHaveBeenCalledExactlyOnceWith(
				'claude-matrix',
				path
			)
		);
	} );

	it( 'discards newly staged files rejected by a concurrent attachment merge', async () => {
		const { connector } = await setupSession();
		connector.stageClaudeChatFile.mockImplementation(
			async ( _, file ) => '/private/' + file.name
		);
		const pick = ( names: string[] ) =>
			fireEvent.change( screen.getByLabelText( 'Upload attachments' ), {
				target: {
					files: names.map( ( name ) => new File( [ 'a' ], name, { type: 'text/plain' } ) ),
				},
			} );
		pick( Array.from( { length: 9 }, ( _, i ) => 'base' + i + '.txt' ) );
		await screen.findByText( 'base8.txt' );
		const stages = [ deferred< string >(), deferred< string >() ];
		for ( const pending of stages )
			connector.stageClaudeChatFile.mockReturnValueOnce( pending.promise );
		pick( [ 'keep.txt' ] );
		pick( [ 'excess.txt' ] );
		await act( async () => stages[ 0 ].resolve( '/private/keep.txt' ) );
		await screen.findByText( 'keep.txt' );
		await act( async () => stages[ 1 ].resolve( '/private/excess.txt' ) );
		await waitFor( () =>
			expect( connector.discardClaudeChatFile ).toHaveBeenCalledExactlyOnceWith(
				'claude-matrix',
				'/private/excess.txt'
			)
		);
		expect( screen.queryByText( 'excess.txt' ) ).not.toBeInTheDocument();
		fireEvent.click( screen.getByRole( 'button', { name: 'Dismiss' } ) );
	} );

	it( 'holds an image without verified vision and checks it again when its queue dispatches', async () => {
		const { connector, queryClient } = await startTurn();
		fireEvent.change( screen.getByLabelText( 'Upload attachments' ), {
			target: { files: [ new File( [ 'img' ], 'header.png', { type: 'image/png' } ) ] },
		} );
		await screen.findByText(
			'Choose a model that supports images before sending these attachments'
		);
		const input = edit( 'Check this image' );
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( screen.queryByRole( 'list', { name: 'Queued messages' } ) ).not.toBeInTheDocument();
		const option = { id: 'model-a', displayName: 'Model A', efforts: [ 'medium' as const ] };
		connector.getClaudeModelCatalog.mockResolvedValue( {
			ok: true,
			models: [ { ...option, imageInput: true } ],
		} );
		await act( async () => {
			await queryClient.invalidateQueries( { queryKey: [ 'claude-models' ] } );
		} );
		await waitFor( () =>
			expect( screen.getByRole( 'button', { name: 'Queue message' } ) ).not.toHaveAttribute(
				'aria-disabled',
				'true'
			)
		);
		fireEvent.keyDown( input, { key: 'Enter' } );
		await screen.findByRole( 'list', { name: 'Queued messages' } );
		connector.getClaudeModelCatalog.mockResolvedValue( { ok: true, models: [ option ] } );
		finishTurn( connector );
		await screen.findByText( 'This queued message needs review. Edit it to send again.' );
		expect( connector.continueSession ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'restores queued preview notes for editing with their original local target', async () => {
		const { connector } = await startTurn();
		act( () => {
			const id = pickAnnotation( 'one', { tag: 'h1', selector: 'h1', path: '/' } )!;
			changeAnnotation( 'one', id, { comment: 'Shorter heading' } );
			requestAnnotationSend( { siteId: 'one', noteIds: [ id ] } );
		} );
		const editMessage = await screen.findByRole( 'button', { name: 'Edit queued message' } );
		await waitFor( () => expect( getSiteAnnotations( 'one' ).notes ).toHaveLength( 0 ) );
		fireEvent.click( editMessage );
		expect( getSiteAnnotations( 'one' ).notes ).toEqual( [
			expect.objectContaining( { selector: 'h1', comment: 'Shorter heading', staged: true } ),
		] );
		finishTurn( connector );
		const input = edit( 'Keep this brief' );
		await waitFor( () =>
			expect( screen.getByRole( 'button', { name: 'Send message' } ) ).not.toHaveAttribute(
				'aria-disabled',
				'true'
			)
		);
		fireEvent.keyDown( input, { key: 'Enter' } );
		await waitFor( () =>
			expect( connector.continueSession ).toHaveBeenCalledWith(
				'claude-matrix',
				expect.stringContaining( 'Shorter heading' ),
				expect.objectContaining( {
					displayMessage: 'Keep this brief',
					visualAnnotations: expect.arrayContaining( [
						expect.objectContaining( { comment: 'Shorter heading', tag: 'h1' } ),
					] ),
				} )
			)
		);
	} );

	it.each( [ 'unchanged', 'account changed', 'target changed' ] )(
		'rechecks the connection and target before dispatch (%s)',
		async ( condition ) => {
			const { connector, session } = await startTurn();
			fireEvent.keyDown( edit( 'Queued turn' ), { key: 'Enter' } );
			await screen.findByRole( 'list', { name: 'Queued messages' } );
			if ( condition === 'account changed' )
				connector.getClaudeRuntimeState.mockResolvedValue( {
					enabled: true,
					connections: [
						{ id: 'c1', executablePath: '/claude', blockers: [], findings: [], revision: 2 },
					],
				} );
			if ( condition === 'target changed' ) {
				connector.getSession.mockResolvedValue( {
					...session,
					entries: [
						...session.entries,
						{
							id: 'site',
							type: 'custom',
							customType: 'studio.site_selected',
							parentId: null,
							timestamp: new Date().toISOString(),
							data: { siteId: 'one', remote: true, wpcomSiteId: 22 },
						},
					],
				} );
			}
			finishTurn( connector );
			if ( condition !== 'unchanged' ) {
				await screen.findByText( 'This queued message needs review. Edit it to send again.' );
				expect( connector.continueSession ).toHaveBeenCalledTimes( 1 );
				fireEvent.click( screen.getByRole( 'button', { name: 'Edit queued message' } ) );
				expect( screen.getByRole( 'combobox', { name: 'Message Claude' } ) ).toHaveValue(
					'Queued turn'
				);
			} else {
				await waitFor( () =>
					expect( connector.continueSession ).toHaveBeenCalledWith(
						'claude-matrix',
						'Queued turn',
						expect.objectContaining( {
							claudeSelection: { model: 'model-a', effort: 'medium' },
							claudeContext: {
								connectionId: 'c1',
								revision: 1,
								target: { environment: 'local', siteId: 'one' },
							},
						} )
					)
				);
			}
		}
	);
} );

describe( 'Claude questions', () => {
	const base = {
		runId: 'question-run',
		turnId: 'question-turn',
		toolCallId: 'question-call',
		requestId: 'batch-1',
	};
	const option = ( label: string ) => ( { label, description: label + ' description' } );
	const request: Extract< BackendTurnEvent, { type: 'question.asked' } > = {
		type: 'question.asked',
		...base,
		questions: [
			{
				question: 'Which sections?',
				multiSelect: true,
				options: [ option( 'News' ), option( 'Contact' ) ],
			},
			{
				question: 'What tone?',
				allowFreeForm: true,
				options: [ option( 'Quiet' ), option( 'Loud' ) ],
			},
			{ question: 'Add a footer?', options: [ option( 'Yes' ), option( 'No' ) ] },
		],
	};
	const active = ( pendingClaudeQuestions: Array< typeof request > ) => [
		{
			sessionId: 'claude-matrix',
			runId: request.runId,
			startedAt: 1,
			phase: 'running' as const,
			pendingClaudeQuestions,
		},
	];

	it( 'recovers a question that arrives before a cold snapshot identifies its run', async () => {
		const first = deferred< Awaited< ReturnType< Connector[ 'getActiveAgentRuns' ] > > >();
		const { connector, emit } = await setupSession( undefined, {
			getActiveAgentRuns: () => first.promise,
		} );
		connector.getActiveAgentRuns.mockResolvedValue( active( [ request ] ) );
		act( () => emit( request ) );
		expect( await screen.findByRole( 'checkbox', { name: 'News' } ) ).toBeDisabled();
		await act( async () => first.resolve( [] ) );
		await waitFor( () => expect( screen.getByRole( 'checkbox', { name: 'News' } ) ).toBeEnabled() );
		expect( connector.getActiveAgentRuns ).toHaveBeenCalledTimes( 2 );
	} );
	it( 'restores an older unanswered batch alongside a live question arriving during reconnect', async () => {
		const second = {
			...request,
			requestId: 'new-request',
			questions: [ { question: 'Title?', options: [ option( 'Hello' ) ] } ],
		};
		const { connector, emit } = await setupSession( undefined, {
			getActiveAgentRuns: async () => active( [] ),
		} );
		const delayed = deferred< Awaited< ReturnType< Connector[ 'getActiveAgentRuns' ] > > >();
		connector.getActiveAgentRuns
			.mockReturnValueOnce( delayed.promise )
			.mockResolvedValue( active( [ request, second ] ) );
		act( () => connector.emit( 'onConnectionRestored' ) );
		act( () => emit( second ) );
		expect( screen.getByRole( 'radio', { name: 'Hello' } ) ).toBeEnabled();
		await act( async () => delayed.resolve( active( [ request ] ) ) );
		await waitFor( () => expect( screen.getByRole( 'checkbox', { name: 'News' } ) ).toBeEnabled() );
		expect( screen.getByRole( 'radio', { name: 'Hello' } ) ).toBeEnabled();
		expect( connector.getActiveAgentRuns ).toHaveBeenCalledTimes( 3 );
	} );

	it( 'submits a restored batch once with multi-select, free text and skip', async () => {
		const { connector, emit } = await setupSession(
			undefined,
			{ getActiveAgentRuns: async () => active( [ request ] ) },
			[ [ request ] ]
		);
		act( () => emit( request ) );
		expect( await screen.findAllByRole( 'group', { name: 'Which sections?' } ) ).toHaveLength( 1 );
		fireEvent.click( screen.getByRole( 'checkbox', { name: 'News' } ) );
		fireEvent.click( screen.getByRole( 'checkbox', { name: 'Contact' } ) );
		fireEvent.click( screen.getByRole( 'button', { name: 'Next' } ) );
		fireEvent.click( screen.getByRole( 'button', { name: 'Write an answer' } ) );
		fireEvent.change( screen.getByRole( 'textbox', { name: 'Your answer' } ), {
			target: { value: 'Like a letter from a friend' },
		} );
		fireEvent.click( screen.getByRole( 'button', { name: 'Next' } ) );
		expect( connector.answerAgentQuestion ).not.toHaveBeenCalled();
		fireEvent.click( screen.getByRole( 'button', { name: 'Skip' } ) );
		await waitFor( () =>
			expect( connector.answerAgentQuestion ).toHaveBeenCalledExactlyOnceWith(
				request.runId,
				{
					'Which sections?': 'News, Contact',
					'What tone?': 'Like a letter from a friend',
					'Add a footer?': SKIPPED_QUESTION,
				},
				request.requestId
			)
		);
		expect( await screen.findByText( 'Skipped' ) ).toBeVisible();
		expect( screen.getByText( 'Like a letter from a friend' ) ).toBeVisible();
	} );

	it( 'keeps stale journals read-only, recovers new questions on reconnect, and cancels them on Stop', async () => {
		const { connector, session, emit } = await setupSession( undefined, {}, [ [ request ] ] );
		expect( screen.getByRole( 'checkbox', { name: 'News' } ) ).toBeDisabled();
		connector.getActiveAgentRuns.mockResolvedValue( active( [ request ] ) );
		act( () => connector.emit( 'onConnectionRestored' ) );
		await waitFor( () => expect( screen.getByRole( 'checkbox', { name: 'News' } ) ).toBeEnabled() );
		const snapshot = deferred< Awaited< ReturnType< Connector[ 'getActiveAgentRuns' ] > > >();
		connector.getActiveAgentRuns.mockReturnValueOnce( snapshot.promise );
		act( () => connector.emit( 'onConnectionRestored' ) );
		fireEvent.click( screen.getByRole( 'checkbox', { name: 'News' } ) );
		fireEvent.click( screen.getByRole( 'button', { name: 'Stop response' } ) );
		await waitFor( () =>
			expect( connector.interruptAgentRun ).toHaveBeenCalledExactlyOnceWith( request.runId )
		);
		await act( async () => snapshot.resolve( active( [ request ] ) ) );
		expect( await screen.findByText( 'Question cancelled' ) ).toBeVisible();
		expect( screen.queryByRole( 'button', { name: 'Next' } ) ).not.toBeInTheDocument();
		const resolved = { type: 'question.resolved' as const, ...base, answers: null };
		connector.getSession.mockResolvedValue( {
			...session,
			claudeJournal: [ [ request, resolved ] ],
		} );
		connector.getActiveAgentRuns.mockResolvedValue( [] );
		await act( async () => connector.emit( 'onConnectionRestored' ) );
		await waitFor( () =>
			expect( screen.queryByRole( 'button', { name: 'Stop response' } ) ).not.toBeInTheDocument()
		);
		act( () => emit( request ) );
		expect( screen.getByRole( 'checkbox', { name: 'News' } ) ).toBeDisabled();
		expect( connector.answerAgentQuestion ).not.toHaveBeenCalled();
	} );

	it( 'keeps simultaneous batches with the same question text independent and retries a failed redraw', async () => {
		const redraw = 'Show me other options';
		const design = {
			...request,
			questions: [ { question: 'Design?', options: [ option( 'One' ), option( redraw ) ] } ],
		};
		const second = { ...design, requestId: 'batch-2' };
		const { connector, emit } = await setupSession( undefined, {
			getActiveAgentRuns: async () => active( [ design, second ] ),
		} );
		const groups = await screen.findAllByRole( 'group', { name: 'Design?' } );
		connector.answerAgentQuestion.mockRejectedValueOnce( new Error( 'Connection lost' ) );
		fireEvent.click( within( groups[ 0 ] ).getByRole( 'radio', { name: redraw } ) );
		expect( await screen.findByText( 'Connection lost' ) ).toBeVisible();
		fireEvent.click( within( groups[ 0 ] ).getByRole( 'radio', { name: redraw } ) );
		await waitFor( () =>
			expect( connector.answerAgentQuestion.mock.calls ).toEqual( [
				[ request.runId, { 'Design?': redraw }, design.requestId ],
				[ request.runId, { 'Design?': redraw }, design.requestId ],
			] )
		);
		act( () => emit( { type: 'question.resolved', ...base, answers: { 'Design?': redraw } } ) );
		fireEvent.click( within( groups[ 1 ] ).getByRole( 'radio', { name: 'One' } ) );
		await waitFor( () =>
			expect( connector.answerAgentQuestion ).toHaveBeenLastCalledWith(
				request.runId,
				{ 'Design?': 'One' },
				second.requestId
			)
		);
	} );

	it( 'reopens the saved choices and zooms only previews belonging to this conversation', async () => {
		const path = '/old/root/claude-matrix.screenshots/';
		const design = {
			...request,
			questions: [
				{
					question: 'Pick a design',
					options: [
						{ ...option( 'Blue' ), image: path + 'blue.png' },
						{ ...option( 'Red' ), image: path + 'red.png' },
						{ ...option( 'Foreign' ), image: '/other/session.screenshots/foreign.png' },
						option( 'Show me other options' ),
					],
				},
			],
		};
		const { connector } = await setupSession( undefined, {}, [
			[
				design,
				{
					type: 'question.resolved',
					...base,
					answers: { 'Pick a design': 'Show me other options' },
				},
			],
		] );
		expect( screen.getByRole( 'radio', { name: 'Show me other options' } ) ).toBeChecked();
		expect( screen.getByRole( 'radio', { name: 'Blue' } ) ).toBeDisabled();
		fireEvent.click( screen.getByRole( 'button', { name: 'View Blue larger' } ) );
		expect( await screen.findByRole( 'img', { name: 'Blue' } ) ).toBeVisible();
		fireEvent.click( screen.getByRole( 'button', { name: 'Next option' } ) );
		expect( await screen.findByRole( 'img', { name: 'Red' } ) ).toBeVisible();
		expect( screen.queryByRole( 'button', { name: 'Choose' } ) ).not.toBeInTheDocument();
		expect( connector.readLocalMediaFile.mock.calls ).toEqual( [
			[ '/sessions/claude-matrix.screenshots/blue.png', 'claude-matrix' ],
			[ '/sessions/claude-matrix.screenshots/red.png', 'claude-matrix' ],
		] );
	} );
} );

describe( 'Claude selection and approval recovery', () => {
	it( 'requires a supported effort when changing to an incompatible model', async () => {
		const { connector } = await setupSession();
		fireEvent.change( screen.getByRole( 'combobox', { name: 'Message Claude' } ), {
			target: { value: 'Inspect the site' },
		} );
		await choose( 'Claude model', 'Model B' );
		expect( screen.getByText( 'Choose an effort for the selected model.' ) ).toBeVisible();
		expect( screen.getByRole( 'button', { name: 'Send message' } ) ).toHaveAttribute(
			'aria-disabled',
			'true'
		);
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
		expect( screen.getByRole( 'button', { name: 'Send message' } ) ).not.toHaveAttribute(
			'aria-disabled',
			'true'
		);
		expect( screen.queryByRole( 'spinbutton' ) ).not.toBeInTheDocument();
	} );

	it( 'holds a saved unsupported effort until the user explicitly chooses a supported one', async () => {
		const { connector } = await setupSession( { model: 'model-a', effort: 'max' } );
		fireEvent.change( screen.getByRole( 'combobox', { name: 'Message Claude' } ), {
			target: { value: 'Inspect the site' },
		} );
		expect( screen.getByRole( 'button', { name: 'Send message' } ) ).toHaveAttribute(
			'aria-disabled',
			'true'
		);
		expect( connector.setClaudeSessionSelection ).not.toHaveBeenCalled();
		await choose( 'Claude effort', 'high' );
		await waitFor( () =>
			expect( connector.setClaudeSessionSelection ).toHaveBeenCalledWith( 'claude-matrix', {
				model: 'model-a',
				effort: 'high',
			} )
		);
		expect( screen.getByRole( 'button', { name: 'Send message' } ) ).not.toHaveAttribute(
			'aria-disabled',
			'true'
		);
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
			fireEvent.change( screen.getByRole( 'combobox', { name: 'Message Claude' } ), {
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
			expect( screen.getByRole( 'button', { name: 'Send message' } ) ).toHaveAttribute(
				'aria-disabled',
				'true'
			);
			expect( screen.getByRole( 'combobox', { name: 'Message Claude' } ) ).toHaveValue(
				'Hold this until I choose again'
			);
			expect( connector.continueSession ).not.toHaveBeenCalled();
		}
	);

	it.each( [ 'native-auth-unqualified', 'native-runtime-unqualified', 'connection-not-found' ] )(
		'holds the prompt when rechecking the runtime reports %s',
		async ( blocker ) => {
			const { connector, queryClient } = await setupSession();
			const prompt = screen.getByRole( 'combobox', { name: 'Message Claude' } );
			fireEvent.change( prompt, { target: { value: 'Private unsent prompt' } } );
			connector.getClaudeModelCatalog.mockResolvedValue( { ok: false, blockers: [ blocker ] } );
			await act( async () => {
				await queryClient.invalidateQueries( { queryKey: [ 'claude-models' ] } );
			} );
			expect( await screen.findByText( describeClaudeIssue( blocker ) ) ).toBeVisible();
			expect( screen.getByRole( 'button', { name: 'Send message' } ) ).toHaveAttribute(
				'aria-disabled',
				'true'
			);
			expect( prompt ).toHaveValue( 'Private unsent prompt' );
			expect( connector.setSessionProvider ).not.toHaveBeenCalled();
			expect( connector.continueSession ).not.toHaveBeenCalled();
		}
	);

	it( 'holds the prompt after a failed catalog refresh instead of using stale capabilities', async () => {
		const { connector, queryClient } = await setupSession();
		fireEvent.change( screen.getByRole( 'combobox', { name: 'Message Claude' } ), {
			target: { value: 'Private unsent prompt' },
		} );
		connector.getClaudeModelCatalog.mockRejectedValue( new Error( 'Runtime unavailable.' ) );
		await act( async () => {
			await queryClient.invalidateQueries( { queryKey: [ 'claude-models' ] } );
		} );
		expect(
			await screen.findByText( 'Claude Code model capabilities could not be checked.' )
		).toBeVisible();
		expect( screen.getByRole( 'button', { name: 'Send message' } ) ).toHaveAttribute(
			'aria-disabled',
			'true'
		);
		expect( connector.continueSession ).not.toHaveBeenCalled();
	} );

	it.each( [ 'removed', 'blocked', 'unreachable' ] )(
		'holds the prompt when the selected connection becomes %s',
		async ( condition ) => {
			const { connector, queryClient } = await setupSession();
			const prompt = screen.getByRole( 'combobox', { name: 'Message Claude' } );
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
			expect( screen.getByRole( 'button', { name: 'Send message' } ) ).toHaveAttribute(
				'aria-disabled',
				'true'
			);
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
		fireEvent.change( screen.getByRole( 'combobox', { name: 'Message Claude' } ), {
			target: { value: 'Use the saved choice' },
		} );
		fireEvent.click( screen.getByRole( 'button', { name: 'Send message' } ) );
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
		const prompt = screen.getByRole( 'combobox', { name: 'Message Claude' } );
		fireEvent.change( prompt, { target: { value: 'Do not send with the old effort' } } );
		fireEvent.click( screen.getByRole( 'button', { name: 'Send message' } ) );
		await act( async () => save.reject( new Error( 'Latest save failed.' ) ) );
		await waitFor( () => expect( prompt ).toHaveValue( 'Do not send with the old effort' ) );
		expect( screen.getByRole( 'combobox', { name: 'Claude effort' } ) ).toHaveTextContent(
			'medium'
		);
		expect( connector.continueSession ).not.toHaveBeenCalled();
	} );

	it( 'holds setting changes during an active tool and uses them only for the next turn', async () => {
		const { connector, emit } = await setupSession();
		const prompt = screen.getByRole( 'combobox', { name: 'Message Claude' } );
		fireEvent.change( prompt, { target: { value: 'First turn' } } );
		fireEvent.click( screen.getByRole( 'button', { name: 'Send message' } ) );
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
		fireEvent.click( screen.getByRole( 'button', { name: 'Send message' } ) );
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
		operation: {
			tool: 'sites.wpCli',
			operationClass: 'command',
			target: { environment: 'local', siteId: 'site' },
			args: '[]',
			localPaths: [] as string[],
		},
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
			getClaudeRuntimeState: async () => ( {
				enabled: true,
				connections: [
					{ id: 'c1', executablePath: 'C:\\Claude\\claude.exe', blockers: [], findings: [] },
				],
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
					operation: {
						tool: 'sites.wpCli',
						operationClass: 'command',
						target: { environment: 'local', siteId: 'site' },
						args: '[]',
						localPaths: [],
					},
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

describe( 'what a Claude approval card shows', () => {
	// An approval as the execution policy sends it: the arguments as escaped,
	// indented JSON, the local paths and the remote, each escaped.
	const approval = (
		requestId: string,
		description: string,
		operation: Omit< BackendApprovalOperation, 'args' | 'target' | 'localPaths' > & {
			args: unknown;
			target?: BackendApprovalOperation[ 'target' ];
			localPaths?: string[];
		}
	): Extract< BackendTurnEvent, { type: 'approval.requested' } > => ( {
		type: 'approval.requested',
		runId: 'run-1',
		turnId: 'turn-1',
		requestId,
		toolCallId: `tool-${ requestId }`,
		description: escapeClaudeApprovalText( description ),
		operation: {
			...operation,
			target: operation.target ?? { environment: 'local', siteId: 'one' },
			args: escapeClaudeApprovalText( JSON.stringify( operation.args, null, 2 ) ),
			localPaths: ( operation.localPaths ?? [] ).map( escapeClaudeApprovalText ),
		},
	} );
	const wpcomRequest = approval( 'wpcom', 'Change something on WordPress.com: wpcom_request', {
		tool: 'wpcom_request',
		operationClass: 'remote-change',
		target: { environment: 'live', siteId: 'one', wpcomSiteId: 4242 },
		args: { method: 'POST', path: '/wp/v2/sites/4242/pages/12' },
		remote: 'WordPress.com site 4242',
	} );
	const siteExport = approval( 'export', 'Change or delete local work: sites.export', {
		tool: 'sites.export',
		operationClass: 'local-overwrite',
		args: { path: '/sites/one/exports/harbor-bakery.zip', mode: 'full' },
		localPaths: [ '/sites/one', '/sites/one/exports/harbor-bakery.zip' ],
	} );
	// A production site and its staging copy, which WordPress.com names alike.
	const push = (
		requestId: string,
		remoteSite: { id: number; name: string; address: string; kind: 'production' | 'staging' }
	) =>
		approval(
			requestId,
			`Change or delete work on WordPress.com: sync.push. It uploads this local site to the connected WordPress.com site ${ remoteSite.id } (a ${ remoteSite.kind } site, ${ remoteSite.address }, named "${ remoteSite.name }") with the options all, replacing the database and every file in wp-content on that site. If it is interrupted, the import of what it uploaded may still be running on WordPress.com`,
			{
				tool: 'sync.push',
				operationClass: 'remote-overwrite',
				args: {
					direction: 'push',
					remoteSite,
					overwrites: [ 'the database and every file in wp-content' ],
				},
				localPaths: [ '/sites/one' ],
				remote: `WordPress.com site ${ remoteSite.id }: a ${ remoteSite.kind } site, ${ remoteSite.address }, named "${ remoteSite.name }"`,
			}
		);
	const pushProduction = push( 'push-production', {
		id: 7101,
		name: 'Harbor Bakery',
		address: 'harborbakery.example.test',
		kind: 'production',
	} );
	const pushStaging = push( 'push-staging', {
		id: 7102,
		name: 'Harbor Bakery',
		address: 'staging-harborbakery.example.test',
		kind: 'staging',
	} );
	const FEEDBACK_DESCRIPTION =
		'Send a message outside Studio: send_feedback. It sends the type and message shown, with a line naming this Studio version and operating system, to the WordPress Studio team at Automattic through WordPress.com, signed in as the WordPress.com account Studio is logged in to';
	const feedback = ( requestId: string, message: string ) =>
		approval( requestId, FEEDBACK_DESCRIPTION, {
			tool: 'send_feedback',
			operationClass: 'external-message',
			args: { type: 'request', message },
		} );
	const images = {
		images: [
			{
				path: '/sites/one/wp-content/uploads/hero.png',
				subject: 'A bread counter at dawn',
				pageContext: 'full-width hero',
				style: 'photorealistic',
				aspectRatio: 'landscape',
			},
			{ path: '/sites/one/wp-content/uploads/band.png', subject: 'Pebbles on a beach' },
		],
		siteContext: 'A seaside bakery.',
		imageGrade: 'warm natural light',
	};
	const generateImages = approval(
		'images',
		'Change something on WordPress.com: generate_images. It sends a prompt made from each image’s subject, page context and style, and the call’s site context and grade, to Studio’s image service on WordPress.com, signed in with that service’s own credential, and writes each image it gets back in this site at the path shown',
		{
			tool: 'generate_images',
			operationClass: 'remote-change',
			args: images,
			localPaths: images.images.map( ( image ) => image.path ),
		}
	);

	async function showApprovals( ...events: BackendTurnEvent[] ) {
		const view = await setupSession();
		act( () => {
			view.connector.emit( 'onAgentEvent', {
				sessionId: 'claude-matrix',
				runId: 'run-1',
				event: { type: 'run.started', timestamp: new Date().toISOString() },
			} );
			for ( const event of events ) view.emit( event );
		} );
		await waitFor( () =>
			expect( screen.getAllByRole( 'group', { name: /^Allow this operation/ } ) ).toHaveLength(
				events.length
			)
		);
		return view;
	}
	// The card that carries a description, and its approve and deny actions.
	const card = ( description: string | RegExp ) =>
		screen
			.getAllByRole( 'group', { name: /^Allow this operation/ } )
			.find( ( group ) =>
				within( group ).queryByRole( 'button', { name: 'Allow', description } )
			)!;
	const actions = ( group: HTMLElement ) => ( {
		allow: within( group ).getByRole( 'button', { name: 'Allow' } ),
		deny: within( group ).getByRole( 'button', { name: 'Deny' } ),
	} );

	it( 'shows a WordPress.com request’s method and path, its remote and the live site it acts on', async () => {
		await showApprovals( wpcomRequest );
		const group = card( 'Change something on WordPress.com: wpcom_request' );
		expect( within( group ).getByText( 'POST' ) ).toBeVisible();
		expect( within( group ).getByText( '/wp/v2/sites/4242/pages/12' ) ).toBeVisible();
		expect( within( group ).getByText( 'WordPress.com site 4242' ) ).toBeVisible();
		expect( within( group ).getByText( /The live WordPress.com site/ ) ).toHaveTextContent(
			'The live WordPress.com site 4242, connected to My site'
		);
		expect( group ).toHaveAccessibleName( /wpcom_request/ );
		for ( const button of Object.values( actions( group ) ) ) {
			expect( button ).toHaveAccessibleDescription( wpcomRequest.description );
		}
	} );

	it( 'shows the file an export writes, its mode and the local paths it touches', async () => {
		await showApprovals( siteExport );
		const group = card( 'Change or delete local work: sites.export' );
		expect( within( group ).getAllByText( '/sites/one/exports/harbor-bakery.zip' ) ).toHaveLength(
			2
		);
		expect( within( group ).getByText( 'full' ) ).toBeVisible();
		expect( within( group ).getByText( '/sites/one' ) ).toBeVisible();
		expect( within( group ).getByText( /local site/ ) ).toHaveTextContent( 'My site' );
		expect( within( group ).getByText( 'Mode' ) ).toBeVisible();
		expect( actions( group ).allow ).toHaveAccessibleDescription( siteExport.description );
	} );

	it( 'shows which WordPress.com site a push replaces, so a production site and its staging copy read differently', async () => {
		await showApprovals( pushProduction, pushStaging );
		const production = card( /a production site, harborbakery\.example\.test/ );
		const staging = card( /a staging site, staging-harborbakery\.example\.test/ );
		expect( production ).not.toBe( staging );
		expect(
			within( production ).getByText(
				'WordPress.com site 7101: a production site, harborbakery.example.test, named "Harbor Bakery"'
			)
		).toBeVisible();
		expect( within( production ).getByText( 'production' ) ).toBeVisible();
		expect( within( production ).getByText( '7101' ) ).toBeVisible();
		expect(
			within( production ).getByText( 'the database and every file in wp-content' )
		).toBeVisible();
		expect( within( production ).queryByText( 'staging' ) ).not.toBeInTheDocument();
		expect(
			within( staging ).getByText(
				'WordPress.com site 7102: a staging site, staging-harborbakery.example.test, named "Harbor Bakery"'
			)
		).toBeVisible();
		expect( within( staging ).getByText( 'staging' ) ).toBeVisible();
		expect( within( staging ).getByText( 'staging-harborbakery.example.test' ) ).toBeVisible();
		expect( within( staging ).queryByText( 'production' ) ).not.toBeInTheDocument();
		expect( actions( production ).allow ).toHaveAccessibleDescription(
			expect.stringContaining( 'a production site' )
		);
		expect( actions( staging ).allow ).toHaveAccessibleDescription(
			expect.stringContaining( 'a staging site' )
		);
	} );

	it( 'shows the feedback’s type and message', async () => {
		await showApprovals(
			feedback( 'feedback', 'Let me choose the uploads folder for each site.' )
		);
		const group = card( FEEDBACK_DESCRIPTION );
		expect( within( group ).getByText( 'request' ) ).toBeVisible();
		expect(
			within( group ).getByText( 'Let me choose the uploads folder for each site.' )
		).toBeVisible();
		expect( actions( group ).allow ).toHaveAccessibleDescription( FEEDBACK_DESCRIPTION );
	} );

	it( 'keeps a very long feedback message whole and readable', async () => {
		const message = `${ 'Please keep the drafts I wrote last week in the same order. '.repeat(
			200
		) }The end of the message.`;
		await showApprovals( feedback( 'long', message ) );
		const group = card( FEEDBACK_DESCRIPTION );
		const shown = within( group ).getByText( message );
		expect( shown ).toBeVisible();
		expect( shown ).toHaveTextContent( message );
		expect( actions( group ).allow ).toHaveAccessibleDescription( FEEDBACK_DESCRIPTION );
	} );

	it( 'shows each image’s specification and path, one per image', async () => {
		await showApprovals( generateImages );
		const group = card( /^Change something on WordPress\.com: generate_images\./ );
		const items = within( group ).getAllByRole( 'listitem' );
		const hero = items.filter(
			( item ) => item.textContent?.includes( 'A bread counter at dawn' )
		);
		const band = items.filter( ( item ) => item.textContent?.includes( 'Pebbles on a beach' ) );
		expect( hero ).toHaveLength( 1 );
		expect( band ).toHaveLength( 1 );
		for ( const text of [
			'/sites/one/wp-content/uploads/hero.png',
			'full-width hero',
			'photorealistic',
			'landscape',
		] )
			expect( within( hero[ 0 ] ).getByText( text ) ).toBeVisible();
		expect( hero[ 0 ] ).not.toHaveTextContent( 'Pebbles on a beach' );
		expect(
			within( band[ 0 ] ).getByText( '/sites/one/wp-content/uploads/band.png' )
		).toBeVisible();
		expect( within( group ).getByText( 'A seaside bakery.' ) ).toBeVisible();
		expect( within( group ).getByText( 'warm natural light' ) ).toBeVisible();
		expect( actions( group ).allow ).toHaveAccessibleDescription( generateImages.description );
	} );

	it( 'keeps a control character the policy escaped escaped, rather than decoding it', async () => {
		const reversed = 'Rename the file to \u202egnp.exe';
		await showApprovals( feedback( 'escaped', reversed ) );
		const group = card( FEEDBACK_DESCRIPTION );
		expect( within( group ).getByText( 'Rename the file to \\u202egnp.exe' ) ).toBeVisible();
		expect( group ).not.toHaveTextContent( /\u202e/ );
	} );

	it( 'approves and denies each request by its ID, as before', async () => {
		const { connector } = await showApprovals(
			wpcomRequest,
			siteExport,
			pushProduction,
			pushStaging,
			feedback( 'feedback', 'Let me choose the uploads folder for each site.' ),
			generateImages
		);
		fireEvent.click( actions( card( /a production site,/ ) ).allow );
		await waitFor( () =>
			expect( connector.answerAgentQuestion ).toHaveBeenCalledExactlyOnceWith( 'run-1', {
				'push-production': 'allow',
			} )
		);
		fireEvent.click( actions( card( FEEDBACK_DESCRIPTION ) ).deny );
		await waitFor( () =>
			expect( connector.answerAgentQuestion ).toHaveBeenLastCalledWith( 'run-1', {
				feedback: 'deny',
			} )
		);
		await waitFor( () =>
			expect( screen.getAllByRole( 'group', { name: /^Allow this operation/ } ) ).toHaveLength( 4 )
		);
		expect( screen.queryByText( /a production site,/ ) ).not.toBeInTheDocument();
		expect( screen.queryByText( FEEDBACK_DESCRIPTION ) ).not.toBeInTheDocument();
	} );

	it( 'hides a pending approval restored into a Claude chat while its runtime is disabled', async () => {
		await setupSession( undefined, {
			getClaudeRuntimeState: async () => ( { enabled: false, connections: [] } ),
			getActiveAgentRuns: async () => [
				{
					sessionId: 'claude-matrix',
					runId: 'run-1',
					startedAt: 1,
					phase: 'running',
					pendingClaudeApprovals: [ wpcomRequest ],
				},
			],
		} );
		expect(
			await screen.findByText( 'Claude Code is unavailable. Recheck its status in Settings.' )
		).toBeVisible();
		expect( await screen.findByRole( 'button', { name: 'Stop response' } ) ).toBeVisible();
		expect( screen.queryByRole( 'button', { name: 'Allow' } ) ).not.toBeInTheDocument();
	} );

	it.each( [
		{ args: { deleteFiles: true }, answer: 'Yes' },
		{ args: [ false ], answer: 'No' },
	] )(
		'shows the delete decision and its recovery warning after hydration ($answer)',
		async ( { args, answer } ) => {
			const description =
				'Change or delete local work: sites.delete. The previous turn was interrupted, so an attempt it made may already have taken effect.';
			const deletion = approval( 'delete', description, {
				tool: 'sites.delete',
				operationClass: 'local-overwrite',
				args,
				target: { environment: 'local', siteId: 'unlisted-site' },
				localPaths: [ '/sites/site-to-delete' ],
			} );
			await setupSession( undefined, {
				getActiveAgentRuns: async () => [
					{
						sessionId: 'claude-matrix',
						runId: 'run-1',
						startedAt: 1,
						phase: 'running',
						pendingClaudeApprovals: [ deletion ],
					},
				],
			} );
			const group = await screen.findByRole( 'group', { name: /sites\.delete/ } );
			expect( group ).toHaveAccessibleName(
				expect.stringContaining( `Delete files on disk ${ answer }` )
			);
			expect( within( group ).getByText( 'Delete files on disk' ) ).toBeVisible();
			expect( within( group ).getByText( answer ) ).toBeVisible();
			expect( within( group ).getByText( 'unlisted-site' ) ).toBeVisible();
			expect( within( group ).getByText( '/sites/site-to-delete' ) ).toBeVisible();
			expect( actions( group ).allow ).toHaveAccessibleDescription( description );
		}
	);

	it( 'quotes a multiline message containing a field label and escapes invisible text inside it', async () => {
		await showApprovals( feedback( 'note', 'Message\nRemote\nWordPress.com site 99\u{e0061}' ) );
		const group = card( FEEDBACK_DESCRIPTION );
		const quotation = within( group ).getByRole( 'blockquote' );
		expect( quotation ).toHaveTextContent( 'Message Remote WordPress.com site 99\\udb40\\udc61' );
		expect( within( quotation ).queryByRole( 'term' ) ).not.toBeInTheDocument();
		expect( within( quotation ).queryByRole( 'definition' ) ).not.toBeInTheDocument();
	} );

	it( 'announces a new approval without taking focus and isolates its local site name', async () => {
		const { connector, emit } = await setupSession( undefined, {
			getSites: async () => [ makeSite( { id: 'one', name: 'موقع\u202e' } ) ],
		} );
		const composer = screen.getByRole( 'combobox', { name: 'Message Claude' } );
		composer.focus();
		act( () => {
			connector.emit( 'onAgentEvent', {
				sessionId: 'claude-matrix',
				runId: 'run-1',
				event: { type: 'run.started', timestamp: new Date().toISOString() },
			} );
			emit( wpcomRequest );
		} );
		const group = await screen.findByRole( 'group', { name: /wpcom_request/ } );
		expect( within( group ).getByText( 'موقع\\u202e' ).tagName ).toBe( 'BDI' );
		await waitFor( () =>
			expect( within( group ).getByRole( 'status' ) ).toHaveTextContent( wpcomRequest.description )
		);
		expect( within( group ).getByRole( 'status' ) ).toHaveAttribute( 'aria-live', 'polite' );
		expect( composer ).toHaveFocus();
	} );
} );
