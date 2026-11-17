/**
 * PromptFoo eval runner for Studio Code agent.
 *
 * Hooks into the agent's turns to capture tool calls, tool results, and
 * assistant text. Returns raw structured data — assertions live in the
 * promptfoo config, not here.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmdirSync,
	writeFileSync,
	writeSync as fsWriteSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
	addAssistantMessageUsage,
	createAgent,
	createTokenUsage,
	type AskUserHandler,
	type SiteInfo,
	type StudioAgentHost,
} from '@studio/agent/node';
import {
	listChatGptConnections,
	setChatGptTokenClient,
} from '@studio/agent/node/chatgpt/credential-broker';
import { isChatGptEnabled } from '@studio/agent/node/chatgpt/settings';
import { setChatGptStateDirectory } from '@studio/agent/node/chatgpt/state-directory';
import { createChatGptTokenClient } from '@studio/agent/node/chatgpt/token-client';
import { writeGlobalInstructions } from '@studio/agent/node/global-instructions';
import { isImageGenerationAvailable } from '@studio/agent/node/image-generation';
import { getChatGptModelCapabilities } from '@studio/agent/protocol/chatgpt-models';
import { DEFAULT_MODEL, isAiModelId, type AiModelId } from '@studio/agent/protocol/models';
import { findLastAssistant } from '@studio/agent/protocol/session-events';
import { DEFAULT_PHP_VERSION } from '@studio/common/constants';
import { addConnectedWpcomSite } from '@studio/common/lib/connected-sites';
import { portFinder } from '@studio/common/lib/port-finder';
import { readAuthToken } from '@studio/common/lib/shared-config';
import { SITE_FILE_ACCESS_SITE_DIRECTORY } from '@studio/common/lib/site-file-access';
import { fetchSyncableSites } from '@studio/common/lib/sync/sync-api';
import {
	getAiPayloadsPath,
	getCertificatesPath,
	getCliConfigPath,
	getConfigDirectory,
} from '@studio/common/lib/well-known-paths';
import {
	resolveAiEnvironment,
	resolveInitialAiProvider,
	resolveUnavailableAiProvider,
} from 'cli/ai/auth';
import {
	installAcceptanceObserver,
	readObservedLines,
	type ObservedRequest,
} from 'cli/ai/chatgpt-acceptance-observer';
import { caseProcessManagerHome, stopCaseProcessManager } from 'cli/ai/eval-case-daemon';
import {
	caseProfile,
	removeCaseProfile,
	withdrawCaseLogin,
	type CaseProfile,
} from 'cli/ai/eval-case-profile';
import { pathsFixedAtLoad } from 'cli/ai/eval-fixed-paths';
import {
	evalHistoryMessages,
	findEvalFixturesDir,
	installWpcomWriteGuard,
	loadEvalAttachments,
	withMockedRemote,
	withMockedWpcomRequest,
	withStagingRemote,
	type EvalAttachments,
	type RemoteCall,
	type StagingSite,
	type WpcomWriteAttempt,
	type WpcomWriteGuard,
} from 'cli/ai/eval-harness';
import { parseEvalRunnerVars, type EvalRunnerVars, type EvalSeed } from 'cli/ai/eval-input';
import { captureTurnOutcome, fingerprintSites, type TurnOutcome } from 'cli/ai/eval-outcome';
import {
	readEvalProviderRequest,
	resolveEvalProviderPlan,
	summarizeExecutedRoute,
	type EvalProviderDeps,
	type EvalProviderFailure,
	type EvalProviderPlan,
	type EvalProviderRequestResult,
	type ExecutedRoute,
	type RequestedRoute,
} from 'cli/ai/eval-provider';
import { matchesStopRule } from 'cli/ai/eval-stop';
import {
	evalSummaryDirectory,
	writeEvalCaseSummary,
	type EvalSummarySource,
} from 'cli/ai/eval-summary';
import { summarizeTiming, type ModelRequestRecord } from 'cli/ai/eval-timing';
import { cliAgentHost } from 'cli/ai/host';
import { getAiProviderDefinition } from 'cli/ai/providers';
import { runCommand as runCreateSiteCommand } from 'cli/commands/site/create';
import { runCommand as runDeleteSiteCommand } from 'cli/commands/site/delete';
import {
	lockCliConfig,
	readCliConfig,
	saveCliConfig,
	unlockCliConfig,
} from 'cli/lib/cli-config/core';
import { getSiteByFolder } from 'cli/lib/cli-config/sites';
import { disconnectFromDaemon, killDaemonAndChildren } from 'cli/lib/daemon-client';
import { PROCESS_MANAGER_HOME } from 'cli/lib/paths';
import { runWpCliCommand } from 'cli/lib/run-wp-cli-command';
import { STUDIO_SITES_ROOT } from 'cli/lib/site-paths';
import { Logger } from 'cli/logger';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { StudioChatArtifactData } from '@studio/agent/protocol/chat-artifacts';
import type { StudioChatImage } from '@studio/agent/protocol/chat-images';
import type { SyncSite } from '@studio/common/types/sync';
import type { StageRecord } from 'cli/ai/acceptance-evidence';
import type { AiProviderId } from 'cli/ai/providers';

interface Inspection {
	args: string[];
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

interface SeededFixtures {
	cleanup: () => Promise< void >;
	inspect: () => Promise< Inspection[] >;
	activeSite?: SiteInfo;
	activeSitePath?: string;
}

// The folder site_create gives a site of this name.
function siteSlug( name: string ): string {
	return name
		.toLowerCase()
		.replace( /[^a-z0-9]+/g, '-' )
		.replace( /^-|-$/g, '' );
}

const sameFolder = ( a: string, b: string ) => path.relative( a, b ) === '';
const isInside = ( folder: string, file: string ) => {
	const relative = path.relative( folder, file );
	return relative !== '' && ! relative.startsWith( '..' ) && ! path.isAbsolute( relative );
};

/**
 * Whether this process runs the case on the Studio profile and site registry
 * its entry made for it (`eval-case-profile.ts`) and, for a case that names a
 * provider, on its own process manager: as the path helpers resolve them now,
 * and as the modules that fix a path when they load fixed it. A bundler can
 * evaluate a module before the entry's overrides, so this is checked before
 * the first site or turn, and the case never proceeds on the owner's profile
 * or the owner's process manager.
 */
