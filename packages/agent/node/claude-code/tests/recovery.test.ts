import { randomUUID } from 'crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getClaudeUncertainOperationDescription } from '@studio/agent/protocol/claude-code';
import { fakeSite } from '../../tests/fake-host';
import { createClaudeEventAdapter } from '../event-adapter';
import { recoverClaudeRun } from '../recovery';
import { claudeLockDigest } from '../run-lock';
import { recoveryNote } from '../runtime';
import { createNativeSessionStore } from '../sessions';
import { createStudioClaudeToolBridge } from '../tool-bridge';
import { createPolicyFixture } from './fixtures/execution-policy';
import type { ClaudeRecoverySeams } from '../recovery';
import type {
	ClaudeJournalEvent,
	ClaudeTurnJournalEvent,
} from '@studio/agent/protocol/backend-events';
import type { OwnedTreeCheck, ProcessIdentityCheck } from '@studio/common/lib/owned-process';

// For the turns that push or pull: the conversation's site is connected to
// `fakeRemoteSite` under the stored login, whose user id is all the policy
// reads of it, in a store that lies outside every folder a turn reaches.
vi.mock( '@studio/common/lib/connected-sites', async () => {
	const { fakeRemoteSite } = await import( '../../tests/fake-host' );
	return { getConnectedWpcomSitesForLocalSite: vi.fn( async () => [ fakeRemoteSite ] ) };
} );
vi.mock( '@studio/common/lib/shared-config', async ( importOriginal ) => ( {
	...( await importOriginal< object >() ),
	getCurrentUserId: vi.fn( async () => 7 ),
} ) );
vi.mock( '@studio/common/lib/well-known-paths', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/common/lib/well-known-paths') >();
	const { default: nodePath } = await import( 'path' );
	const { default: nodeOs } = await import( 'os' );
	return {
		...actual,
		getSharedConfigPath: () =>
			nodePath.join( nodeOs.tmpdir(), 'studio-claude-no-config', 'shared.json' ),
		getCliConfigPath: () => nodePath.join( nodeOs.tmpdir(), 'studio-claude-no-config', 'cli.json' ),
	};
} );

const cleanups: Array< () => Promise< void > > = [];
afterEach( async () => {
	await Promise.all( cleanups.splice( 0 ).map( ( cleanup ) => cleanup() ) );
} );

const owner = { pid: 1111, start: 'owner-start' };
const native = { pid: 2222, start: 'native-start' };
const guardian = { pid: 3333, start: 'guardian-start' };
const self = { pid: 4444, start: 'self-start' };
const ids = { runId: 'run', turnId: 'turn' };
const target = { environment: 'local' as const, siteId: fakeSite.id };
const draft = { nameOrPath: 'site', command: 'post create --post_status=draft --post_title=Hello' };

type Turn = Omit< Awaited< ReturnType< typeof createPolicyFixture > >, 'events' > & {
	bridge: ReturnType< typeof createStudioClaudeToolBridge >;
	events: ClaudeTurnJournalEvent[];
};

// What a turn journals through the real execution policy, tool bridge and
// event adapter, in the order the runtime journals it, up to the moment it
// dies: `act` drives the turn, and whatever is still running when it returns
// never records a result.
async function journalOf(
	act: ( turn: Turn ) => Promise< void >,
	overrides: Parameters< typeof createPolicyFixture >[ 0 ] = () => ( {} )
): Promise< ClaudeTurnJournalEvent[] > {
	const events: ClaudeTurnJournalEvent[] = [];
	const fixture = await createPolicyFixture( ( paths ) => ( {
		onEvent: ( event, journalEvent ) => events.push( journalEvent ?? event ),
		recordOperation: async ( event ) => {
			events.push( event );
		},
		...overrides( paths ),
	} ) );
	const bridge = createStudioClaudeToolBridge(
		fixture.host,
		{ ...ids, policy: fixture.policy },
		( event ) => events.push( event )
	);
	await act( { ...fixture, bridge, events } );
	const recorded = structuredClone( events );
	// The turn dies here: nothing it left running records anything more.
	fixture.controller.abort();
	cleanups.push( fixture.cleanup );
	return recorded;
}

