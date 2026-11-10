import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type ThinkingLevelMap,
} from '@earendil-works/pi-ai';
import { streamSimple as streamOpenAiResponses } from '@earendil-works/pi-ai/api/openai-responses';
import { __, sprintf } from '@wordpress/i18n';
import {
	CHATGPT_RESPONSES_URL,
	ChatGptRouteError,
	sendChatGptRequest,
	summarizeChatGptTokenFailure,
	type ChatGptRouteResponse,
	type ChatGptTokenSource,
} from '@studio/agent/node/chatgpt/route';
import { OPENAI_API_BASE_URL } from '@studio/agent/node/openai-model-list';
import { toPiThinkingLevel } from '@studio/agent/node/runtime/openai-transport';
import {
	classifyChatGptStreamEvent,
	describeChatGptError,
	redactChatGptSecrets,
	type ChatGptErrorSummary,
} from '@studio/agent/protocol/chatgpt-errors';
import {
	describeChatGptReasoningProblem,
	getChatGptModelCapabilities,
	resolveChatGptReasoning,
} from '@studio/agent/protocol/chatgpt-models';
import {
	OPENAI_REASONING_EFFORTS,
	type OpenAiReasoningEffort,
} from '@studio/agent/protocol/openai-models';
import { CHATGPT_PI_PROVIDER } from '@studio/agent/protocol/providers';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ProviderModelRef } from '@studio/agent/protocol/connections';

/*
 * Studio's transport for the ChatGPT plan route (SIWC "Models and inference"
 * and "Preview limitations"): pi's own Responses streaming, with a fetch that
 * reaches only the route and authenticates each request with the turn's
 * current token, and a payload hook that rebuilds pi's request field by
 * field. A turn succeeds only on `response.completed`; anything else is a
 * failure that keeps what streamed, marked incomplete, and is never re-run.
 */

type ProviderConfigInput = Parameters< ModelRuntime[ 'registerProvider' ] >[ 1 ];

// Compaction keeps context under this local budget, as on Studio's other
// providers. The route documents no context window of its own.
const CHATGPT_CONTEXT_BUDGET = 200_000;
// pi's models carry an output cap, which it would send as `max_output_tokens`.
// The route takes no such field (`supportsMaxOutputTokens: false` stops pi,
// and the serializer would drop it anyway), so this only feeds pi's estimates.
const LOCAL_MAX_OUTPUT_TOKENS = 32_000;
// pi calls a provider only with an API key, which its OpenAI client sends as
// the bearer. The fetch below builds every request's headers itself, with the
// turn's token, so this placeholder is neither a credential nor ever sent.
const TOKEN_FROM_TURN = 'studio-chatgpt-token-from-turn';

/** What one ChatGPT turn fixes when it starts. Never a token: only where to get one. */
export interface ChatGptTurnSnapshot {
	/** The connection the turn runs on: its turn handle's. */
	connectionId: string;
	/** A current access token for each request: the turn handle's `getAccessToken`. */
	getAccessToken: ChatGptTokenSource;
	/** Aborted once the connection is signed out, or changes, under the turn: the turn handle's. */
	signal: AbortSignal;
	/** Invalidates the rejected token without discarding a newer one. */
	invalidateAccessToken?: ( rejectedAccessToken: string ) => Promise< void >;
	/** The effort every request of the turn sends. */
	reasoningEffort: OpenAiReasoningEffort;
}

interface ChatGptFunctionTool {
	type: 'function';
	name: string;
	description?: string;
	parameters: Record< string, unknown > | null;
	strict: boolean;
}

type ChatGptInputContent =
	| { type: 'input_text'; text: string }
	| { type: 'input_image'; image_url: string; detail?: string };

