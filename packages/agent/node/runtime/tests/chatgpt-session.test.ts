import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from '@studio/agent/node/agent';
import { ChatGptConnectionError } from '@studio/agent/node/chatgpt/account-store';
import { OPENAI_MODEL_CAPABILITIES } from '@studio/agent/protocol/openai-models';
import { readLastReplyProvider } from '@studio/agent/protocol/providers';
import { createFakeHost } from '../../tests/fake-host';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ChatGptTurnHandle } from '@studio/agent/node/chatgpt/credential-broker';
import type { StudioAgentTurnConfig } from '@studio/agent/node/runtime';
import type {
	ConnectionRegistryEntry,
	ConnectionSelection,
} from '@studio/agent/protocol/connections';
import type {
	OpenAiReasoningEffort,
	OpenAiTurnSettings,
} from '@studio/agent/protocol/openai-models';

/*
 * The real pi agent session — its agent loop, tools, session file and
 * compaction — on a ChatGPT connection, with only OpenAI's HTTP endpoint
 * replaced by Responses streams scripted here and the credential broker
 * replaced by a fake that hands out test tokens. Each turn reopens the
 * session file in a fresh agent, within this one process: the CLI isn't
 * forked, and the connection each turn runs on is passed in, as the CLI
 * will pass the one `resolveConnectionSelection` validated.
 */

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
// Test values only; nothing here reaches OpenAI.
const TOKEN = 'test-chatgpt-access-token';
const API_KEY = 'sk-proj-TESTONLY_chatgpt_session_eeeeeeeeeeeeeeeeee';
const CONNECTION_ID = 'b2f0c9e2-6d3b-4c55-9b8e-3f2d7c1e8a41';
const OTHER_CONNECTION_ID = 'c3f0c9e2-6d3b-4c55-9b8e-3f2d7c1e8a42';

const paths = vi.hoisted( () => ( { root: '' } ) );

vi.mock( '@studio/common/lib/well-known-paths', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/common/lib/well-known-paths') >();
	return {
		...actual,
		getConfigDirectory: () => path.join( paths.root, 'config' ),
		getAiPayloadsPath: () => path.join( paths.root, 'config', 'ai-payloads' ),
	};
} );

// One connection's turn, as the broker begins it: a token per request, a
// check before each tool call, and a signal a sign-out aborts.
class FakeChatGptTurnHandle implements ChatGptTurnHandle {
	readonly connectionId: string;
	private readonly controller = new AbortController();
	ended = false;
	tokenRequests = 0;

	constructor( connectionId: string ) {
		this.connectionId = connectionId;
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	signOut(): void {
		this.controller.abort( new ChatGptConnectionError( 'signed-out' ) );
	}

	async assertActive(): Promise< void > {
		if ( this.controller.signal.aborted ) {
			throw this.controller.signal.reason;
		}
	}

	async getAccessToken(): Promise< string > {
		await this.assertActive();
		this.tokenRequests++;
		return TOKEN;
	}

	end(): void {
		this.ended = true;
	}
}

const fakeBroker = vi.hoisted( () => ( {
	connections: [] as ConnectionRegistryEntry[],
	handles: [] as FakeChatGptTurnHandle[],
} ) );

vi.mock( '@studio/agent/node/chatgpt/credential-broker', async ( importOriginal ) => {
	const actual =
		await importOriginal< typeof import('@studio/agent/node/chatgpt/credential-broker') >();
	return {
		...actual,
		listChatGptConnections: async () => fakeBroker.connections,
		beginChatGptTurn: async ( connectionId: string ) => {
			const handle = new FakeChatGptTurnHandle( connectionId );
			fakeBroker.handles.push( handle );
			return handle;
		},
	};
} );

const connectionEntry = (
	overrides: Partial< ConnectionRegistryEntry > = {}
): ConnectionRegistryEntry => ( {
	connectionId: CONNECTION_ID,
	providerId: 'chatgpt-oauth',
	backend: 'pi',
	revision: 1,
	identity: { subject: 'test-subject-1', email: 'someone@example.com' },
	authStatus: 'connected',
	...overrides,
} );

const selectionFor = ( overrides: Partial< ConnectionSelection > = {} ): ConnectionSelection => ( {
	connectionId: CONNECTION_ID,
	model: { providerId: 'chatgpt-oauth', modelId: 'gpt-6.1-sol' },
	revision: 1,
	...overrides,
} );

const openAiSettingsFor = ( reasoningEffort: OpenAiReasoningEffort ): OpenAiTurnSettings => ( {
	model: 'gpt-6.1-sol',
	apiModelId: OPENAI_MODEL_CAPABILITIES[ 'gpt-6.1-sol' ].apiModelId,
	reasoningEffort,
	reasoningMode: 'standard',
	maxOutputTokens: 32_000,
} );

const usage = ( inputTokens = 900 ) => ( {
	input_tokens: inputTokens,
	input_tokens_details: { cached_tokens: 0 },
	output_tokens: 60,
	output_tokens_details: { reasoning_tokens: 30 },
	total_tokens: inputTokens + 60,
} );

function sse( events: Array< Record< string, unknown > > ): Response {
	const body = events
		.map( ( event ) => `event: ${ String( event.type ) }\ndata: ${ JSON.stringify( event ) }\n\n` )
		.join( '' );
	return new Response( body, { status: 200, headers: { 'content-type': 'text/event-stream' } } );
}

// The events, then nothing until the request is canceled.
function stalledSse( events: Array< Record< string, unknown > > ): Response {
	const body = events
		.map( ( event ) => `event: ${ String( event.type ) }\ndata: ${ JSON.stringify( event ) }\n\n` )
		.join( '' );
	const bytes = new TextEncoder().encode( body );
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
		{ status: 200, headers: { 'content-type': 'text/event-stream' } }
	);
}

