import { describe, expect, it } from 'vitest';
import { buildClaudeEnvironment } from '../auth-status';

const BILLING_ROUTES = {
	ANTHROPIC_API_KEY: 'route',
	ANTHROPIC_AUTH_TOKEN: 'route',
	ANTHROPIC_BASE_URL: 'route',
	CLAUDE_CODE_OAUTH_TOKEN: 'route',
	CLAUDE_CODE_USE_BEDROCK: '1',
	CLAUDE_CODE_USE_VERTEX: '1',
	CLAUDE_CODE_USE_FOUNDRY: '1',
	AWS_PROFILE: 'route',
	AWS_BEARER_TOKEN_BEDROCK: 'route',
	GOOGLE_APPLICATION_CREDENTIALS: 'route',
	GOOGLE_CLOUD_PROJECT: 'route',
	AZURE_OPENAI_KEY: 'route',
	HTTPS_PROXY: 'route',
	https_proxy: 'route',
	ALL_PROXY: 'route',
	CLAUDE_CODE_SIMPLE: '1',
};

describe( 'Claude child environment', () => {
	it( 'reports but never passes inherited provider secrets, preserving OS essentials', () => {
		const result = buildClaudeEnvironment(
			{
				Path: 'path-value',
				ANTHROPIC_API_KEY: 'secret',
				OTHER_SECRET: 'private',
				USERPROFILE: 'profile',
			},
			'win32'
		);
		expect( result.conflicts ).toContain( 'ANTHROPIC_API_KEY' );
		expect( result.env ).toEqual( { Path: 'path-value', USERPROFILE: 'profile' } );
	} );

	it( 'refuses every alternate billing route on every OS, without passing or revealing it', () => {
		for ( const platform of [ 'win32', 'darwin', 'linux' ] ) {
			const result = buildClaudeEnvironment( { ...BILLING_ROUTES, PATH: '/bin' }, platform );
			expect( result.conflicts, platform ).toEqual(
				[ ...new Set( Object.keys( BILLING_ROUTES ).map( ( name ) => name.toUpperCase() ) ) ].sort()
			);
			expect( Object.keys( result.env ), platform ).toEqual( [ 'PATH' ] );
			expect( JSON.stringify( result ), platform ).not.toContain( 'route' );
		}
	} );

	it( 'treats Windows names that differ only in case as one variable', () => {
		const same = buildClaudeEnvironment(
			{ Path: 'C:\\Windows', PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows' },
			'win32'
		);
		expect( same.conflicts ).toEqual( [] );
		expect( same.env ).toEqual( { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows' } );

		const ambiguous = buildClaudeEnvironment(
			{ Path: 'C:\\Windows', PATH: 'C:\\Elsewhere', SystemRoot: 'C:\\Windows' },
			'win32'
		);
		expect( ambiguous.conflicts ).toEqual( [ 'PATH' ] );
		expect( ambiguous.env ).toEqual( { SystemRoot: 'C:\\Windows' } );

		for ( const name of [ 'anthropic_api_key', 'Anthropic_Base_Url', 'claude_code_oauth_token' ] )
			expect( buildClaudeEnvironment( { [ name ]: 'secret' }, 'win32' ).conflicts ).toEqual( [
				name.toUpperCase(),
			] );
	} );

	it( 'keeps the Unix session a native sign-in and run need, by exact name only', () => {
		const session = {
			HOME: '/home/tester',
			USER: 'tester',
			LOGNAME: 'tester',
			SHELL: '/bin/bash',
			PATH: '/usr/local/bin:/usr/bin:/bin',
			TMPDIR: '/tmp/tester',
			LANG: 'en_US.UTF-8',
			LC_ALL: 'en_US.UTF-8',
			XDG_CONFIG_HOME: '/home/tester/.config',
			XDG_DATA_HOME: '/home/tester/.local/share',
			XDG_CACHE_HOME: '/home/tester/.cache',
			XDG_STATE_HOME: '/home/tester/.local/state',
			XDG_RUNTIME_DIR: '/run/user/1000',
			XDG_SESSION_TYPE: 'wayland',
			DISPLAY: ':0',
			WAYLAND_DISPLAY: 'wayland-0',
			XAUTHORITY: '/run/user/1000/.Xauthority',
			DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
		};
		const linux = buildClaudeEnvironment(
			{
				...session,
				Path: '/elsewhere',
				home: '/elsewhere',
				SystemRoot: 'C:\\Windows',
				USERPROFILE: 'C:\\Users\\tester',
				NODE_OPTIONS: '--require /tmp/hook.js',
				STUDIO_OPENAI_API_KEY: 'studio-secret',
				SSH_AUTH_SOCK: '/tmp/agent',
			},
			'linux'
		);
		expect( linux ).toEqual( { env: session, conflicts: [] } );

		const macos = buildClaudeEnvironment(
			{
				HOME: '/Users/tester',
				USER: 'tester',
				SHELL: '/bin/zsh',
				PATH: '/usr/bin:/bin',
				TMPDIR: '/var/folders/xy/T/',
				__CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0',
				DISPLAY: ':0',
				XDG_RUNTIME_DIR: '/run/user/501',
				Path: '/elsewhere',
			},
			'darwin'
		);
		expect( macos ).toEqual( {
			env: {
				HOME: '/Users/tester',
				USER: 'tester',
				SHELL: '/bin/zsh',
				PATH: '/usr/bin:/bin',
				TMPDIR: '/var/folders/xy/T/',
				__CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0',
			},
			conflicts: [],
		} );
	} );
} );