type ChatGptInputItem =
	| { type: 'additional_tools'; role: 'developer'; tools: ChatGptFunctionTool[] }
	| { role: 'developer'; content: string }
	| { role: 'user'; content: string | ChatGptInputContent[] }
	| {
			type: 'message';
			role: 'assistant';
			content: Array< { type: 'output_text'; text: string; annotations: unknown[] } >;
			id?: string;
			status?: string;
			phase?: 'commentary' | 'final_answer';
	  }
	// Replayed as the route produced it, for stateless reasoning.
	| {
			type: 'reasoning';
			id: string;
			summary: unknown[];
			encrypted_content?: string;
			content?: unknown[];
			status?: string;
	  }
	| { type: 'function_call'; call_id: string; name: string; arguments: string; id?: string }
	| { type: 'function_call_output'; call_id: string; output: string | ChatGptInputContent[] };

/**
 * The body of one request to the ChatGPT route: exactly these fields. There
 * is no top-level `tools`; tools travel in an `additional_tools` item.
 */
export interface ChatGptResponsesRequest {
	model: string;
	instructions?: string;
	input: ChatGptInputItem[];
	stream: true;
	store: false;
	reasoning: { effort: OpenAiReasoningEffort };
	/** Encrypted reasoning to replay, statelessly; undocumented for this route. */
	include?: [ 'reasoning.encrypted_content' ];
}

const isRecord = ( value: unknown ): value is Record< string, unknown > =>
	typeof value === 'object' && value !== null && ! Array.isArray( value );

// An item's or tool's `type` for a message: never anything longer, such as content.
const describeKind = ( value: unknown ) =>
	typeof value === 'string' && /^[\w.-]{1,64}$/.test( value ) ? value : typeof value;

function refuse( message: string ): never {
	throw new Error( message );
}

function refuseItem( type: unknown ): never {
	return refuse(
		sprintf(
			/* translators: %s: the type of a Responses API input item, e.g. "tool_search_call". */
			__( 'Studio stopped a ChatGPT request with an item it doesn’t send to ChatGPT (“%s”).' ),
			describeKind( type )
		)
	);
}

function requireString( value: unknown, type: unknown ): string {
	return typeof value === 'string' ? value : refuseItem( type );
}

function serializeContent( value: unknown, type: unknown ): ChatGptInputContent {
	if ( isRecord( value ) && value.type === 'input_text' ) {
		return { type: 'input_text', text: requireString( value.text, type ) };
	}
	if ( isRecord( value ) && value.type === 'input_image' ) {
		return {
			type: 'input_image',
			image_url: requireString( value.image_url, type ),
			...( typeof value.detail === 'string' ? { detail: value.detail } : {} ),
		};
	}
	return refuseItem( isRecord( value ) ? value.type : typeof value );
}

function serializeContentList( value: unknown, type: unknown ): string | ChatGptInputContent[] {
	if ( typeof value === 'string' ) {
		return value;
	}
	return Array.isArray( value )
		? value.map( ( part ) => serializeContent( part, type ) )
		: refuseItem( type );
}

function serializeAssistantMessage( item: Record< string, unknown > ): ChatGptInputItem {
	if ( ! Array.isArray( item.content ) ) {
		return refuseItem( item.type );
	}
	return {
		type: 'message',
		role: 'assistant',
		content: item.content.map( ( part ) =>
			isRecord( part ) && part.type === 'output_text'
				? {
						type: 'output_text',
						text: requireString( part.text, item.type ),
						annotations: Array.isArray( part.annotations ) ? part.annotations : [],
				  }
				: refuseItem( isRecord( part ) ? part.type : typeof part )
		),
		...( typeof item.id === 'string' ? { id: item.id } : {} ),
		...( typeof item.status === 'string' ? { status: item.status } : {} ),
		...( item.phase === 'commentary' || item.phase === 'final_answer'
			? { phase: item.phase }
			: {} ),
	};
}

