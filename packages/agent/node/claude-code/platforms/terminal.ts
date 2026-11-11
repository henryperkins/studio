import type { ClaudeShellSandboxFact, ClaudeSignInPlan, ClaudeSignInRequest } from '../platform';

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
export function cleanEnvironmentCommand(
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
