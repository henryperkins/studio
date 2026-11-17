import { describe, expect, it } from 'vitest';
import { splitCommandArgs } from '../../tools/wp-cli';
import { claudeRouteNote } from '../execution-rules';
import { classifyWpCliArgs, wpCliRouteCommands } from '../wp-cli-rules';

const title200 = 'T'.repeat( 200 );
const content10000 = 'C'.repeat( 10000 );

// What the Claude route runs of WP-CLI, command by command, as C1 allowed it.
const CLASSIFIED: Array< [ string[], string | undefined ] > = [
	[ [ 'option', 'get', 'blogname' ], 'read' ],
	[ [ 'option', 'get', 'blogdescription' ], 'read' ],
	[ [ 'option', 'get', 'home' ], 'read' ],
	[ [ 'option', 'get', 'siteurl' ], 'read' ],
	[ [ 'post', 'list' ], 'read' ],
	[ [ 'post', 'get', '1' ], 'read' ],
	[ [ 'post', 'get', '1234567890' ], 'read' ],
	[ [ 'post', 'create', '--post_status=draft', '--post_title=Hello' ], 'command' ],
	[ [ 'post', 'create', '--post_title=Hello', '--post_status=draft' ], 'command' ],
	[ [ 'post', 'create', '--post_status=draft', `--post_title=${ title200 }` ], 'command' ],
	[
		[ 'post', 'create', '--post_status=draft', '--post_title=Hello', '--post_content=' ],
		'command',
	],
	[
		[
			'post',
			'create',
			'--post_content=<p>Hi</p>',
			'--post_status=draft',
			'--post_title=Ember & Oak',
		],
		'command',
	],
	[
		[
			'post',
			'create',
			'--post_status=draft',
			'--post_title=Multi\nline',
			`--post_content=${ content10000 }`,
		],
		'command',
	],
	// Refused: everything else.
	[ [], undefined ],
	[ [ 'option', 'get' ], undefined ],
	[ [ 'option', 'get', 'smtp_password' ], undefined ],
	[ [ 'option', 'get', 'blogname', '--url=https://example.com' ], undefined ],
	[ [ 'option', 'get', 'BLOGNAME' ], undefined ],
	[ [ 'option', 'update', 'blogname', 'x' ], undefined ],
	[ [ 'post', 'list', '--format=json' ], undefined ],
	[ [ 'post', 'get' ], undefined ],
	[ [ 'post', 'get', '12345678901' ], undefined ],
	[ [ 'post', 'get', '-1' ], undefined ],
	[ [ 'post', 'get', '1', '--field=content' ], undefined ],
	[ [ 'post', 'delete', '1' ], undefined ],
	[ [ 'post', 'create' ], undefined ],
	[ [ 'post', 'create', '--post_status=draft' ], undefined ],
	[ [ 'post', 'create', '--post_title=Hello' ], undefined ],
	[ [ 'post', 'create', '--post_status=publish', '--post_title=Hello' ], undefined ],
	[ [ 'post', 'create', '--post_status=draft', '--post_title=' ], undefined ],
	[ [ 'post', 'create', '--post_status=draft', `--post_title=${ title200 }T` ], undefined ],
	[
		[
			'post',
			'create',
			'--post_status=draft',
			'--post_title=Hello',
			`--post_content=${ content10000 }C`,
		],
		undefined,
	],
	[ [ 'post', 'create', '--post_status=draft', '--post_title=A', '--post_title=B' ], undefined ],
	[
		[ 'post', 'create', '--post_status=draft', '--post_status=draft', '--post_title=A' ],
		undefined,
	],
	[ [ 'post', 'create', 'file.txt', '--post_status=draft', '--post_title=A' ], undefined ],
	[ [ 'post', 'create', '--post_status=draft', '--post_title=A', '--porcelain' ], undefined ],
	[ [ 'post', 'create', '--post_status=draft', '--post_title=A', '--post_type=page' ], undefined ],
	[ [ 'plugin', 'install', 'hello-dolly' ], undefined ],
	[ [ 'user', 'list' ], undefined ],
	[ [ 'theme', 'activate', 'twentytwentyfive' ], undefined ],
	[ [ 'eval', 'echo 1;' ], undefined ],
];

describe( 'the WP-CLI commands the Claude route runs', () => {
	it( 'classifies each command it runs, and refuses every other', () => {
		for ( const [ args, operationClass ] of CLASSIFIED )
			expect( classifyWpCliArgs( args ), JSON.stringify( args ) ).toBe( operationClass );
	} );

	it( 'refuses arguments that are not all strings', () => {
		for ( const args of [
			[ 'post', 'list', 1 ],
			[ 'post', null ],
			[ { toString: () => 'post' } ],
		] )
			expect( classifyWpCliArgs( args ) ).toBeUndefined();
	} );

	it( 'describes each command it runs from the values it checks, with the class it gives it', () => {
		const commands = wpCliRouteCommands();
		expect( commands.map( ( command ) => command.operationClass ) ).toEqual( [
			'read',
			'read',
			'read',
			'command',
		] );
		for ( const command of commands )
			expect( classifyWpCliArgs( command.example ), command.usage ).toBe( command.operationClass );
		expect( commands.map( ( command ) => command.usage ) ).toEqual( [
			'option get <blogname|blogdescription|home|siteurl>',
			'post list',
			'post get <id of up to 10 digits>',
			'post create --post_status=draft --post_title=<1 to 200 characters> [--post_content=<up to 10000 characters>]',
		] );
	} );

	it( 'runs no command the route note does not describe, and describes each with the class it runs it under', () => {
		const commands = wpCliRouteCommands();
		const note = claudeRouteNote( 'wp_cli' )!;
		for ( const command of commands ) expect( note ).toContain( command.usage );
		// Every command shape these tests name, and many the route refuses.
		const verbs = [ 'get', 'list', 'create', 'update', 'delete', 'install', 'activate', 'set' ];
		const tails = [
			[],
			[ 'blogname' ],
			[ '1' ],
			[ '--post_status=draft', '--post_title=A' ],
			[ '--format=json' ],
		];
		const corpus = [
			...CLASSIFIED.map( ( [ args ] ) => args ),
			...[ 'option', 'post', 'user', 'plugin', 'theme', 'site', 'db', 'term', 'menu' ].flatMap(
				( noun ) => verbs.flatMap( ( verb ) => tails.map( ( tail ) => [ noun, verb, ...tail ] ) )
			),
		];
		for ( const args of corpus ) {
			const operationClass = classifyWpCliArgs( args );
			const described = commands.filter( ( command ) => command.matches( args ) );
			expect(
				described.map( ( command ) => command.operationClass ),
				JSON.stringify( args )
			).toEqual( operationClass ? [ operationClass ] : [] );
		}
	} );

	it( 'classifies a command as the tool splits it', () => {
		expect(
			classifyWpCliArgs(
				splitCommandArgs( 'post create --post_status=draft --post_title="Ember & Oak"' )
			)
		).toBe( 'command' );
		expect( classifyWpCliArgs( splitCommandArgs( 'option get blogname' ) ) ).toBe( 'read' );
	} );
} );