function serializeInputItem( item: unknown ): ChatGptInputItem {
	if ( ! isRecord( item ) ) {
		return refuseItem( typeof item );
	}
	const { type } = item;
	if ( type === undefined || type === 'message' ) {
		switch ( item.role ) {
			// Never a system message: the route rejects those.
			case 'system':
			case 'developer':
				return { role: 'developer', content: requireString( item.content, item.role ) };
			case 'user':
				return { role: 'user', content: serializeContentList( item.content, item.role ) };
			case 'assistant':
				return serializeAssistantMessage( item );
		}
		return refuseItem( item.role );
	}
	switch ( type ) {
		case 'reasoning':
			return {
				type: 'reasoning',
				id: requireString( item.id, type ),
				summary: Array.isArray( item.summary ) ? item.summary : [],
				...( typeof item.encrypted_content === 'string'
					? { encrypted_content: item.encrypted_content }
					: {} ),
				...( Array.isArray( item.content ) ? { content: item.content } : {} ),
				...( typeof item.status === 'string' ? { status: item.status } : {} ),
			};
		case 'function_call':
			return {
				type: 'function_call',
				call_id: requireString( item.call_id, type ),
				name: requireString( item.name, type ),
				arguments: requireString( item.arguments, type ),
				...( typeof item.id === 'string' ? { id: item.id } : {} ),
			};
		case 'function_call_output':
			return {
				type: 'function_call_output',
				call_id: requireString( item.call_id, type ),
				output: serializeContentList( item.output, type ),
			};
	}
	return refuseItem( type );
}

// Only Studio's own function tools, under their flat names: never tool search,
// hosted MCP, image generation, file search, Code Interpreter or computer use.
function serializeTool( tool: unknown ): ChatGptFunctionTool {
	if ( ! isRecord( tool ) || tool.type !== 'function' || typeof tool.name !== 'string' ) {
		return refuse(
			sprintf(
				/* translators: %s: the type of a Responses API tool, e.g. "image_generation". */
				__(
					'Studio stopped a ChatGPT request declaring a tool it doesn’t send to ChatGPT (“%s”).'
				),
				describeKind( isRecord( tool ) ? tool.type : tool )
			)
		);
	}
	return {
		type: 'function',
		name: tool.name,
		...( typeof tool.description === 'string' ? { description: tool.description } : {} ),
		parameters: isRecord( tool.parameters ) ? tool.parameters : null,
		strict: tool.strict === true,
	};
}

// The leading system text pi builds from the turn's system prompt.
function isSystemText( item: unknown ): item is { content: string } {
	return (
		isRecord( item ) &&
		( item.type === undefined || item.type === 'message' ) &&
		( item.role === 'developer' || item.role === 'system' ) &&
		typeof item.content === 'string'
	);
}

/**
 * The request the ChatGPT route gets for the request pi built: each field it
 * takes, rebuilt from pi's, and nothing else. Refuses (throws) a request for
 * another model or effort than the turn's, and one carrying an item or tool
 * Studio doesn't send to ChatGPT.
 */
export function serializeChatGptRequest(
	params: unknown,
	target: { model: string; reasoningEffort: OpenAiReasoningEffort }
): ChatGptResponsesRequest {
	const payload = isRecord( params ) ? params : {};
	if ( payload.model !== target.model ) {
		refuse(
			sprintf(
				/* translators: 1: the model a request named, 2: the model chosen for the chat. */
				__( 'Studio stopped a ChatGPT request for %1$s instead of the selected %2$s.' ),
				describeKind( payload.model ),
				target.model
			)
		);
	}
	const effort = isRecord( payload.reasoning ) ? payload.reasoning.effort : undefined;
	if ( effort !== target.reasoningEffort ) {
		refuse(
			sprintf(
				/* translators: 1: the reasoning effort a request would have used, 2: the effort chosen for the chat. */
				__(
					'Studio stopped a ChatGPT request that would have used %1$s reasoning instead of the selected %2$s.'
				),
				typeof effort === 'string' ? effort : __( 'the default' ),
				target.reasoningEffort
			)
		);
	}
	const items: unknown[] = Array.isArray( payload.input )
		? [ ...payload.input ]
		: refuseItem( typeof payload.input );
	let instructions = typeof payload.instructions === 'string' ? payload.instructions : undefined;
	const first = items[ 0 ];
	if ( instructions === undefined && isSystemText( first ) ) {
		instructions = first.content;
		items.shift();
	}
	const tools = Array.isArray( payload.tools ) ? payload.tools.map( serializeTool ) : [];
	const declarations: ChatGptInputItem[] = tools.length
		? [ { type: 'additional_tools', role: 'developer', tools } ]
		: [];
	const replaysReasoning =
		Array.isArray( payload.include ) && payload.include.includes( 'reasoning.encrypted_content' );
	return {
		model: target.model,
		...( instructions ? { instructions } : {} ),
		input: [ ...declarations, ...items.map( serializeInputItem ) ],
		stream: true,
		store: false,
		reasoning: { effort: target.reasoningEffort },
		...( replaysReasoning ? { include: [ 'reasoning.encrypted_content' ] } : {} ),
	};
}

