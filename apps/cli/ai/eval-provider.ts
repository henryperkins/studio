/**
 * Which provider and connection an eval runs on, and which one it actually
 * ran on. Development only, for the eval runner.
 *
 * Without a selection the runner resolves the globally configured provider,
 * as it always has, and a model name alone never picks a billing route. With
 * one, the run executes on the named provider, and for a subscription
 * provider on the named connection, or is refused with a typed code before any
 * model request. What executed is read back from the run itself: the model
 * requests the request observer saw, the providers the runtime stamped on its
 * replies and the connection the conversation's record names.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readChatGptSessionSelection } from '@studio/agent/protocol/chatgpt';
import {
	CHATGPT_MODEL_CAPABILITIES,
	describeChatGptReasoningProblem,
	getDefaultChatGptReasoningEffort,
	resolveChatGptReasoning,
} from '@studio/agent/protocol/chatgpt-models';
import { isAiModelId, type AiModelId } from '@studio/agent/protocol/models';
import {
	OPENAI_MODEL_CAPABILITIES,
	isOpenAiModelId,
	type OpenAiReasoningEffort,
} from '@studio/agent/protocol/openai-models';
import {
	ANTHROPIC_PI_PROVIDER,
	CHATGPT_PI_PROVIDER,
	OPENAI_PI_PROVIDER,
	isAiProviderId,
	type AiProviderId,
} from '@studio/agent/protocol/providers';
import type { ObservedHost, ObservedRequest } from './chatgpt-acceptance-observer';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type {
	ConnectionRegistryEntry,
	ConnectionSelection,
} from '@studio/agent/protocol/connections';
import type { StudioSessionContextData } from '@studio/agent/protocol/sessions/entry-types';

const EVAL_PROVIDER_ENV = 'STUDIO_EVAL_PROVIDER';
const EVAL_CONNECTION_ENV = 'STUDIO_EVAL_CONNECTION';
const EVAL_EFFORT_ENV = 'STUDIO_EVAL_EFFORT';

/** The pi provider id WordPress.com replies carry (the runtime's `studio-wpcom`). */
const WPCOM_PI_PROVIDER = 'studio-wpcom';

/** Where a provider's model requests go, in the request observer's terms. */
type EvalBackend = Extract<
	ObservedHost,
	'chatgpt-route' | 'openai-api' | 'anthropic' | 'wpcom-ai-proxy'
>;

const BACKEND_BY_PROVIDER: Record< AiProviderId, EvalBackend > = {
	wpcom: 'wpcom-ai-proxy',
	'anthropic-api-key': 'anthropic',
	'openai-api-key': 'openai-api',
	'chatgpt-oauth': 'chatgpt-route',
};

const PROVIDER_BY_BACKEND: Record< EvalBackend, AiProviderId > = {
	'wpcom-ai-proxy': 'wpcom',
	anthropic: 'anthropic-api-key',
	'openai-api': 'openai-api-key',
	'chatgpt-route': 'chatgpt-oauth',
};

/**
 * Providers whose conversations run on a connection of their own, named by
 * `STUDIO_EVAL_CONNECTION`. Another subscription provider adds its id here and
 * its planning branch in `resolveEvalProviderPlan`.
 */
const SUBSCRIPTION_PROVIDERS: ReadonlySet< AiProviderId > = new Set( [ 'chatgpt-oauth' ] );

type EvalProviderFailureCode =
	| 'provider-unknown'
	| 'provider-conflict'
	| 'provider-required'
	| 'selection-without-provider'
	| 'connection-required'
	| 'connection-not-applicable'
	| 'connection-unknown'
	| 'connection-signed-out'
	| 'connection-unsupported'
	| 'connection-state-unavailable'
	| 'experimental-flag-off'
	| 'model-not-qualified'
	| 'effort-not-qualified'
	| 'effort-not-applicable'
	| 'model-provider-mismatch'
	| 'provider-not-ready';

export interface EvalProviderFailure {
	code: EvalProviderFailureCode;
	message: string;
}

export interface EvalProviderRequest {
	provider: AiProviderId;
	connectionId?: string;
	model?: string;
	effort?: string;
}

export type EvalProviderRequestResult =
	| { ok: true; request: EvalProviderRequest }
	| { ok: false; failure: EvalProviderFailure };

