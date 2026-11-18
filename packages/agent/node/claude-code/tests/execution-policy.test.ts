import { randomUUID } from 'crypto';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESIGN_SYSTEM_PREVIEW_PATH } from '@studio/agent/protocol/chat-artifacts';
import {
	getClaudeApprovalDisplayArgs,
	resolveClaudeSession,
} from '@studio/agent/protocol/claude-code';
import { getCreatedSiteFromArtifact } from '../../sessions/placement';
import { fakeSite } from '../../tests/fake-host';
import { studioToolDefinitions } from '../../tools';
import { createAskUserQuestionTool } from '../../tools/ask-user-question';
import { createPresentDesignOptionsTool } from '../../tools/present-design-options';
import { createSkillTool } from '../../tools/skill';
import { createClaudeDirectoryListing } from '../directory-listing';
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
	isVerifiedNavigationGuard,
	isVerifiedShellConfinement,
	normalizeHostname,
	requiresClaudeApproval,
} from '../execution-rules';
import { createNativeSessionStore } from '../sessions';
import {
	Declared,
	admitWpCliRead,
	completeGuard,
	createPolicyFixture,
	guarded,
	inherit,
	targetOrigin,
	unverifiableNavigation,
	withAccessor,
	withHidden,
} from './fixtures/execution-policy';
import type { ClaudeOperation } from '../execution-policy';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { ClaudeOperationClass } from '@studio/agent/protocol/claude-code';

// The connections Studio keeps: the target site is connected to
// `fakeRemoteSite`, in a store that lies outside every folder a turn reaches.
vi.mock( '@studio/common/lib/connected-sites', async () => {
	const { fakeRemoteSite } = await import( '../../tests/fake-host' );
	return { getConnectedWpcomSitesForLocalSite: vi.fn( async () => [ fakeRemoteSite ] ) };
} );
// The user id of the stored WordPress.com login those connections are kept under.
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
async function setup( ...args: Parameters< typeof createPolicyFixture > ) {
	const fixture = await createPolicyFixture( ...args );
	cleanups.push( fixture.cleanup );
	return fixture;
}

const draftArgs = [ 'post', 'create', '--post_status=draft', '--post_title=Hello' ];
const deleteArgs = [ 'post', 'delete', '1' ];
async function setupWpCli( ...args: Parameters< typeof createPolicyFixture > ) {
	const fixture = await setup( ...args );
	await admitWpCliRead( fixture.policy, fixture.host );
	return fixture;
}
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
		const names = new Set( [
			...definitions.map( ( definition ) => definition.name ),
			createClaudeDirectoryListing().name,
		] );
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
		expect( CLAUDE_ENABLED_TOOLS.native ).toEqual( [
			'Read',
			'Grep',
			'Glob',
			'Write',
			'Edit',
			'Bash',
		] );
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
			[ 'Write', { file_path: path.join( site, '.env' ), content: 'changed' } ],
			[ 'Bash', { command: 'echo hi' } ],
			[ 'WebFetch', { url: 'https://example.com' } ],
			[ 'Task', { prompt: 'anything' } ],
			[ 'mcp__studio__wp_cli', {}, { name: 'studio', source: 'project' } ],
			[ 'mcp__studio__wp_cli', {} ],
			[ 'mcp__studio__pick_design', {}, studioServer ],
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
		const cwd = context.workspace.workingDirectory;
		expect(
			await policy.authorizeToolUse( { toolName: 'Bash', input, toolUseId: 'use-1', cwd } )
		).toBe( true );
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
		for ( const [ index, unbounded ] of [
			{ command: 'echo hi', run_in_background: true },
			{ command: 'echo hi', timeout: 60 * 60 * 1000 },
			{ command: 'echo hi', dangerouslyDisableSandbox: true },
			{ command: '   ' },
			{ command: 'echo\0hi' },
			{ command: 'echo hi', unexpected: true },
		].entries() )
			expect(
				await policy.authorizeToolUse( {
					toolName: 'Bash',
					input: unbounded,
					toolUseId: 'invalid-' + index,
					cwd,
				} )
			).toBe( false );
		expect( context.approve ).toHaveBeenCalledOnce();
		vi.mocked( context.approve ).mockResolvedValueOnce( 'deny' );
		expect(
			await policy.authorizeToolUse( { toolName: 'Bash', input, toolUseId: 'use-3', cwd } )
		).toBe( false );
	} );
} );

