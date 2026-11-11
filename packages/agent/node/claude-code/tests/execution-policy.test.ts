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
import { CLAUDE_EXECUTION_POLICY_REVISION } from '../execution-policy';
import {
	CLAUDE_ACCOUNT_RECHECK_MS,
	CLAUDE_APPROVAL_TIMEOUT_MS,
	CLAUDE_ENABLED_TOOLS,
	CLAUDE_HOOK_TIMEOUT_SECONDS,
	CLAUDE_NATIVE_TOOL_RULES,
	CLAUDE_NAVIGATION_CONFINEMENT,
	CLAUDE_NAVIGATION_RULE_REVISION,
	CLAUDE_SHELL_CONFINEMENT,
	CLAUDE_STUDIO_TOOL_RULES,
	claudeNativeTools,
	claudeStudioTools,
	claudeToolInventory,
	isLocalHostname,
	normalizeHostname,
	requiresClaudeApproval,
} from '../execution-rules';
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

const targetOrigin = new URL( fakeSite.url ).origin;
// Everything a browser-layer guard must guarantee before a tool may open a URL.
const guarantees = [
	'checksEveryRequest',
	'checksEveryRedirect',
	'appliesOriginRule',
	'checksResolvedAddresses',
	'pinsCheckedAddress',
	'failsClosed',
] as const;
const completeGuard = ( origin: string | null ) => ( {
	ruleRevision: CLAUDE_NAVIGATION_RULE_REVISION,
	targetOrigin: origin,
	...Object.fromEntries( guarantees.map( ( key ) => [ key, true ] ) ),
} );
const guarded = ( origin: string | null ) =>
	( { mode: 'guarded', guard: completeGuard( origin ) } ) as never;

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
			shellConfinement: { mode: 'approval-only' },
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

