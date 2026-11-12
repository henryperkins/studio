import { writeFile } from 'fs/promises';
import path from 'path';
import { Type } from 'typebox';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeHost } from '../../tests/fake-host';
import { studioToolDefinitions } from '../../tools';
import {
	defineTool,
	READ_ONLY,
	type StudioToolDefinition,
	type ToolContext,
} from '../../tools/define-tool';
import { runWpCliTool } from '../../tools/wp-cli';
import { createStudioClaudeDiscoveryServer, createStudioClaudeToolBridge } from '../tool-bridge';
import { createPolicyFixture } from './fixtures/execution-policy';
import type { StudioAgentHost } from '../../host';
import type { ClaudeApprover, ClaudeExecutionPolicy } from '../execution-policy';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';

// The registry a host resolves, which a test may change as only a test can:
// the bridge takes its tools from it and from nowhere else.
const registry = vi.hoisted( () => ( {
	change: undefined as
		| undefined
		| ( ( definitions: StudioToolDefinition[] ) => StudioToolDefinition[] ),
} ) );
vi.mock( '../../tools', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('../../tools') >();
	return {
		...actual,
		resolveStudioToolDefinitions: (
			...args: Parameters< typeof actual.resolveStudioToolDefinitions >
		) => {
			const resolved = actual.resolveStudioToolDefinitions( ...args );
			return registry.change ? registry.change( resolved ) : resolved;
		},
	};
} );

const cleanups: Array< () => Promise< void > > = [];
afterEach( async () => {
	vi.unstubAllEnvs();
	registry.change = undefined;
	await Promise.all( cleanups.splice( 0 ).map( ( cleanup ) => cleanup() ) );
} );
async function setup(
	approve: ClaudeApprover = vi.fn( async () => 'allow' as const ),
	stillConnected = vi.fn( async () => true ),
	onEvent: ( event: BackendTurnEvent ) => void = () => {},
	approvalTimeoutMs = 100
) {
	const fixture = await createPolicyFixture( () => ( {
		approve,
		stillConnected,
		approvalTimeoutMs,
	} ) );
	cleanups.push( fixture.cleanup );
	const bridge = createStudioClaudeToolBridge(
		fixture.host,
		{ runId: 'run', turnId: 'turn', policy: fixture.policy },
		onEvent
	);
	return { ...fixture, bridge, approve };
}
describe( 'Claude Studio tool boundary (mock host)', () => {
	it( 'runs canonical local read and denies other routes and invalid schema', async () => {
		const { host, bridge } = await setup();
		expect(
			( await bridge.invoke( 'wp_cli', { nameOrPath: 'site', command: 'option get blogname' } ) )
				.isError
		).not.toBe( true );
		for ( const command of [
			'post delete 1',
			'option get smtp_password',
			'option get blogname --url=https://example.com',
			'post create file.txt --post_status=draft',
			'post create --post_status=publish',
		] ) {
			expect( ( await bridge.invoke( 'wp_cli', { nameOrPath: 'site', command } ) ).isError ).toBe(
				true
			);
		}
		expect( ( await bridge.invoke( 'wp_cli', { nameOrPath: 'site', command: 1 } ) ).isError ).toBe(
			true
		);
		expect( host.sites.wpCli ).toHaveBeenCalledTimes( 1 );
	} );
	it( 'requires approval immediately before bounded draft creation and rejects cancellation', async () => {
		const denied = await setup( vi.fn( async () => 'deny' as const ) );
		const args = {
			nameOrPath: 'site',
			command: 'post create --post_status=draft --post_title=Hello',
		};
		expect( ( await denied.bridge.invoke( 'wp_cli', args ) ).isError ).toBe( true );
		expect( denied.host.sites.wpCli ).not.toHaveBeenCalled();
		const allowed = await setup();
		await allowed.bridge.invoke( 'wp_cli', args );
		expect( allowed.approve ).toHaveBeenCalledOnce();
		expect( allowed.host.sites.wpCli ).toHaveBeenCalledOnce();
		allowed.controller.abort();
		expect( ( await allowed.bridge.invoke( 'wp_cli', args ) ).isError ).toBe( true );
		expect( allowed.host.sites.wpCli ).toHaveBeenCalledOnce();
	} );
} );

