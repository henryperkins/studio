import { randomUUID } from 'crypto';
import { realpath } from 'fs/promises';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk/core';
import { prepareProcessOwner, readOwnProcessIdentity } from '@studio/common/lib/owned-process';
import { __ } from '@wordpress/i18n';
import { validateStudioChatImages } from '@studio/agent/protocol/chat-images';
import {
	isClaudeEffort,
	isClaudeModelId,
	isClaudeTargetAllowed,
} from '@studio/agent/protocol/claude-code';
import { claudeAccountKey, compareClaudeExecutionAuth, isSameClaudeAccount } from './auth-status';
import {
	claudeConnectionRevision,
	getClaudeConnections,
	prepareClaudeInvocation,
	readClaudeAccountStatus,
} from './connection';
import { QUALIFIED_CLAUDE_CODE_VERSION } from './discovery';
import { createClaudeEventAdapter } from './event-adapter';
import { createClaudeExecutionPolicy } from './execution-policy';
import {
	CLAUDE_APPROVAL_TIMEOUT_MS,
	CLAUDE_ENABLED_TOOLS,
	CLAUDE_HOOK_TIMEOUT_SECONDS,
	CLAUDE_NAVIGATION_CONFINEMENT,
	CLAUDE_SHELL_CONFINEMENT,
	claudeNativeTools,
	claudeTargetOrigin,
	claudeToolInventory,
} from './execution-rules';
import { isClaudeExecutableUnchanged } from './platform';
import { createNativeSessionStore, getClaudeGlobalWorkspace } from './sessions';
import { createStudioClaudeMcpServer, createStudioClaudeToolBridge } from './tool-bridge';
import type { ClaudeAuthIdentity } from './auth-status';
import type { ClaudeAccountStatus, ClaudeAccountStatusRequest } from './connection';
import type { ClaudeAccountCheck, ClaudeApprover } from './execution-policy';
import type { ClaudeExecutableIdentity } from './platform';
import type { StudioAgentHost } from '../host';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk/core';
import type {
	BackendTurnEvent,
	ClaudeBackendTurnSnapshot,
	ClaudeJournalEvent,
	ClaudeRecoveryJournalEvent,
	ClaudeTurnJournalEvent,
} from '@studio/agent/protocol/backend-events';
import type { StudioChatImage } from '@studio/agent/protocol/chat-images';
import type { ClaudeModelOption, ClaudeStudioTarget } from '@studio/agent/protocol/claude-code';
import type {
	OwnedProcess,
	OwnershipFailure,
	ProcessIdentity,
	ProcessOwner,
} from '@studio/common/lib/owned-process';

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
			/** The file inspection qualified; the native process is spawned only while it is unchanged. */
			executableIdentity: ClaudeExecutableIdentity;
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
	) => Promise<
		{ id: string; executablePath: string; configDirectory?: string; revision?: number } | undefined
	>;
	prepare?: ( exe: string, cwd: string, config?: string ) => Promise< Prepared >;
	/** The native sign-in now, read with the prepared binary from the runtime's own status. */
	account?: ( request: ClaudeAccountStatusRequest ) => Promise< ClaudeAccountStatus >;
	clock?: () => number;
	/** Prepares the ownership the native process is started under. */
	prepareOwner?: () => ProcessOwner;
	/** This process's identity, which the run lock records as its owner. */
	ownerIdentity?: () => Promise< ProcessIdentity | undefined >;
}

interface RuntimeOptions extends RuntimeDependencies {
	storeRoot: string;
	approve: ClaudeApprover;
	verifySession?: ( snapshot: ClaudeBackendTurnSnapshot ) => Promise< boolean >;
	/** Whether the conversation still has the turn's native binding and the expected target. */
	verifyTarget: (
		snapshot: ClaudeBackendTurnSnapshot,
		expected: ClaudeStudioTarget
	) => Promise< boolean >;
}

type TerminalEvent = Extract< BackendTurnEvent, { type: 'turn.terminal' } >;

async function findSavedConnection( id: string ) {
	return ( await getClaudeConnections() ).find( ( item ) => item.id === id );
}