function caseIsolationRefusal( namesProvider: boolean ): EvalRefusal | null {
	const own = caseProfile();
	const refusal = ( reason: string ): EvalRefusal => ( {
		code: 'case-profile-not-isolated',
		message: `This case runs only on a Studio profile of its own, made before the runner loads, and ${ reason }, so nothing ran.`,
	} );
	if ( ! own.ok ) {
		return refusal( own.problem );
	}
	const { profile, registry } = own.profile;
	const fixed = pathsFixedAtLoad();
	if (
		! sameFolder( getConfigDirectory(), profile ) ||
		! sameFolder( path.dirname( getCliConfigPath() ), registry )
	) {
		return refusal( 'Studio’s paths resolve to another profile now' );
	}
	const payloads = getAiPayloadsPath();
	if (
		! isInside( profile, payloads ) ||
		! fixed.payloadDescriptions.some( ( text ) => text.includes( payloads ) )
	) {
		return refusal( 'wpcom_request names a payload folder outside it' );
	}
	if (
		! isInside( profile, fixed.rootCaCertificate ) ||
		! sameFolder( path.dirname( fixed.rootCaCertificate ), getCertificatesPath() )
	) {
		return refusal( 'Studio’s certificates folder was fixed outside it when it loaded' );
	}
	if ( namesProvider ) {
		const home = caseProcessManagerHome( process.env );
		if ( ! home || ! sameFolder( home, fixed.processManagerHome ) ) {
			return {
				code: 'process-manager-not-isolated',
				message:
					'A case that names a provider runs its sites only under a process manager of its own, which is not the one this process’s daemon client loaded with, so nothing ran.',
			};
		}
	}
	return null;
}

// A teardown failure never changes the case's outcome, but is never silent:
// the case profile holds a copy of the owner's login.
function warnTeardown( what: string, error: unknown ): void {
	const code = ( error as { code?: unknown } )?.code;
	process.stderr.write(
		`studio-eval warning: ${ what }${ typeof code === 'string' ? ` (${ code })` : '' }
`
	);
}

// The environment that points the case at its own folders, as the entry set
// it: put back as it was when the case started, whatever the case did to it.
const CASE_ENVIRONMENT = [
	'E2E',
	'E2E_CLI_CONFIG_PATH',
	'E2E_SHARED_CONFIG_PATH',
	'DEV_CONFIG_DIR',
] as const;

function saveCaseEnvironment(): () => void {
	const saved = CASE_ENVIRONMENT.map( ( name ) => [ name, process.env[ name ] ] as const );
	return () => {
		for ( const [ name, value ] of saved ) {
			if ( value === undefined ) {
				delete process.env[ name ];
			} else {
				process.env[ name ] = value;
			}
		}
	};
}

// Stopped sites the request is not about, as a user with a few sites has, so
// the outcome can show whether the turn left the user's other sites alone.
const BYSTANDER_SITES = [ 'Portfolio', 'Client Work' ];

async function createBystanderSites(): Promise< string[] > {
	const created: string[] = [];
	for ( const name of BYSTANDER_SITES ) {
		const bystanderPath = path.join( STUDIO_SITES_ROOT, `eval-bystander-${ siteSlug( name ) }` );
		try {
			await runCreateSiteCommand(
				bystanderPath,
				{
					name,
					wpVersion: 'latest',
					phpVersion: DEFAULT_PHP_VERSION,
					fileAccess: SITE_FILE_ACCESS_SITE_DIRECTORY,
					enableHttps: false,
					noStart: true,
					skipBrowser: true,
					skipLogDetails: true,
				},
				new Logger()
			);
		} catch ( error ) {
			await rm( bystanderPath, { recursive: true, force: true } );
			await deleteSites( created );
			throw error;
		}
		created.push( bystanderPath );
	}
	return created;
}

async function deleteSites( sitePaths: string[] ): Promise< void > {
	for ( const sitePath of sitePaths ) {
		await runDeleteSiteCommand( sitePath, true, new Logger() ).catch( () => undefined );
	}
}

/**
 * Writes the requested fixtures into the case's own profile: cli.json (local
 * site and snapshots, in the case's registry), shared.json (connected
 * WordPress.com sites) and the global instructions file, all removed with the
 * case. Returns a cleanup function that deletes the seeded active site.
 */
