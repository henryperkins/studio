import { fork, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import {
	ChatGptConnectionError,
	isChatGptRegistrationId,
	readChatGptAccount,
	type ChatGptAccount,
	type ChatGptConnectionErrorCode,
} from '@studio/agent/node/chatgpt/account-store';
import {
	answerChatGptSessionTokenInvalidation,
	answerChatGptSessionTokenRequest,
	CHATGPT_TURN_WATCH_POLL_MS,
	createChatGptCredentialBroker,
	getChatGptAccessToken,
	getChatGptSessionForkEnvironment,
	invalidateChatGptAccessToken,
	setChatGptTokenClient,
	signOutChatGpt,
	type ChatGptTokenClient,
	type ChatGptTokenServiceResult,
	type ChatGptTokenSet,
} from '@studio/agent/node/chatgpt/credential-broker';
import {
	CHATGPT_SIGN_IN_TIMEOUT_MS,
	ChatGptSignInError,
	createChatGptSignInFlow,
} from '@studio/agent/node/chatgpt/oauth';
import { ChatGptSettingsError, readChatGptModels } from '@studio/agent/node/chatgpt/settings';
import { getChatGptVaultKeyAccounts } from '@studio/agent/node/chatgpt/state-directory';
import { createChatGptTokenClient } from '@studio/agent/node/chatgpt/token-client';
import { isImageGenerationAvailable } from '@studio/agent/node/image-generation';
import { setSessionChatGptSelection } from '@studio/agent/node/sessions/chatgpt-selection';
import { createAiSession, loadAiSession } from '@studio/agent/node/sessions/store';
import {
	CHATGPT_MODEL_CAPABILITIES,
	describeChatGptReasoningProblem,
	getDefaultChatGptReasoningEffort,
	resolveChatGptReasoning,
} from '@studio/agent/protocol/chatgpt-models';
import {
	describeConnectionSelectionError,
	type ChatGptModelAvailability,
} from '@studio/agent/protocol/connections';
import { getAgentEndFailure, type JsonEvent } from '@studio/agent/protocol/json-events';
import {
	createOsCredentialStore,
	credentialStoreKindFor,
	type CredentialStoreKind,
} from '@studio/common/lib/os-credential-store';
import { getConfigDirectory, getSessionsDirectory } from '@studio/common/lib/well-known-paths';
import { __, _n, sprintf } from '@wordpress/i18n';
import {
	AcceptanceManifestError,
	findUnsafeText,
	isManifestVersion,
	openAcceptanceEvidence,
	UnsafeEvidenceError,
	type AcceptanceEvidence,
	type ManifestRun,
	type Observations,
	type StageRecord,
	type StageStatus,
} from 'cli/ai/acceptance-evidence';
import {
	acceptanceStartsNewRun,
	applyAcceptanceIsolation,
	findRealProfileHazard,
	findRealProfileLeak,
	isInsideAcceptanceRun,
	type AcceptanceIsolationProblem,
	type AcceptanceRunPaths,
	type RealProfileHazard,
} from 'cli/ai/acceptance-isolation';
import { endProcessTree, hasExited } from 'cli/ai/acceptance-process-tree';
import {
	ACCEPTANCE_OBSERVER_FILE_ENV,
	installAcceptanceObserver,
	readObservedLines,
	type ObservedRequest,
	type ObservedResponse,
} from 'cli/ai/chatgpt-acceptance-observer';
import { openBrowser } from 'cli/lib/browser';
import { PROCESS_MANAGER_HOME } from 'cli/lib/paths';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ChatGptSignInOutcome } from '@studio/agent/protocol/chatgpt';

/**
 * Development only: reproducible acceptance of the ChatGPT plan provider
 * against a real account, in a run directory of its own. `saved` signs in
 * with a saved credential and runs a draft, a resume and a sign-out against
 * a disposable site; `session` continues that run directory with a
 * session-only returning sign-in, a forked turn that asks the runner for its
 * token, one that isn't offered any, and a refresh held across a sign-out.
 *
 * Without `--live` it only checks local prerequisites and prints its plan.
 * Every stage records its status, typed code and bounded observations before
 * anything judges it, and cleanup runs on every way out.
 */

const CHATGPT_ACCEPTANCE_PROVIDER = 'chatgpt';

type AcceptanceScenario = 'saved' | 'session' | 'provision' | 'retire';
const SCENARIOS: readonly AcceptanceScenario[] = [ 'saved', 'session', 'provision', 'retire' ];
type AcceptanceGate = 'T1' | 'T2' | 'T3' | 'T4';

const GATES: readonly AcceptanceGate[] = [ 'T1', 'T2', 'T3', 'T4' ];
const SITE_NAME = 'ChatGPT Acceptance';
const SITE_FOLDER = 'chatgpt-acceptance';
const EXIT_PASSED = 0;
const EXIT_FAILED = 1;
const EXIT_REFUSED = 2;
const EXIT_INTERRUPTED = 130;
const TURN_TIMEOUT_MS = 15 * 60_000;
const FIRST_REQUEST_TIMEOUT_MS = 5 * 60_000;
// The longest a forked turn may run on after a sign-out before it counts as not stopping.
const STOP_BOUND_MS = 60_000;
// Under the broker's 30 s refresh timeout, after which it would discard the held result itself.
const HOLD_MAX_MS = 20_000;
const HOLD_WAIT_MS = 60_000;
const SETTLE_WAIT_MS = 35_000;
const SIGN_OUT_WAIT_MS = 90_000;
const CLEANUP_STEP_MS = 120_000;
const POLL_MS = 250;

interface ChatGptAcceptanceOptions {
	live: boolean;
	scenario: AcceptanceScenario;
	runDir: string;
	model: string;
	effort: string;
	gates: AcceptanceGate[];
}

type ArgumentProblem =
	| 'scenario-missing'
	| 'scenario-unknown'
	| 'gate-unknown'
	| 'option-not-for-session'
	| 'option-not-for-profile'
	| 'option-unknown'
	| 'option-value-missing';

export type ParsedAcceptanceArgs =
	| { ok: true; options: ChatGptAcceptanceOptions }
	| { ok: true; help: true }
	| { ok: false; problem: ArgumentProblem };

// The route's first qualified model, as the table lists them.
const defaultModel = () => Object.keys( CHATGPT_MODEL_CAPABILITIES )[ 0 ] ?? '';

export function parseChatGptAcceptanceArgs( argv: readonly string[] ): ParsedAcceptanceArgs {
	const values: Record< string, string > = {};
	let live = false;
	const valued = new Set( [ '--scenario', '--run-dir', '--model', '--effort', '--gates' ] );
	for ( let index = 0; index < argv.length; index++ ) {
		const argument = argv[ index ];
		if ( argument === '--help' || argument === '-h' ) {
			return { ok: true, help: true };
		}
		if ( argument === '--live' ) {
			live = true;
			continue;
		}
		const [ name, inline ] = argument.includes( '=' )
			? [
					argument.slice( 0, argument.indexOf( '=' ) ),
					argument.slice( argument.indexOf( '=' ) + 1 ),
			  ]
			: [ argument, undefined ];
		if ( ! valued.has( name ) ) {
			return { ok: false, problem: 'option-unknown' };
		}
		const value = inline ?? argv[ ++index ];
		if (
			value === undefined ||
			value === '' ||
			( inline === undefined && value.startsWith( '--' ) )
		) {
			return { ok: false, problem: 'option-value-missing' };
		}
		values[ name ] = value;
	}
	const scenario = values[ '--scenario' ];
	if ( ! scenario ) {
		return { ok: false, problem: 'scenario-missing' };
	}
	if ( ! SCENARIOS.includes( scenario as AcceptanceScenario ) ) {
		return { ok: false, problem: 'scenario-unknown' };
	}
	if (
		scenario !== 'saved' &&
		[ '--model', '--effort', '--gates' ].some( ( name ) => name in values )
	) {
		return {
			ok: false,
			problem: scenario === 'session' ? 'option-not-for-session' : 'option-not-for-profile',
		};
	}
	const gates = ( values[ '--gates' ] ?? '' )
		.split( ',' )
		.map( ( gate ) => gate.trim().toUpperCase() )
		.filter( Boolean );
	if ( gates.some( ( gate ) => ! GATES.includes( gate as AcceptanceGate ) ) ) {
		return { ok: false, problem: 'gate-unknown' };
	}
	const model = values[ '--model' ] ?? defaultModel();
	return {
		ok: true,
		options: {
			live,
			scenario: scenario as AcceptanceScenario,
			runDir: values[ '--run-dir' ] ?? '',
			model,
			effort: values[ '--effort' ] ?? getDefaultChatGptReasoningEffort( model ),
			gates: [ ...new Set( gates ) ] as AcceptanceGate[],
		},
	};
}

// ---------------------------------------------------------------------------
// What the stages run against: the app's broker, sign-in flow, sessions and
// CLI processes when live; stand-ins in offline tests.

interface AcceptanceClock {
	now(): number;
	sleep( ms: number, signal?: AbortSignal ): Promise< void >;
}

interface AcceptanceSignIn {
	begin(
		registrationId: string | undefined,
		options: { storage: 'vault' | 'session' }
	): Promise< { attemptId: string } >;
	wait( attemptId: string ): Promise< ChatGptSignInOutcome >;
	cancel( attemptId: string ): boolean;
	/** How long an attempt waits for the browser to come back. */
	readonly timeoutMs: number;
}

interface AcceptanceBroker {
	getAccessToken( connectionId: string ): Promise< string >;
	invalidateAccessToken( connectionId: string, rejectedAccessToken: string ): Promise< void >;
	signOut(
		connectionId: string
	): Promise< { localCleared: boolean; remoteRevocationConfirmed: boolean } >;
	sessionForkEnvironment(): Record< string, string >;
	/**
	 * Asks this app for a session-only token the way a forked turn's IPC
	 * request reaches it: whether a token came back, or null without an answer.
	 */
	askSessionToken( connectionId: string, logoutGeneration: number ): Promise< boolean | null >;
	readAccount( registrationId: string ): Promise< ChatGptAccount | null >;
	vaultRecordExists( registrationId: string ): boolean;
	/** The keychain item that holds this profile's vault key; throws when it can't be named. */
	vaultKeyItem(): string;
	/** Removes this profile's own vault key item, unless a saved sign-in still needs it. */
	removeProfileVaultKey(): Promise< 'removed' | 'default-profile' | 'records-exist' >;
	readModels( connectionId: string, revision: number ): Promise< ChatGptModelAvailability >;
}

interface RefreshHold {
	/** True once a successful refresh result is held; false when the refresh failed instead. */
	held: Promise< boolean >;
	release(): void;
}

interface TokenProbeResult {
	tried: boolean;
	rejected: boolean;
	terminal: boolean;
}

export interface AcceptanceTokens {
	holdNextRefresh(): RefreshHold;
	/** How many refreshes the broker made through this client succeeded. */
	refreshes(): number;
	/**
	 * Tries a refresh with a refresh token kept in memory: the one the last
	 * refresh retired, or the one it issued.
	 */
	probe( which: 'retired' | 'rotated' ): Promise< TokenProbeResult >;
	revocations(): { total: number; confirmed: number; rotatedRevoked: boolean };
	/** Releases any hold and waits for refreshes in flight. */
	settle(): Promise< void >;
}

interface AcceptanceSessions {
	create( site?: { name: string; path: string } ): Promise< string >;
	select(
		sessionId: string,
		selection: { connectionId: string; revision: number; model: string; reasoningEffort: string }
	): Promise< void >;
	filePath( sessionId: string ): Promise< string | null >;
}

/** What a turn may do: the test site, the one draft it may create, the tools it may call. */
export interface ToolPolicy {
	site?: { name: string; path: string };
	draftTitle?: string;
	tools: readonly string[];
}

export interface TurnOptions {
	label: string;
	sessionId: string;
	prompt: string;
	/** Started with the runner's session-only offer, answered over IPC. */
	offerSessions: boolean;
	/** Forked with an IPC channel, as the apps fork turns; otherwise spawned as from a terminal. */
	ipc: boolean;
	policy: ToolPolicy;
	/** The session file, to see whether a tool result was persisted when its event arrived. */
	persistenceFile?: string;
	/** Gate T1's live check: images in tool results turned on, in this turn's process only. */
	toolImages?: boolean;
}

export interface TimedEvent {
	receivedAt: number;
	event: JsonEvent;
	/** For a tool result: whether the session file held it on arrival; null when unreadable. */
	persistedAtReceipt?: boolean | null;
}

export interface TurnResult {
	pid: number | undefined;
	exitCode: number | null;
	startedAt: number;
	exitedAt: number;
	events: TimedEvent[];
	requests: ObservedRequest[];
	responses: ObservedResponse[];
	tokenAsks: number;
	tokensHandedOut: number;
	/** The runner interrupted the turn: only ever for a tool call outside its policy. */
	interruptedByRunner: boolean;
}

export interface AcceptanceTurn {
	/** True once the turn's first model request started; false when it ended first. */
	firstRequest(): Promise< boolean >;
	result: Promise< TurnResult >;
	stop(): Promise< void >;
}

interface AcceptanceProcesses {
	startTurn( options: TurnOptions ): AcceptanceTurn;
	runCli( label: string, args: string[] ): Promise< { exitCode: number | null; stdout: string } >;
	/** Stops every process this runner started that is still running. */
	stopOwned(): Promise< { stopped: number; failed: number } >;
}

export interface ChatGptAcceptanceServices {
	clock: AcceptanceClock;
	countdownIntervalMs: number;
	signIn: AcceptanceSignIn;
	broker: AcceptanceBroker;
	tokens: AcceptanceTokens;
	sessions: AcceptanceSessions;
	processes: AcceptanceProcesses;
	buildPresent(): boolean;
	credentialStoreKind(): CredentialStoreKind | null;
	secureStorageAvailable(): Promise< boolean >;
	imageServiceConfigured(): Promise< boolean >;
}

type RunFacts = Pick< ManifestRun, 'source' | 'platform' | 'runtime' | 'build' >;

export interface ChatGptAcceptanceDependencies {
	env: NodeJS.ProcessEnv;
	home: string;
	print( line: string ): void;
	/** Source, platform, runtime and build: local facts only. */
	collectFacts(): Promise< RunFacts >;
	/** Where the app modules resolve the Studio profile and process manager now. */
	configDirectory(): string;
	processManagerHome(): string;
	onInterrupt( handler: () => void ): () => void;
	createServices( context: {
		paths: AcceptanceRunPaths;
		options: ChatGptAcceptanceOptions;
		print: ( line: string ) => void;
	} ): Promise< ChatGptAcceptanceServices >;
}

// ---------------------------------------------------------------------------
// Holding and probing refreshes through the broker's injectable token client.

interface CapturedToken {
	clientId: string;
	refreshToken: string;
}

const REVOKE_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 30_000;

function raceTimeout< T >( promise: Promise< T >, ms: number ): Promise< T | null > {
	let timer: ReturnType< typeof setTimeout > | undefined;
	return Promise.race( [
		promise,
		new Promise< null >( ( resolve ) => {
			timer = setTimeout( () => resolve( null ), ms );
		} ),
	] ).finally( () => clearTimeout( timer ) );
}

/**
 * Wraps a token client: holds the next successful refresh result in memory
 * until released, and keeps the refresh tokens it saw, in memory only, so a
 * probe can show a retired or revoked one is refused. Anything a probe or an
 * abandoned hold leaves usable is revoked at once.
 */
