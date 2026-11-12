/**
 * What an eval case can set up around its turns: remote operations replaced
 * by fixtures and a guard against any other write to WordPress.com, files the
 * user attached, and history the conversation already has. Development only,
 * for the eval runner.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { textResult } from '@studio/agent/node';
// eslint-disable-next-line no-restricted-imports -- development only: no host hook reaches this one tool, so the harness mocks its writes here.
import { wpcomRequestTool } from '@studio/agent/node/tools/wpcom-request';
import {
	buildAttachedFilesPromptBlock,
	type StudioChatFileAttachment,
} from '@studio/agent/protocol/chat-files';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import type { HostSite, StudioAgentHost } from '@studio/agent/node';
import type { StudioChatImage, StudioChatImageMimeType } from '@studio/agent/protocol/chat-images';
import type { Snapshot } from '@studio/common/types/snapshot';
import type { SyncSite } from '@studio/common/types/sync';

/** A remote operation a case's turn asked for, which a mocked host recorded instead of running. */
export interface RemoteCall {
	operation:
		| 'push'
		| 'pull'
		| 'preview-create'
		| 'preview-update'
		| 'preview-delete'
		| 'wpcom-request';
	/** For `wpcom-request`: the method it would have sent. */
	method?: string;
	site?: string;
	target?: string;
	options?: string;
}

// Reserved for documentation (RFC 2606): nothing is ever reached there.
const MOCK_REMOTE_URL = 'https://eval-mock-remote.invalid';
const MOCK_PREVIEW_HOST = 'eval-mock-preview.invalid';

function mockRemoteSite( site: HostSite, remoteSite: string | undefined ): SyncSite {
	return {
		id: 0,
		localSiteId: site.id,
		name: 'Eval mock remote site',
		url: remoteSite && /^https?:\/\//.test( remoteSite ) ? remoteSite : MOCK_REMOTE_URL,
		isStaging: false,
		isPressable: false,
		syncSupport: 'already-connected',
		lastPullTimestamp: null,
		lastPushTimestamp: null,
	};
}

function mockPreview( site: HostSite, hostname = MOCK_PREVIEW_HOST ): Snapshot {
	return {
		url: hostname,
		atomicSiteId: 0,
		localSiteId: site.id,
		date: Date.now(),
		name: `${ site.name } (eval mock preview)`,
	};
}

/**
 * The host with every operation that changes a WordPress.com site (push,
 * pull, preview create, update and delete) recorded in `calls` and answered
 * with a fixture, so an automatic run never reaches a remote site. Everything
 * local stays the real host's.
 */
export function withMockedRemote( host: StudioAgentHost, calls: RemoteCall[] ): StudioAgentHost {
	return {
		...host,
		previews: {
			...host.previews,
			create: async ( site ) => {
				calls.push( { operation: 'preview-create', site: site.name } );
				return mockPreview( site );
			},
			update: async ( site, hostname ) => {
				calls.push( { operation: 'preview-update', site: site.name, target: hostname } );
				return mockPreview( site, hostname );
			},
			delete: async ( hostname ) => {
				calls.push( { operation: 'preview-delete', target: hostname } );
			},
		},
		sync: {
			push: async ( site, options, remoteSite ) => {
				calls.push( { operation: 'push', site: site.name, target: remoteSite, options } );
				return mockRemoteSite( site, remoteSite );
			},
			pull: async ( site, options, remoteSite ) => {
				calls.push( { operation: 'pull', site: site.name, target: remoteSite, options } );
				return mockRemoteSite( site, remoteSite );
			},
		},
	};
}

/**
 * `wpcom_request` with every method but GET answered by a fixture and recorded
 * in `calls`, as the mocked host does for pushes and previews: a write the
 * agent asks for never leaves the process. Reads stay the real tool's. The
 * returned function puts the real tool back.
 */
export function withMockedWpcomRequest( calls: RemoteCall[] ): () => void {
	const original = wpcomRequestTool.handler;
	wpcomRequestTool.handler = async ( args, context ) => {
		if ( args.method === 'GET' ) {
			return original.call( wpcomRequestTool, args, context );
		}
		calls.push( {
			operation: 'wpcom-request',
			method: args.method,
			site: String( args.siteId ),
			target: args.path,
		} );
		return textResult(
			JSON.stringify( { eval_mock: true, method: args.method, path: args.path } )
		);
	};
	return () => {
		wpcomRequestTool.handler = original;
	};
}

