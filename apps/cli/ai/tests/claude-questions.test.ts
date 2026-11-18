import { askClaudeQuestions } from '@studio/agent/node/claude-code/questions';
import { SKIPPED_QUESTION } from '@studio/agent/protocol/tools';
import { afterEach, expect, it, vi } from 'vitest';
import { createClaudeQuestionRouter, getTerminalClaudeQuestionAsker } from '../claude-questions';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';

const { prompt } = vi.hoisted( () => ( { prompt: vi.fn() } ) );
vi.mock( 'node:readline/promises', () => ( {
	createInterface: () => ( { question: prompt, once: vi.fn(), close: vi.fn() } ),
} ) );
afterEach( () => vi.restoreAllMocks() );

const ids = { runId: 'run', turnId: 'turn', toolCallId: 'tool' };
const options = [
	{ label: 'A', description: 'First' },
	{ label: 'B', description: 'Second' },
];
const questions = [
	{ question: 'Choose', options },
	{ question: '__proto__', options },
];
const request = { ...ids, type: 'question.asked' as const, requestId: 'batch', questions };
const signal = new AbortController().signal;

it( 'accepts a complete, correlated reply once and keeps skips and typed answers in the journal', async () => {
	const router = createClaudeQuestionRouter( true );
	const journal: BackendTurnEvent[] = [];
	const replies = Object.fromEntries( [
		[ 'Choose', SKIPPED_QUESTION ],
		[ '__proto__', 'Write my own' ],
	] );
	const second = router.ask!( { ...request, requestId: 'second' }, signal );
	await expect(
		askClaudeQuestions( ids, questions, signal, router.ask!, ( event ) => {
			journal.push( event );
			if ( event.type !== 'question.asked' ) return;
			const reply = { ...event, answers: replies };
			router.answer( { ...reply, runId: 'other' } );
			router.answer( { ...reply, turnId: 'other' } );
			router.answer( { ...reply, requestId: 'other' } );
			router.answer( { ...reply, answers: { Choose: 'Partial' } } );
			router.answer( { ...reply, answers: { ...replies, extra: 'Unexpected' } } );
			router.answer( reply );
			router.answer( { ...reply, answers: { ...replies, Choose: 'Late' } } );
		} )
	).resolves.toEqual( replies );
	expect( journal ).toEqual( [
		{ ...request, requestId: expect.any( String ) },
		{
			type: 'question.resolved',
			...ids,
			requestId: journal[ 0 ].type === 'question.asked' && journal[ 0 ].requestId,
			answers: replies,
		},
	] );
	const aborted = expect( second ).rejects.toMatchObject( { name: 'AbortError' } );
	router.cancelAll();
	await aborted;
} );

it( 'finishes publishing the preview before resolving a Stop, even if a host never answers', async () => {
	const stop = new AbortController();
	let release!: () => void;
	const published = new Promise< void >( ( resolve ) => {
		release = resolve;
	} );
	const presented = vi.fn();
	const events: string[] = [];
	const pending = askClaudeQuestions(
		ids,
		questions,
		stop.signal,
		() => new Promise( () => {} ),
		async ( event ) => {
			if ( event.type === 'question.asked' ) await published;
			events.push( event.type );
		},
		presented
	);
	stop.abort();
	await Promise.resolve();
	expect( events ).toEqual( [] );
	release();
	await expect( pending ).rejects.toMatchObject( { name: 'AbortError' } );
	expect( events ).toEqual( [ 'question.asked', 'question.resolved' ] );
	expect( presented ).toHaveBeenCalledOnce();
} );

it( 'exposes questions only with an answer channel and rejects ambiguous batches before asking', async () => {
	expect( createClaudeQuestionRouter( false ).ask ).toBeUndefined();
	const ask = vi.fn();
	const emit = vi.fn();
	await expect(
		askClaudeQuestions( ids, [ questions[ 0 ], questions[ 0 ] ], signal, ask, emit )
	).rejects.toThrow( 'distinct questions' );
	await expect(
		askClaudeQuestions(
			ids,
			[ { ...questions[ 0 ], options: [ options[ 0 ], options[ 0 ] ] } ],
			signal,
			ask,
			emit
		)
	).rejects.toThrow( 'distinct, nonempty options' );
	expect( ask ).not.toHaveBeenCalled();
	expect( emit ).not.toHaveBeenCalled();
} );

it( 'presents numbered options and preview paths on the terminal and accepts multi-select, typed and skipped replies', async () => {
	const streams = [ process.stdin, process.stderr ];
	const descriptors = streams.map( ( stream ) =>
		Object.getOwnPropertyDescriptor( stream, 'isTTY' )
	);
	try {
		for ( const stream of streams )
			Object.defineProperty( stream, 'isTTY', { configurable: true, value: true } );
		prompt
			.mockResolvedValueOnce( '2, 1' )
			.mockResolvedValueOnce( 'My idea' )
			.mockResolvedValueOnce( '' );
		const result = await getTerminalClaudeQuestionAsker()!(
			{
				...request,
				questions: [
					{
						question: 'Choose',
						multiSelect: true,
						options: [ { ...options[ 0 ], image: '/preview.png' }, options[ 1 ] ],
					},
					{ question: 'Type', options },
					{ question: 'Skip', options },
				],
			},
			signal
		);
		expect( result ).toEqual( { Choose: 'B, A', Type: 'My idea', Skip: SKIPPED_QUESTION } );
		expect( prompt.mock.calls[ 0 ][ 0 ] ).toContain( '/preview.png' );
	} finally {
		streams.forEach( ( stream, index ) => {
			const descriptor = descriptors[ index ];
			if ( descriptor ) Object.defineProperty( stream, 'isTTY', descriptor );
			else Reflect.deleteProperty( stream, 'isTTY' );
		} );
	}
} );