async function seedFixtures( seed: EvalSeed ): Promise< SeededFixtures > {
	const {
		localSite,
		connectedWpcomSites = [],
		snapshots = [],
		globalInstructions,
		activeSite,
		remoteActiveSite,
	} = seed;

	if ( typeof globalInstructions === 'string' ) {
		await writeGlobalInstructions( globalInstructions );
	}

	// preview_list scopes snapshots to the authenticated user (getSnapshotsFromConfig
	// filters on snapshot.userId), so a seeded snapshot is invisible unless it carries
	// the current user's id. Fixtures omit it — they can't know the id — so stamp it here.
	const authUserId = ( await readAuthToken() )?.id;

	if ( localSite || snapshots.length > 0 ) {
		try {
			await lockCliConfig();
			const config = await readCliConfig();
			if ( localSite && ! config.sites.some( ( s ) => s.id === localSite.id ) ) {
				config.sites.push( {
					id: localSite.id,
					name: localSite.name,
					path: localSite.path,
					port: localSite.port,
					url: localSite.url ?? `http://localhost:${ localSite.port }`,
					phpVersion: localSite.phpVersion,
				} );
			}
			for ( const snapshot of snapshots ) {
				config.snapshots.push(
					snapshot.userId === undefined && authUserId !== undefined
						? { ...snapshot, userId: authUserId }
						: snapshot
				);
			}
			await saveCliConfig( config );
		} finally {
			await unlockCliConfig();
		}
	}

	for ( const site of connectedWpcomSites ) {
		await addConnectedWpcomSite( site.localSiteId, site );
	}

	let seededSite: SiteInfo | undefined;
	let activeSitePath: string | undefined;
	if ( activeSite ) {
		activeSitePath = path.join( STUDIO_SITES_ROOT, siteSlug( activeSite.name ) );
		// WordPress is installed on first start; the site stays running, as a
		// site the user has open in Studio is.
		await runCreateSiteCommand(
			activeSitePath,
			{
				name: activeSite.name,
				wpVersion: 'latest',
				phpVersion: DEFAULT_PHP_VERSION,
				fileAccess: SITE_FILE_ACCESS_SITE_DIRECTORY,
				enableHttps: false,
				noStart: false,
				skipBrowser: true,
				skipLogDetails: true,
			},
			new Logger()
		);
		for ( const [ relativePath, content ] of Object.entries( activeSite.files ?? {} ) ) {
			const filePath = path.join( activeSitePath, relativePath );
			mkdirSync( path.dirname( filePath ), { recursive: true } );
			writeFileSync( filePath, content );
		}
		try {
			const site = await getSiteByFolder( activeSitePath );
			for ( const args of activeSite.wpCli ?? [] ) {
				await using command = await runWpCliCommand( site, args );
				const exitCode = await command.response.exitCode;
				const stdout = await command.response.stdoutText;
				const stderr = await command.response.stderrText;
				// WP-CLI `eval` exits 0 on PHP warnings, so seed scripts signal failure by printing SEED_ERROR.
				if ( exitCode !== 0 || stdout.includes( 'SEED_ERROR' ) ) {
					throw new Error(
						`Seed \`wp ${ args[ 0 ] }\` failed (exit ${ exitCode }): ${ stdout } ${ stderr }`
					);
				}
			}
		} catch ( error ) {
			await runDeleteSiteCommand( activeSitePath, true, new Logger() ).catch( () => undefined );
			throw error;
		}
		seededSite = {
			name: activeSite.name,
			path: activeSitePath,
			running: true,
		};
		const { id: localSiteId } = await getSiteByFolder( activeSitePath );
		for ( const connection of activeSite.connectedWpcomSites ?? [] ) {
			await addConnectedWpcomSite( localSiteId, { ...connection, localSiteId } );
		}
	}

	const inspect = async (): Promise< Inspection[] > => {
		if ( ! activeSitePath || ! activeSite?.inspect?.length ) {
			return [];
		}
		const site = await getSiteByFolder( activeSitePath );
		const inspections: Inspection[] = [];
		for ( const args of activeSite.inspect ) {
			try {
				await using command = await runWpCliCommand( site, args );
				inspections.push( {
					args,
					exitCode: await command.response.exitCode,
					stdout: await command.response.stdoutText,
					stderr: await command.response.stderrText,
				} );
			} catch ( error ) {
				inspections.push( {
					args,
					exitCode: null,
					stdout: '',
					stderr: error instanceof Error ? error.message : String( error ),
				} );
			}
		}
		return inspections;
	};

	const cleanup = async () => {
		if ( activeSitePath ) {
			await runDeleteSiteCommand( activeSitePath, true, new Logger() ).catch( () => undefined );
		}
	};
	return {
		cleanup,
		inspect,
		activeSitePath,
		activeSite: remoteActiveSite
			? { ...remoteActiveSite, path: '', running: false, remote: true }
			: seededSite,
	};
}

function extractToolCalls( event: AgentSessionEvent ) {
	if ( event.type !== 'message_end' || event.message.role !== 'assistant' ) {
		return [];
	}
	return event.message.content
		.filter(
			(
				block
			): block is Extract< ( typeof event.message.content )[ number ], { type: 'toolCall' } > =>
				block.type === 'toolCall'
		)
		.map( ( block ) => ( {
			id: block.id,
			name: block.name,
			input: block.arguments as Record< string, unknown >,
		} ) );
}

type ToolCallRecord = {
	id: string;
	name: string;
	input: unknown;
};

type ToolEvent = {
	toolUseId: string;
	toolName: string;
	input: unknown;
	startedAtMs: number;
	endedAtMs?: number;
	durationMs?: number;
	isError?: boolean;
	// Length of the result's text block: what the tool adds to the context.
	outputChars?: number;
	turnIndex: number;
};

type FirstToolError = {
	toolUseId: string | null;
	toolName: string | null;
	input?: unknown;
	error: string;
	turnIndex: number;
};

function extractTextSegments( event: AgentSessionEvent ): string[] {
	if ( event.type !== 'message_end' || event.message.role !== 'assistant' ) {
		return [];
	}
	return event.message.content
		.filter( ( block ): block is { type: 'text'; text: string } => block.type === 'text' )
		.map( ( block ) => block.text );
}

function extractToolResult( event: AgentSessionEvent ): {
	toolUseId: string;
	isError: boolean;
	text?: string;
	images?: Array< { mimeType: string; data: string } >;
	details?: unknown;
} | null {
	if ( event.type !== 'tool_execution_end' ) {
		return null;
	}
	const result = event.result as
		| {
				content?: Array< { type: string; text?: string; data?: string; mimeType?: string } >;
				details?: unknown;
		  }
		| undefined;
	let text: string | undefined;
	let images: Array< { mimeType: string; data: string } > | undefined;
	if ( result?.content && Array.isArray( result.content ) ) {
		const textBlock = result.content.find(
			( b ): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string'
		);
		if ( textBlock ) text = textBlock.text;
		const imageBlocks = result.content.filter(
			( b ): b is { type: 'image'; data: string; mimeType?: string } =>
				b.type === 'image' && typeof b.data === 'string'
		);
		if ( imageBlocks.length > 0 ) {
			images = imageBlocks.map( ( b ) => ( { mimeType: b.mimeType ?? '', data: b.data } ) );
		}
	}
	return {
		toolUseId: event.toolCallId,
		isError: event.isError,
		text,
		images,
		details: result?.details,
	};
}

interface EvalRunnerInput extends EvalRunnerVars {
	prompt: string;
	model?: AiModelId;
	/** An explicit provider selection, or null for the default path. */
	provider: EvalProviderRequestResult | null;
}

