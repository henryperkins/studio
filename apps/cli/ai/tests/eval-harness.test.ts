// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeHost, fakeSite } from '@studio/agent/node/tests/fake-host';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	evalHistoryMessages,
	findEvalFixturesDir,
	loadEvalAttachments,
	withMockedRemote,
	type RemoteCall,
} from 'cli/ai/eval-harness';

const repositoryFixtures = path.resolve( import.meta.dirname, '../../../../scripts/eval/fixtures' );

describe( 'eval harness', () => {
	let base: string;

	beforeEach( () => {
		base = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-eval-harness-' ) );
	} );

	afterEach( () => {
		fs.rmSync( base, { recursive: true, force: true, maxRetries: 5 } );
	} );

	describe( 'mocked remote operations', () => {
		it( 'records pushes, pulls and preview changes without ever reaching the real host', async () => {
			const host = createFakeHost( base );
			const real = [
				host.sync.push,
				host.sync.pull,
				host.previews.create,
				host.previews.update,
				host.previews.delete,
			];
			const calls: RemoteCall[] = [];
			const mocked = withMockedRemote( host, calls );
			const onProgress = vi.fn();

			const pushed = await mocked.sync.push(
				fakeSite,
				'all',
				'https://myprod.wordpress.com',
				onProgress
			);
			const pulled = await mocked.sync.pull( fakeSite, 'sqls', '111', onProgress );
			const created = await mocked.previews.create( fakeSite, onProgress );
			await mocked.previews.update( fakeSite, 'demo.wp.build', true, onProgress );
			await mocked.previews.delete( 'demo.wp.build', onProgress );

			for ( const fn of real ) {
				expect( fn ).not.toHaveBeenCalled();
			}
			expect( calls ).toEqual( [
				{
					operation: 'push',
					site: fakeSite.name,
					target: 'https://myprod.wordpress.com',
					options: 'all',
				},
				{ operation: 'pull', site: fakeSite.name, target: '111', options: 'sqls' },
				{ operation: 'preview-create', site: fakeSite.name },
				{ operation: 'preview-update', site: fakeSite.name, target: 'demo.wp.build' },
				{ operation: 'preview-delete', target: 'demo.wp.build' },
			] );
			expect( pushed?.url ).toBe( 'https://myprod.wordpress.com' );
			expect( pulled?.url ).toMatch( /\.invalid$/ );
			expect( created.url ).toMatch( /\.invalid$/ );
			// Local operations are the real host's.
			expect( mocked.sites ).toBe( host.sites );
			expect( mocked.previews.list ).toBe( host.previews.list );
		} );
	} );

	describe( 'attachments', () => {
		it( 'finds the repository fixtures, or the folder the environment names', () => {
			expect( findEvalFixturesDir( import.meta.dirname, {} ) ).toBe( repositoryFixtures );
			expect( findEvalFixturesDir( base, { STUDIO_EVAL_FIXTURES_DIR: base } ) ).toBe( base );
			expect( findEvalFixturesDir( os.tmpdir(), {} ) ).toBeNull();
		} );

		it( 'sends an image fixture as image input and a document by its absolute path', () => {
			const loaded = loadEvalAttachments(
				[ { fixture: 'red-swatch.png' }, { fixture: 'project-brief.md' } ],
				repositoryFixtures
			);
			if ( 'missing' in loaded ) {
				throw new Error( `missing ${ loaded.missing }` );
			}
			expect( loaded.images ).toHaveLength( 1 );
			expect( loaded.images[ 0 ] ).toMatchObject( {
				name: 'red-swatch.png',
				mimeType: 'image/png',
			} );
			expect(
				Buffer.from( loaded.images[ 0 ].dataBase64, 'base64' ).subarray( 1, 4 ).toString()
			).toBe( 'PNG' );
			expect( loaded.files ).toEqual( [
				expect.objectContaining( {
					name: 'project-brief.md',
					path: path.join( repositoryFixtures, 'project-brief.md' ),
				} ),
			] );
			expect( loaded.promptBlock ).toContain( path.join( repositoryFixtures, 'project-brief.md' ) );
			expect( loaded.summary ).toEqual( [
				{ fixture: 'red-swatch.png', kind: 'image' },
				{ fixture: 'project-brief.md', kind: 'file' },
			] );
		} );

		it( 'names a fixture that is missing instead of running without it', () => {
			expect( loadEvalAttachments( [ { fixture: 'nope.png' } ], repositoryFixtures ) ).toEqual( {
				missing: 'nope.png',
			} );
		} );
	} );

	describe( 'seeded history', () => {
		it( 'writes user and assistant messages as the route records them, with the context size a reply reported', () => {
			const [ user, assistant ] = evalHistoryMessages(
				[
					{ role: 'user', text: 'The codename is AURORA-7.' },
					{ role: 'assistant', text: 'Noted.', contextTokens: 190_000 },
				],
				{ provider: 'studio-chatgpt', api: 'openai-responses', model: 'gpt-6-luna' },
				1_000
			);
			expect( user ).toEqual( {
				role: 'user',
				content: [ { type: 'text', text: 'The codename is AURORA-7.' } ],
				timestamp: 1_000,
			} );
			expect( assistant ).toMatchObject( {
				role: 'assistant',
				content: [ { type: 'text', text: 'Noted.' } ],
				provider: 'studio-chatgpt',
				api: 'openai-responses',
				model: 'gpt-6-luna',
				stopReason: 'stop',
				usage: { input: 190_000, totalTokens: 190_000 },
				timestamp: 1_001,
			} );
		} );
	} );
} );
