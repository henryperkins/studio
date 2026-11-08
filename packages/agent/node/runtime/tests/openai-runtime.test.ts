import fs from 'fs';
import os from 'os';
import path from 'path';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from '@studio/agent/node/agent';
import {
	OPENAI_MODEL_CAPABILITIES,
	OPENAI_MODEL_IDS,
	type OpenAiReasoningEffort,
	type OpenAiTurnSettings,
} from '@studio/agent/protocol/openai-models';
import { createFakeHost } from '../../tests/fake-host';
import { toPiThinkingLevel } from '../openai-transport';
import type {
	AssistantMessage,
	Context,
	Message,
	SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { AgentSessionEvent, CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import type { StudioAgentTurnConfig } from '@studio/agent/node/runtime';

// Safe test keys only.
const KEY = 'sk-proj-TESTONLY_runtime_aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const AMBIENT_KEY = 'sk-proj-TESTONLY_ambient_bbbbbbbbbbbbbbbbbbbbbbbbbbb';

const mocks = vi.hoisted( () => ( {
	createAgentSession: vi.fn(),
	sessions: [] as CreateAgentSessionOptions[],
	root: '',
} ) );

vi.mock( '@earendil-works/pi-coding-agent', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@earendil-works/pi-coding-agent') >() ),
	createAgentSession: mocks.createAgentSession,
} ) );

vi.mock( '@studio/common/lib/well-known-paths', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/common/lib/well-known-paths') >();
	return {
		...actual,
		getConfigDirectory: () => path.join( mocks.root, 'config' ),
		getAiPayloadsPath: () => path.join( mocks.root, 'config', 'ai-payloads' ),
	};
} );

// A session that records its options and replays a scripted reply.
class FakeSession {
	private listener?: ( event: AgentSessionEvent ) => void;
	constructor( public options: CreateAgentSessionOptions ) {}
	subscribe( listener: ( event: AgentSessionEvent ) => void ) {
		this.listener = listener;
		return () => {};
	}
	async prompt() {
		this.listener?.( { type: 'agent_end', willRetry: false, messages: [] } );
	}
	async sendCustomMessage() {}
	async abort() {}
	dispose() {}
	getAllTools() {
		return [];
	}
}

const settingsFor = (
	model: OpenAiTurnSettings[ 'model' ],
	reasoningEffort: OpenAiReasoningEffort,
	reasoningMode: OpenAiTurnSettings[ 'reasoningMode' ] = 'standard',
	maxOutputTokens = 32_000
): OpenAiTurnSettings => ( {
	model,
	apiModelId: OPENAI_MODEL_CAPABILITIES[ model ].apiModelId,
	reasoningEffort,
	reasoningMode,
	maxOutputTokens,
} );

let agent: ReturnType< typeof createAgent >;

async function runTurn( config: Omit< StudioAgentTurnConfig, 'onEvent' | 'session' > ) {
	const events: AgentSessionEvent[] = [];
	const handle = agent.runTurn( {
		session: SessionManager.inMemory( mocks.root ),
		...config,
		onEvent: ( event ) => events.push( event ),
	} );
	await handle.result;
	return { events, options: mocks.sessions.at( -1 ) };
}

function lastError( events: AgentSessionEvent[] ): string | undefined {
	const end = [ ...events ].reverse().find( ( event ) => event.type === 'agent_end' );
	const last = end?.type === 'agent_end' ? end.messages.at( -1 ) : undefined;
	return last?.role === 'assistant' ? last.errorMessage : undefined;
}

const userMessage = ( text: string ): Message => ( {
	role: 'user',
	content: text,
	timestamp: 0,
} );

// One server-sent event stream, as the Responses API sends it.
function sseResponse( events: Array< Record< string, unknown > > ): Response {
	const body = events
		.map( ( event ) => `event: ${ String( event.type ) }\ndata: ${ JSON.stringify( event ) }\n\n` )
		.join( '' );
	return new Response( body, { status: 200, headers: { 'content-type': 'text/event-stream' } } );
}

