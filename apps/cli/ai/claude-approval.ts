import { createInterface } from 'node:readline/promises';
import {
	escapeClaudeApprovalText,
	getClaudeApprovalDisplayArgs,
} from '@studio/agent/protocol/claude-code';
import { __ } from '@wordpress/i18n';
import type { ClaudeApprover } from '@studio/agent/node/claude-code/execution-policy';

export function getTerminalClaudeApprover(): ClaudeApprover | undefined {
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
				const { operation, target } = request;
				const details = escapeClaudeApprovalText(
					JSON.stringify(
						{
							tool: operation.tool,
							target,
							localPaths: operation.localPaths,
							remote: operation.remote,
							args: getClaudeApprovalDisplayArgs( operation.tool, operation.args ),
						},
						null,
						2
					)
				);
				const answer = await terminal.question(
					`${ escapeClaudeApprovalText( operation.description ) }\n${ details }\n${ __(
						'Allow this operation? Type yes to approve.'
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

/**
 * Routes a Claude turn's approval requests to whoever answers them: a Studio
 * app over IPC, by request ID, or else a local approver such as the terminal.
 * With neither, every request is denied. A request is answered at most once;
 * a reply for a request that is no longer pending is ignored.
 */
export function createClaudeApprovalRouter( options: { viaIpc: boolean; local?: ClaudeApprover } ) {
	const pending = new Map< string, ( answer: 'allow' | 'deny' ) => void >();
	const approve: ClaudeApprover = async ( request, signal ) => {
		if ( signal.aborted ) return 'deny';
		if ( ! options.viaIpc ) return options.local ? options.local( request, signal ) : 'deny';
		return new Promise( ( resolve ) => {
			const done = ( answer: 'allow' | 'deny' ) => {
				if ( pending.get( request.requestId ) !== done ) return;
				pending.delete( request.requestId );
				signal.removeEventListener( 'abort', abort );
				resolve( answer );
			};
			const abort = () => done( 'deny' );
			pending.get( request.requestId )?.( 'deny' );
			pending.set( request.requestId, done );
			signal.addEventListener( 'abort', abort, { once: true } );
			if ( signal.aborted ) abort();
		} );
	};
	return {
		approve,
		answer( answers: Record< string, unknown > ) {
			for ( const [ requestId, answer ] of Object.entries( answers ) )
				if ( answer === 'allow' || answer === 'deny' ) pending.get( requestId )?.( answer );
		},
		cancelAll() {
			for ( const done of [ ...pending.values() ] ) done( 'deny' );
		},
	};
}
