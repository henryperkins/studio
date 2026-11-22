// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	createOsCredentialStore,
	type CommandResult,
	type CommandRunner,
} from '@studio/common/lib/os-credential-store';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatGptCredentialBroker } from '@studio/agent/node/chatgpt/credential-broker';
import {
	readChatGptSettings,
	recheckChatGptSettings,
	startChatGptSignIn,
} from '@studio/agent/node/chatgpt/settings';
import {
	createSigningKey,
	startFakeAuthorizationServer,
	type FakeAuthorizationServer,
	type SigningKey,
} from './fixtures/fake-authorization-server';
import type { ChatGptSignInFlow } from '@studio/agent/node/chatgpt/oauth';

/*
 * What a sign-in's start runs of the system keychain's tool, seen through the
 * tool runner the app's store is built on: Linux's `secret-tool`, which a
 * Secret Service may answer with a prompt. The settings module, the app's
 * broker and a sign-in flow are the real ones; only discovery and the browser
 * are local stand-ins. Each test has a profile of its own, so the app's broker
 * holds no key for it.
 */

const CHECK_ITEM = '__studio_keychain_check__';

type Run = { kind: 'availability check' | 'read' | 'write' | 'remove'; overlapped: boolean };

// The keychain tool of the test running: every store the app makes runs it.
const tool = vi.hoisted( () => ( {
	run: null as unknown as CommandRunner,
} ) );
// The sign-in flow the app's start goes through: the real one, against the local server.
const signIns = vi.hoisted( () => ( {
	discoveryUrl: '',
	flow: null as ChatGptSignInFlow | null,
	begun: [] as string[],
	opened: [] as string[],
} ) );

vi.mock( '@studio/common/lib/os-credential-store', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/common/lib/os-credential-store') >();
	return {
		...actual,
		createOsCredentialStore: () =>
			actual.createOsCredentialStore( {
				platform: 'linux',
				run: ( ...args ) => tool.run( ...args ),
			} ),
	};
} );

vi.mock( '@studio/agent/node/chatgpt/oauth', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/agent/node/chatgpt/oauth') >();
	return {
		...actual,
		beginChatGptSignIn: async ( ...args: Parameters< typeof actual.beginChatGptSignIn > ) => {
			signIns.flow ??= actual.createChatGptSignInFlow( {
				discoveryUrl: signIns.discoveryUrl,
				openBrowser: async ( url ) => {
					signIns.opened.push( url );
				},
				// No socket-table lookup: which user a request comes from isn't what is tested here.
				platform: 'win32',
			} );
			const started = await signIns.flow.begin( ...args );
			signIns.begun.push( started.attemptId );
			return started;
		},
	};
} );

// `secret-tool`, holding every availability check until the test lets it answer.
function scriptedSecretTool() {
	const items = new Map< string, string >();
	const state = { reachable: true, saysNothingSaved: false };
	const runs: Run[] = [];
	const heldChecks: Array< () => void > = [];
	let active = 0;
	const ok = ( stdout = '' ): CommandResult => ( { code: 0, stdout, stderr: '' } );
	const nothing: CommandResult = { code: 1, stdout: '', stderr: '' };
	const run: CommandRunner = async ( _command, args, { input } ) => {
		const account = args[ args.indexOf( 'account' ) + 1 ];
		const kind: Run[ 'kind' ] =
			args[ 0 ] === 'store'
				? 'write'
				: args[ 0 ] === 'clear'
				? 'remove'
				: account === CHECK_ITEM
				? 'availability check'
				: 'read';
		runs.push( { kind, overlapped: active > 0 } );
		active++;
		try {
			await new Promise< void >( ( resolve ) =>
				kind === 'availability check' ? heldChecks.push( resolve ) : setImmediate( resolve )
			);
			if ( ! state.reachable ) {
				return { code: 1, stdout: '', stderr: 'secret-tool: Cannot get secret of a locked object' };
			}
			if ( kind === 'availability check' ) {
				return nothing;
			}
			if ( kind === 'write' ) {
				items.set( account, input ?? '' );
				return ok();
			}
			if ( kind === 'remove' ) {
				items.delete( account );
				return ok();
			}
			const secret = items.get( account );
			return state.saysNothingSaved || secret === undefined ? nothing : ok( secret );
		} finally {
			active--;
		}
	};
	return {
		run,
		state,
		runs,
		checks: () => runs.filter( ( entry ) => entry.kind === 'availability check' ).length,
		// Lets the held checks answer, and whatever waits on them settle.
		async answerChecks() {
			heldChecks.splice( 0 ).forEach( ( answer ) => answer() );
			await new Promise( ( resolve ) => setImmediate( resolve ) );
		},
	};
}

