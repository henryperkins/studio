import { mkdtemp, realpath, rm, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import { getConnectedWpcomSitesForLocalSite } from '@studio/common/lib/connected-sites';
import { readSite } from '@studio/common/sites/site-path';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveClaudeSession } from '@studio/agent/protocol/claude-code';
import { loadHydratedAiSession } from '../../sessions/manage';
import {
	appendStudioEntry,
	createAiSession,
	deleteAiSession,
	loadAiSession,
} from '../../sessions/store';
import { getClaudeConnections } from '../connection';
import { claudePlatformTarget, currentClaudeHost } from '../platform';
import { discoverClaudeModels } from '../runtime';
import {
	createNativeSessionStore,
	getClaudeGlobalWorkspace,
	getClaudeSessionStoreRoot,
} from '../sessions';
import {
	createClaudeSession,
	getClaudeRuntimeState,
	setClaudeSessionSelection,
	validateClaudeSendSelection,
	verifyClaudeTurnSession,
	verifyClaudeTurnTarget,
} from '../studio-surface';
import type { ClaudeBackendTurnSnapshot } from '@studio/agent/protocol/backend-events';
import type { SyncSite } from '@studio/common/types/sync';

vi.mock( '@studio/common/sites/site-path', () => ( { readSite: vi.fn() } ) );
vi.mock( '@studio/common/lib/connected-sites', () => ( {
	getConnectedWpcomSitesForLocalSite: vi.fn(),
} ) );
vi.mock( '../connection', () => ( { getClaudeConnections: vi.fn() } ) );
vi.mock( '../runtime', () => ( { discoverClaudeModels: vi.fn() } ) );

const selection = { model: 'claude-model', effort: 'medium' } as const;
const request = { siteId: 'site-id', connectionId: 'connection', selection };
const surfaceTarget = !! claudePlatformTarget( currentClaudeHost() );
const tempDirectories: string[] = [];

afterEach( async () => {
	vi.unstubAllEnvs();
	vi.resetAllMocks();
	await Promise.all( tempDirectories.splice( 0 ).map( ( dir ) => rm( dir, { recursive: true } ) ) );
} );

async function createFixture() {
	const config = await realpath(
		await mkdtemp( path.join( os.tmpdir(), 'studio-claude-surface-' ) )
	);
	tempDirectories.push( config );
	vi.stubEnv( 'DEV_CONFIG_DIR', config );
	vi.stubEnv( 'STUDIO_EXPERIMENTAL_CLAUDE_CODE', '1' );
	vi.mocked( readSite ).mockResolvedValue( { id: 'site-id', name: 'Local site', path: config } );
	vi.mocked( discoverClaudeModels ).mockResolvedValue( {
		ok: true,
		models: [ { id: selection.model, displayName: 'Test model', efforts: [ 'medium', 'high' ] } ],
		workingDirectory: config,
		configDirectory: config,
	} );
	return { root: path.join( config, 'sessions' ), config };
}

it( 'does not inspect stored connections when the experiment is disabled', async () => {
	vi.stubEnv( 'STUDIO_EXPERIMENTAL_CLAUDE_CODE', undefined );
	await expect( getClaudeRuntimeState() ).resolves.toEqual( { enabled: false, connections: [] } );
	expect( getClaudeConnections ).not.toHaveBeenCalled();
} );

it.runIf( surfaceTarget )(
	'creates a pinned local Claude conversation before its first turn and fails closed on a stale Send',
	async () => {
		const { root, config } = await createFixture();
		const summary = await createClaudeSession( root, request );
		expect( summary ).toMatchObject( { backend: 'claude-code', ownerSiteId: 'site-id' } );
		const loaded = await loadHydratedAiSession( root, summary.id );
		expect( loaded.claudeJournal ).toEqual( [] );
		expect( resolveClaudeSession( loaded.entries ) ).toEqual( {
			binding: {
				connectionId: request.connectionId,
				siteId: request.siteId,
				workingDirectory: config,
				configDirectory: config,
			},
			selection,
			target: { environment: 'local', siteId: request.siteId },
		} );
		await expect( validateClaudeSendSelection( root, summary.id, undefined ) ).rejects.toThrow();
		await expect( validateClaudeSendSelection( root, summary.id, selection ) ).resolves.toEqual(
			selection
		);
		await setClaudeSessionSelection( root, summary.id, { ...selection, effort: 'high' } );
		await expect( validateClaudeSendSelection( root, summary.id, selection ) ).rejects.toThrow();
	}
);

