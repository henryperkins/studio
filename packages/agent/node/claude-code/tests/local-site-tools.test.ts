import { randomUUID } from 'crypto';
import { existsSync, readdirSync } from 'fs';
import { mkdir, rename, symlink, writeFile } from 'fs/promises';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSameClaudeTarget } from '@studio/agent/protocol/claude-code';
import { getSkillPath } from '../../skills';
import { fakeSite } from '../../tests/fake-host';
import { isBundledFolder } from '../local-paths';
import { createStudioClaudeToolBridge } from '../tool-bridge';
import { createPolicyFixture } from './fixtures/execution-policy';
import type { ClaudeApprovalRequest, ClaudeExecutionContext } from '../execution-policy';
import type { ClaudeStudioTarget } from '@studio/agent/protocol/claude-code';

// The local site tools qualified for the Claude route, each driven through the
// real execution policy and the bridge the SDK calls, against a fake host
// whose operations are spies.

const cleanups: Array< () => Promise< void > > = [];
afterEach( async () => {
	await Promise.all( cleanups.splice( 0 ).map( ( cleanup ) => cleanup() ) );
} );

async function setup( ...args: Parameters< typeof createPolicyFixture > ) {
	const fixture = await createPolicyFixture( ...args );
	cleanups.push( fixture.cleanup );
	const bridge = createStudioClaudeToolBridge(
		fixture.host,
		{ runId: 'run', turnId: 'turn', policy: fixture.policy },
		() => {}
	);
	cleanups.push( () => bridge.dispose() );
	return { ...fixture, bridge };
}

const text = ( result: { content: Array< { type: string; text?: string } > } ) =>
	result.content.map( ( part ) => part.text ?? '' ).join( '\n' );

describe( 'site_info on the Claude route', () => {
	it( 'reads the status of the conversation’s own site, unprompted and unjournaled', async () => {
		const { bridge, host, context, journal, localSite } = await setup();
		expect( bridge.tools ).toContain( 'site_info' );
		const result = await bridge.invoke( 'site_info', { nameOrPath: 'site' } );
		expect( result.isError ).toBe( false );
		expect( JSON.parse( text( result ) ) ).toMatchObject( { emailPath: '/email/site-123' } );
		expect( host.sites.status ).toHaveBeenCalledWith( localSite );
		expect( context.approve ).not.toHaveBeenCalled();
		expect( journal ).toEqual( [] );
	} );

	it( 'reads no other site', async () => {
		const { bridge, host } = await setup();
		expect( ( await bridge.invoke( 'site_info', { nameOrPath: 'other' } ) ).isError ).toBe( true );
		expect( host.sites.status ).not.toHaveBeenCalled();
	} );
} );

describe( 'the host members a qualified tool reads through', () => {
	it( 'reads the status of the target site only, and nothing once the call has ended', async () => {
		const { policy, host, otherSite, localSite } = await setup();
		const call = new AbortController();
		const guarded = policy.guardHost( host, 'call', call.signal );
		await expect( guarded.sites.status( localSite ) ).resolves.toMatchObject( {
			adminUsername: 'admin',
		} );
		await expect( guarded.sites.isRunning( localSite ) ).resolves.toBe( true );
		await expect( guarded.sites.status( otherSite ) ).rejects.toThrow( 'Denied' );
		await expect( guarded.sites.isRunning( otherSite ) ).rejects.toThrow( 'Denied' );
		await expect(
			guarded.sites.status( { ...fakeSite, path: localSite.path, id: 'forged' } )
		).rejects.toThrow( 'Denied' );
		call.abort();
		await expect( guarded.sites.status( localSite ) ).rejects.toThrow( 'Denied' );
		await expect( guarded.sites.isRunning( localSite ) ).rejects.toThrow( 'Denied' );
		expect( host.sites.status ).toHaveBeenCalledOnce();
		expect( host.sites.isRunning ).toHaveBeenCalledOnce();
	} );

	it( 'reads nothing for a turn whose target or connection changed', async () => {
		const { policy, host, context, localSite } = await setup();
		vi.mocked( context.verifyTarget ).mockResolvedValue( false );
		await expect( policy.guardHost( host, 'call' ).sites.status( localSite ) ).rejects.toThrow(
			'Denied'
		);
		expect( host.sites.status ).not.toHaveBeenCalled();
	} );

	it( 'refuses every member no qualified tool needs: every site, WordPress.com and analytics', async () => {
		const { policy, host } = await setup();
		const guarded = policy.guardHost( host, 'call' );
		await expect( guarded.sites.all() ).rejects.toThrow( 'Denied' );
		await expect( guarded.sites.list() ).rejects.toThrow( 'Denied' );
		await expect( guarded.wpcom.sites( 'token' ) ).rejects.toThrow( 'Denied' );
		await expect( guarded.tracks.record( 'studio_agent_x' as never, {} ) ).rejects.toThrow(
			'Denied'
		);
		expect( host.sites.all ).not.toHaveBeenCalled();
		expect( host.sites.list ).not.toHaveBeenCalled();
		expect( host.wpcom.sites ).not.toHaveBeenCalled();
		expect( host.tracks.record ).not.toHaveBeenCalled();
	} );
} );

// What the journal recorded, tool by tool, in order.
const journaled = ( journal: Array< { operation: { tool: string; operationClass: string } } > ) =>
	journal.map( ( entry ) => [ entry.operation.tool, entry.operation.operationClass ] );

