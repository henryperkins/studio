import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { realpath } from 'fs/promises';
import path from 'path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk/core';
import { validateStudioChatImages } from '@studio/agent/protocol/chat-images';
import { isClaudeEffort, isClaudeModelId } from '@studio/agent/protocol/claude-code';
import { compareClaudeExecutionAuth } from './auth-status';
import { getClaudeConnections, prepareClaudeInvocation } from './connection';
import { QUALIFIED_CLAUDE_CODE_VERSION } from './discovery';
import { createClaudeEventAdapter } from './event-adapter';
import { createNativeSessionStore } from './sessions';
import { createStudioClaudeMcpServer, createStudioClaudeToolBridge } from './tool-bridge';
import type { ClaudeAuthIdentity } from './auth-status';
import type { ClaudeToolPolicy } from './tool-bridge';
import type { StudioAgentHost } from '../host';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk/core';
import type {
	BackendTurnEvent,
	ClaudeBackendTurnSnapshot,
} from '@studio/agent/protocol/backend-events';
import type { StudioChatImage } from '@studio/agent/protocol/chat-images';
import type { ClaudeModelOption } from '@studio/agent/protocol/claude-code';

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
	model?: string,
	effort?: string | null
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
			( inventory.length === 0 ||
				( inventory.length === 1 &&
					inventory[ 0 ].name === 'studio' &&
					inventory[ 0 ].source === 'sdk' &&
					inventory[ 0 ].status === 'pending' ) );
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
		const catalog = new Map< string, ClaudeModelOption >();
		for ( const item of models ) {
			const id = item.resolvedModel ?? item.value;
			if ( ! isClaudeModelId( id ) ) continue;
			const current = catalog.get( id );
			if ( current )
				current.efforts = current.efforts.filter(
					( level ) => item.supportedEffortLevels?.includes( level )
				);
			else
				catalog.set( id, {
					id,
					displayName: item.displayName,
					efforts: ( item.supportedEffortLevels ?? [] ).filter( isClaudeEffort ),
				} );
		}
		const available = [ ...catalog.values() ].filter( ( item ) => item.efforts.length );
		if ( ! model ) return { ok: true as const, acceptedModels: [], models: available };
		const row = models.find(
			( candidate ) => candidate.value === model || candidate.resolvedModel === model
		);
		if ( ! row || ! isClaudeEffort( effort ) ) return { ok: false as const };
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
			models: available,
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
	| { ok: false; blockers?: string[] };
interface RuntimeDependencies {
	query?: typeof sdkQuery;
	connection?: (
		id: string
	) => Promise< { id: string; executablePath: string; configDirectory?: string } | undefined >;
	prepare?: ( exe: string, cwd: string, config?: string ) => Promise< Prepared >;
}

interface RuntimeOptions extends RuntimeDependencies {
	storeRoot: string;
	approve: ClaudeToolPolicy[ 'approve' ];
	verifySession?: ( snapshot: ClaudeBackendTurnSnapshot ) => Promise< boolean >;
}

type TerminalEvent = Extract< BackendTurnEvent, { type: 'turn.terminal' } >;

async function findSavedConnection( id: string ) {
	return ( await getClaudeConnections() ).find( ( item ) => item.id === id );
}