const WPCOM_WRITE_CODE = 'wpcom-write-under-mock';
const READ_METHODS = new Set( [ 'GET', 'HEAD' ] );
const KNOWN_METHODS = new Set( [ 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS' ] );

/** A request a guarded case tried to send to WordPress.com that could change something there. */
interface WpcomWriteAttempt {
	code: typeof WPCOM_WRITE_CODE;
	method: string;
	host: 'wpcom' | 'wpcom-ai-proxy';
	endpoint: 'images' | 'other';
	via: 'fetch' | 'http';
}

export interface WpcomWriteGuardOptions {
	/** The case is labelled as needing Studio's separate image service, which it writes to. */
	allowImageService?: boolean;
	/** The run's provider is WordPress.com, whose model requests go to the AI proxy. */
	allowProxyInference?: boolean;
}

function classifyWpcomWrite(
	hostname: string,
	pathname: string,
	rawMethod: string,
	options: WpcomWriteGuardOptions
): Omit< WpcomWriteAttempt, 'via' > | null {
	const method = rawMethod.toUpperCase();
	const host = hostname.toLowerCase();
	const wpcom =
		host === 'wordpress.com' ||
		host.endsWith( '.wordpress.com' ) ||
		host === 'wp.com' ||
		host.endsWith( '.wp.com' );
	if ( ! wpcom || READ_METHODS.has( method ) ) {
		return null;
	}
	const proxy = pathname.startsWith( '/wpcom/v2/ai-api-proxy' );
	const endpoint = proxy && pathname.includes( '/v1/images/' ) ? 'images' : 'other';
	if ( proxy && endpoint === 'images' && options.allowImageService ) {
		return null;
	}
	if ( proxy && endpoint === 'other' && options.allowProxyInference ) {
		return null;
	}
	return {
		code: WPCOM_WRITE_CODE,
		method: KNOWN_METHODS.has( method ) ? method : 'OTHER',
		host: proxy ? 'wpcom-ai-proxy' : 'wpcom',
		endpoint,
	};
}

const blockedMessage = () =>
	`${ WPCOM_WRITE_CODE }: this eval case may not change anything on WordPress.com, so the request was not sent.`;

/**
 * Options that give an `http` or `https` request a connection which fails at
 * once, before anything is written: the request is never sent anywhere.
 */
export function blockedConnectionOptions(): {
	agent: undefined;
	createConnection: () => net.Socket;
} {
	return {
		// No agent, so the request takes this connection rather than one to the host.
		agent: undefined,
		createConnection: () => {
			const socket = new net.Socket();
			// Never connected: what the request writes waits for a connection that never comes.
			( socket as { connecting: boolean } ).connecting = true;
			// After the request has attached its listeners to the socket.
			setImmediate( () => socket.destroy( new Error( blockedMessage() ) ) );
			return socket;
		},
	};
}

type RequestFunction = ( ...args: unknown[] ) => unknown;

function readHttpTarget( args: unknown[] ): { hostname: string; pathname: string; method: string } {
	const [ first, second ] = args;
	const url =
		typeof first === 'string' ? new URL( first ) : first instanceof URL ? first : undefined;
	const options = (
		url ? ( typeof second === 'object' && second !== null ? second : {} ) : first ?? {}
	) as Record< string, unknown >;
	const host = typeof options.host === 'string' ? options.host.replace( /:\d+$/, '' ) : undefined;
	const hostname = String( options.hostname ?? host ?? url?.hostname ?? '' );
	const pathname = String( options.path ?? url?.pathname ?? '/' ).split( '?' )[ 0 ];
	const method = String( options.method ?? 'GET' );
	return { hostname, pathname, method };
}

function withBlockedConnection( args: unknown[] ): unknown[] {
	const [ first, second, third ] = args;
	if ( typeof first === 'string' || first instanceof URL ) {
		const options = typeof second === 'object' && second !== null ? second : {};
		const callback = typeof second === 'function' ? second : third;
		return [ first, { ...options, ...blockedConnectionOptions() }, callback ].filter(
			( value ) => value !== undefined
		);
	}
	return [ { ...( first as object ), ...blockedConnectionOptions() }, second ].filter(
		( value ) => value !== undefined
	);
}

export interface WpcomWriteGuard {
	/** Every request it refused, in order: what a guarded case was not allowed to send. */
	attempts: WpcomWriteAttempt[];
	/** Puts the process's own `fetch` and request functions back. */
	uninstall(): void;
}

/**
 * Refuses, and records, any request this process tries to send to a
 * WordPress.com host with a method other than GET or HEAD, through `fetch` or
 * the `http` and `https` modules that `wpcom` requests go through. Reads pass.
 * The exceptions are named in `options`: Studio's image service in a case
 * labelled as needing it, and model requests to the AI proxy on a run whose
 * provider is WordPress.com.
 */
export function installWpcomWriteGuard(
	options: WpcomWriteGuardOptions = {},
	targets: {
		global: { fetch: typeof fetch };
		http: { request: RequestFunction };
		https: { request: RequestFunction };
	} = {
		global: globalThis,
		http: http as unknown as { request: RequestFunction },
		https: https as unknown as { request: RequestFunction },
	}
): WpcomWriteGuard {
	const attempts: WpcomWriteAttempt[] = [];
	const originalFetch = targets.global.fetch;
	targets.global.fetch = ( async ( input: Parameters< typeof fetch >[ 0 ], init?: RequestInit ) => {
		let url: URL | null = null;
		try {
			url = new URL(
				typeof input === 'string' || input instanceof URL ? input : ( input as Request ).url
			);
		} catch {
			url = null;
		}
		const method = init?.method ?? ( input instanceof Request ? input.method : undefined ) ?? 'GET';
		const write = url ? classifyWpcomWrite( url.hostname, url.pathname, method, options ) : null;
		if ( write ) {
			attempts.push( { ...write, via: 'fetch' } );
			throw new Error( blockedMessage() );
		}
		return originalFetch( input, init );
	} ) as typeof fetch;
	const modules = [ targets.http, targets.https ];
	const originals = modules.map( ( module ) => {
		const original = module.request;
		module.request = ( ...args: unknown[] ) => {
			const target = readHttpTarget( args );
			const write = classifyWpcomWrite( target.hostname, target.pathname, target.method, options );
			if ( ! write ) {
				return original.apply( module, args );
			}
			attempts.push( { ...write, via: 'http' } );
			return original.apply( module, withBlockedConnection( args ) );
		};
		return original;
	} );
	return {
		attempts,
		uninstall: () => {
			targets.global.fetch = originalFetch;
			modules.forEach( ( module, index ) => {
				module.request = originals[ index ];
			} );
		},
	};
}

/**
 * The folder attachment fixtures are read from: `STUDIO_EVAL_FIXTURES_DIR`,
 * else the repository's `scripts/eval/fixtures`, looked for above `from`.
 */
export function findEvalFixturesDir( from: string, env: NodeJS.ProcessEnv ): string | null {
	if ( env.STUDIO_EVAL_FIXTURES_DIR ) {
		return env.STUDIO_EVAL_FIXTURES_DIR;
	}
	let directory = path.resolve( from );
	for ( let depth = 0; depth < 8; depth++ ) {
		const candidate = path.join( directory, 'scripts', 'eval', 'fixtures' );
		if ( existsSync( candidate ) ) {
			return candidate;
		}
		const parent = path.dirname( directory );
		if ( parent === directory ) {
			break;
		}
		directory = parent;
	}
	return null;
}

const IMAGE_TYPES: Record< string, StudioChatImageMimeType > = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
};

export interface EvalAttachments {
	/** Image input on the turn they are attached to, as the composer sends them. */
	images: StudioChatImage[];
	/** Other files, by absolute path, read with the agent's file tools. */
	files: StudioChatFileAttachment[];
	/** What the first prompt gains for the files, as the CLI appends it. */
	promptBlock: string;
	summary: Array< { fixture: string; kind: 'image' | 'file' } >;
}

/** The named fixtures as the user's attachments, or the first one that is missing. */
export function loadEvalAttachments(
	fixtures: ReadonlyArray< { fixture: string } >,
	fixturesDir: string
): EvalAttachments | { missing: string } {
	const images: StudioChatImage[] = [];
	const files: StudioChatFileAttachment[] = [];
	const summary: EvalAttachments[ 'summary' ] = [];
	for ( const [ index, { fixture } ] of fixtures.entries() ) {
		const file = path.join( fixturesDir, fixture );
		if ( path.basename( fixture ) !== fixture || ! existsSync( file ) ) {
			return { missing: fixture };
		}
		const mimeType = IMAGE_TYPES[ path.extname( fixture ).toLowerCase() ];
		if ( mimeType ) {
			const bytes = readFileSync( file );
			images.push( {
				id: `eval-attachment-${ index }`,
				name: fixture,
				mimeType,
				size: bytes.length,
				dataBase64: bytes.toString( 'base64' ),
			} );
			summary.push( { fixture, kind: 'image' } );
		} else {
			files.push( {
				id: `eval-attachment-${ index }`,
				name: fixture,
				path: file,
				size: statSync( file ).size,
			} );
			summary.push( { fixture, kind: 'file' } );
		}
	}
	return { images, files, promptBlock: buildAttachedFilesPromptBlock( files ), summary };
}

type SessionMessage = Parameters< SessionManager[ 'appendMessage' ] >[ 0 ];

/**
 * Messages a conversation already holds before the case's first turn, the
 * assistant's as a reply on the run's route records it. An assistant message's
 * `contextTokens` is the context size its reply reported, which is what decides
 * whether the next turn compacts first: a fixture can reach a limit that way
 * without sending a request that size.
 */
export function evalHistoryMessages(
	history: ReadonlyArray< { role: 'user' | 'assistant'; text: string; contextTokens?: number } >,
	reply: { provider: string; api: string; model: string },
	startedAt: number = Date.now()
): SessionMessage[] {
	return history.map( ( item, index ) => {
		const content = [ { type: 'text' as const, text: item.text } ];
		const timestamp = startedAt + index;
		if ( item.role === 'user' ) {
			return { role: 'user', content, timestamp } as SessionMessage;
		}
		const tokens = item.contextTokens ?? 0;
		return {
			role: 'assistant',
			content,
			api: reply.api,
			provider: reply.provider,
			model: reply.model,
			usage: {
				input: tokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: tokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: 'stop',
			timestamp,
		} as SessionMessage;
	} );
}
