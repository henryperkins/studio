// @vitest-environment node
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {
	createOsCredentialStore,
	type CommandRunner,
} from '@studio/common/lib/os-credential-store';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
	ChatGptConnectionError,
	getChatGptHostId,
	readChatGptAccount,
	readChatGptAccounts,
	type ChatGptAccount,
} from '@studio/agent/node/chatgpt/account-store';
import {
	CHATGPT_TERMINAL_REFRESH_ERRORS,
	CHATGPT_TURN_WATCH_POLL_MS,
	createChatGptCredentialBroker,
	type ChatGptCredentialBroker,
	type ChatGptCredentialBrokerOptions,
	type ChatGptSignIn,
	type ChatGptTokenClient,
	type ChatGptTokenServiceResult,
	type ChatGptTokenSet,
	type ChatGptTurnHandle,
} from '@studio/agent/node/chatgpt/credential-broker';
import {
	createFakeCredentialStore,
	type FakeCredentialStore,
} from '../../tests/fake-credential-store';
import { createFileCredentialStore } from './fixtures/file-credential-store';
import { createHttpTokenClient } from './fixtures/http-token-client';
import { startMockTokenService } from './fixtures/mock-token-service';

const systemKeychain = vi.hoisted( () => ( { current: null as FakeCredentialStore | null } ) );
const fileWatching = vi.hoisted( () => ( { refused: false } ) );

// Some platforms and file systems can't watch a directory; a test makes it so.
vi.mock( 'node:fs', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('node:fs') >();
	const watch = ( ( ...args: Parameters< typeof actual.watch > ) => {
		if ( fileWatching.refused ) {
			throw Object.assign( new Error( 'ENOSYS: function not implemented, watch' ), {
				code: 'ENOSYS',
			} );
		}
		return actual.watch( ...args );
	} ) as typeof actual.watch;
	return { ...actual, default: { ...actual, watch }, watch };
} );
const lockRace = vi.hoisted( () => ( {
	refusals: 0,
	attempts: 0,
	pause: null as { lockName: string; reached: () => void; release: Promise< void > } | null,
} ) );

// Windows refuses to open a lockfile while another program still has the old
// one open as it is deleted; a test makes it happen on demand. A test can also
// hold the next taking of one lockfile, to interleave two operations exactly.
vi.mock( '@studio/common/lib/lockfile', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/common/lib/lockfile') >();
	return {
		...actual,
		lockFileAsync: async ( ...args: Parameters< typeof actual.lockFileAsync > ) => {
			lockRace.attempts++;
			const pause = lockRace.pause;
			if ( pause && args[ 0 ].endsWith( pause.lockName ) ) {
				lockRace.pause = null;
				pause.reached();
				await pause.release;
			}
			if ( lockRace.refusals > 0 ) {
				lockRace.refusals--;
				throw Object.assign( new Error( 'EPERM: operation not permitted, open' ), {
					code: 'EPERM',
				} );
			}
			return actual.lockFileAsync( ...args );
		},
	};
} );

// The module's own broker reaches the system keychain: never the real one from a test.
vi.mock( '@studio/common/lib/os-credential-store', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/common/lib/os-credential-store') >();
	return {
		...actual,
		createOsCredentialStore: (
			options?: Parameters< typeof actual.createOsCredentialStore >[ 0 ]
		) => ( options ? actual.createOsCredentialStore( options ) : systemKeychain.current!.store ),
	};
} );

const ISSUER = 'https://auth.openai.com';
const GRANTED_SCOPE =
	'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const UUID_V4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

// Placeholders only: nothing here is, or looks like, a real credential.
const SECRET_MARKERS = [ 'test-access-token', 'test-refresh-token', 'test-id-token' ];

const tokens = (
	id: number | string,
	overrides: Partial< ChatGptTokenSet > = {}
): ChatGptTokenSet => ( {
	accessToken: `test-access-token-${ id }`,
	refreshToken: `test-refresh-token-${ id }`,
	idToken: `test-id-token-${ id }`,
	tokenType: 'Bearer',
	expiresIn: 3600,
	scope: GRANTED_SCOPE,
	...overrides,
} );

const signIn = ( overrides: Partial< ChatGptSignIn > = {} ): ChatGptSignIn => ( {
	issuer: ISSUER,
	subject: 'test-subject-1',
	email: 'someone@example.com',
	clientId: 'test-issued-client-1',
	storage: 'vault',
	tokens: tokens( 1 ),
	...overrides,
} );

function expectNoSecret( ...values: unknown[] ) {
	for ( const value of values ) {
		const text =
			value instanceof Error
				? `${ value.message }\n${ value.stack }\n${ JSON.stringify( value ) }`
				: typeof value === 'string'
				? value
				: JSON.stringify( value );
		for ( const marker of SECRET_MARKERS ) {
			expect( text ).not.toContain( marker );
		}
	}
}

function deferred< T >() {
	let resolve!: ( value: T ) => void;
	const promise = new Promise< T >( ( settle ) => ( resolve = settle ) );
	return { promise, resolve };
}

const sleep = ( ms: number ) => new Promise( ( resolve ) => setTimeout( resolve, ms ) );

// Holds whatever next takes the lockfile named `lockName` until `release`.
function pauseNextLock( lockName: string ) {
	const reached = deferred< void >();
	const release = deferred< void >();
	lockRace.pause = { lockName, reached: () => reached.resolve(), release: release.promise };
	return { reached: reached.promise, release: () => release.resolve() };
}

// A promise's outcome as a value, so a rejection is never left unhandled.
const settled = ( promise: Promise< unknown > ) =>
	promise.then(
		( value ) => ( { value } ),
		( error: unknown ) => ( { error } )
	);

// The token service, scripted per test: by default every refresh succeeds with
// fresh tokens and every revocation is confirmed.
function createFakeTokenService() {
	const refreshes: Array< { clientId: string; refreshToken: string } > = [];
	const revocations: Array< { clientId: string; refreshToken: string } > = [];
	let renewals = 0;
	let refresh = async (): Promise< ChatGptTokenServiceResult< ChatGptTokenSet > > => ( {
		ok: true,
		value: tokens( `renewed-${ ++renewals }` ),
	} );
	let revoke = async (): Promise< ChatGptTokenServiceResult< void > > => ( {
		ok: true,
		value: undefined,
	} );
	const client: ChatGptTokenClient = {
		refresh: async ( { clientId, refreshToken } ) => {
			refreshes.push( { clientId, refreshToken } );
			return refresh();
		},
		revoke: async ( { clientId, refreshToken } ) => {
			revocations.push( { clientId, refreshToken } );
			return revoke();
		},
	};
	return {
		client,
		refreshes,
		revocations,
		answerRefresh( handler: typeof refresh ) {
			refresh = handler;
		},
		answerRevoke( handler: typeof revoke ) {
			revoke = handler;
		},
	};
}

// A turn driven the way the transport and the tool loop drive a handle: a
// token before each model request, a check before each tool call.
interface TurnScript {
	stream: ( signal: AbortSignal ) => AsyncIterable< string >;
	toolCall: ( signal: AbortSignal ) => Promise< string >;
}

async function runTurn( handle: ChatGptTurnHandle, script: TurnScript, log: string[] ) {
	try {
		await handle.getAccessToken();
		log.push( 'request' );
		for await ( const text of script.stream( handle.signal ) ) {
			log.push( `text ${ text }` );
		}
		const call = await script.toolCall( handle.signal );
		await handle.assertActive();
		log.push( `tool ${ call }` );
		await handle.getAccessToken();
		log.push( 'request' );
	} catch ( error ) {
		log.push( `stopped ${ ( error as { code?: string } ).code ?? ( error as Error ).name }` );
	} finally {
		handle.end();
	}
}

async function* streamUntilAborted( signal: AbortSignal ) {
	for ( let chunk = 1; ! signal.aborted; chunk++ ) {
		yield String( chunk );
		await sleep( 5 );
	}
	// Closing the connection takes a moment, within sign-out's wait.
	await sleep( 100 );
}

const untilAborted = ( signal: AbortSignal ) =>
	new Promise< never >( ( _resolve, reject ) => {
		if ( signal.aborted ) {
			reject( signal.reason );
		}
		signal.addEventListener( 'abort', () => reject( signal.reason ), { once: true } );
	} );

