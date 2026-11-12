// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeCredentialStore } from '../../tests/fake-credential-store';
import type {
	ChatGptSignIn,
	ChatGptTokenClient,
	ChatGptTokenSet,
} from '@studio/agent/node/chatgpt/credential-broker';

// Every lockfile the ChatGPT store takes, in order.
const locks = vi.hoisted( () => ( { taken: [] as string[] } ) );

vi.mock( '@studio/common/lib/lockfile', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/common/lib/lockfile') >();
	return {
		...actual,
		lockFileAsync: async ( ...args: Parameters< typeof actual.lockFileAsync > ) => {
			locks.taken.push( args[ 0 ] );
			return actual.lockFileAsync( ...args );
		},
	};
} );

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const repoRoot = path.resolve( import.meta.dirname, '..', '..', '..', '..', '..' );

const tokens = ( id: number | string, expiresIn = 3600 ): ChatGptTokenSet => ( {
	accessToken: `test-access-token-${ id }`,
	refreshToken: `test-refresh-token-${ id }`,
	idToken: `test-id-token-${ id }`,
	tokenType: 'Bearer',
	expiresIn,
	scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
} );

const signIn = (): ChatGptSignIn => ( {
	issuer: 'https://auth.openai.com',
	subject: 'test-subject-1',
	email: 'someone@example.com',
	clientId: 'test-issued-client-1',
	storage: 'vault',
	// About to expire, so the first token request refreshes it under its lock.
	tokens: tokens( 1, 60 ),
} );

let renewals = 0;
const tokenClient: ChatGptTokenClient = {
	refresh: async () => ( { ok: true, value: tokens( `renewed-${ ++renewals }` ) } ),
	revoke: async () => ( { ok: true, value: undefined } ),
};

// Fresh modules, so one test's choice of directory never reaches another.
async function load() {
	vi.resetModules();
	return {
		...( await import( '@studio/agent/node/chatgpt/state-directory' ) ),
		...( await import( '@studio/agent/node/chatgpt/account-store' ) ),
		...( await import( '@studio/agent/node/chatgpt/credential-broker' ) ),
	};
}

// A sign-in saved, refreshed, listed and signed out: every file and lock the store uses.
async function lifecycle( modules: Awaited< ReturnType< typeof load > > ) {
	const broker = modules.createChatGptCredentialBroker( {
		tokenClient,
		credentialStore: createFakeCredentialStore().store,
		timing: { turnSettleTimeoutMs: 200, revokeRetryDelaysMs: [ 1, 1 ] },
	} );
	const account = await broker.saveSignIn( signIn() );
	await broker.getAccessToken( account.registrationId );
	const listed = await broker.listConnections();
	const signedOut = await broker.signOut( account.registrationId );
	return { registrationId: account.registrationId, listed, signedOut };
}

const relativeLocks = ( root: string ) =>
	locks.taken.map( ( lock ) => path.relative( root, lock ).replace( UUID, '<registration>' ) );

const chatGptEntries = ( directory: string ) =>
	fs.existsSync( directory )
		? fs.readdirSync( directory ).filter( ( name ) => name.startsWith( 'chatgpt-' ) )
		: [];

