import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';
import { describe, expect, it } from 'vitest';
import {
	classifyOpenAiHttpError,
	classifyOpenAiStreamFailure,
	describeOpenAiError,
	redactOpenAiSecrets,
	type OpenAiErrorSummary,
} from '@studio/agent/protocol/openai-errors';
import type { AssistantMessage } from '@earendil-works/pi-ai';

const KEY = 'sk-proj-TESTONLYabcdefghijklmnopqrstuvwxyz0123456789';

const errorBody = ( code: string, message: string, type = 'invalid_request_error' ) => ( {
	error: { code, message, type, param: null },
} );

// pi decides whether to retry a turn from the assistant message's error text.
function isRetried( summary: OpenAiErrorSummary ): boolean {
	return isRetryableAssistantError( {
		stopReason: 'error',
		errorMessage: describeOpenAiError( summary ),
	} as AssistantMessage );
}

describe( 'classifyOpenAiHttpError', () => {
	it( 'treats 401 as an authentication failure and drops OpenAI’s text, which quotes the key', () => {
		const summary = classifyOpenAiHttpError(
			401,
			errorBody( 'invalid_api_key', `Incorrect API key provided: ${ KEY.slice( 0, 12 ) }…wxyz.` ),
			[ KEY ]
		);
		expect( summary ).toEqual( { kind: 'authentication', status: 401, code: 'invalid_api_key' } );
		expect( describeOpenAiError( summary ) ).not.toMatch( /sk-/ );
	} );

	it.each( [
		[ 403, errorBody( 'missing_scope', 'Missing scopes: api.model.read' ), 'permission' ],
		[ 404, errorBody( 'model_not_found', 'The model does not exist' ), 'model-unavailable' ],
		[ 400, errorBody( 'model_not_found', 'The model does not exist' ), 'model-unavailable' ],
		[ 400, errorBody( 'invalid_value', 'Unsupported value: reasoning.effort' ), 'invalid-request' ],
		[
			429,
			errorBody( 'insufficient_quota', 'You exceeded your current quota', 'insufficient_quota' ),
			'quota',
		],
		[ 429, errorBody( 'rate_limit_exceeded', 'Rate limit reached for requests' ), 'rate-limit' ],
		[ 500, errorBody( 'server_error', 'The server had an error' ), 'server' ],
		[ 503, {}, 'server' ],
	] as const )( 'classifies HTTP %s as %s', ( status, body, kind ) => {
		expect( classifyOpenAiHttpError( status, body ).kind ).toBe( kind );
	} );

	it( 'removes key-shaped text from OpenAI’s explanation', () => {
		const summary = classifyOpenAiHttpError(
			403,
			errorBody( 'forbidden', `Key ${ KEY } may not use this model. Bearer ${ KEY }` ),
			[ KEY ]
		);
		expect( summary.detail ).not.toContain( KEY );
		expect( summary.detail ).not.toMatch( /sk-proj/ );
		expect( describeOpenAiError( summary ) ).not.toContain( KEY );
	} );
} );

describe( 'classifyOpenAiStreamFailure', () => {
	it.each( [
		[ 'rate_limit_exceeded: Rate limit reached', 'rate-limit' ],
		[ 'Error Code insufficient_quota: You exceeded your current quota', 'quota' ],
		[ 'server_error: The server had an error', 'server' ],
		[ 'OpenAI Responses stream ended before a terminal response event', 'interrupted' ],
		[ 'something odd', 'unknown' ],
	] as const )( 'classifies “%s” as %s', ( message, kind ) => {
		expect( classifyOpenAiStreamFailure( message ).kind ).toBe( kind );
	} );
} );

describe( 'describeOpenAiError', () => {
	it.each( [ 'rate-limit', 'server', 'network', 'interrupted' ] as const )(
		'lets pi retry a %s failure',
		( kind ) => {
			expect( isRetried( { kind } ) ).toBe( true );
		}
	);

	it.each( [
		{ kind: 'authentication', status: 401, code: 'invalid_api_key' },
		{ kind: 'permission', status: 403 },
		{ kind: 'model-unavailable', status: 404, code: 'model_not_found' },
		{ kind: 'invalid-request', status: 400, code: 'invalid_value' },
		{ kind: 'quota', status: 429, code: 'insufficient_quota' },
		{ kind: 'quota', status: 429 },
	] satisfies OpenAiErrorSummary[] )( 'never retries a $kind failure', ( summary ) => {
		expect( isRetried( summary ) ).toBe( false );
	} );

	it( 'names the HTTP status and OpenAI code', () => {
		expect(
			describeOpenAiError( { kind: 'model-unavailable', status: 404, code: 'model_not_found' } )
		).toMatch( /\(HTTP 404, model_not_found\)/ );
	} );
} );

describe( 'redactOpenAiSecrets', () => {
	it( 'removes the given secret and anything shaped like a key', () => {
		expect( redactOpenAiSecrets( `a ${ KEY } b sk-abcd1234 c`, [ KEY ] ) ).toBe(
			'a [redacted] b [redacted] c'
		);
		expect( redactOpenAiSecrets( 'Authorization: Bearer abc.def-123' ) ).toBe(
			'Authorization: Bearer [redacted]'
		);
	} );
} );
