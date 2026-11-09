import type { BackendTurnEvent, BackendTurnOutcome } from '@studio/agent/protocol/backend-events';

type ObjectValue = Record< string, unknown >;
function object( value: unknown ): ObjectValue | undefined {
	return value && typeof value === 'object' && ! Array.isArray( value )
		? ( value as ObjectValue )
		: undefined;
}

export function createClaudeEventAdapter(
	runId: string,
	turnId: string,
	onEvent: ( event: BackendTurnEvent ) => void
) {
	let terminal = false;
	let messageId: string | undefined;
	let openIndex: number | undefined;
	const frames = new Set< string >();
	const blocks = new Map< number, { text: string; sequence: number; confirmed: boolean } >();
	return {
		accept( message: ObjectValue ) {
			if ( terminal ) return;
			if ( message.type === 'rate_limit_event' ) {
				const rate = object( message.rate_limit_info );
				if (
					rate?.status === 'rejected' ||
					rate?.isUsingOverage === true ||
					rate?.overageInUse === true
				) {
					terminal = true;
					onEvent( {
						type: 'turn.terminal',
						runId,
						turnId,
						outcome: { status: 'error', message: 'Claude Code reported a usage limit or overage.' },
					} );
				}
				return;
			}
			if ( message.type === 'stream_event' ) {
				const event = object( message.event );
				if ( event?.type === 'message_start' ) {
					const start = object( event.message );
					messageId = typeof start?.id === 'string' ? start.id : undefined;
					blocks.clear();
				} else if ( event?.type === 'content_block_start' && typeof event.index === 'number' ) {
					openIndex = event.index;
					blocks.set( event.index, { text: '', sequence: 0, confirmed: false } );
				} else if (
					event?.type === 'content_block_delta' &&
					typeof event.index === 'number' &&
					messageId
				) {
					const delta = object( event.delta );
					const block = blocks.get( event.index );
					if (
						block &&
						! block.confirmed &&
						delta?.type === 'text_delta' &&
						typeof delta.text === 'string'
					) {
						block.text += delta.text;
						onEvent( {
							type: 'content.provisional',
							runId,
							turnId,
							messageId,
							blockId: String( event.index ),
							blockType: 'text',
							text: block.text,
							sequence: ++block.sequence,
						} );
					}
				} else if ( event?.type === 'content_block_stop' && event.index === openIndex )
					openIndex = undefined;
				return;
			}
			if (
				message.type === 'assistant' &&
				typeof message.uuid === 'string' &&
				! frames.has( message.uuid )
			) {
				frames.add( message.uuid );
				const payload = object( message.message );
				const content = Array.isArray( payload?.content ) ? payload.content : [];
				const block = object( content[ 0 ] );
				if (
					typeof payload?.id === 'string' &&
					block?.type === 'text' &&
					typeof block.text === 'string'
				) {
					const index = payload.id === messageId ? openIndex : undefined;
					const state = index === undefined ? undefined : blocks.get( index );
					if ( state ) state.confirmed = true;
					onEvent( {
						type: 'content.confirmed',
						runId,
						turnId,
						messageId: payload.id,
						blockId: index === undefined ? message.uuid : String( index ),
						blockType: 'text',
						text: block.text,
					} );
				}
				return;
			}
			if ( message.type !== 'result' ) return;
			let outcome: BackendTurnOutcome;
			if (
				message.subtype === 'success' &&
				message.is_error === false &&
				typeof message.num_turns === 'number' &&
				message.num_turns > 0 &&
				( message.terminal_reason === undefined || message.terminal_reason === 'completed' )
			)
				outcome = { status: 'success' };
			else if ( message.subtype === 'error_max_turns' ) outcome = { status: 'max_turns' };
			else if ( message.subtype === 'error_max_budget_usd' )
				outcome = { status: 'budget_exceeded' };
			else outcome = { status: 'error', message: 'Claude Code reported an error.' };
			terminal = true;
			onEvent( { type: 'turn.terminal', runId, turnId, outcome } );
		},
	};
}
