import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from '@studio/agent/node/agent';
import { OPENAI_MODEL_CAPABILITIES } from '@studio/agent/protocol/openai-models';
import { readLastReplyProvider } from '@studio/agent/protocol/providers';
import { createFakeHost } from '../../tests/fake-host';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type {
	OpenAiReasoningEffort,
	OpenAiTurnSettings,
} from '@studio/agent/protocol/openai-models';

/*
 * The real pi agent session — its agent loop, tools, session file and
 * compaction — with only OpenAI's HTTP endpoint replaced by Responses streams
 * scripted here, and a fake Studio host. Each turn reopens the session file in
 * a fresh agent, within this one process: the CLI isn't forked, and the
 * reasoning each turn uses is passed in rather than read from settings.
 */

// A test key only; nothing here reaches OpenAI.
const KEY = 'sk-proj-TESTONLY_session_cccccccccccccccccccccccccccc';
const RESPONSES_URL = 'https://api.openai.com/v1/responses';

const paths = vi.hoisted( () => ( { root: '' } ) );

vi.mock( '@studio/common/lib/well-known-paths', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/common/lib/well-known-paths') >();
	return {
		...actual,
		getConfigDirectory: () => path.join( paths.root, 'config' ),
		getAiPayloadsPath: () => path.join( paths.root, 'config', 'ai-payloads' ),
	};
} );

