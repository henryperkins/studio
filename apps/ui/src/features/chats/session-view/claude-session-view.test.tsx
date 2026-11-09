import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFakeConnector, makeSession, makeSite } from '@/test/fake-connector';
import { renderApp } from '@/test/render';
import type { SessionEntry } from '@/data/core';

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
