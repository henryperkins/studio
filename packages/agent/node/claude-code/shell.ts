import { execFile } from 'child_process';
import { access, constants, lstat, mkdtemp, readdir, realpath, rm, stat } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { getConfigDirectory } from '@studio/common/lib/well-known-paths';
import { isWordPressCoreRelativePath } from '../runtime/tool-safety';
import { CLAUDE_SHELL_CONFINEMENT, isVerifiedShellConfinement } from './execution-rules';
import { claudeSensitiveNames, getCredentialNameGlobs } from './local-paths';
import { claudeShellSandbox, currentClaudeHost } from './platform';
import { getClaudeGlobalWorkspace } from './sessions';
import type { ClaudeShellConfinement } from './execution-rules';
import type { ClaudeHost } from './platform';
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk/core';

interface ShellInput {
	cwd: string;
	site?: string;
	configDirectory: string;
	storeRoot: string;
	env: NodeJS.ProcessEnv;
	signal: AbortSignal;
}

export interface PreparedClaudeShell {
	confinement: ClaudeShellConfinement;
	env: NodeJS.ProcessEnv;
	dispose?: () => Promise< void >;
}

interface ShellSeams {
	host: ClaudeHost;
	run: ( file: string, args: string[], signal: AbortSignal ) => Promise< void >;
	executable: ( file: string ) => Promise< string | undefined >;
	canonical: ( file: string ) => Promise< string >;
	list: ( directory: string ) => Promise< string[] >;
	linkedGit: ( directory: string ) => Promise< boolean >;
	temporary: () => Promise< { path: string; dispose: () => Promise< void > } >;
	studioConfig: string;
}

const exec = promisify( execFile );
const unavailable: PreparedClaudeShell = Object.freeze( {
	confinement: CLAUDE_SHELL_CONFINEMENT,
	env: Object.freeze( {} ),
} );

async function executableFile( file: string ): Promise< string | undefined > {
	try {
		const resolved = await realpath( file );
		await access( resolved, constants.X_OK );
		if ( ( await stat( resolved ) ).isFile() ) return resolved;
	} catch {
		// An unavailable installation is skipped.
	}
}

function windowsBashCandidates( env: NodeJS.ProcessEnv ): string[] {
	const paths = path.win32;
	const read = ( key: string ) =>
		Object.entries( env ).find( ( [ name ] ) => name.toUpperCase() === key )?.[ 1 ];
	const configured = read( 'CLAUDE_CODE_GIT_BASH_PATH' );
	if ( configured ) return [ configured ];
	const folders = [ read( 'PROGRAMFILES' ), read( 'PROGRAMFILES(X86)' ) ]
		.filter( ( value ): value is string => !! value )
		.map( ( folder ) => paths.join( folder, 'Git', 'bin' ) );
	const local = read( 'LOCALAPPDATA' );
	if ( local ) folders.push( paths.join( local, 'Programs', 'Git', 'bin' ) );
	for ( const value of ( read( 'PATH' ) ?? '' ).split( ';' ) ) {
		const folder = value.replace( /^"|"$/g, '' );
		if ( paths.basename( folder ).toLowerCase() === 'cmd' )
			folders.push( paths.join( folder, '..', 'bin' ) );
		else if ( paths.basename( folder ).toLowerCase() === 'bin' ) folders.push( folder );
	}
	return [ ...new Set( folders.map( ( folder ) => paths.join( folder, 'bash.exe' ) ) ) ];
}

async function findGitBash( input: ShellInput, seams: ShellSeams ): Promise< string | undefined > {
	const paths = path.win32;
	const roots = [ input.cwd, ...( input.site ? [ input.site ] : [] ) ];
	for ( const candidate of windowsBashCandidates( input.env ) ) {
		if ( ! /^[a-z]:[\\/]/i.test( candidate ) ) continue;
		const file = await seams.executable( candidate );
		if (
			! file ||
			! /^[a-z]:[\\/]/i.test( file ) ||
			paths.basename( file ).toLowerCase() !== 'bash.exe'
		)
			continue;
		const bin = paths.dirname( file );
		if ( paths.basename( bin ).toLowerCase() !== 'bin' ) continue;
		const parent = paths.dirname( bin );
		const root =
			paths.basename( parent ).toLowerCase() === 'usr' ? paths.dirname( parent ) : parent;
		const markerPaths = [ 'usr/bin/msys-2.0.dll', 'cmd/git.exe' ].map( ( name ) =>
			paths.join( root, name )
		);
		const markers = await Promise.all( markerPaths.map( seams.executable ) );
		const outside = ( name: string ) =>
			roots.every( ( folder ) => {
				const relative = paths.relative( folder, name );
				return paths.isAbsolute( relative ) || relative === '..' || relative.startsWith( '..\\' );
			} );
		if (
			outside( file ) &&
			markers.every(
				( name, i ) => name && paths.relative( markerPaths[ i ], name ) === '' && outside( name )
			)
		)
			return file;
	}
}

