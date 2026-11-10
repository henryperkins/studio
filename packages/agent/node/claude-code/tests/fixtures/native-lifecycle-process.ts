import { once } from 'events';
import path from 'path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk/core';
import { runClaudeTurn } from '../../runtime';
import type { StudioAgentHost } from '../../../host';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';
import type { ChildProcessWithoutNullStreams } from 'child_process';

// The real SDK and Studio launcher, with an empty native profile and a closed prompt gate.
const [ executablePath, root ] = process.argv.slice( 2 );
const controller = new AbortController();
const events: BackendTurnEvent[] = [];
let release!: () => void;
const hold = new Promise< void >( ( resolve ) => {
	release = resolve;
} );
let native: ReturnType< typeof sdkQuery >;
let child: ChildProcessWithoutNullStreams;
let userMessages = 0;

const env: NodeJS.ProcessEnv = {};
for ( const [ name, value ] of Object.entries( process.env ) ) {
	if (
		/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|CLAUDE_CODE_GIT_BASH_PATH)$/i.test(
			name
		)
	)
		env[ name.toUpperCase() ] = value;
}
Object.assign( env, {
	HOME: path.join( root, 'home' ),
	USERPROFILE: path.join( root, 'home' ),
	APPDATA: path.join( root, 'appdata' ),
	LOCALAPPDATA: path.join( root, 'localappdata' ),
	TEMP: path.join( root, 'temp' ),
	TMP: path.join( root, 'temp' ),
	CLAUDE_CONFIG_DIR: path.join( root, 'config' ),
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
	DISABLE_AUTOUPDATER: '1',
} );

process.on( 'message', async ( command ) => {
	if ( command === 'abort' ) controller.abort();
	else {
		const exited = child.exitCode === null ? once( child, 'exit' ) : Promise.resolve();
		if ( command === 'close' ) native.close();
		if ( command === 'eof' ) child.stdin.end();
		if ( command === 'kill-native' ) child.kill( 'SIGKILL' );
		await exited;
	}
	release();
} );

async function main() {
	await runClaudeTurn(
		{
			backend: 'claude-code',
			runId: 'run',
			turnId: 'turn',
			effort: 'medium',
			permissionPolicyRevision: 1,
			selection: {
				connectionId: 'offline',
				revision: 1,
				model: { providerId: 'claude-code', modelId: 'sonnet' },
			},
			workspace: {
				conversationId: 'chat',
				siteId: 'site',
				workingDirectory: root,
				configDirectory: env.CLAUDE_CONFIG_DIR!,
			},
		},
		{ sites: { all: async () => [ { id: 'site', path: root } ] } } as unknown as StudioAgentHost,
		{
			prompt: 'TEST_ONLY_NEVER_RELEASED',
			signal: controller.signal,
			onEvent: ( event ) => events.push( event ),
		},
		{
			storeRoot: path.join( root, 'store' ),
			approve: async () => 'deny',
			connection: async () => ( { id: 'offline', executablePath } ),
			prepare: async () => ( {
				ok: true,
				executablePath,
				cwd: root,
				configDirectory: env.CLAUDE_CONFIG_DIR!,
				projectsDirectory: path.join( env.CLAUDE_CONFIG_DIR!, 'projects' ),
				env,
				identity: {},
			} ),
			query: ( input ) => {
				const launch = input.options!.spawnClaudeCodeProcess!;
				native = sdkQuery( {
					...input,
					options: {
						...input.options,
						spawnClaudeCodeProcess: ( invocation ) => {
							child = launch( invocation ) as ChildProcessWithoutNullStreams;
							const write = child.stdin.write;
							let pending = '';
							child.stdin.write = function ( chunk: string | Uint8Array, ...args: unknown[] ) {
								pending +=
									typeof chunk === 'string' ? chunk : Buffer.from( chunk ).toString( 'utf8' );
								const lines = pending.split( '\n' );
								pending = lines.pop()!;
								for ( const line of lines ) {
									if ( line && JSON.parse( line ).type === 'user' ) {
										userMessages++;
										throw new Error( 'The offline prompt gate opened' );
									}
								}
								return Reflect.apply( write, child.stdin, [ chunk, ...args ] ) as boolean;
							};
							process.send?.( { type: 'spawned', pid: child.pid } );
							return child;
						},
					},
				} );
				return new Proxy( native, {
					get( target, property ) {
						if ( property === 'initializationResult' )
							return async () => {
								const result = await target.initializationResult();
								process.send?.( { type: 'ready', pid: child.pid } );
								await hold;
								return result;
							};
						const value = Reflect.get( target, property );
						return typeof value === 'function' ? value.bind( target ) : value;
					},
				} );
			},
		}
	);
	process.send?.( { type: 'done', userMessages, events }, () => process.disconnect() );
}

main().catch( () => {
	process.send?.( { type: 'failed' }, () => process.disconnect() );
	process.exitCode = 1;
} );
