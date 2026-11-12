import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { mkdtemp, realpath, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { prepareProcessOwner } from '@studio/common/lib/owned-process';
import {
	enoent,
	errno,
	exitChild,
	fakeChild,
	fakeSpawn,
	keeperAnswering,
	linuxSeams,
	WINDOWS_START,
	windowsSeams,
	type FakeChild,
} from '@studio/common/lib/tests/fixtures/owned-process-seams';
import { describe, expect, it, vi } from 'vitest';
import { discoverClaudeModels, qualifyClaudeStartup } from '../runtime';
import type { OwnershipFailure, ProcessOwner } from '@studio/common/lib/owned-process';

const fakeIdentity = {
	path: 'fake',
	size: 0,
	device: '0',
	inode: '0',
	modified: '0',
	changed: '0',
	sha256: '',
};

// A native executable on disk, so the identity check before every spawn holds.
async function nativeExecutable( directory: string ) {
	const executablePath = path.join( directory, 'claude.exe' );
	await writeFile( executablePath, 'native fixture' );
	const found = await stat( executablePath, { bigint: true } );
	return {
		executablePath,
		executableIdentity: {
			path: executablePath,
			size: Number( found.size ),
			device: found.dev.toString(),
			inode: found.ino.toString(),
			modified: found.mtimeNs.toString(),
			changed: found.ctimeNs.toString(),
			sha256: createHash( 'sha256' ).update( 'native fixture' ).digest( 'hex' ),
		},
	};
}

// Starts the native process as the SDK does when a query begins: through the spawn hook.
function launchNative( options: Record< string, unknown > ) {
	return ( options.spawnClaudeCodeProcess as ( invocation: Record< string, unknown > ) => unknown )(
		{
			command: options.pathToClaudeCodeExecutable,
			args: [],
			cwd: options.cwd,
			env: options.env,
			signal: new AbortController().signal,
		}
	);
}

// An owner whose process records what the runtime asks of it, so no real
// process or keeper starts; only the tests of the native mechanism start one.
function fakeProcessOwner(
	owned: {
		prepared?: boolean;
		ready?: boolean;
		clean?: boolean;
		failure?: OwnershipFailure;
		unidentified?: boolean;
		/** Reads the helper that guards the tree; undefined when it cannot be read. */
		guardian?: () => Promise< { pid: number; start: string } | undefined >;
		onShutdown?: () => void;
	} = {},
	order: string[] = []
) {
	const spawnOwned = vi.fn( () => {
		const child = Object.assign( new EventEmitter(), {
			pid: 4321,
			exitCode: null,
			signalCode: null,
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		} );
		return {
			child,
			ready: async () => {
				order.push( 'owned-ready' );
				return owned.ready ?? true;
			},
			failure: () => owned.failure,
			identity: () => ( owned.unidentified ? undefined : { pid: 4321, start: '1' } ),
			guardian: owned.guardian ?? ( async () => ( { pid: 4322, start: '2' } ) ),
			inspect: async () => ( { live: [], uncertain: false } ),
			requestShutdown: async () => {},
			waitForExit: async () => true,
			terminate: async () => owned.clean ?? true,
			shutdown: async () => {
				order.push( 'owned-shutdown' );
				owned.onShutdown?.();
				return owned.clean ?? true;
			},
		};
	} );
	return {
		order,
		spawnOwned,
		prepareOwner: () =>
			( {
				prepared: async () => {
					order.push( 'owner-prepared' );
					return owned.prepared ?? true;
				},
				failure: () => owned.failure,
				spawn: spawnOwned,
				dispose: async () => {
					order.push( 'owner-disposed' );
				},
			} ) as unknown as ProcessOwner,
	};
}

describe( 'Claude SDK startup (mock control responses)', () => {
	const identity = { email: 'user@example.com', subscriptionType: 'max' };
	const good = () => ( {
		initializationResult: async () => ( { hooks_applied: true, hook_on_failure_supported: true } ),
		accountInfo: async () => ( {
			email: 'user@example.com',
			subscriptionType: 'Max',
			apiProvider: 'firstParty',
		} ),
		mcpServerStatus: async () => [
			{ name: 'studio', source: 'sdk', status: 'connected', tools: [ { name: 'wp_cli' } ] },
		],
		supportedModels: async () => [
			{
				value: 'sonnet',
				resolvedModel: 'claude-xyz',
				displayName: 'Sonnet',
				supportedEffortLevels: [ 'medium' ],
			},
		],
	} );
	it( 'requires matching effective authentication, hooks, inventory and exact model effort', async () => {
		expect( ( await qualifyClaudeStartup( good(), identity, 'claude-xyz', 'medium' ) ).ok ).toBe(
			true
		);
		for ( const bad of [
			{
				...good(),
				accountInfo: async () => ( {
					email: 'other@example.com',
					subscriptionType: 'Max',
					apiProvider: 'firstParty',
				} ),
			},
			{
				...good(),
				initializationResult: async () => ( {
					hooks_applied: true,
					hook_on_failure_supported: false,
				} ),
			},
			{
				...good(),
				mcpServerStatus: async () => [ { name: 'studio', source: 'project', status: 'connected' } ],
			},
		] )
			expect( ( await qualifyClaudeStartup( bad, identity, 'claude-xyz', 'medium' ) ).ok ).toBe(
				false
			);
		expect( ( await qualifyClaudeStartup( good(), identity, 'claude-xyz', 'high' ) ).ok ).toBe(
			false
		);
	} );

	// Discovery with a native executable on disk and a fake owner; `launch` says
	// whether the SDK stand-in starts its process through the spawn hook.
	async function discover(
		owner: ReturnType< typeof fakeProcessOwner >,
		{ launch = true }: { launch?: boolean } = {}
	) {
		const directory = await realpath(
			await mkdtemp( path.join( os.tmpdir(), 'Studio Claude Discovery ' ) )
		);
		try {
			const native = await nativeExecutable( directory );
			let options: Record< string, unknown > | undefined;
			let input: Promise< IteratorResult< unknown > > | undefined;
			let closed = false;
			let inventoryRequests = 0;
			const query = ( request: {
				prompt: AsyncIterable< unknown >;
				options: Record< string, unknown >;
			} ) => {
				options = request.options;
				if ( launch ) launchNative( request.options );
				input = request.prompt[ Symbol.asyncIterator ]().next();
				return {
					...good(),
					mcpServerStatus: () =>
						inventoryRequests++ === 0 ? Promise.resolve( [] ) : good().mcpServerStatus(),
					close: () => {
						closed = true;
					},
				};
			};
			const result = await discoverClaudeModels( 'connection', '.', {
				query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
				prepareOwner: owner.prepareOwner,
				connection: async () => ( { id: 'connection', executablePath: native.executablePath } ),
				prepare: async () => ( {
					ok: true as const,
					...native,
					cwd: '.',
					configDirectory: '.',
					projectsDirectory: '.',
					env: {},
					identity,
				} ),
			} );
			return { result, options, input, closed };
		} finally {
			await rm( directory, { recursive: true, force: true, maxRetries: 4 } );
		}
	}

	it( 'discovers available models without starting a turn or sending user input', async () => {
		const owner = fakeProcessOwner();
		const { result, options, input, closed } = await discover( owner );
		expect( result ).toEqual( {
			ok: true,
			models: [ { id: 'claude-xyz', displayName: 'Sonnet', efforts: [ 'medium' ] } ],
			workingDirectory: '.',
			configDirectory: '.',
		} );
		expect( options ).toMatchObject( { persistSession: false, strictMcpConfig: true } );
		expect( options?.model ).toBeUndefined();
		expect( closed ).toBe( true );
		await expect( input ).resolves.toMatchObject( { done: true } );
		expect( owner.order ).toEqual( [ 'owner-prepared', 'owned-ready', 'owned-shutdown' ] );
	} );

	it( 'reports no models from a native process Studio does not own, as a turn would refuse it', async () => {
		const unready = fakeProcessOwner( { ready: false, failure: 'job-assignment-denied' } );
		expect( ( await discover( unready ) ).result ).toMatchObject( { ok: false } );
		const unhooked = fakeProcessOwner();
		expect( ( await discover( unhooked, { launch: false } ) ).result ).toMatchObject( {
			ok: false,
		} );
		expect( unhooked.spawnOwned ).not.toHaveBeenCalled();
		expect( unhooked.order ).toEqual( [ 'owner-prepared', 'owner-disposed' ] );
	} );

	it( 'refuses to spawn an executable that changed after it was prepared', async () => {
		const directory = await realpath(
			await mkdtemp( path.join( os.tmpdir(), 'Studio Claude Spawn ' ) )
		);
		try {
			const executable = path.join( directory, 'claude.exe' );
			await writeFile( executable, 'prepared binary' );
			const found = await stat( executable, { bigint: true } );
			const executableIdentity = {
				path: executable,
				size: Number( found.size ),
				device: found.dev.toString(),
				inode: found.ino.toString(),
				modified: found.mtimeNs.toString(),
				changed: found.ctimeNs.toString(),
				sha256: createHash( 'sha256' ).update( 'prepared binary' ).digest( 'hex' ),
			};
			let launch: Record< string, unknown > | undefined;
			const query = ( request: { options: Record< string, unknown > } ) => {
				launch = request.options;
				return { ...good(), close: () => {} };
			};
			await discoverClaudeModels( 'connection', directory, {
				query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
				prepareOwner: fakeProcessOwner().prepareOwner,
				connection: async () => ( { id: 'connection', executablePath: executable } ),
				prepare: async () => ( {
					ok: true as const,
					executablePath: executable,
					executableIdentity,
					cwd: directory,
					configDirectory: directory,
					projectsDirectory: directory,
					env: {},
					identity,
				} ),
			} );
			await writeFile( executable, 'auto-updated binary' );
			const spawnNative = launch?.spawnClaudeCodeProcess as ( invocation: {
				command: string;
				args: string[];
				cwd: string;
				env: NodeJS.ProcessEnv;
				signal: AbortSignal;
			} ) => unknown;
			expect( () =>
				spawnNative( {
					command: executable,
					args: [],
					cwd: directory,
					env: launch?.env as NodeJS.ProcessEnv,
					signal: new AbortController().signal,
				} )
			).toThrow( 'Unexpected native process invocation' );
		} finally {
			await rm( directory, { recursive: true, force: true, maxRetries: 4 } );
		}
	} );
} );

it( 'rejects an unexpected SDK tool inventory', async () => {
	const query = {
		initializationResult: async () => ( { hooks_applied: true, hook_on_failure_supported: true } ),
		accountInfo: async () => ( {
			email: 'user@example.com',
			subscriptionType: 'Max',
			apiProvider: 'firstParty',
		} ),
		mcpServerStatus: async () => [
			{
				name: 'studio',
				source: 'sdk',
				status: 'connected',
				tools: [ { name: 'wp_cli' }, { name: 'escape' } ],
			},
		],
		supportedModels: async () => [
			{ value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: [ 'medium' ] },
		],
	};
	expect(
		(
			await qualifyClaudeStartup(
				query,
				{ email: 'user@example.com', subscriptionType: 'max' },
				'sonnet',
				'medium'
			)
		).ok
	).toBe( false );
} );

it.each( [ 'missing native reference', 'moved workspace' ] )(
	'persists recovery and keeps old history for %s',
	async ( problem ) => {
		const { runClaudeTurn } = await import( '../runtime' );
		const { createFakeHost } = await import( '../../tests/fake-host' );
		const { createNativeSessionStore } = await import( '../sessions' );
		const fs = await import( 'fs/promises' );
		const os = await import( 'os' );
		const path = await import( 'path' );
		const root = await fs.realpath(
			await fs.mkdtemp( path.join( os.tmpdir(), 'claude-recovery-' ) )
		);
		const store = createNativeSessionStore( root );
		try {
			await store.journal( 'chat', 'old-turn' ).append( {
				type: 'turn.prompt',
				runId: 'old-run',
				turnId: 'old-turn',
				text: 'Original Studio journal',
			} );
			const query = vi.fn< typeof import('@anthropic-ai/claude-agent-sdk/core').query >();
			const host = createFakeHost();
			host.sites.all = async () => [
				{ id: 'site', path: root, name: 'site', url: 'http://localhost', phpVersion: '8.4' },
			];
			const events: unknown[] = [];
			await runClaudeTurn(
				{
					backend: 'claude-code',
					runId: 'run',
					turnId: 'turn',
					selection: {
						connectionId: 'connection',
						model: { providerId: 'claude-code', modelId: 'sonnet' },
						revision: 1,
					},
					effort: 'medium',
					permissionPolicyRevision: 1,
					target: { environment: 'local' as const, siteId: 'site' },
					workspace: {
						conversationId: 'chat',
						siteId: 'site',
						workingDirectory: problem === 'moved workspace' ? path.join( root, 'moved' ) : root,
						configDirectory: root,
					},
				},
				host,
				{
					prompt: 'Do not submit',
					signal: new AbortController().signal,
					onEvent: ( event ) => events.push( event ),
				},
				{
					storeRoot: root,
					query,
					prepareOwner: fakeProcessOwner().prepareOwner,
					approve: async () => 'deny',
					verifyTarget: async () => true,
					connection: async () => ( { id: 'connection', executablePath: 'fake' } ),
					prepare: async () => ( {
						ok: true,
						executablePath: 'fake',
						executableIdentity: fakeIdentity,
						cwd: root,
						configDirectory: root,
						projectsDirectory: root,
						env: {},
						identity: {},
					} ),
				}
			);
			expect( query ).not.toHaveBeenCalled();
			expect( events ).toMatchObject( [
				{ type: 'turn.terminal', outcome: { code: 'rebind_required' } },
			] );
			expect( await store.readJournals( 'chat' ) ).toMatchObject( [
				[ { type: 'turn.prompt', text: 'Original Studio journal' } ],
				[ { type: 'turn.terminal', outcome: { code: 'rebind_required' } } ],
			] );
		} finally {
			await fs.rm( root, { recursive: true, force: true } );
		}
	}
);

it( 'resumes the exact native session after restart with the next model and effort (mock SDK)', async () => {
	const { runClaudeTurn } = await import( '../runtime' );
	const { createFakeHost } = await import( '../../tests/fake-host' );
	const { createNativeSessionStore } = await import( '../sessions' );
	const fs = await import( 'fs/promises' );
	const os = await import( 'os' );
	const path = await import( 'path' );
	const root = await fs.realpath( await fs.mkdtemp( path.join( os.tmpdir(), 'claude-restart-' ) ) );
	const storeRoot = path.join( root, 'studio' );
	const projects = path.join( root, 'projects' );
	try {
		await fs.mkdir( projects );
		const native = await nativeExecutable( root );
		const host = createFakeHost();
		host.sites.all = async () => [
			{ id: 'site', path: root, name: 'site', url: 'http://localhost', phpVersion: '8.4' },
		];
		const query = vi.fn(
			( input: { prompt: AsyncIterable< unknown >; options: Record< string, unknown > } ) => {
				const model = input.options.model;
				const sessionId = input.options.resume ?? input.options.sessionId;
				launchNative( input.options );
				return {
					initializationResult: async () => ( {
						hooks_applied: true,
						hook_on_failure_supported: true,
					} ),
					accountInfo: async () => ( {
						email: 'user@example.com',
						subscriptionType: 'max',
						apiProvider: 'firstParty',
					} ),
					mcpServerStatus: async () => [
						{ name: 'studio', source: 'sdk', status: 'connected', tools: [ { name: 'wp_cli' } ] },
					],
					supportedModels: async () => [
						{ value: 'model-a', displayName: 'Model A', supportedEffortLevels: [ 'medium' ] },
						{ value: 'model-b', displayName: 'Model B', supportedEffortLevels: [ 'high' ] },
					],
					close: () => {},
					async *[ Symbol.asyncIterator ]() {
						for await ( const prompt of input.prompt ) {
							expect( prompt ).toMatchObject( { session_id: sessionId } );
							await fs.appendFile(
								path.join( projects, `${ sessionId }.jsonl` ),
								JSON.stringify( { sessionId, cwd: root } ) + '\n'
							);
							yield {
								type: 'system',
								subtype: 'init',
								session_id: sessionId,
								permissionMode: 'default',
								plugins: [],
								tools: [ 'Read', 'mcp__studio__wp_cli' ],
								cwd: root,
								apiKeySource: 'none',
								claude_code_version: '2.1.319',
								model,
								mcp_servers: [ { name: 'studio', status: 'connected', source: 'sdk' } ],
							};
							yield {
								type: 'result',
								subtype: 'success',
								is_error: false,
								num_turns: 1,
								session_id: sessionId,
							};
						}
					},
				};
			}
		);
		for ( const [ model, effort ] of [
			[ 'model-a', 'medium' ],
			[ 'model-b', 'high' ],
		] ) {
			const events: unknown[] = [];
			await runClaudeTurn(
				{
					backend: 'claude-code',
					runId: model,
					turnId: model,
					effort,
					permissionPolicyRevision: 1,
					target: { environment: 'local' as const, siteId: 'site' },
					selection: {
						connectionId: 'native',
						model: { providerId: 'claude-code', modelId: model },
						revision: 1,
					},
					workspace: {
						conversationId: 'chat',
						siteId: 'site',
						workingDirectory: root,
						configDirectory: root,
					},
				},
				host,
				{
					prompt: model,
					signal: new AbortController().signal,
					onEvent: ( event ) => events.push( event ),
				},
				{
					storeRoot,
					approve: async () => 'deny',
					verifyTarget: async () => true,
					query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
					prepareOwner: fakeProcessOwner().prepareOwner,
					connection: async () => ( { id: 'native', executablePath: native.executablePath } ),
					prepare: async () => ( {
						ok: true,
						...native,
						cwd: root,
						configDirectory: root,
						projectsDirectory: projects,
						env: {},
						identity: { email: 'user@example.com', subscriptionType: 'max' },
					} ),
				}
			);
			expect( events.at( -1 ) ).toMatchObject( {
				type: 'turn.terminal',
				outcome: { status: 'success' },
			} );
		}
		const ref = await createNativeSessionStore( storeRoot ).load( 'chat' );
		expect( query.mock.calls[ 0 ][ 0 ].options ).toMatchObject( {
			sessionId: ref?.nativeSessionId,
			model: 'model-a',
			effort: 'medium',
		} );
		expect( query.mock.calls[ 1 ][ 0 ].options ).toMatchObject( {
			resume: ref?.nativeSessionId,
			model: 'model-b',
			effort: 'high',
		} );
		expect( query.mock.calls[ 1 ][ 0 ].options ).not.toHaveProperty( 'sessionId' );
	} finally {
		await fs.rm( root, { recursive: true, force: true } );
	}
} );

it( 'releases no prompt and reports startup failure even if closing the SDK throws', async () => {
	const { runClaudeTurn } = await import( '../runtime' );
	const { createFakeHost } = await import( '../../tests/fake-host' );
	const fs = await import( 'fs/promises' );
	const os = await import( 'os' );
	const path = await import( 'path' );
	const storeRoot = await fs.mkdtemp( path.join( os.tmpdir(), 'claude-test-' ) );
	const native = await nativeExecutable( storeRoot );
	let promptRead = false;
	let closed = false;
	const fakeQuery = ( input: {
		prompt: AsyncIterable< unknown >;
		options: Record< string, unknown >;
	} ) => {
		launchNative( input.options );
		return {
			initializationResult: async () => ( {
				hooks_applied: false,
				hook_on_failure_supported: true,
			} ),
			accountInfo: async () => ( {
				email: 'user@example.com',
				subscriptionType: 'Max',
				apiProvider: 'firstParty',
			} ),
			mcpServerStatus: async () => [
				{ name: 'studio', source: 'sdk', status: 'connected', tools: [ { name: 'wp_cli' } ] },
			],
			supportedModels: async () => [
				{ value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: [ 'medium' ] },
			],
			close: () => {
				closed = true;
				throw new Error( 'Private details from the SDK close' );
			},
			async *[ Symbol.asyncIterator ]() {
				for await ( const message of input.prompt ) {
					promptRead = true;
					yield message;
				}
			},
		};
	};
	const snapshot = {
		backend: 'claude-code' as const,
		runId: 'run',
		turnId: 'turn',
		selection: {
			connectionId: 'native',
			model: { providerId: 'claude-code' as const, modelId: 'sonnet' },
			revision: 1,
		},
		effort: 'medium',
		permissionPolicyRevision: 1,
		target: { environment: 'local' as const, siteId: 'site' },
		workspace: {
			conversationId: 'chat',
			siteId: 'site',
			workingDirectory: process.cwd(),
			configDirectory: process.cwd(),
		},
	};
	const events: unknown[] = [];
	const host = createFakeHost();
	host.sites.all = async () => [
		{ id: 'site', path: process.cwd(), name: 'site', url: 'http://localhost', phpVersion: '8.4' },
	];
	await runClaudeTurn(
		snapshot,
		host,
		{
			prompt: 'do not send',
			signal: new AbortController().signal,
			onEvent: ( event ) => events.push( event ),
		},
		{
			query: fakeQuery as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
			prepareOwner: fakeProcessOwner().prepareOwner,
			connection: async () => ( { id: 'native', executablePath: native.executablePath } ),
			prepare: async () => ( {
				ok: true as const,
				...native,
				cwd: process.cwd(),
				configDirectory: process.cwd(),
				projectsDirectory: process.cwd(),
				env: {},
				identity: { email: 'user@example.com', subscriptionType: 'max' },
			} ),
			storeRoot,
			approve: async () => 'deny',
			verifyTarget: async () => true,
		}
	);
	expect( promptRead ).toBe( false );
	expect( closed ).toBe( true );
	await fs.rm( storeRoot, { recursive: true, force: true } );
	expect( events ).toMatchObject( [ { type: 'turn.terminal', outcome: { status: 'error' } } ] );
} );

it.each( [ 'unexpected-model', 'eof', 'process-failure' ] )(
	'fails closed after verified startup on %s (mock SDK)',
	async ( failure ) => {
		const fs = await import( 'fs/promises' );
		const os = await import( 'os' );
		const path = await import( 'path' );
		const root = await fs.realpath(
			await fs.mkdtemp( path.join( os.tmpdir(), 'claude-runtime-' ) )
		);
		try {
			const { runClaudeTurn } = await import( '../runtime' );
			const { createFakeHost } = await import( '../../tests/fake-host' );
			const { createNativeSessionStore } = await import( '../sessions' );
			const host = createFakeHost();
			host.sites.all = async () => [
				{ id: 'site', path: root, name: 'site', url: 'http://localhost', phpVersion: '8.4' },
			];
			const snapshot = {
				backend: 'claude-code' as const,
				runId: 'run',
				turnId: 'turn',
				selection: {
					connectionId: 'native',
					model: { providerId: 'claude-code' as const, modelId: 'sonnet' },
					revision: 1,
				},
				effort: 'medium',
				permissionPolicyRevision: 1,
				target: { environment: 'local' as const, siteId: 'site' },
				workspace: {
					conversationId: 'chat',
					siteId: 'site',
					workingDirectory: root,
					configDirectory: root,
				},
			};
			const native = await nativeExecutable( root );
			let emittedPrompt = false;
			let seenInput: unknown;
			let seenOptions: Record< string, unknown > = {};
			const fakeQuery = ( input: {
				prompt: AsyncIterable< unknown >;
				options: Record< string, unknown >;
			} ) => {
				seenOptions = input.options;
				launchNative( input.options );
				return {
					initializationResult: async () => ( {
						hooks_applied: true,
						hook_on_failure_supported: true,
					} ),
					accountInfo: async () => ( {
						email: 'user@example.com',
						subscriptionType: 'Max',
						apiProvider: 'firstParty',
					} ),
					mcpServerStatus: async () => [
						{ name: 'studio', source: 'sdk', status: 'connected', tools: [ { name: 'wp_cli' } ] },
					],
					supportedModels: async () => [
						{ value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: [ 'medium' ] },
					],
					close: () => {},
					async *[ Symbol.asyncIterator ]() {
						for await ( const message of input.prompt ) {
							emittedPrompt = true;
							seenInput = message;
							yield {
								type: 'system',
								subtype: 'init',
								session_id: input.options.sessionId,
								permissionMode: 'default',
								plugins: [],
								tools: [ 'Read', 'mcp__studio__wp_cli' ],
								cwd: root,
								apiKeySource: 'none',
								claude_code_version: '2.1.319',
								model: 'sonnet',
								mcp_servers: [ { name: 'studio', status: 'connected', source: 'sdk' } ],
							};
							if ( failure === 'eof' ) return;
							if ( failure === 'process-failure' )
								throw new Error( 'Private native process failure' );
							yield {
								type: 'assistant',
								session_id: input.options.sessionId,
								uuid: 'unexpected',
								message: {
									id: 'msg',
									model: 'other',
									content: [ { type: 'text', text: 'unsafe' } ],
								},
							};
							yield {
								type: 'result',
								subtype: 'success',
								is_error: false,
								num_turns: 1,
								session_id: input.options.sessionId,
							};
						}
					},
				};
			};
			const events: unknown[] = [];
			await runClaudeTurn(
				snapshot,
				host,
				{
					prompt: 'hello',
					images: [
						{
							id: 'image',
							name: 'sample.png',
							mimeType: 'image/png',
							dataBase64: 'iVBORw0KGgo=',
							size: 8,
						},
					],
					signal: new AbortController().signal,
					onEvent: ( event ) => events.push( event ),
				},
				{
					query: fakeQuery as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
					prepareOwner: fakeProcessOwner().prepareOwner,
					connection: async () => ( { id: 'native', executablePath: native.executablePath } ),
					prepare: async () => ( {
						ok: true as const,
						...native,
						cwd: root,
						configDirectory: root,
						projectsDirectory: path.join( root, 'projects' ),
						env: {},
						identity: { email: 'user@example.com', subscriptionType: 'max' },
					} ),
					storeRoot: path.join( root, 'store' ),
					approve: async () => 'deny',
					verifyTarget: async () => true,
				}
			);
			expect( emittedPrompt ).toBe( true );
			expect( seenInput ).toMatchObject( {
				message: {
					content: [
						{ type: 'text', text: 'hello' },
						{
							type: 'image',
							source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
						},
					],
				},
			} );
			expect( seenOptions ).toMatchObject( {
				pathToClaudeCodeExecutable: native.executablePath,
				cwd: root,
				model: 'sonnet',
				effort: 'medium',
				tools: [ 'Read' ],
				permissionMode: 'default',
				settingSources: [],
			} );
			const saved = await createNativeSessionStore( path.join( root, 'store' ) ).load( 'chat' );
			expect( saved?.nativeSessionId ).toBe( seenOptions.sessionId );
			const status = failure === 'eof' ? 'unknown_process_exit' : 'error';
			expect(
				await createNativeSessionStore( path.join( root, 'store' ) )
					.journal( 'chat', 'turn' )
					.read()
			).toMatchObject( [
				{ type: 'turn.prompt', text: 'hello' },
				{ type: 'turn.terminal', outcome: { status } },
			] );
			expect( events ).toMatchObject( [
				{ type: 'turn.prompt', text: 'hello' },
				{ type: 'turn.terminal', outcome: { status } },
			] );
		} finally {
			await fs.rm( root, { recursive: true, force: true } );
		}
	}
);

it( 'denies native tools until system init has been verified (mock SDK)', async () => {
	const fs = await import( 'fs/promises' );
	const os = await import( 'os' );
	const path = await import( 'path' );
	const root = await fs.realpath( await fs.mkdtemp( path.join( os.tmpdir(), 'claude-init-' ) ) );
	try {
		const { runClaudeTurn } = await import( '../runtime' );
		const { createFakeHost } = await import( '../../tests/fake-host' );
		const host = createFakeHost();
		host.sites.all = async () => [
			{ id: 'site', path: root, name: 'site', url: 'http://localhost', phpVersion: '8.4' },
		];
		const snapshot = {
			backend: 'claude-code' as const,
			runId: 'run',
			turnId: 'turn',
			selection: {
				connectionId: 'native',
				model: { providerId: 'claude-code' as const, modelId: 'sonnet' },
				revision: 1,
			},
			effort: 'medium',
			permissionPolicyRevision: 1,
			target: { environment: 'local' as const, siteId: 'site' },
			workspace: {
				conversationId: 'chat',
				siteId: 'site',
				workingDirectory: root,
				configDirectory: root,
			},
		};
		const native = await nativeExecutable( root );
		let before: unknown;
		const fakeQuery = ( input: {
			prompt: AsyncIterable< unknown >;
			options: {
				hooks: {
					PreToolUse: Array< { hooks: Array< ( input: unknown ) => Promise< unknown > > } >;
				};
				sessionId: string;
			};
		} ) => {
			launchNative( input.options );
			return {
				initializationResult: async () => ( {
					hooks_applied: true,
					hook_on_failure_supported: true,
				} ),
				accountInfo: async () => ( {
					email: 'user@example.com',
					subscriptionType: 'Max',
					apiProvider: 'firstParty',
				} ),
				mcpServerStatus: async () => [
					{ name: 'studio', source: 'sdk', status: 'connected', tools: [ { name: 'wp_cli' } ] },
				],
				supportedModels: async () => [
					{ value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: [ 'medium' ] },
				],
				close: () => {},
				async *[ Symbol.asyncIterator ]() {
					for await ( const _message of input.prompt ) {
						before = await input.options.hooks.PreToolUse[ 0 ].hooks[ 0 ]( {
							hook_event_name: 'PreToolUse',
							tool_name: 'mcp__studio__wp_cli',
							mcp_server: { name: 'studio', source: 'sdk' },
						} );
						yield {
							type: 'result',
							subtype: 'success',
							is_error: false,
							session_id: input.options.sessionId,
						};
					}
				},
			};
		};
		await runClaudeTurn(
			snapshot,
			host,
			{ prompt: 'hello', signal: new AbortController().signal, onEvent: () => {} },
			{
				query: fakeQuery as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
				prepareOwner: fakeProcessOwner().prepareOwner,
				connection: async () => ( { id: 'native', executablePath: native.executablePath } ),
				prepare: async () => ( {
					ok: true as const,
					...native,
					cwd: root,
					configDirectory: root,
					projectsDirectory: path.join( root, 'projects' ),
					env: {},
					identity: { email: 'user@example.com', subscriptionType: 'max' },
				} ),
				storeRoot: path.join( root, 'store' ),
				approve: async () => 'deny',
				verifyTarget: async () => true,
			}
		);
		expect( before ).toMatchObject( { hookSpecificOutput: { permissionDecision: 'deny' } } );
	} finally {
		await fs.rm( root, { recursive: true, force: true } );
	}
} );

it( 'qualifies only the known built-in privacy plugin and rejects unqualified plugins', async () => {
	const { isQualifiedClaudePlugins } = await import( '../runtime' );
	expect( isQualifiedClaudePlugins( [ { name: 'cc-plugin-privacy', path: 'builtin' } ] ) ).toBe(
		true
	);
	expect(
		isQualifiedClaudePlugins( [ { name: 'cc-plugin-privacy', path: 'C:\\untrusted' } ] )
	).toBe( false );
	expect(
		isQualifiedClaudePlugins( [
			{ name: 'cc-plugin-privacy', path: 'builtin' },
			{ name: 'unknown', path: 'builtin' },
		] )
	).toBe( false );
} );

it( 'blocks native reads of credential-bearing files and the native config tree', async () => {
	const fs = await import( 'fs/promises' );
	const os = await import( 'os' );
	const path = await import( 'path' );
	const root = await fs.realpath( await fs.mkdtemp( path.join( os.tmpdir(), 'claude-read-' ) ) );
	try {
		const config = path.join( root, 'config' );
		await fs.mkdir( config );
		for ( const file of [
			'safe.txt',
			'.env',
			'wp-config.php',
			'.credentials.json',
			'config/state.json',
		] )
			await fs.writeFile( path.join( root, file ), 'fixture' );
		const { isAllowedNativePath } = await import( '../execution-rules' );
		expect( await isAllowedNativePath( path.join( root, 'safe.txt' ), [ root ], config ) ).toBe(
			true
		);
		for ( const file of [ '.env', 'wp-config.php', '.credentials.json', 'config/state.json' ] )
			expect( await isAllowedNativePath( path.join( root, file ), [ root ], config ) ).toBe(
				false
			);
	} finally {
		await fs.rm( root, { recursive: true, force: true } );
	}
} );

it( 'waits for the exact SDK server to finish connecting before qualification', async () => {
	let calls = 0;
	const query = {
		initializationResult: async () => ( { hooks_applied: true, hook_on_failure_supported: true } ),
		accountInfo: async () => ( {
			email: 'user@example.com',
			subscriptionType: 'Max',
			apiProvider: 'firstParty',
		} ),
		mcpServerStatus: async () =>
			++calls === 1
				? [ { name: 'studio', source: 'sdk', status: 'pending' } ]
				: [ { name: 'studio', source: 'sdk', status: 'connected', tools: [ { name: 'wp_cli' } ] } ],
		supportedModels: async () => [
			{ value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: [ 'medium' ] },
		],
	};
	expect(
		(
			await qualifyClaudeStartup(
				query,
				{ email: 'user@example.com', subscriptionType: 'max' },
				'sonnet',
				'medium'
			)
		).ok
	).toBe( true );
	expect( calls ).toBe( 2 );
} );

it( 'rejects any SDK spawn command, cwd or environment that changes the qualified invocation', async () => {
	const { isQualifiedClaudeSpawn } = await import( '../runtime' );
	const expected = {
		command: 'C:\\Claude\\claude.exe',
		cwd: 'C:\\Site',
		env: { PATH: 'path', CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1' },
	};
	const valid = {
		...expected,
		args: [],
		env: {
			...expected.env,
			CLAUDE_AGENT_SDK_VERSION: 'test',
			CLAUDE_CODE_ENTRYPOINT: 'sdk',
			CLAUDE_CODE_SDK_READS_SESSION_STATE: '1',
		},
	};
	expect( isQualifiedClaudeSpawn( valid, expected ) ).toBe( true );
	expect( isQualifiedClaudeSpawn( { ...valid, command: 'C:\\other.exe' }, expected ) ).toBe(
		false
	);
	expect( isQualifiedClaudeSpawn( { ...valid, cwd: 'C:\\other' }, expected ) ).toBe( false );
	expect(
		isQualifiedClaudeSpawn(
			{ ...valid, env: { ...valid.env, ANTHROPIC_API_KEY: 'secret' } },
			expected
		)
	).toBe( false );
	expect(
		isQualifiedClaudeSpawn( { ...valid, env: { ...valid.env, PATH: 'other' } }, expected )
	).toBe( false );
} );

it( 'deduplicates discovered model aliases by canonical ID without inventing effort levels', async () => {
	const q = {
		initializationResult: async () => ( { hooks_applied: true, hook_on_failure_supported: true } ),
		accountInfo: async () => ( {
			email: 'user@example.com',
			subscriptionType: 'Max',
			apiProvider: 'firstParty',
		} ),
		mcpServerStatus: async () => [
			{ name: 'studio', source: 'sdk', status: 'connected', tools: [ { name: 'wp_cli' } ] },
		],
		supportedModels: async () => [
			{
				value: 'sonnet',
				resolvedModel: 'canonical',
				displayName: 'Sonnet',
				supportedEffortLevels: [ 'medium', 'high' ],
			},
			{
				value: 'alias',
				resolvedModel: 'canonical',
				displayName: 'Sonnet',
				supportedEffortLevels: [ 'medium' ],
			},
		],
	};
	const result = await qualifyClaudeStartup(
		q,
		{ email: 'user@example.com', subscriptionType: 'max' },
		'canonical',
		'medium'
	);
	expect( result.ok && result.models ).toEqual( [
		{ id: 'canonical', displayName: 'Sonnet', efforts: [ 'medium' ] },
	] );
} );

// A mock SDK that starts its process through the spawn hook, then runs `onTurn`
// after init, then gives `answer`: by default a successful result.
function fakeNativeTurn(
	cwd: string,
	{
		onTurn = async () => {},
		account = () => ( {
			email: 'user@example.com',
			subscriptionType: 'max',
			apiProvider: 'firstParty',
		} ),
		projects,
		answer = ( sessionId ) => [
			{
				type: 'result',
				subtype: 'success',
				is_error: false,
				num_turns: 1,
				session_id: sessionId,
			},
		],
	}: {
		onTurn?: ( options: Record< string, unknown > ) => Promise< void >;
		account?: () => Record< string, string >;
		projects?: string;
		answer?: ( sessionId: unknown ) => Array< Record< string, unknown > >;
	} = {}
) {
	return vi.fn(
		( input: { prompt: AsyncIterable< unknown >; options: Record< string, unknown > } ) => {
			launchNative( input.options );
			return {
				initializationResult: async () => ( {
					hooks_applied: true,
					hook_on_failure_supported: true,
				} ),
				accountInfo: async () => account(),
				mcpServerStatus: async () => [
					{ name: 'studio', source: 'sdk', status: 'connected', tools: [ { name: 'wp_cli' } ] },
				],
				supportedModels: async () => [
					{ value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: [ 'medium' ] },
				],
				close: () => {},
				async *[ Symbol.asyncIterator ]() {
					const sessionId = input.options.resume ?? input.options.sessionId;
					for await ( const _prompt of input.prompt ) {
						if ( projects ) {
							const { appendFile } = await import( 'fs/promises' );
							const { join } = await import( 'path' );
							await appendFile(
								join( projects, `${ sessionId }.jsonl` ),
								JSON.stringify( { sessionId, cwd } ) + '\n'
							);
						}
						yield {
							type: 'system',
							subtype: 'init',
							session_id: sessionId,
							permissionMode: 'default',
							plugins: [],
							tools: [ 'Read', 'mcp__studio__wp_cli' ],
							cwd,
							apiKeySource: 'none',
							claude_code_version: '2.1.319',
							model: 'sonnet',
							mcp_servers: [ { name: 'studio', status: 'connected', source: 'sdk' } ],
						};
						await onTurn( input.options );
						yield* answer( sessionId );
					}
				},
			};
		}
	);
}

it( 'runs a global conversation only in the dedicated global workspace (mock SDK)', async () => {
	const { runClaudeTurn } = await import( '../runtime' );
	const { createFakeHost } = await import( '../../tests/fake-host' );
	const { getClaudeGlobalWorkspace } = await import( '../sessions' );
	const fs = await import( 'fs/promises' );
	const os = await import( 'os' );
	const path = await import( 'path' );
	const root = await fs.realpath( await fs.mkdtemp( path.join( os.tmpdir(), 'claude-global-' ) ) );
	try {
		const storeRoot = path.join( root, 'store' );
		await fs.mkdir( getClaudeGlobalWorkspace( storeRoot ), { recursive: true } );
		const workspace = await fs.realpath( getClaudeGlobalWorkspace( storeRoot ) );
		const elsewhere = path.join( root, 'elsewhere' );
		await fs.mkdir( elsewhere );
		const host = createFakeHost();
		host.sites.all = async () => [];
		const native = await nativeExecutable( root );
		const query = fakeNativeTurn( workspace );
		const run = async ( conversationId: string, workingDirectory: string ) => {
			const events: Array< { type: string; outcome?: unknown } > = [];
			await runClaudeTurn(
				{
					backend: 'claude-code',
					runId: conversationId,
					turnId: conversationId,
					effort: 'medium',
					permissionPolicyRevision: 1,
					selection: {
						connectionId: 'native',
						model: { providerId: 'claude-code', modelId: 'sonnet' },
						revision: 1,
					},
					workspace: { conversationId, siteId: null, workingDirectory, configDirectory: root },
					target: { environment: 'global' },
				},
				host,
				{
					prompt: 'hello',
					signal: new AbortController().signal,
					onEvent: ( event ) => events.push( event ),
				},
				{
					storeRoot,
					approve: async () => 'deny',
					verifyTarget: async () => true,
					query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
					prepareOwner: fakeProcessOwner().prepareOwner,
					connection: async () => ( { id: 'native', executablePath: native.executablePath } ),
					prepare: async () => ( {
						ok: true,
						...native,
						cwd: workingDirectory,
						configDirectory: root,
						projectsDirectory: path.join( root, 'projects' ),
						env: {},
						identity: { email: 'user@example.com', subscriptionType: 'max' },
					} ),
				}
			);
			return events;
		};
		expect( ( await run( 'global', workspace ) ).at( -1 ) ).toMatchObject( {
			type: 'turn.terminal',
			outcome: { status: 'success' },
		} );
		expect( query.mock.calls[ 0 ][ 0 ].options ).toMatchObject( { cwd: workspace } );
		expect( await run( 'moved', elsewhere ) ).toMatchObject( [
			{ type: 'turn.terminal', outcome: { code: 'rebind_required' } },
		] );
		expect( query ).toHaveBeenCalledOnce();
	} finally {
		await fs.rm( root, { recursive: true, force: true } );
	}
} );

it( 'routes the SDK hook and native permission request through the execution policy (mock SDK)', async () => {
	const { runClaudeTurn } = await import( '../runtime' );
	const { createFakeHost } = await import( '../../tests/fake-host' );
	const fs = await import( 'fs/promises' );
	const os = await import( 'os' );
	const path = await import( 'path' );
	const root = await fs.realpath( await fs.mkdtemp( path.join( os.tmpdir(), 'claude-policy-' ) ) );
	try {
		const site = path.join( root, 'site' );
		const config = path.join( root, 'config' );
		await fs.mkdir( site );
		await fs.mkdir( config );
		await fs.writeFile( path.join( site, 'readme.txt' ), 'fixture' );
		const host = createFakeHost();
		host.sites.all = async () => [
			{ id: 'site', path: site, name: 'site', url: 'http://localhost', phpVersion: '8.4' },
		];
		let targetUnchanged = true;
		const decisions: unknown[] = [];
		const readme = { file_path: path.join( site, 'readme.txt' ) };
		type Hook = ( input: unknown ) => Promise< { hookSpecificOutput: unknown } >;
		type Permission = (
			name: string,
			input: Record< string, unknown >,
			options: Record< string, unknown >
		) => Promise< { behavior: string } >;
		const native = await nativeExecutable( config );
		const query = fakeNativeTurn( site, {
			onTurn: async ( options ) => {
				const hooks = options.hooks as { PreToolUse: Array< { hooks: Hook[] } > };
				const hook = ( toolName: string, toolInput: unknown ) =>
					hooks.PreToolUse[ 0 ].hooks[ 0 ]( {
						hook_event_name: 'PreToolUse',
						tool_name: toolName,
						tool_input: toolInput,
						tool_use_id: toolName,
					} );
				const permission = options.canUseTool as Permission;
				const signal = new AbortController().signal;
				decisions.push( ( await hook( 'Read', readme ) ).hookSpecificOutput );
				decisions.push( ( await permission( 'Read', readme, { signal } ) ).behavior );
				decisions.push(
					( await hook( 'Write', { ...readme, content: 'changed' } ) ).hookSpecificOutput
				);
				decisions.push(
					(
						await permission(
							'mcp__studio__wp_cli',
							{},
							{
								signal,
								mcpServer: { name: 'studio', source: 'project' },
							}
						)
					).behavior
				);
				targetUnchanged = false;
				decisions.push( ( await hook( 'Read', readme ) ).hookSpecificOutput );
			},
		} );
		await runClaudeTurn(
			{
				backend: 'claude-code',
				runId: 'run',
				turnId: 'turn',
				effort: 'medium',
				permissionPolicyRevision: 1,
				selection: {
					connectionId: 'native',
					model: { providerId: 'claude-code', modelId: 'sonnet' },
					revision: 1,
				},
				workspace: {
					conversationId: 'chat',
					siteId: 'site',
					workingDirectory: site,
					configDirectory: config,
				},
				target: { environment: 'local', siteId: 'site' },
			},
			host,
			{ prompt: 'hello', signal: new AbortController().signal, onEvent: () => {} },
			{
				storeRoot: path.join( root, 'store' ),
				approve: async () => 'deny',
				verifyTarget: async () => targetUnchanged,
				query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
				prepareOwner: fakeProcessOwner().prepareOwner,
				connection: async () => ( { id: 'native', executablePath: native.executablePath } ),
				prepare: async () => ( {
					ok: true,
					...native,
					cwd: site,
					configDirectory: config,
					projectsDirectory: path.join( config, 'projects' ),
					env: {},
					identity: { email: 'user@example.com', subscriptionType: 'max' },
				} ),
			}
		);
		const allow = { hookEventName: 'PreToolUse', permissionDecision: 'allow' };
		const deny = { hookEventName: 'PreToolUse', permissionDecision: 'deny' };
		expect( decisions ).toEqual( [ allow, 'allow', deny, 'deny', deny ] );
	} finally {
		await fs.rm( root, { recursive: true, force: true } );
	}
} );

async function runtimeFixture( prefix: string ) {
	const { createFakeHost } = await import( '../../tests/fake-host' );
	const fs = await import( 'fs/promises' );
	const os = await import( 'os' );
	const path = await import( 'path' );
	const parent = await fs.realpath( await fs.mkdtemp( path.join( os.tmpdir(), prefix ) ) );
	const root = path.join( parent, 'site' );
	const config = path.join( parent, 'config' );
	const projects = path.join( config, 'projects' );
	await fs.mkdir( root );
	await fs.mkdir( projects, { recursive: true } );
	await fs.writeFile( path.join( root, 'readme.txt' ), 'fixture' );
	const host = createFakeHost();
	host.sites.all = async () => [
		{ id: 'site', path: root, name: 'site', url: 'http://localhost', phpVersion: '8.4' },
	];
	return {
		root,
		config,
		projects,
		host,
		storeRoot: path.join( parent, 'store' ),
		cleanup: () => fs.rm( parent, { recursive: true, force: true } ),
	};
}

function turnSnapshot( root: string, config: string, id: string, revision = 1 ) {
	return {
		backend: 'claude-code' as const,
		runId: id,
		turnId: id,
		effort: 'medium',
		permissionPolicyRevision: 1,
		selection: {
			connectionId: 'native',
			model: { providerId: 'claude-code' as const, modelId: 'sonnet' },
			revision,
		},
		workspace: {
			conversationId: 'chat',
			siteId: 'site',
			workingDirectory: root,
			configDirectory: config,
		},
		target: { environment: 'local' as const, siteId: 'site' },
	};
}

function nativeAccount( email: string ) {
	return { email, subscriptionType: 'max', apiProvider: 'firstParty' };
}

// A selected launcher that links to the binary a turn was prepared with, on a
// simulated disk, and a native executable on the real disk for the spawn
// check. The runtime reads the account with the executable it prepared;
// `simulated` checks that it did and points the read at the simulated binary.
async function preparedBinary( directory: string ) {
	const { memoryFileSystem, sha256 } = await import( './fixtures/native-binaries' );
	const path = await import( 'path' );
	const disk = memoryFileSystem( path.posix );
	const selected = '/home/tester/.local/bin/claude';
	const inspected = '/home/tester/.local/share/claude/versions/2.1.319';
	const bytes = Buffer.from( 'inspected binary' );
	disk.write( inspected, bytes );
	disk.link( selected, inspected );
	const found = await disk.files.stat( inspected );
	const executableIdentity = {
		path: inspected,
		size: found.size,
		device: found.device,
		inode: found.inode,
		modified: found.modified,
		changed: found.changed,
		sha256: sha256( bytes ),
	};
	const native = await nativeExecutable( directory );
	return {
		disk,
		selected,
		inspected,
		native,
		simulated: (
			request: import('../connection').ClaudeAccountStatusRequest
		): import('../connection').ClaudeAccountStatusRequest => {
			if (
				request.executablePath !== native.executablePath ||
				request.executableIdentity !== native.executableIdentity
			)
				throw new Error( 'The account was read with another executable than the prepared one' );
			return { ...request, executablePath: inspected, executableIdentity };
		},
	};
}

it( 'registers a PreToolUse hook that outlasts any approval and denies a cancelled hook (mock SDK)', async () => {
	const { runClaudeTurn } = await import( '../runtime' );
	const { CLAUDE_HOOK_TIMEOUT_SECONDS } = await import( '../execution-rules' );
	const path = await import( 'path' );
	const fixture = await runtimeFixture( 'claude-hook-' );
	try {
		const decisions: unknown[] = [];
		let timeout: unknown;
		const native = await nativeExecutable( fixture.config );
		const query = fakeNativeTurn( fixture.root, {
			onTurn: async ( options ) => {
				const matcher = (
					options.hooks as {
						PreToolUse: Array< {
							timeout?: number;
							hooks: Array<
								(
									input: unknown,
									id: string,
									context: { signal: AbortSignal }
								) => Promise< { hookSpecificOutput: { permissionDecision: string } } >
							>;
						} >;
					}
				 ).PreToolUse[ 0 ];
				timeout = matcher.timeout;
				const read = {
					hook_event_name: 'PreToolUse',
					tool_name: 'Read',
					tool_input: { file_path: path.join( fixture.root, 'readme.txt' ) },
					tool_use_id: 'read',
				};
				const cancelled = new AbortController();
				cancelled.abort();
				for ( const signal of [ new AbortController().signal, cancelled.signal ] )
					decisions.push(
						( await matcher.hooks[ 0 ]( read, 'read', { signal } ) ).hookSpecificOutput
							.permissionDecision
					);
			},
		} );
		await runClaudeTurn(
			turnSnapshot( fixture.root, fixture.config, 'turn' ),
			fixture.host,
			{ prompt: 'hello', signal: new AbortController().signal, onEvent: () => {} },
			{
				storeRoot: fixture.storeRoot,
				approve: async () => 'deny',
				verifyTarget: async () => true,
				query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
				prepareOwner: fakeProcessOwner().prepareOwner,
				connection: async () => ( { id: 'native', executablePath: native.executablePath } ),
				prepare: async () => ( {
					ok: true,
					...native,
					cwd: fixture.root,
					configDirectory: fixture.config,
					projectsDirectory: fixture.projects,
					env: {},
					identity: { email: 'user@example.com', subscriptionType: 'max' },
				} ),
			}
		);
		expect( timeout ).toBe( CLAUDE_HOOK_TIMEOUT_SECONDS );
		expect( decisions ).toEqual( [ 'allow', 'deny' ] );
	} finally {
		await fixture.cleanup();
	}
} );

it( 'refuses a turn sent on an earlier connection revision (mock SDK)', async () => {
	const { runClaudeTurn } = await import( '../runtime' );
	const fixture = await runtimeFixture( 'claude-revision-' );
	try {
		const query = vi.fn();
		const events: Array< { type: string; outcome?: { status: string; message?: string } } > = [];
		await runClaudeTurn(
			turnSnapshot( fixture.root, fixture.config, 'stale' ),
			fixture.host,
			{ prompt: 'hello', signal: new AbortController().signal, onEvent: ( e ) => events.push( e ) },
			{
				storeRoot: fixture.storeRoot,
				approve: async () => 'deny',
				verifyTarget: async () => true,
				query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
				connection: async () => ( { id: 'native', executablePath: 'fake', revision: 2 } ),
				prepare: async () => ( {
					ok: true,
					executablePath: 'fake',
					executableIdentity: fakeIdentity,
					cwd: fixture.root,
					configDirectory: fixture.config,
					projectsDirectory: fixture.projects,
					env: {},
					identity: { email: 'user@example.com', subscriptionType: 'max' },
				} ),
			}
		);
		expect( query ).not.toHaveBeenCalled();
		expect( events.at( -1 ) ).toMatchObject( {
			type: 'turn.terminal',
			outcome: { status: 'error', message: expect.stringContaining( 'changed' ) },
		} );
	} finally {
		await fixture.cleanup();
	}
} );

it( 'stops the turn within the recheck bound when the stored sign-in changes or cannot be read (mock SDK)', async () => {
	const { runClaudeTurn } = await import( '../runtime' );
	const { readClaudeAccountStatus } = await import( '../connection' );
	const { CLAUDE_ACCOUNT_RECHECK_MS } = await import( '../execution-rules' );
	const path = await import( 'path' );
	for ( const name of Object.keys( process.env ) )
		if ( /^(ANTHROPIC_|AWS_|GOOGLE_|AZURE_|CLAUDE_)|_PROXY$/i.test( name ) ) vi.stubEnv( name, '' );
	const fixture = await runtimeFixture( 'claude-signin-' );
	try {
		const status = ( email: string ) =>
			JSON.stringify( {
				loggedIn: true,
				authMethod: 'claude.ai',
				apiProvider: 'firstParty',
				storedClaudeAiLogin: true,
				subscriptionType: 'max',
				email,
			} );
		for ( const [ change, code ] of [
			[ status( 'someone-else@example.com' ), 'account_changed' ],
			[ 'unreadable output', 'account_unverified' ],
		] ) {
			const { disk, selected, native, simulated } = await preparedBinary( fixture.config );
			let stored = status( 'user@example.com' );
			const now = { value: 1_000 };
			const preflight = 400;
			const decisions: string[] = [];
			const query = fakeNativeTurn( fixture.root, {
				onTurn: async ( options ) => {
					const hook = (
						options.hooks as {
							PreToolUse: Array< {
								hooks: Array<
									(
										input: unknown,
										id: string,
										context: { signal: AbortSignal }
									) => Promise< { hookSpecificOutput: { permissionDecision: string } } >
								>;
							} >;
						}
					 ).PreToolUse[ 0 ].hooks[ 0 ];
					const read = async () =>
						decisions.push(
							(
								await hook(
									{
										hook_event_name: 'PreToolUse',
										tool_name: 'Read',
										tool_input: { file_path: path.join( fixture.root, 'readme.txt' ) },
										tool_use_id: 'read',
									},
									'read',
									{ signal: new AbortController().signal }
								)
							).hookSpecificOutput.permissionDecision
						);
					await read();
					stored = change;
					// The bound counts from when the preflight read started.
					now.value += CLAUDE_ACCOUNT_RECHECK_MS - 1 - preflight;
					await read();
					now.value += 1;
					await read();
				},
			} );
			const events: Array< { type: string; outcome?: unknown } > = [];
			await runClaudeTurn(
				{
					...turnSnapshot( fixture.root, fixture.config, code ),
					workspace: {
						conversationId: code,
						siteId: 'site',
						workingDirectory: fixture.root,
						configDirectory: fixture.config,
					},
				},
				fixture.host,
				{
					prompt: 'hello',
					signal: new AbortController().signal,
					onEvent: ( e ) => events.push( e ),
				},
				{
					storeRoot: fixture.storeRoot,
					approve: async () => 'deny',
					verifyTarget: async () => true,
					clock: () => now.value,
					account: ( request ) =>
						readClaudeAccountStatus( simulated( request ), {
							run: async () => ( { stdout: stored } ),
							files: disk.files,
						} ),
					query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
					prepareOwner: fakeProcessOwner().prepareOwner,
					connection: async () => ( { id: 'native', executablePath: selected } ),
					prepare: async () => {
						now.value += preflight;
						return {
							ok: true,
							...native,
							cwd: fixture.root,
							configDirectory: fixture.config,
							projectsDirectory: fixture.projects,
							env: {},
							identity: { email: 'user@example.com', subscriptionType: 'max' },
						};
					},
				}
			);
			expect( decisions, code ).toEqual( [ 'allow', 'allow', 'deny' ] );
			expect( events.at( -1 ) ).toMatchObject( {
				type: 'turn.terminal',
				outcome: { status: 'interrupted', code },
			} );
		}
	} finally {
		vi.unstubAllEnvs();
		await fixture.cleanup();
	}
} );

it( 'runs no account re-check against a binary the selected path was re-pointed or replaced to mid-turn, and stops as unverified (mock SDK)', async () => {
	const { runClaudeTurn } = await import( '../runtime' );
	const { readClaudeAccountStatus } = await import( '../connection' );
	const { CLAUDE_ACCOUNT_RECHECK_MS } = await import( '../execution-rules' );
	const { recordingRunner } = await import( './fixtures/native-binaries' );
	const path = await import( 'path' );
	for ( const name of Object.keys( process.env ) )
		if ( /^(ANTHROPIC_|AWS_|GOOGLE_|AZURE_|CLAUDE_)|_PROXY$/i.test( name ) ) vi.stubEnv( name, '' );
	const fixture = await runtimeFixture( 'claude-repointed-' );
	try {
		for ( const change of [ 're-pointed', 'replaced' ] as const ) {
			const { disk, selected, inspected, native, simulated } = await preparedBinary(
				fixture.config
			);
			const other = '/home/tester/.local/share/claude/versions/2.1.320';
			disk.write( other, Buffer.from( 'another binary' ) );
			const runner = recordingRunner( () =>
				JSON.stringify( {
					loggedIn: true,
					authMethod: 'claude.ai',
					apiProvider: 'firstParty',
					storedClaudeAiLogin: true,
					subscriptionType: 'max',
					email: 'user@example.com',
				} )
			);
			const now = { value: 1_000 };
			const decisions: string[] = [];
			const query = fakeNativeTurn( fixture.root, {
				onTurn: async ( options ) => {
					const hook = (
						options.hooks as {
							PreToolUse: Array< {
								hooks: Array<
									(
										input: unknown,
										id: string,
										context: { signal: AbortSignal }
									) => Promise< { hookSpecificOutput: { permissionDecision: string } } >
								>;
							} >;
						}
					 ).PreToolUse[ 0 ].hooks[ 0 ];
					const read = async () =>
						decisions.push(
							(
								await hook(
									{
										hook_event_name: 'PreToolUse',
										tool_name: 'Read',
										tool_input: { file_path: path.join( fixture.root, 'readme.txt' ) },
										tool_use_id: 'read',
									},
									'read',
									{ signal: new AbortController().signal }
								)
							).hookSpecificOutput.permissionDecision
						);
					await read();
					now.value += CLAUDE_ACCOUNT_RECHECK_MS;
					await read();
					if ( change === 're-pointed' ) disk.link( selected, other );
					else disk.write( inspected, Buffer.from( 'replaced binary' ) );
					now.value += CLAUDE_ACCOUNT_RECHECK_MS;
					await read();
				},
			} );
			const events: Array< { type: string; outcome?: unknown } > = [];
			await runClaudeTurn(
				{
					...turnSnapshot( fixture.root, fixture.config, change ),
					workspace: {
						conversationId: change,
						siteId: 'site',
						workingDirectory: fixture.root,
						configDirectory: fixture.config,
					},
				},
				fixture.host,
				{
					prompt: 'hello',
					signal: new AbortController().signal,
					onEvent: ( e ) => events.push( e ),
				},
				{
					storeRoot: fixture.storeRoot,
					approve: async () => 'deny',
					verifyTarget: async () => true,
					clock: () => now.value,
					account: ( request ) =>
						readClaudeAccountStatus( simulated( request ), { run: runner.run, files: disk.files } ),
					query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
					prepareOwner: fakeProcessOwner().prepareOwner,
					connection: async () => ( { id: 'native', executablePath: selected } ),
					prepare: async () => ( {
						ok: true,
						...native,
						cwd: fixture.root,
						configDirectory: fixture.config,
						projectsDirectory: fixture.projects,
						env: {},
						identity: { email: 'user@example.com', subscriptionType: 'max' },
					} ),
				}
			);
			expect(
				runner.calls.map( ( { file, args } ) => [ file, ...args ] ),
				change
			).toEqual( [ [ inspected, 'auth', 'status', '--json' ] ] );
			expect( decisions, change ).toEqual( [ 'allow', 'allow', 'deny' ] );
			expect( events.at( -1 ), change ).toMatchObject( {
				type: 'turn.terminal',
				outcome: { status: 'interrupted', code: 'account_unverified' },
			} );
		}
	} finally {
		vi.unstubAllEnvs();
		await fixture.cleanup();
	}
} );

it( 'keeps a conversation on the Claude account it started with, adopting it for older conversations (mock SDK)', async () => {
	const { runClaudeTurn } = await import( '../runtime' );
	const { createNativeSessionStore } = await import( '../sessions' );
	const { randomUUID } = await import( 'crypto' );
	const fixture = await runtimeFixture( 'claude-bound-' );
	try {
		const run = async ( conversationId: string, email: string ) => {
			const events: Array< { type: string; outcome?: { status: string; code?: string } } > = [];
			const native = await nativeExecutable( fixture.config );
			const query = fakeNativeTurn( fixture.root, {
				account: () => nativeAccount( email ),
				projects: fixture.projects,
			} );
			await runClaudeTurn(
				{
					...turnSnapshot( fixture.root, fixture.config, randomUUID() ),
					workspace: {
						conversationId,
						siteId: 'site',
						workingDirectory: fixture.root,
						configDirectory: fixture.config,
					},
				},
				fixture.host,
				{
					prompt: 'hello',
					signal: new AbortController().signal,
					onEvent: ( e ) => events.push( e ),
				},
				{
					storeRoot: fixture.storeRoot,
					approve: async () => 'deny',
					verifyTarget: async () => true,
					query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
					prepareOwner: fakeProcessOwner().prepareOwner,
					connection: async () => ( { id: 'native', executablePath: native.executablePath } ),
					prepare: async () => ( {
						ok: true,
						...native,
						cwd: fixture.root,
						configDirectory: fixture.config,
						projectsDirectory: fixture.projects,
						env: {},
						identity: { email, subscriptionType: 'max' },
					} ),
				}
			);
			return { outcome: events.at( -1 )?.outcome, queried: query.mock.calls.length };
		};
		expect( await run( 'chat', 'user@example.com' ) ).toMatchObject( {
			outcome: { status: 'success' },
		} );
		expect( await run( 'chat', 'user@example.com' ) ).toMatchObject( {
			outcome: { status: 'success' },
		} );
		expect( await run( 'chat', 'someone-else@example.com' ) ).toEqual( {
			outcome: expect.objectContaining( { code: 'rebind_required' } ),
			queried: 0,
		} );

		const store = createNativeSessionStore( fixture.storeRoot );
		await store.create( {
			backend: 'claude-code',
			nativeSessionId: randomUUID(),
			connectionId: 'native',
			conversationId: 'older',
			siteId: 'site',
			workingDirectory: fixture.root,
			configDirectory: fixture.config,
		} );
		const fs = await import( 'fs/promises' );
		const path = await import( 'path' );
		const older = ( await store.load( 'older' ) )!;
		await fs.writeFile(
			path.join( fixture.projects, `${ older.nativeSessionId }.jsonl` ),
			JSON.stringify( { sessionId: older.nativeSessionId, cwd: fixture.root } ) + '\n'
		);
		expect( await run( 'older', 'user@example.com' ) ).toMatchObject( {
			outcome: { status: 'success' },
		} );
		expect( ( await store.load( 'older' ) )?.accountKey ).toMatch( /^[0-9a-f]{64}$/ );
		expect( await run( 'older', 'someone-else@example.com' ) ).toEqual( {
			outcome: expect.objectContaining( { code: 'rebind_required' } ),
			queried: 0,
		} );
	} finally {
		await fixture.cleanup();
	}
} );

// A native executable on disk, so the identity check before the spawn holds,
// and an owned process that records what the runtime asks of it.
async function ownedNativeFixture(
	prefix: string,
	owned: Parameters< typeof fakeProcessOwner >[ 0 ] = {}
) {
	const fixture = await runtimeFixture( prefix );
	const native = await nativeExecutable( fixture.config );
	const owner = fakeProcessOwner( owned );
	return {
		...fixture,
		order: owner.order,
		spawnOwned: owner.spawnOwned,
		prepareOwner: owner.prepareOwner,
		connection: async () => ( { id: 'native', executablePath: native.executablePath } ),
		prepare: async () => ( {
			ok: true as const,
			...native,
			cwd: fixture.root,
			configDirectory: fixture.config,
			projectsDirectory: fixture.projects,
			env: {},
			identity: { email: 'user@example.com', subscriptionType: 'max' },
		} ),
		account: async () => ( {
			state: 'signed-in' as const,
			identity: { email: 'user@example.com', subscriptionType: 'max' },
		} ),
	};
}

// A mock SDK that launches its process the way the real one does, unless
// `launch` is false, then runs `onTurn` after init.
function spawningNativeTurn(
	cwd: string,
	onTurn: ( options: Record< string, unknown > ) => Promise< 'result' | 'end' >,
	{ launch = true }: { launch?: boolean } = {}
) {
	return vi.fn(
		( input: { prompt: AsyncIterable< unknown >; options: Record< string, unknown > } ) => {
			const options = input.options;
			if ( launch ) launchNative( options );
			return {
				initializationResult: async () => ( {
					hooks_applied: true,
					hook_on_failure_supported: true,
				} ),
				accountInfo: async () => nativeAccount( 'user@example.com' ),
				mcpServerStatus: async () => [
					{ name: 'studio', source: 'sdk', status: 'connected', tools: [ { name: 'wp_cli' } ] },
				],
				supportedModels: async () => [
					{ value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: [ 'medium' ] },
				],
				close: () => {},
				async *[ Symbol.asyncIterator ]() {
					for await ( const _prompt of input.prompt ) {
						yield {
							type: 'system',
							subtype: 'init',
							session_id: options.sessionId,
							permissionMode: 'default',
							plugins: [],
							tools: [ 'Read', 'mcp__studio__wp_cli' ],
							cwd,
							apiKeySource: 'none',
							claude_code_version: '2.1.319',
							model: 'sonnet',
							mcp_servers: [ { name: 'studio', status: 'connected', source: 'sdk' } ],
						};
						if ( ( await onTurn( options ) ) === 'result' )
							yield {
								type: 'result',
								subtype: 'success',
								is_error: false,
								num_turns: 1,
								session_id: options.sessionId,
							};
					}
				},
			};
		}
	);
}

it( 'on cancel ends the pending approval before the native process hears of it, then stops the owned tree, and runs no queued host operation (mock SDK)', async () => {
	const { runClaudeTurn } = await import( '../runtime' );
	const { createNativeSessionStore } = await import( '../sessions' );
	const { Client } = await import( '@modelcontextprotocol/sdk/client/index.js' );
	// The SDK's wildcard export resolves at runtime, although the ESLint resolver misses it.
	// eslint-disable-next-line import-x/no-unresolved
	const { InMemoryTransport } = await import( '@modelcontextprotocol/sdk/inMemory.js' );
	const fixture = await ownedNativeFixture( 'claude-cancel-' );
	try {
		const site = {
			id: 'site',
			path: fixture.root,
			name: 'site',
			url: 'http://localhost',
			phpVersion: '8.4',
		};
		vi.mocked( fixture.host.sites.resolve ).mockResolvedValue( site );
		const turn = new AbortController();
		const query = spawningNativeTurn( fixture.root, async ( options ) => {
			const stopped = new Promise< void >( ( resolve ) =>
				( options.abortController as AbortController ).signal.addEventListener(
					'abort',
					() => {
						fixture.order.push( 'native-abort' );
						resolve();
					},
					{ once: true }
				)
			);
			const [ clientTransport, serverTransport ] = InMemoryTransport.createLinkedPair();
			const client = new Client( { name: 'studio-test', version: '1.0.0' } );
			const server = (
				options.mcpServers as { studio: { instance: { connect( t: unknown ): Promise< void > } } }
			 ).studio.instance;
			await Promise.all( [ server.connect( serverTransport ), client.connect( clientTransport ) ] );
			void client
				.callTool( {
					name: 'wp_cli',
					arguments: {
						nameOrPath: 'site',
						command: 'post create --post_status=draft --post_title=Hello',
					},
				} )
				.catch( () => {} );
			await stopped;
			return 'end';
		} );
		const events: Array< { type: string; outcome?: { status: string } } > = [];
		await runClaudeTurn(
			turnSnapshot( fixture.root, fixture.config, 'turn' ),
			fixture.host,
			{ prompt: 'hello', signal: turn.signal, onEvent: ( event ) => events.push( event ) },
			{
				storeRoot: fixture.storeRoot,
				approve: ( _request, signal ) => {
					fixture.order.push( 'approval-requested' );
					signal.addEventListener( 'abort', () => fixture.order.push( 'approval-cancelled' ), {
						once: true,
					} );
					// The user stops the turn while the approval waits.
					queueMicrotask( () => turn.abort() );
					return new Promise( () => {} );
				},
				verifyTarget: async () => true,
				query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
				prepareOwner: fixture.prepareOwner,
				connection: fixture.connection,
				prepare: fixture.prepare,
				account: fixture.account,
			}
		);
		expect( fixture.order ).toEqual( [
			'owner-prepared',
			'owned-ready',
			'approval-requested',
			'approval-cancelled',
			'native-abort',
			'owned-shutdown',
		] );
		expect( fixture.host.sites.wpCli ).not.toHaveBeenCalled();
		expect( events.filter( ( event ) => event.type === 'turn.terminal' ) ).toEqual( [
			expect.objectContaining( { outcome: expect.objectContaining( { status: 'interrupted' } ) } ),
		] );
		expect( events.map( ( event ) => event.type ) ).toContain( 'approval.resolved' );
		await (
			await createNativeSessionStore( fixture.storeRoot ).lockTurn( 'chat' )
		)();
	} finally {
		await fixture.cleanup();
	}
} );

it( 'has an operation’s authorization on disk in the turn’s journal before the host runs it (mock SDK)', async () => {
	const { runClaudeTurn } = await import( '../runtime' );
	const { createNativeSessionStore } = await import( '../sessions' );
	const { Client } = await import( '@modelcontextprotocol/sdk/client/index.js' );
	// The SDK's wildcard export resolves at runtime, although the ESLint resolver misses it.
	// eslint-disable-next-line import-x/no-unresolved
	const { InMemoryTransport } = await import( '@modelcontextprotocol/sdk/inMemory.js' );
	const fixture = await ownedNativeFixture( 'claude-authorized-' );
	try {
		const site = {
			id: 'site',
			path: fixture.root,
			name: 'site',
			url: 'http://localhost',
			phpVersion: '8.4',
		};
		vi.mocked( fixture.host.sites.resolve ).mockResolvedValue( site );
		const store = createNativeSessionStore( fixture.storeRoot );
		let onDisk: unknown[] = [];
		vi.mocked( fixture.host.sites.wpCli ).mockImplementation( async () => {
			onDisk = ( await store.readJournals( 'chat' ) ).flat();
			return { exitCode: 0, stdout: '', stderr: '' };
		} );
		const query = spawningNativeTurn( fixture.root, async ( options ) => {
			const [ clientTransport, serverTransport ] = InMemoryTransport.createLinkedPair();
			const client = new Client( { name: 'studio-test', version: '1.0.0' } );
			const server = (
				options.mcpServers as { studio: { instance: { connect( t: unknown ): Promise< void > } } }
			 ).studio.instance;
			await Promise.all( [ server.connect( serverTransport ), client.connect( clientTransport ) ] );
			await client.callTool( {
				name: 'wp_cli',
				arguments: {
					nameOrPath: 'site',
					command: 'post create --post_status=draft --post_title=Hello',
				},
			} );
			return 'result';
		} );
		await runClaudeTurn(
			turnSnapshot( fixture.root, fixture.config, 'turn' ),
			fixture.host,
			{ prompt: 'hello', signal: new AbortController().signal, onEvent: () => {} },
			{
				storeRoot: fixture.storeRoot,
				approve: async () => 'allow',
				verifyTarget: async () => true,
				query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
				prepareOwner: fixture.prepareOwner,
				ownerIdentity: async () => ( { pid: 1234, start: '1' } ),
				connection: fixture.connection,
				prepare: fixture.prepare,
				account: fixture.account,
			}
		);
		expect( fixture.host.sites.wpCli ).toHaveBeenCalledOnce();
		expect( onDisk ).toContainEqual(
			expect.objectContaining( {
				type: 'operation.authorized',
				operation: expect.objectContaining( { tool: 'sites.wpCli', operationClass: 'command' } ),
				description: 'Create a draft post on the current local site',
			} )
		);
		expect(
			JSON.stringify(
				onDisk.filter( ( event ) => ( event as { type: string } ).type === 'operation.authorized' )
			)
		).not.toContain( 'Hello' );
	} finally {
		await fixture.cleanup();
	}
} );

it( 'ends a turn whose journal cannot be read with an outcome the next message can retry, sends nothing, releases the lock, and runs the next turn once the journal reads (mock SDK)', async () => {
	const { runClaudeTurn } = await import( '../runtime' );
	const { createNativeSessionStore } = await import( '../sessions' );
	const fs = await import( 'fs/promises' );
	const path = await import( 'path' );
	const fixture = await ownedNativeFixture( 'claude-journal-unreadable-' );
	try {
		const run = async ( id: string, query: ReturnType< typeof fakeNativeTurn > ) => {
			const events: Array< {
				type: string;
				outcome?: { status: string; code?: string; message?: string };
			} > = [];
			await runClaudeTurn(
				turnSnapshot( fixture.root, fixture.config, id ),
				fixture.host,
				{
					prompt: 'hello',
					signal: new AbortController().signal,
					onEvent: ( e ) => events.push( e ),
				},
				{
					storeRoot: fixture.storeRoot,
					approve: async () => 'deny',
					verifyTarget: async () => true,
					query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
					prepareOwner: fixture.prepareOwner,
					ownerIdentity: async () => ( { pid: 1234, start: id } ),
					connection: fixture.connection,
					prepare: fixture.prepare,
					account: fixture.account,
				}
			);
			return events;
		};
		// The journal's order cannot be read for a moment, as a file being replaced can be.
		const order = path.join(
			fixture.storeRoot,
			`${ createHash( 'sha256' ).update( 'chat' ).digest( 'hex' ) }.journal-order.json`
		);
		await fs.mkdir( fixture.storeRoot, { recursive: true } );
		await fs.writeFile( order, '{"version":1' );
		const unreadable = fakeNativeTurn( fixture.root, { projects: fixture.projects } );
		const events = await run( 'unreadable', unreadable );
		expect( unreadable ).not.toHaveBeenCalled();
		expect( events ).toEqual( [
			{
				type: 'turn.terminal',
				runId: 'unreadable',
				turnId: 'unreadable',
				outcome: {
					status: 'error',
					code: 'journal_unreadable',
					message: 'Studio could not read this chat’s history just now. Try again.',
				},
			},
		] );
		// The session view keeps Send disabled for good only after `rebind_required`.
		expect( events[ 0 ].outcome?.code ).not.toBe( 'rebind_required' );
		await (
			await createNativeSessionStore( fixture.storeRoot ).lockTurn( 'chat' )
		)();

		await fs.rm( order );
		const next = fakeNativeTurn( fixture.root, { projects: fixture.projects } );
		expect( ( await run( 'next', next ) ).at( -1 ) ).toMatchObject( {
			type: 'turn.terminal',
			outcome: { status: 'success' },
		} );
		expect( next ).toHaveBeenCalledOnce();
		await (
			await createNativeSessionStore( fixture.storeRoot ).lockTurn( 'chat' )
		)();
	} finally {
		await fixture.cleanup();
	}
} );

describe( 'the run lock a turn records (mock SDK)', () => {
	const owner = { pid: 1234, start: '134389060500000000' };
	const lockOf = async ( storeRoot: string ) => {
		const { readFileSync } = await import( 'fs' );
		const path = await import( 'path' );
		const file = path.join(
			storeRoot,
			`${ createHash( 'sha256' ).update( 'chat' ).digest( 'hex' ) }.json.lock`
		);
		return () => JSON.parse( readFileSync( file, 'utf8' ) ) as Record< string, unknown >;
	};

	it( 'names the turn and its owner at once, the native session before the SDK starts, and the owned process before the prompt', async () => {
		const { runClaudeTurn } = await import( '../runtime' );
		const { createNativeSessionStore } = await import( '../sessions' );
		const fixture = await ownedNativeFixture( 'claude-lock-record-' );
		try {
			const read = await lockOf( fixture.storeRoot );
			const seen: Record< string, Record< string, unknown > > = {};
			const inner = spawningNativeTurn( fixture.root, async () => {
				seen.prompt = read();
				return 'result';
			} );
			const query = vi.fn( ( input: Parameters< typeof inner >[ 0 ] ) => {
				// The SDK starts its process from here.
				seen.query = read();
				return inner( input );
			} );
			const events: Array< { type: string; outcome?: { status: string } } > = [];
			await runClaudeTurn(
				turnSnapshot( fixture.root, fixture.config, 'turn' ),
				fixture.host,
				{
					prompt: 'hello',
					signal: new AbortController().signal,
					onEvent: ( event ) => events.push( event ),
				},
				{
					storeRoot: fixture.storeRoot,
					approve: async () => 'deny',
					verifyTarget: async () => true,
					query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
					prepareOwner: () => {
						seen.owner = read();
						return fixture.prepareOwner();
					},
					ownerIdentity: async () => owner,
					connection: fixture.connection,
					prepare: fixture.prepare,
					account: fixture.account,
				}
			);
			expect( events.at( -1 ) ).toMatchObject( {
				type: 'turn.terminal',
				outcome: { status: 'success' },
			} );
			const locked = {
				version: 2,
				purpose: 'run',
				conversationId: 'chat',
				platform: process.platform,
				owner,
				runId: 'turn',
				turnId: 'turn',
				connection: { id: 'native', revision: 1 },
				workspace: {
					siteId: 'site',
					workingDirectory: fixture.root,
					configDirectory: fixture.config,
				},
			};
			expect( seen.owner ).toMatchObject( { ...locked, stage: 'locked' } );
			expect( seen.owner ).not.toHaveProperty( 'session' );
			const nativeSessionId = ( await createNativeSessionStore( fixture.storeRoot ).load(
				'chat'
			) )!.nativeSessionId;
			const session = { nativeSessionId, resume: false };
			expect( seen.query ).toMatchObject( { ...locked, stage: 'starting', session } );
			expect( seen.query ).not.toHaveProperty( 'processes' );
			expect( seen.prompt ).toMatchObject( {
				...locked,
				stage: 'owned',
				session,
				processes: {
					native: { pid: 4321, start: '1' },
					guardian: { pid: 4322, start: '2' },
				},
			} );
			expect( seen.prompt.token ).toBe( seen.owner.token );
			await expect(
				createNativeSessionStore( fixture.storeRoot ).inspectLock( 'chat' )
			).resolves.toEqual( { state: 'none' } );
		} finally {
			await fixture.cleanup();
		}
	} );

	it( 'starts nothing and takes no lock when it cannot read its own process identity', async () => {
		const { runClaudeTurn } = await import( '../runtime' );
		const { createNativeSessionStore } = await import( '../sessions' );
		const fixture = await ownedNativeFixture( 'claude-lock-owner-' );
		try {
			const query = spawningNativeTurn( fixture.root, async () => 'result' );
			const prepareOwner = vi.fn( fixture.prepareOwner );
			const events: Array< { type: string; outcome?: { status: string } } > = [];
			await runClaudeTurn(
				turnSnapshot( fixture.root, fixture.config, 'turn' ),
				fixture.host,
				{
					prompt: 'hello',
					signal: new AbortController().signal,
					onEvent: ( event ) => events.push( event ),
				},
				{
					storeRoot: fixture.storeRoot,
					approve: async () => 'deny',
					verifyTarget: async () => true,
					query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
					prepareOwner,
					ownerIdentity: async () => undefined,
					connection: fixture.connection,
					prepare: fixture.prepare,
					account: fixture.account,
				}
			);
			expect( events ).toEqual( [
				expect.objectContaining( {
					type: 'turn.terminal',
					outcome: expect.objectContaining( { status: 'error' } ),
				} ),
			] );
			expect( query ).not.toHaveBeenCalled();
			expect( prepareOwner ).not.toHaveBeenCalled();
			await expect(
				createNativeSessionStore( fixture.storeRoot ).inspectLock( 'chat' )
			).resolves.toEqual( { state: 'none' } );
		} finally {
			await fixture.cleanup();
		}
	} );

	it( 'sends no prompt to a native process whose ownership it could not record', async () => {
		const { runClaudeTurn } = await import( '../runtime' );
		const { createNativeSessionStore } = await import( '../sessions' );
		const fixture = await ownedNativeFixture( 'claude-lock-unrecorded-', { unidentified: true } );
		try {
			const read = await lockOf( fixture.storeRoot );
			let stage: unknown;
			const onTurn = vi.fn( async () => 'result' as const );
			const inner = spawningNativeTurn( fixture.root, onTurn );
			const query = vi.fn( ( input: Parameters< typeof inner >[ 0 ] ) => {
				const started = inner( input );
				return Object.assign( started, {
					close: () => {
						stage = read().stage;
					},
				} );
			} );
			const events: Array< { type: string; outcome?: { status: string } } > = [];
			await runClaudeTurn(
				turnSnapshot( fixture.root, fixture.config, 'turn' ),
				fixture.host,
				{
					prompt: 'hello',
					signal: new AbortController().signal,
					onEvent: ( event ) => events.push( event ),
				},
				{
					storeRoot: fixture.storeRoot,
					approve: async () => 'deny',
					verifyTarget: async () => true,
					query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
					prepareOwner: fixture.prepareOwner,
					ownerIdentity: async () => owner,
					connection: fixture.connection,
					prepare: fixture.prepare,
					account: fixture.account,
				}
			);
			expect( onTurn ).not.toHaveBeenCalled();
			expect( events.map( ( event ) => event.type ) ).not.toContain( 'turn.prompt' );
			expect( events.at( -1 ) ).toMatchObject( {
				type: 'turn.terminal',
				outcome: { status: 'error' },
			} );
			expect( stage ).toBe( 'starting' );
			await expect(
				createNativeSessionStore( fixture.storeRoot ).inspectLock( 'chat' )
			).resolves.toEqual( { state: 'none' } );
		} finally {
			await fixture.cleanup();
		}
	} );

	it( 'sends no prompt, and says it could not own the process, when the helper guarding the tree cannot be identified', async () => {
		const { runClaudeTurn } = await import( '../runtime' );
		const { createNativeSessionStore } = await import( '../sessions' );
		const fixture = await ownedNativeFixture( 'claude-lock-unguarded-', {
			guardian: async () => undefined,
		} );
		try {
			const read = await lockOf( fixture.storeRoot );
			let stage: unknown;
			const onTurn = vi.fn( async () => 'result' as const );
			const inner = spawningNativeTurn( fixture.root, onTurn );
			const query = vi.fn( ( input: Parameters< typeof inner >[ 0 ] ) =>
				Object.assign( inner( input ), {
					close: () => {
						stage = read().stage;
					},
				} )
			);
			const events: Array< { type: string; outcome?: { status: string; code?: string } } > = [];
			await runClaudeTurn(
				turnSnapshot( fixture.root, fixture.config, 'turn' ),
				fixture.host,
				{
					prompt: 'hello',
					signal: new AbortController().signal,
					onEvent: ( event ) => events.push( event ),
				},
				{
					storeRoot: fixture.storeRoot,
					approve: async () => 'deny',
					verifyTarget: async () => true,
					query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
					prepareOwner: fixture.prepareOwner,
					ownerIdentity: async () => owner,
					connection: fixture.connection,
					prepare: fixture.prepare,
					account: fixture.account,
				}
			);
			expect( onTurn ).not.toHaveBeenCalled();
			expect( events ).toEqual( [
				expect.objectContaining( {
					type: 'turn.terminal',
					outcome: expect.objectContaining( { status: 'error', code: 'process_unowned' } ),
				} ),
			] );
			expect( stage ).toBe( 'starting' );
			await expect(
				createNativeSessionStore( fixture.storeRoot ).inspectLock( 'chat' )
			).resolves.toEqual( { state: 'none' } );
		} finally {
			await fixture.cleanup();
		}
	} );

	it( 'releases the lock only once the ownership it is recording has settled, and never recreates it', async () => {
		const { runClaudeTurn } = await import( '../runtime' );
		const { createNativeSessionStore } = await import( '../sessions' );
		const { existsSync } = await import( 'fs' );
		const path = await import( 'path' );
		let settleGuardian!: ( identity: { pid: number; start: string } ) => void;
		const guardianRead = new Promise< { pid: number; start: string } >( ( resolve ) => {
			settleGuardian = resolve;
		} );
		let shutDown!: () => void;
		const shutdownCalled = new Promise< void >( ( resolve ) => {
			shutDown = resolve;
		} );
		const fixture = await ownedNativeFixture( 'claude-lock-settled-', {
			guardian: () => guardianRead,
			onShutdown: () => shutDown(),
		} );
		try {
			const file = path.join(
				fixture.storeRoot,
				`${ createHash( 'sha256' ).update( 'chat' ).digest( 'hex' ) }.json.lock`
			);
			const inner = spawningNativeTurn( fixture.root, async () => 'result' );
			// Startup fails while the guardian is still being read, so the turn ends first.
			const query = vi.fn( ( input: Parameters< typeof inner >[ 0 ] ) =>
				Object.assign( inner( input ), {
					initializationResult: async () => ( {
						hooks_applied: false,
						hook_on_failure_supported: true,
					} ),
				} )
			);
			const events: Array< { type: string; outcome?: { status: string } } > = [];
			const turn = runClaudeTurn(
				turnSnapshot( fixture.root, fixture.config, 'turn' ),
				fixture.host,
				{
					prompt: 'hello',
					signal: new AbortController().signal,
					onEvent: ( event ) => events.push( event ),
				},
				{
					storeRoot: fixture.storeRoot,
					approve: async () => 'deny',
					verifyTarget: async () => true,
					query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
					prepareOwner: fixture.prepareOwner,
					ownerIdentity: async () => owner,
					connection: fixture.connection,
					prepare: fixture.prepare,
					account: fixture.account,
				}
			);
			await shutdownCalled;
			await new Promise( ( resolve ) => setTimeout( resolve, 100 ) );
			const heldWhileReading = existsSync( file );
			settleGuardian( { pid: 4322, start: '2' } );
			await turn;
			expect( heldWhileReading ).toBe( true );
			expect( events.at( -1 ) ).toMatchObject( {
				type: 'turn.terminal',
				outcome: { status: 'error' },
			} );
			await expect(
				createNativeSessionStore( fixture.storeRoot ).inspectLock( 'chat' )
			).resolves.toEqual( { state: 'none' } );
		} finally {
			await fixture.cleanup();
		}
	} );
} );

it( 'reports no success and keeps the run lock when the owned tree cannot be confirmed gone (mock SDK)', async () => {
	const { runClaudeTurn } = await import( '../runtime' );
	const { createNativeSessionStore } = await import( '../sessions' );
	const fixture = await ownedNativeFixture( 'claude-unclean-', { clean: false } );
	try {
		const events: Array< { type: string; outcome?: { status: string } } > = [];
		await runClaudeTurn(
			turnSnapshot( fixture.root, fixture.config, 'turn' ),
			fixture.host,
			{
				prompt: 'hello',
				signal: new AbortController().signal,
				onEvent: ( event ) => events.push( event ),
			},
			{
				storeRoot: fixture.storeRoot,
				approve: async () => 'deny',
				verifyTarget: async () => true,
				query: spawningNativeTurn(
					fixture.root,
					async () => 'result'
				) as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
				prepareOwner: fixture.prepareOwner,
				connection: fixture.connection,
				prepare: fixture.prepare,
				account: fixture.account,
			}
		);
		expect( fixture.order ).toEqual( [ 'owner-prepared', 'owned-ready', 'owned-shutdown' ] );
		expect( events.filter( ( event ) => event.type === 'turn.terminal' ) ).toEqual( [
			expect.objectContaining( {
				outcome: expect.objectContaining( {
					status: 'error',
					code: 'process_unconfirmed',
					message: expect.stringContaining( 'stays locked' ),
				} ),
			} ),
		] );
		await expect(
			createNativeSessionStore( fixture.storeRoot ).lockTurn( 'chat' )
		).rejects.toThrow();
	} finally {
		await fixture.cleanup();
	}
} );

it( 'sends no prompt to a native process it could not put in the job, and says why (mock SDK)', async () => {
	const { runClaudeTurn } = await import( '../runtime' );
	const fixture = await ownedNativeFixture( 'claude-unowned-', {
		ready: false,
		failure: 'job-assignment-denied',
	} );
	try {
		const onTurn = vi.fn( async () => 'result' as const );
		const events: Array< { type: string; outcome?: { status: string } } > = [];
		await runClaudeTurn(
			turnSnapshot( fixture.root, fixture.config, 'turn' ),
			fixture.host,
			{
				prompt: 'hello',
				signal: new AbortController().signal,
				onEvent: ( event ) => events.push( event ),
			},
			{
				storeRoot: fixture.storeRoot,
				approve: async () => 'deny',
				verifyTarget: async () => true,
				query: spawningNativeTurn(
					fixture.root,
					onTurn
				) as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
				prepareOwner: fixture.prepareOwner,
				connection: fixture.connection,
				prepare: fixture.prepare,
				account: fixture.account,
			}
		);
		expect( onTurn ).not.toHaveBeenCalled();
		expect( fixture.order ).toEqual( [ 'owner-prepared', 'owned-ready', 'owned-shutdown' ] );
		expect( events ).toEqual( [
			expect.objectContaining( {
				type: 'turn.terminal',
				outcome: expect.objectContaining( {
					status: 'error',
					code: 'process_unowned',
					message: expect.stringContaining( 'job object' ),
				} ),
			} ),
		] );
	} finally {
		await fixture.cleanup();
	}
} );

it.each( [
	[ 'keeper-blocked', 'Full Language mode' ],
	[ 'keeper-unavailable', 'could not start' ],
	[ 'keeper-timeout', 'did not answer in time' ],
] as const )(
	'starts no native process when the job cannot be prepared (%s), and says why (mock SDK)',
	async ( failure, reason ) => {
		const { runClaudeTurn } = await import( '../runtime' );
		const { createNativeSessionStore } = await import( '../sessions' );
		const fixture = await ownedNativeFixture( 'claude-unprepared-', { prepared: false, failure } );
		try {
			const query = spawningNativeTurn( fixture.root, async () => 'result' );
			const events: Array< { type: string; outcome?: { status: string } } > = [];
			await runClaudeTurn(
				turnSnapshot( fixture.root, fixture.config, 'turn' ),
				fixture.host,
				{
					prompt: 'hello',
					signal: new AbortController().signal,
					onEvent: ( event ) => events.push( event ),
				},
				{
					storeRoot: fixture.storeRoot,
					approve: async () => 'deny',
					verifyTarget: async () => true,
					query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
					prepareOwner: fixture.prepareOwner,
					connection: fixture.connection,
					prepare: fixture.prepare,
					account: fixture.account,
				}
			);
			expect( query ).not.toHaveBeenCalled();
			expect( fixture.spawnOwned ).not.toHaveBeenCalled();
			expect( fixture.order ).toEqual( [ 'owner-prepared', 'owner-disposed' ] );
			expect( events ).toEqual( [
				expect.objectContaining( {
					type: 'turn.terminal',
					outcome: expect.objectContaining( {
						status: 'error',
						code: 'process_unowned',
						message: expect.stringContaining( reason ),
					} ),
				} ),
			] );
			if ( failure !== 'keeper-blocked' )
				expect( JSON.stringify( events ) ).not.toContain( 'Language' );
			await (
				await createNativeSessionStore( fixture.storeRoot ).lockTurn( 'chat' )
			)();
		} finally {
			await fixture.cleanup();
		}
	}
);

it( 'sends no prompt, and keeps the run lock, when the SDK starts without Studio’s spawn hook (mock SDK)', async () => {
	const { runClaudeTurn } = await import( '../runtime' );
	const { createNativeSessionStore } = await import( '../sessions' );
	const fixture = await ownedNativeFixture( 'claude-unhooked-' );
	try {
		const onTurn = vi.fn( async () => 'result' as const );
		const events: Array< { type: string; outcome?: { status: string } } > = [];
		await runClaudeTurn(
			turnSnapshot( fixture.root, fixture.config, 'turn' ),
			fixture.host,
			{
				prompt: 'hello',
				signal: new AbortController().signal,
				onEvent: ( event ) => events.push( event ),
			},
			{
				storeRoot: fixture.storeRoot,
				approve: async () => 'deny',
				verifyTarget: async () => true,
				query: spawningNativeTurn( fixture.root, onTurn, {
					launch: false,
				} ) as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
				prepareOwner: fixture.prepareOwner,
				connection: fixture.connection,
				prepare: fixture.prepare,
				account: fixture.account,
			}
		);
		expect( onTurn ).not.toHaveBeenCalled();
		expect( fixture.spawnOwned ).not.toHaveBeenCalled();
		expect( fixture.order ).toEqual( [ 'owner-prepared', 'owner-disposed' ] );
		expect( events ).toEqual( [
			expect.objectContaining( {
				type: 'turn.terminal',
				outcome: expect.objectContaining( {
					status: 'error',
					code: 'process_unconfirmed',
					message: expect.stringContaining( 'stays locked' ),
				} ),
			} ),
		] );
		await expect(
			createNativeSessionStore( fixture.storeRoot ).lockTurn( 'chat' )
		).rejects.toThrow();
	} finally {
		await fixture.cleanup();
	}
} );

it( 'starts no native process, and leaves no keeper, when the turn is cancelled while the job is being prepared (mock SDK)', async () => {
	const { runClaudeTurn } = await import( '../runtime' );
	const { createNativeSessionStore } = await import( '../sessions' );
	const fixture = await ownedNativeFixture( 'claude-cancel-prepare-' );
	try {
		const turn = new AbortController();
		let finishPreparing!: ( prepared: boolean ) => void;
		const preparing = new Promise< boolean >( ( resolve ) => {
			finishPreparing = resolve;
		} );
		const owner = {
			prepared: () => {
				fixture.order.push( 'owner-prepared' );
				// The user stops the turn while the keeper is still creating the job.
				queueMicrotask( () => turn.abort() );
				return preparing;
			},
			failure: () => undefined,
			spawn: fixture.spawnOwned,
			dispose: async () => {
				fixture.order.push( 'owner-disposed' );
			},
		} as unknown as import('@studio/common/lib/owned-process').ProcessOwner;
		const query = spawningNativeTurn( fixture.root, async () => 'result' );
		const events: Array< { type: string; outcome?: { status: string } } > = [];
		const run = runClaudeTurn(
			turnSnapshot( fixture.root, fixture.config, 'turn' ),
			fixture.host,
			{ prompt: 'hello', signal: turn.signal, onEvent: ( event ) => events.push( event ) },
			{
				storeRoot: fixture.storeRoot,
				approve: async () => 'deny',
				verifyTarget: async () => true,
				query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
				prepareOwner: () => owner,
				connection: fixture.connection,
				prepare: fixture.prepare,
				account: fixture.account,
			}
		);
		const settled = await Promise.race( [
			run.then( () => 'ended' ),
			new Promise( ( resolve ) => setTimeout( () => resolve( 'still waiting' ), 2_000 ) ),
		] );
		finishPreparing( true );
		await run;
		expect( settled ).toBe( 'ended' );
		expect( query ).not.toHaveBeenCalled();
		expect( fixture.spawnOwned ).not.toHaveBeenCalled();
		expect( fixture.order ).toEqual( [ 'owner-prepared', 'owner-disposed' ] );
		expect( events ).toEqual( [
			expect.objectContaining( {
				type: 'turn.terminal',
				outcome: expect.objectContaining( { status: 'interrupted' } ),
			} ),
		] );
		await (
			await createNativeSessionStore( fixture.storeRoot ).lockTurn( 'chat' )
		)();
	} finally {
		await fixture.cleanup();
	}
} );

describe( 'the turns after a recovery (mock SDK)', () => {
	// The OS answered as if the turn's owner and its tree had gone. In these
	// tests the turn the recovery stands for is still waiting in this process;
	// it is ended only once the test is done.
	const goneSeams = {
		platform: process.platform,
		self: async () => ( { pid: 999999, start: 'recoverer' } ),
		checkIdentity: async () => 'gone' as const,
		checkTree: async () => ( { state: 'ended' as const } ),
	};
	type Runtime = typeof import('../runtime');
	type Fixture = Awaited< ReturnType< typeof ownedNativeFixture > >;
	type Query = ReturnType< typeof fakeNativeTurn >;
	const bindingOf = ( fixture: Fixture ) => ( {
		connectionId: 'native',
		conversationId: 'chat',
		siteId: 'site',
		workingDirectory: fixture.root,
		configDirectory: fixture.config,
	} );
	const optionsOf = ( query: Query ) =>
		query.mock.calls[ 0 ][ 0 ].options as Record< string, unknown > & {
			systemPrompt: { append: string };
		};
	async function turn(
		runtime: Runtime,
		fixture: Fixture,
		id: string,
		query: Query,
		overrides: Partial< Parameters< Runtime[ 'runClaudeTurn' ] >[ 3 ] > = {},
		signal = new AbortController().signal
	) {
		const events: Array< { type: string; outcome?: { status: string; code?: string } } > = [];
		await runtime.runClaudeTurn(
			turnSnapshot( fixture.root, fixture.config, id ),
			fixture.host,
			{ prompt: 'hello', signal, onEvent: ( event ) => events.push( event ) },
			{
				storeRoot: fixture.storeRoot,
				approve: async () => 'allow',
				verifyTarget: async () => true,
				query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
				prepareOwner: fixture.prepareOwner,
				ownerIdentity: async () => ( { pid: 1234, start: id } ),
				connection: fixture.connection,
				prepare: fixture.prepare,
				account: fixture.account,
				...overrides,
			}
		);
		return events;
	}
	const noted = async ( fixture: Fixture ) => {
		const { createNativeSessionStore } = await import( '../sessions' );
		return ( await createNativeSessionStore( fixture.storeRoot ).readJournals( 'chat' ) )
			.flat()
			.filter( ( event ) => ( event.type as string ) === 'turn.recovery-noted' );
	};

	it( 'resumes the same native session, tells Claude once what may or may not have run, and runs the next turn as a normal one, across a restart', async () => {
		const { createNativeSessionStore } = await import( '../sessions' );
		const { recoverClaudeRun } = await import( '../recovery' );
		const { Client } = await import( '@modelcontextprotocol/sdk/client/index.js' );
		// The SDK's wildcard export resolves at runtime, although the ESLint resolver misses it.
		// eslint-disable-next-line import-x/no-unresolved
		const { InMemoryTransport } = await import( '@modelcontextprotocol/sdk/inMemory.js' );
		const fixture = await ownedNativeFixture( 'claude-after-recovery-' );
		let finishCommand!: () => void;
		const commandRunning = new Promise< void >( ( resolve ) => {
			finishCommand = resolve;
		} );
		const stopFirst = new AbortController();
		let first: Promise< unknown > | undefined;
		try {
			vi.mocked( fixture.host.sites.resolve ).mockResolvedValue( {
				id: 'site',
				path: fixture.root,
				name: 'site',
				url: 'http://localhost',
				phpVersion: '8.4',
			} );
			vi.mocked( fixture.host.sites.wpCli ).mockImplementation( async () => {
				await commandRunning;
				return { exitCode: 0, stdout: '', stderr: '' };
			} );
			const runtime = await import( '../runtime' );
			// The first turn dies while the draft the user allowed is being created.
			const dying = fakeNativeTurn( fixture.root, {
				projects: fixture.projects,
				onTurn: async ( options ) => {
					const [ clientTransport, serverTransport ] = InMemoryTransport.createLinkedPair();
					const client = new Client( { name: 'studio-test', version: '1.0.0' } );
					const server = (
						options.mcpServers as {
							studio: { instance: { connect( t: unknown ): Promise< void > } };
						}
					 ).studio.instance;
					await Promise.all( [
						server.connect( serverTransport ),
						client.connect( clientTransport ),
					] );
					await client.callTool( {
						name: 'wp_cli',
						arguments: {
							nameOrPath: 'site',
							command: 'post create --post_status=draft --post_title=Hello',
						},
					} );
				},
			} );
			first = turn( runtime, fixture, 'first', dying, {}, stopFirst.signal );
			await vi.waitFor( () => expect( fixture.host.sites.wpCli ).toHaveBeenCalled() );
			const store = createNativeSessionStore( fixture.storeRoot );
			const { nativeSessionId } = ( await store.load( 'chat' ) )!;
			expect( await recoverClaudeRun( store, bindingOf( fixture ), goneSeams ) ).toMatchObject( {
				status: 'recovered',
				uncertainOperations: [
					expect.objectContaining( { tool: 'sites.wpCli', evidence: 'authorized' } ),
				],
			} );
			const recoveredLock = ( await store.readJournals( 'chat' ) )
				.flat()
				.find( ( event ) => event.type === 'turn.recovered' ) as { lock: string };

			// Studio restarts between the recovery and the next turn.
			vi.resetModules();
			const restarted = await import( '../runtime' );
			const next = fakeNativeTurn( fixture.root, { projects: fixture.projects } );
			expect( ( await turn( restarted, fixture, 'next', next ) ).at( -1 ) ).toMatchObject( {
				type: 'turn.terminal',
				outcome: { status: 'success' },
			} );
			const resumed = optionsOf( next );
			expect( resumed.resume ).toBe( nativeSessionId );
			expect( resumed.sessionId ).toBeUndefined();
			const base = optionsOf( dying ).systemPrompt.append;
			const note = resumed.systemPrompt.append;
			expect( note.startsWith( base ) ).toBe( true );
			expect( note ).toContain( 'the previous turn' );
			expect( note ).toContain( 'interrupted' );
			expect( note ).not.toContain( 'Run a command: wp_cli' );
			expect( note ).toContain( 'Create a draft post on the current local site' );
			expect( note ).toMatch( /inspect/i );
			expect( note ).toMatch( /do not repeat/i );
			expect( note ).not.toContain( 'Hello' );
			expect( await noted( fixture ) ).toEqual( [
				{
					type: 'turn.recovery-noted',
					runId: 'next',
					turnId: 'next',
					locks: [ recoveredLock.lock ],
				},
			] );

			const after = fakeNativeTurn( fixture.root, { projects: fixture.projects } );
			expect( ( await turn( restarted, fixture, 'after', after ) ).at( -1 ) ).toMatchObject( {
				type: 'turn.terminal',
				outcome: { status: 'success' },
			} );
			expect( optionsOf( after ).resume ).toBe( nativeSessionId );
			expect( optionsOf( after ).systemPrompt.append ).toBe( base );
			expect( await noted( fixture ) ).toHaveLength( 1 );
		} finally {
			stopFirst.abort();
			finishCommand();
			await first;
			await fixture.cleanup();
		}
	} );

	it( 'starts one native session for a recovered chat that had none, says only that the turn was interrupted when nothing was uncertain, and keeps that until a prompt carries it', async () => {
		const { createNativeSessionStore } = await import( '../sessions' );
		const { recoverClaudeRun } = await import( '../recovery' );
		const fixture = await ownedNativeFixture( 'claude-after-recovery-fresh-' );
		let finishPreparing!: ( prepared: { ok: false } ) => void;
		const preparing = new Promise< { ok: false } >( ( resolve ) => {
			finishPreparing = resolve;
		} );
		const prepareFirst = vi.fn( () => preparing );
		let first: Promise< unknown > | undefined;
		try {
			const runtime = await import( '../runtime' );
			// The first turn dies before it starts anything: its lock names no native session.
			first = turn( runtime, fixture, 'first', fakeNativeTurn( fixture.root ), {
				prepare: prepareFirst,
			} );
			await vi.waitFor( () => expect( prepareFirst ).toHaveBeenCalled() );
			const store = createNativeSessionStore( fixture.storeRoot );
			expect( await store.load( 'chat' ) ).toBeUndefined();
			expect( await recoverClaudeRun( store, bindingOf( fixture ), goneSeams ) ).toMatchObject( {
				status: 'recovered',
				uncertainOperations: [],
			} );

			// The next turn cannot own its native process, so no prompt carries the note.
			const unowned = fakeNativeTurn( fixture.root, { projects: fixture.projects } );
			expect(
				await turn( runtime, fixture, 'unowned', unowned, {
					prepareOwner: fakeProcessOwner( { ready: false, failure: 'job-assignment-denied' } )
						.prepareOwner,
				} )
			).toEqual( [
				expect.objectContaining( {
					outcome: expect.objectContaining( { code: 'process_unowned' } ),
				} ),
			] );
			expect( await noted( fixture ) ).toEqual( [] );

			const fresh = fakeNativeTurn( fixture.root, { projects: fixture.projects } );
			expect( ( await turn( runtime, fixture, 'fresh', fresh ) ).at( -1 ) ).toMatchObject( {
				type: 'turn.terminal',
				outcome: { status: 'success' },
			} );
			const started = optionsOf( fresh );
			expect( started.resume ).toBeUndefined();
			expect( typeof started.sessionId ).toBe( 'string' );
			const note = started.systemPrompt.append;
			expect( note ).toContain( 'interrupted' );
			expect( note ).not.toMatch( /may or may not|inspect/i );
			expect( await noted( fixture ) ).toEqual( [
				expect.objectContaining( { turnId: 'fresh' } ),
			] );

			const after = fakeNativeTurn( fixture.root, { projects: fixture.projects } );
			expect( ( await turn( runtime, fixture, 'after', after ) ).at( -1 ) ).toMatchObject( {
				type: 'turn.terminal',
				outcome: { status: 'success' },
			} );
			expect( optionsOf( after ).resume ).toBe( started.sessionId );
			expect( optionsOf( after ).sessionId ).toBeUndefined();
			expect( optionsOf( after ).systemPrompt.append ).not.toContain( 'interrupted' );
			expect( await noted( fixture ) ).toHaveLength( 1 );
		} finally {
			finishPreparing( { ok: false } );
			await first;
			await fixture.cleanup();
		}
	} );

	// Recovers the chat after a first turn that died before it started
	// anything, so the next prompt carries the note. Returns what ends that
	// first turn, which is still waiting in this process.
	async function interruptedChat( runtime: Runtime, fixture: Fixture ) {
		const { createNativeSessionStore } = await import( '../sessions' );
		const { recoverClaudeRun } = await import( '../recovery' );
		let finishPreparing!: ( prepared: { ok: false } ) => void;
		const preparing = new Promise< { ok: false } >( ( resolve ) => {
			finishPreparing = resolve;
		} );
		const prepareFirst = vi.fn( () => preparing );
		const first = turn( runtime, fixture, 'first', fakeNativeTurn( fixture.root ), {
			prepare: prepareFirst,
		} );
		await vi.waitFor( () => expect( prepareFirst ).toHaveBeenCalled() );
		expect(
			await recoverClaudeRun(
				createNativeSessionStore( fixture.storeRoot ),
				bindingOf( fixture ),
				goneSeams
			)
		).toMatchObject( { status: 'recovered' } );
		return async () => {
			finishPreparing( { ok: false } );
			await first;
		};
	}

	it( 'names an operation Studio does not recognize to Claude in the note, in the note’s own words', async () => {
		const { createNativeSessionStore } = await import( '../sessions' );
		const fixture = await ownedNativeFixture( 'claude-note-unknown-' );
		try {
			const runtime = await import( '../runtime' );
			// A recovery as recorded of a turn that started a tool this build does not know.
			const dead = { runId: 'dead', turnId: 'dead' };
			await createNativeSessionStore( fixture.storeRoot ).recordRecovery( 'chat', 'token', [
				{
					type: 'turn.terminal',
					...dead,
					outcome: { status: 'unknown_process_exit', code: 'recovered' },
				},
				{
					type: 'turn.recovered',
					...dead,
					lock: 'f'.repeat( 64 ),
					invalidatedApprovals: [],
					uncertainOperations: [
						{ toolCallId: 'unknown', tool: 'future_tool', evidence: 'started' },
					],
				},
			] );
			const next = fakeNativeTurn( fixture.root, { projects: fixture.projects } );
			expect( ( await turn( runtime, fixture, 'next', next ) ).at( -1 ) ).toMatchObject( {
				type: 'turn.terminal',
				outcome: { status: 'success' },
			} );
			const note = optionsOf( next ).systemPrompt.append;
			expect( note ).toContain( '\n- Run an operation Studio does not recognize: future_tool\n' );
			expect( note ).not.toContain( 'undefined' );
		} finally {
			await fixture.cleanup();
		}
	} );

	const apiError = ( sessionId: unknown ) => ( {
		type: 'result',
		subtype: 'success',
		is_error: true,
		num_turns: 1,
		session_id: sessionId,
	} );

	it.each( [ 'an API error', 'a cancel', 'an account stop' ] as const )(
		'keeps the note for the next turn when the turn that carried it ends with %s before Claude answered',
		async ( ending ) => {
			const path = await import( 'path' );
			const { CLAUDE_ACCOUNT_RECHECK_MS } = await import( '../execution-rules' );
			const fixture = await ownedNativeFixture( 'claude-note-kept-' );
			let finishFirst: ( () => Promise< void > ) | undefined;
			try {
				const runtime = await import( '../runtime' );
				finishFirst = await interruptedChat( runtime, fixture );
				const stop = new AbortController();
				const clock = { now: 1_000 };
				const failing = fakeNativeTurn( fixture.root, {
					projects: fixture.projects,
					onTurn: async ( options ) => {
						if ( ending === 'a cancel' ) stop.abort();
						if ( ending === 'an account stop' ) {
							// The next operation reads the sign-in again, and finds another account.
							clock.now += CLAUDE_ACCOUNT_RECHECK_MS;
							const hook = (
								options.hooks as {
									PreToolUse: Array< {
										hooks: Array<
											(
												input: unknown,
												id: string,
												context: { signal: AbortSignal }
											) => Promise< unknown >
										>;
									} >;
								}
							 ).PreToolUse[ 0 ].hooks[ 0 ];
							await hook(
								{
									hook_event_name: 'PreToolUse',
									tool_name: 'Read',
									tool_input: { file_path: path.join( fixture.root, 'readme.txt' ) },
									tool_use_id: 'read',
								},
								'read',
								{ signal: new AbortController().signal }
							);
						}
					},
					answer: ( sessionId ) => ( ending === 'an API error' ? [ apiError( sessionId ) ] : [] ),
				} );
				const events = await turn(
					runtime,
					fixture,
					'failing',
					failing,
					ending === 'an account stop'
						? {
								clock: () => clock.now,
								account: async () => ( {
									state: 'signed-in' as const,
									identity: { email: 'someone-else@example.com', subscriptionType: 'max' },
								} ),
						  }
						: {},
					stop.signal
				);
				expect( events.at( -1 ) ).toMatchObject( {
					type: 'turn.terminal',
					outcome:
						ending === 'an API error'
							? { status: 'error' }
							: ending === 'a cancel'
							? { status: 'interrupted' }
							: { status: 'interrupted', code: 'account_changed' },
				} );
				expect( optionsOf( failing ).systemPrompt.append ).toContain( 'interrupted' );
				expect( await noted( fixture ) ).toEqual( [] );

				const next = fakeNativeTurn( fixture.root, { projects: fixture.projects } );
				expect( ( await turn( runtime, fixture, 'next', next ) ).at( -1 ) ).toMatchObject( {
					type: 'turn.terminal',
					outcome: { status: 'success' },
				} );
				expect( optionsOf( next ).systemPrompt.append ).toContain( 'interrupted' );
				expect( await noted( fixture ) ).toEqual( [
					expect.objectContaining( { turnId: 'next' } ),
				] );
			} finally {
				await finishFirst?.();
				await fixture.cleanup();
			}
		}
	);

	it( 'counts the note as given once Claude has answered the prompt that carried it, even when that turn then fails', async () => {
		const fixture = await ownedNativeFixture( 'claude-note-answered-' );
		let finishFirst: ( () => Promise< void > ) | undefined;
		try {
			const runtime = await import( '../runtime' );
			finishFirst = await interruptedChat( runtime, fixture );
			const answered = fakeNativeTurn( fixture.root, {
				projects: fixture.projects,
				answer: ( sessionId ) => [
					{
						type: 'assistant',
						uuid: 'frame',
						session_id: sessionId,
						parent_tool_use_id: null,
						message: {
							id: 'message',
							model: 'sonnet',
							content: [ { type: 'text', text: 'I will check the site first.' } ],
						},
					},
					apiError( sessionId ),
				],
			} );
			expect( ( await turn( runtime, fixture, 'answered', answered ) ).at( -1 ) ).toMatchObject( {
				type: 'turn.terminal',
				outcome: { status: 'error' },
			} );
			expect( optionsOf( answered ).systemPrompt.append ).toContain( 'interrupted' );
			expect( await noted( fixture ) ).toEqual( [
				expect.objectContaining( { turnId: 'answered' } ),
			] );

			const next = fakeNativeTurn( fixture.root, { projects: fixture.projects } );
			expect( ( await turn( runtime, fixture, 'next', next ) ).at( -1 ) ).toMatchObject( {
				type: 'turn.terminal',
				outcome: { status: 'success' },
			} );
			expect( optionsOf( next ).systemPrompt.append ).not.toContain( 'interrupted' );
			expect( await noted( fixture ) ).toHaveLength( 1 );
		} finally {
			await finishFirst?.();
			await fixture.cleanup();
		}
	} );
} );

// The real ownership logic, with the OS answered through seams: each case is
// a native process that exits, or cannot be owned, before Studio owns it.
describe( 'a native process Studio could not own (mock SDK, owned-process with injected OS seams)', () => {
	function windowsOwner( own: ( child: FakeChild ) => string[] ) {
		const child = fakeChild( 4242 );
		child.kill = ( signal: NodeJS.Signals = 'SIGTERM' ) => {
			child.killed.push( signal );
			setImmediate( () => exitChild( child, 1 ) );
			return true;
		};
		const { spawn: spawnSeam } = fakeSpawn(
			child,
			keeperAnswering( { 'own 4242': () => own( child ), 'end-tree': [ 'ended 0' ] } )
		);
		return () => prepareProcessOwner( { ...windowsSeams, spawn: spawnSeam } );
	}

	function posixOwner( groupEmpty: boolean ) {
		const child = fakeChild( 500 );
		const { spawn: spawnSeam } = fakeSpawn( child );
		let clock = 0;
		return () =>
			prepareProcessOwner( {
				...linuxSeams( {}, ( _pid, signal ) => {
					if ( signal !== 0 ) throw new Error( 'An unverified group must never be signalled' );
					if ( groupEmpty ) throw errno( 'ESRCH' );
				} ),
				// The leader exits, and is reaped, while its identity is read.
				readFile: async ( file: string ) => {
					if ( child.exitCode === null ) exitChild( child );
					throw enoent( file );
				},
				now: () => clock,
				delay: async () => {
					clock += 100;
					await new Promise( ( resolve ) => setImmediate( resolve ) );
				},
				spawn: spawnSeam,
			} );
	}

	it.each( [
		[
			'Windows: the child was reaped before its assignment was read',
			() =>
				windowsOwner( ( child ) => {
					exitChild( child );
					return [ `assigned ${ WINDOWS_START }` ];
				} ),
			false,
		],
		[
			'Windows: the child was gone before the keeper could open it',
			() =>
				windowsOwner( ( child ) => {
					exitChild( child );
					return [ 'failed open 87' ];
				} ),
			false,
		],
		[
			'Windows: the assignment was denied, so a grandchild whose parent exited could not be seen',
			() => windowsOwner( () => [ `failed assign 5 ${ WINDOWS_START }` ] ),
			false,
		],
		[
			'POSIX: the leader was reaped before its identity was read, and its group is empty',
			() => posixOwner( true ),
			true,
		],
		[
			'POSIX: the leader was reaped before its identity was read, and its group remains',
			() => posixOwner( false ),
			false,
		],
	] )(
		'%s: releases the run lock only on proof that nothing remains, and otherwise says it stays locked',
		async ( _name, owner, released ) => {
			const { runClaudeTurn } = await import( '../runtime' );
			const { createNativeSessionStore } = await import( '../sessions' );
			const fixture = await ownedNativeFixture( 'claude-fast-exit-' );
			try {
				const onTurn = vi.fn( async () => 'result' as const );
				const events: Array< { type: string; outcome?: { status: string } } > = [];
				await runClaudeTurn(
					turnSnapshot( fixture.root, fixture.config, 'turn' ),
					fixture.host,
					{
						prompt: 'hello',
						signal: new AbortController().signal,
						onEvent: ( event ) => events.push( event ),
					},
					{
						storeRoot: fixture.storeRoot,
						approve: async () => 'deny',
						verifyTarget: async () => true,
						query: spawningNativeTurn(
							fixture.root,
							onTurn
						) as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
						prepareOwner: owner(),
						connection: fixture.connection,
						prepare: fixture.prepare,
						account: fixture.account,
					}
				);
				expect( onTurn ).not.toHaveBeenCalled();
				const store = createNativeSessionStore( fixture.storeRoot );
				if ( released ) {
					expect( events ).toEqual( [
						expect.objectContaining( {
							outcome: expect.objectContaining( { status: 'error', code: 'process_unowned' } ),
						} ),
					] );
					await (
						await store.lockTurn( 'chat' )
					)();
				} else {
					expect( events ).toEqual( [
						expect.objectContaining( {
							outcome: expect.objectContaining( {
								status: 'error',
								code: 'process_unconfirmed',
								message: expect.stringContaining( 'stays locked' ),
							} ),
						} ),
					] );
					await expect( store.lockTurn( 'chat' ) ).rejects.toThrow();
				}
			} finally {
				await fixture.cleanup();
			}
		}
	);
} );
