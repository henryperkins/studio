import { randomUUID } from 'crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveClaudeSession } from '@studio/agent/protocol/claude-code';
import { fakeSite } from '../../tests/fake-host';
import { studioToolDefinitions } from '../../tools';
import { createAskUserQuestionTool } from '../../tools/ask-user-question';
import { createPresentDesignOptionsTool } from '../../tools/present-design-options';
import { createSkillTool } from '../../tools/skill';
import {
	CLAUDE_ENABLED_TOOLS,
	CLAUDE_EXECUTION_POLICY_REVISION,
	CLAUDE_NATIVE_TOOL_RULES,
	CLAUDE_STUDIO_TOOL_RULES,
	requiresClaudeApproval,
} from '../execution-policy';
import { createNativeSessionStore } from '../sessions';
import { createPolicyFixture } from './fixtures/execution-policy';
import type { ClaudeOperation } from '../execution-policy';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { ClaudeOperationClass } from '@studio/agent/protocol/claude-code';

const cleanups: Array< () => Promise< void > > = [];
afterEach( async () => {
	await Promise.all( cleanups.splice( 0 ).map( ( cleanup ) => cleanup() ) );
} );
async function setup( ...args: Parameters< typeof createPolicyFixture > ) {
	const fixture = await createPolicyFixture( ...args );
	cleanups.push( fixture.cleanup );
	return fixture;
}

const draftArgs = [ 'post', 'create', '--post_status=draft', '--post_title=Hello' ];
const skipFlags = [ '--skip-packages', '--skip-plugins', '--skip-themes' ];
const studioServer = { name: 'studio', source: 'sdk' };

describe( 'Claude operation classes', () => {
	it( 'classifies every registered Studio tool at least as strictly as its annotations', () => {
		const skill = createSkillTool();
		const definitions = [
			...studioToolDefinitions,
			createAskUserQuestionTool( async () => ( {} ) ),
			createPresentDesignOptionsTool(),
			...( skill ? [ skill ] : [] ),
		];
		for ( const definition of definitions ) {
			const rule = CLAUDE_STUDIO_TOOL_RULES.get( definition.name );
			expect( rule, definition.name ).toBeDefined();
			const { readOnlyHint, destructiveHint, openWorldHint } = definition.annotations;
			if ( ! readOnlyHint )
				expect( [ 'read', 'remote-read' ], definition.name ).not.toContain( rule!.operationClass );
			if ( destructiveHint || ( openWorldHint && ! readOnlyHint ) )
				expect( requiresClaudeApproval( rule!.operationClass ), definition.name ).toBe( true );
		}
		const names = new Set( definitions.map( ( definition ) => definition.name ) );
		for ( const name of CLAUDE_STUDIO_TOOL_RULES.keys() )
			expect( names.has( name ) || ( name === 'Skill' && ! skill ), name ).toBe( true );
	} );

	it( 'keeps ordinary local edits unprompted and asks before overwrite, remote, message and command operations', () => {
		const classes: ClaudeOperationClass[] = [
			'read',
			'remote-read',
			'local-change',
			'local-overwrite',
			'remote-change',
			'remote-overwrite',
			'external-message',
			'command',
		];
		expect(
			Object.fromEntries( classes.map( ( item ) => [ item, requiresClaudeApproval( item ) ] ) )
		).toEqual( {
			read: false,
			'remote-read': false,
			'local-change': false,
			'local-overwrite': true,
			'remote-change': true,
			'remote-overwrite': true,
			'external-message': true,
			command: true,
		} );
		expect( CLAUDE_NATIVE_TOOL_RULES.get( 'Write' )?.operationClass ).toBe( 'local-change' );
		expect( CLAUDE_NATIVE_TOOL_RULES.get( 'Edit' )?.operationClass ).toBe( 'local-change' );
		expect( CLAUDE_NATIVE_TOOL_RULES.get( 'Bash' )?.operationClass ).toBe( 'command' );
		expect( CLAUDE_STUDIO_TOOL_RULES.get( 'send_feedback' )?.operationClass ).toBe(
			'external-message'
		);
		expect( CLAUDE_STUDIO_TOOL_RULES.get( 'site_push' )?.operationClass ).toBe(
			'remote-overwrite'
		);
		// This build runs only what the proof of concept ran.
		expect( CLAUDE_ENABLED_TOOLS ).toEqual( { native: [ 'Read' ], studio: [ 'wp_cli' ] } );
	} );

	it( 'classifies a WordPress.com request by its method, never by its annotation alone', () => {
		const rule = CLAUDE_STUDIO_TOOL_RULES.get( 'wpcom_request' )!;
		expect( rule.classify?.( { siteId: 1, method: 'GET', path: '/posts' } ) ).toBe( 'remote-read' );
		expect( rule.classify?.( { siteId: 1, method: 'DELETE', path: '/posts/1' } ) ).toBe(
			'remote-overwrite'
		);
		expect( rule.classify?.( { siteId: 1, method: 'PATCH', path: '/posts/1' } ) ).toBeUndefined();
	} );
} );

