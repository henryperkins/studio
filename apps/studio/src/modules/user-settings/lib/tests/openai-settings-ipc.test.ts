/**
 * @vitest-environment node
 */
import { IpcMainInvokeEvent } from 'electron';
import {
	readAiSettings,
	saveOpenAiApiKey as saveOpenAiApiKeyToConfig,
	setOpenAiDefaults as setOpenAiDefaultsInConfig,
} from '@studio/agent/node/settings-store';
import { createDisconnectedOpenAiSettings } from '@studio/agent/protocol/providers';
import { vi } from 'vitest';
import { saveOpenAiApiKey, setOpenAiDefaults } from 'src/modules/user-settings/lib/ipc-handlers';

vi.mock( 'electron', () => ( {
	BrowserWindow: { fromWebContents: vi.fn() },
	nativeTheme: {},
	systemPreferences: { setUserDefault: vi.fn() },
} ) );
vi.mock( 'src/lib/tracks', async ( importActual ) => ( {
	...( await importActual< typeof import('src/lib/tracks') >() ),
	recordTracksEvent: vi.fn(),
} ) );
vi.mock( '@studio/agent/node/settings-store', () => ( {
	readAiSettings: vi.fn(),
	saveOpenAiApiKey: vi.fn(),
	setOpenAiDefaults: vi.fn(),
} ) );

const KEY = 'sk-proj-TESTONLY_desktop_ffffffffffffffffffffffffff';
const event = {} as IpcMainInvokeEvent;
const settings = {
	provider: 'wpcom' as const,
	hasAnthropicApiKey: false,
	anthropicApiKeyPreview: null,
	hasOpenAiApiKey: true,
	openAi: {
		...createDisconnectedOpenAiSettings(),
		keyStorage: 'keychain' as const,
		keyHint: '…ffff',
	},
};

describe( 'OpenAI settings over IPC', () => {
	beforeEach( () => {
		vi.mocked( readAiSettings ).mockResolvedValue( settings );
		vi.mocked( saveOpenAiApiKeyToConfig ).mockResolvedValue( settings );
		vi.mocked( setOpenAiDefaultsInConfig ).mockResolvedValue( settings );
	} );

	it( 'passes the key to the settings store and returns only its hint', async () => {
		const result = await saveOpenAiApiKey( event, KEY, 'session' );

		expect( saveOpenAiApiKeyToConfig ).toHaveBeenCalledWith( KEY, { storage: 'session' } );
		expect( JSON.stringify( result ) ).not.toContain( KEY );
	} );

	it.each( [
		[ 42, 'keychain' ],
		[ KEY, 'plaintext-file' ],
		[ KEY, undefined ],
	] )( 'refuses key %j with storage %j from the renderer', async ( key, storage ) => {
		await expect( saveOpenAiApiKey( event, key, storage ) ).rejects.toThrow();
		expect( saveOpenAiApiKeyToConfig ).not.toHaveBeenCalled();
	} );

	it( 'refuses defaults that aren’t an object', async () => {
		await expect( setOpenAiDefaults( event, null as never ) ).rejects.toThrow();
		await setOpenAiDefaults( event, { reasoningEffort: 'high' } );
		expect( setOpenAiDefaultsInConfig ).toHaveBeenCalledWith( { reasoningEffort: 'high' } );
	} );
} );
