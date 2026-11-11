/**
 * What an eval case can set up around its turns: remote operations replaced
 * by fixtures, files the user attached, and history the conversation already
 * has. Development only, for the eval runner.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
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
	operation: 'push' | 'pull' | 'preview-create' | 'preview-update' | 'preview-delete';
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