function buildThinkingLevelMap( efforts: readonly OpenAiReasoningEffort[] ): ThinkingLevelMap {
	return Object.fromEntries(
		OPENAI_REASONING_EFFORTS.map( ( effort ) => [
			toPiThinkingLevel( effort ),
			efforts.includes( effort ) ? effort : null,
		] )
	) as ThinkingLevelMap;
}

/** The pi model of one ChatGPT-route model, by the slug the route lists it under. */
export function buildChatGptModel(
	model: ProviderModelRef,
	label?: string
): Model< 'openai-responses' > {
	if ( model.providerId !== 'chatgpt-oauth' ) {
		throw new Error( `${ model.modelId } isn’t a ChatGPT model.` );
	}
	const capabilities = getChatGptModelCapabilities( model.modelId );
	if ( ! capabilities ) {
		throw new Error(
			describeChatGptReasoningProblem( { code: 'unknown-model', model: model.modelId } )
		);
	}
	return {
		id: model.modelId,
		name: label ?? model.modelId,
		api: 'openai-responses',
		provider: CHATGPT_PI_PROVIDER,
		baseUrl: OPENAI_API_BASE_URL,
		reasoning: true,
		input: capabilities.imageInput ? [ 'text', 'image' ] : [ 'text' ],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: CHATGPT_CONTEXT_BUDGET,
		maxTokens: LOCAL_MAX_OUTPUT_TOKENS,
		thinkingLevelMap: buildThinkingLevelMap( capabilities.reasoningEfforts ),
		compat: {
			// `strict: false` on every function tool, as on the OpenAI API route.
			supportsStrictMode: true,
			// What the serializer relies on: system text collapsed into one leading
			// message, tools in the top-level list it moves into an
			// `additional_tools` item, no tool search, grammar tools or
			// `configuration_update` items, and no output cap.
			supportsMidConvoSystemMessages: false,
			supportsAdditionalTools: false,
			supportsToolSearch: false,
			supportsOpenAIGrammarTools: false,
			supportsMidConvoEffort: false,
			supportsMaxOutputTokens: false,
		},
	};
}

interface ChatGptExchange {
	fetch: typeof fetch;
	serialize( params: unknown ): ChatGptResponsesRequest;
	/** Why the request failed before its stream opened: refused, no token or connection, an HTTP error. */
	failure?: ChatGptErrorSummary;
	/** A request was sent. */
	sent: boolean;
	/** The route answered with a stream. */
	opened: boolean;
	requestId?: string;
	/** `response.completed` arrived. */
	completed: boolean;
	/** The stream's first `response.failed`, `response.incomplete` or `error` event. */
	streamFailure?: ChatGptErrorSummary;
	/** The stream's body ended without breaking. */
	ended: boolean;
	redact( text: string ): string;
}

/**
 * Watches the server-sent events going by, without changing a byte: pi reads
 * the stream, but an `error` event's code and param never reach it, and
 * neither does whether the body ended or broke.
 */
