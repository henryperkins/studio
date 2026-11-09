import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { realpath } from 'fs/promises';
import path from 'path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk/core';
import { compareClaudeExecutionAuth } from './auth-status';
import { getClaudeConnections, prepareClaudeInvocation } from './connection';
import { createClaudeEventAdapter } from './event-adapter';
import { createNativeSessionStore } from './sessions';
import { createStudioClaudeToolBridge } from './tool-bridge';
import type { ClaudeAuthIdentity } from './auth-status';
import type { ClaudeToolPolicy } from './tool-bridge';
import type { StudioAgentHost } from '../host';
import type {
	BackendTurnEvent,
	ClaudeBackendTurnSnapshot,
} from '@studio/agent/protocol/backend-events';
import type { StudioChatImage } from '@studio/agent/protocol/chat-images';

interface StartupControl {
	initializationResult(): Promise< {
		hooks_applied?: boolean;
		hook_on_failure_supported?: boolean;
	} >;
	accountInfo(): Promise< ClaudeAuthIdentity >;
	mcpServerStatus(): Promise<
		Array< { name: string; source?: string; status: string; tools?: Array< { name: string } > } >
	>;
	supportedModels(): Promise<
		Array< {
			value: string;
			resolvedModel?: string;
			displayName: string;
			supportedEffortLevels?: readonly string[];
		} >
	>;
}
export function isQualifiedClaudePlugins(
	plugins: readonly { name: string; path: string }[]
): boolean {
	return (
		plugins.length <= 1 &&
		plugins.every( ( plugin ) => plugin.name === 'cc-plugin-privacy' && plugin.path === 'builtin' )
	);
}
export async function qualifyClaudeStartup(
	query: StartupControl,
	identity: ClaudeAuthIdentity,
	model: string,
	effort: string | null
) {
	try {
		const [ init, account, firstInventory, models ] = await Promise.all( [
			query.initializationResult(),
			query.accountInfo(),
			query.mcpServerStatus(),
			query.supportedModels(),
		] );
		let inventory = firstInventory;
		for (
			let attempt = 0;
			attempt < 20 &&
			inventory.length === 1 &&
			inventory[ 0 ].name === 'studio' &&
			inventory[ 0 ].source === 'sdk' &&
			inventory[ 0 ].status === 'pending';
			attempt++
		) {
			await new Promise( ( resolve ) => setTimeout( resolve, 50 ) );
			inventory = await query.mcpServerStatus();
		}
		if (
			! init.hooks_applied ||
			! init.hook_on_failure_supported ||
			! compareClaudeExecutionAuth( identity, account ) ||
			inventory.length !== 1 ||
			inventory[ 0 ].name !== 'studio' ||
			inventory[ 0 ].source !== 'sdk' ||
			inventory[ 0 ].status !== 'connected' ||
			inventory[ 0 ].tools?.length !== 1 ||
			inventory[ 0 ].tools[ 0 ].name !== 'wp_cli'
		)
			return { ok: false as const };
		const row = models.find(
			( candidate ) => candidate.value === model || candidate.resolvedModel === model
		);
		if ( ! row || ! effort ) return { ok: false as const };
		const catalog = new Map< string, { id: string; displayName: string; efforts: string[] } >();
		for ( const item of models ) {
			const id = item.resolvedModel ?? item.value;
			const current = catalog.get( id );
			if ( current )
				current.efforts = current.efforts.filter(
					( level ) => item.supportedEffortLevels?.includes( level )
				);
			else
				catalog.set( id, {
					id,
					displayName: item.displayName,
					efforts: [ ...( item.supportedEffortLevels ?? [] ) ],
				} );
		}
		const canonical = row.resolvedModel ?? row.value;
		if ( ! catalog.get( canonical )?.efforts.includes( effort ) ) return { ok: false as const };
		return {
			ok: true as const,
			acceptedModels: [
				canonical,
				...models
					.filter( ( item ) => ( item.resolvedModel ?? item.value ) === canonical )
					.map( ( item ) => item.value ),
			],
			models: [ ...catalog.values() ],
		};
	} catch {
		return { ok: false as const };
	}
}

export function isQualifiedClaudeSpawn(
	actual: { command: string; cwd?: string; env: NodeJS.ProcessEnv },
	expected: { command: string; cwd: string; env: NodeJS.ProcessEnv }
): boolean {
	if ( actual.command !== expected.command || actual.cwd !== expected.cwd ) return false;
	const allowedExtra = new Set( [
		'CLAUDE_AGENT_SDK_VERSION',
		'CLAUDE_CODE_ENTRYPOINT',
		'CLAUDE_CODE_SDK_READS_SESSION_STATE',
	] );
	for ( const [ name, value ] of Object.entries( expected.env ) )
		if ( actual.env[ name ] !== value ) return false;
	for ( const name of Object.keys( actual.env ) )
		if (
			! Object.prototype.hasOwnProperty.call( expected.env, name ) &&
			! allowedExtra.has( name )
		)
			return false;
	return true;
}

