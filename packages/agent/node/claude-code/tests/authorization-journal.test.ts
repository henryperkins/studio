import { randomUUID } from 'crypto';
import { writeFile } from 'fs/promises';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeSite } from '../../tests/fake-host';
import {
	CLAUDE_NATIVE_TOOL_RULES,
	CLAUDE_STUDIO_TOOL_RULES,
	HOST_OPERATION_CLASSES,
} from '../execution-rules';
import { createPolicyFixture, guarded, targetOrigin } from './fixtures/execution-policy';
import type { StudioAgentHost } from '../../host';
import type { ClaudeOperationClass } from '@studio/agent/protocol/claude-code';
import type { Mock } from 'vitest';

// Every rule an operation can run under, enabled whether or not it is
// qualified, as `unqualified-tool-rules.test.ts` does: what is checked here is
// what each rule's authorization records, not what this build runs.
vi.mock( '../execution-rules', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('../execution-rules') >();
	const claudeStudioTools: typeof actual.claudeStudioTools = ( enabled, navigation, origin ) =>
		enabled.studio.filter( ( name ) => {
			const rule = actual.CLAUDE_STUDIO_TOOL_RULES.get( name );
			return (
				!! rule && ( ! rule.navigates || actual.isVerifiedNavigationGuard( navigation, origin ) )
			);
		} );
	return { ...actual, claudeStudioTools };
} );

const cleanups: Array< () => Promise< void > > = [];
afterEach( async () => {
	await Promise.all( cleanups.splice( 0 ).map( ( cleanup ) => cleanup() ) );
} );

const READS: ReadonlySet< ClaudeOperationClass > = new Set( [ 'read', 'remote-read' ] );
const doesMoreThanRead = ( operationClass: ClaudeOperationClass ) => ! READS.has( operationClass );
const local = { environment: 'local' as const, siteId: fakeSite.id };
const live = { environment: 'live' as const, siteId: fakeSite.id, wpcomSiteId: 42 };
const site = { ...fakeSite };

type Paths = { site: string; parent: string };

// A call that passes the rule of each Studio tool whose class does more than read.
const STUDIO_CALLS: Record< string, { args: ( paths: Paths ) => unknown; live?: true } > = {
	site_create: { args: () => ( {} ) },
	site_start: { args: () => ( { nameOrPath: 'site' } ) },
	site_stop: { args: () => ( { nameOrPath: 'site' } ) },
	site_delete: { args: () => ( { nameOrPath: 'site' } ) },
	preview_create: { args: () => ( { nameOrPath: 'site' } ) },
	preview_update: { args: () => ( { nameOrPath: 'site' } ) },
	preview_delete: { args: () => ( {} ) },
	wp_cli: {
		args: () => ( {
			nameOrPath: 'site',
			command: 'post create --post_status=draft --post_title=Hello',
		} ),
	},
	scaffold_theme: { args: () => ( { nameOrPath: 'site', name: 'Theme' } ) },
	validate_blocks: { args: () => ( { nameOrPath: 'site', filePath: 'templates/index.html' } ) },
	take_screenshot: { args: () => ( { url: fakeSite.url } ) },
	generate_images: {
		args: ( paths ) => ( {
			images: [ { path: path.join( paths.site, 'hero.png' ), subject: 'Hero' } ],
		} ),
	},
	install_taxonomy_scripts: { args: () => ( { nameOrPath: 'site' } ) },
	wpcom_request: { args: () => ( { siteId: 42, method: 'POST', path: '/posts' } ), live: true },
	site_push: { args: () => ( { nameOrPath: 'site' } ) },
	site_pull: { args: () => ( { nameOrPath: 'site' } ) },
	site_import: { args: () => ( { nameOrPath: 'site' } ) },
	site_export: { args: () => ( { nameOrPath: 'site' } ) },
	open_annotation_browser: { args: () => ( { url: fakeSite.url } ) },
	send_feedback: { args: () => ( {} ) },
	present_design_options: { args: () => ( {} ) },
};

// A use of each native tool whose class does more than read. Each carries
// content that must never reach the journal.
const NATIVE_USES: Record< string, ( paths: Paths ) => Record< string, unknown > > = {
	Write: ( paths ) => ( {
		file_path: path.join( paths.site, 'readme.txt' ),
		content: 'secret body',
	} ),
	Edit: ( paths ) => ( {
		file_path: path.join( paths.site, 'readme.txt' ),
		old_string: 'fixture',
		new_string: 'secret body',
	} ),
	MultiEdit: ( paths ) => ( {
		file_path: path.join( paths.site, 'readme.txt' ),
		edits: [ { old_string: 'fixture', new_string: 'secret body' } ],
	} ),
	Bash: () => ( { command: 'echo secret' } ),
};