function watchEventStream( response: Response, exchange: ChatGptExchange ): Response {
	if ( ! response.body ) {
		return response;
	}
	const decoder = new TextDecoder();
	let pending = '';
	let eventName = '';
	let data: string[] = [];
	const dispatch = () => {
		const text = data.join( '\n' );
		const name = eventName;
		data = [];
		eventName = '';
		let event: unknown;
		try {
			event = JSON.parse( text );
		} catch {
			return;
		}
		if ( ! isRecord( event ) ) {
			return;
		}
		const typed = event.type === undefined && name ? { ...event, type: name } : event;
		if ( typed.type === 'response.completed' ) {
			exchange.completed = true;
			return;
		}
		const failure = classifyChatGptStreamEvent( typed );
		if ( failure && ! exchange.streamFailure ) {
			// The code and param are shown to the user too, so the turn's token
			// comes out of them as it does out of the detail, in the same safe
			// form classification gave them.
			const safeReference = ( text: string ) =>
				exchange
					.redact( text )
					.replace( /[^A-Za-z0-9._-]/g, '_' )
					.slice( 0, 64 );
			exchange.streamFailure = {
				...failure,
				...( failure.code ? { code: safeReference( failure.code ) } : {} ),
				...( failure.param ? { param: safeReference( failure.param ) } : {} ),
				...( failure.detail ? { detail: exchange.redact( failure.detail ) } : {} ),
			};
		}
	};
	const read = ( text: string ) => {
		const lines = ( pending + text ).split( /\r\n|\r|\n/ );
		pending = lines.pop() ?? '';
		for ( const line of lines ) {
			if ( line === '' ) {
				if ( data.length ) {
					dispatch();
				}
			} else if ( line.startsWith( 'data:' ) ) {
				data.push( line.slice( line.startsWith( 'data: ' ) ? 6 : 5 ) );
			} else if ( line.startsWith( 'event:' ) ) {
				eventName = line.slice( 6 ).trim();
			}
		}
	};
	const watched = response.body.pipeThrough(
		new TransformStream< Uint8Array, Uint8Array >( {
			transform( chunk, controller ) {
				controller.enqueue( chunk );
				read( decoder.decode( chunk, { stream: true } ) );
			},
			flush() {
				// As pi's SSE reader does, an event missing its closing blank line counts.
				read( `${ decoder.decode() }\n\n` );
				exchange.ended = true;
			},
		} )
	);
	return new Response( watched, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	} );
}

function createChatGptExchange(
	target: { model: string; reasoningEffort: OpenAiReasoningEffort },
	getAccessToken: ChatGptTokenSource,
	invalidateAccessToken?: ( rejectedAccessToken: string ) => Promise< void >
): ChatGptExchange {
	const exchange: ChatGptExchange = {
		sent: false,
		opened: false,
		completed: false,
		ended: false,
		redact: ( text ) => redactChatGptSecrets( text ),
		serialize( params ) {
			try {
				return serializeChatGptRequest( params, target );
			} catch ( error ) {
				exchange.failure = {
					kind: 'refused',
					detail: error instanceof Error ? error.message : String( error ),
				};
				throw error;
			}
		},
		fetch: ( async ( input: RequestInfo | URL, init?: RequestInit ) => {
			const url = new URL( input instanceof Request ? input.url : String( input ) ).href;
			const body = init?.body;
			if (
				url !== CHATGPT_RESPONSES_URL ||
				init?.method?.toUpperCase() !== 'POST' ||
				typeof body !== 'string'
			) {
				exchange.failure = {
					kind: 'refused',
					detail: __( 'Studio sends ChatGPT plan requests only to OpenAI’s Responses API.' ),
				};
				throw new Error( exchange.failure.detail );
			}
			exchange.sent = true;
			let result: ChatGptRouteResponse;
			try {
				result = await sendChatGptRequest( {
					endpoint: 'responses',
					body,
					getAccessToken,
					invalidateAccessToken,
					signal: init?.signal ?? undefined,
				} );
			} catch ( error ) {
				if ( error instanceof ChatGptRouteError ) {
					exchange.failure = error.summary;
				}
				throw error;
			}
			exchange.requestId = result.requestId;
			exchange.redact = result.redact;
			if ( result.failure ) {
				exchange.failure = result.failure;
				return result.response;
			}
			exchange.opened = true;
			return watchEventStream( result.response, exchange );
		} ) as typeof fetch,
	};
	return exchange;
}