export function readEvalRunnerInput(
	argv: readonly string[] = process.argv,
	env: NodeJS.ProcessEnv = process.env
): EvalRunnerInput {
	const prompt = argv[ 2 ];
	if ( ! prompt ) {
		throw new Error( 'Missing prompt argument' );
	}

	let vars: Record< string, unknown > = {};
	if ( argv[ 4 ] ) {
		try {
			vars = JSON.parse( argv[ 4 ] )?.vars ?? {};
		} catch {
			// ignore
		}
	}

	const envModel = env.STUDIO_EVAL_MODEL?.trim();
	const varModel = typeof vars.model === 'string' ? vars.model.trim() : undefined;
	const rawModel = varModel || envModel;
	const model = rawModel && isAiModelId( rawModel ) ? rawModel : undefined;

	const parsed = parseEvalRunnerVars( vars );
	return {
		...parsed,
		prompt: parsed.prompt ?? prompt,
		model,
		provider: readEvalProviderRequest( { env, vars } ),
	};
}

const liveProviderDeps: EvalProviderDeps = {
	isChatGptEnabled,
	listChatGptConnections,
	provider: ( id ) => getAiProviderDefinition( id ),
	get home() {
		return os.homedir();
	},
	// The profile the eval process started with, which the case reads, never the case's own.
	configDirectory: () => {
		const own = caseProfile();
		return own.ok ? own.profile.source : getConfigDirectory();
	},
	useChatGptProfile: setChatGptStateDirectory,
};

interface EvalRefusal {
	code: EvalProviderFailure[ 'code' ] | EvalSetupRefusalCode;
	message: string;
}

type EvalSetupRefusalCode =
	| 'case-profile-not-isolated'
	| 'process-manager-not-isolated'
	| 'staging-not-designated'
	| 'staging-not-confirmed'
	| 'staging-needs-active-site'
	| 'history-needs-provider'
	| 'fixture-missing'
	| 'image-service-not-configured'
	| 'image-service-still-configured';

interface ProviderRouteReport {
	requested: RequestedRoute | null;
	executed?: ExecutedRoute;
	failure?: EvalRefusal;
	blocked?: EvalBlock;
}

/**
 * A case that can't pass on the selected route yet, by what the route is
 * qualified for: neither run nor failed, and never silently skipped.
 */
interface EvalBlock {
	code: 'tool-images-not-qualified';
	message: string;
}

function blockedRun( block: EvalBlock, requested: RequestedRoute ) {
	return {
		success: false,
		error: block.message,
		blocked: block,
		providerRoute: { requested, blocked: block } satisfies ProviderRouteReport,
	};
}

/**
 * A run refused before any site, turn or model request, with its typed code:
 * in `providerRoute` too when a provider was selected or its selection failed.
 */
function refusedRun( failure: EvalRefusal, route?: { requested: RequestedRoute | null } ) {
	return {
		success: false,
		error: failure.message,
		refusal: failure,
		...( route
			? { providerRoute: { requested: route.requested, failure } satisfies ProviderRouteReport }
			: {} ),
	};
}

const STAGING_SITE_ID_ENV = 'STUDIO_EVAL_STAGING_SITE_ID';
const STAGING_SITE_URL_ENV = 'STUDIO_EVAL_STAGING_SITE_URL';

/**
 * The WordPress.com site the person running the eval named for this run as the
 * disposable staging site a `remote: staging` case may change, never one a
 * config names. It says which site, not that the site is staging.
 */
function designatedStagingSite(): { id: number; url: string } | null {
	const id = Number( process.env[ STAGING_SITE_ID_ENV ] );
	const url = process.env[ STAGING_SITE_URL_ENV ]?.trim();
	if ( ! Number.isSafeInteger( id ) || id <= 0 || ! url || ! /^https:\/\//.test( url ) ) {
		return null;
	}
	return { id, url };
}

const comparableSiteUrl = ( url: string ) => {
	try {
		const parsed = new URL( url );
		return `${ parsed.origin }${ parsed.pathname.replace( /\/+$/, '' ) }`.toLowerCase();
	} catch {
		return null;
	}
};

/**
 * The designated site as WordPress.com lists it among the account's sites,
 * when it lists it at that address and as a staging site: whether the site is
 * staging comes from WordPress.com, never from the environment. A read only.
 */
async function confirmStagingSite( designated: {
	id: number;
	url: string;
} ): Promise< { site: Omit< SyncSite, 'localSiteId' > } | { problem: string } > {
	const login = await readAuthToken();
	if ( ! login ) {
		return { problem: 'no WordPress.com login to ask WordPress.com with' };
	}
	let sites: SyncSite[];
	try {
		sites = await fetchSyncableSites( login.accessToken );
	} catch {
		return { problem: 'WordPress.com could not list the account’s sites' };
	}
	const listed = sites.find( ( site ) => site.id === designated.id );
	if ( ! listed ) {
		return { problem: 'the account has no site with that id' };
	}
	if ( ! listed.isStaging ) {
		return { problem: 'WordPress.com does not list that site as a staging site' };
	}
	const address = comparableSiteUrl( designated.url );
	if ( ! address || comparableSiteUrl( listed.url ) !== address ) {
		return { problem: 'WordPress.com lists that site at another address' };
	}
	const { localSiteId: _unused, ...site } = listed;
	return { site: { ...site, syncSupport: 'already-connected' } };
}

interface UiEvents {
	artifacts: Array< { id: string; widgets: string[] } >;
	previewReloads: number;
}

/**
 * Runs one case on the profile, registry and (for a case that names a
 * provider) process manager its entry made for it, refused before anything
 * else when it isn't on them, and removes the profile and registry when it
 * ends, whatever the outcome.
 */
export async function runEval( input: EvalRunnerInput ) {
	const restoreCaseEnvironment = saveCaseEnvironment();
	try {
		const isolation = caseIsolationRefusal( input.provider?.ok === true );
		const own = caseProfile();
		if ( isolation || ! own.ok ) {
			return refusedRun(
				isolation ?? { code: 'case-profile-not-isolated', message: own.ok ? '' : own.problem },
				input.provider ? { requested: null } : undefined
			);
		}
		return await runCase( input, own.profile );
	} finally {
		restoreCaseEnvironment();
		removeCaseProfile( warnTeardown );
	}
}