it( 'blocks a local operation when an ancestor WP-CLI config can redirect it', async () => {
	const { host, bridge, parent } = await setup();
	await writeFile( path.join( parent, 'wp-cli.local.yml' ), 'ssh: remote.example.invalid\n' );
	expect(
		( await bridge.invoke( 'wp_cli', { nameOrPath: 'site', command: 'post list' } ) ).isError
	).toBe( true );
	expect( host.sites.wpCli ).not.toHaveBeenCalled();
} );

it( 'blocks WP-CLI environment overrides before reaching the host', async () => {
	vi.stubEnv( 'WP_CLI_CONFIG_PATH', 'override.yml' );
	const { host, bridge } = await setup();
	expect(
		( await bridge.invoke( 'wp_cli', { nameOrPath: 'site', command: 'post list' } ) ).isError
	).toBe( true );
	expect( host.sites.wpCli ).not.toHaveBeenCalled();
} );

it( 'expires a pending draft approval, rejects a late allow, and exposes the exact proposed arguments', async () => {
	let release!: ( value: 'allow' ) => void;
	const approve = vi.fn(
		( ..._args: Parameters< ClaudeApprover > ) =>
			new Promise< 'allow' >( ( resolve ) => {
				release = resolve;
			} )
	);
	const { bridge, host } = await setup( approve );
	const pending = bridge.invoke( 'wp_cli', {
		nameOrPath: 'site',
		command: 'post create --post_status=draft --post_title=Hello',
	} );
	await new Promise( ( resolve ) => setTimeout( resolve, 150 ) );
	expect( ( await pending ).isError ).toBe( true );
	release( 'allow' );
	await Promise.resolve();
	expect( host.sites.wpCli ).not.toHaveBeenCalled();
	expect( approve.mock.calls[ 0 ][ 0 ] ).toMatchObject( {
		operation: { args: [ 'post', 'create', '--post_status=draft', '--post_title=Hello' ] },
	} );
} );

it( 'does not mutate when the connection is detached after approval', async () => {
	const { bridge, host } = await setup(
		vi.fn( async () => 'allow' as const ),
		vi.fn( async () => false )
	);
	expect(
		(
			await bridge.invoke( 'wp_cli', {
				nameOrPath: 'site',
				command: 'post create --post_status=draft --post_title=Hello',
			} )
		).isError
	).toBe( true );
	expect( host.sites.wpCli ).not.toHaveBeenCalled();
} );

it( 'denies a host operation when cancellation arrives during the final connection check', async () => {
	const holder: { cancel?: () => void } = {};
	const { bridge, host, controller } = await setup(
		vi.fn( async () => 'allow' as const ),
		vi.fn( async () => {
			holder.cancel?.();
			return true;
		} )
	);
	holder.cancel = () => controller.abort();
	expect(
		(
			await bridge.invoke( 'wp_cli', {
				nameOrPath: 'site',
				command: 'post create --post_status=draft --post_title=Hello',
			} )
		).isError
	).toBe( true );
	expect( host.sites.wpCli ).not.toHaveBeenCalled();
} );

it( 'aborts a running host operation and waits for it to settle before disposing', async () => {
	const { bridge, host } = await setup();
	let toolStarted = false;
	let settleHost!: () => void;
	const onHostAbort = vi.fn();
	host.sites.wpCli = async ( _site, _args, options ) => {
		await options?.beforeSpawn?.();
		options?.signal?.addEventListener( 'abort', onHostAbort, { once: true } );
		await new Promise< void >( ( resolve ) => {
			settleHost = resolve;
			toolStarted = true;
		} );
		throw new Error( 'The child stopped' );
	};
	const running = bridge.invoke( 'wp_cli', { nameOrPath: 'site', command: 'post list' } );
	await vi.waitFor( () => expect( toolStarted ).toBe( true ) );
	let disposed = false;
	const disposing = bridge.dispose().then( () => {
		disposed = true;
	} );
	try {
		expect( onHostAbort ).toHaveBeenCalledOnce();
		await Promise.resolve();
		expect( disposed ).toBe( false );
	} finally {
		settleHost();
		await disposing;
	}
	expect( ( await running ).isError ).toBe( true );
} );

