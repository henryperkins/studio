// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setChatGptToolImagesForLiveCheck } from '@studio/agent/node/chatgpt/tool-images';
import { sendsChatGptToolImages } from '@studio/agent/node/runtime/chatgpt-transport';

const repoRoot = path.resolve( import.meta.dirname, '..', '..', '..', '..', '..' );

describe( 'images in ChatGPT tool results', () => {
	afterEach( () => setChatGptToolImagesForLiveCheck( false ) );

	it( 'are off on the route until a live request shows it takes them', () => {
		expect( sendsChatGptToolImages( 'gpt-6-luna' ) ).toBe( false );
		expect( sendsChatGptToolImages( 'gpt-7-nova' ) ).toBe( false );
	} );

	it( 'are on, for a model that takes images at all, only while the live check’s override is', () => {
		setChatGptToolImagesForLiveCheck( true );
		expect( sendsChatGptToolImages( 'gpt-6-luna' ) ).toBe( true );
		expect( sendsChatGptToolImages( 'gpt-7-nova' ) ).toBe( false );

		setChatGptToolImagesForLiveCheck( false );
		expect( sendsChatGptToolImages( 'gpt-6-luna' ) ).toBe( false );
	} );
} );

describe( 'who may turn images in ChatGPT tool results on', () => {
	const SKIPPED = new Set( [ 'node_modules', 'dist', 'out', '.vite', 'coverage', 'vendor' ] );
	// Development-only code: the live check's preload in the acceptance runner's turn, and the eval runner.
	const ALLOWED = new Set( [
		'packages/agent/node/chatgpt/tool-images.ts',
		'apps/cli/ai/chatgpt-acceptance-tool-images.ts',
		'apps/cli/ai/eval-runner.ts',
	] );

	function sourceFiles( directory: string ): string[] {
		return fs.readdirSync( directory, { withFileTypes: true } ).flatMap( ( entry ) => {
			if ( entry.name.startsWith( '.' ) || SKIPPED.has( entry.name ) ) {
				return [];
			}
			const file = path.join( directory, entry.name );
			if ( entry.isDirectory() ) {
				return entry.name === 'tests' ? [] : sourceFiles( file );
			}
			return /\.(ts|tsx|mts|mjs|js|cjs)$/.test( entry.name ) && ! /\.test\./.test( entry.name )
				? [ file ]
				: [];
		} );
	}

	it( 'is called only by development-only code, is not part of a public entry point, and reads no environment', () => {
		const callers = [ 'apps', 'packages', 'scripts', 'tools' ]
			.flatMap( ( top ) => sourceFiles( path.join( repoRoot, top ) ) )
			.filter( ( file ) =>
				fs.readFileSync( file, 'utf8' ).includes( 'setChatGptToolImagesForLiveCheck' )
			)
			.map( ( file ) => path.relative( repoRoot, file ).split( path.sep ).join( '/' ) );
		expect( callers ).toContain( 'apps/cli/ai/chatgpt-acceptance-tool-images.ts' );
		expect( callers.filter( ( file ) => ! ALLOWED.has( file ) ) ).toEqual( [] );
		for ( const entry of [ 'packages/agent/node/index.ts', 'packages/agent/protocol' ] ) {
			const target = path.join( repoRoot, entry );
			const files = fs.statSync( target ).isDirectory() ? sourceFiles( target ) : [ target ];
			for ( const file of files ) {
				expect( fs.readFileSync( file, 'utf8' ) ).not.toMatch( /tool-images/ );
			}
		}
		for ( const file of [
			'packages/agent/node/chatgpt/tool-images.ts',
			'apps/cli/ai/chatgpt-acceptance-tool-images.ts',
		] ) {
			expect( fs.readFileSync( path.join( repoRoot, file ), 'utf8' ) ).not.toMatch(
				/process\.env|process\.argv/
			);
		}
	} );
} );
