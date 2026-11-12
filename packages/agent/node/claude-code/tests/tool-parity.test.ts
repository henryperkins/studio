import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgent } from '../../agent';
import { createFakeHost } from '../../tests/fake-host';
import { studioToolDefinitions } from '../../tools';
import { createAskUserQuestionTool } from '../../tools/ask-user-question';
import { createPresentDesignOptionsTool } from '../../tools/present-design-options';
import { createSkillTool } from '../../tools/skill';
import {
	CLAUDE_ENABLED_TOOLS,
	CLAUDE_NATIVE_TOOL_RULES,
	CLAUDE_NAVIGATION_CONFINEMENT,
	CLAUDE_SHELL_CONFINEMENT,
	CLAUDE_STUDIO_TOOL_RULES,
	claudeNativeTools,
	claudeStudioTools,
	isQualifiedStudioRule,
} from '../execution-rules';
import { createStudioClaudeMcpServer, createStudioClaudeToolBridge } from '../tool-bridge';
import { createPolicyFixture, targetOrigin } from './fixtures/execution-policy';
import type {
	AgentSessionEvent,
	CreateAgentSessionOptions,
	ToolDefinition,
} from '@earendil-works/pi-coding-agent';

// The contract between the Pi route's tools and the Claude route's. The Pi
// route's registry is read from what real Pi turns register, under every host
// capability that changes it; each tool there has exactly one status on the
// Claude route below, and that status must be what the Claude execution policy
// actually enables and what the Claude bridge actually lists.

type Step = 'C2a-2' | 'C2a-3' | 'C2b' | 'C2c';
type ClaudeStatus =
	// Bridged from the registry and qualified by the policy.
	| { status: 'bridged' }
	// Claude Code's own tool of that name stands for it, and the policy enables it.
	| { status: 'native'; native: string }
	// Bridged and qualified like `bridged`, but registered only for a host with
	// `capability`: neither route lists it without it, and Claude lists it in
	// exactly the scenarios where Pi does.
	| { status: 'absent'; capability: Capability }
	// Not enabled yet: why, and the step that qualifies it. `native` names the
	// Claude Code tool that would stand for it.
	| { status: 'unqualified'; step: Step; reason: string; native?: string };

const LOCAL = 'Local site operation; its channels are not declared and tested yet';
const REMOTE = 'Reaches WordPress.com or another service; its scope and approval are not bound yet';
const BROWSER = 'Drives a browser; needs the navigation guard (contract revision 2)';
const NATIVE = 'Native equivalent not qualified: argument and write-path adaptation';