export async function settleNativeProcess(
	child: {
		exitCode: number | null;
		signalCode: NodeJS.Signals | null;
		once( event: 'exit', listener: () => void ): unknown;
		off( event: 'exit', listener: () => void ): unknown;
		kill( signal: NodeJS.Signals ): boolean;
	},
	graceMs = 3000
): Promise< boolean > {
	const wait = () =>
		new Promise< boolean >( ( resolve ) => {
			if ( child.exitCode !== null || child.signalCode !== null ) return resolve( true );
			const done = () => {
				clearTimeout( timer );
				child.off( 'exit', done );
				resolve( true );
			};
			const timer = setTimeout( () => {
				child.off( 'exit', done );
				resolve( false );
			}, graceMs );
			child.once( 'exit', done );
		} );
	if ( await wait() ) return true;
	child.kill( 'SIGKILL' );
	return wait();
}

export async function isAllowedNativeRead(
	file: string,
	workspace: string,
	config: string
): Promise< boolean > {
	if ( ! path.isAbsolute( file ) ) return false;
	try {
		const canonical = await realpath( file );
		const inside = ( root: string, candidate: string ) => {
			const relative = path.relative( root, candidate );
			return (
				relative === '' ||
				( relative !== '..' &&
					! relative.startsWith( '..' + path.sep ) &&
					! path.isAbsolute( relative ) )
			);
		};
		const sensitive = ( candidate: string ) =>
			candidate
				.split( /[\\/]/ )
				.some( ( part ) =>
					/^(?:\.env(?:\..*)?|wp-config\.php|\.credentials(?:\..*)?|\.ssh|database|.*secret.*|.*credential.*|.*\.(?:pem|key|p12|pfx))$/i.test(
						part
					)
				);
		return (
			inside( workspace, canonical ) &&
			canonical !== workspace &&
			! inside( config, canonical ) &&
			! sensitive( file ) &&
			! sensitive( canonical )
		);
	} catch {
		return false;
	}
}

interface RuntimeInput {
	prompt: string;
	images?: StudioChatImage[];
	signal: AbortSignal;
	onEvent: ( event: BackendTurnEvent ) => void;
}
type Prepared =
	| {
			ok: true;
			executablePath: string;
			cwd: string;
			configDirectory: string;
			projectsDirectory: string;
			env: NodeJS.ProcessEnv;
			identity: ClaudeAuthIdentity;
	  }
	| { ok: false };
interface RuntimeOptions {
	storeRoot: string;
	approve: ClaudeToolPolicy[ 'approve' ];
	query?: typeof sdkQuery;
	connection?: (
		id: string
	) => Promise< { id: string; executablePath: string; configDirectory?: string } | undefined >;
	prepare?: ( exe: string, cwd: string, config?: string ) => Promise< Prepared >;
}

