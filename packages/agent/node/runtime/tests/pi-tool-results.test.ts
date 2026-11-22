import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { runToolCall, type AgentTool, type AgentToolCall } from '@earendil-works/pi-agent-core';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from '@studio/agent/node/agent';
import { studioToolDefinitions } from '@studio/agent/node/tools';
import {
	defineTool,
	READ_ONLY,
	type StudioToolDefinition,
} from '@studio/agent/node/tools/define-tool';
import { createFakeHost } from '../../tests/fake-host';
import type { AgentSessionEvent, CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import type { StudioAgentHost } from '@studio/agent/node/host';
import type { SiteInfo } from '@studio/agent/node/types';

// The result contract of a Studio tool on the Pi route, pinned as the route
// runs it: the tools a real turn registers with pi, run through pi's own
// tool-call steps (argument preparation, schema validation, execution and
// error conversion). What the model sees is the result's `content`; `details`
// stays with the session and the UI.

const mocks = vi.hoisted( () => ( {
	createAgentSession: vi.fn(),
	configRoot: '',
} ) );

vi.mock( '@earendil-works/pi-coding-agent', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@earendil-works/pi-coding-agent') >() ),
	createAgentSession: mocks.createAgentSession,
} ) );

vi.mock( '@studio/common/lib/well-known-paths', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/common/lib/well-known-paths') >();
	return {
		...actual,
		getConfigDirectory: () => mocks.configRoot,
		getAiPayloadsPath: () => path.join( mocks.configRoot, 'tmp', 'ai-payloads' ),
	};
} );

vi.mock( '@studio/agent/node/image-generation', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/agent/node/image-generation') >() ),
	isImageGenerationAvailable: async () => false,
} ) );

vi.mock( '@studio/agent/node/global-instructions', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/agent/node/global-instructions') >() ),
	readGlobalInstructions: async () => undefined,
} ) );

// The registry is frozen; the contract tools are added to an extendable copy.
vi.mock( '@studio/agent/node/tools/registry', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/agent/node/tools/registry') >();
	return { ...actual, studioToolDefinitions: [ ...actual.studioToolDefinitions ] };
} );

const reply = {
	role: 'assistant',
	content: [ { type: 'text', text: 'Done.' } ],
	api: 'openai-completions',
	provider: 'studio-wpcom',
	model: 'fast',
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: 'stop',
	timestamp: 0,
} as const;

class FakeSession {
	private listener?: ( event: AgentSessionEvent ) => void;
	public state = { model: { id: 'fast', provider: 'studio-wpcom' }, messages: [] as unknown[] };

	subscribe( listener: ( event: AgentSessionEvent ) => void ): () => void {
		this.listener = listener;
		return () => {};
	}

	async prompt(): Promise< void > {
		for ( const event of [
			{ type: 'message_end', message: reply },
			{ type: 'agent_end', willRetry: false, messages: [ reply ] },
		] as unknown as AgentSessionEvent[] ) {
			this.listener?.( event );
		}
	}

	async sendCustomMessage(): Promise< void > {}
	async abort(): Promise< void > {}
	dispose(): void {}
}

// What each contract tool's handler was called with, in call order.
const calls: Array< { name: string; args: unknown } > = [];
const gates: { release?: () => void; background?: ReturnType< typeof deferred > } = {};

function deferred() {
	let resolve!: ( report: string | undefined ) => void;
	let reject!: ( error: unknown ) => void;
	const promise = new Promise< string | undefined >( ( settle, fail ) => {
		resolve = settle;
		reject = fail;
	} );
	return { promise, resolve, reject };
}

