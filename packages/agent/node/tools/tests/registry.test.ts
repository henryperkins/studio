import { describe, expect, it, vi } from 'vitest';
import { createFakeHost } from '../../tests/fake-host';
import { defineTool, READ_ONLY, type StudioToolDefinition } from '../define-tool';
import { resolveStudioToolDefinitions, resolveStudioTools, studioToolDefinitions } from '../index';
import { runWpCliTool } from '../wp-cli';

// The registry a process runs is frozen. This test, like every test that
// needs a tool of its own, runs against an extendable copy, which only the
// test runner's module mocking can give.
vi.mock( '../registry', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('../registry') >();
	return { ...actual, studioToolDefinitions: [ ...actual.studioToolDefinitions ] };
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
		try {
			expect( () => resolveStudioToolDefinitions( host ) ).toThrow( 'wp_cli' );
			expect( () => resolveStudioTools( host ) ).toThrow( 'wp_cli' );
		} finally {
			studioToolDefinitions.splice( studioToolDefinitions.indexOf( impostor ), 1 );
		}
		expect( resolveStudioToolDefinitions( host ).map( ( tool ) => tool.name ) ).toContain(
			'wp_cli'
		);
	} );

	it( 'is frozen as the process runs it, whatever the environment says', async () => {
		vi.stubEnv( 'VITEST', 'true' );
		try {
			const registry = await vi.importActual< typeof import('../registry') >( '../registry' );
			const fixed = registry.studioToolDefinitions;
			expect( Object.isFrozen( fixed ) ).toBe( true );
			const two = contract( 'contract_two' );
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
			expect( fixed.map( ( tool ) => tool.name ) ).not.toContain( 'contract_two' );
		} finally {
			vi.unstubAllEnvs();
		}
	} );

	it( 'lets a test add a tool of its own to its copy and take it out again', () => {
		const one = contract( 'contract_registered' );
		studioToolDefinitions.push( one );
		try {
			expect(
				resolveStudioToolDefinitions( createFakeHost() ).map( ( tool ) => tool.name )
			).toContain( 'contract_registered' );
		} finally {
			studioToolDefinitions.splice( studioToolDefinitions.indexOf( one ), 1 );
		}
	} );
} );