const usage = {
	input_tokens: 120,
	input_tokens_details: { cached_tokens: 0 },
	output_tokens: 40,
	output_tokens_details: { reasoning_tokens: 25 },
	total_tokens: 160,
};

const REASONING_ITEM = {
	type: 'reasoning',
	id: 'rs_1',
	summary: [],
	encrypted_content: 'gAAAA-encrypted-reasoning-1',
};
const FUNCTION_CALL = {
	type: 'function_call',
	id: 'fc_1',
	call_id: 'call_1',
	name: 'Read',
	arguments: '{"path":"wp-config.php"}',
	status: 'completed',
};

// A reply that reasons, then calls a tool with its arguments split over
// several chunks.
const TOOL_CALL_EVENTS = [
	{ type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
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
		delta: '{"pa',
	},
	{
		type: 'response.function_call_arguments.delta',
		output_index: 1,
		item_id: 'fc_1',
		delta: 'th":"wp-con',
	},
	{
		type: 'response.function_call_arguments.delta',
		output_index: 1,
		item_id: 'fc_1',
		delta: 'fig.php"}',
	},
	{
		type: 'response.function_call_arguments.done',
		output_index: 1,
		item_id: 'fc_1',
		arguments: FUNCTION_CALL.arguments,
	},
	{ type: 'response.output_item.done', output_index: 1, item: FUNCTION_CALL },
	{
		type: 'response.completed',
		response: {
			id: 'resp_1',
			status: 'completed',
			output: [ REASONING_ITEM, FUNCTION_CALL ],
			usage,
		},
	},
];