describe( 'ChatGPT state directory', () => {
	let base: string;
	let configDir: string;
	let profileDir: string;
	let previousConfigDir: string | undefined;

	beforeEach( () => {
		base = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-chatgpt-state-' ) );
		configDir = path.join( base, 'config' );
		profileDir = path.join( base, 'dedicated-profile' );
		fs.mkdirSync( configDir );
		fs.mkdirSync( profileDir );
		previousConfigDir = process.env.DEV_CONFIG_DIR;
		process.env.DEV_CONFIG_DIR = configDir;
		locks.taken = [];
	} );

	afterEach( () => {
		if ( previousConfigDir === undefined ) {
			delete process.env.DEV_CONFIG_DIR;
		} else {
			process.env.DEV_CONFIG_DIR = previousConfigDir;
		}
		fs.rmSync( base, { recursive: true, force: true, maxRetries: 5 } );
	} );

	it( 'is the Studio config directory when unset: the same files, lockfiles and errors as before', async () => {
		const modules = await load();
		expect( modules.getChatGptStateDirectory() ).toBe( configDir );
		const { registrationId, listed, signedOut } = await lifecycle( modules );

		expect( listed ).toEqual( [ expect.objectContaining( { connectionId: registrationId } ) ] );
		expect( signedOut.localCleared ).toBe( true );
		expect( chatGptEntries( configDir ).sort() ).toEqual( [
			'chatgpt-accounts.json',
			'chatgpt-credentials',
		] );
		expect( new Set( relativeLocks( configDir ) ) ).toEqual(
			new Set( [
				'chatgpt-accounts.json.lock',
				path.join( 'chatgpt-credentials', 'vault-key.lock' ),
				path.join( 'chatgpt-credentials', '<registration>.lock' ),
			] )
		);

		fs.writeFileSync( path.join( configDir, 'chatgpt-accounts.json' ), '{ not json' );
		await expect( modules.readChatGptAccounts() ).rejects.toMatchObject( {
			name: 'ChatGptConnectionError',
			code: 'accounts-unreadable',
		} );
	} );

	it( 'keeps every read, write and lock of ChatGPT state in the directory set, and none in the config directory', async () => {
		const unset = await load();
		await lifecycle( unset );
		const before = relativeLocks( configDir );
		fs.rmSync( configDir, { recursive: true } );
		fs.mkdirSync( configDir );
		locks.taken = [];

		const modules = await load();
		modules.setChatGptStateDirectory( profileDir );
		expect( modules.getChatGptStateDirectory() ).toBe( profileDir );
		const { signedOut } = await lifecycle( modules );

		expect( signedOut.localCleared ).toBe( true );
		expect( chatGptEntries( profileDir ).sort() ).toEqual( [
			'chatgpt-accounts.json',
			'chatgpt-credentials',
		] );
		expect( fs.readdirSync( configDir ) ).toEqual( [] );
		expect( locks.taken.every( ( lock ) => lock.startsWith( profileDir + path.sep ) ) ).toBe(
			true
		);
		expect( relativeLocks( profileDir ) ).toEqual( before );
	} );

	it( 'accepts only an absolute, existing directory', async () => {
		const modules = await load();
		const file = path.join( base, 'a-file' );
		fs.writeFileSync( file, '' );
		for ( const [ directory, code ] of [
			[ 'relative/profile', 'not-absolute' ],
			[ path.join( base, 'missing' ), 'not-a-directory' ],
			[ file, 'not-a-directory' ],
		] ) {
			expect( () => modules.setChatGptStateDirectory( directory ) ).toThrow(
				expect.objectContaining( { name: 'ChatGptStateDirectoryError', code } )
			);
		}
		expect( modules.getChatGptStateDirectory() ).toBe( configDir );
	} );

	it( 'may be set, changed and cleared until ChatGPT state is first used', async () => {
		const modules = await load();
		const other = path.join( base, 'other-profile' );
		fs.mkdirSync( other );
		modules.setChatGptStateDirectory( profileDir );
		modules.setChatGptStateDirectory( other );
		modules.setChatGptStateDirectory( null );
		modules.setChatGptStateDirectory( profileDir );
		expect( modules.getChatGptStateDirectory() ).toBe( profileDir );
	} );

	it( 'refuses to move ChatGPT state to another directory once it has been used, but takes the same one again', async () => {
		const modules = await load();
		const other = path.join( base, 'other-profile' );
		fs.mkdirSync( other );
		modules.setChatGptStateDirectory( profileDir );
		await modules.readChatGptAccounts();

		for ( const directory of [ other, null, configDir ] ) {
			expect( () => modules.setChatGptStateDirectory( directory ) ).toThrow(
				expect.objectContaining( { name: 'ChatGptStateDirectoryError', code: 'in-use' } )
			);
		}
		modules.setChatGptStateDirectory( profileDir );
		expect( modules.getChatGptStateDirectory() ).toBe( profileDir );

		// Unset and used: the config directory is in use, and only it may be named.
		const fresh = await load();
		await fresh.readChatGptAccounts();
		expect( () => fresh.setChatGptStateDirectory( profileDir ) ).toThrow(
			expect.objectContaining( { code: 'in-use' } )
		);
		fresh.setChatGptStateDirectory( configDir );
		fresh.setChatGptStateDirectory( null );
	} );
} );

describe( 'who may set the ChatGPT state directory', () => {
	const SKIPPED = new Set( [ 'node_modules', 'dist', 'out', '.vite', 'coverage', 'vendor' ] );
	// Development-only code: the eval runner, which runs a case's turns in its own process.
	const ALLOWED = new Set( [
		'packages/agent/node/chatgpt/state-directory.ts',
		'apps/cli/ai/eval-runner.ts',
	] );

	function sourceFiles( directory: string ): string[] {
		return fs.readdirSync( directory, { withFileTypes: true } ).flatMap( ( entry ) => {
			if ( entry.name.startsWith( '.' ) || SKIPPED.has( entry.name ) ) {
				return [];
			}
			const file = path.join( directory, entry.name );
			if ( entry.isDirectory() ) {
				return entry.name === 'tests' ? [] : sourceFiles( file );
			}
			return /\.(ts|tsx|mts|mjs|js|cjs)$/.test( entry.name ) && ! /\.test\./.test( entry.name )
				? [ file ]
				: [];
		} );
	}

	it( 'is called only by the development-only eval runner, and is not part of a public entry point', () => {
		const callers = [ 'apps', 'packages', 'scripts', 'tools' ]
			.flatMap( ( top ) => sourceFiles( path.join( repoRoot, top ) ) )
			.filter( ( file ) => fs.readFileSync( file, 'utf8' ).includes( 'setChatGptStateDirectory' ) )
			.map( ( file ) => path.relative( repoRoot, file ).split( path.sep ).join( '/' ) );
		expect( callers.length ).toBeGreaterThan( 0 );
		expect( callers.filter( ( file ) => ! ALLOWED.has( file ) ) ).toEqual( [] );
		for ( const entry of [ 'packages/agent/node/index.ts', 'packages/agent/protocol' ] ) {
			const target = path.join( repoRoot, entry );
			const files = fs.statSync( target ).isDirectory() ? sourceFiles( target ) : [ target ];
			for ( const file of files ) {
				expect( fs.readFileSync( file, 'utf8' ) ).not.toMatch( /state-directory/ );
			}
		}
	} );
} );
