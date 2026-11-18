import {
	isCompleteClaudeAnswer,
	type ClaudeQuestionAsker,
} from '@studio/agent/node/claude-code/questions';
import { escapeClaudeApprovalText } from '@studio/agent/protocol/claude-code';
import { SKIPPED_QUESTION } from '@studio/agent/protocol/tools';
import { __ } from '@wordpress/i18n';
import { withClaudeTerminal } from './claude-terminal';

export function getTerminalClaudeQuestionAsker(): ClaudeQuestionAsker | undefined {
	if ( ! process.stdin.isTTY || ! process.stderr.isTTY ) return;
	return ( request, signal ) =>
		withClaudeTerminal( signal, async ( terminal, active ) => {
			const answers = new Map< string, string >();
			for ( const q of request.questions ) {
				const options = q.options.map(
					( option, index ) =>
						`${ index + 1 }. ${ option.label } — ${ option.description }${
							option.image ? '\n' + option.image : ''
						}`
				);
				const hint = q.multiSelect
					? __(
							'Enter option numbers separated by commas, type an answer, or press Enter to skip.'
					  )
					: __( 'Enter an option number, type an answer, or press Enter to skip.' );
				active.throwIfAborted();
				const reply = (
					await terminal.question(
						escapeClaudeApprovalText( [ q.question, ...options, hint, '> ' ].join( '\n' ) ),
						{ signal: active }
					)
				).trim();
				const selections = ( q.multiSelect ? reply.split( ',' ) : [ reply ] ).map( ( v ) =>
					v.trim()
				);
				const labels = selections.map( ( v ) =>
					/^[1-9]\d*$/.test( v ) ? q.options[ Number( v ) - 1 ]?.label : undefined
				);
				answers.set(
					q.question,
					labels.every( ( label ) => label !== undefined )
						? [ ...new Set( labels ) ].join( ', ' )
						: reply || SKIPPED_QUESTION
				);
			}
			active.throwIfAborted();
			return Object.fromEntries( answers );
		} );
}

export function createClaudeQuestionRouter( viaIpc: boolean, local?: ClaudeQuestionAsker ) {
	type Request = Parameters< ClaudeQuestionAsker >[ 0 ];
	const pending = new Map<
		string,
		{ request: Request; resolve: ( answers: Record< string, string > ) => void }
	>();
	const lifetime = new AbortController();
	const ask: ClaudeQuestionAsker = ( request, signal ) => {
		const active = AbortSignal.any( [ signal, lifetime.signal ] );
		active.throwIfAborted();
		if ( ! viaIpc && local ) return local( request, active );
		return new Promise( ( resolve, reject ) => {
			const cancel = () => {
				pending.delete( request.requestId );
				reject( active.reason );
			};
			active.addEventListener( 'abort', cancel, { once: true } );
			pending.set( request.requestId, {
				request,
				resolve: ( answers ) => {
					pending.delete( request.requestId );
					active.removeEventListener( 'abort', cancel );
					resolve( answers );
				},
			} );
		} );
	};
	return {
		ask: viaIpc || local ? ask : undefined,
		answer( message: {
			requestId?: unknown;
			runId?: unknown;
			turnId?: unknown;
			answers?: unknown;
		} ) {
			if ( typeof message.requestId !== 'string' ) return;
			const batch = pending.get( message.requestId );
			if (
				batch &&
				batch.request.runId === message.runId &&
				batch.request.turnId === message.turnId &&
				isCompleteClaudeAnswer( batch.request, message.answers )
			)
				batch.resolve( message.answers );
		},
		cancelAll: () => lifetime.abort(),
	};
}
