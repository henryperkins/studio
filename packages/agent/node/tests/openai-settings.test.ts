import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeCredentialStore, type FakeCredentialStore } from './fake-credential-store';

// Safe test keys only; nothing here ever reaches OpenAI.
const KEY = 'sk-proj-TESTONLY_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaawxyz';
const OTHER_KEY = 'sk-proj-TESTONLY_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb5678';

const keychain = vi.hoisted( () => ( { current: null as FakeCredentialStore | null } ) );

vi.mock( '@studio/common/lib/os-credential-store', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/common/lib/os-credential-store') >() ),
	createOsCredentialStore: () => keychain.current!.store,
} ) );

const modelList = ( ...ids: string[] ) =>
	new Response( JSON.stringify( { object: 'list', data: ids.map( ( id ) => ( { id } ) ) } ), {
		status: 200,
	} );
const errorResponse = ( status: number, code: string, message = code ) =>
	new Response( JSON.stringify( { error: { code, message, type: code } } ), { status } );

// Module state (the cached keychain status, a session key) is per process, so
// each test loads fresh modules, as a restarted app would.
async function load() {
	vi.resetModules();
	return {
		settings: await import( '@studio/agent/node/settings-store' ),
		credentials: await import( '@studio/agent/node/openai-credentials' ),
		storage: await import( '@studio/common/lib/os-credential-store' ),
	};
}