async function verifySandbox(
	mechanism: 'seatbelt' | 'bubblewrap',
	seams: ShellSeams,
	signal: AbortSignal
) {
	if ( ! ( await seams.executable( '/bin/bash' ) ) ) throw new Error( 'Bash unavailable' );
	if ( mechanism === 'seatbelt' ) {
		await seams.run(
			'/usr/bin/sandbox-exec',
			[ '-p', '(version 1)(allow default)(deny network*)(deny file-write*)', '/usr/bin/true' ],
			signal
		);
	} else {
		await seams.run( '/usr/bin/socat', [ '-V' ], signal );
		await seams.run(
			'/usr/bin/bwrap',
			[
				'--die-with-parent',
				'--new-session',
				'--unshare-user',
				'--unshare-pid',
				'--unshare-net',
				'--ro-bind',
				'/',
				'/',
				'--dev',
				'/dev',
				'--proc',
				'/proc',
				'--',
				'/usr/bin/true',
			],
			signal
		);
	}
}

async function privateTemporary() {
	// Claude Code falls back to shared temp paths for long temp-directory overrides.
	const directory = await mkdtemp( '/tmp/studio-sh-' );
	return { path: directory, dispose: () => rm( directory, { recursive: true, force: true } ) };
}

// A linked worktree can grant the SDK writes to Git metadata outside the working directory.
async function hasLinkedGit( directory: string ): Promise< boolean > {
	const metadata = ( file: string ) =>
		lstat( file ).catch( ( error: NodeJS.ErrnoException ) => {
			if ( error.code !== 'ENOENT' ) throw error;
			return undefined;
		} );
	for ( let root = directory; ; root = path.posix.dirname( root ) ) {
		const git = path.posix.join( root, '.git' );
		const entry = await metadata( git );
		if ( entry )
			return ! entry.isDirectory() || !! ( await metadata( path.posix.join( git, 'commondir' ) ) );
		if ( root === '/' ) return false;
	}
}

const contains = ( root: string, file: string ) =>
	root === file || file.startsWith( root.endsWith( '/' ) ? root : root + '/' );

async function shellFilesystem(
	input: ShellInput,
	seams: ShellSeams
): Promise< SandboxSettings[ 'filesystem' ] > {
	const { cwd, site, configDirectory, storeRoot } = input;
	const roots = Array.from( new Set( site ? [ cwd, site ] : [ cwd ] ) );
	const state = [ configDirectory, storeRoot, seams.studioConfig ];
	const protectedPaths = Array.from(
		new Set( [ ...state, ...( await Promise.all( state.map( seams.canonical ) ) ) ] )
	);
	// The Bash sandbox permits reading other paths by default. Hide conventional
	// account credential stores even when they are outside the working directories.
	const home = input.env.HOME;
	const homeCredentials = home
		? [
				'.ssh',
				'.aws',
				'.azure',
				'.gnupg',
				'.kube',
				'.netrc',
				'.npmrc',
				'.git-credentials',
				'.config/git/credentials',
				'.config/gh',
				'.config/gcloud',
				'.docker/config.json',
				'.claude',
				'.claude.json',
				'.codex',
		  ].map( ( name ) => path.posix.join( home, name ) )
		: [];
	// The settings take path patterns. A literal path containing a pattern character
	// cannot also identify the directory that the policy inspected.
	if (
		[ ...roots, ...protectedPaths, ...homeCredentials ].some(
			( file ) => ! path.posix.isAbsolute( file ) || /[?*[\]{}\\\n\r]/.test( file )
		)
	)
		return;
	const global =
		cwd ===
		getClaudeGlobalWorkspace( await seams.canonical( storeRoot ) )
			.split( path.sep )
			.join( '/' );
	for ( const root of roots ) {
		if (
			homeCredentials.some( ( file ) => contains( file, root ) || contains( root, file ) ) ||
			protectedPaths.some(
				( file ) =>
					contains( root, file ) || ( contains( file, root ) && ! ( global && root === cwd ) )
			)
		)
			return;
		if (
			contains( await seams.canonical( configDirectory ), root ) ||
			( await seams.linkedGit( root ) )
		)
			return;
	}
	const privateFiles = [
		...claudeSensitiveNames,
		'.git/config',
		'.git-credentials',
		'.netrc',
		'.npmrc',
	];
	const names = privateFiles.flatMap( getCredentialNameGlobs );
	const privatePatterns = roots.flatMap( ( root ) =>
		names.map( ( name ) => path.posix.join( root, '**', name ) )
	);
	const exactPaths = roots.flatMap( ( root ) =>
		privateFiles
			.filter( ( name ) => ! name.includes( '*' ) )
			.map( ( name ) => path.posix.join( root, name ) )
	);
	// Linux denyRead supports wildcards after a literal first directory component.
	// Its denyWrite only accepts literal paths (or a trailing /**).
	const coreFiles = site
		? [
				'wp-admin',
				'wp-includes',
				...( await seams.list( site ) ).filter( isWordPressCoreRelativePath ),
		  ].map( ( name ) => path.posix.join( site, name ) )
		: [];
	const deniedWrites = protectedPaths.filter( ( file ) => ! ( global && contains( file, cwd ) ) );
	if ( site ) exactPaths.push( path.posix.join( site, 'wp-content', 'database' ) );
	const filesystem = {
		allowWrite: [],
		...( global ? { allowRead: [ cwd ] } : {} ),
		denyRead: [ ...protectedPaths, ...homeCredentials, ...exactPaths, ...privatePatterns ],
		denyWrite: [
			...deniedWrites,
			...homeCredentials,
			...exactPaths,
			...coreFiles,
			...roots.map( ( root ) => path.posix.join( root, '.git' ) ),
			...( seams.host.platform === 'darwin' ? privatePatterns : [] ),
		],
	};
	for ( const paths of Object.values( filesystem ) ) Object.freeze( paths );
	return Object.freeze( filesystem );
}

