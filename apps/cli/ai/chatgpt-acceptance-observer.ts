import fs from 'node:fs';

/**
 * Development only. Loaded with `--import` into the Studio CLI processes the
 * ChatGPT acceptance runner starts: wraps `fetch` and appends one line per
 * request it sees, and one per response, to the file the runner names in
 * `STUDIO_ACCEPTANCE_OBSERVER_FILE`. A line holds the request's destination
 * class, the bearer's shape, the model, the effort and counts of what the
 * request and its stream carried. Never a URL, a header value, a token or any
 * content.
 */

export const ACCEPTANCE_OBSERVER_FILE_ENV = 'STUDIO_ACCEPTANCE_OBSERVER_FILE';

export type ObservedHost =
	| 'chatgpt-route'
	| 'openai-api'
	| 'openai-auth'
	| 'wpcom-ai-proxy'
	| 'wpcom'
	| 'anthropic'
	| 'other';

export type BearerShape = 'none' | 'api-key' | 'jwt' | 'opaque';

export interface ObservedRequestSummary {
	host: ObservedHost;
	endpoint: 'responses' | 'models' | 'other';
	bearer: BearerShape;
	model?: string;
	effort?: string;
	stream?: boolean;
	store?: boolean;
	outputCap?: boolean;
	previousResponseId?: boolean;
	tools?: number;
	inputItems?: number;
	userMessages?: number;
	assistantMessages?: number;
	functionCalls?: number;
	functionOutputs?: number;
	reasoningItems?: number;
	imageInputs?: number;
	imageToolOutputs?: number;
}

export interface ObservedRequest extends ObservedRequestSummary {
	kind: 'request';
	id: number;
	pid: number;
	startedAt: number;
}

export interface ObservedResponseSummary {
	status: number | null;
	reasoningOutputs: number;
	functionCallOutputs: number;
	completed: boolean;
	failed: boolean;
}

export interface ObservedResponse extends ObservedResponseSummary {
	kind: 'response';
	id: number;
	pid: number;
	endedAt: number;
}

export type ObservedLine = ObservedRequest | ObservedResponse;