it( 'reports the lifecycle of a Studio tool invocation without exposing exception text', async () => {
	const events: BackendTurnEvent[] = [];
	const { host, bridge } = await setup(
		async () => 'deny',
		vi.fn( async () => true ),
		( event ) => events.push( event )
	);
	host.sites.wpCli = vi.fn( async () => {
		throw new Error( 'secret diagnostic' );
	} );
	const result = await bridge.invoke( 'wp_cli', {
		nameOrPath: 'site',
		command: 'option get blogname',
	} );
	expect( result.isError ).toBe( true );
	expect( JSON.stringify( events ) ).not.toContain( 'secret diagnostic' );
	expect( events.map( ( event ) => event.type ) ).toEqual( [ 'tool.started', 'tool.result' ] );
} );

it( 'exposes the canonical schema through the actual in-process SDK MCP server', async () => {
	const { Client } = await import( '@modelcontextprotocol/sdk/client/index.js' );
	// The SDK's wildcard export resolves at runtime, although the ESLint resolver misses it.
	// eslint-disable-next-line import-x/no-unresolved
	const { InMemoryTransport } = await import( '@modelcontextprotocol/sdk/inMemory.js' );
	const { bridge, host } = await setup();
	const [ clientTransport, serverTransport ] = InMemoryTransport.createLinkedPair();
	const client = new Client( { name: 'studio-test', version: '1.0.0' } );
	await Promise.all( [
		bridge.server.instance.connect( serverTransport ),
		client.connect( clientTransport ),
	] );
	try {
		const tools = await client.listTools();
		expect( tools.tools.map( ( item ) => item.name ) ).toEqual( [ 'wp_cli' ] );
		const result = await client.callTool( {
			name: 'wp_cli',
			arguments: { nameOrPath: 'site', command: 'option get blogname' },
		} );
		expect( result.isError ).not.toBe( true );
		expect( host.sites.wpCli ).toHaveBeenCalledOnce();
	} finally {
		await client.close();
		await bridge.dispose();
	}
} );

it( 'cancels a pending approval when the SDK cancels the MCP call', async () => {
	let approvalSignal: AbortSignal | undefined;
	const { bridge, host } = await setup(
		vi.fn( ( _request, signal: AbortSignal ) => {
			approvalSignal = signal;
			return new Promise< 'allow' >( () => {} );
		} ),
		vi.fn( async () => true ),
		() => {},
		60_000
	);
	const call = new AbortController();
	const pending = bridge.invoke(
		'wp_cli',
		{ nameOrPath: 'site', command: 'post create --post_status=draft --post_title=Hello' },
		call.signal
	);
	await vi.waitFor( () => expect( approvalSignal ).toBeDefined() );
	call.abort();
	expect( ( await pending ).isError ).toBe( true );
	expect( approvalSignal!.aborted ).toBe( true );
	expect( host.sites.wpCli ).not.toHaveBeenCalled();
} );

async function listedTools( bridge: ReturnType< typeof createStudioClaudeToolBridge > ) {
	const { Client } = await import( '@modelcontextprotocol/sdk/client/index.js' );
	// The SDK's wildcard export resolves at runtime, although the ESLint resolver misses it.
	// eslint-disable-next-line import-x/no-unresolved
	const { InMemoryTransport } = await import( '@modelcontextprotocol/sdk/inMemory.js' );
	const [ clientTransport, serverTransport ] = InMemoryTransport.createLinkedPair();
	const client = new Client( { name: 'studio-test', version: '1.0.0' } );
	await Promise.all( [
		bridge.server.instance.connect( serverTransport ),
		client.connect( clientTransport ),
	] );
	try {
		return ( await client.listTools() ).tools;
	} finally {
		await client.close();
	}
}

