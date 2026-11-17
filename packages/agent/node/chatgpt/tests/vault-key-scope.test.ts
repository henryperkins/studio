// @vitest-environment node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readChatGptAccount } from '@studio/agent/node/chatgpt/account-store';
import {
	createChatGptCredentialBroker,
	type ChatGptSignIn,
	type ChatGptTokenClient,
	type ChatGptTokenSet,
} from '@studio/agent/node/chatgpt/credential-broker';
import { getChatGptVaultKeyAccounts } from '@studio/agent/node/chatgpt/state-directory';
import { scriptedKeychain, type KeychainPlatform } from './fixtures/scripted-keychain';

// What the file system answers when a real path is read: a test can make it
// fail for some paths, with the error code it names.
const realPaths = vi.hoisted( () => ( {
	fail: null as ( ( target: string ) => string | undefined ) | null,
} ) );

vi.mock( 'node:fs', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('node:fs') >();
	const native = ( ( target: string ) => {
		const code = realPaths.fail?.( target );
		if ( code ) {
			throw Object.assign( new Error( `${ code }: scripted, realpath` ), { code } );
		}
		return actual.realpathSync.native( target );
	} ) as unknown as typeof actual.realpathSync.native;
	const realpathSync = Object.assign(
		( ( ...args: Parameters< typeof actual.realpathSync > ) =>
			actual.realpathSync( ...args ) ) as typeof actual.realpathSync,
		{ native }
	);
	return { ...actual, default: { ...actual, realpathSync }, realpathSync };
} );

// Every store here runs over a scripted tool; the real keychain is never reached.
vi.mock( '@studio/common/lib/os-credential-store', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/common/lib/os-credential-store') >();
	return {
		...actual,
		createOsCredentialStore: (
			options?: Parameters< typeof actual.createOsCredentialStore >[ 0 ]
		) => {
			if ( ! options?.run ) {
				throw new Error( 'A test must never reach the system keychain.' );
			}
			return actual.createOsCredentialStore( options );
		},
	};
} );

const PLATFORMS: readonly KeychainPlatform[] = [ 'darwin', 'linux', 'win32' ];
// The default profile's item: the name every profile shared before keys were kept per profile.
const DEFAULT_ITEM = 'wordpress-studio/chatgpt-vault-key';
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;
const GRANTED_SCOPE =
	'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

// Another profile's item: today's name and the first 16 hex digits of its real path's SHA-256.
const scopedItem = ( directory: string ) =>
	`wordpress-studio/chatgpt-vault-key-${ createHash( 'sha256' )
		.update( fs.realpathSync.native( directory ), 'utf8' )
		.digest( 'hex' )
		.slice( 0, 16 ) }`;

const tokens = ( id: number | string, expiresIn = 3600 ): ChatGptTokenSet => ( {
	accessToken: `test-access-token-${ id }`,
	refreshToken: `test-refresh-token-${ id }`,
	idToken: `test-id-token-${ id }`,
	tokenType: 'Bearer',
	expiresIn,
	scope: GRANTED_SCOPE,
} );

const signIn = (
	storage: 'vault' | 'session',
	id: number,
	expiresIn?: number
): ChatGptSignIn => ( {
	issuer: 'https://auth.openai.com',
	subject: `test-subject-${ id }`,
	email: 'someone@example.com',
	clientId: `test-issued-client-${ id }`,
	storage,
	tokens: tokens( id, expiresIn ),
} );