describe( 'OpenAI settings', () => {
	let configDir: string;
	let previousDevConfigDir: string | undefined;
	let fetchMock: ReturnType< typeof vi.fn >;

	const sharedConfigPath = () => path.join( configDir, 'shared.json' );
	const readSharedText = () =>
		fs.existsSync( sharedConfigPath() ) ? fs.readFileSync( sharedConfigPath(), 'utf8' ) : '';
	const readShared = () => JSON.parse( readSharedText() || '{}' );

	function expectNoKeyOutsideKeychain( value: unknown ) {
		for ( const key of [ KEY, OTHER_KEY ] ) {
			expect( JSON.stringify( value ) ).not.toContain( key );
			expect( readSharedText() ).not.toContain( key );
		}
	}

	beforeEach( () => {
		configDir = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-openai-settings-' ) );
		previousDevConfigDir = process.env.DEV_CONFIG_DIR;
		process.env.DEV_CONFIG_DIR = configDir;
		keychain.current = createFakeCredentialStore();
		fetchMock = vi.fn().mockResolvedValue( modelList( 'gpt-6.1-sol', 'gpt-6-luna' ) );
		vi.stubGlobal( 'fetch', fetchMock );
	} );

	afterEach( () => {
		vi.unstubAllGlobals();
		if ( previousDevConfigDir === undefined ) {
			delete process.env.DEV_CONFIG_DIR;
		} else {
			process.env.DEV_CONFIG_DIR = previousDevConfigDir;
		}
		fs.rmSync( configDir, { recursive: true, force: true } );
	} );

	it( 'defaults to no key and the documented defaults', async () => {
		const { settings } = await load();
		await expect( settings.readAiSettings() ).resolves.toMatchObject( {
			provider: 'wpcom',
			hasOpenAiApiKey: false,
			openAi: {
				keyStorage: null,
				keyHint: null,
				secureStorage: 'available',
				defaultModel: 'gpt-6.1-sol',
				defaultReasoningEffort: 'medium',
				defaultReasoningMode: 'standard',
				maxOutputTokens: 32_000,
				models: { checkedAt: null, availableModelIds: null, lastError: null },
			},
		} );
		expect( fetchMock ).not.toHaveBeenCalled();
	} );

	it( 'checks the key with OpenAI, keeps it in the keychain and reports only a hint', async () => {
		fetchMock.mockResolvedValue(
			modelList( 'gpt-6.1-sol', 'gpt-6-luna', 'text-embedding-4-large', 'gpt-7-preview' )
		);
		const { settings } = await load();

		const result = await settings.saveOpenAiApiKey( `  ${ KEY }  ` );

		expect( result ).toMatchObject( {
			provider: 'wpcom',
			hasOpenAiApiKey: true,
			openAi: { keyStorage: 'keychain', keyHint: '…wxyz' },
		} );
		// Embedding and unknown chat models never become selectable.
		expect( result.openAi.models.availableModelIds ).toEqual( [ 'gpt-6.1-sol', 'gpt-6-luna' ] );
		expect( keychain.current!.items.get( 'openai-api-key' ) ).toBe( KEY );
		expectNoKeyOutsideKeychain( result );

		const [ url, init ] = fetchMock.mock.calls[ 0 ];
		expect( url ).toBe( 'https://api.openai.com/v1/models' );
		expect( init ).toMatchObject( {
			headers: { Authorization: `Bearer ${ KEY }` },
			redirect: 'error',
		} );
	} );

	it.each( [ 'not-a-key', 'sk-short', `sk-admin-${ 'a'.repeat( 30 ) }`, '' ] )(
		'refuses %j without asking OpenAI',
		async ( value ) => {
			const { settings } = await load();
			await expect( settings.saveOpenAiApiKey( value ) ).rejects.toBeInstanceOf(
				settings.InvalidOpenAiApiKeyError
			);
			expect( fetchMock ).not.toHaveBeenCalled();
			expect( keychain.current!.items.size ).toBe( 0 );
		}
	);

	it( 'does not store a key OpenAI rejects, and never echoes it', async () => {
		fetchMock.mockResolvedValue(
			errorResponse( 401, 'invalid_api_key', `Incorrect API key provided: ${ KEY }.` )
		);
		const { settings } = await load();

		const error = await settings.saveOpenAiApiKey( KEY ).catch( ( e: unknown ) => e );

		expect( error ).toBeInstanceOf( settings.InvalidOpenAiApiKeyError );
		expect( ( error as Error ).message ).not.toContain( KEY );
		expect( keychain.current!.items.size ).toBe( 0 );
		expect( readSharedText() ).toBe( '' );
	} );

	it( 'stores a key that may not list models, separately from a rejected key', async () => {
		fetchMock.mockResolvedValue(
			errorResponse( 403, 'missing_scope', 'You have insufficient permissions: api.model.read' )
		);
		const { settings } = await load();

		const result = await settings.saveOpenAiApiKey( KEY );

		expect( result.hasOpenAiApiKey ).toBe( true );
		expect( result.openAi.models ).toMatchObject( {
			availableModelIds: null,
			lastError: { kind: 'permission', status: 403 },
		} );
	} );

	it.each( [
		[ 'offline', () => Promise.reject( new TypeError( 'fetch failed' ) ), 'network' ],
		[ 'rate limited', async () => errorResponse( 429, 'rate_limit_exceeded' ), 'rate-limit' ],
		[ 'out of quota', async () => errorResponse( 429, 'insufficient_quota' ), 'quota' ],
	] as const )( 'stores a key it can’t verify while %s', async ( _label, respond, kind ) => {
		fetchMock.mockImplementation( respond );
		const { settings } = await load();

		const result = await settings.saveOpenAiApiKey( KEY );

		expect( result.hasOpenAiApiKey ).toBe( true );
		expect( result.openAi.models.lastError?.kind ).toBe( kind );
		expectNoKeyOutsideKeychain( result );
	} );

	it( 'replaces the key and forgets the previous key’s model list', async () => {
		const { settings } = await load();
		await settings.saveOpenAiApiKey( KEY );

		fetchMock.mockResolvedValue( modelList( 'gpt-6-astra' ) );
		const result = await settings.saveOpenAiApiKey( OTHER_KEY );

		expect( keychain.current!.items.get( 'openai-api-key' ) ).toBe( OTHER_KEY );
		expect( result.openAi.keyHint ).toBe( '…5678' );
		expect( result.openAi.models.availableModelIds ).toEqual( [ 'gpt-6-astra' ] );
	} );

	it( 'applies concurrent saves in one process one at a time, keeping key and model list together', async () => {
		const { settings } = await load();
		let releaseFirst!: () => void;
		fetchMock
			.mockImplementationOnce(
				() =>
					new Promise( ( resolve ) => {
						releaseFirst = () => resolve( modelList( 'gpt-6-luna' ) );
					} )
			)
			.mockImplementationOnce( async () => modelList( 'gpt-6-astra' ) );

		const first = settings.saveOpenAiApiKey( KEY );
		const second = settings.saveOpenAiApiKey( OTHER_KEY );
		await vi.waitFor( () => expect( fetchMock ).toHaveBeenCalledTimes( 1 ) );
		releaseFirst();
		await Promise.all( [ first, second ] );

		const result = await settings.readAiSettings();
		expect( keychain.current!.items.get( 'openai-api-key' ) ).toBe( OTHER_KEY );
		expect( result.openAi.models.availableModelIds ).toEqual( [ 'gpt-6-astra' ] );
	} );

	it( 'removes the key, and moves only new conversations back to WordPress.com', async () => {
		const { settings } = await load();
		await settings.saveOpenAiApiKey( KEY );
		await settings.setAiProvider( 'openai-api-key' );
		await settings.setOpenAiDefaults( { model: 'gpt-6-luna', reasoningEffort: 'none' } );

		const result = await settings.removeOpenAiApiKey();

		expect( keychain.current!.items.size ).toBe( 0 );
		expect( result ).toMatchObject( {
			provider: 'wpcom',
			hasOpenAiApiKey: false,
			openAi: {
				keyStorage: null,
				keyHint: null,
				// The defaults stay for when a key is added again.
				defaultModel: 'gpt-6-luna',
				defaultReasoningEffort: 'none',
				models: { availableModelIds: null },
			},
		} );
	} );

	describe( 'without a system keychain', () => {
		beforeEach( () => {
			keychain.current!.state.available = false;
			keychain.current!.state.absent = true;
		} );

		it( 'says so, and refuses to save the key anywhere else', async () => {
			const { settings, storage } = await load();

			await expect( settings.readAiSettings() ).resolves.toMatchObject( {
				openAi: { secureStorage: 'unavailable' },
			} );
			await expect( settings.saveOpenAiApiKey( KEY ) ).rejects.toBeInstanceOf(
				storage.SecureStorageError
			);
			const after = await settings.readAiSettings();
			expect( after.hasOpenAiApiKey ).toBe( false );
			expectNoKeyOutsideKeychain( after );
		} );

		it( 'keeps a session-only key in memory, and gives it to a forked turn only when asked', async () => {
			const { settings, credentials } = await load();

			const result = await settings.saveOpenAiApiKey( KEY, { storage: 'session' } );

			expect( result ).toMatchObject( {
				hasOpenAiApiKey: true,
				openAi: { keyStorage: 'session', secureStorage: 'unavailable' },
			} );
			expectNoKeyOutsideKeychain( result );
			// A forked turn's environment says a key is offered, never what it is.
			expect( credentials.getOpenAiSessionKeyForkEnvironment() ).toEqual( {
				STUDIO_OPENAI_SESSION_KEY_OFFERED: '1',
			} );
			const reply = vi.fn();
			expect(
				credentials.answerOpenAiSessionKeyRequest(
					{ type: 'studio.openai-session-key.request' },
					reply
				)
			).toBe( true );
			expect( reply ).toHaveBeenCalledWith( { type: 'studio.openai-session-key', key: KEY } );
			expect( credentials.answerOpenAiSessionKeyRequest( { type: 'interrupt' }, reply ) ).toBe(
				false
			);

			// A restarted app has no key.
			const restarted = await load();
			await expect( restarted.settings.readAiSettings() ).resolves.toMatchObject( {
				hasOpenAiApiKey: false,
			} );
		} );
	} );

	it( 'removes a session key on a machine with no keychain to clean up', async () => {
		keychain.current!.state.available = false;
		keychain.current!.state.absent = true;
		const { settings } = await load();
		await settings.saveOpenAiApiKey( KEY, { storage: 'session' } );

		await expect( settings.removeOpenAiApiKey() ).resolves.toMatchObject( {
			hasOpenAiApiKey: false,
		} );
	} );

	describe( 'with a keychain this process can’t reach', () => {
		it( 'won’t report a removal while a key saved there may come back', async () => {
			// Saved earlier, e.g. from the desktop session; now Studio runs over SSH.
			keychain.current!.items.set( 'openai-api-key', OTHER_KEY );
			keychain.current!.state.available = false;
			const { settings, storage } = await load();
			await settings.saveOpenAiApiKey( KEY, { storage: 'session' } );

			const removal = settings.removeOpenAiApiKey();

			await expect( removal ).rejects.toBeInstanceOf( storage.SecureStorageError );
			await expect( removal ).rejects.toThrow(
				/stopped using the key for this session, but couldn’t reach the system keychain/
			);
			await expect( settings.readAiSettings() ).resolves.toMatchObject( {
				hasOpenAiApiKey: false,
			} );
			expect( keychain.current!.items.get( 'openai-api-key' ) ).toBe( OTHER_KEY );

			keychain.current!.state.available = true;
			await settings.removeOpenAiApiKey();

			expect( keychain.current!.items.has( 'openai-api-key' ) ).toBe( false );
			await expect( settings.readAiSettings() ).resolves.toMatchObject( {
				hasOpenAiApiKey: false,
			} );
		} );

		it( 'checks the keychain again instead of trusting a failure it cached', async () => {
			keychain.current!.items.set( 'openai-api-key', KEY );
			keychain.current!.state.available = false;
			const { settings } = await load();
			await settings.readAiSettings();
			keychain.current!.state.available = true;

			await settings.removeOpenAiApiKey();

			expect( keychain.current!.items.has( 'openai-api-key' ) ).toBe( false );
		} );
	} );

	describe( 'in a turn forked by an app', () => {
		// The turn's end of the IPC channel; `answer` plays the app.
		function parentChannel( answer: ( request: unknown ) => unknown ) {
			const events = new EventEmitter();
			const send = vi.fn( ( message: unknown ) => {
				const reply = answer( message );
				if ( reply !== undefined ) {
					setImmediate( () => events.emit( 'message', reply ) );
				}
			} );
			return Object.assign( events, { send } );
		}
		const OFFER = 'STUDIO_OPENAI_SESSION_KEY_OFFERED';

		it( 'asks the app for its session key once, the first time it needs one', async () => {
			const { credentials } = await load();
			const channel = parentChannel( () => ( { type: 'studio.openai-session-key', key: KEY } ) );
			const env: NodeJS.ProcessEnv = { [ OFFER ]: '1', PATH: '/bin' };

			credentials.acceptOpenAiSessionKeyFromParent( channel, env );

			expect( env ).toEqual( { PATH: '/bin' } );
			expect( channel.send ).not.toHaveBeenCalled();
			for ( let attempt = 0; attempt < 2; attempt++ ) {
				await expect( credentials.readOpenAiKeySource() ).resolves.toEqual( {
					key: KEY,
					storage: 'session',
				} );
			}
			expect( channel.send ).toHaveBeenCalledTimes( 1 );
			expect( channel.send ).toHaveBeenCalledWith(
				{ type: 'studio.openai-session-key.request' },
				expect.any( Function )
			);
			expect( channel.listenerCount( 'message' ) ).toBe( 0 );
		} );

		it( 'uses the keychain when the app no longer has a session key', async () => {
			keychain.current!.items.set( 'openai-api-key', OTHER_KEY );
			const { credentials } = await load();
			const channel = parentChannel( () => ( { type: 'studio.openai-session-key', key: null } ) );

			credentials.acceptOpenAiSessionKeyFromParent( channel, { [ OFFER ]: '1' } );

			await expect( credentials.readOpenAiKeySource() ).resolves.toEqual( {
				key: OTHER_KEY,
				storage: 'keychain',
			} );
		} );

		it( 'doesn’t wait for an app that never answers', async () => {
			keychain.current!.items.set( 'openai-api-key', OTHER_KEY );
			const { credentials } = await load();
			const channel = parentChannel( () => undefined );
			credentials.acceptOpenAiSessionKeyFromParent( channel, { [ OFFER ]: '1' } );
			vi.useFakeTimers();
			try {
				const source = credentials.readOpenAiKeySource();
				await vi.advanceTimersByTimeAsync( 10_000 );
				await expect( source ).resolves.toEqual( { key: OTHER_KEY, storage: 'keychain' } );
			} finally {
				vi.useRealTimers();
			}
			expect( channel.listenerCount( 'message' ) ).toBe( 0 );
		} );

		it( 'uses the keychain when the channel to the app has closed', async () => {
			keychain.current!.items.set( 'openai-api-key', OTHER_KEY );
			const { credentials } = await load();
			const channel = Object.assign( new EventEmitter(), {
				send: vi.fn( ( _message: unknown, callback: ( error: Error | null ) => void ) =>
					setImmediate( () => callback( new Error( 'Channel closed' ) ) )
				),
			} );
			credentials.acceptOpenAiSessionKeyFromParent( channel, { [ OFFER ]: '1' } );

			await expect( credentials.readOpenAiKeySource() ).resolves.toEqual( {
				key: OTHER_KEY,
				storage: 'keychain',
			} );
		} );

		it( 'never asks an app that offered no key', async () => {
			const { credentials } = await load();
			const channel = parentChannel( () => ( { type: 'studio.openai-session-key', key: KEY } ) );

			credentials.acceptOpenAiSessionKeyFromParent( channel, { PATH: '/bin' } );

			await expect( credentials.readOpenAiKeySource() ).resolves.toBeNull();
			expect( channel.send ).not.toHaveBeenCalled();
		} );
	} );

	describe( 'model refresh', () => {
		it( 'keeps the previous list when a refresh fails', async () => {
			const { settings } = await load();
			await settings.saveOpenAiApiKey( KEY );
			const before = ( await settings.readAiSettings() ).openAi.models;

			fetchMock.mockResolvedValue( errorResponse( 503, 'server_error' ) );
			const failed = await settings.refreshOpenAiModels();

			expect( failed.openAi.models ).toEqual( {
				...before,
				lastError: { kind: 'server', status: 503, code: 'server_error', detail: 'server_error' },
			} );

			fetchMock.mockResolvedValue( errorResponse( 401, 'invalid_api_key' ) );
			const revoked = await settings.refreshOpenAiModels();
			expect( revoked.openAi.models.availableModelIds ).toEqual( before.availableModelIds );
			expect( revoked.openAi.models.lastError?.kind ).toBe( 'authentication' );
		} );

		it( 'keeps saved defaults when a refresh fails or the list shrinks', async () => {
			const { settings } = await load();
			await settings.saveOpenAiApiKey( KEY );
			await settings.setOpenAiDefaults( { model: 'gpt-6-luna', reasoningEffort: 'high' } );

			fetchMock.mockResolvedValue( modelList( 'gpt-6.1-sol' ) );
			const result = await settings.refreshOpenAiModels();

			expect( result.openAi ).toMatchObject( {
				defaultModel: 'gpt-6-luna',
				defaultReasoningEffort: 'high',
				models: { availableModelIds: [ 'gpt-6.1-sol' ] },
			} );
		} );

		it( 'needs a key', async () => {
			const { settings } = await load();
			await expect( settings.refreshOpenAiModels() ).rejects.toBeInstanceOf(
				settings.OpenAiSettingsError
			);
		} );
	} );

	describe( 'defaults', () => {
		it( 'saves a supported combination', async () => {
			const { settings } = await load();
			const result = await settings.setOpenAiDefaults( {
				model: 'gpt-6-astra',
				reasoningEffort: 'max',
				reasoningMode: 'pro',
				maxOutputTokens: 128_000,
			} );
			expect( result.openAi ).toMatchObject( {
				defaultModel: 'gpt-6-astra',
				defaultReasoningEffort: 'max',
				defaultReasoningMode: 'pro',
				maxOutputTokens: 128_000,
			} );
			expect( readShared() ).toMatchObject( {
				openaiDefaultModel: 'gpt-6-astra',
				openaiDefaultReasoningEffort: 'max',
				openaiDefaultReasoningMode: 'pro',
				openaiMaxOutputTokens: 128_000,
			} );
		} );

		it.each( [
			[ { model: 'gpt-6-astra', reasoningEffort: 'none' }, /doesn’t support “None” reasoning/ ],
			[ { model: 'gpt-7-preview' }, /doesn’t support the OpenAI model “gpt-7-preview”/ ],
			[ { maxOutputTokens: 200_000 }, /from 1,024 to 128,000/ ],
		] )( 'refuses %j without changing anything', async ( update, message ) => {
			const { settings } = await load();
			await expect( settings.setOpenAiDefaults( update ) ).rejects.toThrow( message );
			expect( readSharedText() ).toBe( '' );
		} );

		it( 'refuses a model the project’s list lacks', async () => {
			const { settings } = await load();
			await settings.saveOpenAiApiKey( KEY );
			await expect( settings.setOpenAiDefaults( { model: 'gpt-6-astra' } ) ).rejects.toThrow(
				/isn’t in your OpenAI project’s model list/
			);
		} );

		it( 'reads values another build wrote as the built-in defaults', async () => {
			fs.writeFileSync(
				sharedConfigPath(),
				JSON.stringify( {
					version: 1,
					openaiDefaultModel: 'gpt-5.6-sol',
					openaiDefaultReasoningEffort: 'turbo',
					openaiDefaultReasoningMode: 42,
					openaiMaxOutputTokens: '32000',
					openaiModels: 'not an object',
					authToken: undefined,
					locale: 'fr',
				} )
			);
			const { settings } = await load();
			await expect( settings.readAiSettings() ).resolves.toMatchObject( {
				openAi: {
					defaultModel: 'gpt-6.1-sol',
					defaultReasoningEffort: 'medium',
					defaultReasoningMode: 'standard',
					maxOutputTokens: 32_000,
					models: { availableModelIds: null },
				},
			} );
		} );

		it( 'ignores a model list checked against another catalog version', async () => {
			fs.writeFileSync(
				sharedConfigPath(),
				JSON.stringify( {
					version: 1,
					openaiModels: {
						checkedAt: '2026-01-01T00:00:00.000Z',
						availableModelIds: [ 'gpt-6-luna' ],
						catalogVersion: '2026-01-01',
						lastError: null,
					},
				} )
			);
			const { settings } = await load();
			await expect( settings.readAiSettings() ).resolves.toMatchObject( {
				openAi: { models: { availableModelIds: null, checkedAt: '2026-01-01T00:00:00.000Z' } },
			} );
		} );
	} );

	describe( 'selecting OpenAI for new conversations', () => {
		it( 'needs a key', async () => {
			const { settings } = await load();
			await expect( settings.setAiProvider( 'openai-api-key' ) ).rejects.toBeInstanceOf(
				settings.OpenAiSettingsError
			);
		} );

		it( 'refuses a key OpenAI now rejects, but accepts an unverifiable one', async () => {
			const { settings } = await load();
			await settings.saveOpenAiApiKey( KEY );

			fetchMock.mockResolvedValue( errorResponse( 401, 'invalid_api_key' ) );
			await expect( settings.setAiProvider( 'openai-api-key' ) ).rejects.toBeInstanceOf(
				settings.InvalidOpenAiApiKeyError
			);

			fetchMock.mockRejectedValue( new TypeError( 'fetch failed' ) );
			await expect( settings.setAiProvider( 'openai-api-key' ) ).resolves.toMatchObject( {
				provider: 'openai-api-key',
			} );
		} );

		it( 'works without a WordPress.com login or an Anthropic key', async () => {
			const { settings } = await load();
			await settings.saveOpenAiApiKey( KEY );
			const result = await settings.setAiProvider( 'openai-api-key' );
			expect( result ).toMatchObject( {
				provider: 'openai-api-key',
				hasAnthropicApiKey: false,
				hasOpenAiApiKey: true,
			} );
		} );
	} );
} );
