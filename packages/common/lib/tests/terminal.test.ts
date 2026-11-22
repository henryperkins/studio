/**
 * @vitest-environment node
 */
import {
	resolveLinuxTerminalCommandLaunch,
	resolveLinuxTerminalLaunch,
} from '../user-settings/terminal';

const SITE = '/home/user/Studio/my site';

describe( 'resolveLinuxTerminalCommandLaunch', () => {
	const argv = [ '/opt/My Tools/$HOME `x` "q" \'s\'/tool', 'auth', 'login' ];

	it( 'runs the command as separate arguments in the desktop default terminal first', () => {
		expect(
			resolveLinuxTerminalCommandLaunch(
				SITE,
				argv,
				findIn( 'xdg-terminal-exec', 'x-terminal-emulator' )
			)
		).toEqual( { file: '/usr/bin/xdg-terminal-exec', args: argv, cwd: SITE } );
		expect(
			resolveLinuxTerminalCommandLaunch( SITE, argv, findIn( 'x-terminal-emulator', 'xterm' ) )
		).toEqual( { file: '/usr/bin/x-terminal-emulator', args: [ '-e', ...argv ], cwd: SITE } );
	} );

	it( 'uses each terminal’s own argument-preserving form', () => {
		const expected: Record< string, string[] > = {
			'gnome-terminal': [ `--working-directory=${ SITE }`, '--', ...argv ],
			konsole: [ '--workdir', SITE, '-e', ...argv ],
			'xfce4-terminal': [ `--working-directory=${ SITE }`, '-x', ...argv ],
			'mate-terminal': [ `--working-directory=${ SITE }`, '-x', ...argv ],
			terminator: [ `--working-directory=${ SITE }`, '-x', ...argv ],
			alacritty: [ '--working-directory', SITE, '-e', ...argv ],
			kitty: [ '--directory', SITE, ...argv ],
			foot: [ `--working-directory=${ SITE }`, ...argv ],
			wezterm: [ 'start', '--cwd', SITE, '--', ...argv ],
			xterm: [ '-e', ...argv ],
		};
		for ( const [ command, args ] of Object.entries( expected ) )
			expect( resolveLinuxTerminalCommandLaunch( SITE, argv, findIn( command ) ), command ).toEqual(
				{ file: `/usr/bin/${ command }`, args, cwd: SITE }
			);
	} );

	it( 'never uses a terminal that would parse the command as one string', () => {
		for ( const command of [ 'ptyxis', 'kgx', 'tilix', 'lxterminal', 'qterminal' ] )
			expect(
				resolveLinuxTerminalCommandLaunch( SITE, argv, findIn( command ) ),
				command
			).toBeNull();
	} );
} );

function findIn( ...commands: string[] ) {
	return ( command: string ) => ( commands.includes( command ) ? `/usr/bin/${ command }` : null );
}

describe( 'resolveLinuxTerminalLaunch', () => {
	it( 'prefers the desktop default terminal launcher over specific terminals', () => {
		expect(
			resolveLinuxTerminalLaunch(
				'terminal',
				SITE,
				findIn( 'x-terminal-emulator', 'gnome-terminal' )
			)
		).toEqual( { file: '/usr/bin/x-terminal-emulator', args: [], cwd: SITE } );
	} );

	it( 'prefers xdg-terminal-exec over x-terminal-emulator', () => {
		expect(
			resolveLinuxTerminalLaunch(
				'terminal',
				SITE,
				findIn( 'x-terminal-emulator', 'xdg-terminal-exec' )
			)
		).toEqual( { file: '/usr/bin/xdg-terminal-exec', args: [], cwd: SITE } );
	} );

	it( 'opens Xfce Terminal when GNOME Terminal is not installed', () => {
		expect( resolveLinuxTerminalLaunch( 'terminal', SITE, findIn( 'xfce4-terminal' ) ) ).toEqual( {
			file: '/usr/bin/xfce4-terminal',
			args: [ `--working-directory=${ SITE }` ],
			cwd: SITE,
		} );
	} );

	it( 'passes the folder as its own argument to terminals that take it separately', () => {
		expect( resolveLinuxTerminalLaunch( 'terminal', SITE, findIn( 'konsole' ) ) ).toEqual( {
			file: '/usr/bin/konsole',
			args: [ '--workdir', SITE ],
			cwd: SITE,
		} );
	} );

	it( 'uses the preferred terminal when it is installed', () => {
		expect(
			resolveLinuxTerminalLaunch( 'ghostty', SITE, findIn( 'ghostty', 'x-terminal-emulator' ) )
		).toEqual( {
			file: '/usr/bin/ghostty',
			args: [ `--working-directory=${ SITE }` ],
			cwd: SITE,
		} );
		expect(
			resolveLinuxTerminalLaunch( 'warp', SITE, findIn( 'warp-terminal', 'x-terminal-emulator' ) )
		).toEqual( { file: '/usr/bin/warp-terminal', args: [], cwd: SITE } );
	} );

	it( 'falls back to a system terminal when the preferred one is missing', () => {
		expect( resolveLinuxTerminalLaunch( 'ghostty', SITE, findIn( 'kitty' ) ) ).toEqual( {
			file: '/usr/bin/kitty',
			args: [ '--directory', SITE ],
			cwd: SITE,
		} );
	} );

	it( 'falls back to a system terminal for a preference with no Linux build', () => {
		expect( resolveLinuxTerminalLaunch( 'iterm', SITE, findIn( 'x-terminal-emulator' ) ) ).toEqual(
			{ file: '/usr/bin/x-terminal-emulator', args: [], cwd: SITE }
		);
	} );

	it( 'returns null when no known terminal is installed', () => {
		expect( resolveLinuxTerminalLaunch( 'terminal', SITE, findIn() ) ).toBeNull();
	} );
} );
