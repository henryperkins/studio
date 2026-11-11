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
