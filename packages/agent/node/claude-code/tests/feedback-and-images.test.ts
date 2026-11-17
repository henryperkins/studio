import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { readAuthToken } from '@studio/common/lib/shared-config';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateImages, resolveImageService } from '@studio/agent/node/image-generation';
import { reserveAttachmentsArgs } from '../../tools/media-library';
import { createStudioClaudeToolBridge } from '../tool-bridge';
import { createPolicyFixture } from './fixtures/execution-policy';
import type { StudioAgentHost } from '../../host';

// The two tools that send or generate, each driven through the real execution
// policy and the bridge the SDK calls, against a fake host whose operations
// are spies. Nothing here leaves the machine: the feedback service's MCP
// client and transport are stand-ins that record what they would send, as in
// `node/tests/send-feedback.test.ts`; the image service's requests are a
// stand-in that records each prompt and answers with fixed bytes, as in
// `node/tests/tools.test.ts`; and the stored login is a test value whose file
// lies in a configuration folder of this test's own.

const config = vi.hoisted( () => ( { root: '' } ) );
const feedback = vi.hoisted( () => ( {
	transports: [] as Array< { url: string; options: unknown } >,
	calls: [] as unknown[],
	answer: {} as Record< string, unknown >,
} ) );

vi.mock( '@studio/common/lib/well-known-paths', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/common/lib/well-known-paths') >();
	const nodePath = await import( 'path' );
	return {
		...actual,
		getConfigDirectory: () => config.root,
		getSharedConfigPath: () => nodePath.join( config.root, 'shared.json' ),
	};
} );

vi.mock( '@studio/common/lib/shared-config', async ( importOriginal ) => ( {
	...( await importOriginal< object >() ),
	readAuthToken: vi.fn(),
} ) );

vi.mock( '@studio/agent/node/image-generation', async ( importOriginal ) => ( {
	...( await importOriginal< object >() ),
	resolveImageService: vi.fn(),
	generateImages: vi.fn(),
} ) );

vi.mock( '@modelcontextprotocol/sdk/client/index.js', () => ( {
	Client: class {
		async connect() {}
		async callTool( request: unknown ) {
			feedback.calls.push( request );
			return feedback.answer;
		}
		async close() {}
	},
} ) );
vi.mock( '@modelcontextprotocol/sdk/client/streamableHttp.js', () => ( {
	StreamableHTTPClientTransport: class {
		constructor( url: URL, options: unknown ) {
			feedback.transports.push( { url: url.toString(), options } );
		}
	},
} ) );

const LOGIN = {
	accessToken: 'test-login-token',
	id: 7,
	displayName: 'Test Person',
	email: 'person@example.test',
	expirationTime: Number.MAX_SAFE_INTEGER,
};

beforeAll( async () => {
	config.root = await realpath(
		await mkdtemp( path.join( os.tmpdir(), 'studio-claude-config-' ) )
	);
} );
afterAll( async () => {
	await rm( config.root, { recursive: true, force: true } );
} );

// The image service signed in with the stored login, which names its account.
const IMAGE_SERVICE = {
	token: LOGIN.accessToken,
	use: {
		service: 'wordpress-com' as const,
		credential: 'wordpress-com-login' as const,
		account: { displayName: LOGIN.displayName, email: LOGIN.email },
	},
};
const PNG = Buffer.from( [ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3 ] );

beforeEach( () => {
	vi.mocked( readAuthToken )
		.mockReset()
		.mockResolvedValue( LOGIN as never );
	vi.mocked( resolveImageService ).mockReset().mockResolvedValue( IMAGE_SERVICE );
	vi.mocked( generateImages )
		.mockReset()
		.mockImplementation( async ( _userAgent, _token, requests ) =>
			requests.map( () => ( { ok: true, bytes: PNG } ) )
		);
	feedback.transports.length = 0;
	feedback.calls.length = 0;
	feedback.answer = {
		content: [ { type: 'text', text: 'Thanks!' } ],
		structuredContent: { status: 'success', feedback_id: 42 },
	};
} );

const cleanups: Array< () => Promise< void > > = [];
afterEach( async () => {
	await Promise.all( cleanups.splice( 0 ).map( ( cleanup ) => cleanup() ) );
} );

