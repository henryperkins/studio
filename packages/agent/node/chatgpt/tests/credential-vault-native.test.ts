// @vitest-environment node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOsCredentialStore } from '@studio/common/lib/os-credential-store';
import {
	createNativeTestIdentity,
	nativeCredentialStoreTestGate,
	withNativeStoreSession,
	type NativeStoreSession,
} from '@studio/common/lib/tests/utils/native-credential-store';
import { describe, expect, it } from 'vitest';
import { readChatGptAccount } from '@studio/agent/node/chatgpt/account-store';
import {
	createChatGptCredentialBroker,
	type ChatGptSignIn,
	type ChatGptTokenClient,
} from '@studio/agent/node/chatgpt/credential-broker';

/**
 * The ChatGPT vault on this machine's real system keychain: a sealed record on
 * disk, its key in the keychain. Opt-in only, never in CI; see
 * scripts/chatgpt-acceptance/README.md. The broker keeps its key under a
 * keychain service named for the run, never Studio's own, in a temporary
 * profile; both are removed whether each test passes or fails.
 */

const gate = nativeCredentialStoreTestGate();
const identity = createNativeTestIdentity();
const FIXTURE = path.join( import.meta.dirname, 'fixtures', 'native-vault-process.ts' );
const WRAPPING_KEY_ACCOUNT = 'chatgpt-vault-key';
const TIMEOUT_MS = 180_000;
// Placeholders only, recognisable on disk.
const TOKEN_MARKERS = [ 'test-access-token', 'test-refresh-token', 'test-id-token' ];

const unreachableTokenService: ChatGptTokenClient = {
	refresh: async () => ( { ok: false, error: { kind: 'transient' } } ),
	revoke: async () => ( { ok: false, error: { kind: 'transient' } } ),
};

const material = ( prefix: string, size: number ) => {
	let text = `${ prefix }-${ randomBytes( 8 ).toString( 'hex' ) }.`;
	for ( let index = 0; text.length < size; index++ ) {
		text += `${ index.toString( 36 ) }-`;
	}
	return text.slice( 0, size );
};

const signIn = (
	storage: 'vault' | 'session',
	sizes = { access: 64, id: 64, refresh: 64 }
): ChatGptSignIn => ( {
	issuer: 'https://auth.openai.com',
	subject: `test-subject-${ randomBytes( 4 ).toString( 'hex' ) }`,
	email: 'someone@example.com',
	clientId: 'test-issued-client-1',
	storage,
	tokens: {
		accessToken: material( 'test-access-token', sizes.access ),
		refreshToken: material( 'test-refresh-token', sizes.refresh ),
		idToken: material( 'test-id-token', sizes.id ),
		tokenType: 'Bearer',
		expiresIn: 3600,
		scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
	},
} );

interface Profile {
	session: NativeStoreSession;
	configDir: string;
	broker(): ReturnType< typeof createChatGptCredentialBroker >;
	vaultPath( registrationId: string ): string;
	readAllFiles(): string;
}

// A temporary profile and the run's keychain service, both removed afterwards however the test ends.
const withProfile = ( test: ( profile: Profile ) => Promise< void > ) => () =>
	withNativeStoreSession(
		identity,
		( service ) => createOsCredentialStore( { service } ),
		async ( session ) => {
			session.track( WRAPPING_KEY_ACCOUNT );
			const configDir = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-native-vault-' ) );
			const previousConfigDir = process.env.DEV_CONFIG_DIR;
			process.env.DEV_CONFIG_DIR = configDir;
			const readAllFiles = ( directory = configDir ): string =>
				fs
					.readdirSync( directory, { withFileTypes: true } )
					.map( ( entry ) => {
						const entryPath = path.join( directory, entry.name );
						return entry.isDirectory()
							? readAllFiles( entryPath )
							: fs.readFileSync( entryPath, 'utf8' );
					} )
					.join( '\n' );
			try {
				await test( {
					session,
					configDir,
					broker: () =>
						createChatGptCredentialBroker( {
							tokenClient: unreachableTokenService,
							credentialStore: session.store,
						} ),
					vaultPath: ( registrationId ) =>
						path.join( configDir, 'chatgpt-credentials', `${ registrationId }.vault` ),
					readAllFiles: () => readAllFiles(),
				} );
			} finally {
				if ( previousConfigDir === undefined ) {
					delete process.env.DEV_CONFIG_DIR;
				} else {
					process.env.DEV_CONFIG_DIR = previousConfigDir;
				}
				fs.rmSync( configDir, { recursive: true, force: true, maxRetries: 5 } );
			}
		}
	);

// A fresh Studio process on the profile: the expected token goes on stdin, a verdict comes back.
function readInAnotherProcess(
	configDir: string,
	registrationId: string,
	expectedAccessToken: string
): Promise< Record< string, unknown > > {
	return new Promise( ( resolve, reject ) => {
		const child = spawn( process.execPath, [ FIXTURE, identity.runId, registrationId ], {
			env: { ...process.env, DEV_CONFIG_DIR: configDir },
			stdio: [ 'pipe', 'pipe', 'pipe' ],
			windowsHide: true,
		} );
		let stdout = '';
		child.stdout.setEncoding( 'utf8' ).on( 'data', ( chunk: string ) => ( stdout += chunk ) );
		child.stderr.resume();
		child.on( 'error', reject );
		child.on( 'close', () => {
			try {
				resolve( JSON.parse( stdout.trim().split( '\n' ).pop() ?? '' ) );
			} catch {
				reject( new Error( 'The other process reported nothing.' ) );
			}
		} );
		child.stdin.end( expectedAccessToken );
	} );
}