const failure = ( code: EvalProviderFailureCode, message: string ) => ( {
	ok: false as const,
	failure: { code, message },
} );

const text = ( value: unknown ): string | undefined =>
	typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * The provider selection a run names, or null when it names none and takes
 * the default path. The provider comes from `STUDIO_EVAL_PROVIDER` or the
 * case's `provider` var, which must agree; the connection only from
 * `STUDIO_EVAL_CONNECTION`, so no config holds one; the effort from the case's
 * `effort` var or `STUDIO_EVAL_EFFORT`; the model from the case's `model` var
 * or `STUDIO_EVAL_MODEL`, as on the default path.
 */
export function readEvalProviderRequest( {
	env,
	vars,
}: {
	env: NodeJS.ProcessEnv;
	vars: Record< string, unknown >;
} ): EvalProviderRequestResult | null {
	const fromEnv = text( env[ EVAL_PROVIDER_ENV ] );
	const fromCase = text( vars.provider );
	const connectionId = text( env[ EVAL_CONNECTION_ENV ] );
	const effort = text( vars.effort ) ?? text( env[ EVAL_EFFORT_ENV ] );
	const model = text( vars.model ) ?? text( env.STUDIO_EVAL_MODEL );
	if ( fromEnv && fromCase && fromEnv !== fromCase ) {
		return failure(
			'provider-conflict',
			`${ EVAL_PROVIDER_ENV } names ${ fromEnv } but the case names ${ fromCase }. Name one provider.`
		);
	}
	const provider = fromEnv ?? fromCase;
	if ( ! provider ) {
		if ( vars.requireProvider === true ) {
			return failure(
				'provider-required',
				`This case runs only on an explicitly selected provider. Set ${ EVAL_PROVIDER_ENV } (and ${ EVAL_CONNECTION_ENV } for a subscription provider); the global provider is never used for it.`
			);
		}
		if ( connectionId || effort ) {
			return failure(
				'selection-without-provider',
				`${
					connectionId ? EVAL_CONNECTION_ENV : EVAL_EFFORT_ENV
				} is set but no provider is selected. Set ${ EVAL_PROVIDER_ENV } too.`
			);
		}
		return null;
	}
	if ( ! isAiProviderId( provider ) ) {
		return failure(
			'provider-unknown',
			`Unknown eval provider "${ provider }". Use one of: wpcom, anthropic-api-key, openai-api-key, chatgpt-oauth.`
		);
	}
	return {
		ok: true,
		request: {
			provider,
			...( connectionId ? { connectionId } : {} ),
			...( model ? { model } : {} ),
			...( effort ? { effort } : {} ),
		},
	};
}

/** A connection, named without its identifier: stable within a machine, never reversible. */
export function evalConnectionRef( connectionId: string ): string {
	return `conn-${ createHash( 'sha256' )
		.update( `studio-eval-connection:${ connectionId }` )
		.digest( 'hex' )
		.slice( 0, 12 ) }`;
}

/** What a provider-qualified run asked for. */
export interface RequestedRoute {
	kind: AiProviderId;
	backend: EvalBackend;
	/** Paid with a subscription: an API-key bearer is never right on it. */
	subscription: boolean;
	/** `evalConnectionRef` of the connection, or the provider id for its implicit one. */
	connectionRef: string;
	model: string;
	/** The model id the requests carry, or null when the observer can't see it. */
	wireModel: string | null;
	effort: string | null;
}

export interface EvalProviderPlan {
	requested: RequestedRoute;
	/** The turn's provider environment: never the global provider's. */
	env: Record< string, string >;
	turn: {
		model?: AiModelId;
		connection?: ConnectionSelection;
		chatGpt?: { reasoningEffort: OpenAiReasoningEffort };
	};
	/** The record a subscription conversation names its connection by, before each turn. */
	sessionContext?: StudioSessionContextData;
	/** What a reply on this route records, for seeded history. */
	reply: { provider: string; api: string; model: string };
}

/** The parts of a legacy provider definition (`cli/ai/providers`) planning reads. */
interface EvalLegacyProvider {
	isReady(): Promise< boolean >;
	resolveEnv(): Promise< Record< string, string > >;
	supportsModel( model: AiModelId ): boolean;
	readonly defaultModel: AiModelId;
}

