import fs from 'fs';
import { type AgentTool } from '@earendil-works/pi-agent-core';
import {
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	type Model,
	type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { streamSimple as streamAnthropicMessages } from '@earendil-works/pi-ai/api/anthropic-messages';
import { streamSimple as streamOpenAiCompletions } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as streamOpenAiResponses } from '@earendil-works/pi-ai/api/openai-responses';
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models';
import {
	createAgentSession,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	DefaultResourceLoader,
	ModelRuntime,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type SessionEntry,
	type SessionManager,
	type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { getAiTracksIdentity } from '@studio/common/lib/tracks-identity';
import { type TSchema } from 'typebox';
import { withDesignSystemPreview } from '@studio/agent/node/chat-artifacts';
import {
	beginChatGptTurn,
	listChatGptConnections,
	type ChatGptTurnHandle,
} from '@studio/agent/node/chatgpt/credential-broker';
import { readGlobalInstructions } from '@studio/agent/node/global-instructions';
import { isImageGenerationAvailable } from '@studio/agent/node/image-generation';
import { OPENAI_API_BASE_URL } from '@studio/agent/node/openai-model-list';
import { createResultNotes } from '@studio/agent/node/result-notes';
import { buildSystemPrompt, type ToolPromptContribution } from '@studio/agent/node/system-prompt';
import { resolveStudioTools } from '@studio/agent/node/tools';
import { createAskUserQuestionTool } from '@studio/agent/node/tools/ask-user-question';
import { bindTool } from '@studio/agent/node/tools/define-tool';
import { createPresentDesignOptionsTool } from '@studio/agent/node/tools/present-design-options';
import { createSkillTool } from '@studio/agent/node/tools/skill';
import {
	describeChatGptReasoningProblem,
	getDefaultChatGptReasoningEffort,
	resolveChatGptReasoning,
} from '@studio/agent/protocol/chatgpt-models';
import {
	describeConnectionSelectionError,
	resolveConnectionSelection,
	type ConnectionRegistryEntry,
	type ConnectionSelection,
} from '@studio/agent/protocol/connections';
import {
	aiModelSupportsImages,
	DEFAULT_MODEL,
	getAiModel,
	getAiModelFamily,
	getAiModelLabel,
	type AiModelFamily,
	type AiModelId,
} from '@studio/agent/protocol/models';
import {
	describeOpenAiSettingsProblem,
	getInitialOpenAiReasoningEffort,
	isOpenAiModelId,
	OPENAI_DEFAULT_MAX_OUTPUT_TOKENS,
	OPENAI_DEFAULT_REASONING_MODE,
	resolveOpenAiTurnSettings,
	type OpenAiReasoningEffort,
	type OpenAiTurnSettings,
} from '@studio/agent/protocol/openai-models';
import {
	ANTHROPIC_PI_PROVIDER,
	CHATGPT_PI_PROVIDER,
	getAiModelFamilyProvider,
	getEffectiveSessionProvider,
} from '@studio/agent/protocol/providers';
import { findLastAssistant, isEmptyStop } from '@studio/agent/protocol/session-events';
import {
	buildChatGptModel,
	createChatGptProviderConfig,
	type ChatGptTurnSnapshot,
} from './chatgpt-transport';
import { getFileToolPrompt } from './file-tool-prompts';
import { withLeakedToolCallMarkupRemoved } from './leaked-tool-call-markup';
import {
	buildOpenAiModel,
	createOpenAiProviderConfig,
	STUDIO_OPENAI_PROVIDER,
	toPiThinkingLevel,
} from './openai-transport';
import { getPendingWork, type PendingWork } from './pending-work';
import { stripStaleImagesFromContext } from './strip-stale-images';
import {
	getIncompleteToolCallReason,
	getFileWriteRefusal,
	getPayloadLimitViolation,
	type StudioToolPayloadGuardState,
	updateStudioToolPayloadGuardState,
} from './tool-safety';
import { withUsageCapErrorRewrite } from './usage-cap';
import type { StudioAgentHost } from '@studio/agent/node/host';
import type { StudioToolResultDetails } from '@studio/agent/node/tools/define-tool';
import type { AskUserHandler, SiteInfo } from '@studio/agent/node/types';
import type { StudioChatImage } from '@studio/agent/protocol/chat-images';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentToolAny = AgentTool< any >;
type StudioWpcomModel =
	| Model< 'openai-completions' >
	| Model< 'openai-responses' >
	| Model< 'anthropic-messages' >;
type StudioModel = StudioWpcomModel | Model< 'anthropic-messages' >;
type ProviderConfigInput = Parameters< ModelRuntime[ 'registerProvider' ] >[ 1 ];

const STUDIO_WPCOM_PROVIDER = 'studio-wpcom';
// A reply with nothing in it ends the turn without the user seeing why (see
// `isEmptyStop`). Resume it with a message the user doesn't see, up to this
// many times per turn. pi leaves a reply that has only reasoning out of the
// next request, so the message carries that reasoning; otherwise the model
// starts the same reasoning over and runs out again.
const MAX_EMPTY_STOP_CONTINUES = 2;
const EMPTY_STOP_CONTINUE_TYPE = 'studio.empty_stop_continue';
const STUDIO_COMPACTION_SETTINGS = {
	enabled: true,
	reserveTokens: 16_384,
	keepRecentTokens: 20_000,
};

/**
 * What one ChatGPT turn sends, fixed when the turn starts: the reasoning
 * effort every request uses, and the model's display label. No output cap
 * and no reasoning mode: the ChatGPT route takes neither, so neither exists
 * here to leak into a request.
 */
export interface ChatGptTurnSettings {
	/**
	 * Checked against the model's ChatGPT capabilities when the turn starts;
	 * an effort the model doesn't list fails the turn rather than sending a
	 * nearby one. Defaults to medium when the model lists it, else its
	 * lowest listed effort.
	 */
	reasoningEffort?: OpenAiReasoningEffort;
	/** The model's display name, as its connection's model list gave it. */
	label?: string;
}

export interface StudioAgentTurnConfig {
	prompt: string;
	images?: StudioChatImage[];
	session: SessionManager;
	/**
	 * Provider credentials for this turn, kept apart from the environment the
	 * agent's tools run in: nothing here is passed to a spawned process.
	 */
	env?: Record< string, string >;
	model?: AiModelId;
	/**
	 * The OpenAI model, effort, mode and output cap, fixed when the turn
	 * starts. Every request in the turn — tool continuations and retries
	 * included — uses these. Defaults to the model's initial settings.
	 */
	openAi?: OpenAiTurnSettings;
	/**
	 * The validated connection this turn runs on, from
	 * `resolveConnectionSelection`. A ChatGPT selection routes the turn
	 * through that connection alone: no API key can stand in for it, and the
	 * session must already run on that same connection and revision. A
	 * legacy selection must name the provider and model `model` already
	 * does. Without one, routing is inferred from `model` as before.
	 */
	connection?: ConnectionSelection;
	/** The ChatGPT turn's effort and label; only with a ChatGPT `connection`. */
	chatGpt?: ChatGptTurnSettings;
	activeSite?: SiteInfo | null;
	onAskUser?: AskUserHandler;
	onEvent: ( event: AgentSessionEvent ) => void;
}

interface ResolvedStudioAgentTurnConfig extends StudioAgentTurnConfig {
	host: StudioAgentHost;
	env: Record< string, string >;
	model: AiModelId;
}

export interface StudioAgentTurnHandle {
	result: Promise< void >;
	interrupt(): Promise< void >;
	/** Whether `name` is one of the turn's registered tools, not a name the model made up. */
	hasTool( name: string ): boolean;
}

export function runStudioAgentTurn(
	host: StudioAgentHost,
	config: StudioAgentTurnConfig
): StudioAgentTurnHandle {
	const controller = new AbortController();
	let activeSession: AgentSession | undefined;
	const resolvedConfig: ResolvedStudioAgentTurnConfig = {
		...config,
		host,
		env: config.env ?? { ...( process.env as Record< string, string > ) },
		model: config.model ?? DEFAULT_MODEL,
	};

	if ( ! fs.existsSync( host.sitesRoot ) ) {
		fs.mkdirSync( host.sitesRoot, { recursive: true } );
	}

	const result = runAgentSessionTurn( resolvedConfig, controller, ( session ) => {
		activeSession = session;
	} );

	return {
		result,
		async interrupt() {
			controller.abort();
			await activeSession?.abort();
		},
		hasTool( name ) {
			return activeSession?.getAllTools().some( ( tool ) => tool.name === name ) ?? false;
		},
	};
}

interface ResolvedCredentials {
	apiKey: string;
	baseURL: string;
	extraHeaders?: Record< string, string >;
}

function resolveCredentials(
	family: AiModelFamily,
	env: Record< string, string >
): { ok: true; creds: ResolvedCredentials } | { ok: false; reason: string } {
	if ( family === 'studio' ) {
		const apiKey = env.STUDIO_WPCOM_API_KEY?.trim();
		if ( ! apiKey ) {
			return {
				ok: false,
				reason:
					'The WordPress.com models need a wpcom access token, and STUDIO_WPCOM_API_KEY is not set — run /login to authenticate.',
			};
		}
		const baseURL = env.STUDIO_WPCOM_BASE_URL?.trim();
		if ( ! baseURL ) {
			return { ok: false, reason: 'STUDIO_WPCOM_BASE_URL not set — cannot route to wpcom proxy.' };
		}
		return {
			ok: true,
			creds: {
				apiKey,
				baseURL,
				extraHeaders: parseJsonHeaderEnv(
					'STUDIO_WPCOM_DEFAULT_HEADERS',
					env.STUDIO_WPCOM_DEFAULT_HEADERS
				),
			},
		};
	}

	if ( family === 'openai' ) {
		// Studio-namespaced so only Studio's saved key can satisfy it, never an
		// OPENAI_API_KEY the user happens to have in their environment.
		const apiKey = env.STUDIO_OPENAI_API_KEY?.trim();
		if ( ! apiKey ) {
			return {
				ok: false,
				reason:
					'OpenAI isn’t connected: add an OpenAI API key in Settings → AI, or with /openai-key in Studio Code. (STUDIO_OPENAI_API_KEY is not set.)',
			};
		}
		return { ok: true, creds: { apiKey, baseURL: OPENAI_API_BASE_URL } };
	}

	const apiKey = env.ANTHROPIC_API_KEY?.trim();
	if ( ! apiKey ) {
		return {
			ok: false,
			reason:
				'Anthropic provider selected but ANTHROPIC_API_KEY is not set. Switch to the Anthropic · API key provider with /provider and save a key.',
		};
	}
	return {
		ok: true,
		creds: {
			apiKey,
			baseURL: 'https://api.anthropic.com',
		},
	};
}

// Synthesize a pi `agent_end` event with a single error assistant message.
// Used for failures the runtime catches before pi's own `agent_end` fires
// (missing credentials, abort during pre-flight, exceptions out of the
// agent loop). Downstream consumers read `stopReason`/`errorMessage` from
// the last assistant message — same path as a real run that errored.
function syntheticErrorAgentEnd(
	stopReason: 'error' | 'aborted',
	errorMessage: string,
	provider: string = ANTHROPIC_PI_PROVIDER
): AgentSessionEvent {
	return {
		type: 'agent_end',
		willRetry: false,
		messages: [
			{
				role: 'assistant',
				content: errorMessage ? [ { type: 'text', text: errorMessage } ] : [],
				api: provider === CHATGPT_PI_PROVIDER ? 'openai-responses' : 'anthropic-messages',
				provider,
				model: '',
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason,
				errorMessage,
				timestamp: Date.now(),
			},
		],
	};
}

/**
 * The turn's OpenAI settings, validated again here so a caller can't start a
 * turn with a combination the model doesn't support. Frozen: nothing during
 * the turn may change them.
 */
function resolveTurnOpenAiSettings(
	config: ResolvedStudioAgentTurnConfig
): { ok: true; settings: OpenAiTurnSettings } | { ok: false; reason: string } {
	if ( ! isOpenAiModelId( config.model ) ) {
		return { ok: false, reason: `Unknown OpenAI model: ${ config.model }` };
	}
	if ( config.openAi && config.openAi.model !== config.model ) {
		return { ok: false, reason: 'The OpenAI settings name a different model than the turn.' };
	}
	const result = resolveOpenAiTurnSettings(
		config.openAi ?? {
			model: config.model,
			reasoningEffort: getInitialOpenAiReasoningEffort( config.model ),
			reasoningMode: OPENAI_DEFAULT_REASONING_MODE,
			maxOutputTokens: OPENAI_DEFAULT_MAX_OUTPUT_TOKENS,
		}
	);
	return result.ok
		? { ok: true, settings: Object.freeze( { ...result.settings } ) }
		: { ok: false, reason: describeOpenAiSettingsProblem( result.problem ) };
}

/** How one turn reaches its model: a legacy provider's credentials, or one ChatGPT connection's turn. */
type TurnRouting =
	| {
			kind: 'legacy';
			family: AiModelFamily;
			creds: ResolvedCredentials;
			openAiSettings?: OpenAiTurnSettings;
	  }
	| {
			kind: 'chatgpt';
			turn: ChatGptTurnHandle;
			model: Model< 'openai-responses' >;
			reasoningEffort: OpenAiReasoningEffort;
	  };

// The selection against the broker's live registry: the same checks
// `resolveConnectionSelection` makes of a recorded one, of the caller's.
function validateChatGptSelectionLive(
	selection: ConnectionSelection,
	connections: readonly ConnectionRegistryEntry[]
): string | undefined {
	const providerId = 'chatgpt-oauth';
	const connection = connections.find( ( entry ) => entry.connectionId === selection.connectionId );
	if ( ! connection ) {
		return describeConnectionSelectionError( { code: 'disconnected', providerId } );
	}
	if ( connection.providerId !== providerId || connection.backend !== 'pi' ) {
		return describeConnectionSelectionError( { code: 'unsupported', providerId } );
	}
	if ( connection.revision !== selection.revision ) {
		return describeConnectionSelectionError( { code: 'changed', providerId } );
	}
	if ( connection.authStatus !== 'connected' || ! connection.identity?.subject ) {
		return describeConnectionSelectionError( { code: 'disconnected', providerId } );
	}
	return undefined;
}

// The session against the selection: a conversation that ran on ChatGPT
// continues only on the connection, model and revision it recorded, and one
// that ran elsewhere never continues on ChatGPT. A session with no history
// yet may start on the selected connection.
function validateChatGptSessionBinding(
	entries: SessionEntry[],
	selection: ConnectionSelection,
	connections: readonly ConnectionRegistryEntry[]
): string | undefined {
	if ( getEffectiveSessionProvider( entries, null ) === 'chatgpt-oauth' ) {
		const resolved = resolveConnectionSelection( entries, { connections, settings: null } );
		if ( ! resolved.ok ) {
			return describeConnectionSelectionError( resolved.error );
		}
		const recorded = resolved.selection;
		if (
			recorded.connectionId !== selection.connectionId ||
			recorded.model.providerId !== selection.model.providerId ||
			recorded.model.modelId !== selection.model.modelId ||
			recorded.revision !== selection.revision
		) {
			return 'This chat ran on a different ChatGPT connection or model than the selected one, so it can’t continue on it. Start a new chat.';
		}
		return undefined;
	}
	const hasHistory = entries.some(
		( entry ) =>
			entry.type === 'message' ||
			entry.type === 'model_change' ||
			( entry.type === 'custom' && entry.customType === 'studio.session_context' )
	);
	return hasHistory
		? 'This chat ran on another provider, so it can’t continue on ChatGPT. Start a new chat with ChatGPT.'
		: undefined;
}

/**
 * A ChatGPT turn's routing, or why it can't run: the model and effort
 * checked, the selection live and bound to the session, then the
 * connection's turn begun. No API key is read: a disconnected connection
 * fails here however usable a saved key is.
 */
async function resolveChatGptRouting(
	config: ResolvedStudioAgentTurnConfig,
	selection: ConnectionSelection
): Promise< { ok: true; routing: TurnRouting } | { ok: false; reason: string } > {
	if ( config.openAi ) {
		return {
			ok: false,
			reason: 'A ChatGPT turn doesn’t use OpenAI API settings, so none may be set for it.',
		};
	}
	const reasoning = resolveChatGptReasoning(
		selection.model.modelId,
		config.chatGpt?.reasoningEffort ?? getDefaultChatGptReasoningEffort( selection.model.modelId )
	);
	if ( ! reasoning.ok ) {
		return { ok: false, reason: describeChatGptReasoningProblem( reasoning.problem ) };
	}
	let model: Model< 'openai-responses' >;
	try {
		model = buildChatGptModel( selection.model, config.chatGpt?.label );
	} catch ( error ) {
		return { ok: false, reason: error instanceof Error ? error.message : String( error ) };
	}
	let connections: ConnectionRegistryEntry[];
	try {
		connections = await listChatGptConnections();
	} catch ( error ) {
		return { ok: false, reason: error instanceof Error ? error.message : String( error ) };
	}
	const liveProblem = validateChatGptSelectionLive( selection, connections );
	if ( liveProblem ) {
		return { ok: false, reason: liveProblem };
	}
	const bindingProblem = validateChatGptSessionBinding(
		config.session.getEntries(),
		selection,
		connections
	);
	if ( bindingProblem ) {
		return { ok: false, reason: bindingProblem };
	}
	let turn: ChatGptTurnHandle;
	try {
		turn = await beginChatGptTurn( selection.connectionId );
	} catch ( error ) {
		return { ok: false, reason: error instanceof Error ? error.message : String( error ) };
	}
	if ( turn.connectionId !== selection.connectionId ) {
		turn.end();
		return {
			ok: false,
			reason: 'The ChatGPT turn began on a different connection than the selected one.',
		};
	}
	return {
		ok: true,
		routing: { kind: 'chatgpt', turn, model, reasoningEffort: reasoning.effort },
	};
}

async function runAgentSessionTurn(
	config: ResolvedStudioAgentTurnConfig,
	controller: AbortController,
	setActiveSession: ( session: AgentSession | undefined ) => void
): Promise< void > {
	const selection = config.connection;
	const isChatGptTurn = selection?.model.providerId === 'chatgpt-oauth';
	const syntheticProvider =
		isChatGptTurn || config.chatGpt ? CHATGPT_PI_PROVIDER : ANTHROPIC_PI_PROVIDER;
	if ( config.chatGpt && ! isChatGptTurn ) {
		config.onEvent(
			syntheticErrorAgentEnd(
				'error',
				'ChatGPT turn settings need a ChatGPT connection selection.',
				CHATGPT_PI_PROVIDER
			)
		);
		return;
	}
	if ( selection && ! isChatGptTurn ) {
		const family = getAiModelFamily( config.model );
		if (
			selection.model.providerId !== getAiModelFamilyProvider( family ) ||
			selection.model.modelId !== config.model
		) {
			config.onEvent(
				syntheticErrorAgentEnd(
					'error',
					'The selected connection doesn’t match the model this turn runs on.'
				)
			);
			return;
		}
	}

	let routing: TurnRouting;
	if ( isChatGptTurn ) {
		const resolved = await resolveChatGptRouting( config, selection );
		if ( ! resolved.ok ) {
			config.onEvent( syntheticErrorAgentEnd( 'error', resolved.reason, syntheticProvider ) );
			return;
		}
		routing = resolved.routing;
	} else {
		const family = getAiModelFamily( config.model );
		const resolved = resolveCredentials( family, config.env );
		if ( ! resolved.ok ) {
			config.onEvent( syntheticErrorAgentEnd( 'error', resolved.reason ) );
			return;
		}
		let openAiSettings: OpenAiTurnSettings | undefined;
		if ( family === 'openai' ) {
			const settings = resolveTurnOpenAiSettings( config );
			if ( ! settings.ok ) {
				config.onEvent( syntheticErrorAgentEnd( 'error', settings.reason ) );
				return;
			}
			openAiSettings = settings.settings;
		}
		routing = { kind: 'legacy', family, creds: resolved.creds, openAiSettings };
	}

	let session: AgentSession | undefined;
	let unsubscribe: ( () => void ) | undefined;
	const payloadGuardState: StudioToolPayloadGuardState = {};
	try {
		session = await createStudioAgentSession( config, payloadGuardState, routing );
		setActiveSession( session );
		let emptyStopContinues = 0;
		let continueAfterEmptyStop = false;
		let cutOffReasoning = '';
		unsubscribe = session.subscribe( ( event ) => {
			updateStudioToolPayloadGuardState( event, payloadGuardState );
			if (
				event.type === 'agent_end' &&
				! event.willRetry &&
				emptyStopContinues < MAX_EMPTY_STOP_CONTINUES
			) {
				const lastAssistant = findLastAssistant( event.messages );
				if ( isEmptyStop( lastAssistant ) ) {
					// Not final: consumers wait for the turn's real end.
					continueAfterEmptyStop = true;
					cutOffReasoning = ( lastAssistant?.content ?? [] )
						.map( ( block ) => ( block.type === 'thinking' ? block.thinking : '' ) )
						.join( '' )
						.trim();
					config.onEvent( { ...event, willRetry: true } );
					return;
				}
			}
			config.onEvent( event );
		} );

		if ( controller.signal.aborted ) {
			await session.abort();
			config.onEvent( syntheticErrorAgentEnd( 'aborted', '', syntheticProvider ) );
			return;
		}

		await session.prompt( config.prompt, {
			expandPromptTemplates: false,
			source: 'rpc',
			images: config.images?.map( ( image ) => ( {
				type: 'image' as const,
				data: image.dataBase64,
				mimeType: image.mimeType,
			} ) ),
		} );
		while ( continueAfterEmptyStop ) {
			continueAfterEmptyStop = false;
			if ( controller.signal.aborted ) {
				config.onEvent( syntheticErrorAgentEnd( 'aborted', '', syntheticProvider ) );
				break;
			}
			emptyStopContinues++;
			await session.sendCustomMessage(
				{
					customType: EMPTY_STOP_CONTINUE_TYPE,
					content: cutOffReasoning
						? `Your reasoning was cut off before you replied. Continue from where it stopped:\n\n${ cutOffReasoning }`
						: 'continue',
					display: false,
				},
				{ triggerTurn: true }
			);
		}
		await getPendingWork( config.session ).settle();
	} catch ( error ) {
		const aborted = controller.signal.aborted;
		const message = aborted ? '' : error instanceof Error ? error.message : String( error );
		config.onEvent(
			syntheticErrorAgentEnd( aborted ? 'aborted' : 'error', message, syntheticProvider )
		);
	} finally {
		unsubscribe?.();
		session?.dispose();
		setActiveSession( undefined );
		if ( routing.kind === 'chatgpt' ) {
			routing.turn.end();
		}
	}
}

async function createStudioAgentSession(
	config: ResolvedStudioAgentTurnConfig,
	payloadGuardState: StudioToolPayloadGuardState,
	routing: TurnRouting
): Promise< AgentSession > {
	const model =
		routing.kind === 'chatgpt'
			? routing.model
			: routing.openAiSettings
			? buildOpenAiModel( routing.openAiSettings, getAiModelLabel( routing.openAiSettings.model ) )
			: buildModel( config.model, routing.family, routing.creds );
	const visionEnabled =
		routing.kind === 'chatgpt'
			? routing.model.input.includes( 'image' )
			: aiModelSupportsImages( config.model );
	const [ userInstructions, imageGenerationEnabled ] = await Promise.all( [
		readGlobalInstructions(),
		isImageGenerationAvailable(),
	] );

	const tools = buildAgentTools( config, imageGenerationEnabled, visionEnabled );
	const systemPrompt = buildSystemPrompt( {
		userInstructions,
		tools: tools.map( toolPromptContribution ),
		activeSite: config.activeSite,
	} );

	const pendingWork = getPendingWork( config.session );
	const site = config.activeSite;
	const notes = createResultNotes();
	const resultNotes =
		site && ! site.remote ? ( text: string ) => notes( site.path, text ) : undefined;
	const toolDefinitions = tools.map( ( tool ) =>
		toToolDefinition(
			config.host,
			tool,
			payloadGuardState,
			pendingWork,
			resultNotes,
			routing.kind === 'chatgpt' ? routing.turn : undefined
		)
	);
	const modelRuntime = await createModelRuntime( model, routing );
	const settingsManager = createSettingsManager( config.env, routing.kind === 'chatgpt' );
	const { sitesRoot } = config.host;
	const resourceLoader = new DefaultResourceLoader( {
		cwd: sitesRoot,
		agentDir: sitesRoot,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt,
		appendSystemPrompt: [],
	} );
	await resourceLoader.reload();

	const result = await createAgentSession( {
		cwd: sitesRoot,
		agentDir: sitesRoot,
		modelRuntime,
		model,
		// OpenAI and ChatGPT turns use the chosen effort; the others keep medium.
		thinkingLevel:
			routing.kind === 'chatgpt'
				? toPiThinkingLevel( routing.reasoningEffort )
				: routing.openAiSettings
				? toPiThinkingLevel( routing.openAiSettings.reasoningEffort )
				: 'medium',
		sessionManager: config.session,
		settingsManager,
		resourceLoader,
		customTools: toolDefinitions,
		tools: toolDefinitions.map( ( tool ) => tool.name ),
		sessionStartEvent: { type: 'session_start', reason: 'startup' },
	} );

	return result.session;
}

function buildModel(
	modelId: AiModelId,
	family: AiModelFamily,
	creds: ResolvedCredentials
): StudioModel {
	const baseUrl = creds.baseURL.replace( /\/+$/, '' );
	const common = {
		id: modelId,
		name: modelId,
		baseUrl,
		input: aiModelSupportsImages( modelId )
			? [ 'text' as const, 'image' as const ]
			: [ 'text' as const ],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...( creds.extraHeaders ? { headers: creds.extraHeaders } : {} ),
	};

	if ( family === 'studio' ) {
		// The capability tiers are resolved to upstream models by the wpcom
		// proxy. The context window is a conservative floor across the
		// upstreams a tier may resolve to, so compaction kicks in before any
		// of them overflows.
		//
		// `strong` rides the proxy's Anthropic Messages path, which sits beside
		// `/v1` rather than under it and authenticates with a bearer token.
		if ( modelId === 'strong' ) {
			return {
				...common,
				baseUrl: baseUrl.replace( /\/v1$/, '' ),
				headers: { ...creds.extraHeaders, Authorization: `Bearer ${ creds.apiKey }` },
				api: 'anthropic-messages',
				provider: STUDIO_WPCOM_PROVIDER,
				reasoning: false,
				contextWindow: 200_000,
				maxTokens: 32_000,
			};
		}
		// `balanced` rides the Responses path: its upstream is a reasoning model
		// that rejects tools-plus-reasoning on Chat Completions.
		if ( modelId === 'balanced' ) {
			return {
				...common,
				api: 'openai-responses',
				provider: STUDIO_WPCOM_PROVIDER,
				reasoning: true,
				contextWindow: 200_000,
				maxTokens: 32_000,
			};
		}
		// The other tiers speak Chat Completions. pi infers `compat` from the
		// base URL, which for us reads as plain OpenAI — so spell out the shape
		// or requests carry OpenAI-only fields other upstreams reject. With
		// `supportsReasoningEffort` false no thinking switch is sent at all and
		// each upstream uses its own default — the portable choice across
		// vendors that spell that parameter differently.
		return {
			...common,
			api: 'openai-completions',
			provider: STUDIO_WPCOM_PROVIDER,
			reasoning: true,
			contextWindow: 200_000,
			maxTokens: 32_000,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				supportsStrictMode: false,
				maxTokensField: 'max_tokens',
			},
		};
	}
	// Without `compat.forceAdaptiveThinking` pi-ai sends the legacy
	// `thinking: { type: 'enabled', budget_tokens }` shape, which Sonnet 5 /
	// Opus 5 reject with a 400 — copy the thinking fields from pi's catalog.
	const catalogModel = (
		ANTHROPIC_MODELS as Partial< Record< string, Model< 'anthropic-messages' > > >
	 )[ modelId ];
	return {
		...common,
		api: 'anthropic-messages',
		provider: ANTHROPIC_PI_PROVIDER,
		reasoning: true,
		// contextWindow/maxTokens intentionally stay below the catalog values.
		contextWindow: 200_000,
		// thinkingLevel 'high' reserves ~16384 of this budget for extended thinking
		// (see adjustMaxTokensForThinking in pi-ai); keep enough headroom for visible
		// output so single tool calls can emit a full-page HTML payload.
		maxTokens: 32_000,
		...( catalogModel?.thinkingLevelMap
			? { thinkingLevelMap: catalogModel.thinkingLevelMap }
			: {} ),
		...( catalogModel?.compat ? { compat: catalogModel.compat } : {} ),
	};
}

