/**
 * @vitest-environment node
 */
import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import {
	InvalidAnthropicApiKeyError,
	InvalidOpenAiApiKeyError,
	OpenAiSettingsError,
} from '@studio/agent/node/settings-store';
import { createDisconnectedOpenAiSettings } from '@studio/agent/protocol/providers';
import { createCliRunner } from '@studio/common/lib/cli-process';
import { SecureStorageError } from '@studio/common/lib/os-credential-store';
import { listSites } from '@studio/common/sites/list';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startLocalServer } from '../../local/src/index';
import type { LocalServer } from '../../local/src/index';

const mocks = vi.hoisted( () => ( {
	execute: vi.fn(),
	killAll: vi.fn(),
	readSitePath: vi.fn(),
	readAiSettings: vi.fn(),
	saveAnthropicApiKey: vi.fn(),
	setAiProvider: vi.fn(),
	saveOpenAiApiKey: vi.fn(),
	removeOpenAiApiKey: vi.fn(),
	refreshOpenAiModels: vi.fn(),
	setOpenAiDefaults: vi.fn(),
	setSessionOpenAiSelection: vi.fn(),
} ) );

vi.mock( '@studio/common/lib/cli-process', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/common/lib/cli-process') >() ),
	killChild: vi.fn( ( child: { kill: () => void } ) => child.kill() ),
	createCliRunner: vi.fn( () => ( {
		executeCliCommand: mocks.execute,
		killAll: mocks.killAll,
	} ) ),
} ) );
vi.mock( '@studio/common/sites/list', () => ( { listSites: vi.fn() } ) );
vi.mock( '@studio/common/sites/site-path', () => ( { readSitePath: mocks.readSitePath } ) );
vi.mock( '@studio/agent/node/settings-store', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/agent/node/settings-store') >() ),
	readAiSettings: mocks.readAiSettings,
	saveAnthropicApiKey: mocks.saveAnthropicApiKey,
	setAiProvider: mocks.setAiProvider,
	saveOpenAiApiKey: mocks.saveOpenAiApiKey,
	removeOpenAiApiKey: mocks.removeOpenAiApiKey,
	refreshOpenAiModels: mocks.refreshOpenAiModels,
	setOpenAiDefaults: mocks.setOpenAiDefaults,
} ) );
vi.mock( '@studio/agent/node/sessions/openai-selection', () => ( {
	setSessionOpenAiSelection: mocks.setSessionOpenAiSelection,
} ) );
vi.mock( '@studio/agent/node/run-manager', () => ( {
	createAgentRunManager: vi.fn( () => ( {
		startAgentRun: vi.fn(),
		listActiveAgentRuns: vi.fn( () => [] ),
		interruptAgentRun: vi.fn(),
		answerAgentRun: vi.fn(),
	} ) ),
} ) );
vi.mock( '@studio/common/sites/snapshots', () => ( {
	publishPreviewSite: vi.fn(),
	fetchSnapshots: vi.fn( async () => [] ),
} ) );