function nativeLaunchOptions(
	prepared: Extract< Prepared, { ok: true } >,
	controller: AbortController,
	onChild: ( child: ReturnType< typeof spawn > ) => void
): Options {
	const env = { ...prepared.env, CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1' };
	return {
		abortController: controller,
		pathToClaudeCodeExecutable: prepared.executablePath,
		cwd: prepared.cwd,
		env,
		spawnClaudeCodeProcess: ( invocation ) => {
			if (
				! isQualifiedClaudeSpawn( invocation, {
					command: prepared.executablePath,
					cwd: prepared.cwd,
					env,
				} )
			)
				throw new Error( 'Unexpected native process invocation' );
			const child = spawn( invocation.command, invocation.args, {
				cwd: invocation.cwd,
				env: invocation.env,
				signal: invocation.signal,
				windowsHide: true,
				stdio: 'pipe',
			} );
			onChild( child );
			child.stderr.resume();
			return child;
		},
		tools: [ 'Read' ],
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
	};
}

async function qualifyWithinDeadline(
	query: StartupControl,
	identity: ClaudeAuthIdentity,
	signal: AbortSignal,
	model?: string,
	effort?: string
) {
	if ( signal.aborted ) return { ok: false as const };
	let stop!: () => void;
	const interrupted = new Promise< { ok: false } >( ( resolve ) => {
		stop = () => resolve( { ok: false } );
	} );
	const timer = setTimeout( stop, 15000 );
	signal.addEventListener( 'abort', stop, { once: true } );
	try {
		return await Promise.race( [
			qualifyClaudeStartup( query, identity, model, effort ),
			interrupted,
		] );
	} finally {
		clearTimeout( timer );
		signal.removeEventListener( 'abort', stop );
	}
}

export async function discoverClaudeModels(
	connectionId: string,
	workingDirectory: string,
	dependencies: RuntimeDependencies = {}
) {
	const failed = { ok: false as const, blockers: [ 'native-runtime-unqualified' ] };
	const controller = new AbortController();
	let child: ReturnType< typeof spawn > | undefined;
	let sdk: ReturnType< typeof sdkQuery > | undefined;
	let server: ReturnType< typeof createStudioClaudeMcpServer > | undefined;
	const done = new Promise< IteratorResult< SDKUserMessage > >( ( resolve ) => {
		controller.signal.addEventListener(
			'abort',
			() => resolve( { done: true, value: undefined } ),
			{
				once: true,
			}
		);
	} );
	let result:
		| typeof failed
		| { ok: true; models: ClaudeModelOption[]; workingDirectory: string; configDirectory: string } =
		failed;
	try {
		const findConnection = dependencies.connection ?? findSavedConnection;
		const connection = await findConnection( connectionId );
		if ( ! connection ) return { ok: false as const, blockers: [ 'connection-not-found' ] };
		const prepared = await ( dependencies.prepare ?? prepareClaudeInvocation )(
			connection.executablePath,
			workingDirectory,
			connection.configDirectory
		);
		if ( ! prepared.ok )
			return { ok: false as const, blockers: prepared.blockers ?? failed.blockers };
		server = createStudioClaudeMcpServer( async () => ( { content: [], isError: true } ) );
		sdk = ( dependencies.query ?? sdkQuery )( {
			prompt: { [ Symbol.asyncIterator ]: () => ( { next: () => done } ) },
			options: {
				...nativeLaunchOptions( prepared, controller, ( process ) => {
					child = process;
				} ),
				persistSession: false,
				mcpServers: { studio: server },
				hooks: {
					PreToolUse: [
						{
							onFailure: 'block',
							hooks: [ async () => ( { decision: 'block' } ) ],
						},
					],
				},
			},
		} );
		const qualification = await qualifyWithinDeadline( sdk, prepared.identity, controller.signal );
		if ( qualification.ok && ( await findConnection( connectionId ) ) ) {
			result = {
				ok: true,
				models: qualification.models,
				workingDirectory: prepared.cwd,
				configDirectory: prepared.configDirectory,
			};
		}
	} catch {
		result = failed;
	} finally {
		controller.abort();
		try {
			sdk?.close();
		} catch {
			result = failed;
		}
		try {
			if ( child && ! ( await settleNativeProcess( child ) ) ) result = failed;
			await server?.instance.close();
		} catch {
			result = failed;
		}
	}
	return result;
}

export async function runClaudeTurn(
	snapshot: ClaudeBackendTurnSnapshot,
	host: StudioAgentHost,
	input: RuntimeInput,
	options: RuntimeOptions
): Promise< void > {
	const { runId, turnId, workspace, selection } = snapshot;
	const fail = (): TerminalEvent => ( {
		type: 'turn.terminal',
		runId,
		turnId,
		outcome: {
			status: 'error',
			message: 'Claude Code could not start or safely complete this turn.',
		},
	} );
	const rebind = (
		message = 'The original Claude workspace or native history could not be verified. Start a new Claude chat to continue.'
	): TerminalEvent => ( {
		type: 'turn.terminal',
		runId,
		turnId,
		outcome: {
			status: 'error',
			code: 'rebind_required',
			message,
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
	let terminal: TerminalEvent | undefined;
	let detached = false;
	let connectionWatch: ReturnType< typeof setTimeout > | undefined;
	const failIfSuccessful = () => {
		if ( ! terminal || terminal.outcome.status === 'success' ) terminal = fail();
	};
	let nativeInitAccepted = false;
	let journal: ReturnType< ReturnType< typeof createNativeSessionStore >[ 'journal' ] > | undefined;
	let journalWork = Promise.resolve();
	let journalFailed = false;
	try {
		if ( input.signal.aborted ) throw new Error();
		const store = createNativeSessionStore( options.storeRoot );
		try {
			release = await store.lockTurn( workspace.conversationId );
		} catch ( error ) {
			if ( ( error as NodeJS.ErrnoException ).code !== 'EEXIST' ) throw error;
			terminal = rebind(
				'This chat still has a Claude run lock. Confirm the earlier native process has exited before starting another chat.'
			);
			return;
		}
		if (
			( await store.isPendingDeletion( workspace.conversationId ) ) ||
			( options.verifySession && ! ( await options.verifySession( snapshot ) ) )
		) {
			throw new Error( 'The Studio chat was deleted or changed before the turn started' );
		}
		journal = store.journal( workspace.conversationId, turnId );
		const images = validateStudioChatImages( input.images );
		const findConnection = options.connection ?? findSavedConnection;
		const connection = await findConnection( selection.connectionId );
		if ( ! connection ) {
			terminal = rebind(
				'This Claude Code connection was detached. Select a connection and start a new Claude chat.'
			);
			return;
		}
		const site = ( await host.sites.all() ).find(
			( candidate ) => candidate.id === workspace.siteId
		);
		if (
			! site ||
			( await realpath( site.path ).catch( () => undefined ) ) !== workspace.workingDirectory ||
			( await realpath( workspace.configDirectory ).catch( () => undefined ) ) !==
				workspace.configDirectory
		) {
			terminal = rebind();
			return;
		}
		const prepared = await ( options.prepare ?? prepareClaudeInvocation )(
			connection.executablePath,
			workspace.workingDirectory,
			connection.configDirectory
		);
		if ( ! prepared.ok ) throw new Error();
		if (
			prepared.cwd !== workspace.workingDirectory ||
			prepared.configDirectory !== workspace.configDirectory
		) {
			terminal = rebind();
			return;
		}
		const stillConnected = async () => {
			const current = await findConnection( selection.connectionId );
			return (
				!! current &&
				current.executablePath === connection.executablePath &&
				current.configDirectory === connection.configDirectory
			);
		};
		const watchConnection = async () => {
			const connected = await stillConnected().catch( () => false );
			if ( controller.signal.aborted ) return;
			if ( ! connected ) {
				detached = true;
				controller.abort();
				return;
			}
			connectionWatch = setTimeout( () => void watchConnection(), 1000 ).unref();
		};
		let existing;
		try {
			existing = await store.load( workspace.conversationId );
			if (
				! existing &&
				( await store.readJournals( workspace.conversationId ) ).some( ( events ) =>
					events.some(
						( event ) => event.type !== 'turn.terminal' || event.outcome.status === 'success'
					)
				)
			) {
				terminal = rebind();
				return;
			}
		} catch {
			terminal = rebind();
			return;
		}
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
		) {
			terminal = rebind();
			return;
		}
		const session = existing ?? {
			backend: 'claude-code' as const,
			...binding,
			nativeSessionId: randomUUID(),
		};
		const emit = ( event: BackendTurnEvent ) => {
			if ( event.type === 'turn.terminal' ) {
				terminal ??= event;
				return;
			}
			journalWork = journalWork
				.then( () => journal!.append( event ) )
				.catch( () => {
					journalFailed = true;
					controller.abort();
				} );
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
		const nativeInput = async function* (): AsyncGenerator< SDKUserMessage > {
			if ( ( await gate ) && ! controller.signal.aborted )
				yield {
					type: 'user' as const,
					message: {
						role: 'user',
						content: images.length
							? [
									{ type: 'text', text: input.prompt },
									...images.map( ( image ) => ( {
										type: 'image' as const,
										source: {
											type: 'base64' as const,
											media_type: image.mimeType,
											data: image.dataBase64,
										},
									} ) ),
							  ]
							: input.prompt,
					},
					parent_tool_use_id: null,
					session_id: session.nativeSessionId,
					client_composed: true as const,
				};
		};
		const effort = snapshot.effort;
		if ( ! isClaudeEffort( effort ) ) throw new Error();
		native = ( options.query ?? sdkQuery )( {
			prompt: nativeInput(),
			options: {
				...nativeLaunchOptions( prepared, controller, ( child ) => {
					ownedChild = child;
				} ),
				...( existing
					? { resume: session.nativeSessionId }
					: { sessionId: session.nativeSessionId } ),
				model: selection.model.modelId,
				effort,
				includePartialMessages: true,
				mcpServers: { studio: bridge.server },
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
		const qualification = await qualifyWithinDeadline(
			native,
			prepared.identity,
			controller.signal,
			selection.model.modelId,
			effort
		);
		if ( ! qualification.ok || controller.signal.aborted || ! ( await stillConnected() ) )
			throw new Error();
		if ( ! existing ) await store.create( session );
		if ( controller.signal.aborted || ! ( await stillConnected() ) ) throw new Error();
		const submitted = { type: 'turn.prompt' as const, runId, turnId, text: input.prompt };
		await journal.append( submitted );
		if ( controller.signal.aborted || ! ( await stillConnected() ) ) throw new Error();
		input.onEvent( submitted );
		connectionWatch = setTimeout( () => void watchConnection(), 1000 ).unref();
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
					message.claude_code_version !== QUALIFIED_CLAUDE_CODE_VERSION ||
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
		terminal ??=
			input.signal.aborted || detached
				? { type: 'turn.terminal', runId, turnId, outcome: { status: 'interrupted' } }
				: fail();
	} finally {
		openGate( false );
		controller.abort();
		clearTimeout( connectionWatch );
		try {
			native?.close();
		} catch {
			failIfSuccessful();
		}
		let stopped = true;
		try {
			if ( ownedChild ) stopped = await settleNativeProcess( ownedChild );
		} catch {
			stopped = false;
		}
		try {
			await bridge?.dispose();
		} catch {
			failIfSuccessful();
		}
		terminal ??= {
			type: 'turn.terminal',
			runId,
			turnId,
			outcome: {
				status: input.signal.aborted || detached ? 'interrupted' : 'unknown_process_exit',
			},
		};
		if ( detached && terminal.outcome.status === 'interrupted' ) {
			terminal.outcome.message = 'Claude Code was detached during this turn.';
		}
		if ( ! stopped ) failIfSuccessful();
		try {
			await journalWork;
			if ( journalFailed ) failIfSuccessful();
			await journal?.append( terminal );
		} catch {
			failIfSuccessful();
		}
		if ( stopped )
			try {
				await release?.();
			} catch {
				failIfSuccessful();
			}
		clearTimeout( timer );
		input.signal.removeEventListener( 'abort', cancel );
		input.onEvent( terminal );
	}
}