describe.each( [
	[ 'site_start', 'start' ],
	[ 'site_stop', 'stop' ],
] as const )( '%s on the Claude route', ( name, operation ) => {
	it( 'runs on the conversation’s own site unprompted, journaled at the tool and at its host operation, behind the host fence', async () => {
		const { bridge, host, context, journal, policy } = await setup();
		expect( bridge.tools ).toContain( name );
		const result = await bridge.invoke( name, { nameOrPath: 'site' } );
		expect( result.isError ).toBe( false );
		expect( host.sites[ operation ] ).toHaveBeenCalledWith(
			expect.objectContaining( { id: fakeSite.id } ),
			expect.any( Function ),
			expect.objectContaining( {
				signal: expect.any( AbortSignal ),
				beforeSpawn: expect.any( Function ),
			} )
		);
		expect( context.approve ).not.toHaveBeenCalled();
		expect( journaled( journal ) ).toEqual( [
			[ name, 'local-change' ],
			[ `sites.${ operation }`, 'local-change' ],
		] );
		// The fence it ran behind refuses once the turn has ended.
		const options = vi.mocked( host.sites[ operation ] ).mock.calls[ 0 ][ 2 ]!;
		policy.dispose();
		expect( options.signal!.aborted ).toBe( true );
		await expect( options.beforeSpawn!() ).rejects.toThrow( 'Denied' );
	} );

	it( 'touches no other site, and no site from a global conversation', async () => {
		const { bridge, host, journal } = await setup();
		expect( ( await bridge.invoke( name, { nameOrPath: 'other' } ) ).isError ).toBe( true );
		expect( host.sites[ operation ] ).not.toHaveBeenCalled();
		expect( journal ).toEqual( [] );
		const global = await setup( ( paths ) => ( {
			target: { environment: 'global' },
			targetSite: undefined,
			workspace: { siteId: null, workingDirectory: paths.parent, configDirectory: paths.config },
			localRoots: [ paths.parent ],
		} ) );
		expect( ( await global.bridge.invoke( name, { nameOrPath: 'site' } ) ).isError ).toBe( true );
		expect( global.host.sites[ operation ] ).not.toHaveBeenCalled();
	} );
} );

describe( 'site_delete on the Claude route', () => {
	it( 'deletes the conversation’s own site only once the user approves that exact operation, which shows the site’s folder', async () => {
		const { bridge, host, context, journal, site } = await setup();
		expect( bridge.tools ).toContain( 'site_delete' );
		const result = await bridge.invoke( 'site_delete', { nameOrPath: 'site', deleteFiles: false } );
		expect( result.isError ).toBe( false );
		expect( context.approve ).toHaveBeenCalledOnce();
		const [ request ] = vi.mocked( context.approve ).mock.calls[ 0 ];
		expect( request.operation ).toMatchObject( {
			tool: 'sites.delete',
			operationClass: 'local-overwrite',
			args: [ false ],
			localPaths: [ site ],
		} );
		expect( host.sites.delete ).toHaveBeenCalledWith(
			expect.objectContaining( { id: fakeSite.id } ),
			false,
			expect.any( Function ),
			expect.objectContaining( { beforeSpawn: expect.any( Function ) } )
		);
		expect( journaled( journal ) ).toEqual( [
			[ 'site_delete', 'local-overwrite' ],
			[ 'sites.delete', 'local-overwrite' ],
		] );
		expect( journal[ 1 ].requestId ).toBe( request.requestId );
	} );

	it( 'moves the files to the trash by default, as on every route, and says so in the approval', async () => {
		const { bridge, context } = await setup();
		await bridge.invoke( 'site_delete', { nameOrPath: 'site' } );
		expect( vi.mocked( context.approve ).mock.calls[ 0 ][ 0 ].operation.args ).toEqual( [ true ] );
	} );

	it( 'deletes nothing the user denies, and says so', async () => {
		const { bridge, host, journal } = await setup( () => ( {
			approve: vi.fn( async () => 'deny' as const ),
		} ) );
		const result = await bridge.invoke( 'site_delete', { nameOrPath: 'site' } );
		expect( result.isError ).toBe( true );
		expect( text( result ) ).toContain( 'The user did not approve this operation' );
		expect( host.sites.delete ).not.toHaveBeenCalled();
		expect( journaled( journal ) ).toEqual( [ [ 'site_delete', 'local-overwrite' ] ] );
	} );

	it( 'deletes no other site', async () => {
		const { bridge, host, context } = await setup();
		expect( ( await bridge.invoke( 'site_delete', { nameOrPath: 'other' } ) ).isError ).toBe(
			true
		);
		expect( context.approve ).not.toHaveBeenCalled();
		expect( host.sites.delete ).not.toHaveBeenCalled();
	} );
} );

const PATH_REFUSAL = 'inside the site’s folder or this conversation’s workspace';

