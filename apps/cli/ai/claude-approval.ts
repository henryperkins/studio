import {
	escapeClaudeApprovalText,
	getClaudeApprovalDisplayArgs,
} from '@studio/agent/protocol/claude-code';
import { __ } from '@wordpress/i18n';
import { withClaudeTerminal } from './claude-terminal';
import type { ClaudeApprover } from '@studio/agent/node/claude-code/execution-policy';

export function getTerminalClaudeApprover(): ClaudeApprover | undefined {
	if ( ! process.stdin.isTTY || ! process.stderr.isTTY ) return;
	return ( request, signal ) =>
		withClaudeTerminal< 'allow' | 'deny' >( signal, async ( terminal, active ) => {
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
				{ signal: active }
			);
			return ! signal.aborted && answer.trim().toLowerCase() === 'yes' ? 'allow' : 'deny';
		} ).catch( () => 'deny' );
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
