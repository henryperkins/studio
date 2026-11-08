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

// Lets a test hold the next write to shared.json until it says so.
const sharedConfigWrite = vi.hoisted( () => ( { hold: null as Promise< void > | null } ) );

vi.mock( '@studio/common/lib/shared-config', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/common/lib/shared-config') >();
	const held = async () => {
		const hold = sharedConfigWrite.hold;
		sharedConfigWrite.hold = null;
		await hold;
	};
	return {
		...actual,
		updateSharedConfig: async ( update: Parameters< typeof actual.updateSharedConfig >[ 0 ] ) => {
			await held();
			return actual.updateSharedConfig( update );
		},
		updateSharedConfigFrom: async (
			compute: Parameters< typeof actual.updateSharedConfigFrom >[ 0 ]
		) => {
			await held();
			return actual.updateSharedConfigFrom( compute );
		},
	};
} );

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
		sharedConfigWrite.hold = null;
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

		it( 'reports a key the keychain can’t return, rather than no key', async () => {
			const { settings, storage } = await load();
			await settings.saveOpenAiApiKey( KEY );
			const reason = 'Couldn’t read from the system keychain: User interaction is not allowed.';
			// The keychain answers, but can't return its item just now (a locked item, say).
			keychain.current!.store.get = async () => {
				throw new storage.SecureStorageError( reason );
			};

			const result = await settings.readAiSettings();

			expect( result ).toMatchObject( {
				hasOpenAiApiKey: false,
				openAi: { keyStorage: null, keyError: reason, secureStorage: 'available' },
			} );
			expectNoKeyOutsideKeychain( result );
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

		// The keychain may hold another project's key (A) while the app runs on a
		// session key (B): a turn that can't get B must not run on A.
		const closedChannel = () =>
			Object.assign( new EventEmitter(), {
				send: vi.fn( ( _message: unknown, callback: ( error: Error | null ) => void ) =>
					setImmediate( () => callback( new Error( 'Channel closed' ) ) )
				),
			} );
		it.each( [
			[
				'the app replies without a key',
				() => parentChannel( () => ( { type: 'studio.openai-session-key', key: null } ) ),
			],
			[ 'the channel to the app has closed', closedChannel ],
		] )( 'fails rather than use the keychain’s key when %s', async ( _case, channel ) => {
			keychain.current!.items.set( 'openai-api-key', OTHER_KEY );
			const { settings, credentials } = await load();
			credentials.acceptOpenAiSessionKeyFromParent( channel(), { [ OFFER ]: '1' } );

			await expect( credentials.readOpenAiKeySource() ).rejects.toBeInstanceOf(
				credentials.OpenAiSessionKeyUnavailableError
			);
			await expect( settings.readOpenAiApiKey() ).rejects.toThrow(
				/couldn’t get the OpenAI key kept for this session/
			);
			const shown = await settings.readAiSettings();
			expect( shown.hasOpenAiApiKey ).toBe( false );
			expect( JSON.stringify( shown ) ).not.toContain( OTHER_KEY.slice( -4 ) );
		} );

		it( 'fails rather than use the keychain’s key when the app never answers', async () => {
			keychain.current!.items.set( 'openai-api-key', OTHER_KEY );
			const { credentials } = await load();
			const channel = parentChannel( () => undefined );
			credentials.acceptOpenAiSessionKeyFromParent( channel, { [ OFFER ]: '1' } );
			vi.useFakeTimers();
			try {
				const source = credentials.readOpenAiKeySource();
				const outcome = expect( source ).rejects.toBeInstanceOf(
					credentials.OpenAiSessionKeyUnavailableError
				);
				await vi.advanceTimersByTimeAsync( 10_000 );
				await outcome;
			} finally {
				vi.useRealTimers();
			}
			expect( channel.listenerCount( 'message' ) ).toBe( 0 );
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
		// Each arrives with HTTP 200 but isn't a model list Studio can read.
		const unreadable = () =>
			new Response( '{"object":"list","data":[{"id":"gpt-6', { status: 200 } );
		const brokenStream = () =>
			new Response(
				new ReadableStream( {
					start( controller ) {
						controller.enqueue( new TextEncoder().encode( '{"object":"list","da' ) );
						controller.error( new Error( 'socket hang up' ) );
					},
				} ),
				{ status: 200 }
			);
		const wrongShape = () =>
			new Response( JSON.stringify( { models: [ { id: 'gpt-6.1-sol' } ] } ), { status: 200 } );

		it.each( [
			[ 'truncated JSON', unreadable, 'unknown' ],
			[ 'a stream that breaks off', brokenStream, 'interrupted' ],
			[ 'an unexpected envelope', wrongShape, 'unknown' ],
		] )( 'keeps the previous list after %s', async ( _case, response, kind ) => {
			const { settings } = await load();
			await settings.saveOpenAiApiKey( KEY );
			const before = ( await settings.readAiSettings() ).openAi.models;
			expect( before.availableModelIds ).toEqual( [ 'gpt-6.1-sol', 'gpt-6-luna' ] );

			fetchMock.mockResolvedValue( response() );
			const after = await settings.refreshOpenAiModels();

			expect( after.openAi.models.availableModelIds ).toEqual( before.availableModelIds );
			expect( after.openAi.models.checkedAt ).toBe( before.checkedAt );
			expect( after.openAi.models.lastError?.kind ).toBe( kind );
		} );

		it( 'never applies one key’s model list to another key', async () => {
			// Key A, in the keychain, lists Sol and Luna.
			await ( await load() ).settings.saveOpenAiApiKey( KEY );
			// The keychain can't be reached; a session key for another project lists only Astra.
			keychain.current!.state.available = false;
			fetchMock.mockResolvedValue( modelList( 'gpt-6-astra' ) );
			const withSessionKey = await (
				await load()
			).settings.saveOpenAiApiKey( OTHER_KEY, {
				storage: 'session',
			} );
			expect( withSessionKey.openAi.models.availableModelIds ).toEqual( [ 'gpt-6-astra' ] );

			// After a restart with the keychain back, A is in use again.
			keychain.current!.state.available = true;
			const restarted = await load();
			const settings = await restarted.settings.readAiSettings();

			expect( settings.openAi.keyHint ).toBe( '…wxyz' );
			expect( settings.openAi.models ).toMatchObject( {
				availableModelIds: null,
				checkedAt: null,
				lastError: null,
			} );
			expectNoKeyOutsideKeychain( settings );

			fetchMock.mockResolvedValue( modelList( 'gpt-6.1-sol', 'gpt-6-luna' ) );
			const refreshed = await restarted.settings.refreshOpenAiModels();
			expect( refreshed.openAi.models.availableModelIds ).toEqual( [
				'gpt-6.1-sol',
				'gpt-6-luna',
			] );
		} );

		it( 'accepts a list that is genuinely empty', async () => {
			const { settings } = await load();
			await settings.saveOpenAiApiKey( KEY );

			fetchMock.mockResolvedValue( modelList() );
			const after = await settings.refreshOpenAiModels();

			expect( after.openAi.models.availableModelIds ).toEqual( [] );
			expect( after.openAi.models.lastError ).toBeNull();
		} );

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

		it( 'keeps a default another app changed while this change waited to be written', async () => {
			const { settings } = await load();
			let resume!: () => void;
			sharedConfigWrite.hold = new Promise< void >( ( resolve ) => ( resume = resolve ) );

			// The reasoning is changed in one app and the model in another at the same time.
			const choosingEffort = settings.setOpenAiDefaults( { reasoningEffort: 'high' } );
			await vi.waitFor( () => expect( sharedConfigWrite.hold ).toBeNull() );
			await settings.setOpenAiDefaults( { model: 'gpt-6-astra' } );
			resume();
			await choosingEffort;

			expect( readShared() ).toMatchObject( {
				openaiDefaultModel: 'gpt-6-astra',
				openaiDefaultReasoningEffort: 'high',
			} );
		} );

		it( 'keeps the effort a new model has, and gives it its starting effort otherwise', async () => {
			const { settings } = await load();
			await settings.setOpenAiDefaults( { model: 'gpt-6-luna', reasoningEffort: 'high' } );
			await expect( settings.setOpenAiDefaults( { model: 'gpt-6-astra' } ) ).resolves.toMatchObject(
				{ openAi: { defaultModel: 'gpt-6-astra', defaultReasoningEffort: 'high' } }
			);

			await settings.setOpenAiDefaults( { model: 'gpt-6-luna', reasoningEffort: 'none' } );
			await expect( settings.setOpenAiDefaults( { model: 'gpt-6-astra' } ) ).resolves.toMatchObject(
				{ openAi: { defaultModel: 'gpt-6-astra', defaultReasoningEffort: 'medium' } }
			);
		} );

		it( 'checks a change against the defaults another app saved while it waited', async () => {
			const { settings } = await load();
			await settings.setOpenAiDefaults( { model: 'gpt-6-luna' } );
			let resume!: () => void;
			sharedConfigWrite.hold = new Promise< void >( ( resolve ) => ( resume = resolve ) );

			// “None” suits the model shown when it was chosen, not the one saved meanwhile.
			const choosingEffort = settings.setOpenAiDefaults( { reasoningEffort: 'none' } );
			await vi.waitFor( () => expect( sharedConfigWrite.hold ).toBeNull() );
			await settings.setOpenAiDefaults( { model: 'gpt-6-astra', reasoningEffort: 'high' } );
			resume();
			await expect( choosingEffort ).rejects.toThrow( /doesn’t support “None” reasoning/ );

			expect( readShared() ).toMatchObject( {
				openaiDefaultModel: 'gpt-6-astra',
				openaiDefaultReasoningEffort: 'high',
			} );
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
			await ( await load() ).settings.saveOpenAiApiKey( KEY );
			const shared = readShared();
			fs.writeFileSync(
				sharedConfigPath(),
				JSON.stringify( {
					...shared,
					openaiModels: {
						...shared.openaiModels,
						checkedAt: '2026-01-01T00:00:00.000Z',
						catalogVersion: '2026-01-01',
					},
				} )
			);
			const { settings } = await load();
			await expect( settings.readAiSettings() ).resolves.toMatchObject( {
				openAi: { models: { availableModelIds: null, checkedAt: '2026-01-01T00:00:00.000Z' } },
			} );
		} );

		it( 'keeps only a fingerprint of the key beside the list', async () => {
			await ( await load() ).settings.saveOpenAiApiKey( KEY );

			const stored = readShared().openaiModels;
			expect( stored.keyFingerprint ).toMatch( /^[0-9a-f]{16}$/ );
			expect( readSharedText() ).not.toContain( KEY );
			expect( readSharedText() ).not.toContain( KEY.slice( 'sk-proj-'.length, 24 ) );
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

		it( 'never leaves OpenAI the default once the key is removed during the switch', async () => {
			const { settings } = await load();
			await settings.saveOpenAiApiKey( KEY );
			let answerList!: ( response: Response ) => void;
			fetchMock.mockImplementationOnce(
				() => new Promise< Response >( ( resolve ) => ( answerList = resolve ) )
			);

			// The switch checks the key with OpenAI; Remove key is pressed meanwhile.
			const switching = settings.setAiProvider( 'openai-api-key' );
			await vi.waitFor( () => expect( answerList ).toBeDefined() );
			const removing = settings.removeOpenAiApiKey();
			answerList( modelList( 'gpt-6.1-sol' ) );
			await Promise.allSettled( [ switching, removing ] );

			await expect( settings.readAiSettings() ).resolves.toMatchObject( {
				provider: 'wpcom',
				hasOpenAiApiKey: false,
			} );
		} );

		it( 'never lets a first write put legacy settings back over one made meanwhile', async () => {
			fs.writeFileSync(
				path.join( configDir, 'cli.json' ),
				JSON.stringify( {
					version: 1,
					sites: [],
					snapshots: [],
					aiProvider: 'anthropic-api-key',
					anthropicApiKey: 'sk-ant-TESTONLY_legacy_dddddddddddd',
				} )
			);
			const { settings } = await load();
			fetchMock.mockImplementation( async () => new Response( '{}', { status: 200 } ) );
			let resume!: () => void;
			sharedConfigWrite.hold = new Promise< void >( ( resolve ) => ( resume = resolve ) );

			// Both are first writes to shared.json; WordPress.com is chosen while the save waits.
			const saving = settings.saveAnthropicApiKey( 'sk-ant-TESTONLY_new_eeeeeeeeeeeeeeee' );
			await vi.waitFor( () => expect( sharedConfigWrite.hold ).toBeNull() );
			await settings.setAiProvider( 'wpcom' );
			resume();
			await saving;

			expect( readShared() ).toMatchObject( {
				aiProvider: 'wpcom',
				anthropicApiKey: 'sk-ant-TESTONLY_new_eeeeeeeeeeeeeeee',
			} );
		} );

		it( 'never lets an Anthropic key save put back the OpenAI default a removal cleared', async () => {
			const { settings } = await load();
			await settings.saveOpenAiApiKey( KEY );
			await settings.setAiProvider( 'openai-api-key' );
			fetchMock.mockImplementation( async () => new Response( '{}', { status: 200 } ) );
			let resume!: () => void;
			sharedConfigWrite.hold = new Promise< void >( ( resolve ) => ( resume = resolve ) );

			// The Anthropic save has read the settings and waits to write; the OpenAI key goes meanwhile.
			const saving = settings.saveAnthropicApiKey( 'sk-ant-TESTONLY_cccccccccccccccccccc' );
			await vi.waitFor( () => expect( sharedConfigWrite.hold ).toBeNull() );
			await settings.removeOpenAiApiKey();
			resume();
			await saving;

			await expect( settings.readAiSettings() ).resolves.toMatchObject( {
				provider: 'wpcom',
				hasOpenAiApiKey: false,
				hasAnthropicApiKey: true,
			} );
		} );
	} );
} );
