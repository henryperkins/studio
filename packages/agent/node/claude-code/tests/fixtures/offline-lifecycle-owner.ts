import { spawn } from 'child_process';
import { appendFileSync, mkdirSync, statSync } from 'fs';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
// The SDK's wildcard export resolves at runtime, although the ESLint resolver misses it.
// eslint-disable-next-line import-x/no-unresolved
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { prepareProcessOwner } from '@studio/common/lib/owned-process';
import { CLAUDE_EXECUTION_POLICY_REVISION } from '../../execution-policy';
import { runClaudeTurn } from '../../runtime';
import { reportedStudioServer } from './studio-server';
import type { StudioAgentHost } from '../../../host';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'child_process';

// The real Studio runtime, policy and owned-process tree, with a Node test
// process in place of the vendor executable and an SDK stand-in that drives
// it: after init it asks for a draft, whose approval never arrives, and then
// waits for the test to act.
const [ nativeFixture, marker, lifetime, root ] = process.argv.slice( 2 );
setTimeout( () => process.exit( 1 ), Number( lifetime ) + 15_000 ).unref();
const site = path.join( root, 'site' );
const config = path.join( root, 'config' );
const controller = new AbortController();
const events: BackendTurnEvent[] = [];
const wpCli: unknown[] = [];
let approvalCancelled = false;
let child: ChildProcessWithoutNullStreams | undefined;
let closeNative: () => void = () => {};

const env: NodeJS.ProcessEnv = {};
for ( const [ name, value ] of Object.entries( process.env ) )
	if ( /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|HOME)$/i.test( name ) )
		env[ name ] = value;

const found = statSync( process.execPath, { bigint: true } );
const siteRecord = {
	id: 'site',
	path: site,
	name: 'site',
	url: 'http://localhost',
	phpVersion: '8.4',
};
const host = {
	sitesRoot: root,
	sites: {
		all: async () => [ siteRecord ],
		resolve: async () => siteRecord,
		wpCli: async ( ...args: unknown[] ) => {
			wpCli.push( args );
			return { exitCode: 0, stdout: '', stderr: '' };
		},
	},
} as unknown as StudioAgentHost;

// The first process the owner starts is its Windows job keeper.
const helpers: ChildProcess[] = [];
const recording = ( ( ...args: Parameters< typeof spawn > ) => {
	const started = spawn( ...args );
	helpers.push( started );
	return started;
} ) as typeof spawn;

process.on( 'message', ( command ) => {
	if ( command === 'abort' ) controller.abort();
	if ( command === 'close' ) closeNative();
	if ( command === 'eof' ) child?.stdin.end();
	if ( command === 'kill-native' ) child?.kill( 'SIGKILL' );
	// This process's own unreaped child.
	if ( command === 'kill-keeper' ) helpers[ 0 ]?.kill( 'SIGKILL' );
} );

function firstLine( stream: NodeJS.ReadableStream ): Promise< string > {
	return new Promise( ( resolve ) => {
		let buffer = '';
		stream.setEncoding( 'utf8' );
		stream.on( 'data', ( chunk: string ) => {
			buffer += chunk;
			const end = buffer.indexOf( '\n' );
			if ( end >= 0 ) resolve( buffer.slice( 0, end ).trim() );
		} );
	} );
}

