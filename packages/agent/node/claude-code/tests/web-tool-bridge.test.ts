import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { expect, it, vi } from 'vitest';
import { fakeSite } from '../../tests/fake-host';
import { claudeBrowserConfinement } from '../execution-rules';
import { createStudioClaudeToolBridge } from '../tool-bridge';
import { createPolicyFixture } from './fixtures/execution-policy';
import type { AddressInfo } from 'node:net';

// Use the same registry, authorization, host and abort signal as a Claude turn.
it.skipIf( ! existsSync( chromium.executablePath() ) )(
	'Stop ends a screenshot through the Claude bridge and leaves no artifact',
	async () => {
		let began!: () => void;
		const requested = new Promise< void >( ( resolve ) => {
			began = resolve;
		} );
		const server = createServer( ( _req, res ) => {
			res.writeHead( 200, { 'Content-Type': 'text/html' } );
			res.write( '<title>Slow page</title>' );
			began();
		} );
		server.listen( 0, '127.0.0.1' );
		await once( server, 'listening' );
		const origin = 'http://127.0.0.1:' + ( server.address() as AddressInfo ).port;
		const fixture = await createPolicyFixture( ( { site } ) => ( {
			targetSite: { id: fakeSite.id, path: site, url: origin },
			navigationConfinement: claudeBrowserConfinement( origin ),
		} ) );
		fixture.localSite.url = origin;
		const showArtifact = vi.fn();
		fixture.host.ui = { showArtifact, reloadPreview: vi.fn() };
		const bridge = createStudioClaudeToolBridge(
			fixture.host,
			{ policy: fixture.policy, runId: 'run', turnId: 'turn' },
			() => {}
		);
		try {
			const socketClosed = new Promise< void >( ( resolve ) =>
				server.once( 'connection', ( socket ) => socket.once( 'close', () => resolve() ) )
			);
			const result = bridge.invoke( 'take_screenshot', { url: origin } );
			// A refusal at startup must fail the test immediately.
			await Promise.race( [
				requested,
				result.then( () => {
					throw new Error( 'Screenshot ended before its page requested the document' );
				} ),
			] );
			fixture.controller.abort();
			expect( ( await result ).isError ).toBe( true );
			await socketClosed;
			expect( showArtifact ).not.toHaveBeenCalled();
		} finally {
			fixture.controller.abort();
			server.closeAllConnections();
			await bridge.dispose();
			await new Promise< void >( ( resolve ) => server.close( () => resolve() ) );
			await fixture.cleanup();
		}
	},
	30000
);