const TEXT_EVENTS = ( text: string, status = 'completed', incompleteReason?: string ) => [
	{ type: 'response.created', response: { id: 'resp_2', status: 'in_progress', output: [] } },
	{
		type: 'response.output_item.added',
		output_index: 0,
		item: { type: 'message', id: 'msg_1', role: 'assistant', content: [], status: 'in_progress' },
	},
	{ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', delta: text },
	{
		type: 'response.output_item.done',
		output_index: 0,
		item: {
			type: 'message',
			id: 'msg_1',
			role: 'assistant',
			status: 'completed',
			content: [ { type: 'output_text', text, annotations: [] } ],
		},
	},
	{
		type: status === 'completed' ? 'response.completed' : 'response.incomplete',
		response: {
			id: 'resp_2',
			status,
			...( incompleteReason ? { incomplete_details: { reason: incompleteReason } } : {} ),
			output: [],
			usage,
		},
	},
];

function captureFetch( respond: () => Response | Promise< Response > ) {
	const spy = vi.spyOn( globalThis, 'fetch' ).mockImplementation( async () => respond() );
	return {
		spy,
		request( index = 0 ) {
			const [ url, init ] = spy.mock.calls[ index ];
			return {
				url: String( url ),
				init: init!,
				headers: new Headers( init?.headers ),
				body: JSON.parse( String( init?.body ) ) as Record< string, unknown >,
			};
		},
	};
}

// Streams one request through the provider Studio registered for the turn,
// as pi's agent loop does: the session's level becomes `reasoning`.
async function stream(
	options: CreateAgentSessionOptions,
	context: Context,
	extra: SimpleStreamOptions = {}
): Promise< AssistantMessage > {
	const level = options.thinkingLevel;
	return options
		.modelRuntime!.streamSimple( options.model!, context, {
			maxRetries: 0,
			reasoning: level === 'off' ? undefined : level,
			...extra,
		} )
		.result();
}

describe( 'OpenAI turns', () => {
	const savedEnv = { ...process.env };

	beforeEach( () => {
		mocks.root = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-openai-runtime-' ) );
		mocks.sessions.length = 0;
		mocks.createAgentSession.mockReset();
		mocks.createAgentSession.mockImplementation( async ( options: CreateAgentSessionOptions ) => {
			mocks.sessions.push( options );
			return {
				session: new FakeSession( options ),
				extensionsResult: { extensions: [], errors: [], runtime: {} },
			};
		} );
		agent = createAgent( { host: createFakeHost( path.join( mocks.root, 'sites' ) ) } );
	} );

	afterEach( () => {
		vi.restoreAllMocks();
		process.env = { ...savedEnv };
		fs.rmSync( mocks.root, { recursive: true, force: true } );
	} );

	describe( 'session setup', () => {
		it.each( [
			[ 'gpt-6.1-terra', 'none', 'off' ],
			[ 'gpt-6-luna', 'low', 'low' ],
			[ 'gpt-6.1-sol', 'xhigh', 'xhigh' ],
			[ 'gpt-6-astra', 'max', 'max' ],
		] as const )(
			'starts %s at the chosen %s effort, not a fixed medium',
			async ( model, effort, level ) => {
				const { options } = await runTurn( {
					prompt: 'hi',
					model,
					env: { STUDIO_OPENAI_API_KEY: KEY },
					openAi: settingsFor( model, effort ),
				} );
				expect( options?.thinkingLevel ).toBe( level );
				expect( options?.model ).toMatchObject( {
					id: model,
					api: 'openai-responses',
					provider: 'studio-openai',
					baseUrl: 'https://api.openai.com/v1',
					reasoning: true,
					input: [ 'text', 'image' ],
					maxTokens: 32_000,
				} );
			}
		);

		it( 'maps exactly the model’s documented efforts', async () => {
			const { options } = await runTurn( {
				prompt: 'hi',
				model: 'gpt-6.1-sol',
				env: { STUDIO_OPENAI_API_KEY: KEY },
			} );
			expect( options?.model?.thinkingLevelMap ).toEqual( {
				off: null,
				minimal: null,
				low: 'low',
				medium: 'medium',
				high: 'high',
				xhigh: 'xhigh',
				max: 'max',
			} );
			// The default when a caller passes no settings: medium, standard.
			expect( options?.thinkingLevel ).toBe( 'medium' );
		} );

		it( 'keeps compaction within the model’s usable input', async () => {
			const { options } = await runTurn( {
				prompt: 'hi',
				model: 'gpt-6-luna',
				env: { STUDIO_OPENAI_API_KEY: KEY },
			} );
			expect( options?.model?.contextWindow ).toBe( 200_000 );
			expect( options?.model?.contextWindow ).toBeLessThan(
				OPENAI_MODEL_CAPABILITIES[ 'gpt-6-luna' ].maxInputTokens
			);
			expect( options?.settingsManager?.getCompactionSettings() ).toMatchObject( {
				enabled: true,
				reserveTokens: 16_384,
			} );
		} );

		it( 'keeps the other providers on medium', async () => {
			const { options } = await runTurn( {
				prompt: 'hi',
				model: 'claude-sonnet-5',
				env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
			} );
			expect( options?.thinkingLevel ).toBe( 'medium' );
		} );

		it( 'refuses an unsupported combination before contacting OpenAI', async () => {
			const fetchSpy = vi.spyOn( globalThis, 'fetch' );
			const { events } = await runTurn( {
				prompt: 'hi',
				model: 'gpt-6-astra',
				env: { STUDIO_OPENAI_API_KEY: KEY },
				openAi: settingsFor( 'gpt-6-astra', 'none' ),
			} );
			expect( lastError( events ) ).toBe(
				'GPT-6 Astra doesn’t support “None” reasoning. Choose one of: Low, Medium, High, Extra high, Max.'
			);
			expect( mocks.createAgentSession ).not.toHaveBeenCalled();
			expect( fetchSpy ).not.toHaveBeenCalled();
		} );

		it( 'refuses settings made for another model', async () => {
			const { events } = await runTurn( {
				prompt: 'hi',
				model: 'gpt-6-luna',
				env: { STUDIO_OPENAI_API_KEY: KEY },
				openAi: settingsFor( 'gpt-6.1-sol', 'medium' ),
			} );
			expect( lastError( events ) ).toMatch( /different model/ );
			expect( mocks.createAgentSession ).not.toHaveBeenCalled();
		} );

		it( 'reports a missing key as disconnected, never using an ambient OPENAI_API_KEY', async () => {
			process.env.OPENAI_API_KEY = AMBIENT_KEY;
			const { events } = await runTurn( {
				prompt: 'hi',
				model: 'gpt-6.1-sol',
				env: { OPENAI_API_KEY: AMBIENT_KEY },
			} );
			expect( lastError( events ) ).toMatch( /^OpenAI isn’t connected/ );
			expect( mocks.createAgentSession ).not.toHaveBeenCalled();
		} );
	} );

	describe( 'requests', () => {
		it.each(
			OPENAI_MODEL_IDS.flatMap( ( model ) =>
				OPENAI_MODEL_CAPABILITIES[ model ].reasoningEfforts.flatMap( ( effort ) =>
					( [ 'standard', 'pro' ] as const ).map( ( mode ) => [ model, effort, mode ] as const )
				)
			)
		)( 'sends %s with exactly %s effort in %s mode', async ( model, effort, mode ) => {
			const { options } = await runTurn( {
				prompt: 'hi',
				model,
				env: { STUDIO_OPENAI_API_KEY: KEY },
				openAi: settingsFor( model, effort, mode, 64_000 ),
			} );
			const http = captureFetch( () => sseResponse( TEXT_EVENTS( 'Done.' ) ) );

			const reply = await stream( options!, { messages: [ userMessage( 'hello' ) ] } );

			expect( reply.stopReason ).toBe( 'stop' );
			const { url, init, headers, body } = http.request();
			expect( url ).toBe( 'https://api.openai.com/v1/responses' );
			expect( init.redirect ).toBe( 'error' );
			expect( headers.get( 'authorization' ) ).toBe( `Bearer ${ KEY }` );
			expect( [ ...headers.keys() ].filter( ( name ) => /wpcom/i.test( name ) ) ).toEqual( [] );
			expect( body.model ).toBe( OPENAI_MODEL_CAPABILITIES[ model ].apiModelId );
			expect( body.reasoning ).toEqual( {
				effort,
				...( mode === 'pro' ? { mode: 'pro' } : {} ),
			} );
			expect( body.max_output_tokens ).toBe( 64_000 );
			expect( body.store ).toBe( false );
			expect( body ).not.toHaveProperty( 'temperature' );
			expect( body ).not.toHaveProperty( 'top_p' );
			expect( JSON.stringify( body.input ) ).not.toContain( 'configuration_update' );
		} );

		it( 'sends only Studio’s key, whatever OPENAI_* variables the environment holds', async () => {
			process.env.OPENAI_ORG_ID = 'org-ambient';
			process.env.OPENAI_PROJECT_ID = 'proj_ambient';
			process.env.OPENAI_CUSTOM_HEADERS = `Authorization: Bearer ${ AMBIENT_KEY }\nX-Team: web`;
			const { options } = await runTurn( {
				prompt: 'hi',
				model: 'gpt-6.1-sol',
				env: { STUDIO_OPENAI_API_KEY: KEY },
			} );
			const http = captureFetch( () => sseResponse( TEXT_EVENTS( 'Done.' ) ) );

			const reply = await stream( options!, { messages: [ userMessage( 'hello' ) ] } );

			expect( reply.stopReason ).toBe( 'stop' );
			const { headers } = http.request();
			expect( headers.get( 'authorization' ) ).toBe( `Bearer ${ KEY }` );
			expect( headers.has( 'openai-organization' ) ).toBe( false );
			expect( headers.has( 'openai-project' ) ).toBe( false );
		} );

		it( 'refuses to send an effort other than the chosen one', async () => {
			const { options } = await runTurn( {
				prompt: 'hi',
				model: 'gpt-6.1-sol',
				env: { STUDIO_OPENAI_API_KEY: KEY },
				openAi: settingsFor( 'gpt-6.1-sol', 'high' ),
			} );
			const http = captureFetch( () => sseResponse( TEXT_EVENTS( 'no' ) ) );

			const reply = await stream(
				options!,
				{ messages: [ userMessage( 'hello' ) ] },
				{ reasoning: 'low' }
			);

			expect( reply.stopReason ).toBe( 'error' );
			expect( reply.errorMessage ).toMatch(
				/would have used low reasoning instead of the selected high/
			);
			expect( http.spy ).not.toHaveBeenCalled();
		} );

		it( 'declares every tool non-strict, so OpenAI keeps optional parameters optional', async () => {
			const { options } = await runTurn( {
				prompt: 'hi',
				model: 'gpt-6-luna',
				env: { STUDIO_OPENAI_API_KEY: KEY },
			} );
			const http = captureFetch( () => sseResponse( TEXT_EVENTS( 'ok' ) ) );
			const tools = options!.customTools!.slice( 0, 3 ).map( ( tool ) => ( {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			} ) );

			await stream( options!, { messages: [ userMessage( 'hello' ) ], tools } );

			const sent = http.request().body.tools as Array< Record< string, unknown > >;
			expect( sent ).toHaveLength( 3 );
			for ( const tool of sent ) {
				expect( tool ).toMatchObject( { type: 'function', strict: false } );
			}
		} );
	} );

	describe( 'streaming', () => {
		it( 'assembles split tool arguments and replays reasoning and call ids on the continuation', async () => {
			const settings = settingsFor( 'gpt-6.1-sol', 'xhigh', 'pro' );
			const { options } = await runTurn( {
				prompt: 'hi',
				model: 'gpt-6.1-sol',
				env: { STUDIO_OPENAI_API_KEY: KEY },
				openAi: settings,
			} );
			const replies = [ sseResponse( TOOL_CALL_EVENTS ), sseResponse( TEXT_EVENTS( 'Read it.' ) ) ];
			const http = captureFetch( () => replies.shift()! );

			const first = await stream( options!, { messages: [ userMessage( 'read the config' ) ] } );
			expect( first.stopReason ).toBe( 'toolUse' );
			const call = first.content.find( ( block ) => block.type === 'toolCall' );
			expect( call ).toMatchObject( {
				id: 'call_1|fc_1',
				name: 'Read',
				arguments: { path: 'wp-config.php' },
			} );
			expect( first.usage ).toMatchObject( { output: 40, reasoning: 25 } );

			const second = await stream( options!, {
				messages: [
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
				],
			} );

			expect( second.stopReason ).toBe( 'stop' );
			const continuation = http.request( 1 ).body;
			// The same snapshot applies to every request in the turn.
			expect( continuation.model ).toBe( 'gpt-6.1-sol' );
			expect( continuation.reasoning ).toEqual( { effort: 'xhigh', mode: 'pro' } );
			const input = continuation.input as Array< Record< string, unknown > >;
			expect( input ).toContainEqual( REASONING_ITEM );
			expect( input ).toContainEqual(
				expect.objectContaining( {
					type: 'function_call',
					id: 'fc_1',
					call_id: 'call_1',
					name: 'Read',
					arguments: '{"path":"wp-config.php"}',
				} )
			);
			expect( input ).toContainEqual(
				expect.objectContaining( {
					type: 'function_call_output',
					call_id: 'call_1',
					output: '<?php // config',
				} )
			);
			// Reasoning stays ahead of the call it led to.
			const reasoningIndex = input.findIndex( ( item ) => item.type === 'reasoning' );
			const callIndex = input.findIndex( ( item ) => item.type === 'function_call' );
			expect( reasoningIndex ).toBeLessThan( callIndex );
		} );

		it( 'drops another model’s encrypted reasoning but keeps the conversation when switching', async () => {
			const { options: firstOptions } = await runTurn( {
				prompt: 'hi',
				model: 'gpt-6.1-sol',
				env: { STUDIO_OPENAI_API_KEY: KEY },
			} );
			const replies = [ sseResponse( TOOL_CALL_EVENTS ), sseResponse( TEXT_EVENTS( 'ok' ) ) ];
			const http = captureFetch( () => replies.shift()! );
			const first = await stream( firstOptions!, { messages: [ userMessage( 'read it' ) ] } );

			const { options: lunaOptions } = await runTurn( {
				prompt: 'hi',
				model: 'gpt-6-luna',
				env: { STUDIO_OPENAI_API_KEY: KEY },
				openAi: settingsFor( 'gpt-6-luna', 'none' ),
			} );
			await stream( lunaOptions!, {
				messages: [
					userMessage( 'read it' ),
					first,
					{
						role: 'toolResult',
						toolCallId: 'call_1|fc_1',
						toolName: 'Read',
						content: [ { type: 'text', text: 'contents' } ],
						isError: false,
						timestamp: 0,
					},
					userMessage( 'now summarize' ),
				],
			} );

			const body = http.request( 1 ).body;
			expect( body.model ).toBe( 'gpt-6-luna' );
			expect( body.reasoning ).toEqual( { effort: 'none' } );
			const input = body.input as Array< Record< string, unknown > >;
			// Encrypted reasoning only replays to the model that produced it.
			expect( input.some( ( item ) => item.type === 'reasoning' ) ).toBe( false );
			const call = input.find( ( item ) => item.type === 'function_call' );
			const output = input.find( ( item ) => item.type === 'function_call_output' );
			expect( call ).toMatchObject( { name: 'Read', arguments: '{"path":"wp-config.php"}' } );
			expect( output?.call_id ).toBe( call?.call_id );
			expect( input.at( -1 ) ).toMatchObject( { role: 'user' } );
		} );

		it( 'reports output cut at the token cap as a length stop, not an error', async () => {
			const { options } = await runTurn( {
				prompt: 'hi',
				model: 'gpt-6-luna',
				env: { STUDIO_OPENAI_API_KEY: KEY },
			} );
			captureFetch( () =>
				sseResponse( TEXT_EVENTS( 'partial', 'incomplete', 'max_output_tokens' ) )
			);

			const reply = await stream( options!, { messages: [ userMessage( 'long' ) ] } );

			expect( reply.stopReason ).toBe( 'length' );
			expect( reply.errorMessage ).toBeUndefined();
		} );

		it( 'leaves a canceled request canceled', async () => {
			const { options } = await runTurn( {
				prompt: 'hi',
				model: 'gpt-6-luna',
				env: { STUDIO_OPENAI_API_KEY: KEY },
			} );
			const controller = new AbortController();
			vi.spyOn( globalThis, 'fetch' ).mockImplementation( async () => {
				controller.abort();
				throw Object.assign( new Error( 'This operation was aborted' ), { name: 'AbortError' } );
			} );

			const reply = await stream(
				options!,
				{ messages: [ userMessage( 'stop' ) ] },
				{ signal: controller.signal }
			);

			expect( reply.stopReason ).toBe( 'aborted' );
			expect( reply.errorMessage ?? '' ).not.toMatch( /OpenAI/ );
		} );

		it( 'classifies a stream that stopped early as interrupted, which pi retries', async () => {
			const { options } = await runTurn( {
				prompt: 'hi',
				model: 'gpt-6-luna',
				env: { STUDIO_OPENAI_API_KEY: KEY },
			} );
			captureFetch( () => sseResponse( TEXT_EVENTS( 'cut' ).slice( 0, 3 ) ) );

			const reply = await stream( options!, { messages: [ userMessage( 'hi' ) ] } );

			expect( reply.stopReason ).toBe( 'error' );
			expect( reply.errorMessage ).toMatch( /^The OpenAI response stream stopped early/ );
			expect( isRetryableAssistantError( reply ) ).toBe( true );
		} );
	} );

	describe( 'errors', () => {
		it.each( [
			[ 401, 'invalid_api_key', /^OpenAI didn’t accept the API key/, false ],
			[ 403, 'missing_scope', /^The OpenAI API key doesn’t have permission/, false ],
			[ 404, 'model_not_found', /^This model isn’t available to your OpenAI project/, false ],
			[ 400, 'invalid_value', /^OpenAI rejected the request/, false ],
			[ 429, 'insufficient_quota', /^Your OpenAI project is out of quota/, false ],
			[ 429, 'rate_limit_exceeded', /^OpenAI rate limit reached/, true ],
			[ 500, 'server_error', /^OpenAI had a server error/, true ],
		] as const )( 'explains HTTP %s (%s)', async ( status, code, message, retried ) => {
			const { options } = await runTurn( {
				prompt: 'hi',
				model: 'gpt-6.1-sol',
				env: { STUDIO_OPENAI_API_KEY: KEY },
			} );
			captureFetch(
				() =>
					new Response(
						JSON.stringify( {
							error: { code, type: code, message: `Problem with key ${ KEY }` },
						} ),
						{ status }
					)
			);

			const reply = await stream( options!, { messages: [ userMessage( 'hi' ) ] } );

			expect( reply.stopReason ).toBe( 'error' );
			expect( reply.errorMessage ).toMatch( message );
			expect( reply.errorMessage ).toContain( `HTTP ${ status }` );
			expect( reply.errorMessage ).not.toContain( KEY );
			// Never the WordPress.com usage-cap wording.
			expect( reply.errorMessage ).not.toMatch( /Monthly usage limit/ );
			expect( isRetryableAssistantError( reply ) ).toBe( retried );
		} );

		it( 'explains a network failure, which pi retries', async () => {
			const { options } = await runTurn( {
				prompt: 'hi',
				model: 'gpt-6.1-sol',
				env: { STUDIO_OPENAI_API_KEY: KEY },
			} );
			vi.spyOn( globalThis, 'fetch' ).mockRejectedValue(
				Object.assign( new TypeError( 'fetch failed' ), {
					cause: new Error( 'getaddrinfo ENOTFOUND api.openai.com' ),
				} )
			);

			const reply = await stream( options!, { messages: [ userMessage( 'hi' ) ] } );

			expect( reply.errorMessage ).toMatch( /^Couldn’t reach OpenAI/ );
			expect( reply.errorMessage ).toContain( 'ENOTFOUND' );
			expect( isRetryableAssistantError( reply ) ).toBe( true );
		} );
	} );

	describe( 'tool environment', () => {
		it( 'runs Bash without any provider key, whatever the parent process holds', async () => {
			process.env.OPENAI_API_KEY = AMBIENT_KEY;
			process.env.ANTHROPIC_API_KEY = 'sk-ant-TESTONLY';
			const { options } = await runTurn( {
				prompt: 'hi',
				model: 'gpt-6.1-sol',
				env: { STUDIO_OPENAI_API_KEY: KEY },
			} );
			const bash = options!.customTools!.find( ( tool ) => tool.name === 'Bash' )!;

			const result = await bash.execute(
				'call_env',
				{ command: 'env' },
				undefined,
				undefined,
				undefined as never
			);

			const output = result.content
				.map( ( part ) => ( part.type === 'text' ? part.text : '' ) )
				.join();
			expect( output ).toMatch( /\bPATH=/ );
			for ( const leaked of [ KEY, AMBIENT_KEY, 'sk-ant-TESTONLY' ] ) {
				expect( output ).not.toContain( leaked );
			}
			expect( output ).not.toMatch( /\b(OPENAI_API_KEY|STUDIO_OPENAI_API_KEY|ANTHROPIC_API_KEY)=/ );
		} );
	} );
} );

// Keeps the helper honest: every OpenAI effort maps to a pi level and back.
describe( 'toPiThinkingLevel', () => {
	it.each( [
		[ 'none', 'off' ],
		[ 'low', 'low' ],
		[ 'max', 'max' ],
	] as const )( 'maps %s to %s', ( effort, level ) => {
		expect( toPiThinkingLevel( effort ) ).toBe( level );
	} );
} );