describe( 'Claude tool use at the SDK hook and native permission request', () => {
	it( 'allows only enabled tools from the Studio SDK server and reads inside the target', async () => {
		const { policy, site } = await setup();
		await writeFile( path.join( site, 'readme.txt' ), 'fixture' );
		await writeFile( path.join( site, '.env' ), 'SECRET=1' );
		const use = ( toolName: string, input: unknown, mcpServer?: typeof studioServer ) =>
			policy.authorizeToolUse( { toolName, input, toolUseId: randomUUID(), mcpServer } );
		expect( await use( 'Read', { file_path: path.join( site, 'readme.txt' ) } ) ).toBe( true );
		expect( await use( 'mcp__studio__wp_cli', {}, studioServer ) ).toBe( true );
		const denied: Array< [ string, unknown, typeof studioServer? ] > = [
			[ 'Read', { file_path: path.join( site, '.env' ) } ],
			[ 'Read', { file_path: path.join( site, '..', 'config' ) } ],
			[ 'Read', { file_path: 'readme.txt' } ],
			[ 'Read', 'readme.txt' ],
			[ 'Write', { file_path: path.join( site, 'readme.txt' ), content: 'changed' } ],
			[ 'Bash', { command: 'echo hi' } ],
			[ 'WebFetch', { url: 'https://example.com' } ],
			[ 'Task', { prompt: 'anything' } ],
			[ 'mcp__studio__wp_cli', {}, { name: 'studio', source: 'project' } ],
			[ 'mcp__studio__wp_cli', {} ],
			[ 'mcp__studio__site_delete', {}, studioServer ],
			[ 'mcp__other__wp_cli', {}, { name: 'other', source: 'sdk' } ],
		];
		for ( const [ toolName, input, server ] of denied )
			expect( await use( toolName, input, server ), toolName ).toBe( false );
	} );

	it( 'denies tool use before startup is verified and after the target or connection changed', async () => {
		let ready = false;
		const { policy, site, context } = await setup( () => ( { ready: () => ready } ) );
		await writeFile( path.join( site, 'readme.txt' ), 'fixture' );
		const read = () =>
			policy.authorizeToolUse( {
				toolName: 'Read',
				input: { file_path: path.join( site, 'readme.txt' ) },
				toolUseId: randomUUID(),
			} );
		expect( await read() ).toBe( false );
		ready = true;
		expect( await read() ).toBe( true );
		expect( context.verifyTarget ).toHaveBeenLastCalledWith( {
			environment: 'local',
			siteId: fakeSite.id,
		} );
		vi.mocked( context.verifyTarget ).mockResolvedValueOnce( false );
		expect( await read() ).toBe( false );
		// A changed target ends what this turn may do; it does not wait to be changed back.
		expect( await read() ).toBe( false );
		expect( policy.signal.aborted ).toBe( true );

		const detached = await setup( () => ( { stillConnected: async () => false } ) );
		await writeFile( path.join( detached.site, 'readme.txt' ), 'fixture' );
		expect(
			await detached.policy.authorizeToolUse( {
				toolName: 'Read',
				input: { file_path: path.join( detached.site, 'readme.txt' ) },
				toolUseId: 'use',
			} )
		).toBe( false );
	} );

	it( 'asks for a bounded approval of the exact shell command, whatever the command says', async () => {
		const { policy, context, events } = await setup( () => ( {
			enabledTools: { native: [ 'Read', 'Bash' ], studio: [] },
		} ) );
		const input = { command: 'echo hi', description: 'Say hi' };
		expect( await policy.authorizeToolUse( { toolName: 'Bash', input, toolUseId: 'use-1' } ) ).toBe(
			true
		);
		expect( context.approve ).toHaveBeenCalledOnce();
		const request = vi.mocked( context.approve ).mock.calls[ 0 ][ 0 ];
		expect( request.operation ).toMatchObject( {
			tool: 'Bash',
			operationClass: 'command',
			args: input,
		} );
		expect( Object.isFrozen( request.operation.args ) ).toBe( true );
		expect( events[ 0 ] ).toMatchObject( {
			type: 'approval.requested',
			toolCallId: 'use-1',
			operation: { tool: 'Bash', operationClass: 'command' },
		} );
		for ( const unbounded of [
			{ command: 'echo hi', run_in_background: true },
			{ command: 'echo hi', timeout: 60 * 60 * 1000 },
			{ command: 'echo hi', dangerouslyDisableSandbox: true },
			{ command: '   ' },
			{ command: 'echo hi', unexpected: true },
		] )
			expect(
				await policy.authorizeToolUse( { toolName: 'Bash', input: unbounded, toolUseId: 'use-2' } )
			).toBe( false );
		expect( context.approve ).toHaveBeenCalledOnce();
		vi.mocked( context.approve ).mockResolvedValueOnce( 'deny' );
		expect( await policy.authorizeToolUse( { toolName: 'Bash', input, toolUseId: 'use-3' } ) ).toBe(
			false
		);
	} );
} );