export interface EvalProviderDeps {
	isChatGptEnabled(): boolean;
	listChatGptConnections(): Promise< ConnectionRegistryEntry[] >;
	provider( id: AiProviderId ): EvalLegacyProvider;
}

export type EvalProviderPlanResult =
	| { ok: true; plan: EvalProviderPlan }
	| { ok: false; failure: EvalProviderFailure };

const REPLY_API: Record< AiProviderId, string > = {
	wpcom: 'openai-completions',
	'anthropic-api-key': 'anthropic-messages',
	'openai-api-key': 'openai-responses',
	'chatgpt-oauth': 'openai-responses',
};

const REPLY_PROVIDER: Record< AiProviderId, string > = {
	wpcom: WPCOM_PI_PROVIDER,
	'anthropic-api-key': ANTHROPIC_PI_PROVIDER,
	'openai-api-key': OPENAI_PI_PROVIDER,
	'chatgpt-oauth': CHATGPT_PI_PROVIDER,
};

async function planChatGpt(
	request: EvalProviderRequest,
	deps: EvalProviderDeps
): Promise< EvalProviderPlanResult > {
	const { connectionId } = request;
	if ( ! connectionId ) {
		return failure(
			'connection-required',
			`A ChatGPT eval runs on one signed-in ChatGPT connection: set ${ EVAL_CONNECTION_ENV } to its registration id (shown by /chatgpt → Select saved account).`
		);
	}
	if ( ! deps.isChatGptEnabled() ) {
		return failure(
			'experimental-flag-off',
			'ChatGPT plan connections are off in this process. Set STUDIO_EXPERIMENTAL_CHATGPT=1 to run a ChatGPT eval.'
		);
	}
	const model = request.model ?? Object.keys( CHATGPT_MODEL_CAPABILITIES )[ 0 ] ?? '';
	const reasoning = resolveChatGptReasoning(
		model,
		request.effort ?? getDefaultChatGptReasoningEffort( model )
	);
	if ( ! reasoning.ok ) {
		return failure(
			reasoning.problem.code === 'unknown-model' ? 'model-not-qualified' : 'effort-not-qualified',
			describeChatGptReasoningProblem( reasoning.problem )
		);
	}
	let connections: ConnectionRegistryEntry[];
	try {
		connections = await deps.listChatGptConnections();
	} catch {
		return failure(
			'connection-state-unavailable',
			'Studio couldn’t read the ChatGPT connections in this profile, so the eval did not run.'
		);
	}
	const entry = connections.find( ( item ) => item.connectionId === connectionId );
	if ( ! entry ) {
		return failure(
			'connection-unknown',
			`No ChatGPT connection with the id in ${ EVAL_CONNECTION_ENV } is saved in this Studio profile.`
		);
	}
	if ( entry.providerId !== 'chatgpt-oauth' || entry.backend !== 'pi' ) {
		return failure(
			'connection-unsupported',
			'That connection is not a ChatGPT connection Studio’s agent can run on.'
		);
	}
	if ( entry.authStatus !== 'connected' || ! entry.identity?.subject ) {
		return failure(
			'connection-signed-out',
			'That ChatGPT connection is not signed in here. Sign in again with secure storage: a session-only sign-in lives only in the app that holds it.'
		);
	}
	const sessionContext: StudioSessionContextData = {
		provider: 'chatgpt-oauth',
		connectionId,
		revision: entry.revision,
		model,
		reasoningEffort: reasoning.effort,
	};
	return {
		ok: true,
		plan: {
			requested: {
				kind: 'chatgpt-oauth',
				backend: BACKEND_BY_PROVIDER[ 'chatgpt-oauth' ],
				subscription: true,
				connectionRef: evalConnectionRef( connectionId ),
				model,
				wireModel: model,
				effort: reasoning.effort,
			},
			env: await deps.provider( 'chatgpt-oauth' ).resolveEnv(),
			turn: {
				connection: {
					connectionId,
					model: { providerId: 'chatgpt-oauth', modelId: model },
					revision: entry.revision,
				},
				chatGpt: { reasoningEffort: reasoning.effort },
			},
			sessionContext,
			reply: { provider: CHATGPT_PI_PROVIDER, api: REPLY_API[ 'chatgpt-oauth' ], model },
		},
	};
}