const MODEL_SLUG = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const EFFORTS = new Set( [ 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max' ] );

const isRecord = ( value: unknown ): value is Record< string, unknown > =>
	typeof value === 'object' && value !== null && ! Array.isArray( value );

function classifyHost( url: URL ): {
	host: ObservedHost;
	endpoint: ObservedRequestSummary[ 'endpoint' ];
} {
	const host = url.hostname.toLowerCase();
	if ( host === 'api.openai.com' ) {
		const endpoint =
			url.pathname === '/v1/responses'
				? 'responses'
				: url.pathname === '/v1/models'
				? 'models'
				: 'other';
		return { host: 'openai-api', endpoint };
	}
	if ( host === 'auth.openai.com' ) {
		return { host: 'openai-auth', endpoint: 'other' };
	}
	if ( host === 'api.anthropic.com' ) {
		return { host: 'anthropic', endpoint: 'other' };
	}
	if ( host === 'public-api.wordpress.com' || host.endsWith( '.wordpress.com' ) ) {
		return {
			host: url.pathname.startsWith( '/wpcom/v2/ai-api-proxy' ) ? 'wpcom-ai-proxy' : 'wpcom',
			endpoint: 'other',
		};
	}
	return { host: 'other', endpoint: 'other' };
}

function classifyBearer( authorization: string | null ): BearerShape {
	const match = authorization?.match( /^\s*bearer\s+(\S+)/i );
	if ( ! match ) {
		return 'none';
	}
	const credential = match[ 1 ];
	if ( /^sk-/.test( credential ) ) {
		return 'api-key';
	}
	return /^eyJ[\w-]+\.[\w-]+\./.test( credential ) ? 'jwt' : 'opaque';
}

const countWhere = < T >( items: readonly T[], predicate: ( item: T ) => boolean ) =>
	items.filter( predicate ).length;

const hasImage = ( content: unknown ) =>
	Array.isArray( content ) &&
	content.some( ( part ) => isRecord( part ) && part.type === 'input_image' );

function summarizeResponsesBody(
	body: Record< string, unknown >
): Partial< ObservedRequestSummary > {
	const input = Array.isArray( body.input ) ? body.input.filter( isRecord ) : [];
	const reasoning = isRecord( body.reasoning ) ? body.reasoning : {};
	const additionalTools = input
		.filter( ( item ) => item.type === 'additional_tools' && Array.isArray( item.tools ) )
		.reduce( ( total, item ) => total + ( item.tools as unknown[] ).length, 0 );
	return {
		model:
			typeof body.model === 'string' && MODEL_SLUG.test( body.model ) ? body.model : 'unrecognized',
		...( typeof reasoning.effort === 'string'
			? { effort: EFFORTS.has( reasoning.effort ) ? reasoning.effort : 'unrecognized' }
			: {} ),
		stream: body.stream === true,
		store: body.store === true,
		outputCap: body.max_output_tokens !== undefined || body.max_tokens !== undefined,
		previousResponseId: body.previous_response_id !== undefined,
		tools: additionalTools + ( Array.isArray( body.tools ) ? body.tools.length : 0 ),
		inputItems: input.length,
		userMessages: countWhere( input, ( item ) => item.role === 'user' ),
		assistantMessages: countWhere(
			input,
			( item ) => item.type === 'message' && item.role === 'assistant'
		),
		functionCalls: countWhere( input, ( item ) => item.type === 'function_call' ),
		functionOutputs: countWhere( input, ( item ) => item.type === 'function_call_output' ),
		reasoningItems: countWhere( input, ( item ) => item.type === 'reasoning' ),
		imageInputs: countWhere( input, ( item ) => item.role === 'user' && hasImage( item.content ) ),
		imageToolOutputs: countWhere(
			input,
			( item ) => item.type === 'function_call_output' && hasImage( item.output )
		),
	};
}

function readHeader( input: unknown, init: RequestInit | undefined, name: string ): string | null {
	try {
		if ( init?.headers ) {
			return new Headers( init.headers ).get( name );
		}
		if ( input instanceof Request ) {
			return input.headers.get( name );
		}
	} catch {
		// Unreadable headers say nothing.
	}
	return null;
}

/** What a request is, without anything it carries. Null when it has no URL this can read. */
export function summarizeObservedRequest(
	input: unknown,
	init?: RequestInit
): ObservedRequestSummary | null {
	let url: URL;
	try {
		url = new URL(
			typeof input === 'string' || input instanceof URL ? input : ( input as Request ).url
		);
	} catch {
		return null;
	}
	const { host, endpoint } = classifyHost( url );
	const summary: ObservedRequestSummary = {
		host,
		endpoint,
		bearer: classifyBearer( readHeader( input, init, 'authorization' ) ),
	};
	if ( host === 'openai-api' && endpoint === 'models' ) {
		return { ...summary, host: summary.bearer === 'api-key' ? 'openai-api' : 'chatgpt-route' };
	}
	if ( host !== 'openai-api' || endpoint !== 'responses' || typeof init?.body !== 'string' ) {
		return summary;
	}
	let body: unknown;
	try {
		body = JSON.parse( init.body );
	} catch {
		return summary;
	}
	if ( ! isRecord( body ) ) {
		return summary;
	}
	return {
		...summary,
		// The ChatGPT route and the API share an endpoint; the bearer tells them apart.
		host: summary.bearer === 'api-key' ? 'openai-api' : 'chatgpt-route',
		...summarizeResponsesBody( body ),
	};
}

/** What a streamed Responses reply carried: counts of item types and how it ended. */
export function summarizeResponseStream(
	text: string,
	status: number | null
): ObservedResponseSummary {
	const summary: ObservedResponseSummary = {
		status,
		reasoningOutputs: 0,
		functionCallOutputs: 0,
		completed: false,
		failed: false,
	};
	for ( const line of text.split( /\r?\n/ ) ) {
		if ( ! line.startsWith( 'data:' ) ) {
			continue;
		}
		let event: unknown;
		try {
			event = JSON.parse( line.slice( 5 ).trim() );
		} catch {
			continue;
		}
		if ( ! isRecord( event ) ) {
			continue;
		}
		if ( event.type === 'response.output_item.done' && isRecord( event.item ) ) {
			if ( event.item.type === 'reasoning' ) {
				summary.reasoningOutputs += 1;
			}
			if ( event.item.type === 'function_call' ) {
				summary.functionCallOutputs += 1;
			}
		}
		if ( event.type === 'response.completed' ) {
			summary.completed = true;
		}
		if ( event.type === 'response.failed' || event.type === 'error' ) {
			summary.failed = true;
		}
	}
	return summary;
}

/** Appends request and response summaries to `file` for every `fetch` in this process. */
export function installAcceptanceObserver(
	file: string,
	target: { fetch: typeof fetch } = globalThis
): () => void {
	const original = target.fetch;
	let sequence = 0;
	const write = ( line: ObservedLine ) => {
		try {
			fs.appendFileSync( file, JSON.stringify( line ) + '\n', 'utf8' );
		} catch {
			// An observation that can't be kept never fails the request.
		}
	};
	const observed = async ( input: Parameters< typeof fetch >[ 0 ], init?: RequestInit ) => {
		const id = ++sequence;
		const request = summarizeObservedRequest( input, init );
		if ( request ) {
			write( { kind: 'request', id, pid: process.pid, startedAt: Date.now(), ...request } );
		}
		let response: Response;
		try {
			response = await original( input, init );
		} catch ( error ) {
			if ( request ) {
				write( {
					kind: 'response',
					id,
					pid: process.pid,
					endedAt: Date.now(),
					...summarizeResponseStream( '', null ),
				} );
			}
			throw error;
		}
		if ( request && ( request.host === 'chatgpt-route' || request.host === 'openai-api' ) ) {
			const status = response.status;
			const streamed = response.headers.get( 'content-type' )?.includes( 'text/event-stream' );
			void ( streamed ? response.clone().text() : Promise.resolve( '' ) )
				.catch( () => '' )
				.then( ( text ) =>
					write( {
						kind: 'response',
						id,
						pid: process.pid,
						endedAt: Date.now(),
						...summarizeResponseStream( text, status ),
					} )
				);
		} else if ( request ) {
			write( {
				kind: 'response',
				id,
				pid: process.pid,
				endedAt: Date.now(),
				...summarizeResponseStream( '', response.status ),
			} );
		}
		return response;
	};
	target.fetch = observed as typeof fetch;
	return () => {
		target.fetch = original;
	};
}

/** The lines an observer wrote, skipping a last line still being written. */
export function readObservedLines( file: string ): ObservedLine[] {
	let text: string;
	try {
		text = fs.readFileSync( file, 'utf8' );
	} catch {
		return [];
	}
	const lines: ObservedLine[] = [];
	for ( const line of text.split( /\r?\n/ ) ) {
		if ( ! line ) {
			continue;
		}
		try {
			lines.push( JSON.parse( line ) as ObservedLine );
		} catch {
			// Partly written.
		}
	}
	return lines;
}

const preloadFile = process.env[ ACCEPTANCE_OBSERVER_FILE_ENV ];
if ( preloadFile ) {
	installAcceptanceObserver( preloadFile );
}
