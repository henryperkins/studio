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
					approve: async () => 'deny',
					verifyTarget: async () => true,
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
	}: {
		onTurn?: ( options: Record< string, unknown > ) => Promise< void >;
		account?: () => Record< string, string >;
		projects?: string;
	} = {}
) {
	return vi.fn(
		( input: { prompt: AsyncIterable< unknown >; options: Record< string, unknown > } ) => ( {
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
					yield {
						type: 'result',
						subtype: 'success',
						is_error: false,
						num_turns: 1,
						session_id: sessionId,
					};
				}
			},
		} )
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
					connection: async () => ( { id: 'native', executablePath: 'fake' } ),
					prepare: async () => ( {
						ok: true,
						executablePath: 'fake',
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
				connection: async () => ( { id: 'native', executablePath: 'fake' } ),
				prepare: async () => ( {
					ok: true,
					executablePath: 'fake',
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

it( 'registers a PreToolUse hook that outlasts any approval and denies a cancelled hook (mock SDK)', async () => {
	const { runClaudeTurn } = await import( '../runtime' );
	const { CLAUDE_HOOK_TIMEOUT_SECONDS } = await import( '../execution-rules' );
	const path = await import( 'path' );
	const fixture = await runtimeFixture( 'claude-hook-' );
	try {
		const decisions: unknown[] = [];
		let timeout: unknown;
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
				connection: async () => ( { id: 'native', executablePath: 'fake' } ),
				prepare: async () => ( {
					ok: true,
					executablePath: 'fake',
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

it( 'stops the turn when the connection revision or the native account changes (mock SDK)', async () => {
	const { runClaudeTurn } = await import( '../runtime' );
	const path = await import( 'path' );
	const fixture = await runtimeFixture( 'claude-account-' );
	try {
		const options = (
			query: unknown,
			connection: { id: string; executablePath: string; revision?: number }
		) => ( {
			storeRoot: fixture.storeRoot,
			approve: async () => 'deny' as const,
			verifyTarget: async () => true,
			query: query as typeof import('@anthropic-ai/claude-agent-sdk/core').query,
			connection: async () => connection,
			prepare: async () => ( {
				ok: true as const,
				executablePath: 'fake',
				cwd: fixture.root,
				configDirectory: fixture.config,
				projectsDirectory: fixture.projects,
				env: {},
				identity: { email: 'user@example.com', subscriptionType: 'max' },
			} ),
		} );
		const reestablished = vi.fn();
		const events: Array< { type: string; outcome?: { status: string; message?: string } } > = [];
		await runClaudeTurn(
			turnSnapshot( fixture.root, fixture.config, 'stale' ),
			fixture.host,
			{ prompt: 'hello', signal: new AbortController().signal, onEvent: ( e ) => events.push( e ) },
			options( reestablished, { id: 'native', executablePath: 'fake', revision: 2 } )
		);
		expect( reestablished ).not.toHaveBeenCalled();
		expect( events.at( -1 ) ).toMatchObject( {
			type: 'turn.terminal',
			outcome: { status: 'error', message: expect.stringContaining( 'changed' ) },
		} );

		let email = 'user@example.com';
		const decisions: unknown[] = [];
		const query = fakeNativeTurn( fixture.root, {
			account: () => nativeAccount( email ),
			onTurn: async ( turnOptions ) => {
				const hook = (
					turnOptions.hooks as {
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
				const read = () =>
					hook(
						{
							hook_event_name: 'PreToolUse',
							tool_name: 'Read',
							tool_input: { file_path: path.join( fixture.root, 'readme.txt' ) },
							tool_use_id: 'read',
						},
						'read',
						{ signal: new AbortController().signal }
					);
				decisions.push( ( await read() ).hookSpecificOutput.permissionDecision );
				email = 'someone-else@example.com';
				decisions.push( ( await read() ).hookSpecificOutput.permissionDecision );
			},
		} );
		events.length = 0;
		await runClaudeTurn(
			turnSnapshot( fixture.root, fixture.config, 'switched' ),
			fixture.host,
			{ prompt: 'hello', signal: new AbortController().signal, onEvent: ( e ) => events.push( e ) },
			options( query, { id: 'native', executablePath: 'fake' } )
		);
		expect( decisions ).toEqual( [ 'allow', 'deny' ] );
		expect( events.at( -1 ) ).toMatchObject( {
			type: 'turn.terminal',
			outcome: { status: 'interrupted', message: expect.stringContaining( 'account' ) },
		} );
	} finally {
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
					connection: async () => ( { id: 'native', executablePath: 'fake' } ),
					prepare: async () => ( {
						ok: true,
						executablePath: 'fake',
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
