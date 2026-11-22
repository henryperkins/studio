// @vitest-environment node
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ChatGptTokenSet } from '@studio/agent/node/chatgpt/credential-broker';
import type { RunManagerOutput } from '@studio/agent/node/run-manager';

vi.mock( 'node:child_process', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('node:child_process') >();
	return { ...actual, fork: vi.fn( actual.fork ) };
} );
vi.mock( '@studio/agent/node/agent-stats', () => ( {
	recordAgentSend: vi.fn(),
	recordAgentRun: vi.fn(),
} ) );
vi.mock( '@studio/common/lib/error-reporting', () => ( { captureException: vi.fn() } ) );
vi.mock( '@studio/common/lib/shared-config', () => ( {
	updateSharedSession: vi.fn().mockResolvedValue( undefined ),
} ) );
vi.mock( '@studio/agent/node/sessions/placement', () => ( {
	getCreatedSiteFromArtifact: vi.fn(),
	setAiSessionSitePlacement: vi.fn(),
} ) );
vi.mock( '@studio/common/lib/os-credential-store', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/common/lib/os-credential-store') >() ),
	createOsCredentialStore: () => ( {
		check: async () => ( { available: true } ),
		get: async () => null,
		set: async () => {
			throw new Error( 'Unexpected vault write.' );
		},
		delete: async () => undefined,
	} ),
} ) );

const tokens = ( name: string ): ChatGptTokenSet => ( {
	accessToken: `test-access-token-${ name }`,
	refreshToken: `test-refresh-token-${ name }`,
	idToken: `test-id-token-${ name }`,
	tokenType: 'Bearer',
	expiresIn: 3600,
	scope: 'openid offline_access chatgpt.tokens.use.direct',
} );

describe( 'ChatGPT run manager with native forks', () => {
	let configDir: string;
	let previousConfigDir: string | undefined;
	let credentials: typeof import('@studio/agent/node/chatgpt/credential-broker');
	const refresh = vi.fn( async () => ( { ok: true as const, value: tokens( 'renewed' ) } ) );
	const revoke = vi.fn( async () => ( { ok: true as const, value: undefined } ) );

	beforeEach( async () => {
		vi.resetModules();
		vi.clearAllMocks();
		configDir = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-run-manager-chatgpt-' ) );
		previousConfigDir = process.env.DEV_CONFIG_DIR;
		process.env.DEV_CONFIG_DIR = configDir;
		credentials = await import( '@studio/agent/node/chatgpt/credential-broker' );
		credentials.setChatGptTokenClient( { refresh, revoke } );
	} );

	afterEach( () => {
		if ( previousConfigDir === undefined ) {
			delete process.env.DEV_CONFIG_DIR;
		} else {
			process.env.DEV_CONFIG_DIR = previousConfigDir;
		}
		fs.rmSync( configDir, { recursive: true, force: true, maxRetries: 5 } );
	} );

	async function startRun( connectionId: string, surface: 'desktop' | 'cliui' ) {
		const { createAgentRunManager } = await import( '@studio/agent/node/run-manager' );
		const { createAiSession, appendStudioEntry } = await import(
			'@studio/agent/node/sessions/store'
		);
		const sessions = path.join( configDir, 'sessions' );
		const session = await createAiSession( sessions );
		await appendStudioEntry( sessions, session.id, 'studio.session_context', {
			provider: 'chatgpt-oauth',
			connectionId,
			revision: 1,
			model: 'gpt-6',
		} );
		const outputs: RunManagerOutput[] = [];
		let watched!: () => void;
		const watching = new Promise< void >( ( resolve ) => ( watched = resolve ) );
		const manager = createAgentRunManager( {
			cliBinary: path.join( import.meta.dirname, 'fixtures', 'chatgpt-fork.ts' ),
			surface,
			emit: ( output ) => outputs.push( output ),
			beginChatGptTurn: async ( id ) => {
				const handle = await credentials.beginChatGptTurn( id );
				watched();
				return handle;
			},
		} );
		const { runId } = manager.startAgentRun( { sessionId: session.id, prompt: 'test' } );
		const child = vi.mocked( fork ).mock.results.at( -1 )!.value;
		const exited = new Promise< number | null >( ( resolve ) => child.once( 'exit', resolve ) );
		onTestFinished( async () => {
			child.kill( 'SIGKILL' );
			await exited;
		} );
		const waitForInfo = ( message: string ) =>
			vi.waitFor(
				() =>
					expect( outputs ).toContainEqual(
						expect.objectContaining( {
							kind: 'agent',
							event: expect.objectContaining( {
								event: expect.objectContaining( { type: 'info', message } ),
							} ),
						} )
					),
				{ timeout: 10_000 }
			);
		await waitForInfo( 'ready' );
		await watching;
		return {
			manager,
			runId,
			outputs,
			exited,
			waitForInfo,
			command: ( action: string ) => manager.answerAgentRun( runId, { action } ),
		};
	}

	async function signIn() {
		return credentials.saveChatGptSignIn( {
			issuer: 'https://auth.openai.com',
			subject: 'test-subject',
			clientId: 'test-issued-client',
			storage: 'session',
			tokens: tokens( 'initial' ),
		} );
	}

	it.each( [ 'desktop', 'cliui' ] as const )(
		'revokes a pruned session credential after its %s child exits',
		async ( surface ) => {
			const { registrationId } = await signIn();
			const run = await startRun( registrationId, surface );
			let completed = false;
			const signingOut = credentials.signOutChatGpt( registrationId ).then( ( result ) => {
				completed = true;
				return result;
			} );
			await run.waitForInfo( 'interrupt-received' );
			run.command( 'request-after-interrupt' );
			await run.waitForInfo( 'token-blocked' );
			expect( credentials.getChatGptSessionForkEnvironment() ).toEqual( {} );
			expect( completed ).toBe( false );
			run.command( 'finish' );

			await expect( run.exited ).resolves.toBe( 0 );
			await expect( signingOut ).resolves.toEqual( {
				localCleared: true,
				remoteRevocationConfirmed: true,
			} );
			expect( revoke ).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining( {
					clientId: 'test-issued-client',
					refreshToken: 'test-refresh-token-initial',
				} )
			);
			expect( run.manager.listActiveAgentRuns() ).toEqual( [] );
			expect( JSON.stringify( run.outputs ) ).not.toMatch(
				/test-(access|refresh|id)-token|chatgpt-session-token/
			);
		},
		20_000
	);

	it( 'refreshes once when two native forks reject the same token at different times', async () => {
		const { registrationId } = await signIn();
		const first = await startRun( registrationId, 'desktop' );
		const second = await startRun( registrationId, 'cliui' );
		first.command( 'reject' );
		await first.waitForInfo( 'renewed' );
		second.command( 'reject' );
		await second.waitForInfo( 'renewed' );

		expect( refresh ).toHaveBeenCalledTimes( 1 );
		for ( const run of [ first, second ] ) {
			run.command( 'finish' );
			await expect( run.exited ).resolves.toBe( 0 );
			expect( JSON.stringify( run.outputs ) ).not.toMatch(
				/test-(access|refresh|id)-token|chatgpt-session-token/
			);
		}
		expect( JSON.stringify( vi.mocked( fork ).mock.calls ) ).not.toMatch(
			/test-(access|refresh|id)-token/
		);
		await expect( credentials.signOutChatGpt( registrationId ) ).resolves.toMatchObject( {
			remoteRevocationConfirmed: true,
		} );
		expect( revoke ).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining( {
				refreshToken: 'test-refresh-token-renewed',
			} )
		);
	}, 20_000 );
} );
