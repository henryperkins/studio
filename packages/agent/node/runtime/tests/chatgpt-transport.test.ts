// @vitest-environment node
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatGptConnectionError } from '@studio/agent/node/chatgpt/account-store';
import { CHATGPT_UNAVAILABLE_RETRY_DELAYS_MS } from '@studio/agent/node/chatgpt/route';
import { CHATGPT_MODEL_CAPABILITIES } from '@studio/agent/protocol/chatgpt-models';
import { OPENAI_MODEL_CAPABILITIES } from '@studio/agent/protocol/openai-models';
import { CHATGPT_PI_PROVIDER, OPENAI_PI_PROVIDER } from '@studio/agent/protocol/providers';
import {
	buildChatGptModel,
	createChatGptProviderConfig,
	serializeChatGptRequest,
	type ChatGptTurnSnapshot,
} from '../chatgpt-transport';
import {
	buildOpenAiModel,
	createOpenAiProviderConfig,
	toPiThinkingLevel,
} from '../openai-transport';
import type {
	AssistantMessage,
	Context,
	Credential,
	CredentialInfo,
	CredentialStore,
	Message,
	Model,
	SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { OpenAiReasoningEffort } from '@studio/agent/protocol/openai-models';

/*
 * Studio's ChatGPT-plan transport, registered with a real pi model runtime and
 * streamed through pi's own Responses code, with only `fetch` replaced: every
 * request is captured, every reply is a scripted server-sent event stream
 * built from the shapes OpenAI documents. Nothing here reaches OpenAI, and
 * every token is a test string.
 */

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const CONNECTION = 'registration-test';
const TOKEN = 'test-chatgpt-access-token';
// A test key only, for the OpenAI API comparison.
const API_KEY = 'sk-proj-TESTONLY_chatgpt_transport_dddddddddddddddddd';
const SYSTEM_PROMPT = 'You are Studio’s assistant.';

// The fields the route documents as unsupported, and the two it says to omit.
const FORBIDDEN_FIELDS = [
	'background',
	'conversation',
	'max_output_tokens',
	'max_tool_calls',
	'metadata',
	'moderation',
	'multi_agent',
	'prompt',
	'prompt_cache_retention',
	'safety_identifier',
	'temperature',
	'top_logprobs',
	'top_p',
	'truncation',
	'user',
	'previous_response_id',
	'service_tier',
];

const TOOLS = [
	{
		name: 'Read',
		description: 'Read a file in the site.',
		parameters: {
			type: 'object',
			properties: { path: { type: 'string' } },
			required: [ 'path' ],
		},
	},
	{
		name: 'site_create',
		description: 'Create a local site.',
		parameters: {
			type: 'object',
			properties: { name: { type: 'string' }, blueprint: { type: 'object' } },
			required: [ 'name' ],
		},
	},
];

class MemoryCredentialStore implements CredentialStore {
	private readonly credentials = new Map< string, Credential >();
	async read( providerId: string ) {
		return this.credentials.get( providerId );
	}
	async list(): Promise< readonly CredentialInfo[] > {
		return [ ...this.credentials ].map( ( [ providerId, credential ] ) => ( {
			providerId,
			type: credential.type,
		} ) );
	}
	async modify(
		providerId: string,
		fn: ( current: Credential | undefined ) => Promise< Credential | undefined >
	) {
		const next = await fn( this.credentials.get( providerId ) );
		if ( next ) {
			this.credentials.set( providerId, next );
		}
		return next;
	}
	async delete( providerId: string ) {
		this.credentials.delete( providerId );
	}
}

interface TestSnapshot extends ChatGptTurnSnapshot {
	tokenRequests: number;
}

function snapshotFor(
	reasoningEffort: OpenAiReasoningEffort,
	overrides: Partial< ChatGptTurnSnapshot > = {}
): TestSnapshot {
	const snapshot: TestSnapshot = {
		connectionId: CONNECTION,
		tokenRequests: 0,
		getAccessToken: async () => {
			snapshot.tokenRequests++;
			return TOKEN;
		},
		signal: new AbortController().signal,
		reasoningEffort,
		...overrides,
	};
	return snapshot;
}

async function registerChatGpt( snapshot: ChatGptTurnSnapshot, slug = 'gpt-6.1-sol' ) {
	const model = buildChatGptModel( { providerId: 'chatgpt-oauth', modelId: slug }, 'GPT-6.1 Sol' );
	const runtime = await ModelRuntime.create( {
		credentials: new MemoryCredentialStore(),
		modelsPath: null,
	} );
	runtime.registerProvider(
		CHATGPT_PI_PROVIDER,
		createChatGptProviderConfig( model, CONNECTION, snapshot )
	);
	return { runtime, model };
}

// One request through the registered provider, as pi's agent loop sends it:
// the session's thinking level becomes `reasoning`.
function streamTurn(
	turn: { runtime: ModelRuntime; model: Model< 'openai-responses' > },
	context: Context,
	effort: OpenAiReasoningEffort,
	extra: SimpleStreamOptions = {}
) {
	const level = toPiThinkingLevel( effort );
	return turn.runtime.streamSimple( turn.model, context, {
		maxRetries: 0,
		reasoning: level === 'off' ? undefined : level,
		...extra,
	} );
}

const userMessage = ( text: string ): Message => ( { role: 'user', content: text, timestamp: 0 } );

const conversation = ( messages: Message[], tools = TOOLS ): Context => ( {
	systemPrompt: SYSTEM_PROMPT,
	messages,
	tools,
} );

function sseText( events: Array< Record< string, unknown > > ): string {
	return events
		.map( ( event ) => `event: ${ String( event.type ) }\ndata: ${ JSON.stringify( event ) }\n\n` )
		.join( '' );
}

const STREAM_HEADERS = { 'content-type': 'text/event-stream', 'x-request-id': 'req_stream_1' };

function sse( events: Array< Record< string, unknown > > ): Response {
	return new Response( sseText( events ), { status: 200, headers: STREAM_HEADERS } );
}

// The same events, delivered a few bytes at a time, splitting lines and
// multi-byte characters across chunks.
function chunkedSse( events: Array< Record< string, unknown > >, size = 7 ): Response {
	const bytes = new TextEncoder().encode( sseText( events ) );
	return new Response(
		new ReadableStream< Uint8Array >( {
			start( controller ) {
				for ( let offset = 0; offset < bytes.length; offset += size ) {
					controller.enqueue( bytes.slice( offset, offset + size ) );
				}
				controller.close();
			},
		} ),
		{ status: 200, headers: STREAM_HEADERS }
	);
}

// The events, then a dropped connection. The failure waits for the next read:
// erroring a stream discards what it hasn't delivered yet.
function brokenSse( events: Array< Record< string, unknown > > ): Response {
	const bytes = new TextEncoder().encode( sseText( events ) );
	let sent = false;
	return new Response(
		new ReadableStream< Uint8Array >( {
			pull( controller ) {
				if ( sent ) {
					controller.error( new TypeError( 'terminated' ) );
					return;
				}
				sent = true;
				controller.enqueue( bytes );
			},
		} ),
		{ status: 200, headers: STREAM_HEADERS }
	);
}

// The events, then nothing until the request is canceled.
function stalledSse( events: Array< Record< string, unknown > > ): Response {
	const bytes = new TextEncoder().encode( sseText( events ) );
	let sent = false;
	return new Response(
		new ReadableStream< Uint8Array >( {
			pull( controller ) {
				if ( ! sent ) {
					sent = true;
					controller.enqueue( bytes );
				}
				return new Promise( () => {} );
			},
		} ),
		{ status: 200, headers: STREAM_HEADERS }
	);
}

function jsonError( status: number, body: unknown, requestId = 'req_http_1' ): Response {
	return new Response( JSON.stringify( body ), {
		status,
		headers: { 'content-type': 'application/json', 'x-request-id': requestId },
	} );
}

const usage = {
	input_tokens: 120,
	input_tokens_details: { cached_tokens: 0 },
	output_tokens: 40,
	output_tokens_details: { reasoning_tokens: 25 },
	total_tokens: 160,
};

const created = ( id: string ) => ( {
	type: 'response.created',
	response: { id, status: 'in_progress', output: [] },
} );

const messageStart = ( id: string ) => ( {
	type: 'response.output_item.added',
	output_index: 0,
	item: { type: 'message', id, role: 'assistant', content: [], status: 'in_progress' },
} );

const textDelta = ( id: string, delta: string ) => ( {
	type: 'response.output_text.delta',
	output_index: 0,
	item_id: id,
	delta,
} );

const messageDone = ( id: string, text: string ) => ( {
	type: 'response.output_item.done',
	output_index: 0,
	item: {
		type: 'message',
		id,
		role: 'assistant',
		status: 'completed',
		content: [ { type: 'output_text', text, annotations: [] } ],
	},
} );

const completed = ( id: string, output: unknown[] = [] ) => ( {
	type: 'response.completed',
	response: { id, status: 'completed', output, usage },
} );

const textReply = ( text: string ) => [
	created( 'resp_text' ),
	messageStart( 'msg_text' ),
	textDelta( 'msg_text', text ),
	messageDone( 'msg_text', text ),
	completed( 'resp_text' ),
];

// Text that started streaming, with no ending yet.
const PARTIAL = [
	created( 'resp_partial' ),
	messageStart( 'msg_partial' ),
	textDelta( 'msg_partial', 'Here is the first half of' ),
];

const REASONING_ITEM = {
	type: 'reasoning',
	id: 'rs_1',
	summary: [],
	encrypted_content: 'test-encrypted-reasoning-1',
};
const FUNCTION_CALL = {
	type: 'function_call',
	id: 'fc_1',
	call_id: 'call_1',
	name: 'Read',
	arguments: '{"path":"wp-config.php"}',
	status: 'completed',
};

const toolCallStart = [
	created( 'resp_tool' ),
	{
		type: 'response.output_item.added',
		output_index: 0,
		item: { ...REASONING_ITEM, encrypted_content: undefined },
	},
	{ type: 'response.output_item.done', output_index: 0, item: REASONING_ITEM },
	{
		type: 'response.output_item.added',
		output_index: 1,
		item: { ...FUNCTION_CALL, arguments: '', status: 'in_progress' },
	},
	{
		type: 'response.function_call_arguments.delta',
		output_index: 1,
		item_id: 'fc_1',
		delta: '{"path":"wp-co',
	},
	{
		type: 'response.function_call_arguments.delta',
		output_index: 1,
		item_id: 'fc_1',
		delta: 'nfig.php"}',
	},
];

const TOOL_CALL_REPLY = [
	...toolCallStart,
	{
		type: 'response.function_call_arguments.done',
		output_index: 1,
		item_id: 'fc_1',
		arguments: FUNCTION_CALL.arguments,
	},
	{ type: 'response.output_item.done', output_index: 1, item: FUNCTION_CALL },
	completed( 'resp_tool', [ REASONING_ITEM, FUNCTION_CALL ] ),
];

interface CapturedRequest {
	url: string;
	init: RequestInit;
	headers: Headers;
	body: Record< string, unknown > & { input: Array< Record< string, unknown > > };
}

function captureFetch( replies: Array< () => Response > | ( () => Response ) ) {
	const spy = vi.spyOn( globalThis, 'fetch' ).mockImplementation( async () => {
		if ( typeof replies === 'function' ) {
			return replies();
		}
		const reply = replies.shift();
		if ( ! reply ) {
			throw new Error( 'No reply scripted for this request.' );
		}
		return reply();
	} );
	return {
		spy,
		request( index = 0 ): CapturedRequest {
			const [ url, init ] = spy.mock.calls[ index ];
			return {
				url: String( url ),
				init: init!,
				headers: new Headers( init?.headers ),
				body: JSON.parse( String( init?.body ) ),
			};
		},
	};
}

const asFunctionTools = ( tools: typeof TOOLS ) =>
	tools.map( ( tool ) => ( {
		type: 'function',
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		strict: false,
	} ) );

function expectFailure( reply: AssistantMessage ) {
	expect( reply.stopReason ).toBe( 'error' );
	expect( reply.errorMessage ).not.toContain( TOKEN );
	expect( reply.errorMessage ).not.toContain( '(ChatGPT plan billing' );
}

describe( 'the ChatGPT transport', () => {
	const savedEnv = { ...process.env };

	beforeEach( () => {
		process.env = { ...savedEnv };
	} );

	afterEach( () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		process.env = { ...savedEnv };
	} );

	describe( 'requests', () => {
		it( 'sends one stateless streamed request to the public Responses endpoint, with the turn’s token', async () => {
			const snapshot = snapshotFor( 'medium' );
			const turn = await registerChatGpt( snapshot );
			const http = captureFetch( [ () => sse( textReply( 'Hello.' ) ) ] );

			const reply = await streamTurn(
				turn,
				conversation( [ userMessage( 'hello' ) ] ),
				'medium'
			).result();

			expect( reply.stopReason ).toBe( 'stop' );
			expect( reply.provider ).toBe( CHATGPT_PI_PROVIDER );
			expect( http.spy ).toHaveBeenCalledTimes( 1 );
			const { url, init, headers, body } = http.request();
			expect( url ).toBe( RESPONSES_URL );
			expect( init.method ).toBe( 'POST' );
			expect( init.redirect ).toBe( 'error' );
			expect( [ ...headers.keys() ].sort() ).toEqual( [ 'authorization', 'content-type' ] );
			expect( headers.get( 'authorization' ) ).toBe( `Bearer ${ TOKEN }` );
			expect( headers.get( 'content-type' ) ).toBe( 'application/json' );
			expect( Object.keys( body ).sort() ).toEqual( [
				'include',
				'input',
				'instructions',
				'model',
				'reasoning',
				'store',
				'stream',
			] );
			expect( body ).toMatchObject( {
				model: 'gpt-6.1-sol',
				instructions: SYSTEM_PROMPT,
				stream: true,
				store: false,
				reasoning: { effort: 'medium' },
			} );
			expect( body.input ).toEqual( [
				{ type: 'additional_tools', role: 'developer', tools: asFunctionTools( TOOLS ) },
				{ role: 'user', content: [ { type: 'input_text', text: 'hello' } ] },
			] );
		} );

		// `include` is undocumented for this route: it is sent only because pi asks
		// for encrypted reasoning to replay it statelessly, as on the public API.
		it( 'asks for encrypted reasoning exactly when pi does, for stateless replay (undocumented for this route)', async () => {
			const withReasoning = await registerChatGpt( snapshotFor( 'low' ), 'gpt-6.1-terra' );
			const without = await registerChatGpt( snapshotFor( 'none' ), 'gpt-6.1-terra' );
			const http = captureFetch( [ () => sse( textReply( 'a' ) ), () => sse( textReply( 'b' ) ) ] );

			await streamTurn( withReasoning, conversation( [ userMessage( 'hi' ) ] ), 'low' ).result();
			await streamTurn( without, conversation( [ userMessage( 'hi' ) ] ), 'none' ).result();

			expect( http.request( 0 ).body.include ).toEqual( [ 'reasoning.encrypted_content' ] );
			expect( http.request( 1 ).body ).not.toHaveProperty( 'include' );
			expect( http.request( 1 ).body.reasoning ).toEqual( { effort: 'none' } );
		} );

		it.each(
			Object.entries( CHATGPT_MODEL_CAPABILITIES ).flatMap( ( [ slug, capabilities ] ) =>
				capabilities.reasoningEfforts.map( ( effort ) => [ slug, effort ] as const )
			)
		)( 'sends %s with exactly %s effort', async ( slug, effort ) => {
			const turn = await registerChatGpt( snapshotFor( effort ), slug );
			const http = captureFetch( [ () => sse( textReply( 'Done.' ) ) ] );

			const reply = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				effort
			).result();

			expect( reply.stopReason ).toBe( 'stop' );
			expect( http.request().body.model ).toBe( slug );
			expect( http.request().body.reasoning ).toEqual( { effort } );
		} );

		it( 'refuses to send an effort other than the selected one', async () => {
			const turn = await registerChatGpt( snapshotFor( 'high' ) );
			const http = captureFetch( [ () => sse( textReply( 'no' ) ) ] );

			const reply = await streamTurn( turn, conversation( [ userMessage( 'hi' ) ] ), 'high', {
				reasoning: 'low',
			} ).result();

			expectFailure( reply );
			expect( reply.errorMessage ).toMatch(
				/would have used low reasoning instead of the selected high/
			);
			expect( http.spy ).not.toHaveBeenCalled();
		} );

		it( 'declares every tool once, in a developer additional_tools item ahead of the conversation', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			const http = captureFetch( [
				() => sse( TOOL_CALL_REPLY ),
				() => sse( textReply( 'Read it.' ) ),
			] );

			const first = await streamTurn(
				turn,
				conversation( [ userMessage( 'read the config' ) ] ),
				'medium'
			).result();
			await streamTurn(
				turn,
				conversation( [
					userMessage( 'read the config' ),
					first,
					{
						role: 'toolResult',
						toolCallId: 'call_1|fc_1',
						toolName: 'Read',
						content: [ { type: 'text', text: '<?php // config' } ],
						isError: false,
						timestamp: 0,
					},
				] ),
				'medium'
			).result();

			for ( const index of [ 0, 1 ] ) {
				const { body } = http.request( index );
				expect( body ).not.toHaveProperty( 'tools' );
				const declarations = body.input.filter( ( item ) => item.type === 'additional_tools' );
				expect( declarations ).toEqual( [
					{ type: 'additional_tools', role: 'developer', tools: asFunctionTools( TOOLS ) },
				] );
				expect( body.input[ 0 ] ).toBe( declarations[ 0 ] );
			}
		} );

		it( 'replays the conversation statelessly, keeping item ids and their order', async () => {
			const turn = await registerChatGpt( snapshotFor( 'xhigh' ) );
			const http = captureFetch( [
				() => sse( TOOL_CALL_REPLY ),
				() => sse( textReply( 'Read it.' ) ),
			] );

			const first = await streamTurn(
				turn,
				conversation( [ userMessage( 'read the config' ) ] ),
				'xhigh'
			).result();
			expect( first.stopReason ).toBe( 'toolUse' );
			expect( first.content.find( ( block ) => block.type === 'toolCall' ) ).toMatchObject( {
				id: 'call_1|fc_1',
				name: 'Read',
				arguments: { path: 'wp-config.php' },
			} );

			const second = await streamTurn(
				turn,
				conversation( [
					userMessage( 'read the config' ),
					first,
					{
						role: 'toolResult',
						toolCallId: 'call_1|fc_1',
						toolName: 'Read',
						content: [ { type: 'text', text: '<?php // config' } ],
						isError: false,
						timestamp: 0,
					},
				] ),
				'xhigh'
			).result();

			expect( second.stopReason ).toBe( 'stop' );
			const { body } = http.request( 1 );
			expect( body ).not.toHaveProperty( 'previous_response_id' );
			expect( body.store ).toBe( false );
			expect( body.reasoning ).toEqual( { effort: 'xhigh' } );
			expect( body.input.slice( 1 ) ).toEqual( [
				{ role: 'user', content: [ { type: 'input_text', text: 'read the config' } ] },
				REASONING_ITEM,
				{
					type: 'function_call',
					id: 'fc_1',
					call_id: 'call_1',
					name: 'Read',
					arguments: '{"path":"wp-config.php"}',
				},
				{ type: 'function_call_output', call_id: 'call_1', output: '<?php // config' },
			] );
		} );

		it( 'takes a token from the turn’s token source for every request and keeps none', async () => {
			let issued = 0;
			const snapshot = snapshotFor( 'medium', {
				getAccessToken: async () => `test-rotating-token-${ ++issued }`,
			} );
			const turn = await registerChatGpt( snapshot );
			expect( issued ).toBe( 0 );
			const http = captureFetch( [ () => sse( textReply( 'a' ) ), () => sse( textReply( 'b' ) ) ] );

			await streamTurn( turn, conversation( [ userMessage( 'one' ) ] ), 'medium' ).result();
			await streamTurn( turn, conversation( [ userMessage( 'two' ) ] ), 'medium' ).result();

			expect( http.request( 0 ).headers.get( 'authorization' ) ).toBe(
				'Bearer test-rotating-token-1'
			);
			expect( http.request( 1 ).headers.get( 'authorization' ) ).toBe(
				'Bearer test-rotating-token-2'
			);
			// The registration pi keeps holds neither token, after both requests.
			const registered = turn.runtime.getRegisteredProviderConfig( CHATGPT_PI_PROVIDER );
			expect( registered?.apiKey ).toBeDefined();
			expect( JSON.stringify( registered ) ).not.toMatch( /test-rotating-token/ );
		} );

		it( 'sends system text as instructions and never a system message', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			const http = captureFetch( [ () => sse( textReply( 'ok' ) ) ] );

			await streamTurn(
				turn,
				conversation( [
					userMessage( 'hi' ),
					{ role: 'system', content: 'Later note.', timestamp: 0 },
				] ),
				'medium'
			).result();

			const { body } = http.request();
			expect( body.instructions ).toContain( SYSTEM_PROMPT );
			expect( body.input.some( ( item ) => item.role === 'system' ) ).toBe( false );
		} );

		it( 'leaves out every unsupported field whatever the caller asks for', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			const http = captureFetch( [ () => sse( textReply( 'ok' ) ) ] );

			await streamTurn( turn, conversation( [ userMessage( 'hi' ) ] ), 'medium', {
				maxTokens: 9_000,
				temperature: 0.2,
				sessionId: 'session-1',
				cacheRetention: 'long',
				toolChoice: 'auto',
				metadata: { user: 'someone' },
				serviceTier: 'priority',
			} as SimpleStreamOptions ).result();

			const { body } = http.request();
			for ( const field of FORBIDDEN_FIELDS ) {
				expect( body ).not.toHaveProperty( field );
			}
			expect( Object.keys( body ).sort() ).toEqual( [
				'include',
				'input',
				'instructions',
				'model',
				'reasoning',
				'store',
				'stream',
			] );
		} );

		it( 'sends no account or client headers, whatever the caller or environment adds', async () => {
			process.env.OPENAI_ORG_ID = 'org-ambient';
			process.env.OPENAI_PROJECT_ID = 'proj_ambient';
			process.env.OPENAI_CUSTOM_HEADERS = `Authorization: Bearer ${ API_KEY }\nX-Team: web`;
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			const http = captureFetch( [ () => sse( textReply( 'ok' ) ) ] );

			await streamTurn( turn, conversation( [ userMessage( 'hi' ) ] ), 'medium', {
				sessionId: 'session-1',
				headers: { 'ChatGPT-Account-Id': 'acct_1', 'X-Extra': 'value' },
			} ).result();

			const { headers } = http.request();
			expect( [ ...headers.keys() ].sort() ).toEqual( [ 'authorization', 'content-type' ] );
			expect( headers.get( 'authorization' ) ).toBe( `Bearer ${ TOKEN }` );
		} );

		it( 'sends no output cap, while an OpenAI API request keeps its configured one', async () => {
			const chatGpt = await registerChatGpt( snapshotFor( 'medium' ) );
			const settings = {
				model: 'gpt-6.1-sol' as const,
				apiModelId: OPENAI_MODEL_CAPABILITIES[ 'gpt-6.1-sol' ].apiModelId,
				reasoningEffort: 'medium' as const,
				reasoningMode: 'standard' as const,
				maxOutputTokens: 64_000,
			};
			const openAiModel = buildOpenAiModel( settings, 'GPT-6.1 Sol' );
			const openAiRuntime = await ModelRuntime.create( {
				credentials: new MemoryCredentialStore(),
				modelsPath: null,
			} );
			openAiRuntime.registerProvider(
				OPENAI_PI_PROVIDER,
				createOpenAiProviderConfig( openAiModel, API_KEY, settings )
			);
			const http = captureFetch( [ () => sse( textReply( 'a' ) ), () => sse( textReply( 'b' ) ) ] );

			await streamTurn( chatGpt, conversation( [ userMessage( 'hi' ) ] ), 'medium', {
				maxTokens: 64_000,
			} ).result();
			await streamTurn(
				{ runtime: openAiRuntime, model: openAiModel },
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();

			expect( http.request( 0 ).body ).not.toHaveProperty( 'max_output_tokens' );
			expect( http.request( 1 ).body.max_output_tokens ).toBe( 64_000 );
			expect( http.request( 1 ).headers.get( 'authorization' ) ).toBe( `Bearer ${ API_KEY }` );
		} );

		it( 'uses the turn’s token even with OpenAI API keys in the environment', async () => {
			process.env.OPENAI_API_KEY = API_KEY;
			process.env.STUDIO_OPENAI_API_KEY = API_KEY;
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			const http = captureFetch( () =>
				jsonError( 401, { error: { code: 'subscription_sharing_invalid_user', message: 'No.' } } )
			);

			const reply = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();

			expectFailure( reply );
			expect( http.spy ).toHaveBeenCalledTimes( 1 );
			expect( http.request().url ).toBe( RESPONSES_URL );
			expect( http.request().headers.get( 'authorization' ) ).toBe( `Bearer ${ TOKEN }` );
		} );
	} );

	describe( 'the provider configuration', () => {
		it( 'refuses a turn snapshot made for another connection', () => {
			expect( () =>
				createChatGptProviderConfig(
					buildChatGptModel( { providerId: 'chatgpt-oauth', modelId: 'gpt-6.1-sol' } ),
					'registration-other',
					snapshotFor( 'medium' )
				)
			).toThrow( /another ChatGPT connection/ );
		} );

		it( 'refuses an effort the model doesn’t list, rather than sending a nearby one', () => {
			expect( () =>
				createChatGptProviderConfig(
					buildChatGptModel( { providerId: 'chatgpt-oauth', modelId: 'gpt-6-astra' } ),
					CONNECTION,
					snapshotFor( 'none' )
				)
			).toThrow( 'gpt-6-astra doesn’t support “None” reasoning with ChatGPT.' );
		} );

		it( 'builds models only for ChatGPT slugs it has capabilities for', () => {
			expect( () =>
				buildChatGptModel( { providerId: 'chatgpt-oauth', modelId: 'gpt-7-nova' } )
			).toThrow( /gpt-7-nova/ );
			expect( () =>
				buildChatGptModel( { providerId: 'openai-api-key', modelId: 'gpt-6.1-sol' } )
			).toThrow( /isn’t a ChatGPT model/ );
			expect(
				buildChatGptModel( { providerId: 'chatgpt-oauth', modelId: 'gpt-6-luna' }, 'GPT-6 Luna' )
			).toMatchObject( {
				id: 'gpt-6-luna',
				name: 'GPT-6 Luna',
				api: 'openai-responses',
				provider: CHATGPT_PI_PROVIDER,
				baseUrl: 'https://api.openai.com/v1',
				reasoning: true,
				input: [ 'text', 'image' ],
				thinkingLevelMap: {
					off: 'none',
					minimal: null,
					low: 'low',
					medium: 'medium',
					high: 'high',
					xhigh: 'xhigh',
					max: 'max',
				},
			} );
		} );
	} );

	describe( 'serializeChatGptRequest', () => {
		const target = { model: 'gpt-6.1-sol', reasoningEffort: 'medium' as const };
		const piPayload = ( extra: Record< string, unknown > = {} ) => ( {
			model: 'gpt-6.1-sol',
			stream: true,
			store: false,
			input: [
				{ role: 'developer', content: SYSTEM_PROMPT },
				{ role: 'user', content: [ { type: 'input_text', text: 'hi' } ] },
			],
			reasoning: { effort: 'medium', summary: 'auto' },
			...extra,
		} );

		it( 'builds the body from what it allows, never from what pi sent', () => {
			const request = serializeChatGptRequest(
				piPayload( {
					...Object.fromEntries( FORBIDDEN_FIELDS.map( ( field ) => [ field, 'x' ] ) ),
					prompt_cache_key: 'session',
					tool_choice: 'auto',
					parallel_tool_calls: true,
					text: { verbosity: 'low' },
				} ),
				target
			);

			expect( request ).toEqual( {
				model: 'gpt-6.1-sol',
				instructions: SYSTEM_PROMPT,
				input: [ { role: 'user', content: [ { type: 'input_text', text: 'hi' } ] } ],
				stream: true,
				store: false,
				reasoning: { effort: 'medium' },
			} );
		} );

		it( 'turns later system text into developer messages', () => {
			const request = serializeChatGptRequest(
				piPayload( {
					input: [
						{ role: 'developer', content: SYSTEM_PROMPT },
						{ role: 'user', content: [ { type: 'input_text', text: 'hi' } ] },
						{ type: 'message', role: 'system', content: 'Later.' },
					],
				} ),
				target
			);

			expect( request.input.at( -1 ) ).toEqual( { role: 'developer', content: 'Later.' } );
		} );

		it.each( [
			[ 'tool search', { type: 'tool_search_call', call_id: 'c', execution: 'client' } ],
			[ 'a mid-conversation effort change', { type: 'configuration_update', reasoning: {} } ],
			[ 'a hosted tool call', { type: 'image_generation_call', id: 'ig_1' } ],
		] )( 'refuses to send %s', ( _name, item ) => {
			expect( () =>
				serializeChatGptRequest(
					piPayload( {
						input: [ { role: 'user', content: [ { type: 'input_text', text: 'hi' } ] }, item ],
					} ),
					target
				)
			).toThrow( /Studio stopped a ChatGPT request/ );
		} );

		it.each( [
			[ 'image generation', { type: 'image_generation' } ],
			[ 'hosted MCP', { type: 'mcp', server_label: 'x', server_url: 'https://example.com' } ],
			[ 'tool search', { type: 'tool_search' } ],
			[ 'file search', { type: 'file_search', vector_store_ids: [] } ],
			[ 'Code Interpreter', { type: 'code_interpreter', container: { type: 'auto' } } ],
			[ 'computer use', { type: 'computer_use_preview' } ],
		] )( 'refuses to declare %s', ( _name, tool ) => {
			expect( () => serializeChatGptRequest( piPayload( { tools: [ tool ] } ), target ) ).toThrow(
				/Studio stopped a ChatGPT request/
			);
		} );

		it( 'refuses a request for another model', () => {
			expect( () =>
				serializeChatGptRequest( piPayload( { model: 'gpt-6-luna' } ), target )
			).toThrow( /gpt-6-luna instead of the selected gpt-6.1-sol/ );
		} );
	} );

	describe( 'completion', () => {
		it( 'succeeds only on response.completed', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			captureFetch( [ () => sse( textReply( 'All done.' ) ) ] );

			const reply = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();

			expect( reply.stopReason ).toBe( 'stop' );
			expect( reply.errorMessage ).toBeUndefined();
			expect( reply.content ).toEqual( [
				expect.objectContaining( { type: 'text', text: 'All done.' } ),
			] );
		} );

		it( 'keeps text that streamed before response.failed, marked incomplete', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			const http = captureFetch( [
				() =>
					sse( [
						...PARTIAL,
						{
							type: 'response.failed',
							response: {
								id: 'resp_partial',
								status: 'failed',
								error: {
									code: 'subscription_sharing_usage_limit_exceeded',
									message: 'Usage limit reached.',
								},
								output: [],
							},
						},
					] ),
			] );

			const reply = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();

			expectFailure( reply );
			expect( reply.content ).toEqual( [
				expect.objectContaining( { type: 'text', text: 'Here is the first half of' } ),
			] );
			expect( reply.errorMessage ).toMatch( /^You’ve reached a ChatGPT usage limit/ );
			expect( reply.errorMessage ).toContain( 'https://chatgpt.com/settings/usage' );
			expect( reply.errorMessage ).toContain( 'The partial reply is kept but incomplete.' );
			expect( reply.errorMessage ).not.toContain( 'subscription_sharing_usage_limit_exceeded' );
			expect( reply.diagnostics ).toEqual( [
				expect.objectContaining( {
					type: 'studio.chatgpt-error',
					details: expect.objectContaining( {
						code: 'subscription_sharing_usage_limit_exceeded',
						requestId: 'req_stream_1',
					} ),
				} ),
			] );
			expect( http.spy ).toHaveBeenCalledTimes( 1 );
		} );

		it( 'fails on response.incomplete, keeping its text, even for the output-cap reason', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			captureFetch( [
				() =>
					sse( [
						...PARTIAL,
						{
							type: 'response.incomplete',
							response: {
								id: 'resp_partial',
								status: 'incomplete',
								incomplete_details: { reason: 'max_output_tokens' },
								output: [],
								usage,
							},
						},
					] ),
			] );

			const reply = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();

			expectFailure( reply );
			expect( reply.content ).toEqual( [
				expect.objectContaining( { text: 'Here is the first half of' } ),
			] );
			expect( reply.errorMessage ).toMatch( /^ChatGPT stopped before finishing its reply/ );
			expect( reply.errorMessage ).not.toContain( 'max_output_tokens' );
			expect( reply.diagnostics ).toEqual( [
				expect.objectContaining( {
					details: expect.objectContaining( { code: 'max_output_tokens' } ),
				} ),
			] );
			expect( reply.errorMessage ).toContain( 'The partial reply is kept but incomplete.' );
		} );

		it( 'fails on an error event, keeping its code and param, however the bytes arrive', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			captureFetch( [
				() =>
					chunkedSse( [
						...PARTIAL,
						{
							type: 'error',
							code: 'subscription_sharing_unsupported_capability',
							message: 'Not supported — remove it.',
							param: 'input[2].content',
							sequence_number: 4,
						},
					] ),
			] );

			const reply = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();

			expectFailure( reply );
			expect( reply.errorMessage ).toMatch(
				/^ChatGPT plan usage doesn’t support part of this request/
			);
			expect( reply.errorMessage ).not.toContain( 'subscription_sharing_unsupported_capability' );
			expect( reply.diagnostics ).toEqual( [
				expect.objectContaining( {
					details: expect.objectContaining( {
						code: 'subscription_sharing_unsupported_capability',
						param: 'input_2_.content',
					} ),
				} ),
			] );
		} );

		it( 'reads an `error` event whose data nests its error, as the OpenAI SDK does', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			const error = {
				error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Limit reached.' },
			};
			captureFetch( [
				() =>
					new Response(
						`${ sseText( PARTIAL ) }event: error\ndata: ${ JSON.stringify( error ) }\n\n`,
						{
							status: 200,
							headers: STREAM_HEADERS,
						}
					),
			] );

			const reply = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();

			expectFailure( reply );
			expect( reply.errorMessage ).toMatch( /^You’ve reached a ChatGPT usage limit/ );
			expect( reply.errorMessage ).toContain( 'The partial reply is kept but incomplete.' );
		} );

		it( 'fails when the stream ends without a terminal event', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			captureFetch( [ () => sse( PARTIAL ) ] );

			const reply = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();

			expectFailure( reply );
			expect( reply.errorMessage ).toMatch( /^ChatGPT’s reply ended before ChatGPT confirmed/ );
			expect( reply.content ).toEqual( [
				expect.objectContaining( { text: 'Here is the first half of' } ),
			] );
		} );

		it( 'fails when the connection drops mid-stream', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			const http = captureFetch( [ () => brokenSse( PARTIAL ) ] );

			const reply = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();

			expectFailure( reply );
			expect( reply.errorMessage ).toMatch( /^The connection to ChatGPT dropped/ );
			expect( reply.errorMessage ).toContain( 'The partial reply is kept but incomplete.' );
			expect( http.spy ).toHaveBeenCalledTimes( 1 );
		} );

		it( 'never hands over a tool call whose arguments didn’t finish', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			captureFetch( [ () => sse( toolCallStart ) ] );

			const reply = await streamTurn(
				turn,
				conversation( [ userMessage( 'read it' ) ] ),
				'medium'
			).result();

			expectFailure( reply );
			expect( reply.stopReason ).not.toBe( 'toolUse' );
		} );

		it( 'fails a completed response that still has an unfinished tool call', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			captureFetch( [ () => sse( [ ...toolCallStart, completed( 'resp_tool' ) ] ) ] );

			const reply = await streamTurn(
				turn,
				conversation( [ userMessage( 'read it' ) ] ),
				'medium'
			).result();

			expectFailure( reply );
			expect( reply.errorMessage ).toMatch( /^ChatGPT sent a response Studio couldn’t read/ );
		} );
	} );

	describe( 'errors before the stream', () => {
		it( 'keeps a detail-only body’s text, status and request id', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			const http = captureFetch( () =>
				jsonError( 403, { detail: 'Country, region, or territory not supported' }, 'req_403' )
			);

			const reply = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();

			expectFailure( reply );
			expect( reply.errorMessage ).toMatch( /^ChatGPT refused this request/ );
			expect( reply.errorMessage ).toContain( 'HTTP 403' );
			expect( reply.errorMessage ).toContain( 'req_403' );
			expect( reply.errorMessage ).toContain( 'Country, region, or territory not supported' );
			expect( http.spy ).toHaveBeenCalledTimes( 1 );
		} );

		it( 'surfaces an authorization failure without trying again, and without its text', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			const http = captureFetch( () =>
				jsonError( 401, { detail: `Signature rejected for ${ TOKEN }` } )
			);

			const reply = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();

			expectFailure( reply );
			expect( reply.errorMessage ).toMatch( /^ChatGPT didn’t accept the sign-in for this account/ );
			expect( reply.errorMessage ).toContain( 'HTTP 401' );
			expect( reply.errorMessage ).not.toContain( 'Signature rejected' );
			expect( http.spy ).toHaveBeenCalledTimes( 1 );
		} );

		it( 'invalidates a rejected token, and a 401 on the fresh token is an authorization failure', async () => {
			let currentToken = TOKEN;
			const invalidations: string[] = [];
			const snapshot = snapshotFor( 'medium', {
				getAccessToken: async () => currentToken,
				invalidateAccessToken: async ( rejectedAccessToken ) => {
					invalidations.push( rejectedAccessToken );
					currentToken = 'fresh-test-chatgpt-token';
				},
			} );
			const turn = await registerChatGpt( snapshot );
			const http = captureFetch( () =>
				jsonError( 401, { error: { code: 'subscription_sharing_invalid_user', message: 'No.' } } )
			);

			const first = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();
			expectFailure( first );
			expect( invalidations ).toEqual( [ TOKEN ] );
			expect( http.spy ).toHaveBeenCalledTimes( 1 );

			const second = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi again' ) ] ),
				'medium'
			).result();
			expectFailure( second );
			expect( second.errorMessage ).toMatch( /^ChatGPT didn’t accept the sign-in/ );
			expect( http.request( 1 ).headers.get( 'authorization' ) ).toBe(
				'Bearer fresh-test-chatgpt-token'
			);
			expect( http.spy ).toHaveBeenCalledTimes( 2 );
			expect( invalidations ).toEqual( [ TOKEN, 'fresh-test-chatgpt-token' ] );
		} );

		it.each( [
			[
				'subscription_sharing_user_not_eligible',
				/^ChatGPT plan usage isn’t available for this account/,
			],
			[ 'chatpass_v2_scope_not_authorized', /^ChatGPT didn’t authorize Studio to use your plan/ ],
			[
				'subscription_sharing_route_not_supported',
				/^ChatGPT plan usage doesn’t accept the kind of request/,
			],
		] )( 'surfaces a 403 %s without trying again', async ( code, message ) => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			const http = captureFetch( () =>
				jsonError( 403, { error: { code, message: 'Refused.', param: null } } )
			);

			const reply = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();

			expectFailure( reply );
			expect( reply.errorMessage ).toMatch( message );
			expect( reply.errorMessage ).toContain( code );
			expect( http.spy ).toHaveBeenCalledTimes( 1 );
		} );

		it( 'pauses at the usage limit, linking to usage and naming no reset time', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			const http = captureFetch( () =>
				jsonError( 429, {
					error: {
						code: 'subscription_sharing_usage_limit_exceeded',
						message: 'You have hit your usage limit.',
					},
				} )
			);

			const reply = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();

			expectFailure( reply );
			expect( reply.errorMessage ).toMatch( /^You’ve reached a ChatGPT usage limit/ );
			expect( reply.errorMessage ).toContain( 'https://chatgpt.com/settings/usage' );
			expect( reply.errorMessage ).not.toMatch( /reset|hours?\b|minutes?\b/i );
			expect( reply.errorMessage ).not.toContain( 'The partial reply' );
			expect( http.spy ).toHaveBeenCalledTimes( 1 );
		} );

		it( 'names the unsupported param and never sends the same body again', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			const http = captureFetch( () =>
				jsonError( 400, {
					error: {
						code: 'subscription_sharing_unsupported_capability',
						param: 'reasoning.effort',
						message: 'Unsupported.',
					},
				} )
			);

			const reply = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();

			expectFailure( reply );
			expect( reply.errorMessage ).toMatch(
				/^ChatGPT plan usage doesn’t support part of this request \(reasoning\.effort\)/
			);
			expect( http.spy ).toHaveBeenCalledTimes( 1 );
		} );

		it( 'tries a 503 again a bounded number of times, with a fresh token each time', async () => {
			const snapshot = snapshotFor( 'medium' );
			const turn = await registerChatGpt( snapshot );
			vi.useFakeTimers( { toFake: [ 'setTimeout', 'clearTimeout' ] } );
			const http = captureFetch( () =>
				jsonError( 503, {
					error: { code: 'subscription_sharing_usage_unavailable', message: 'Try later.' },
				} )
			);

			const pending = streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();
			await vi.advanceTimersByTimeAsync(
				CHATGPT_UNAVAILABLE_RETRY_DELAYS_MS.reduce( ( total, delay ) => total + delay, 0 )
			);
			const reply = await pending;

			expectFailure( reply );
			expect( reply.errorMessage ).toMatch( /^ChatGPT plan usage is unavailable right now/ );
			expect( reply.errorMessage ).toContain( 'HTTP 503' );
			const attempts = CHATGPT_UNAVAILABLE_RETRY_DELAYS_MS.length + 1;
			expect( http.spy ).toHaveBeenCalledTimes( attempts );
			expect( snapshot.tokenRequests ).toBe( attempts );
		} );

		it( 'goes on once a 503 passes', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			vi.useFakeTimers( { toFake: [ 'setTimeout', 'clearTimeout' ] } );
			const http = captureFetch( [
				() => jsonError( 503, { detail: 'Direct routing is unavailable.' } ),
				() => sse( textReply( 'Back.' ) ),
			] );

			const pending = streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();
			await vi.advanceTimersByTimeAsync( CHATGPT_UNAVAILABLE_RETRY_DELAYS_MS[ 0 ] );
			const reply = await pending;

			expect( reply.stopReason ).toBe( 'stop' );
			expect( http.spy ).toHaveBeenCalledTimes( 2 );
			expect( http.request( 1 ).body ).toEqual( http.request( 0 ).body );
		} );

		it( 'never tries again once anything has streamed, even for an unavailable code', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			const http = captureFetch( () =>
				sse( [
					...PARTIAL,
					{
						type: 'response.failed',
						response: {
							id: 'resp_partial',
							status: 'failed',
							error: { code: 'subscription_sharing_usage_unavailable', message: 'Later.' },
							output: [],
						},
					},
				] )
			);

			const reply = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();

			expectFailure( reply );
			expect( reply.errorMessage ).toMatch( /^ChatGPT plan usage is unavailable right now/ );
			expect( http.spy ).toHaveBeenCalledTimes( 1 );
		} );

		it( 'removes the token from any text the route echoes', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			captureFetch( () =>
				jsonError( 400, { error: { code: 'invalid_value', message: `Bad token ${ TOKEN }.` } } )
			);

			const reply = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();

			expectFailure( reply );
			expect( reply.errorMessage ).toMatch( /^ChatGPT rejected the request/ );
			expect( reply.errorMessage ).toContain( 'Bad token [redacted].' );
		} );

		it( 'removes the token from an error’s code and param, in a response and in a stream', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			captureFetch( [
				() =>
					jsonError( 400, {
						error: {
							code: `invalid_${ TOKEN }`,
							param: `field_${ TOKEN }`,
							message: 'Refused.',
						},
					} ),
				() =>
					sse( [
						...PARTIAL,
						{
							type: 'error',
							code: 'subscription_sharing_unsupported_capability',
							message: 'Not supported.',
							param: `input_${ TOKEN }`,
							sequence_number: 4,
						},
					] ),
			] );

			const fromResponse = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();
			const fromStream = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();

			expectFailure( fromResponse );
			expect( fromResponse.errorMessage ).toContain( 'invalid__redacted_' );
			expect( fromResponse.errorMessage ).toContain( 'param field__redacted_' );
			expectFailure( fromStream );
			// After streaming began, the reference rides in the structured
			// diagnostic, not in the text pi scans for overflow or retry.
			expect( fromStream.errorMessage ).not.toContain( 'input_' );
			expect( fromStream.diagnostics ).toEqual( [
				expect.objectContaining( {
					type: 'studio.chatgpt-error',
					details: expect.objectContaining( {
						code: 'subscription_sharing_unsupported_capability',
						param: 'input__redacted_',
					} ),
				} ),
			] );
		} );

		it( 'explains a network failure, without trying again', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			const spy = vi.spyOn( globalThis, 'fetch' ).mockRejectedValue(
				Object.assign( new TypeError( 'fetch failed' ), {
					cause: new Error( 'getaddrinfo ENOTFOUND api.openai.com' ),
				} )
			);

			const reply = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();

			expectFailure( reply );
			expect( reply.errorMessage ).toMatch( /^Couldn’t reach ChatGPT/ );
			expect( reply.errorMessage ).toContain( 'ENOTFOUND' );
			expect( spy ).toHaveBeenCalledTimes( 1 );
		} );
	} );

	describe( 'cancellation and sign-out', () => {
		it( 'leaves a canceled turn canceled, keeping what streamed and sending nothing again', async () => {
			const turn = await registerChatGpt( snapshotFor( 'medium' ) );
			const http = captureFetch( () => stalledSse( PARTIAL ) );
			const controller = new AbortController();

			const events = streamTurn( turn, conversation( [ userMessage( 'hi' ) ] ), 'medium', {
				signal: controller.signal,
			} );
			for await ( const event of events ) {
				if ( event.type === 'text_delta' ) {
					controller.abort();
				}
			}
			const reply = await events.result();

			expect( reply.stopReason ).toBe( 'aborted' );
			expect( reply.content ).toEqual( [
				expect.objectContaining( { text: 'Here is the first half of' } ),
			] );
			expect( reply.errorMessage ?? '' ).not.toMatch( /ChatGPT/ );
			expect( http.spy ).toHaveBeenCalledTimes( 1 );
		} );

		it( 'ends a turn whose connection is signed out under it, saying why', async () => {
			const connection = new AbortController();
			const turn = await registerChatGpt( snapshotFor( 'medium', { signal: connection.signal } ) );
			captureFetch( () => stalledSse( PARTIAL ) );

			const events = streamTurn( turn, conversation( [ userMessage( 'hi' ) ] ), 'medium' );
			for await ( const event of events ) {
				if ( event.type === 'text_delta' ) {
					connection.abort( new ChatGptConnectionError( 'signed-out' ) );
				}
			}
			const reply = await events.result();

			expect( reply.stopReason ).toBe( 'aborted' );
			expect( reply.errorMessage ).toBe(
				'You signed out of this ChatGPT account. Sign in again to continue.'
			);
			expect( reply.content ).toEqual( [
				expect.objectContaining( { text: 'Here is the first half of' } ),
			] );
		} );

		it( 'stops before contacting OpenAI when the token source refuses', async () => {
			const turn = await registerChatGpt(
				snapshotFor( 'medium', {
					getAccessToken: async () => {
						throw new ChatGptConnectionError( 'needs-sign-in' );
					},
				} )
			);
			const http = captureFetch( () => sse( textReply( 'never' ) ) );

			const reply = await streamTurn(
				turn,
				conversation( [ userMessage( 'hi' ) ] ),
				'medium'
			).result();

			expectFailure( reply );
			expect( reply.errorMessage ).toMatch( /^Your ChatGPT sign-in expired or was revoked/ );
			expect( http.spy ).not.toHaveBeenCalled();
		} );
	} );
} );