async function main() {
	await runClaudeTurn(
		{
			backend: 'claude-code',
			runId: 'run',
			turnId: 'turn',
			effort: 'medium',
			permissionPolicyRevision: CLAUDE_EXECUTION_POLICY_REVISION,
			target: { environment: 'local' as const, siteId: 'site' },
			selection: {
				connectionId: 'offline',
				revision: 1,
				model: { providerId: 'claude-code', modelId: 'sonnet' },
			},
			workspace: {
				conversationId: 'chat',
				siteId: 'site',
				workingDirectory: site,
				configDirectory: config,
			},
		},
		host,
		{ prompt: 'TEST_ONLY', signal: controller.signal, onEvent: ( event ) => events.push( event ) },
		{
			storeRoot: path.join( root, 'store' ),
			prepareOwner: () => prepareProcessOwner( { spawn: recording } ),
			approve: ( _request, signal ) => {
				signal.addEventListener(
					'abort',
					() => {
						approvalCancelled = true;
					},
					{ once: true }
				);
				process.send?.( { type: 'approval', native: child?.pid } );
				return new Promise( () => {} );
			},
			verifyTarget: async () => true,
			account: async () => ( {
				state: 'signed-in',
				identity: { email: 'user@example.com', subscriptionType: 'max' },
			} ),
			connection: async () => ( { id: 'offline', executablePath: process.execPath } ),
			prepare: async () => ( {
				ok: true,
				executablePath: process.execPath,
				executableIdentity: {
					path: process.execPath,
					size: Number( found.size ),
					device: found.dev.toString(),
					inode: found.ino.toString(),
					modified: found.mtimeNs.toString(),
					changed: found.ctimeNs.toString(),
					sha256: '',
				},
				cwd: site,
				configDirectory: config,
				projectsDirectory: path.join( config, 'projects' ),
				env,
				identity: { email: 'user@example.com', subscriptionType: 'max' },
			} ),
			query: ( input ) => {
				const options = input.options!;
				child = options.spawnClaudeCodeProcess!( {
					command: options.pathToClaudeCodeExecutable!,
					args: [ nativeFixture, 'tree', marker, lifetime ],
					cwd: options.cwd,
					env: options.env!,
					signal: new AbortController().signal,
				} ) as ChildProcessWithoutNullStreams;
				const native = child;
				const ready = firstLine( native.stdout );
				const ended = new Promise< void >( ( resolve ) => {
					closeNative = () => {
						native.stdin.end();
						resolve();
					};
					native.once( 'exit', () => resolve() );
					options.abortController!.signal.addEventListener( 'abort', () => resolve(), {
						once: true,
					} );
				} );
				return {
					initializationResult: async () => ( {
						hooks_applied: true,
						hook_on_failure_supported: true,
					} ),
					accountInfo: async () => ( {
						email: 'user@example.com',
						subscriptionType: 'max',
						apiProvider: 'firstParty',
					} ),
					mcpServerStatus: async () => [ reportedStudioServer( options ) ],
					supportedModels: async () => [
						{ value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: [ 'medium' ] },
					],
					close: () => closeNative(),
					async *[ Symbol.asyncIterator ]() {
						for await ( const _prompt of input.prompt as AsyncIterable< unknown > ) {
							// The native history the vendor runtime keeps for the conversation.
							const projects = path.join( config, 'projects', 'studio-lifecycle' );
							mkdirSync( projects, { recursive: true } );
							appendFileSync(
								path.join( projects, `${ options.sessionId }.jsonl` ),
								JSON.stringify( { sessionId: options.sessionId, cwd: site } ) + '\n'
							);
							yield {
								type: 'system',
								subtype: 'init',
								session_id: options.sessionId,
								permissionMode: 'default',
								plugins: [],
								tools: [
									...( Array.isArray( options.tools ) ? options.tools : [] ),
									...reportedStudioServer( options ).tools.map(
										( tool ) => `mcp__studio__${ tool.name }`
									),
								],
								cwd: site,
								apiKeySource: 'none',
								claude_code_version: '2.1.319',
								model: 'sonnet',
								mcp_servers: [ { name: 'studio', status: 'connected', source: 'sdk' } ],
							};
							const [ , treePid, shellPid, leafPid ] = ( await ready ).split( ' ' );
							process.send?.( {
								type: 'native',
								native: Number( treePid ),
								shell: Number( shellPid ),
								leaf: Number( leafPid ),
							} );
							const [ clientTransport, serverTransport ] = InMemoryTransport.createLinkedPair();
							const client = new Client( { name: 'studio-lifecycle', version: '1.0.0' } );
							const server = (
								options.mcpServers as unknown as {
									studio: { instance: { connect( t: unknown ): Promise< void > } };
								}
							 ).studio.instance;
							await Promise.all( [
								server.connect( serverTransport ),
								client.connect( clientTransport ),
							] );
							void client
								.callTool( {
									name: 'wp_cli',
									arguments: {
										nameOrPath: 'site',
										command: 'post create --post_status=draft --post_title=Hello',
									},
								} )
								.catch( () => {} );
							await ended;
						}
					},
				} as unknown as ReturnType<
					NonNullable< Parameters< typeof runClaudeTurn >[ 3 ][ 'query' ] >
				>;
			},
		}
	);
	process.send?.( { type: 'done', events, approvalCancelled, wpCli: wpCli.length }, () =>
		process.disconnect()
	);
}

main().catch( () => {
	process.send?.( { type: 'failed' }, () => process.disconnect() );
	process.exitCode = 1;
} );