async function runCase( input: EvalRunnerInput, own: CaseProfile ) {
	const evalStartedAt = Date.now();
	const elapsed = () => Date.now() - evalStartedAt;
	const phaseTimingsMs: Record< string, number > = {};
	let phaseStartedAt = Date.now();

	let plan: EvalProviderPlan | null = null;
	let runProvider: AiProviderId;
	let aiEnvironment: Record< string, string >;
	if ( input.provider ) {
		if ( ! input.provider.ok ) {
			return refusedRun( input.provider.failure, { requested: null } );
		}
		const resolved = await resolveEvalProviderPlan( input.provider.request, liveProviderDeps );
		phaseTimingsMs.resolve_selected_provider_ms = Date.now() - phaseStartedAt;
		if ( ! resolved.ok ) {
			return refusedRun( resolved.failure, { requested: null } );
		}
		plan = resolved.plan;
		runProvider = plan.requested.kind;
		aiEnvironment = plan.env;
		if ( plan.requested.kind === 'chatgpt-oauth' ) {
			setChatGptTokenClient( createChatGptTokenClient() );
		}
	} else {
		let aiProvider: AiProviderId = await resolveInitialAiProvider();
		phaseTimingsMs.resolve_initial_provider_ms = Date.now() - phaseStartedAt;

		phaseStartedAt = Date.now();
		aiProvider = ( await resolveUnavailableAiProvider( aiProvider ) ) ?? aiProvider;
		phaseTimingsMs.resolve_unavailable_provider_ms = Date.now() - phaseStartedAt;

		phaseStartedAt = Date.now();
		aiEnvironment = await resolveAiEnvironment( aiProvider );
		phaseTimingsMs.resolve_ai_environment_ms = Date.now() - phaseStartedAt;
		runProvider = aiProvider;
	}
	// A selected case never changes anything on WordPress.com unless it is a
	// staging case: without a `remote` var it runs as `remote: mock`.
	const remote = input.remote ?? ( plan ? 'mock' : undefined );
	// Mirrors the fallback in the agent runtime (packages/agent/node/runtime) — keep in sync.
	const resolvedModel = plan ? plan.requested.model : input.model ?? DEFAULT_MODEL;
	const providerRefusal = ( failure: EvalRefusal ) =>
		refusedRun( failure, plan ? { requested: plan.requested } : undefined );
	// Decided by the route's capability table alone, so the case runs as soon as the table qualifies it.
	if (
		input.needsToolImages &&
		plan?.requested.kind === 'chatgpt-oauth' &&
		getChatGptModelCapabilities( plan.requested.model )?.toolImageInput !== true
	) {
		return blockedRun(
			{
				code: 'tool-images-not-qualified',
				message: `This case is judged on images a tool returns to the model, and the ChatGPT route isn't qualified for them on ${ plan.requested.model } yet (gate T1), so it was not run.`,
			},
			plan.requested
		);
	}

	let seed = input.seed;
	let stagingSite: StagingSite | null = null;
	if ( input.remote === 'staging' ) {
		const designated = designatedStagingSite();
		if ( ! designated ) {
			return providerRefusal( {
				code: 'staging-not-designated',
				message: `A remote: staging case changes a real WordPress.com site, so it runs only against a disposable staging site you name for this run: set ${ STAGING_SITE_ID_ENV } and ${ STAGING_SITE_URL_ENV } (https) on the command that runs it.`,
			} );
		}
		const confirmed = await confirmStagingSite( designated );
		if ( 'problem' in confirmed ) {
			return providerRefusal( {
				code: 'staging-not-confirmed',
				message: `The designated staging site was not confirmed by WordPress.com: ${ confirmed.problem }.`,
			} );
		}
		const staging = confirmed.site;
		stagingSite = { id: staging.id, url: staging.url };
		if ( ! seed?.activeSite ) {
			return providerRefusal( {
				code: 'staging-needs-active-site',
				message: 'A remote: staging case connects the staging site to its seeded active site.',
			} );
		}
		seed = {
			...seed,
			activeSite: {
				...seed.activeSite,
				connectedWpcomSites: [ ...( seed.activeSite.connectedWpcomSites ?? [] ), staging ],
			},
		};
	}
	if ( seed?.history?.length && ! plan ) {
		return providerRefusal( {
			code: 'history-needs-provider',
			message:
				'Seeded history is recorded as replies on the selected route, so it needs STUDIO_EVAL_PROVIDER.',
		} );
	}
	let attachments: EvalAttachments | null = null;
	if ( input.attachments?.length ) {
		const fixturesDir = findEvalFixturesDir( import.meta.dirname, process.env );
		const loaded = fixturesDir
			? loadEvalAttachments( input.attachments, fixturesDir )
			: { missing: input.attachments[ 0 ].fixture };
		if ( 'missing' in loaded ) {
			return providerRefusal( {
				code: 'fixture-missing',
				message: `The attachment fixture ${ loaded.missing } is not in scripts/eval/fixtures (or STUDIO_EVAL_FIXTURES_DIR).`,
			} );
		}
		attachments = loaded;
	}

	const remoteCalls: RemoteCall[] = [];
	// Every request and remote operation the case's guards refused, in order.
	const refusedWrites: WpcomWriteAttempt[] = [];
	const uiEvents: UiEvents = { artifacts: [], previewReloads: 0 };
	let baseHost: StudioAgentHost = cliAgentHost;
	if ( remote === 'mock' ) {
		baseHost = withMockedRemote( cliAgentHost, remoteCalls );
	} else if ( stagingSite ) {
		baseHost = withStagingRemote( cliAgentHost, remoteCalls, stagingSite, refusedWrites );
	}
	const guarded = remote === 'mock' || stagingSite !== null;
	const host = input.ui
		? {
				...baseHost,
				ui: {
					showArtifact: ( artifact: StudioChatArtifactData ) => {
						uiEvents.artifacts.push( {
							id: artifact.id,
							widgets: artifact.widgets.map( ( widget ) => widget.type ),
						} );
					},
					reloadPreview: () => {
						uiEvents.previewReloads += 1;
					},
				},
		  }
		: baseHost;
	let agent = createAgent( { host } );

	const env = {
		...( process.env as Record< string, string > ),
		...aiEnvironment,
	};
	// Allow running inside a Claude Code session
	delete env.CLAUDECODE;
	if ( input.imageService === 'off' ) {
		// The image service's own token; its other credential, the WordPress.com
		// login, is left out of the case's profile below.
		delete process.env.STUDIO_IMAGE_API_TOKEN;
		delete env.STUDIO_IMAGE_API_TOKEN;
	}

	const toolCalls: ToolCallRecord[] = [];
	const toolResults: {
		toolUseId: string | null;
		toolName: string | null;
		isError: boolean;
		text?: string;
		images?: Array< { mimeType: string; data: string } >;
		details?: unknown;
	}[] = [];
	const toolEvents: ToolEvent[] = [];
	const requests: ModelRequestRecord[] = [];
	const textSegments: string[] = [];
	const questions: Array< { question: string; options: string[]; answer: string } > = [];
	const pendingAnswers = [ ...( input.answers ?? [] ) ];
	const onAskUser: AskUserHandler | undefined = input.answers
		? async ( asked ) =>
				Object.fromEntries(
					asked.map( ( { question, options } ) => {
						const label = pendingAnswers.shift()?.label;
						const answer = ( label === '@first' ? options[ 0 ]?.label : label ) ?? 'Cancel';
						questions.push( {
							question,
							options: options.map( ( option ) => option.label ),
							answer,
						} );
						return [ question, answer ];
					} )
				)
		: undefined;
	const toolNameById = new Map< string, string >();
	const toolEventById = new Map< string, ToolEvent >();
	let firstToolError: FirstToolError | null = null;
	// Wall-clock per turn, measured between successive assistant messages.
	const turnDurationsMs: number[] = [];
	let turnIndex = 0;
	let numTurns = 0;
	let numTurnsResult: number | null = null;
	let success = false;
	let error: string | null = null;
	let timedOut = false;
	let stoppedAt: { toolUseId: string; toolName: string; index: number } | null = null;
	// From the last assistant message: a provider failure ends the turn with
	// stopReason "error" and its message here, without throwing.
	let stopReason: string | null = null;
	let errorMessage: string | null = null;
	// Summed from each assistant message's usage, so evals can compare the
	// token cost of prompt variants, not just their outcomes.
	const usage = createTokenUsage();

	let observerFile: string | null = null;
	// What the case swaps in for its turns, put back in reverse order.
	const restorers: Array< () => void > = [];
	const restore = () => {
		while ( restorers.length ) {
			restorers.pop()?.();
		}
	};
	let wpcomGuard: WpcomWriteGuard | null = null;
	let bystanderPaths: string[] = [];
	let seeded: SeededFixtures | null = null;
	let sitesDeleted = false;
	try {
		// The case's sites never take a port the user's sites or another case's have.
		for ( const port of own.reservedPorts ) {
			portFinder.addUnavailablePort( port );
		}
		if ( input.imageService === 'off' ) {
			// Without the login, Studio's image service, which signs with it, is off.
			withdrawCaseLogin( own );
		}
		// As the runtime decides it: whether this run offers generate_images.
		const imageServiceConfigured = input.imageService
			? await isImageGenerationAvailable()
			: undefined;
		if ( input.imageService === 'off' && imageServiceConfigured ) {
			return providerRefusal( {
				code: 'image-service-still-configured',
				message:
					'This case needs Studio’s image service off, but the case’s own profile still configures it, so nothing ran.',
			} );
		}
		if ( input.imageService === 'required' && ! imageServiceConfigured ) {
			return providerRefusal( {
				code: 'image-service-not-configured',
				message:
					'This case needs Studio’s separate WordPress.com image service: log in to WordPress.com or set STUDIO_IMAGE_API_TOKEN.',
			} );
		}
		// What the run's model requests really were, read back into `providerRoute.executed`.
		observerFile = plan
			? path.join( os.tmpdir(), `studio-eval-requests-${ Date.now() }-${ process.pid }.ndjson` )
			: null;
		if ( observerFile ) {
			restorers.push(
				installAcceptanceObserver( observerFile, globalThis, {
					bearerIdentity: plan?.bearerIdentity,
				} )
			);
		}
		if ( guarded ) {
			restorers.push(
				withMockedWpcomRequest(
					remoteCalls,
					stagingSite ? { site: stagingSite, refused: refusedWrites } : undefined
				)
			);
			wpcomGuard = installWpcomWriteGuard( {
				allowImageService: input.imageService === 'required',
				allowProxyInference: runProvider === 'wpcom',
				...( stagingSite ? { stagingSite } : {} ),
				attempts: refusedWrites,
			} );
			restorers.push( wpcomGuard.uninstall );
		}
		const replies: Array< { provider?: unknown; model?: unknown } > = [];

		let inspections: Inspection[] = [];
		let outcome: TurnOutcome | { error: string } | null = null;
		const prompt = `${ input.prompt.trim() }${ attachments?.promptBlock ?? '' }`;
		bystanderPaths = await createBystanderSites();
		if ( seed ) {
			seeded = await seedFixtures( seed );
		}

		phaseStartedAt = Date.now();
		// Every run keeps its session JSONL (the full transcript) and reports its
		// path as `sessionFile`; STUDIO_EVAL_SESSION_DIR picks the directory.
		const sessionDir =
			process.env.STUDIO_EVAL_SESSION_DIR?.trim() ||
			path.join( os.tmpdir(), 'studio-eval-sessions' );
		mkdirSync( sessionDir, { recursive: true } );
		let session = SessionManager.create( STUDIO_SITES_ROOT, sessionDir );
		if ( plan && seed?.history?.length ) {
			for ( const message of evalHistoryMessages( seed.history, plan.reply ) ) {
				session.appendMessage( message );
			}
		}
		// Where each user message's turn starts in the run's records.
		const turns: Array< {
			reopened: boolean;
			startedAtMs: number;
			toolCallsStart: number;
			textSegmentsStart: number;
			questionsStart: number;
		} > = [];
		const queryStartedAt = Date.now();
		let turnStart = queryStartedAt;

		const handleEvent = ( event: AgentSessionEvent ): void => {
			if ( event.type === 'message_end' && event.message.role === 'assistant' ) {
				replies.push( { provider: event.message.provider, model: event.message.model } );
				const messageUsage = addAssistantMessageUsage( usage, event );
				const now = Date.now();
				// pi stamps the assistant message just before it sends the request.
				const requestStartedAt = event.message.timestamp || turnStart;
				requests.push( {
					startedAtMs: requestStartedAt - evalStartedAt,
					endedAtMs: now - evalStartedAt,
					durationMs: now - requestStartedAt,
					contextTokens: messageUsage
						? messageUsage.input + messageUsage.cacheRead + messageUsage.cacheWrite
						: 0,
					outputTokens: messageUsage?.output ?? 0,
					stopReason: event.message.stopReason,
					...( event.message.errorMessage ? { errorMessage: event.message.errorMessage } : {} ),
					hasText: event.message.content.some(
						( block ) => block.type === 'text' && block.text.trim() !== ''
					),
					toolCalls: event.message.content.filter( ( block ) => block.type === 'toolCall' ).length,
				} );
				turnDurationsMs.push( now - turnStart );
				turnIndex += 1;
				if ( turnIndex === 1 ) {
					phaseTimingsMs.first_assistant_message_ms = now - queryStartedAt;
				}
				turnStart = now;
			}
			for ( const tc of extractToolCalls( event ) ) {
				if ( input.stopAt && ! stoppedAt && matchesStopRule( tc, input.stopAt ) ) {
					stoppedAt = { toolUseId: tc.id, toolName: tc.name, index: toolCalls.length };
					void query.interrupt();
				}
				toolCalls.push( tc );
				toolNameById.set( tc.id, tc.name );
				const evt: ToolEvent = {
					toolUseId: tc.id,
					toolName: tc.name,
					input: tc.input,
					startedAtMs: elapsed(),
					turnIndex,
				};
				toolEvents.push( evt );
				toolEventById.set( tc.id, evt );
			}
			textSegments.push( ...extractTextSegments( event ) );

			if ( event.type === 'tool_execution_end' ) {
				const tr = extractToolResult( event );
				if ( tr ) {
					const id = tr.toolUseId;
					const evt = toolEventById.get( id );
					if ( evt ) {
						evt.endedAtMs = elapsed();
						evt.durationMs = evt.endedAtMs - evt.startedAtMs;
						evt.isError = tr.isError;
						evt.outputChars = tr.text?.length ?? 0;
					}
					if ( tr.isError && ! firstToolError ) {
						firstToolError = {
							toolUseId: id,
							toolName: toolNameById.get( id ) ?? null,
							...( evt?.input ? { input: evt.input } : {} ),
							error: tr.text ?? 'Tool returned an error result.',
							turnIndex,
						};
					}
					toolResults.push( {
						toolUseId: id,
						toolName: toolNameById.get( id ) ?? null,
						isError: tr.isError,
						...( tr.text ? { text: tr.text } : {} ),
						...( tr.images ? { images: tr.images } : {} ),
						...( tr.details !== undefined ? { details: tr.details } : {} ),
					} );
				}
			}

			if ( event.type === 'turn_end' ) {
				numTurns += 1;
			}

			if ( event.type === 'agent_end' ) {
				const lastAssistant = findLastAssistant( event.messages );
				success =
					! lastAssistant ||
					( lastAssistant.stopReason !== 'error' && lastAssistant.stopReason !== 'aborted' );
				numTurnsResult = numTurns;
				stopReason = lastAssistant?.stopReason ?? null;
				errorMessage = lastAssistant?.errorMessage ?? null;
			}
		};

		const runTurn = (
			turnPrompt: string,
			{ images, reopen = false }: { images?: StudioChatImage[]; reopen?: boolean } = {}
		) => {
			const sessionFile = session.getSessionFile();
			if ( reopen && sessionFile ) {
				// As a resumed chat: the conversation read back from its file, in a fresh agent.
				session = SessionManager.open( sessionFile, sessionDir );
				agent = createAgent( { host } );
			}
			turns.push( {
				reopened: reopen,
				startedAtMs: elapsed(),
				toolCallsStart: toolCalls.length,
				textSegmentsStart: textSegments.length,
				questionsStart: questions.length,
			} );
			// As the CLI does before each turn: the conversation names the connection it runs on.
			if ( plan?.sessionContext ) {
				session.appendCustomEntry( 'studio.session_context', plan.sessionContext );
			}
			return agent.runTurn( {
				prompt: turnPrompt,
				...( images?.length ? { images } : {} ),
				env,
				session,
				activeSite: seeded?.activeSite,
				onEvent: handleEvent,
				onAskUser,
				...( plan ? plan.turn : input.model ? { model: input.model } : {} ),
			} );
		};
		const sitesBeforeTurn = await fingerprintSites();
		let query = runTurn( prompt, { images: attachments?.images } );
		phaseTimingsMs.start_ai_agent_ms = Date.now() - phaseStartedAt;

		const timeout = setTimeout( () => {
			timedOut = true;
			void query.interrupt();
		}, input.timeoutMs ?? 300000 );

		try {
			await query.result;
			for ( const followUp of input.followUps ?? [] ) {
				if ( timedOut || ( stoppedAt && ! input.resumeAfterStop ) ) {
					break;
				}
				query = runTurn( followUp.prompt, { reopen: followUp.reopen } );
				await query.result;
			}
		} catch ( caught ) {
			error = caught instanceof Error ? caught.message : String( caught );
		} finally {
			clearTimeout( timeout );
			// The turns are over: the route report and the guard cover theirs only.
			restore();
			outcome = await captureTurnOutcome(
				sitesBeforeTurn,
				seeded?.activeSitePath,
				mkdtempSync( path.join( os.tmpdir(), 'studio-eval-outcome-' ) )
			).catch( ( caught ) => ( {
				error: caught instanceof Error ? caught.message : String( caught ),
			} ) );
			sitesDeleted = true;
			if ( seeded ) {
				inspections = await seeded.inspect().catch( () => [] );
				await seeded.cleanup().catch( () => undefined );
			}
			await deleteSites( bystanderPaths );
		}
		phaseTimingsMs.total_eval_ms = elapsed();
		const blockedWrites = wpcomGuard?.attempts ?? [];
		const guardCode = stagingSite ? 'wpcom-write-outside-staging' : 'wpcom-write-under-mock';
		if ( blockedWrites.length ) {
			success = false;
			error = `${ guardCode }: the case tried ${
				blockedWrites.length
			} request(s) that could change WordPress.com ${
				stagingSite ? 'outside its designated staging site' : 'under remote: mock'
			}; none was sent.${ error ? ` ${ error }` : '' }`;
		}

		const providerRoute: ProviderRouteReport | null =
			plan && observerFile
				? {
						requested: plan.requested,
						executed: summarizeExecutedRoute( {
							requests: readObservedLines( observerFile ).filter(
								( line ): line is ObservedRequest => line.kind === 'request'
							),
							replies,
							entries: session.getEntries(),
							turnStartedAt: turns.map( ( turn ) => evalStartedAt + turn.startedAtMs ),
						} ),
				  }
				: null;

		return {
			...( providerRoute ? { providerRoute } : {} ),
			...( guarded ? { remoteCalls } : {} ),
			...( wpcomGuard
				? {
						remoteGuard: {
							code: blockedWrites.length ? guardCode : null,
							blocked: blockedWrites,
							...( stagingSite ? { allowed: wpcomGuard.allowed } : {} ),
						},
				  }
				: {} ),
			...( input.ui ? { uiEvents } : {} ),
			...( input.imageService ? { imageService: { configured: imageServiceConfigured } } : {} ),
			...( attachments ? { attachments: attachments.summary } : {} ),
			turns,
			compactions: session.getEntries().filter( ( entry ) => entry.type === 'compaction' ).length,
			success,
			error,
			timedOut,
			stoppedAt,
			model: resolvedModel,
			numTurns: numTurnsResult,
			stopReason,
			errorMessage,
			usage,
			sessionFile: session.getSessionFile() ?? null,
			phaseTimingsMs,
			timing: summarizeTiming( requests, toolEvents ),
			requests,
			turnDurationsMs,
			toolCalls,
			toolResults,
			toolEvents,
			firstToolError,
			textSegments,
			questions,
			inspections,
			outcome,
		};
	} finally {
		try {
			restore();
		} catch ( error ) {
			warnTeardown( 'could not restore the case’s swapped-in functions', error );
		}
		if ( ! sitesDeleted ) {
			await seeded?.cleanup().catch( () => undefined );
			await deleteSites( bystanderPaths ).catch( () => undefined );
		}
		if ( observerFile ) {
			try {
				await rm( observerFile, { force: true } );
			} catch ( error ) {
				warnTeardown( 'could not remove the request observer file', error );
			}
		}
	}
}