describe( 'the Claude bridge built from the Studio registry', () => {
	it( 'lists each tool the policy enables as the registry defines it: its name, description and canonical schema', async () => {
		const { bridge } = await setup();
		const tools = await listedTools( bridge );
		expect( tools.map( ( item ) => item.name ) ).toEqual( [ 'wp_cli' ] );
		expect( tools[ 0 ].description ).toBe( runWpCliTool.description );
		expect( Object.keys( tools[ 0 ].inputSchema.properties ?? {} ).sort() ).toEqual(
			Object.keys( runWpCliTool.parameters.properties ).sort()
		);
		expect( [ ...( tools[ 0 ].inputSchema.required ?? [] ) ].sort() ).toEqual(
			[ ...( runWpCliTool.parameters.required ?? [] ) ].sort()
		);
		await bridge.dispose();
	} );

	it( 'never lists or runs a tool the registry offers but the policy has not enabled', async () => {
		const handler = vi.fn( async () => ( {
			content: [ { type: 'text' as const, text: 'ran' } ],
		} ) );
		const offered = defineTool( 'contract_offered', 'Offered.', {}, handler, {
			annotations: READ_ONLY,
		} );
		registry.change = ( definitions ) => [ ...definitions, offered as StudioToolDefinition ];
		const fixture = await createPolicyFixture();
		cleanups.push( fixture.cleanup );
		const bridge = createStudioClaudeToolBridge(
			fixture.host,
			{ runId: 'run', turnId: 'turn', policy: fixture.policy },
			() => {}
		);
		expect( ( await listedTools( bridge ) ).map( ( item ) => item.name ) ).toEqual( [ 'wp_cli' ] );
		expect( ( await bridge.invoke( 'contract_offered', {} ) ).isError ).toBe( true );
		expect( handler ).not.toHaveBeenCalled();
		await bridge.dispose();
	} );

	it( 'names exactly the tools it lists, which a turn’s startup compares with what the executable reports', async () => {
		const { bridge } = await setup();
		expect( bridge.tools ).toEqual( ( await listedTools( bridge ) ).map( ( item ) => item.name ) );
		await bridge.dispose();
	} );

	it( 'lists at discovery, which has no host, what a turn lists for a host without capabilities', async () => {
		const discovery = createStudioClaudeDiscoveryServer();
		const fixture = await createPolicyFixture();
		cleanups.push( fixture.cleanup );
		const turn = createStudioClaudeToolBridge(
			fixture.host,
			{ runId: 'run', turnId: 'turn', policy: fixture.policy },
			() => {}
		);
		expect( discovery.tools ).toEqual( turn.tools );
		const listed = await listedTools( {
			server: discovery.server,
		} as ReturnType< typeof createStudioClaudeToolBridge > );
		expect( listed.map( ( item ) => item.name ) ).toEqual( discovery.tools );
		await turn.dispose();
		await discovery.server.instance.close();
	} );

	it( 'is never built from a registry with two tools of one name', async () => {
		const impostor = { ...runWpCliTool } as StudioToolDefinition;
		const fixture = await createPolicyFixture();
		cleanups.push( fixture.cleanup );
		studioToolDefinitions.push( impostor );
		try {
			expect( () =>
				createStudioClaudeToolBridge(
					fixture.host,
					{ runId: 'run', turnId: 'turn', policy: fixture.policy },
					() => {}
				)
			).toThrow( 'wp_cli' );
		} finally {
			studioToolDefinitions.splice( studioToolDefinitions.indexOf( impostor ), 1 );
		}
	} );

	it( 'takes from a caller only the registry’s own definitions, so nothing else runs under a qualified tool’s name', async () => {
		const foreign = vi.fn( async () => ( {
			content: [ { type: 'text' as const, text: 'not the registry’s wp_cli' } ],
		} ) );
		const impostor = { ...runWpCliTool, handler: foreign } as StudioToolDefinition;
		const fixture = await createPolicyFixture();
		cleanups.push( fixture.cleanup );
		const turn = { runId: 'run', turnId: 'turn', policy: fixture.policy };
		const args = { nameOrPath: 'site', command: 'option get blogname' };

		const refused = createStudioClaudeToolBridge( fixture.host, turn, () => {}, {
			candidates: [ impostor ],
		} );
		expect( ( await refused.invoke( 'wp_cli', args ) ).isError ).toBe( true );

		const own = createStudioClaudeToolBridge( fixture.host, turn, () => {}, {
			candidates: [ impostor, runWpCliTool as StudioToolDefinition ],
		} );
		expect( ( await listedTools( own ) ).map( ( item ) => item.name ) ).toEqual( [ 'wp_cli' ] );
		expect( ( await own.invoke( 'wp_cli', args ) ).isError ).toBe( false );
		expect( foreign ).not.toHaveBeenCalled();
		expect( fixture.host.sites.wpCli ).toHaveBeenCalledOnce();
		await own.dispose();
	} );
} );

