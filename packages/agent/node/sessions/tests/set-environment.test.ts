import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSessionEnvironment, setClaudeSessionTarget } from '@studio/agent/node/sessions/manage';
import { createAiSession, loadAiSession } from '@studio/agent/node/sessions/store';
import { resolveClaudeSession } from '@studio/agent/protocol/claude-code';

const SITE = { id: 'site-1', name: 'My Site', path: '/tmp/my-site' };

vi.mock( '@studio/common/sites/site-path', () => ( { readSites: async () => [ SITE ] } ) );
vi.mock( '@studio/common/lib/shared-config', async ( importOriginal ) => ( {
	...( await importOriginal< object >() ),
	readSharedSession: async () => undefined,
} ) );
vi.mock( '@studio/agent/node/sessions/placement', async ( importOriginal ) => ( {
	...( await importOriginal< object >() ),
	readAiSessionPlacement: async () => ( {
		kind: 'site',
		siteId: SITE.id,
		sitePath: SITE.path,
		siteName: SITE.name,
	} ),
} ) );
const connected = vi.hoisted( () => ( { sites: [] as object[] } ) );
vi.mock( '@studio/common/lib/connected-sites', () => ( {
	getConnectedWpcomSitesForLocalSite: async () => connected.sites,
} ) );

describe( 'setSessionEnvironment', () => {
	let root: string;

	beforeEach( async () => {
		root = await fs.mkdtemp( path.join( os.tmpdir(), 'studio-set-env-' ) );
		connected.sites = [
			{ id: 7, name: 'Staging', url: 'https://staging.example', isStaging: true },
			{ id: 42, name: 'Production', url: 'https://mysite.example', isStaging: false },
		];
	} );

	afterEach( () => fs.rm( root, { recursive: true, force: true } ) );

	it( 'switches to the production connection and back to the local site', async () => {
		const { id } = await createAiSession( root, { site: SITE } );

		await setSessionEnvironment( root, id, 'live' );
		let { summary } = await loadAiSession( root, id );
		expect( summary.activeEnvironment ).toBe( 'live' );
		expect( summary.lastSelectedWpcomSiteId ).toBe( 42 );

		await setSessionEnvironment( root, id, 'local' );
		( { summary } = await loadAiSession( root, id ) );
		expect( summary.activeEnvironment ).toBe( 'local' );
	} );

	it( 'refuses Live when the site has no connection', async () => {
		connected.sites = [];
		const { id } = await createAiSession( root, { site: SITE } );

		await expect( setSessionEnvironment( root, id, 'live' ) ).rejects.toThrow(
			'This site is not connected to a WordPress.com site.'
		);
	} );

	const claude = ( siteId: string | null ) => ( {
		binding: {
			connectionId: 'connection',
			siteId,
			workingDirectory: SITE.path,
			configDirectory: '/config',
		},
		selection: { model: 'model', effort: 'medium' as const },
	} );

	it( 'switches a Claude conversation between its site and the live site, keeping its native binding', async () => {
		const options = { site: SITE, claude: claude( SITE.id ) };
		const { id } = await createAiSession( root, options );

		await setSessionEnvironment( root, id, 'live' );
		let loaded = await loadAiSession( root, id );
		expect( loaded.summary.activeEnvironment ).toBe( 'live' );
		expect( resolveClaudeSession( loaded.entries ) ).toMatchObject( {
			binding: options.claude.binding,
			target: { environment: 'live', siteId: SITE.id, wpcomSiteId: 42 },
		} );

		await setSessionEnvironment( root, id, 'local' );
		loaded = await loadAiSession( root, id );
		expect( loaded.summary.activeEnvironment ).toBe( 'local' );
		expect( resolveClaudeSession( loaded.entries ) ).toMatchObject( {
			binding: options.claude.binding,
			target: { environment: 'local', siteId: SITE.id },
		} );
	} );

	it( 'returns a global chat from a chosen live site to Studio and refuses stale target choices', async () => {
		const { id } = await createAiSession( root, { claude: claude( null ) } );
		const initial = { environment: 'global' } as const;
		const local = { environment: 'local', siteId: SITE.id } as const;
		const live = { environment: 'live', siteId: SITE.id, wpcomSiteId: 7 } as const;
		await setClaudeSessionTarget( root, id, initial, local );
		await expect( setClaudeSessionTarget( root, id, initial, live ) ).rejects.toThrow( 'changed' );
		await expect(
			setClaudeSessionTarget( root, id, local, { ...live, wpcomSiteId: 1234 } )
		).rejects.toThrow( 'no longer connected' );
		await setClaudeSessionTarget( root, id, local, live );
		let chat = await loadAiSession( root, id );
		expect( resolveClaudeSession( chat.entries )?.target ).toEqual( live );
		await setClaudeSessionTarget( root, id, live, initial );
		chat = await loadAiSession( root, id );
		expect( resolveClaudeSession( chat.entries ) ).toMatchObject( {
			target: initial,
			binding: claude( null ).binding,
		} );
	} );

	it( 'refuses to point a Claude conversation at a site other than the one it works in', async () => {
		const other = { id: 'site-2', name: 'Other', path: '/tmp/other' };
		const { id } = await createAiSession( root, { site: other, claude: claude( other.id ) } );

		await expect( setSessionEnvironment( root, id, 'local' ) ).rejects.toThrow(
			'Start a new chat'
		);
		const loaded = await loadAiSession( root, id );
		expect( resolveClaudeSession( loaded.entries )?.target ).toEqual( {
			environment: 'local',
			siteId: other.id,
		} );
	} );
} );