export async function prepareClaudeShell(
	input: ShellInput,
	overrides: Partial< ShellSeams > = {}
): Promise< PreparedClaudeShell > {
	const seams: ShellSeams = {
		host: currentClaudeHost(),
		run: async ( file, args, signal ) => {
			await exec( file, args, {
				cwd: '/',
				env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
				signal,
				timeout: 3000,
				maxBuffer: 64 * 1024,
			} );
		},
		canonical: async ( file ) => {
			try {
				return await realpath( file );
			} catch ( error ) {
				if ( ( error as NodeJS.ErrnoException ).code !== 'ENOENT' ) throw error;
				return file;
			}
		},
		executable: executableFile,
		list: ( directory ) => readdir( directory ),
		linkedGit: hasLinkedGit,
		temporary: privateTemporary,
		studioConfig: getConfigDirectory(),
		...overrides,
	};
	try {
		const fact = claudeShellSandbox( seams.host );
		if ( ! fact || input.signal.aborted ) return unavailable;
		if ( seams.host.platform === 'win32' ) {
			const file = await findGitBash( input, seams );
			return file && ! input.signal.aborted
				? { confinement: { mode: 'approval-only' }, env: { CLAUDE_CODE_GIT_BASH_PATH: file } }
				: unavailable;
		}
		if ( ! fact.available || ! fact.mechanism ) return unavailable;
		const filesystem = await shellFilesystem( input, seams );
		if ( ! filesystem ) return unavailable;
		await verifySandbox( fact.mechanism, seams, input.signal );
		if ( input.signal.aborted ) return unavailable;
		const sandbox: SandboxSettings = {
			enabled: true,
			failIfUnavailable: true,
			autoAllowBashIfSandboxed: false,
			allowUnsandboxedCommands: false,
			network: { strictAllowlist: true, allowedDomains: [] },
			filesystem,
		};
		Object.freeze( sandbox.network!.allowedDomains );
		Object.freeze( sandbox.network );
		const confinement = Object.freeze( {
			mode: 'sandbox' as const,
			sandbox: Object.freeze( sandbox ),
		} );
		if ( ! isVerifiedShellConfinement( confinement, input.cwd ) ) return unavailable;
		const temp = await seams.temporary();
		return {
			confinement,
			env: {
				PATH: '/usr/bin:/bin' + ( input.env.PATH ? ':' + input.env.PATH : '' ),
				SHELL: '/bin/bash',
				TMPDIR: temp.path,
				CLAUDE_CODE_TMPDIR: temp.path,
			},
			dispose: temp.dispose,
		};
	} catch {
		return unavailable;
	}
}
