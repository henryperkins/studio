import { createDisconnectedOpenAiSettings } from '@studio/agent/protocol/providers';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createFakeConnector, makeSession, makeSite, TEST_USER } from '@/test/fake-connector';
import { renderApp } from '@/test/render';
import {
	assistantToolCallEntry,
	promptEntry,
	toolResultEntry,
	turnClosedEntry,
} from '@/test/session-entries';
import type { SessionEntry } from '@/data/core';

vi.setConfig( { testTimeout: 30_000 } );

const RESULT_TEXT = 'Generating 1 image in the background.';

const pin = ( data: Record< string, unknown > ): SessionEntry =>
	( {
		type: 'custom',
		id: 'pin',
		parentId: null,
		timestamp: new Date( 0 ).toISOString(),
		customType: 'studio.session_context',
		data,
	} ) as unknown as SessionEntry;

// A generate_images row as the runtime records it off a subscription plan's route.
const imageRow = (): SessionEntry[] => [
	promptEntry( 'Add a hero image.' ),
	assistantToolCallEntry( 'generate_images', {
		images: [ { path: '/sites/example/wp-content/uploads/hero.png', subject: 'A loaf' } ],
	} ),
	toolResultEntry( RESULT_TEXT ),
	turnClosedEntry( 'success' ),
];

async function openChat( entries: SessionEntry[], withApiKey: boolean ) {
	const connector = createFakeConnector(
		{
			user: withApiKey ? null : TEST_USER,
			sites: [ makeSite( { id: 'example', name: 'Example' } ) ],
			sessions: [
				{
					summary: makeSession( { id: 'chat', ownerSiteId: 'example', firstPrompt: 'Hello' } ),
					entries,
				},
			],
		},
		{
			getAiSettings: async () => ( {
				provider: 'wpcom',
				hasAnthropicApiKey: false,
				anthropicApiKeyPreview: null,
				hasOpenAiApiKey: withApiKey,
				openAi: createDisconnectedOpenAiSettings(),
			} ),
		}
	);
	renderApp( { connector, path: '/sessions/chat' } );
	fireEvent.click( await screen.findByRole( 'button', { name: /^Worked/ } ) );
	fireEvent.click( await screen.findByRole( 'button', { name: /1 image/ } ) );
	expect( await screen.findByText( RESULT_TEXT ) ).toBeVisible();
}

describe( 'the image service line on a generate_images row', () => {
	it.each( [
		[ 'a WordPress.com chat', [ pin( { provider: 'wpcom', model: 'balanced' } ) ], false ],
		[ 'an API-key chat', [ pin( { provider: 'openai-api-key', model: 'gpt-6.1-sol' } ) ], true ],
	] as const )( 'is absent in %s', async ( _chat, context, withApiKey ) => {
		await openChat( [ ...context, ...imageRow() ], withApiKey );

		expect( screen.queryByText( /image service/ ) ).not.toBeInTheDocument();
		expect( screen.queryByText( TEST_USER.email ) ).not.toBeInTheDocument();
	} );
} );
