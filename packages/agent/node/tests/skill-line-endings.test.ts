import { parseDesignEntry } from '@studio/agent/node/design-catalog';
import { parseSkillContents } from '@studio/agent/node/skills';

const skillLf = [
	'---',
	'name: sample',
	'description: A sample skill',
	'user-invokable: true',
	'---',
	'',
	'# Sample',
	'',
	'Line one.',
	'Line two.',
	'',
].join( '\n' );

const entryLf = [
	'---',
	'title: Sample entry',
	'description: A sample entry',
	'---',
	'Build: something',
	'Fallback: something else',
	'',
].join( '\n' );

const toCrlf = ( text: string ) => text.replace( /\n/g, '\r\n' );
const toMixed = ( text: string ) =>
	text
		.split( '\n' )
		.map( ( line, index ) => line + ( index % 2 ? '\r' : '' ) )
		.join( '\n' );

describe( 'skill files with CRLF line endings', () => {
	it( 'parses a SKILL.md the same as with LF endings', () => {
		const expected = parseSkillContents( skillLf );
		expect( expected ).toEqual( {
			name: 'sample',
			description: 'A sample skill',
			body: '# Sample\n\nLine one.\nLine two.',
			userInvokable: true,
		} );
		expect( parseSkillContents( toCrlf( skillLf ) ) ).toEqual( expected );
		expect( parseSkillContents( toMixed( skillLf ) ) ).toEqual( expected );
	} );

	it( 'parses a design catalog entry the same as with LF endings', () => {
		const expected = parseDesignEntry( entryLf );
		expect( expected ).toEqual( {
			name: 'Sample entry',
			description: 'A sample entry',
			details: 'Build: something\nFallback: something else',
		} );
		expect( parseDesignEntry( toCrlf( entryLf ) ) ).toEqual( expected );
		expect( parseDesignEntry( toMixed( entryLf ) ) ).toEqual( expected );
	} );
} );
