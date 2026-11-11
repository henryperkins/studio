// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	installAcceptanceObserver,
	readObservedLines,
	summarizeObservedRequest,
	summarizeResponseStream,
} from 'cli/ai/chatgpt-acceptance-observer';

const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl';
const API_KEY = 'sk-proj-0123456789abcdefABCDEF';
const PROMPT = 'Create a draft titled Secret Plans';

const responsesBody = ( overrides: Record< string, unknown > = {} ) =>
	JSON.stringify( {
		model: 'gpt-6-luna',
		stream: true,
		store: false,
		reasoning: { effort: 'low' },
		include: [ 'reasoning.encrypted_content' ],
		input: [
			{ type: 'additional_tools', role: 'developer', tools: [ { name: 'a' }, { name: 'b' } ] },
			{ role: 'developer', content: 'You are Studio.' },
			{
				role: 'user',
				content: [
					{ type: 'input_text', text: PROMPT },
					{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
				],
			},
			{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' },
			{ type: 'function_call', call_id: 'c1', name: 'take_screenshot', arguments: '{}' },
			{
				type: 'function_call_output',
				call_id: 'c1',
				output: [ { type: 'input_image', image_url: 'data:image/png;base64,BBBB' } ],
			},
			{
				type: 'message',
				role: 'assistant',
				content: [ { type: 'output_text', text: 'ok', annotations: [] } ],
			},
		],
		...overrides,
	} );

describe( 'acceptance request observer', () => {
	it( 'summarizes a ChatGPT route request by shape and counts alone', () => {
		const summary = summarizeObservedRequest( 'https://api.openai.com/v1/responses', {
			method: 'POST',
			headers: { authorization: `Bearer ${ JWT }` },
			body: responsesBody(),
		} );
		expect( summary ).toEqual( {
			host: 'chatgpt-route',
			endpoint: 'responses',
			bearer: 'jwt',
			model: 'gpt-6-luna',
			effort: 'low',
			stream: true,
			store: false,
			outputCap: false,
			previousResponseId: false,
			tools: 2,
			inputItems: 7,
			userMessages: 1,
			assistantMessages: 1,
			functionCalls: 1,
			functionOutputs: 1,
			reasoningItems: 1,
			imageInputs: 1,
			imageToolOutputs: 1,
		} );
		const text = JSON.stringify( summary );
		for ( const secret of [ JWT, PROMPT, 'opaque', 'AAAA', 'BBBB', 'You are Studio' ] ) {
			expect( text ).not.toContain( secret );
		}
	} );

	it( 'tells an API-key request on the same endpoint apart, and flags an output cap', () => {
		expect(
			summarizeObservedRequest( new URL( 'https://api.openai.com/v1/responses' ), {
				headers: new Headers( { Authorization: `Bearer ${ API_KEY }` } ),
				body: responsesBody( { max_output_tokens: 10, previous_response_id: 'resp_1' } ),
			} )
		).toMatchObject( {
			host: 'openai-api',
			bearer: 'api-key',
			outputCap: true,
			previousResponseId: true,
		} );
	} );

	it( 'classifies other destinations without keeping their addresses', () => {
		expect(
			summarizeObservedRequest( 'https://api.openai.com/v1/models', {
				headers: { authorization: `Bearer ${ JWT }` },
			} )
		).toEqual( { host: 'chatgpt-route', endpoint: 'models', bearer: 'jwt' } );
		expect(
			summarizeObservedRequest( 'https://auth.openai.com/oauth/token', { method: 'POST' } )
		).toEqual( { host: 'openai-auth', endpoint: 'other', bearer: 'none' } );
		expect(
			summarizeObservedRequest( 'https://public-api.wordpress.com/wpcom/v2/ai-api-proxy/v1/x' )
		).toMatchObject( { host: 'wpcom-ai-proxy', endpoint: 'other' } );
		// Studio's separate image service shares the proxy but is not inference.
		expect(
			summarizeObservedRequest(
				'https://public-api.wordpress.com/wpcom/v2/ai-api-proxy/v1/images/generations'
			)
		).toMatchObject( { host: 'wpcom-ai-proxy', endpoint: 'images' } );
		expect(
			summarizeObservedRequest( 'https://public-api.wordpress.com/rest/v1.1/v1/images/x' )
		).toMatchObject( { host: 'wpcom', endpoint: 'other' } );
		expect( summarizeObservedRequest( 'https://api.anthropic.com/v1/messages' ) ).toMatchObject( {
			host: 'anthropic',
		} );
		expect( summarizeObservedRequest( 'https://example.test/' ) ).toMatchObject( {
			host: 'other',
		} );
		expect( summarizeObservedRequest( 'not a url' ) ).toBeNull();
		expect(
			summarizeObservedRequest( 'https://api.openai.com/v1/responses', {
				headers: { authorization: `Bearer ${ JWT }` },
				body: responsesBody( { model: 'Secret Model With Spaces' } ),
			} )
		).toMatchObject( { model: 'unrecognized' } );
	} );

	it( 'counts reasoning and function call items in a streamed reply, and how it ended', () => {
		const stream = [
			'event: response.output_item.done',
			`data: ${ JSON.stringify( {
				type: 'response.output_item.done',
				item: { type: 'reasoning', encrypted_content: 'x' },
			} ) }`,
			`data: ${ JSON.stringify( {
				type: 'response.output_item.done',
				item: { type: 'function_call' },
			} ) }`,
			`data: ${ JSON.stringify( { type: 'response.completed', response: {} } ) }`,
			'data: [DONE]',
		].join( '\n' );
		expect( summarizeResponseStream( stream, 200 ) ).toEqual( {
			status: 200,
			reasoningOutputs: 1,
			functionCallOutputs: 1,
			completed: true,
			failed: false,
		} );
		expect(
			summarizeResponseStream( `data: ${ JSON.stringify( { type: 'response.failed' } ) }`, 200 )
		).toMatchObject( { completed: false, failed: true } );
	} );

	describe( 'installed in a process', () => {
		let dir: string;

		beforeEach( () => {
			dir = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-acceptance-observer-' ) );
		} );

		afterEach( () => {
			fs.rmSync( dir, { recursive: true, force: true } );
		} );

		it( 'appends a request and a response line per fetch, and stops when removed', async () => {
			const file = path.join( dir, 'observed.ndjson' );
			const target = {
				fetch: async () =>
					new Response(
						`data: ${ JSON.stringify( { type: 'response.completed', response: {} } ) }\n\n`,
						{ status: 200, headers: { 'content-type': 'text/event-stream' } }
					),
			} as unknown as { fetch: typeof fetch };
			const remove = installAcceptanceObserver( file, target );
			const response = await target.fetch( 'https://api.openai.com/v1/responses', {
				method: 'POST',
				headers: { authorization: `Bearer ${ JWT }` },
				body: responsesBody(),
			} );
			expect( await response.text() ).toContain( 'response.completed' );
			await new Promise( ( resolve ) => setTimeout( resolve, 20 ) );
			const lines = readObservedLines( file );
			expect( lines ).toEqual( [
				expect.objectContaining( {
					kind: 'request',
					id: 1,
					host: 'chatgpt-route',
					model: 'gpt-6-luna',
				} ),
				expect.objectContaining( { kind: 'response', id: 1, status: 200, completed: true } ),
			] );
			const raw = fs.readFileSync( file, 'utf8' );
			for ( const secret of [ JWT, PROMPT, 'api.openai.com', 'https' ] ) {
				expect( raw ).not.toContain( secret );
			}
			remove();
			await target.fetch( 'https://api.openai.com/v1/models' );
			expect( readObservedLines( file ) ).toHaveLength( 2 );
		} );

		it( 'keeps only the answer of a bearer comparison it is given, for ChatGPT route requests alone', async () => {
			const file = path.join( dir, 'observed.ndjson' );
			const target = {
				fetch: async () => new Response( '{}', { status: 200 } ),
			} as unknown as { fetch: typeof fetch };
			const seen: Array< string | null > = [];
			const remove = installAcceptanceObserver( file, target, {
				bearerIdentity: ( authorization ) => {
					seen.push( authorization );
					return 'match';
				},
			} );
			await target.fetch( 'https://api.openai.com/v1/responses', {
				method: 'POST',
				headers: { authorization: `Bearer ${ JWT }` },
				body: responsesBody(),
			} );
			await target.fetch( 'https://api.openai.com/v1/responses', {
				method: 'POST',
				headers: { authorization: `Bearer ${ API_KEY }` },
				body: responsesBody(),
			} );
			await target.fetch( 'https://public-api.wordpress.com/rest/v1.1/me' );
			remove();
			expect( seen ).toEqual( [ `Bearer ${ JWT }` ] );
			const requests = readObservedLines( file ).filter( ( line ) => line.kind === 'request' );
			expect(
				requests.map( ( line ) => [ line.host, 'identity' in line ? line.identity : null ] )
			).toEqual( [
				[ 'chatgpt-route', 'match' ],
				[ 'openai-api', null ],
				[ 'wpcom', null ],
			] );
			const raw = fs.readFileSync( file, 'utf8' );
			for ( const secret of [ JWT, JWT.split( '.' )[ 1 ], API_KEY, 'user-1' ] ) {
				expect( raw ).not.toContain( secret );
			}
		} );

		it( 'records a failed fetch and passes its error on', async () => {
			const file = path.join( dir, 'observed.ndjson' );
			const target = {
				fetch: async () => {
					throw new TypeError( 'fetch failed' );
				},
			} as unknown as { fetch: typeof fetch };
			installAcceptanceObserver( file, target );
			await expect( target.fetch( 'https://api.openai.com/v1/models' ) ).rejects.toThrow(
				'fetch failed'
			);
			expect( readObservedLines( file ) ).toEqual( [
				expect.objectContaining( { kind: 'request', endpoint: 'models' } ),
				expect.objectContaining( { kind: 'response', status: null } ),
			] );
		} );
	} );
} );