export async function runClaudeTurn(
	snapshot: ClaudeBackendTurnSnapshot,
	host: StudioAgentHost,
	input: RuntimeInput,
	options: RuntimeOptions
): Promise< void > {
	const { runId, turnId, workspace, selection } = snapshot;
	const fail = (): BackendTurnEvent => ( {
		type: 'turn.terminal',
		runId,
		turnId,
		outcome: {
			status: 'error',
			message: 'Claude Code could not start or safely complete this turn.',
		},
	} );
	const controller = new AbortController();
	const cancel = () => controller.abort();
	input.signal.addEventListener( 'abort', cancel, { once: true } );
	const timer = setTimeout( cancel, 30 * 60 * 1000 );
	let release: ( () => Promise< void > ) | undefined;
	let native: ReturnType< typeof sdkQuery > | undefined;
	let ownedChild: ReturnType< typeof spawn > | undefined;
	let bridge: ReturnType< typeof createStudioClaudeToolBridge > | undefined;
	let openGate: ( allow: boolean ) => void = () => {};
	const gate = new Promise< boolean >( ( resolve ) => {
		openGate = resolve;
	} );
	let terminal: BackendTurnEvent | undefined;
	let nativeInitAccepted = false;
	let journal: ReturnType< ReturnType< typeof createNativeSessionStore >[ 'journal' ] > | undefined;
	let journalWork = Promise.resolve();
	try {
		if ( input.signal.aborted || input.images?.length ) throw new Error();
		const findConnection =
			options.connection ??
			( async ( id: string ) =>
				( await getClaudeConnections() ).find( ( item ) => item.id === id ) );
		const connection = await findConnection( selection.connectionId );
		if ( ! connection ) throw new Error();
		const prepared = await ( options.prepare ?? prepareClaudeInvocation )(
			connection.executablePath,
			workspace.workingDirectory,
			connection.configDirectory
		);
		if (
			! prepared.ok ||
			prepared.cwd !== workspace.workingDirectory ||
			prepared.configDirectory !== workspace.configDirectory
		)
			throw new Error();
		const stillConnected = async () => {
			const current = await findConnection( selection.connectionId );
			return (
				!! current &&
				current.executablePath === connection.executablePath &&
				current.configDirectory === connection.configDirectory
			);
		};
		const store = createNativeSessionStore( options.storeRoot );
		release = await store.lockTurn( workspace.conversationId );
		const existing = await store.load( workspace.conversationId );
		const binding = {
			connectionId: selection.connectionId,
			conversationId: workspace.conversationId,
			siteId: workspace.siteId,
			workingDirectory: prepared.cwd,
			configDirectory: prepared.configDirectory,
		};
		if (
			existing &&
			( await store.resolve( existing, binding, prepared.projectsDirectory ) ).status !== 'ready'
		)
			throw new Error();
		const session = existing ?? {
			backend: 'claude-code' as const,
			...binding,
			nativeSessionId: randomUUID(),
		};
		const site = ( await host.sites.all() ).find(
			( candidate ) => candidate.id === workspace.siteId
		);
		if ( ! site || ( await realpath( site.path ) ) !== prepared.cwd ) throw new Error();
		journal = store.journal( workspace.conversationId, turnId );
		const emit = ( event: BackendTurnEvent ) => {
			if ( event.type === 'turn.terminal' ) {
				terminal ??= event;
				return;
			}
			journalWork = journalWork.then( () => journal!.append( event ) );
			input.onEvent( event );
		};
		bridge = createStudioClaudeToolBridge(
			host,
			{
				runId,
				turnId,
				siteId: workspace.siteId,
				workingDirectory: prepared.cwd,
				signal: controller.signal,
				approve: options.approve,
				approvalTimeoutMs: 120000,
				stillConnected: async () => nativeInitAccepted && ( await stillConnected() ),
			},
			emit
		);
		const nativeInput = async function* () {
			if ( ( await gate ) && ! controller.signal.aborted )
				yield {
					type: 'user' as const,
					message: { role: 'user' as const, content: input.prompt },
					parent_tool_use_id: null,
					session_id: session.nativeSessionId,
					client_composed: true as const,
				};
		};
		const effort = snapshot.effort;
		if ( ! effort || ! [ 'low', 'medium', 'high', 'xhigh', 'max' ].includes( effort ) )
			throw new Error();
		const childEnv = { ...prepared.env, CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1' };
		native = ( options.query ?? sdkQuery )( {
			prompt: nativeInput(),
			options: {
				abortController: controller,
				pathToClaudeCodeExecutable: prepared.executablePath,
				cwd: prepared.cwd,
				env: childEnv,
				spawnClaudeCodeProcess: ( spawnOptions ) => {
					if (
						! isQualifiedClaudeSpawn( spawnOptions, {
							command: prepared.executablePath,
							cwd: prepared.cwd,
							env: childEnv,
						} )
					)
						throw new Error( 'Unexpected native process invocation' );
					const child = spawn( spawnOptions.command, spawnOptions.args, {
						cwd: spawnOptions.cwd,
						env: spawnOptions.env,
						signal: spawnOptions.signal,
						windowsHide: true,
						stdio: 'pipe',
					} );
					ownedChild = child;
					child.stderr.resume();
					return child;
				},
				...( existing
					? { resume: session.nativeSessionId }
					: { sessionId: session.nativeSessionId } ),
				model: selection.model.modelId,
				effort: effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
				includePartialMessages: true,
				tools: [ 'Read' ],
				mcpServers: { studio: bridge.server },
				strictMcpConfig: true,
				settingSources: [],
				settings: {
					autoMemoryEnabled: false,
					disableClaudeAiConnectors: true,
					enabledPlugins: {
						'cc-plugin-agents-md@builtin': false,
						'cc-plugin-plugin-authoring@builtin': false,
						'cc-plugin-telemetry@builtin': false,
					},
				},
				extraArgs: { 'disable-slash-commands': null },
				permissionMode: 'default',
				permissionPrompts: 'host',
				systemPrompt: {
					type: 'preset',
					preset: 'claude_code',
					append:
						'Work only in the current local WordPress site. Use Studio tools for WordPress operations. Do not publish or access production.',
				},
				canUseTool: async ( name, toolInput ) =>
					name === 'Read' || name === 'mcp__studio__wp_cli'
						? { behavior: 'allow', updatedInput: toolInput }
						: { behavior: 'deny', message: 'Tool unavailable.' },
				hooks: {
					PreToolUse: [
						{
							onFailure: 'block',
							hooks: [
								async ( hook ) => {
									let allowed = false;
									if (
										nativeInitAccepted &&
										hook.hook_event_name === 'PreToolUse' &&
										! controller.signal.aborted
									) {
										if ( hook.tool_name === 'mcp__studio__wp_cli' )
											allowed =
												hook.mcp_server?.name === 'studio' && hook.mcp_server?.source === 'sdk';
										else if (
											hook.tool_name === 'Read' &&
											hook.tool_input &&
											typeof hook.tool_input === 'object'
										) {
											const file = ( hook.tool_input as Record< string, unknown > ).file_path;
											if ( typeof file === 'string' )
												allowed =
													( await isAllowedNativeRead(
														file,
														prepared.cwd,
														prepared.configDirectory
													) ) &&
													( await stillConnected() ) &&
													! controller.signal.aborted;
										}
									}
									return {
										hookSpecificOutput: {
											hookEventName: 'PreToolUse',
											permissionDecision: allowed ? 'allow' : 'deny',
										},
									};
								},
							],
						},
					],
				},
			},
		} );
		const qualification = await Promise.race( [
			qualifyClaudeStartup( native, prepared.identity, selection.model.modelId, effort ),
			new Promise< { ok: false } >( ( resolve ) => {
				controller.signal.addEventListener( 'abort', () => resolve( { ok: false } ), {
					once: true,
				} );
				setTimeout( () => resolve( { ok: false } ), 15000 ).unref();
			} ),
		] );
		if ( ! qualification.ok || controller.signal.aborted || ! ( await stillConnected() ) )
			throw new Error();
		if ( ! existing ) await store.create( session );
		if ( controller.signal.aborted || ! ( await stillConnected() ) ) throw new Error();
		openGate( true );
		const adapter = createClaudeEventAdapter( runId, turnId, emit );
		for await ( const message of native ) {
			if ( controller.signal.aborted ) break;
			if (
				'session_id' in message &&
				message.session_id &&
				message.session_id !== session.nativeSessionId
			)
				throw new Error();
			if ( message.type === 'system' && message.subtype === 'init' ) {
				if (
					message.permissionMode !== 'default' ||
					! isQualifiedClaudePlugins( message.plugins ) ||
					message.plugin_errors?.length ||
					message.tools.some( ( name ) => name !== 'Read' && name !== 'mcp__studio__wp_cli' ) ||
					message.cwd !== prepared.cwd ||
					message.apiKeySource !== 'none' ||
					message.claude_code_version !== '2.1.319' ||
					! qualification.acceptedModels.includes( message.model ) ||
					message.mcp_servers.length !== 1 ||
					message.mcp_servers[ 0 ].name !== 'studio' ||
					message.mcp_servers[ 0 ].status !== 'connected' ||
					message.mcp_servers[ 0 ].source !== 'sdk'
				)
					throw new Error();
				nativeInitAccepted = true;
			}
			if (
				message.type === 'assistant' &&
				! qualification.acceptedModels.includes( message.message.model )
			)
				throw new Error();
			if ( message.type === 'result' && message.subtype === 'success' && ! nativeInitAccepted )
				throw new Error();
			adapter.accept( message as unknown as Record< string, unknown > );
			if ( terminal ) break;
		}
	} catch {
		terminal ??= input.signal.aborted
			? { type: 'turn.terminal', runId, turnId, outcome: { status: 'interrupted' } }
			: fail();
	} finally {
		openGate( false );
		controller.abort();
		native?.close();
		let stopped = true;
		try {
			if ( ownedChild ) stopped = await settleNativeProcess( ownedChild );
		} catch {
			stopped = false;
		}
		try {
			await bridge?.dispose();
		} catch {
			if (
				! terminal ||
				terminal.type !== 'turn.terminal' ||
				terminal.outcome.status === 'success'
			)
				terminal = fail();
		}
		terminal ??= {
			type: 'turn.terminal',
			runId,
			turnId,
			outcome: { status: input.signal.aborted ? 'interrupted' : 'unknown_process_exit' },
		};
		if (
			! stopped &&
			( terminal.type !== 'turn.terminal' || terminal.outcome.status === 'success' )
		)
			terminal = fail();
		try {
			await journalWork;
			await journal?.append( terminal );
		} catch {
			terminal = fail();
		}
		if ( stopped )
			try {
				await release?.();
			} catch {
				if ( terminal.type !== 'turn.terminal' || terminal.outcome.status === 'success' )
					terminal = fail();
			}
		clearTimeout( timer );
		input.signal.removeEventListener( 'abort', cancel );
		input.onEvent( terminal );
	}
}