// A call of each host operation that does more than read.
const HOST_CALLS: Record<
	string,
	{ global?: true; call: ( host: StudioAgentHost, paths: Paths ) => Promise< unknown > }
> = {
	'sites.create': {
		global: true,
		call: ( host, paths ) => host.sites.create( 'New', path.join( paths.parent, 'new' ), () => {} ),
	},
	'sites.start': { call: ( host ) => host.sites.start( site, () => {} ) },
	'sites.stop': { call: ( host ) => host.sites.stop( site, () => {} ) },
	'sites.delete': { call: ( host ) => host.sites.delete( site, false, () => {} ) },
	'sites.import': {
		call: ( host, paths ) => host.sites.import( site, path.join( paths.site, 'a.zip' ), () => {} ),
	},
	'sites.export': {
		call: ( host, paths ) =>
			host.sites.export( site, path.join( paths.site, 'a.zip' ), 'full', () => {} ),
	},
	'sites.wpCli': {
		call: ( host ) =>
			host.sites.wpCli( site, [ 'post', 'create', '--post_status=draft', '--post_title=Hello' ] ),
	},
	'previews.create': { call: ( host ) => host.previews.create( site, () => {} ) },
	'previews.update': {
		call: ( host ) => host.previews.update( site, 'demo.wp.build', false, () => {} ),
	},
	'previews.delete': { call: ( host ) => host.previews.delete( 'demo.wp.build', () => {} ) },
	'sync.push': { call: ( host ) => host.sync.push( site, 'all', 'remote', () => {} ) },
	'sync.pull': { call: ( host ) => host.sync.pull( site, 'all', 'remote', () => {} ) },
};

async function setup( ...args: Parameters< typeof createPolicyFixture > ) {
	const fixture = await createPolicyFixture( ...args );
	cleanups.push( fixture.cleanup );
	await writeFile( path.join( fixture.site, 'readme.txt' ), 'fixture' );
	return fixture;
}

// The rules that can let a call do more than read: by their class, or, for a
// rule classified by its arguments, whatever its class says.
const mayDoMoreThanRead = (
	rules: ReadonlyMap< string, { operationClass: ClaudeOperationClass; classify?: unknown } >
) =>
	[ ...rules ]
		.filter( ( [ , rule ] ) => doesMoreThanRead( rule.operationClass ) || !! rule.classify )
		.map( ( [ name ] ) => name )
		.sort();