// In-memory credential store so the runtime never reads or writes an auth.json
// on disk. Studio resolves credentials from the environment on every turn and
// injects them via runtime API keys or registered provider configs, so nothing
// needs to be persisted.
class InMemoryCredentialStore implements CredentialStore {
	private readonly credentials = new Map< string, Credential >();

	async read( providerId: string ): Promise< Credential | undefined > {
		return this.credentials.get( providerId );
	}

	async list(): Promise< readonly CredentialInfo[] > {
		return [ ...this.credentials.entries() ].map( ( [ providerId, credential ] ) => ( {
			providerId,
			type: credential.type,
		} ) );
	}

	async modify(
		providerId: string,
		fn: ( current: Credential | undefined ) => Promise< Credential | undefined >
	): Promise< Credential | undefined > {
		const next = await fn( this.credentials.get( providerId ) );
		if ( next ) {
			this.credentials.set( providerId, next );
		}
		return next;
	}

	async delete( providerId: string ): Promise< void > {
		this.credentials.delete( providerId );
	}
}

async function createModelRuntime(
	model: StudioModel,
	routing: TurnRouting
): Promise< ModelRuntime > {
	const modelRuntime = await ModelRuntime.create( {
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
	} );

	if ( routing.kind === 'chatgpt' ) {
		// No token is registered: each request takes the turn's current one.
		const snapshot: ChatGptTurnSnapshot = {
			connectionId: routing.turn.connectionId,
			getAccessToken: () => routing.turn.getAccessToken(),
			signal: routing.turn.signal,
			invalidateAccessToken: ( token ) => routing.turn.invalidateAccessToken( token ),
			reasoningEffort: routing.reasoningEffort,
		};
		modelRuntime.registerProvider(
			CHATGPT_PI_PROVIDER,
			createChatGptProviderConfig(
				model as Model< 'openai-responses' >,
				routing.turn.connectionId,
				snapshot
			)
		);
		return modelRuntime;
	}

	if ( routing.openAiSettings ) {
		modelRuntime.registerProvider(
			STUDIO_OPENAI_PROVIDER,
			createOpenAiProviderConfig(
				model as Model< 'openai-responses' >,
				routing.creds.apiKey,
				routing.openAiSettings
			)
		);
		return modelRuntime;
	}

	if ( routing.family === 'studio' ) {
		modelRuntime.registerProvider(
			model.provider,
			createWpcomProviderConfig( model as StudioWpcomModel, routing.creds )
		);
		return modelRuntime;
	}

	await modelRuntime.setRuntimeApiKey( routing.family, routing.creds.apiKey );
	return modelRuntime;
}