// The fake Windows PasswordVault behind the real Windows keychain adapter.
function createFakePasswordVault() {
	const items = new Map< string, string >();
	const run: CommandRunner = async ( _command, args, { input } ) => {
		const script = Buffer.from( args[ args.length - 1 ], 'base64' ).toString( 'utf16le' );
		const done = ( stdout = '' ) => ( { code: 0, stdout, stderr: '' } );
		const added = /PasswordCredential\('([^']+)', '([^']+)'/.exec( script );
		if ( added ) {
			items.set( `${ added[ 1 ] }/${ added[ 2 ] }`, input ?? '' );
			return done();
		}
		const retrieved = /\$vault\.Retrieve\('([^']+)', '([^']+)'\)/.exec( script );
		if ( ! retrieved ) {
			return done();
		}
		const name = `${ retrieved[ 1 ] }/${ retrieved[ 2 ] }`;
		if ( ! items.has( name ) ) {
			return { code: 3, stdout: '', stderr: '' };
		}
		if ( script.includes( '$vault.Remove($credential)' ) ) {
			items.delete( name );
			return done();
		}
		return done( items.get( name ) );
	};
	return { run, items };
}

describe( 'ChatGPT credential broker', () => {
	let configDir: string;
	let previousConfigDir: string | undefined;
	let keychain: FakeCredentialStore;
	let service: ReturnType< typeof createFakeTokenService >;

	const accountsPath = () => path.join( configDir, 'chatgpt-accounts.json' );
	const credentialsDir = () => path.join( configDir, 'chatgpt-credentials' );
	const vaultPath = ( registrationId: string ) =>
		path.join( credentialsDir(), `${ registrationId }.vault` );
	// Records, and any temp file a write left behind.
	const vaultFiles = () =>
		fs.existsSync( credentialsDir() )
			? fs
					.readdirSync( credentialsDir() )
					.filter( ( name ) => name.includes( '.vault' ) )
					.sort()
			: [];
	// Everything Studio wrote under the config directory, as text.
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

	// One process's broker; a test starts another to play a second app.
	function startBroker( options: Partial< ChatGptCredentialBrokerOptions > = {} ) {
		return createChatGptCredentialBroker( {
			tokenClient: service.client,
			credentialStore: keychain.store,
			timing: { turnSettleTimeoutMs: 200, revokeRetryDelaysMs: [ 1, 1 ] },
			...options,
		} );
	}

	const expiring = ( id: number | string = 1 ) => tokens( id, { expiresIn: 60 } );

	beforeEach( () => {
		configDir = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-chatgpt-broker-' ) );
		previousConfigDir = process.env.DEV_CONFIG_DIR;
		process.env.DEV_CONFIG_DIR = configDir;
		keychain = createFakeCredentialStore();
		systemKeychain.current = keychain;
		service = createFakeTokenService();
		lockRace.refusals = 0;
		lockRace.attempts = 0;
		lockRace.pause = null;
		fileWatching.refused = false;
	} );

	afterEach( () => {
		if ( previousConfigDir === undefined ) {
			delete process.env.DEV_CONFIG_DIR;
		} else {
			process.env.DEV_CONFIG_DIR = previousConfigDir;
		}
		fs.rmSync( configDir, { recursive: true, force: true, maxRetries: 5 } );
	} );

	describe( 'the account index', () => {
		it( 'makes each new sign-in a registration of its own, under an id minted for it', async () => {
			const broker = startBroker();
			const first = await broker.saveSignIn( signIn() );
			const second = await broker.saveSignIn(
				signIn( {
					subject: 'test-subject-2',
					email: 'other@example.com',
					clientId: 'test-issued-client-2',
					tokens: tokens( 2 ),
				} )
			);

			expect( first ).toMatchObject( {
				issuer: ISSUER,
				subject: 'test-subject-1',
				email: 'someone@example.com',
				clientId: 'test-issued-client-1',
				label: 'someone@example.com',
				revision: 1,
				logoutGeneration: 0,
				storage: 'vault',
				state: 'signed-in',
			} );
			for ( const account of [ first, second ] ) {
				expect( account.registrationId ).toMatch( new RegExp( `^${ UUID_V4 }$` ) );
			}
			expect( first.registrationId ).not.toBe( second.registrationId );
			expect( await readChatGptAccounts() ).toEqual( [ first, second ] );
			await expect( broker.getAccessToken( first.registrationId ) ).resolves.toBe(
				'test-access-token-1'
			);
			await expect( broker.getAccessToken( second.registrationId ) ).resolves.toBe(
				'test-access-token-2'
			);
		} );

		it( 'keeps one host id, generated once in the urn:uuid form and saved before it is used', async () => {
			const hostIds = await Promise.all( [ 1, 2, 3 ].map( () => getChatGptHostId() ) );

			expect( new Set( hostIds ).size ).toBe( 1 );
			expect( hostIds[ 0 ] ).toMatch( new RegExp( `^urn:uuid:${ UUID_V4 }$` ) );
			expect( JSON.parse( fs.readFileSync( accountsPath(), 'utf8' ) ).hostId ).toBe( hostIds[ 0 ] );
			const broker = startBroker();
			const { registrationId } = await broker.saveSignIn( signIn() );
			await broker.signOut( registrationId );
			await expect( getChatGptHostId() ).resolves.toBe( hostIds[ 0 ] );
		} );

		it( 'keeps a registration’s revision through a sign-in again, bumping it only when its issued client changes', async () => {
			const broker = startBroker();
			const account = await broker.saveSignIn( signIn() );

			const again = await broker.saveSignIn(
				signIn( { registrationId: account.registrationId, tokens: tokens( 2 ) } )
			);
			expect( again ).toMatchObject( { registrationId: account.registrationId, revision: 1 } );

			const reissued = await broker.saveSignIn(
				signIn( {
					registrationId: account.registrationId,
					clientId: 'test-issued-client-9',
					tokens: tokens( 3 ),
				} )
			);
			expect( reissued ).toMatchObject( { revision: 2, clientId: 'test-issued-client-9' } );
			await expect( broker.getAccessToken( account.registrationId ) ).resolves.toBe(
				'test-access-token-3'
			);
			expect( await readChatGptAccounts() ).toHaveLength( 1 );
		} );

		it.each( [
			[ 'as another account', { subject: 'test-subject-2' } ],
			[ 'from another issuer', { issuer: 'https://auth.example.com' } ],
			[
				'without the plan permission',
				{ tokens: tokens( 2, { scope: 'openid profile email offline_access' } ) },
			],
			[ 'without a refresh token', { tokens: tokens( 2, { refreshToken: undefined } ) } ],
			[ 'without an ID token', { tokens: tokens( 2, { idToken: undefined } ) } ],
			[ 'on the registration placeholder client', { clientId: 'dynamic_agent_client' } ],
		] )(
			'refuses a sign-in %s, leaving the registration as it was',
			async ( _label, overrides ) => {
				const broker = startBroker();
				const account = await broker.saveSignIn( signIn() );

				const failed = await broker
					.saveSignIn(
						signIn( { tokens: tokens( 2 ), registrationId: account.registrationId, ...overrides } )
					)
					.catch( ( error: unknown ) => error );

				expect( failed ).toBeInstanceOf( ChatGptConnectionError );
				expect( ( failed as ChatGptConnectionError ).code ).toBe(
					'subject' in overrides || 'issuer' in overrides ? 'identity-mismatch' : 'invalid-sign-in'
				);
				expect( await readChatGptAccounts() ).toEqual( [ account ] );
				await expect( startBroker().getAccessToken( account.registrationId ) ).resolves.toBe(
					'test-access-token-1'
				);
			}
		);

		it( 'gives registrations of the same email distinct labels, losing none when processes sign in at once', async () => {
			const brokers = [ startBroker(), startBroker() ];

			const accounts = await Promise.all(
				Array.from( { length: 6 }, ( _, n ) =>
					brokers[ n % 2 ].saveSignIn(
						signIn( {
							subject: `test-subject-${ n }`,
							clientId: `test-issued-client-${ n }`,
							tokens: tokens( n ),
						} )
					)
				)
			);

			const saved = await readChatGptAccounts();
			expect( saved.map( ( account ) => account.registrationId ).sort() ).toEqual(
				accounts.map( ( account ) => account.registrationId ).sort()
			);
			expect( new Set( saved.map( ( account ) => account.label ) ).size ).toBe( 6 );
			expect( saved.map( ( account ) => account.label ) ).toContain( 'someone@example.com (2)' );
		} );

		it( 'takes each lock Windows refuses for a moment while another process lets it go', async () => {
			// Refused three times in a row, then free.
			lockRace.refusals = 3;

			const account = await startBroker().saveSignIn( signIn() );

			expect( lockRace.refusals ).toBe( 0 );
			await expect( startBroker().getAccessToken( account.registrationId ) ).resolves.toBe(
				'test-access-token-1'
			);
		} );

		it( 'refuses an account list a newer Studio wrote rather than overwrite it', async () => {
			const newer = JSON.stringify( { version: 2, accounts: [] } );
			fs.writeFileSync( accountsPath(), newer );

			await expect( readChatGptAccounts() ).rejects.toMatchObject( {
				code: 'accounts-unreadable',
			} );
			await expect( startBroker().saveSignIn( signIn() ) ).rejects.toMatchObject( {
				code: 'accounts-unreadable',
			} );
			expect( fs.readFileSync( accountsPath(), 'utf8' ) ).toBe( newer );
			expect( vaultFiles() ).toEqual( [] );
		} );
	} );

	describe( 'the record vault', () => {
		it( 'seals each record with AES-256-GCM under a fresh IV, bound to its registration, with only the key in the keychain', async () => {
			const broker = startBroker();
			const first = await broker.saveSignIn( signIn() );
			// The same account and client, signed in as a registration of its own.
			const second = await broker.saveSignIn( signIn( { tokens: tokens( 2 ) } ) );

			const sealed = fs.readFileSync( vaultPath( first.registrationId ), 'utf8' );
			expectNoSecret( sealed );
			const envelope = JSON.parse( sealed );
			expect( envelope ).toMatchObject( { version: 1 } );
			expect( Buffer.from( envelope.iv, 'base64' ) ).toHaveLength( 12 );
			expect( Buffer.from( envelope.tag, 'base64' ) ).toHaveLength( 16 );
			expect( [ ...keychain.items.keys() ] ).toEqual( [ 'chatgpt-vault-key' ] );
			expect( Buffer.from( keychain.items.get( 'chatgpt-vault-key' )!, 'base64url' ) ).toHaveLength(
				32
			);

			await broker.saveSignIn(
				signIn( { registrationId: first.registrationId, tokens: tokens( 3 ) } )
			);
			expect(
				JSON.parse( fs.readFileSync( vaultPath( first.registrationId ), 'utf8' ) ).iv
			).not.toBe( envelope.iv );

			// One registration's record copied over another's is never read as that one's.
			fs.copyFileSync( vaultPath( first.registrationId ), vaultPath( second.registrationId ) );
			await expect( startBroker().getAccessToken( second.registrationId ) ).rejects.toMatchObject( {
				code: 'needs-sign-in',
			} );
			await expect( startBroker().getAccessToken( first.registrationId ) ).resolves.toBe(
				'test-access-token-3'
			);
		} );

		it( 'refuses a record sealed for another registration, even one rewritten to name this one', async () => {
			const broker = startBroker();
			const first = await broker.saveSignIn( signIn() );
			const second = await broker.saveSignIn( signIn( { tokens: tokens( 2 ) } ) );
			// The vault's own format and key, as only something holding the key could use them.
			const key = Buffer.from( keychain.items.get( 'chatgpt-vault-key' )!, 'base64url' );
			const aad = ( registrationId: string ) =>
				Buffer.from( `studio.chatgpt-credentials.v1:${ registrationId }` );
			const sealed = JSON.parse( fs.readFileSync( vaultPath( first.registrationId ), 'utf8' ) );
			const decipher = crypto.createDecipheriv(
				'aes-256-gcm',
				key,
				Buffer.from( sealed.iv, 'base64' ),
				{ authTagLength: 16 }
			);
			decipher.setAAD( aad( first.registrationId ) );
			decipher.setAuthTag( Buffer.from( sealed.tag, 'base64' ) );
			const renamed = {
				...JSON.parse(
					Buffer.concat( [
						decipher.update( Buffer.from( sealed.ciphertext, 'base64' ) ),
						decipher.final(),
					] ).toString( 'utf8' )
				),
				registrationId: second.registrationId,
			};
			const seal = ( registrationId: string ) => {
				const iv = crypto.randomBytes( 12 );
				const cipher = crypto.createCipheriv( 'aes-256-gcm', key, iv, { authTagLength: 16 } );
				cipher.setAAD( aad( registrationId ) );
				const ciphertext = Buffer.concat( [
					cipher.update( JSON.stringify( renamed ), 'utf8' ),
					cipher.final(),
				] );
				return JSON.stringify( {
					version: 1,
					iv: iv.toString( 'base64' ),
					tag: cipher.getAuthTag().toString( 'base64' ),
					ciphertext: ciphertext.toString( 'base64' ),
				} );
			};

			fs.writeFileSync( vaultPath( second.registrationId ), seal( first.registrationId ) );
			await expect( startBroker().getAccessToken( second.registrationId ) ).rejects.toMatchObject( {
				code: 'needs-sign-in',
			} );

			// Sealed for the second registration, the same record is read: the refusal was the binding's.
			await broker.saveSignIn(
				signIn( { registrationId: second.registrationId, tokens: tokens( 3 ) } )
			);
			fs.writeFileSync( vaultPath( second.registrationId ), seal( second.registrationId ) );
			await expect( startBroker().getAccessToken( second.registrationId ) ).resolves.toBe(
				'test-access-token-1'
			);
		} );

		const NEWER_RECORD = JSON.stringify( { version: 2, sealed: 'by a newer version of Studio' } );

		it( 'refuses a record a newer Studio wrote, keeping it and the registration as they are', async () => {
			const broker = startBroker();
			const account = await broker.saveSignIn( signIn() );
			fs.writeFileSync( vaultPath( account.registrationId ), NEWER_RECORD );

			for ( const reader of [ broker, startBroker() ] ) {
				await expect( reader.getAccessToken( account.registrationId ) ).rejects.toMatchObject( {
					code: 'newer-format',
				} );
			}
			await expect( broker.readIdTokenHint( account.registrationId ) ).resolves.toBeNull();
			expect( fs.readFileSync( vaultPath( account.registrationId ), 'utf8' ) ).toBe( NEWER_RECORD );
			expect( await readChatGptAccounts() ).toEqual( [ account ] );
			expect( service.refreshes ).toEqual( [] );
		} );

		it( 'refuses a newer record it finds once the refresh lock is free, rather than clear it', async () => {
			const broker = startBroker();
			const account = await broker.saveSignIn( signIn( { tokens: expiring() } ) );
			const refresh = deferred< ChatGptTokenServiceResult< ChatGptTokenSet > >();
			service.answerRefresh( () => refresh.promise );
			const holding = broker.getAccessToken( account.registrationId );
			await vi.waitFor( () => expect( service.refreshes ).toHaveLength( 1 ) );
			// Another process reads the expiring record, then waits for the lock.
			const attempts = lockRace.attempts;
			const waiting = startBroker().getAccessToken( account.registrationId );
			await vi.waitFor( () => expect( lockRace.attempts ).toBeGreaterThan( attempts ) );

			fs.writeFileSync( vaultPath( account.registrationId ), NEWER_RECORD );
			refresh.resolve( { ok: false, error: { kind: 'transient', status: 503 } } );

			await expect( holding ).rejects.toMatchObject( { code: 'refresh-failed' } );
			await expect( waiting ).rejects.toMatchObject( { code: 'newer-format' } );
			expect( fs.readFileSync( vaultPath( account.registrationId ), 'utf8' ) ).toBe( NEWER_RECORD );
			expect( await readChatGptAccounts() ).toEqual( [ account ] );
		} );

		it( 'reads the keychain again before giving up on a record its key can’t open', async () => {
			const app = startBroker();
			const { registrationId } = await app.saveSignIn( signIn() );
			// The keychain item went, and another process signed in again under a new key.
			keychain.items.clear();
			await startBroker().saveSignIn( signIn( { registrationId, tokens: tokens( 2 ) } ) );

			await expect( app.getAccessToken( registrationId ) ).resolves.toBe( 'test-access-token-2' );
			expect( await readChatGptAccount( registrationId ) ).toMatchObject( { state: 'signed-in' } );
		} );

		it.each( [ 'clientId', 'subject' ] as const )(
			'refuses a record whose %s differs from its registration’s',
			async ( field ) => {
				const { registrationId } = await startBroker().saveSignIn( signIn() );
				const index = JSON.parse( fs.readFileSync( accountsPath(), 'utf8' ) );
				index.accounts[ 0 ][ field ] = 'test-other-value';
				fs.writeFileSync( accountsPath(), JSON.stringify( index ) );

				await expect( startBroker().getAccessToken( registrationId ) ).rejects.toMatchObject( {
					code: 'needs-sign-in',
				} );
				expect( service.refreshes ).toEqual( [] );
			}
		);

		it( 'round-trips a 16 KB record byte for byte, keeping only the 32-byte key in Windows’ PasswordVault', async () => {
			const passwordVault = createFakePasswordVault();
			const credentialStore = createOsCredentialStore( {
				platform: 'win32',
				run: passwordVault.run,
			} );
			const material = ( prefix: string, size: number ) =>
				`${ prefix }.`.padEnd(
					size,
					'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.'
				);
			const large = tokens( 1, {
				accessToken: material( 'test-access-token', 16 * 1024 ),
				idToken: material( 'test-id-token', 8 * 1024 ),
				refreshToken: material( 'test-refresh-token', 2 * 1024 ),
			} );

			const { registrationId } = await startBroker( { credentialStore } ).saveSignIn(
				signIn( { tokens: large } )
			);

			const reader = startBroker( { credentialStore } );
			await expect( reader.getAccessToken( registrationId ) ).resolves.toBe( large.accessToken );
			await expect( reader.readIdTokenHint( registrationId ) ).resolves.toBe( large.idToken );
			await reader.signOut( registrationId );
			expect( service.revocations ).toEqual( [
				{ clientId: 'test-issued-client-1', refreshToken: large.refreshToken },
			] );
			expect( [ ...passwordVault.items.keys() ] ).toEqual( [
				'wordpress-studio/chatgpt-vault-key',
			] );
			const [ key ] = passwordVault.items.values();
			expect( key ).toMatch( /^[A-Za-z0-9_-]{43}$/ );
			expect( Buffer.from( key, 'base64url' ) ).toHaveLength( 32 );
		} );

		it( 'never writes tokens anywhere when the keychain is unavailable', async () => {
			keychain.state.available = false;

			const failed = await startBroker()
				.saveSignIn( signIn() )
				.catch( ( error: unknown ) => error );

			expect( failed ).toMatchObject( { code: 'vault-unavailable' } );
			expectNoSecret( failed );
			expect( await readChatGptAccounts() ).toEqual( [] );
			expect( vaultFiles() ).toEqual( [] );
			expectNoSecret( readAllFiles() );
		} );

		it( 'keeps a stored sign-in while the keychain can’t be reached to unlock it', async () => {
			const { registrationId } = await startBroker().saveSignIn( signIn( { tokens: expiring() } ) );
			keychain.state.available = false;

			await expect( startBroker().getAccessToken( registrationId ) ).rejects.toMatchObject( {
				code: 'vault-unavailable',
			} );
			expect( await readChatGptAccount( registrationId ) ).toMatchObject( { state: 'signed-in' } );
			expect( vaultFiles() ).toEqual( [ `${ registrationId }.vault` ] );
			expect( service.refreshes ).toEqual( [] );

			keychain.state.available = true;
			await expect( startBroker().getAccessToken( registrationId ) ).resolves.toBe(
				'test-access-token-renewed-1'
			);
		} );

		it( 'keeps the previous record when the app is killed during a vault write, and cleans up after it', async () => {
			const keychainFile = path.join( configDir, 'test-keychain.json' );
			const options = {
				credentialStore: createFileCredentialStore( keychainFile ),
				timing: { refreshLockStaleMs: 500 },
			};
			const { registrationId } = await startBroker( options ).saveSignIn( signIn() );

			const crashing = startBrokerProcess( [
				'crash-before-vault-rename',
				keychainFile,
				'http://127.0.0.1:9',
				registrationId,
			] );
			crashing.child.stdin.write(
				`${ JSON.stringify( signIn( { registrationId, tokens: tokens( 2 ) } ) ) }\n`
			);
			const exit = await crashing.exited;

			// Killed before it could report, with its temp file left behind.
			expect( exit ).not.toEqual( { code: 0, signal: null } );
			expect( crashing.output() ).toBe( '' );
			expect( vaultFiles() ).toEqual( [
				`${ registrationId }.vault`,
				expect.stringMatching( new RegExp( `^${ registrationId }\\.vault\\.tmp-` ) ),
			] );
			await expect( startBroker( options ).getAccessToken( registrationId ) ).resolves.toBe(
				'test-access-token-1'
			);
			expect( await readChatGptAccount( registrationId ) ).toMatchObject( {
				state: 'signed-in',
				revision: 1,
			} );

			// The next write, once the dead process's lock is stale, replaces the record and the leftover.
			await startBroker( options ).saveSignIn( signIn( { registrationId, tokens: tokens( 3 ) } ) );
			expect( vaultFiles() ).toEqual( [ `${ registrationId }.vault` ] );
			await expect( startBroker( options ).getAccessToken( registrationId ) ).resolves.toBe(
				'test-access-token-3'
			);
		}, 60_000 );
	} );

	describe( 'access tokens', () => {
		it( 'returns the saved token while it has more than five minutes left', async () => {
			const broker = startBroker();
			const { registrationId } = await broker.saveSignIn(
				signIn( { tokens: tokens( 1, { expiresIn: 6 * 60 } ) } )
			);

			await expect( broker.getAccessToken( registrationId ) ).resolves.toBe(
				'test-access-token-1'
			);
			expect( service.refreshes ).toEqual( [] );
		} );

		it( 'renews a token within five minutes of expiry with the issued client, replacing token, expiry and refresh token together', async () => {
			const broker = startBroker();
			const { registrationId } = await broker.saveSignIn(
				signIn( { tokens: tokens( 1, { expiresIn: 4 * 60 } ) } )
			);
			service.answerRefresh( async () => ( { ok: true, value: tokens( 2 ) } ) );

			await expect( broker.getAccessToken( registrationId ) ).resolves.toBe(
				'test-access-token-2'
			);
			expect( service.refreshes ).toEqual( [
				{ clientId: 'test-issued-client-1', refreshToken: 'test-refresh-token-1' },
			] );
			// The replacement holds for its own hour, in every process.
			await expect( startBroker().getAccessToken( registrationId ) ).resolves.toBe(
				'test-access-token-2'
			);
			expect( service.refreshes ).toHaveLength( 1 );
			// The verified ID token stays; a refresh response's is never taken unverified.
			await expect( broker.readIdTokenHint( registrationId ) ).resolves.toBe( 'test-id-token-1' );
			await broker.signOut( registrationId );
			expect( service.revocations ).toEqual( [
				{ clientId: 'test-issued-client-1', refreshToken: 'test-refresh-token-2' },
			] );
		} );

		it( 'keeps the grant’s scopes when a renewal doesn’t restate them', async () => {
			const broker = startBroker();
			const { registrationId } = await broker.saveSignIn( signIn( { tokens: expiring() } ) );
			service.answerRefresh( async () => ( {
				ok: true,
				value: tokens( 2, { scope: undefined, refreshToken: undefined, idToken: undefined } ),
			} ) );

			await expect( broker.getAccessToken( registrationId ) ).resolves.toBe(
				'test-access-token-2'
			);
			await broker.signOut( registrationId );
			// A response without a refresh token keeps the one it renewed with.
			expect( service.revocations ).toEqual( [
				{ clientId: 'test-issued-client-1', refreshToken: 'test-refresh-token-1' },
			] );
		} );

		it( 'treats exactly the documented refresh errors as terminal', () => {
			expect( [ ...CHATGPT_TERMINAL_REFRESH_ERRORS ].sort() ).toEqual( [
				'invalid_grant',
				'invalid_refresh_token',
				'refresh_token_expired',
				'refresh_token_invalidated',
				'refresh_token_reused',
				'token_expired',
			] );
		} );

		it.each( [ 'invalid_grant', 'refresh_token_reused' ] )(
			'clears the tokens and asks for sign-in again after %s, keeping the registration',
			async ( code ) => {
				const broker = startBroker();
				const account = await broker.saveSignIn( signIn( { tokens: expiring() } ) );
				const hostId = await getChatGptHostId();
				service.answerRefresh( async () => ( {
					ok: false,
					error: { kind: 'terminal', code, status: 400 },
				} ) );

				await expect( broker.getAccessToken( account.registrationId ) ).rejects.toMatchObject( {
					code: 'needs-sign-in',
				} );
				expect( vaultFiles() ).toEqual( [] );
				expect( await readChatGptAccount( account.registrationId ) ).toEqual( {
					...account,
					state: 'needs-sign-in',
					updatedAt: expect.any( String ),
				} );
				await expect( getChatGptHostId() ).resolves.toBe( hostId );
				expect( await broker.listConnections() ).toEqual( [
					expect.objectContaining( {
						connectionId: account.registrationId,
						authStatus: 'disconnected',
					} ),
				] );
			}
		);

		it.each( [
			[
				'a server error',
				async (): Promise< ChatGptTokenServiceResult< ChatGptTokenSet > > => ( {
					ok: false,
					error: { kind: 'transient', status: 503 },
				} ),
			],
			[
				'an unreachable service',
				async (): Promise< ChatGptTokenServiceResult< ChatGptTokenSet > > => {
					throw new Error( 'connect ECONNREFUSED 127.0.0.1:443' );
				},
			],
		] )( 'keeps the credentials through %s', async ( _label, failure ) => {
			const broker = startBroker();
			const { registrationId } = await broker.saveSignIn( signIn( { tokens: expiring() } ) );
			service.answerRefresh( failure );

			await expect( broker.getAccessToken( registrationId ) ).rejects.toMatchObject( {
				code: 'refresh-failed',
			} );
			expect( await readChatGptAccount( registrationId ) ).toMatchObject( { state: 'signed-in' } );

			service.answerRefresh( async () => ( { ok: true, value: tokens( 2 ) } ) );
			await expect( broker.getAccessToken( registrationId ) ).resolves.toBe(
				'test-access-token-2'
			);
			expect( service.refreshes.map( ( request ) => request.refreshToken ) ).toEqual( [
				'test-refresh-token-1',
				'test-refresh-token-1',
			] );
		} );

		it( 'clears the tokens when a renewal comes back without the plan permission', async () => {
			const broker = startBroker();
			const { registrationId } = await broker.saveSignIn( signIn( { tokens: expiring() } ) );
			service.answerRefresh( async () => ( {
				ok: true,
				value: tokens( 2, { scope: 'openid profile email offline_access' } ),
			} ) );

			await expect( broker.getAccessToken( registrationId ) ).rejects.toMatchObject( {
				code: 'needs-sign-in',
			} );
			expect( vaultFiles() ).toEqual( [] );
			expect( await readChatGptAccount( registrationId ) ).toMatchObject( {
				state: 'needs-sign-in',
			} );
			// The replacement it won't keep is revoked rather than left valid.
			await vi.waitFor( () =>
				expect( service.revocations ).toEqual( [
					{ clientId: 'test-issued-client-1', refreshToken: 'test-refresh-token-2' },
				] )
			);
		} );

		it( 'renews once for every caller waiting in one process', async () => {
			const broker = startBroker();
			const { registrationId } = await broker.saveSignIn( signIn( { tokens: expiring() } ) );

			const results = await Promise.all(
				[ 1, 2, 3 ].map( () => broker.getAccessToken( registrationId ) )
			);

			expect( results ).toEqual( Array( 3 ).fill( 'test-access-token-renewed-1' ) );
			expect( service.refreshes ).toHaveLength( 1 );
		} );

		it( 'renews once across processes: one refresh reaches the service, and both use the record it committed', async () => {
			const tokenService = await startMockTokenService( {
				refreshToken: 'test-refresh-token-1',
				delayMs: 300,
			} );
			onTestFinished( () => tokenService.close() );
			const keychainFile = path.join( configDir, 'test-keychain.json' );
			const options = {
				credentialStore: createFileCredentialStore( keychainFile ),
				tokenClient: createHttpTokenClient( tokenService.url ),
			};
			const app = startBroker( options );
			const { registrationId } = await app.saveSignIn( signIn( { tokens: expiring() } ) );

			const processes = [ 1, 2 ].map( () =>
				startBrokerProcess( [ 'get-access-token', keychainFile, tokenService.url, registrationId ] )
			);
			for ( const other of processes ) {
				expect( await other.nextLine() ).toBe( 'ready' );
			}
			const outcomes = processes.map( ( other ) => other.nextLine() );
			for ( const other of processes ) {
				other.child.stdin.write( 'go\n' );
			}
			const results = ( await Promise.all( outcomes ) ).map( ( line ) => JSON.parse( line ) );

			const committed = tokenService.issued();
			expect( tokenService.refreshes ).toEqual( [ 'test-refresh-token-1' ] );
			expect( results ).toEqual( [
				{ ok: true, value: committed?.accessToken },
				{ ok: true, value: committed?.accessToken },
			] );
			await expect( startBroker( options ).getAccessToken( registrationId ) ).resolves.toBe(
				committed?.accessToken
			);
			await app.signOut( registrationId );
			expect( tokenService.revocations ).toEqual( [ committed?.refreshToken ] );
		}, 60_000 );
	} );

	describe( 'the logout generation', () => {
		it( 'abandons refreshes that finish or start after sign-out began, so none can bring tokens back', async () => {
			const broker = startBroker();
			const { registrationId } = await broker.saveSignIn( signIn( { tokens: expiring() } ) );
			const refresh = deferred< ChatGptTokenServiceResult< ChatGptTokenSet > >();
			service.answerRefresh( () => refresh.promise );

			const inFlight = broker.getAccessToken( registrationId );
			await vi.waitFor( () => expect( service.refreshes ).toHaveLength( 1 ) );
			// Waits for the lock the refresh in flight holds.
			const waiting = broker.getAccessToken( registrationId );
			const signingOut = broker.signOut( registrationId );
			await vi.waitFor( async () =>
				expect( await readChatGptAccount( registrationId ) ).toMatchObject( {
					state: 'signed-out',
					logoutGeneration: 1,
				} )
			);
			refresh.resolve( { ok: true, value: tokens( 2 ) } );

			await expect( inFlight ).rejects.toMatchObject( { code: 'signed-out' } );
			await expect( waiting ).rejects.toMatchObject( { code: 'signed-out' } );
			await expect( signingOut ).resolves.toEqual( {
				localCleared: true,
				remoteRevocationConfirmed: true,
			} );
			expect( service.refreshes ).toHaveLength( 1 );
			expect( vaultFiles() ).toEqual( [] );
			await expect( broker.getAccessToken( registrationId ) ).rejects.toMatchObject( {
				code: 'signed-out',
			} );
			// Sign-out revoked the token it found; the abandoned refresh's replacement isn't left valid.
			await vi.waitFor( () =>
				expect( service.revocations.map( ( request ) => request.refreshToken ).sort() ).toEqual( [
					'test-refresh-token-1',
					'test-refresh-token-2',
				] )
			);
		} );
	} );

	describe( 'a sign-in and a sign-out at once', () => {
		it( 'refuses a sign-in that a sign-out overtook, leaving no record and the account signed out', async () => {
			const broker = startBroker();
			const { registrationId } = await broker.saveSignIn( signIn() );
			// The sign-in has written its record and waits to update the account list.
			const accountList = pauseNextLock( 'chatgpt-accounts.json.lock' );
			const signingIn = settled(
				broker.saveSignIn( signIn( { registrationId, tokens: tokens( 2 ) } ) )
			);
			await accountList.reached;
			// Another process signs out meanwhile, then waits for the sign-in's refresh lock.
			const signingOut = startBroker().signOut( registrationId );
			await vi.waitFor( async () =>
				expect( await readChatGptAccount( registrationId ) ).toMatchObject( {
					state: 'signed-out',
					logoutGeneration: 1,
				} )
			);
			accountList.release();

			expect( await signingIn ).toEqual( {
				error: expect.objectContaining( { code: 'signed-out' } ),
			} );
			await expect( signingOut ).resolves.toEqual( {
				localCleared: true,
				remoteRevocationConfirmed: true,
			} );
			expect( vaultFiles() ).toEqual( [] );
			expect( await readChatGptAccount( registrationId ) ).toMatchObject( {
				state: 'signed-out',
				logoutGeneration: 1,
			} );
			// The sign-out revoked the tokens it ended; the refused sign-in's aren't left valid.
			await vi.waitFor( () =>
				expect( service.revocations.map( ( request ) => request.refreshToken ).sort() ).toEqual( [
					'test-refresh-token-1',
					'test-refresh-token-2',
				] )
			);

			// A sign-in after the sign-out is saved as usual.
			await expect(
				broker.saveSignIn( signIn( { registrationId, tokens: tokens( 3 ) } ) )
			).resolves.toMatchObject( { state: 'signed-in', logoutGeneration: 1 } );
			await expect( startBroker().getAccessToken( registrationId ) ).resolves.toBe(
				'test-access-token-3'
			);
		} );

		it( 'leaves what a sign-in saved when it began after the sign-out did', async () => {
			const broker = startBroker();
			const { registrationId } = await broker.saveSignIn( signIn() );
			// The sign-out has begun, and waits for the refresh lock before clearing.
			const refreshLock = pauseNextLock( `${ registrationId }.lock` );
			const signingOut = startBroker().signOut( registrationId );
			await refreshLock.reached;

			await expect(
				broker.saveSignIn( signIn( { registrationId, tokens: tokens( 2 ) } ) )
			).resolves.toMatchObject( { state: 'signed-in', logoutGeneration: 1 } );
			refreshLock.release();

			// It cleared nothing it could find from before; the tokens it ended were replaced.
			await expect( signingOut ).resolves.toEqual( {
				localCleared: true,
				remoteRevocationConfirmed: false,
			} );
			expect( await readChatGptAccount( registrationId ) ).toMatchObject( {
				state: 'signed-in',
				logoutGeneration: 1,
			} );
			await expect( startBroker().getAccessToken( registrationId ) ).resolves.toBe(
				'test-access-token-2'
			);
			expect( service.revocations ).toEqual( [] );
		} );

		it( 'leaves a session-only sign-in that began after the sign-out did', async () => {
			const app = startBroker( { timing: { turnSettleTimeoutMs: 10_000 } } );
			const { registrationId } = await app.saveSignIn( signIn( { storage: 'session' } ) );
			// A turn that settles only when the test says keeps the sign-out waiting.
			const turn = await app.beginTurn( registrationId );
			const signingOut = app.signOut( registrationId );
			await vi.waitFor( async () =>
				expect( await readChatGptAccount( registrationId ) ).toMatchObject( {
					state: 'signed-out',
				} )
			);

			await app.saveSignIn( signIn( { registrationId, storage: 'session', tokens: tokens( 2 ) } ) );
			turn.end();

			await expect( signingOut ).resolves.toEqual( {
				localCleared: true,
				remoteRevocationConfirmed: false,
			} );
			await expect( app.getAccessToken( registrationId ) ).resolves.toBe( 'test-access-token-2' );
			expect( app.getSessionForkEnvironment() ).toEqual( {
				STUDIO_CHATGPT_SESSIONS_OFFERED: registrationId,
			} );
			expect( service.revocations ).toEqual( [] );
		} );
	} );

	describe( 'sign-out', () => {
		it( 'revokes the refresh token, then clears every token, keeping the registration, its issued client and the host id', async () => {
			const broker = startBroker();
			const account = await broker.saveSignIn( signIn() );
			const hostId = await getChatGptHostId();

			await expect( broker.signOut( account.registrationId ) ).resolves.toEqual( {
				localCleared: true,
				remoteRevocationConfirmed: true,
			} );

			expect( service.revocations ).toEqual( [
				{ clientId: 'test-issued-client-1', refreshToken: 'test-refresh-token-1' },
			] );
			expect( vaultFiles() ).toEqual( [] );
			expect( await readChatGptAccount( account.registrationId ) ).toMatchObject( {
				state: 'signed-out',
				clientId: 'test-issued-client-1',
				revision: 1,
				logoutGeneration: 1,
			} );
			await expect( getChatGptHostId() ).resolves.toBe( hostId );
			for ( const call of [
				() => broker.getAccessToken( account.registrationId ),
				() => broker.beginTurn( account.registrationId ),
			] ) {
				await expect( call() ).rejects.toMatchObject( { code: 'signed-out' } );
			}
			await expect( broker.readIdTokenHint( account.registrationId ) ).resolves.toBeNull();

			// Signing in again reuses the registration and its client.
			await expect(
				broker.saveSignIn(
					signIn( { registrationId: account.registrationId, tokens: tokens( 2 ) } )
				)
			).resolves.toMatchObject( { state: 'signed-in', revision: 1, logoutGeneration: 1 } );
			await expect( broker.getAccessToken( account.registrationId ) ).resolves.toBe(
				'test-access-token-2'
			);
		} );

		it.each( [
			[ 'retries through server errors until revocation is confirmed', [ 503 ], true, 2 ],
			[
				'reports revocation unconfirmed after retrying through server errors',
				[ 503, 503, 503 ],
				false,
				3,
			],
			[ 'doesn’t retry a revocation the service refused', [ 400 ], false, 1 ],
		] )( '%s', async ( _label, failures, confirmed, attempts ) => {
			const broker = startBroker();
			const { registrationId } = await broker.saveSignIn( signIn() );
			const pending = [ ...failures ];
			service.answerRevoke( async () => {
				const status = pending.shift();
				return status === undefined
					? { ok: true, value: undefined }
					: { ok: false, error: { kind: status >= 500 ? 'transient' : 'terminal', status } };
			} );

			await expect( broker.signOut( registrationId ) ).resolves.toEqual( {
				localCleared: true,
				remoteRevocationConfirmed: confirmed,
			} );
			expect( service.revocations ).toHaveLength( attempts );
			expect( vaultFiles() ).toEqual( [] );
		} );

		it( 'ends a streaming turn before it returns: nothing more is streamed', async () => {
			const broker = startBroker();
			const { registrationId } = await broker.saveSignIn( signIn() );
			const handle = await broker.beginTurn( registrationId );
			const log: string[] = [];
			const turn = runTurn(
				handle,
				{ stream: streamUntilAborted, toolCall: ( signal ) => untilAborted( signal ) },
				log
			);
			await vi.waitFor( () =>
				expect( log.filter( ( entry ) => entry.startsWith( 'text' ) ).length ).toBeGreaterThan( 2 )
			);

			await broker.signOut( registrationId );

			expect( handle.signal.aborted ).toBe( true );
			expect( log.at( -1 ) ).toBe( 'stopped signed-out' );
			const settled = [ ...log ];
			await sleep( 50 );
			await turn;
			expect( log ).toEqual( settled );
			expect( log.filter( ( entry ) => entry === 'request' ) ).toHaveLength( 1 );
		} );

		it( 'never runs a tool call that was pending when it signed out', async () => {
			const broker = startBroker();
			const { registrationId } = await broker.saveSignIn( signIn() );
			const handle = await broker.beginTurn( registrationId );
			const log: string[] = [];
			// Waiting for the user's approval, which doesn't watch the turn's signal.
			const approval = deferred< string >();
			const turn = runTurn(
				handle,
				{
					stream: async function* () {
						yield 'calling a tool';
					},
					toolCall: () => approval.promise,
				},
				log
			);
			await vi.waitFor( () => expect( log ).toContain( 'text calling a tool' ) );

			// Doesn't wait past its bound for a turn that won't settle.
			await expect( broker.signOut( registrationId ) ).resolves.toMatchObject( {
				localCleared: true,
			} );
			approval.resolve( 'delete_site' );
			await turn;

			expect( log ).toEqual( [ 'request', 'text calling a tool', 'stopped signed-out' ] );
		} );

		it( 'stops turns in another process at their next model request or tool call', async () => {
			const app = startBroker();
			const { registrationId } = await app.saveSignIn( signIn() );
			const toolTurn = await app.beginTurn( registrationId );
			const modelTurn = await app.beginTurn( registrationId );
			const log: string[] = [];
			const approval = deferred< string >();
			const turn = runTurn(
				toolTurn,
				{
					stream: async function* () {
						yield 'calling a tool';
					},
					toolCall: () => approval.promise,
				},
				log
			);
			await vi.waitFor( () => expect( log ).toContain( 'text calling a tool' ) );

			await startBroker().signOut( registrationId );
			approval.resolve( 'delete_site' );
			await turn;

			expect( log ).toEqual( [ 'request', 'text calling a tool', 'stopped signed-out' ] );
			expect( toolTurn.signal.aborted ).toBe( true );
			await expect( modelTurn.getAccessToken() ).rejects.toMatchObject( { code: 'signed-out' } );
			expect( modelTurn.signal.aborted ).toBe( true );
			modelTurn.end();
		} );

		it( 'stops a turn streaming in another process within the watch bound, after which it sends nothing', async () => {
			const keychainFile = path.join( configDir, 'test-keychain.json' );
			const app = startBroker( { credentialStore: createFileCredentialStore( keychainFile ) } );
			const { registrationId } = await app.saveSignIn( signIn() );
			const turn = startBrokerProcess( [
				'hold-turn',
				keychainFile,
				'http://127.0.0.1:9',
				registrationId,
			] );
			await turn.waitForLine( ( line ) => line.startsWith( 'chunk' ), 30_000 );

			const signingOut = Date.now();
			await app.signOut( registrationId );
			const aborted = await turn.waitForLine(
				( line ) => line.startsWith( '{"aborted"' ),
				CHATGPT_TURN_WATCH_POLL_MS + 3_000
			);
			const stoppedWithin = Date.now() - signingOut;
			await turn.exited;

			expect( JSON.parse( aborted ) ).toEqual( { aborted: 'signed-out' } );
			expect( stoppedWithin ).toBeLessThan( CHATGPT_TURN_WATCH_POLL_MS + 1_000 );
			const lines = turn.lines();
			expect(
				lines.slice( lines.indexOf( aborted ) + 1 ).filter( ( line ) => line.startsWith( 'chunk' ) )
			).toEqual( [] );
		}, 60_000 );

		it( 'still stops a turn where the account list can’t be watched, by reading it within the poll bound', async () => {
			fileWatching.refused = true;
			const app = startBroker( { timing: { accountsPollMs: 100 } } );
			const { registrationId } = await app.saveSignIn( signIn() );
			const handle = await app.beginTurn( registrationId );

			await startBroker().signOut( registrationId );

			await vi.waitFor( () => expect( handle.signal.aborted ).toBe( true ), { timeout: 2_000 } );
			expect( handle.signal.reason ).toMatchObject( { code: 'signed-out' } );
			handle.end();
		} );

		it( 'stops a turn whose connection was signed in again under another client', async () => {
			const broker = startBroker();
			const { registrationId } = await broker.saveSignIn( signIn() );
			const handle = await broker.beginTurn( registrationId );

			await broker.saveSignIn(
				signIn( { registrationId, clientId: 'test-issued-client-9', tokens: tokens( 2 ) } )
			);

			await expect( handle.assertActive() ).rejects.toMatchObject( { code: 'changed' } );
			expect( handle.signal.aborted ).toBe( true );
			handle.end();
		} );
	} );

	describe( 'session-only sign-in', () => {
		it( 'keeps the tokens in this process’s memory only, renewing them there', async () => {
			keychain.state.available = false;
			const app = startBroker();

			const account = await app.saveSignIn( signIn( { storage: 'session', tokens: expiring() } ) );

			expect( account.storage ).toBe( 'session' );
			await expect( app.getAccessToken( account.registrationId ) ).resolves.toBe(
				'test-access-token-renewed-1'
			);
			expect( service.refreshes ).toEqual( [
				{ clientId: 'test-issued-client-1', refreshToken: 'test-refresh-token-1' },
			] );
			expect( vaultFiles() ).toEqual( [] );
			expectNoSecret( readAllFiles() );
			// Another process, or this app once restarted, has nothing to use.
			await expect( startBroker().getAccessToken( account.registrationId ) ).rejects.toMatchObject(
				{
					code: 'session-unavailable',
				}
			);
		} );

		it( 'never brings back a stored record, nor answers with another registration', async () => {
			const app = startBroker();
			const account = await app.saveSignIn( signIn() );
			const other = await app.saveSignIn(
				signIn( {
					subject: 'test-subject-2',
					clientId: 'test-issued-client-2',
					tokens: tokens( 2 ),
				} )
			);
			const storedRecord = fs.readFileSync( vaultPath( account.registrationId ) );

			await app.saveSignIn(
				signIn( {
					registrationId: account.registrationId,
					storage: 'session',
					tokens: tokens( 3 ),
				} )
			);

			expect( vaultFiles() ).toEqual( [ `${ other.registrationId }.vault` ] );
			await expect( app.getAccessToken( account.registrationId ) ).resolves.toBe(
				'test-access-token-3'
			);
			// Even with its old record put back, a restarted app reads no record for it.
			fs.writeFileSync( vaultPath( account.registrationId ), storedRecord );
			const restarted = startBroker();
			await expect( restarted.getAccessToken( account.registrationId ) ).rejects.toMatchObject( {
				code: 'session-unavailable',
			} );
			await expect( restarted.getAccessToken( other.registrationId ) ).resolves.toBe(
				'test-access-token-2'
			);
			expect(
				( await restarted.listConnections() ).map( ( entry ) => [
					entry.connectionId,
					entry.authStatus,
				] )
			).toEqual( [
				[ account.registrationId, 'disconnected' ],
				[ other.registrationId, 'connected' ],
			] );
		} );

		// The turn's end of the IPC channel, answered by the app that forked it.
		function channelTo( app: ChatGptCredentialBroker ) {
			const events = new EventEmitter();
			const sent: unknown[] = [];
			const send = vi.fn( ( message: unknown, callback: ( error: Error | null ) => void ) => {
				sent.push( message );
				const answered = app.answerSessionTokenRequest( message, ( reply ) => {
					sent.push( reply );
					setImmediate( () => events.emit( 'message', reply ) );
				} );
				callback( answered ? null : new Error( 'Unexpected message' ) );
			} );
			return Object.assign( events, { send, sent } );
		}

		it( 'hands a forked turn a short-lived access token over IPC, never in its environment', async () => {
			const app = startBroker();
			const account = await app.saveSignIn( signIn( { storage: 'session' } ) );

			const forkEnvironment = app.getSessionForkEnvironment();
			expect( forkEnvironment ).toEqual( {
				STUDIO_CHATGPT_SESSIONS_OFFERED: account.registrationId,
			} );
			const env: NodeJS.ProcessEnv = { ...forkEnvironment, PATH: '/bin' };
			const channel = channelTo( app );
			const turn = startBroker();
			turn.acceptSessionTokensFromParent( channel, env );

			expect( env ).toEqual( { PATH: '/bin' } );
			expect( await turn.listConnections() ).toEqual( [
				expect.objectContaining( {
					connectionId: account.registrationId,
					authStatus: 'connected',
				} ),
			] );
			for ( let request = 0; request < 2; request++ ) {
				await expect( turn.getAccessToken( account.registrationId ) ).resolves.toBe(
					'test-access-token-1'
				);
			}
			expect( channel.send ).toHaveBeenCalledTimes( 1 );
			const crossed = JSON.stringify( channel.sent );
			expect( crossed ).toContain( 'test-access-token-1' );
			expect( crossed ).not.toContain( 'test-refresh-token' );
			expect( crossed ).not.toContain( 'test-id-token' );
			expect( vaultFiles() ).toEqual( [] );
			expect( app.answerSessionTokenRequest( { type: 'interrupt' }, vi.fn() ) ).toBe( false );

			// Once the app signs out, the turn's copy is no use.
			await app.signOut( account.registrationId );
			await expect( turn.getAccessToken( account.registrationId ) ).rejects.toMatchObject( {
				code: 'signed-out',
			} );
		} );

		it.each<
			[ string, ( other: ChatGptCredentialBroker, registrationId: string ) => Promise< void > ]
		>( [
			[
				'signs it out',
				async ( other, registrationId ) => {
					await other.signOut( registrationId );
				},
			],
			[
				'signs it out and in again',
				async ( other, registrationId ) => {
					await other.signOut( registrationId );
					await other.saveSignIn(
						signIn( { registrationId, storage: 'session', tokens: tokens( 2 ) } )
					);
				},
			],
		] )(
			'drops a session-only sign-in, and stops offering it to forks, once another process %s',
			async ( _label, change ) => {
				const app = startBroker( { timing: { accountsPollMs: 100 } } );
				const { registrationId } = await app.saveSignIn( signIn( { storage: 'session' } ) );
				expect( app.getSessionForkEnvironment() ).toEqual( {
					STUDIO_CHATGPT_SESSIONS_OFFERED: registrationId,
				} );

				await change( startBroker(), registrationId );

				// No request is needed: the app notices from the account list.
				await vi.waitFor( () => expect( app.getSessionForkEnvironment() ).toEqual( {} ), {
					timeout: 2_000,
				} );
				const reply = vi.fn();
				app.answerSessionTokenRequest(
					{
						type: 'studio.chatgpt-session-token.request',
						requestId: 'request-1',
						connectionId: registrationId,
					},
					reply
				);
				await vi.waitFor( () =>
					expect( reply ).toHaveBeenCalledWith(
						expect.objectContaining( { requestId: 'request-1', accessToken: null } )
					)
				);
				expect( ( await app.listConnections() ).map( ( entry ) => entry.authStatus ) ).toEqual( [
					'disconnected',
				] );
			}
		);

		it( 'fails a forked turn whose app no longer holds its session, rather than read a stored record', async () => {
			const owner = startBroker();
			const account = await owner.saveSignIn( signIn( { storage: 'session' } ) );
			const restartedApp = startBroker();
			const turn = startBroker();
			turn.acceptSessionTokensFromParent( channelTo( restartedApp ), {
				STUDIO_CHATGPT_SESSIONS_OFFERED: account.registrationId,
			} );

			await expect( turn.getAccessToken( account.registrationId ) ).rejects.toMatchObject( {
				code: 'session-unavailable',
			} );
		} );
	} );

	describe( 'the connection registry', () => {
		it( 'lists each registration as a pi connection with its revision and verified identity, connected only where it can run', async () => {
			const app = startBroker();
			const stored = await app.saveSignIn( signIn() );
			const session = await app.saveSignIn(
				signIn( {
					subject: 'test-subject-2',
					email: null,
					clientId: 'test-issued-client-2',
					storage: 'session',
					tokens: tokens( 2 ),
				} )
			);
			const signedOut = await app.saveSignIn(
				signIn( {
					subject: 'test-subject-3',
					clientId: 'test-issued-client-3',
					tokens: tokens( 3 ),
				} )
			);
			await app.signOut( signedOut.registrationId );
			const entry = (
				account: ChatGptAccount,
				authStatus: 'connected' | 'disconnected',
				identity: object
			) => ( {
				connectionId: account.registrationId,
				providerId: 'chatgpt-oauth',
				backend: 'pi',
				revision: 1,
				identity,
				authStatus,
			} );

			const entries = await app.listConnections();

			expect( entries ).toEqual( [
				entry( stored, 'connected', { subject: 'test-subject-1', email: 'someone@example.com' } ),
				entry( session, 'connected', { subject: 'test-subject-2' } ),
				entry( signedOut, 'disconnected', {
					subject: 'test-subject-3',
					email: 'someone@example.com',
				} ),
			] );
			expectNoSecret( entries );
			// Another process can't run on this app's session-only sign-in.
			expect(
				( await startBroker().listConnections() ).map( ( item ) => item.authStatus )
			).toEqual( [ 'connected', 'disconnected', 'disconnected' ] );
		} );
	} );

	it( 'keeps every token out of errors, results, the registry, the account list, the fork environment and logs', async () => {
		const logged = ( [ 'log', 'info', 'warn', 'error', 'debug' ] as const ).map( ( method ) =>
			vi.spyOn( console, method ).mockImplementation( () => undefined )
		);
		onTestFinished( () => logged.forEach( ( spy ) => spy.mockRestore() ) );
		const app = startBroker();
		const stored = await app.saveSignIn( signIn( { tokens: expiring() } ) );
		const session = await app.saveSignIn(
			signIn( {
				subject: 'test-subject-2',
				clientId: 'test-issued-client-2',
				storage: 'session',
				tokens: tokens( 2 ),
			} )
		);
		const outcomes: unknown[] = [
			stored,
			session,
			await app.listConnections(),
			app.getSessionForkEnvironment(),
		];
		const failure = ( promise: Promise< unknown > ) =>
			promise.then(
				() => new Error( 'Expected a failure' ),
				( error: unknown ) => error
			);

		service.answerRefresh( async () => ( {
			ok: false,
			error: { kind: 'transient', status: 503 },
		} ) );
		outcomes.push( await failure( app.getAccessToken( stored.registrationId ) ) );
		service.answerRefresh( async () => ( {
			ok: false,
			error: { kind: 'terminal', code: 'invalid_grant', status: 400 },
		} ) );
		outcomes.push( await failure( app.getAccessToken( stored.registrationId ) ) );
		outcomes.push(
			await failure(
				app.saveSignIn(
					signIn( {
						registrationId: session.registrationId,
						subject: 'test-subject-9',
						tokens: tokens( 9 ),
					} )
				)
			)
		);
		outcomes.push( await failure( startBroker().getAccessToken( session.registrationId ) ) );
		keychain.state.available = false;
		outcomes.push( await failure( startBroker().saveSignIn( signIn( { tokens: tokens( 7 ) } ) ) ) );
		outcomes.push( await app.signOut( session.registrationId ) );

		expectNoSecret( ...outcomes, readAllFiles() );
		for ( const outcome of outcomes.filter( ( item ) => item instanceof Error ) ) {
			expect( outcome ).toBeInstanceOf( ChatGptConnectionError );
		}
		for ( const spy of logged ) {
			expect( spy ).not.toHaveBeenCalled();
		}
	} );

	it( 'runs the app’s broker on the system keychain and the token client the app sets, keeping credentials until one is set', async () => {
		vi.resetModules();
		const broker = await import( '@studio/agent/node/chatgpt/credential-broker' );
		const { registrationId } = await broker.saveChatGptSignIn( signIn( { tokens: expiring() } ) );

		await expect( broker.getChatGptAccessToken( registrationId ) ).rejects.toMatchObject( {
			code: 'refresh-failed',
		} );
		expect( await readChatGptAccount( registrationId ) ).toMatchObject( { state: 'signed-in' } );
		expect( [ ...keychain.items.keys() ] ).toEqual( [ 'chatgpt-vault-key' ] );

		broker.setChatGptTokenClient( service.client );
		await expect( broker.getChatGptAccessToken( registrationId ) ).resolves.toBe(
			'test-access-token-renewed-1'
		);
		expect( await broker.listChatGptConnections() ).toEqual( [
			expect.objectContaining( { connectionId: registrationId, authStatus: 'connected' } ),
		] );
		await expect( broker.signOutChatGpt( registrationId ) ).resolves.toEqual( {
			localCleared: true,
			remoteRevocationConfirmed: true,
		} );
	} );

	// One Studio process running the broker from the sources.
	function startBrokerProcess( args: string[] ) {
		const child = spawn(
			process.execPath,
			[ path.join( import.meta.dirname, 'fixtures', 'broker-process.ts' ), ...args ],
			{ env: { ...process.env, DEV_CONFIG_DIR: configDir }, stdio: [ 'pipe', 'pipe', 'pipe' ] }
		);
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding( 'utf8' ).on( 'data', ( chunk: string ) => ( stdout += chunk ) );
		child.stderr.setEncoding( 'utf8' ).on( 'data', ( chunk: string ) => ( stderr += chunk ) );
		const exited = new Promise< { code: number | null; signal: NodeJS.Signals | null } >(
			( resolve ) => child.once( 'exit', ( code, signal ) => resolve( { code, signal } ) )
		);
		const lines: string[] = [];
		const waiting: Array< ( line: string ) => void > = [];
		const everyLine: string[] = [];
		const lineEvents = new EventEmitter();
		readline.createInterface( { input: child.stdout } ).on( 'line', ( line ) => {
			everyLine.push( line );
			lineEvents.emit( 'line', line );
			const reader = waiting.shift();
			if ( reader ) {
				reader( line );
			} else {
				lines.push( line );
			}
		} );
		const nextLine = () =>
			lines.length
				? Promise.resolve( lines.shift()! )
				: new Promise< string >( ( resolve, reject ) => {
						waiting.push( resolve );
						void exited.then( () => reject( new Error( `The process exited. ${ stderr }` ) ) );
				  } );
		// The first line, so far or to come, that `matches`.
		const waitForLine = ( matches: ( line: string ) => boolean, timeoutMs: number ) =>
			new Promise< string >( ( resolve, reject ) => {
				const seen = everyLine.find( matches );
				if ( seen !== undefined ) {
					resolve( seen );
					return;
				}
				const onLine = ( line: string ) => {
					if ( matches( line ) ) {
						clearTimeout( timer );
						lineEvents.off( 'line', onLine );
						resolve( line );
					}
				};
				const timer = setTimeout( () => {
					lineEvents.off( 'line', onLine );
					reject( new Error( `No such line within ${ timeoutMs } ms. ${ stderr }` ) );
				}, timeoutMs );
				lineEvents.on( 'line', onLine );
			} );
		onTestFinished( () => {
			child.kill();
		} );
		return {
			child,
			exited,
			nextLine,
			waitForLine,
			lines: () => [ ...everyLine ],
			output: () => stdout,
		};
	}
} );
