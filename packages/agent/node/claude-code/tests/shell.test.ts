import { existsSync } from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareClaudeShell } from '../shell';

const input = {
	cwd: '/sites/example',
	site: '/sites/example',
	configDirectory: '/home/user/.claude',
	storeRoot: '/home/user/.studio/sessions.claude-code',
	env: { PATH: '/usr/bin:/bin', HOME: '/home/user' },
	signal: new AbortController().signal,
};

function fixtures( platform = 'linux' ) {
	const run = vi.fn( async ( _file: string, _args: string[], _signal: AbortSignal ) => {} );
	const dispose = vi.fn( async () => {} );
	const temporary = vi.fn( async () => ( { path: '/tmp/studio-sh-test', dispose } ) );
	const seams = {
		host: { platform, arch: 'x64' },
		run,
		temporary,
		canonical: async ( file: string ) => file,
		executable: async ( file: string ) => file,
		list: async () => [ 'wp-load.php', 'index.php', 'wp-login.php', 'theme.php' ],
		linkedGit: async () => false,
		studioConfig: '/home/user/.studio',
	};
	return { run, dispose, temporary, seams };
}

describe( 'the shell selected for a Claude turn', () => {
	afterEach( () => vi.restoreAllMocks() );

	it.each( [
		[ 'linux', '/usr/bin/bwrap' ],
		[ 'darwin', '/usr/bin/sandbox-exec' ],
	] )( 'probes %s before giving the SDK immutable sandbox settings', async ( os, program ) => {
		const { seams, run, dispose } = fixtures( os );
		const shell = await prepareClaudeShell( input, seams );
		expect( run.mock.calls.map( ( args ) => args[ 0 ] ) ).toContain( program );
		expect( shell.confinement.mode ).toBe( 'sandbox' );
		if ( shell.confinement.mode !== 'sandbox' ) return;
		const sandbox = shell.confinement.sandbox!;
		expect( sandbox ).toMatchObject( {
			enabled: true,
			failIfUnavailable: true,
			autoAllowBashIfSandboxed: false,
			allowUnsandboxedCommands: false,
			network: { strictAllowlist: true, allowedDomains: [] },
			filesystem: {
				allowWrite: [],
				denyRead: expect.arrayContaining( [
					input.configDirectory,
					input.storeRoot,
					'/home/user/.ssh',
					'/home/user/.config/gh',
				] ),
				denyWrite: expect.arrayContaining( [
					'/sites/example/wp-admin',
					'/sites/example/wp-config.php',
				] ),
			},
		} );
		expect( Object.isFrozen( sandbox.network?.allowedDomains ) ).toBe( true );
		expect( Object.isFrozen( sandbox.filesystem?.denyRead ) ).toBe( true );
		expect( shell.env.CLAUDE_CODE_TMPDIR ).toBe( '/tmp/studio-sh-test' );
		await shell.dispose?.();
		expect( dispose ).toHaveBeenCalledOnce();
	} );

	it.each( [ 'linux', 'darwin' ] )(
		'protects mixed-case credential names in the %s sandbox settings',
		async ( os ) => {
			const result = await prepareClaudeShell( input, fixtures( os ).seams );
			expect( result.confinement.mode ).toBe( 'sandbox' );
			if ( result.confinement.mode !== 'sandbox' ) return;
			const settings = result.confinement.sandbox!.filesystem!;
			const paths = [
				'.EnV',
				'nested/.EnV.Local',
				'nested/.MySeCrEt',
				'nested/service.PEm',
				'nested/.GiT/CoNfIg',
			];
			for ( const file of paths ) {
				const matches = ( pattern: string ) =>
					path.posix.matchesGlob( input.cwd + '/' + file, pattern );
				expect( settings.denyRead?.some( matches ) ).toBe( true );
				if ( os === 'darwin' ) expect( settings.denyWrite?.some( matches ) ).toBe( true );
			}
			if ( os === 'linux' )
				expect( settings.denyWrite?.some( ( pattern ) => pattern.includes( '/**/' ) ) ).toBe(
					false
				);
		}
	);

	it( 'withholds Bash when namespaces are unusable or a required helper is absent', async () => {
		const { run, seams, temporary } = fixtures();
		run.mockRejectedValue( new Error( 'Blocked by kernel' ) );
		expect( ( await prepareClaudeShell( input, seams ) ).confinement.mode ).toBe( 'none' );
		expect( temporary ).not.toHaveBeenCalled();
	} );

	it( 'opens only the exact global workspace under the protected Studio journal directory', async () => {
		const { seams } = fixtures();
		const cwd = '/home/user/.studio/sessions.claude-code/global-workspace';
		const result = await prepareClaudeShell( { ...input, cwd }, seams );
		expect( result.confinement ).toMatchObject( {
			mode: 'sandbox',
			sandbox: {
				filesystem: {
					allowRead: [ cwd ],
					allowWrite: [],
					denyRead: expect.arrayContaining( [
						input.configDirectory,
						input.storeRoot,
						cwd + '/**/.[eE][nN][vV]',
						input.site + '/**/.[gG][iI][tT]/[cC][oO][nN][fF][iI][gG]',
					] ),
					denyWrite: expect.arrayContaining( [
						input.configDirectory,
						input.site + '/wp-load.php',
					] ),
				},
			},
		} );
		if ( result.confinement.mode !== 'sandbox' ) return;
		expect( result.confinement.sandbox!.filesystem!.denyWrite ).not.toContain( input.storeRoot );
	} );

	it( 'withholds Bash for linked worktrees whose shared Git directory would add a write root', async () => {
		const { seams, run } = fixtures();
		const result = await prepareClaudeShell( input, { ...seams, linkedGit: async () => true } );
		expect( result.confinement.mode ).toBe( 'none' );
		expect( run ).not.toHaveBeenCalled();
	} );

	it( 'keeps a sandbox from writing Studio state or launching from a credential directory', async () => {
		const { seams, run } = fixtures();
		for ( const cwd of [
			'/home/user/.studio/sessions.claude-code/other',
			'/home/user/.claude',
			'/home/user',
			'/',
		] ) {
			expect( ( await prepareClaudeShell( { ...input, cwd }, seams ) ).confinement.mode ).toBe(
				'none'
			);
		}
		expect( run ).not.toHaveBeenCalled();
	} );

	it( 'on Windows pins only the bash executable of a Git for Windows installation', async () => {
		const { seams, run, temporary } = fixtures( 'win32' );
		const root = 'C:\\Program Files\\Git';
		const env = { ProgramFiles: 'C:\\Program Files' };
		const files = [
			root + '\\bin\\bash.exe',
			root + '\\usr\\bin\\msys-2.0.dll',
			root + '\\cmd\\git.exe',
		];
		const executable = async ( file: string ) => ( files.includes( file ) ? file : undefined );
		const target = { ...input, cwd: 'C:\\sites\\example', site: 'C:\\sites\\example', env };
		const result = await prepareClaudeShell( target, { ...seams, executable } );
		expect( result.confinement ).toEqual( { mode: 'approval-only' } );
		expect( result.env.CLAUDE_CODE_GIT_BASH_PATH ).toBe( files[ 0 ] );
		expect( run ).not.toHaveBeenCalled();
		expect( temporary ).not.toHaveBeenCalled();
		const unsupported = {
			...target,
			env: { ...env, CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Windows\\System32\\bash.exe' },
		};
		expect(
			( await prepareClaudeShell( unsupported, { ...seams, executable } ) ).confinement.mode
		).toBe( 'none' );
		expect(
			( await prepareClaudeShell( { ...target, cwd: root }, { ...seams, executable } ) ).confinement
				.mode
		).toBe( 'none' );
		expect(
			(
				await prepareClaudeShell( target, {
					...seams,
					executable: async ( file ) =>
						file.endsWith( '.dll' ) ? 'D:\\unrelated\\msys-2.0.dll' : file,
				} )
			).confinement.mode
		).toBe( 'none' );
	} );

	const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
	const installed = path.win32.join( programFiles, 'Git', 'bin', 'bash.exe' );
	it.runIf( process.platform === 'win32' && existsSync( installed ) )(
		'discovers an installed Git for Windows without invoking the shell',
		async () => {
			const result = await prepareClaudeShell( {
				...input,
				cwd: 'C:\\sites\\example',
				site: undefined,
				env: { ProgramFiles: programFiles },
			} );
			expect( result.confinement.mode ).toBe( 'approval-only' );
			expect( result.env.CLAUDE_CODE_GIT_BASH_PATH?.toLowerCase() ).toBe( installed.toLowerCase() );
		}
	);
} );
