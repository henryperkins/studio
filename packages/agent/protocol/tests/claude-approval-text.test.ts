import { describe, expect, it } from 'vitest';
import { escapeClaudeApprovalText } from '../claude-code';

describe( 'text shown in a Claude approval', () => {
	it( 'exposes invisible text, including supplementary tag characters, with JSON escapes', () => {
		const tag = '\u{e0068}\u{e0069}';
		const value = 'one\u200b\u2060\ufeff\u00ad\u202e' + tag + 'two';
		const shown = 'one\\u200b\\u2060\\ufeff\\u00ad\\u202e\\udb40\\udc68\\udb40\\udc69two';
		expect( escapeClaudeApprovalText( value ) ).toBe( shown );
		expect( escapeClaudeApprovalText( shown ) ).toBe( shown );
		const args = escapeClaudeApprovalText( JSON.stringify( { message: value } ) );
		expect( args ).not.toContain( tag );
		expect( escapeClaudeApprovalText( JSON.parse( args ).message ) ).toBe( shown );
	} );

	it( 'preserves normal script joins and emoji presentation and reveals longer invisible runs', () => {
		const natural = 'می\u200cروم 👩\u200d💻 ✈\ufe0f ☕\ufe0e\n\t';
		expect( escapeClaudeApprovalText( natural ) ).toBe( natural );
		expect( escapeClaudeApprovalText( 'a\u200c\ufe0e\u200d\ufe0fb' ) ).toBe(
			'a\\u200c\\ufe0e\\u200d\\ufe0fb'
		);
		expect( escapeClaudeApprovalText( '\u200d\u200d\u200d' ) ).toBe( '\\u200d\\u200d\\u200d' );
		expect( escapeClaudeApprovalText( '\u180b\u{e0100}' ) ).toBe( '\\u180b\\udb40\\udd00' );
	} );
} );
