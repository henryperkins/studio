import { randomBytes } from 'crypto';
import path from 'path';
import type {
	ClaudePlatformSeams,
	ClaudePrivateScript,
	ClaudeShellSandboxFact,
	ClaudeSignInPlan,
	ClaudeSignInRequest,
} from '../platform';

/** The documentation and SDK passages every platform's sandbox facts rest on. */
const SANDBOX_SOURCES: readonly string[] = Object.freeze( [
	'https://code.claude.com/docs/en/sandboxing (read November 11, 2026)',
	'https://code.claude.com/docs/en/setup, "Set up on Windows" (read November 11, 2026)',
	'@anthropic-ai/claude-agent-sdk 0.3.319 sdk.d.ts: Options.sandbox, SandboxSettings, sandbox_required_unavailable',
] );

export function sandboxFact(
	fact: Omit< ClaudeShellSandboxFact, 'sources' >
): ClaudeShellSandboxFact {
	return Object.freeze( {
		...fact,
		requires: Object.freeze( [ ...fact.requires ] ),
		optional: Object.freeze( [ ...fact.optional ] ),
		limitations: Object.freeze( [ ...fact.limitations ] ),
		sources: SANDBOX_SOURCES,
	} );
}

/** Whether Studio is running in a remote login session, where a new window would not reach the user. */
export function isRemoteSession( env: NodeJS.ProcessEnv ): boolean {
	return [ 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY' ].some( ( name ) => !! env[ name ] );
}

/**
 * The login command as separate arguments, started by `env -i` with exactly the
 * allowlisted variables, so a terminal's or shell profile's environment never
 * reaches the vendor's process. `env` reads every leading argument containing
 * `=` as an assignment, so an executable path with `=` cannot be passed safely.
 */
function cleanEnvironmentCommand(
	request: ClaudeSignInRequest
): string[] | Extract< ClaudeSignInPlan, { state: 'user-action-needed' } > {
	if ( request.executablePath.includes( '=' ) )
		return { state: 'user-action-needed', reason: 'executable-path-unsupported' };
	const assignments = Object.entries( request.env )
		.filter( ( [ , value ] ) => value !== undefined )
		.map( ( [ name, value ] ) => `${ name }=${ value }` )
		.sort();
	return [ '/usr/bin/env', '-i', ...assignments, request.executablePath, ...request.args ];
}

/** Absolute paths of characters that no shell, fish and csh included, treats specially. */
const SHELL_INERT_PATH = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

/** POSIX sh single quoting: everything inside is literal, so a quote is closed, escaped and reopened. */
function shellQuote( value: string ): string {
	return `'${ value.replace( /'/g, "'\\''" ) }'`;
}

/**
 * The sign-in as a POSIX sh script in a fresh directory under the first
 * temporary directory whose real path is shell-inert. Only `/bin/sh` reads
 * the user's paths and values, POSIX-quoted; the terminal and its login
 * shell are given `/bin/sh <script>` and nothing else. The script removes
 * itself before it runs anything.
 */
export async function signInScript(
	request: ClaudeSignInRequest,
	seams: ClaudePlatformSeams
): Promise<
	| { base: string; script: ClaudePrivateScript; command: string[] }
	| Extract< ClaudeSignInPlan, { state: 'user-action-needed' } >
> {
	const command = cleanEnvironmentCommand( request );
	if ( ! Array.isArray( command ) ) return command;
	for ( const candidate of [ seams.tempDirectory(), '/tmp' ] ) {
		let base: string;
		try {
			base = await seams.files.realpath( candidate );
		} catch {
			continue;
		}
		if ( ! SHELL_INERT_PATH.test( base ) ) continue;
		const directory = path.posix.join(
			base,
			`studio-claude-sign-in-${ randomBytes( 8 ).toString( 'hex' ) }`
		);
		const scriptPath = path.posix.join( directory, 'sign-in.sh' );
		return {
			base,
			script: {
				directory,
				path: scriptPath,
				contents: [
					`/bin/rm -f -- ${ shellQuote( scriptPath ) }`,
					`/bin/rmdir -- ${ shellQuote( directory ) }`,
					`cd -- ${ shellQuote( request.cwd ) } || exit 1`,
					`exec ${ command.map( shellQuote ).join( ' ' ) }`,
					'',
				].join( '\n' ),
			},
			command: [ '/bin/sh', scriptPath ],
		};
	}
	throw new Error( 'No temporary directory has a shell-inert path' );
}