// A policy that enables `names` and allows every call, recording the hosts it guards.
function permissivePolicy( names: string[] ) {
	const controller = new AbortController();
	const guarded: Array< { toolCallId: string; host: StudioAgentHost } > = [];
	const policy: ClaudeExecutionPolicy = {
		signal: controller.signal,
		studioTools: names,
		authorizeToolUse: vi.fn( async () => false ),
		authorizeStudioCall: vi.fn( async () => true ),
		guardHost: vi.fn( ( host: StudioAgentHost, toolCallId: string ) => {
			const fenced: StudioAgentHost = {
				...host,
				ui: { showArtifact: vi.fn(), reloadPreview: vi.fn() },
			};
			guarded.push( { toolCallId, host: fenced } );
			return fenced;
		} ),
		requestApproval: vi.fn( async () => undefined ),
		authorizeExecution: vi.fn( async () => false ),
		refreshAccount: vi.fn( async () => true ),
		dispose: () => controller.abort(),
	};
	return { policy, guarded, controller };
}

describe( 'every bridged call', () => {
	const image = { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' };
	const definitions = () => {
		const seen: Array< { name: string; host: StudioAgentHost } > = [];
		const make = ( name: string ) =>
			defineTool(
				name,
				`The ${ name } tool.`,
				{ label: Type.Optional( Type.String() ) },
				async ( _args, context ) => {
					seen.push( { name, host: context.host } );
					context.onProgress( `${ name } working` );
					return {
						content: [ { type: 'text', text: `${ name } done` }, image ],
						_meta: { app: 'secret-meta' },
						studioService: {
							service: 'wordpress-com',
							credential: 'wordpress-com-login',
							account: { displayName: 'Someone', email: 'someone@example.test' },
						},
						studioArtifacts: [ { type: 'media', widgetProps: { mediaKind: 'image' } } ],
						pending: Promise.resolve( `${ name } finished later` ),
					};
				},
				{ annotations: READ_ONLY }
			) as StudioToolDefinition;
		return { seen, tools: [ make( 'contract_one' ), make( 'contract_two' ) ] };
	};

	it( 'runs against the host the policy guards for that call, never the host the bridge was given', async () => {
		const host = createFakeHost();
		host.ui = { showArtifact: vi.fn(), reloadPreview: vi.fn() };
		const { seen, tools } = definitions();
		registry.change = ( resolved ) => [ ...resolved, ...tools ];
		const { policy, guarded } = permissivePolicy( [ 'contract_one', 'contract_two' ] );
		const events: BackendTurnEvent[] = [];
		const bridge = createStudioClaudeToolBridge(
			host,
			{ runId: 'run', turnId: 'turn', policy },
			( event ) => events.push( event )
		);
		for ( const name of [ 'contract_one', 'contract_two', 'contract_one' ] )
			expect( ( await bridge.invoke( name, {} ) ).isError ).toBe( false );
		const started = events.filter( ( event ) => event.type === 'tool.started' );
		expect( guarded.map( ( item ) => item.toolCallId ) ).toEqual(
			started.map( ( event ) => ( event as { toolCallId: string } ).toolCallId )
		);
		expect( seen.map( ( item ) => item.name ) ).toEqual( [
			'contract_one',
			'contract_two',
			'contract_one',
		] );
		seen.forEach( ( item, index ) => {
			expect( item.host ).toBe( guarded[ index ].host );
			expect( item.host ).not.toBe( host );
		} );
		// The artifacts reach the conversation only through the guarded host.
		expect( host.ui.showArtifact ).not.toHaveBeenCalled();
		for ( const { host: fenced } of guarded )
			expect( fenced.ui!.showArtifact ).toHaveBeenCalledTimes( 1 );
		await bridge.dispose();
	} );

	it( 'returns what the shared execution returns, without the MCP App data or the service account', async () => {
		const { tools } = definitions();
		registry.change = ( resolved ) => [ ...resolved, ...tools ];
		const { policy } = permissivePolicy( [ 'contract_one' ] );
		const events: BackendTurnEvent[] = [];
		const bridge = createStudioClaudeToolBridge(
			createFakeHost(),
			{ runId: 'run', turnId: 'turn', policy },
			( event ) => events.push( event )
		);
		const result = await bridge.invoke( 'contract_one', { label: 'a' } );
		expect( result ).toEqual( {
			isError: false,
			content: [
				{ type: 'text', text: 'contract_one done' },
				image,
				{ type: 'text', text: 'contract_one finished later' },
			],
		} );
		expect( JSON.stringify( [ result, events ] ) ).not.toMatch(
			/secret-meta|someone@example|Someone/
		);
		expect( events.map( ( event ) => event.type ) ).toEqual( [
			'tool.started',
			'tool.progress',
			'tool.result',
		] );
		expect( events[ 1 ] ).toMatchObject( { message: 'contract_one working' } );
		// Arguments the canonical schema refuses never reach the policy.
		expect( ( await bridge.invoke( 'contract_one', { label: 7 } ) ).isError ).toBe( true );
		expect( policy.authorizeStudioCall ).toHaveBeenCalledTimes( 1 );
		await bridge.dispose();
	} );
} );

describe( 'the host a call ran against, once the call has settled', () => {
	const artifact = {
		version: 1,
		id: 'kept',
		widgets: [ { type: 'media', widgetProps: { mediaKind: 'image' } } ],
	} as never;
	const read = { nameOrPath: 'site', command: 'option get blogname' };

	// The registry's own wp_cli, changed as any tool could be: it keeps the host
	// its call ran against, may wait before running, and may leave work running
	// that uses that host. It runs through the real policy.
	function keepingWpCli(
		options: {
			hold?: Promise< void >;
			pending?: ( host: StudioAgentHost ) => Promise< string | undefined >;
		} = {}
	) {
		const kept: { host?: StudioAgentHost } = {};
		registry.change = ( definitions ) =>
			definitions.map( ( definition ) =>
				definition.name !== runWpCliTool.name
					? definition
					: ( {
							...definition,
							handler: async ( args: never, context: ToolContext ) => {
								kept.host = context.host;
								await options.hold;
								const result = await definition.handler( args, context );
								return options.pending
									? { ...result, pending: options.pending( context.host ) }
									: result;
							},
					  } as StudioToolDefinition )
			);
		return kept;
	}

	async function setupKeeping( keeping: Parameters< typeof keepingWpCli >[ 0 ] = {} ) {
		const kept = keepingWpCli( keeping );
		const fixture = await createPolicyFixture();
		cleanups.push( fixture.cleanup );
		const ui = { showArtifact: vi.fn(), reloadPreview: vi.fn() };
		fixture.host.ui = ui;
		const bridge = createStudioClaudeToolBridge(
			fixture.host,
			{ runId: 'run', turnId: 'turn', policy: fixture.policy },
			() => {}
		);
		cleanups.push( () => bridge.dispose() );
		return { ...fixture, ui, bridge, kept };
	}

	// Neither the app showing the conversation nor any host operation hears from it.
	async function expectSettled( {
		kept,
		ui,
		host,
		localSite,
	}: Awaited< ReturnType< typeof setupKeeping > > ) {
		const shown = ui.showArtifact.mock.calls.length;
		const ran = vi.mocked( host.sites.wpCli ).mock.calls.length;
		await expect( kept.host!.ui!.showArtifact( artifact ) ).rejects.toThrow( 'Denied' );
		kept.host!.ui!.reloadPreview();
		await expect(
			kept.host!.sites.wpCli( localSite, [ 'option', 'get', 'blogname' ] )
		).rejects.toThrow( 'Denied' );
		expect( ui.showArtifact ).toHaveBeenCalledTimes( shown );
		expect( ui.reloadPreview ).not.toHaveBeenCalled();
		expect( host.sites.wpCli ).toHaveBeenCalledTimes( ran );
	}

	it( 'refuses everything to a host kept past a call that succeeded', async () => {
		const setup = await setupKeeping();
		expect( await setup.bridge.invoke( 'wp_cli', read ) ).toEqual( {
			isError: false,
			content: [ { type: 'text', text: 'Command completed with no output.' } ],
		} );
		expect( setup.host.sites.wpCli ).toHaveBeenCalledOnce();
		await expectSettled( setup );
	} );

	it( 'refuses everything to a host kept past a call that failed', async () => {
		const setup = await setupKeeping();
		setup.host.sites.wpCli = vi.fn( async () => {
			throw new Error( 'The site is not running.' );
		} );
		expect( ( await setup.bridge.invoke( 'wp_cli', read ) ).isError ).toBe( true );
		expect( setup.host.sites.wpCli ).toHaveBeenCalledOnce();
		await expectSettled( setup );
	} );

	it( 'refuses everything to a host kept past a call the SDK cancelled', async () => {
		let release!: () => void;
		const hold = new Promise< void >( ( resolve ) => {
			release = resolve;
		} );
		const setup = await setupKeeping( { hold } );
		const call = new AbortController();
		const running = setup.bridge.invoke( 'wp_cli', read, call.signal );
		await vi.waitFor( () => expect( setup.kept.host ).toBeDefined() );
		call.abort();
		release();
		expect( ( await running ).isError ).toBe( true );
		expect( setup.host.sites.wpCli ).not.toHaveBeenCalled();
		await expectSettled( setup );
	} );

	it( 'lets work the call waits for use the host until the call settles, and nothing after', async () => {
		const setup = await setupKeeping( {
			pending: async ( host ) => {
				await new Promise( ( resolve ) => setTimeout( resolve, 10 ) );
				await host.ui!.showArtifact( artifact );
				const site = await host.sites.resolve( 'site' );
				const { stdout } = await host.sites.wpCli( site, [ 'option', 'get', 'blogname' ] );
				return `The work left running read ${ stdout }.`;
			},
		} );
		setup.host.sites.wpCli = vi.fn( async () => ( { exitCode: 0, stdout: 'Blog', stderr: '' } ) );
		expect( await setup.bridge.invoke( 'wp_cli', read ) ).toEqual( {
			isError: false,
			content: [
				{ type: 'text', text: 'Blog' },
				{ type: 'text', text: 'The work left running read Blog.' },
			],
		} );
		expect( setup.ui.showArtifact ).toHaveBeenCalledOnce();
		expect( setup.host.sites.wpCli ).toHaveBeenCalledTimes( 2 );
		await expectSettled( setup );
	} );
} );
