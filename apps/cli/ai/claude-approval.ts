import { createInterface } from 'node:readline/promises';
import { escapeClaudeApprovalText } from '@studio/agent/protocol/claude-code';
import { __ } from '@wordpress/i18n';
import type { ClaudeToolPolicy } from '@studio/agent/node/claude-code/tool-bridge';

export function getTerminalClaudeApprover(): ClaudeToolPolicy[ 'approve' ] | undefined {
	if ( ! process.stdin.isTTY || ! process.stderr.isTTY ) return;
	let previous: Promise< 'allow' | 'deny' > = Promise.resolve( 'deny' );
	return ( request, signal ) => {
		previous = previous.then( async () => {
			if ( signal.aborted ) return 'deny';
			const terminal = createInterface( { input: process.stdin, output: process.stderr } );
			const closed = new AbortController();
			const stop = () => closed.abort();
			terminal.once( 'close', stop );
			terminal.once( 'SIGINT', stop );
			try {
				const details = escapeClaudeApprovalText( JSON.stringify( request.args, null, 2 ) );
				const answer = await terminal.question(
					`${ request.description }\n${ details }\n${ __(
						'Allow this draft operation? Type yes to approve.'
					) } `,
					{ signal: AbortSignal.any( [ signal, closed.signal ] ) }
				);
				return ! signal.aborted && answer.trim().toLowerCase() === 'yes' ? 'allow' : 'deny';
			} catch {
				return 'deny';
			} finally {
				terminal.close();
			}
		} );
		return previous;
	};
}
