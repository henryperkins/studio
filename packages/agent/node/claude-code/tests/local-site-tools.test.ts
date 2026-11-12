import { existsSync, readdirSync } from 'fs';
import { mkdir, rename, symlink, writeFile } from 'fs/promises';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSkillPath } from '../../skills';
import { fakeSite } from '../../tests/fake-host';
import { isBundledFolder } from '../local-paths';
import { createStudioClaudeToolBridge } from '../tool-bridge';
import { createPolicyFixture } from './fixtures/execution-policy';

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
