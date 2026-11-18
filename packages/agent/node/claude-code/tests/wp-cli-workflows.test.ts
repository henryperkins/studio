import { lstat, mkdir, symlink, writeFile } from 'fs/promises';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStudioClaudeToolBridge } from '../tool-bridge';
import { inspectWpCliArgs, wpCliRouteCommands } from '../wp-cli-rules';
import { createPolicyFixture } from './fixtures/execution-policy';
import type { ClaudeApprover } from '../execution-policy';

const cleanups: Array< () => Promise< void > > = [];
afterEach( async () => {
	await Promise.all( cleanups.splice( 0 ).map( ( cleanup ) => cleanup() ) );
	vi.unstubAllEnvs();
} );

async function setup( recovery = false, answer: ClaudeApprover = async () => 'allow' ) {
	const approve = vi.fn( answer );
	const fixture = await createPolicyFixture( () => ( {
		uncertainAfterRecovery: recovery,
		approve,
	} ) );
	vi.stubEnv( 'HOME', fixture.parent );
	vi.stubEnv( 'USERPROFILE', fixture.parent );
	const bridge = createStudioClaudeToolBridge(
		fixture.host,
		{ runId: 'run', turnId: 'turn', policy: fixture.policy },
		() => {}
	);
	cleanups.push( async () => {
		await bridge.dispose();
		await fixture.cleanup();
	} );
	const wpCli = vi.mocked( fixture.host.sites.wpCli );
	wpCli.mockImplementation( async ( _site, _args, options ) => {
		await options?.beforeSpawn?.();
		return { exitCode: 0, stdout: 'Ran', stderr: '' };
	} );
	const invoke = ( command: string, nameOrPath = 'site' ) =>
		bridge.invoke( 'wp_cli', { nameOrPath, command } );
	return { ...fixture, invoke, approve, wpCli };
}