interface NativeLaunch {
	owner: ProcessOwner;
	supervise: boolean;
	/** Called on every spawn request, before any check. */
	onRequested: () => void;
	onOwned: ( owned: OwnedProcess ) => void;
	/** Said to Claude for this turn only, after Studio's standing instructions. */
	instructions?: string;
}

const STUDIO_INSTRUCTIONS =
	'Work only in the current local WordPress site. Use Studio tools for WordPress operations. Do not publish or access production.';

const oneLine = ( text: unknown ) => String( text ).replace( /\s+/g, ' ' ).trim();

/**
 * What the first turn after a recovery tells Claude, once: that the previous
 * turn was interrupted and nothing was replayed; and, when operations of it
 * may or may not have taken effect, which ones, and to inspect the current
 * state before repeating any of them. Covers every recovery no prompt has
 * carried yet; undefined when there is none.
 */
function recoveryNote(
	journals: ClaudeJournalEvent[][]
): { text: string; locks: string[] } | undefined {
	const events = journals.flat();
	const noted = new Set(
		events.flatMap( ( event ) => ( event.type === 'turn.recovery-noted' ? event.locks : [] ) )
	);
	const recoveries = events.filter(
		( event ): event is ClaudeRecoveryJournalEvent =>
			event.type === 'turn.recovered' && ! noted.has( event.lock )
	);
	if ( ! recoveries.length ) return;
	const uncertain = [
		...new Set(
			recoveries.flatMap( ( recovery ) =>
				( Array.isArray( recovery.uncertainOperations ) ? recovery.uncertainOperations : [] ).map(
					( operation ) => {
						const tool = oneLine( operation.tool );
						let description = tool;
						if ( typeof operation.description === 'string' )
							description = oneLine( operation.description );
						else if ( operation.evidence === 'started' )
							description = `Run an operation Studio does not recognize: ${ tool }`;
						return description.includes( tool )
							? `- ${ description }`
							: `- ${ description } (${ tool })`;
					}
				)
			)
		),
	];
	const lines = [
		'Studio note: Claude Code stopped before the previous turn of this conversation finished, so that turn was interrupted. Studio recovered the conversation and replayed nothing from that turn.',
	];
	if ( uncertain.length )
		lines.push(
			'These operations of the interrupted turn may or may not have taken effect:',
			...uncertain,
			'Before repeating any of them, inspect the current state to see whether it already took effect. Do not repeat any of them automatically: repeat one only when the user’s request still needs it and your inspection shows that it did not take effect.'
		);
	return { text: lines.join( '\n' ), locks: recoveries.map( ( recovery ) => recovery.lock ) };
}