describe( 'Claude approvals at host execution', () => {
	it( 'approves exactly the proposed draft once, before the CLI command, after the SDK allowed the tool', async () => {
		const { policy, context, host, localSite, events, site } = await setup();
		expect(
			await policy.authorizeToolUse( {
				toolName: 'mcp__studio__wp_cli',
				input: { nameOrPath: 'site', command: 'post create' },
				toolUseId: 'use',
				mcpServer: studioServer,
			} )
		).toBe( true );
		expect( context.approve ).not.toHaveBeenCalled();
		await policy.guardHost( host, 'call' ).sites.wpCli( localSite, draftArgs );
		expect( context.approve ).toHaveBeenCalledOnce();
		const request = vi.mocked( context.approve ).mock.calls[ 0 ][ 0 ];
		expect( request ).toMatchObject( {
			runId: 'run',
			turnId: 'turn',
			toolCallId: 'call',
			connectionId: 'connection',
			connectionRevision: 1,
			policyRevision: CLAUDE_EXECUTION_POLICY_REVISION,
			target: { environment: 'local', siteId: fakeSite.id },
			operation: {
				tool: 'sites.wpCli',
				operationClass: 'command',
				args: draftArgs,
				siteId: fakeSite.id,
				localPaths: [ site ],
			},
		} );
		expect( request.requestId ).toMatch( /^[0-9a-f-]{36}$/ );
		expect( Object.isFrozen( request ) && Object.isFrozen( request.operation.args ) ).toBe( true );
		expect( host.sites.wpCli ).toHaveBeenCalledOnce();
		const [ ranOn, ranArgs, options ] = vi.mocked( host.sites.wpCli ).mock.calls[ 0 ];
		expect( ranOn.id ).toBe( fakeSite.id );
		expect( ranArgs ).toEqual( [ ...draftArgs, ...skipFlags ] );
		await expect( options?.beforeSpawn?.() ).resolves.toBeUndefined();
		expect( events.map( ( event ) => event.type ) ).toEqual( [
			'approval.requested',
			'approval.resolved',
		] );
		expect( events[ 0 ] ).toMatchObject( {
			requestId: request.requestId,
			toolCallId: 'call',
			operation: {
				tool: 'sites.wpCli',
				operationClass: 'command',
				target: { environment: 'local', siteId: fakeSite.id },
			},
			draft: { siteName: 'My Site', title: 'Hello' },
		} );
	} );

	it( 'runs allowlisted reads without asking and refuses other sites and commands outside this build', async () => {
		const { policy, context, host, localSite } = await setup();
		const guarded = policy.guardHost( host, 'call' );
		await guarded.sites.wpCli( localSite, [ 'post', 'list' ] );
		expect( context.approve ).not.toHaveBeenCalled();
		await expect( guarded.sites.wpCli( localSite, [ 'post', 'delete', '1' ] ) ).rejects.toThrow();
		await expect(
			guarded.sites.wpCli( { ...localSite, id: 'other' }, [ 'post', 'list' ] )
		).rejects.toThrow();
		vi.mocked( host.sites.resolve ).mockResolvedValueOnce( { ...localSite, id: 'other' } );
		await expect( guarded.sites.wpCli( localSite, [ 'post', 'list' ] ) ).rejects.toThrow();
		expect( host.sites.wpCli ).toHaveBeenCalledOnce();
	} );

	it( 'rejects execution when the arguments or call differ from the approval, and uses a grant once', async () => {
		const { policy, context } = await setup();
		const args = { nameOrPath: 'site' };
		const operation: ClaudeOperation = {
			tool: 'site_delete',
			operationClass: 'local-overwrite',
			args,
			siteId: fakeSite.id,
			localPaths: [],
			description: 'Delete the site',
		};
		const changed = await policy.requestApproval( operation, 'call' );
		args.nameOrPath = 'another site';
		expect( await policy.authorizeExecution( changed!, operation, 'call' ) ).toBe( false );
		args.nameOrPath = 'site';
		// A mismatched use spends the grant.
		expect( await policy.authorizeExecution( changed!, operation, 'call' ) ).toBe( false );
		const elsewhere = await policy.requestApproval( operation, 'call' );
		expect( await policy.authorizeExecution( elsewhere!, operation, 'other-call' ) ).toBe( false );
		const exact = await policy.requestApproval( operation, 'call' );
		expect( await policy.authorizeExecution( exact!, operation, 'call' ) ).toBe( true );
		expect( await policy.authorizeExecution( exact!, operation, 'call' ) ).toBe( false );
		expect( context.approve ).toHaveBeenCalledTimes( 3 );
	} );

	it( 'does not run a denied draft, expires an unanswered one and ignores its late allow', async () => {
		let release!: ( answer: 'allow' ) => void;
		const { policy, host, localSite, events, context } = await setup( () => ( {
			approve: vi
				.fn()
				.mockResolvedValueOnce( 'deny' )
				.mockImplementationOnce(
					() =>
						new Promise( ( resolve ) => {
							release = resolve;
						} )
				),
		} ) );
		const guarded = policy.guardHost( host, 'call' );
		await expect( guarded.sites.wpCli( localSite, draftArgs ) ).rejects.toThrow();
		await expect( guarded.sites.wpCli( localSite, draftArgs ) ).rejects.toThrow();
		expect( vi.mocked( context.approve ).mock.calls[ 1 ][ 1 ].aborted ).toBe( true );
		release( 'allow' );
		await new Promise( ( resolve ) => setTimeout( resolve, 10 ) );
		expect( host.sites.wpCli ).not.toHaveBeenCalled();
		expect( events.map( ( event ) => event.type ) ).toEqual( [
			'approval.requested',
			'approval.resolved',
			'approval.requested',
			'approval.resolved',
		] );
	} );

	it( 'does not run an approved operation when the target changed after Send', async () => {
		const { policy, host, localSite, context, site } = await setup();
		await writeFile( path.join( site, 'readme.txt' ), 'fixture' );
		vi.mocked( context.approve ).mockImplementationOnce( async () => {
			vi.mocked( context.verifyTarget ).mockResolvedValue( false );
			return 'allow';
		} );
		const guarded = policy.guardHost( host, 'call' );
		await expect( guarded.sites.wpCli( localSite, draftArgs ) ).rejects.toThrow();
		vi.mocked( context.verifyTarget ).mockResolvedValue( true );
		await expect( guarded.sites.wpCli( localSite, [ 'post', 'list' ] ) ).rejects.toThrow();
		expect(
			await policy.authorizeToolUse( {
				toolName: 'Read',
				input: { file_path: path.join( site, 'readme.txt' ) },
				toolUseId: 'use',
			} )
		).toBe( false );
		expect( host.sites.wpCli ).not.toHaveBeenCalled();
	} );

	it( 'does not run an approved operation when the connection changed before execution', async () => {
		const { policy, host, localSite, context } = await setup();
		vi.mocked( context.approve ).mockImplementationOnce( async () => {
			vi.mocked( context.stillConnected ).mockResolvedValue( false );
			return 'allow';
		} );
		await expect(
			policy.guardHost( host, 'call' ).sites.wpCli( localSite, draftArgs )
		).rejects.toThrow();
		expect( host.sites.wpCli ).not.toHaveBeenCalled();
	} );

	it( 'invalidates a pending approval when the turn is cancelled, so a later reply cannot run it', async () => {
		let reply!: ( answer: 'allow' ) => void;
		let approvalSignal: AbortSignal | undefined;
		const { policy, host, localSite, controller, events } = await setup( () => ( {
			approvalTimeoutMs: 60_000,
			approve: vi.fn(
				( _request, signal: AbortSignal ) =>
					new Promise< 'allow' >( ( resolve ) => {
						approvalSignal = signal;
						reply = resolve;
					} )
			),
		} ) );
		const pending = policy.guardHost( host, 'call' ).sites.wpCli( localSite, draftArgs );
		await vi.waitFor( () => expect( approvalSignal ).toBeDefined() );
		controller.abort();
		await expect( pending ).rejects.toThrow();
		expect( approvalSignal!.aborted ).toBe( true );
		reply( 'allow' );
		await new Promise( ( resolve ) => setTimeout( resolve, 10 ) );
		expect( host.sites.wpCli ).not.toHaveBeenCalled();
		expect( events.at( -1 ) ).toMatchObject( { type: 'approval.resolved' } );
	} );

	it( 'fences every cancellable host operation before its CLI command', async () => {
		const { policy, host, localSite, context } = await setup();
		const guarded = policy.guardHost( host, 'call' );
		await guarded.sites.start( localSite, () => {} );
		expect( host.sites.start ).toHaveBeenCalledWith(
			expect.objectContaining( { id: fakeSite.id } ),
			expect.any( Function ),
			expect.objectContaining( { signal: policy.signal, beforeSpawn: expect.any( Function ) } )
		);
		await guarded.sites.delete( localSite, true, () => {} );
		expect( context.approve ).toHaveBeenCalledWith(
			expect.objectContaining( {
				operation: expect.objectContaining( {
					tool: 'sites.delete',
					operationClass: 'local-overwrite',
				} ),
			} ),
			expect.any( AbortSignal )
		);
		await guarded.sync.push( localSite, 'all', 'remote.example', () => {} );
		await guarded.previews.create( localSite, () => {} );
		expect( context.approve ).toHaveBeenCalledTimes( 3 );
		policy.dispose();
		await expect( guarded.sites.stop( localSite, () => {} ) ).rejects.toThrow();
		expect( host.sites.stop ).not.toHaveBeenCalled();
	} );
} );