// pi (>= 0.78) parses `registerProvider` config values (apiKey, headers) as
// templates: a `$NAME` / `${NAME}` sequence is read as an environment-variable
// reference and a leading `!` is read as a shell command. wpcom OAuth tokens are
// random strings that can contain `$` followed by a name-like sequence, so pi
// resolves that fragment to an undefined env var and treats the provider as
// unauthenticated ("No API key found for studio-wpcom-anthropic."). Escape the
// token so pi treats it as a literal: `$` -> `$$`, and a leading `!` -> `$!`.
function escapePiConfigValue( value: string ): string {
	const dollarEscaped = value.replace( /\$/g, () => '$$' );
	return dollarEscaped.startsWith( '!' ) ? `$${ dollarEscaped }` : dollarEscaped;
}

// The wpcom lane only needs pi's stock streaming for each tier's API; the
// custom provider exists to wrap the stream with the usage-cap 429 rewrite and
// the leaked tool-call cleanup, and to strip stale screenshots, which would
// otherwise bloat requests past the proxy's body limit.
function createWpcomProviderConfig(
	model: StudioWpcomModel,
	creds: ResolvedCredentials
): ProviderConfigInput {
	// pi types `streamSimple` against `Model<Api>`; each API's stream function
	// is narrower, and the model registered below is the one passed in.
	const stream = (
		model.api === 'openai-completions'
			? streamOpenAiCompletions
			: model.api === 'anthropic-messages'
			? streamAnthropicMessages
			: streamOpenAiResponses
	) as NonNullable< ProviderConfigInput[ 'streamSimple' ] >;
	// The model keeps its stable id for pi and the session history; only the
	// request names the proxy's current upstream alias.
	const apiModelId = getAiModel( model.id as AiModelId )?.apiModelId;
	return {
		baseUrl: creds.baseURL,
		apiKey: escapePiConfigValue( creds.apiKey ),
		api: model.api,
		headers: creds.extraHeaders,
		streamSimple: ( m, ctx, options?: SimpleStreamOptions ) =>
			withUsageCapErrorRewrite(
				withLeakedToolCallMarkupRemoved(
					stream( m, stripStaleImagesFromContext( ctx ), {
						...options,
						...( apiModelId
							? {
									onPayload: async ( params: unknown, payloadModel ) => {
										const next = ( await options?.onPayload?.( params, payloadModel ) ) ?? params;
										return { ...( next as Record< string, unknown > ), model: apiModelId };
									},
							  }
							: {} ),
					} )
				)
			),
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				baseUrl: model.baseUrl,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				headers: creds.extraHeaders,
				compat: model.compat,
			},
		],
	};
}