export function createAcceptanceTokenService(
	inner: ChatGptTokenClient
): AcceptanceTokens & { client: ChatGptTokenClient } {
	let nextHold: { resolveHeld: ( held: boolean ) => void; gate: Promise< void > } | null = null;
	const releases = new Set< () => void >();
	const inFlight = new Set< Promise< unknown > >();
	let retired: CapturedToken | null = null;
	let rotated: CapturedToken | null = null;
	let refreshes = 0;
	const revoked: Array< CapturedToken & { confirmed: boolean } > = [];

	const revokeQuietly = ( clientId: string, refreshToken: string ) =>
		inner
			.revoke( { clientId, refreshToken, signal: AbortSignal.timeout( REVOKE_TIMEOUT_MS ) } )
			.catch( () => undefined );

	async function refresh(
		request: Parameters< ChatGptTokenClient[ 'refresh' ] >[ 0 ]
	): Promise< ChatGptTokenServiceResult< ChatGptTokenSet > > {
		const hold = nextHold;
		nextHold = null;
		const result = await inner.refresh( request );
		if ( result.ok ) {
			refreshes++;
			retired = { clientId: request.clientId, refreshToken: request.refreshToken };
			rotated = {
				clientId: request.clientId,
				refreshToken: result.value.refreshToken ?? request.refreshToken,
			};
		}
		if ( hold ) {
			hold.resolveHeld( result.ok );
			if ( result.ok ) {
				await hold.gate;
				// The broker stopped waiting: nothing would use or revoke what it was issued.
				if ( request.signal.aborted && result.value.refreshToken ) {
					await revokeQuietly( request.clientId, result.value.refreshToken );
				}
			}
		}
		return result;
	}

	const client: ChatGptTokenClient = {
		refresh: ( request ) => {
			const running = refresh( request );
			inFlight.add( running );
			void running.finally( () => inFlight.delete( running ) ).catch( () => undefined );
			return running;
		},
		revoke: async ( request ) => {
			const result = await inner.revoke( request );
			revoked.push( {
				clientId: request.clientId,
				refreshToken: request.refreshToken,
				confirmed: result.ok,
			} );
			return result;
		},
	};

	return {
		client,
		holdNextRefresh() {
			let resolveHeld: ( held: boolean ) => void = () => undefined;
			let release: () => void = () => undefined;
			const held = new Promise< boolean >( ( resolve ) => ( resolveHeld = resolve ) );
			const gate = new Promise< void >( ( resolve ) => ( release = resolve ) );
			nextHold = { resolveHeld, gate };
			releases.add( release );
			return {
				held,
				release: () => {
					releases.delete( release );
					release();
				},
			};
		},
		refreshes: () => refreshes,
		async probe( which ) {
			const target = which === 'retired' ? retired : rotated;
			if ( ! target ) {
				return { tried: false, rejected: false, terminal: false };
			}
			const result = await inner
				.refresh( {
					clientId: target.clientId,
					refreshToken: target.refreshToken,
					signal: AbortSignal.timeout( PROBE_TIMEOUT_MS ),
				} )
				.catch(
					(): ChatGptTokenServiceResult< ChatGptTokenSet > => ( {
						ok: false,
						error: { kind: 'transient' },
					} )
				);
			if ( result.ok ) {
				if ( result.value.refreshToken ) {
					await revokeQuietly( target.clientId, result.value.refreshToken );
				}
				await revokeQuietly( target.clientId, target.refreshToken );
				return { tried: true, rejected: false, terminal: false };
			}
			return { tried: true, rejected: true, terminal: result.error.kind === 'terminal' };
		},
		revocations() {
			return {
				total: revoked.length,
				confirmed: revoked.filter( ( item ) => item.confirmed ).length,
				rotatedRevoked: Boolean(
					rotated &&
						revoked.some(
							( item ) => item.confirmed && item.refreshToken === rotated?.refreshToken
						)
				),
			};
		},
		async settle() {
			nextHold?.resolveHeld( false );
			nextHold = null;
			for ( const release of releases ) {
				release();
			}
			releases.clear();
			await raceTimeout( Promise.allSettled( [ ...inFlight ] ), SETTLE_WAIT_MS );
		},
	};
}

// ---------------------------------------------------------------------------
// Reading turns: tool calls, the final answer, typed failure codes.

const CONNECTION_CODES: readonly ChatGptConnectionErrorCode[] = [
	'not-found',
	'signed-out',
	'needs-sign-in',
	'session-unavailable',
	'changed',
	'vault-unavailable',
	'vault-key-unreadable',
	'refresh-failed',
	'identity-mismatch',
	'invalid-sign-in',
	'accounts-unreadable',
	'newer-format',
];

/** The typed codes a turn's failure text names, never the text itself. */
export function classifyTurnFailure( text: string ): string[] {
	const codes = new Set< string >();
	for ( const code of CONNECTION_CODES ) {
		const message = new ChatGptConnectionError( code ).message;
		const stem = code === 'vault-unavailable' ? message.split( '(' )[ 0 ] : message;
		if ( text.includes( stem ) ) {
			codes.add( code );
		}
	}
	for ( const [ , reference ] of text.matchAll( /\(([^()]*)\)/g ) ) {
		for ( const part of reference.split( /,\s*/ ) ) {
			if ( ( CONNECTION_CODES as readonly string[] ).includes( part ) ) {
				codes.add( part );
			}
		}
	}
	// A turn's failure reaches the runner as text only: every text the shared
	// wording gives a code, one per state of the account the chat runs on.
	const accountStates: Array< Parameters< typeof describeConnectionSelectionError >[ 1 ] > = [
		undefined,
		'signed-in',
		'signed-out',
		'needs-sign-in',
	];
	for ( const code of [ 'disconnected', 'changed', 'unsupported' ] as const ) {
		if (
			accountStates.some( ( state ) =>
				text.includes(
					describeConnectionSelectionError( { code, providerId: 'chatgpt-oauth' }, state )
				)
			)
		) {
			codes.add( `connection-${ code }` );
		}
	}
	if ( /subscription_sharing_usage_limit_exceeded/.test( text ) ) {
		codes.add( 'usage-limit' );
	}
	return [ ...codes ].sort();
}

interface ToolCallDigest {
	id: string;
	name: string;
	args: unknown;
	startedAt: number;
	endedAt?: number;
	isError?: boolean;
	hasStudioService: boolean;
	persistedAtReceipt?: boolean | null;
}

export interface TurnDigest {
	toolCalls: ToolCallDigest[];
	finalText: string;
	/** Typed codes from a failed or interrupted ending, never its text. */
	failureCodes: string[];
	status: string | null;
	questions: number;
	/**
	 * How the turn's last assistant message stopped: `aborted` when the turn's
	 * own ChatGPT connection signal ended it, `error` for a failure.
	 */
	stopReason: string | null;
	/** When the runner received the event that ended the turn. */
	endedAt: number | null;
}

const isRecord = ( value: unknown ): value is Record< string, unknown > =>
	typeof value === 'object' && value !== null && ! Array.isArray( value );

function lastAssistant( event: Record< string, unknown > ): Record< string, unknown > | null {
	const messages = Array.isArray( event.messages ) ? event.messages : [];
	for ( let index = messages.length - 1; index >= 0; index-- ) {
		const message = messages[ index ];
		if ( isRecord( message ) && message.role === 'assistant' ) {
			return message;
		}
	}
	return null;
}

function assistantText( message: Record< string, unknown > | null ): string | null {
	if ( ! message || ! Array.isArray( message.content ) ) {
		return null;
	}
	return message.content
		.filter(
			( block ): block is { type: 'text'; text: string } =>
				isRecord( block ) && block.type === 'text' && typeof block.text === 'string'
		)
		.map( ( block ) => block.text )
		.join( '\n' );
}

export function digestTurnEvents( events: readonly TimedEvent[] ): TurnDigest {
	const digest: TurnDigest = {
		toolCalls: [],
		finalText: '',
		failureCodes: [],
		status: null,
		questions: 0,
		stopReason: null,
		endedAt: null,
	};
	const codes = new Set< string >();
	for ( const { receivedAt, event, persistedAtReceipt } of events ) {
		if ( event.type === 'message' && isRecord( event.message ) ) {
			const inner = event.message as unknown as Record< string, unknown >;
			if ( inner.type === 'tool_execution_start' && typeof inner.toolCallId === 'string' ) {
				digest.toolCalls.push( {
					id: inner.toolCallId,
					name: String( inner.toolName ),
					args: inner.args,
					startedAt: receivedAt,
					hasStudioService: false,
				} );
			} else if ( inner.type === 'tool_execution_end' ) {
				const call = digest.toolCalls.find( ( item ) => item.id === inner.toolCallId );
				if ( call ) {
					const result = isRecord( inner.result ) ? inner.result : {};
					call.endedAt = receivedAt;
					call.isError = inner.isError === true;
					call.hasStudioService =
						isRecord( result.details ) && isRecord( result.details.studioService );
					if ( persistedAtReceipt !== undefined ) {
						call.persistedAtReceipt = persistedAtReceipt;
					}
				}
			} else if ( inner.type === 'agent_end' && inner.willRetry !== true ) {
				const last = lastAssistant( inner );
				digest.stopReason = typeof last?.stopReason === 'string' ? last.stopReason : null;
				digest.endedAt = receivedAt;
				const failure = getAgentEndFailure( event.message as AgentSessionEvent );
				if ( failure ) {
					classifyTurnFailure( failure.message ).forEach( ( code ) => codes.add( code ) );
				} else if ( last?.stopReason === 'aborted' ) {
					if ( typeof last.errorMessage === 'string' ) {
						classifyTurnFailure( last.errorMessage ).forEach( ( code ) => codes.add( code ) );
					}
				} else {
					digest.finalText = assistantText( last ) ?? digest.finalText;
				}
			}
		} else if ( event.type === 'error' ) {
			classifyTurnFailure( event.message ).forEach( ( code ) => codes.add( code ) );
		} else if ( event.type === 'turn.completed' ) {
			digest.status = event.status;
			digest.endedAt ??= receivedAt;
		} else if ( event.type === 'question.asked' ) {
			digest.questions += event.questions.length;
		}
	}
	digest.failureCodes = [ ...codes ].sort();
	return digest;
}

const READ_ONLY_TOOLS = new Set( [
	'site_info',
	'site_list',
	'Read',
	'Grep',
	'Glob',
	'Ls',
	'Skill',
] );
const READ_VERBS = new Set( [
	'get',
	'list',
	'version',
	'status',
	'exists',
	'count',
	'is-installed',
	'is-active',
	'path',
] );
const UNSAFE_WP_COMMANDS = new Set( [
	'eval',
	'eval-file',
	'db',
	'search-replace',
	'shell',
	'package',
	'cron',
	'config',
	'cli',
] );