describe( 'site_import on the Claude route', () => {
	it( 'imports a backup from the conversation’s folders once the user approves the operation that names it', async () => {
		const { bridge, host, context, journal, site } = await setup();
		const backup = path.join( site, 'backup.zip' );
		await writeFile( backup, 'zip' );
		expect( bridge.tools ).toContain( 'site_import' );
		const result = await bridge.invoke( 'site_import', { nameOrPath: 'site', importFile: backup } );
		expect( result.isError ).toBe( false );
		const [ request ] = vi.mocked( context.approve ).mock.calls[ 0 ];
		expect( request.operation ).toMatchObject( {
			tool: 'sites.import',
			operationClass: 'local-overwrite',
			localPaths: [ site, backup ],
		} );
		expect( host.sites.import ).toHaveBeenCalledWith(
			expect.objectContaining( { id: fakeSite.id } ),
			backup,
			expect.any( Function ),
			expect.objectContaining( { beforeSpawn: expect.any( Function ) } )
		);
		expect( journaled( journal ) ).toEqual( [
			[ 'site_import', 'local-overwrite' ],
			[ 'sites.import', 'local-overwrite' ],
		] );
	} );

	it( 'reads no file outside the conversation’s folders, by any path, nor one that holds credentials, and says why without the path', async () => {
		const { bridge, host, context, site, parent } = await setup();
		await writeFile( path.join( parent, 'elsewhere.zip' ), 'zip' );
		await writeFile( path.join( site, 'credentials.zip' ), 'zip' );
		await mkdir( path.join( parent, 'outside' ) );
		await writeFile( path.join( parent, 'outside', 'backup.zip' ), 'zip' );
		await symlink( path.join( parent, 'outside' ), path.join( site, 'linked' ), 'junction' );
		for ( const importFile of [
			path.join( parent, 'elsewhere.zip' ),
			path.join( site, '..', 'elsewhere.zip' ),
			path.join( site, 'linked', 'backup.zip' ),
			path.join( site, 'credentials.zip' ),
			path.join( site, 'missing.zip' ),
			'backup.zip',
		] ) {
			const result = await bridge.invoke( 'site_import', { nameOrPath: 'site', importFile } );
			expect( result.isError, importFile ).toBe( true );
			expect( text( result ), importFile ).toContain( PATH_REFUSAL );
			expect( text( result ), importFile ).not.toContain( parent );
		}
		expect( context.approve ).not.toHaveBeenCalled();
		expect( host.sites.import ).not.toHaveBeenCalled();
	} );
} );

describe( 'site_export on the Claude route', () => {
	it( 'writes a backup in the conversation’s folders once the user approves the operation that names it', async () => {
		const { bridge, host, context, journal, site } = await setup();
		const exportFile = path.join( site, 'exports', 'backup.zip' );
		expect( bridge.tools ).toContain( 'site_export' );
		const result = await bridge.invoke( 'site_export', { nameOrPath: 'site', exportFile } );
		expect( result.isError ).toBe( false );
		expect( vi.mocked( context.approve ).mock.calls[ 0 ][ 0 ].operation ).toMatchObject( {
			tool: 'sites.export',
			operationClass: 'local-overwrite',
			args: [ exportFile, 'full' ],
			localPaths: [ site, exportFile ],
		} );
		expect( host.sites.export ).toHaveBeenCalledWith(
			expect.objectContaining( { id: fakeSite.id } ),
			exportFile,
			'full',
			expect.any( Function ),
			expect.objectContaining( { beforeSpawn: expect.any( Function ) } )
		);
		expect( journaled( journal ) ).toEqual( [
			[ 'site_export', 'local-overwrite' ],
			[ 'sites.export', 'local-overwrite' ],
		] );
	} );

	it( 'writes nowhere outside the conversation’s folders, by any path, and says why without the path', async () => {
		const { bridge, host, context, site, parent } = await setup();
		await mkdir( path.join( parent, 'outside' ) );
		await symlink( path.join( parent, 'outside' ), path.join( site, 'linked' ), 'junction' );
		for ( const exportFile of [
			path.join( parent, 'backup.zip' ),
			path.join( site, '..', 'backup.zip' ),
			path.join( site, 'linked', 'backup.zip' ),
			path.join( site, 'linked', 'new', 'backup.zip' ),
			path.join( site, 'secret-backup.zip' ),
			'backup.zip',
			// Without a file the tool writes to the working folder of Studio's own
			// process, which is none of the conversation's.
			undefined,
		] ) {
			const result = await bridge.invoke( 'site_export', { nameOrPath: 'site', exportFile } );
			expect( result.isError, String( exportFile ) ).toBe( true );
			expect( text( result ), String( exportFile ) ).toContain( PATH_REFUSAL );
			expect( text( result ), String( exportFile ) ).not.toContain( parent );
		}
		expect( context.approve ).not.toHaveBeenCalled();
		expect( host.sites.export ).not.toHaveBeenCalled();
	} );

	it( 'checks the file again immediately before the command starts, so an approved path that now leads elsewhere writes nothing', async () => {
		const { bridge, host, context, site, parent } = await setup();
		await mkdir( path.join( site, 'exports' ) );
		await mkdir( path.join( parent, 'outside' ) );
		vi.mocked( context.approve ).mockImplementationOnce( async () => {
			await rename( path.join( site, 'exports' ), path.join( site, 'moved' ) );
			await symlink( path.join( parent, 'outside' ), path.join( site, 'exports' ), 'junction' );
			return 'allow';
		} );
		host.sites.export = vi.fn( async ( _site, _file, _mode, _progress, options ) => {
			await options?.beforeSpawn?.();
		} );
		const result = await bridge.invoke( 'site_export', {
			nameOrPath: 'site',
			exportFile: path.join( site, 'exports', 'backup.zip' ),
		} );
		expect( result.isError ).toBe( true );
		expect( host.sites.export ).not.toHaveBeenCalled();
	} );
} );