async function setupWith(
	capabilities: { imageGeneration?: boolean },
	...args: Parameters< typeof createPolicyFixture >
) {
	const fixture = await createPolicyFixture( ...args );
	cleanups.push( fixture.cleanup );
	const bridge = createStudioClaudeToolBridge(
		fixture.host,
		{ runId: 'run', turnId: 'turn', policy: fixture.policy },
		() => {},
		capabilities
	);
	cleanups.push( () => bridge.dispose() );
	return { ...fixture, bridge };
}
const setup = ( ...args: Parameters< typeof createPolicyFixture > ) => setupWith( {}, ...args );
// A turn that found Studio's image service, as the runtime resolves it.
const setupImages = ( ...args: Parameters< typeof createPolicyFixture > ) =>
	setupWith( { imageGeneration: true }, ...args );

// A conversation without a site, as a global chat starts.
const global = ( paths: { parent: string; config: string } ) => ( {
	target: { environment: 'global' as const },
	targetSite: undefined,
	workspace: { siteId: null, workingDirectory: paths.parent, configDirectory: paths.config },
	localRoots: [ paths.parent ],
} );

const text = ( result: { content: Array< { type: string; text?: string } > } ) =>
	result.content.map( ( part ) => part.text ?? '' ).join( '\n' );

describe( 'send_feedback on the Claude route', () => {
	const report = { type: 'bug', message: 'The preview froze after the zebra theme loaded.' };
	const sent = {
		name: 'wpcom-mcp-send-feedback',
		arguments: {
			action: 'submit',
			type: 'bug',
			content: `[WordPressStudio/test on ${ process.platform }]\n\n${ report.message }`,
		},
	};

	it( 'sends the report once the user approves it, seeing its type and message and told what goes with them and where, never the login', async () => {
		const { bridge, context, journal, events } = await setup();
		expect( bridge.tools ).toContain( 'send_feedback' );
		const result = await bridge.invoke( 'send_feedback', report );
		expect( result.isError ).toBe( false );
		expect( text( result ) ).toBe( 'Feedback sent. Feedback ID: 42.' );

		expect( context.approve ).toHaveBeenCalledOnce();
		const [ request ] = vi.mocked( context.approve ).mock.calls[ 0 ];
		expect( request.operation ).toMatchObject( {
			tool: 'send_feedback',
			operationClass: 'external-message',
			args: report,
			localPaths: [],
		} );
		expect( request.operation.description ).toContain( 'Send a message outside Studio' );
		expect( request.operation.description ).toContain( 'Studio version and operating system' );
		expect( request.operation.description ).toContain( 'WordPress Studio team' );
		const shown = JSON.stringify(
			events.filter( ( event ) => event.type === 'approval.requested' )
		);
		expect( shown ).toContain( report.message );
		for ( const secret of [ LOGIN.accessToken, LOGIN.email, LOGIN.displayName ] )
			expect( shown ).not.toContain( secret );

		// What leaves the machine: the report as shown, with the line naming
		// Studio's version and operating system, to the feedback service's fixed
		// address, signed in with the stored login.
		expect( feedback.transports ).toEqual( [
			{
				url: 'https://public-api.wordpress.com/wpcom/v2/mcp/v1',
				options: {
					requestInit: {
						headers: {
							authorization: `Bearer ${ LOGIN.accessToken }`,
							'user-agent': 'WordPressStudio/test',
						},
					},
				},
			},
		] );
		expect( feedback.calls ).toEqual( [ sent ] );

		// Journaled before it was sent, under its approval, with neither the
		// message nor the login.
		expect( journal ).toEqual( [
			expect.objectContaining( {
				requestId: request.requestId,
				operation: {
					tool: 'send_feedback',
					operationClass: 'external-message',
					target: context.target,
				},
			} ),
		] );
		for ( const secret of [ report.message, LOGIN.accessToken, LOGIN.email, LOGIN.displayName ] )
			expect( JSON.stringify( journal ) ).not.toContain( secret );
	} );

	it( 'sends a report from a conversation without a site too', async () => {
		const { bridge, context } = await setup( global );
		expect( ( await bridge.invoke( 'send_feedback', report ) ).isError ).toBe( false );
		expect( context.approve ).toHaveBeenCalledOnce();
		expect( feedback.calls ).toEqual( [ sent ] );
	} );

	it( 'sends nothing the user denies, says so, and journals nothing', async () => {
		const { bridge, journal } = await setup( () => ( {
			approve: vi.fn( async () => 'deny' as const ),
		} ) );
		const result = await bridge.invoke( 'send_feedback', report );
		expect( result.isError ).toBe( true );
		expect( text( result ) ).toContain( 'The user did not approve this operation' );
		expect( feedback.transports ).toEqual( [] );
		expect( feedback.calls ).toEqual( [] );
		expect( readAuthToken ).not.toHaveBeenCalled();
		expect( journal ).toEqual( [] );
	} );

	it( 'reads no stored login that lies in a folder the turn reaches, and asks nothing', async () => {
		const { bridge, context, journal } = await setup( ( paths ) => ( {
			localRoots: [ paths.site, config.root ],
		} ) );
		expect( ( await bridge.invoke( 'send_feedback', report ) ).isError ).toBe( true );
		expect( context.approve ).not.toHaveBeenCalled();
		expect( readAuthToken ).not.toHaveBeenCalled();
		expect( feedback.calls ).toEqual( [] );
		expect( journal ).toEqual( [] );
	} );

	it( 'asks nothing and sends nothing once the native account has changed', async () => {
		const { bridge, context, journal } = await setup( () => ( {
			verifyAccount: vi.fn( async () => 'changed' as const ),
		} ) );
		expect( ( await bridge.invoke( 'send_feedback', report ) ).isError ).toBe( true );
		expect( context.approve ).not.toHaveBeenCalled();
		expect( feedback.calls ).toEqual( [] );
		expect( journal ).toEqual( [] );
	} );

	it( 'asks once in a turn after a recovery that left operations uncertain, as in any turn', async () => {
		const { bridge, context } = await setup( () => ( { uncertainAfterRecovery: true } ) );
		expect( ( await bridge.invoke( 'send_feedback', report ) ).isError ).toBe( false );
		expect( context.approve ).toHaveBeenCalledOnce();
		expect( feedback.calls ).toEqual( [ sent ] );
	} );

	it( 'tells Claude only Studio’s fixed sentence when the service fails, never what it answered', async () => {
		feedback.answer = {
			isError: true,
			content: [ { type: 'text', text: `Rate limited for ${ LOGIN.email }` } ],
		};
		const { bridge } = await setup();
		const result = await bridge.invoke( 'send_feedback', report );
		expect( result.isError ).toBe( true );
		expect( text( result ) ).toBe( 'Studio operation denied or failed.' );
	} );
} );