async function planLegacy(
	request: EvalProviderRequest,
	deps: EvalProviderDeps
): Promise< EvalProviderPlanResult > {
	const kind = request.provider;
	if ( request.connectionId ) {
		return failure(
			'connection-not-applicable',
			`${ kind } has one implicit connection; unset ${ EVAL_CONNECTION_ENV }.`
		);
	}
	if ( request.effort ) {
		return failure(
			'effort-not-applicable',
			`An eval effort applies to subscription providers only; unset it for ${ kind }.`
		);
	}
	const definition = deps.provider( kind );
	const model = request.model ?? definition.defaultModel;
	if ( ! isAiModelId( model ) || ! definition.supportsModel( model ) ) {
		return failure( 'model-provider-mismatch', `${ kind } does not serve the model "${ model }".` );
	}
	if ( ! ( await definition.isReady() ) ) {
		return failure(
			'provider-not-ready',
			`${ kind } is not set up in this Studio profile, and the eval runs nowhere else.`
		);
	}
	let env: Record< string, string >;
	try {
		env = await definition.resolveEnv();
	} catch {
		return failure(
			'provider-not-ready',
			`${ kind } could not provide its credentials, and the eval runs nowhere else.`
		);
	}
	return {
		ok: true,
		plan: {
			requested: {
				kind,
				backend: BACKEND_BY_PROVIDER[ kind ],
				subscription: false,
				connectionRef: kind,
				model,
				wireModel:
					kind === 'openai-api-key' && isOpenAiModelId( model )
						? OPENAI_MODEL_CAPABILITIES[ model ].apiModelId
						: null,
				effort: null,
			},
			env,
			turn: { model },
			reply: { provider: REPLY_PROVIDER[ kind ], api: REPLY_API[ kind ], model },
		},
	};
}

/**
 * What a selected run sends its turns, checked against the live connection
 * state first. A selection that can't run here is refused with its code: never
 * replaced by the global provider, another connection, model or effort.
 */
export function resolveEvalProviderPlan(
	request: EvalProviderRequest,
	deps: EvalProviderDeps
): Promise< EvalProviderPlanResult > {
	return SUBSCRIPTION_PROVIDERS.has( request.provider )
		? planChatGpt( request, deps )
		: planLegacy( request, deps );
}

/** One model or image-service request of the run, as the observer summarized it. */
interface ExecutedRequest {
	host: ObservedHost;
	endpoint: ObservedRequest[ 'endpoint' ];
	bearer: ObservedRequest[ 'bearer' ];
	model?: string;
	effort?: string;
	inputItems?: number;
	imageInputs?: number;
	imageToolOutputs?: number;
	reasoningItems?: number;
	/** The user message (0 for the first) whose turn made the request. */
	turn?: number;
}

/** The route a run's model requests actually took. */
export interface ExecutedRoute {
	kind: AiProviderId | 'none' | 'mixed';
	backend: EvalBackend | 'none' | 'mixed';
	modelRequests: number;
	apiKeyBearers: number;
	/** Requests to Studio's separate WordPress.com image service: not inference. */
	imageServiceRequests: number;
	models: string[];
	efforts: string[];
	/** The providers the runtime recorded on its replies. */
	replyKinds: Array< AiProviderId | 'unknown' >;
	replyModels: string[];
	/**
	 * For ChatGPT, `evalConnectionRef` of the connection the conversation's
	 * record names, which the runtime checks against the connection it begins
	 * every turn on; for a legacy provider, its implicit connection.
	 */
	connectionRef: string | null;
	/** Up to 200 requests, in order. */
	requests: ExecutedRequest[];
}

const isModelBackend = ( host: ObservedHost ): host is EvalBackend =>
	host === 'chatgpt-route' ||
	host === 'openai-api' ||
	host === 'anthropic' ||
	host === 'wpcom-ai-proxy';

const distinct = < T >( values: Array< T | undefined > ): T[] => [
	...new Set( values.filter( ( value ): value is T => value !== undefined ) ),
];

function replyKind( provider: unknown ): AiProviderId | 'unknown' {
	switch ( provider ) {
		case CHATGPT_PI_PROVIDER:
			return 'chatgpt-oauth';
		case OPENAI_PI_PROVIDER:
			return 'openai-api-key';
		case ANTHROPIC_PI_PROVIDER:
			return 'anthropic-api-key';
		case WPCOM_PI_PROVIDER:
			return 'wpcom';
		default:
			return 'unknown';
	}
}