describe( 'install_taxonomy_scripts on the Claude route', () => {
	const scripts = readdirSync( getSkillPath( 'taxonomist', 'scripts' ) );
	const installed = ( site: string ) =>
		existsSync( path.join( site, 'tmp', 'taxonomist' ) )
			? readdirSync( path.join( site, 'tmp', 'taxonomist' ) )
			: [];

	it( 'copies Studio’s own scripts into the conversation’s site, unprompted and journaled', async () => {
		const { bridge, context, journal, site } = await setup();
		expect( bridge.tools ).toContain( 'install_taxonomy_scripts' );
		const result = await bridge.invoke( 'install_taxonomy_scripts', { nameOrPath: 'site' } );
		expect( result.isError ).toBe( false );
		expect( scripts.length ).toBeGreaterThan( 0 );
		expect( installed( site ).sort() ).toEqual( [ ...scripts ].sort() );
		expect( context.approve ).not.toHaveBeenCalled();
		expect( journaled( journal ) ).toEqual( [ [ 'install_taxonomy_scripts', 'local-change' ] ] );
	} );

	it( 'writes into no other site, and through no link that leads out of the site', async () => {
		const { bridge, site, parent, other, journal } = await setup();
		expect(
			( await bridge.invoke( 'install_taxonomy_scripts', { nameOrPath: 'other' } ) ).isError
		).toBe( true );
		expect( installed( other ) ).toEqual( [] );
		await mkdir( path.join( parent, 'outside' ) );
		await symlink( path.join( parent, 'outside' ), path.join( site, 'tmp' ), 'junction' );
		expect(
			( await bridge.invoke( 'install_taxonomy_scripts', { nameOrPath: 'site' } ) ).isError
		).toBe( true );
		expect( readdirSync( path.join( parent, 'outside' ) ) ).toEqual( [] );
		expect( journal ).toEqual( [] );
	} );

	it( 'after a recovery that left operations uncertain, asks first and shows every file it writes', async () => {
		const { bridge, context, site } = await setup( () => ( { uncertainAfterRecovery: true } ) );
		expect(
			( await bridge.invoke( 'install_taxonomy_scripts', { nameOrPath: 'site' } ) ).isError
		).toBe( false );
		const [ request ] = vi.mocked( context.approve ).mock.calls[ 0 ];
		expect( request.operation.localPaths ).toEqual( [
			path.join( site, 'tmp', 'taxonomist' ),
			...scripts.map( ( file ) => path.join( site, 'tmp', 'taxonomist', file ) ),
		] );
		expect( request.operation.description ).toContain( 'may already have taken effect' );
	} );
} );

describe( 'a link whose target does not exist, in a path Studio writes', () => {
	// A link planted in the conversation's site that points out of it, at
	// nothing yet. A write that followed it would create its target outside the
	// site's folder, though in this test's own scratch folder. A file link
	// needs a privilege Windows may not grant; where it does not, that case is
	// skipped and the junction cases still run.
	async function fileLink(
		context: { skip: () => void },
		target: string,
		link: string
	): Promise< void > {
		try {
			await symlink( target, link, 'file' );
		} catch ( error ) {
			if ( process.platform === 'win32' && ( error as NodeJS.ErrnoException ).code === 'EPERM' )
				context.skip();
			throw error;
		}
	}
	// An export that writes its file as the CLI would, once its fence passes.
	const writingExports = ( host: Awaited< ReturnType< typeof setup > >[ 'host' ] ) => {
		host.sites.export = vi.fn( async ( _site, file, _mode, _progress, options ) => {
			await options?.beforeSpawn?.();
			await writeFile( file, 'zip' );
		} );
	};

	it( 'refuses an export file that is a link to nothing, and writes nothing where it points', async ( context ) => {
		const { bridge, host, site, parent } = await setup();
		writingExports( host );
		await mkdir( path.join( parent, 'outside' ) );
		const escaped = path.join( parent, 'outside', 'escaped.zip' );
		await fileLink( context, escaped, path.join( site, 'backup.zip' ) );
		const result = await bridge.invoke( 'site_export', {
			nameOrPath: 'site',
			exportFile: path.join( site, 'backup.zip' ),
		} );
		expect( result.isError ).toBe( true );
		expect( text( result ) ).toContain( PATH_REFUSAL );
		expect( host.sites.export ).not.toHaveBeenCalled();
		expect( existsSync( escaped ) ).toBe( false );
	} );

	it( 'refuses an export file under a folder link to nothing, and writes nothing where it points', async () => {
		const { bridge, host, site, parent } = await setup();
		writingExports( host );
		await mkdir( path.join( parent, 'outside' ) );
		const missing = path.join( parent, 'outside', 'missing' );
		await symlink( missing, path.join( site, 'exports' ), 'junction' );
		const result = await bridge.invoke( 'site_export', {
			nameOrPath: 'site',
			exportFile: path.join( site, 'exports', 'backup.zip' ),
		} );
		expect( result.isError ).toBe( true );
		expect( text( result ) ).toContain( PATH_REFUSAL );
		expect( host.sites.export ).not.toHaveBeenCalled();
		expect( existsSync( missing ) ).toBe( false );
	} );

	it( 'still writes an export file that does not exist yet in a folder that does', async () => {
		const { bridge, host, site } = await setup();
		writingExports( host );
		const result = await bridge.invoke( 'site_export', {
			nameOrPath: 'site',
			exportFile: path.join( site, 'backup.zip' ),
		} );
		expect( result.isError ).toBe( false );
		expect( existsSync( path.join( site, 'backup.zip' ) ) ).toBe( true );
	} );

	it( 'checks again immediately before the command starts, so a link to nothing planted while the user reads the approval writes nothing', async ( context ) => {
		const { bridge, host, context: policyContext, site, parent } = await setup();
		writingExports( host );
		await mkdir( path.join( parent, 'outside' ) );
		const escaped = path.join( parent, 'outside', 'later.zip' );
		let planted: Promise< void > | undefined;
		vi.mocked( policyContext.approve ).mockImplementationOnce( async () => {
			planted = fileLink( context, escaped, path.join( site, 'later.zip' ) );
			await planted;
			return 'allow';
		} );
		const result = await bridge.invoke( 'site_export', {
			nameOrPath: 'site',
			exportFile: path.join( site, 'later.zip' ),
		} );
		await planted;
		expect( result.isError ).toBe( true );
		expect( host.sites.export ).not.toHaveBeenCalled();
		expect( existsSync( escaped ) ).toBe( false );
	} );

	it( 'refuses to copy the Taxonomist scripts through a folder link to nothing', async () => {
		const { bridge, site, parent, journal } = await setup();
		await mkdir( path.join( parent, 'outside' ) );
		const missing = path.join( parent, 'outside', 'missing' );
		await symlink( missing, path.join( site, 'tmp' ), 'junction' );
		const result = await bridge.invoke( 'install_taxonomy_scripts', { nameOrPath: 'site' } );
		expect( result.isError ).toBe( true );
		expect( existsSync( missing ) ).toBe( false );
		expect( journal ).toEqual( [] );
	} );

	it( 'refuses to copy a Taxonomist script over a file link to nothing', async ( context ) => {
		const { bridge, site, parent, journal } = await setup();
		const [ script ] = readdirSync( getSkillPath( 'taxonomist', 'scripts' ) );
		await mkdir( path.join( parent, 'outside' ) );
		await mkdir( path.join( site, 'tmp', 'taxonomist' ), { recursive: true } );
		const escaped = path.join( parent, 'outside', script );
		await fileLink( context, escaped, path.join( site, 'tmp', 'taxonomist', script ) );
		const result = await bridge.invoke( 'install_taxonomy_scripts', { nameOrPath: 'site' } );
		expect( result.isError ).toBe( true );
		expect( existsSync( escaped ) ).toBe( false );
		expect( journal ).toEqual( [] );
	} );
} );

