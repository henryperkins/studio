// @vitest-environment node
import { mkdtemp, rm, writeFile as writeFileNow } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getSharedConfigPath } from '@studio/common/lib/well-known-paths';
import { readFile } from 'atomically';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getImageServiceState } from 'src/modules/user-settings/lib/ipc-handlers';

// Test values only; nothing here reaches WordPress.com.
const LOGIN_TOKEN = 'test-wpcom-login-token';
let configDir: string;

beforeEach( async () => {
	configDir = await mkdtemp( path.join( os.tmpdir(), 'studio-image-service-ipc-' ) );
	vi.stubEnv( 'DEV_CONFIG_DIR', configDir );
	vi.stubEnv( 'STUDIO_IMAGE_API_TOKEN', '' );
} );

afterEach( async () => {
	vi.unstubAllEnvs();
	await rm( configDir, { recursive: true, force: true } );
} );

describe( 'image service desktop IPC boundary', () => {
	it( 'says what sets the image service up while Studio has no WordPress.com login', async () => {
		await expect( getImageServiceState() ).resolves.toEqual( {
			available: false,
			service: 'wordpress-com',
			reason: 'signed-out',
			setup: 'wordpress-com-login',
		} );
	} );

	it( 'names the WordPress.com account it acts as, never its token', async () => {
		// The Desktop tests stub `atomically`, so the stored login is read through it.
		const config = JSON.stringify( {
			version: 1,
			authToken: {
				accessToken: LOGIN_TOKEN,
				expiresIn: 60,
				expirationTime: Date.now() + 60_000,
				id: 42,
				email: 'someone@example.test',
				displayName: 'Someone',
			},
		} );
		await writeFileNow( getSharedConfigPath(), config );
		vi.mocked( readFile ).mockResolvedValueOnce( config as never );

		const state = await getImageServiceState();

		expect( state ).toEqual( {
			available: true,
			service: 'wordpress-com',
			credential: 'wordpress-com-login',
			account: { displayName: 'Someone', email: 'someone@example.test' },
		} );
		expect( JSON.stringify( state ) ).not.toContain( LOGIN_TOKEN );
	} );
} );