describe( 'what the policy journals before an operation that does more than read runs', () => {
	it( 'has a case for every rule and host operation whose class does more than read', () => {
		const names = mayDoMoreThanRead;
		expect(
			names(
				new Map( [
					[ 'reads', { operationClass: 'read' as const } ],
					[ 'classified', { operationClass: 'read' as const, classify: () => 'command' } ],
				] )
			)
		).toEqual( [ 'classified' ] );
		expect( Object.keys( STUDIO_CALLS ).sort() ).toEqual( names( CLAUDE_STUDIO_TOOL_RULES ) );
		expect( Object.keys( NATIVE_USES ).sort() ).toEqual( names( CLAUDE_NATIVE_TOOL_RULES ) );
		expect( Object.keys( HOST_CALLS ).sort() ).toEqual(
			[
				...Object.entries( HOST_OPERATION_CLASSES )
					.filter( ( [ , operationClass ] ) => doesMoreThanRead( operationClass ) )
					.map( ( [ name ] ) => name ),
				'sites.wpCli',
			].sort()
		);
	} );

	it.each( Object.keys( STUDIO_CALLS ) )(
		'journals the Studio tool %s, its class and a safe description, before allowing it',
		async ( name ) => {
			const call = STUDIO_CALLS[ name ];
			const target = call.live ? live : local;
			const fixture = await setup( () => ( {
				enabledTools: { native: [], studio: [ name ] },
				navigationConfinement: guarded( targetOrigin ),
				target,
			} ) );
			const args = call.args( fixture );
			const toolCallId = randomUUID();
			expect(
				await fixture.policy.authorizeStudioCall( {
					host: fixture.host,
					name,
					args,
					toolCallId,
				} )
			).toBe( true );
			const rule = CLAUDE_STUDIO_TOOL_RULES.get( name )!;
			const asked = vi
				.mocked( fixture.context.approve )
				.mock.calls.map( ( [ request ] ) => request.requestId );
			expect( fixture.journal ).toEqual( [
				{
					type: 'operation.authorized',
					runId: 'run',
					turnId: 'turn',
					toolCallId,
					...( asked.length ? { requestId: asked[ 0 ] } : {} ),
					operation: {
						tool: name,
						operationClass: rule.classify ? rule.classify( args ) : rule.operationClass,
						target,
					},
					description: expect.stringContaining( name ),
				},
			] );
			expect( JSON.stringify( fixture.journal ) ).not.toContain( fixture.site );
		}
	);

	it.each( Object.keys( NATIVE_USES ) )(
		'journals the native tool %s, without its input, before allowing it',
		async ( name ) => {
			const fixture = await setup( () => ( {
				enabledTools: { native: [ name ], studio: [] },
				shellConfinement: { mode: 'approval-only' },
			} ) );
			expect(
				await fixture.policy.authorizeToolUse( {
					toolName: name,
					input: NATIVE_USES[ name ]( fixture ),
					toolUseId: 'tool-use',
				} )
			).toBe( true );
			expect( fixture.journal ).toEqual( [
				expect.objectContaining( {
					type: 'operation.authorized',
					toolCallId: 'tool-use',
					operation: {
						tool: name,
						operationClass: CLAUDE_NATIVE_TOOL_RULES.get( name )!.operationClass,
						target: local,
					},
				} ),
			] );
			expect( JSON.stringify( fixture.journal ) ).not.toContain( 'secret' );
			expect( JSON.stringify( fixture.journal ) ).not.toContain( fixture.site );
		}
	);

	it.each( Object.keys( HOST_CALLS ) )(
		'journals the host operation %s before the host runs it',
		async ( name ) => {
			const order: string[] = [];
			const fixture = await setup( ( paths ) =>
				HOST_CALLS[ name ].global
					? {
							target: { environment: 'global' },
							targetSite: undefined,
							workspace: {
								siteId: null,
								workingDirectory: paths.parent,
								configDirectory: paths.config,
							},
					  }
					: {}
			);
			const record = fixture.context.recordOperation;
			fixture.context.recordOperation = async ( event ) => {
				order.push( `journal ${ event.operation.tool }` );
				await record( event );
			};
			const [ group, method ] = name.split( '.' );
			const spy = (
				fixture.host as unknown as Record<
					string,
					Record< string, Mock< ( ...args: unknown[] ) => Promise< unknown > > >
				>
			 )[ group ][ method ];
			const result = spy.getMockImplementation();
			spy.mockImplementation( async ( ...args: unknown[] ) => {
				order.push( `host ${ name }` );
				return result?.( ...args );
			} );
			await HOST_CALLS[ name ].call( fixture.policy.guardHost( fixture.host, 'call' ), fixture );
			expect( order ).toEqual( [ `journal ${ name }`, `host ${ name }` ] );
			expect( fixture.journal ).toEqual( [
				expect.objectContaining( {
					type: 'operation.authorized',
					toolCallId: 'call',
					operation: expect.objectContaining( {
						tool: name,
						operationClass:
							name === 'sites.wpCli'
								? 'command'
								: HOST_OPERATION_CLASSES[ name as keyof typeof HOST_OPERATION_CLASSES ],
					} ),
				} ),
			] );
			expect( JSON.stringify( fixture.journal ) ).not.toContain( fixture.site );
		}
	);

	it( 'names the approval an approved operation runs under, and describes it as the approval did', async () => {
		const { policy, host, journal, context } = await setup();
		await policy
			.guardHost( host, 'call' )
			.sites.wpCli( site, [ 'post', 'create', '--post_status=draft', '--post_title=Hello' ] );
		const [ request ] = vi.mocked( context.approve ).mock.calls[ 0 ];
		expect( journal ).toEqual( [
			expect.objectContaining( {
				toolCallId: 'call',
				requestId: request.requestId,
				description: 'Create a draft post on the current local site',
			} ),
		] );
	} );

	it( 'journals nothing for an operation that only reads', async () => {
		const {
			policy,
			host,
			journal,
			site: folder,
		} = await setup( () => ( {
			enabledTools: { native: [ 'Read' ], studio: [ 'wp_cli' ] },
		} ) );
		expect(
			await policy.authorizeToolUse( {
				toolName: 'Read',
				input: { file_path: path.join( folder, 'readme.txt' ) },
				toolUseId: 'read',
			} )
		).toBe( true );
		await policy.guardHost( host, 'call' ).sites.wpCli( site, [ 'option', 'get', 'blogname' ] );
		expect( host.sites.wpCli ).toHaveBeenCalledOnce();
		expect( journal ).toEqual( [] );
	} );

	it( 'journals nothing at the tool for a WP-CLI call that only reads, and journals one it cannot place as a command', async () => {
		const { policy, host, journal } = await setup();
		const call = ( command: string, toolCallId: string ) =>
			policy.authorizeStudioCall( {
				host,
				name: 'wp_cli',
				args: { nameOrPath: 'site', command },
				toolCallId,
			} );
		expect( await call( 'post list', 'list' ) ).toBe( true );
		expect( await call( 'option get blogname', 'option' ) ).toBe( true );
		expect( journal ).toEqual( [] );
		expect( await call( 'plugin install hello-dolly', 'install' ) ).toBe( true );
		expect( await call( 'post   list --format=json', 'formatted' ) ).toBe( true );
		expect( journal ).toEqual( [
			expect.objectContaining( {
				toolCallId: 'install',
				operation: expect.objectContaining( { tool: 'wp_cli', operationClass: 'command' } ),
			} ),
			expect.objectContaining( {
				toolCallId: 'formatted',
				operation: expect.objectContaining( { tool: 'wp_cli', operationClass: 'command' } ),
			} ),
		] );
	} );

	it( 'journals a WP-CLI command that does more than read at its host operation, whatever its tool call was classified as', async () => {
		const { policy, host, journal, context } = await setup();
		const order: string[] = [];
		const record = context.recordOperation;
		context.recordOperation = async ( event ) => {
			order.push( `journal ${ event.operation.tool }` );
			await record( event );
		};
		vi.mocked( host.sites.wpCli ).mockImplementation( async () => {
			order.push( 'host sites.wpCli' );
			return { exitCode: 0, stdout: '', stderr: '' };
		} );
		// The tool call reads as a read; the command that reaches the host is a draft.
		expect(
			await policy.authorizeStudioCall( {
				host,
				name: 'wp_cli',
				args: { nameOrPath: 'site', command: 'post list' },
				toolCallId: 'call',
			} )
		).toBe( true );
		await policy
			.guardHost( host, 'call' )
			.sites.wpCli( site, [ 'post', 'create', '--post_status=draft', '--post_title=Hello' ] );
		expect( order ).toEqual( [ 'journal sites.wpCli', 'host sites.wpCli' ] );
		expect( journal ).toEqual( [
			expect.objectContaining( {
				toolCallId: 'call',
				operation: expect.objectContaining( { tool: 'sites.wpCli', operationClass: 'command' } ),
			} ),
		] );
	} );

	it( 'runs nothing it could not journal', async () => {
		const {
			policy,
			host,
			site: folder,
		} = await setup( () => ( {
			enabledTools: { native: [ 'Write' ], studio: [ 'scaffold_theme' ] },
			recordOperation: async () => {
				throw new Error( 'The disk is full' );
			},
		} ) );
		expect(
			await policy.authorizeToolUse( {
				toolName: 'Write',
				input: { file_path: path.join( folder, 'readme.txt' ) },
				toolUseId: 'write',
			} )
		).toBe( false );
		await expect(
			policy
				.guardHost( host, 'call' )
				.sites.wpCli( site, [ 'post', 'create', '--post_status=draft', '--post_title=Hello' ] )
		).rejects.toThrow( 'Denied' );
		expect( host.sites.wpCli ).not.toHaveBeenCalled();
		expect(
			await policy.authorizeStudioCall( {
				host,
				name: 'scaffold_theme',
				args: { nameOrPath: 'site', name: 'Theme' },
				toolCallId: 'theme',
			} )
		).toBe( false );
	} );

	it( 'refuses a native mutation it cannot name in the journal', async () => {
		const {
			policy,
			journal,
			site: folder,
		} = await setup( () => ( {
			enabledTools: { native: [ 'Write' ], studio: [] },
		} ) );
		expect(
			await policy.authorizeToolUse( {
				toolName: 'Write',
				input: { file_path: path.join( folder, 'readme.txt' ) },
			} )
		).toBe( false );
		expect( journal ).toEqual( [] );
	} );
} );
