import { randomUUID } from 'crypto';
import { lstat, realpath } from 'fs/promises';
import os from 'os';
import path from 'path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk/core';
import { Value } from 'typebox/value';
import { z } from 'zod';
import { bindTool } from '../tools/define-tool';
import { runWpCliTool } from '../tools/wp-cli';
import type { StudioAgentHost } from '../host';
import type { ToolResult } from '../tools/define-tool';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';

export interface ClaudeApprovalRequest {
	runId: string;
	turnId: string;
	toolCallId: string;
	operationId: string;
	siteId: string;
	description: string;
	args: string[];
}
export interface ClaudeToolPolicy {
	runId: string;
	turnId: string;
	siteId: string;
	workingDirectory: string;
	signal: AbortSignal;
	approve: ( request: ClaudeApprovalRequest, signal: AbortSignal ) => Promise< 'allow' | 'deny' >;
	approvalTimeoutMs: number;
	stillConnected: () => Promise< boolean >;
}

function classify( args: string[] ): 'read' | 'draft' | undefined {
	if (
		args.length === 3 &&
		args[ 0 ] === 'option' &&
		args[ 1 ] === 'get' &&
		[ 'blogname', 'blogdescription', 'home', 'siteurl' ].includes( args[ 2 ] )
	)
		return 'read';
	if ( args.length === 2 && args[ 0 ] === 'post' && args[ 1 ] === 'list' ) return 'read';
	if (
		args.length === 3 &&
		args[ 0 ] === 'post' &&
		args[ 1 ] === 'get' &&
		/^\d{1,10}$/.test( args[ 2 ] )
	)
		return 'read';
	if ( args[ 0 ] !== 'post' || args[ 1 ] !== 'create' || args.length < 4 || args.length > 5 )
		return;
	const options = args.slice( 2 );
	if ( new Set( options.map( ( option ) => option.split( '=', 1 )[ 0 ] ) ).size !== options.length )
		return;
	if ( ! options.includes( '--post_status=draft' ) ) return;
	if ( ! options.some( ( option ) => /^--post_title=[\s\S]{1,200}$/.test( option ) ) ) return;
	if (
		! options.every(
			( option ) =>
				option === '--post_status=draft' ||
				/^--post_title=[\s\S]{1,200}$/.test( option ) ||
				/^--post_content=[\s\S]{0,10000}$/.test( option )
		)
	)
		return;
	return 'draft';
}

async function hasWpCliOverrides( workspace: string ): Promise< boolean > {
	if (
		Object.entries( process.env ).some( ( [ name, value ] ) => /^WP_CLI_/i.test( name ) && value )
	)
		return true;

	const candidates = new Set( [ path.join( os.homedir(), '.wp-cli', 'config.yml' ) ] );
	if ( process.env.HOME && path.isAbsolute( process.env.HOME ) ) {
		candidates.add( path.join( process.env.HOME, '.wp-cli', 'config.yml' ) );
	}
	for ( let directory = workspace; ; directory = path.dirname( directory ) ) {
		candidates.add( path.join( directory, 'wp-cli.local.yml' ) );
		candidates.add( path.join( directory, 'wp-cli.yml' ) );
		if ( path.dirname( directory ) === directory ) break;
	}
	for ( const candidate of candidates ) {
		try {
			await lstat( candidate );
			return true;
		} catch ( error ) {
			if ( ( error as NodeJS.ErrnoException ).code !== 'ENOENT' ) return true;
		}
	}
	return false;
}

async function approval(
	policy: ClaudeToolPolicy,
	request: ClaudeApprovalRequest
): Promise< boolean > {
	if ( policy.signal.aborted ) return false;
	const controller = new AbortController();
	const cancel = () => controller.abort();
	policy.signal.addEventListener( 'abort', cancel, { once: true } );
	let timer: ReturnType< typeof setTimeout > | undefined;
	try {
		const denied = new Promise< 'deny' >( ( resolve ) => {
			controller.signal.addEventListener( 'abort', () => resolve( 'deny' ), { once: true } );
			timer = setTimeout( () => controller.abort(), Math.max( 1, policy.approvalTimeoutMs ) );
		} );
		const result = await Promise.race( [
			policy.approve( request, controller.signal ).catch( () => 'deny' as const ),
			denied,
		] );
		return result === 'allow' && ! controller.signal.aborted && ! policy.signal.aborted;
	} finally {
		if ( timer ) clearTimeout( timer );
		policy.signal.removeEventListener( 'abort', cancel );
		controller.abort();
	}
}