/**
 * For a case that selects a provider (or must), its sanitized summary
 * (`eval-summary.ts`): the one output of the case that may leave the machine.
 * Never fails the case; the summary's own guard decides what it holds.
 */
export function writeCaseSummary(
	input: EvalRunnerInput,
	result: unknown,
	env: NodeJS.ProcessEnv = process.env
): StageRecord | null {
	if ( ! input.provider ) {
		return null;
	}
	try {
		return writeEvalCaseSummary( ( result ?? {} ) as EvalSummarySource, {
			caseId: input.caseId,
			provider: input.provider.ok ? input.provider.request.provider : undefined,
			directory: evalSummaryDirectory( env ),
		} );
	} catch ( error ) {
		warnTeardown( 'could not write the case’s sanitized summary', error );
		return null;
	}
}

const RESULT_PREFIX = 'EVAL_RUNNER_RESULT_FILE=';

// The folder the entry made for this case's sites, once nothing is left in it.
// A site the turn created and kept stays, with its folder.
function removeEmptySitesRoot(): void {
	const sitesRoot = process.env.E2E_SITES_ROOT;
	if ( sitesRoot && path.basename( sitesRoot ).startsWith( 'studio-eval-sites-' ) ) {
		try {
			rmdirSync( sitesRoot );
		} catch {
			// Not empty, or already gone.
		}
	}
}