const REASONING = {
	type: 'reasoning',
	id: 'rs_turn1',
	summary: [],
	encrypted_content: 'gAAAA-encrypted-turn-1',
};
const READ_CALL = {
	type: 'function_call',
	id: 'fc_turn1',
	call_id: 'call_read_1',
	name: 'Read',
	arguments: '{"path":"wp-config.php"}',
	status: 'completed',
};

// Reasons, then asks to read a file.
const toolCallReply = () =>
	sse( [
		{ type: 'response.created', response: { id: 'resp_a', status: 'in_progress', output: [] } },
		{
			type: 'response.output_item.added',
			output_index: 0,
			item: { ...REASONING, encrypted_content: undefined },
		},
		{ type: 'response.output_item.done', output_index: 0, item: REASONING },
		{
			type: 'response.output_item.added',
			output_index: 1,
			item: { ...READ_CALL, arguments: '', status: 'in_progress' },
		},
		{
			type: 'response.function_call_arguments.delta',
			output_index: 1,
			item_id: READ_CALL.id,
			delta: READ_CALL.arguments,
		},
		{
			type: 'response.function_call_arguments.done',
			output_index: 1,
			item_id: READ_CALL.id,
			arguments: READ_CALL.arguments,
		},
		{ type: 'response.output_item.done', output_index: 1, item: READ_CALL },
		{
			type: 'response.completed',
			response: {
				id: 'resp_a',
				status: 'completed',
				output: [ REASONING, READ_CALL ],
				usage: usage(),
			},
		},
	] );

let replyCount = 0;
const textReply = ( text: string, inputTokens?: number ) => {
	const id = `msg_${ ++replyCount }`;
	return sse( [
		{
			type: 'response.created',
			response: { id: `resp_${ id }`, status: 'in_progress', output: [] },
		},
		{
			type: 'response.output_item.added',
			output_index: 0,
			item: { type: 'message', id, role: 'assistant', content: [], status: 'in_progress' },
		},
		{ type: 'response.output_text.delta', output_index: 0, item_id: id, delta: text },
		{
			type: 'response.output_item.done',
			output_index: 0,
			item: {
				type: 'message',
				id,
				role: 'assistant',
				status: 'completed',
				content: [ { type: 'output_text', text, annotations: [] } ],
			},
		},
		{
			type: 'response.completed',
			response: {
				id: `resp_${ id }`,
				status: 'completed',
				output: [],
				usage: usage( inputTokens ),
			},
		},
	] );
};

// Text that started streaming, with no ending at all.
const PARTIAL_EVENTS = [
	{
		type: 'response.created',
		response: { id: 'resp_partial', status: 'in_progress', output: [] },
	},
	{
		type: 'response.output_item.added',
		output_index: 0,
		item: {
			type: 'message',
			id: 'msg_partial',
			role: 'assistant',
			content: [],
			status: 'in_progress',
		},
	},
	{
		type: 'response.output_text.delta',
		output_index: 0,
		item_id: 'msg_partial',
		delta: 'Here is the first half of',
	},
];

const PARTIAL_REPLY = () => sse( PARTIAL_EVENTS );