const CLAUDE_TOOL_STATUS: Record< string, ClaudeStatus > = {
	wp_cli: { status: 'bridged' },
	site_create: {
		status: 'unqualified',
		step: 'C2a-2',
		reason: `${ LOCAL }; it changes the conversation's site (selectSite and its site preview), which nothing journals yet, so the guarded host refuses both (carry item 7)`,
	},
	site_info: { status: 'bridged' },
	site_start: { status: 'bridged' },
	site_stop: { status: 'bridged' },
	site_delete: { status: 'bridged' },
	site_import: { status: 'bridged' },
	site_export: { status: 'bridged' },
	scaffold_theme: { status: 'unqualified', step: 'C2a-2', reason: LOCAL },
	install_taxonomy_scripts: { status: 'bridged' },
	refresh_browser: { status: 'absent', capability: 'ui' },
	site_list: { status: 'unqualified', step: 'C2a-3', reason: REMOTE },
	site_connected_remote_sites: { status: 'unqualified', step: 'C2a-3', reason: REMOTE },
	wpcom_request: { status: 'unqualified', step: 'C2a-3', reason: REMOTE },
	preview_create: { status: 'unqualified', step: 'C2a-3', reason: REMOTE },
	preview_list: { status: 'unqualified', step: 'C2a-3', reason: REMOTE },
	preview_update: {
		status: 'unqualified',
		step: 'C2a-3',
		reason: `${ REMOTE }; preview hosts are not tied to the target (carry item 12)`,
	},
	preview_delete: {
		status: 'unqualified',
		step: 'C2a-3',
		reason: `${ REMOTE }; preview hosts are not tied to the target (carry item 12)`,
	},
	site_push: {
		status: 'unqualified',
		step: 'C2a-3',
		reason: `${ REMOTE }; the remote is not matched to the live target (carry item 12)`,
	},
	site_pull: {
		status: 'unqualified',
		step: 'C2a-3',
		reason: `${ REMOTE }; the remote is not matched to the live target (carry item 12)`,
	},
	send_feedback: { status: 'unqualified', step: 'C2a-3', reason: REMOTE },
	generate_images: {
		status: 'unqualified',
		step: 'C2a-3',
		reason:
			'Needs the image service as its own capability in the Claude turn, which does not resolve it yet, and runs `wp eval`, which the policy refuses (carry item 11)',
	},
	take_screenshot: { status: 'unqualified', step: 'C2b', reason: BROWSER },
	inspect_design: { status: 'unqualified', step: 'C2b', reason: BROWSER },
	validate_blocks: { status: 'unqualified', step: 'C2b', reason: BROWSER },
	need_for_speed: { status: 'unqualified', step: 'C2b', reason: BROWSER },
	rank_me_up: { status: 'unqualified', step: 'C2b', reason: BROWSER },
	open_annotation_browser: { status: 'unqualified', step: 'C2b', reason: BROWSER },
	AskUserQuestion: {
		status: 'unqualified',
		step: 'C2c',
		reason: 'The Claude route has no question channel yet',
	},
	present_design_options: {
		status: 'unqualified',
		step: 'C2c',
		reason: `Design choices need the question channel; ${ BROWSER }`,
	},
	pick_design: {
		status: 'unqualified',
		step: 'C2c',
		reason: 'Design choice; offers options to pick only with a question channel',
	},
	Skill: {
		status: 'unqualified',
		step: 'C2c',
		reason: 'Skills and their capability gates are not bridged yet',
	},
	Read: { status: 'native', native: 'Read' },
	Write: { status: 'unqualified', step: 'C2b', reason: NATIVE, native: 'Write' },
	Edit: { status: 'unqualified', step: 'C2b', reason: NATIVE, native: 'Edit' },
	Bash: {
		status: 'unqualified',
		step: 'C2b',
		reason: 'Needs a verified shell confinement',
		native: 'Bash',
	},
	Grep: { status: 'unqualified', step: 'C2b', reason: NATIVE, native: 'Grep' },
	Glob: { status: 'unqualified', step: 'C2b', reason: NATIVE, native: 'Glob' },
	Ls: { status: 'unqualified', step: 'C2b', reason: NATIVE, native: 'LS' },
};

// The host capabilities that change which tools a Pi turn registers.
type Capability = 'ui' | 'questions' | 'imageService';
const CAPABILITIES: readonly Capability[] = [ 'ui', 'questions', 'imageService' ];
type Scenario = Record< Capability, boolean >;
const SCENARIOS: Scenario[] = [ 0, 1, 2, 3, 4, 5, 6, 7 ].map( ( bits ) => ( {
	ui: Boolean( bits & 1 ),
	questions: Boolean( bits & 2 ),
	imageService: Boolean( bits & 4 ),
} ) );
const label = ( scenario: Scenario ) =>
	CAPABILITIES.filter( ( capability ) => scenario[ capability ] ).join( '+' ) || 'none';

const mocks = vi.hoisted( () => ( {
	createAgentSession: vi.fn(),
	configRoot: '',
	imageService: false,
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
	isImageGenerationAvailable: async () => mocks.imageService,
} ) );

vi.mock( '@studio/agent/node/global-instructions', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/agent/node/global-instructions') >() ),
	readGlobalInstructions: async () => undefined,
} ) );