const GRANTED_SCOPE =
	'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

describe( 'the system keychain while a ChatGPT sign-in starts', () => {
	let signingKey: SigningKey;
	let fake: FakeAuthorizationServer;
	let keychain: ReturnType< typeof scriptedSecretTool >;
	let configDir: string;
	let previousConfigDir: string | undefined;

	// A sign-in kept in secure storage, saved by another app.
	function savedInSecureStorage() {
		return createChatGptCredentialBroker( {
			tokenClient: {
				refresh: async () => ( { ok: false, error: { kind: 'transient' } } ),
				revoke: async () => ( { ok: false, error: { kind: 'transient' } } ),
			},
			credentialStore: createOsCredentialStore(),
		} ).saveSignIn( {
			issuer: 'https://auth.openai.com',
			subject: 'test-subject-1',
			email: 'someone@example.com',
			clientId: 'test-issued-client-1',
			storage: 'vault',
			tokens: {
				accessToken: 'test-access-token-1',
				refreshToken: 'test-refresh-token-1',
				idToken: 'test-id-token-1',
				tokenType: 'Bearer',
				expiresIn: 3600,
				scope: GRANTED_SCOPE,
			},
		} );
	}

	// What the settings know of the keychain before the sign-in starts: a recheck's answer.
	async function knownAs( answer: 'available' | 'unavailable' ) {
		keychain.state.reachable = answer === 'available';
		const rechecking = recheckChatGptSettings();
		await keychain.answerChecks();
		await expect( rechecking ).resolves.toMatchObject( { secureStorage: answer } );
		keychain.state.reachable = true;
		keychain.runs.splice( 0 );
	}

	const secureStorageShown = async () => ( await readChatGptSettings() ).secureStorage;

	// The browser through the start address, the authorize page and back to the callback.
	async function finishInBrowser( attemptId: string ) {
		const location = async ( url: string ) =>
			( await fetch( url, { redirect: 'manual' } ) ).headers.get( 'location' )!;
		const callback = await location( await location( signIns.opened.at( -1 )! ) );
		await ( await fetch( callback, { redirect: 'manual' } ) ).text();
		return signIns.flow!.wait( attemptId );
	}

	beforeAll( async () => {
		signingKey = await createSigningKey( 'test-key-1' );
	} );

	beforeEach( async () => {
		configDir = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-chatgpt-settings-keychain-' ) );
		previousConfigDir = process.env.DEV_CONFIG_DIR;
		process.env.DEV_CONFIG_DIR = configDir;
		vi.stubEnv( 'STUDIO_EXPERIMENTAL_CHATGPT', '1' );
		keychain = scriptedSecretTool();
		tool.run = keychain.run;
		fake = await startFakeAuthorizationServer( signingKey );
		signIns.discoveryUrl = fake.discoveryUrl;
		signIns.flow = null;
		signIns.opened = [];
	} );

	afterEach( async () => {
		await keychain.answerChecks();
		for ( const attemptId of signIns.begun.splice( 0 ) ) {
			signIns.flow?.cancel( attemptId );
		}
		vi.unstubAllEnvs();
		await fake.close();
		if ( previousConfigDir === undefined ) {
			delete process.env.DEV_CONFIG_DIR;
		} else {
			process.env.DEV_CONFIG_DIR = previousConfigDir;
		}
		fs.rmSync( configDir, { recursive: true, force: true, maxRetries: 5 } );
	} );

	describe( 'for a sign-in kept in secure storage', () => {
		it( 'runs no availability check besides its own read of the key, and shows the keychain available from that read', async () => {
			await savedInSecureStorage();
			await knownAs( 'unavailable' );

			await expect( startChatGptSignIn( undefined, { storage: 'vault' } ) ).resolves.toEqual( {
				attemptId: expect.any( String ),
			} );

			expect( keychain.runs ).toEqual( [ { kind: 'read', overlapped: false } ] );
			expect( await secureStorageShown() ).toBe( 'available' );
			expect( keychain.checks() ).toBe( 0 );
		} );

		it( 'shows the keychain unavailable when its own read of the key couldn’t reach it, running nothing else', async () => {
			await savedInSecureStorage();
			await knownAs( 'available' );
			keychain.state.reachable = false;

			await startChatGptSignIn( undefined, { storage: 'vault' } );

			expect( keychain.runs ).toEqual( [ { kind: 'read', overlapped: false } ] );
			expect( await secureStorageShown() ).toBe( 'unavailable' );
			expect( keychain.checks() ).toBe( 0 );
		} );

		it( 'keeps a key the keychain says it doesn’t have apart from a keychain it can’t reach: refused, and still shown available', async () => {
			await savedInSecureStorage();
			await knownAs( 'available' );
			keychain.state.saysNothingSaved = true;

			await expect( startChatGptSignIn( undefined, { storage: 'vault' } ) ).rejects.toThrow(
				/couldn’t read the key in the system keychain/
			);

			expect( keychain.runs ).toEqual( [ { kind: 'read', overlapped: false } ] );
			expect( await secureStorageShown() ).toBe( 'available' );
			expect( keychain.checks() ).toBe( 0 );
		} );

		it( 'runs no keychain tool at all when no saved sign-in needs the key, leaving what the settings last found', async () => {
			await knownAs( 'unavailable' );

			await startChatGptSignIn( undefined, { storage: 'vault' } );

			expect( keychain.runs ).toEqual( [] );
			expect( await secureStorageShown() ).toBe( 'unavailable' );
		} );

		it( 'waits for an availability check already running before its own read of the key', async () => {
			await savedInSecureStorage();
			await knownAs( 'unavailable' );
			// The Settings group opened: its recheck waits on a Secret Service prompt.
			const rechecking = recheckChatGptSettings();
			await new Promise( ( resolve ) => setImmediate( resolve ) );

			const starting = startChatGptSignIn( undefined, { storage: 'vault' } );
			await new Promise( ( resolve ) => setTimeout( resolve, 50 ) );

			expect( keychain.runs ).toEqual( [ { kind: 'availability check', overlapped: false } ] );

			await keychain.answerChecks();
			await expect( starting ).resolves.toEqual( { attemptId: expect.any( String ) } );
			await rechecking;
			expect( keychain.runs ).toEqual( [
				{ kind: 'availability check', overlapped: false },
				{ kind: 'read', overlapped: false },
			] );
			expect( await secureStorageShown() ).toBe( 'available' );
		} );

		it( 'runs its reads one at a time when it signs a saved account in again', async () => {
			const { registrationId } = await savedInSecureStorage();
			await knownAs( 'unavailable' );

			await startChatGptSignIn( registrationId );

			// Its check of the key, then the ID token hint from the account's saved record.
			expect( keychain.runs ).toEqual( [
				{ kind: 'read', overlapped: false },
				{ kind: 'read', overlapped: false },
			] );
			expect( await secureStorageShown() ).toBe( 'available' );
		} );
	} );

	// A first secure sign-in reads nothing at its start: what its save found is the answer.
	describe( 'once a sign-in kept in secure storage is saved', () => {
		it( 'shows the keychain available when the save kept its key there', async () => {
			await knownAs( 'unavailable' );
			const { attemptId } = await startChatGptSignIn( undefined, { storage: 'vault' } );
			expect( keychain.runs ).toEqual( [] );
			expect( await secureStorageShown() ).toBe( 'unavailable' );

			await expect( finishInBrowser( attemptId ) ).resolves.toMatchObject( { ok: true } );

			expect( keychain.runs.map( ( entry ) => entry.kind ) ).toContain( 'write' );
			expect( keychain.checks() ).toBe( 0 );
			expect( await secureStorageShown() ).toBe( 'available' );
		} );

		it( 'shows the keychain unavailable when the save couldn’t reach it', async () => {
			await knownAs( 'available' );
			const { attemptId } = await startChatGptSignIn( undefined, { storage: 'vault' } );
			keychain.state.reachable = false;

			await expect( finishInBrowser( attemptId ) ).resolves.toMatchObject( {
				ok: false,
				code: 'vault-unavailable',
			} );

			expect( keychain.checks() ).toBe( 0 );
			expect( await secureStorageShown() ).toBe( 'unavailable' );
		} );
	} );

	describe( 'for a sign-in kept for this app session only', () => {
		it( 'checks the keychain once its start has finished its own reads, never at the same time', async () => {
			const { registrationId } = await savedInSecureStorage();
			await knownAs( 'unavailable' );

			await startChatGptSignIn( registrationId, { storage: 'session' } );

			// The read is the ID token hint from the account's saved record.
			expect( keychain.runs ).toEqual( [
				{ kind: 'read', overlapped: false },
				{ kind: 'availability check', overlapped: false },
			] );
			await keychain.answerChecks();
			expect( await secureStorageShown() ).toBe( 'available' );
			expect( keychain.checks() ).toBe( 1 );
		} );

		it( 'checks the keychain once for a new account, and shows what it found', async () => {
			await knownAs( 'available' );
			keychain.state.reachable = false;

			await startChatGptSignIn( undefined, { storage: 'session' } );

			expect( keychain.runs ).toEqual( [ { kind: 'availability check', overlapped: false } ] );
			await keychain.answerChecks();
			expect( await secureStorageShown() ).toBe( 'unavailable' );
		} );
	} );
} );
