import { existsSync } from 'fs';
import fsPromises, {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'fs/promises';
import os from 'os';
import path from 'path';
import { getCurrentUserId, readAuthToken } from '@studio/common/lib/shared-config';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	generateImages,
	interpretImageResponse,
	resolveImageService,
} from '@studio/agent/node/image-generation';
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

// The stored login, and its user id read from it, as Studio reads both.
vi.mock( '@studio/common/lib/shared-config', async ( importOriginal ) => ( {
	...( await importOriginal< object >() ),
	readAuthToken: vi.fn(),
	getCurrentUserId: vi.fn(),
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
	// Read from the same stored login, without counting as the tool's own read.
	vi.mocked( getCurrentUserId )
		.mockReset()
		.mockImplementation(
			async () => ( await vi.mocked( readAuthToken ).getMockImplementation()?.() )?.id ?? null
		);
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
	capabilities: Parameters< typeof createStudioClaudeToolBridge >[ 3 ],
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

// What Studio says when the WordPress.com login a call was approved under is
// no longer the one Studio is signed in with.
const LOGIN_REFUSAL = 'only under the login it was signed in with when the operation was prepared';
// The user signs in to another WordPress.com account while reading the approval.
const switchingLogin = async () => {
	vi.mocked( readAuthToken ).mockResolvedValue( { ...LOGIN, id: 8 } as never );
	return 'allow' as const;
};

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

	it( 'sends nothing, and journals nothing, once the WordPress.com login has changed since the user was asked', async () => {
		const { bridge, context, journal } = await setup();
		vi.mocked( context.approve ).mockImplementationOnce( switchingLogin );
		const result = await bridge.invoke( 'send_feedback', report );
		expect( result.isError ).toBe( true );
		expect( text( result ) ).toContain( LOGIN_REFUSAL );
		expect( feedback.calls ).toEqual( [] );
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
		// The report was sent, and it was the service that failed it.
		expect( feedback.calls ).toEqual( [ sent ] );
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
	// What the uploads check establishes, and only that: not where the uploads are.
	const UPLOADS_OUTSIDE =
		'here the folder for this month’s uploads is not an existing folder inside this site’s folder';
	const UPLOADS_CAUSE = 'keeps its uploads outside';
	const ISOLATION = [ '--skip-packages', '--skip-plugins', '--skip-themes' ];

	// WordPress as a reservation finds it: it makes this month's uploads folder,
	// `made`, by default the site's own folder joined with `folder`, and reports
	// each file by `folder`, the part of that folder's path after the site's;
	// attachment IDs from 7.
	function reserving(
		host: StudioAgentHost,
		folder = 'wp-content/uploads/2026/11',
		made?: string
	) {
		let next = 7;
		host.sites.wpCli = vi.fn( async ( site, args ) => {
			const php = args[ 1 ] ?? '';
			if ( ! php.includes( 'wp_insert_attachment' ) )
				return { exitCode: 0, stdout: '', stderr: '' };
			await mkdir( made ?? path.join( site.path, folder ), { recursive: true } );
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
		// the image service, signed in with its own credential, requested only
		// while the call lives.
		expect( generateImages ).toHaveBeenCalledWith(
			'WordPressStudio/test',
			LOGIN.accessToken,
			[ { prompt: expect.stringContaining( 'Pebbles on a beach' ), aspectRatio: undefined } ],
			undefined,
			expect.any( AbortSignal )
		);
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
		expect( text( result ) ).toContain(
			`FAILED ${ path.join( uploads, 'buns.png' ) }: the image service gave no usable image`
		);
		expect( await readFile( written ) ).toEqual( PNG );
		expect( existsSync( path.join( uploads, '2026', '11', 'buns.png' ) ) ).toBe( false );

		const calls = vi.mocked( host.sites.wpCli ).mock.calls;
		expect( calls ).toHaveLength( 2 );
		for ( const [ called, args, options ] of calls ) {
			expect( called ).toEqual( localSite );
			expect( args[ 0 ] ).toBe( 'eval' );
			expect( args.slice( 2 ) ).toEqual( ISOLATION );
			// Fenced before it starts, and once started run to its end, whatever
			// the call's signal says.
			expect( options ).toEqual( { beforeSpawn: expect.any( Function ) } );
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

	it( 'tells Claude of a failed image only the status and error code the image service answered, never the rest of its answer', async () => {
		const { bridge, site } = await setupImages();
		// What the service's answer becomes, as the image service's client reads it.
		const failure = ( raw: string, status: number ) => {
			try {
				interpretImageResponse( raw, status );
			} catch ( error ) {
				return { ok: false, error: ( error as Error ).message };
			}
			throw new Error( 'not a failure' );
		};
		const secret = 'person@example.test';
		vi.mocked( generateImages ).mockResolvedValueOnce( [
			failure(
				JSON.stringify( { error: { code: 'invalid_size', message: `Bad size ${ secret }` } } ),
				400
			),
			failure( JSON.stringify( { code: 'rate_limited', message: `Quota for ${ secret }` } ), 503 ),
			{
				...failure(
					JSON.stringify( {
						error: { code: 'moderation_blocked', message: `Unsafe subject for ${ secret }` },
					} ),
					400
				),
				filtered: true,
			},
			failure( `<html>${ secret }</html>`, 200 ),
			{ ok: false, error: `getaddrinfo ENOTFOUND ${ secret }` },
			// An answer over several lines, one of which looks like a line of its own.
			failure( `<html>\nFAILED elsewhere.png: ${ secret }\n</html>`, 502 ),
		] );
		const files = [ 'a', 'b', 'c', 'd', 'e', 'f' ].map( ( name ) =>
			path.join( site, `${ name }.png` )
		);
		const result = await bridge.invoke( 'generate_images', {
			images: files.map( ( file ) => ( { path: file, subject: 'An image' } ) ),
		} );
		expect( result.isError ).toBe( false );
		const said = text( result );
		expect( said ).toContain(
			`FAILED ${ files[ 0 ] }: the image service answered HTTP 400, error code invalid_size`
		);
		expect( said ).toContain(
			`FAILED ${ files[ 1 ] }: the image service answered HTTP 503, error code rate_limited`
		);
		expect( said ).toContain(
			`FAILED ${ files[ 2 ] }: the image service’s safety filter refused the prompt; rewrite the subject to avoid the sensitive element and call generate_images again for this image`
		);
		expect( said ).toContain( `FAILED ${ files[ 3 ] }: the image service gave no usable image` );
		expect( said ).toContain( `FAILED ${ files[ 4 ] }: the image service gave no usable image` );
		expect( said ).toContain( `FAILED ${ files[ 5 ] }: the image service answered HTTP 502` );
		for ( const answered of [
			secret,
			'Bad size',
			'Quota',
			'Unsafe',
			'html',
			'getaddrinfo',
			'elsewhere',
		] )
			expect( said, answered ).not.toContain( answered );
	} );

	// `x.png:s.png` names the stream `s.png` of the file `x.png`, which no check
	// that resolves paths can see. (A `..` segment is no such case for this tool:
	// the rule and the tool both resolve the path before it is checked or written.)
	it.runIf( process.platform === 'win32' )(
		'writes no image named as an NTFS stream of a file in the site, says its form is the reason, and asks, sends and journals nothing',
		async () => {
			const { bridge, host, context, journal, site } = await setupImages();
			const file = `${ path.join( site, 'x.png' ) }:s.png`;
			const result = await bridge.invoke( 'generate_images', {
				images: [ { path: file, subject: 'Hero' } ],
			} );
			expect( result.isError ).toBe( true );
			expect( text( result ) ).toContain( 'only by a plain absolute path' );
			expect( text( result ) ).not.toContain( SITE_FILES );
			expect( context.approve ).not.toHaveBeenCalled();
			expect( generateImages ).not.toHaveBeenCalled();
			expect( host.sites.wpCli ).not.toHaveBeenCalled();
			expect( journal ).toEqual( [] );
			expect( existsSync( path.join( site, 'x.png' ) ) ).toBe( false );
		}
	);

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
		// WordPress made this month's folder there before Studio could check;
		// nothing was written in it.
		expect( await readdir( path.join( parent, 'outside', 'uploads' ) ) ).toEqual( [] );
	} );

	it( 'adds nothing to a media library whose uploads are configured outside the site by an absolute path, which the reservation reports as a path inside it, and writes nothing in the site', async () => {
		const { bridge, host, site, parent } = await setupImages();
		// WordPress keeps the uploads in `outside`; the reservation reports what
		// follows the site's path in their folder's path, which is no folder here.
		const month = path.join( parent, 'outside', 'uploads', '2026', '11' );
		reserving( host, '2026/11', month );
		const result = await bridge.invoke( 'generate_images', {
			images: [ { path: path.join( site, 'wp-content', 'uploads', 'hero.png' ), subject: 'Hero' } ],
		} );
		expect( result.isError ).toBe( true );
		expect( text( result ) ).toContain( UPLOADS_OUTSIDE );
		expect( generateImages ).not.toHaveBeenCalled();
		const calls = vi.mocked( host.sites.wpCli ).mock.calls;
		expect( calls ).toHaveLength( 2 );
		expect( decoded( calls[ 1 ][ 1 ][ 1 ] ) ).toEqual( { ready: [], failed: [ 7 ] } );
		expect( existsSync( path.join( site, '2026' ) ) ).toBe( false );
		expect( await readdir( month ) ).toEqual( [] );
	} );

	it( 'says only what it found, a month folder that is not an existing folder inside the site, when WordPress could not make that folder inside the site', async () => {
		const { bridge, host, site, parent } = await setupImages();
		// The uploads are configured inside the site, but this month's folder was
		// not made there.
		reserving( host, 'wp-content/uploads/2026/11', path.join( parent, 'elsewhere' ) );
		const result = await bridge.invoke( 'generate_images', {
			images: [ { path: path.join( site, 'wp-content', 'uploads', 'hero.png' ), subject: 'Hero' } ],
		} );
		expect( result.isError ).toBe( true );
		expect( text( result ) ).toContain( UPLOADS_OUTSIDE );
		expect( text( result ) ).not.toContain( UPLOADS_CAUSE );
		expect( generateImages ).not.toHaveBeenCalled();
		const calls = vi.mocked( host.sites.wpCli ).mock.calls;
		expect( decoded( calls[ 1 ][ 1 ][ 1 ] ) ).toEqual( { ready: [], failed: [ 7 ] } );
	} );

	it( 'deletes again what a reservation that does not have its shape inserted for the call’s images, and generates nothing', async () => {
		const reservation = ( entries: unknown ) => ( {
			exitCode: 0,
			stdout: typeof entries === 'string' ? entries : JSON.stringify( entries ),
			stderr: '',
		} );
		const entry = ( id: number, name: string, extra: object = {} ) => ( {
			id,
			file: `wp-content/uploads/2026/11/${ name }`,
			url: `http://localhost:8888/wp-content/uploads/2026/11/${ name }`,
			...extra,
		} );
		const cases: Array< [ string, unknown, number[] ] > = [
			// One attachment for two images.
			[ 'too few', [ entry( 7, 'hero.png' ) ], [ 7 ] ],
			// One without its URL, and one under the unique name WordPress gave it.
			[
				'no URL',
				[ entry( 7, 'hero.png', { url: undefined } ), entry( 8, 'buns-1.png' ) ],
				[ 7, 8 ],
			],
			// One named for no image of this call is not this call's to delete.
			[
				'a stranger',
				[ entry( 7, 'hero.png' ), entry( 3, 'other.png' ), entry( 8, 'buns.png' ) ],
				[ 7, 8 ],
			],
			// Nothing it can read names any attachment.
			[ 'unreadable', 'not json', [] ],
		];
		for ( const [ label, entries, deleted ] of cases ) {
			const { bridge, host, site } = await setupImages();
			host.sites.wpCli = vi.fn( async ( _site, args ) =>
				args[ 1 ]?.includes( 'wp_insert_attachment' )
					? reservation( entries )
					: { exitCode: 0, stdout: '', stderr: '' }
			);
			const uploads = path.join( site, 'wp-content', 'uploads' );
			const result = await bridge.invoke( 'generate_images', {
				images: [
					{ path: path.join( uploads, 'hero.png' ), subject: 'Hero' },
					{ path: path.join( uploads, 'buns.png' ), subject: 'Buns' },
				],
			} );
			expect( result.isError, label ).toBe( true );
			const calls = vi.mocked( host.sites.wpCli ).mock.calls;
			expect( calls.length, label ).toBe( deleted.length ? 2 : 1 );
			if ( deleted.length )
				expect( decoded( calls[ 1 ][ 1 ][ 1 ] ), label ).toEqual( { ready: [], failed: deleted } );
		}
		expect( generateImages ).not.toHaveBeenCalled();
	} );

	it( 'deletes again what such a reservation inserted for images whose names end in a hyphen and digits, or that WordPress stored under a unique name, and nothing named otherwise', async () => {
		const requested = [ 'image-0.png', 'image-1.png', 'team-2024.png', 'photo.png' ];
		const entry = ( id: number, name: string, extra: object = {} ) => ( {
			id,
			file: `wp-content/uploads/2026/11/${ name }`,
			url: `http://localhost:8888/wp-content/uploads/2026/11/${ name }`,
			...extra,
		} );
		const { bridge, host, site } = await setupImages();
		host.sites.wpCli = vi.fn( async ( _site, args ) => ( {
			exitCode: 0,
			stdout: args[ 1 ]?.includes( 'wp_insert_attachment' )
				? JSON.stringify( [
						entry( 7, 'image-0.png' ),
						entry( 8, 'image-1.png' ),
						entry( 9, 'team-2024.png' ),
						// photo.png was taken, so WordPress stored it as photo-1.png;
						// this entry lacks its URL, so the output does not have its shape.
						entry( 10, 'photo-1.png', { url: undefined } ),
						// Named for no image of this call: a stem of a requested name,
						// another suffix, or a requested name's stem with no digits.
						entry( 3, 'image.png' ),
						entry( 4, 'team.png' ),
						entry( 5, 'photo-x.png' ),
						entry( 6, 'team-2024-copy.png' ),
				  ] )
				: '',
			stderr: '',
		} ) );
		const uploads = path.join( site, 'wp-content', 'uploads' );
		const result = await bridge.invoke( 'generate_images', {
			images: requested.map( ( name ) => ( { path: path.join( uploads, name ), subject: name } ) ),
		} );
		expect( result.isError ).toBe( true );
		const calls = vi.mocked( host.sites.wpCli ).mock.calls;
		expect( calls ).toHaveLength( 2 );
		expect( decoded( calls[ 1 ][ 1 ][ 1 ] ) ).toEqual( { ready: [], failed: [ 7, 8, 9, 10 ] } );
		expect( generateImages ).not.toHaveBeenCalled();
	} );

	it( 'deletes again, once the call has ended, what such a reservation inserted when deleting it at once failed', async () => {
		const { bridge, host, journal, site } = await setupImages();
		let deletions = 0;
		host.sites.wpCli = vi.fn( async ( _site, args ) => {
			if ( args[ 1 ]?.includes( 'wp_insert_attachment' ) )
				return {
					exitCode: 0,
					stdout: JSON.stringify( [
						{
							id: 7,
							file: 'wp-content/uploads/2026/11/hero.png',
							url: 'http://localhost:8888/wp-content/uploads/2026/11/hero.png',
						},
					] ),
					stderr: '',
				};
			// The first deletion fails.
			return { exitCode: deletions++ ? 0 : 1, stdout: '', stderr: '' };
		} );
		const uploads = path.join( site, 'wp-content', 'uploads' );
		const result = await bridge.invoke( 'generate_images', {
			images: [
				{ path: path.join( uploads, 'hero.png' ), subject: 'Hero' },
				{ path: path.join( uploads, 'buns.png' ), subject: 'Buns' },
			],
		} );
		expect( result.isError ).toBe( true );
		const calls = vi.mocked( host.sites.wpCli ).mock.calls;
		expect( calls ).toHaveLength( 3 );
		for ( const call of calls.slice( 1 ) )
			expect( decoded( call[ 1 ][ 1 ] ) ).toEqual( { ready: [], failed: [ 7 ] } );
		expect( journaled( journal ) ).toEqual( [
			[ 'generate_images', 'remote-change' ],
			[ 'media.reserve', 'local-change' ],
			[ 'media.finalize', 'local-change' ],
		] );
		expect( journal[ 2 ].description ).toContain(
			'It deletes the 1 attachment of this call that was neither completed nor deleted when the call ended'
		);
		expect( generateImages ).not.toHaveBeenCalled();
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

	it( 'generates nothing, and journals nothing, once the WordPress.com login has changed since the user was asked', async () => {
		const { bridge, context, journal, site } = await setupImages();
		vi.mocked( context.approve ).mockImplementationOnce( switchingLogin );
		const result = await bridge.invoke( 'generate_images', {
			images: [ { path: path.join( site, 'hero.png' ), subject: 'Hero' } ],
		} );
		expect( result.isError ).toBe( true );
		expect( text( result ) ).toContain( LOGIN_REFUSAL );
		expect( generateImages ).not.toHaveBeenCalled();
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

describe( 'what an approval says is shown', () => {
	// The approval as the app is given it: its description, and the display of
	// the arguments, local paths and remote.
	type Shown = { description: string; args: string; localPaths: string[]; remote?: string };
	const approvals = ( events: unknown[] ) =>
		events
			.filter( ( event ) => ( event as { type: string } ).type === 'approval.requested' )
			.map( ( event ) => {
				const { description, operation } = event as {
					description: string;
					operation: Omit< Shown, 'description' >;
				};
				return { description, ...operation };
			} );

	it( 'carries, for send_feedback, the type and message its note says it shows', async () => {
		const { bridge, events } = await setup();
		const report = { type: 'request', message: 'Let me pick the uploads folder.' };
		await bridge.invoke( 'send_feedback', report );
		const [ shown ] = approvals( events );
		expect( shown.description ).toContain( 'the type and message shown' );
		expect( JSON.parse( shown.args ) ).toEqual( report );
	} );

	it( 'carries, for generate_images, each image’s specification and the path its note says it shows', async () => {
		const { bridge, events, site } = await setupImages();
		const call = {
			images: [
				{
					path: path.join( site, 'hero.png' ),
					subject: 'A café counter at dawn',
					pageContext: 'full-width hero',
					style: 'photorealistic',
					aspectRatio: 'landscape',
				},
				{ path: path.join( site, 'band.png' ), subject: 'Pebbles on a beach' },
			],
			siteContext: 'A seaside bakery.',
			imageGrade: 'warm natural light',
		};
		await bridge.invoke( 'generate_images', call );
		const [ shown ] = approvals( events );
		expect( shown.description ).toContain( 'at the path shown' );
		expect( JSON.parse( shown.args ) ).toEqual( call );
		expect( shown.localPaths ).toEqual( call.images.map( ( image ) => image.path ) );
	} );
} );

describe( 'generate_images when its call is cancelled, or ends with attachments unsettled', () => {
	const MONTH = path.join( 'wp-content', 'uploads', '2026', '11' );
	const decodedData = ( php: string ) =>
		JSON.parse(
			Buffer.from( /base64_decode\( '([^']+)' \)/.exec( php )![ 1 ], 'base64' ).toString()
		);

	// WordPress's media library in the conversation's site, as the fixed
	// commands change it, each run once its fence passes, as the CLI host runs
	// them: a reservation inserts a row per name, in this month's uploads
	// folder, which WordPress creates, under a name no other row or file has (a
	// taken name gets a hyphen and digits, as `wp_unique_filename` gives it); a
	// completion marks rows done; a deletion removes rows and their files, as
	// `wp_delete_attachment` does. `onReserve` runs while the reservation runs.
	function mediaLibrary( host: StudioAgentHost, site: string, onReserve?: () => void ) {
		const rows = new Map< number, { file: string; done: boolean } >();
		let next = 7;
		const unique = ( name: string ) => {
			const taken = ( candidate: string ) =>
				existsSync( path.join( site, MONTH, candidate ) ) ||
				[ ...rows.values() ].some( ( row ) => row.file === path.join( site, MONTH, candidate ) );
			let candidate = name;
			for ( let suffix = 1; taken( candidate ); suffix++ )
				candidate = name.replace( /\.png$/, `-${ suffix }.png` );
			return candidate;
		};
		host.sites.wpCli = vi.fn( async ( _site, args, options ) => {
			await options?.beforeSpawn?.();
			const php = args[ 1 ] ?? '';
			const data = decodedData( php );
			if ( php.includes( 'wp_insert_attachment' ) ) {
				await mkdir( path.join( site, MONTH ), { recursive: true } );
				const reserved = ( data as string[] ).map( ( requested ) => {
					const id = next++;
					const name = unique( requested );
					rows.set( id, { file: path.join( site, MONTH, name ), done: false } );
					return {
						id,
						file: `wp-content/uploads/2026/11/${ name }`,
						url: `http://localhost:8888/wp-content/uploads/2026/11/${ name }`,
					};
				} );
				onReserve?.();
				return { exitCode: 0, stdout: JSON.stringify( reserved ), stderr: '' };
			}
			for ( const id of data.ready as number[] ) rows.get( id )!.done = true;
			for ( const id of data.failed as number[] ) {
				const row = rows.get( id );
				rows.delete( id );
				if ( row ) await rm( row.file, { force: true } );
			}
			return { exitCode: 0, stdout: '', stderr: '' };
		} );
		return {
			rows,
			// No attachment row without its file, and no file without its attachment completed.
			async isSettled() {
				for ( const [ id, row ] of rows ) {
					expect( existsSync( row.file ), `row ${ id }` ).toBe( true );
					expect( row.done, `row ${ id }` ).toBe( true );
				}
				const folder = path.join( site, MONTH );
				const files = existsSync( folder ) ? await readdir( folder ) : [];
				for ( const file of files )
					expect(
						[ ...rows.values() ].some(
							( row ) => row.done && row.file === path.join( folder, file )
						),
						file
					).toBe( true );
			},
		};
	}

	// The image service, answering each request when the test says, as `fetch`
	// is called; an aborted request rejects as `fetch` rejects it. A request
	// made without a signal cannot be aborted, so once the call is cancelled it
	// is answered at once, and a call that keeps requesting still ends.
	function imageService( cancel: AbortSignal ) {
		const requests: Array< { answer: ( onRead?: () => void ) => void } > = [];
		const unabortable: Array< () => void > = [];
		cancel.addEventListener( 'abort', () => unabortable.forEach( ( answer ) => answer() ) );
		const fetch = vi.fn(
			( _url: string, init: { signal?: AbortSignal } ) =>
				new Promise( ( resolve, reject ) => {
					const abort = () =>
						reject( new DOMException( 'This operation was aborted', 'AbortError' ) );
					if ( init.signal?.aborted ) return abort();
					init.signal?.addEventListener( 'abort', abort, { once: true } );
					const answer = ( onRead?: () => void ) =>
						resolve( {
							status: 200,
							text: async () => {
								onRead?.();
								return JSON.stringify( { data: [ { b64_json: PNG.toString( 'base64' ) } ] } );
							},
						} );
					requests.push( { answer } );
					if ( ! init.signal ) {
						if ( cancel.aborted ) answer();
						else unabortable.push( () => answer() );
					}
				} )
		);
		vi.stubGlobal( 'fetch', fetch );
		return { fetch, requests };
	}

	const images = ( site: string, count: number ) => ( {
		images: Array.from( { length: count }, ( _, index ) => ( {
			path: path.join( site, 'wp-content', 'uploads', `image-${ index }.png` ),
			subject: `Image ${ index }`,
		} ) ),
	} );
	const settledEntry = ( journal: Array< { operation: { tool: string }; description: string } > ) =>
		journal.filter( ( entry ) => entry.operation.tool === 'media.finalize' ).at( -1 );

	beforeEach( async () => {
		const actual = await vi.importActual< typeof import('@studio/agent/node/image-generation') >(
			'@studio/agent/node/image-generation'
		);
		vi.mocked( generateImages ).mockImplementation( actual.generateImages );
	} );
	afterEach( () => {
		vi.unstubAllGlobals();
	} );

	it( 'requests no image once the call is cancelled while its attachments are reserved, and deletes them all, journaled as settled', async () => {
		const cancel = new AbortController();
		const { bridge, host, journal, site } = await setupImages();
		const library = mediaLibrary( host, site, () => cancel.abort() );
		const { fetch } = imageService( cancel.signal );
		await bridge.invoke( 'generate_images', images( site, 2 ), cancel.signal );
		expect( fetch ).not.toHaveBeenCalled();
		expect( library.rows.size ).toBe( 0 );
		await library.isSettled();
		expect( settledEntry( journal )?.description ).toContain(
			'completes the 0 attachments of this call whose image was written and deletes the 2 whose image was not, since the call was cancelled'
		);
	} );

	it( 'requests no further image once the call is cancelled between images, keeps the one that arrived, and deletes the rest, journaled as settled', async () => {
		const cancel = new AbortController();
		const { bridge, host, journal, site } = await setupImages();
		const library = mediaLibrary( host, site );
		const service = imageService( cancel.signal );
		const call = bridge.invoke( 'generate_images', images( site, 6 ), cancel.signal );
		// Five requests at a time: the sixth waits for one of them to finish.
		await vi.waitFor( () => expect( service.requests ).toHaveLength( 5 ) );
		service.requests[ 0 ].answer( () => cancel.abort() );
		await call;
		expect( service.fetch ).toHaveBeenCalledTimes( 5 );
		expect( [ ...library.rows.values() ] ).toEqual( [
			{ file: path.join( site, MONTH, 'image-0.png' ), done: true },
		] );
		expect( await readFile( path.join( site, MONTH, 'image-0.png' ) ) ).toEqual( PNG );
		await library.isSettled();
		expect( settledEntry( journal )?.description ).toContain(
			'completes the 1 attachment of this call whose image was written and deletes the 5 whose image was not, since the call was cancelled'
		);
	} );

	it( 'completes, once the call is cancelled after the last image was written, the attachments of the images written and deletes the others, journaled as settled', async () => {
		const cancel = new AbortController();
		const { bridge, host, policy, journal, site } = await setupImages();
		const library = mediaLibrary( host, site );
		vi.mocked( generateImages ).mockResolvedValueOnce( [
			{ ok: true, bytes: PNG },
			{ ok: false, error: 'Timed out' },
		] );
		// The call is cancelled as the tool, its images written, settles them.
		const guardHost = policy.guardHost;
		policy.guardHost = ( ...guarding ) => {
			const guarded = guardHost( ...guarding );
			const media = guarded.media!;
			return {
				...guarded,
				media: {
					...media,
					finalize: async ( ...settling ) => {
						cancel.abort();
						return media.finalize( ...settling );
					},
				},
			};
		};
		await bridge.invoke( 'generate_images', images( site, 2 ), cancel.signal );
		expect( [ ...library.rows.values() ] ).toEqual( [
			{ file: path.join( site, MONTH, 'image-0.png' ), done: true },
		] );
		await library.isSettled();
		expect(
			journal.map( ( entry ) => entry.operation.tool ),
			'the settling is journaled before it runs'
		).toEqual( [ 'generate_images', 'media.reserve', 'media.finalize' ] );
		expect( settledEntry( journal )?.description ).toContain(
			'completes the 1 attachment of this call whose image was written and deletes the 1 whose image was not, since the call was cancelled'
		);
	} );

	// What the journal says of the deletion a call's end makes, and of what it left.
	const DELETED_AT_END = ( count: number ) =>
		`deletes the ${ count } attachments of this call that were neither completed nor deleted when the call ended, with any image file written for them`;
	const LEFT_AT_END = ( count: number ) =>
		`Studio could not delete the ${ count } attachments of this call that were neither completed nor deleted when the call ended`;
	const leftNotes = ( events: Array< { type: string; message?: string } > ) =>
		events.flatMap( ( event ) =>
			event.type === 'tool.progress' && event.message?.startsWith( 'Studio could not delete' )
				? [ event.message ]
				: []
		);
	// The call is cancelled as the tool, its images written, settles them;
	// `before` runs first.
	const cancellingAtFinalize = (
		policy: Awaited< ReturnType< typeof setupImages > >[ 'policy' ],
		cancel: AbortController,
		before: () => Promise< void > = async () => {}
	) => {
		const guardHost = policy.guardHost;
		policy.guardHost = ( ...guarding ) => {
			const guarded = guardHost( ...guarding );
			const media = guarded.media!;
			return {
				...guarded,
				media: {
					...media,
					finalize: async ( ...settling ) => {
						cancel.abort();
						await before();
						return media.finalize( ...settling );
					},
				},
			};
		};
	};

	it( 'deletes, once the call has ended, every attachment it reserved and neither completed nor deleted, with the image written for it, when another image could not be written', async () => {
		const { bridge, host, journal, events, site } = await setupImages();
		const library = mediaLibrary( host, site );
		vi.mocked( generateImages ).mockResolvedValueOnce( [
			{ ok: true, bytes: PNG },
			{ ok: true, bytes: PNG },
		] );
		const first = path.join( site, MONTH, 'image-0.png' );
		const second = path.join( site, MONTH, 'image-1.png' );
		// The second image cannot be written; the first is written only after
		// that failure, as a write still under way would be.
		const write = fsPromises.writeFile;
		let wroteFirst = () => {};
		const firstWritten = new Promise< void >( ( resolve ) => ( wroteFirst = resolve ) );
		const writing = vi
			.spyOn( fsPromises, 'writeFile' )
			.mockImplementation( async ( ...args: Parameters< typeof write > ) => {
				if ( args[ 0 ] === second )
					throw Object.assign( new Error( 'EACCES: permission denied' ), { code: 'EACCES' } );
				if ( args[ 0 ] === first ) {
					await new Promise( ( resolve ) => setTimeout( resolve, 200 ) );
					await write( ...args );
					wroteFirst();
					return;
				}
				return write( ...args );
			} );
		try {
			const result = await bridge.invoke( 'generate_images', images( site, 2 ) );
			expect( result.isError ).toBe( true );
			await firstWritten;
		} finally {
			writing.mockRestore();
		}
		expect( library.rows.size ).toBe( 0 );
		await library.isSettled();
		expect( journal.map( ( entry ) => entry.operation.tool ) ).toEqual( [
			'generate_images',
			'media.reserve',
			'media.finalize',
		] );
		expect( settledEntry( journal )?.description ).toContain( DELETED_AT_END( 2 ) );
		expect( leftNotes( events ) ).toEqual( [] );
	} );

	it( 'deletes, once the call has ended, the attachments of an image path named twice, and the one file both images were written to', async () => {
		const { bridge, host, journal, site } = await setupImages();
		const library = mediaLibrary( host, site );
		vi.mocked( generateImages ).mockResolvedValueOnce( [
			{ ok: true, bytes: PNG },
			{ ok: true, bytes: PNG },
		] );
		const hero = path.join( site, 'wp-content', 'uploads', 'hero.png' );
		const result = await bridge.invoke( 'generate_images', {
			images: [
				{ path: hero, subject: 'A café counter at dawn' },
				{ path: hero, subject: 'Cardamom buns on a tray' },
			],
		} );
		expect( result.isError ).toBe( true );
		expect( library.rows.size ).toBe( 0 );
		await library.isSettled();
		expect( settledEntry( journal )?.description ).toContain( DELETED_AT_END( 2 ) );
	} );

	it( 'deletes, once the call has ended, the attachments whose completion the user denied in a turn after a recovery, without asking again', async () => {
		const { bridge, host, context, journal, site } = await setupImages( () => ( {
			uncertainAfterRecovery: true,
			approve: vi.fn( async ( request: { operation: { tool: string } } ) =>
				request.operation.tool === 'media.finalize' ? ( 'deny' as const ) : ( 'allow' as const )
			),
		} ) );
		const library = mediaLibrary( host, site );
		vi.mocked( generateImages ).mockResolvedValueOnce( [
			{ ok: true, bytes: PNG },
			{ ok: false, error: 'Timed out' },
		] );
		await bridge.invoke( 'generate_images', images( site, 2 ) );
		expect(
			vi.mocked( context.approve ).mock.calls.map( ( [ request ] ) => request.operation.tool )
		).toEqual( [ 'generate_images', 'media.reserve', 'media.finalize' ] );
		expect( library.rows.size ).toBe( 0 );
		await library.isSettled();
		expect( journal.map( ( entry ) => entry.operation.tool ) ).toEqual( [
			'generate_images',
			'media.reserve',
			'media.finalize',
		] );
		expect( settledEntry( journal )?.description ).toContain( DELETED_AT_END( 2 ) );
	} );

	it( 'deletes, once the call has ended, what a settling that failed left', async () => {
		const cancel = new AbortController();
		const { bridge, host, policy, journal, events, site } = await setupImages();
		const library = mediaLibrary( host, site );
		vi.mocked( generateImages ).mockResolvedValueOnce( [
			{ ok: true, bytes: PNG },
			{ ok: false, error: 'Timed out' },
		] );
		// The settling's command fails once; what follows runs as WordPress would.
		const settles = vi.mocked( host.sites.wpCli ).getMockImplementation()!;
		let failed = false;
		host.sites.wpCli = vi.fn( async ( ...args: Parameters< typeof settles > ) => {
			if ( ! failed && ! args[ 1 ][ 1 ]?.includes( 'wp_insert_attachment' ) ) {
				failed = true;
				return { exitCode: 1, stdout: '', stderr: '' };
			}
			return settles( ...args );
		} );
		cancellingAtFinalize( policy, cancel );
		await bridge.invoke( 'generate_images', images( site, 2 ), cancel.signal );
		expect( failed ).toBe( true );
		expect( library.rows.size ).toBe( 0 );
		await library.isSettled();
		expect( journal.map( ( entry ) => entry.operation.tool ) ).toEqual( [
			'generate_images',
			'media.reserve',
			'media.finalize',
			'media.finalize',
		] );
		expect( journal[ 2 ].description ).toContain( 'since the call was cancelled' );
		expect( settledEntry( journal )?.description ).toContain( DELETED_AT_END( 2 ) );
		expect( leftNotes( events ) ).toEqual( [] );
	} );

	it( 'says in the journal how many attachments it left when a settling and the deletion at the call’s end are both refused', async () => {
		const cancel = new AbortController();
		const { bridge, host, policy, journal, events, site } = await setupImages();
		const library = mediaLibrary( host, site );
		vi.mocked( generateImages ).mockResolvedValueOnce( [
			{ ok: true, bytes: PNG },
			{ ok: false, error: 'Timed out' },
		] );
		// A WP-CLI configuration of the site's own appears as the call is cancelled.
		cancellingAtFinalize( policy, cancel, () =>
			writeFile( path.join( site, 'wp-cli.yml' ), 'require: [ elsewhere.php ]' )
		);
		await bridge.invoke( 'generate_images', images( site, 2 ), cancel.signal );
		// The reservation ran; the settling's command and the deletion's were each
		// refused by their fence before they started.
		expect( vi.mocked( host.sites.wpCli ) ).toHaveBeenCalledTimes( 3 );
		expect( library.rows.size ).toBe( 2 );
		expect( journal.map( ( entry ) => entry.operation.tool ) ).toEqual( [
			'generate_images',
			'media.reserve',
			'media.finalize',
			'media.finalize',
		] );
		expect( settledEntry( journal )?.description ).toContain( DELETED_AT_END( 2 ) );
		const left = leftNotes( events );
		expect( left ).toHaveLength( 1 );
		expect( left[ 0 ] ).toContain( LEFT_AT_END( 2 ) );
		expect( left[ 0 ] ).not.toContain( site );
	} );

	it( 'keeps the turn up after Stop until a settling command it started has ended, however long that takes', async () => {
		const cancel = new AbortController();
		const { bridge, host, site } = await setupImages();
		const library = mediaLibrary( host, site );
		vi.mocked( generateImages ).mockResolvedValueOnce( [ { ok: true, bytes: PNG } ] );
		// The completing command, once its fence has passed, runs until the test
		// lets it end.
		let release = () => {};
		const reserve = vi.mocked( host.sites.wpCli ).getMockImplementation()!;
		host.sites.wpCli = vi.fn( async ( ...args: Parameters< typeof reserve > ) => {
			if ( args[ 1 ][ 1 ]?.includes( 'wp_insert_attachment' ) ) return reserve( ...args );
			await args[ 2 ]?.beforeSpawn?.();
			await new Promise< void >( ( resolve ) => ( release = resolve ) );
			return reserve( args[ 0 ], args[ 1 ] );
		} );
		let settled = false;
		const call = bridge
			.invoke( 'generate_images', images( site, 1 ), cancel.signal )
			.finally( () => ( settled = true ) );
		await vi.waitFor( () => expect( host.sites.wpCli ).toHaveBeenCalledTimes( 2 ) );
		cancel.abort();
		// Time passes for the turn's end only as the test advances it, far past
		// any bound it could be given.
		let disposed = false;
		vi.useFakeTimers( { toFake: [ 'setTimeout', 'clearTimeout' ] } );
		try {
			const disposing = bridge.dispose().then( () => ( disposed = true ) );
			await vi.advanceTimersByTimeAsync( 10 * 60 * 1000 );
			vi.useRealTimers();
			await new Promise( ( resolve ) => setTimeout( resolve, 200 ) );
			expect( disposed ).toBe( false );
			expect( settled ).toBe( false );
			release();
			await disposing;
		} finally {
			vi.useRealTimers();
		}
		await call;
		await library.isSettled();
	} );
} );