function createSettingsManager(
	_env: Record< string, string >,
	disableRetry = false
): SettingsManager {
	return SettingsManager.inMemory(
		{
			defaultThinkingLevel: 'high',
			compaction: STUDIO_COMPACTION_SETTINGS,
			// A ChatGPT turn is never re-run by pi: no automatic retry, ever.
			...( disableRetry ? { retry: { enabled: false } } : {} ),
		},
		{ projectTrusted: false }
	);
}

// pi's tools declare a prompt snippet and so do Studio's (see define-tool.ts);
// the AgentTool type does not carry it, hence the cast.
type ToolPromptFields = { promptSnippet?: string };

function toolPromptContribution( tool: AgentToolAny ): ToolPromptContribution {
	return { name: tool.name, promptSnippet: ( tool as ToolPromptFields ).promptSnippet };
}

function toToolDefinition(
	host: StudioAgentHost,
	tool: AgentToolAny,
	payloadGuardState: StudioToolPayloadGuardState,
	pendingWork: PendingWork,
	resultNotes?: ( text: string ) => Promise< string >,
	chatGptTurn?: ChatGptTurnHandle
): ToolDefinition {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		promptSnippet: ( tool as ToolPromptFields ).promptSnippet,
		execute: async ( toolCallId, params, signal, onUpdate ) => {
			// A ChatGPT sign-out since the model asked for this call stops it
			// here: the tool never runs on a connection that is gone.
			if ( chatGptTurn ) {
				await chatGptTurn.assertActive();
				if ( chatGptTurn.signal.aborted ) {
					throw chatGptTurn.signal.reason;
				}
			}
			const incompleteToolCallReason = getIncompleteToolCallReason( payloadGuardState, toolCallId );
			if ( incompleteToolCallReason ) {
				throw new Error( incompleteToolCallReason );
			}
			const payloadLimitViolation = getPayloadLimitViolation( tool.name, params );
			if ( payloadLimitViolation ) {
				throw new Error( payloadLimitViolation );
			}
			const fileWriteRefusal = await getFileWriteRefusal(
				tool.name,
				params,
				host.sitesRoot,
				async ( folder ) => Boolean( await host.sites.findByFolder( folder ) )
			);
			if ( fileWriteRefusal ) {
				throw new Error( fileWriteRefusal );
			}
			if ( ( tool as { settlesPendingWork?: boolean } ).settlesPendingWork ) {
				await pendingWork.settle();
			}
			const result = await tool.execute( toolCallId, params, signal, onUpdate );
			const details = result.details as StudioToolResultDetails | undefined;
			if ( details?.pending ) {
				pendingWork.add( details.pending );
				delete details.pending;
			}
			const resultText = result.content
				.map( ( part ) => ( part.type === 'text' ? part.text : '' ) )
				.join( '\n' );
			const notes = [ await resultNotes?.( resultText ), pendingWork.takeReports() ]
				.filter( Boolean )
				.join( '\n' );
			return notes
				? { ...result, content: [ ...result.content, { type: 'text', text: notes } ] }
				: result;
		},
	};
}