describe( 'Claude Studio tools that act outside the host', () => {
	const enabledTools = {
		native: [],
		studio: [
			'scaffold_theme',
			'validate_blocks',
			'generate_images',
			'site_info',
			'take_screenshot',
		],
	};

	it( 'names what each tool with a site or path argument reaches', () => {
		for ( const definition of studioToolDefinitions ) {
			const { properties } = definition.parameters as { properties: Record< string, unknown > };
			if ( 'nameOrPath' in properties )
				expect(
					CLAUDE_STUDIO_TOOL_RULES.get( definition.name )?.site,
					definition.name
				).toBeDefined();
		}
		for ( const name of [ 'validate_blocks', 'generate_images', 'take_screenshot' ] )
			expect( CLAUDE_STUDIO_TOOL_RULES.get( name )?.paths, name ).toBeDefined();
	} );

	it( 'binds them to the target site and names that site and path in the approval', async () => {
		const { policy, host, context, site, other } = await setup( () => ( {
			enabledTools,
			navigationConfinement: guarded( targetOrigin ),
		} ) );
		const call = ( name: string, args: Record< string, unknown > ) =>
			policy.authorizeStudioCall( { host, name, args, toolCallId: randomUUID() } );
		expect( await call( 'scaffold_theme', { nameOrPath: 'site', name: 'Theme' } ) ).toBe( true );
		expect( await call( 'scaffold_theme', { nameOrPath: 'other', name: 'Theme' } ) ).toBe( false );
		expect( await call( 'scaffold_theme', { name: 'Theme' } ) ).toBe( false );
		expect( await call( 'site_info', { nameOrPath: other } ) ).toBe( false );
		expect( context.approve ).not.toHaveBeenCalled();
		expect(
			await call( 'validate_blocks', { nameOrPath: 'site', filePath: 'templates/index.html' } )
		).toBe( true );
		expect( vi.mocked( context.approve ).mock.calls[ 0 ][ 0 ].operation ).toMatchObject( {
			tool: 'validate_blocks',
			siteId: fakeSite.id,
			localPaths: [ path.join( site, 'templates', 'index.html' ) ],
		} );
		expect(
			await call( 'validate_blocks', { nameOrPath: 'site', filePath: '../other/index.html' } )
		).toBe( false );
		const image = ( file: string ) => ( { images: [ { path: file, subject: 'Hero' } ] } );
		expect( await call( 'generate_images', image( path.join( site, 'hero.png' ) ) ) ).toBe( true );
		expect( await call( 'generate_images', image( path.join( other, 'hero.png' ) ) ) ).toBe(
			false
		);
		expect( await call( 'generate_images', image( 'hero.png' ) ) ).toBe( false );
		expect(
			await call( 'take_screenshot', {
				url: 'http://localhost:8888',
				themeScreenshot: path.join( other, 'wp-content', 'themes', 'theme' ),
			} )
		).toBe( false );
		expect( await call( 'take_screenshot', { url: 'http://localhost:8888' } ) ).toBe( true );
		expect( context.approve ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'binds them to no site in a global conversation', async () => {
		const { policy, host, site } = await setup( ( paths ) => ( {
			target: { environment: 'global' },
			targetSite: undefined,
			workspace: { siteId: null, workingDirectory: paths.parent, configDirectory: paths.config },
			enabledTools,
		} ) );
		const call = ( name: string, args: Record< string, unknown > ) =>
			policy.authorizeStudioCall( { host, name, args, toolCallId: randomUUID() } );
		expect( await call( 'scaffold_theme', { nameOrPath: 'site', name: 'Theme' } ) ).toBe( false );
		expect(
			await call( 'generate_images', {
				images: [ { path: path.join( site, 'a.png' ), subject: 'A' } ],
			} )
		).toBe( false );
	} );

	it( 'lets the host resolve only the target site', async () => {
		const { policy, host, site, other } = await setup();
		const guarded = policy.guardHost( host, 'call' );
		await expect( guarded.sites.resolve( 'site' ) ).resolves.toMatchObject( { id: fakeSite.id } );
		await expect( guarded.sites.resolve( 'other' ) ).rejects.toThrow();
		await expect( guarded.sites.findByFolder( other ) ).rejects.toThrow();
		await expect( guarded.sites.findByFolder( site ) ).resolves.toMatchObject( {
			id: fakeSite.id,
		} );
		await expect(
			guarded.sites.findByFolder( path.join( site, 'nowhere' ) )
		).resolves.toBeUndefined();
	} );
} );

describe( 'Claude WordPress.com requests', () => {
	it( 'matches absolute site paths to a site and allows only listed account reads', () => {
		const remote = CLAUDE_STUDIO_TOOL_RULES.get( 'wpcom_request' )!.remote!;
		expect( remote( { siteId: 1, method: 'GET', path: '/posts' } ) ).toEqual( { wpcomSiteId: 1 } );
		expect( remote( { siteId: 1, method: 'GET', path: '!/sites/99/posts' } ) ).toEqual( {
			wpcomSiteId: 99,
		} );
		expect( remote( { siteId: 1, method: 'GET', path: '!/me' } ) ).toEqual( {} );
		expect( remote( { siteId: 1, method: 'GET', path: '!/plans/features' } ) ).toEqual( {} );
		for ( const args of [
			{ method: 'POST', path: '!/me' },
			{ method: 'GET', path: '!/me/settings' },
			{ method: 'GET', path: '!/read/following' },
			{ method: 'GET', path: '!/sites/example.wordpress.com/posts' },
			{ method: 'GET', path: '!/sites/99/../100/posts' },
			{ method: 'GET', path: '/../../sites/100/posts' },
			{ method: 'GET', path: '/posts/%2e%2e/%2E%2E/sites/100' },
			{ method: 'GET', path: '/posts?context=edit' },
			{ method: 'GET', path: '/.\t./100/posts' },
			{ method: 'GET', path: '/.\n./100/posts' },
			{ method: 'GET', path: '/.\r./100/posts' },
			{ method: 'GET', path: '!/sites/1/.\t./100/posts' },
			{ method: 'GET', path: '!/sites/1/../100/posts' },
			{ method: 'GET', path: '/..%2f100/posts' },
			{ method: 'GET', path: '/.%09./100/posts' },
			{ method: 'GET', path: '/%252e%252e/100/posts' },
			{ method: 'GET', path: '/\uff0e\uff0e/100/posts' },
			{ method: 'GET', path: '!/sites/0100/posts' },
			{ method: 'GET', path: '!sites/100/posts' },
		] )
			expect( remote( { siteId: 1, ...args } ), args.path ).toBeUndefined();
	} );

	it( 'lets a WordPress.com request reach only the live target', async () => {
		const enabledTools = { native: [], studio: [ 'wpcom_request' ] };
		const live = await setup( () => ( {
			target: { environment: 'live', siteId: fakeSite.id, wpcomSiteId: 42 },
			enabledTools,
		} ) );
		const call = ( fixture: typeof live, args: Record< string, unknown > ) =>
			fixture.policy.authorizeStudioCall( {
				host: fixture.host,
				name: 'wpcom_request',
				args,
				toolCallId: randomUUID(),
			} );
		expect( await call( live, { siteId: 42, method: 'GET', path: '/posts' } ) ).toBe( true );
		expect( await call( live, { siteId: 42, method: 'GET', path: '!/sites/42/posts' } ) ).toBe(
			true
		);
		expect( await call( live, { siteId: 7, method: 'GET', path: '/posts' } ) ).toBe( false );
		expect( await call( live, { siteId: 42, method: 'GET', path: '!/sites/7/posts' } ) ).toBe(
			false
		);
		expect( live.context.approve ).not.toHaveBeenCalled();
		expect( await call( live, { siteId: 42, method: 'POST', path: '/posts' } ) ).toBe( true );
		expect( await call( live, { siteId: 42, method: 'DELETE', path: '!/sites/7/posts/1' } ) ).toBe(
			false
		);
		expect( live.context.approve ).toHaveBeenCalledOnce();
		expect(
			await live.policy.authorizeStudioCall( {
				host: live.host,
				name: 'wp_cli',
				args: {},
				toolCallId: 'call',
			} )
		).toBe( false );

		const local = await setup( () => ( { enabledTools } ) );
		expect( await call( local, { siteId: 42, method: 'GET', path: '/posts' } ) ).toBe( false );
		const global = await setup( ( paths ) => ( {
			target: { environment: 'global' },
			targetSite: undefined,
			workspace: { siteId: null, workingDirectory: paths.parent, configDirectory: paths.config },
			enabledTools,
		} ) );
		expect( await call( global, { siteId: 42, method: 'GET', path: '!/sites/42/posts' } ) ).toBe(
			false
		);
		expect( await call( global, { siteId: 42, method: 'GET', path: '!/me' } ) ).toBe( true );
	} );
} );

describe( 'Claude native search tools', () => {
	it( 'keeps Glob and Grep patterns inside the target folders', async () => {
		const { policy, site } = await setup( () => ( {
			enabledTools: { native: [ 'Glob', 'Grep' ], studio: [] },
		} ) );
		const use = ( toolName: string, input: Record< string, unknown > ) =>
			policy.authorizeToolUse( { toolName, input, toolUseId: randomUUID() } );
		expect( await use( 'Glob', { pattern: '**/*.php' } ) ).toBe( true );
		expect( await use( 'Glob', { pattern: '**/*.php', path: site } ) ).toBe( true );
		expect( await use( 'Grep', { pattern: 'add_action', glob: '*.php' } ) ).toBe( true );
		expect( await use( 'Glob', { pattern: 'wp-content/**/*.{php,css}' } ) ).toBe( true );
		const outside: Array< [ string, Record< string, unknown > ] > = [
			[ 'Glob', { pattern: '../**' } ],
			[ 'Glob', { pattern: 'wp-content/../../**' } ],
			[ 'Glob', { pattern: '{..,x}/**' } ],
			[ 'Glob', { pattern: '{/etc,x}/**' } ],
			[ 'Glob', { pattern: '{C:/Users,x}/**' } ],
			[ 'Glob', { pattern: '@(/etc)/**' } ],
			[ 'Glob', { pattern: '{C:\\Users,x}/**' } ],
			[ 'Glob', { pattern: '{\\\\server\\share,x}/**' } ],
			[ 'Glob', { pattern: 'a{b,{x,/etc}}/**' } ],
			[ 'Glob', { pattern: '+(x|/etc)/**' } ],
			[ 'Glob', { pattern: '{x,~/.ssh}/**' } ],
			[ 'Glob', { pattern: '[/]etc/**' } ],
			[ 'Glob', { pattern: '{x),/etc}/**' } ],
			[ 'Glob', { pattern: '@(x}|/etc)/**' } ],
			[ 'Glob', { pattern: '{x\\},/etc}/**' } ],
			[ 'Glob', { pattern: '.{.,x}/**' } ],
			[ 'Grep', { pattern: 'x', glob: '{x),/etc}/**' } ],
			[ 'Glob', { pattern: path.join( site, '**' ) } ],
			[ 'Glob', { pattern: '/etc/**' } ],
			[ 'Glob', { pattern: '~/**' } ],
			[ 'Glob', { pattern: '**', path: '..' } ],
			[ 'Grep', { pattern: 'x', glob: '../**' } ],
			[ 'Grep', { pattern: 'x', glob: 'C:/**' } ],
			[ 'Grep', { pattern: 'x', path: path.join( site, '..' ) } ],
		];
		for ( const [ toolName, input ] of outside )
			expect( await use( toolName, input ), JSON.stringify( input ) ).toBe( false );
	} );
} );

describe( 'Claude shell confinement', () => {
	const shell = { native: [ 'Read', 'Bash' ], studio: [] };
	const echo = ( toolUseId?: string ) => ( {
		toolName: 'Bash',
		input: { command: 'echo hi' },
		toolUseId,
	} );

	const confinedSandbox = {
		enabled: true,
		allowUnsandboxedCommands: false,
		autoAllowBashIfSandboxed: false,
	};

	it( 'keeps shell tools disabled unless the turn declares a confinement the policy can verify', async () => {
		expect( CLAUDE_SHELL_CONFINEMENT ).toEqual( { mode: 'none' } );
		const unconfined = await setup( () => ( { enabledTools: shell } ) );
		const workspace = unconfined.site;
		expect(
			claudeNativeTools( CLAUDE_ENABLED_TOOLS, CLAUDE_SHELL_CONFINEMENT, workspace )
		).toEqual( [ 'Read' ] );
		expect( claudeNativeTools( shell, { mode: 'none' }, workspace ) ).toEqual( [ 'Read' ] );
		expect( await unconfined.policy.authorizeToolUse( echo( 'use' ) ) ).toBe( false );
		expect( unconfined.context.approve ).not.toHaveBeenCalled();
		for ( const sandbox of [
			undefined,
			{ enabled: false },
			{ enabled: true },
			{ enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: false },
			{ enabled: true, allowUnsandboxedCommands: false },
			{ ...confinedSandbox, autoAllowBashIfSandboxed: true },
			{ ...confinedSandbox, allowUnsandboxedCommands: true },
			{ ...confinedSandbox, failIfUnavailable: false },
			{ ...confinedSandbox, excludedCommands: [ '*' ] },
			{ ...confinedSandbox, excludedCommands: [] },
			{ ...confinedSandbox, allowNestedUserNamespaces: true },
			{ ...confinedSandbox, allowAppleEvents: true },
			{ ...confinedSandbox, enableWeakerNestedSandbox: true },
			{ ...confinedSandbox, enableWeakerNetworkIsolation: true },
			{ ...confinedSandbox, ignoreViolations: { file: [ '*' ] } },
			{ ...confinedSandbox, bwrapPath: '/tmp/bwrap' },
			{ ...confinedSandbox, ripgrep: { command: '/tmp/rg' } },
			{ ...confinedSandbox, network: { allowLocalBinding: true } },
			{ ...confinedSandbox, credentials: {} },
			{ ...confinedSandbox, unknownSetting: true },
			{ ...confinedSandbox, filesystem: { disabled: true } },
			{ ...confinedSandbox, filesystem: { allowRead: [ '/' ] } },
			{ ...confinedSandbox, filesystem: { allowWrite: [ path.dirname( workspace ) ] } },
			{ ...confinedSandbox, filesystem: { allowWrite: [ 'relative' ] } },
		] ) {
			const declared = { mode: 'sandbox' as const, sandbox };
			expect( claudeNativeTools( shell, declared, workspace ), JSON.stringify( sandbox ) ).toEqual(
				[ 'Read' ]
			);
			const unconfigured = await setup( () => ( {
				enabledTools: shell,
				shellConfinement: declared,
			} ) );
			expect( await unconfigured.policy.authorizeToolUse( echo( 'use' ) ) ).toBe( false );
			expect( unconfigured.context.approve ).not.toHaveBeenCalled();
		}
		const confined = await setup( ( paths ) => ( {
			enabledTools: shell,
			shellConfinement: {
				mode: 'sandbox',
				sandbox: {
					...confinedSandbox,
					failIfUnavailable: true,
					filesystem: { allowWrite: [ paths.site ], denyRead: [ paths.config ] },
				},
			},
		} ) );
		expect( claudeNativeTools( shell, confined.context.shellConfinement, confined.site ) ).toEqual(
			[ 'Read', 'Bash' ]
		);
		expect( await confined.policy.authorizeToolUse( echo( 'use' ) ) ).toBe( true );
		expect( confined.context.approve ).toHaveBeenCalledOnce();
		expect(
			vi.mocked( confined.context.approve ).mock.calls[ 0 ][ 0 ].operation.description
		).toMatch( /in a sandbox that can write only in the workspace/ );
	} );

	it( 'in approval-only mode asks for every command, says it is unconfined, and never reuses an answer', async () => {
		const { policy, context, events } = await setup( () => ( {
			enabledTools: shell,
			shellConfinement: { mode: 'approval-only' },
		} ) );
		expect( await policy.authorizeToolUse( echo( 'use-1' ) ) ).toBe( true );
		expect( await policy.authorizeToolUse( echo( 'use-1' ) ) ).toBe( false );
		expect( await policy.authorizeToolUse( echo( 'use-2' ) ) ).toBe( true );
		expect( await policy.authorizeToolUse( echo() ) ).toBe( false );
		expect( context.approve ).toHaveBeenCalledTimes( 2 );
		expect( vi.mocked( context.approve ).mock.calls[ 0 ][ 0 ].operation.description ).toMatch(
			/not confined to the workspace/
		);
		expect( events[ 0 ] ).toMatchObject( {
			type: 'approval.requested',
			description: expect.stringMatching( /not confined to the workspace/ ),
		} );
	} );
} );

describe( 'Claude approvals that outlive their caller', () => {
	it( 'keeps every approval shorter than the hook that waits for it', () => {
		expect( CLAUDE_HOOK_TIMEOUT_SECONDS * 1000 ).toBeGreaterThanOrEqual(
			CLAUDE_APPROVAL_TIMEOUT_MS + 30_000
		);
	} );

	it( 'denies when the hook is cancelled, and the permission request cannot ask again for that tool use', async () => {
		let approvalSignal: AbortSignal | undefined;
		const { policy, context, site } = await setup( () => ( {
			enabledTools: { native: [ 'Read', 'Bash' ], studio: [] },
			shellConfinement: { mode: 'approval-only' },
			approvalTimeoutMs: 60_000,
			approve: vi.fn( ( _request, signal: AbortSignal ) => {
				approvalSignal = signal;
				return new Promise< 'allow' >( () => {} );
			} ),
		} ) );
		const hook = new AbortController();
		const use = { toolName: 'Bash', input: { command: 'echo hi' }, toolUseId: 'use' };
		const pending = policy.authorizeToolUse( use, hook.signal );
		await vi.waitFor( () => expect( approvalSignal ).toBeDefined() );
		hook.abort();
		await expect( pending ).resolves.toBe( false );
		expect( approvalSignal!.aborted ).toBe( true );
		expect( await policy.authorizeToolUse( use, new AbortController().signal ) ).toBe( false );
		expect( context.approve ).toHaveBeenCalledOnce();
		expect( policy.signal.aborted ).toBe( false );
		await writeFile( path.join( site, 'readme.txt' ), 'fixture' );
		expect(
			await policy.authorizeToolUse(
				{
					toolName: 'Read',
					input: { file_path: path.join( site, 'readme.txt' ) },
					toolUseId: 'read',
				},
				hook.signal
			)
		).toBe( false );
	} );

	it( 'cancels a Studio tool approval when its MCP call is cancelled', async () => {
		let approvalSignal: AbortSignal | undefined;
		const { policy, host, localSite } = await setup( () => ( {
			approvalTimeoutMs: 60_000,
			approve: vi.fn( ( _request, signal: AbortSignal ) => {
				approvalSignal = signal;
				return new Promise< 'allow' >( () => {} );
			} ),
		} ) );
		const call = new AbortController();
		const pending = policy
			.guardHost( host, 'call', call.signal )
			.sites.wpCli( localSite, draftArgs );
		await vi.waitFor( () => expect( approvalSignal ).toBeDefined() );
		call.abort();
		await expect( pending ).rejects.toThrow();
		expect( approvalSignal!.aborted ).toBe( true );
		expect( host.sites.wpCli ).not.toHaveBeenCalled();
		expect( policy.signal.aborted ).toBe( false );
	} );
} );

describe( 'Claude account changes', () => {
	it( 'asks for nothing and runs nothing once the native account changed', async () => {
		const before = await setup();
		vi.mocked( before.context.verifyAccount ).mockResolvedValue( 'changed' );
		await expect(
			before.policy.guardHost( before.host, 'call' ).sites.wpCli( before.localSite, draftArgs )
		).rejects.toThrow();
		expect( before.context.approve ).not.toHaveBeenCalled();
		expect( before.policy.signal.aborted ).toBe( true );

		const during = await setup();
		vi.mocked( during.context.approve ).mockImplementationOnce( async () => {
			vi.mocked( during.context.verifyAccount ).mockResolvedValue( 'changed' );
			return 'allow';
		} );
		await expect(
			during.policy.guardHost( during.host, 'call' ).sites.wpCli( during.localSite, draftArgs )
		).rejects.toThrow();
		expect( during.host.sites.wpCli ).not.toHaveBeenCalled();
		expect( during.policy.signal.aborted ).toBe( true );
	} );
} );

describe( 'Claude Studio tools that reach a site by URL', () => {
	const enabledTools = {
		native: [],
		studio: [
			'take_screenshot',
			'inspect_design',
			'open_annotation_browser',
			'need_for_speed',
			'rank_me_up',
		],
	};

	it( 'names the URL each tool with a URL or site path reaches, and gates it on a navigation guard', () => {
		for ( const definition of studioToolDefinitions ) {
			const { properties } = definition.parameters as { properties: Record< string, unknown > };
			if ( 'url' in properties || ( 'path' in properties && 'nameOrPath' in properties ) )
				expect(
					CLAUDE_STUDIO_TOOL_RULES.get( definition.name )?.urls,
					definition.name
				).toBeDefined();
		}
		for ( const [ name, rule ] of CLAUDE_STUDIO_TOOL_RULES )
			expect( rule.navigates === true, name ).toBe( enabledTools.studio.includes( name ) );
		for ( const name of enabledTools.studio )
			expect( CLAUDE_STUDIO_TOOL_RULES.get( name )?.urls, name ).toBeDefined();
	} );

	it( 'keeps browser tools disabled unless the turn declares a navigation guard the policy can verify', async () => {
		expect( CLAUDE_NAVIGATION_CONFINEMENT ).toEqual( { mode: 'none' } );
		const withWpCli = { native: [ 'Read' ], studio: [ ...enabledTools.studio, 'wp_cli' ] };
		const complete = completeGuard( targetOrigin );
		const incomplete: unknown[] = [
			{ mode: 'none' },
			{ mode: 'guarded', guard: undefined },
			{ mode: 'guarded', guard: null },
			{ mode: 'guarded', guard: 'verified' },
			{ mode: 'guarded', guard: [ complete ] },
			{ mode: 'unknown', guard: complete },
			...guarantees.flatMap( ( key ) => {
				const { [ key ]: _omitted, ...missing } = complete as Record< string, unknown >;
				return [
					{ mode: 'guarded', guard: missing },
					{ mode: 'guarded', guard: { ...complete, [ key ]: false } },
					{ mode: 'guarded', guard: { ...complete, [ key ]: 'true' } },
					{ mode: 'guarded', guard: { ...complete, [ key ]: 1 } },
				];
			} ),
			{ mode: 'guarded', guard: { ...complete, ruleRevision: undefined } },
			{
				mode: 'guarded',
				guard: { ...complete, ruleRevision: CLAUDE_NAVIGATION_RULE_REVISION + 1 },
			},
			{ mode: 'guarded', guard: { ...complete, targetOrigin: null } },
			{ mode: 'guarded', guard: { ...complete, targetOrigin: 'http://localhost:8889' } },
			{ mode: 'guarded', guard: { ...complete, targetOrigin: `${ targetOrigin }/` } },
			{ mode: 'guarded', guard: { ...complete, allowPrivateAddresses: [ '127.0.0.1' ] } },
			{ mode: 'guarded', guard: { ...complete, exceptions: [] } },
		];
		for ( const navigationConfinement of incomplete ) {
			const label = JSON.stringify( navigationConfinement );
			expect(
				claudeStudioTools( withWpCli, navigationConfinement as never, targetOrigin ),
				label
			).toEqual( [ 'wp_cli' ] );
			expect(
				claudeToolInventory(
					withWpCli,
					{ mode: 'none' },
					'/workspace',
					navigationConfinement as never,
					targetOrigin
				),
				label
			).toEqual( [ 'Read', 'mcp__studio__wp_cli' ] );
			const { policy, host, context } = await setup( () => ( {
				enabledTools: withWpCli,
				navigationConfinement: navigationConfinement as never,
			} ) );
			for ( const name of [ 'take_screenshot', 'inspect_design', 'open_annotation_browser' ] ) {
				expect(
					await policy.authorizeStudioCall( {
						host,
						name,
						args: { url: `${ targetOrigin }/`, selectors: [ 'body' ] },
						toolCallId: randomUUID(),
					} ),
					`${ name } ${ label }`
				).toBe( false );
				expect(
					await policy.authorizeToolUse( {
						toolName: `mcp__studio__${ name }`,
						input: {},
						mcpServer: studioServer,
					} ),
					`${ name } ${ label }`
				).toBe( false );
			}
			for ( const name of [ 'need_for_speed', 'rank_me_up' ] )
				expect(
					await policy.authorizeStudioCall( {
						host,
						name,
						args: { nameOrPath: 'site' },
						toolCallId: randomUUID(),
					} ),
					`${ name } ${ label }`
				).toBe( false );
			expect( context.approve ).not.toHaveBeenCalled();
		}

		expect( claudeStudioTools( withWpCli, guarded( targetOrigin ), targetOrigin ) ).toEqual(
			withWpCli.studio
		);
		const { policy, host } = await setup( () => ( {
			enabledTools: withWpCli,
			navigationConfinement: guarded( targetOrigin ),
		} ) );
		expect(
			await policy.authorizeStudioCall( {
				host,
				name: 'take_screenshot',
				args: { url: `${ targetOrigin }/` },
				toolCallId: randomUUID(),
			} )
		).toBe( true );
		expect(
			await policy.authorizeToolUse( {
				toolName: 'mcp__studio__take_screenshot',
				input: {},
				mcpServer: studioServer,
			} )
		).toBe( true );

		// A guard bound to another target does not count for this one.
		expect( claudeStudioTools( withWpCli, guarded( targetOrigin ), null ) ).toEqual( [ 'wp_cli' ] );
		expect( claudeStudioTools( withWpCli, guarded( null ), null ) ).toEqual( withWpCli.studio );
	} );

	it( 'compares host names lowercased, punycoded and without trailing dots', async () => {
		expect( normalizeHostname( 'LocalHost..' ) ).toBe( 'localhost' );
		expect( normalizeHostname( '[::1]' ) ).toBe( '::1' );
		for ( const hostname of [
			'localhost.',
			'localhost..',
			'LOCALHOST.',
			'site.localhost.',
			'printer.local.',
			'127.0.0.1',
			'[::7f00:1]',
			'.',
		] )
			expect( isLocalHostname( hostname ), hostname ).toBe( true );
		expect( isLocalHostname( 'example.com.' ) ).toBe( false );

		const { policy, host } = await setup( () => ( {
			enabledTools,
			navigationConfinement: guarded( targetOrigin ),
		} ) );
		for ( const name of [ 'take_screenshot', 'inspect_design', 'open_annotation_browser' ] ) {
			const at = ( url: string ) =>
				policy.authorizeStudioCall( { host, name, args: { url }, toolCallId: randomUUID() } );
			for ( const url of [
				'http://localhost.:8882/',
				'http://localhost.:8888/',
				'http://localhost..:8888/',
				'http://LOCALHOST%2E:8882/',
				'http://localhost\u3002:8882/',
				'http://\uff4c\uff4f\uff43\uff41\uff4c\uff48\uff4f\uff53\uff54.:8882/',
				'http://site.localhost./',
				'http://site.localhost../',
				'http://printer.local./',
				'http://other-site.example.:8890/',
				'http://OTHER-SITE.example..:8890/',
				'http://127.0.0.1.:8882/',
				'http://[::127.0.0.1]:8882/',
				'http://./',
			] )
				expect( await at( url ), `${ name } ${ url }` ).toBe( false );
			expect( await at( 'https://example.com./' ), name ).toBe( true );
			// A public name can resolve to a local address; only the browser-layer
			// guard, which resolves it, can refuse it. Without that guard the tool is
			// not enabled at all.
			expect( await at( 'http://127.0.0.1.nip.io:8882/' ), name ).toBe( true );
		}
	} );

	it( 'allows the target site and public pages, and denies other schemes and local origins', async () => {
		const { policy, host } = await setup( () => ( {
			enabledTools,
			navigationConfinement: guarded( targetOrigin ),
		} ) );
		const call = ( name: string, args: Record< string, unknown > ) =>
			policy.authorizeStudioCall( { host, name, args, toolCallId: randomUUID() } );
		for ( const name of [ 'take_screenshot', 'inspect_design', 'open_annotation_browser' ] ) {
			const at = ( url: string ) => call( name, { url, selectors: [ 'body' ] } );
			expect( await at( 'http://localhost:8888/about' ), name ).toBe( true );
			expect( await at( 'https://example.com/' ), name ).toBe( true );
			for ( const url of [
				'file:///C:/Windows/win.ini',
				'file:///etc/passwd',
				'data:text/html,<p>x</p>',
				'javascript:alert(1)',
				'chrome://settings',
				'http://127.0.0.1:8882/',
				'http://localhost:8889/',
				'http://[::1]:8888/',
				'http://2130706433/',
				'http://192.168.1.10/',
				'http://10.0.0.5/',
				'http://172.20.0.1/',
				'http://169.254.169.254/latest/meta-data/',
				'http://[::ffff:127.0.0.1]:8888/',
				'http://[fd00::1]/',
				'http://printer.local/',
				'http://other-site.example:8890/',
				'not a url',
			] )
				expect( await at( url ), `${ name } ${ url }` ).toBe( false );
		}
	} );

	it( 'keeps a site audit on the target site whatever path it is given', async () => {
		const { policy, host } = await setup( () => ( {
			enabledTools,
			navigationConfinement: guarded( targetOrigin ),
		} ) );
		for ( const name of [ 'need_for_speed', 'rank_me_up' ] ) {
			const audit = ( auditPath?: string ) =>
				policy.authorizeStudioCall( {
					host,
					name,
					args: { nameOrPath: 'site', ...( auditPath === undefined ? {} : { path: auditPath } ) },
					toolCallId: randomUUID(),
				} );
			expect( await audit(), name ).toBe( true );
			expect( await audit( '/about' ), name ).toBe( true );
			expect( await audit( '/wp-admin/' ), name ).toBe( true );
			for ( const auditPath of [
				'@127.0.0.1:8882/',
				'//evil.example/',
				'http://evil.example/',
				'/\\evil.example',
				'\\\\evil.example',
				'about',
				'',
			] )
				expect( await audit( auditPath ), `${ name } ${ auditPath }` ).toBe( false );
		}
	} );

	it( 'reaches no local site from a global conversation', async () => {
		const { policy, host } = await setup( ( paths ) => ( {
			target: { environment: 'global' },
			targetSite: undefined,
			workspace: { siteId: null, workingDirectory: paths.parent, configDirectory: paths.config },
			enabledTools,
			navigationConfinement: guarded( null ),
		} ) );
		const at = ( url: string ) =>
			policy.authorizeStudioCall( {
				host,
				name: 'take_screenshot',
				args: { url },
				toolCallId: randomUUID(),
			} );
		expect( await at( 'http://localhost:8888/' ) ).toBe( false );
		expect( await at( 'https://example.com/' ) ).toBe( true );
	} );
} );

describe( 'Claude WordPress.com request transport options', () => {
	const remote = () => CLAUDE_STUDIO_TOOL_RULES.get( 'wpcom_request' )!.remote!;

	it( 'allows only real API namespaces and no query keys the client turns into transport options', () => {
		const get = ( extra: Record< string, unknown > ) =>
			remote()( { siteId: 42, method: 'GET', path: '/posts', ...extra } );
		for ( const apiNamespace of [ undefined, '', 'wp/v2', 'wpcom/v2' ] )
			expect( get( { apiNamespace } ), String( apiNamespace ) ).toEqual( { wpcomSiteId: 42 } );
		expect( get( { query: { per_page: 20, _fields: 'id,title' } } ) ).toEqual( {
			wpcomSiteId: 42,
		} );
		for ( const extra of [
			{ apiNamespace: 'wp/v2/sites/7/posts#' },
			{ apiNamespace: 'wp/v2/sites/7/posts?x=' },
			{ apiNamespace: 'rest/v1.1/sites/7/posts#' },
			{ apiNamespace: 'wpcom/v3' },
			{ apiNamespace: 'wp/v2/' },
			{ apiNamespace: 7 },
			{ query: { proxyOrigin: 'http://127.0.0.1:9' } },
			{ query: { apiVersion: '1.1/sites/7' } },
			{ query: { apiNamespace: 'wp/v2' } },
			{ query: { _method: 'POST' } },
			{ query: { method: 'DELETE' } },
			{ query: 'per_page=20' },
		] )
			expect( get( extra ), JSON.stringify( extra ) ).toBeUndefined();
		expect(
			remote()( {
				siteId: 1,
				method: 'GET',
				path: '!/me',
				apiNamespace: 'rest/v1.1/sites/7/posts#',
			} )
		).toBeUndefined();
	} );
} );

describe( 'Claude account checks during a turn', () => {
	it( 'verifies the account before an unprompted operation once the last check is older than the bound', async () => {
		const { policy, site, context, clock } = await setup();
		await writeFile( path.join( site, 'readme.txt' ), 'fixture' );
		const read = () =>
			policy.authorizeToolUse( {
				toolName: 'Read',
				input: { file_path: path.join( site, 'readme.txt' ) },
				toolUseId: randomUUID(),
			} );
		clock.now = CLAUDE_ACCOUNT_RECHECK_MS - 1;
		expect( await read() ).toBe( true );
		expect( context.verifyAccount ).not.toHaveBeenCalled();
		clock.now = CLAUDE_ACCOUNT_RECHECK_MS;
		expect( await read() ).toBe( true );
		expect( context.verifyAccount ).toHaveBeenCalledOnce();
		clock.now = CLAUDE_ACCOUNT_RECHECK_MS * 2 - 1;
		expect( await read() ).toBe( true );
		expect( context.verifyAccount ).toHaveBeenCalledOnce();
		clock.now = CLAUDE_ACCOUNT_RECHECK_MS * 2;
		vi.mocked( context.verifyAccount ).mockResolvedValueOnce( 'changed' );
		expect( await read() ).toBe( false );
		expect( policy.signal.aborted ).toBe( true );

		const unverified = await setup();
		await writeFile( path.join( unverified.site, 'readme.txt' ), 'fixture' );
		unverified.clock.now = CLAUDE_ACCOUNT_RECHECK_MS;
		vi.mocked( unverified.context.verifyAccount ).mockResolvedValueOnce( 'unverified' );
		expect(
			await unverified.policy.authorizeToolUse( {
				toolName: 'Read',
				input: { file_path: path.join( unverified.site, 'readme.txt' ) },
				toolUseId: 'use',
			} )
		).toBe( false );
	} );

	it( 'ends a pending approval when a periodic check finds another account', async () => {
		let approvalSignal: AbortSignal | undefined;
		const { policy, host, localSite, context, clock } = await setup( () => ( {
			approvalTimeoutMs: 60_000,
			approve: vi.fn( ( _request, signal: AbortSignal ) => {
				approvalSignal = signal;
				return new Promise< 'allow' >( () => {} );
			} ),
		} ) );
		const pending = policy.guardHost( host, 'call' ).sites.wpCli( localSite, draftArgs );
		await vi.waitFor( () => expect( approvalSignal ).toBeDefined() );
		expect( await policy.refreshAccount() ).toBe( true );
		clock.now = CLAUDE_ACCOUNT_RECHECK_MS;
		vi.mocked( context.verifyAccount ).mockResolvedValue( 'changed' );
		expect( await policy.refreshAccount() ).toBe( false );
		await expect( pending ).rejects.toThrow();
		expect( approvalSignal!.aborted ).toBe( true );
		expect( host.sites.wpCli ).not.toHaveBeenCalled();
	} );
} );