describe( 'generate_images on the Claude route', () => {
	// What the journal recorded, tool by tool, in order.
	const journaled = ( journal: Array< { operation: { tool: string; operationClass: string } } > ) =>
		journal.map( ( entry ) => [ entry.operation.tool, entry.operation.operationClass ] );
	// The data a media-library command carries, as its PHP decodes it.
	const decoded = ( php: string ) =>
		JSON.parse(
			Buffer.from( /base64_decode\( '([^']+)' \)/.exec( php )![ 1 ], 'base64' ).toString()
		);
	const SITE_FILES = 'inside the folder of this conversation’s site';
	const UPLOADS_OUTSIDE = 'uploads folder';
	const ISOLATION = [ '--skip-packages', '--skip-plugins', '--skip-themes' ];

	// WordPress as a reservation finds it: this month's uploads folder, in the
	// site's own folder unless `folder` says otherwise, attachment IDs from 7.
	function reserving( host: StudioAgentHost, folder = 'wp-content/uploads/2026/11' ) {
		let next = 7;
		host.sites.wpCli = vi.fn( async ( _site, args ) => {
			const php = args[ 1 ] ?? '';
			if ( ! php.includes( 'wp_insert_attachment' ) )
				return { exitCode: 0, stdout: '', stderr: '' };
			const names = decoded( php ) as string[];
			return {
				exitCode: 0,
				stdout: JSON.stringify(
					names.map( ( name ) => ( {
						id: next++,
						file: `${ folder }/${ name }`,
						url: `http://localhost:8888/${ folder }/${ name }`,
					} ) )
				),
				stderr: '',
			};
		} );
	}

	it( 'is offered only to a turn that found Studio’s image service, as the Pi route offers it', async () => {
		const without = await setup();
		expect( without.bridge.tools ).not.toContain( 'generate_images' );
		const call = { images: [ { path: path.join( without.site, 'hero.png' ), subject: 'Hero' } ] };
		expect( ( await without.bridge.invoke( 'generate_images', call ) ).isError ).toBe( true );
		expect( generateImages ).not.toHaveBeenCalled();
		const withService = await setupImages();
		expect( withService.bridge.tools ).toContain( 'generate_images' );
	} );

	it( 'writes a theme image into the conversation’s site once the user approves the call, which shows the specs and paths and says what is sent where, never the credential, and returns nothing about the account', async () => {
		const { bridge, host, context, journal, events, site } = await setupImages();
		const file = path.join( site, 'wp-content', 'themes', 'acme', 'assets', 'images', 'band.png' );
		const args = {
			images: [ { path: file, subject: 'Pebbles on a beach' } ],
			siteContext: 'A seaside bakery.',
		};
		const result = await bridge.invoke( 'generate_images', args );
		expect( result.isError ).toBe( false );
		expect( text( result ) ).toContain( `- ${ file }` );
		expect( await readFile( file ) ).toEqual( PNG );

		expect( context.approve ).toHaveBeenCalledOnce();
		const [ request ] = vi.mocked( context.approve ).mock.calls[ 0 ];
		expect( request.operation ).toMatchObject( {
			tool: 'generate_images',
			operationClass: 'remote-change',
			args,
			localPaths: [ file ],
		} );
		expect( request.operation.description ).toContain( 'Studio’s image service on WordPress.com' );
		expect( request.operation.description ).toContain( 'wp-content/uploads' );

		// What leaves the machine: one prompt per image, made from its specs, to
		// the image service, signed in with its own credential.
		expect( generateImages ).toHaveBeenCalledWith( 'WordPressStudio/test', LOGIN.accessToken, [
			{ prompt: expect.stringContaining( 'Pebbles on a beach' ), aspectRatio: undefined },
		] );
		expect( journaled( journal ) ).toEqual( [ [ 'generate_images', 'remote-change' ] ] );
		expect( journal[ 0 ].requestId ).toBe( request.requestId );

		// Claude hears the content only: no account, no service record.
		expect( Object.keys( result ).sort() ).toEqual( [ 'content', 'isError' ] );
		const shown = JSON.stringify(
			events.filter( ( event ) => event.type === 'approval.requested' )
		);
		for ( const secret of [ LOGIN.accessToken, LOGIN.email, LOGIN.displayName ] ) {
			expect( JSON.stringify( result ), secret ).not.toContain( secret );
			expect( shown, secret ).not.toContain( secret );
			expect( JSON.stringify( journal ), secret ).not.toContain( secret );
		}
		expect( JSON.stringify( result ) ).not.toContain( 'wordpress-com' );
		expect( host.sites.wpCli ).not.toHaveBeenCalled();
		expect( host.sites.all ).not.toHaveBeenCalled();
	} );

	it( 'adds an image under the site’s wp-content/uploads to its media library through Studio’s own fixed WP-CLI commands, each journaled before it runs, with the site’s own code left out', async () => {
		const { bridge, host, journal, site, localSite } = await setupImages();
		reserving( host );
		vi.mocked( generateImages ).mockResolvedValueOnce( [
			{ ok: true, bytes: PNG },
			{ ok: false, error: 'Timed out' },
		] );
		const uploads = path.join( site, 'wp-content', 'uploads' );
		const result = await bridge.invoke( 'generate_images', {
			images: [
				{ path: path.join( uploads, 'hero.png' ), subject: 'A café counter at dawn' },
				{ path: path.join( uploads, 'buns.png' ), subject: 'Cardamom buns on a tray' },
			],
		} );
		expect( result.isError ).toBe( false );
		const written = path.join( uploads, '2026', '11', 'hero.png' );
		expect( text( result ) ).toContain(
			`- ${ written }, attachment ID 7, URL http://localhost:8888/wp-content/uploads/2026/11/hero.png`
		);
		expect( text( result ) ).toContain( `FAILED ${ path.join( uploads, 'buns.png' ) }: Timed out` );
		expect( await readFile( written ) ).toEqual( PNG );
		expect( existsSync( path.join( uploads, '2026', '11', 'buns.png' ) ) ).toBe( false );

		const calls = vi.mocked( host.sites.wpCli ).mock.calls;
		expect( calls ).toHaveLength( 2 );
		for ( const [ called, args, options ] of calls ) {
			expect( called ).toEqual( localSite );
			expect( args[ 0 ] ).toBe( 'eval' );
			expect( args.slice( 2 ) ).toEqual( ISOLATION );
			expect( options ).toEqual(
				expect.objectContaining( {
					signal: expect.any( AbortSignal ),
					beforeSpawn: expect.any( Function ),
				} )
			);
		}
		expect( calls[ 0 ][ 1 ][ 1 ] ).toContain( 'wp_insert_attachment' );
		expect( decoded( calls[ 0 ][ 1 ][ 1 ] ) ).toEqual( [ 'hero.png', 'buns.png' ] );
		expect( decoded( calls[ 1 ][ 1 ][ 1 ] ) ).toEqual( { ready: [ 7 ], failed: [ 8 ] } );
		expect( journaled( journal ) ).toEqual( [
			[ 'generate_images', 'remote-change' ],
			[ 'media.reserve', 'local-change' ],
			[ 'media.finalize', 'local-change' ],
		] );
		expect( JSON.stringify( journal ) ).not.toContain( site );
		expect( host.sites.all ).not.toHaveBeenCalled();
	} );

	it( 'writes no image outside the conversation’s site, by any path or link, says why, and asks, sends and journals nothing', async () => {
		const { bridge, host, context, journal, site, other, parent } = await setupImages();
		await mkdir( path.join( parent, 'outside' ) );
		await symlink( path.join( parent, 'outside' ), path.join( site, 'linked' ), 'junction' );
		const files = [
			path.join( other, 'hero.png' ),
			path.join( other, 'wp-content', 'uploads', 'hero.png' ),
			path.join( parent, 'hero.png' ),
			path.join( site, 'linked', 'hero.png' ),
			'hero.png',
		];
		for ( const file of files ) {
			const result = await bridge.invoke( 'generate_images', {
				images: [
					{ path: path.join( site, 'inside.png' ), subject: 'Inside' },
					{ path: file, subject: 'Hero' },
				],
			} );
			expect( result.isError, file ).toBe( true );
			expect( text( result ), file ).toContain( SITE_FILES );
			expect( text( result ), file ).not.toContain( parent );
		}
		const noSite = await setupImages( global );
		const anywhere = await noSite.bridge.invoke( 'generate_images', {
			images: [ { path: path.join( noSite.site, 'hero.png' ), subject: 'Hero' } ],
		} );
		expect( anywhere.isError ).toBe( true );
		expect( text( anywhere ) ).toContain( SITE_FILES );
		for ( const fixture of [ { context, host, journal }, noSite ] ) {
			expect( fixture.context.approve ).not.toHaveBeenCalled();
			expect( fixture.host.sites.wpCli ).not.toHaveBeenCalled();
			expect( fixture.journal ).toEqual( [] );
		}
		expect( generateImages ).not.toHaveBeenCalled();
		expect( existsSync( path.join( parent, 'outside', 'hero.png' ) ) ).toBe( false );
	} );

	it( 'adds nothing to a media library whose uploads folder lies outside the site: it deletes the attachments it reserved, says why and generates nothing', async () => {
		const { bridge, host, site, parent } = await setupImages();
		reserving( host, '../outside/uploads' );
		const result = await bridge.invoke( 'generate_images', {
			images: [ { path: path.join( site, 'wp-content', 'uploads', 'hero.png' ), subject: 'Hero' } ],
		} );
		expect( result.isError ).toBe( true );
		expect( text( result ) ).toContain( UPLOADS_OUTSIDE );
		expect( text( result ) ).not.toContain( parent );
		expect( generateImages ).not.toHaveBeenCalled();
		const calls = vi.mocked( host.sites.wpCli ).mock.calls;
		expect( calls ).toHaveLength( 2 );
		expect( decoded( calls[ 1 ][ 1 ][ 1 ] ) ).toEqual( { ready: [], failed: [ 7 ] } );
		expect( existsSync( path.join( parent, 'outside' ) ) ).toBe( false );
	} );

	it( 'still runs no eval through wp_cli, and completes or deletes only attachments the same call reserved in the conversation’s site, once each', async () => {
		const { bridge, host, policy, localSite, otherSite, other } = await setupImages();
		reserving( host );
		expect(
			( await bridge.invoke( 'wp_cli', { nameOrPath: 'site', command: "eval 'echo 1;'" } ) ).isError
		).toBe( true );
		const guarded = policy.guardHost( host, 'call' );
		await expect(
			guarded.sites.wpCli( localSite, reserveAttachmentsArgs( [ 'x.png' ] ) )
		).rejects.toThrow( 'Denied' );
		await expect( guarded.media!.finalize( localSite, [ 7 ], [] ) ).rejects.toThrow( 'Denied' );
		expect( host.sites.wpCli ).not.toHaveBeenCalled();

		for ( const names of [ [], [ '../x.png' ], [ 'x.php' ], [ 'sub/x.png' ], [ 7 ] ] )
			await expect(
				guarded.media!.reserve( localSite, names as string[] ),
				JSON.stringify( names )
			).rejects.toThrow( 'Denied' );
		await expect( guarded.media!.reserve( otherSite, [ 'x.png' ] ) ).rejects.toThrow( 'Denied' );
		await expect(
			guarded.media!.siteContaining( [ path.join( other, 'wp-content', 'uploads', 'x.png' ) ] )
		).rejects.toThrow( 'Denied' );
		expect( host.sites.wpCli ).not.toHaveBeenCalled();

		await expect( guarded.media!.reserve( localSite, [ 'x.png' ] ) ).resolves.toEqual( [
			expect.objectContaining( { id: 7 } ),
		] );
		const another = policy.guardHost( host, 'another' );
		await expect( another.media!.finalize( localSite, [ 7 ], [] ) ).rejects.toThrow( 'Denied' );
		await expect( guarded.media!.finalize( localSite, [ 7 ], [ 7 ] ) ).rejects.toThrow( 'Denied' );
		await expect( guarded.media!.finalize( localSite, [ 8 ], [] ) ).rejects.toThrow( 'Denied' );
		await guarded.media!.finalize( localSite, [ 7 ], [] );
		await expect( guarded.media!.finalize( localSite, [], [ 7 ] ) ).rejects.toThrow( 'Denied' );
		expect( host.sites.wpCli ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'runs no media-library command where a WP-CLI configuration of the site’s own would change it, as for every WP-CLI command of the turn', async () => {
		const { bridge, host, site } = await setupImages();
		reserving( host );
		await writeFile( path.join( site, 'wp-cli.yml' ), 'require: [ elsewhere.php ]' );
		const result = await bridge.invoke( 'generate_images', {
			images: [ { path: path.join( site, 'wp-content', 'uploads', 'hero.png' ), subject: 'Hero' } ],
		} );
		expect( result.isError ).toBe( true );
		expect( host.sites.wpCli ).not.toHaveBeenCalled();
		expect( generateImages ).not.toHaveBeenCalled();
	} );

	it( 'generates nothing the user denies, says so, and journals nothing', async () => {
		const { bridge, host, journal, site } = await setupImages( () => ( {
			approve: vi.fn( async () => 'deny' as const ),
		} ) );
		reserving( host );
		const result = await bridge.invoke( 'generate_images', {
			images: [ { path: path.join( site, 'wp-content', 'uploads', 'hero.png' ), subject: 'Hero' } ],
		} );
		expect( result.isError ).toBe( true );
		expect( text( result ) ).toContain( 'The user did not approve this operation' );
		expect( generateImages ).not.toHaveBeenCalled();
		expect( resolveImageService ).not.toHaveBeenCalled();
		expect( host.sites.wpCli ).not.toHaveBeenCalled();
		expect( journal ).toEqual( [] );
	} );

	it( 'asks nothing and generates nothing once the native account has changed, nor with a stored login in a folder the turn reaches', async () => {
		const changed = await setupImages( () => ( {
			verifyAccount: vi.fn( async () => 'changed' as const ),
		} ) );
		const reachable = await setupImages( ( paths ) => ( {
			localRoots: [ paths.site, config.root ],
		} ) );
		for ( const fixture of [ changed, reachable ] ) {
			const result = await fixture.bridge.invoke( 'generate_images', {
				images: [ { path: path.join( fixture.site, 'hero.png' ), subject: 'Hero' } ],
			} );
			expect( result.isError ).toBe( true );
			expect( fixture.context.approve ).not.toHaveBeenCalled();
			expect( fixture.journal ).toEqual( [] );
		}
		expect( generateImages ).not.toHaveBeenCalled();
	} );

	it( 'after a recovery that left operations uncertain, asks for the call as always, and again, saying so, before each change of the media library', async () => {
		const { bridge, host, context, site } = await setupImages( () => ( {
			uncertainAfterRecovery: true,
		} ) );
		reserving( host );
		const result = await bridge.invoke( 'generate_images', {
			images: [ { path: path.join( site, 'wp-content', 'uploads', 'hero.png' ), subject: 'Hero' } ],
		} );
		expect( result.isError ).toBe( false );
		const requests = vi.mocked( context.approve ).mock.calls.map( ( [ request ] ) => request );
		expect( requests.map( ( request ) => request.operation.tool ) ).toEqual( [
			'generate_images',
			'media.reserve',
			'media.finalize',
		] );
		expect( requests[ 0 ].operation.description ).not.toContain( 'may already have taken effect' );
		for ( const request of requests.slice( 1 ) ) {
			expect( request.operation.description ).toContain( 'may already have taken effect' );
			expect( request.operation.localPaths ).toEqual( [ site ] );
		}
	} );
} );
