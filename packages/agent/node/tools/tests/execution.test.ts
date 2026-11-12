import { Type } from 'typebox';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeHost } from '../../tests/fake-host';
import { bindTool, defineTool, READ_ONLY, type ToolResult } from '../define-tool';
import {
	checkToolArguments,
	completeToolResult,
	runStudioTool,
	type PendingWorkTracker,
} from '../execution';
import { resolveStudioTools, studioToolDefinitions } from '../index';
import type { StudioAgentUi } from '../../host';

const execution = vi.hoisted( () => ( { runs: [] as string[] } ) );
vi.mock( '../execution', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('../execution') >();
	return {
		...actual,
		runStudioTool: ( ...args: Parameters< typeof actual.runStudioTool > ) => {
			execution.runs.push( args[ 0 ].name );
			return actual.runStudioTool( ...args );
		},
	};
} );

afterEach( () => {
	vi.restoreAllMocks();
	execution.runs.length = 0;
} );

const host = createFakeHost();
const image = { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' };
const widget = { type: 'media' as const, widgetProps: { mediaKind: 'image' } };

function tool(
	handler: (
		args: { label: string; count?: number },
		onProgress: ( m: string ) => void
	) => unknown,
	settlesPendingWork = false
) {
	const definition = defineTool(
		'contract_tool',
		'A tool.',
		{ label: Type.String(), count: Type.Optional( Type.Number() ) },
		async ( args, context ) =>
			( await handler( args, ( message ) => context.onProgress( message ) ) ) as ToolResult,
		{ annotations: READ_ONLY, settlesPendingWork }
	);
	return bindTool( definition, host );
}

const text = ( value: string ) => ( { type: 'text' as const, text: value } );
const ok = () => ( { content: [ text( 'done' ) ] } );
const ui = () => ( {
	showArtifact: vi.fn< StudioAgentUi[ 'showArtifact' ] >(),
	reloadPreview: vi.fn< StudioAgentUi[ 'reloadPreview' ] >(),
} );

describe( 'checkToolArguments', () => {
	it( 'accepts arguments the canonical schema accepts and names at most three problems otherwise', () => {
		const { parameters } = tool( ok );
		expect( checkToolArguments( parameters, { label: 'a' } ) ).toBeUndefined();
		expect( checkToolArguments( parameters, { label: 'a', count: 2 } ) ).toBeUndefined();
		expect( checkToolArguments( parameters, { label: 7 } ) ).toEqual( [
			expect.stringMatching( /^\/label / ),
		] );
		expect( checkToolArguments( parameters, {} ) ).toEqual( [
			expect.stringMatching( /^arguments / ),
		] );
		expect( checkToolArguments( parameters, 'label' )?.length ).toBeGreaterThan( 0 );
		expect(
			checkToolArguments(
				Type.Object( { a: Type.String(), b: Type.String(), c: Type.String(), d: Type.String() } ),
				{
					a: 1,
					b: 2,
					c: 3,
					d: 4,
				}
			)
		).toHaveLength( 3 );
	} );
} );

describe( 'runStudioTool', () => {
	it( 'runs nothing for arguments the schema refuses, not even the runtime’s gate', async () => {
		const handler = vi.fn( ok );
		const authorize = vi.fn( async () => true );
		expect( await runStudioTool( tool( handler ), { label: 7 }, { authorize } ) ).toEqual( {
			status: 'invalid-arguments',
			problems: [ expect.stringMatching( /^\/label / ) ],
		} );
		expect( authorize ).not.toHaveBeenCalled();
		expect( handler ).not.toHaveBeenCalled();
		// A transport that validated the call already turns the check off.
		expect(
			( await runStudioTool( tool( handler ), { label: 7 }, { validate: false } ) ).status
		).toBe( 'completed' );
	} );

	it( 'asks the runtime’s gate once the arguments are valid, and runs nothing it refuses or that throws', async () => {
		const handler = vi.fn( ok );
		expect(
			await runStudioTool( tool( handler ), { label: 'a' }, { authorize: async () => false } )
		).toEqual( { status: 'refused' } );
		const broken = new Error( 'gate broke' );
		expect(
			await runStudioTool(
				tool( handler ),
				{ label: 'a' },
				{
					authorize: async () => {
						throw broken;
					},
				}
			)
		).toEqual( { status: 'failed', error: broken } );
		expect( handler ).not.toHaveBeenCalled();
	} );

	it( 'never starts a call cancelled before it starts, including while the gate decides', async () => {
		const handler = vi.fn( ok );
		const cancelled = new AbortController();
		cancelled.abort();
		const authorize = vi.fn( async () => true );
		expect(
			await runStudioTool(
				tool( handler ),
				{ label: 'a' },
				{ signal: cancelled.signal, authorize }
			)
		).toEqual( { status: 'cancelled' } );
		expect( authorize ).not.toHaveBeenCalled();

		const turn = new AbortController();
		expect(
			await runStudioTool(
				tool( handler ),
				{ label: 'a' },
				{
					signal: turn.signal,
					authorize: async () => {
						turn.abort();
						return true;
					},
				}
			)
		).toEqual( { status: 'cancelled' } );
		expect( handler ).not.toHaveBeenCalled();
	} );

	it( 'reports progress in order and returns the text and image blocks as the tool made them', async () => {
		const progress: Array< [ string, boolean | undefined ] > = [];
		const run = await runStudioTool(
			tool( ( _args, onProgress ) => {
				onProgress( 'one' );
				onProgress( 'two' );
				return { content: [ text( 'first' ), image ] };
			} ),
			{ label: 'a' },
			{ onProgress: ( message, update ) => void progress.push( [ message, update ] ) }
		);
		expect( progress ).toEqual( [
			[ 'one', undefined ],
			[ 'two', undefined ],
		] );
		expect( run ).toEqual( {
			status: 'completed',
			result: { content: [ text( 'first' ), image ] },
		} );
		// Without a progress callback, progress goes nowhere.
		expect(
			(
				await runStudioTool(
					tool( ( _args, onProgress ) => {
						onProgress( 'x' );
						return ok();
					} ),
					{ label: 'a' }
				)
			).status
		).toBe( 'completed' );
	} );

	it( 'shows a successful result’s artifacts once, nothing of a failed call, and survives a failed show', async () => {
		const shown = ui();
		await runStudioTool(
			tool( () => ( { ...ok(), studioArtifacts: [ widget ] } ) ),
			{ label: 'a' },
			{ ui: shown }
		);
		expect( shown.showArtifact ).toHaveBeenCalledTimes( 1 );
		expect( shown.showArtifact ).toHaveBeenCalledWith(
			expect.objectContaining( { widgets: [ widget ] } )
		);

		const failed = ui();
		const error = new Error( 'It broke at the site' );
		expect(
			await runStudioTool(
				tool( () => {
					throw error;
				} ),
				{ label: 'a' },
				{ ui: failed }
			)
		).toEqual( { status: 'failed', error } );
		expect( failed.showArtifact ).not.toHaveBeenCalled();

		const broken = ui();
		broken.showArtifact.mockRejectedValue( new Error( 'disk full' ) );
		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		const run = await runStudioTool(
			tool( () => ( { ...ok(), studioArtifacts: [ widget ] } ) ),
			{ label: 'a' },
			{ ui: broken }
		);
		expect( run.status ).toBe( 'completed' );
		expect( warn ).toHaveBeenCalledWith(
			'[chat-artifacts] failed to emit artifact for contract_tool:',
			expect.any( Error )
		);
	} );

	it( 'keeps a failure’s value for the runtime to word, whatever was thrown', async () => {
		expect(
			await runStudioTool(
				tool( () => {
					throw 'plain failure';
				} ),
				{ label: 'a' }
			)
		).toEqual( { status: 'failed', error: 'plain failure' } );
	} );

	it( 'without completion, hands the runtime the result with its pending work untouched', async () => {
		const pending = Promise.resolve( 'later' );
		const run = await runStudioTool(
			tool( () => ( { ...ok(), pending, _meta: { app: 1 } } ) ),
			{ label: 'a' }
		);
		expect( run ).toEqual( {
			status: 'completed',
			result: { content: [ text( 'done' ) ], pending, _meta: { app: 1 } },
		} );
	} );

	it( 'with completion and no tracker, waits for the work left running and reports it after the notes', async () => {
		const notes = vi.fn( async ( resultText: string ) => `noted: ${ resultText }` );
		const run = await runStudioTool(
			tool( () => ( {
				content: [ text( 'markup' ), image ],
				pending: Promise.resolve( 'finished later' ),
				_meta: { app: 1 },
				studioService: {
					service: 'wordpress-com',
					credential: 'environment-token',
					account: null,
				},
			} ) ),
			{ label: 'a' },
			{ completion: { notes } }
		);
		expect( notes ).toHaveBeenCalledWith( 'markup\n' );
		expect( run ).toEqual( {
			status: 'completed',
			result: {
				content: [ text( 'markup' ), image, text( 'noted: markup\n\nfinished later' ) ],
				_meta: { app: 1 },
				studioService: { service: 'wordpress-com', credential: 'environment-token', account: null },
			},
		} );
		expect( Object.keys( ( run as { result: object } ).result ) ).not.toContain( 'pending' );

		const failure = new Error( 'Generation failed.' );
		expect(
			await runStudioTool(
				tool( () => ( { ...ok(), pending: Promise.reject( failure ) } ) ),
				{ label: 'a' },
				{ completion: {} }
			)
		).toEqual( { status: 'failed', error: failure } );
	} );

	it( 'with a tracker, keeps the work for later results and settles it before a tool that renders the site', async () => {
		const tracker: PendingWorkTracker & { added: unknown[] } = {
			added: [],
			add: vi.fn( ( pending ) => void tracker.added.push( pending ) ),
			settle: vi.fn( async () => {} ),
			takeReports: vi.fn( () => 'earlier work finished' ),
		};
		const pending = new Promise< string | undefined >( () => {} );
		const run = await runStudioTool(
			tool( () => ( { ...ok(), pending } ) ),
			{ label: 'a' },
			{ completion: { pendingWork: tracker } }
		);
		expect( tracker.added ).toEqual( [ pending ] );
		expect( tracker.settle ).not.toHaveBeenCalled();
		expect( run ).toEqual( {
			status: 'completed',
			result: { content: [ text( 'done' ), text( 'earlier work finished' ) ] },
		} );

		const order: string[] = [];
		vi.mocked( tracker.settle ).mockImplementation( async () => void order.push( 'settled' ) );
		await runStudioTool(
			tool( () => {
				order.push( 'ran' );
				return ok();
			}, true ),
			{ label: 'a' },
			{ completion: { pendingWork: tracker } }
		);
		expect( order ).toEqual( [ 'settled', 'ran' ] );
	} );
} );

describe( 'completeToolResult', () => {
	it( 'returns the same content when there is nothing to add', async () => {
		const content = [ text( 'done' ) ];
		expect( await completeToolResult( content, undefined, {} ) ).toBe( content );
		expect(
			await completeToolResult( content, Promise.resolve( undefined ), { notes: () => '' } )
		).toBe( content );
	} );
} );

describe( 'the routes that run Studio tools', () => {
	it( 'runs every tool the Pi route registers from the registry through the shared execution', async () => {
		const definition = defineTool( 'contract_registered', 'A tool.', {}, async () => ok(), {
			annotations: READ_ONLY,
		} );
		studioToolDefinitions.push( definition );
		try {
			const registered = resolveStudioTools( createFakeHost() ).find(
				( candidate ) => candidate.name === 'contract_registered'
			)!;
			const result = await registered.execute( 'call', {} as never );
			expect( result.content ).toEqual( [ text( 'done' ) ] );
			expect( execution.runs ).toEqual( [ 'contract_registered' ] );
		} finally {
			studioToolDefinitions.splice( studioToolDefinitions.indexOf( definition ), 1 );
		}
	} );
} );
