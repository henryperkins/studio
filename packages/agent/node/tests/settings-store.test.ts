import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatGptSettingsError } from '@studio/agent/node/chatgpt/settings';
import {
	InvalidAnthropicApiKeyError,
	readAiSettings,
	saveAnthropicApiKey,
	setAiProvider,
} from '@studio/agent/node/settings-store';
import { createDisconnectedOpenAiSettings } from '@studio/agent/protocol/providers';
import { createFakeCredentialStore } from './fake-credential-store';

// Never the real system keychain from a unit test.
vi.mock( '@studio/common/lib/os-credential-store', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/common/lib/os-credential-store') >() ),
	createOsCredentialStore: () => createFakeCredentialStore().store,
} ) );

const NO_OPENAI = { hasOpenAiApiKey: false, openAi: createDisconnectedOpenAiSettings() };

describe( 'ai settings store', () => {
	let configDir: string;
	let previousDevConfigDir: string | undefined;

	const sharedConfigPath = () => path.join( configDir, 'shared.json' );
	const cliConfigPath = () => path.join( configDir, 'cli.json' );
	const readShared = () => JSON.parse( fs.readFileSync( sharedConfigPath(), 'utf8' ) );

	beforeEach( () => {
		configDir = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-ai-settings-' ) );
		previousDevConfigDir = process.env.DEV_CONFIG_DIR;
		process.env.DEV_CONFIG_DIR = configDir;
		// Selecting the Anthropic provider validates the key; default to "valid".
		vi.stubGlobal( 'fetch', vi.fn().mockResolvedValue( { ok: true, status: 200 } ) );
	} );

	afterEach( () => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		if ( previousDevConfigDir === undefined ) {
			delete process.env.DEV_CONFIG_DIR;
		} else {
			process.env.DEV_CONFIG_DIR = previousDevConfigDir;
		}
		fs.rmSync( configDir, { recursive: true, force: true } );
	} );

	it( 'defaults to WordPress.com when no config exists', async () => {
		await expect( readAiSettings() ).resolves.toEqual( {
			provider: 'wpcom',
			hasAnthropicApiKey: false,
			anthropicApiKeyPreview: null,
			...NO_OPENAI,
		} );
	} );

	it( 'saves an accepted key to shared.json without changing the provider', async () => {
		const settings = await saveAnthropicApiKey( 'sk-ant-api03-testkey-abcd1234' );

		expect( settings ).toEqual( {
			provider: 'wpcom',
			hasAnthropicApiKey: true,
			anthropicApiKeyPreview: 'sk-ant-api03-tes...1234',
			...NO_OPENAI,
		} );
		expect( readShared().anthropicApiKey ).toBe( 'sk-ant-api03-testkey-abcd1234' );
		expect( fs.existsSync( cliConfigPath() ) ).toBe( false );
	} );

	it( 'reads legacy values from cli.json and migrates them on write', async () => {
		fs.writeFileSync(
			cliConfigPath(),
			JSON.stringify( {
				version: 1,
				sites: [],
				snapshots: [],
				aiProvider: 'anthropic-api-key',
				anthropicApiKey: 'sk-ant-api03-legacykey-9999',
			} )
		);

		await expect( readAiSettings() ).resolves.toMatchObject( {
			provider: 'anthropic-api-key',
			hasAnthropicApiKey: true,
		} );

		await setAiProvider( 'wpcom' );

		expect( readShared() ).toMatchObject( {
			aiProvider: 'wpcom',
			anthropicApiKey: 'sk-ant-api03-legacykey-9999',
		} );
	} );

	it( 'does not store a key Anthropic rejects, but stores an unverifiable one', async () => {
		vi.stubGlobal( 'fetch', vi.fn().mockResolvedValue( { ok: false, status: 401 } ) );
		await expect( saveAnthropicApiKey( 'sk-ant-api03-rejected' ) ).rejects.toBeInstanceOf(
			InvalidAnthropicApiKeyError
		);
		await expect( readAiSettings() ).resolves.toMatchObject( { hasAnthropicApiKey: false } );
		expect( fs.existsSync( sharedConfigPath() ) ).toBe( false );

		vi.stubGlobal( 'fetch', vi.fn().mockRejectedValue( new Error( 'offline' ) ) );
		await expect( saveAnthropicApiKey( 'sk-ant-api03-testkey-abcd1234' ) ).resolves.toMatchObject( {
			hasAnthropicApiKey: true,
		} );
	} );

	it( 'selects the Anthropic provider once its key is accepted', async () => {
		await saveAnthropicApiKey( 'sk-ant-api03-testkey-abcd1234' );

		await expect( setAiProvider( 'anthropic-api-key' ) ).resolves.toMatchObject( {
			provider: 'anthropic-api-key',
		} );
		expect( readShared().aiProvider ).toBe( 'anthropic-api-key' );
	} );

	it( 'refuses the Anthropic provider without a saved key', async () => {
		await expect( setAiProvider( 'anthropic-api-key' ) ).rejects.toBeInstanceOf(
			InvalidAnthropicApiKeyError
		);
	} );

	it.each( [ '', '1' ] )(
		'rejects a global ChatGPT default with the gate set to %j',
		async ( gate ) => {
			vi.stubEnv( 'STUDIO_EXPERIMENTAL_CHATGPT', gate );
			const config = JSON.stringify( { version: 1, aiProvider: 'openai-api-key', locale: 'es' } );
			fs.writeFileSync( sharedConfigPath(), config );

			await expect( setAiProvider( 'chatgpt-oauth' ) ).rejects.toBeInstanceOf(
				ChatGptSettingsError
			);

			expect( fs.readFileSync( sharedConfigPath(), 'utf8' ) ).toBe( config );
			expect( fetch ).not.toHaveBeenCalled();
		}
	);

	it( 'does not create global settings when ChatGPT is requested as the default', async () => {
		await expect( setAiProvider( 'chatgpt-oauth' ) ).rejects.toThrow(
			'Choose a ChatGPT account in a new chat instead of setting a default provider.'
		);
		expect( fs.existsSync( sharedConfigPath() ) ).toBe( false );
	} );

	it( 'clears the key, falls back to WordPress.com, and preserves unrelated fields', async () => {
		fs.writeFileSync(
			sharedConfigPath(),
			JSON.stringify( {
				version: 1,
				anthropicApiKey: 'sk-ant-api03-testkey-abcd1234',
				aiProvider: 'anthropic-api-key',
				locale: 'es',
			} )
		);

		const settings = await saveAnthropicApiKey( null );

		expect( settings ).toEqual( {
			provider: 'wpcom',
			hasAnthropicApiKey: false,
			anthropicApiKeyPreview: null,
			...NO_OPENAI,
		} );
		const written = readShared();
		expect( written.anthropicApiKey ).toBeUndefined();
		expect( written ).toMatchObject( { aiProvider: 'wpcom', locale: 'es' } );
	} );

	it( 'keeps OpenAI the default when the Anthropic key is cleared', async () => {
		fs.writeFileSync(
			sharedConfigPath(),
			JSON.stringify( {
				version: 1,
				anthropicApiKey: 'sk-ant-api03-testkey-abcd1234',
				aiProvider: 'openai-api-key',
			} )
		);

		const settings = await saveAnthropicApiKey( null );

		expect( settings ).toMatchObject( { provider: 'openai-api-key', hasAnthropicApiKey: false } );
		expect( readShared() ).toMatchObject( { aiProvider: 'openai-api-key' } );
		expect( readShared().anthropicApiKey ).toBeUndefined();
	} );

	it( 'trims the key and treats a blank one as cleared', async () => {
		const settings = await saveAnthropicApiKey( '  sk-ant-api03-testkey-abcd1234  ' );
		expect( settings.anthropicApiKeyPreview ).toBe( 'sk-ant-api03-tes...1234' );
		expect( readShared().anthropicApiKey ).toBe( 'sk-ant-api03-testkey-abcd1234' );

		await expect( saveAnthropicApiKey( '   ' ) ).resolves.toMatchObject( {
			hasAnthropicApiKey: false,
			provider: 'wpcom',
		} );
	} );

	it( 'previews a short key by its tail only, never most of the key', async () => {
		const settings = await saveAnthropicApiKey( 'sk-short-key-1234' );

		expect( settings.anthropicApiKeyPreview ).toBe( '...1234' );
	} );

	it( 'refuses a rejected key on switch but accepts an unverifiable one', async () => {
		await saveAnthropicApiKey( 'sk-ant-api03-testkey-abcd1234' );

		vi.stubGlobal( 'fetch', vi.fn().mockResolvedValue( { ok: false, status: 401 } ) );
		await expect( setAiProvider( 'anthropic-api-key' ) ).rejects.toBeInstanceOf(
			InvalidAnthropicApiKeyError
		);
		await expect( readAiSettings() ).resolves.toMatchObject( { provider: 'wpcom' } );

		vi.stubGlobal( 'fetch', vi.fn().mockRejectedValue( new Error( 'offline' ) ) );
		await expect( setAiProvider( 'anthropic-api-key' ) ).resolves.toMatchObject( {
			provider: 'anthropic-api-key',
		} );
	} );

	it( 'treats an unknown stored provider as the default', async () => {
		fs.writeFileSync(
			cliConfigPath(),
			JSON.stringify( { version: 1, aiProvider: 'claude-code' } )
		);

		await expect( readAiSettings() ).resolves.toMatchObject( { provider: 'wpcom' } );
	} );
} );