const serviceAccount = {
	service: 'wordpress-com' as const,
	credential: 'wordpress-com-login' as const,
	account: { displayName: 'Someone', email: 'someone@example.test' },
};
const artifactWidget = {
	type: 'media' as const,
	widgetProps: { mediaKind: 'image', src: 'file:///captures/home.png' },
};
const image = { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' };

const contractTools = [
	defineTool(
		'contract_echo',
		'Echoes its arguments.',
		{ label: Type.String(), count: Type.Optional( Type.Number() ) },
		async ( args ) => {
			calls.push( { name: 'contract_echo', args } );
			return { content: [ { type: 'text', text: `echo ${ args.label }` } ] };
		},
		{ annotations: READ_ONLY }
	),
	defineTool(
		'contract_rich',
		'Returns text, an image, an artifact, MCP App data and the service it used.',
		{},
		async ( args, context ) => {
			calls.push( { name: 'contract_rich', args } );
			context.onProgress( 'Working' );
			context.onProgress( 'Still working', true );
			return {
				content: [ { type: 'text', text: 'first' }, image ],
				_meta: { app: 'secret-meta' },
				studioArtifacts: [ artifactWidget ],
				studioService: serviceAccount,
			};
		},
		{ annotations: READ_ONLY }
	),
	defineTool(
		'contract_fail',
		'Fails after reporting progress.',
		{ plain: Type.Optional( Type.Boolean() ) },
		async ( args, context ) => {
			calls.push( { name: 'contract_fail', args } );
			context.onProgress( 'Trying' );
			if ( args.plain ) {
				throw 'plain failure';
			}
			throw new Error( 'It broke at the site' );
		},
		{ annotations: READ_ONLY }
	),
	defineTool(
		'contract_background',
		'Leaves work running.',
		{},
		async ( args ) => {
			calls.push( { name: 'contract_background', args } );
			gates.background = deferred();
			return {
				content: [ { type: 'text', text: 'started' } ],
				pending: gates.background.promise,
			};
		},
		{ annotations: READ_ONLY }
	),
	defineTool(
		'contract_settles',
		'Runs once earlier work has settled.',
		{},
		async ( args ) => {
			calls.push( { name: 'contract_settles', args } );
			return { content: [ { type: 'text', text: 'settled' } ] };
		},
		{ annotations: READ_ONLY, settlesPendingWork: true }
	),
	defineTool(
		'contract_slow',
		'Waits until released.',
		{},
		async ( args ) => {
			calls.push( { name: 'contract_slow', args } );
			await new Promise< void >( ( resolve ) => {
				gates.release = resolve;
			} );
			return { content: [ { type: 'text', text: 'finished' } ] };
		},
		{ annotations: READ_ONLY }
	),
	defineTool(
		'contract_markup',
		'Returns block markup.',
		{ nameOrPath: Type.Optional( Type.String() ) },
		async ( args ) => {
			calls.push( { name: 'contract_markup', args } );
			return { content: [ { type: 'text', text: '<!-- wp:navigation /-->' } ] };
		},
		{ annotations: READ_ONLY }
	),
] as StudioToolDefinition[];

let root: string;
let host: StudioAgentHost;
let session: SessionManager;
let tools: AgentTool[];

// Starts a turn, as Studio Code does, and keeps the tools it registered with pi.
async function startTurn( activeSite?: SiteInfo ) {
	mocks.createAgentSession.mockClear();
	session = SessionManager.inMemory( root );
	await createAgent( { host } ).runTurn( {
		prompt: 'Use the tools.',
		model: 'fast',
		env: { STUDIO_WPCOM_API_KEY: 'token', STUDIO_WPCOM_BASE_URL: 'https://proxy.example/v1' },
		session,
		activeSite,
		onEvent: () => {},
	} ).result;
	const options = mocks.createAgentSession.mock.calls[ 0 ][ 0 ] as CreateAgentSessionOptions;
	tools = ( options.customTools ?? [] ) as unknown as AgentTool[];
}

let callIds = 0;
// One tool call, run by pi exactly as it runs a call the model made.
function call(
	name: string,
	args: Record< string, unknown > = {},
	options: { signal?: AbortSignal; onUpdate?: ( partial: unknown ) => void } = {}
) {
	return runToolCall(
		{ type: 'toolCall', id: `call-${ ++callIds }`, name, arguments: args } as AgentToolCall,
		{
			tools,
			assistantMessage: reply as never,
			context: { messages: [] },
			signal: options.signal,
			onUpdate: options.onUpdate,
		}
	);
}

const callsOf = ( name: string ) => calls.filter( ( item ) => item.name === name );

beforeEach( async () => {
	root = await mkdtemp( path.join( os.tmpdir(), 'studio-pi-tool-results-' ) );
	mocks.configRoot = path.join( root, 'config' );
	host = createFakeHost( path.join( root, 'sites' ) );
	calls.length = 0;
	delete gates.release;
	delete gates.background;
	mocks.createAgentSession.mockImplementation( async () => ( {
		session: new FakeSession(),
		extensionsResult: { extensions: [], errors: [], runtime: {} },
	} ) );
	studioToolDefinitions.push( ...contractTools );
} );

afterEach( async () => {
	for ( const tool of contractTools )
		studioToolDefinitions.splice( studioToolDefinitions.indexOf( tool ), 1 );
	vi.restoreAllMocks();
	await rm( root, { recursive: true, force: true } );
} );

describe( 'Studio tool results on the Pi route', () => {
	it( 'runs a call with only the arguments pi validated, coerced as pi coerces them', async () => {
		await startTurn();
		const plain = await call( 'contract_echo', { label: 'a' } );
		expect( plain.isError ).toBe( false );
		expect( plain.result.content ).toEqual( [ { type: 'text', text: 'echo a' } ] );
		await call( 'contract_echo', { label: 'b', count: '3' } );
		await call( 'contract_echo', { label: 'c', count: null } );
		await call( 'contract_echo', { label: 7 } );
		expect( callsOf( 'contract_echo' ).map( ( item ) => item.args ) ).toEqual( [
			{ label: 'a' },
			{ label: 'b', count: 3 },
			{ label: 'c' },
			{ label: '7' },
		] );
	} );

	it( 'refuses a schema-invalid call before the tool runs, with pi’s validation message', async () => {
		await startTurn();
		for ( const args of [ {}, { label: 'a', count: 'many' }, { label: { text: 'a' } } ] ) {
			const outcome = await call( 'contract_echo', args );
			expect( outcome.isError ).toBe( true );
			expect( outcome.result.content ).toEqual( [
				{
					type: 'text',
					text: expect.stringMatching( /^Validation failed for tool "contract_echo"/ ),
				},
			] );
		}
		expect( callsOf( 'contract_echo' ) ).toEqual( [] );
	} );

	it( 'gives the model the text and image blocks in order, and keeps MCP App data, the service account and artifacts out of them', async () => {
		await startTurn();
		const outcome = await call( 'contract_rich' );
		expect( outcome.isError ).toBe( false );
		expect( outcome.result.content ).toEqual( [ { type: 'text', text: 'first' }, image ] );
		expect( JSON.stringify( outcome.result.content ) ).not.toMatch(
			/secret-meta|someone@example|captures/
		);
		// The session and the UI keep the artifacts; MCP App data is dropped, and so
		// is the service, which only the ChatGPT route keeps.
		expect( outcome.result.details ).toEqual( {
			studioArtifacts: [ artifactWidget ],
		} );
		expect( Object.keys( outcome.result.details as object ) ).not.toContain( '_meta' );
		expect( JSON.stringify( outcome.result.details ) ).not.toContain( 'secret-meta' );
	} );

	it( 'shows the artifacts in the conversation when a Studio UI is attached, and a failed show does not fail the call', async () => {
		const ui = { showArtifact: vi.fn(), reloadPreview: vi.fn() };
		host.ui = ui;
		await startTurn();
		await call( 'contract_rich' );
		expect( ui.showArtifact ).toHaveBeenCalledTimes( 1 );
		expect( ui.showArtifact ).toHaveBeenCalledWith( {
			version: expect.any( Number ),
			id: expect.any( String ),
			widgets: [ artifactWidget ],
		} );

		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		ui.showArtifact.mockImplementation( () => {
			throw new Error( 'disk full' );
		} );
		const outcome = await call( 'contract_rich' );
		expect( outcome.isError ).toBe( false );
		expect( outcome.result.content ).toEqual( [ { type: 'text', text: 'first' }, image ] );
		expect( warn ).toHaveBeenCalledWith(
			expect.stringContaining( '[chat-artifacts] failed to emit artifact for contract_rich' ),
			expect.any( Error )
		);
	} );

	it( 'reports progress as tool updates that carry only the message', async () => {
		await startTurn();
		const updates: unknown[] = [];
		await call( 'contract_rich', {}, { onUpdate: ( partial ) => void updates.push( partial ) } );
		expect( updates ).toEqual( [
			{ content: [], details: { studioProgress: { message: 'Working', update: undefined } } },
			{ content: [], details: { studioProgress: { message: 'Still working', update: true } } },
		] );
	} );

	it( 'fails safely: the model sees the message the tool threw, and nothing the call produced reaches the conversation', async () => {
		const ui = { showArtifact: vi.fn(), reloadPreview: vi.fn() };
		host.ui = ui;
		await startTurn();
		const updates: unknown[] = [];
		const failed = await call(
			'contract_fail',
			{},
			{ onUpdate: ( partial ) => void updates.push( partial ) }
		);
		expect( failed.isError ).toBe( true );
		expect( failed.result ).toEqual( {
			content: [ { type: 'text', text: 'It broke at the site' } ],
			details: {},
		} );
		// Progress reported before the failure still reaches the UI.
		expect( updates ).toEqual( [
			{ content: [], details: { studioProgress: { message: 'Trying', update: undefined } } },
		] );
		const plain = await call( 'contract_fail', { plain: true } );
		expect( plain.isError ).toBe( true );
		expect( plain.result.content ).toEqual( [ { type: 'text', text: 'plain failure' } ] );
		expect( ui.showArtifact ).not.toHaveBeenCalled();
	} );

	it( 'does not start a call cancelled before it runs, and finishes one cancelled while it runs', async () => {
		await startTurn();
		const cancelled = new AbortController();
		cancelled.abort();
		const notStarted = await call( 'contract_slow', {}, { signal: cancelled.signal } );
		expect( notStarted.isError ).toBe( true );
		expect( notStarted.result.content ).toEqual( [ { type: 'text', text: 'Operation aborted' } ] );
		expect( callsOf( 'contract_slow' ) ).toEqual( [] );

		const turn = new AbortController();
		const running = call( 'contract_slow', {}, { signal: turn.signal } );
		await vi.waitFor( () => expect( gates.release ).toBeDefined() );
		turn.abort();
		gates.release!();
		const finished = await running;
		expect( finished.isError ).toBe( false );
		expect( finished.result.content ).toEqual( [ { type: 'text', text: 'finished' } ] );
	} );

	it( 'keeps work a tool leaves running, reports it with a later result, and runs a tool that settles pending work only after it', async () => {
		await startTurn();
		const started = await call( 'contract_background' );
		expect( started.result.content ).toEqual( [ { type: 'text', text: 'started' } ] );
		expect( started.result.details ).toEqual( {} );
		expect( Object.keys( started.result.details as object ) ).not.toContain( 'pending' );

		// A tool that does not settle pending work runs at once and reports nothing yet.
		const meanwhile = await call( 'contract_echo', { label: 'x' } );
		expect( meanwhile.result.content ).toEqual( [ { type: 'text', text: 'echo x' } ] );

		const settling = call( 'contract_settles' );
		await new Promise( ( resolve ) => setTimeout( resolve, 20 ) );
		expect( callsOf( 'contract_settles' ) ).toEqual( [] );
		gates.background!.resolve( 'background done' );
		const settled = await settling;
		expect( settled.result.content ).toEqual( [
			{ type: 'text', text: 'settled' },
			{ type: 'text', text: 'background done' },
		] );

		// Work that fails is reported by its message, with the next result.
		await call( 'contract_background' );
		gates.background!.reject( new Error( 'generation failed' ) );
		await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
		const next = await call( 'contract_echo', { label: 'y' } );
		expect( next.result.content ).toEqual( [
			{ type: 'text', text: 'echo y' },
			{ type: 'text', text: 'generation failed' },
		] );
	} );

	it( 'adds, once per turn, what the local site declares about the core blocks a result shows', async () => {
		const sitePath = path.join( root, 'sites', 'my-site' );
		const blocks = path.join( sitePath, 'wp-includes', 'blocks', 'navigation' );
		await mkdir( blocks, { recursive: true } );
		await writeFile(
			path.join( blocks, 'block.json' ),
			JSON.stringify( { attributes: { overlayMenu: { enum: [ 'never', 'always' ] } } } )
		);
		await startTurn( { id: 'site-123', name: 'My Site', path: sitePath, running: true } );
		const first = await call( 'contract_markup' );
		expect( first.result.content ).toEqual( [
			{ type: 'text', text: '<!-- wp:navigation /-->' },
			{
				type: 'text',
				text: expect.stringMatching( /^core\/navigation settings, declared in .*: overlayMenu/ ),
			},
		] );
		const again = await call( 'contract_markup' );
		expect( again.result.content ).toEqual( [ { type: 'text', text: '<!-- wp:navigation /-->' } ] );
	} );
} );
