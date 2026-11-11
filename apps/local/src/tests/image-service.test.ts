// @vitest-environment node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { updateSharedConfig } from '@studio/common/lib/shared-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startLocalServer, type LocalServer } from '../index';

// Test values only; nothing here reaches WordPress.com.
const LOGIN_TOKEN = 'test-wpcom-login-token';
const IMAGE_TOKEN = 'test-image-service-token';
let root: string;
let server: LocalServer;

const read = async () => {
	const response = await fetch( `${ server.url }/api/image-service` );
	return { status: response.status, text: await response.text() };
};

beforeEach( async () => {
	root = await fs.mkdtemp( path.join( os.tmpdir(), 'studio-image-service-http-' ) );
	vi.stubEnv( 'DEV_CONFIG_DIR', root );
	vi.stubEnv( 'STUDIO_IMAGE_API_TOKEN', '' );
	server = await startLocalServer( {
		cliBinary: path.join( root, 'cli.mjs' ),
		sessionsRoot: root,
		sitesRoot: root,
		port: 0,
	} );
} );

afterEach( async () => {
	await server.close();
	vi.unstubAllEnvs();
	await fs.rm( root, { recursive: true, force: true } );
} );

describe( 'image service HTTP boundary', () => {
	it( 'says what sets the image service up while Studio has no WordPress.com login', async () => {
		const { status, text } = await read();

		expect( status ).toBe( 200 );
		expect( JSON.parse( text ) ).toEqual( {
			available: false,
			service: 'wordpress-com',
			reason: 'signed-out',
			setup: 'wordpress-com-login',
		} );
	} );

	it( 'names the WordPress.com account it acts as, never its token', async () => {
		await updateSharedConfig( {
			authToken: {
				accessToken: LOGIN_TOKEN,
				expiresIn: 60,
				expirationTime: Date.now() + 60_000,
				id: 42,
				email: 'someone@example.test',
				displayName: 'Someone',
			},
		} );

		const { text } = await read();

		expect( JSON.parse( text ) ).toEqual( {
			available: true,
			service: 'wordpress-com',
			credential: 'wordpress-com-login',
			account: { displayName: 'Someone', email: 'someone@example.test' },
		} );
		expect( text ).not.toContain( LOGIN_TOKEN );
	} );

	it( 'reports a token set for the image service without the token', async () => {
		vi.stubEnv( 'STUDIO_IMAGE_API_TOKEN', IMAGE_TOKEN );

		const { text } = await read();

		expect( JSON.parse( text ) ).toEqual( {
			available: true,
			service: 'wordpress-com',
			credential: 'environment-token',
			account: null,
		} );
		expect( text ).not.toContain( IMAGE_TOKEN );
	} );
} );