function buildAgentTools(
	config: ResolvedStudioAgentTurnConfig,
	imageGenerationEnabled: boolean,
	visionEnabled: boolean
): AgentToolAny[] {
	const { host } = config;
	const askUserTool: AgentToolAny[] = config.onAskUser
		? [ bindTool( createAskUserQuestionTool( config.onAskUser ), host ) ]
		: [];
	const tracks = getAiTracksIdentity( config.session.getSessionId() );
	const designOptionsTool: AgentToolAny[] =
		config.onAskUser && host.ui
			? [
					bindTool(
						createPresentDesignOptionsTool( { onAskUser: config.onAskUser, tracks } ),
						host
					) as unknown as AgentToolAny,
			  ]
			: [];

	const skillToolDef = createSkillTool();
	const skillTool: AgentToolAny[] = skillToolDef ? [ bindTool( skillToolDef, host ) ] : [];

	// pi's tools are registered under Studio's names; the prompt text for them
	// is Studio's too (file-tool-prompts.ts), so nothing of pi's wording leaks.
	const renameTool = < S extends TSchema >( tool: AgentTool< S >, name: string ): AgentTool< S > =>
		( { ...tool, name, label: name, ...getFileToolPrompt( name ) } ) as AgentTool< S >;

	const { sitesRoot, ui } = host;
	const designSystemPreview = < TTool extends AgentToolAny >( tool: TTool ) =>
		withDesignSystemPreview( tool, sitesRoot, ui );
	const piTools: AgentToolAny[] = [
		renameTool( createReadTool( sitesRoot ), 'Read' ),
		designSystemPreview( renameTool( createWriteTool( sitesRoot ), 'Write' ) ),
		designSystemPreview( renameTool( createEditTool( sitesRoot ), 'Edit' ) ),
		renameTool( createBashTool( sitesRoot, { spawnHook: withoutProviderSecrets } ), 'Bash' ),
		renameTool( createGrepTool( sitesRoot ), 'Grep' ),
		renameTool( createFindTool( sitesRoot ), 'Glob' ),
		renameTool( createLsTool( sitesRoot ), 'Ls' ),
	];
	const studioTools = resolveStudioTools( host, {
		imageGeneration: imageGenerationEnabled,
		visionEnabled,
		canAskUser: Boolean( config.onAskUser ),
		tracks,
	} ) as unknown as AgentToolAny[];
	return [ ...studioTools, ...askUserTool, ...designOptionsTool, ...skillTool, ...piTools ];
}