const hangs = () => new Promise< never >( () => {} );

// A draft whose approval is still waiting for its answer.
const pendingDraft = () =>
	journalOf(
		async ( { bridge, events } ) => {
			void bridge.invoke( 'wp_cli', draft );
			await vi.waitFor( () =>
				expect( events.some( ( event ) => event.type === 'approval.requested' ) ).toBe( true )
			);
		},
		() => ( { approve: hangs, approvalTimeoutMs: 60_000 } )
	);

// A draft the user allowed, whose WP-CLI command was still running.
const runningDraft = () =>
	journalOf( async ( { bridge, host } ) => {
		vi.mocked( host.sites.wpCli ).mockImplementation( hangs );
		void bridge.invoke( 'wp_cli', draft );
		await vi.waitFor( () => expect( host.sites.wpCli ).toHaveBeenCalled() );
	} );

const idsOf = ( events: ClaudeTurnJournalEvent[] ) => ( {
	toolCallId: (
		events.find( ( event ) => event.type === 'tool.started' ) as { toolCallId: string }
	 ).toolCallId,
	requestId: (
		events.find( ( event ) => event.type === 'approval.requested' ) as { requestId: string }
	 ).requestId,
} );

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
		journal?: ClaudeTurnJournalEvent[];
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
		return { nativeSessionId, lock, raw: await readFile( lockFile, 'utf8' ) };
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
	it( 'carries unconfirmed image cleanup into recovery even after the tool returned', async () => {
		const fixture = await recoveryFixture();
		const toolCallId = 'image-call';
		const message = 'Studio could not confirm cleanup of 2 image reservations.';
		await fixture.deadTurn( {
			journal: [
				{
					type: 'operation.authorized',
					...ids,
					toolCallId,
					operation: { tool: 'media.reserve', operationClass: 'local-change', target },
					description: 'Reserve attachments',
				},
				{ type: 'tool.progress', ...ids, toolCallId, message, unsettledMediaReservations: 2 },
				{ type: 'tool.progress', ...ids, toolCallId, message: 'Ordinary tool progress' },
				{ type: 'tool.result', ...ids, toolCallId, isError: true },
			],
		} );
		const result = await fixture.recover();
		expect( result.status === 'recovered' && result.uncertainOperations ).toEqual( [
			expect.objectContaining( { tool: 'media.reserve', target, description: message } ),
		] );
		const note = recoveryNote( await fixture.store.readJournals( 'chat' ) );
		expect( note?.text ).toContain( message );
		expect( note?.text ).not.toContain( 'Ordinary tool progress' );
	} );

	it( 'recovers once the owner and the whole native tree are provably gone: one interrupted outcome, partial output kept, pending approvals closed, and the same native session resumes next', async () => {
		const fixture = await recoveryFixture();
		// The prompt as the runtime journals it, the partial answer through the
		// real event adapter, then a draft waiting for its approval.
		const journal: ClaudeTurnJournalEvent[] = [
			{ type: 'turn.prompt', ...ids, text: 'Write a draft' },
		];
		createClaudeEventAdapter( ids.runId, ids.turnId, ( event ) => journal.push( event ) ).accept( {
			type: 'assistant',
			uuid: 'frame',
			message: { id: 'message', content: [ { type: 'text', text: 'Partial answer' } ] },
		} );
		journal.push( ...( await pendingDraft() ) );
		const { toolCallId, requestId } = idsOf( journal );
		const { nativeSessionId } = await fixture.deadTurn( { journal } );
		const result = await fixture.recover();
		// The tool call is journaled at the tool and at the host operation it
		// reached; the host operation says what would have changed.
		const uncertain = [
			{
				toolCallId,
				tool: 'sites.wpCli',
				operationClass: 'command',
				target,
				description: 'Create a draft post on the current local site',
				evidence: 'requested',
				requestId,
				resolved: false,
			},
		];
		expect( result ).toEqual( {
			status: 'recovered',
			...ids,
			recordedTerminal: true,
			invalidatedApprovals: [ requestId ],
			uncertainOperations: uncertain,
		} );
		expect( fixture.seams.checkIdentity ).toHaveBeenCalledWith( owner );
		expect( fixture.seams.checkTree ).toHaveBeenCalledWith( { native, guardian } );
		const journals = await fixture.store.readJournals( 'chat' );
		expect( journals[ 0 ] ).toEqual( journal );
		expect( journals[ 1 ] ).toEqual( [
			{ type: 'approval.resolved', ...ids, toolCallId, requestId },
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
				invalidatedApprovals: [ requestId ],
				uncertainOperations: uncertain,
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
		const finished = await journalOf( async ( { bridge } ) => {
			await bridge.invoke( 'wp_cli', draft );
		} );
		const running = await runningDraft();
		const { toolCallId, requestId } = idsOf( running );
		await fixture.deadTurn( { journal: [ ...finished, ...running ] } );
		const result = await fixture.recover();
		expect( result ).toEqual( {
			status: 'recovered',
			...ids,
			recordedTerminal: true,
			invalidatedApprovals: [],
			uncertainOperations: [
				{
					toolCallId,
					tool: 'sites.wpCli',
					operationClass: 'command',
					target,
					description: 'Create a draft post on the current local site',
					evidence: 'authorized',
					requestId,
					resolved: true,
				},
			],
		} );
		const added = ( await fixture.store.readJournals( 'chat' ) )[ 1 ];
		expect( added.map( ( event ) => event.type ) ).toEqual( [ 'turn.terminal', 'turn.recovered' ] );
	} );

	it( 'says, for a pull or push that was still running, which WordPress.com site it synced with, its options and what it may have left, in the note the next turn gives Claude', async () => {
		const cases = [
			[
				'site_pull',
				'sync.pull',
				'If it is interrupted, the site’s server may be left stopped and its database emptied, with the previous one in the operating system’s trash',
			],
			[
				'site_push',
				'sync.push',
				'If it is interrupted, the import of what it uploaded may still be running on WordPress.com',
			],
		] as const;
		for ( const [ name, operation, left ] of cases ) {
			const fixture = await recoveryFixture();
			const journal = await journalOf( async ( { bridge, host } ) => {
				const running = name === 'site_pull' ? host.sync.pull : host.sync.push;
				vi.mocked( running ).mockImplementation( hangs );
				void bridge.invoke( name, {
					nameOrPath: 'site',
					remoteSite: '111',
					options: 'sqls,uploads',
				} );
				await vi.waitFor( () => expect( running ).toHaveBeenCalled() );
			} );
			await fixture.deadTurn( { journal } );
			const result = await fixture.recover();
			expect( result.status === 'recovered' && result.uncertainOperations, name ).toEqual( [
				expect.objectContaining( { tool: operation, evidence: 'authorized' } ),
			] );
			const note = recoveryNote( await fixture.store.readJournals( 'chat' ) );
			for ( const said of [
				'WordPress.com site 111 (a production site, myprod.wordpress.com, named "My Production Site")',
				'with the options sqls, uploads',
				left,
			] )
				expect( note?.text, name ).toContain( said );
			expect( note?.uncertain, name ).toBe( true );
		}
	} );

	it( 'reports an operation that needed no approval and has no result as uncertain, and a read as settled', async () => {
		const fixture = await recoveryFixture();
		const journal = await journalOf(
			async ( { policy, site } ) => {
				const file = path.join( site, 'readme.txt' );
				await writeFile( file, 'fixture' );
				for ( const toolName of [ 'Read', 'Write' ] )
					expect(
						await policy.authorizeToolUse( {
							toolName,
							input:
								toolName === 'Write'
									? { file_path: file, content: 'changed' }
									: { file_path: file },
							toolUseId: `${ toolName }-use`,
						} )
					).toBe( true );
			},
			() => ( { enabledTools: { native: [ 'Read', 'Write' ], studio: [] } } )
		);
		await fixture.deadTurn( { journal } );
		expect( await fixture.recover() ).toMatchObject( {
			status: 'recovered',
			invalidatedApprovals: [],
			uncertainOperations: [
				{
					toolCallId: 'Write-use',
					tool: 'Write',
					operationClass: 'local-change',
					target,
					description: expect.stringContaining( 'readme.txt' ),
					evidence: 'authorized',
				},
			],
		} );
		const terminal = terminals( await fixture.store.readJournals( 'chat' ) )[ 0 ];
		expect( ( terminal as { outcome: { message: string } } ).outcome.message ).toContain(
			'may or may not'
		);
	} );

	it( 'names each interrupted native file change in the recovered chat without including file contents', async () => {
		const fixture = await recoveryFixture();
		const files: string[] = [];
		const journal = await journalOf(
			async ( { policy, site } ) => {
				for ( const [ index, name ] of [
					'first  page.md',
					'second\u200bpage.md',
					'third.txt',
				].entries() ) {
					const file = path.join( site, name );
					files.push( file );
					await writeFile( file, 'private before' );
					const edit = index === 2;
					const input = edit
						? { file_path: file, old_string: 'private before', new_string: 'private after' }
						: { file_path: file, content: 'private after' };
					expect(
						await policy.authorizeToolUse( {
							toolName: edit ? 'Edit' : 'Write',
							toolUseId: 'file-' + index,
							input,
						} )
					).toBe( true );
				}
			},
			() => ( { uncertainAfterRecovery: true } )
		);
		await fixture.deadTurn( { journal } );
		const recovered = await fixture.recover();
		if ( recovered.status !== 'recovered' ) throw new Error( 'Expected a recovered turn' );
		const descriptions = recovered.uncertainOperations.map(
			getClaudeUncertainOperationDescription
		);
		const note = recoveryNote( await fixture.store.readJournals( 'chat' ) );
		expect( descriptions ).toHaveLength( 3 );
		const escaped = files.map( ( file ) => JSON.stringify( file ).replace( '\u200b', '\\u200b' ) );
		for ( const [ index, file ] of escaped.entries() ) {
			expect( descriptions[ index ] ).toContain( file );
			expect( note?.text ).toContain( descriptions[ index ] );
		}
		expect( [ ...descriptions, note?.text ].join( '\n' ) ).not.toMatch(
			/private before|private after|\u200b/
		);
	} );

	// The one case built by hand: journal entries of shapes this build no longer
	// writes, or of a tool it does not know.
	it( 'reports an approval from an earlier build and a tool it does not recognise as uncertain, never as reads', async () => {
		const fixture = await recoveryFixture();
		await fixture.deadTurn( {
			journal: [
				{
					type: 'approval.requested',
					...ids,
					toolCallId: 'earlier',
					requestId: 'earlier-request',
					description: 'Create a draft post on My\u200bShop',
					operation: {
						tool: 'sites.wpCli',
						operationClass: 'command',
						target,
						args: '[]',
						localPaths: [],
					},
				},
				{ type: 'approval.resolved', ...ids, toolCallId: 'earlier', requestId: 'earlier-request' },
				{ type: 'tool.started', ...ids, toolCallId: 'unknown', name: 'future\u200b_tool' },
				{ type: 'tool.started', ...ids, toolCallId: 'known-read', name: 'site_info' },
			],
		} );
		const result = await fixture.recover();
		expect( result ).toMatchObject( {
			status: 'recovered',
			uncertainOperations: [
				{
					toolCallId: 'earlier',
					tool: 'sites.wpCli',
					operationClass: 'command',
					evidence: 'requested',
					description: 'Create a draft post on My\u200bShop',
					requestId: 'earlier-request',
					resolved: true,
				},
				{
					toolCallId: 'unknown',
					tool: 'future\u200b_tool',
					evidence: 'started',
				},
			],
		} );
		const unknown = result.status === 'recovered' ? result.uncertainOperations[ 1 ] : undefined;
		expect( unknown ).not.toHaveProperty( 'operationClass' );
		// Its kind is the evidence; the apps word it in their own language.
		expect( unknown ).not.toHaveProperty( 'description' );
		expect( result.status === 'recovered' && result.uncertainOperations ).toHaveLength( 2 );
		if ( result.status !== 'recovered' ) throw new Error( 'Expected a recovered turn' );
		expect( result.uncertainOperations.map( getClaudeUncertainOperationDescription ) ).toEqual( [
			'Create a draft post on My\\u200bShop',
			'Run an operation Studio does not recognize: future\\u200b_tool',
		] );
		const journals = await fixture.store.readJournals( 'chat' );
		const recorded = journals.flat().find( ( event ) => event.type === 'turn.recovered' );
		expect(
			recorded?.uncertainOperations.map( ( operation ) => operation.description ?? operation.tool )
		).toEqual( [ 'Create a draft post on My\u200bShop', 'future\u200b_tool' ] );
		const note = recoveryNote( journals );
		expect( note?.text ).toContain( 'My\\u200bShop' );
		expect( note?.text ).toContain( 'future\\u200b_tool' );
		expect( note?.text ).not.toContain( '\u200b' );
	} );

	it( 'reports one operation for a tool call journaled at the tool and at its host operation, the host one, and never merges entries that name no tool call', async () => {
		const fixture = await recoveryFixture();
		const authorized = ( toolCallId: string | undefined, tool: string ) =>
			( {
				type: 'operation.authorized',
				...ids,
				toolCallId,
				operation: { tool, operationClass: 'command', target },
				description: `Run a command: ${ tool }`,
			} ) as ClaudeTurnJournalEvent;
		await fixture.deadTurn( {
			journal: [
				// One call, journaled at the tool and at the host operation it reached.
				authorized( 'call', 'wp_cli' ),
				authorized( 'call', 'sites.wpCli' ),
				// One call that reached two host operations: each may have changed something.
				authorized( 'create', 'site_create' ),
				authorized( 'create', 'sites.create' ),
				authorized( 'create', 'sites.start' ),
				// A call that never reached its host operation.
				authorized( 'alone', 'wp_cli' ),
				// Entries that name no tool call, and a result that names none either.
				authorized( undefined, 'wp_cli' ),
				authorized( undefined, 'wp_cli' ),
				authorized( undefined, 'sites.wpCli' ),
				authorized( '', 'wp_cli' ),
				{ type: 'tool.result', ...ids, isError: false } as ClaudeTurnJournalEvent,
			],
		} );
		const result = await fixture.recover();
		expect( result.status === 'recovered' && result.uncertainOperations ).toEqual( [
			expect.objectContaining( { toolCallId: 'call', tool: 'sites.wpCli' } ),
			expect.objectContaining( { toolCallId: 'create', tool: 'sites.create' } ),
			expect.objectContaining( { toolCallId: 'create', tool: 'sites.start' } ),
			expect.objectContaining( { toolCallId: 'alone', tool: 'wp_cli' } ),
			expect.objectContaining( { tool: 'wp_cli' } ),
			expect.objectContaining( { tool: 'wp_cli' } ),
			expect.objectContaining( { tool: 'sites.wpCli' } ),
			expect.objectContaining( { toolCallId: '', tool: 'wp_cli' } ),
		] );
	} );

	it( 'leaves the dead run’s approvals unanswerable by any later run', async () => {
		const fixture = await recoveryFixture();
		const journal = await pendingDraft();
		const { requestId: stale, toolCallId } = idsOf( journal );
		await fixture.deadTurn( { journal } );
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
				{ requestId: stale },
				{
					tool: 'sites.wpCli',
					operationClass: 'command',
					args: [ 'post', 'create', '--post_status=draft', '--post_title=Hello' ],
					localPaths: [],
					description: 'Create a draft post on the current local site',
				},
				toolCallId
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
			const journal = await pendingDraft();
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
		).toMatchObject( { state: 'claimed' } );
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
		const journal = await pendingDraft();
		const { requestId } = idsOf( journal );
		const { raw } = await fixture.deadTurn( { journal } );
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
			invalidatedApprovals: [ requestId ],
			uncertainOperations: [ expect.objectContaining( { tool: 'sites.wpCli', requestId } ) ],
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

	const claimsIn = async ( fixture: Awaited< ReturnType< typeof recoveryFixture > > ) =>
		( await readdir( path.dirname( fixture.lockFile ) ) ).filter( ( name ) =>
			name.includes( '.claim-' )
		);

	it( 'gives an empty or unreadable claim its own reason, and leaves it and the lock as they are', async () => {
		const fixture = await recoveryFixture();
		const { raw } = await fixture.deadTurn();
		const claim = `${ fixture.lockFile }.${ claudeLockDigest( JSON.parse( raw ).token ).slice(
			0,
			32
		) }.claim-0`;
		for ( const content of [ '', '{"version":1', JSON.stringify( { version: 1 } ) ] ) {
			await writeFile( claim, content );
			expect( await fixture.recover() ).toEqual( {
				status: 'blocked',
				reason: 'recovery-claim-unreadable',
				...ids,
			} );
			expect( await readFile( claim, 'utf8' ) ).toBe( content );
			expect( await readFile( fixture.lockFile, 'utf8' ) ).toBe( raw );
		}
	} );

	it( 'returns a typed result, and gives up its claim, when the lock cannot be read again at takeover', async () => {
		const fixture = await recoveryFixture();
		const { raw } = await fixture.deadTurn();
		const unreadable = {
			...fixture.store,
			holdsLock: async () => {
				throw Object.assign( new Error( 'access denied' ), { code: 'EACCES' } );
			},
		};
		expect( await fixture.recover( {}, unreadable ) ).toEqual( {
			status: 'blocked',
			reason: 'lock-unreadable',
			...ids,
		} );
		expect( await readFile( fixture.lockFile, 'utf8' ) ).toBe( raw );
		expect( await claimsIn( fixture ) ).toEqual( [] );
		expect( await fixture.store.readJournals( 'chat' ) ).toEqual( [] );
	} );

	it( 'removes its own claim once it has recovered', async () => {
		const fixture = await recoveryFixture();
		const { raw } = await fixture.deadTurn();
		const token = JSON.parse( raw ).token as string;
		// A claim left by an earlier recovery whose process has ended.
		const gone = { pid: 7777, start: 'ended-recovery' };
		expect(
			await fixture.store.claimRecovery( 'chat', token, gone, async () => 'gone' )
		).toMatchObject( { state: 'claimed' } );
		expect( await fixture.recover() ).toMatchObject( { status: 'recovered' } );
		expect( await claimsIn( fixture ) ).toEqual( [] );
	} );

	it( 'recovers once when two recoveries run at the same time', async () => {
		const fixture = await recoveryFixture();
		await fixture.deadTurn( { journal: await pendingDraft() } );
		// Each recovery's claim names this live process.
		fixture.states.set( `${ self.pid }:${ self.start }`, 'alive' );
		const results = await Promise.all( [ fixture.recover(), fixture.recover() ] );
		expect( results.filter( ( result ) => result.status === 'recovered' ) ).toHaveLength( 1 );
		expect( results.find( ( result ) => result.status === 'blocked' ) ).toMatchObject( {
			reason: expect.stringMatching( /^(recovery-in-progress|lock-changed|not-locked)$/ ),
		} );
		const events = ( await fixture.store.readJournals( 'chat' ) ).flat();
		expect( events.filter( ( event ) => event.type === 'turn.recovered' ) ).toHaveLength( 1 );
		expect( events.filter( ( event ) => event.type === 'turn.terminal' ) ).toHaveLength( 1 );
		expect( events.filter( ( event ) => event.type === 'approval.resolved' ) ).toHaveLength( 1 );
		expect( await fixture.store.inspectLock( 'chat' ) ).toEqual( { state: 'none' } );
		expect( await claimsIn( fixture ) ).toEqual( [] );
	} );

	it( 'leaves a lock that replaced the recovered one between the record and the release, with the record kept once', async () => {
		const fixture = await recoveryFixture();
		const { raw } = await fixture.deadTurn();
		let replacement: string | undefined;
		const replacing = {
			...fixture.store,
			recordRecovery: async ( ...args: Parameters< typeof fixture.store.recordRecovery > ) => {
				const recorded = await fixture.store.recordRecovery( ...args );
				// Something else takes the conversation once the record is on disk.
				await rm( fixture.lockFile );
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
				return recorded;
			},
		};
		expect( await fixture.recover( {}, replacing ) ).toEqual( {
			status: 'blocked',
			reason: 'lock-changed',
			...ids,
		} );
		expect( replacement ).not.toBe( raw );
		expect( await readFile( fixture.lockFile, 'utf8' ) ).toBe( replacement );
		const events = ( await fixture.store.readJournals( 'chat' ) ).flat();
		expect( events.filter( ( event ) => event.type === 'turn.recovered' ) ).toEqual( [
			expect.objectContaining( { lock: claudeLockDigest( JSON.parse( raw ).token ) } ),
		] );
		expect( await claimsIn( fixture ) ).toEqual( [] );
	} );

	it( 'takes over nothing when the owner moved its lock to a later stage after it was inspected', async () => {
		const fixture = await recoveryFixture();
		const { lock } = await fixture.deadTurn( { stage: 'locked' } );
		let advanced: string | undefined;
		fixture.seams.checkIdentity.mockImplementationOnce( async () => {
			// The owner, still running with the same token, starts its native process.
			await lock.update( {
				stage: 'starting',
				session: { nativeSessionId: randomUUID(), resume: false },
			} );
			advanced = await readFile( fixture.lockFile, 'utf8' );
			return 'gone';
		} );
		expect( await fixture.recover() ).toEqual( {
			status: 'blocked',
			reason: 'lock-changed',
			...ids,
		} );
		expect( await readFile( fixture.lockFile, 'utf8' ) ).toBe( advanced );
		expect( await fixture.store.readJournals( 'chat' ) ).toEqual( [] );
		expect( await claimsIn( fixture ) ).toEqual( [] );
	} );
} );

describe( 'deleting a conversation', () => {
	it( 'removes its leftover lock and claim files, but no claim whose process may still run, and nothing of another conversation', async () => {
		const fixture = await recoveryFixture();
		const { raw } = await fixture.deadTurn();
		const directory = path.dirname( fixture.lockFile );
		const lockName = path.basename( fixture.lockFile );
		const digest = claudeLockDigest( JSON.parse( raw ).token ).slice( 0, 32 );
		const claim = ( generation: number ) => `${ lockName }.${ digest }.claim-${ generation }`;
		const other = `${ lockName.replace(
			/^[0-9a-f]{64}/,
			'f'.repeat( 64 )
		) }.${ randomUUID() }.tmp`;
		const files: Record< string, string > = {
			[ `${ lockName }.${ randomUUID() }.tmp` ]: '{"version":2',
			[ claim( 0 ) ]: JSON.stringify( { version: 1, claimant: { pid: 1, start: 'ended' } } ),
			[ claim( 1 ) ]: JSON.stringify( { version: 1, claimant: { pid: 2, start: 'running' } } ),
			[ claim( 2 ) ]: '',
			[ other ]: 'another conversation',
		};
		await rm( fixture.lockFile );
		for ( const [ name, content ] of Object.entries( files ) )
			await writeFile( path.join( directory, name ), content );
		const release = await fixture.store.lockTurn( 'chat' );
		await fixture.store.clearConversation(
			'chat',
			async () => {},
			async ( identity ) => ( identity.start === 'ended' ? 'gone' : 'alive' )
		);
		await release();
		expect( ( await readdir( directory ) ).sort() ).toEqual(
			[ claim( 1 ), claim( 2 ), other ].sort()
		);
	} );
} );