describe( 'local web server Connect contracts', () => {
	let server: LocalServer;

	beforeEach( async () => {
		vi.clearAllMocks();
		nock.enableNetConnect( /^(localhost|127\.0\.0\.1)/ );
		vi.mocked( createCliRunner ).mockReturnValue( {
			executeCliCommand: mocks.execute,
			killAll: mocks.killAll,
		} as never );
		vi.mocked( listSites ).mockResolvedValue( [
			{
				id: 'local-a',
				name: 'Local A',
				path: '/sites/local-a',
				port: 8881,
				url: 'http://localhost:8881',
				phpVersion: '8.4',
				running: false,
			},
		] );
		mocks.readSitePath.mockImplementation( async ( siteId: string ) =>
			siteId === 'local-a' ? '/sites/local-a' : null
		);
		mocks.execute.mockImplementation( () => {
			const emitter = new EventEmitter();
			queueMicrotask( () => emitter.emit( 'success' ) );
			return [ emitter, {} ];
		} );
		mocks.readAiSettings.mockResolvedValue( {
			provider: 'wpcom',
			hasAnthropicApiKey: false,
			anthropicApiKeyPreview: null,
		} );
		mocks.saveAnthropicApiKey.mockImplementation( async ( key: string | null ) => ( {
			provider: 'wpcom',
			hasAnthropicApiKey: key !== null,
			anthropicApiKeyPreview: key === null ? null : key.trim().slice( -4 ),
		} ) );
		mocks.setAiProvider.mockImplementation( async ( provider: string ) => ( {
			provider,
			hasAnthropicApiKey: true,
			anthropicApiKeyPreview: '1234',
		} ) );
		server = await startLocalServer( {
			cliBinary: '/mock/cli.mjs',
			sessionsRoot: '/sessions',
			sitesRoot: '/sites',
			port: 0,
			host: '127.0.0.1',
		} );
	} );

	afterEach( async () => {
		await server.close();
		nock.disableNetConnect();
	} );

	it( 'reports the AI provider settings without the key itself', async () => {
		const response = await fetch(
			`${ server.url.replace( 'localhost', '127.0.0.1' ) }/api/ai-settings`
		);

		expect( response.status ).toBe( 200 );
		await expect( response.json() ).resolves.toEqual( {
			provider: 'wpcom',
			hasAnthropicApiKey: false,
			anthropicApiKeyPreview: null,
		} );
	} );

	it( 'passes the Anthropic API key to the settings store untouched', async () => {
		const response = await fetch(
			`${ server.url.replace( 'localhost', '127.0.0.1' ) }/api/ai-settings`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify( { anthropicApiKey: '  sk-ant-test-1234  ' } ),
			}
		);

		expect( response.status ).toBe( 200 );
		await expect( response.json() ).resolves.toMatchObject( {
			hasAnthropicApiKey: true,
			anthropicApiKeyPreview: '1234',
		} );
		expect( mocks.saveAnthropicApiKey ).toHaveBeenCalledWith( '  sk-ant-test-1234  ' );
	} );

	it( 'clears the Anthropic API key', async () => {
		const response = await fetch(
			`${ server.url.replace( 'localhost', '127.0.0.1' ) }/api/ai-settings`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify( { anthropicApiKey: null } ),
			}
		);

		expect( response.status ).toBe( 200 );
		await expect( response.json() ).resolves.toMatchObject( { hasAnthropicApiKey: false } );
		expect( mocks.saveAnthropicApiKey ).toHaveBeenCalledWith( null );
	} );

	it( 'returns 400 with the message when Anthropic rejects a key being saved', async () => {
		mocks.saveAnthropicApiKey.mockRejectedValueOnce(
			new InvalidAnthropicApiKeyError(
				'Anthropic rejected this API key. Check the key and try again.'
			)
		);

		const response = await fetch(
			`${ server.url.replace( 'localhost', '127.0.0.1' ) }/api/ai-settings`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify( { anthropicApiKey: 'sk-ant-rejected' } ),
			}
		);

		expect( response.status ).toBe( 400 );
		await expect( response.json() ).resolves.toEqual( {
			error: 'Anthropic rejected this API key. Check the key and try again.',
		} );
	} );

	it( 'rejects a non-string Anthropic API key', async () => {
		const response = await fetch(
			`${ server.url.replace( 'localhost', '127.0.0.1' ) }/api/ai-settings`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify( { anthropicApiKey: 42 } ),
			}
		);

		expect( response.status ).toBe( 400 );
		expect( mocks.saveAnthropicApiKey ).not.toHaveBeenCalled();
	} );

	it( 'switches the AI provider', async () => {
		const response = await fetch(
			`${ server.url.replace( 'localhost', '127.0.0.1' ) }/api/ai-settings/provider`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify( { provider: 'anthropic-api-key' } ),
			}
		);

		expect( response.status ).toBe( 200 );
		await expect( response.json() ).resolves.toMatchObject( { provider: 'anthropic-api-key' } );
		expect( mocks.setAiProvider ).toHaveBeenCalledWith( 'anthropic-api-key' );
	} );

	it( 'returns 400 with the message when Anthropic rejects the saved key', async () => {
		mocks.setAiProvider.mockRejectedValueOnce(
			new InvalidAnthropicApiKeyError(
				'Anthropic rejected this API key. Check the key and try again.'
			)
		);

		const response = await fetch(
			`${ server.url.replace( 'localhost', '127.0.0.1' ) }/api/ai-settings/provider`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify( { provider: 'anthropic-api-key' } ),
			}
		);

		expect( response.status ).toBe( 400 );
		await expect( response.json() ).resolves.toEqual( {
			error: 'Anthropic rejected this API key. Check the key and try again.',
		} );
	} );

	it( 'rejects an unknown AI provider', async () => {
		const response = await fetch(
			`${ server.url.replace( 'localhost', '127.0.0.1' ) }/api/ai-settings/provider`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify( { provider: 'claude-code' } ),
			}
		);

		expect( response.status ).toBe( 400 );
		expect( mocks.setAiProvider ).not.toHaveBeenCalled();
	} );

	it( 'rejects pinning a session to an unknown AI provider', async () => {
		const response = await fetch(
			`${ server.url.replace( 'localhost', '127.0.0.1' ) }/api/sessions/session-1/provider`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify( { provider: 'claude-code', model: 'claude-sonnet-5' } ),
			}
		);

		expect( response.status ).toBe( 400 );
		await expect( response.json() ).resolves.toEqual( {
			error: 'Unknown AI provider: claude-code',
		} );
	} );

	it( 'rejects pinning a session to a model its provider cannot serve', async () => {
		const response = await fetch(
			`${ server.url.replace( 'localhost', '127.0.0.1' ) }/api/sessions/session-1/provider`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify( { provider: 'anthropic-api-key', model: 'balanced' } ),
			}
		);

		expect( response.status ).toBe( 400 );
	} );

	describe( 'OpenAI', () => {
		const KEY = 'sk-proj-TESTONLY_local_eeeeeeeeeeeeeeeeeeeeeeeeeeee';
		const connected = {
			provider: 'wpcom',
			hasAnthropicApiKey: false,
			anthropicApiKeyPreview: null,
			hasOpenAiApiKey: true,
			openAi: { ...createDisconnectedOpenAiSettings(), keyStorage: 'keychain', keyHint: '…eeee' },
		};
		const request = ( path: string, init: RequestInit = {} ) =>
			fetch( `${ server.url.replace( 'localhost', '127.0.0.1' ) }/api${ path }`, {
				...init,
				headers: { 'Content-Type': 'application/json', ...init.headers },
			} );

		beforeEach( () => {
			mocks.saveOpenAiApiKey.mockResolvedValue( connected );
			mocks.removeOpenAiApiKey.mockResolvedValue( { ...connected, hasOpenAiApiKey: false } );
			mocks.refreshOpenAiModels.mockResolvedValue( connected );
			mocks.setOpenAiDefaults.mockResolvedValue( connected );
			mocks.setSessionOpenAiSelection.mockResolvedValue( undefined );
		} );

		it( 'passes a key to the settings store and never sends it back', async () => {
			const response = await request( '/ai-settings/openai-key', {
				method: 'POST',
				body: JSON.stringify( { key: KEY, storage: 'keychain' } ),
			} );

			expect( response.status ).toBe( 200 );
			const text = await response.text();
			expect( text ).not.toContain( KEY );
			expect( JSON.parse( text ) ).toMatchObject( { hasOpenAiApiKey: true } );
			expect( mocks.saveOpenAiApiKey ).toHaveBeenCalledWith( KEY, { storage: 'keychain' } );
		} );

		it.each( [
			[ { key: 42, storage: 'keychain' } ],
			[ { key: KEY, storage: 'plaintext-file' } ],
			[ { key: KEY } ],
		] )( 'rejects a malformed key request %j', async ( body ) => {
			const response = await request( '/ai-settings/openai-key', {
				method: 'POST',
				body: JSON.stringify( body ),
			} );

			expect( response.status ).toBe( 400 );
			expect( mocks.saveOpenAiApiKey ).not.toHaveBeenCalled();
		} );

		it.each( [
			[ new InvalidOpenAiApiKeyError( 'OpenAI didn’t accept the API key.' ), 400 ],
			[ new OpenAiSettingsError( 'Add an OpenAI API key first.' ), 400 ],
			[ new SecureStorageError( 'There is no system keychain here.' ), 409 ],
		] )( 'answers %s with status %i and its message', async ( error, status ) => {
			mocks.saveOpenAiApiKey.mockRejectedValueOnce( error );

			const response = await request( '/ai-settings/openai-key', {
				method: 'POST',
				body: JSON.stringify( { key: KEY, storage: 'keychain' } ),
			} );

			expect( response.status ).toBe( status );
			await expect( response.json() ).resolves.toEqual( { error: error.message } );
		} );

		it( 'removes the key, refreshes models and saves defaults', async () => {
			expect( ( await request( '/ai-settings/openai-key', { method: 'DELETE' } ) ).status ).toBe(
				200
			);
			expect( mocks.removeOpenAiApiKey ).toHaveBeenCalled();

			expect(
				( await request( '/ai-settings/openai-models/refresh', { method: 'POST' } ) ).status
			).toBe( 200 );
			expect( mocks.refreshOpenAiModels ).toHaveBeenCalled();

			const defaults = { model: 'gpt-6-luna', reasoningEffort: 'none' };
			const response = await request( '/ai-settings/openai-defaults', {
				method: 'PATCH',
				body: JSON.stringify( defaults ),
			} );
			expect( response.status ).toBe( 200 );
			expect( mocks.setOpenAiDefaults ).toHaveBeenCalledWith( defaults );
		} );

		it( 'pins a session to an OpenAI selection, and reports one it refuses', async () => {
			const selection = { model: 'gpt-6-astra', reasoningEffort: 'max', reasoningMode: 'pro' };
			const response = await request( '/sessions/chat-1/openai-selection', {
				method: 'POST',
				body: JSON.stringify( selection ),
			} );
			expect( response.status ).toBe( 204 );
			expect( mocks.setSessionOpenAiSelection ).toHaveBeenCalledWith(
				'/sessions',
				'chat-1',
				selection
			);

			mocks.setSessionOpenAiSelection.mockRejectedValueOnce(
				new OpenAiSettingsError( 'GPT-6 Astra doesn’t support “None” reasoning.' )
			);
			const refused = await request( '/sessions/chat-1/openai-selection', {
				method: 'POST',
				body: JSON.stringify( { ...selection, reasoningEffort: 'none' } ),
			} );
			expect( refused.status ).toBe( 400 );
		} );

		it( 'refuses OpenAI requests from another website', async () => {
			const response = await request( '/ai-settings/openai-key', {
				method: 'POST',
				headers: { Origin: 'https://attacker.example' },
				body: JSON.stringify( { key: KEY, storage: 'keychain' } ),
			} );

			expect( response.status ).toBe( 403 );
			expect( mocks.saveOpenAiApiKey ).not.toHaveBeenCalled();
		} );
	} );

	it( 'delegates deletion to the CLI cascade', async () => {
		const response = await fetch(
			`${ server.url.replace( 'localhost', '127.0.0.1' ) }/api/sites/local-a`,
			{ method: 'DELETE' }
		);

		expect( response.status ).toBe( 204 );
		expect( mocks.execute ).toHaveBeenCalledWith(
			[ 'site', 'delete', '--path', '/sites/local-a', '--files' ],
			{ output: 'capture' }
		);
	} );

	it( 'reports when the CLI cannot delete the local site', async () => {
		mocks.execute.mockImplementationOnce( () => {
			const emitter = new EventEmitter();
			queueMicrotask( () => emitter.emit( 'failure', { error: new Error( 'delete failed' ) } ) );
			return [ emitter, {} ];
		} );

		const response = await fetch(
			`${ server.url.replace( 'localhost', '127.0.0.1' ) }/api/sites/local-a`,
			{ method: 'DELETE' }
		);

		expect( response.status ).toBe( 500 );
	} );

	it( 'creates the Connect shell with --no-start', async () => {
		const siteId = '00000000-0000-4000-8000-000000000001';
		const randomUuid = vi.spyOn( crypto, 'randomUUID' ).mockReturnValue( siteId as never );
		mocks.execute.mockImplementationOnce( () => {
			const emitter = new EventEmitter();
			queueMicrotask( () => {
				emitter.emit( 'data', {
					data: {
						action: 'result',
						value: {
							id: siteId,
							name: 'Remote site',
							path: '/sites/remote-site',
							port: 8882,
							url: 'http://localhost:8882',
							phpVersion: '8.4',
							running: false,
						},
					},
				} );
				emitter.emit( 'success' );
			} );
			return [ emitter, {} ];
		} );

		try {
			const response = await fetch(
				`${ server.url.replace( 'localhost', '127.0.0.1' ) }/api/sites`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify( {
						name: 'Remote site',
						path: '/sites/remote-site',
						skipStart: true,
					} ),
				}
			);

			expect( response.status ).toBe( 200 );
			expect( mocks.execute.mock.calls.some( ( [ args ] ) => args.includes( '--no-start' ) ) ).toBe(
				true
			);
		} finally {
			randomUuid.mockRestore();
		}
	} );

	it( 'streams the sync activity the CLI publishes', async () => {
		const eventsCall = mocks.execute.mock.calls.findIndex(
			( [ args ] ) => args[ 0 ] === '_events'
		);
		const [ cliEvents ] = mocks.execute.mock.results[ eventsCall ].value;
		const baseUrl = server.url.replace( 'localhost', '127.0.0.1' );
		const eventsResponse = await fetch( `${ baseUrl }/api/events` );
		const reader = eventsResponse.body!.getReader();
		await reader.read();

		const event = { siteId: 'local-a', activity: { kind: 'pending', direction: 'pull' } };
		cliEvents.emit( 'data', {
			data: { action: 'keyValuePair', key: 'sync-event', value: JSON.stringify( event ) },
		} );
		const eventChunk = new TextDecoder().decode( ( await reader.read() ).value );
		await reader.cancel();

		expect( eventChunk ).toContain(
			JSON.stringify( { channel: 'sync-activity', payload: event } )
		);
	} );

	// A user cancel is reported as an outcome, not a 500 — the browser connector
	// turns it back into a cancelled error.
	it( 'reports a cancelled pull instead of failing the request', async () => {
		// The CLI never finishes on its own here, so the request only settles if the
		// cancel lands — which means we must not race it: wait until the pull has
		// actually started before asking for it to stop.
		let pullStarted: () => void = () => undefined;
		const started = new Promise< void >( ( resolve ) => {
			pullStarted = resolve;
		} );
		mocks.execute.mockImplementationOnce( () => {
			const emitter = new EventEmitter();
			queueMicrotask( pullStarted );
			// Exits when asked to stop, as a pull still safe to cancel does.
			const kill = () => emitter.emit( 'failure', { error: new Error( 'exited' ) } );
			return [ emitter, { kill } ];
		} );
		const baseUrl = server.url.replace( 'localhost', '127.0.0.1' );

		const pulling = fetch( `${ baseUrl }/api/sites/local-a/pull`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify( { remoteSiteId: 42 } ),
		} );
		await started;
		const cancelled = await fetch( `${ baseUrl }/api/sites/local-a/sync/cancel`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify( { remoteSiteId: 42 } ),
		} );

		expect( cancelled.status ).toBe( 204 );
		const response = await pulling;
		expect( response.status ).toBe( 200 );
		await expect( response.json() ).resolves.toEqual( { cancelled: true } );
	} );

	it( 'returns a signup URL that comes back through the local callback', async () => {
		const redirectUri = 'http://localhost:8081/auth/callback';
		const response = await fetch(
			`${ server.url.replace(
				'localhost',
				'127.0.0.1'
			) }/api/auth/login-url?signup=1&redirect_uri=${ encodeURIComponent( redirectUri ) }`
		);
		const { url } = ( await response.json() ) as { url: string };
		const signupUrl = new URL( url );
		const oauthUrl = new URL( signupUrl.searchParams.get( 'oauth2_redirect' ) ?? '' );

		expect( signupUrl.pathname ).toBe( '/start/wpcc/oauth2-user' );
		expect( oauthUrl.searchParams.get( 'redirect_uri' ) ).toBe( redirectUri );
	} );
} );