function expectNoToken( text: string ) {
	for ( const marker of TOKEN_MARKERS ) {
		expect( text ).not.toContain( marker );
	}
}

describe.skipIf( ! gate.run )(
	`the ChatGPT vault on the real system keychain, ${ process.platform } ${ process.arch }${
		gate.run ? '' : ` (skipped: ${ gate.reason })`
	}`,
	() => {
		it(
			'keeps a large sign-in for a fresh process, with only a 32-byte key in the keychain',
			withProfile( async ( { session, configDir, broker, vaultPath, readAllFiles } ) => {
				const large = signIn( 'vault', { access: 16 * 1024, id: 8 * 1024, refresh: 2 * 1024 } );

				const account = await broker().saveSignIn( large );

				await expect(
					readInAnotherProcess( configDir, account.registrationId, large.tokens.accessToken )
				).resolves.toEqual( { matches: true } );
				const key = await session.store.get( WRAPPING_KEY_ACCOUNT );
				expect( key ).toMatch( /^[A-Za-z0-9_-]{43}$/ );
				expect( Buffer.from( key!, 'base64url' ) ).toHaveLength( 32 );
				expect( fs.existsSync( vaultPath( account.registrationId ) ) ).toBe( true );
				expectNoToken( readAllFiles() );
			} ),
			TIMEOUT_MS
		);

		it(
			'asks for a sign-in again when the record is damaged, keeping the key',
			withProfile( async ( { session, configDir, broker, vaultPath, readAllFiles } ) => {
				const saved = signIn( 'vault' );
				const account = await broker().saveSignIn( saved );
				const key = await session.store.get( WRAPPING_KEY_ACCOUNT );
				const sealed = JSON.parse( fs.readFileSync( vaultPath( account.registrationId ), 'utf8' ) );
				const ciphertext = Buffer.from( sealed.ciphertext, 'base64' );
				ciphertext[ 0 ] ^= 0xff;
				fs.writeFileSync(
					vaultPath( account.registrationId ),
					JSON.stringify( { ...sealed, ciphertext: ciphertext.toString( 'base64' ) } )
				);

				await expect(
					readInAnotherProcess( configDir, account.registrationId, saved.tokens.accessToken )
				).resolves.toEqual( { code: 'needs-sign-in' } );
				expect( await readChatGptAccount( account.registrationId ) ).toMatchObject( {
					state: 'needs-sign-in',
				} );
				expect( fs.existsSync( vaultPath( account.registrationId ) ) ).toBe( false );
				await expect( session.store.get( WRAPPING_KEY_ACCOUNT ) ).resolves.toBe( key );
				expectNoToken( readAllFiles() );
			} ),
			TIMEOUT_MS
		);

		it(
			'asks for a sign-in again once the keychain has lost the key, and makes a new one for the next',
			withProfile( async ( { session, configDir, broker, vaultPath, readAllFiles } ) => {
				const lost = signIn( 'vault' );
				const account = await broker().saveSignIn( lost );
				const oldKey = await session.store.get( WRAPPING_KEY_ACCOUNT );
				await session.store.delete( WRAPPING_KEY_ACCOUNT );

				await expect(
					readInAnotherProcess( configDir, account.registrationId, lost.tokens.accessToken )
				).resolves.toEqual( { code: 'needs-sign-in' } );
				expect( fs.existsSync( vaultPath( account.registrationId ) ) ).toBe( false );

				const next = signIn( 'vault' );
				const again = await broker().saveSignIn( next );
				const newKey = await session.store.get( WRAPPING_KEY_ACCOUNT );
				expect( newKey ).toMatch( /^[A-Za-z0-9_-]{43}$/ );
				expect( newKey ).not.toBe( oldKey );
				await expect(
					readInAnotherProcess( configDir, again.registrationId, next.tokens.accessToken )
				).resolves.toEqual( { matches: true } );
				expectNoToken( readAllFiles() );
			} ),
			TIMEOUT_MS
		);

		it(
			'keeps a session-only sign-in out of the keychain and off the disk',
			withProfile( async ( { session, broker, vaultPath, readAllFiles } ) => {
				await broker().saveSignIn( signIn( 'vault' ) );
				const key = await session.store.get( WRAPPING_KEY_ACCOUNT );
				const app = broker();

				const kept = await app.saveSignIn( signIn( 'session' ) );

				expect( kept.storage ).toBe( 'session' );
				await expect( app.getAccessToken( kept.registrationId ) ).resolves.toMatch(
					/^test-access-token-/
				);
				await expect( session.store.get( WRAPPING_KEY_ACCOUNT ) ).resolves.toBe( key );
				expect( fs.existsSync( vaultPath( kept.registrationId ) ) ).toBe( false );
				expectNoToken( readAllFiles() );
			} ),
			TIMEOUT_MS
		);
	}
);