const comparablePath = ( value: string ) => {
	const resolved = path.resolve( value );
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

function isTestSite( site: NonNullable< ToolPolicy[ 'site' ] >, nameOrPath: string ): boolean {
	if ( nameOrPath.trim().toLowerCase() === site.name.toLowerCase() ) {
		return true;
	}
	return (
		path.isAbsolute( nameOrPath ) && comparablePath( nameOrPath ) === comparablePath( site.path )
	);
}

// The words of a WP-CLI command as the wp_cli tool reads them: a quote opens
// only at the start of a word or right after `=`, so `--post_title="A B"` is one word.
function splitWpCliWords( command: string ): string[] {
	const words: string[] = [];
	let current = '';
	let quote: string | null = null;
	for ( const character of command ) {
		if ( quote ) {
			if ( character === quote ) {
				quote = null;
			} else {
				current += character;
			}
		} else if (
			( character === '"' || character === "'" ) &&
			( current === '' || current.endsWith( '=' ) )
		) {
			quote = character;
		} else if ( /\s/.test( character ) ) {
			if ( current ) {
				words.push( current );
				current = '';
			}
		} else {
			current += character;
		}
	}
	if ( current ) {
		words.push( current );
	}
	return words;
}

// Command groups whose verb follows a second noun: `post meta get`, `theme mod list`.
const WP_CLI_SUBCOMMAND_GROUPS = new Set( [ 'meta', 'term', 'mod', 'auto-updates', 'option' ] );

const wpCliPositionals = ( words: readonly string[] ) =>
	words.filter( ( word ) => ! word.startsWith( '-' ) );

/** A WP-CLI command's verb: the word after its command, or after its sub-command group. */
function wpCliVerb( positional: readonly string[] ): string | undefined {
	return WP_CLI_SUBCOMMAND_GROUPS.has( positional[ 1 ] ) ? positional[ 2 ] : positional[ 1 ];
}

/** Whether a WP-CLI command only reads: decided by its verb, never by words after it. */
export function isWpCliReadCommand( command: string ): boolean {
	const positional = wpCliPositionals( splitWpCliWords( command ) );
	const verb = wpCliVerb( positional );
	return (
		positional.length > 0 &&
		! UNSAFE_WP_COMMANDS.has( positional[ 0 ] ) &&
		verb !== undefined &&
		READ_VERBS.has( verb )
	);
}

function optionValue( words: readonly string[], name: string ): string | undefined {
	const prefix = `${ name }=`;
	const found = words.find( ( word ) => word.startsWith( prefix ) );
	return found === undefined ? undefined : found.slice( prefix.length );
}

/**
 * Whether a tool call stays within what a turn may do: read-only tools, the
 * tools its stage names, WP-CLI reads on the test site, and the one named test
 * draft. Anything else, publishing above all, is unexpected.
 */
export function classifyToolCall(
	policy: ToolPolicy,
	name: string,
	args: unknown
): 'allowed' | 'unexpected' {
	if ( ! policy.tools.includes( name ) && ! READ_ONLY_TOOLS.has( name ) ) {
		return 'unexpected';
	}
	const input = isRecord( args ) ? args : {};
	if (
		typeof input.nameOrPath === 'string' &&
		( ! policy.site || ! isTestSite( policy.site, input.nameOrPath ) )
	) {
		return 'unexpected';
	}
	if ( name !== 'wp_cli' ) {
		return 'allowed';
	}
	if ( ! policy.site || typeof input.nameOrPath !== 'string' ) {
		return 'unexpected';
	}
	const command = typeof input.command === 'string' ? input.command : '';
	const words = splitWpCliWords( command );
	if ( words.some( ( word ) => /publish|future/i.test( word ) ) ) {
		return 'unexpected';
	}
	if ( isWpCliReadCommand( command ) ) {
		return 'allowed';
	}
	const positional = wpCliPositionals( words );
	if ( positional[ 0 ] === 'post' && positional[ 1 ] === 'create' && policy.draftTitle ) {
		const status = optionValue( words, '--post_status' );
		const type = optionValue( words, '--post_type' );
		if (
			optionValue( words, '--post_title' ) === policy.draftTitle &&
			( status === undefined || status === 'draft' ) &&
			( type === undefined || type === 'post' )
		) {
			return 'allowed';
		}
	}
	return 'unexpected';
}

export interface WpPost {
	id: number;
	title: string;
	status: string;
}

/** A `post list --format=json` result, or null when the output is anything else. */
export function parseWpPostList( stdout: string ): WpPost[] | null {
	const candidates = [
		stdout.trim(),
		...stdout.split( /\r?\n/ ).filter( ( line ) => line.trim().startsWith( '[' ) ),
	];
	for ( const candidate of candidates ) {
		let parsed: unknown;
		try {
			parsed = JSON.parse( candidate );
		} catch {
			continue;
		}
		if ( ! Array.isArray( parsed ) ) {
			continue;
		}
		const posts: WpPost[] = [];
		for ( const item of parsed ) {
			if (
				! isRecord( item ) ||
				! Number.isSafeInteger( Number( item.ID ) ) ||
				typeof item.ID === 'boolean' ||
				( typeof item.ID === 'string' && ! /^\d+$/.test( item.ID ) ) ||
				typeof item.post_title !== 'string' ||
				typeof item.post_status !== 'string'
			) {
				return null;
			}
			posts.push( { id: Number( item.ID ), title: item.post_title, status: item.post_status } );
		}
		return posts;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Stages: each records before anything judges it.

class StageVerdict extends Error {
	constructor(
		readonly status: 'failed' | 'blocked',
		readonly code: string
	) {
		super( code );
		this.name = 'StageVerdict';
	}
}

class AcceptanceInterrupted extends Error {
	constructor() {
		super( 'interrupted' );
		this.name = 'AcceptanceInterrupted';
	}
}

const fail = ( code: string ): never => {
	throw new StageVerdict( 'failed', code );
};

const block = ( code: string ): never => {
	throw new StageVerdict( 'blocked', code );
};

function check( condition: boolean, code: string ): void {
	if ( ! condition ) {
		fail( code );
	}
}

const round1 = ( value: number ) => Math.round( value * 10 ) / 10;

function untilAborted< T >( promise: Promise< T >, signal: AbortSignal ): Promise< T > {
	if ( signal.aborted ) {
		return Promise.reject( new AcceptanceInterrupted() );
	}
	return new Promise< T >( ( resolve, reject ) => {
		const onAbort = () => reject( new AcceptanceInterrupted() );
		signal.addEventListener( 'abort', onAbort, { once: true } );
		promise.then(
			( value ) => {
				signal.removeEventListener( 'abort', onAbort );
				resolve( value );
			},
			( error ) => {
				signal.removeEventListener( 'abort', onAbort );
				reject( error );
			}
		);
	} );
}

interface AcceptanceState {
	schemaVersion: 1;
	registrationId?: string;
	storage?: 'vault' | 'session';
	siteName?: string;
	sitePath?: string;
	siteCreated?: boolean;
	draftSessionId?: string;
	draftTitle?: string;
	draftContent?: string;
	marker?: string;
	effort?: string;
	offeredSessionId?: string;
	/**
	 * What follows `chatgpt-vault-key-` in the name of the run profile's own
	 * keychain item, so an abandoned run's item can be removed by its exact
	 * name. The whole name would read as an opaque token.
	 */
	vaultKeySuffix?: string;
}

type CleanupSlot = 'sign-in' | 'refresh' | 'processes' | 'site' | 'registration' | 'vault-key';
const CLEANUP_ORDER: readonly CleanupSlot[] = [
	'sign-in',
	'refresh',
	'processes',
	'site',
	'registration',
	'vault-key',
];

/** One cleanup step: records what it did in `report`; false or a throw is a failed step. */
type CleanupAction = ( report: Observations ) => Promise< boolean >;

interface StageContext {
	options: ChatGptAcceptanceOptions;
	paths: AcceptanceRunPaths;
	services: ChatGptAcceptanceServices;
	evidence: AcceptanceEvidence;
	run: number;
	state: AcceptanceState;
	saveState(): void;
	print( line: string ): void;
	signal: AbortSignal;
	cleanup: Map< CleanupSlot, CleanupAction >;
	turns: Partial< Record< string, TurnResult > >;
	baseline: WpPost[] | null;
	signOutResult: { localCleared: boolean; remoteRevocationConfirmed: boolean } | null;
}

interface StageDefinition {
	name: string;
	/** An optional gate: skipped unless requested, and its failure doesn't stop the run. */
	gate?: AcceptanceGate;
	/** What a numbered stage covers, for the plan. */
	summary?: () => string;
	run( ctx: StageContext, observations: Observations ): Promise< void >;
}

function requireRegistration( ctx: StageContext ): string {
	const id = ctx.state.registrationId;
	return id && isChatGptRegistrationId( id ) ? id : fail( 'no-registration' );
}

async function requireSignedInAccount( ctx: StageContext ): Promise< ChatGptAccount > {
	const account = await ctx.services.broker.readAccount( requireRegistration( ctx ) );
	return account?.state === 'signed-in' ? account : fail( 'not-signed-in' );
}

function requireSite( ctx: StageContext ): { name: string; path: string } {
	const { siteName, sitePath, siteCreated } = ctx.state;
	return siteName && sitePath && siteCreated
		? { name: siteName, path: sitePath }
		: fail( 'no-site' );
}

// Signs out the test registration on the way out, unless something already did.
function registerRegistrationCleanup( ctx: StageContext ): void {
	ctx.cleanup.set( 'registration', async ( report ) => {
		const id = ctx.state.registrationId;
		if ( ! id ) {
			return true;
		}
		const account = await ctx.services.broker.readAccount( id );
		if ( account?.state !== 'signed-in' ) {
			return true;
		}
		try {
			const result = await ctx.services.broker.signOut( id );
			report.testRegistrationSignedOut = true;
			report.signOutLocalCleared = result.localCleared;
			report.signOutRemoteConfirmed = result.remoteRevocationConfirmed;
			return result.localCleared;
		} catch {
			report.signOutFailed = true;
			return false;
		}
	} );
}

// The default profile's vault key item: the run's profile must never key its records under it.
const UNSCOPED_VAULT_KEY_ITEM = 'chatgpt-vault-key';

/** The run profile's own vault key item, or null when it would be the unscoped one or can't be named. */
function scopedVaultKeyItem( ctx: StageContext ): string | null {
	let item: string;
	try {
		item = ctx.services.broker.vaultKeyItem();
	} catch {
		return null;
	}
	return item !== UNSCOPED_VAULT_KEY_ITEM && item.startsWith( `${ UNSCOPED_VAULT_KEY_ITEM }-` )
		? item
		: null;
}

/** Whether the run profile's own vault key item is gone: never while a saved sign-in needs it. */
async function removeRunVaultKey( ctx: StageContext ): Promise< boolean > {
	try {
		return ( await ctx.services.broker.removeProfileVaultKey() ) === 'removed';
	} catch {
		return false;
	}
}

// Removes the run profile's own vault key item on the way out, after the
// registration's sign-out, so a run leaves nothing of its own in the keychain.
function registerVaultKeyCleanup( ctx: StageContext ): void {
	ctx.cleanup.set( 'vault-key', async ( report ) => {
		report.vaultKeyRemoved = await removeRunVaultKey( ctx );
		return report.vaultKeyRemoved;
	} );
}

function describeDuration( ms: number ): string {
	const minutes = Math.round( ms / 60_000 );
	if ( minutes >= 1 ) {
		/* translators: %d: a number of minutes. */
		return sprintf( _n( '%d minute', '%d minutes', minutes ), minutes );
	}
	/* translators: %s: a number of seconds. */
	return sprintf( __( '%s seconds' ), String( round1( ms / 1000 ) ) );
}

async function runCountdown(
	ctx: StageContext,
	openedAt: number,
	timeoutMs: number,
	signal: AbortSignal
): Promise< void > {
	const { clock, countdownIntervalMs } = ctx.services;
	for (;;) {
		await clock.sleep( countdownIntervalMs, signal );
		if ( signal.aborted ) {
			return;
		}
		const remaining = timeoutMs - ( clock.now() - openedAt );
		if ( remaining <= 0 ) {
			return;
		}
		const minutes = Math.round( remaining / 60_000 );
		ctx.print(
			minutes >= 1
				? sprintf(
						/* translators: %d: minutes left to finish signing in to ChatGPT in the browser. */
						_n(
							'%d minute remains to finish signing in to ChatGPT in your browser.',
							'%d minutes remain to finish signing in to ChatGPT in your browser.',
							minutes
						),
						minutes
				  )
				: sprintf(
						/* translators: %s: seconds left to finish signing in to ChatGPT in the browser. */
						__( '%s seconds remain to finish signing in to ChatGPT in your browser.' ),
						String( Math.round( remaining / 1000 ) )
				  )
		);
	}
}

/**
 * One browser sign-in. The typed code of a failed outcome is the stage's code;
 * a pending attempt is cancelled, and waited for, on every way out, so one
 * that was already being saved finishes before anything signs out. Whenever
 * an attempt commits, cancelled or not, its registration is kept in the
 * state, so cleanup signs it out.
 */
async function signInStage(
	ctx: StageContext,
	observations: Observations,
	registrationId: string | undefined,
	storage: 'vault' | 'session'
): Promise< Extract< ChatGptSignInOutcome, { ok: true } > > {
	const { signIn, clock } = ctx.services;
	observations.timeoutS = signIn.timeoutMs / 1000;
	ctx.print( __( 'Opening ChatGPT’s sign-in page in your browser…' ) );
	const { attemptId } = await signIn.begin( registrationId, { storage } );
	const openedAt = clock.now();
	observations.browserOpened = true;
	let settled = false;
	const waiting = signIn.wait( attemptId ).then( ( outcome ) => {
		settled = true;
		if ( outcome.ok ) {
			ctx.state.registrationId ??= outcome.registrationId;
			ctx.state.storage = storage;
			ctx.saveState();
		}
		return outcome;
	} );
	const settle = async () => {
		if ( ! settled ) {
			signIn.cancel( attemptId );
			await raceTimeout( waiting, SETTLE_WAIT_MS );
		}
	};
	ctx.cleanup.set( 'sign-in', async ( report ) => {
		await settle();
		report.pendingSignInCancelled = true;
		return settled;
	} );
	ctx.print(
		sprintf(
			/* translators: %s: how long the sign-in waits, e.g. "10 minutes". */
			__(
				'Your browser opened ChatGPT’s sign-in page. Finish signing in there within %s; Studio stops waiting after that.'
			),
			describeDuration( signIn.timeoutMs )
		)
	);
	const countdown = new AbortController();
	void runCountdown( ctx, openedAt, signIn.timeoutMs, countdown.signal );
	try {
		const outcome = await untilAborted( waiting, ctx.signal );
		observations.completedAfterS = round1( ( clock.now() - openedAt ) / 1000 );
		if ( ! outcome.ok ) {
			observations.timedOut = outcome.code === 'timed-out';
			if ( outcome.code === 'timed-out' ) {
				ctx.print(
					sprintf(
						/* translators: 1: seconds since the browser opened, 2: the sign-in time limit in seconds. */
						__(
							'Studio stopped waiting %1$s s after your browser opened (the limit is %2$s s). The sign-in has to finish in the browser within that time.'
						),
						String( observations.completedAfterS ),
						String( observations.timeoutS )
					)
				);
			}
			return fail( outcome.code );
		}
		return outcome;
	} finally {
		countdown.abort();
		await settle();
		ctx.cleanup.delete( 'sign-in' );
	}
}

// The IPC message a forked turn sends its app for a session-only token.
const SESSION_TOKEN_REQUEST_TYPE = 'studio.chatgpt-session-token.request';

/**
 * Asks a session's owner for a token through its answer path, with the
 * message a forked turn sends. Keeps only whether a token came back; null
 * when the owner didn't take the message.
 */
export function askOwnerForSessionToken(
	answer: ( message: unknown, reply: ( message: unknown ) => void ) => boolean,
	connectionId: string,
	logoutGeneration: number
): Promise< boolean | null > {
	return new Promise( ( resolve ) => {
		const taken = answer(
			{ type: SESSION_TOKEN_REQUEST_TYPE, requestId: randomUUID(), connectionId, logoutGeneration },
			( reply ) =>
				resolve(
					isRecord( reply ) && typeof reply.accessToken === 'string' && reply.accessToken !== ''
				)
		);
		if ( ! taken ) {
			resolve( null );
		}
	} );
}

function routeRequests( result: TurnResult ): ObservedRequest[] {
	return result.requests.filter(
		( request ) => request.host === 'chatgpt-route' && request.endpoint === 'responses'
	);
}

function responseFor( result: TurnResult, request: ObservedRequest ): ObservedResponse | undefined {
	return result.responses.find(
		( response ) => response.id === request.id && response.pid === request.pid
	);
}

/** Every model request on the route, at the selection, stateless, with nothing else billed. */
function applyRouteAudit(
	observations: Observations,
	result: TurnResult,
	expected: { model: string; effort: string }
): void {
	const route = routeRequests( result );
	observations.modelRequests = route.length;
	observations.apiKeyBearers = result.requests.filter(
		( request ) => request.bearer === 'api-key'
	).length;
	observations.otherProviderRequests = result.requests.filter( ( request ) =>
		[ 'openai-api', 'anthropic', 'wpcom-ai-proxy' ].includes( request.host )
	).length;
	observations.allOnSelectedModel = route.every( ( request ) => request.model === expected.model );
	observations.allAtSelectedEffort = route.every(
		( request ) => request.effort === expected.effort
	);
	observations.noOutputCap = route.every( ( request ) => ! request.outputCap );
	observations.stateless = route.every(
		( request ) => request.store === false && ! request.previousResponseId
	);
	observations.maxInputItems = Math.max(
		0,
		...route.map( ( request ) => request.inputItems ?? 0 )
	);
	check( observations.apiKeyBearers === 0, 'api-key-bearer' );
	check( observations.otherProviderRequests === 0, 'provider-fallback' );
	check( route.length > 0, 'no-model-request' );
	check( observations.allOnSelectedModel, 'model-substituted' );
	check( observations.allAtSelectedEffort, 'effort-substituted' );
	check( observations.noOutputCap, 'output-cap-sent' );
	check( observations.stateless, 'stateful-request' );
}

async function runTurn( ctx: StageContext, options: TurnOptions ): Promise< TurnResult > {
	const turn = ctx.services.processes.startTurn( options );
	const result = await untilAborted( raceTimeout( turn.result, TURN_TIMEOUT_MS ), ctx.signal );
	if ( ! result ) {
		await turn.stop();
		return fail( 'turn-timed-out' );
	}
	ctx.turns[ options.label ] = result;
	return result;
}

function observeTurn(
	observations: Observations,
	result: TurnResult,
	policy: ToolPolicy
): TurnDigest {
	const digest = digestTurnEvents( result.events );
	observations.toolCalls = digest.toolCalls.length;
	observations.unexpectedToolCalls = digest.toolCalls.filter(
		( call ) => classifyToolCall( policy, call.name, call.args ) === 'unexpected'
	).length;
	observations.questionsAsked = digest.questions;
	observations.completed = digest.status === 'success';
	return digest;
}

function judgeTurn(
	observations: Observations,
	result: TurnResult,
	policy: ToolPolicy
): TurnDigest {
	const digest = observeTurn( observations, result, policy );
	check( observations.unexpectedToolCalls === 0, 'unexpected-tool-call' );
	return digest;
}

const createMarker = () => {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	return `G3${ Array.from( { length: 7 }, () => alphabet[ randomInt( alphabet.length ) ] ).join(
		''
	) }`;
};

const READY_PROMPT = 'Reply with the single word READY. Do not use any tools.';

/**
 * Gate T4 for one pair of the route's qualified table: the pair, in a chat of
 * its own with no site, answers a bounded read-only turn on the route at that
 * model and effort. One model doesn't qualify the list, so each pair is its
 * own stage and record. Pairs are numbered in the table's order (models, then
 * each model's efforts) at the run's source commit: a stage named after a model
 * slug would be long and digit-laden enough for the evidence guard to refuse it.
 */
function modelSmokeStage( model: string, effort: string, number: number ): StageDefinition {
	const label = `smoke-${ number }`;
	return {
		name: `gate-t4-${ label }`,
		gate: 'T4',
		summary: () =>
			sprintf(
				/* translators: 1: ChatGPT model id, 2: reasoning effort such as low. */
				__( '%1$s at %2$s effort' ),
				model,
				effort
			),
		async run( ctx, observations ) {
			const account = await requireSignedInAccount( ctx );
			const availability = await ctx.services.broker.readModels(
				account.registrationId,
				account.revision
			);
			observations.modelListed = Boolean(
				availability.models?.some( ( item ) => item.id === model )
			);
			if ( ! observations.modelListed ) {
				return block( 'model-not-listed' );
			}
			const sessionId = await ctx.services.sessions.create();
			await ctx.services.sessions.select( sessionId, {
				connectionId: account.registrationId,
				revision: account.revision,
				model,
				reasoningEffort: effort,
			} );
			const policy: ToolPolicy = { tools: [] };
			const result = await runTurn( ctx, {
				label,
				sessionId,
				prompt: READY_PROMPT,
				offerSessions: false,
				ipc: true,
				policy,
			} );
			const digest = judgeTurn( observations, result, policy );
			observations.answeredReady = /\bREADY\b/.test( digest.finalText );
			check( observations.completed === true, digest.failureCodes[ 0 ] ?? 'turn-failed' );
			applyRouteAudit( observations, result, { model, effort } );
			check( observations.answeredReady, 'ready-not-answered' );
		},
	};
}

const MODEL_SMOKE_STAGES: StageDefinition[] = Object.entries( CHATGPT_MODEL_CAPABILITIES )
	.flatMap( ( [ model, capabilities ] ) =>
		capabilities.reasoningEfforts.map( ( effort ) => ( { model, effort } ) )
	)
	.map( ( { model, effort }, index ) => modelSmokeStage( model, effort, index + 1 ) );

async function readPosts( ctx: StageContext, sitePath: string ): Promise< WpPost[] > {
	const listed = await ctx.services.processes.runCli( 'wp-post-list', [
		'wp',
		'--path',
		sitePath,
		'post',
		'list',
		'--post_type=post',
		'--post_status=any',
		'--format=json',
		'--fields=ID,post_title,post_status',
	] );
	const posts = listed.exitCode === 0 ? parseWpPostList( listed.stdout ) : null;
	return posts ?? fail( 'post-list-unreadable' );
}

function offeredRegistrations( environment: Record< string, string > ): string[] {
	return Object.values( environment ).flatMap( ( value ) => value.split( ',' ) );
}

async function waitUntil(
	ctx: StageContext,
	condition: () => Promise< boolean >,
	timeoutMs: number
): Promise< boolean > {
	const { clock } = ctx.services;
	const deadline = clock.now() + timeoutMs;
	for (;;) {
		if ( await condition() ) {
			return true;
		}
		if ( clock.now() >= deadline || ctx.signal.aborted ) {
			return false;
		}
		await clock.sleep( POLL_MS, ctx.signal );
	}
}

const prerequisitesStage: StageDefinition = {
	name: 'prerequisites',
	async run( ctx, observations ) {
		observations.buildPresent = ctx.services.buildPresent();
		if ( ! observations.buildPresent ) {
			block( 'build-missing' );
		}
		// A saved sign-in creates its profile's vault key: never under the item
		// the user's own profile keeps its key in, which it could replace.
		if ( ctx.options.scenario === 'saved' || ctx.options.scenario === 'provision' ) {
			const item = scopedVaultKeyItem( ctx );
			observations.vaultKeyScoped = item !== null;
			if ( item === null ) {
				return block( 'vault-key-not-scoped' );
			}
			ctx.state.vaultKeySuffix = item.slice( UNSCOPED_VAULT_KEY_ITEM.length + 1 );
			ctx.saveState();
		}
		// Which keychain, and whether it answered: a session-only run records it
		// too, so a result on a machine without one is told apart.
		const store = ctx.services.credentialStoreKind();
		observations.storePasswordVault = store === 'password-vault';
		observations.storeKeychain = store === 'keychain';
		observations.storeSecretService = store === 'secret-service';
		observations.secureStorageAvailable = await ctx.services.secureStorageAvailable();
		if ( ctx.options.scenario !== 'session' && ! observations.secureStorageAvailable ) {
			block( 'secure-storage-unavailable' );
		}
		observations.isolated = true;
	},
};

const SAVED_STAGES: StageDefinition[] = [
	prerequisitesStage,
	{
		name: 'sign-in',
		async run( ctx, observations ) {
			registerRegistrationCleanup( ctx );
			registerVaultKeyCleanup( ctx );
			const outcome = await signInStage( ctx, observations, undefined, 'vault' );
			const account = await ctx.services.broker.readAccount( outcome.registrationId );
			observations.signedIn = account?.state === 'signed-in';
			observations.storedInVault = ctx.services.broker.vaultRecordExists( outcome.registrationId );
			check( observations.signedIn, 'not-signed-in' );
			check( observations.storedInVault, 'vault-record-missing' );
		},
	},
	{
		name: 're-sign-in',
		async run( ctx, observations ) {
			const id = requireRegistration( ctx );
			const before = await ctx.services.broker.readAccount( id );
			const outcome = await signInStage( ctx, observations, id, 'vault' );
			const after = await ctx.services.broker.readAccount( id );
			observations.sameRegistration = outcome.registrationId === id;
			observations.sameRevision = after?.revision === before?.revision;
			observations.signedIn = after?.state === 'signed-in';
			check( observations.sameRegistration, 'registration-changed' );
			check( observations.signedIn, 'not-signed-in' );
		},
	},
	{
		name: 'model-discovery',
		async run( ctx, observations ) {
			const account = await requireSignedInAccount( ctx );
			const availability = await ctx.services.broker.readModels(
				account.registrationId,
				account.revision
			);
			observations.listedModels = availability.models?.length ?? 0;
			observations.selectedModelListed = Boolean(
				availability.models?.some( ( model ) => model.id === ctx.options.model )
			);
			observations.unqualifiedModelsListed = availability.listsUnqualifiedModels === true;
			observations.listReadFailed = availability.lastError !== null;
			check( ! observations.listReadFailed, 'model-list-failed' );
			check( observations.selectedModelListed, 'model-not-listed' );
		},
	},
	...MODEL_SMOKE_STAGES,
	{
		name: 'disposable-site',
		async run( ctx, observations ) {
			const sitePath = path.join( ctx.paths.sitesDir, SITE_FOLDER );
			ctx.state.siteName = SITE_NAME;
			ctx.state.sitePath = sitePath;
			ctx.state.siteCreated = false;
			ctx.saveState();
			ctx.cleanup.set( 'site', async ( report ) => {
				const { runCli } = ctx.services.processes;
				const stop = await runCli( 'site-stop', [ 'site', 'stop', '--path', sitePath ] );
				const remove = await runCli( 'site-delete', [ 'site', 'delete', sitePath, '--no-files' ] );
				// Only the run's own process manager: its home is inside the run directory.
				const daemon = await runCli( 'daemon-stop', [ 'site', 'stop', '--all' ] );
				report.siteStopFailed = stop.exitCode !== 0;
				report.siteDeleteFailed = remove.exitCode !== 0;
				report.daemonStopFailed = daemon.exitCode !== 0;
				// Without a created site, there was nothing these steps had to stop.
				return (
					! ctx.state.siteCreated ||
					( ! report.siteStopFailed && ! report.siteDeleteFailed && ! report.daemonStopFailed )
				);
			} );
			const created = await ctx.services.processes.runCli( 'site-create', [
				'site',
				'create',
				'--path',
				sitePath,
				'--name',
				SITE_NAME,
				'--skip-browser',
				'--skip-log-details',
			] );
			observations.siteCreated = created.exitCode === 0;
			check( observations.siteCreated, 'site-create-failed' );
			ctx.state.siteCreated = true;
			ctx.saveState();
			ctx.baseline = await readPosts( ctx, sitePath );
			observations.baselinePosts = ctx.baseline.length;
		},
	},
	{
		name: 'draft-turn',
		async run( ctx, observations ) {
			const account = await requireSignedInAccount( ctx );
			const site = requireSite( ctx );
			const sessionId = await ctx.services.sessions.create( site );
			const marker = createMarker();
			const title = `ChatGPT acceptance ${ marker }`;
			const content = `Acceptance marker ${ marker }.`;
			Object.assign( ctx.state, {
				draftSessionId: sessionId,
				draftTitle: title,
				draftContent: content,
				marker,
				effort: ctx.options.effort,
			} );
			ctx.saveState();
			await ctx.services.sessions.select( sessionId, {
				connectionId: account.registrationId,
				revision: account.revision,
				model: ctx.options.model,
				reasoningEffort: ctx.options.effort,
			} );
			const policy: ToolPolicy = { site, draftTitle: title, tools: [ 'wp_cli' ] };
			const result = await runTurn( ctx, {
				label: 'draft',
				sessionId,
				prompt:
					`Use WP-CLI on the active site "${ site.name }". First read the site title with \`option get blogname\`. ` +
					`Then create exactly one draft post, with post status draft and never published, titled "${ title }" with the content "${ content }". ` +
					'Do not change anything else and do not use any tool other than WP-CLI. Reply with the new post ID when done.',
				offerSessions: false,
				ipc: true,
				policy,
			} );
			const digest = judgeTurn( observations, result, policy );
			const wpCli = digest.toolCalls.filter( ( call ) => call.name === 'wp_cli' );
			observations.wpCliCalls = wpCli.length;
			observations.wpCliReads = wpCli.filter(
				( call ) =>
					call.isError === false &&
					isRecord( call.args ) &&
					typeof call.args.command === 'string' &&
					isWpCliReadCommand( call.args.command )
			).length;
			observations.modelRequests = routeRequests( result ).length;
			check( observations.completed === true, digest.failureCodes[ 0 ] ?? 'turn-failed' );
			check( observations.wpCliReads >= 1, 'no-site-read' );
		},
	},
	{
		name: 'draft-request-audit',
		async run( ctx, observations ) {
			const result = ctx.turns.draft ?? fail( 'no-draft-turn' );
			observations.streamed = routeRequests( result ).every(
				( request ) => request.stream === true
			);
			applyRouteAudit( observations, result, {
				model: ctx.options.model,
				effort: ctx.options.effort,
			} );
			check( observations.streamed, 'not-streamed' );
		},
	},
	{
		name: 'draft-readback',
		async run( ctx, observations ) {
			const site = requireSite( ctx );
			const before = ctx.baseline ?? fail( 'no-baseline' );
			const after = await readPosts( ctx, site.path );
			const added = after.filter( ( post ) => ! before.some( ( old ) => old.id === post.id ) );
			const draft = added[ 0 ];
			observations.newPosts = added.length;
			observations.statusDraft = draft?.status === 'draft';
			observations.titleMatches = draft?.title === ctx.state.draftTitle;
			observations.otherPostsUnchanged = before.every( ( old ) =>
				after.some(
					( post ) => post.id === old.id && post.title === old.title && post.status === old.status
				)
			);
			observations.contentMatches = false;
			if ( draft ) {
				const content = await ctx.services.processes.runCli( 'wp-post-get', [
					'wp',
					'--path',
					site.path,
					'post',
					'get',
					String( draft.id ),
					'--field=post_content',
				] );
				observations.contentMatches =
					content.exitCode === 0 && content.stdout.includes( ctx.state.draftContent ?? '\u0000' );
			}
			check( observations.newPosts === 1, 'draft-count' );
			check( observations.statusDraft, 'not-draft' );
			check( observations.titleMatches, 'title-mismatch' );
			check( observations.contentMatches, 'content-mismatch' );
			check( observations.otherPostsUnchanged, 'other-posts-changed' );
		},
	},
	{
		name: 'gate-t2-reasoning-replay',
		gate: 'T2',
		async run( ctx, observations ) {
			const site = requireSite( ctx );
			const sessionId = ctx.state.draftSessionId ?? fail( 'no-draft-session' );
			const policy: ToolPolicy = { site, tools: [] };
			const result = await runTurn( ctx, {
				label: 'gate-t2',
				sessionId,
				prompt:
					'Think it through step by step before answering: which is larger, 17 × 23 or 19 × 21? Before you answer, call site_info for the active site to check that it is running. Then reply with the larger product and whether the site is running.',
				offerSessions: false,
				ipc: true,
				policy,
			} );
			const digest = judgeTurn( observations, result, policy );
			const route = routeRequests( result ).sort(
				( a, b ) => a.startedAt - b.startedAt || a.id - b.id
			);
			const producing = route.findIndex(
				( request ) => ( responseFor( result, request )?.reasoningOutputs ?? 0 ) > 0
			);
			const next = producing >= 0 ? route[ producing + 1 ] : undefined;
			const nextResponse = next ? responseFor( result, next ) : undefined;
			observations.reasoningItemsProduced = route.reduce(
				( total, request ) => total + ( responseFor( result, request )?.reasoningOutputs ?? 0 ),
				0
			);
			observations.reasoningItemsReplayed = next?.reasoningItems ?? 0;
			observations.replayAccepted = nextResponse?.status === 200 && nextResponse.completed;
			if ( producing < 0 ) {
				return block( 'no-reasoning-item' );
			}
			check( next !== undefined, 'no-follow-up-request' );
			check( observations.reasoningItemsReplayed > 0, 'reasoning-not-replayed' );
			check( observations.replayAccepted, 'reasoning-replay-rejected' );
			check( observations.completed === true, digest.failureCodes[ 0 ] ?? 'turn-failed' );
		},
	},
	{
		name: 'effort-change',
		async run( ctx, observations ) {
			const account = await requireSignedInAccount( ctx );
			const sessionId = ctx.state.draftSessionId ?? fail( 'no-draft-session' );
			const efforts: readonly string[] =
				CHATGPT_MODEL_CAPABILITIES[ ctx.options.model ]?.reasoningEfforts ?? [];
			const next = efforts.find( ( effort ) => effort !== ctx.options.effort );
			if ( ! next ) {
				return block( 'no-other-qualified-effort' );
			}
			await ctx.services.sessions.select( sessionId, {
				connectionId: account.registrationId,
				revision: account.revision,
				model: ctx.options.model,
				reasoningEffort: next,
			} );
			ctx.state.effort = next;
			ctx.saveState();
			observations.effortChanged = true;
		},
	},
	{
		name: 'resume',
		async run( ctx, observations ) {
			const site = requireSite( ctx );
			const sessionId = ctx.state.draftSessionId ?? fail( 'no-draft-session' );
			const draft = ctx.turns.draft ?? fail( 'no-draft-turn' );
			const policy: ToolPolicy = { site, tools: [] };
			const result = await runTurn( ctx, {
				label: 'resume',
				sessionId,
				prompt:
					'Without using any tools, reply with only the marker word at the end of the title of the draft post you created earlier in this conversation.',
				offerSessions: false,
				ipc: true,
				policy,
			} );
			const digest = judgeTurn( observations, result, policy );
			const route = routeRequests( result );
			observations.freshProcess = result.pid !== undefined && result.pid !== draft.pid;
			observations.historyReplayed =
				route.length > 0 &&
				( route[ 0 ].assistantMessages ?? 0 ) + ( route[ 0 ].functionCalls ?? 0 ) > 0;
			observations.requestsAtNewEffort =
				route.length > 0 && route.every( ( request ) => request.effort === ctx.state.effort );
			observations.markerRecovered = Boolean(
				ctx.state.marker && digest.finalText.includes( ctx.state.marker )
			);
			check( observations.completed === true, digest.failureCodes[ 0 ] ?? 'turn-failed' );
			check( observations.freshProcess, 'same-process' );
			applyRouteAudit( observations, result, {
				model: ctx.options.model,
				effort: ctx.state.effort ?? ctx.options.effort,
			} );
			check( observations.historyReplayed, 'history-not-replayed' );
			check( observations.markerRecovered, 'continuity-lost' );
		},
	},
	{
		name: 'gate-t1-image-tool-result',
		gate: 'T1',
		async run( ctx, observations ) {
			const site = requireSite( ctx );
			const sessionId = ctx.state.draftSessionId ?? fail( 'no-draft-session' );
			const marker = createMarker();
			const titled = await ctx.services.processes.runCli( 'wp-blogname', [
				'wp',
				'--path',
				site.path,
				'option',
				'update',
				'blogname',
				marker,
			] );
			check( titled.exitCode === 0, 'site-title-not-set' );
			const policy: ToolPolicy = { site, tools: [ 'take_screenshot' ] };
			const result = await runTurn( ctx, {
				label: 'gate-t1',
				sessionId,
				prompt:
					"Take a screenshot of the active site's home page with take_screenshot, then reply with the site title exactly as it appears in the screenshot. Use no tool other than take_screenshot.",
				offerSessions: false,
				ipc: true,
				policy,
				toolImages: true,
			} );
			const digest = judgeTurn( observations, result, policy );
			const screenshots = digest.toolCalls.filter(
				( call ) => call.name === 'take_screenshot'
			).length;
			const imageRequests = routeRequests( result ).filter(
				( request ) => ( request.imageToolOutputs ?? 0 ) > 0
			);
			observations.screenshotCalls = screenshots;
			observations.otherToolCalls = digest.toolCalls.length - screenshots;
			observations.imageToolOutputsSent = imageRequests.reduce(
				( total, request ) => total + ( request.imageToolOutputs ?? 0 ),
				0
			);
			observations.routeAcceptedImageResult =
				imageRequests.length > 0 &&
				imageRequests.every( ( request ) => {
					const response = responseFor( result, request );
					return response?.status === 200 && response.completed;
				} );
			observations.markerReadFromImage = digest.finalText.includes( marker );
			check( screenshots > 0, 'no-screenshot' );
			check( observations.otherToolCalls === 0, 'other-tools-used' );
			check( observations.imageToolOutputsSent > 0, 'image-result-not-sent' );
			check( observations.routeAcceptedImageResult, 'image-tool-result-rejected' );
			check( observations.completed === true, digest.failureCodes[ 0 ] ?? 'turn-failed' );
			check( observations.markerReadFromImage, 'image-not-used' );
		},
	},
	{
		name: 'gate-t3-image-service-row',
		gate: 'T3',
		async run( ctx, observations ) {
			observations.imageServiceConfigured = await ctx.services.imageServiceConfigured();
			if ( ! observations.imageServiceConfigured ) {
				return block( 'image-service-not-configured' );
			}
			const site = requireSite( ctx );
			const sessionId = ctx.state.draftSessionId ?? fail( 'no-draft-session' );
			const policy: ToolPolicy = { site, tools: [ 'generate_images' ] };
			const result = await runTurn( ctx, {
				label: 'gate-t3',
				sessionId,
				prompt:
					'Use generate_images to make one small image of a plain blue square and save it under wp-content/uploads of the active site. Use no other tool, then reply DONE.',
				offerSessions: false,
				ipc: true,
				policy,
				persistenceFile: ( await ctx.services.sessions.filePath( sessionId ) ) ?? undefined,
			} );
			const digest = judgeTurn( observations, result, policy );
			const generated = digest.toolCalls.find( ( call ) => call.name === 'generate_images' );
			observations.generateImagesCalls = digest.toolCalls.filter(
				( call ) => call.name === 'generate_images'
			).length;
			observations.detailsDelivered = generated?.hasStudioService === true;
			// Read from the session file when the row arrived; no reading is no evidence.
			observations.persistenceChecked = typeof generated?.persistedAtReceipt === 'boolean';
			observations.deliveredBeforePersisted = generated?.persistedAtReceipt === false;
			check( generated !== undefined, 'no-image-generation' );
			check( observations.detailsDelivered, 'service-details-missing' );
			check( observations.persistenceChecked, 'session-file-unreadable' );
			check( observations.deliveredBeforePersisted, 'details-only-after-persisting' );
		},
	},
	{
		// So the sign-out has a grant this runner saw rotate to revoke, which
		// `remote-revocation` then probes, as the session scenario's hold does.
		name: 'refresh-before-sign-out',
		async run( ctx, observations ) {
			const { broker, tokens } = ctx.services;
			const id = requireRegistration( ctx );
			const before = tokens.refreshes();
			await broker.invalidateAccessToken( id, await broker.getAccessToken( id ) );
			await broker.getAccessToken( id );
			observations.refreshed = tokens.refreshes() > before;
			check( observations.refreshed, 'refresh-not-forced' );
		},
	},
	{
		name: 'active-run-stops-on-sign-out',
		async run( ctx, observations ) {
			const id = requireRegistration( ctx );
			const site = requireSite( ctx );
			const sessionId = ctx.state.draftSessionId ?? fail( 'no-draft-session' );
			const { clock } = ctx.services;
			const policy: ToolPolicy = { site, tools: [ 'wp_cli' ] };
			const turn = ctx.services.processes.startTurn( {
				label: 'active-run',
				sessionId,
				prompt:
					'Using WP-CLI on the active site, run each of these read-only commands one at a time, waiting for each result before the next: `option get blogname`, `plugin list`, `theme list`, `user list --fields=ID`, `post list --post_type=page`, `option get siteurl`. Then summarize them in one sentence.',
				offerSessions: false,
				ipc: true,
				policy,
			} );
			const active = await untilAborted(
				raceTimeout( turn.firstRequest(), FIRST_REQUEST_TIMEOUT_MS ),
				ctx.signal
			);
			observations.runActiveAtSignOut = active === true;
			if ( active === null ) {
				await turn.stop();
				return fail( 'no-first-request' );
			}
			const signOutBeganAt = clock.now();
			const signedOut = await ctx.services.broker.signOut( id );
			ctx.signOutResult = signedOut;
			observations.localCleared = signedOut.localCleared;
			observations.remoteRevocationConfirmed = signedOut.remoteRevocationConfirmed;
			observations.signOutTookS = round1(
				Math.min( Math.max( 0, clock.now() - signOutBeganAt ), SIGN_OUT_WAIT_MS ) / 1000
			);
			observations.watchPollS = CHATGPT_TURN_WATCH_POLL_MS / 1000;
			const result = await untilAborted( raceTimeout( turn.result, STOP_BOUND_MS ), ctx.signal );
			observations.stoppedWithinBound = result !== null;
			if ( ! result ) {
				await turn.stop();
				return fail( 'run-not-stopped' );
			}
			ctx.turns[ 'active-run' ] = result;
			const digest = observeTurn( observations, result, policy );
			// Work that began before the sign-out may finish. A turn's own watch
			// sees the sign-out within one poll of it beginning; anything that
			// starts later ran on a connection that was gone.
			const watchBoundAt = signOutBeganAt + CHATGPT_TURN_WATCH_POLL_MS;
			const inWatchWindow = ( at: number ) => at >= signOutBeganAt && at <= watchBoundAt;
			const endedAt = digest.endedAt ?? result.exitedAt;
			const route = routeRequests( result );
			observations.endedBeforeSignOut = endedAt < signOutBeganAt;
			observations.stopDelayS = round1(
				Math.min( Math.max( 0, endedAt - signOutBeganAt ), TURN_TIMEOUT_MS ) / 1000
			);
			observations.routeRequestsInWatchWindow = route.filter( ( request ) =>
				inWatchWindow( request.startedAt )
			).length;
			observations.routeRequestsAfterSignOut = route.filter(
				( request ) => request.startedAt > watchBoundAt
			).length;
			observations.toolStartsInWatchWindow = digest.toolCalls.filter( ( call ) =>
				inWatchWindow( call.startedAt )
			).length;
			observations.toolStartsAfterSignOut = digest.toolCalls.filter(
				( call ) => call.startedAt > watchBoundAt
			).length;
			observations.toolRunsAfterSignOut = digest.toolCalls.filter(
				( call ) => call.startedAt > watchBoundAt && call.isError === false
			).length;
			observations.endedSuccessfully =
				digest.status === 'success' || ( digest.status === null && digest.stopReason === 'stop' );
			observations.reportedSignedOut = digest.failureCodes.includes( 'signed-out' );
			// Stopped through the turn's own connection signal (its watch, or its
			// handle before a request or tool), or only by an error the broker
			// returned when the turn next asked it for a token.
			observations.stoppedByTurnHandle =
				observations.reportedSignedOut && digest.stopReason === 'aborted';
			observations.stoppedByBrokerErrorOnly =
				observations.reportedSignedOut && ! observations.stoppedByTurnHandle;
			observations.ownerInterruptSent = result.interruptedByRunner;
			check( observations.localCleared, 'local-not-cleared' );
			check( observations.unexpectedToolCalls === 0, 'unexpected-tool-call' );
			if ( ! observations.runActiveAtSignOut || observations.endedBeforeSignOut ) {
				return block( 'run-ended-before-sign-out' );
			}
			check( observations.routeRequestsAfterSignOut === 0, 'request-after-sign-out' );
			check( observations.toolStartsAfterSignOut === 0, 'tool-call-after-sign-out' );
			check( ! observations.endedSuccessfully, 'completed-after-sign-out' );
			check( observations.reportedSignedOut, 'stopped-for-other-reason' );
		},
	},
	{
		name: 'remote-revocation',
		async run( ctx, observations ) {
			const { broker, tokens } = ctx.services;
			const id = requireRegistration( ctx );
			observations.serviceConfirmedRevocation =
				ctx.signOutResult?.remoteRevocationConfirmed === true;
			const revocations = tokens.revocations();
			observations.revocationRequests = revocations.total;
			observations.rotatedRevokedBySignOut = revocations.rotatedRevoked;
			// The record itself, not the broker's word that it cleared it.
			observations.vaultRecordAfterSignOut = broker.vaultRecordExists( id );
			// The rotated token first: presenting the retired one can make the
			// service revoke the whole grant as reused, which would say nothing
			// about what the sign-out revoked.
			const rotated = await tokens.probe( 'rotated' );
			const retired = await tokens.probe( 'retired' );
			observations.probeTried = rotated.tried;
			observations.rotatedRefreshRejected = rotated.tried && rotated.rejected;
			observations.rejectionTerminal = rotated.terminal;
			observations.retiredRefreshRejected = retired.tried && retired.rejected;
			check( ! observations.vaultRecordAfterSignOut, 'vault-record-left' );
			if ( ! rotated.tried ) {
				return block( 'no-rotated-grant' );
			}
			check( observations.rotatedRefreshRejected, 'rotated-grant-usable' );
			check( observations.rotatedRevokedBySignOut, 'rotated-not-revoked-by-sign-out' );
			check( observations.retiredRefreshRejected, 'retired-refresh-accepted' );
		},
	},
	{
		name: 'blocked-after-sign-out',
		async run( ctx, observations ) {
			const site = requireSite( ctx );
			const sessionId = ctx.state.draftSessionId ?? fail( 'no-draft-session' );
			const policy: ToolPolicy = { site, tools: [] };
			const result = await runTurn( ctx, {
				label: 'after-sign-out',
				sessionId,
				prompt: READY_PROMPT,
				offerSessions: false,
				ipc: true,
				policy,
			} );
			const digest = judgeTurn( observations, result, policy );
			observations.routeRequests = routeRequests( result ).length;
			observations.apiKeyBearers = result.requests.filter(
				( request ) => request.bearer === 'api-key'
			).length;
			observations.otherProviderRequests = result.requests.filter( ( request ) =>
				[ 'openai-api', 'anthropic', 'wpcom-ai-proxy' ].includes( request.host )
			).length;
			observations.failedBeforeInference =
				observations.routeRequests === 0 && digest.status !== 'success';
			observations.reportedSignedOut = digest.failureCodes.some( ( code ) =>
				[ 'signed-out', 'connection-disconnected' ].includes( code )
			);
			check( observations.routeRequests === 0, 'inference-after-sign-out' );
			check(
				observations.apiKeyBearers === 0 && observations.otherProviderRequests === 0,
				'fallback-attempted'
			);
			check( observations.reportedSignedOut, 'unexpected-failure' );
		},
	},
];

// A dedicated eval profile: one registration signed in to the run's own
// profile with secure storage, left signed in for provider-qualified evals.
const PROVISION_STAGES: StageDefinition[] = [
	prerequisitesStage,
	{
		name: 'profile-sign-in',
		async run( ctx, observations ) {
			registerRegistrationCleanup( ctx );
			registerVaultKeyCleanup( ctx );
			const outcome = await signInStage( ctx, observations, undefined, 'vault' );
			const account = await ctx.services.broker.readAccount( outcome.registrationId );
			observations.signedIn = account?.state === 'signed-in';
			observations.storedInVault = ctx.services.broker.vaultRecordExists( outcome.registrationId );
			check( observations.signedIn, 'not-signed-in' );
			check( observations.storedInVault, 'vault-record-missing' );
			// Ready for evals: only a failure before here signs it out again, and
			// its vault key item stays until `retire`.
			ctx.cleanup.delete( 'registration' );
			ctx.cleanup.delete( 'vault-key' );
			observations.leftSignedIn = true;
		},
	},
];

// Retires a dedicated eval profile: its registration signed out, locally and
// at ChatGPT, then its own vault key item removed.
const RETIRE_STAGES: StageDefinition[] = [
	prerequisitesStage,
	{
		name: 'profile-sign-out',
		async run( ctx, observations ) {
			const id = requireRegistration( ctx );
			// The broker names the item from the profile's real path now; a profile
			// moved or copied since `provision` names one its records weren't
			// sealed under. Nothing is signed out or removed through another name.
			const recorded = ctx.state.vaultKeySuffix
				? `${ UNSCOPED_VAULT_KEY_ITEM }-${ ctx.state.vaultKeySuffix }`
				: null;
			observations.vaultKeyNameMatches =
				recorded !== null && scopedVaultKeyItem( ctx ) === recorded;
			check( observations.vaultKeyNameMatches, 'vault-key-name-mismatch' );
			registerVaultKeyCleanup( ctx );
			const account = await ctx.services.broker.readAccount( id );
			observations.wasSignedIn = account?.state === 'signed-in';
			if ( ! observations.wasSignedIn ) {
				block( 'already-signed-out' );
			}
			const result = await ctx.services.broker.signOut( id );
			observations.localCleared = result.localCleared;
			observations.remoteRevocationConfirmed = result.remoteRevocationConfirmed;
			observations.vaultKeyRemoved = await removeRunVaultKey( ctx );
			if ( observations.vaultKeyRemoved ) {
				ctx.cleanup.delete( 'vault-key' );
			}
			check( result.localCleared, 'local-not-cleared' );
			check( result.remoteRevocationConfirmed, 'remote-revocation-unconfirmed' );
			check( observations.vaultKeyRemoved, 'vault-key-not-removed' );
		},
	},
];

const SESSION_STAGES: StageDefinition[] = [
	prerequisitesStage,
	{
		name: 'returning-sign-in',
		async run( ctx, observations ) {
			const id = requireRegistration( ctx );
			registerRegistrationCleanup( ctx );
			const outcome = await signInStage( ctx, observations, id, 'session' );
			observations.sameRegistration = outcome.registrationId === id;
			check( observations.sameRegistration, 'registration-changed' );
		},
	},
	{
		name: 'no-persisted-record',
		async run( ctx, observations ) {
			const id = requireRegistration( ctx );
			const account = await ctx.services.broker.readAccount( id );
			observations.signedIn = account?.state === 'signed-in';
			observations.storageSession = account?.storage === 'session';
			observations.vaultRecordPresent = ctx.services.broker.vaultRecordExists( id );
			check( observations.signedIn, 'not-signed-in' );
			check( observations.storageSession, 'not-session-storage' );
			check( ! observations.vaultRecordPresent, 'credential-record-persisted' );
		},
	},
	{
		name: 'offered-fork-inference',
		async run( ctx, observations ) {
			const account = await requireSignedInAccount( ctx );
			const sessionId = await ctx.services.sessions.create();
			ctx.state.offeredSessionId = sessionId;
			ctx.saveState();
			await ctx.services.sessions.select( sessionId, {
				connectionId: account.registrationId,
				revision: account.revision,
				model: ctx.options.model,
				reasoningEffort: ctx.options.effort,
			} );
			const policy: ToolPolicy = { tools: [] };
			const result = await runTurn( ctx, {
				label: 'offered-fork',
				sessionId,
				prompt: READY_PROMPT,
				offerSessions: true,
				ipc: true,
				policy,
			} );
			const digest = judgeTurn( observations, result, policy );
			observations.tokenAsks = result.tokenAsks;
			observations.tokensHandedOut = result.tokensHandedOut;
			observations.answeredReady = /\bREADY\b/.test( digest.finalText );
			check( observations.completed === true, digest.failureCodes[ 0 ] ?? 'turn-failed' );
			check( result.tokensHandedOut > 0, 'no-token-over-ipc' );
			applyRouteAudit( observations, result, {
				model: ctx.options.model,
				effort: ctx.options.effort,
			} );
		},
	},
	{
		name: 'unoffered-process-fails',
		async run( ctx, observations ) {
			const sessionId = ctx.state.offeredSessionId ?? fail( 'no-offered-session' );
			const policy: ToolPolicy = { tools: [] };
			const result = await runTurn( ctx, {
				label: 'unoffered',
				sessionId,
				prompt: READY_PROMPT,
				offerSessions: false,
				ipc: false,
				policy,
			} );
			const digest = judgeTurn( observations, result, policy );
			observations.tokenAsks = result.tokenAsks;
			observations.routeRequests = routeRequests( result ).length;
			observations.apiKeyBearers = result.requests.filter(
				( request ) => request.bearer === 'api-key'
			).length;
			observations.otherProviderRequests = result.requests.filter( ( request ) =>
				[ 'openai-api', 'anthropic', 'wpcom-ai-proxy' ].includes( request.host )
			).length;
			observations.failedBeforeInference =
				observations.routeRequests === 0 && digest.status !== 'success';
			observations.reportedUnavailable = digest.failureCodes.some( ( code ) =>
				[ 'connection-disconnected', 'session-unavailable' ].includes( code )
			);
			check( observations.routeRequests === 0, 'inference-without-offer' );
			check(
				observations.apiKeyBearers === 0 && observations.otherProviderRequests === 0,
				'fallback-attempted'
			);
			check( observations.reportedUnavailable, 'unexpected-failure' );
		},
	},
	{
		name: 'refresh-hold-across-sign-out',
		async run( ctx, observations ) {
			const { broker, tokens, clock, processes } = ctx.services;
			const id = requireRegistration( ctx );
			// The generation a fork offered this session would ask with.
			const { logoutGeneration } = await requireSignedInAccount( ctx );
			const sessionId = ctx.state.offeredSessionId ?? fail( 'no-offered-session' );
			const current = await broker.getAccessToken( id );
			const hold = tokens.holdNextRefresh();
			let signingOut: Promise< void > | null = null;
			ctx.cleanup.set( 'refresh', async ( report ) => {
				hold.release();
				await tokens.settle();
				report.heldRefreshReleased = true;
				// A sign-out this stage began revokes what the release returned.
				if ( signingOut ) {
					report.signOutSettled =
						( await raceTimeout(
							signingOut.then( () => true ),
							SIGN_OUT_WAIT_MS
						) ) === true;
				}
				return true;
			} );
			// The waits for the hold, the fork and the sign-out end at once on an
			// interrupt; cleanup releases the hold. A probe isn't cut short: each
			// one revokes whatever it was issued.
			const abortable = < T >( promise: Promise< T > ) => untilAborted( promise, ctx.signal );
			await broker.invalidateAccessToken( id, current );
			let renewalError: unknown = null;
			const renewal = broker.getAccessToken( id ).then(
				() => undefined,
				( error: unknown ) => {
					renewalError = error;
				}
			);
			observations.refreshHeld =
				( await abortable( raceTimeout( hold.held, HOLD_WAIT_MS ) ) ) === true;
			if ( ! observations.refreshHeld ) {
				hold.release();
				await abortable( raceTimeout( renewal, SETTLE_WAIT_MS ) );
				return block( 'refresh-not-held' );
			}
			const heldAt = clock.now();
			let signOutResult: { localCleared: boolean; remoteRevocationConfirmed: boolean } | null =
				null;
			signingOut = broker.signOut( id ).then(
				( result ) => {
					signOutResult = result;
				},
				() => undefined
			);
			observations.generationAdvancedDuringHold = await waitUntil(
				ctx,
				async () => ( await broker.readAccount( id ) )?.state === 'signed-out',
				Math.max( 0, HOLD_MAX_MS / 2 )
			);
			if ( ctx.signal.aborted ) {
				throw new AcceptanceInterrupted();
			}
			// The offer may linger until the held refresh settles.
			observations.offerAdvertisedDuringWindow = offeredRegistrations(
				broker.sessionForkEnvironment()
			).includes( id );
			// A forked turn started now lists the account as disconnected and never
			// asks, so the runner asks this app itself, as a fork's request would.
			const ask = broker.askSessionToken( id, logoutGeneration );
			const fork = processes.startTurn( {
				label: 'window-fork',
				sessionId,
				prompt: READY_PROMPT,
				offerSessions: true,
				ipc: true,
				policy: { tools: [] },
			} );
			const early = await abortable(
				raceTimeout( fork.result, Math.max( 0, HOLD_MAX_MS - ( clock.now() - heldAt ) ) )
			);
			observations.windowForkEndedBeforeRelease = early !== null;
			hold.release();
			await abortable( raceTimeout( renewal, SETTLE_WAIT_MS ) );
			const forkResult = early ?? ( await abortable( raceTimeout( fork.result, STOP_BOUND_MS ) ) );
			if ( ! forkResult ) {
				await fork.stop();
			}
			const asked = await abortable( raceTimeout( ask, SETTLE_WAIT_MS ) );
			observations.windowDirectAskAnswered = asked !== null;
			observations.windowDirectAskRefused = asked === false;
			observations.windowDirectAskGotToken = asked === true;
			const forkDigest = forkResult ? digestTurnEvents( forkResult.events ) : null;
			observations.windowForkTokenAsks = forkResult?.tokenAsks ?? 0;
			observations.windowForkTokensHandedOut = forkResult?.tokensHandedOut ?? 0;
			observations.windowForkRouteRequests = forkResult ? routeRequests( forkResult ).length : 0;
			observations.windowForkFallbackRequests = forkResult
				? forkResult.requests.filter(
						( request ) =>
							request.bearer === 'api-key' ||
							[ 'openai-api', 'anthropic', 'wpcom-ai-proxy' ].includes( request.host )
				  ).length
				: 0;
			observations.windowForkSucceeded = forkDigest?.status === 'success';
			observations.windowForkReportedUnavailable = Boolean(
				forkDigest?.failureCodes.some( ( code ) =>
					[ 'connection-disconnected', 'session-unavailable', 'signed-out' ].includes( code )
				)
			);
			observations.heldRefreshRejectedSignedOut =
				renewalError instanceof ChatGptConnectionError && renewalError.code === 'signed-out';
			await abortable( raceTimeout( signingOut, SIGN_OUT_WAIT_MS ) );
			const signedOut = signOutResult as {
				localCleared: boolean;
				remoteRevocationConfirmed: boolean;
			} | null;
			ctx.signOutResult = signedOut;
			observations.localCleared = signedOut?.localCleared === true;
			observations.remoteRevocationConfirmed = signedOut?.remoteRevocationConfirmed === true;
			observations.offerGoneAfterSettle = ! offeredRegistrations(
				broker.sessionForkEnvironment()
			).includes( id );
			observations.rotatedRevokedBySignOut = tokens.revocations().rotatedRevoked;
			// The rotated token first: presenting the retired one can make the
			// service revoke the whole grant as reused, which would say nothing
			// about what the sign-out revoked.
			const rotated = await tokens.probe( 'rotated' );
			const retired = await tokens.probe( 'retired' );
			observations.rotatedRefreshRejected = rotated.tried && rotated.rejected;
			observations.retiredRefreshRejected = retired.tried && retired.rejected;
			ctx.cleanup.delete( 'refresh' );
			check( forkResult !== null, 'window-fork-not-stopped' );
			check( observations.windowForkTokensHandedOut === 0, 'token-handed-out-during-window' );
			check(
				observations.windowForkRouteRequests === 0 && observations.windowForkFallbackRequests === 0,
				'inference-during-window'
			);
			check( ! observations.windowForkSucceeded, 'window-fork-completed' );
			// An answer is owed only while the offer lingers; a token never is.
			if ( observations.offerAdvertisedDuringWindow ) {
				check( observations.windowDirectAskAnswered, 'window-ask-unanswered' );
			}
			check( ! observations.windowDirectAskGotToken, 'window-ask-got-token' );
			check( observations.heldRefreshRejectedSignedOut, 'held-refresh-not-rejected' );
			check( observations.localCleared, 'local-not-cleared' );
			check( observations.offerGoneAfterSettle, 'offer-not-pruned' );
			check( observations.rotatedRefreshRejected, 'rotated-grant-usable' );
			check( observations.rotatedRevokedBySignOut, 'rotated-not-revoked-by-sign-out' );
			check( observations.retiredRefreshRejected, 'retired-refresh-accepted' );
		},
	},
];

export const SAVED_STAGE_NAMES: readonly string[] = SAVED_STAGES.map( ( stage ) => stage.name );
export const SESSION_STAGE_NAMES: readonly string[] = SESSION_STAGES.map( ( stage ) => stage.name );
export const PROVISION_STAGE_NAMES: readonly string[] = PROVISION_STAGES.map(
	( stage ) => stage.name
);
export const RETIRE_STAGE_NAMES: readonly string[] = RETIRE_STAGES.map( ( stage ) => stage.name );

const STAGES: Record< AcceptanceScenario, StageDefinition[] > = {
	saved: SAVED_STAGES,
	session: SESSION_STAGES,
	provision: PROVISION_STAGES,
	retire: RETIRE_STAGES,
};

function verdictOf(
	error: unknown,
	signal: AbortSignal
): { status: 'failed' | 'blocked'; code: string } {
	if ( error instanceof StageVerdict ) {
		return { status: error.status, code: error.code };
	}
	if ( error instanceof AcceptanceInterrupted || signal.aborted ) {
		return { status: 'failed', code: 'interrupted' };
	}
	if ( error instanceof ChatGptSignInError || error instanceof ChatGptConnectionError ) {
		return { status: 'failed', code: error.code };
	}
	if ( error instanceof ChatGptSettingsError ) {
		return { status: 'failed', code: 'settings-refused' };
	}
	return { status: 'failed', code: 'unexpected-error' };
}

function recordSafely(
	ctx: StageContext,
	record: Omit< StageRecord, 'schemaVersion' | 'run' | 'scenario' >
): StageRecord {
	const base = { run: ctx.run, scenario: ctx.options.scenario };
	try {
		return ctx.evidence.record( { ...base, ...record } );
	} catch ( error ) {
		if ( ! ( error instanceof UnsafeEvidenceError ) ) {
			throw error;
		}
		return ctx.evidence.record( {
			...base,
			stage: record.stage,
			status: 'failed',
			code: 'unsafe-evidence',
			durationS: record.durationS,
			observations: {},
		} );
	}
}

function printRecord( ctx: StageContext, record: StageRecord ): void {
	const duration = sprintf(
		/* translators: %s: a duration in seconds. */
		__( '%s s' ),
		String( record.durationS )
	);
	ctx.print(
		record.code
			? sprintf(
					/* translators: 1: stage name, 2: passed, failed, blocked or skipped, 3: typed code, 4: duration. */
					__( '[%2$s] %1$s: %3$s (%4$s)' ),
					record.stage,
					record.status,
					record.code,
					duration
			  )
			: sprintf(
					/* translators: 1: stage name, 2: passed, failed, blocked or skipped, 3: duration. */
					__( '[%2$s] %1$s (%3$s)' ),
					record.stage,
					record.status,
					duration
			  )
	);
}

async function executeStage(
	ctx: StageContext,
	definition: StageDefinition
): Promise< StageRecord > {
	const observations: Observations = {};
	const startedAt = ctx.services.clock.now();
	let status: StageStatus = 'passed';
	let code: string | undefined;
	if ( definition.gate && ! ctx.options.gates.includes( definition.gate ) ) {
		status = 'skipped';
		code = 'not-requested';
	} else {
		try {
			await definition.run( ctx, observations );
		} catch ( error ) {
			( { status, code } = verdictOf( error, ctx.signal ) );
		}
	}
	const record = recordSafely( ctx, {
		stage: definition.name,
		status,
		...( code ? { code } : {} ),
		durationS: round1( Math.max( 0, ctx.services.clock.now() - startedAt ) / 1000 ),
		observations,
	} );
	printRecord( ctx, record );
	return record;
}

async function runCleanup( ctx: StageContext ): Promise< StageRecord > {
	const report: Observations = {};
	const startedAt = ctx.services.clock.now();
	let failures = 0;
	for ( const slot of CLEANUP_ORDER ) {
		const action = ctx.cleanup.get( slot );
		if ( ! action ) {
			continue;
		}
		try {
			const ok = await raceTimeout( action( report ), CLEANUP_STEP_MS );
			if ( ok !== true ) {
				failures++;
			}
		} catch {
			failures++;
		}
	}
	report.stepFailures = failures;
	const record = recordSafely( ctx, {
		stage: 'cleanup',
		status: failures ? 'failed' : 'passed',
		...( failures ? { code: 'cleanup-failed' } : {} ),
		durationS: round1( Math.max( 0, ctx.services.clock.now() - startedAt ) / 1000 ),
		observations: report,
	} );
	printRecord( ctx, record );
	return record;
}

// ---------------------------------------------------------------------------
// The run: refusals before anything live, then stages, then cleanup.

function describeArgumentProblem( problem: ArgumentProblem ): string {
	switch ( problem ) {
		case 'scenario-missing':
			return __(
				'Choose a scenario with --scenario saved, session, provision (a dedicated eval profile) or retire (its sign-out).'
			);
		case 'scenario-unknown':
			return __( 'The scenario must be saved, session, provision or retire.' );
		case 'gate-unknown':
			return __( 'The optional gates are T1, T2, T3 and T4.' );
		case 'option-not-for-session':
			return __(
				'The session scenario uses the model, effort and site of the saved run in the same directory, so it takes no --model, --effort or --gates.'
			);
		case 'option-not-for-profile':
			return __(
				'The provision and retire scenarios only sign a dedicated eval profile in or out, so they take no --model, --effort or --gates.'
			);
		case 'option-unknown':
			return __( 'That option isn’t one this runner takes.' );
		case 'option-value-missing':
			return __( 'An option is missing its value.' );
	}
}

function describeIsolationProblem( problem: AcceptanceIsolationProblem ): string {
	switch ( problem ) {
		case 'run-dir-missing':
			return __( 'Pass --run-dir with an absolute path for this run’s files.' );
		case 'run-dir-relative':
			return __( 'The run directory must be an absolute path.' );
		case 'run-dir-not-empty':
			return __(
				'The saved and provision scenarios start a new run: choose a run directory that doesn’t exist yet or is empty.'
			);
		case 'run-dir-not-found':
			return __(
				'The session and retire scenarios continue an earlier run: pass that run’s directory.'
			);
		case 'run-dir-in-studio-profile':
			return __( 'The run directory can’t be inside your Studio profile.' );
		case 'run-dir-folder-outside':
			return __(
				'A folder of the run directory (its profile, process manager, sites or another) leads outside it through a link, so nothing was run.'
			);
	}
}

function describeRealProfileHazard( hazard: RealProfileHazard ): string {
	switch ( hazard ) {
		case 'legacy-process-manager-home':
			return __(
				'Your Studio profile still has the process manager folder of an older Studio version (.studio/pm2) and no .studio/daemon. Every Studio CLI process this runner starts would rename that folder in your real profile, outside the run directory, so nothing was run. Run any command of your installed Studio CLI once, for example “studio site list”, to finish that rename, then run this again.'
			);
	}
}

type SessionProblem =
	| 'manifest-missing'
	| 'manifest-unreadable'
	| 'no-saved-run'
	| 'no-provision-run'
	| 'source-changed'
	| 'registration-missing';

function describeSessionProblem( problem: SessionProblem ): string {
	switch ( problem ) {
		case 'manifest-missing':
			return __(
				'This run directory has no manifest from an earlier run, so there is nothing to continue. Run the saved or provision scenario in it first.'
			);
		case 'manifest-unreadable':
			return __( 'Studio can’t read this run directory’s manifest, so nothing was run.' );
		case 'no-saved-run':
			return __( 'This run directory has no saved run to continue.' );
		case 'no-provision-run':
			return __(
				'This run directory holds no dedicated eval profile: run the provision scenario in a new directory first.'
			);
		case 'source-changed':
			return __(
				'The saved run in this directory used a different source commit. Run both scenarios from the same commit.'
			);
		case 'registration-missing':
			return __(
				'The saved run in this directory left no ChatGPT registration to sign in to again. Run the saved scenario in a new directory.'
			);
	}
}

function usage(): string {
	return __(
		'Usage: node apps/cli/dist/cli/chatgpt-acceptance.mjs --scenario saved|session|provision|retire --run-dir <absolute path> [--live] [--model <model>] [--effort <effort>] [--gates T1,T2,T3,T4]'
	);
}

function checkContinuedRun(
	evidence: AcceptanceEvidence,
	facts: RunFacts,
	from: 'saved' | 'provision'
):
	| { ok: true; saved: ManifestRun; state: AcceptanceState }
	| { ok: false; problem: SessionProblem } {
	let runs: ManifestRun[];
	try {
		const manifest = evidence.readManifest();
		if ( ! manifest ) {
			return { ok: false, problem: 'manifest-missing' };
		}
		runs = manifest.runs;
	} catch ( error ) {
		if ( error instanceof AcceptanceManifestError ) {
			return { ok: false, problem: 'manifest-unreadable' };
		}
		throw error;
	}
	const saved = [ ...runs ].reverse().find( ( run ) => run.scenario === from );
	if ( ! saved ) {
		return { ok: false, problem: from === 'saved' ? 'no-saved-run' : 'no-provision-run' };
	}
	// A sign-out works from any commit; a session continues the saved run's.
	if ( from === 'saved' && ( ! facts.source.sha || saved.source.sha !== facts.source.sha ) ) {
		return { ok: false, problem: 'source-changed' };
	}
	let state: Record< string, unknown > | null;
	try {
		state = evidence.readState();
	} catch {
		state = null;
	}
	if ( ! state || ! isChatGptRegistrationId( state.registrationId ) ) {
		return { ok: false, problem: 'registration-missing' };
	}
	return {
		ok: true,
		saved,
		state: { ...( state as unknown as AcceptanceState ), schemaVersion: 1 },
	};
}

function printPlan( print: ( line: string ) => void, options: ChatGptAcceptanceOptions ): void {
	const stages = STAGES[ options.scenario ];
	print(
		sprintf(
			/* translators: 1: scenario name, 2: model, 3: reasoning effort. */
			__( 'Scenario %1$s on %2$s at %3$s effort. Stages:' ),
			options.scenario,
			options.model,
			options.effort
		)
	);
	for ( const stage of stages ) {
		const summary = stage.summary?.();
		print(
			stage.gate && summary
				? sprintf(
						/* translators: 1: stage name, 2: gate name such as T4, 3: what the stage covers. */
						__( '  %1$s (optional: runs with --gates %2$s): %3$s' ),
						stage.name,
						stage.gate,
						summary
				  )
				: stage.gate
				? sprintf(
						/* translators: 1: stage name, 2: gate name such as T1. */
						__( '  %1$s (optional: runs with --gates %2$s)' ),
						stage.name,
						stage.gate
				  )
				: `  ${ stage.name }`
		);
	}
}

/** Runs the acceptance command line; resolves to the process exit code. */
export async function runChatGptAcceptance(
	argv: readonly string[],
	deps: ChatGptAcceptanceDependencies
): Promise< number > {
	// The evidence's own check: no line names a path, an identifier or a secret.
	const print = ( line: string ) =>
		deps.print(
			findUnsafeText( line )
				? __(
						'[A line was withheld because it looked like a secret, an address or an identifier.]'
				  )
				: line
		);
	const parsed = parseChatGptAcceptanceArgs( argv );
	if ( 'help' in parsed ) {
		print( usage() );
		return EXIT_PASSED;
	}
	if ( ! parsed.ok ) {
		print( describeArgumentProblem( parsed.problem ) );
		print( usage() );
		return EXIT_REFUSED;
	}
	const options = { ...parsed.options };
	const isolation = applyAcceptanceIsolation( deps.env, {
		runDir: options.runDir,
		mustBeNew: acceptanceStartsNewRun( options.scenario ),
		home: deps.home,
	} );
	if ( ! isolation.ok ) {
		print( describeIsolationProblem( isolation.problem ) );
		return EXIT_REFUSED;
	}
	const { paths } = isolation;
	const leak = findRealProfileLeak( deps.env, deps.home );
	const profileOk = isInsideAcceptanceRun( deps.configDirectory(), paths.profileDir );
	const daemonOk = isInsideAcceptanceRun( deps.processManagerHome(), paths.daemonDir );
	if ( leak || ! profileOk || ! daemonOk ) {
		print(
			sprintf(
				/* translators: %s: an environment variable name such as DEV_CONFIG_DIR. */
				__( 'This run would use your real Studio profile (%s), so nothing was run.' ),
				leak ?? ( profileOk ? 'STUDIO_PROCESS_MANAGER_HOME' : 'DEV_CONFIG_DIR' )
			)
		);
		return EXIT_REFUSED;
	}
	const hazard = findRealProfileHazard( deps.home );
	if ( hazard ) {
		print( describeRealProfileHazard( hazard ) );
		return EXIT_REFUSED;
	}

	const facts = await deps.collectFacts();
	let state: AcceptanceState = { schemaVersion: 1 };
	if ( options.scenario === 'session' || options.scenario === 'retire' ) {
		const compatible = checkContinuedRun(
			openAcceptanceEvidence( paths.runDir, CHATGPT_ACCEPTANCE_PROVIDER ),
			facts,
			options.scenario === 'session' ? 'saved' : 'provision'
		);
		if ( ! compatible.ok ) {
			print( describeSessionProblem( compatible.problem ) );
			return EXIT_REFUSED;
		}
		options.model = compatible.saved.model;
		options.effort = compatible.saved.effort;
		state = compatible.state;
	}
	const reasoning = resolveChatGptReasoning( options.model, options.effort );
	if ( ! reasoning.ok ) {
		print( describeChatGptReasoningProblem( reasoning.problem ) );
		return EXIT_REFUSED;
	}

	printPlan( print, options );
	if ( ! options.live ) {
		print(
			__(
				'Dry check only: nothing was run, and nothing reached a network, a browser, the system keychain, a Studio profile or a site. Add --live to run these stages against a real ChatGPT account.'
			)
		);
		return EXIT_REFUSED;
	}

	for ( const directory of [
		paths.runDir,
		paths.profileDir,
		paths.daemonDir,
		paths.sitesDir,
		paths.appDataDir,
		paths.observerDir,
		paths.wpCliDir,
	] ) {
		fs.mkdirSync( directory, { recursive: true } );
	}
	const evidence = openAcceptanceEvidence( paths.runDir, CHATGPT_ACCEPTANCE_PROVIDER );
	const controller = new AbortController();
	let interrupted = false;
	const stopListening = deps.onInterrupt( () => {
		interrupted = true;
		// Before any write: after a hang-up the terminal may take none.
		controller.abort();
		print( __( 'Interrupted: stopping the current stage and cleaning up…' ) );
	} );
	try {
		const services = await deps.createServices( { paths, options, print } );
		const run = evidence.startRun( {
			scenario: options.scenario,
			createdOn: new Date( services.clock.now() ).toISOString().slice( 0, 10 ),
			...facts,
			model: options.model,
			effort: options.effort,
			gates: options.scenario === 'saved' ? options.gates : [],
		} );
		const ctx: StageContext = {
			options,
			paths,
			services,
			evidence,
			run,
			state,
			saveState: () => evidence.writeState( { ...ctx.state } ),
			print,
			signal: controller.signal,
			cleanup: new Map(),
			turns: {},
			baseline: null,
			signOutResult: null,
		};
		ctx.cleanup.set( 'processes', async ( report ) => {
			const { stopped, failed } = await services.processes.stopOwned();
			report.processesStopped = stopped;
			report.processStopFailures = failed;
			return failed === 0;
		} );
		ctx.saveState();
		print( __( 'Evidence goes to the run directory you passed with --run-dir.' ) );

		let firstFailure: StageRecord | null = null;
		let gateFailed = false;
		let cleanup: StageRecord;
		try {
			for ( const definition of STAGES[ options.scenario ] ) {
				const record = await executeStage( ctx, definition );
				if ( record.status !== 'failed' && record.status !== 'blocked' ) {
					continue;
				}
				if ( definition.gate ) {
					gateFailed ||= record.status === 'failed';
					continue;
				}
				firstFailure = record;
				break;
			}
		} finally {
			cleanup = await runCleanup( ctx );
		}
		if ( firstFailure ) {
			print(
				sprintf(
					/* translators: 1: stage name, 2: typed failure code. */
					__( 'Result: stopped at %1$s (%2$s).' ),
					firstFailure.stage,
					firstFailure.code ?? firstFailure.status
				)
			);
		}
		if ( cleanup.status === 'failed' ) {
			print(
				firstFailure
					? __( 'Cleanup failed too (cleanup-failed); the stage above is the run’s result.' )
					: __( 'Result: every stage ran, but cleanup failed (cleanup-failed).' )
			);
		} else if ( ! firstFailure ) {
			print(
				gateFailed
					? __( 'Result: the required stages passed; a requested gate failed.' )
					: __( 'Result: every required stage passed.' )
			);
			if ( options.scenario === 'provision' ) {
				print(
					__(
						'The dedicated eval profile is ready and stays signed in. For a provider-qualified eval, set STUDIO_EVAL_CHATGPT_PROFILE to the profile folder of this run directory and STUDIO_EVAL_CONNECTION to the registrationId in its state.json. Retire it with --scenario retire and the same run directory.'
					)
				);
			}
		}
		if ( interrupted ) {
			return EXIT_INTERRUPTED;
		}
		return firstFailure || cleanup.status === 'failed' || gateFailed ? EXIT_FAILED : EXIT_PASSED;
	} catch ( error ) {
		// Never the error's text: it may quote what evidence must not hold.
		print(
			sprintf(
				/* translators: %s: an error class name. */
				__( 'The run stopped on an unexpected %s; see the evidence recorded so far.' ),
				error instanceof Error ? error.name : 'error'
			)
		);
		return interrupted ? EXIT_INTERRUPTED : EXIT_FAILED;
	} finally {
		stopListening();
	}
}

// ---------------------------------------------------------------------------
// Live: the app's own broker, sign-in flow, sessions and the built CLI.

const PROVIDER_SECRET_VARIABLES = new Set( [
	'OPENAI_API_KEY',
	'STUDIO_OPENAI_API_KEY',
	'ANTHROPIC_API_KEY',
	'ANTHROPIC_AUTH_TOKEN',
	'STUDIO_WPCOM_API_KEY',
] );

/** What every CLI process the runner starts gets: its own isolated environment, without provider keys. */
export function acceptanceChildEnvironment(
	base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
	const env = { ...base };
	for ( const name of Object.keys( env ) ) {
		if ( PROVIDER_SECRET_VARIABLES.has( name.toUpperCase() ) ) {
			delete env[ name ];
		}
	}
	return env;
}

const sleep = ( ms: number, signal?: AbortSignal ) =>
	new Promise< void >( ( resolve ) => {
		const timer = setTimeout( resolve, ms );
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout( timer );
				resolve();
			},
			{ once: true }
		);
	} );

/**
 * Whether the session file already holds the result of a tool call; null when
 * the file can't be read, which says nothing either way.
 */
export function isToolResultPersisted( sessionFile: string, toolCallId: string ): boolean | null {
	let text: string;
	try {
		text = fs.readFileSync( sessionFile, 'utf8' );
	} catch {
		return null;
	}
	return text.split( /\r?\n/ ).some( ( line ) => {
		if ( ! line.includes( toolCallId ) ) {
			return false;
		}
		try {
			const entry = JSON.parse( line ) as {
				type?: string;
				message?: { role?: string; toolCallId?: string };
			};
			return (
				entry.type === 'message' &&
				entry.message?.role === 'toolResult' &&
				entry.message.toolCallId === toolCallId
			);
		} catch {
			return false;
		}
	} );
}

const isJsonEvent = ( message: unknown ): message is JsonEvent =>
	isRecord( message ) && typeof message.type === 'string';

// With a callback, a send that fails is reported there rather than as the child's 'error'.
function sendQuietly(
	child: ChildProcess,
	message: Parameters< ChildProcess[ 'send' ] >[ 0 ]
): void {
	if ( ! child.connected ) {
		return;
	}
	try {
		child.send( message, () => undefined );
	} catch {
		// The channel closed meanwhile.
	}
}

// On POSIX each CLI process the runner starts leads a process group of its
// own, which holds what it starts in turn; on Windows the runner finds a
// tree's processes itself (see `endProcessTree`).
const CHILDREN_LEAD_PROCESS_GROUPS = process.platform !== 'win32';
const CHILD_STOP_WAIT_MS = 3_000;

// Every CLI process this runner started that hasn't closed yet.
const runningChildren = new Set< ChildProcess >();

const describeDescendantsMayRemain = () =>
	__(
		'A CLI process this run started was ended, but the processes it had started couldn’t be listed, so some of them may still be running.'
	);

/**
 * Stops a child the runner started: a turn is asked to stop first, over its
 * IPC channel; then its whole tree is ended while the child still runs, since
 * ending the child first would leave its descendants out of reach.
 */
async function stopChild(
	child: ChildProcess,
	onDescendantsMayRemain: () => void
): Promise< boolean > {
	if ( hasExited( child ) ) {
		return true;
	}
	const exited = new Promise< true >( ( resolve ) => child.once( 'exit', () => resolve( true ) ) );
	const exitedWithin = async ( ms: number ) =>
		hasExited( child ) || ( await raceTimeout( exited, ms ) ) === true;
	if ( child.connected ) {
		sendQuietly( child, { type: 'interrupt' } );
		if ( await exitedWithin( CHILD_STOP_WAIT_MS ) ) {
			return true;
		}
	}
	endProcessTree( child, { onDescendantsMayRemain } );
	if ( await exitedWithin( CHILD_STOP_WAIT_MS ) ) {
		return true;
	}
	// The tree couldn't be ended (no process group): the child alone, at least.
	if ( ! hasExited( child ) ) {
		child.kill( 'SIGKILL' );
	}
	return exitedWithin( CHILD_STOP_WAIT_MS );
}

/**
 * Ends the tree of every CLI process this runner started that still runs, at
 * once and without waiting for them to exit: for an exit that can't finish
 * cleanup. The same routine as a normal stop.
 */
export function endRunningAcceptanceChildren( onDescendantsMayRemain: () => void ): void {
	for ( const child of runningChildren ) {
		endProcessTree( child, { onDescendantsMayRemain } );
		if ( ! hasExited( child ) ) {
			try {
				child.kill( 'SIGKILL' );
			} catch {
				// Gone meanwhile.
			}
		}
	}
}

function refuseQuestions(
	questions: Array< { question: string; options: Array< { label: string } > } >
) {
	return Object.fromEntries(
		questions.map( ( question ) => [
			question.question,
			question.options.find( ( option ) => /cancel|^no\b|don.t|skip|stop/i.test( option.label ) )
				?.label ?? 'Cancel',
		] )
	);
}

/**
 * What a turn's CLI process preloads: the request observer, and for gate T1's
 * live check alone the module that turns images in tool results on in it.
 */
export function acceptanceTurnExecArgv(
	scripts: { observer: string; toolImages: string },
	options: Pick< TurnOptions, 'toolImages' >
): string[] {
	return [
		'--import',
		pathToFileURL( scripts.observer ).href,
		...( options.toolImages ? [ '--import', pathToFileURL( scripts.toolImages ).href ] : [] ),
	];
}

export function createLiveAcceptanceProcesses( {
	mainScript,
	scripts,
	paths,
	print,
}: {
	mainScript: string;
	scripts: { observer: string; toolImages: string };
	paths: AcceptanceRunPaths;
	print: ( line: string ) => void;
} ): AcceptanceProcesses {
	let sequence = 0;
	// What this run started and hasn't closed: cleanup stops these, and only these.
	const owned = new Set< ChildProcess >();
	let warned = false;
	const onDescendantsMayRemain = () => {
		if ( ! warned ) {
			warned = true;
			print( describeDescendantsMayRemain() );
		}
	};
	const stop = ( child: ChildProcess ) => stopChild( child, onDescendantsMayRemain );

	function track( child: ChildProcess ): Promise< number | null > {
		runningChildren.add( child );
		owned.add( child );
		const forget = () => {
			runningChildren.delete( child );
			owned.delete( child );
		};
		return new Promise( ( resolve ) => {
			// After its output and IPC channel close too, so no last event is lost.
			child.once( 'close', ( code ) => {
				forget();
				resolve( code );
			} );
			child.once( 'error', () => {
				forget();
				resolve( null );
			} );
		} );
	}

	return {
		startTurn( options ) {
			const observerFile = path.join(
				paths.observerDir,
				`${ String( ++sequence ).padStart( 2, '0' ) }-${ options.label }.ndjson`
			);
			const offer = getChatGptSessionForkEnvironment();
			const env: NodeJS.ProcessEnv = {
				...acceptanceChildEnvironment(),
				[ ACCEPTANCE_OBSERVER_FILE_ENV ]: observerFile,
			};
			for ( const [ name, value ] of Object.entries( offer ) ) {
				if ( options.offerSessions ) {
					env[ name ] = value;
				} else {
					delete env[ name ];
				}
			}
			const args = [
				'code',
				'sessions',
				'resume',
				options.sessionId,
				options.prompt,
				'--json',
				'--avoid-telemetry',
			];
			const execArgv = acceptanceTurnExecArgv( scripts, options );
			const child = options.ipc
				? fork( mainScript, args, {
						env,
						execArgv,
						stdio: [ 'ignore', 'ignore', 'ignore', 'ipc' ],
						detached: CHILDREN_LEAD_PROCESS_GROUPS,
				  } )
				: spawn( process.execPath, [ ...execArgv, mainScript, ...args ], {
						env,
						stdio: [ 'ignore', 'pipe', 'ignore' ],
						windowsHide: true,
						detached: CHILDREN_LEAD_PROCESS_GROUPS,
				  } );
			const startedAt = Date.now();
			const events: TimedEvent[] = [];
			let tokenAsks = 0;
			let tokensHandedOut = 0;
			let interruptedByRunner = false;
			const onEvent = ( event: JsonEvent ) => {
				const timed: TimedEvent = { receivedAt: Date.now(), event };
				const inner =
					event.type === 'message' && isRecord( event.message )
						? ( event.message as unknown as Record< string, unknown > )
						: null;
				if (
					options.persistenceFile &&
					inner?.type === 'tool_execution_end' &&
					typeof inner.toolCallId === 'string'
				) {
					timed.persistedAtReceipt = isToolResultPersisted(
						options.persistenceFile,
						inner.toolCallId
					);
				}
				events.push( timed );
				if ( event.type === 'question.asked' ) {
					sendQuietly( child, { type: 'answer', answers: refuseQuestions( event.questions ) } );
				}
				if (
					inner?.type === 'tool_execution_start' &&
					classifyToolCall( options.policy, String( inner.toolName ), inner.args ) ===
						'unexpected' &&
					child.connected
				) {
					interruptedByRunner = true;
					sendQuietly( child, { type: 'interrupt' } );
				}
			};
			if ( options.ipc ) {
				child.on( 'message', ( message ) => {
					if (
						options.offerSessions &&
						answerChatGptSessionTokenRequest( message, ( reply ) => {
							if ( isRecord( reply ) && typeof reply.accessToken === 'string' ) {
								tokensHandedOut++;
							}
							sendQuietly( child, reply as { type: string } );
						} )
					) {
						tokenAsks++;
						return;
					}
					if ( options.offerSessions && answerChatGptSessionTokenInvalidation( message ) ) {
						return;
					}
					if ( isJsonEvent( message ) ) {
						onEvent( message );
					}
				} );
			} else if ( child.stdout ) {
				readline.createInterface( { input: child.stdout } ).on( 'line', ( line ) => {
					try {
						const parsed: unknown = JSON.parse( line );
						if ( isJsonEvent( parsed ) ) {
							onEvent( parsed );
						}
					} catch {
						// Not an event line.
					}
				} );
			}
			const exited = track( child );
			let done = false;
			const result = exited.then( ( exitCode ) => {
				done = true;
				const lines = readObservedLines( observerFile );
				return {
					pid: child.pid,
					exitCode,
					startedAt,
					exitedAt: Date.now(),
					events,
					requests: lines.filter( ( line ): line is ObservedRequest => line.kind === 'request' ),
					responses: lines.filter( ( line ): line is ObservedResponse => line.kind === 'response' ),
					tokenAsks,
					tokensHandedOut,
					interruptedByRunner,
				};
			} );
			return {
				async firstRequest() {
					for (;;) {
						if (
							readObservedLines( observerFile ).some(
								( line ) =>
									line.kind === 'request' &&
									line.host === 'chatgpt-route' &&
									line.endpoint === 'responses'
							)
						) {
							return true;
						}
						if ( done ) {
							return false;
						}
						await sleep( POLL_MS );
					}
				},
				result,
				stop: async () => {
					await stop( child );
				},
			};
		},
		runCli( label, args ) {
			const child = spawn( process.execPath, [ mainScript, ...args ], {
				env: acceptanceChildEnvironment(),
				stdio: [ 'ignore', 'pipe', 'ignore' ],
				windowsHide: true,
				detached: CHILDREN_LEAD_PROCESS_GROUPS,
			} );
			let stdout = '';
			child.stdout?.setEncoding( 'utf8' );
			child.stdout?.on( 'data', ( chunk: string ) => {
				if ( stdout.length < 4_000_000 ) {
					stdout += chunk;
				}
			} );
			const exited = track( child );
			const timeoutMs = label === 'site-create' ? 15 * 60_000 : 5 * 60_000;
			return raceTimeout( exited, timeoutMs ).then( async ( exitCode ) => {
				if ( exitCode === null && child.exitCode === null ) {
					await stop( child );
				}
				return { exitCode, stdout };
			} );
		},
		async stopOwned() {
			let stopped = 0;
			let failed = 0;
			for ( const child of [ ...owned ] ) {
				if ( await stop( child ) ) {
					stopped++;
				} else {
					failed++;
				}
			}
			return { stopped, failed };
		},
	};
}

async function createLiveServices( {
	paths,
	print,
}: {
	paths: AcceptanceRunPaths;
	print: ( line: string ) => void;
} ): Promise< ChatGptAcceptanceServices > {
	process.env.STUDIO_EXPERIMENTAL_CHATGPT = '1';
	const cliDirectory = import.meta.dirname;
	const mainScript = path.join( cliDirectory, 'main.mjs' );
	const scripts = {
		observer: path.join( cliDirectory, 'chatgpt-acceptance-observer.mjs' ),
		toolImages: path.join( cliDirectory, 'chatgpt-acceptance-tool-images.mjs' ),
	};
	installAcceptanceObserver( path.join( paths.observerDir, '00-runner.ndjson' ) );
	const tokens = createAcceptanceTokenService( createChatGptTokenClient() );
	setChatGptTokenClient( tokens.client );
	// The app's broker has no module-level call for removing the profile's vault
	// key: a broker of the runner's own, on the same keychain, makes it.
	const keyBroker = createChatGptCredentialBroker( { tokenClient: tokens.client } );
	const flow = createChatGptSignInFlow( { openBrowser: ( url ) => openBrowser( url ) } );
	return {
		clock: { now: () => Date.now(), sleep },
		countdownIntervalMs: 60_000,
		signIn: {
			begin: ( registrationId, options ) => flow.begin( registrationId, options ),
			wait: ( attemptId ) => flow.wait( attemptId ),
			cancel: ( attemptId ) => flow.cancel( attemptId ),
			timeoutMs: CHATGPT_SIGN_IN_TIMEOUT_MS,
		},
		broker: {
			getAccessToken: getChatGptAccessToken,
			invalidateAccessToken: invalidateChatGptAccessToken,
			signOut: signOutChatGpt,
			sessionForkEnvironment: getChatGptSessionForkEnvironment,
			askSessionToken: ( id, logoutGeneration ) =>
				askOwnerForSessionToken( answerChatGptSessionTokenRequest, id, logoutGeneration ),
			readAccount: readChatGptAccount,
			vaultRecordExists: ( id ) =>
				fs.existsSync( path.join( getConfigDirectory(), 'chatgpt-credentials', `${ id }.vault` ) ),
			vaultKeyItem: () => getChatGptVaultKeyAccounts().own,
			removeProfileVaultKey: () => keyBroker.removeProfileVaultKey(),
			readModels: ( id, revision ) => readChatGptModels( id, revision ),
		},
		tokens,
		sessions: {
			create: async ( site ) =>
				( await createAiSession( getSessionsDirectory(), site ? { site } : {} ) ).id,
			select: async ( sessionId, selection ) => {
				await setSessionChatGptSelection( getSessionsDirectory(), sessionId, selection );
			},
			filePath: async ( sessionId ) =>
				( await loadAiSession( getSessionsDirectory(), sessionId ) ).summary.filePath,
		},
		processes: createLiveAcceptanceProcesses( { mainScript, scripts, paths, print } ),
		buildPresent: () =>
			[ mainScript, scripts.observer, scripts.toolImages ].every( ( file ) =>
				fs.existsSync( file )
			),
		credentialStoreKind: () => credentialStoreKindFor( process.platform ),
		secureStorageAvailable: async () => ( await createOsCredentialStore().check() ).available,
		imageServiceConfigured: () => isImageGenerationAvailable(),
	};
}

/** This machine's platform as the manifest records it: a release it can't read is null. */
export function acceptancePlatform( release: string = os.release() ): RunFacts[ 'platform' ] {
	return {
		os: process.platform,
		release: isManifestVersion( release ) ? release : null,
		arch: process.arch,
	};
}

async function collectLiveFacts(): Promise< RunFacts > {
	const cliDirectory = import.meta.dirname;
	const repositoryRoot = path.resolve( cliDirectory, '..', '..', '..', '..' );
	const run = ( command: string, args: string[], shell = false ) => {
		const result = spawnSync( command, args, {
			cwd: repositoryRoot,
			encoding: 'utf8',
			shell,
			windowsHide: true,
		} );
		return result.status === 0 ? result.stdout.trim() : null;
	};
	const sha = run( 'git', [ 'rev-parse', 'HEAD' ] );
	const status = sha ? run( 'git', [ 'status', '--porcelain' ] ) : null;
	const npm = run( 'npm', [ '--version' ], true );
	const mainScript = path.join( cliDirectory, 'main.mjs' );
	return {
		source: {
			sha: sha && /^[0-9a-f]{40}$/.test( sha ) ? sha : null,
			dirty: status === null ? null : status.length > 0,
		},
		platform: acceptancePlatform(),
		runtime: {
			node: process.versions.node,
			npm: npm && isManifestVersion( npm ) ? npm : null,
		},
		build: {
			cliVersion:
				typeof __STUDIO_CLI_VERSION__ === 'string' && isManifestVersion( __STUDIO_CLI_VERSION__ )
					? __STUDIO_CLI_VERSION__
					: '0.0.0',
			buildId: fs.existsSync( mainScript )
				? createHash( 'sha256' )
						.update( fs.readFileSync( mainScript ) )
						.digest( 'hex' )
						.slice( 0, 12 )
				: null,
		},
	};
}

/**
 * Calls `handler` on the first signal that ends a run: Ctrl+C, a termination
 * request, a closed terminal and, on Windows, Ctrl+Break; any second one calls
 * `forceExit`. Returns what stops listening.
 */
export function onAcceptanceSignals(
	handler: () => void,
	{
		target,
		platform,
		forceExit,
	}: {
		target: Pick< NodeJS.Process, 'on' | 'off' >;
		platform: NodeJS.Platform;
		forceExit: () => void;
	}
): () => void {
	const signals: NodeJS.Signals[] = [
		'SIGINT',
		'SIGTERM',
		'SIGHUP',
		...( platform === 'win32' ? [ 'SIGBREAK' as const ] : [] ),
	];
	let received = 0;
	const onSignal = () => {
		received++;
		if ( received === 1 ) {
			handler();
		} else {
			forceExit();
		}
	};
	for ( const signal of signals ) {
		target.on( signal, onSignal );
	}
	return () => {
		for ( const signal of signals ) {
			target.off( signal, onSignal );
		}
	};
}

// A terminal that hung up (EIO) or a reader that went away (EPIPE).
const isLostOutput = ( error: unknown ) => {
	const code = ( error as NodeJS.ErrnoException | null )?.code;
	return code === 'EIO' || code === 'EPIPE';
};

// A stream onto a file throws a failed write; a terminal or pipe reports it as 'error'.
function writeLine( stream: NodeJS.WritableStream, line: string ): void {
	try {
		stream.write( `${ line }\n` );
	} catch ( error ) {
		if ( ! isLostOutput( error ) ) {
			throw error;
		}
	}
}

/** The dependencies of a real run, from the built CLI's directory. */
export function createLiveChatGptAcceptanceDependencies(
	io: {
		stdout: NodeJS.WritableStream;
		stderr: NodeJS.WritableStream;
		signals: Pick< NodeJS.Process, 'on' | 'off' >;
		platform: NodeJS.Platform;
		exit: ( code: number ) => void;
	} = {
		stdout: process.stdout,
		stderr: process.stderr,
		signals: process,
		platform: process.platform,
		exit: ( code ) => process.exit( code ),
	}
): ChatGptAcceptanceDependencies {
	// For the life of the run, output that can no longer be written never ends
	// it, so cleanup after a closed terminal runs to its end; any other write
	// error surfaces as it would without this listener.
	for ( const stream of [ io.stdout, io.stderr ] ) {
		stream.on( 'error', ( error: unknown ) => {
			if ( ! isLostOutput( error ) ) {
				throw error;
			}
		} );
	}
	const print = ( line: string ) => writeLine( io.stdout, line );
	return {
		env: process.env,
		home: os.homedir(),
		print,
		collectFacts: collectLiveFacts,
		configDirectory: getConfigDirectory,
		processManagerHome: () => PROCESS_MANAGER_HOME,
		onInterrupt: ( handler ) =>
			onAcceptanceSignals( handler, {
				target: io.signals,
				platform: io.platform,
				forceExit: () => {
					let warned = false;
					// Their own process groups keep the terminal's signal from them on POSIX.
					endRunningAcceptanceChildren( () => {
						if ( ! warned ) {
							warned = true;
							print( describeDescendantsMayRemain() );
						}
					} );
					print(
						__(
							'Stopped before cleanup finished. See scripts/chatgpt-acceptance/README.md to stop what this run started.'
						)
					);
					io.exit( EXIT_INTERRUPTED );
				},
			} ),
		createServices: ( { paths, print: printLine } ) =>
			createLiveServices( { paths, print: printLine } ),
	};
}