type RequestBody = Record< string, unknown > & {
	input: Array< Record< string, unknown > >;
	reasoning?: Record< string, unknown >;
};

interface CapturedRequest {
	headers: Headers;
	body: RequestBody;
}

describe( 'a ChatGPT conversation in a real agent session', () => {
	let sitesRoot: string;
	let sessionDir: string;
	let replies: Array< () => Response >;
	let requests: CapturedRequest[];
	let fetchSpy: ReturnType< typeof vi.spyOn >;

	beforeEach( () => {
		paths.root = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-chatgpt-session-' ) );
		sitesRoot = path.join( paths.root, 'sites' );
		sessionDir = path.join( paths.root, 'sessions' );
		fs.mkdirSync( sitesRoot, { recursive: true } );
		fs.mkdirSync( sessionDir, { recursive: true } );
		fs.writeFileSync(
			path.join( sitesRoot, 'wp-config.php' ),
			"<?php define( 'DB_NAME', 'studio' );\n"
		);
		replies = [];
		requests = [];
		replyCount = 0;
		fakeBroker.connections = [ connectionEntry() ];
		fakeBroker.handles = [];
		fetchSpy = vi.spyOn( globalThis, 'fetch' ).mockImplementation( async ( input, init ) => {
			const url = input instanceof Request ? input.url : String( input );
			if ( url !== RESPONSES_URL ) {
				return new Response( null, { status: 404 } );
			}
			requests.push( {
				headers: new Headers( init?.headers ),
				body: JSON.parse( String( init?.body ) ) as RequestBody,
			} );
			const reply = replies.shift();
			if ( ! reply ) {
				throw new Error( `No reply scripted for request ${ requests.length }` );
			}
			return reply();
		} );
	} );

	afterEach( () => {
		vi.restoreAllMocks();
		fs.rmSync( paths.root, { recursive: true, force: true } );
	} );

	// A fresh conversation pinned to its ChatGPT connection, as the CLI pins
	// one before its first turn.
	function newChatGptSession( selection: ConnectionSelection ): SessionManager {
		const session = SessionManager.create( sitesRoot, sessionDir );
		session.appendCustomEntry( 'studio.session_context', {
			provider: 'chatgpt-oauth',
			connectionId: selection.connectionId,
			revision: selection.revision,
			model: selection.model.modelId,
		} );
		return session;
	}

	const reopen = ( sessionFile: string ) =>
		SessionManager.open( sessionFile, sessionDir, sitesRoot );

	// Each turn runs in a fresh agent on the session, as each turn of a
	// Studio app's forked CLI does.
	async function runTurn(
		session: SessionManager,
		prompt: string,
		turn: Omit< StudioAgentTurnConfig, 'prompt' | 'session' | 'onEvent' >,
		onEvent?: ( event: AgentSessionEvent ) => void
	) {
		const events: AgentSessionEvent[] = [];
		const agent = createAgent( { host: createFakeHost( sitesRoot ) } );
		const handle = agent.runTurn( {
			prompt,
			session,
			...turn,
			onEvent: ( event ) => {
				events.push( event );
				onEvent?.( event );
			},
		} );
		await handle.result;
		const end = [ ...events ].reverse().find( ( event ) => event.type === 'agent_end' );
		const last = end?.type === 'agent_end' ? end.messages.at( -1 ) : undefined;
		const text =
			last?.role === 'assistant'
				? last.content.map( ( block ) => ( block.type === 'text' ? block.text : '' ) ).join( '' )
				: undefined;
		return {
			sessionFile: session.getSessionFile()!,
			error: last?.role === 'assistant' ? last.errorMessage : undefined,
			text,
			entries: session.getEntries(),
			events,
		};
	}

	const runChatGptTurn = (
		session: SessionManager,
		prompt: string,
		selection: ConnectionSelection,
		effort: OpenAiReasoningEffort,
		env: Record< string, string > = {},
		onEvent?: ( event: AgentSessionEvent ) => void
	) =>
		runTurn(
			session,
			prompt,
			{
				connection: selection,
				chatGpt: { reasoningEffort: effort, label: 'GPT-6.1 Sol' },
				env,
			},
			onEvent
		);

	const itemsOfType = ( request: CapturedRequest, type: string ) =>
		request.body.input.filter( ( item ) => item.type === type );

	it( 'keeps reasoning, tool calls and effort straight across tool use, reopened sessions and compaction', async () => {
		const selection = selectionFor();
		// Turn 1, Medium, with no API key anywhere: the model reasons, reads
		// a file, then answers.
		replies.push( toolCallReply, () => textReply( 'DB_NAME is studio.' ) );
		const first = await runChatGptTurn(
			newChatGptSession( selection ),
			'What is the database name?',
			selection,
			'medium'
		);

		expect( first.error ).toBeUndefined();
		expect( first.text ).toContain( 'DB_NAME is studio.' );
		// The provider pi records on the replies is the one Studio reads them by.
		expect( readLastReplyProvider( first.entries ) ).toBe( 'chatgpt-oauth' );
		expect( requests ).toHaveLength( 2 );
		for ( const request of requests ) {
			expect( request.headers.get( 'authorization' ) ).toBe( `Bearer ${ TOKEN }` );
			expect( request.body.model ).toBe( 'gpt-6.1-sol' );
			expect( request.body.reasoning ).toEqual( { effort: 'medium' } );
			// Nothing of the OpenAI API turn settings exists to leak.
			expect( request.body ).not.toHaveProperty( 'max_output_tokens' );
			expect( request.body.store ).toBe( false );
			expect( request.body.input[ 0 ] ).toMatchObject( { type: 'additional_tools' } );
		}
		// The continuation replays the encrypted reasoning before the call it
		// led to, and answers that call by its id.
		const continuation = requests[ 1 ];
		expect( itemsOfType( continuation, 'reasoning' ) ).toEqual( [
			expect.objectContaining( {
				id: REASONING.id,
				encrypted_content: REASONING.encrypted_content,
			} ),
		] );
		const [ output ] = itemsOfType( continuation, 'function_call_output' );
		expect( output.call_id ).toBe( READ_CALL.call_id );
		expect( String( output.output ) ).toContain( "define( 'DB_NAME', 'studio' )" );
		expect( fakeBroker.handles ).toHaveLength( 1 );
		expect( fakeBroker.handles[ 0 ].ended ).toBe( true );

		// Turn 2, in a fresh agent on the reopened file, with High passed in.
		// Its reply reports a context close to the budget, so the session
		// compacts afterwards.
		requests.length = 0;
		const longPrompt = `Check this log for errors:\n${ 'PHP Notice: nothing to see here.\n'.repeat(
			3_000
		) }`;
		replies.push(
			() => textReply( 'The log has no errors.', 190_000 ),
			() => textReply( 'Summary: the user asked for the database name; it is studio.' )
		);
		const second = await runChatGptTurn(
			reopen( first.sessionFile ),
			longPrompt,
			selection,
			'high'
		);

		expect( second.error ).toBeUndefined();
		expect( requests.length ).toBeGreaterThanOrEqual( 2 );
		const [ turnRequest, ...compactionRequests ] = requests;
		expect( turnRequest.body.reasoning ).toEqual( { effort: 'high' } );
		expect( itemsOfType( turnRequest, 'function_call_output' ) ).toEqual( [
			expect.objectContaining( { call_id: READ_CALL.call_id } ),
		] );
		// Compaction's summary request runs on the same connection, model and effort.
		for ( const request of compactionRequests ) {
			expect( request.headers.get( 'authorization' ) ).toBe( `Bearer ${ TOKEN }` );
			expect( request.body.model ).toBe( 'gpt-6.1-sol' );
			expect( request.body.reasoning ).toEqual( { effort: 'high' } );
			expect( request.body ).not.toHaveProperty( 'max_output_tokens' );
		}
		expect( second.entries.some( ( entry ) => entry.type === 'compaction' ) ).toBe( true );

		// Turn 3, in another fresh agent: the summary stands in for the early turns.
		requests.length = 0;
		replies.push( () => textReply( 'Anything else?' ) );
		const third = await runChatGptTurn(
			reopen( second.sessionFile ),
			'Thanks.',
			selection,
			'high'
		);

		expect( third.error ).toBeUndefined();
		expect( requests ).toHaveLength( 1 );
		expect( requests[ 0 ].body.reasoning ).toEqual( { effort: 'high' } );
		expect( JSON.stringify( requests[ 0 ].body.input ) ).toContain(
			'the user asked for the database name'
		);
		expect( itemsOfType( requests[ 0 ], 'function_call' ) ).toEqual( [] );
		expect( JSON.stringify( requests[ 0 ].body.input ) ).not.toContain(
			REASONING.encrypted_content
		);
	} );

	it( 'fails a stream that ends without response.completed, keeping what streamed', async () => {
		const selection = selectionFor();
		replies.push( PARTIAL_REPLY );

		const turn = await runChatGptTurn( newChatGptSession( selection ), 'hi', selection, 'medium' );

		expect( turn.error ).toMatch( /^ChatGPT’s reply ended before ChatGPT confirmed/ );
		expect( turn.text ).toContain( 'Here is the first half of' );
		expect( fetchSpy ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'ends the turn when the connection is signed out mid-stream', async () => {
		const selection = selectionFor();
		replies.push( () => stalledSse( PARTIAL_EVENTS ) );

		const turn = await runChatGptTurn(
			newChatGptSession( selection ),
			'hi',
			selection,
			'medium',
			{},
			( event ) => {
				if (
					event.type === 'message_update' &&
					event.assistantMessageEvent.type === 'text_delta'
				) {
					fakeBroker.handles.at( -1 )?.signOut();
				}
			}
		);

		expect( turn.error ).toMatch( /^You signed out of this ChatGPT account/ );
		expect( turn.text ).toContain( 'Here is the first half of' );
		expect( fakeBroker.handles[ 0 ].ended ).toBe( true );
	} );

	it( 'doesn’t run a tool call the model asked for once the connection is signed out', async () => {
		const selection = selectionFor();
		replies.push( toolCallReply, () => textReply( 'Read it.' ) );

		const turn = await runChatGptTurn(
			newChatGptSession( selection ),
			'read the config',
			selection,
			'medium',
			{},
			( event ) => {
				if ( event.type === 'tool_execution_start' && event.toolName === 'Read' ) {
					fakeBroker.handles.at( -1 )?.signOut();
				}
			}
		);

		expect( turn.error ).toMatch( /^You signed out of this ChatGPT account/ );
		// The tool never ran, so no continuation carrying its output was sent
		// and no result in the session holds the file it would have read.
		expect( requests ).toHaveLength( 1 );
		expect( JSON.stringify( turn.entries ) ).not.toContain( 'DB_NAME' );
		expect( fakeBroker.handles[ 0 ].ended ).toBe( true );
	} );

	describe( 'whole-loop routing', () => {
		it( 'runs a connected ChatGPT turn with no OpenAI API key saved', async () => {
			const selection = selectionFor();
			replies.push( () => textReply( 'Hello from the plan.' ) );

			const turn = await runChatGptTurn(
				newChatGptSession( selection ),
				'hi',
				selection,
				'medium',
				{}
			);

			expect( turn.error ).toBeUndefined();
			expect( turn.text ).toContain( 'Hello from the plan.' );
			expect( requests ).toHaveLength( 1 );
			expect( requests[ 0 ].headers.get( 'authorization' ) ).toBe( `Bearer ${ TOKEN }` );
		} );

		it( 'lets the selected connection alone decide credentials and settings when both expose the same slug', async () => {
			const selection = selectionFor();
			// Both connections can serve 'gpt-6.1-sol', and a usable API key is
			// saved: the ChatGPT turn still runs on the plan, through a tool.
			replies.push( toolCallReply, () => textReply( 'DB_NAME is studio.' ) );
			const chatGpt = await runChatGptTurn(
				newChatGptSession( selection ),
				'What is the database name?',
				selection,
				'medium',
				{ STUDIO_OPENAI_API_KEY: API_KEY }
			);

			expect( chatGpt.error ).toBeUndefined();
			expect( readLastReplyProvider( chatGpt.entries ) ).toBe( 'chatgpt-oauth' );
			expect( requests ).toHaveLength( 2 );
			for ( const request of requests ) {
				expect( request.headers.get( 'authorization' ) ).toBe( `Bearer ${ TOKEN }` );
				expect( request.body ).not.toHaveProperty( 'max_output_tokens' );
			}
			expect( itemsOfType( requests[ 1 ], 'function_call_output' ) ).toEqual( [
				expect.objectContaining( { call_id: READ_CALL.call_id } ),
			] );

			// The same slug under the API key runs on the key, with its cap.
			requests.length = 0;
			replies.push( toolCallReply, () => textReply( 'DB_NAME is studio.' ) );
			const openAi = await runTurn( SessionManager.create( sitesRoot, sessionDir ), 'hi', {
				model: 'gpt-6.1-sol',
				openAi: openAiSettingsFor( 'medium' ),
				env: { STUDIO_OPENAI_API_KEY: API_KEY },
			} );

			expect( openAi.error ).toBeUndefined();
			expect( readLastReplyProvider( openAi.entries ) ).toBe( 'openai-api-key' );
			expect( requests ).toHaveLength( 2 );
			for ( const request of requests ) {
				expect( request.headers.get( 'authorization' ) ).toBe( `Bearer ${ API_KEY }` );
				expect( request.body.max_output_tokens ).toBe( 32_000 );
			}
		} );

		it( 'fails a disconnected ChatGPT connection explicitly even when a usable API key is saved', async () => {
			fakeBroker.connections = [];
			const selection = selectionFor();

			const turn = await runChatGptTurn(
				newChatGptSession( selection ),
				'hi',
				selection,
				'medium',
				{ STUDIO_OPENAI_API_KEY: API_KEY }
			);

			expect( turn.error ).toBe(
				'ChatGPT isn’t connected, so this chat can’t continue. Start a new chat with another provider.'
			);
			expect( fetchSpy ).not.toHaveBeenCalled();
			expect( fakeBroker.handles ).toHaveLength( 0 );
		} );
	} );

	describe( 'selections the runtime refuses', () => {
		it( 'refuses a session pinned to another ChatGPT account', async () => {
			fakeBroker.connections = [
				connectionEntry(),
				connectionEntry( { connectionId: OTHER_CONNECTION_ID } ),
			];
			const pinned = selectionFor();
			const other = selectionFor( { connectionId: OTHER_CONNECTION_ID } );

			const turn = await runChatGptTurn( newChatGptSession( pinned ), 'hi', other, 'medium' );

			expect( turn.error ).toMatch( /different ChatGPT connection or model/ );
			expect( fetchSpy ).not.toHaveBeenCalled();
			expect( fakeBroker.handles ).toHaveLength( 0 );
		} );

		it( 'refuses a connection whose revision changed since the chat ran on it', async () => {
			fakeBroker.connections = [ connectionEntry( { revision: 2 } ) ];
			const selection = selectionFor();

			const turn = await runChatGptTurn(
				newChatGptSession( selection ),
				'hi',
				selection,
				'medium'
			);

			expect( turn.error ).toBe(
				'The ChatGPT connection this chat ran on has changed since, so the chat can’t continue. Start a new chat.'
			);
			expect( fetchSpy ).not.toHaveBeenCalled();
		} );

		it( 'refuses to continue a conversation that ran on another provider', async () => {
			replies.push( () => textReply( 'From the API.' ) );
			const openAi = await runTurn( SessionManager.create( sitesRoot, sessionDir ), 'hi', {
				model: 'gpt-6.1-sol',
				openAi: openAiSettingsFor( 'medium' ),
				env: { STUDIO_OPENAI_API_KEY: API_KEY },
			} );
			expect( openAi.error ).toBeUndefined();
			const sent = requests.length;

			const turn = await runChatGptTurn(
				reopen( openAi.sessionFile ),
				'hi again',
				selectionFor(),
				'medium',
				{ STUDIO_OPENAI_API_KEY: API_KEY }
			);

			expect( turn.error ).toMatch( /ran on another provider/ );
			expect( requests ).toHaveLength( sent );
			expect( fakeBroker.handles ).toHaveLength( 0 );
		} );

		it( 'refuses a ChatGPT model Studio doesn’t support', async () => {
			const selection = selectionFor( {
				model: { providerId: 'chatgpt-oauth', modelId: 'gpt-7-nova' },
			} );

			const turn = await runChatGptTurn(
				newChatGptSession( selection ),
				'hi',
				selection,
				'medium'
			);

			expect( turn.error ).toContain( 'gpt-7-nova' );
			expect( fetchSpy ).not.toHaveBeenCalled();
		} );

		it( 'refuses an effort the model doesn’t list, rather than sending a nearby one', async () => {
			const selection = selectionFor( {
				model: { providerId: 'chatgpt-oauth', modelId: 'gpt-6-astra' },
			} );

			const turn = await runChatGptTurn( newChatGptSession( selection ), 'hi', selection, 'none' );

			expect( turn.error ).toMatch( /doesn’t support “None” reasoning/ );
			expect( fetchSpy ).not.toHaveBeenCalled();
		} );

		it( 'refuses OpenAI API settings on a ChatGPT turn', async () => {
			const selection = selectionFor();

			const turn = await runTurn( newChatGptSession( selection ), 'hi', {
				connection: selection,
				chatGpt: { reasoningEffort: 'medium' },
				openAi: openAiSettingsFor( 'medium' ),
				env: { STUDIO_OPENAI_API_KEY: API_KEY },
			} );

			expect( turn.error ).toMatch( /doesn’t use OpenAI API settings/ );
			expect( fetchSpy ).not.toHaveBeenCalled();
		} );
	} );
} );