// Why a turn's request ended without `response.completed`, from what was seen.
function classifyOutcome( exchange: ChatGptExchange, piMessage: string ): ChatGptErrorSummary {
	const requestId = exchange.requestId ? { requestId: exchange.requestId } : {};
	const detail = piMessage.trim() ? { detail: exchange.redact( piMessage.trim() ) } : {};
	if ( exchange.failure ) {
		return exchange.failure;
	}
	if ( exchange.streamFailure ) {
		return { ...exchange.streamFailure, ...requestId };
	}
	if ( ! exchange.sent ) {
		return { kind: 'refused', ...detail };
	}
	if ( ! exchange.opened ) {
		return { kind: 'network', ...detail };
	}
	if ( exchange.completed ) {
		return { kind: 'invalid-response', ...requestId, ...detail };
	}
	return exchange.ended
		? { kind: 'no-completion', ...requestId }
		: { kind: 'interrupted', ...requestId, ...detail };
}

const hasPartialOutput = ( message: AssistantMessage ) =>
	message.content.some(
		( block ) => block.type === 'toolCall' || ( block.type === 'text' && block.text.trim() !== '' )
	);

function toFailure(
	message: AssistantMessage,
	summary: ChatGptErrorSummary,
	exchange?: ChatGptExchange
): AssistantMessageEvent {
	const partial = hasPartialOutput( message ) ? { partial: true } : {};
	const fullSummary = { ...summary, ...partial };
	// After streaming began, the server's raw reference and diagnostic text
	// stay out of `errorMessage`: pi reads that text for overflow recovery
	// and would compact and re-send. They ride in a structured diagnostic.
	const postStream = Boolean( exchange?.opened || exchange?.streamFailure );
	if ( postStream ) {
		message.diagnostics = [
			...( message.diagnostics ?? [] ),
			{
				type: 'studio.chatgpt-error',
				timestamp: Date.now(),
				details: { ...fullSummary },
			},
		];
	}
	const described = postStream ? { kind: summary.kind, ...partial } : fullSummary;
	message.stopReason = 'error';
	message.errorMessage = describeChatGptError( described );
	return { type: 'error', reason: 'error', error: message };
}

function toInterrupted(
	message: AssistantMessage,
	summary: ChatGptErrorSummary
): AssistantMessageEvent {
	message.stopReason = 'aborted';
	// The broker's own words for why the connection ended, with no reference
	// appended: the clear sign-out message the user reads.
	message.errorMessage = summary.detail ?? describeChatGptError( summary );
	return { type: 'error', reason: 'aborted', error: message };
}

/**
 * Passes pi's events on, and makes its last one honest: a success only after
 * `response.completed`; any other ending a classified failure that keeps the
 * text that streamed; a cancellation left as one. A turn whose connection
 * ended under it fails with the reason the connection gave.
 */
