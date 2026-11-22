import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { expect, it, vi } from 'vitest';
import { askClaudeQuestions } from '../questions';
import { createStudioClaudeToolBridge } from '../tool-bridge';
import { createPolicyFixture, guarded, targetOrigin } from './fixtures/execution-policy';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';

it( 'routes concurrent Studio questions to their own tool calls and dismisses the remaining request on Stop', async () => {
	const fixture = await createPolicyFixture();
	const events: BackendTurnEvent[] = [];
	const replies = new Map< string, ( value: Record< string, string > ) => void >();
	const turn = { runId: 'run', turnId: 'turn', policy: fixture.policy };
	const emit = ( event: BackendTurnEvent ) => {
		events.push( event );
	};
	const bridge = createStudioClaudeToolBridge( fixture.host, turn, emit, {
		ask: ( questions, signal, toolCallId, presented ) =>
			askClaudeQuestions(
				{ ...turn, toolCallId },
				questions,
				signal,
				( request ) =>
					new Promise( ( resolve ) => {
						replies.set( request.requestId, resolve );
					} ),
				emit,
				presented
			),
	} );
	const ask = () =>
		bridge.invoke( 'AskUserQuestion', {
			questions: [
				{
					question: 'Which page?',
					options: [
						{ label: 'Contact', description: 'Add a form.' },
						{ label: 'Gallery', description: 'Show photographs.' },
					],
				},
			],
		} );
	try {
		expect( await bridge.invoke( 'AskUserQuestion', { questions: [] } ) ).toMatchObject( {
			isError: true,
			content: [ { text: 'Ask between one and four distinct questions.' } ],
		} );
		expect( replies.size ).toBe( 0 );
		const calls = [ ask(), ask() ];
		await vi.waitFor( () => expect( replies.size ).toBe( 2 ) );
		const asked = events.filter( ( event ) => event.type === 'question.asked' );
		expect( new Set( asked.map( ( event ) => event.toolCallId ) ).size ).toBe( 2 );
		replies.get( asked[ 1 ].requestId )!( { 'Which page?': 'Gallery' } );
		await Promise.race( calls );
		fixture.controller.abort();
		const finished = await Promise.all( calls );
		expect( finished.filter( ( r ) => ! r.isError ) ).toEqual( [
			{ isError: false, content: [ { type: 'text', text: '{"Which page?":"Gallery"}' } ] },
		] );
		const resolved = events.filter( ( e ) => e.type === 'question.resolved' );
		expect( resolved ).toMatchObject( [
			{
				requestId: asked[ 1 ].requestId,
				toolCallId: asked[ 1 ].toolCallId,
				answers: { 'Which page?': 'Gallery' },
			},
			{ requestId: asked[ 0 ].requestId, toolCallId: asked[ 0 ].toolCallId, answers: null },
		] );
	} finally {
		fixture.controller.abort();
		await bridge.dispose();
		await fixture.cleanup();
	}
} );

it.skipIf( ! existsSync( chromium.executablePath() ) )(
	'presents a catalog draw through the guarded bridge, keeps its PNGs and redraws different layouts',
	async () => {
		const fixture = await createPolicyFixture( () => ( {
			navigationConfinement: guarded( targetOrigin ),
		} ) );
		const folder = path.join( fixture.parent, 'chat.screenshots' );
		await mkdir( folder );
		fixture.host.ui = { showArtifact: vi.fn(), reloadPreview: vi.fn() };
		fixture.host.screenshotsDirectory = () => folder;
		const turn = { runId: 'run', turnId: 'turn', policy: fixture.policy };
		const shown: string[] = [];
		const bridge = createStudioClaudeToolBridge( fixture.host, turn, () => {}, {
			ask: async ( questions, _signal, _id, onPresented ) => {
				onPresented?.();
				const question = questions[ 0 ];
				shown.push( ...question.options.flatMap( ( opt ) => ( opt.image ? [ opt.image ] : [] ) ) );
				return { [ question.question ]: 'Show other options' };
			},
		} );
		try {
			const draw = async () => {
				const result = await bridge.invoke( 'pick_design', { catalog: 'layouts', options: 2 } );
				expect( result.isError ).toBe( false );
				const labels = result.content.flatMap( ( part ) =>
					part.type === 'text'
						? Array.from(
								part.text.matchAll( /^Layout concept: (.+)$/gm ),
								( match ) => match[ 1 ]
						  )
						: []
				);
				expect( labels ).toHaveLength( 2 );
				return labels;
			};
			const labels = await draw();
			const result = await bridge.invoke( 'present_design_options', {
				question: 'Which layout?',
				catalog: 'layouts',
				options: labels.map( ( label ) => ( {
					label,
					description: label,
					preview: '<style>body{margin:0}main{height:100vh}</style><main>' + label + '</main>',
				} ) ),
			} );
			expect( result ).toMatchObject( {
				isError: false,
				content: [ { text: expect.stringContaining( 'Show other options' ) } ],
			} );
			expect( shown ).toHaveLength( 2 );
			for ( const image of shown ) {
				expect( path.dirname( image ) ).toBe( folder );
				const png = await readFile( image );
				expect( [ png.readUInt32BE( 16 ), png.readUInt32BE( 20 ) ] ).toEqual( [ 1200, 900 ] );
			}
			expect( ( await draw() ).filter( ( label ) => labels.includes( label ) ) ).toEqual( [] );
		} finally {
			await bridge.dispose();
			await fixture.cleanup();
		}
	},
	30_000
);