describe( 'Claude approvals at host execution', () => {
	it( 'approves a recovery draft once at the host after the SDK allows the tool', async () => {
		const { policy, context, host, localSite, events, site } = await setupWpCli( () => ( {
			uncertainAfterRecovery: true,
		} ) );
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
				operationClass: 'local-change',
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
		expect( ranArgs ).toEqual( [ ...draftArgs, '--skip-packages' ] );
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
				operationClass: 'local-change',
				target: { environment: 'local', siteId: fakeSite.id },
			},
			draft: { siteName: 'My Site', title: 'Hello' },
		} );
	} );

	it( 'runs recognized reads without asking and refuses other sites or a redirected command', async () => {
		const { policy, context, host, localSite } = await setupWpCli();
		const guarded = policy.guardHost( host, 'call' );
		await guarded.sites.wpCli( localSite, [ 'post', 'list' ] );
		expect( context.approve ).not.toHaveBeenCalled();
		await expect(
			guarded.sites.wpCli( localSite, [ 'post', 'list', '--url=other' ] )
		).rejects.toThrow();
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

	it( 'authorizes only the original host arguments even when the display names them', async () => {
		const { policy, events } = await setup();
		const operation: ClaudeOperation = {
			tool: 'sites.delete',
			operationClass: 'local-overwrite',
			args: [ false ],
			localPaths: [],
			description: 'Delete the site',
		};
		const first = await policy.requestApproval( operation, 'call' );
		const shown = events.find( ( event ) => event.type === 'approval.requested' );
		const displayArgs = shown && JSON.parse( shown.operation.args );
		expect( displayArgs ).toEqual( { deleteFiles: false } );
		expect(
			await policy.authorizeExecution( first!, { ...operation, args: displayArgs }, 'call' )
		).toBe( false );
		const second = await policy.requestApproval( operation, 'call' );
		expect( await policy.authorizeExecution( second!, operation, 'call' ) ).toBe( true );
	} );

	it.each( [
		{ tool: 'sites.delete', args: { deleteFiles: true } },
		{ tool: 'sites.export', args: [ 'unidentified' ] },
		{ tool: 'sites.wpCli', args: [ 'post', 1 ] },
		{ tool: 'sync.push', args: [ 'unidentified' ] },
		{ tool: 'unknown.tool', args: [ 'unidentified' ] },
		{ tool: 'constructor', args: [ 'unidentified' ] },
	] )(
		'retains existing named fields and unrecognized argument shapes for $tool',
		( { tool, args } ) => {
			expect( getClaudeApprovalDisplayArgs( tool, args ) ).toBe( args );
		}
	);

	it( 'does not run a denied deletion, expires an unanswered one and ignores its late allow', async () => {
		let release!: ( answer: 'allow' ) => void;
		const { policy, host, localSite, events, context } = await setupWpCli( () => ( {
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
		await expect( guarded.sites.wpCli( localSite, deleteArgs ) ).rejects.toThrow();
		await expect( guarded.sites.wpCli( localSite, deleteArgs ) ).rejects.toThrow();
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
		const { policy, host, localSite, context, site } = await setupWpCli();
		await writeFile( path.join( site, 'readme.txt' ), 'fixture' );
		vi.mocked( context.approve ).mockImplementationOnce( async () => {
			vi.mocked( context.verifyTarget ).mockResolvedValue( false );
			return 'allow';
		} );
		const guarded = policy.guardHost( host, 'call' );
		await expect( guarded.sites.wpCli( localSite, deleteArgs ) ).rejects.toThrow();
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
		const { policy, host, localSite, context } = await setupWpCli();
		vi.mocked( context.approve ).mockImplementationOnce( async () => {
			vi.mocked( context.stillConnected ).mockResolvedValue( false );
			return 'allow';
		} );
		await expect(
			policy.guardHost( host, 'call' ).sites.wpCli( localSite, deleteArgs )
		).rejects.toThrow();
		expect( host.sites.wpCli ).not.toHaveBeenCalled();
	} );

	it( 'invalidates a pending approval when the turn is cancelled, so a later reply cannot run it', async () => {
		let reply!: ( answer: 'allow' ) => void;
		let approvalSignal: AbortSignal | undefined;
		const { policy, host, localSite, controller, events } = await setupWpCli( () => ( {
			approvalTimeoutMs: 60_000,
			approve: vi.fn(
				( _request, signal: AbortSignal ) =>
					new Promise< 'allow' >( ( resolve ) => {
						approvalSignal = signal;
						reply = resolve;
					} )
			),
		} ) );
		const pending = policy.guardHost( host, 'call' ).sites.wpCli( localSite, deleteArgs );
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
		await guarded.sync.push( localSite, 'all', '111', () => {} );
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

	it( 'creates sites only from a global conversation, and makes no site the conversation’s site that the host does not know as the one this turn created', async () => {
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
		// Only directly in Studio's sites folder.
		await expect(
			guarded.sites.create( 'Nested', path.join( parent, 'nested', 'site' ), () => {} )
		).rejects.toThrow();
		expect( host.sites.create ).not.toHaveBeenCalled();
		const created = path.join( parent, 'new-site' );
		await guarded.sites.create( 'New site', created, () => {} );
		expect( context.verifyTarget ).toHaveBeenLastCalledWith( { environment: 'global' } );
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
		// Even the folder this turn created is refused while the host knows no
		// site by that id there (local-site-tools.test.ts selects one it does).
		await expect(
			guarded.selectSite!( { id: 'new', name: 'New site', path: created, running: true } )
		).rejects.toThrow( 'Denied' );
		expect( selectSite ).not.toHaveBeenCalled();
		// A turn creates one site, whether or not it became the conversation's site.
		policy.takeRefusals( 'call' );
		await expect(
			guarded.sites.create( 'Another', path.join( parent, 'another' ), () => {} )
		).rejects.toThrow( 'Denied' );
		expect( policy.takeRefusals( 'call' ) ).toEqual( [
			expect.stringContaining( 'Studio creates one site in a turn' ),
		] );
		expect( host.sites.create ).toHaveBeenCalledOnce();

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
			policy.authorizeToolUse( {
				toolName: 'Read',
				input: { file_path: file },
				toolUseId: randomUUID(),
			} );
		expect( await read( path.join( parent, 'workspace', 'notes.md' ) ) ).toBe( true );
		expect( await read( path.join( site, 'readme.txt' ) ) ).toBe( true );
		expect( await read( path.join( parent, 'elsewhere.txt' ) ) ).toBe( false );
	} );
} );

describe( 'Claude Studio tools that act outside the host', () => {
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

	it( 'lets the host resolve only the target site', async () => {
		const { policy, host, site, other } = await setup();
		const fenced = policy.guardHost( host, 'call' );
		await expect( fenced.sites.resolve( 'site' ) ).resolves.toMatchObject( { id: fakeSite.id } );
		await expect( fenced.sites.resolve( 'other' ) ).rejects.toThrow();
		await expect( fenced.sites.findByFolder( other ) ).rejects.toThrow();
		await expect( fenced.sites.findByFolder( site ) ).resolves.toMatchObject( {
			id: fakeSite.id,
		} );
		await expect(
			fenced.sites.findByFolder( path.join( site, 'nowhere' ) )
		).resolves.toBeUndefined();
	} );

	// The end of a call that settles normally is the bridge's to signal; its tests
	// show a host kept past any call refusing everything.
	it( 'shows nothing in the conversation once the signal it was guarded with aborts, as when the SDK cancels the call, or once the turn has ended', async () => {
		const { policy, host, controller } = await setup();
		const ui = { showArtifact: vi.fn(), reloadPreview: vi.fn() };
		host.ui = ui;
		const artifact = { version: 1, id: 'a', widgets: [] } as never;
		const call = new AbortController();
		const fenced = policy.guardHost( host, 'call', call.signal );
		expect( fenced.ui ).not.toBe( ui );
		await fenced.ui!.showArtifact( artifact );
		fenced.ui!.reloadPreview();
		expect( ui.showArtifact ).toHaveBeenCalledTimes( 1 );
		expect( ui.reloadPreview ).toHaveBeenCalledTimes( 1 );

		call.abort();
		await expect( fenced.ui!.showArtifact( artifact ) ).rejects.toThrow( 'Denied' );
		fenced.ui!.reloadPreview();
		const later = policy.guardHost( host, 'later' );
		controller.abort();
		await expect( later.ui!.showArtifact( artifact ) ).rejects.toThrow( 'Denied' );
		later.ui!.reloadPreview();
		expect( ui.showArtifact ).toHaveBeenCalledTimes( 1 );
		expect( ui.reloadPreview ).toHaveBeenCalledTimes( 1 );

		// Without an app showing the conversation there is nothing to fence.
		host.ui = undefined;
		expect( policy.guardHost( host, 'none' ).ui ).toBeUndefined();
	} );

	it( 'refuses to show anything that would bind a site conversation to a site, its own included', async () => {
		const { policy, host, site } = await setup();
		const ui = { showArtifact: vi.fn(), reloadPreview: vi.fn() };
		host.ui = ui;
		const fenced = policy.guardHost( host, 'call', new AbortController().signal );
		const artifact = ( ...widgets: Array< { type: string; widgetProps: object } > ) =>
			( { version: 1, id: randomUUID(), widgets } ) as never;
		const sitePreview = ( widgetProps: object ) => ( { type: 'site-preview', widgetProps } );
		const media = { type: 'media', widgetProps: { mediaKind: 'image' } };
		const binding = [
			artifact(
				sitePreview( {
					path: '/',
					siteId: 'new',
					siteName: 'New site',
					sitePath: path.join( site, '..', 'new-site' ),
					url: 'http://localhost:8890',
				} )
			),
			artifact(
				media,
				sitePreview( { path: '/', siteId: fakeSite.id, siteName: fakeSite.name, sitePath: site } )
			),
		];
		const unbinding = [
			artifact( media ),
			artifact( sitePreview( { path: DESIGN_SYSTEM_PREVIEW_PATH } ) ),
			artifact( sitePreview( { path: '/', siteId: fakeSite.id } ) ),
		];
		// What the run manager would bind the conversation to is exactly what is refused.
		for ( const item of binding ) {
			expect( getCreatedSiteFromArtifact( item ) ).toBeDefined();
			await expect( fenced.ui!.showArtifact( item ) ).rejects.toThrow( 'Denied' );
		}
		expect( ui.showArtifact ).not.toHaveBeenCalled();
		for ( const item of unbinding ) {
			expect( getCreatedSiteFromArtifact( item ) ).toBeUndefined();
			await fenced.ui!.showArtifact( item );
		}
		expect( ui.showArtifact ).toHaveBeenCalledTimes( unbinding.length );
	} );

	it( 'names the Studio tools the turn may run, as its selection enables them', async () => {
		const { policy } = await setup( () => ( { navigationConfinement: guarded( targetOrigin ) } ) );
		expect( policy.studioTools ).toEqual( [ ...CLAUDE_ENABLED_TOOLS.studio ] );
		const only = await setup( () => ( { enabledTools: { native: [], studio: [ 'wp_cli' ] } } ) );
		expect( only.policy.studioTools ).toEqual( [ 'wp_cli' ] );
		const disabled = await setup( () => ( { enabledTools: { native: [ 'Read' ], studio: [] } } ) );
		expect( disabled.policy.studioTools ).toEqual( [] );
	} );
} );

describe( 'Claude WordPress.com requests', () => {
	it( 'matches absolute site paths to a site and allows only listed account reads', () => {
		const remote = CLAUDE_STUDIO_TOOL_RULES.get( 'wpcom_request' )!.remote!;
		const site = ( args: Record< string, unknown > ) => remote( args )?.wpcomSiteId;
		expect( site( { siteId: 1, method: 'GET', path: '/posts' } ) ).toBe( 1 );
		expect( site( { siteId: 1, method: 'GET', path: '!/sites/99/posts' } ) ).toBe( 99 );
		expect( remote( { siteId: 1, method: 'GET', path: '!/plans/features' } ) ).toBeDefined();
		expect( site( { siteId: 1, method: 'GET', path: '!/plans/features' } ) ).toBeUndefined();
		for ( const args of [
			{ method: 'GET', path: '!/me' },
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
	const echo = ( cwd: string, toolUseId?: string ) => ( {
		toolName: 'Bash',
		input: { command: 'echo hi' },
		cwd,
		toolUseId,
	} );

	it( 'binds each shell decision to the actual starting directory, including duplicate callbacks', async () => {
		const { policy, context, site, other } = await setup( () => ( {
			enabledTools: shell,
			shellConfinement: { mode: 'approval-only' },
		} ) );
		expect( await policy.authorizeToolUse( { ...echo( site, 'missing' ), cwd: undefined } ) ).toBe(
			false
		);
		expect( await policy.authorizeToolUse( echo( other, 'other' ) ) ).toBe( false );
		expect( await policy.authorizeToolUse( echo( site, 'one' ) ) ).toBe( true );
		expect( await policy.authorizeToolUse( echo( other, 'one' ) ) ).toBe( false );
		expect( context.approve ).toHaveBeenCalledOnce();
		expect( vi.mocked( context.approve ).mock.calls[ 0 ][ 0 ].operation.localPaths ).toEqual( [
			site,
		] );
	} );

	it( 'checks the shared UTF-8 byte limit before asking for a command', async () => {
		const { policy, context, site } = await setup( () => ( {
			enabledTools: shell,
			shellConfinement: { mode: 'approval-only' },
		} ) );
		const command = 'é'.repeat( 4096 );
		const use = echo( site, 'fits' );
		expect( await policy.authorizeToolUse( { ...use, input: { command } } ) ).toBe( true );
		const tooLong = await policy.decideToolUse( {
			...use,
			toolUseId: 'large',
			input: { command: command + 'a' },
		} );
		expect( tooLong ).toMatchObject( {
			allowed: false,
			reason: expect.stringContaining( '8192 bytes' ),
		} );
		expect( context.approve ).toHaveBeenCalledOnce();
	} );

	const confinedSandbox = {
		enabled: true,
		failIfUnavailable: true,
		network: { strictAllowlist: true, allowedDomains: [] },
		allowUnsandboxedCommands: false,
		autoAllowBashIfSandboxed: false,
	};

	it( 'keeps shell tools disabled unless the turn declares a confinement the policy can verify', async () => {
		expect( CLAUDE_SHELL_CONFINEMENT ).toEqual( { mode: 'none' } );
		const unconfined = await setup( () => ( { enabledTools: shell } ) );
		const workspace = unconfined.site;
		expect(
			claudeNativeTools( CLAUDE_ENABLED_TOOLS, CLAUDE_SHELL_CONFINEMENT, workspace )
		).toEqual( [ 'Read', 'Grep', 'Glob', 'Write', 'Edit' ] );
		expect( claudeNativeTools( shell, { mode: 'none' }, workspace ) ).toEqual( [ 'Read' ] );
		expect( await unconfined.policy.authorizeToolUse( echo( workspace, 'use' ) ) ).toBe( false );
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
			{ ...confinedSandbox, failIfUnavailable: undefined },
			{ ...confinedSandbox, network: undefined },
			{
				...confinedSandbox,
				network: { strictAllowlist: true, allowedDomains: [ 'example.test' ] },
			},
			{ ...confinedSandbox, network: { strictAllowlist: false, allowedDomains: [] } },
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
			expect( await unconfigured.policy.authorizeToolUse( echo( unconfigured.site, 'use' ) ) ).toBe(
				false
			);
			expect( unconfigured.context.approve ).not.toHaveBeenCalled();
		}
		const confined = await setup( ( paths ) => ( {
			enabledTools: shell,
			localRoots: [ paths.site, paths.other ],
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
		expect( await confined.policy.authorizeToolUse( echo( confined.site, 'use' ) ) ).toBe( true );
		expect( confined.context.approve ).toHaveBeenCalledOnce();
		expect(
			vi.mocked( confined.context.approve ).mock.calls[ 0 ][ 0 ].operation.localPaths
		).toEqual( [ confined.site, confined.other ] );
		expect(
			vi.mocked( confined.context.approve ).mock.calls[ 0 ][ 0 ].operation.description
		).toMatch( /sandbox.*temporary files/ );
	} );

	it( 'refuses a sandbox whose additional working directory is redirected during approval', async () => {
		const { policy, site, journal } = await setup( ( paths ) => ( {
			enabledTools: shell,
			shellConfinement: { mode: 'sandbox', sandbox: confinedSandbox },
			localRoots: [ paths.site, paths.other ],
			approve: async () => {
				const moved = path.join( paths.parent, 'moved' );
				await rename( paths.other, moved );
				await symlink( moved, paths.other, 'junction' );
				return 'allow';
			},
		} ) );
		expect( await policy.authorizeToolUse( echo( site, 'redirected' ) ) ).toBe( false );
		expect( journal ).toHaveLength( 0 );
	} );

	it( 'verifies a shell confinement only from plain data, and never throws on a malformed one', () => {
		const workspace = path.resolve( 'workspace' );
		const inside = path.join( workspace, 'build' );
		const outside = path.dirname( workspace );
		const sandbox = { ...confinedSandbox, filesystem: { allowWrite: [ inside ] } };
		const confined = ( settings: unknown ) => ( { mode: 'sandbox', sandbox: settings } );
		const writes = ( allowWrite: unknown ) =>
			confined( { ...confinedSandbox, filesystem: { allowWrite } } );
		let reads = 0;
		for ( const declared of [
			{ mode: 'approval-only' },
			confined( sandbox ),
			confined( { ...confinedSandbox, filesystem: { allowRead: [ workspace ] } } ),
			confined( Object.freeze( sandbox ) ),
			Object.assign( Object.create( null ), { mode: 'approval-only' } ),
		] )
			expect( isVerifiedShellConfinement( declared as never, workspace ) ).toBe( true );
		const rejected: Array< [ string, unknown ] > = [
			[ 'null', null ],
			[ 'undefined', undefined ],
			[ 'a string', 'approval-only' ],
			[ 'an array', [ 'approval-only' ] ],
			[ 'a Map', new Map( [ [ 'mode', 'approval-only' ] ] ) ],
			[ 'a class instance', new Declared( { mode: 'approval-only' } ) ],
			[ 'a proxy', new Proxy( { mode: 'approval-only' }, {} ) ],
			[ 'an inherited mode', inherit( { mode: 'approval-only' } ) ],
			[ 'an accessor mode', withAccessor( {}, 'mode', () => 'approval-only' ) ],
			[ 'approval-only with a setting', { mode: 'approval-only', sandbox: { enabled: false } } ],
			[ 'approval-only with a hidden key', withHidden( { mode: 'approval-only' }, 'sandbox', {} ) ],
			[ 'approval-only with a symbol key', { mode: 'approval-only', [ Symbol( 'x' ) ]: 1 } ],
			[ 'an extra top-level key', { ...confined( sandbox ), excludedCommands: [ '*' ] } ],
			[ 'a hidden top-level key', withHidden( confined( sandbox ), 'excludedCommands', [ '*' ] ) ],
			[ 'an inherited sandbox', inherit( { sandbox }, { mode: 'sandbox' } ) ],
			[ 'an accessor sandbox', withAccessor( { mode: 'sandbox' }, 'sandbox', () => sandbox ) ],
			[ 'inherited settings', confined( inherit( sandbox ) ) ],
			[
				'an inherited setting',
				confined(
					inherit(
						{ enabled: true },
						{ allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false }
					)
				),
			],
			[
				'an accessor setting',
				confined(
					withAccessor(
						{ allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false },
						'enabled',
						() => true
					)
				),
			],
			[ 'a hidden setting', confined( withHidden( sandbox, 'excludedCommands', [ '*' ] ) ) ],
			[ 'a symbol setting', confined( { ...sandbox, [ Symbol( 'excludedCommands' ) ]: [ '*' ] } ) ],
			[ 'settings as a class instance', confined( new Declared( sandbox ) ) ],
			[ 'settings as a proxy', confined( new Proxy( { ...sandbox }, {} ) ) ],
			[ 'settings as an array', confined( [ sandbox ] ) ],
			[ 'a null filesystem', confined( { ...confinedSandbox, filesystem: null } ) ],
			[ 'a filesystem as an array', confined( { ...confinedSandbox, filesystem: [] } ) ],
			[
				'an inherited filesystem',
				confined( { ...confinedSandbox, filesystem: inherit( { allowWrite: [ outside ] } ) } ),
			],
			[
				'a hidden write root',
				confined( { ...confinedSandbox, filesystem: withHidden( {}, 'allowWrite', [ outside ] ) } ),
			],
			[
				'write roots that change between reads',
				confined( {
					...confinedSandbox,
					filesystem: withAccessor( {}, 'allowWrite', () =>
						reads++ === 0 ? [ inside ] : [ outside ]
					),
				} ),
			],
			[ 'write roots outside the workspace', writes( [ inside, outside ] ) ],
			[ 'write roots as a proxy', writes( new Proxy( [ inside ], {} ) ) ],
			[ 'write roots with a gap', writes( Object.assign( new Array( 2 ), { 1: inside } ) ) ],
			[
				'write roots with an extra key',
				writes( Object.assign( [ inside ], { extra: outside } ) ),
			],
			[
				'a write root behind an accessor',
				writes( Object.defineProperty( [ inside ], 0, { get: () => outside, enumerable: true } ) ),
			],
			[ 'write roots as a set', writes( new Set( [ inside ] ) ) ],
			[ 'a write root that is not a string', writes( [ { toString: () => inside } ] ) ],
		];
		for ( const [ label, declared ] of rejected ) {
			let verified: unknown;
			let tools: unknown;
			expect( () => {
				verified = isVerifiedShellConfinement( declared as never, workspace );
				tools = claudeNativeTools( shell, declared as never, workspace );
			}, label ).not.toThrow();
			expect( verified, label ).toBe( false );
			expect( tools, label ).toEqual( [ 'Read' ] );
		}
		for ( const enabled of [ null, undefined, {}, { native: 'Read' }, { native: [ 'Read', 7 ] } ] )
			expect( claudeNativeTools( enabled as never, { mode: 'approval-only' }, workspace ) ).toEqual(
				[]
			);
	} );

	it( 'in approval-only mode asks for each command use and shares its answer across callbacks', async () => {
		const { policy, context, events } = await setup( () => ( {
			enabledTools: shell,
			shellConfinement: { mode: 'approval-only' },
		} ) );
		const cwd = context.workspace.workingDirectory;
		expect( await policy.authorizeToolUse( echo( cwd, 'use-1' ) ) ).toBe( true );
		expect( await policy.authorizeToolUse( echo( cwd, 'use-1' ) ) ).toBe( true );
		expect( await policy.authorizeToolUse( echo( cwd, 'use-2' ) ) ).toBe( true );
		expect( await policy.authorizeToolUse( echo( cwd ) ) ).toBe( false );
		expect( context.approve ).toHaveBeenCalledTimes( 2 );
		expect( vi.mocked( context.approve ).mock.calls[ 0 ][ 0 ].operation.description ).toMatch(
			/can read and change files outside this workspace/
		);
		expect( events[ 0 ] ).toMatchObject( {
			type: 'approval.requested',
			description: expect.stringMatching( /can read and change files outside this workspace/ ),
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
		const use = { toolName: 'Bash', input: { command: 'echo hi' }, toolUseId: 'use', cwd: site };
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
		const { policy, host, localSite } = await setupWpCli( () => ( {
			approvalTimeoutMs: 60_000,
			approve: vi.fn( ( _request, signal: AbortSignal ) => {
				approvalSignal = signal;
				return new Promise< 'allow' >( () => {} );
			} ),
		} ) );
		const call = new AbortController();
		const pending = policy
			.guardHost( host, 'call', call.signal )
			.sites.wpCli( localSite, deleteArgs );
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
		const before = await setupWpCli();
		vi.mocked( before.context.verifyAccount ).mockResolvedValue( 'changed' );
		await expect(
			before.policy.guardHost( before.host, 'call' ).sites.wpCli( before.localSite, deleteArgs )
		).rejects.toThrow();
		expect( before.context.approve ).not.toHaveBeenCalled();
		expect( before.policy.signal.aborted ).toBe( true );

		const during = await setupWpCli();
		vi.mocked( during.context.approve ).mockImplementationOnce( async () => {
			vi.mocked( during.context.verifyAccount ).mockResolvedValue( 'changed' );
			return 'allow';
		} );
		await expect(
			during.policy.guardHost( during.host, 'call' ).sites.wpCli( during.localSite, deleteArgs )
		).rejects.toThrow();
		expect( during.host.sites.wpCli ).not.toHaveBeenCalled();
		expect( during.policy.signal.aborted ).toBe( true );
	} );
} );

describe( 'Claude Studio tools that reach a site by URL', () => {
	const browserTools = [
		'take_screenshot',
		'inspect_design',
		'open_annotation_browser',
		'need_for_speed',
		'rank_me_up',
	];

	it( 'names the URL each tool with a URL or site path reaches', () => {
		for ( const definition of studioToolDefinitions ) {
			const { properties } = definition.parameters as { properties: Record< string, unknown > };
			if ( 'url' in properties || ( 'path' in properties && 'nameOrPath' in properties ) )
				expect(
					CLAUDE_STUDIO_TOOL_RULES.get( definition.name )?.urls,
					definition.name
				).toBeDefined();
		}
	} );

	it( 'verifies a navigation guard only when it declares every guarantee, and nothing else, as plain data', () => {
		expect( CLAUDE_NAVIGATION_CONFINEMENT ).toEqual( { mode: 'none' } );
		expect( CLAUDE_NAVIGATION_RULE_REVISION ).toBe( 2 );
		for ( const origin of [ targetOrigin, null ] ) {
			expect( isVerifiedNavigationGuard( guarded( origin ), origin ), String( origin ) ).toBe(
				true
			);
			for ( const [ label, declared ] of unverifiableNavigation( origin ) ) {
				let verified: unknown;
				expect( () => {
					verified = isVerifiedNavigationGuard( declared as never, origin );
				}, label ).not.toThrow();
				expect( verified, `${ label } for ${ origin }` ).toBe( false );
			}
		}
		// A guard bound to another target does not count for this one.
		expect( isVerifiedNavigationGuard( guarded( targetOrigin ), null ) ).toBe( false );
		expect( isVerifiedNavigationGuard( guarded( null ), targetOrigin ) ).toBe( false );
		// An origin the caller does not know verifies nothing, whatever the guard says.
		for ( const origin of [ undefined, 0, false, {}, [ targetOrigin ] ] )
			expect(
				isVerifiedNavigationGuard(
					{ mode: 'guarded', guard: { ...completeGuard( null ), targetOrigin: origin } } as never,
					origin as never
				),
				String( origin )
			).toBe( false );
		// The guard of rule revision 1 states neither of the guarantees added since.
		const {
			confinesFileDocuments: _file,
			blocksUncheckedChannels: _channels,
			...revisionOne
		} = completeGuard( targetOrigin ) as Record< string, unknown >;
		expect(
			isVerifiedNavigationGuard(
				{ mode: 'guarded', guard: { ...revisionOne, ruleRevision: 1 } } as never,
				targetOrigin
			)
		).toBe( false );
		// Plain data without a prototype, or frozen, is still plain data.
		const bare = ( fields: object ) => Object.assign( Object.create( null ), fields );
		expect(
			isVerifiedNavigationGuard(
				bare( { mode: 'guarded', guard: bare( completeGuard( targetOrigin ) ) } ),
				targetOrigin
			)
		).toBe( true );
		expect(
			isVerifiedNavigationGuard(
				Object.freeze( {
					mode: 'guarded',
					guard: Object.freeze( completeGuard( targetOrigin ) ),
				} ) as never,
				targetOrigin
			)
		).toBe( true );
	} );

	it( 'refuses browser tools without a verified navigation guard', async () => {
		const withWpCli = { native: [ 'Read' ], studio: [ ...browserTools, 'wp_cli' ] };
		const declarations = unverifiableNavigation( targetOrigin );
		for ( const [ label, navigationConfinement ] of declarations ) {
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
			expect(
				await policy.authorizeToolUse( {
					toolName: 'mcp__studio__wp_cli',
					input: {},
					mcpServer: studioServer,
				} ),
				label
			).toBe( true );
		}
	} );

	it( 'compares host names lowercased, punycoded and without trailing dots', () => {
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
	} );
} );

describe( 'Claude WordPress.com request transport options', () => {
	const remote = () => CLAUDE_STUDIO_TOOL_RULES.get( 'wpcom_request' )!.remote!;

	it( 'allows only real API namespaces and no query keys the client turns into transport options', () => {
		const get = ( extra: Record< string, unknown > ) =>
			remote()( { siteId: 42, method: 'GET', path: '/posts', ...extra } );
		for ( const apiNamespace of [ undefined, '', 'wp/v2', 'wpcom/v2' ] )
			expect( get( { apiNamespace } ), String( apiNamespace ) ).toMatchObject( {
				wpcomSiteId: 42,
			} );
		expect( get( { query: { per_page: 20, _fields: 'id,title' } } ) ).toMatchObject( {
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
				path: '!/plans/features',
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
		const { policy, host, localSite, context, clock } = await setupWpCli( () => ( {
			approvalTimeoutMs: 60_000,
			approve: vi.fn( ( _request, signal: AbortSignal ) => {
				approvalSignal = signal;
				return new Promise< 'allow' >( () => {} );
			} ),
		} ) );
		const pending = policy.guardHost( host, 'call' ).sites.wpCli( localSite, deleteArgs );
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