// Studio tools and the Agent SDK freely print to stdout (pi-tui spinners,
// daemon status, …). promptfoo's `exec:` provider wraps us in
// `child_process.exec`, whose default 1 MB stdout buffer long runs overflow.
// Redirect stdout writes to stderr during the run, serialize the result to a
// tmp file, and emit only `EVAL_RUNNER_RESULT_FILE=<path>` via a raw
// `fs.writeSync(1, …)` that bypasses the wrapper.
export async function main() {
	const filePath = path.join( os.tmpdir(), `studio-eval-${ Date.now() }-${ process.pid }.json` );

	( process.stdout as unknown as { write: ( ...args: unknown[] ) => boolean } ).write = (
		...args: unknown[]
	) => {
		return ( process.stderr.write as unknown as ( ...args: unknown[] ) => boolean )( ...args );
	};
	const rawStdout = ( line: string ) => fsWriteSync( 1, line );
	const emit = ( payload: unknown ) => {
		try {
			writeFileSync( filePath, JSON.stringify( payload ) );
			rawStdout( `${ RESULT_PREFIX }${ filePath }` );
		} catch ( writeError ) {
			const msg = writeError instanceof Error ? writeError.message : String( writeError );
			process.stderr.write( `[eval-runner] failed to write ${ filePath }: ${ msg }\n` );
			rawStdout( JSON.stringify( { success: false, error: msg } ) );
		}
	};

	let exitCode = 0;
	let input: EvalRunnerInput | null = null;
	let result: unknown;
	try {
		input = readEvalRunnerInput();
		result = await runEval( input );
	} catch ( error ) {
		result = { success: false, error: error instanceof Error ? error.message : String( error ) };
		exitCode = 1;
	}
	// Also when the case never started: its input was unreadable.
	removeCaseProfile( warnTeardown );
	emit( result );
	if ( input ) {
		writeCaseSummary( input, result );
	}
	await stopCaseProcessManager( {
		home: caseProcessManagerHome( process.env ),
		processManagerHome: PROCESS_MANAGER_HOME,
		kill: killDaemonAndChildren,
		disconnect: disconnectFromDaemon,
		warn: warnTeardown,
	} );
	removeEmptySitesRoot();
	// The Agent SDK keeps internal handles open past conversation end; bail out
	// rather than leaving promptfoo waiting on its exec child.
	process.exit( exitCode );
}
