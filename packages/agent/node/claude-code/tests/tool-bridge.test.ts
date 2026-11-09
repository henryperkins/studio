import { mkdtemp, realpath, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeHost, fakeSite } from '../../tests/fake-host';
import { createStudioClaudeToolBridge } from '../tool-bridge';
import type { ClaudeToolPolicy } from '../tool-bridge';

const dirs: string[] = [];
afterEach( async () => {
	await Promise.all(
		dirs.splice( 0 ).map( ( dir ) => rm( dir, { recursive: true, force: true } ) )
	);
} );
async function setup(
	approve: ClaudeToolPolicy[ 'approve' ] = vi.fn( async () => 'allow' as const ),
	stillConnected = vi.fn( async () => true )
) {
	const dir = await realpath( await mkdtemp( path.join( os.tmpdir(), 'studio-claude-' ) ) );
	dirs.push( dir );
	const host = createFakeHost();
	host.sites.resolve = vi.fn( async () => ( { ...fakeSite, path: dir } ) );
	const controller = new AbortController();
	const bridge = createStudioClaudeToolBridge(
		host,
		{
			runId: 'run',
			turnId: 'turn',
			siteId: fakeSite.id,
			workingDirectory: dir,
			signal: controller.signal,
			approve,
			approvalTimeoutMs: 100,
			stillConnected,
		},
		() => {}
	);
	return { host, bridge, approve, controller };
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

it( 'expires a pending draft approval, rejects a late allow, and exposes the exact proposed arguments', async () => {
	let release!: ( value: 'allow' ) => void;
	const approve = vi.fn(
		( _request: Parameters< ClaudeToolPolicy[ 'approve' ] >[ 0 ] ) =>
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
		args: [ 'post', 'create', '--post_status=draft', '--post_title=Hello' ],
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

it( 'reports the lifecycle of a Studio tool invocation without exposing exception text', async () => {
	const { host, controller } = await setup();
	const events: import('@studio/agent/protocol/backend-events').BackendTurnEvent[] = [];
	host.sites.wpCli = vi.fn( async () => {
		throw new Error( 'secret diagnostic' );
	} );
	const site = await host.sites.resolve( 'site' );
	const bridge = createStudioClaudeToolBridge(
		host,
		{
			runId: 'run',
			turnId: 'turn',
			siteId: site.id,
			workingDirectory: site.path,
			signal: controller.signal,
			approve: async () => 'deny',
			approvalTimeoutMs: 100,
			stillConnected: async () => true,
		},
		( event ) => events.push( event )
	);
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