// Records each call the shared execution runs; stubbed, it runs no tool, and a
// bound tool's own `execute`, which skips it, refuses to run.
const execution = vi.hoisted( () => ( { stub: false, runs: [] as string[] } ) );
vi.mock( '../../tools/execution', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('../../tools/execution') >();
	return {
		...actual,
		runStudioTool: async ( ...args: Parameters< typeof actual.runStudioTool > ) => {
			execution.runs.push( args[ 0 ].name );
			return execution.stub
				? { status: 'completed' as const, result: { content: [] } }
				: actual.runStudioTool( ...args );
		},
	};
} );
vi.mock( '../../tools/define-tool', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('../../tools/define-tool') >();
	return {
		...actual,
		bindTool: ( ...args: Parameters< typeof actual.bindTool > ) => {
			const bound = actual.bindTool( ...args );
			return {
				...bound,
				execute: ( ...call: Parameters< typeof bound.execute > ) =>
					execution.stub
						? Promise.reject( new Error( `${ bound.name } ran outside the shared execution` ) )
						: bound.execute( ...call ),
			};
		},
	};
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
};

class FakeSession {
	private listener?: ( event: AgentSessionEvent ) => void;
	public state = { model: { id: 'fast', provider: 'studio-wpcom' }, messages: [] as unknown[] };
	subscribe( listener: ( event: AgentSessionEvent ) => void ) {
		this.listener = listener;
		return () => {};
	}
	async prompt() {
		for ( const event of [
			{ type: 'message_end', message: reply },
			{ type: 'agent_end', willRetry: false, messages: [ reply ] },
		] as unknown as AgentSessionEvent[] )
			this.listener?.( event );
	}
	async sendCustomMessage() {}
	async abort() {}
	dispose() {}
}

let root: string;
const piRegistered = new Map< string, ToolDefinition[] >();
const piTools = new Map< string, string[] >();
const claudeTools = new Map< string, string[] >();

// The tools a real Pi turn registers for a host with these capabilities.
async function piToolsRegistered( scenario: Scenario ): Promise< ToolDefinition[] > {
	const host = createFakeHost( path.join( root, 'sites' ) );
	if ( scenario.ui ) host.ui = { showArtifact: vi.fn(), reloadPreview: vi.fn() };
	mocks.imageService = scenario.imageService;
	mocks.createAgentSession.mockClear();
	await createAgent( { host } ).runTurn( {
		prompt: 'List the tools.',
		model: 'fast',
		env: { STUDIO_WPCOM_API_KEY: 'token', STUDIO_WPCOM_BASE_URL: 'https://proxy.example/v1' },
		session: SessionManager.inMemory( root ),
		onAskUser: scenario.questions ? async () => ( {} ) : undefined,
		onEvent: () => {},
	} ).result;
	const options = mocks.createAgentSession.mock.calls[ 0 ][ 0 ] as CreateAgentSessionOptions;
	return options.customTools ?? [];
}

async function listed( server: ReturnType< typeof createStudioClaudeMcpServer > ) {
	const { Client } = await import( '@modelcontextprotocol/sdk/client/index.js' );
	// The SDK's wildcard export resolves at runtime, although the ESLint resolver misses it.
	// eslint-disable-next-line import-x/no-unresolved
	const { InMemoryTransport } = await import( '@modelcontextprotocol/sdk/inMemory.js' );
	const [ clientTransport, serverTransport ] = InMemoryTransport.createLinkedPair();
	const client = new Client( { name: 'studio-test', version: '1.0.0' } );
	await Promise.all( [
		server.instance.connect( serverTransport ),
		client.connect( clientTransport ),
	] );
	try {
		return ( await client.listTools() ).tools.map( ( item ) => item.name );
	} finally {
		await client.close();
	}
}

// The Studio tools the Claude bridge lists for a turn on a host with these
// capabilities, under this build's policy.
async function claudeToolNames( scenario: Scenario ): Promise< string[] > {
	const fixture = await createPolicyFixture();
	try {
		if ( scenario.ui ) fixture.host.ui = { showArtifact: vi.fn(), reloadPreview: vi.fn() };
		const bridge = createStudioClaudeToolBridge(
			fixture.host,
			{ runId: 'run', turnId: 'turn', policy: fixture.policy },
			() => {}
		);
		try {
			return await listed( bridge.server );
		} finally {
			await bridge.dispose();
		}
	} finally {
		await fixture.cleanup();
	}
}

