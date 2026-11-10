import { mkdtemp, realpath, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { readSite } from '@studio/common/sites/site-path';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveClaudeSession } from '@studio/agent/protocol/claude-code';
import { loadHydratedAiSession } from '../../sessions/manage';
import { createAiSession, deleteAiSession, loadAiSession } from '../../sessions/store';
import { getClaudeConnections } from '../connection';
import { discoverClaudeModels } from '../runtime';
import { createNativeSessionStore, getClaudeSessionStoreRoot } from '../sessions';
import {
	createClaudeSession,
	getClaudeRuntimeState,
	setClaudeSessionSelection,
	validateClaudeSendSelection,
} from '../studio-surface';

vi.mock( '@studio/common/sites/site-path', () => ( { readSite: vi.fn() } ) );
vi.mock( '../connection', () => ( { getClaudeConnections: vi.fn() } ) );
vi.mock( '../runtime', () => ( { discoverClaudeModels: vi.fn() } ) );

const selection = { model: 'claude-model', effort: 'medium' } as const;
const request = { siteId: 'site-id', connectionId: 'connection', selection };
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

it.runIf( process.platform === 'win32' && process.arch === 'x64' )(
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
		} );
		await expect( validateClaudeSendSelection( root, summary.id, undefined ) ).rejects.toThrow();
		await expect( validateClaudeSendSelection( root, summary.id, selection ) ).resolves.toEqual(
			selection
		);
		await setClaudeSessionSelection( root, summary.id, { ...selection, effort: 'high' } );
		await expect( validateClaudeSendSelection( root, summary.id, selection ) ).rejects.toThrow();
	}
);

it.runIf( process.platform === 'win32' && process.arch === 'x64' )(
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

it.runIf( process.platform === 'win32' && process.arch === 'x64' )(
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
