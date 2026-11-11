import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from '@studio/agent/node/agent';
import { ChatGptConnectionError } from '@studio/agent/node/chatgpt/account-store';
import { buildAttachedFilesPromptBlock } from '@studio/agent/protocol/chat-files';
import { OPENAI_MODEL_CAPABILITIES } from '@studio/agent/protocol/openai-models';
import { readLastReplyProvider } from '@studio/agent/protocol/providers';
import { formatVisualAnnotationsPrompt } from '@studio/agent/protocol/visual-annotations';
import { createFakeHost, fakeSite } from '../../tests/fake-host';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ChatGptTurnHandle } from '@studio/agent/node/chatgpt/credential-broker';
import type { StudioAgentHost } from '@studio/agent/node/host';
import type { StudioAgentTurnConfig, StudioAgentTurnHandle } from '@studio/agent/node/runtime';
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

// Only what needs a real browser or a WordPress.com login is replaced: the
// page capture and the annotation browser, and whether a login exists, which
// is what makes the image service available without a token of its own.
const seams = vi.hoisted( () => ( {
	order: [] as string[],
	captureScreenshotBuffer: vi.fn(),
	annotateInBrowser: vi.fn(),
	wpcomLogin: null as { accessToken: string } | null,
} ) );

vi.mock( '@studio/agent/node/tools/screenshot-helpers', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/agent/node/tools/screenshot-helpers') >() ),
	captureScreenshotBuffer: seams.captureScreenshotBuffer,
} ) );

vi.mock( '@studio/agent/node/inspector/inspector-inject', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/agent/node/inspector/inspector-inject') >() ),
	annotateInBrowser: seams.annotateInBrowser,
} ) );

vi.mock( '@studio/common/lib/shared-config', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/common/lib/shared-config') >() ),
	readAuthToken: async () => seams.wpcomLogin,
} ) );

// One connection's turn, as the broker begins it: a token per request, a
// check before each tool call, and a signal a sign-out aborts.
class FakeChatGptTurnHandle implements ChatGptTurnHandle {
	readonly connectionId: string;
	private readonly controller = new AbortController();
	ended = false;
	tokenRequests = 0;
	invalidations: string[] = [];

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
		return fakeBroker.token;
	}

	async invalidateAccessToken( rejectedAccessToken: string ): Promise< void > {
		this.invalidations.push( rejectedAccessToken );
	}

	end(): void {
		this.ended = true;
	}
}