it.runIf( surfaceTarget )(
	'deletes only the selected Studio journal and rejects deletion while the run lock is held',
	async () => {
		const { root } = await createFixture();
		const { id } = await createClaudeSession( root, request );
		const second = await createClaudeSession( root, request );
		const store = createNativeSessionStore( getClaudeSessionStoreRoot( root ) );
		const event = {
			type: 'turn.prompt' as const,
			runId: 'run',
			turnId: 'turn',
			text: 'Display journal',
		};
		const release = await store.lockTurn( id );
		try {
			await store.journal( id, 'turn' ).append( event );
			await store.journal( second.id, 'turn' ).append( event );
			await expect( deleteAiSession( root, id ) ).rejects.toThrow();
			expect( ( await loadHydratedAiSession( root, id ) ).claudeRecovery ).toBe( 'run-locked' );
		} finally {
			await release();
		}
		await deleteAiSession( root, id );
		await expect( store.readJournals( id ) ).resolves.toEqual( [] );
		await expect( store.readJournals( second.id ) ).resolves.toEqual( [ [ event ] ] );
	}
);

it.runIf( surfaceTarget )(
	'refuses unsupported effort and a Claude selection on a Pi session',
	async () => {
		const { root } = await createFixture();
		await expect(
			createClaudeSession( root, { ...request, selection: { ...selection, effort: 'max' } } )
		).rejects.toThrow();
		const summary = await createAiSession( root );
		const loaded = await loadAiSession( root, summary.id );
		expect( resolveClaudeSession( loaded.entries ) ).toBeUndefined();
		await expect( validateClaudeSendSelection( root, summary.id, selection ) ).rejects.toThrow();
		await expect(
			validateClaudeSendSelection( root, summary.id, undefined )
		).resolves.toBeUndefined();
	}
);

it.runIf( surfaceTarget )(
	'creates a global conversation in the dedicated global workspace',
	async () => {
		const { root, config } = await createFixture();
		const workspace = getClaudeGlobalWorkspace( getClaudeSessionStoreRoot( root ) );
		vi.mocked( discoverClaudeModels ).mockResolvedValue( {
			ok: true,
			models: [ { id: selection.model, displayName: 'Test model', efforts: [ 'medium' ] } ],
			workingDirectory: workspace,
			configDirectory: config,
		} );
		const summary = await createClaudeSession( root, { connectionId: 'connection', selection } );
		expect( discoverClaudeModels ).toHaveBeenCalledWith( 'connection', workspace );
		expect( readSite ).not.toHaveBeenCalled();
		expect( ( await stat( workspace ) ).isDirectory() ).toBe( true );
		const { entries } = await loadAiSession( root, summary.id );
		expect( resolveClaudeSession( entries ) ).toEqual( {
			binding: {
				connectionId: 'connection',
				siteId: null,
				workingDirectory: workspace,
				configDirectory: config,
			},
			selection,
			target: { environment: 'global' },
		} );
	}
);

it.runIf( surfaceTarget )(
	'holds a Send to a disconnected live target and verifies the target a turn started with',
	async () => {
		const { root, config } = await createFixture();
		const summary = await createClaudeSession( root, request );
		const live = { siteName: 'Local site', sitePath: config, siteId: request.siteId };
		await appendStudioEntry( root, summary.id, 'studio.site_selected', {
			...live,
			remote: true,
			url: 'https://example.wordpress.com',
			wpcomSiteId: 42,
		} );
		vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( [] );
		await expect( validateClaudeSendSelection( root, summary.id, selection ) ).rejects.toThrow(
			'no longer connected'
		);
		vi.mocked( getConnectedWpcomSitesForLocalSite ).mockResolvedValue( [ { id: 42 } as SyncSite ] );
		await expect( validateClaudeSendSelection( root, summary.id, selection ) ).resolves.toEqual(
			selection
		);
		const turn: ClaudeBackendTurnSnapshot = {
			backend: 'claude-code',
			runId: 'run',
			turnId: 'turn',
			effort: selection.effort,
			permissionPolicyRevision: 1,
			selection: {
				connectionId: request.connectionId,
				revision: 0,
				model: { providerId: 'claude-code', modelId: selection.model },
			},
			workspace: {
				conversationId: summary.id,
				siteId: request.siteId,
				workingDirectory: config,
				configDirectory: config,
			},
			target: { environment: 'live', siteId: request.siteId, wpcomSiteId: 42 },
		};
		await expect( verifyClaudeTurnSession( root, turn ) ).resolves.toBe( true );
		await expect( verifyClaudeTurnTarget( root, turn, turn.target ) ).resolves.toBe( true );
		await appendStudioEntry( root, summary.id, 'studio.site_selected', live );
		await expect( verifyClaudeTurnTarget( root, turn, turn.target ) ).resolves.toBe( false );
		await expect( verifyClaudeTurnSession( root, turn ) ).resolves.toBe( false );
		await expect(
			verifyClaudeTurnTarget( root, turn, { environment: 'local', siteId: request.siteId } )
		).resolves.toBe( true );
	}
);