beforeAll( async () => {
	root = await mkdtemp( path.join( os.tmpdir(), 'studio-tool-parity-' ) );
	mocks.configRoot = path.join( root, 'config' );
	mocks.createAgentSession.mockImplementation( async () => ( {
		session: new FakeSession(),
		extensionsResult: { extensions: [], errors: [], runtime: {} },
	} ) );
	for ( const scenario of SCENARIOS ) {
		const registered = await piToolsRegistered( scenario );
		piRegistered.set( label( scenario ), registered );
		piTools.set(
			label( scenario ),
			registered.map( ( tool ) => tool.name )
		);
		claudeTools.set( label( scenario ), await claudeToolNames( scenario ) );
	}
}, 60_000 );

afterAll( async () => {
	await rm( root, { recursive: true, force: true } );
} );

const registered = () => [ ...new Set( [ ...piTools.values() ].flat() ) ].sort();
const statuses = () => Object.entries( CLAUDE_TOOL_STATUS );
// Qualified and run through the bridge, wherever its host registers it.
const isBridged = ( status: ClaudeStatus ) =>
	status.status === 'bridged' || status.status === 'absent';
const enabledStudio = () =>
	claudeStudioTools( CLAUDE_ENABLED_TOOLS, CLAUDE_NAVIGATION_CONFINEMENT, targetOrigin );
const enabledNative = () =>
	claudeNativeTools( CLAUDE_ENABLED_TOOLS, CLAUDE_SHELL_CONFINEMENT, path.resolve( 'workspace' ) );

