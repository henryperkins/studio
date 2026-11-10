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
	type StreamBlock = {
		text: string;
		sequence: number;
		confirmed: boolean;
		type?: string;
		finalText?: string;
	};
	const messages = new Map< string, Map< number, StreamBlock > >();
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
					openIndex = undefined;
					if ( messageId && ! messages.has( messageId ) ) messages.set( messageId, new Map() );
				} else if ( event?.type === 'content_block_start' && typeof event.index === 'number' ) {
					openIndex = event.index;
					const blocks = messageId ? messages.get( messageId ) : undefined;
					if ( blocks && ! blocks.has( event.index ) ) {
						const content = object( event.content_block );
						blocks.set( event.index, {
							text: '',
							sequence: 0,
							confirmed: false,
							type: typeof content?.type === 'string' ? content.type : undefined,
						} );
					}
				} else if (
					event?.type === 'content_block_delta' &&
					typeof event.index === 'number' &&
					messageId
				) {
					const delta = object( event.delta );
					const block = messages.get( messageId )?.get( event.index );
					const text =
						delta?.type === 'text_delta'
							? delta.text
							: delta?.type === 'thinking_delta'
							? delta.thinking
							: undefined;
					if (
						block &&
						! block.confirmed &&
						( ( block.type === 'text' && delta?.type === 'text_delta' ) ||
							( block.type === 'thinking' && delta?.type === 'thinking_delta' ) ) &&
						typeof text === 'string'
					) {
						block.text += text;
						onEvent( {
							type: 'content.provisional',
							runId,
							turnId,
							messageId,
							blockId: String( event.index ),
							blockType: block.type === 'thinking' ? 'reasoning' : 'text',
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
				if ( typeof payload?.id !== 'string' ) return;
				const id = payload.id;
				let blocks = messages.get( id );
				for ( const [ position, rawBlock ] of content.entries() ) {
					const block = object( rawBlock );
					const text =
						block?.type === 'text'
							? block.text
							: block?.type === 'thinking'
							? block.thinking
							: undefined;
					if ( typeof text !== 'string' ) continue;
					const blockType = block?.type === 'thinking' ? 'reasoning' : 'text';
					let index: number | undefined;
					if ( content.length > 1 ) index = position;
					else if ( blocks ) {
						const candidates = [ ...blocks.entries() ].filter(
							( [ , state ] ) =>
								state.type === block?.type && ! state.confirmed && text.startsWith( state.text )
						);
						const evidenced = candidates.filter( ( [ , state ] ) => state.text.length > 0 );
						index =
							evidenced.find(
								( [ candidate ] ) => id === messageId && candidate === openIndex
							)?.[ 0 ] ??
							( evidenced.length === 1 ? evidenced[ 0 ][ 0 ] : undefined ) ??
							candidates.find(
								( [ candidate ] ) => id === messageId && candidate === openIndex
							)?.[ 0 ] ??
							( candidates.length === 1 ? candidates[ 0 ][ 0 ] : undefined );
						if (
							index === undefined &&
							[ ...blocks.values() ].some(
								( state ) =>
									state.type === block?.type && state.confirmed && state.finalText === text
							)
						)
							continue;
					}
					let state = index === undefined ? undefined : blocks?.get( index );
					if ( content.length > 1 && index !== undefined && ! state ) {
						if ( ! blocks ) {
							blocks = new Map();
							messages.set( id, blocks );
						}
						state = { text: '', sequence: 0, confirmed: false, type: block?.type as string };
						blocks.set( index, state );
					}
					if ( state?.confirmed ) continue;
					if ( state ) {
						state.confirmed = true;
						state.finalText = text;
					}
					onEvent( {
						type: 'content.confirmed',
						runId,
						turnId,
						messageId: id,
						blockId: index === undefined ? message.uuid : String( index ),
						blockType,
						text,
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