describe( 'WP-CLI on the Claude route', () => {
	it.each( wpCliRouteCommands().map( ( row ) => [ row.usage, row ] as const ) )(
		'runs the documented example for %s through the shared tool',
		async ( _usage, row ) => {
			const { site, localSite, invoke, wpCli, approve, journal } = await setup();
			const detail = inspectWpCliArgs( row.example );
			if ( 'refusal' in detail ) throw new Error( detail.refusal );
			expect( detail.known ).toBe( true );
			expect( detail.operationClass ).toBe( row.operationClass );
			const expected = [ ...row.example ];
			const paths: string[] = [];
			for ( const binding of detail.files ) {
				const prefix = binding.prefix ?? '';
				const filename = expected[ binding.index ].slice( prefix.length );
				const file = path.resolve( site, filename );
				expect( file.startsWith( site + path.sep ) ).toBe( true );
				if ( binding.reservedPath ) {
					await expect( lstat( file ) ).rejects.toMatchObject( { code: 'ENOENT' } );
					continue;
				}
				if ( binding.kind === 'directory' || binding.kind === 'write-directory' ) {
					await mkdir( file, { recursive: true } );
				} else {
					await mkdir( path.dirname( file ), { recursive: true } );
					if ( binding.kind === 'read' ) await writeFile( file, 'fixture' );
				}
				paths.push( file );
				expected[ binding.index ] = prefix + file;
			}
			const command = row.example
				.map( ( arg ) =>
					arg.startsWith( '--post_content=' ) || /\s/.test( arg ) ? "'" + arg + "'" : arg
				)
				.join( ' ' );
			const result = await invoke( command );
			expect( result.isError, JSON.stringify( result.content ) ).toBe( false );
			expect( wpCli ).toHaveBeenCalledExactlyOnceWith(
				localSite,
				[ ...expected, '--skip-packages' ],
				expect.anything()
			);
			if ( row.operationClass === 'command' || row.operationClass === 'local-overwrite' ) {
				expect( approve ).toHaveBeenCalledOnce();
				expect( approve.mock.calls[ 0 ][ 0 ].operation ).toMatchObject( {
					args: expected,
					siteId: localSite.id,
					operationClass: row.operationClass,
					localPaths: expect.arrayContaining( [ site, ...paths ] ),
				} );
			} else {
				expect( approve ).not.toHaveBeenCalled();
			}
			expect( journal.map( ( event ) => event.operation.operationClass ) ).toEqual(
				row.operationClass === 'read' ? [] : [ row.operationClass, row.operationClass ]
			);
		}
	);

	it.each( [ 'skip', 'create' ] )(
		'keeps the import authors keyword %s literal and checks it again before spawn',
		async ( keyword ) => {
			const { site, invoke, wpCli, approve } = await setup();
			const source = path.join( site, 'site.xml' );
			const authorFlag = '--authors=' + keyword;
			const command = 'import site.xml ' + authorFlag;
			await writeFile( source, 'fixture' );
			expect( ( await invoke( command ) ).isError ).toBe( false );
			expect( wpCli.mock.calls[ 0 ][ 1 ] ).toEqual( [
				'import',
				source,
				authorFlag,
				'--skip-packages',
			] );
			const spawned = vi.fn();
			wpCli.mockImplementationOnce( async ( _site, _args, options ) => {
				await writeFile( path.join( site, keyword ), 'fixture author map' );
				await options?.beforeSpawn?.();
				spawned();
				return { exitCode: 0, stdout: '', stderr: '' };
			} );
			expect( ( await invoke( command ) ).isError ).toBe( true );
			expect( spawned ).not.toHaveBeenCalled();
			expect( approve ).toHaveBeenCalledTimes( 2 );
			expect( ( await invoke( command ) ).isError ).toBe( true );
			expect( approve ).toHaveBeenCalledTimes( 2 );
			expect( wpCli ).toHaveBeenCalledTimes( 2 );
		}
	);

	it( 'runs the shipped content and plugin workflows with the intended journal class', async () => {
		const { site, localSite, wpCli, journal, approve, invoke } = await setup();
		const images = [ 'one image.jpg', 'another.png' ];
		for ( const name of images ) await writeFile( path.join( site, name ), 'fixture' );
		const read = await invoke( 'post list --post_type=attachment --post__in=2,3 --fields=ID,guid' );
		expect( read.isError ).toBe( false );
		expect( journal ).toHaveLength( 0 );
		for ( const command of [
			'plugin install woocommerce --activate',
			'theme activate studio-theme',
			'option update page_on_front 2',
			'media import "one image.jpg" another.png --porcelain',
		] ) {
			const start = journal.length;
			expect( ( await invoke( command ) ).isError, command ).toBe( false );
			expect( journal.slice( start ).map( ( event ) => event.operation ) ).toEqual( [
				expect.objectContaining( { tool: 'wp_cli', operationClass: 'local-change' } ),
				expect.objectContaining( { tool: 'sites.wpCli', operationClass: 'local-change' } ),
			] );
		}
		expect( wpCli.mock.lastCall ).toEqual( [
			localSite,
			[
				'media',
				'import',
				...images.map( ( name ) => path.join( site, name ) ),
				'--porcelain',
				'--skip-packages',
			],
			expect.anything(),
		] );
		expect( approve ).not.toHaveBeenCalled();
	} );

	it( 'shows the recovery draft and asks once for an ordinary change', async () => {
		const { localSite, invoke, approve, journal } = await setup( true );
		const draft = 'post create --post_status=draft --post_title=Hello --post_content="Draft text"';
		expect( ( await invoke( draft ) ).isError ).toBe( false );
		expect( approve ).toHaveBeenCalledOnce();
		expect( approve.mock.calls[ 0 ][ 0 ].operation ).toMatchObject( {
			siteId: localSite.id,
			operationClass: 'local-change',
			draft: { title: 'Hello', content: 'Draft text' },
		} );
		expect( journal.map( ( event ) => event.operation.operationClass ) ).toEqual( [
			'local-change',
			'local-change',
		] );
	} );

	it( 'accepts the concrete Jetpack and WooCommerce calls in Studio’s shipped procedures', async () => {
		const { invoke, approve, journal } = await setup();
		for ( const command of [
			'post list --post_type=wp_template,wp_template_part',
			'post list --post_type=attachment --field=ID',
			'plugin list --status=active --field=name',
			'jetpack module list',
			'term list category --format=json --fields=term_id,name,slug,description,count,parent',
		] ) {
			expect( ( await invoke( command ) ).isError, command ).toBe( false );
		}
		expect( journal ).toHaveLength( 0 );
		for ( const command of [
			'jetpack module activate seo-tools',
			'wc product_cat create --name="Single Origin" --user=admin',
			`wc product create --name="Premium Dog Food" --type=simple --regular_price=42 --status=publish --description="Sample product." --images='[{"id":2}]' --categories='[{"id":3}]' --user=admin`,
			'post meta update 5 _wp_page_template page-no-title',
			'post meta update 5 _wp_attachment_image_alt "A flower in bloom"',
		] ) {
			expect( ( await invoke( command ) ).isError, command ).toBe( false );
		}
		expect( approve ).not.toHaveBeenCalled();
		expect( new Set( journal.map( ( event ) => event.operation.operationClass ) ) ).toEqual(
			new Set( [ 'local-change' ] )
		);
	} );

	it( 'asks before an overwrite, an unknown command, and a named URL', async () => {
		const { invoke, wpCli, approve, journal, localSite } = await setup();
		for ( const [ command, operationClass ] of [
			[ 'post delete 5 --force', 'local-overwrite' ],
			[ 'studio-fixture inspect notes --format=json', 'command' ],
			[ 'media import https://example.invalid/image.png', 'command' ],
		] ) {
			const start = journal.length;
			expect( ( await invoke( command ) ).isError, command ).toBe( false );
			expect( approve.mock.lastCall?.[ 0 ].operation ).toMatchObject( {
				siteId: localSite.id,
				operationClass,
				args: command.split( ' ' ),
			} );
			expect( journal.slice( start ).map( ( event ) => event.operation.operationClass ) ).toEqual( [
				operationClass,
				operationClass,
			] );
		}
		expect( approve ).toHaveBeenCalledTimes( 3 );
		expect( wpCli ).toHaveBeenCalledTimes( 3 );
	} );

	it( 'passes the Taxonomist preview arguments to the checked script after approval', async () => {
		const { site, invoke, approve, wpCli } = await setup();
		const script = path.join( site, 'tmp', 'taxonomist', 'apply-changes.php' );
		const suggestions = 'taxonomist-data/results/suggestions.json';
		const log = 'taxonomist-data/logs/change.tsv';
		await mkdir( path.dirname( script ), { recursive: true } );
		await writeFile( script, '<?php // fixture' );
		await mkdir( path.dirname( path.join( site, suggestions ) ), { recursive: true } );
		await writeFile( path.join( site, suggestions ), '[]' );
		await mkdir( path.dirname( path.join( site, log ) ), { recursive: true } );
		const result = await invoke(
			`eval-file tmp/taxonomist/apply-changes.php ${ suggestions } ${ log } preview`
		);
		expect( result.isError ).toBe( false );
		expect( approve ).toHaveBeenCalledOnce();
		const approved = approve.mock.calls[ 0 ][ 0 ].operation;
		expect( approved ).toMatchObject( {
			operationClass: 'command',
			localPaths: expect.arrayContaining( [
				script,
				path.join( site, suggestions ),
				path.join( site, log ),
			] ),
		} );
		const ran = wpCli.mock.calls[ 0 ][ 1 ];
		expect( ran ).toEqual( [
			'eval-file',
			script,
			path.join( site, suggestions ),
			path.join( site, log ),
			'preview',
			'--skip-packages',
		] );
		expect( approved.args ).toEqual( ran.slice( 0, -1 ) );
	} );

	it( 'keeps an unrecognized option behind approval and honors denial', async () => {
		const { approve, invoke, wpCli, localSite, journal } = await setup( false, async () => 'deny' );
		expect( ( await invoke( 'post list --new-plugin-option=1' ) ).isError ).toBe( true );
		expect( approve.mock.lastCall?.[ 0 ].operation ).toMatchObject( {
			operationClass: 'command',
			args: [ 'post', 'list', '--new-plugin-option=1' ],
			siteId: localSite.id,
		} );
		expect( approve.mock.lastCall?.[ 0 ].operation.description ).toMatch( /check|review|unknown/i );
		expect( wpCli ).not.toHaveBeenCalled();
		expect( journal.some( ( event ) => event.operation.tool === 'sites.wpCli' ) ).toBe( false );
	} );

	it( 'refuses out-of-site files and site redirects even in a command needing approval', async () => {
		const { site, other, invoke, approve, wpCli } = await setup();
		await writeFile( path.join( other, 'page.html' ), 'fixture' );
		await symlink( other, path.join( site, 'linked' ), 'junction' );
		for ( const command of [
			'post create ../other/page.html',
			'post update 2 linked/page.html',
			'media import linked/page.html --new-plugin-option',
			'post list -- --url=https://example.invalid',
			'studio-fixture inspect --ssh=example.invalid',
		] ) {
			expect( ( await invoke( command ) ).isError, command ).toBe( true );
		}
		expect( ( await invoke( 'plugin list', 'other' ) ).isError ).toBe( true );
		expect( approve ).not.toHaveBeenCalled();
		expect( wpCli ).not.toHaveBeenCalled();
	} );
} );
