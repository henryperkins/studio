import { describe, expect, it } from 'vitest';
import { splitCommandArgs } from '../../tools/wp-cli';
import { claudeRouteNote } from '../execution-rules';
import { classifyWpCliArgs, inspectWpCliArgs, wpCliRouteCommands } from '../wp-cli-rules';

describe( 'the WP-CLI commands on the Claude route', () => {
	it.each( [
		[ 'post list --post_type=wp_template,wp_template_part --fields=ID,guid', 'read' ],
		[ '--quiet plugin list --status=active --field=name', 'read' ],
		[ 'term list category --format=json --fields=term_id,count', 'read' ],
		[ 'search-replace old new --dry-run', 'read' ],
		[ 'post create --post_status=draft --post_title="Ember & Oak"', 'local-change' ],
		[ 'theme activate studio-theme', 'local-change' ],
		[ 'option update blog_public 1', 'local-change' ],
		[ 'plugin install hello-dolly --activate', 'local-change' ],
		[ 'plugin install https://example.test/plugin.zip --activate', 'command' ],
		[ 'plugin install hello-dolly --force', 'local-overwrite' ],
		[ 'post delete 12 --force', 'local-overwrite' ],
		[ 'search-replace old new', 'local-overwrite' ],
		[ 'jetpack module list', 'read' ],
		[ 'jetpack module activate contact-form', 'local-change' ],
		[ 'wc product_cat create --name=Coffee --user=admin', 'local-change' ],
		[ 'example-plugin list', 'command' ],
		[ 'eval "return 1;"', 'command' ],
		[ 'post list --unknown-option', 'command' ],
		[ 'post list --format=json --format=table', 'command' ],
		[ 'option update blog_public 1 --format=unrecognized', 'command' ],
	] )( '%s has class %s', ( command, kind ) => {
		expect( classifyWpCliArgs( splitCommandArgs( command ) ) ).toBe( kind );
	} );

	it.each( [
		[ 'post', 'list', '--url=https://site.test' ],
		[ '--quiet', 'cli', '--format=json', 'update' ],
		[ 'post', 'list', '--', '--ssh=site' ],
		[ 'post', 'list', '--no-path' ],
		[ 'cli', 'alias', 'list' ],
		[ 'package', 'list' ],
		[ 'server' ],
		[ 'post', 'list', '--blog=http://other.test' ],
		[ '--quiet', '@other', 'post', 'list' ],
		[ 'post', 'list', '--prompt' ],
		[ 'post', 'list', '--no-skip-packages' ],
		[ 'post', 'create', '-' ],
		[ 'option', 'update', 'name', 'value', '--edit' ],
		[ 'post', 'list', 42 ],
		[],
	] )( 'refuses the call with arguments %s', ( ...args ) => {
		expect( inspectWpCliArgs( args ) ).toHaveProperty( 'refusal' );
	} );

	it( 'keeps known file operands checked even when other arguments need a command approval', () => {
		for ( const [ args, files ] of [
			[ [ 'post', 'create', 'page.html', '--unknown' ], [ { index: 2, kind: 'read' } ] ],
			[ [ 'post', 'update', '2', '3', 'page.html' ], [ { index: 4, kind: 'read' } ] ],
			[ [ 'post', 'update', 'page.html', '2' ], [ { index: 2, kind: 'read' } ] ],
			[
				[ 'media', 'import', 'x.png', 'y.png', '--porcelain' ],
				[
					{ index: 2, kind: 'read' },
					{ index: 3, kind: 'read' },
				],
			],
			[
				[ 'media', 'import', 'https://example.test/p.png', 'x.png' ],
				[ { index: 3, kind: 'read' } ],
			],
			[ [ 'theme', 'install', 'theme.zip' ], [ { index: 2, kind: 'read' } ] ],
			[
				[ 'export', '--dir=exports' ],
				[ { index: 1, prefix: '--dir=', kind: 'write-directory' } ],
			],
			[ [ 'db', 'export', 'site.sql' ], [ { index: 2, kind: 'write' } ] ],
			[ [ 'eval-file', 'script.php', 'arg' ], [ { index: 1, kind: 'read' } ] ],
			[
				[ 'search-replace', 'old', 'new', '--export=file.sql' ],
				[ { index: 3, prefix: '--export=', kind: 'write' } ],
			],
		] as const )
			expect( inspectWpCliArgs( args ), JSON.stringify( args ) ).toMatchObject( { files } );
	} );

	it( 'requires approval for URL imports, arbitrary WooCommerce image sources, and unfamiliar options', () => {
		const args = [
			'wc',
			'product',
			'create',
			'--name=Coffee',
			'--regular_price=8',
			'--user=admin',
		];
		expect( classifyWpCliArgs( [ ...args, '--images=[{"id":42}]' ] ) ).toBe( 'local-change' );
		expect(
			classifyWpCliArgs( [ ...args, '--images=[{"src":"https://example.test/p.png"}]' ] )
		).toBe( 'command' );
		expect( inspectWpCliArgs( [ 'example', 'list' ] ) ).toMatchObject( {
			known: false,
			reason: expect.any( String ),
		} );
		expect( inspectWpCliArgs( [ 'media', 'import', 'https://example.test/p.png' ] ) ).toMatchObject(
			{ operationClass: 'command', reason: expect.any( String ) }
		);
	} );

	it( 'marks a recognized draft for presentation', () => {
		expect(
			inspectWpCliArgs( [
				'--quiet',
				'post',
				'create',
				'--post_title=Example',
				'--post_status=draft',
			] )
		).toHaveProperty( 'draft', true );
		expect(
			inspectWpCliArgs( [ 'other', 'create', '--post_title=Example', '--post_status=draft' ] )
		).not.toHaveProperty( 'draft' );
	} );

	it( 'honors the bundled command aliases and keeps output paths bound', () => {
		expect( inspectWpCliArgs( [ 'db', 'dump', 'data.sql' ] ) ).toMatchObject( {
			operationClass: 'local-overwrite',
			files: [ { index: 2, kind: 'write' } ],
		} );
		expect( inspectWpCliArgs( [ 'core', 'upgrade', 'patch.zip' ] ) ).toMatchObject( {
			files: [ { index: 2, kind: 'read' } ],
		} );
		for ( const args of [
			[ 'export', '--stdout', '--no-stdout' ],
			[ 'export', '--dir=exports', '--no-dir' ],
			[ 'export', '--filename_format=../x.xml' ],
			[ 'export', '--filename_format=file.xml', '--filename_format=file.json' ],
			[ 'db', 'dump' ],
			[ 'db', 'import' ],
			[ 'import', 'site.xml' ],
			[ 'search-replace', 'a', 'b', '--no-log' ],
			[ 'search-replace', 'a', 'b', '--no-export' ],
			[ 'post', 'update', '1e2', 'page.html' ],
		] )
			expect( inspectWpCliArgs( args ), JSON.stringify( args ) ).toHaveProperty( 'refusal' );
		expect( classifyWpCliArgs( [ 'post', 'list', '--skip-packages' ] ) ).toBe( 'read' );
		expect(
			inspectWpCliArgs( [
				'eval-file',
				'tmp/taxonomist/apply-changes.php',
				'suggestions.json',
				'changes.tsv',
				'preview',
			] )
		).toMatchObject( {
			operationClass: 'command',
			files: [ { index: 1, kind: 'read', evalArgs: [ 2, 3, 4 ] } ],
		} );
	} );

	it( 'describes every recognized form and the approval fallback in the route note', () => {
		const note = claudeRouteNote( 'wp_cli' )!;
		const commands = wpCliRouteCommands();
		expect( commands.length ).toBeGreaterThan( 20 );
		for ( const command of commands ) {
			expect( inspectWpCliArgs( command.example ), command.usage ).toMatchObject( {
				operationClass: command.operationClass,
				known: true,
			} );
			expect( note ).toContain( command.usage );
		}
		expect( note ).toMatch( /unrecognized|unknown|unlisted|other commands/i );
	} );
} );