export function createStudioClaudeMcpServer(
	invoke: ( args: unknown ) => Promise< { content: ToolResult[ 'content' ]; isError: boolean } >
) {
	const schema = z.fromJSONSchema(
		runWpCliTool.parameters as unknown as Parameters< typeof z.fromJSONSchema >[ 0 ]
	);
	if ( ! ( schema instanceof z.ZodObject ) ) throw new Error( 'Unsupported tool schema' );
	return createSdkMcpServer( {
		name: 'studio',
		tools: [
			tool(
				runWpCliTool.name,
				'Read the current local WordPress site or request approval to create a draft post.',
				schema.shape,
				invoke
			),
		],
	} );
}

export function createStudioClaudeToolBridge(
	host: StudioAgentHost,
	policy: ClaudeToolPolicy,
	onEvent: ( event: BackendTurnEvent ) => void
) {
	let disposed = false;
	async function invoke( name: string, args: unknown ) {
		const toolCallId = randomUUID();
		onEvent( {
			type: 'tool.started',
			runId: policy.runId,
			turnId: policy.turnId,
			toolCallId,
			name,
		} );
		const fail = () => {
			onEvent( {
				type: 'tool.result',
				runId: policy.runId,
				turnId: policy.turnId,
				toolCallId,
				isError: true,
			} );
			return {
				isError: true as const,
				content: [ { type: 'text' as const, text: 'Studio operation denied or failed.' } ],
			};
		};
		if (
			disposed ||
			policy.signal.aborted ||
			name !== runWpCliTool.name ||
			! Value.Check( runWpCliTool.parameters, args )
		)
			return fail();
		try {
			const guardedHost: StudioAgentHost = {
				...host,
				sites: {
					...host.sites,
					wpCli: async ( site, wpArgs ) => {
						const kind = classify( wpArgs );
						if (
							! kind ||
							site.id !== policy.siteId ||
							( await realpath( site.path ) ) !== policy.workingDirectory ||
							policy.signal.aborted ||
							disposed
						)
							throw new Error( 'Denied' );
						if ( kind === 'draft' ) {
							const request = {
								runId: policy.runId,
								turnId: policy.turnId,
								toolCallId,
								operationId: randomUUID(),
								siteId: policy.siteId,
								description: 'Create a draft post on the current local site',
								args: [ ...wpArgs ],
							};
							onEvent( {
								type: 'approval.requested',
								runId: policy.runId,
								turnId: policy.turnId,
								toolCallId,
								requestId: request.operationId,
								description: request.description,
							} );
							if ( ! ( await approval( policy, request ) ) ) throw new Error( 'Denied' );
						}
						const current = await host.sites.resolve( site.path );
						if (
							disposed ||
							policy.signal.aborted ||
							! ( await policy.stillConnected() ) ||
							current.id !== policy.siteId ||
							( await realpath( current.path ) ) !== policy.workingDirectory ||
							( await hasWpCliOverrides( policy.workingDirectory ) )
						)
							throw new Error( 'Denied' );
						if ( disposed || policy.signal.aborted ) throw new Error( 'Denied' );
						return host.sites.wpCli( current, [
							...wpArgs,
							'--skip-packages',
							'--skip-plugins',
							'--skip-themes',
						] );
					},
				},
			};
			const bound = bindTool( runWpCliTool, guardedHost );
			const result = await bound.rawHandler( args, {
				onProgress: ( message, update ) =>
					onEvent( {
						type: 'tool.progress',
						runId: policy.runId,
						turnId: policy.turnId,
						toolCallId,
						message,
						update,
					} ),
			} );
			const pending = await result.pending;
			onEvent( {
				type: 'tool.result',
				runId: policy.runId,
				turnId: policy.turnId,
				toolCallId,
				isError: false,
			} );
			return {
				isError: false as const,
				content: pending
					? [ ...result.content, { type: 'text' as const, text: pending } ]
					: result.content,
			};
		} catch {
			return fail();
		}
	}
	const server = createStudioClaudeMcpServer( ( args ) => invoke( runWpCliTool.name, args ) );
	return {
		server,
		invoke,
		async dispose() {
			disposed = true;
			await server.instance.close();
		},
	};
}