describe( 'refresh_browser on the Claude route', () => {
	it( 'reloads the preview of the app that shows the conversation, unprompted and unjournaled, only while the call lives', async () => {
		const fixture = await createPolicyFixture();
		cleanups.push( fixture.cleanup );
		const ui = { showArtifact: vi.fn(), reloadPreview: vi.fn() };
		fixture.host.ui = ui;
		let kept: ( () => void ) | undefined;
		const guardHost = fixture.policy.guardHost;
		const bridge = createStudioClaudeToolBridge(
			fixture.host,
			{
				runId: 'run',
				turnId: 'turn',
				policy: {
					...fixture.policy,
					guardHost: ( ...args ) => {
						const guarded = guardHost( ...args );
						kept = () => guarded.ui!.reloadPreview();
						return guarded;
					},
				},
			},
			() => {}
		);
		cleanups.push( () => bridge.dispose() );
		expect( bridge.tools ).toContain( 'refresh_browser' );
		expect( ( await bridge.invoke( 'refresh_browser', {} ) ).isError ).toBe( false );
		expect( ui.reloadPreview ).toHaveBeenCalledOnce();
		expect( fixture.context.approve ).not.toHaveBeenCalled();
		expect( fixture.journal ).toEqual( [] );
		kept!();
		expect( ui.reloadPreview ).toHaveBeenCalledOnce();
	} );

	it( 'is not offered to a host without an app that shows the conversation', async () => {
		const { bridge } = await setup();
		expect( bridge.tools ).not.toContain( 'refresh_browser' );
		expect( ( await bridge.invoke( 'refresh_browser', {} ) ).isError ).toBe( true );
	} );
} );

describe( 'the folders Studio ships its read-only files in', () => {
	it( 'are Studio’s own bundled skills, outside every folder a conversation reaches', async () => {
		const scripts = getSkillPath( 'taxonomist', 'scripts' );
		const { parent } = await setup();
		expect( await isBundledFolder( scripts, [ parent ] ) ).toBe( true );
		expect( await isBundledFolder( parent, [] ) ).toBe( false );
		expect( await isBundledFolder( path.join( scripts, '..', '..', '..' ), [] ) ).toBe( false );
		expect( await isBundledFolder( 'skills/taxonomist/scripts', [] ) ).toBe( false );
		// Bundled files a conversation could reach would be no longer Studio's own.
		expect( await isBundledFolder( scripts, [ path.dirname( scripts ) ] ) ).toBe( false );
	} );
} );

