import { writeFile } from 'fs/promises';
import path from 'path';
import { Type } from 'typebox';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeHost } from '../../tests/fake-host';
import { defineTool, READ_ONLY, type StudioToolDefinition } from '../../tools/define-tool';
import { runWpCliTool } from '../../tools/wp-cli';
import { createStudioClaudeToolBridge } from '../tool-bridge';
import { createPolicyFixture } from './fixtures/execution-policy';
import type { StudioAgentHost } from '../../host';
import type { ClaudeApprover, ClaudeExecutionPolicy } from '../execution-policy';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';

const cleanups: Array< () => Promise< void > > = [];
afterEach( async () => {
	vi.unstubAllEnvs();
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
		const fixture = await createPolicyFixture();
		cleanups.push( fixture.cleanup );
		const bridge = createStudioClaudeToolBridge(
			fixture.host,
			{ runId: 'run', turnId: 'turn', policy: fixture.policy },
			() => {},
			{ candidates: [ runWpCliTool as StudioToolDefinition, offered as StudioToolDefinition ] }
		);
		expect( ( await listedTools( bridge ) ).map( ( item ) => item.name ) ).toEqual( [ 'wp_cli' ] );
		expect( ( await bridge.invoke( 'contract_offered', {} ) ).isError ).toBe( true );
		expect( handler ).not.toHaveBeenCalled();
		await bridge.dispose();
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
		const { policy, guarded } = permissivePolicy( [ 'contract_one', 'contract_two' ] );
		const events: BackendTurnEvent[] = [];
		const bridge = createStudioClaudeToolBridge(
			host,
			{ runId: 'run', turnId: 'turn', policy },
			( event ) => events.push( event ),
			{ candidates: tools }
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
		const { policy } = permissivePolicy( [ 'contract_one' ] );
		const events: BackendTurnEvent[] = [];
		const bridge = createStudioClaudeToolBridge(
			createFakeHost(),
			{ runId: 'run', turnId: 'turn', policy },
			( event ) => events.push( event ),
			{ candidates: tools }
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
