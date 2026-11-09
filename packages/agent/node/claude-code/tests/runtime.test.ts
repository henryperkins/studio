import { describe, expect, it, vi } from 'vitest';
import { discoverClaudeModels, qualifyClaudeStartup } from '../runtime';

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

	it( 'discovers available models without starting a turn or sending user input', async () => {
		let launch: Record< string, unknown > | undefined;
		let input: Promise< IteratorResult< unknown > > | undefined;
		let closed = false;
		let inventoryRequests = 0;
		const query = ( request: {
			prompt: AsyncIterable< unknown >;
			options: Record< string, unknown >;
		} ) => {
			launch = request.options;
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
		await expect(
			discoverClaudeModels( 'connection', '.', {
				query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
				connection: async () => ( { id: 'connection', executablePath: 'fake' } ),
				prepare: async () => ( {
					ok: true as const,
					executablePath: 'fake',
					cwd: '.',
					configDirectory: '.',
					projectsDirectory: '.',
					env: {},
					identity,
				} ),
			} )
		).resolves.toEqual( {
			ok: true,
			models: [ { id: 'claude-xyz', displayName: 'Sonnet', efforts: [ 'medium' ] } ],
			workingDirectory: '.',
			configDirectory: '.',
		} );
		expect( launch ).toMatchObject( { persistSession: false, strictMcpConfig: true } );
		expect( launch?.model ).toBeUndefined();
		expect( closed ).toBe( true );
		await expect( input ).resolves.toMatchObject( { done: true } );
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
					approve: async () => 'deny',
					connection: async () => ( { id: 'connection', executablePath: 'fake' } ),
					prepare: async () => ( {
						ok: true,
						executablePath: 'fake',
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
		const host = createFakeHost();
		host.sites.all = async () => [
			{ id: 'site', path: root, name: 'site', url: 'http://localhost', phpVersion: '8.4' },
		];
		const query = vi.fn(
			( input: { prompt: AsyncIterable< unknown >; options: Record< string, unknown > } ) => {
				const model = input.options.model;
				const sessionId = input.options.resume ?? input.options.sessionId;
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
					query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
					connection: async () => ( { id: 'native', executablePath: 'fake' } ),
					prepare: async () => ( {
						ok: true,
						executablePath: 'fake',
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
	let promptRead = false;
	let closed = false;
	const fakeQuery = ( input: { prompt: AsyncIterable< unknown > } ) => ( {
		initializationResult: async () => ( { hooks_applied: false, hook_on_failure_supported: true } ),
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
	} );
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
			connection: async () => ( { id: 'native', executablePath: 'fake' } ),
			prepare: async () => ( {
				ok: true as const,
				executablePath: 'fake',
				cwd: process.cwd(),
				configDirectory: process.cwd(),
				projectsDirectory: process.cwd(),
				env: {},
				identity: { email: 'user@example.com', subscriptionType: 'max' },
			} ),
			storeRoot,
			approve: async () => 'deny',
		}
	);
	expect( promptRead ).toBe( false );
	expect( closed ).toBe( true );
	await fs.rm( storeRoot, { recursive: true, force: true } );
	expect( events ).toMatchObject( [ { type: 'turn.terminal', outcome: { status: 'error' } } ] );
} );

it( 'sends only after verified startup, freezes options and records an explicit session (mock SDK)', async () => {
	const fs = await import( 'fs/promises' );
	const os = await import( 'os' );
	const path = await import( 'path' );
	const root = await fs.realpath( await fs.mkdtemp( path.join( os.tmpdir(), 'claude-runtime-' ) ) );
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
			workspace: {
				conversationId: 'chat',
				siteId: 'site',
				workingDirectory: root,
				configDirectory: root,
			},
		};
		let emittedPrompt = false;
		let seenInput: unknown;
		let seenOptions: Record< string, unknown > = {};
		const fakeQuery = ( input: {
			prompt: AsyncIterable< unknown >;
			options: Record< string, unknown >;
		} ) => {
			seenOptions = input.options;
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
						yield {
							type: 'assistant',
							session_id: input.options.sessionId,
							uuid: 'unexpected',
							message: { id: 'msg', model: 'other', content: [ { type: 'text', text: 'unsafe' } ] },
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
				connection: async () => ( { id: 'native', executablePath: 'fake' } ),
				prepare: async () => ( {
					ok: true as const,
					executablePath: 'fake',
					cwd: root,
					configDirectory: root,
					projectsDirectory: path.join( root, 'projects' ),
					env: {},
					identity: { email: 'user@example.com', subscriptionType: 'max' },
				} ),
				storeRoot: path.join( root, 'store' ),
				approve: async () => 'deny',
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
			pathToClaudeCodeExecutable: 'fake',
			cwd: root,
			model: 'sonnet',
			effort: 'medium',
			tools: [ 'Read' ],
			permissionMode: 'default',
			settingSources: [],
		} );
		const saved = await createNativeSessionStore( path.join( root, 'store' ) ).load( 'chat' );
		expect( saved?.nativeSessionId ).toBe( seenOptions.sessionId );
		expect(
			await createNativeSessionStore( path.join( root, 'store' ) ).journal( 'chat', 'turn' ).read()
		).toMatchObject( [
			{ type: 'turn.prompt', text: 'hello' },
			{ type: 'turn.terminal', outcome: { status: 'error' } },
		] );
		expect( events ).toMatchObject( [
			{ type: 'turn.prompt', text: 'hello' },
			{ type: 'turn.terminal', outcome: { status: 'error' } },
		] );
	} finally {
		await fs.rm( root, { recursive: true, force: true } );
	}
} );

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
			workspace: {
				conversationId: 'chat',
				siteId: 'site',
				workingDirectory: root,
				configDirectory: root,
			},
		};
		let before: unknown;
		const fakeQuery = ( input: {
			prompt: AsyncIterable< unknown >;
			options: {
				hooks: {
					PreToolUse: Array< { hooks: Array< ( input: unknown ) => Promise< unknown > > } >;
				};
				sessionId: string;
			};
		} ) => ( {
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
		} );
		await runClaudeTurn(
			snapshot,
			host,
			{ prompt: 'hello', signal: new AbortController().signal, onEvent: () => {} },
			{
				query: fakeQuery as unknown as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
				connection: async () => ( { id: 'native', executablePath: 'fake' } ),
				prepare: async () => ( {
					ok: true as const,
					executablePath: 'fake',
					cwd: root,
					configDirectory: root,
					projectsDirectory: path.join( root, 'projects' ),
					env: {},
					identity: { email: 'user@example.com', subscriptionType: 'max' },
				} ),
				storeRoot: path.join( root, 'store' ),
				approve: async () => 'deny',
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
		const { isAllowedNativeRead } = await import( '../runtime' );
		expect( await isAllowedNativeRead( path.join( root, 'safe.txt' ), root, config ) ).toBe( true );
		for ( const file of [ '.env', 'wp-config.php', '.credentials.json', 'config/state.json' ] )
			expect( await isAllowedNativeRead( path.join( root, file ), root, config ) ).toBe( false );
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

it( 'waits for an owned child to exit and kills a stalled child before releasing its lock', async () => {
	const { settleNativeProcess } = await import( '../runtime' );
	let killed = false;
	let exited = false;
	let listener: () => void = () => {};
	const child = {
		get exitCode() {
			return exited ? 0 : null;
		},
		get signalCode() {
			return null;
		},
		once: ( _event: string, fn: () => void ) => {
			listener = fn;
		},
		off: () => {},
		kill: () => {
			killed = true;
			exited = true;
			listener();
			return true;
		},
	};
	expect( await settleNativeProcess( child, 10 ) ).toBe( true );
	expect( killed ).toBe( true );
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
