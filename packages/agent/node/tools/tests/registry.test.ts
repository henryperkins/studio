import { afterEach, describe, expect, it } from 'vitest';
import { createFakeHost } from '../../tests/fake-host';
import { defineTool, READ_ONLY, type StudioToolDefinition } from '../define-tool';
import {
	resolveStudioToolDefinitions,
	resolveStudioTools,
	studioToolDefinitions,
	studioToolRegistry,
} from '../index';
import { runWpCliTool } from '../wp-cli';

const added: StudioToolDefinition[] = [];
afterEach( () => {
	for ( const definition of added.splice( 0 ) )
		studioToolDefinitions.splice( studioToolDefinitions.indexOf( definition ), 1 );
} );

const contract = ( name: string ) =>
	defineTool( name, 'A tool.', {}, async () => ( { content: [] } ), {
		annotations: READ_ONLY,
	} ) as StudioToolDefinition;

describe( 'the Studio tool registry', () => {
	it( 'refuses to resolve two tools of one name, so no definition can stand in for another', () => {
		const host = createFakeHost();
		const impostor = { ...runWpCliTool } as StudioToolDefinition;
		studioToolDefinitions.push( impostor );
		added.push( impostor );
		expect( () => resolveStudioToolDefinitions( host ) ).toThrow( 'wp_cli' );
		expect( () => resolveStudioTools( host ) ).toThrow( 'wp_cli' );
		studioToolDefinitions.splice( studioToolDefinitions.indexOf( impostor ), 1 );
		added.length = 0;
		expect( resolveStudioToolDefinitions( host ).map( ( tool ) => tool.name ) ).toContain(
			'wp_cli'
		);
	} );

	it( 'cannot be changed once the process runs, outside the test runner', () => {
		const one = contract( 'contract_one' );
		const two = contract( 'contract_two' );
		const fixed = studioToolRegistry( [ one ], false );
		expect( Object.isFrozen( fixed ) ).toBe( true );
		const attempts: Array< () => unknown > = [
			() => fixed.push( two ),
			() => fixed.unshift( two ),
			() => fixed.splice( 0, 1, two ),
			() => fixed.pop(),
			() => ( fixed.length = 0 ),
			() => {
				fixed[ 0 ] = two;
			},
		];
		for ( const attempt of attempts ) expect( attempt ).toThrow( TypeError );
		expect( fixed ).toEqual( [ one ] );
	} );

	it( 'lets a test add a tool of its own and take it out again', () => {
		const one = contract( 'contract_registered' );
		expect( Object.isFrozen( studioToolRegistry( [], true ) ) ).toBe( false );
		studioToolDefinitions.push( one );
		added.push( one );
		expect(
			resolveStudioToolDefinitions( createFakeHost() ).map( ( tool ) => tool.name )
		).toContain( 'contract_registered' );
	} );
} );