const settingsFor = ( reasoningEffort: OpenAiReasoningEffort ): OpenAiTurnSettings => ( {
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

type RequestBody = Record< string, unknown > & {
	input: Array< Record< string, unknown > >;
	reasoning?: Record< string, unknown >;
};

describe( 'an OpenAI conversation in a real agent session', () => {
	let sitesRoot: string;
	let sessionDir: string;
	let replies: Array< () => Response >;
	let requests: RequestBody[];

	beforeEach( () => {
		paths.root = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-openai-session-' ) );
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
		vi.spyOn( globalThis, 'fetch' ).mockImplementation( async ( input, init ) => {
			const url = input instanceof Request ? input.url : String( input );
			if ( url !== RESPONSES_URL ) {
				return new Response( null, { status: 404 } );
			}
			requests.push( JSON.parse( String( init?.body ) ) as RequestBody );
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

	// Each turn runs in a fresh agent on the reopened session file, as each turn
	// of a Studio app's forked CLI does.
	async function runTurn(
		sessionFile: string | undefined,
		prompt: string,
		effort: OpenAiReasoningEffort
	) {
		const session = sessionFile
			? SessionManager.open( sessionFile, sessionDir, sitesRoot )
			: SessionManager.create( sitesRoot, sessionDir );
		const events: AgentSessionEvent[] = [];
		const agent = createAgent( { host: createFakeHost( sitesRoot ) } );
		const handle = agent.runTurn( {
			prompt,
			session,
			model: 'gpt-6.1-sol',
			openAi: settingsFor( effort ),
			env: { STUDIO_OPENAI_API_KEY: KEY },
			onEvent: ( event ) => events.push( event ),
		} );
		await handle.result;
		const end = [ ...events ].reverse().find( ( event ) => event.type === 'agent_end' );
		const last = end?.type === 'agent_end' ? end.messages.at( -1 ) : undefined;
		return {
			sessionFile: session.getSessionFile()!,
			error: last?.role === 'assistant' ? last.errorMessage : undefined,
			entries: session.getEntries(),
		};
	}

	const itemsOfType = ( request: RequestBody, type: string ) =>
		request.input.filter( ( item ) => item.type === type );

	it( 'keeps reasoning, tool calls and settings straight across tool use, reopened sessions and compaction', async () => {
		// Turn 1, Medium: the model reasons, reads a file, then answers.
		replies.push( toolCallReply, () => textReply( 'DB_NAME is studio.' ) );
		const first = await runTurn( undefined, 'What is the database name?', 'medium' );

		expect( first.error ).toBeUndefined();
		// The provider pi records on the replies is the one Studio reads them by.
		expect( readLastReplyProvider( first.entries ) ).toBe( 'openai-api-key' );
		expect( requests ).toHaveLength( 2 );
		for ( const request of requests ) {
			expect( request.reasoning ).toEqual( { effort: 'medium' } );
			expect( request.store ).toBe( false );
			expect( JSON.stringify( request.input ) ).not.toContain( 'configuration_update' );
		}
		// The continuation replays the encrypted reasoning before the call it led
		// to, and answers that call by its id.
		const continuation = requests[ 1 ];
		expect( itemsOfType( continuation, 'reasoning' ) ).toEqual( [
			expect.objectContaining( {
				id: REASONING.id,
				encrypted_content: REASONING.encrypted_content,
			} ),
		] );
		const types = continuation.input.map( ( item ) => item.type ?? item.role );
		expect( types.indexOf( 'reasoning' ) ).toBeLessThan( types.indexOf( 'function_call' ) );
		expect( itemsOfType( continuation, 'function_call' ) ).toEqual( [
			expect.objectContaining( { call_id: READ_CALL.call_id, name: 'Read' } ),
		] );
		const [ output ] = itemsOfType( continuation, 'function_call_output' );
		expect( output.call_id ).toBe( READ_CALL.call_id );
		expect( String( output.output ) ).toContain( "define( 'DB_NAME', 'studio' )" );

		// Turn 2, in a fresh agent, with High passed in. Its reply reports a
		// context close to the budget, so the session compacts afterwards.
		requests.length = 0;
		// Long enough that what came before it is what compaction summarizes.
		const longPrompt = `Check this log for errors:\n${ 'PHP Notice: nothing to see here.\n'.repeat(
			3_000
		) }`;
		replies.push(
			() => textReply( 'The log has no errors.', 190_000 ),
			() => textReply( 'Summary: the user asked for the database name; it is studio.' )
		);
		const second = await runTurn( first.sessionFile, longPrompt, 'high' );

		expect( second.error ).toBeUndefined();
		expect( requests.length ).toBeGreaterThanOrEqual( 2 );
		const [ turnRequest, ...compactionRequests ] = requests;
		expect( turnRequest.reasoning ).toEqual( { effort: 'high' } );
		// The history from the earlier agent is all there, call ids included.
		expect( itemsOfType( turnRequest, 'reasoning' ) ).toEqual( [
			expect.objectContaining( { encrypted_content: REASONING.encrypted_content } ),
		] );
		expect( itemsOfType( turnRequest, 'function_call_output' ) ).toEqual( [
			expect.objectContaining( { call_id: READ_CALL.call_id } ),
		] );
		// Compaction's summary request runs on the same model and effort.
		for ( const request of compactionRequests ) {
			expect( request.model ).toBe( turnRequest.model );
			expect( request.reasoning ).toEqual( { effort: 'high' } );
			expect( request.store ).toBe( false );
			expect( JSON.stringify( request.input ) ).not.toContain( 'configuration_update' );
		}
		expect( second.entries.some( ( entry ) => entry.type === 'compaction' ) ).toBe( true );

		// Turn 3, in another fresh agent: the summary stands in for the early turns.
		requests.length = 0;
		replies.push( () => textReply( 'Anything else?' ) );
		const third = await runTurn( second.sessionFile, 'Thanks.', 'high' );

		expect( third.error ).toBeUndefined();
		expect( requests ).toHaveLength( 1 );
		const [ afterCompaction ] = requests;
		expect( afterCompaction.reasoning ).toEqual( { effort: 'high' } );
		expect( JSON.stringify( afterCompaction.input ) ).toContain(
			'the user asked for the database name'
		);
		expect( itemsOfType( afterCompaction, 'function_call' ) ).toEqual( [] );
		expect( JSON.stringify( afterCompaction.input ) ).not.toContain( REASONING.encrypted_content );
	} );
} );