describe( 'the ChatGPT vault key of each profile', () => {
	let base: string;
	let home: string;
	let defaultProfile: string;
	let profileA: string;
	let profileB: string;
	let previousConfigDir: string | undefined;
	let renewals: number;
	let revocations: string[];

	const tokenClient: ChatGptTokenClient = {
		refresh: async () => ( { ok: true, value: tokens( `renewed-${ ++renewals }` ) } ),
		revoke: async ( { refreshToken } ) => {
			revocations.push( refreshToken );
			return { ok: true, value: undefined };
		},
	};

	const selectProfile = ( directory: string ) => {
		process.env.DEV_CONFIG_DIR = directory;
	};
	// Where Studio's own profile is: `<home>/.studio`.
	const setHome = ( directory: string ) => vi.spyOn( os, 'homedir' ).mockReturnValue( directory );
	const broker = ( keychain: ReturnType< typeof scriptedKeychain > ) =>
		createChatGptCredentialBroker( {
			tokenClient,
			credentialStore: keychain.store,
			timing: { turnSettleTimeoutMs: 200, revokeRetryDelaysMs: [ 1, 1 ] },
		} );
	const recordPath = ( profile: string, registrationId: string ) =>
		path.join( profile, 'chatgpt-credentials', `${ registrationId }.vault` );

	beforeEach( () => {
		base = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-chatgpt-vault-key-' ) );
		home = path.join( base, 'home' );
		defaultProfile = path.join( home, '.studio' );
		profileA = path.join( base, 'profile-a' );
		profileB = path.join( base, 'profile-b' );
		for ( const directory of [ defaultProfile, profileA, profileB ] ) {
			fs.mkdirSync( directory, { recursive: true } );
		}
		setHome( home );
		previousConfigDir = process.env.DEV_CONFIG_DIR;
		renewals = 0;
		revocations = [];
		realPaths.fail = null;
	} );

	afterEach( () => {
		realPaths.fail = null;
		vi.restoreAllMocks();
		if ( previousConfigDir === undefined ) {
			delete process.env.DEV_CONFIG_DIR;
		} else {
			process.env.DEV_CONFIG_DIR = previousConfigDir;
		}
		fs.rmSync( base, { recursive: true, force: true, maxRetries: 5 } );
	} );

	it.each( PLATFORMS )(
		'on %s, keeps the default profile’s key under today’s item, wordpress-studio/chatgpt-vault-key',
		async ( platform ) => {
			const keychain = scriptedKeychain( platform );
			selectProfile( defaultProfile );

			const { registrationId } = await broker( keychain ).saveSignIn( signIn( 'vault', 1 ) );

			expect( [ ...keychain.items.keys() ] ).toEqual( [ DEFAULT_ITEM ] );
			expect( keychain.items.get( DEFAULT_ITEM ) ).toMatch( KEY_TEXT );
			// The same directory, named another way, is the same profile.
			selectProfile( path.join( base, 'home', '..', 'home', '.studio' ) + path.sep );
			await expect( broker( keychain ).getAccessToken( registrationId ) ).resolves.toBe(
				'test-access-token-1'
			);
			expect( keychain.writes ).toEqual( [ DEFAULT_ITEM ] );
		}
	);

	it.each( PLATFORMS )(
		'on %s, gives every other profile an item of its own, named from a hash of its real path, so two profiles never see each other’s key',
		async ( platform ) => {
			const keychain = scriptedKeychain( platform );
			selectProfile( profileA );
			const a = await broker( keychain ).saveSignIn( signIn( 'vault', 1 ) );
			selectProfile( profileB );
			const b = await broker( keychain ).saveSignIn( signIn( 'vault', 2 ) );

			const names = [ ...keychain.items.keys() ];
			expect( names.sort() ).toEqual( [ scopedItem( profileA ), scopedItem( profileB ) ].sort() );
			for ( const name of names ) {
				expect( name ).toMatch( /^wordpress-studio\/chatgpt-vault-key-[0-9a-f]{16}$/ );
				expect( name ).not.toContain( 'profile' );
			}
			expect( keychain.items.get( scopedItem( profileA ) ) ).toMatch( KEY_TEXT );
			expect( keychain.items.get( scopedItem( profileA ) ) ).not.toBe(
				keychain.items.get( scopedItem( profileB ) )
			);

			selectProfile( profileA );
			await expect( broker( keychain ).getAccessToken( a.registrationId ) ).resolves.toBe(
				'test-access-token-1'
			);
			selectProfile( profileB );
			await expect( broker( keychain ).getAccessToken( b.registrationId ) ).resolves.toBe(
				'test-access-token-2'
			);
			expect( keychain.writes.sort() ).toEqual( names.sort() );
		}
	);

	it.each( PLATFORMS )(
		'on %s, makes a fresh profile’s own item when the keychain falsely says nothing is saved, leaving the default profile’s item byte for byte and its sign-in readable',
		async ( platform ) => {
			const keychain = scriptedKeychain( platform );
			selectProfile( defaultProfile );
			const saved = await broker( keychain ).saveSignIn( signIn( 'vault', 1 ) );
			const defaultKey = keychain.items.get( DEFAULT_ITEM );
			const record = fs.readFileSync( recordPath( defaultProfile, saved.registrationId ), 'utf8' );
			// A dismissed unlock prompt, on Linux's Secret Service for one.
			keychain.state.saysNothingSaved = true;

			selectProfile( profileA );
			const fresh = await broker( keychain ).saveSignIn( signIn( 'vault', 2 ) );

			expect( keychain.items.get( DEFAULT_ITEM ) ).toBe( defaultKey );
			expect( keychain.items.get( scopedItem( profileA ) ) ).toMatch( KEY_TEXT );
			expect( keychain.items.get( scopedItem( profileA ) ) ).not.toBe( defaultKey );
			expect( keychain.writes ).toEqual( [ DEFAULT_ITEM, scopedItem( profileA ) ] );

			selectProfile( defaultProfile );
			await expect( broker( keychain ).getAccessToken( saved.registrationId ) ).resolves.toBe(
				'test-access-token-1'
			);
			expect( await readChatGptAccount( saved.registrationId ) ).toMatchObject( {
				state: 'signed-in',
			} );
			expect( fs.readFileSync( recordPath( defaultProfile, saved.registrationId ), 'utf8' ) ).toBe(
				record
			);
			selectProfile( profileA );
			await expect( broker( keychain ).getAccessToken( fresh.registrationId ) ).resolves.toBe(
				'test-access-token-2'
			);
		}
	);

	describe( 'a profile whose records were sealed under the shared item before keys were per profile', () => {
		let legacyProfile: string;

		// The records as this branch wrote them before: the profile's records under the shared item.
		async function savedBeforeKeysWerePerProfile( platform: KeychainPlatform ) {
			legacyProfile = path.join( base, 'earlier-home', '.studio' );
			fs.mkdirSync( legacyProfile, { recursive: true } );
			const keychain = scriptedKeychain( platform );
			setHome( path.dirname( legacyProfile ) );
			selectProfile( legacyProfile );
			const first = await broker( keychain ).saveSignIn( signIn( 'vault', 1 ) );
			// About to expire, so its next use renews it.
			const second = await broker( keychain ).saveSignIn( signIn( 'vault', 2, 60 ) );
			expect( [ ...keychain.items.keys() ] ).toEqual( [ DEFAULT_ITEM ] );
			// Studio's own profile is elsewhere: this one is a profile of its own now.
			setHome( home );
			return {
				keychain,
				first,
				second,
				sharedKey: keychain.items.get( DEFAULT_ITEM ),
				writesBefore: keychain.writes.length,
			};
		}

		it.each( PLATFORMS )(
			'on %s, opens and renews them with that item, read-only, and refuses the next secure save until they are signed out',
			async ( platform ) => {
				const saved = await savedBeforeKeysWerePerProfile( platform );
				const app = broker( saved.keychain );

				await expect( app.getAccessToken( saved.first.registrationId ) ).resolves.toBe(
					'test-access-token-1'
				);
				await expect( app.getAccessToken( saved.second.registrationId ) ).resolves.toBe(
					'test-access-token-renewed-1'
				);
				await expect(
					broker( saved.keychain ).getAccessToken( saved.second.registrationId )
				).resolves.toBe( 'test-access-token-renewed-1' );
				await expect( app.readIdTokenHint( saved.first.registrationId ) ).resolves.toBe(
					'test-id-token-1'
				);

				await expect( app.checkVaultKey() ).rejects.toMatchObject( {
					code: 'vault-key-unreadable',
				} );
				for ( const save of [
					signIn( 'vault', 3 ),
					{ ...signIn( 'vault', 1 ), registrationId: saved.first.registrationId },
				] ) {
					await expect( app.saveSignIn( save ) ).rejects.toMatchObject( {
						code: 'vault-key-unreadable',
					} );
				}
				const session = await app.saveSignIn( signIn( 'session', 5 ) );
				await expect( app.getAccessToken( session.registrationId ) ).resolves.toBe(
					'test-access-token-5'
				);
				expect( saved.keychain.writes.slice( saved.writesBefore ) ).toEqual( [] );
				expect( [ ...saved.keychain.items.keys() ] ).toEqual( [ DEFAULT_ITEM ] );
				expect( saved.keychain.items.get( DEFAULT_ITEM ) ).toBe( saved.sharedKey );

				// The way out: sign the saved accounts out, then save again under the profile's own key.
				await app.signOut( saved.first.registrationId );
				await app.signOut( saved.second.registrationId );
				expect( revocations.sort() ).toEqual(
					[ 'test-refresh-token-1', 'test-refresh-token-renewed-1' ].sort()
				);
				const next = await app.saveSignIn( signIn( 'vault', 6 ) );

				expect( saved.keychain.items.get( DEFAULT_ITEM ) ).toBe( saved.sharedKey );
				expect( saved.keychain.items.get( scopedItem( legacyProfile ) ) ).toMatch( KEY_TEXT );
				expect( saved.keychain.writes.slice( saved.writesBefore ) ).toEqual( [
					scopedItem( legacyProfile ),
				] );
				await expect(
					broker( saved.keychain ).getAccessToken( next.registrationId )
				).resolves.toBe( 'test-access-token-6' );
			}
		);

		it.each( PLATFORMS )(
			'on %s, keeps a record the shared item’s key no longer opens, reporting the key unreadable rather than asking for a sign-in',
			async ( platform ) => {
				const saved = await savedBeforeKeysWerePerProfile( platform );
				const record = fs.readFileSync(
					recordPath( legacyProfile, saved.first.registrationId ),
					'utf8'
				);
				// The default profile made a key of its own since, as it may once it has no record.
				saved.keychain.items.set( DEFAULT_ITEM, 'A'.repeat( 43 ) );

				await expect(
					broker( saved.keychain ).getAccessToken( saved.first.registrationId )
				).rejects.toMatchObject( { code: 'vault-key-unreadable' } );

				expect(
					fs.readFileSync( recordPath( legacyProfile, saved.first.registrationId ), 'utf8' )
				).toBe( record );
				expect( await readChatGptAccount( saved.first.registrationId ) ).toMatchObject( {
					state: 'signed-in',
				} );
				expect( saved.keychain.writes.slice( saved.writesBefore ) ).toEqual( [] );
			}
		);
	} );

	it.each( PLATFORMS )(
		'on %s, removes only its own profile’s item when asked, once no saved sign-in needs it, and never the default profile’s',
		async ( platform ) => {
			const keychain = scriptedKeychain( platform );
			selectProfile( defaultProfile );
			const kept = await broker( keychain ).saveSignIn( signIn( 'vault', 1 ) );
			const defaultKey = keychain.items.get( DEFAULT_ITEM );
			await expect( broker( keychain ).removeProfileVaultKey() ).resolves.toBe( 'default-profile' );

			selectProfile( profileA );
			const app = broker( keychain );
			const retiring = await app.saveSignIn( signIn( 'vault', 2 ) );
			await expect( app.removeProfileVaultKey() ).resolves.toBe( 'records-exist' );
			expect( keychain.items.has( scopedItem( profileA ) ) ).toBe( true );

			await app.signOut( retiring.registrationId );
			await expect( app.removeProfileVaultKey() ).resolves.toBe( 'removed' );

			expect( [ ...keychain.items.keys() ] ).toEqual( [ DEFAULT_ITEM ] );
			expect( keychain.items.get( DEFAULT_ITEM ) ).toBe( defaultKey );
			selectProfile( defaultProfile );
			await expect( broker( keychain ).getAccessToken( kept.registrationId ) ).resolves.toBe(
				'test-access-token-1'
			);
		}
	);

	describe( 'the real path the item is named from', () => {
		const unnamed = { name: 'ChatGptStateDirectoryError', code: 'unresolved' };

		// Only a part that doesn't exist is passed over on the way to the nearest
		// existing folder: anything else could name the same profile another way.
		it.each( [ 'EACCES', 'EIO', 'ENOTDIR' ] )(
			'names no key while the profile’s real path can’t be read (%s), reading and writing no keychain item, and the same one as before once it can',
			async ( code ) => {
				const keychain = scriptedKeychain( 'linux' );
				selectProfile( profileA );
				const saved = await broker( keychain ).saveSignIn( signIn( 'vault', 1 ) );
				const record = fs.readFileSync( recordPath( profileA, saved.registrationId ), 'utf8' );
				const callsBefore = keychain.calls.length;
				realPaths.fail = ( target ) => ( target === path.resolve( profileA ) ? code : undefined );

				expect( () => getChatGptVaultKeyAccounts() ).toThrow( expect.objectContaining( unnamed ) );
				const app = broker( keychain );
				await expect( app.getAccessToken( saved.registrationId ) ).rejects.toMatchObject( unnamed );
				await expect( app.checkVaultKey() ).rejects.toMatchObject( unnamed );
				await expect( app.saveSignIn( signIn( 'vault', 2 ) ) ).rejects.toMatchObject( unnamed );
				await expect( app.removeProfileVaultKey() ).rejects.toMatchObject( unnamed );

				expect( keychain.calls.slice( callsBefore ) ).toEqual( [] );
				expect( fs.readFileSync( recordPath( profileA, saved.registrationId ), 'utf8' ) ).toBe(
					record
				);
				expect( await readChatGptAccount( saved.registrationId ) ).toMatchObject( {
					state: 'signed-in',
				} );

				realPaths.fail = null;
				await expect( app.getAccessToken( saved.registrationId ) ).resolves.toBe(
					'test-access-token-1'
				);
				expect( [ ...keychain.items.keys() ] ).toEqual( [ scopedItem( profileA ) ] );
			}
		);

		it( 'names a profile that doesn’t exist yet as it is named once it does', () => {
			const later = path.join( base, 'not-yet', 'profile' );
			selectProfile( later );
			const before = getChatGptVaultKeyAccounts();

			fs.mkdirSync( later, { recursive: true } );

			expect( getChatGptVaultKeyAccounts() ).toEqual( before );
			expect( `wordpress-studio/${ before.own }` ).toBe( scopedItem( later ) );
		} );

		it.runIf( process.platform === 'win32' )(
			'on Windows, names a profile the same whatever the case of its drive letter, even where none of its path exists',
			() => {
				realPaths.fail = () => 'ENOENT';
				const tail = path.join( 'studio-profile-on-a-missing-drive', 'profile' );

				selectProfile( `q:\\${ tail }` );
				const lower = getChatGptVaultKeyAccounts();
				selectProfile( `Q:\\${ tail }` );

				expect( getChatGptVaultKeyAccounts() ).toEqual( lower );
			}
		);
	} );
} );