describe( 'site_create on the Claude route', () => {
	const ONE_SITE = 'A conversation works on one site';
	// A global conversation, on a host whose app shows the conversation and
	// follows the site the agent creates.
	async function setupGlobal( overrides: Partial< ClaudeExecutionContext > = {} ) {
		const fixture = await setup( ( paths ) => ( {
			target: { environment: 'global' },
			targetSite: undefined,
			workspace: { siteId: null, workingDirectory: paths.parent, configDirectory: paths.config },
			localRoots: [ paths.parent ],
			...overrides,
		} ) );
		const created = path.join( fixture.parent, 'my-coffee-shop' );
		const site = {
			id: 'new-site',
			name: 'My Coffee Shop',
			path: created,
			url: 'http://localhost:8890',
			phpVersion: '8.4',
			adminPassword: 'password',
		};
		// The host knows the site this turn creates, and another site, `other`,
		// that was there before.
		fixture.host.sites.resolve = vi.fn( async ( reference: string ) =>
			reference === 'other' ? fixture.otherSite : site
		);
		fixture.host.sites.findByFolder = vi.fn( async ( folder: string ) =>
			path.resolve( folder ) === created ? site : undefined
		);
		fixture.host.sites.create = vi.fn( async ( _name: string, folder: string ) => {
			await mkdir( folder, { recursive: true } );
		} );
		const ui = { showArtifact: vi.fn(), reloadPreview: vi.fn() };
		fixture.host.ui = ui;
		// The conversation's stored target, as the turn's checks read it.
		const stored = { target: { environment: 'global' } as ClaudeStudioTarget };
		fixture.host.selectSite = vi.fn( async ( selected: { id?: string } ) => {
			stored.target = { environment: 'local', siteId: selected.id! };
		} );
		vi.mocked( fixture.context.verifyTarget ).mockImplementation( async ( expected ) =>
			isSameClaudeTarget( expected, stored.target )
		);
		await writeFile( path.join( fixture.parent, 'notes.md' ), 'fixture' );
		const bridge = createStudioClaudeToolBridge(
			fixture.host,
			{ runId: 'run', turnId: 'turn', policy: fixture.policy },
			() => {}
		);
		cleanups.push( () => bridge.dispose() );
		const read = () =>
			fixture.policy.authorizeToolUse( {
				toolName: 'Read',
				input: { file_path: path.join( fixture.parent, 'notes.md' ) },
				toolUseId: randomUUID(),
			} );
		return { ...fixture, bridge, created, site, ui, stored, read };
	}

	it( 'creates a site from a global conversation and makes it the conversation’s site, unprompted, journaling each change before it is made', async () => {
		const { bridge, host, journal, created, site, ui, stored, context } = await setupGlobal();
		expect( bridge.tools ).toContain( 'site_create' );
		const order: string[] = [];
		const record = context.recordOperation;
		context.recordOperation = async ( event ) => {
			order.push( `journal ${ event.operation.tool }` );
			await record( event );
		};
		vi.mocked( host.sites.create ).mockImplementation( async () => {
			order.push( 'host sites.create' );
		} );
		const select = vi.mocked( host.selectSite! );
		const selecting = select.getMockImplementation()!;
		select.mockImplementation( async ( selected ) => {
			order.push( 'host selectSite' );
			await selecting( selected );
		} );
		ui.showArtifact.mockImplementation( async () => {
			order.push( 'host ui.showArtifact' );
		} );
		const result = await bridge.invoke( 'site_create', { name: 'My Coffee Shop' } );
		expect( result.isError ).toBe( false );
		expect( order ).toEqual( [
			'journal site_create',
			'journal sites.create',
			'host sites.create',
			'journal selectSite',
			'host selectSite',
			'journal ui.showArtifact',
			'host ui.showArtifact',
		] );
		expect( JSON.parse( text( result ) ) ).toMatchObject( { id: 'new-site', path: created } );
		expect( host.sites.create ).toHaveBeenCalledWith(
			'My Coffee Shop',
			created,
			expect.any( Function ),
			expect.objectContaining( { beforeSpawn: expect.any( Function ) } )
		);
		expect( host.selectSite ).toHaveBeenCalledWith( expect.objectContaining( { id: site.id } ) );
		expect( stored.target ).toEqual( { environment: 'local', siteId: site.id } );
		expect( ui.showArtifact ).toHaveBeenCalledWith(
			expect.objectContaining( {
				widgets: [ expect.objectContaining( { type: 'site-preview' } ) ],
			} )
		);
		expect( context.approve ).not.toHaveBeenCalled();
		expect( journaled( journal ) ).toEqual( [
			[ 'site_create', 'local-change' ],
			[ 'sites.create', 'local-change' ],
			[ 'selectSite', 'local-change' ],
			[ 'ui.showArtifact', 'local-change' ],
		] );
		expect( JSON.stringify( journal ) ).not.toContain( created );
	} );

	it( 'keeps the turn when a check runs while the selection is written, and stops it for a target the turn did not set', async () => {
		const { bridge, context, stored, policy, read } = await setupGlobal();
		// A check that starts before the selection and reads the stored target
		// after it is written (carry item 7).
		let release!: () => void;
		const written = new Promise< void >( ( resolve ) => {
			release = resolve;
		} );
		vi.mocked( context.verifyTarget ).mockImplementationOnce( async ( expected ) => {
			await written;
			return isSameClaudeTarget( expected, stored.target );
		} );
		const checks = vi.mocked( context.verifyTarget ).mock.calls.length;
		const alongside = read();
		await vi.waitFor( () =>
			expect( vi.mocked( context.verifyTarget ).mock.calls.length ).toBe( checks + 1 )
		);
		const result = bridge.invoke( 'site_create', { name: 'My Coffee Shop' } );
		await vi.waitFor( () =>
			expect( stored.target ).toEqual( { environment: 'local', siteId: 'new-site' } )
		);
		release();
		expect( ( await result ).isError ).toBe( false );
		expect( await alongside ).toBe( true );
		expect( policy.signal.aborted ).toBe( false );
		expect( await read() ).toBe( true );
		// The conversation moved to a target this turn did not set.
		stored.target = { environment: 'local', siteId: 'other-site' };
		expect( await read() ).toBe( false );
		expect( policy.signal.aborted ).toBe( true );
	} );

	it( 'keeps the turn when a check reads the new target before the selection lands and the old one after, by checking again once the write has settled', async () => {
		const { bridge, host, context, stored, policy, read } = await setupGlobal();
		// The selection's write lands, then takes a while to report back.
		let land!: () => void;
		let finish!: () => void;
		const landing = new Promise< void >( ( resolve ) => {
			land = resolve;
		} );
		const finishing = new Promise< void >( ( resolve ) => {
			finish = resolve;
		} );
		let landed!: () => void;
		const written = new Promise< void >( ( resolve ) => {
			landed = resolve;
		} );
		host.selectSite = vi.fn( async ( selected: { id?: string } ) => {
			await landing;
			stored.target = { environment: 'local', siteId: selected.id! };
			landed();
			await finishing;
		} );
		const result = bridge.invoke( 'site_create', { name: 'My Coffee Shop' } );
		await vi.waitFor( () => expect( host.selectSite ).toHaveBeenCalled() );
		// One check, while the write is in flight: it reads the new target before
		// the write lands and the old one after.
		let racing = true;
		vi.mocked( context.verifyTarget ).mockImplementation( async ( expected ) => {
			const before = stored.target;
			if ( racing && expected.environment === 'global' ) {
				land();
				await written;
				return isSameClaudeTarget( expected, stored.target );
			}
			return isSameClaudeTarget( expected, before );
		} );
		const alongside = read();
		await written;
		// The check settles what it can before the write reports back.
		await new Promise( ( resolve ) => setTimeout( resolve, 10 ) );
		racing = false;
		finish();
		expect( await alongside ).toBe( true );
		expect( ( await result ).isError ).toBe( false );
		expect( policy.signal.aborted ).toBe( false );
		expect( await read() ).toBe( true );
	} );

	it( 'keeps both targets when the selection fails, since its write may or may not have landed, and stops the turn for any other', async () => {
		const { bridge, host, stored, policy, read, journal } = await setupGlobal();
		host.selectSite = vi.fn( async ( selected: { id?: string } ) => {
			stored.target = { environment: 'local', siteId: selected.id! };
			throw new Error( 'The disk is full' );
		} );
		const result = await bridge.invoke( 'site_create', { name: 'My Coffee Shop' } );
		expect( result.isError ).toBe( true );
		expect( journaled( journal ) ).toContainEqual( [ 'selectSite', 'local-change' ] );
		expect( await read() ).toBe( true );
		stored.target = { environment: 'global' };
		expect( await read() ).toBe( true );
		expect( policy.signal.aborted ).toBe( false );
		stored.target = { environment: 'local', siteId: 'other-site' };
		expect( await read() ).toBe( false );
		expect( policy.signal.aborted ).toBe( true );
	} );

	it( 'after a recovery that left operations uncertain, asks before it creates, selects and shows the site, each approval showing the site’s folder', async () => {
		const { bridge, host, context, journal, created, stored } = await setupGlobal( {
			uncertainAfterRecovery: true,
		} );
		const result = await bridge.invoke( 'site_create', { name: 'My Coffee Shop' } );
		expect( result.isError ).toBe( false );
		const requests = vi.mocked( context.approve ).mock.calls.map( ( [ request ] ) => request );
		expect( requests.map( ( request ) => request.operation.tool ) ).toEqual( [
			'sites.create',
			'selectSite',
			'ui.showArtifact',
		] );
		for ( const request of requests ) {
			expect( request.operation.operationClass ).toBe( 'local-change' );
			expect( request.operation.localPaths ).toEqual( [ created ] );
			expect( request.operation.description ).toContain( 'may already have taken effect' );
		}
		expect( host.selectSite ).toHaveBeenCalledOnce();
		expect( stored.target ).toEqual( { environment: 'local', siteId: 'new-site' } );
		// Each change runs under its own approval, which the journal names.
		expect( journal.slice( 1 ).map( ( entry ) => entry.requestId ) ).toEqual(
			requests.map( ( request ) => request.requestId )
		);
	} );

	it( 'after such a recovery, leaves the conversation’s site as it was when the user denies the selection, and journals nothing for it', async () => {
		const { bridge, host, journal, ui, stored, policy } = await setupGlobal( {
			uncertainAfterRecovery: true,
			approve: vi.fn( async ( request: ClaudeApprovalRequest ) =>
				request.operation.tool === 'selectSite' ? ( 'deny' as const ) : ( 'allow' as const )
			),
		} );
		const result = await bridge.invoke( 'site_create', { name: 'My Coffee Shop' } );
		expect( result.isError ).toBe( true );
		expect( text( result ) ).toContain( 'The user did not approve this operation' );
		expect( host.sites.create ).toHaveBeenCalledOnce();
		expect( host.selectSite ).not.toHaveBeenCalled();
		expect( ui.showArtifact ).not.toHaveBeenCalled();
		expect( stored.target ).toEqual( { environment: 'global' } );
		expect( journaled( journal ) ).toEqual( [
			[ 'site_create', 'local-change' ],
			[ 'sites.create', 'local-change' ],
		] );
		expect( policy.signal.aborted ).toBe( false );
	} );

	it( 'after such a recovery, checks the site again once the user has answered, and selects nothing the host no longer knows', async () => {
		const fixture = await setupGlobal( { uncertainAfterRecovery: true } );
		vi.mocked( fixture.context.approve ).mockImplementation( async ( request ) => {
			// The site is removed while the user reads the selection's approval.
			if ( request.operation.tool === 'selectSite' )
				vi.mocked( fixture.host.sites.findByFolder ).mockResolvedValue( undefined );
			return 'allow';
		} );
		const result = await fixture.bridge.invoke( 'site_create', { name: 'My Coffee Shop' } );
		expect( result.isError ).toBe( true );
		expect( fixture.host.selectSite ).not.toHaveBeenCalled();
		expect( journaled( fixture.journal ) ).not.toContainEqual( [ 'selectSite', 'local-change' ] );
	} );

	it( 'creates nothing from a site conversation, says why, and journals nothing', async () => {
		const { bridge, host, journal } = await setup();
		const result = await bridge.invoke( 'site_create', { name: 'My Coffee Shop' } );
		expect( result.isError ).toBe( true );
		expect( text( result ) ).toContain( ONE_SITE );
		expect( host.sites.create ).not.toHaveBeenCalled();
		expect( journal ).toEqual( [] );
	} );

	it( 'works on the site it created once that site is the conversation’s site, each tool under its own class, and on no other site', async () => {
		const { bridge, host, context, journal, site, created } = await setupGlobal();
		const onCreated = { nameOrPath: site.name };
		// Before the site exists, nothing acts on it.
		expect( ( await bridge.invoke( 'site_info', onCreated ) ).isError ).toBe( true );
		expect( ( await bridge.invoke( 'site_create', { name: site.name } ) ).isError ).toBe( false );
		journal.length = 0;

		const info = await bridge.invoke( 'site_info', onCreated );
		expect( info.isError ).toBe( false );
		expect( host.sites.status ).toHaveBeenCalledWith( site );
		const read = await bridge.invoke( 'wp_cli', {
			...onCreated,
			command: 'option get blogname',
		} );
		expect( read.isError ).toBe( false );
		expect( host.sites.wpCli ).toHaveBeenLastCalledWith(
			site,
			expect.arrayContaining( [ 'option', 'get', 'blogname' ] ),
			expect.objectContaining( { beforeSpawn: expect.any( Function ) } )
		);
		expect( ( await bridge.invoke( 'site_start', onCreated ) ).isError ).toBe( false );
		expect( host.sites.start ).toHaveBeenCalledWith(
			site,
			expect.any( Function ),
			expect.objectContaining( { beforeSpawn: expect.any( Function ) } )
		);
		expect( context.approve ).not.toHaveBeenCalled();
		// A command asks, as on the conversation's own site, and its approval
		// names the site it now works on.
		const draft = await bridge.invoke( 'wp_cli', {
			...onCreated,
			command: 'post create --post_status=draft --post_title=Hello',
		} );
		expect( draft.isError ).toBe( false );
		const [ request ] = vi.mocked( context.approve ).mock.calls[ 0 ];
		expect( request.target ).toEqual( { environment: 'local', siteId: site.id } );
		expect( request.operation.localPaths ).toEqual( [ created ] );
		expect( journaled( journal ) ).toEqual( [
			[ 'site_start', 'local-change' ],
			[ 'sites.start', 'local-change' ],
			[ 'wp_cli', 'command' ],
			[ 'sites.wpCli', 'command' ],
		] );

		// Another site the host knows is still out of reach.
		expect( ( await bridge.invoke( 'site_start', { nameOrPath: 'other' } ) ).isError ).toBe( true );
		expect( ( await bridge.invoke( 'site_info', { nameOrPath: 'other' } ) ).isError ).toBe( true );
		expect( host.sites.start ).toHaveBeenCalledOnce();
		expect( host.sites.status ).toHaveBeenCalledOnce();
	} );

	it( 'acts on no site it created before that site’s selection has landed', async () => {
		const { bridge, host, site } = await setupGlobal();
		let land!: () => void;
		const landing = new Promise< void >( ( resolve ) => {
			land = resolve;
		} );
		const select = vi.mocked( host.selectSite! );
		const selecting = select.getMockImplementation()!;
		select.mockImplementation( async ( selected ) => {
			await landing;
			await selecting( selected );
		} );
		const creating = bridge.invoke( 'site_create', { name: site.name } );
		await vi.waitFor( () => expect( host.selectSite ).toHaveBeenCalled() );
		expect( ( await bridge.invoke( 'site_info', { nameOrPath: site.name } ) ).isError ).toBe(
			true
		);
		expect( host.sites.status ).not.toHaveBeenCalled();
		land();
		expect( ( await creating ).isError ).toBe( false );
		expect( ( await bridge.invoke( 'site_info', { nameOrPath: site.name } ) ).isError ).toBe(
			false
		);
	} );

	it( 'creates no second site in the turn that made one the conversation’s site, says why, and journals nothing for it', async () => {
		const { bridge, host, journal } = await setupGlobal();
		expect( ( await bridge.invoke( 'site_create', { name: 'My Coffee Shop' } ) ).isError ).toBe(
			false
		);
		const before = journal.length;
		const second = await bridge.invoke( 'site_create', { name: 'Another Shop' } );
		expect( second.isError ).toBe( true );
		expect( text( second ) ).toContain( ONE_SITE );
		expect( host.sites.create ).toHaveBeenCalledOnce();
		expect( journal ).toHaveLength( before );
	} );

	it( 'makes no other site the conversation’s site', async () => {
		const { policy, host, site } = await setupGlobal();
		const guarded = policy.guardHost( host, 'call' );
		await expect(
			guarded.selectSite!( { id: site.id, name: site.name, path: site.path, running: true } )
		).rejects.toThrow( 'Denied' );
		await guarded.sites.create( site.name, site.path, () => {} );
		await expect(
			guarded.selectSite!( { id: 'forged', name: site.name, path: site.path, running: true } )
		).rejects.toThrow( 'Denied' );
		expect( host.selectSite ).not.toHaveBeenCalled();
	} );
} );

describe( 'a site binding Studio refuses', () => {
	it( 'is said to the model with the result of the call that asked for it', async () => {
		const fixture = await createPolicyFixture();
		cleanups.push( fixture.cleanup );
		fixture.host.ui = { showArtifact: vi.fn(), reloadPreview: vi.fn() };
		// The conversation's own site, shown as a created site would be: the run
		// manager would bind the conversation to it.
		const guarded = fixture.policy.guardHost( fixture.host, 'call' );
		await expect(
			guarded.ui!.showArtifact( {
				version: 1,
				id: 'binding',
				widgets: [
					{
						type: 'site-preview',
						widgetProps: {
							path: '/',
							siteId: fakeSite.id,
							siteName: fakeSite.name,
							sitePath: fixture.site,
						},
					},
				],
			} as never )
		).rejects.toThrow( 'Denied' );
		expect( fixture.host.ui.showArtifact ).not.toHaveBeenCalled();
		expect( fixture.policy.takeRefusals( 'call' ) ).toEqual( [
			expect.stringContaining( 'did not make that site this conversation’s site' ),
		] );
	} );
} );
