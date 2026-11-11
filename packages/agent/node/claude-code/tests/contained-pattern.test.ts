import { createRequire } from 'module';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { isContainedPattern } from '../execution-rules';

const require = createRequire( import.meta.url );
const braces = require( 'braces' ) as {
	expand: ( pattern: string ) => string[];
};
const picomatch = require( 'picomatch' ) as {
	( pattern: string, options?: { dot?: boolean } ): ( file: string ) => boolean;
	scan: ( pattern: string ) => { base: string };
};

const accepted = [
	'*',
	'**',
	'**/*',
	'*.php',
	'**/*.php',
	'**/*.test.ts',
	'**/README.md',
	'.github/**/*.yml',
	'.env*',
	'**/.*rc',
	'.??*',
	'wp-content/themes/**/*.css',
	'wp-content/plugins/my_plugin-2/**',
	'src/?/x.ts',
	'a/b/c.txt',
	'./**/*.php',
	'**/*.{php,js}',
	'*.{min.js,map}',
	'{src,lib}/**/*.ts',
	'**/{functions,style}.{php,css}',
	'{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}',
];

const rejected: unknown[] = [
	// The reviewer's cases: an unbalanced or escaped closer ends a group early.
	'{x),/etc}/**',
	'@(x}|/etc)/**',
	'{x\\},/etc}/**',
	// Stepping up, directly or once braces expand.
	'..',
	'../**',
	'.../**',
	'a/../b',
	'wp-content/../../**',
	'{..,x}/**',
	'{a,..}/**',
	'.{.,x}/**',
	'{.,x}./**',
	'{a.,b}./**',
	'{1..3}/**',
	'{a..c}',
	// Absolute, home and Windows forms.
	'/',
	'/**',
	'/etc/**',
	'//server/share/**',
	// picomatch drops a leading './', which leaves these absolute.
	'.//**',
	'.//etc/passwd',
	'././/**',
	'a//b',
	// Engines that list '.' and '..' for a segment with a leading dot, as a
	// shell does, can match '..' with these.
	'.*',
	'.*/x',
	'.?/**',
	'.?*/*',
	'.*?/x',
	'a/.*/b',
	'{.*,x}/y',
	'~/**',
	'~root/**',
	'$HOME/**',
	'C:/**',
	'C:**',
	'c:\\x\\**',
	'C:\\Windows\\**',
	'\\**',
	'\\\\server\\share\\**',
	'\\\\?\\C:\\**',
	'**\\*.php',
	'{C:/Users,x}/**',
	'{C:\\Users,x}/**',
	'{\\\\server\\share,x}/**',
	'**/*.php:Zone.Identifier',
	// Groups that are nested, unbalanced, single, empty or hold a separator.
	'{/etc,x}/**',
	'{x,~/.ssh}/**',
	'a{b,{x,/etc}}/**',
	'{a,{b,c}}',
	'{a,b',
	'a,b}',
	'}a{',
	'{a}',
	'{}',
	'{,a}/**',
	'{a,}/**',
	'{a,,b}',
	'{a,b/c}/**',
	'{a,b\\c}',
	'{a,b:c}',
	// Extglobs, negation, alternation and character classes.
	'!**/*.php',
	'@(/etc)/**',
	'!(x)/**',
	'+(x|/etc)/**',
	'?(x)/**',
	'*(x)/**',
	'(a|b)/**',
	'a|b',
	'[/]etc/**',
	'[a-z]*.php',
	'**/[!.]*',
	// Escapes, whitespace, controls and characters outside the list.
	'%2e%2e/**',
	'**/*.php ',
	' **',
	'**/\t*',
	'**/*.php\u0000',
	'\uff0e\uff0e/**',
	'**/caf\u00e9*',
	'a#b',
	'a=b',
	'',
	'a'.repeat( 513 ),
	'{a,b}'.repeat( 9 ),
	42,
	null,
	[ '*' ],
];

describe( 'Claude file patterns', () => {
	it( 'accepts only patterns made of the allowlisted grammar', () => {
		for ( const pattern of accepted ) expect( isContainedPattern( pattern ), pattern ).toBe( true );
		for ( const pattern of rejected )
			expect( isContainedPattern( pattern ), JSON.stringify( pattern ) ).toBe( false );
	} );

	it( 'rejects the reviewer patterns that the glob libraries expand above the folder', () => {
		expect( braces.expand( '{x),/etc}/**' ) ).toContain( '/etc/**' );
		expect( picomatch( '@(x}|/etc)/**', { dot: true } )( '/etc/passwd' ) ).toBe( true );
		expect( braces.expand( '{x\\},/etc}/**' ) ).toContain( '/etc/**' );
		expect( picomatch( '{x\\},/etc}/**', { dot: true } )( '/etc/passwd' ) ).toBe( true );
		expect( braces.expand( '.{.,x}/**' ) ).toContain( '../**' );
		expect( picomatch.scan( './/**' ).base ).toBe( '/' );
		expect( picomatch( './/**', { dot: true } )( '/etc/passwd' ) ).toBe( true );
		for ( const pattern of [
			'{x),/etc}/**',
			'@(x}|/etc)/**',
			'{x\\},/etc}/**',
			'.{.,x}/**',
			'.//**',
		] )
			expect( isContainedPattern( pattern ), pattern ).toBe( false );
	} );

	it( 'expands every accepted pattern only to relative paths that never step up', () => {
		for ( const pattern of accepted ) {
			const expansions = braces.expand( pattern );
			expect( expansions.length, pattern ).toBeGreaterThan( 0 );
			for ( const expansion of expansions ) {
				const label = `${ pattern } -> ${ expansion }`;
				expect( path.posix.isAbsolute( expansion ), label ).toBe( false );
				expect( path.win32.isAbsolute( expansion ), label ).toBe( false );
				expect( expansion, label ).not.toMatch( /^[a-z]:|^~|\\/i );
				expect( expansion.split( '/' ), label ).not.toContain( '..' );
				expect( expansion, label ).not.toContain( '..' );
				const { base } = picomatch.scan( expansion );
				expect( path.posix.isAbsolute( base ) || base.split( '/' ).includes( '..' ), label ).toBe(
					false
				);
			}
		}
	} );
} );
