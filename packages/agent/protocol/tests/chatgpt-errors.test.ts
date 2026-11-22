import { describe, expect, it } from 'vitest';
import {
	classifyChatGptHttpError,
	classifyChatGptStreamEvent,
	describeChatGptError,
} from '@studio/agent/protocol/chatgpt-errors';

const TOKEN = 'sk-proj-TESTONLY_chatgpt_errors_aaaaaaaaaaaaaaaa';

describe( 'ChatGPT error reference fields', () => {
	it( 'bounds and sanitizes a token-shaped code and param before they are described', () => {
		const summary = classifyChatGptHttpError(
			400,
			{
				error: {
					code: `bad ${ TOKEN } ${ 'x'.repeat( 200 ) }`,
					param: `field/${ TOKEN }?${ 'y'.repeat( 200 ) }`,
					message: 'Rejected.',
				},
			},
			{ secrets: [ TOKEN ] }
		);

		expect( summary.code ).toBeDefined();
		expect( summary.param ).toBeDefined();
		expect( summary.code!.length ).toBeLessThanOrEqual( 64 );
		expect( summary.param!.length ).toBeLessThanOrEqual( 64 );
		expect( summary.code ).toMatch( /^[A-Za-z0-9._-]+$/ );
		expect( summary.param ).toMatch( /^[A-Za-z0-9._-]+$/ );
		const described = describeChatGptError( summary );
		expect( described ).not.toContain( TOKEN );
		expect( described.length ).toBeLessThan( 900 );
	} );

	it( 'bounds a token-shaped stream code the same way', () => {
		const summary = classifyChatGptStreamEvent( {
			type: 'error',
			error: { code: `bad ${ TOKEN }`, param: `p ${ TOKEN }`, message: 'Failed.' },
		} );

		expect( summary?.code ).toMatch( /^[A-Za-z0-9._-]+$/ );
		expect( summary?.param ).toMatch( /^[A-Za-z0-9._-]+$/ );
		expect( describeChatGptError( summary! ) ).not.toContain( TOKEN );
	} );
} );
