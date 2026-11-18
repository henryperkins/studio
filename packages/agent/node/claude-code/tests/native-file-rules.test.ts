import { describe, expect, it } from 'vitest';
import { CLAUDE_NATIVE_TOOL_RULES, getClaudeNativePayloadRefusal } from '../execution-rules';

const calls: Array< [ string, Record< string, unknown > ] > = [
	[
		'Read',
		{ file_path: '/site/manual.pdf', offset: 0, limit: 20, pages: '3-22', allow_large: true },
	],
	[ 'Glob', { pattern: '**/*.{php,css}', path: '/site' } ],
	[
		'Grep',
		{
			pattern: '../text',
			path: '/site',
			glob: '*.php',
			type: 'php',
			output_mode: 'content',
			context: 2,
			'-B': 2,
			'-A': 0,
			'-C': 1,
			'-n': true,
			'-i': true,
			'-o': true,
			multiline: false,
			head_limit: 0,
			offset: 1,
		},
	],
	[ 'Write', { file_path: '/site/style.css', content: '' } ],
	[
		'Edit',
		{ file_path: '/site/style.css', old_string: 'old', new_string: '', replace_all: true },
	],
];

describe( 'native file tool inputs', () => {
	it.each( calls )( '%s accepts its SDK fields and refuses a new one', ( name, input ) => {
		const accepts = CLAUDE_NATIVE_TOOL_RULES.get( name )!.accepts!;
		expect( accepts( input ) ).toBe( true );
		expect( accepts( { ...input, symlink_target: '/another-file' } ) ).toBe( false );
	} );

	it.each( [
		[ 'Read', { file_path: '/site/file', offset: -1 } ],
		[ 'Read', { file_path: '/site/file', limit: 0.5 } ],
		[ 'Read', { file_path: '/site/file', allow_large: 1 } ],
		[ 'Read', { file_path: '/site/file', pages: 1 } ],
		[ 'Glob', {} ],
		[ 'Glob', { pattern: '../*.css' } ],
		[ 'Grep', { pattern: 'x', glob: [ '*.css' ] } ],
		[ 'Grep', { pattern: 'x', glob: '../*' } ],
		[ 'Grep', { pattern: 'x', type: '../file' } ],
		[ 'Grep', { pattern: 'x', '-A': -1 } ],
		[ 'Grep', { pattern: 'x', head_limit: 1.5 } ],
		[ 'Grep', { pattern: 'x', output_mode: 'files' } ],
		[ 'Grep', { pattern: 'x', multiline: 'true' } ],
		[ 'Write', { file_path: '/site/file' } ],
		[ 'Edit', { file_path: '/site/file', old_string: 'same', new_string: 'same' } ],
	] as const )( 'refuses malformed %s input %o', ( name, input ) => {
		expect( CLAUDE_NATIVE_TOOL_RULES.get( name )!.accepts!( input ) ).toBe( false );
	} );

	it( 'accepts a whole-file Read and a single PDF page', () => {
		const accepts = CLAUDE_NATIVE_TOOL_RULES.get( 'Read' )!.accepts!;
		expect( accepts( { file_path: '/site/file' } ) ).toBe( true );
		expect( accepts( { file_path: '/site/file.pdf', pages: '42' } ) ).toBe( true );
	} );

	it( 'applies the Studio payload limit to native Write content and both sides of an Edit', () => {
		const text = 'é'.repeat( 3500 );
		expect( getClaudeNativePayloadRefusal( 'Write', { content: text } ) ).toBeUndefined();
		expect( getClaudeNativePayloadRefusal( 'Write', { content: text.repeat( 3 ) } ) ).toMatch(
			/smaller/i
		);
		expect(
			getClaudeNativePayloadRefusal( 'Edit', { old_string: text, new_string: text + 'a' } )
		).toBeUndefined();
		expect(
			getClaudeNativePayloadRefusal( 'Edit', { old_string: text + text, new_string: text } )
		).toMatch( /smaller/i );
	} );
} );