function withChatGptOutcome(
	source: AssistantMessageEventStream,
	exchange: ChatGptExchange,
	userSignal: AbortSignal | undefined,
	connectionSignal: AbortSignal
): AssistantMessageEventStream {
	const outcome = createAssistantMessageEventStream();
	const connectionEnded = () => connectionSignal.aborted && ! userSignal?.aborted;
	void ( async () => {
		let lastMessage: AssistantMessage | undefined;
		let pushedTerminal = false;
		try {
			for await ( const event of source ) {
				if ( event.type === 'done' ) {
					lastMessage = event.message;
					const succeeded =
						exchange.completed && ( event.reason === 'stop' || event.reason === 'toolUse' );
					pushedTerminal = true;
					outcome.push(
						succeeded
							? event
							: toFailure( event.message, classifyOutcome( exchange, '' ), exchange )
					);
				} else if ( event.type === 'error' && connectionEnded() ) {
					lastMessage = event.error;
					pushedTerminal = true;
					outcome.push(
						toInterrupted( event.error, summarizeChatGptTokenFailure( connectionSignal.reason ) )
					);
				} else if ( event.type === 'error' && event.reason === 'error' ) {
					lastMessage = event.error;
					pushedTerminal = true;
					outcome.push(
						toFailure(
							event.error,
							classifyOutcome( exchange, event.error.errorMessage ?? '' ),
							exchange
						)
					);
				} else if ( event.type === 'error' ) {
					lastMessage = event.error;
					pushedTerminal = true;
					outcome.push( event );
				} else {
					if ( 'partial' in event && event.partial ) {
						lastMessage = event.partial as AssistantMessage;
					}
					outcome.push( event );
				}
			}
		} catch ( error ) {
			if ( ! pushedTerminal && lastMessage ) {
				try {
					outcome.push(
						connectionEnded()
							? toInterrupted(
									lastMessage,
									summarizeChatGptTokenFailure( connectionSignal.reason )
							  )
							: toFailure(
									lastMessage,
									classifyOutcome(
										exchange,
										error instanceof Error ? error.message : String( error )
									),
									exchange
							  )
					);
				} catch {
					// Ending the stream below is what keeps the turn from hanging.
				}
			}
		} finally {
			outcome.end();
		}
	} )();
	return outcome;
}

/**
 * The pi registration of one ChatGPT turn's model, under `CHATGPT_PI_PROVIDER`.
 * Holds no token: each request takes one from the turn's token source.
 */
export function createChatGptProviderConfig(
	model: Model< 'openai-responses' >,
	connectionId: string,
	turnSnapshot: ChatGptTurnSnapshot
): ProviderConfigInput {
	if ( turnSnapshot.connectionId !== connectionId ) {
		throw new Error( 'This ChatGPT turn snapshot belongs to another ChatGPT connection.' );
	}
	if ( model.provider !== CHATGPT_PI_PROVIDER ) {
		throw new Error( `${ model.id } isn’t a ChatGPT model.` );
	}
	const reasoning = resolveChatGptReasoning( model.id, turnSnapshot.reasoningEffort );
	if ( ! reasoning.ok ) {
		throw new Error( describeChatGptReasoningProblem( reasoning.problem ) );
	}
	const target = { model: model.id, reasoningEffort: reasoning.effort };
	return {
		baseUrl: OPENAI_API_BASE_URL,
		apiKey: TOKEN_FROM_TURN,
		api: 'openai-responses',
		streamSimple: ( m, context, options?: SimpleStreamOptions ) => {
			const exchange = createChatGptExchange(
				target,
				turnSnapshot.getAccessToken,
				turnSnapshot.invalidateAccessToken
			);
			const userSignal = options?.signal;
			return withChatGptOutcome(
				streamOpenAiResponses( m as Model< 'openai-responses' >, context, {
					...options,
					signal: userSignal
						? AbortSignal.any( [ userSignal, turnSnapshot.signal ] )
						: turnSnapshot.signal,
					// Only a 503 is tried again, by the fetch, before anything streams.
					maxRetries: 0,
					fetch: exchange.fetch,
					onPayload: async ( params: unknown, payloadModel ) => {
						const next = ( await options?.onPayload?.( params, payloadModel ) ) ?? params;
						return exchange.serialize( next );
					},
				} ),
				exchange,
				userSignal,
				turnSnapshot.signal
			);
		},
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				baseUrl: model.baseUrl,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				thinkingLevelMap: model.thinkingLevelMap,
				compat: model.compat,
			},
		],
	};
}