describe( 'Studio tools on the Claude route, against the Pi route’s registry', () => {
	it( 'reads the registry from real Pi turns, capability-dependent factories included', () => {
		const all = registered();
		// The registry and the factories that capabilities add.
		for ( const name of [
			...studioToolDefinitions.map( ( definition ) => definition.name ),
			createAskUserQuestionTool( async () => ( {} ) ).name,
			createPresentDesignOptionsTool().name,
			createSkillTool()!.name,
		] )
			expect( all, name ).toContain( name );
		// What changes with the host is seen changing.
		const has = ( scenario: string, name: string ) => piTools.get( scenario )!.includes( name );
		expect( has( 'none', 'refresh_browser' ) ).toBe( false );
		expect( has( 'ui', 'refresh_browser' ) ).toBe( true );
		expect( has( 'none', 'AskUserQuestion' ) ).toBe( false );
		expect( has( 'questions', 'AskUserQuestion' ) ).toBe( true );
		expect( has( 'questions', 'present_design_options' ) ).toBe( false );
		expect( has( 'ui+questions', 'present_design_options' ) ).toBe( true );
		expect( has( 'none', 'generate_images' ) ).toBe( false );
		expect( has( 'imageService', 'generate_images' ) ).toBe( true );
	} );

	it( 'gives every registered tool exactly one status, and no status to a tool the Pi route never registers', () => {
		expect( Object.keys( CLAUDE_TOOL_STATUS ).sort() ).toEqual( registered() );
		for ( const [ name, status ] of statuses() ) {
			if ( status.status === 'unqualified' ) {
				expect( status.reason.length, name ).toBeGreaterThan( 0 );
				expect( [ 'C2a-2', 'C2a-3', 'C2b', 'C2c' ], name ).toContain( status.step );
			}
		}
	} );

	it( 'marks qualified exactly what the execution policy enables, and nothing it does not', () => {
		const studio = enabledStudio();
		const native = enabledNative();
		for ( const [ name, status ] of statuses() ) {
			const rule = CLAUDE_STUDIO_TOOL_RULES.get( name );
			switch ( status.status ) {
				case 'bridged':
				case 'absent':
					expect( studio, name ).toContain( name );
					expect( isQualifiedStudioRule( rule ), name ).toBe( true );
					break;
				case 'native':
					expect( CLAUDE_NATIVE_TOOL_RULES.has( status.native ), name ).toBe( true );
					expect( native, name ).toContain( status.native );
					break;
				default:
					expect( studio, name ).not.toContain( name );
					if ( rule ) expect( isQualifiedStudioRule( rule ), name ).toBe( false );
					if ( status.status === 'unqualified' && status.native ) {
						expect( CLAUDE_NATIVE_TOOL_RULES.has( status.native ), name ).toBe( true );
						expect( native, name ).not.toContain( status.native );
					}
			}
		}
		// Whatever the policy enables, the table marks as bridged, or as absent
		// without a host capability, which then decides where it is listed.
		const bridged = statuses()
			.filter( ( [ , status ] ) => isBridged( status ) )
			.map( ( [ name ] ) => name );
		const mapped = statuses().flatMap( ( [ , status ] ) =>
			status.status === 'native' ? [ status.native ] : []
		);
		expect( [ ...studio ].sort() ).toEqual( bridged.sort() );
		expect( [ ...native ].sort() ).toEqual( mapped.sort() );
	} );

	it.each( SCENARIOS.map( label ) )(
		'lists on the Claude bridge exactly the qualified tools the Pi route registers, with host capabilities: %s',
		( scenario ) => {
			const pi = piTools.get( scenario )!;
			const claude = claudeTools.get( scenario )!;
			const expected = pi.filter(
				( name ) => !! CLAUDE_TOOL_STATUS[ name ] && isBridged( CLAUDE_TOOL_STATUS[ name ] )
			);
			expect( claude ).toEqual( expected );
			// A tool Pi leaves out for the host's capabilities is left out here too.
			for ( const name of claude ) expect( pi, name ).toContain( name );
		}
	);

	it( 'keeps every tool marked absent out of both routes without its capability, and lists it on Claude exactly where Pi does', () => {
		for ( const [ name, status ] of statuses() ) {
			if ( status.status !== 'absent' ) continue;
			let listedWithCapability = false;
			for ( const scenario of SCENARIOS ) {
				const where = `${ name } (${ label( scenario ) })`;
				const onPi = piTools.get( label( scenario ) )!.includes( name );
				if ( ! scenario[ status.capability ] ) expect( onPi, where ).toBe( false );
				else listedWithCapability ||= onPi;
				expect( claudeTools.get( label( scenario ) )!.includes( name ), where ).toBe( onPi );
			}
			// The capability is what decides, so a host that has it gets the tool.
			expect( listedWithCapability, name ).toBe( true );
		}
	} );

	it( 'runs every Studio-defined tool a real Pi turn registers through the shared execution', async () => {
		const studioDefined = new Set( [
			...studioToolDefinitions.map( ( definition ) => definition.name ),
			createAskUserQuestionTool( async () => ( {} ) ).name,
			createPresentDesignOptionsTool().name,
			createSkillTool()!.name,
		] );
		// Anything else a Pi turn registers is one of pi's own file tools.
		const piFileTools = statuses().flatMap( ( [ name, status ] ) =>
			'native' in status && status.native ? [ name ] : []
		);
		expect( registered().filter( ( name ) => ! studioDefined.has( name ) ) ).toEqual(
			piFileTools.sort()
		);
		execution.stub = true;
		try {
			const ran = new Set< string >();
			for ( const scenario of SCENARIOS )
				for ( const tool of piRegistered.get( label( scenario ) )! ) {
					if ( ! studioDefined.has( tool.name ) ) continue;
					execution.runs.length = 0;
					await tool.execute(
						`call-${ tool.name }`,
						{} as never,
						undefined,
						undefined,
						{} as never
					);
					expect( execution.runs, `${ tool.name } (${ label( scenario ) })` ).toEqual( [
						tool.name,
					] );
					ran.add( tool.name );
				}
			expect( [ ...ran ].sort() ).toEqual( [ ...studioDefined ].sort() );
		} finally {
			execution.stub = false;
			execution.runs.length = 0;
		}
	} );

	it( 'can carry the canonical schema of every Studio-defined tool, once it is qualified', async () => {
		const skill = createSkillTool()!;
		const definitions = [
			...studioToolDefinitions,
			createAskUserQuestionTool( async () => ( {} ) ),
			createPresentDesignOptionsTool(),
			skill,
		];
		const server = createStudioClaudeMcpServer( definitions, async () => ( {
			content: [],
			isError: true,
		} ) );
		expect( ( await listed( server ) ).sort() ).toEqual(
			definitions.map( ( definition ) => definition.name ).sort()
		);
	} );
} );
