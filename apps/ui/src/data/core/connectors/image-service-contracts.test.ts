import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIpcConnector } from './ipc';
import { createLocalConnector } from './local';
import type { ImageServiceState } from '@studio/agent/protocol/image-service';

const STATE: ImageServiceState = {
	available: true,
	service: 'wordpress-com',
	credential: 'wordpress-com-login',
	account: { displayName: 'Someone', email: 'someone@example.test' },
};

beforeEach( () => vi.stubGlobal( 'ipcListener', { subscribe: vi.fn() } ) );
afterEach( () => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
} );

describe( 'image service connector contracts', () => {
	it( 'reads the image service through Desktop IPC', async () => {
		const api = { getImageServiceState: vi.fn( async () => STATE ) };
		vi.stubGlobal( 'ipcApi', api );

		await expect( createIpcConnector().getImageServiceState() ).resolves.toEqual( STATE );
		expect( api.getImageServiceState ).toHaveBeenCalledExactlyOnceWith();
	} );

	it( 'reads the same image service from the studio ui backend', async () => {
		const fetch = vi.fn( async () => new Response( JSON.stringify( STATE ) ) );
		vi.stubGlobal( 'fetch', fetch );

		await expect(
			createLocalConnector( { apiBaseUrl: 'http://localhost:8081' } ).getImageServiceState()
		).resolves.toEqual( STATE );
		expect( fetch ).toHaveBeenCalledWith(
			'http://localhost:8081/api/image-service',
			expect.not.objectContaining( { method: expect.anything() } )
		);
	} );
} );