// Model provider keys the agent's shell has no use for, including
// STUDIO_WPCOM_API_KEY, the WordPress.com models' copy of the access token.
// STUDIO_WPCOM_TOKEN stays: Studio's own CLI, which the agent runs, logs in with it.
const PROVIDER_SECRET_VARIABLES = new Set( [
	'OPENAI_API_KEY',
	'STUDIO_OPENAI_API_KEY',
	'ANTHROPIC_API_KEY',
	'ANTHROPIC_AUTH_TOKEN',
	'STUDIO_WPCOM_API_KEY',
] );

/**
 * Strips model provider keys from the environment a Bash tool command runs in,
 * whatever their case: Windows reads `openai_api_key` as OPENAI_API_KEY.
 */
function withoutProviderSecrets< T extends { env: NodeJS.ProcessEnv } >( context: T ): T {
	const env = { ...context.env };
	for ( const name of Object.keys( env ) ) {
		if ( PROVIDER_SECRET_VARIABLES.has( name.toUpperCase() ) ) {
			delete env[ name ];
		}
	}
	return { ...context, env };
}

function parseJsonHeaderEnv(
	name: string,
	value: string | undefined
): Record< string, string > | undefined {
	if ( ! value ) return undefined;
	try {
		const parsed: unknown = JSON.parse( value );
		if ( parsed && typeof parsed === 'object' && ! Array.isArray( parsed ) ) {
			const entries = Object.entries( parsed as Record< string, unknown > ).filter(
				( [ , v ] ) => typeof v === 'string'
			) as [ string, string ][];
			return entries.length ? Object.fromEntries( entries ) : undefined;
		}
		console.warn(
			`${ name } must be a JSON object of string→string pairs; ignoring custom headers.`
		);
	} catch {
		console.warn( `${ name } contained malformed JSON; ignoring custom headers.` );
	}
	return undefined;
}