const fakeBroker = vi.hoisted( () => ( {
	connections: [] as ConnectionRegistryEntry[],
	handles: [] as FakeChatGptTurnHandle[],
	token: '',
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
	model: { providerId: 'chatgpt-oauth', modelId: 'gpt-6-luna' },
	revision: 1,
	...overrides,
} );

const openAiSettingsFor = ( reasoningEffort: OpenAiReasoningEffort ): OpenAiTurnSettings => ( {
	model: 'gpt-6-luna',
	apiModelId: OPENAI_MODEL_CAPABILITIES[ 'gpt-6-luna' ].apiModelId,
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

const IMAGE_READ_CALL = {
	...READ_CALL,
	id: 'fc_image',
	call_id: 'call_read_image',
	arguments: '{"path":"screenshot.png"}',
};

// Asks to read an image file, whose tool result carries the image itself.
const imageToolCallReply = () =>
	sse( [
		{ type: 'response.created', response: { id: 'resp_img', status: 'in_progress', output: [] } },
		{
			type: 'response.output_item.added',
			output_index: 0,
			item: { ...IMAGE_READ_CALL, arguments: '', status: 'in_progress' },
		},
		{
			type: 'response.function_call_arguments.delta',
			output_index: 0,
			item_id: IMAGE_READ_CALL.id,
			delta: IMAGE_READ_CALL.arguments,
		},
		{
			type: 'response.function_call_arguments.done',
			output_index: 0,
			item_id: IMAGE_READ_CALL.id,
			arguments: IMAGE_READ_CALL.arguments,
		},
		{ type: 'response.output_item.done', output_index: 0, item: IMAGE_READ_CALL },
		{
			type: 'response.completed',
			response: {
				id: 'resp_img',
				status: 'completed',
				output: [ IMAGE_READ_CALL ],
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

const TINY_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAZ0lEQVR4nO3QAQEAAACCoP6ftiHKBIbckCsAuQKQKwC5ApArALkCkCsAuQKQKwC5ApArALkCkCsAuQKQKwC5ApArALkCkCsAuQKQKwC5ApArALkCkCsAuQKQKwC5ApArALkCkCsAuQNG0MOymiW+jAAAAABJRU5ErkJggg==';
// A JPEG's leading bytes: the capture is only stored and passed on, never decoded.
const SCREENSHOT_JPEG = Buffer.from( [
	0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
] );

let callBatch = 0;

/**
 * One reply asking for these tool calls, in order, and the call ids the next
 * request answers them by.
 */
function toolCalls( ...calls: Array< { name: string; args: Record< string, unknown > } > ) {
	const batch = ++callBatch;
	const items = calls.map( ( call, index ) => ( {
		type: 'function_call',
		id: `fc_${ batch }_${ index }`,
		call_id: `call_${ batch }_${ index }`,
		name: call.name,
		arguments: JSON.stringify( call.args ),
		status: 'completed',
	} ) );
	const responseId = `resp_calls_${ batch }`;
	const reply = () =>
		sse( [
			{
				type: 'response.created',
				response: { id: responseId, status: 'in_progress', output: [] },
			},
			...items.flatMap( ( item, index ) => [
				{
					type: 'response.output_item.added',
					output_index: index,
					item: { ...item, arguments: '', status: 'in_progress' },
				},
				{
					type: 'response.function_call_arguments.delta',
					output_index: index,
					item_id: item.id,
					delta: item.arguments,
				},
				{
					type: 'response.function_call_arguments.done',
					output_index: index,
					item_id: item.id,
					arguments: item.arguments,
				},
				{ type: 'response.output_item.done', output_index: index, item },
			] ),
			{
				type: 'response.completed',
				response: { id: responseId, status: 'completed', output: items, usage: usage() },
			},
		] );
	return { reply, callIds: items.map( ( item ) => item.call_id ) };
}

function deferred< T = void >() {
	let resolve!: ( value: T ) => void;
	const promise = new Promise< T >( ( done ) => {
		resolve = done;
	} );
	return { promise, resolve };
}

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
	let host: StudioAgentHost;
	let activeHandle: StudioAgentTurnHandle | undefined;
	// Answers by what each request is, instead of in a scripted order.
	let respond: ( ( request: CapturedRequest ) => Response ) | undefined;
	// WordPress.com's image service, which generate_images calls.
	let imageService: ( init: RequestInit ) => Response | Promise< Response >;
	let imageRequests: Headers[];

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
		fs.writeFileSync(
			path.join( sitesRoot, 'screenshot.png' ),
			Buffer.from( TINY_PNG_BASE64, 'base64' )
		);
		replies = [];
		requests = [];
		replyCount = 0;
		fakeBroker.connections = [ connectionEntry() ];
		fakeBroker.handles = [];
		fakeBroker.token = TOKEN;
		host = {
			...createFakeHost( sitesRoot ),
			screenshotsDirectory: async () => path.join( paths.root, 'screenshots' ),
		};
		activeHandle = undefined;
		respond = undefined;
		seams.order = [];
		seams.wpcomLogin = null;
		seams.captureScreenshotBuffer.mockReset().mockImplementation( async () => {
			seams.order.push( 'capture' );
			return {
				buffer: SCREENSHOT_JPEG,
				documentHeight: 900,
				contentHeight: 900,
				capturedHeight: 900,
				offset: 0,
				clipped: false,
			};
		} );
		seams.annotateInBrowser.mockReset();
		imageRequests = [];
		imageService = () => new Response( null, { status: 500 } );
		fetchSpy = vi.spyOn( globalThis, 'fetch' ).mockImplementation( async ( input, init ) => {
			const url = input instanceof Request ? input.url : String( input );
			if ( url.endsWith( '/v1/images/generations' ) ) {
				imageRequests.push( new Headers( init?.headers ) );
				return imageService( init ?? {} );
			}
			if ( url !== RESPONSES_URL ) {
				return new Response( null, { status: 404 } );
			}
			const request = {
				headers: new Headers( init?.headers ),
				body: JSON.parse( String( init?.body ) ) as RequestBody,
			};
			requests.push( request );
			if ( respond ) {
				return respond( request );
			}
			const reply = replies.shift();
			if ( ! reply ) {
				throw new Error( `No reply scripted for request ${ requests.length }` );
			}
			return reply();
		} );
	} );

	afterEach( () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
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
		const agent = createAgent( { host } );
		const handle = agent.runTurn( {
			prompt,
			session,
			...turn,
			onEvent: ( event ) => {
				events.push( event );
				onEvent?.( event );
			},
		} );
		activeHandle = handle;
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
			stopReason: last?.role === 'assistant' ? last.stopReason : undefined,
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
				chatGpt: { reasoningEffort: effort, label: 'GPT-6 Luna' },
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
			expect( request.body.model ).toBe( 'gpt-6-luna' );
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
		// One token taken per request in the turn.
		expect( fakeBroker.handles[ 0 ].tokenRequests ).toBe( 2 );
		// No credential in the session entries or the events the turn emitted.
		expect( JSON.stringify( first.entries ) ).not.toContain( TOKEN );
		expect( JSON.stringify( first.events ) ).not.toContain( TOKEN );

		// Turn 2, in a fresh agent on the reopened file, with Low passed in.
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
			'low'
		);

		expect( second.error ).toBeUndefined();
		expect( requests.length ).toBeGreaterThanOrEqual( 2 );
		const [ turnRequest, ...compactionRequests ] = requests;
		expect( turnRequest.body.reasoning ).toEqual( { effort: 'low' } );
		expect( itemsOfType( turnRequest, 'function_call_output' ) ).toEqual( [
			expect.objectContaining( { call_id: READ_CALL.call_id } ),
		] );
		// The earlier assistant text is replayed as an assistant message.
		expect(
			turnRequest.body.input.some(
				( item ) =>
					item.role === 'assistant' &&
					JSON.stringify( item.content ).includes( 'DB_NAME is studio.' )
			)
		).toBe( true );
		// Compaction's summary request runs on the same connection, model and effort.
		for ( const request of compactionRequests ) {
			expect( request.headers.get( 'authorization' ) ).toBe( `Bearer ${ TOKEN }` );
			expect( request.body.model ).toBe( 'gpt-6-luna' );
			expect( request.body.reasoning ).toEqual( { effort: 'low' } );
			expect( request.body ).not.toHaveProperty( 'max_output_tokens' );
		}
		expect( second.entries.some( ( entry ) => entry.type === 'compaction' ) ).toBe( true );

		// Turn 3, in another fresh agent: the summary stands in for the early turns.
		requests.length = 0;
		replies.push( () => textReply( 'Anything else?' ) );
		const third = await runChatGptTurn( reopen( second.sessionFile ), 'Thanks.', selection, 'low' );

		expect( third.error ).toBeUndefined();
		expect( requests ).toHaveLength( 1 );
		expect( requests[ 0 ].body.reasoning ).toEqual( { effort: 'low' } );
		expect( JSON.stringify( requests[ 0 ].body.input ) ).toContain(
			'the user asked for the database name'
		);
		expect( itemsOfType( requests[ 0 ], 'function_call' ) ).toEqual( [] );
		expect( JSON.stringify( requests[ 0 ].body.input ) ).not.toContain(
			REASONING.encrypted_content
		);
	} );

	it( 'invalidates only the rejected request’s token and lets the next turn use a newer one', async () => {
		const selection = selectionFor();
		const renewed = 'test-chatgpt-renewed-token';
		replies.push( () => {
			fakeBroker.token = renewed;
			return new Response( JSON.stringify( { detail: `Rejected ${ TOKEN }` } ), {
				status: 401,
				headers: { 'content-type': 'application/json' },
			} );
		} );

		const first = await runChatGptTurn( newChatGptSession( selection ), 'hi', selection, 'medium' );

		expect( first.stopReason ).toBe( 'error' );
		expect( first.error ).toMatch( /^ChatGPT didn’t accept the sign-in/ );
		expect( requests ).toHaveLength( 1 );
		expect( requests[ 0 ].headers.get( 'authorization' ) ).toBe( `Bearer ${ TOKEN }` );
		expect( fakeBroker.handles[ 0 ].invalidations ).toEqual( [ TOKEN ] );
		expect( fakeBroker.handles[ 0 ].ended ).toBe( true );
		expect( first.events.some( ( event ) => event.type === 'auto_retry_start' ) ).toBe( false );

		replies.push( () => textReply( 'Hello again.' ) );
		const second = await runChatGptTurn(
			reopen( first.sessionFile ),
			'hi again',
			selection,
			'medium'
		);

		expect( second.error ).toBeUndefined();
		expect( second.text ).toBe( 'Hello again.' );
		expect( requests ).toHaveLength( 2 );
		expect( requests[ 1 ].headers.get( 'authorization' ) ).toBe( `Bearer ${ renewed }` );
		expect( fakeBroker.handles[ 1 ].invalidations ).toEqual( [] );
		const recorded = JSON.stringify( [ first.events, second.events, second.entries ] );
		expect( recorded ).not.toContain( TOKEN );
		expect( recorded ).not.toContain( renewed );
	} );

	it( 'fails a stream that ends without response.completed, keeping what streamed', async () => {
		const selection = selectionFor();
		replies.push( PARTIAL_REPLY );

		const turn = await runChatGptTurn( newChatGptSession( selection ), 'hi', selection, 'medium' );

		expect( turn.error ).toMatch( /^ChatGPT’s reply ended before ChatGPT confirmed/ );
		expect( turn.text ).toContain( 'Here is the first half of' );
		expect( fetchSpy ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'does not retry a mid-stream failure in the whole loop', async () => {
		const selection = selectionFor();
		replies.push( () =>
			sse( [
				...PARTIAL_EVENTS,
				{
					type: 'response.failed',
					response: {
						id: 'resp_partial',
						status: 'failed',
						output: [],
						error: { code: 'server_error', message: 'Upstream exploded.' },
					},
				},
			] )
		);

		const turn = await runChatGptTurn( newChatGptSession( selection ), 'hi', selection, 'medium' );

		expect( turn.stopReason ).toBe( 'error' );
		expect( turn.error ).toMatch( /^ChatGPT had a server error/ );
		expect( turn.text ).toContain( 'Here is the first half of' );
		// Exactly one request, and pi never scheduled a retry of it.
		expect( requests ).toHaveLength( 1 );
		expect( turn.events.some( ( event ) => event.type === 'auto_retry_start' ) ).toBe( false );
		expect( JSON.stringify( turn.entries ) ).not.toContain( TOKEN );
	} );

	it( 'does not re-send a mid-stream context_length_exceeded failure after compaction', async () => {
		const selection = selectionFor();
		replies.push( () =>
			sse( [
				...PARTIAL_EVENTS,
				{
					type: 'error',
					code: 'context_length_exceeded',
					message: 'context_length_exceeded: too many tokens in this request',
					sequence_number: 3,
				},
			] )
		);

		const turn = await runChatGptTurn( newChatGptSession( selection ), 'hi', selection, 'medium' );

		expect( turn.stopReason ).toBe( 'error' );
		// The raw overflow text stays out of the message pi scans, and rides
		// in the structured diagnostic instead.
		expect( turn.error ).not.toContain( 'context_length_exceeded' );
		expect( turn.error ).not.toContain( 'too many tokens' );
		const lastMessage = [ ...turn.events ]
			.reverse()
			.find( ( event ) => event.type === 'agent_end' );
		const messages =
			lastMessage?.type === 'agent_end'
				? ( lastMessage.messages as Array< { diagnostics?: unknown } > )
				: [];
		expect( JSON.stringify( messages.at( -1 )?.diagnostics ?? [] ) ).toContain(
			'context_length_exceeded'
		);
		expect( requests ).toHaveLength( 1 );
		expect( turn.events.some( ( event ) => event.type === 'auto_retry_start' ) ).toBe( false );
		expect( turn.entries.some( ( entry ) => entry.type === 'compaction' ) ).toBe( false );
	} );

	it( 'sends an image tool result back as image input', async () => {
		const selection = selectionFor();
		replies.push( imageToolCallReply, () => textReply( 'It is a tiny image.' ) );

		const turn = await runChatGptTurn(
			newChatGptSession( selection ),
			'Describe screenshot.png',
			selection,
			'medium'
		);

		expect( turn.error ).toBeUndefined();
		expect( requests ).toHaveLength( 2 );
		const [ output ] = itemsOfType( requests[ 1 ], 'function_call_output' );
		expect( output.call_id ).toBe( IMAGE_READ_CALL.call_id );
		expect( JSON.stringify( output.output ) ).toContain( 'input_image' );
		expect( JSON.stringify( output.output ) ).toContain( 'data:image/png;base64,' );
		expect( fakeBroker.handles[ 0 ].tokenRequests ).toBe( 2 );
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
		// Closed as interrupted, not as an error.
		expect( turn.stopReason ).toBe( 'aborted' );
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
		expect( turn.stopReason ).toBe( 'aborted' );
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
			// Both connections can serve 'gpt-6-luna', and a usable API key is
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
			expect( JSON.stringify( chatGpt.entries ) ).not.toContain( TOKEN );
			expect( JSON.stringify( chatGpt.entries ) ).not.toContain( API_KEY );
			expect( JSON.stringify( chatGpt.events ) ).not.toContain( TOKEN );
			expect( JSON.stringify( chatGpt.events ) ).not.toContain( API_KEY );
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
				model: 'gpt-6-luna',
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
			// The synthetic failure is stamped as a ChatGPT reply, not Anthropic's.
			expect( JSON.stringify( turn.events ) ).toContain( '"provider":"studio-chatgpt"' );
			expect( JSON.stringify( turn.entries ) ).not.toContain( API_KEY );
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
				model: 'gpt-6-luna',
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

		it.each( [ 'gpt-7-nova', 'gpt-6.1-sol' ] )(
			'refuses %s, a ChatGPT model Studio doesn’t support, saying it isn’t qualified',
			async ( modelId ) => {
				const selection = selectionFor( { model: { providerId: 'chatgpt-oauth', modelId } } );

				const turn = await runChatGptTurn(
					newChatGptSession( selection ),
					'hi',
					selection,
					'medium'
				);

				expect( turn.error ).toBe(
					`Studio doesn’t support the ChatGPT model “${ modelId }” yet: it isn’t qualified for use with a ChatGPT plan. Choose another model to continue.`
				);
				expect( fetchSpy ).not.toHaveBeenCalled();
				expect( fakeBroker.handles ).toHaveLength( 0 );
			}
		);

		it( 'refuses an effort the model doesn’t list, rather than sending a nearby one', async () => {
			const selection = selectionFor();

			const turn = await runChatGptTurn( newChatGptSession( selection ), 'hi', selection, 'high' );

			expect( turn.error ).toMatch(
				/^Studio doesn’t support “High” reasoning for gpt-6-luna with ChatGPT yet/
			);
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

	// Every request of the turn on the selected connection, model and effort,
	// with no output cap.
	const expectPinned = ( effort: OpenAiReasoningEffort, token = TOKEN ) => {
		expect( requests.length ).toBeGreaterThan( 0 );
		expect( fakeBroker.handles.length ).toBeGreaterThan( 0 );
		for ( const handle of fakeBroker.handles ) {
			expect( handle.connectionId ).toBe( CONNECTION_ID );
		}
		for ( const request of requests ) {
			expect( request.headers.get( 'authorization' ) ).toBe( `Bearer ${ token }` );
			expect( request.body.model ).toBe( 'gpt-6-luna' );
			expect( request.body.reasoning ).toEqual( { effort } );
			expect( request.body ).not.toHaveProperty( 'max_output_tokens' );
		}
	};

	const outputFor = ( request: CapturedRequest, callId: string ) => {
		const output = itemsOfType( request, 'function_call_output' ).find(
			( item ) => item.call_id === callId
		);
		if ( ! output ) {
			throw new Error( `No output for ${ callId }` );
		}
		return output.output;
	};

	const declaredTools = ( request: CapturedRequest ) =>
		( request.body.input[ 0 ].tools as Array< { name: string; description?: string } > ).map(
			( tool ) => tool.name
		);

	const imageCount = ( value: unknown ) =>
		JSON.stringify( value ).match( /"type":"input_image"/g )?.length ?? 0;

	const userContent = ( request: CapturedRequest ) =>
		request.body.input.filter( ( item ) => item.role === 'user' ).map( ( item ) => item.content );

	const attachedImage = ( id: string ) => ( {
		id,
		name: `${ id }.png`,
		mimeType: 'image/png' as const,
		size: Buffer.from( TINY_PNG_BASE64, 'base64' ).length,
		dataBase64: TINY_PNG_BASE64,
	} );

	const IMAGE_SERVICE_TOKEN = 'test-wpcom-image-service-token';

	describe( 'rich Studio workflows on the ChatGPT route', () => {
		it( 'sends the composer’s attached images to the model as image input with the prompt', async () => {
			const selection = selectionFor();
			replies.push( () => textReply( 'Two small images.' ) );

			const turn = await runTurn( newChatGptSession( selection ), 'Compare these.', {
				connection: selection,
				chatGpt: { reasoningEffort: 'medium' },
				images: [ attachedImage( 'first' ), attachedImage( 'second' ) ],
			} );

			expect( turn.error ).toBeUndefined();
			expect( requests ).toHaveLength( 1 );
			expectPinned( 'medium' );
			const [ content ] = userContent( requests[ 0 ] );
			expect( content ).toEqual( [
				{ type: 'input_text', text: 'Compare these.' },
				expect.objectContaining( {
					type: 'input_image',
					image_url: `data:image/png;base64,${ TINY_PNG_BASE64 }`,
				} ),
				expect.objectContaining( {
					type: 'input_image',
					image_url: `data:image/png;base64,${ TINY_PNG_BASE64 }`,
				} ),
			] );
			// Without a way to ask the user, no question tool; without the image
			// service, no image generation.
			expect( declaredTools( requests[ 0 ] ) ).not.toContain( 'AskUserQuestion' );
			expect( declaredTools( requests[ 0 ] ) ).not.toContain( 'generate_images' );
		} );

		it( 'returns a screenshot to the model as image input, shows it as an artifact with progress, and refreshes the preview', async () => {
			const ui = { showArtifact: vi.fn(), reloadPreview: vi.fn() };
			host.ui = ui;
			const selection = selectionFor();
			const shot = toolCalls( {
				name: 'take_screenshot',
				args: { url: 'http://localhost:8881/' },
			} );
			const refresh = toolCalls( { name: 'refresh_browser', args: {} } );
			replies.push( shot.reply, refresh.reply, () => textReply( 'The page renders.' ) );

			const turn = await runChatGptTurn(
				newChatGptSession( selection ),
				'Check the home page.',
				selection,
				'medium'
			);

			expect( turn.error ).toBeUndefined();
			expect( requests ).toHaveLength( 3 );
			expectPinned( 'medium' );
			const declared = requests[ 0 ].body.input[ 0 ].tools as Array< {
				name: string;
				description: string;
			} >;
			expect( declared.find( ( tool ) => tool.name === 'take_screenshot' )?.description ).toContain(
				'Returns the screenshot as an image that you can analyze visually'
			);
			expect( seams.captureScreenshotBuffer ).toHaveBeenCalledWith(
				'http://localhost:8881/',
				expect.anything(),
				expect.objectContaining( { forModel: true } )
			);
			expect( outputFor( requests[ 1 ], shot.callIds[ 0 ] ) ).toEqual( [
				{ type: 'input_text', text: expect.stringContaining( 'Screenshot captured' ) },
				expect.objectContaining( {
					type: 'input_image',
					image_url: `data:image/jpeg;base64,${ SCREENSHOT_JPEG.toString( 'base64' ) }`,
				} ),
			] );
			// The next request replays the capture with the rest of the history.
			expect( imageCount( outputFor( requests[ 2 ], shot.callIds[ 0 ] ) ) ).toBe( 1 );
			expect( ui.showArtifact ).toHaveBeenCalledTimes( 1 );
			expect( ui.showArtifact.mock.calls[ 0 ][ 0 ].widgets ).toEqual( [
				expect.objectContaining( {
					type: 'media',
					widgetProps: expect.objectContaining( { mediaKind: 'image' } ),
				} ),
			] );
			expect(
				turn.events.some(
					( event ) =>
						event.type === 'tool_execution_update' &&
						event.toolName === 'take_screenshot' &&
						JSON.stringify( event.partialResult ).includes( 'Taking desktop screenshot' )
				)
			).toBe( true );
			expect( ui.reloadPreview ).toHaveBeenCalledTimes( 1 );
			expect( String( outputFor( requests[ 2 ], refresh.callIds[ 0 ] ) ) ).toBe(
				'Reloaded the site preview.'
			);
		} );

		it( 'asks the user a question and gives the model their answer', async () => {
			const selection = selectionFor();
			const onAskUser = vi.fn( async () => ( { 'Which layout?': 'Two columns' } ) );
			const question = {
				question: 'Which layout?',
				options: [
					{ label: 'One column', description: 'A single column.' },
					{ label: 'Two columns', description: 'Content with a sidebar.' },
				],
			};
			const ask = toolCalls( { name: 'AskUserQuestion', args: { questions: [ question ] } } );
			replies.push( ask.reply, () => textReply( 'Two columns it is.' ) );

			const turn = await runTurn( newChatGptSession( selection ), 'Pick a layout with me.', {
				connection: selection,
				chatGpt: { reasoningEffort: 'medium' },
				onAskUser,
			} );

			expect( turn.error ).toBeUndefined();
			expect( turn.text ).toBe( 'Two columns it is.' );
			expectPinned( 'medium' );
			expect( declaredTools( requests[ 0 ] ) ).toContain( 'AskUserQuestion' );
			expect( onAskUser ).toHaveBeenCalledExactlyOnceWith( [
				expect.objectContaining( question ),
			] );
			expect( JSON.parse( String( outputFor( requests[ 1 ], ask.callIds[ 0 ] ) ) ) ).toEqual( {
				'Which layout?': 'Two columns',
			} );
		} );

		it( 'gives the model the user’s visual annotations and their images, from the composer and from the annotation browser', async () => {
			const selection = selectionFor();
			const target = { tag: 'h1', selector: 'h1', path: '/', url: 'http://localhost:8881/' };
			const composerImage = attachedImage( 'note-image' );
			const prompt = formatVisualAnnotationsPrompt(
				[
					{
						...target,
						id: 'note-1',
						number: 1,
						comment: 'Make this heading larger.',
						images: [ { id: composerImage.id } ],
					},
				],
				[ composerImage ]
			);
			seams.annotateInBrowser.mockResolvedValue( [
				{
					...target,
					id: 'note-2',
					number: 1,
					comment: 'Use the brand blue here.',
					images: [ attachedImage( 'browser-image' ) ],
				},
			] );
			const browse = toolCalls( {
				name: 'open_annotation_browser',
				args: { url: 'http://localhost:8881/' },
			} );
			replies.push( browse.reply, () => textReply( 'I’ll make both changes.' ) );

			const turn = await runTurn( newChatGptSession( selection ), prompt, {
				connection: selection,
				chatGpt: { reasoningEffort: 'medium' },
				images: [ composerImage ],
			} );

			expect( turn.error ).toBeUndefined();
			expectPinned( 'medium' );
			const [ content ] = userContent( requests[ 0 ] );
			expect( JSON.stringify( content ) ).toContain( 'Make this heading larger.' );
			expect( imageCount( content ) ).toBe( 1 );
			expect( seams.annotateInBrowser ).toHaveBeenCalledWith(
				'http://localhost:8881/',
				30 * 60 * 1000
			);
			const output = outputFor( requests[ 1 ], browse.callIds[ 0 ] );
			expect( JSON.stringify( output ) ).toContain( 'Use the brand blue here.' );
			expect( imageCount( output ) ).toBe( 1 );
		} );

		it( 'reads an attached document, reports a missing one and refuses a core-file write to the model, without failing the turn', async () => {
			const selection = selectionFor();
			const downloads = path.join( paths.root, 'Downloads' );
			fs.mkdirSync( downloads );
			const brief = path.join( downloads, 'brief.md' );
			fs.writeFileSync( brief, '# Brief\nThe site sells sourdough.\n' );
			const missing = path.join( downloads, 'gone.md' );
			const site = path.join( sitesRoot, 'bakery' );
			fs.mkdirSync( path.join( site, 'wp-includes' ), { recursive: true } );
			fs.mkdirSync( path.join( site, 'wp-content' ), { recursive: true } );
			const core = path.join( site, 'wp-includes', 'version.php' );
			fs.writeFileSync( core, "<?php $wp_version = '7.1';\n" );
			vi.mocked( host.sites.findByFolder ).mockImplementation( async ( folder ) =>
				path.resolve( folder ) === path.resolve( site ) ? { ...fakeSite, path: site } : undefined
			);
			const prompt = `Use the attached brief.${ buildAttachedFilesPromptBlock( [
				{ id: 'brief', name: 'brief.md', path: brief },
				{ id: 'gone', name: 'gone.md', path: missing },
			] ) }`;
			const reads = toolCalls(
				{ name: 'Read', args: { path: brief } },
				{ name: 'Read', args: { path: missing } }
			);
			const write = toolCalls( { name: 'Write', args: { path: core, content: 'changed' } } );
			replies.push( reads.reply, write.reply, () =>
				textReply( 'I used the brief; one attachment is missing.' )
			);

			const turn = await runChatGptTurn(
				newChatGptSession( selection ),
				prompt,
				selection,
				'medium'
			);

			expect( turn.error ).toBeUndefined();
			expect( turn.text ).toBe( 'I used the brief; one attachment is missing.' );
			expectPinned( 'medium' );
			expect( userContent( requests[ 0 ] ) ).toEqual( [
				[ { type: 'input_text', text: prompt } ],
			] );
			expect( String( outputFor( requests[ 1 ], reads.callIds[ 0 ] ) ) ).toContain(
				'The site sells sourdough.'
			);
			expect( String( outputFor( requests[ 1 ], reads.callIds[ 1 ] ) ) ).toMatch(
				/ENOENT|not found/i
			);
			expect( String( outputFor( requests[ 2 ], write.callIds[ 0 ] ) ) ).toContain(
				"Not run: wp-includes/version.php is this Studio site's copy of WordPress core"
			);
			expect( fs.readFileSync( core, 'utf8' ) ).toContain( "'7.1'" );
		} );

		it( 'settles background image generation before a screenshot runs, and reports its failure to the model with that result', async () => {
			vi.stubEnv( 'STUDIO_IMAGE_API_TOKEN', IMAGE_SERVICE_TOKEN );
			host.ui = { showArtifact: vi.fn(), reloadPreview: vi.fn() };
			const answer = deferred< Response >();
			imageService = () => answer.promise;
			const selection = selectionFor();
			const hero = path.join( sitesRoot, 'bakery', 'wp-content', 'themes', 'b', 'hero.png' );
			const generate = toolCalls( {
				name: 'generate_images',
				args: { images: [ { path: hero, subject: 'A loaf of sourdough on a board.' } ] },
			} );
			const shot = toolCalls( {
				name: 'take_screenshot',
				args: { url: 'http://localhost:8881/' },
			} );
			replies.push( generate.reply, shot.reply, () => textReply( 'The hero image failed.' ) );

			const turn = await runChatGptTurn(
				newChatGptSession( selection ),
				'Add a hero image.',
				selection,
				'medium',
				{},
				( event ) => {
					if ( event.type === 'tool_execution_start' && event.toolName === 'take_screenshot' ) {
						setTimeout( () => {
							seams.order.push( 'image answered' );
							answer.resolve(
								new Response( JSON.stringify( { error: { message: 'Bad request.' } } ), {
									status: 400,
								} )
							);
						}, 0 );
					}
				}
			);

			expect( turn.error ).toBeUndefined();
			expect( seams.order ).toEqual( [ 'image answered', 'capture' ] );
			expect( String( outputFor( requests[ 1 ], generate.callIds[ 0 ] ) ) ).toContain(
				'Generating 1 image in the background'
			);
			expect( JSON.stringify( outputFor( requests[ 2 ], shot.callIds[ 0 ] ) ) ).toContain(
				`These images failed`
			);
			expect( fs.existsSync( hero ) ).toBe( false );
			expectPinned( 'medium' );
		} );

		it( 'doesn’t end the turn before its background image generation settles', async () => {
			vi.stubEnv( 'STUDIO_IMAGE_API_TOKEN', IMAGE_SERVICE_TOKEN );
			const answer = deferred< Response >();
			imageService = () => answer.promise;
			const selection = selectionFor();
			const hero = path.join( sitesRoot, 'bakery', 'wp-content', 'themes', 'b', 'hero.png' );
			const generate = toolCalls( {
				name: 'generate_images',
				args: { images: [ { path: hero, subject: 'A loaf of sourdough on a board.' } ] },
			} );
			replies.push( generate.reply, () => textReply( 'Your hero image is on its way.' ) );

			const turn = await runChatGptTurn(
				newChatGptSession( selection ),
				'Add a hero image.',
				selection,
				'medium',
				{},
				( event ) => {
					if ( event.type === 'agent_end' && ! event.willRetry ) {
						setTimeout( () => {
							seams.order.push( 'image answered' );
							answer.resolve(
								new Response( JSON.stringify( { data: [ { b64_json: TINY_PNG_BASE64 } ] } ) )
							);
						}, 0 );
					}
				}
			);
			seams.order.push( 'turn ended' );

			expect( turn.error ).toBeUndefined();
			expect( seams.order ).toEqual( [ 'image answered', 'turn ended' ] );
			expect( fs.readFileSync( hero ).toString( 'base64' ) ).toBe( TINY_PNG_BASE64 );
		} );

		// Today's behavior, which G2b builds on: image generation is Studio's
		// WordPress.com image service, offered on a ChatGPT turn when that
		// service is configured, and it never uses the ChatGPT sign-in.
		it.each( [
			[ 'no image service', {}, null, undefined ],
			[
				'an image service token',
				{ STUDIO_IMAGE_API_TOKEN: IMAGE_SERVICE_TOKEN },
				null,
				IMAGE_SERVICE_TOKEN,
			],
			[ 'a WordPress.com login', {}, 'test-wpcom-login-token', 'test-wpcom-login-token' ],
		] as const )(
			'offers image generation with %s, on its own credential',
			async ( _name, env, login, imageToken ) => {
				for ( const [ name, value ] of Object.entries( env ) ) {
					vi.stubEnv( name, value );
				}
				seams.wpcomLogin = login ? { accessToken: login } : null;
				imageService = () =>
					new Response( JSON.stringify( { data: [ { b64_json: TINY_PNG_BASE64 } ] } ) );
				const selection = selectionFor();
				const hero = path.join( sitesRoot, 'bakery', 'wp-content', 'themes', 'b', 'hero.png' );
				const generate = toolCalls( {
					name: 'generate_images',
					args: { images: [ { path: hero, subject: 'A loaf of sourdough on a board.' } ] },
				} );
				replies.push( ...( imageToken ? [ generate.reply ] : [] ), () => textReply( 'Done.' ) );

				const turn = await runChatGptTurn(
					newChatGptSession( selection ),
					'Add a hero image.',
					selection,
					'medium'
				);

				expect( turn.error ).toBeUndefined();
				expectPinned( 'medium' );
				expect( declaredTools( requests[ 0 ] ).includes( 'generate_images' ) ).toBe(
					Boolean( imageToken )
				);
				expect( imageRequests.map( ( headers ) => headers.get( 'authorization' ) ) ).toEqual(
					imageToken ? [ `Bearer ${ imageToken }` ] : []
				);
				expect(
					JSON.stringify( imageRequests.map( ( headers ) => [ ...headers ] ) )
				).not.toContain( TOKEN );
				expect(
					JSON.stringify( requests.map( ( request ) => [ ...request.headers ] ) )
				).not.toMatch( /test-wpcom-/ );
			}
		);
	} );

	describe( 'compaction, restart and interruption on the ChatGPT route', () => {
		const LONG_LOG = `Check this log for errors:\n${ 'PHP Notice: nothing to see here.\n'.repeat(
			3_000
		) }`;

		// pi's own summarization prompt, pinned in compaction.test.ts.
		const isSummaryRequest = ( request: CapturedRequest ) =>
			String( request.body.instructions ?? '' ).startsWith(
				'You are a context summarization assistant.'
			);

		const compacted = ( turn: { entries: Array< { type: string } > } ) =>
			turn.entries.some( ( entry ) => entry.type === 'compaction' );

		const toolRuns = ( turn: { events: AgentSessionEvent[] } ) =>
			turn.events.filter( ( event ) => event.type === 'tool_execution_start' ).length;

		// A first turn that read a file, so the history holds a tool call.
		async function readConfigTurn( selection: ConnectionSelection ) {
			const read = toolCalls( { name: 'Read', args: { path: 'wp-config.php' } } );
			replies.push( read.reply, () => textReply( 'DB_NAME is studio.' ) );
			const turn = await runChatGptTurn(
				newChatGptSession( selection ),
				'What is the database name?',
				selection,
				'medium'
			);
			expect( turn.error ).toBeUndefined();
			requests.length = 0;
			return { turn, read };
		}

		it( 'replays an image-heavy history statelessly and summarizes it without its images, on the pinned connection, model and effort', async () => {
			const selection = selectionFor();
			const readImage = toolCalls( { name: 'Read', args: { path: 'screenshot.png' } } );
			replies.push( readImage.reply, () => textReply( 'Three images seen.' ) );
			const first = await runTurn(
				newChatGptSession( selection ),
				'Compare these with the screenshot.',
				{
					connection: selection,
					chatGpt: { reasoningEffort: 'medium' },
					images: [ attachedImage( 'a' ), attachedImage( 'b' ) ],
				}
			);
			expect( first.error ).toBeUndefined();
			expect( imageCount( requests[ 1 ].body.input ) ).toBe( 3 );
			expectPinned( 'medium' );

			// Reopened in a fresh agent, at another effort, near the budget.
			requests.length = 0;
			replies.push(
				() => textReply( 'The log has no errors.', 190_000 ),
				() => textReply( 'Summary: the user compared three images.' )
			);
			const second = await runChatGptTurn(
				reopen( first.sessionFile ),
				LONG_LOG,
				selection,
				'low'
			);

			expect( second.error ).toBeUndefined();
			expect( compacted( second ) ).toBe( true );
			expect( toolRuns( second ) ).toBe( 0 );
			expectPinned( 'low' );
			const [ turnRequest, ...summaryRequests ] = requests;
			expect( isSummaryRequest( turnRequest ) ).toBe( false );
			expect( imageCount( turnRequest.body.input ) ).toBe( 3 );
			expect( summaryRequests.length ).toBeGreaterThan( 0 );
			for ( const request of summaryRequests ) {
				expect( isSummaryRequest( request ) ).toBe( true );
				expect( imageCount( request.body.input ) ).toBe( 0 );
			}

			// The summary stands in for the images from here on.
			requests.length = 0;
			replies.push( () => textReply( 'Anything else?' ) );
			const third = await runChatGptTurn(
				reopen( second.sessionFile ),
				'Thanks.',
				selection,
				'low'
			);

			expect( third.error ).toBeUndefined();
			expect( requests ).toHaveLength( 1 );
			expectPinned( 'low' );
			expect( JSON.stringify( requests[ 0 ].body.input ) ).toContain(
				'the user compared three images'
			);
			expect( imageCount( requests[ 0 ].body.input ) ).toBe( 0 );
			expect( toolRuns( third ) ).toBe( 0 );
		} );

		it( 'keeps the history whole when compaction’s summary breaks off, without sending it again or re-running a tool', async () => {
			const selection = selectionFor();
			const { turn: first, read } = await readConfigTurn( selection );
			replies.push( () => textReply( 'The log has no errors.', 190_000 ), PARTIAL_REPLY );

			const second = await runChatGptTurn(
				reopen( first.sessionFile ),
				LONG_LOG,
				selection,
				'low'
			);

			expect( second.text ).toBe( 'The log has no errors.' );
			expect( requests.map( isSummaryRequest ) ).toEqual( [ false, true ] );
			expectPinned( 'low' );
			expect( compacted( second ) ).toBe( false );
			expect( toolRuns( second ) ).toBe( 0 );

			// The next turn still has the whole conversation, and summarizes on
			// the same connection, model and effort when it does.
			requests.length = 0;
			respond = ( request ) =>
				isSummaryRequest( request )
					? textReply( 'Summary: the database name is studio.' )
					: textReply( 'Anything else?' );
			const third = await runChatGptTurn(
				reopen( second.sessionFile ),
				'Thanks.',
				selection,
				'low'
			);

			expect( third.error ).toBeUndefined();
			expect( third.text ).toBe( 'Anything else?' );
			expectPinned( 'low' );
			const turnRequests = requests.filter( ( request ) => ! isSummaryRequest( request ) );
			expect( turnRequests ).toHaveLength( 1 );
			expect( toolRuns( third ) ).toBe( 0 );
			if ( ! compacted( third ) ) {
				expect( itemsOfType( turnRequests[ 0 ], 'function_call' ) ).toEqual( [
					expect.objectContaining( { call_id: read.callIds[ 0 ] } ),
				] );
			}
		} );

		it( 'invalidates a token rejected during compaction, keeps the history whole, and goes on with the newer token', async () => {
			const selection = selectionFor();
			const { turn: first } = await readConfigTurn( selection );
			const renewed = 'test-chatgpt-renewed-token';
			replies.push(
				() => textReply( 'The log has no errors.', 190_000 ),
				() => {
					fakeBroker.token = renewed;
					return new Response( JSON.stringify( { detail: `Rejected ${ TOKEN }` } ), {
						status: 401,
						headers: { 'content-type': 'application/json' },
					} );
				}
			);

			const second = await runChatGptTurn(
				reopen( first.sessionFile ),
				LONG_LOG,
				selection,
				'low'
			);

			expect( second.text ).toBe( 'The log has no errors.' );
			expect( requests.map( isSummaryRequest ) ).toEqual( [ false, true ] );
			expectPinned( 'low' );
			expect( fakeBroker.handles.at( -1 )!.invalidations ).toEqual( [ TOKEN ] );
			expect( compacted( second ) ).toBe( false );
			expect( JSON.stringify( [ second.events, second.entries ] ) ).not.toContain( TOKEN );

			requests.length = 0;
			respond = ( request ) =>
				isSummaryRequest( request )
					? textReply( 'Summary: the database name is studio.' )
					: textReply( 'Anything else?' );
			const third = await runChatGptTurn(
				reopen( second.sessionFile ),
				'Thanks.',
				selection,
				'low'
			);

			expect( third.error ).toBeUndefined();
			expectPinned( 'low', renewed );
			expect( toolRuns( third ) ).toBe( 0 );
			expect( JSON.stringify( [ third.events, third.entries ] ) ).not.toContain( renewed );
		} );

		it( 'reports a partly failed tool batch to the model and, after a mid-stream failure, resumes without running either tool again', async () => {
			const selection = selectionFor();
			vi.mocked( host.sites.wpCli )
				.mockResolvedValueOnce( { exitCode: 0, stdout: 'Success: Created post 5.', stderr: '' } )
				.mockResolvedValueOnce( {
					exitCode: 1,
					stdout: '',
					stderr: 'Error: Could not find the post with ID 99.',
				} );
			const batch = toolCalls(
				{
					name: 'wp_cli',
					args: {
						nameOrPath: 'My Site',
						command: 'post create --post_title=Hello --post_status=draft',
					},
				},
				{ name: 'wp_cli', args: { nameOrPath: 'My Site', command: 'post get 99' } }
			);
			replies.push( batch.reply, () =>
				sse( [
					...PARTIAL_EVENTS,
					{
						type: 'response.failed',
						response: {
							id: 'resp_partial',
							status: 'failed',
							output: [],
							error: { code: 'server_error', message: 'Upstream exploded.' },
						},
					},
				] )
			);

			const first = await runChatGptTurn(
				newChatGptSession( selection ),
				'Create a draft, then read post 99.',
				selection,
				'medium'
			);

			expect( first.stopReason ).toBe( 'error' );
			expect( first.error ).toMatch( /^ChatGPT had a server error/ );
			expect( first.events.some( ( event ) => event.type === 'auto_retry_start' ) ).toBe( false );
			expect( requests ).toHaveLength( 2 );
			expectPinned( 'medium' );
			expect( String( outputFor( requests[ 1 ], batch.callIds[ 0 ] ) ) ).toContain(
				'Success: Created post 5.'
			);
			expect( String( outputFor( requests[ 1 ], batch.callIds[ 1 ] ) ) ).toContain(
				'Could not find the post with ID 99.'
			);
			expect( host.sites.wpCli ).toHaveBeenCalledTimes( 2 );

			requests.length = 0;
			replies.push( () => textReply( 'Post 5 is a draft; post 99 doesn’t exist.' ) );
			const second = await runChatGptTurn(
				reopen( first.sessionFile ),
				'What happened?',
				selection,
				'low'
			);

			expect( second.error ).toBeUndefined();
			expect( requests ).toHaveLength( 1 );
			expectPinned( 'low' );
			expect( host.sites.wpCli ).toHaveBeenCalledTimes( 2 );
			expect( toolRuns( second ) ).toBe( 0 );
			expect(
				itemsOfType( requests[ 0 ], 'function_call' ).map( ( item ) => item.call_id )
			).toEqual( batch.callIds );
			expect( String( outputFor( requests[ 0 ], batch.callIds[ 0 ] ) ) ).toContain(
				'Success: Created post 5.'
			);
			expect( String( outputFor( requests[ 0 ], batch.callIds[ 1 ] ) ) ).toContain(
				'Could not find the post with ID 99.'
			);
			// The reply that failed partway isn't replayed as if it were whole.
			expect( JSON.stringify( requests[ 0 ].body.input ) ).not.toContain(
				'Here is the first half of'
			);
		} );

		it.each( [
			[ 'while its command runs', 'during', 1, 'Success: Created post 5.' ],
			[ 'before its command starts', 'before', 0, 'Operation aborted' ],
		] as const )(
			'never runs a tool call again that an interruption cut into %s',
			async ( _name, when, commandRuns, recorded ) => {
				const selection = selectionFor();
				vi.mocked( host.sites.wpCli ).mockImplementationOnce( async () => {
					if ( when === 'during' ) {
						void activeHandle!.interrupt();
					}
					return { exitCode: 0, stdout: 'Success: Created post 5.', stderr: '' };
				} );
				const create = toolCalls( {
					name: 'wp_cli',
					args: {
						nameOrPath: 'My Site',
						command: 'post create --post_title=Hello --post_status=draft',
					},
				} );
				replies.push( create.reply );

				const first = await runChatGptTurn(
					newChatGptSession( selection ),
					'Create a draft.',
					selection,
					'medium',
					{},
					( event ) => {
						if (
							when === 'before' &&
							event.type === 'tool_execution_start' &&
							event.toolName === 'wp_cli'
						) {
							void activeHandle!.interrupt();
						}
					}
				);

				// pi records an abort that lands while it prepares the next request as
				// an error, on every provider, not as an interruption.
				expect( first.stopReason ).toBe( 'error' );
				expect( first.error ).toBe( 'This operation was aborted' );
				expect( requests ).toHaveLength( 1 );
				expect( host.sites.wpCli ).toHaveBeenCalledTimes( commandRuns );

				requests.length = 0;
				replies.push( () => textReply( 'I’ll check whether the draft exists first.' ) );
				const second = await runChatGptTurn(
					reopen( first.sessionFile ),
					'Did it work?',
					selection,
					'low'
				);

				expect( second.error ).toBeUndefined();
				expect( requests ).toHaveLength( 1 );
				expectPinned( 'low' );
				expect( host.sites.wpCli ).toHaveBeenCalledTimes( commandRuns );
				expect( toolRuns( second ) ).toBe( 0 );
				expect(
					itemsOfType( requests[ 0 ], 'function_call' ).map( ( item ) => item.call_id )
				).toEqual( create.callIds );
				expect( outputFor( requests[ 0 ], create.callIds[ 0 ] ) ).toBe( recorded );
			}
		);
	} );
} );
