import type { Options } from '@anthropic-ai/claude-agent-sdk/core';
import type { ChildProcessWithoutNullStreams } from 'child_process';

// This SDK stand-in executes only the arguments Studio returns after approval.
// Bash and its writer run inside Studio's real process owner.
export async function exerciseApprovedBash(
	options: Options,
	shell: ChildProcessWithoutNullStreams,
	firstOutput: Promise< string >,
	scenario: string,
	reportResult: Promise< void >
) {
	const signal = options.abortController!.signal;
	const result = async ( command: string, timeout: number, output: unknown ) => {
		const completed = options.hooks!.PostToolUse!.find( ( matcher ) => matcher.matcher === 'Bash' );
		if ( ! completed ) throw new Error( 'Missing Bash result hook' );
		await completed.hooks[ 0 ](
			{
				hook_event_name: 'PostToolUse',
				tool_name: 'Bash',
				tool_use_id: 'writer',
				tool_input: { command, timeout },
				tool_response: output,
				session_id: options.sessionId!,
				transcript_path: '',
				cwd: options.cwd!,
			},
			'writer',
			{ signal }
		);
	};
	const permission = async ( id: string, command: string, timeout: number ) => {
		const input = { command, timeout };
		const hook = await options.hooks!.PreToolUse![ 0 ].hooks[ 0 ](
			{
				hook_event_name: 'PreToolUse',
				session_id: options.sessionId!,
				transcript_path: '',
				cwd: options.cwd!,
				tool_name: 'Bash',
				tool_use_id: id,
				tool_input: input,
			},
			id,
			{ signal }
		);
		const decision = await options.canUseTool!( 'Bash', input, {
			requestId: id,
			toolUseID: id,
			signal,
		} );
		const hookAllows =
			'hookSpecificOutput' in hook &&
			hook.hookSpecificOutput?.hookEventName === 'PreToolUse' &&
			hook.hookSpecificOutput.permissionDecision === 'allow';
		if ( hookAllows !== ( decision?.behavior === 'allow' ) )
			throw new Error( 'Studio permission callbacks disagreed' );
		if ( decision?.behavior !== 'allow' || typeof decision.updatedInput?.command !== 'string' )
			return false;
		shell.stdin.write( decision.updatedInput.command + '\n' );
		return true;
	};
	if ( ! Array.isArray( options.tools ) || ! options.tools.includes( 'Bash' ) )
		throw new Error( 'Bash missing' );
	if (
		options.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS !== '1' ||
		options.env?.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR !== '1'
	)
		throw new Error( 'Unexpected foreground settings' );
	if ( await permission( 'denied', 'printf denied > denied.txt', 1_000 ) )
		throw new Error( 'Ran denied command' );
	if ( scenario === 'completed' ) {
		const command = 'printf approved >> approved.txt && echo finished';
		const timeout = 30_000;
		if (
			! ( await permission( 'writer', command, timeout ) ) ||
			( await permission( 'writer', command, timeout ) ) ||
			( await firstOutput ) !== 'finished'
		)
			throw new Error( 'Bash command did not complete' );
		await result( command, timeout, { stdout: 'finished\n', stderr: '', interrupted: false } );
		if ( await permission( 'writer', command, timeout ) ) throw new Error( 'Replayed command' );
		return;
	}
	const node = "'" + process.execPath.replace( /\\/g, '/' ).replace( /'/g, "'\\''" ) + "'";
	const writer = [
		"const fs = require('node:fs')",
		"function tick() { fs.appendFileSync('heartbeat.txt', '.') }",
		'tick()',
		'console.log(process.pid)',
		'setInterval(tick, 30)',
		'setTimeout(() => process.exit(0), 45000)',
	].join( '; ' );
	const command = `printf approved > approved.txt; ${ node } -e "${ writer }"; :`;
	const timeout = scenario === 'timeout' ? 8_000 : 45_000;
	if ( ! ( await permission( 'writer', command, timeout ) ) )
		throw new Error( 'Bash command denied' );
	const writerPid = Number( await firstOutput );
	if ( ! Number.isSafeInteger( writerPid ) || writerPid <= 0 )
		throw new Error( 'Invalid writer PID' );
	process.send?.( { type: 'bash-started', shell: shell.pid, writer: writerPid } );
	if ( scenario === 'invalid result' || scenario === 'sandbox override' ) {
		await reportResult;
		await result(
			command,
			timeout,
			scenario === 'invalid result'
				? {}
				: {
						stdout: '',
						stderr: '',
						interrupted: false,
						dangerouslyDisableSandbox: true,
				  }
		);
	}
}
