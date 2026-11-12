import { randomUUID } from 'crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoverClaudeRun } from '../recovery';
import { claudeLockDigest, createNativeSessionStore } from '../sessions';
import { createPolicyFixture } from './fixtures/execution-policy';
import type { ClaudeRecoverySeams } from '../recovery';
import type { BackendTurnEvent, ClaudeJournalEvent } from '@studio/agent/protocol/backend-events';
import type { OwnedTreeCheck, ProcessIdentityCheck } from '@studio/common/lib/owned-process';

const cleanups: Array< () => Promise< void > > = [];
afterEach( async () => {
	await Promise.all( cleanups.splice( 0 ).map( ( cleanup ) => cleanup() ) );
} );

const owner = { pid: 1111, start: 'owner-start' };
const native = { pid: 2222, start: 'native-start' };
const guardian = { pid: 3333, start: 'guardian-start' };
const self = { pid: 4444, start: 'self-start' };
const ids = { runId: 'run', turnId: 'turn' };
const target = { environment: 'local' as const, siteId: 'site' };

function approval( requestId: string, toolCallId: string ): BackendTurnEvent {
	return {
		type: 'approval.requested',
		...ids,
		toolCallId,
		requestId,
		description: 'Create a draft post on the current local site',
		operation: {
			tool: 'wp_cli',
			operationClass: 'local-change',
			target,
			args: '{}',
			localPaths: [],
		},
	};
}

async function recoveryFixture() {
	const parent = await realpath( await mkdtemp( path.join( os.tmpdir(), 'claude-recovery-' ) ) );
	cleanups.push( () => rm( parent, { recursive: true, force: true } ) );
	const site = path.join( parent, 'site' );
	const config = path.join( parent, 'config' );
	const projects = path.join( config, 'projects' );
	await mkdir( site );
	await mkdir( projects, { recursive: true } );
	const storeRoot = path.join( parent, 'store' );
	const store = createNativeSessionStore( storeRoot );
	const binding = {
		connectionId: 'connection',
		conversationId: 'chat',
		siteId: 'site',
		workingDirectory: site,
		configDirectory: config,
	};
	const states = new Map< string, ProcessIdentityCheck >();
	const tree: { result: OwnedTreeCheck } = { result: { state: 'ended' } };
	const seams = {
		platform: process.platform,
		self: vi.fn( async () => self ),
		checkIdentity: vi.fn(
			async ( identity: { pid: number; start: string } ) =>
				states.get( `${ identity.pid }:${ identity.start }` ) ?? 'gone'
		),
		checkTree: vi.fn( async () => tree.result ),
	} satisfies ClaudeRecoverySeams;
	const lockFile = path.join(
		storeRoot,
		`${ ( await import( 'crypto' ) )
			.createHash( 'sha256' )
			.update( 'chat' )
			.digest( 'hex' ) }.json.lock`
	);

	// A turn whose owner died: its native session, history, journal and run
	// lock exactly as the runtime leaves them.
	async function deadTurn( {
		stage = 'owned',
		resume = false,
		ref = true,
		history = true,
		lockSessionId,
		journal = [],
	}: {
		stage?: 'locked' | 'starting' | 'owned';
		resume?: boolean;
		ref?: boolean;
		history?: boolean;
		lockSessionId?: string;
		journal?: BackendTurnEvent[];
	} = {} ) {
		const nativeSessionId = randomUUID();
		if ( ref ) await store.create( { backend: 'claude-code', ...binding, nativeSessionId } );
		if ( history )
			await writeFile(
				path.join( projects, `${ nativeSessionId }.jsonl` ),
				JSON.stringify( { sessionId: nativeSessionId, cwd: site } ) + '\n'
			);
		const lock = await store.lockRun( 'chat', {
			owner,
			...ids,
			connection: { id: 'connection', revision: 1 },
			workspace: { siteId: 'site', workingDirectory: site, configDirectory: config },
		} );
		if ( stage !== 'locked' )
			await lock.update( {
				stage: 'starting',
				session: { nativeSessionId: lockSessionId ?? nativeSessionId, resume },
			} );
		if ( stage === 'owned' )
			await lock.update( { stage: 'owned', processes: { native, guardian } } );
		const turn = store.journal( 'chat', 'turn' );
		for ( const event of journal ) await turn.append( event );
		return { nativeSessionId, raw: await readFile( lockFile, 'utf8' ) };
	}

	const recover = ( overrides: Partial< typeof binding > = {}, using = store ) =>
		recoverClaudeRun( using, { ...binding, ...overrides }, seams );

	return {
		site,
		config,
		projects,
		store,
		binding,
		states,
		tree,
		seams,
		lockFile,
		deadTurn,
		recover,
	};
}