function nativeLaunchOptions(
	prepared: Extract< Prepared, { ok: true } >,
	controller: AbortController,
	launch: NativeLaunch
): Options {
	const env = { ...prepared.env, CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1' };
	return {
		abortController: controller,
		pathToClaudeCodeExecutable: prepared.executablePath,
		cwd: prepared.cwd,
		env,
		spawnClaudeCodeProcess: ( invocation ) => {
			launch.onRequested();
			if (
				! isQualifiedClaudeSpawn( invocation, {
					command: prepared.executablePath,
					cwd: prepared.cwd,
					env,
				} ) ||
				! isClaudeExecutableUnchanged( prepared.executableIdentity )
			)
				throw new Error( 'Unexpected native process invocation' );
			const owned = launch.owner.spawn( invocation.command, invocation.args, {
				cwd: invocation.cwd,
				env: invocation.env,
				supervise: launch.supervise,
			} );
			launch.onOwned( owned );
			// The SDK aborts this once it stops waiting for the process to exit;
			// escalation stays with the owned shutdown, within the owned tree.
			invocation.signal?.addEventListener( 'abort', () => void owned.requestShutdown(), {
				once: true,
			} );
			owned.child.stderr.resume();
			return owned.child;
		},
		tools: claudeNativeTools( CLAUDE_ENABLED_TOOLS, CLAUDE_SHELL_CONFINEMENT, prepared.cwd ),
		...( CLAUDE_SHELL_CONFINEMENT.mode === 'sandbox'
			? { sandbox: CLAUDE_SHELL_CONFINEMENT.sandbox }
			: {} ),
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
			append: [ STUDIO_INSTRUCTIONS, launch.instructions ].filter( Boolean ).join( '\n\n' ),
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

// Settles with `work`, or with undefined as soon as `signal` aborts.
function untilAborted< T >( work: Promise< T >, signal: AbortSignal ): Promise< T | undefined > {
	if ( signal.aborted ) return Promise.resolve( undefined );
	return new Promise( ( resolve, reject ) => {
		const stop = () => resolve( undefined );
		signal.addEventListener( 'abort', stop, { once: true } );
		work.then(
			( value ) => {
				signal.removeEventListener( 'abort', stop );
				resolve( value );
			},
			( error ) => {
				signal.removeEventListener( 'abort', stop );
				reject( error );
			}
		);
	} );
}

function unownedMessage( failure: OwnershipFailure | undefined ): string {
	const message = __(
		'Studio could not take ownership of the Claude Code process, so nothing was sent.'
	);
	let reason: string | undefined;
	if ( failure === 'keeper-blocked' )
		reason = __(
			'Windows PowerShell does not run in Full Language mode here, which Studio’s process keeper needs.'
		);
	else if ( failure === 'keeper-unavailable' )
		reason = __( 'Windows PowerShell could not start Studio’s process keeper.' );
	else if ( failure === 'keeper-timeout' )
		reason = __( 'Studio’s process keeper did not answer in time.' );
	else if ( failure?.startsWith( 'job-' ) )
		reason = __( 'Windows did not let Studio put Claude Code in a job object it controls.' );
	return reason ? `${ message } ${ reason }` : message;
}

function unconfirmedMessage(): string {
	return __(
		'Studio could not confirm that every process of this Claude Code turn has ended, so this chat stays locked until it is recovered.'
	);
}

function journalUnreadableMessage(): string {
	return __( 'Studio could not read this chat’s history just now. Try again.' );
}

export async function discoverClaudeModels(
	connectionId: string,
	workingDirectory: string,
	dependencies: RuntimeDependencies = {}
) {
	const failed = { ok: false as const, blockers: [ 'native-runtime-unqualified' ] };
	const controller = new AbortController();
	let owner: ProcessOwner | undefined;
	let owned: OwnedProcess | undefined;
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
		owner = ( dependencies.prepareOwner ?? prepareProcessOwner )();
		if ( ! ( await owner.prepared() ) ) return failed;
		server = createStudioClaudeMcpServer( async () => ( { content: [], isError: true } ) );
		sdk = ( dependencies.query ?? sdkQuery )( {
			prompt: { [ Symbol.asyncIterator ]: () => ( { next: () => done } ) },
			options: {
				// Discovery sends no prompt, so nothing it starts can run a tool; it
				// also runs in the Desktop's main process, which is not a Node binary
				// a POSIX supervisor could run on.
				...nativeLaunchOptions( prepared, controller, {
					owner,
					supervise: false,
					onRequested: () => {},
					onOwned: ( started ) => {
						owned = started;
					},
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
		// Models are reported only from a native process Studio owns, as a turn
		// sends its prompt only to one.
		if (
			qualification.ok &&
			owned &&
			( await owned.ready() ) &&
			( await findConnection( connectionId ) )
		) {
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
			if ( owned ) {
				if ( ! ( await owned.shutdown() ) ) result = failed;
			} else await owner?.dispose();
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
	const { runId, turnId, workspace, selection, target } = snapshot;
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
	const unowned = ( failure: OwnershipFailure | undefined ): TerminalEvent => ( {
		type: 'turn.terminal',
		runId,
		turnId,
		outcome: {
			status: 'error',
			code: 'process_unowned',
			message: unownedMessage( failure ),
		},
	} );
	// The run lock stays: the turn says so, after whatever it said already.
	const unconfirmed = ( previous: TerminalEvent ): TerminalEvent => ( {
		type: 'turn.terminal',
		runId,
		turnId,
		outcome: {
			status: previous.outcome.status === 'interrupted' ? 'interrupted' : 'error',
			code: 'process_unconfirmed',
			message: [ previous.outcome.message, unconfirmedMessage() ].filter( Boolean ).join( ' ' ),
		},
	} );
	const controller = new AbortController();
	let policy: ReturnType< typeof createClaudeExecutionPolicy > | undefined;
	// Stopping first makes the policy refuse every new operation and end every
	// pending approval; only then does the native process hear of it.
	const cancel = () => {
		policy?.dispose();
		controller.abort();
	};
	input.signal.addEventListener( 'abort', cancel, { once: true } );
	const timer = setTimeout( cancel, 30 * 60 * 1000 );
	let release: ( () => Promise< void > ) | undefined;
	let native: ReturnType< typeof sdkQuery > | undefined;
	let owner: ProcessOwner | undefined;
	let owned: OwnedProcess | undefined;
	// Settles once the owned process is confirmed and recorded in the run lock,
	// or found not to be.
	let ownership: Promise< 'recorded' | 'unowned' | 'unrecorded' > | undefined;
	// Whether the SDK asked Studio's spawn hook for its process; one that never
	// did may have started a process Studio knows nothing of.
	let spawnRequested = false;
	let bridge: ReturnType< typeof createStudioClaudeToolBridge > | undefined;
	let openGate: ( allow: boolean ) => void = () => {};
	const gate = new Promise< boolean >( ( resolve ) => {
		openGate = resolve;
	} );
	let terminal: TerminalEvent | undefined;
	let stopReason: 'detached' | 'account' | 'account-unverified' | undefined;
	const stop = ( reason: 'detached' | 'account' | 'account-unverified' ) => {
		stopReason ??= reason;
		cancel();
	};
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
		// A lock that cannot name its owner could never be recovered, so no turn starts without one.
		const ownerIdentity = await ( options.ownerIdentity ?? readOwnProcessIdentity )();
		if ( ! ownerIdentity ) throw new Error();
		let lock: Awaited< ReturnType< typeof store.lockRun > >;
		try {
			lock = await store.lockRun( workspace.conversationId, {
				owner: ownerIdentity,
				runId,
				turnId,
				connection: { id: selection.connectionId, revision: selection.revision },
				workspace: {
					siteId: workspace.siteId,
					workingDirectory: workspace.workingDirectory,
					configDirectory: workspace.configDirectory,
				},
			} );
			release = () => lock.release();
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
		if ( claudeConnectionRevision( connection ) !== selection.revision ) {
			terminal = {
				type: 'turn.terminal',
				runId,
				turnId,
				outcome: {
					status: 'error',
					message: 'The Claude Code connection changed after this message was sent. Send it again.',
				},
			};
			return;
		}
		const canonical = ( directory: string ) => realpath( directory ).catch( () => undefined );
		const sites = await host.sites.all();
		const expectedWorkspace =
			workspace.siteId === null
				? getClaudeGlobalWorkspace( options.storeRoot )
				: sites.find( ( candidate ) => candidate.id === workspace.siteId )?.path;
		if (
			! isClaudeTargetAllowed( workspace.siteId, target ) ||
			! expectedWorkspace ||
			( await canonical( expectedWorkspace ) ) !== workspace.workingDirectory ||
			( await canonical( workspace.configDirectory ) ) !== workspace.configDirectory
		) {
			terminal = rebind();
			return;
		}
		let targetSite: { id: string; path: string; url: string } | undefined;
		if ( target.environment !== 'global' ) {
			const site = sites.find( ( candidate ) => candidate.id === target.siteId );
			const sitePath = site && ( await canonical( site.path ) );
			if ( ! sitePath ) {
				terminal = {
					type: 'turn.terminal',
					runId,
					turnId,
					outcome: {
						status: 'error',
						message:
							'The site this chat works on is unavailable. Choose another target or start a new chat.',
					},
				};
				return;
			}
			targetSite = { id: target.siteId, path: sitePath, url: site.url };
		}
		// Prepared now, so the job exists by the time the native process starts.
		owner = ( options.prepareOwner ?? prepareProcessOwner )();
		const clock = options.clock ?? Date.now;
		const accountVerifiedAt = clock();
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
		const accountKey = claudeAccountKey( prepared.identity );
		const stillConnected = async () => {
			const current = await findConnection( selection.connectionId );
			return (
				!! current &&
				current.executablePath === connection.executablePath &&
				current.configDirectory === connection.configDirectory &&
				claudeConnectionRevision( current ) === selection.revision
			);
		};
		// Ends the turn, and with it every pending approval, once the connection
		// is detached or re-established.
		const verifyConnection = async () => {
			if ( await stillConnected().catch( () => false ) ) return true;
			stop( 'detached' );
			return false;
		};
		// Reads the native sign-in the runtime would use now, with the prepared
		// binary only. Another account ends the turn; a status that cannot be
		// read, or a selected path that no longer leads to that binary, ends it
		// too, but says so.
		const verifyAccount = async (): Promise< ClaudeAccountCheck > => {
			const status = await ( options.account ?? readClaudeAccountStatus )( {
				selectedPath: connection.executablePath,
				executablePath: prepared.executablePath,
				executableIdentity: prepared.executableIdentity,
				cwd: prepared.cwd,
				configDirectory: connection.configDirectory,
			} ).catch( (): ClaudeAccountStatus => ( { state: 'unavailable' } ) );
			if (
				status.state === 'signed-in' &&
				isSameClaudeAccount( prepared.identity, status.identity )
			)
				return 'same';
			if ( status.state === 'unavailable' ) {
				stop( 'account-unverified' );
				return 'unverified';
			}
			stop( 'account' );
			return 'changed';
		};
		let journals: ClaudeJournalEvent[][];
		try {
			journals = await store.readJournals( workspace.conversationId );
		} catch {
			// Without its journal, Studio cannot tell whether an earlier turn was
			// interrupted. The next turn reads it again.
			terminal = {
				type: 'turn.terminal',
				runId,
				turnId,
				outcome: {
					status: 'error',
					code: 'journal_unreadable',
					message: journalUnreadableMessage(),
				},
			};
			return;
		}
		let existing;
		try {
			existing = await store.load( workspace.conversationId );
			if (
				! existing &&
				journals.some( ( events ) =>
					events.some(
						( event ) =>
							event.type !== 'turn.recovered' &&
							( event.type !== 'turn.terminal' || event.outcome.status === 'success' )
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
		const note = recoveryNote( journals );
		if ( existing?.accountKey && existing.accountKey !== accountKey ) {
			terminal = rebind(
				'This chat belongs to another Claude account. Sign that account back in, or start a new chat.'
			);
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
			...( accountKey ? { accountKey } : {} ),
		};
		// Journal-only, after everything emitted before it, and on disk when it settles.
		const journalOnly = ( event: ClaudeTurnJournalEvent ): Promise< void > => {
			const written = journalWork.then( () => journal!.append( event ) );
			journalWork = written.catch( () => {
				journalFailed = true;
				cancel();
			} );
			return written;
		};
		// The recovery note counts as given once Claude has answered the prompt
		// that carried it: at its first answer accepted from the SDK, or at the
		// turn's successful end. A turn that ends before either leaves the note
		// for the next turn; a crash before this mark is on disk gives it again.
		let noteGiven = false;
		const markNoteGiven = () => {
			if ( ! note || noteGiven ) return;
			noteGiven = true;
			void journalOnly( { type: 'turn.recovery-noted', runId, turnId, locks: note.locks } ).catch(
				() => {}
			);
		};
		const emit = ( event: BackendTurnEvent ) => {
			if ( event.type === 'turn.terminal' ) {
				if ( event.outcome.status === 'success' ) markNoteGiven();
				terminal ??= event;
				return;
			}
			journalWork = journalWork
				.then( () => journal!.append( event ) )
				.catch( () => {
					journalFailed = true;
					cancel();
				} );
			input.onEvent( event );
		};
		policy = createClaudeExecutionPolicy( {
			runId,
			turnId,
			connectionId: selection.connectionId,
			connectionRevision: selection.revision,
			policyRevision: snapshot.permissionPolicyRevision,
			target,
			workspace: {
				siteId: workspace.siteId,
				workingDirectory: prepared.cwd,
				configDirectory: prepared.configDirectory,
			},
			targetSite,
			localRoots:
				targetSite && targetSite.path !== prepared.cwd
					? [ prepared.cwd, targetSite.path ]
					: [ prepared.cwd ],
			enabledTools: CLAUDE_ENABLED_TOOLS,
			shellConfinement: CLAUDE_SHELL_CONFINEMENT,
			navigationConfinement: CLAUDE_NAVIGATION_CONFINEMENT,
			signal: controller.signal,
			approve: options.approve,
			approvalTimeoutMs: CLAUDE_APPROVAL_TIMEOUT_MS,
			ready: () => nativeInitAccepted,
			stillConnected: verifyConnection,
			verifyAccount,
			accountVerifiedAt,
			now: clock,
			verifyTarget: ( expected ) => options.verifyTarget( snapshot, expected ),
			onEvent: emit,
			recordOperation: journalOnly,
		} );
		const guard = policy;
		bridge = createStudioClaudeToolBridge( host, { runId, turnId, policy: guard }, emit );
		const watchConnection = async () => {
			const unchanged = ( await verifyConnection() ) && ( await guard.refreshAccount() );
			if ( controller.signal.aborted || ! unchanged ) return;
			connectionWatch = setTimeout( () => void watchConnection(), 1000 ).unref();
		};
		const nativeInput = async function* (): AsyncGenerator< SDKUserMessage > {
			if ( ! ( await gate ) || controller.signal.aborted ) return;
			// The recovery note goes to Claude with this prompt. It is marked as given
			// only once Claude answers (`markNoteGiven`), so it may be given again,
			// but is never lost to a turn that failed before Claude read it.
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
		// The keeper may take a while to create the job; a cancel ends the wait,
		// and nothing is started after it.
		const jobPrepared = await untilAborted( owner.prepared(), controller.signal );
		if ( controller.signal.aborted ) throw new Error();
		if ( ! jobPrepared ) {
			terminal = unowned( owner.failure() );
			return;
		}
		// The SDK starts its process inside `query`, so the lock says so first.
		await lock.update( {
			stage: 'starting',
			session: { nativeSessionId: session.nativeSessionId, resume: !! existing },
		} );
		if ( controller.signal.aborted ) throw new Error();
		const processOwner = owner;
		native = ( options.query ?? sdkQuery )( {
			prompt: nativeInput(),
			options: {
				...nativeLaunchOptions( prepared, controller, {
					owner: processOwner,
					supervise: true,
					onRequested: () => {
						spawnRequested = true;
					},
					instructions: note?.text,
					onOwned: ( started ) => {
						owned = started;
						ownership = started.ready().then(
							async ( ready ) => {
								const identity = started.identity();
								if ( ! ready ) return 'unowned';
								if ( ! identity ) return 'unrecorded';
								// Without the helper that guards the tree, a recovery could
								// never prove the tree ended, so no prompt goes to it.
								const guardian = await started.guardian();
								if ( ! guardian ) return 'unowned';
								await lock.update( {
									stage: 'owned',
									processes: { native: identity, guardian },
								} );
								return 'recorded';
							},
							() => 'unowned' as const
						);
						ownership = ownership.catch( () => 'unrecorded' as const );
					},
				} ),
				...( existing
					? { resume: session.nativeSessionId }
					: { sessionId: session.nativeSessionId } ),
				model: selection.model.modelId,
				effort,
				includePartialMessages: true,
				mcpServers: { studio: bridge.server },
				// The hook and the permission request each apply the whole policy, so
				// a native allow rule that skips one cannot skip the Studio guard.
				canUseTool: async ( name, toolInput, { mcpServer, toolUseID, signal } ) =>
					( await guard.authorizeToolUse(
						{ toolName: name, input: toolInput, toolUseId: toolUseID, mcpServer },
						signal
					) )
						? { behavior: 'allow', updatedInput: toolInput }
						: { behavior: 'deny', message: 'Tool unavailable.' },
				hooks: {
					PreToolUse: [
						{
							onFailure: 'block',
							// An approval waits inside this hook, so the hook outlasts it.
							// If Claude Code still gives up on the hook, the hook's
							// signal cancels the approval and the tool use is never
							// asked about again.
							timeout: CLAUDE_HOOK_TIMEOUT_SECONDS,
							hooks: [
								async ( hook, _toolUseId, context ) => ( {
									hookSpecificOutput: {
										hookEventName: 'PreToolUse',
										permissionDecision:
											hook.hook_event_name === 'PreToolUse' &&
											( await guard.authorizeToolUse(
												{
													toolName: hook.tool_name,
													input: hook.tool_input,
													toolUseId: hook.tool_use_id,
													mcpServer: hook.mcp_server,
												},
												context?.signal
											) )
												? 'allow'
												: 'deny',
									},
								} ),
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
		// No prompt reaches a native process whose tree Studio could not take
		// ownership of, nor one the SDK started without Studio's spawn hook,
		// nor one the run lock does not name for a later recovery.
		const owning = ownership ? await ownership : 'unowned';
		if ( ! owned || owning === 'unowned' ) {
			terminal = unowned( owned?.failure() );
			return;
		}
		if ( owning !== 'recorded' ) throw new Error();
		if ( ! accountKey ) throw new Error();
		if ( ! existing ) await store.create( session );
		else if ( ! existing.accountKey )
			await store.bindAccount( workspace.conversationId, accountKey );
		if ( controller.signal.aborted || ! ( await stillConnected() ) ) throw new Error();
		const submitted = { type: 'turn.prompt' as const, runId, turnId, text: input.prompt };
		await journal.append( submitted );
		if ( controller.signal.aborted || ! ( await stillConnected() ) ) throw new Error();
		input.onEvent( submitted );
		connectionWatch = setTimeout( () => void watchConnection(), 1000 ).unref();
		openGate( true );
		const adapter = createClaudeEventAdapter( runId, turnId, emit );
		const inventory = claudeToolInventory(
			CLAUDE_ENABLED_TOOLS,
			CLAUDE_SHELL_CONFINEMENT,
			prepared.cwd,
			CLAUDE_NAVIGATION_CONFINEMENT,
			claudeTargetOrigin( target, targetSite )
		);
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
					message.tools.some( ( name ) => ! inventory.includes( name ) ) ||
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
			if ( message.type === 'assistant' ) {
				if ( ! qualification.acceptedModels.includes( message.message.model ) ) throw new Error();
				markNoteGiven();
			}
			if ( message.type === 'result' && message.subtype === 'success' && ! nativeInitAccepted )
				throw new Error();
			adapter.accept( message as unknown as Record< string, unknown > );
			if ( terminal ) break;
		}
	} catch {
		terminal ??=
			input.signal.aborted || stopReason
				? { type: 'turn.terminal', runId, turnId, outcome: { status: 'interrupted' } }
				: fail();
	} finally {
		// The policy first, then a graceful stop (the SDK ends the native input),
		// then a bounded wait and escalation within the owned tree only.
		policy?.dispose();
		openGate( false );
		controller.abort();
		clearTimeout( connectionWatch );
		try {
			native?.close();
		} catch {
			failIfSuccessful();
		}
		// The run lock is released only on proof that nothing of the run remains.
		let stopped = true;
		try {
			if ( owned ) stopped = await owned.shutdown();
			else {
				await owner?.dispose();
				// The SDK was started but never asked the spawn hook for its
				// process, so whatever it started is not Studio's to prove gone.
				if ( native && ! spawnRequested ) stopped = false;
			}
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
				status: input.signal.aborted || stopReason ? 'interrupted' : 'unknown_process_exit',
			},
		};
		if ( stopReason && terminal.outcome.status === 'interrupted' ) {
			if ( stopReason === 'account' ) {
				terminal.outcome.code = 'account_changed';
				terminal.outcome.message =
					'The Claude account changed during this turn. Sign the original account back in, or start a new chat.';
			} else if ( stopReason === 'account-unverified' ) {
				terminal.outcome.code = 'account_unverified';
				terminal.outcome.message =
					'Studio could not verify the Claude account, so this turn stopped. Check the Claude Code sign-in and send again.';
			} else terminal.outcome.message = 'Claude Code was detached during this turn.';
		}
		if ( ! stopped ) terminal = unconfirmed( terminal );
		try {
			await journalWork;
			if ( journalFailed ) failIfSuccessful();
			await journal?.append( terminal );
		} catch {
			failIfSuccessful();
		}
		// A lock update still recording ownership settles first: the release
		// follows it on the lock, never the other way round.
		await ownership;
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
