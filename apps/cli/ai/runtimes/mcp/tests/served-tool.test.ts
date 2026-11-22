import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { bindTool, createResultNotes, defineTool, READ_ONLY } from '@studio/agent/node';
import { Type } from 'typebox';
import { expect, it, vi } from 'vitest';
import { cliAgentHost } from 'cli/ai/host';
import { runServedTool } from 'cli/ai/runtimes/mcp/served-tool';

it( 'adds the declared settings of the core blocks a result shows, from the site the call names, once', async () => {
	const root = mkdtempSync( path.join( tmpdir(), 'served-tool-' ) );
	const sitePath = path.join( root, 'site' );
	mkdirSync( path.join( sitePath, 'wp-includes', 'blocks', 'navigation' ), { recursive: true } );
	writeFileSync(
		path.join( sitePath, 'wp-includes', 'blocks', 'navigation', 'block.json' ),
		JSON.stringify( { attributes: { submenuVisibility: { enum: [ 'hover', 'click' ] } } } )
	);
	const site = { id: '1', name: 'My Site', path: sitePath, port: 8881, phpVersion: '8.3' };
	writeFileSync( path.join( root, 'cli.json' ), JSON.stringify( { version: 1, sites: [ site ] } ) );
	vi.stubEnv( 'E2E', '1' );
	vi.stubEnv( 'E2E_CLI_CONFIG_PATH', root );

	const tool = defineTool(
		'show_header',
		'Shows the header.',
		{ nameOrPath: Type.Optional( Type.String() ) },
		async () => ( { content: [ { type: 'text', text: '<!-- wp:navigation /-->' } ] } ),
		{ annotations: READ_ONLY }
	);
	const resultNotes = createResultNotes();
	const notes = async ( args: Record< string, unknown > ) =>
		(
			await runServedTool( cliAgentHost, bindTool( tool, cliAgentHost ), args, resultNotes )
		).content
			.slice( 1 )
			.map( ( part ) => ( part.type === 'text' ? part.text : '' ) );
	const blockJson = path.join( sitePath, 'wp-includes/blocks/navigation/block.json' );

	expect( await notes( {} ) ).toEqual( [] );
	expect( await notes( { nameOrPath: 'Missing Site' } ) ).toEqual( [] );
	expect( await notes( { nameOrPath: 'My Site' } ) ).toEqual( [
		`core/navigation settings, declared in ${ blockJson
			.split( path.sep )
			.join( '/' ) }: submenuVisibility ("hover"|"click").`,
	] );
	// Once per MCP session, as once per Studio Code turn.
	expect( await notes( { nameOrPath: 'My Site' } ) ).toEqual( [] );
} );

it( 'gives the client the text and image blocks, then the work the tool left running, with the MCP App data beside them', async () => {
	const image = { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' };
	const progress: string[] = [];
	const tool = defineTool(
		'show_page',
		'Shows a page.',
		{},
		async ( _args, context ) => {
			context.onProgress( 'Rendering' );
			progress.push( 'reported' );
			return {
				content: [ { type: 'text', text: 'Rendered.' }, image ],
				_meta: { page: 'for the app' },
				studioArtifacts: [ { type: 'media', widgetProps: { mediaKind: 'image' } } ],
				pending: Promise.resolve( 'Finished later.' ),
			};
		},
		{ annotations: READ_ONLY }
	);

	const served = await runServedTool(
		cliAgentHost,
		bindTool( tool, cliAgentHost ),
		{},
		createResultNotes()
	);

	expect( progress ).toEqual( [ 'reported' ] );
	expect( served ).toEqual( {
		content: [
			{ type: 'text', text: 'Rendered.' },
			image,
			{ type: 'text', text: 'Finished later.' },
		],
		_meta: { page: 'for the app' },
		isError: false,
	} );
} );

it( 'reports a failure, or failed work the tool left running, by its message', async () => {
	const failing = ( name: string, fail: () => Promise< never > | never, pending?: boolean ) =>
		bindTool(
			defineTool(
				name,
				'Fails.',
				{},
				async () =>
					pending ? { content: [ { type: 'text', text: 'Started.' } ], pending: fail() } : fail(),
				{ annotations: READ_ONLY }
			),
			cliAgentHost
		);
	const serve = ( tool: ReturnType< typeof failing > ) =>
		runServedTool( cliAgentHost, tool, {}, createResultNotes() );

	expect(
		await serve(
			failing( 'thrown', () => {
				throw new Error( 'The site is not running.' );
			} )
		)
	).toEqual( { content: [ { type: 'text', text: 'The site is not running.' } ], isError: true } );
	expect(
		await serve(
			failing( 'plain', () => {
				throw 'plain failure';
			} )
		)
	).toEqual( { content: [ { type: 'text', text: 'plain failure' } ], isError: true } );
	expect(
		await serve(
			failing( 'background', () => Promise.reject( new Error( 'Generation failed.' ) ), true )
		)
	).toEqual( { content: [ { type: 'text', text: 'Generation failed.' } ], isError: true } );
} );

it( 'never hands an MCP client the image service account a result was made with', async () => {
	const tool = defineTool(
		'make_images',
		'Makes images.',
		{},
		async () => ( {
			content: [ { type: 'text', text: 'Generating 1 image in the background.' } ],
			studioService: {
				service: 'wordpress-com',
				credential: 'wordpress-com-login',
				account: { displayName: 'Someone', email: 'someone@example.test' },
			},
		} ),
		{ annotations: READ_ONLY }
	);

	const served = await runServedTool(
		cliAgentHost,
		bindTool( tool, cliAgentHost ),
		{},
		createResultNotes()
	);

	expect( JSON.stringify( served ) ).not.toMatch( /Someone|someone@example|wordpress-com/ );
} );

it( 'refuses arguments the tool’s schema refuses, naming at most three problems, before the tool runs', async () => {
	const handler = vi.fn( async () => ( { content: [ { type: 'text' as const, text: 'Ran.' } ] } ) );
	const tool = defineTool(
		'show_site',
		'Shows a site.',
		{ nameOrPath: Type.String(), a: Type.String(), b: Type.String(), c: Type.String() },
		handler,
		{ annotations: READ_ONLY }
	);
	const serve = ( args: Record< string, unknown > ) =>
		runServedTool( cliAgentHost, bindTool( tool, cliAgentHost ), args, createResultNotes() );

	expect( await serve( { nameOrPath: 7, a: 'x', b: 'x', c: 'x' } ) ).toEqual( {
		content: [
			{ type: 'text', text: 'Invalid arguments for show_site: /nameOrPath must be string.' },
		],
		isError: true,
	} );
	const many = await serve( { nameOrPath: 1, a: 2, b: 3, c: 4 } );
	expect( many.isError ).toBe( true );
	expect( ( many.content[ 0 ] as { text: string } ).text.split( '; ' ) ).toHaveLength( 3 );
	expect( handler ).not.toHaveBeenCalled();
} );