const terminals = ( journals: ClaudeJournalEvent[][] ) =>
	journals.flat().filter( ( event ) => event.type === 'turn.terminal' );

describe( 'recovering a conversation whose run outlived its owner', () => {
	it( 'recovers once the owner and the whole native tree are provably gone: one interrupted outcome, partial output kept, pending approvals closed, and the same native session resumes next', async () => {
		const fixture = await recoveryFixture();
		const journal: BackendTurnEvent[] = [
			{ type: 'turn.prompt', ...ids, text: 'Write a draft' },
			{
				type: 'content.confirmed',
				...ids,
				messageId: 'message',
				blockId: '0',
				blockType: 'text',
				text: 'Partial answer',
			},
			approval( 'request', 'call' ),
		];
		const { nativeSessionId } = await fixture.deadTurn( { journal } );
		const result = await fixture.recover();
		const uncertain = {
			requestId: 'request',
			toolCallId: 'call',
			tool: 'wp_cli',
			operationClass: 'local-change',
			target,
			description: 'Create a draft post on the current local site',
			resolved: false,
		};
		expect( result ).toEqual( {
			status: 'recovered',
			...ids,
			recordedTerminal: true,
			invalidatedApprovals: [ 'request' ],
			uncertainOperations: [ uncertain ],
		} );
		expect( fixture.seams.checkIdentity ).toHaveBeenCalledWith( owner );
		expect( fixture.seams.checkTree ).toHaveBeenCalledWith( { native, guardian } );
		const journals = await fixture.store.readJournals( 'chat' );
		expect( journals[ 0 ] ).toEqual( journal );
		expect( journals[ 1 ] ).toEqual( [
			{ type: 'approval.resolved', ...ids, toolCallId: 'call', requestId: 'request' },
			{
				type: 'turn.terminal',
				...ids,
				outcome: {
					status: 'unknown_process_exit',
					code: 'recovered',
					message: expect.stringContaining( 'may or may not' ),
				},
			},
			{
				type: 'turn.recovered',
				...ids,
				lock: expect.stringMatching( /^[0-9a-f]{64}$/ ),
				invalidatedApprovals: [ 'request' ],
				uncertainOperations: [ uncertain ],
			},
		] );
		expect( terminals( journals ) ).toHaveLength( 1 );
		expect( await fixture.store.inspectLock( 'chat' ) ).toEqual( { state: 'none' } );
		const ref = ( await fixture.store.load( 'chat' ) )!;
		expect( ref.nativeSessionId ).toBe( nativeSessionId );
		expect( ( await fixture.store.resolve( ref, fixture.binding, fixture.projects ) ).status ).toBe(
			'ready'
		);
		await (
			await fixture.store.lockTurn( 'chat' )
		)();
	} );

	it( 'recovers a turn that never started its native process without asking about any', async () => {
		const fixture = await recoveryFixture();
		await fixture.deadTurn( { stage: 'locked' } );
		expect( await fixture.recover() ).toMatchObject( {
			status: 'recovered',
			recordedTerminal: true,
			invalidatedApprovals: [],
			uncertainOperations: [],
		} );
		expect( fixture.seams.checkTree ).not.toHaveBeenCalled();
		const [ [ terminal ] ] = await fixture.store.readJournals( 'chat' );
		expect( terminal ).toMatchObject( {
			type: 'turn.terminal',
			outcome: { status: 'unknown_process_exit', code: 'recovered' },
		} );
		expect( ( terminal as { outcome: { message: string } } ).outcome.message ).toContain(
			'Nothing was retried'
		);
	} );

	it( 'records no second outcome when the dead turn recorded its own', async () => {
		const fixture = await recoveryFixture();
		await fixture.deadTurn( {
			journal: [
				{ type: 'turn.prompt', ...ids, text: 'Hello' },
				{
					type: 'turn.terminal',
					...ids,
					outcome: { status: 'error', code: 'process_unconfirmed', message: 'locked' },
				},
			],
		} );
		expect( await fixture.recover() ).toMatchObject( {
			status: 'recovered',
			recordedTerminal: false,
		} );
		const journals = await fixture.store.readJournals( 'chat' );
		expect( terminals( journals ) ).toEqual( [
			expect.objectContaining( {
				outcome: expect.objectContaining( { code: 'process_unconfirmed' } ),
			} ),
		] );
		expect( journals[ 1 ].map( ( event ) => event.type ) ).toEqual( [ 'turn.recovered' ] );
	} );

	it( 'reports an approved mutation with no recorded result as uncertain, one with a result as settled, and retries neither', async () => {
		const fixture = await recoveryFixture();
		await fixture.deadTurn( {
			journal: [
				approval( 'answered', 'pending-result' ),
				{ type: 'approval.resolved', ...ids, toolCallId: 'pending-result', requestId: 'answered' },
				approval( 'done', 'finished' ),
				{ type: 'approval.resolved', ...ids, toolCallId: 'finished', requestId: 'done' },
				{ type: 'tool.result', ...ids, toolCallId: 'finished', isError: false, message: 'Created' },
				{ type: 'tool.started', ...ids, toolCallId: 'read', name: 'Read' },
			],
		} );
		const result = await fixture.recover();
		expect( result ).toMatchObject( {
			status: 'recovered',
			invalidatedApprovals: [],
			uncertainOperations: [
				expect.objectContaining( {
					requestId: 'answered',
					toolCallId: 'pending-result',
					resolved: true,
				} ),
			],
		} );
		const added = ( await fixture.store.readJournals( 'chat' ) )[ 1 ];
		expect( added.map( ( event ) => event.type ) ).toEqual( [ 'turn.terminal', 'turn.recovered' ] );
	} );

	it( 'leaves the dead run’s approvals unanswerable by any later run', async () => {
		const fixture = await recoveryFixture();
		await fixture.deadTurn( { journal: [ approval( 'stale', 'call' ) ] } );
		await fixture.recover();
		const events = ( await fixture.store.readJournals( 'chat' ) ).flat();
		// A reconnecting app restores only unresolved requests of the current run.
		expect(
			events.filter(
				( event ) =>
					event.type === 'approval.requested' &&
					! events.some(
						( other ) => other.type === 'approval.resolved' && other.requestId === event.requestId
					)
			)
		).toEqual( [] );
		// A grant is scoped to the run that asked for it: the next run's policy
		// never authorizes an operation with the dead run's request.
		const next = await createPolicyFixture( () => ( { runId: 'next-run', turnId: 'next-turn' } ) );
		cleanups.push( next.cleanup );
		expect(
			await next.policy.authorizeExecution(
				{ requestId: 'stale' },
				{
					tool: 'wp_cli',
					operationClass: 'local-change',
					args: {},
					localPaths: [],
					description: 'Create a draft post on the current local site',
				},
				'call'
			)
		).toBe( false );
	} );

	it.each( [
		[ 'its owner is still running', 'owner-alive', { owner: 'alive' } ],
		[ 'its owner cannot be read', 'owner-unverifiable', { owner: 'unknown' } ],
		[ 'a native process may have started unowned', 'native-unowned', { stage: 'starting' } ],
		[ 'its native process is running', 'native-alive', { tree: [ 'alive', 'native' ] } ],
		[
			'its native process cannot be read',
			'native-unverifiable',
			{ tree: [ 'unknown', 'native' ] },
		],
		[ 'its guardian is running', 'guardian-alive', { tree: [ 'alive', 'guardian' ] } ],
		[ 'its guardian cannot be read', 'guardian-unverifiable', { tree: [ 'unknown', 'guardian' ] } ],
		[ 'a descendant is still running', 'descendants-alive', { tree: [ 'alive', 'descendant' ] } ],
		[
			'its descendants cannot be read',
			'descendants-unverifiable',
			{ tree: [ 'unknown', 'descendant' ] },
		],
		[ 'it names another connection', 'binding-mismatch', { binding: { connectionId: 'other' } } ],
		[ 'it names another site', 'binding-mismatch', { binding: { siteId: 'other' } } ],
		[ 'the workspace is gone', 'workspace-missing', { removeWorkspace: true } ],
		[ 'the native history is missing', 'native-history-missing', { history: false } ],
		[
			'it names another native session',
			'native-session-mismatch',
			{ lockSessionId: '0b6c1c6a-4b8a-4d5e-9e31-2f0c8d1a7b55' },
		],
		[
			'it resumed a session the chat no longer records',
			'native-session-missing',
			{ resume: true, ref: false },
		],
		[ 'it was written on another platform', 'platform-mismatch', { platform: 'aix' } ],
	] as const )(
		'keeps the lock, the journal and the native history when %s',
		async ( _name, reason, scenario ) => {
			const fixture = await recoveryFixture();
			const options = scenario as {
				owner?: ProcessIdentityCheck;
				stage?: 'starting';
				tree?: readonly [ 'alive' | 'unknown', 'native' | 'guardian' | 'descendant' ];
				binding?: Record< string, string >;
				removeWorkspace?: boolean;
				history?: boolean;
				lockSessionId?: string;
				resume?: boolean;
				ref?: boolean;
				platform?: string;
			};
			const journal = [ approval( 'request', 'call' ) ];
			const { raw } = await fixture.deadTurn( {
				stage: options.stage,
				history: options.history,
				lockSessionId: options.lockSessionId,
				resume: options.resume,
				ref: options.ref,
				journal,
			} );
			if ( options.owner ) fixture.states.set( `${ owner.pid }:${ owner.start }`, options.owner );
			if ( options.tree )
				fixture.tree.result = { state: options.tree[ 0 ], process: options.tree[ 1 ] };
			if ( options.removeWorkspace ) await rm( fixture.site, { recursive: true } );
			if ( options.platform ) fixture.seams.platform = options.platform as NodeJS.Platform;
			const before = await fixture.store.readJournals( 'chat' );
			expect( await fixture.recover( options.binding ) ).toEqual( {
				status: 'blocked',
				reason,
				...ids,
			} );
			expect( await readFile( fixture.lockFile, 'utf8' ) ).toBe( raw );
			expect( await fixture.store.readJournals( 'chat' ) ).toEqual( before );
			if ( reason.startsWith( 'owner' ) ) expect( fixture.seams.checkTree ).not.toHaveBeenCalled();
		}
	);

	it.each( [
		[ 'nothing holds the lock', 'not-locked' ],
		[ 'the chat is being deleted', 'deletion-pending' ],
		[ 'a deletion holds the lock', 'lock-not-a-run' ],
		[ 'the lock cannot be read', 'lock-unreadable' ],
		[ 'the lock predates owner records', 'legacy-lock' ],
	] as const )( 'recovers nothing when %s', async ( _name, reason ) => {
		const fixture = await recoveryFixture();
		await mkdir( path.dirname( fixture.lockFile ), { recursive: true } );
		if ( reason === 'legacy-lock' ) await writeFile( fixture.lockFile, randomUUID() );
		if ( reason === 'deletion-pending' ) {
			await fixture.deadTurn();
			await writeFile( fixture.lockFile.replace( /\.lock$/, '.deleting' ), '' );
		}
		if ( reason === 'lock-not-a-run' ) await fixture.store.lockTurn( 'chat' );
		if ( reason === 'lock-unreadable' ) await writeFile( fixture.lockFile, '{"version":2' );
		const before = await readFile( fixture.lockFile, 'utf8' ).catch( () => undefined );
		expect( await fixture.recover() ).toEqual( { status: 'blocked', reason } );
		expect( await readFile( fixture.lockFile, 'utf8' ).catch( () => undefined ) ).toBe( before );
		expect( fixture.seams.checkIdentity ).not.toHaveBeenCalled();
	} );

	it( 'never clobbers a lock that replaced the inspected one before the takeover', async () => {
		const fixture = await recoveryFixture();
		const { raw } = await fixture.deadTurn();
		let replacement: string | undefined;
		fixture.seams.checkTree.mockImplementation( async () => {
			// Meanwhile another app recovers the same lock and a new turn takes the conversation.
			expect( await fixture.store.releaseRecoveredLock( 'chat', raw ) ).toBe( true );
			await fixture.store.lockRun( 'chat', {
				owner: { pid: 5555, start: 'live-owner' },
				runId: 'next-run',
				turnId: 'next-turn',
				connection: { id: 'connection', revision: 1 },
				workspace: {
					siteId: 'site',
					workingDirectory: fixture.site,
					configDirectory: fixture.config,
				},
			} );
			replacement = await readFile( fixture.lockFile, 'utf8' );
			return { state: 'ended' };
		} );
		expect( await fixture.recover() ).toEqual( {
			status: 'blocked',
			reason: 'lock-changed',
			...ids,
		} );
		expect( await readFile( fixture.lockFile, 'utf8' ) ).toBe( replacement );
		expect( terminals( await fixture.store.readJournals( 'chat' ) ) ).toEqual( [] );
		const leftovers = ( await import( 'fs/promises' ) ).readdir( path.dirname( fixture.lockFile ) );
		expect( ( await leftovers ).filter( ( name ) => name.includes( '.claim-' ) ) ).toEqual( [] );
	} );

	it( 'waits for another recovery that holds the claim, and takes over one whose claimant is gone', async () => {
		const fixture = await recoveryFixture();
		const { raw } = await fixture.deadTurn();
		const token = JSON.parse( raw ).token as string;
		const other = { pid: 6666, start: 'other-recovery' };
		expect(
			await fixture.store.claimRecovery( 'chat', token, other, async () => 'gone' )
		).toBeDefined();
		fixture.states.set( `${ other.pid }:${ other.start }`, 'alive' );
		expect( await fixture.recover() ).toEqual( {
			status: 'blocked',
			reason: 'recovery-in-progress',
			...ids,
		} );
		expect( await readFile( fixture.lockFile, 'utf8' ) ).toBe( raw );
		fixture.states.set( `${ other.pid }:${ other.start }`, 'unknown' );
		expect( await fixture.recover() ).toMatchObject( { reason: 'recovery-in-progress' } );
		fixture.states.set( `${ other.pid }:${ other.start }`, 'gone' );
		expect( await fixture.recover() ).toMatchObject( { status: 'recovered' } );
		expect( await fixture.store.inspectLock( 'chat' ) ).toEqual( { state: 'none' } );
	} );

	it( 'records itself once: a recovery interrupted before it released the lock completes later without a second record', async () => {
		const fixture = await recoveryFixture();
		const { raw } = await fixture.deadTurn( { journal: [ approval( 'request', 'call' ) ] } );
		const interrupted = {
			...fixture.store,
			releaseRecoveredLock: async () => {
				throw new Error( 'The process ended here' );
			},
		};
		expect( await fixture.recover( {}, interrupted ) ).toEqual( {
			status: 'blocked',
			reason: 'recovery-failed',
			...ids,
		} );
		expect( await readFile( fixture.lockFile, 'utf8' ) ).toBe( raw );
		const second = await fixture.recover();
		expect( second ).toEqual( {
			status: 'recovered',
			...ids,
			recordedTerminal: true,
			invalidatedApprovals: [ 'request' ],
			uncertainOperations: [ expect.objectContaining( { requestId: 'request' } ) ],
		} );
		const events = ( await fixture.store.readJournals( 'chat' ) ).flat();
		expect( events.filter( ( event ) => event.type === 'turn.terminal' ) ).toHaveLength( 1 );
		expect( events.filter( ( event ) => event.type === 'turn.recovered' ) ).toEqual( [
			expect.objectContaining( { lock: claudeLockDigest( JSON.parse( raw ).token ) } ),
		] );
		expect( events.filter( ( event ) => event.type === 'approval.resolved' ) ).toHaveLength( 1 );
	} );

	it( 'never claims a lock without its own identity to put on the claim', async () => {
		const fixture = await recoveryFixture();
		const { raw } = await fixture.deadTurn();
		fixture.seams.self.mockResolvedValue( undefined as never );
		expect( await fixture.recover() ).toEqual( {
			status: 'blocked',
			reason: 'recovery-failed',
			...ids,
		} );
		expect( await readFile( fixture.lockFile, 'utf8' ) ).toBe( raw );
	} );
} );