export function summarizeExecutedRoute( {
	requests,
	replies,
	entries,
	turnStartedAt = [],
}: {
	requests: readonly ObservedRequest[];
	replies: ReadonlyArray< { provider?: unknown; model?: unknown } >;
	entries: SessionEntry[];
	/** When each user message's turn started (epoch ms), in order. */
	turnStartedAt?: readonly number[];
} ): ExecutedRoute {
	const turnOf = ( startedAt: number ) => {
		const index = turnStartedAt.filter( ( start ) => start <= startedAt ).length - 1;
		return index >= 0 ? index : undefined;
	};
	const imageService = requests.filter(
		( request ) => request.host === 'wpcom-ai-proxy' && request.endpoint === 'images'
	);
	const inference = requests.filter(
		( request ) =>
			isModelBackend( request.host ) &&
			request.endpoint !== 'models' &&
			! imageService.includes( request )
	);
	const backends = distinct( inference.map( ( request ) => request.host as EvalBackend ) );
	const backend = backends.length === 1 ? backends[ 0 ] : backends.length ? 'mixed' : 'none';
	const kind = backend === 'none' || backend === 'mixed' ? backend : PROVIDER_BY_BACKEND[ backend ];
	let connectionRef: string | null = null;
	if ( kind === 'chatgpt-oauth' ) {
		const recorded = readChatGptSessionSelection( entries )?.connectionId;
		connectionRef = recorded ? evalConnectionRef( recorded ) : null;
	} else if ( kind !== 'none' && kind !== 'mixed' ) {
		connectionRef = kind;
	}
	return {
		kind,
		backend,
		modelRequests: inference.length,
		apiKeyBearers: inference.filter( ( request ) => request.bearer === 'api-key' ).length,
		imageServiceRequests: imageService.length,
		models: distinct( inference.map( ( request ) => request.model ) ),
		efforts: distinct( inference.map( ( request ) => request.effort ) ),
		replyKinds: distinct( replies.map( ( reply ) => replyKind( reply.provider ) ) ),
		replyModels: distinct(
			replies.map( ( reply ) => ( typeof reply.model === 'string' ? reply.model : undefined ) )
		),
		connectionRef,
		requests: [ ...inference, ...imageService ]
			.sort( ( a, b ) => a.startedAt - b.startedAt || a.id - b.id )
			.slice( 0, 200 )
			.map( ( request ) => ( {
				host: request.host,
				endpoint: request.endpoint,
				bearer: request.bearer,
				model: request.model,
				effort: request.effort,
				inputItems: request.inputItems,
				imageInputs: request.imageInputs,
				imageToolOutputs: request.imageToolOutputs,
				reasoningItems: request.reasoningItems,
				turn: turnOf( request.startedAt ),
			} ) ),
	};
}

const CHATGPT_ACCOUNTS_FILE = 'chatgpt-accounts.json';
const CHATGPT_CREDENTIALS_DIRECTORY = 'chatgpt-credentials';

/**
 * Makes the ChatGPT sign-ins of `sourceDir` usable from an eval case's own
 * profile: its credential records by a directory link, so a refresh and its
 * lockfiles land in the source's records (copying them would leave the
 * source with a refresh token the service has since retired), and its account
 * list by a file link, or a copy where links are refused. The returned
 * function removes those links, never anything they point to.
 */
export function linkChatGptState( sourceDir: string, caseDir: string ): () => void {
	const made: string[] = [];
	const credentials = path.join( sourceDir, CHATGPT_CREDENTIALS_DIRECTORY );
	if ( fs.existsSync( credentials ) ) {
		const link = path.join( caseDir, CHATGPT_CREDENTIALS_DIRECTORY );
		fs.symlinkSync( credentials, link, process.platform === 'win32' ? 'junction' : 'dir' );
		made.push( link );
	}
	const accounts = path.join( sourceDir, CHATGPT_ACCOUNTS_FILE );
	if ( fs.existsSync( accounts ) ) {
		const link = path.join( caseDir, CHATGPT_ACCOUNTS_FILE );
		try {
			fs.symlinkSync( accounts, link, 'file' );
		} catch {
			fs.copyFileSync( accounts, link );
		}
		made.push( link );
	}
	return () => {
		for ( const link of made ) {
			try {
				fs.unlinkSync( link );
			} catch {
				// Already gone.
			}
		}
	};
}