describe( 'Claude targets', () => {
	const binding = { connectionId: 'connection', workingDirectory: '/w', configDirectory: '/c' };
	const entry = ( customType: string, data: unknown ) =>
		( {
			type: 'custom',
			id: randomUUID(),
			parentId: null,
			timestamp: '2026-11-11T00:00:00.000Z',
			customType,
			data,
		} ) as SessionEntry;
	const selection = entry( 'studio.claude_selection', { model: 'model', effort: 'medium' } );
	const selected = ( data: Record< string, unknown > ) =>
		entry( 'studio.site_selected', { siteName: 'Site', sitePath: '/s', ...data } );
	const siteChat = [
		selected( { siteId: 'site' } ),
		entry( 'studio.claude_binding', { ...binding, siteId: 'site' } ),
		selection,
	];
	const globalChat = [ entry( 'studio.claude_binding', { ...binding, siteId: null } ), selection ];

	it( 'resolves global and site conversations and explicit local and live selections', () => {
		expect( resolveClaudeSession( globalChat )?.target ).toEqual( { environment: 'global' } );
		expect( resolveClaudeSession( siteChat )?.target ).toEqual( {
			environment: 'local',
			siteId: 'site',
		} );
		const live = [ ...siteChat, selected( { siteId: 'site', remote: true, wpcomSiteId: 42 } ) ];
		expect( resolveClaudeSession( live )?.target ).toEqual( {
			environment: 'live',
			siteId: 'site',
			wpcomSiteId: 42,
		} );
		expect( resolveClaudeSession( [ ...live, selected( { siteId: 'site' } ) ] )?.target ).toEqual( {
			environment: 'local',
			siteId: 'site',
		} );
		const created = [ ...globalChat, selected( { siteId: 'created' } ) ];
		expect( resolveClaudeSession( created ) ).toMatchObject( {
			binding: { siteId: null },
			target: { environment: 'local', siteId: 'created' },
		} );
	} );

	it( 'refuses a selection that would rebind a site conversation or cannot name its target', () => {
		for ( const invalid of [
			[ ...siteChat, selected( { siteId: 'other' } ) ],
			[ ...siteChat, selected( {} ) ],
			[ ...siteChat, selected( { siteId: 'site', remote: true } ) ],
			[ entry( 'studio.claude_binding', binding ), selection ],
		] )
			expect( () => resolveClaudeSession( invalid ) ).toThrow();
	} );

	it( 'keeps legacy site conversations, their native records and their journals', async () => {
		const root = await realpath( await mkdtemp( path.join( os.tmpdir(), 'claude-legacy-' ) ) );
		cleanups.push( () => rm( root, { recursive: true, force: true } ) );
		const store = createNativeSessionStore( root );
		const record = {
			backend: 'claude-code' as const,
			nativeSessionId: randomUUID(),
			connectionId: 'connection',
			workingDirectory: root,
			configDirectory: root,
		};
		const prompt = {
			type: 'turn.prompt' as const,
			runId: 'run',
			turnId: 'turn',
			text: 'Before global conversations existed',
		};
		await store.create( { ...record, conversationId: 'legacy', siteId: 'site' } );
		await store.journal( 'legacy', 'turn' ).append( prompt );
		await store.create( { ...record, conversationId: 'global', siteId: null } );
		await expect(
			store.create( {
				...record,
				conversationId: 'missing',
			} as unknown as Parameters< typeof store.create >[ 0 ] )
		).rejects.toThrow();
		await expect( store.load( 'legacy' ) ).resolves.toMatchObject( { siteId: 'site' } );
		await expect( store.load( 'global' ) ).resolves.toMatchObject( { siteId: null } );
		await expect( store.readJournals( 'legacy' ) ).resolves.toEqual( [ [ prompt ] ] );
	} );

	it( 'creates sites only from a global conversation and records the new site for the next turn', async () => {
		const workspace = { siteId: null, workingDirectory: '', configDirectory: '' };
		const { policy, host, context, parent, localSite } = await setup( ( paths ) => ( {
			target: { environment: 'global' },
			workspace: { ...workspace, workingDirectory: paths.parent, configDirectory: paths.config },
			targetSite: undefined,
			localRoots: [ paths.parent ],
		} ) );
		const selectSite = vi.fn( async () => {} );
		host.selectSite = selectSite;
		const guarded = policy.guardHost( host, 'call' );
		const created = path.join( parent, 'new-site' );
		await guarded.sites.create( 'New site', created, () => {} );
		expect( host.sites.create ).toHaveBeenCalledWith(
			'New site',
			created,
			expect.any( Function ),
			expect.objectContaining( { signal: policy.signal } )
		);
		await expect( guarded.sites.start( localSite, () => {} ) ).rejects.toThrow();
		await expect(
			guarded.selectSite!( {
				id: 'other',
				name: 'Other',
				path: path.join( parent, 'other' ),
				running: true,
			} )
		).rejects.toThrow();
		await guarded.selectSite!( { id: 'new', name: 'New site', path: created, running: true } );
		expect( selectSite ).toHaveBeenCalledOnce();
		await guarded.sites.create( 'Another', path.join( parent, 'another' ), () => {} );
		expect( context.verifyTarget ).toHaveBeenLastCalledWith( {
			environment: 'local',
			siteId: 'new',
		} );
		await expect(
			guarded.sites.create( 'Nested', path.join( parent, 'nested', 'site' ), () => {} )
		).rejects.toThrow();
		expect( host.sites.create ).toHaveBeenCalledTimes( 2 );

		const siteConversation = await setup();
		await expect(
			siteConversation.policy
				.guardHost( siteConversation.host, 'call' )
				.sites.create( 'New site', path.join( siteConversation.parent, 'new-site' ), () => {} )
		).rejects.toThrow();
		expect( siteConversation.host.sites.create ).not.toHaveBeenCalled();
	} );

	it( 'lets a WordPress.com request reach only the live target', async () => {
		const enabledTools = { native: [], studio: [ 'wpcom_request' ] };
		const live = await setup( () => ( {
			target: { environment: 'live', siteId: fakeSite.id, wpcomSiteId: 42 },
			enabledTools,
		} ) );
		const call = ( policy: typeof live.policy, args: Record< string, unknown > ) =>
			policy.authorizeStudioCall( 'wpcom_request', args, randomUUID() );
		expect( await call( live.policy, { siteId: 42, method: 'GET', path: '/posts' } ) ).toBe( true );
		expect( await call( live.policy, { siteId: 7, method: 'GET', path: '/posts' } ) ).toBe( false );
		expect( live.context.approve ).not.toHaveBeenCalled();
		expect( await call( live.policy, { siteId: 42, method: 'POST', path: '/posts' } ) ).toBe(
			true
		);
		expect( live.context.approve ).toHaveBeenCalledOnce();
		expect( await live.policy.authorizeStudioCall( 'wp_cli', {}, 'call' ) ).toBe( false );

		const local = await setup( () => ( { enabledTools } ) );
		expect( await call( local.policy, { siteId: 42, method: 'GET', path: '/posts' } ) ).toBe(
			false
		);
	} );

	it( 'reads in the target site of a global conversation as well as its own workspace', async () => {
		const { policy, site, parent } = await setup( ( paths ) => ( {
			workspace: { siteId: null, workingDirectory: paths.parent, configDirectory: paths.config },
			localRoots: [ path.join( paths.parent, 'workspace' ), paths.site ],
		} ) );
		await mkdir( path.join( parent, 'workspace' ) );
		await writeFile( path.join( parent, 'workspace', 'notes.md' ), 'fixture' );
		await writeFile( path.join( site, 'readme.txt' ), 'fixture' );
		await writeFile( path.join( parent, 'elsewhere.txt' ), 'fixture' );
		const read = ( file: string ) =>
			policy.authorizeToolUse( { toolName: 'Read', input: { file_path: file }, toolUseId: 'use' } );
		expect( await read( path.join( parent, 'workspace', 'notes.md' ) ) ).toBe( true );
		expect( await read( path.join( site, 'readme.txt' ) ) ).toBe( true );
		expect( await read( path.join( parent, 'elsewhere.txt' ) ) ).toBe( false );
	} );
} );
