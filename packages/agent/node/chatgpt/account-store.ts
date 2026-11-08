import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LOCKFILE_STALE_TIME, LOCKFILE_WAIT_TIME } from '@studio/common/constants';
import { isErrnoException } from '@studio/common/lib/is-errno-exception';
import { lockFileAsync, unlockFileAsync } from '@studio/common/lib/lockfile';
import { getConfigDirectory } from '@studio/common/lib/well-known-paths';
import { __, sprintf } from '@wordpress/i18n';
import { readFile, writeFile } from 'atomically';

/**
 * The ChatGPT accounts Studio signed in to on this host, without any secret:
 * `~/.studio/chatgpt-accounts.json`, written under its own lockfile like every
 * other config file. Tokens live in the credential broker's vault.
 *
 * Each account use is a registration of its own, with its own issued client,
 * even for the same email (Sign in with ChatGPT, "Profiles and sessions").
 * Studio mints its id, which is also the connection id conversations record.
 */

const ACCOUNTS_FILE = 'chatgpt-accounts.json';
const ACCOUNTS_VERSION = 1;
const UUID_V4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const REGISTRATION_ID = new RegExp( `^${ UUID_V4 }$` );
const HOST_ID = new RegExp( `^urn:uuid:${ UUID_V4 }$` );
// The client a first sign-in registers through. Never an account's own.
const REGISTRATION_CLIENT_ID = 'dynamic_agent_client';
// Long enough for a busy disk on Windows, short enough to hold a lock through.
const RENAME_RETRY_MS = 1_000;
// While another process deletes a lockfile, Windows refuses to open or stat it:
// the lock is coming free, so taking it is tried again.
const LOCK_RACE_ERRORS = new Set( [ 'EPERM', 'EACCES', 'EBUSY' ] );
const LOCK_RACE_RETRY_MS = 25;

/** Where a registration's tokens live: the vault, or the memory of the app that signed in. */
export type ChatGptCredentialStorage = 'vault' | 'session';

/**
 * Signed in; signed out by the user; or its tokens were rejected, lost or
 * found unusable, so it needs a sign-in again.
 */
export type ChatGptAccountState = 'signed-in' | 'signed-out' | 'needs-sign-in';

export interface ChatGptAccount {
	registrationId: string;
	issuer: string;
	/** The verified ID token's `sub`: the account's identity. */
	subject: string;
	/** Display only: two registrations can share an email. */
	email: string | null;
	/** The client OpenAI issued this registration; never `dynamic_agent_client`. */
	clientId: string;
	label: string;
	/** Starts at 1; goes up when the registration's issued client changes. */
	revision: number;
	/** Goes up at every sign-out, so a refresh that began before it never commits. */
	logoutGeneration: number;
	storage: ChatGptCredentialStorage;
	state: ChatGptAccountState;
	createdAt: string;
	updatedAt: string;
}

/** The verified, non-secret part of a completed sign-in. */
export interface ChatGptAccountSignIn {
	issuer: string;
	subject: string;
	email?: string | null;
	clientId: string;
	label?: string;
	storage: ChatGptCredentialStorage;
}

interface AccountIndex {
	version: typeof ACCOUNTS_VERSION;
	/** This host's `ext_agent_host_id`: generated once, never changed. */
	hostId: string | null;
	accounts: ChatGptAccount[];
}

export type ChatGptConnectionErrorCode =
	| 'not-found'
	| 'signed-out'
	| 'needs-sign-in'
	| 'session-unavailable'
	| 'changed'
	| 'vault-unavailable'
	| 'refresh-failed'
	| 'identity-mismatch'
	| 'invalid-sign-in'
	| 'accounts-unreadable'
	| 'newer-format';

function describeChatGptConnectionError(
	code: ChatGptConnectionErrorCode,
	detail?: string
): string {
	switch ( code ) {
		case 'not-found':
			return __( 'Studio has no record of this ChatGPT account. Sign in to ChatGPT again.' );
		case 'signed-out':
			return __( 'You signed out of this ChatGPT account. Sign in again to continue.' );
		case 'needs-sign-in':
			return __( 'Your ChatGPT sign-in expired or was revoked. Sign in again to continue.' );
		case 'session-unavailable':
			return __(
				'This ChatGPT sign-in was kept for one app session only, and isn’t available here. Sign in again to continue.'
			);
		case 'changed':
			return __(
				'The ChatGPT account this turn ran on was signed in again under another registration, so the turn stopped.'
			);
		case 'vault-unavailable':
			return sprintf(
				/* translators: %s: why the system keychain can't be used. */
				__(
					'Studio couldn’t reach the system keychain that protects your ChatGPT sign-in (%s). Unlock it and try again.'
				),
				detail ?? __( 'unknown error' )
			);
		case 'refresh-failed':
			return __(
				'Studio couldn’t renew your ChatGPT sign-in just now. Check your connection and try again.'
			);
		case 'identity-mismatch':
			return __(
				'You signed in as a different ChatGPT account than this connection uses, so nothing was changed.'
			);
		case 'invalid-sign-in':
			return __(
				'ChatGPT didn’t grant Studio what it needs to use your plan, so nothing was saved. Sign in again and allow access.'
			);
		case 'accounts-unreadable':
			return __(
				'Studio couldn’t read its list of ChatGPT accounts. It may have been written by a newer version of Studio.'
			);
		case 'newer-format':
			return __(
				'Your ChatGPT sign-in was saved by a newer version of Studio. Update Studio to use it here.'
			);
	}
}

/** Why a ChatGPT account can't be used or changed. The message is for the user and never holds a secret. */
export class ChatGptConnectionError extends Error {
	readonly code: ChatGptConnectionErrorCode;

	constructor( code: ChatGptConnectionErrorCode, detail?: string ) {
		super( describeChatGptConnectionError( code, detail ) );
		this.name = 'ChatGptConnectionError';
		this.code = code;
	}
}

export function isChatGptRegistrationId( value: unknown ): value is string {
	return typeof value === 'string' && REGISTRATION_ID.test( value );
}

export function createChatGptRegistrationId(): string {
	return randomUUID();
}

export function isSameChatGptIdentity(
	account: Pick< ChatGptAccount, 'issuer' | 'subject' >,
	signIn: Pick< ChatGptAccountSignIn, 'issuer' | 'subject' >
): boolean {
	return account.issuer === signIn.issuer && account.subject === signIn.subject;
}

/** A client id that can be saved as a registration's own. */
export function isIssuedChatGptClientId( value: unknown ): value is string {
	return typeof value === 'string' && value !== '' && value !== REGISTRATION_CLIENT_ID;
}

const isRecord = ( value: unknown ): value is Record< string, unknown > =>
	typeof value === 'object' && value !== null && ! Array.isArray( value );

const isNonEmptyString = ( value: unknown ): value is string =>
	typeof value === 'string' && value !== '';

const isWholeNumber = ( value: unknown, minimum: number ): value is number =>
	typeof value === 'number' && Number.isInteger( value ) && value >= minimum;

function isAccount( value: unknown ): value is ChatGptAccount {
	return (
		isRecord( value ) &&
		isChatGptRegistrationId( value.registrationId ) &&
		isNonEmptyString( value.issuer ) &&
		isNonEmptyString( value.subject ) &&
		( value.email === null || typeof value.email === 'string' ) &&
		isIssuedChatGptClientId( value.clientId ) &&
		typeof value.label === 'string' &&
		isWholeNumber( value.revision, 1 ) &&
		isWholeNumber( value.logoutGeneration, 0 ) &&
		( value.storage === 'vault' || value.storage === 'session' ) &&
		( value.state === 'signed-in' ||
			value.state === 'signed-out' ||
			value.state === 'needs-sign-in' ) &&
		typeof value.createdAt === 'string' &&
		typeof value.updatedAt === 'string'
	);
}

function isAccountIndex( value: unknown ): value is AccountIndex {
	if (
		! isRecord( value ) ||
		value.version !== ACCOUNTS_VERSION ||
		! (
			value.hostId === null ||
			( typeof value.hostId === 'string' && HOST_ID.test( value.hostId ) )
		) ||
		! Array.isArray( value.accounts ) ||
		! value.accounts.every( isAccount )
	) {
		return false;
	}
	const ids = new Set( value.accounts.map( ( account ) => account.registrationId ) );
	return ids.size === value.accounts.length;
}

// Only the known fields leave this module; the index keeps any a newer build added.
function toAccount( account: ChatGptAccount ): ChatGptAccount {
	return {
		registrationId: account.registrationId,
		issuer: account.issuer,
		subject: account.subject,
		email: account.email,
		clientId: account.clientId,
		label: account.label,
		revision: account.revision,
		logoutGeneration: account.logoutGeneration,
		storage: account.storage,
		state: account.state,
		createdAt: account.createdAt,
		updatedAt: account.updatedAt,
	};
}

const getAccountsPath = () => path.join( getConfigDirectory(), ACCOUNTS_FILE );

async function readIndex(): Promise< AccountIndex > {
	let text: string;
	try {
		text = await readFile( getAccountsPath(), { encoding: 'utf8' } );
	} catch ( error ) {
		if ( isErrnoException( error ) && error.code === 'ENOENT' ) {
			return { version: ACCOUNTS_VERSION, hostId: null, accounts: [] };
		}
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse( text );
	} catch {
		throw new ChatGptConnectionError( 'accounts-unreadable' );
	}
	if ( ! isAccountIndex( parsed ) ) {
		throw new ChatGptConnectionError( 'accounts-unreadable' );
	}
	return parsed;
}

async function removeLeftoverTempFiles( directory: string, fileName: string ): Promise< void > {
	let names: string[];
	try {
		names = await fs.readdir( directory );
	} catch {
		return;
	}
	// `atomically` names its temp files `<file>.tmp-<id>`; any still here belong to a write that never finished.
	const prefix = `${ fileName }.tmp-`;
	await Promise.all(
		names
			.filter( ( name ) => name.startsWith( prefix ) )
			.map( ( name ) =>
				fs.rm( path.join( directory, name ), { force: true } ).catch( () => undefined )
			)
	);
}

/**
 * Replaces `fileName` in `directory` atomically: a temp file in the same
 * directory, flushed, then renamed over it, retried briefly while Windows holds
 * the file. A crash before the rename leaves the previous file whole. The
 * caller holds the file's lock, so any temp file found is a dead write's and
 * is removed.
 */
export async function writeChatGptFileAtomically(
	directory: string,
	fileName: string,
	contents: string
): Promise< void > {
	await fs.mkdir( directory, { recursive: true, mode: 0o700 } );
	await removeLeftoverTempFiles( directory, fileName );
	await writeFile( path.join( directory, fileName ), contents, {
		encoding: 'utf8',
		mode: 0o600,
		timeout: RENAME_RETRY_MS,
	} );
}

/** Removes `fileName` and any temp file a write of it left. False when it couldn't be removed. */
export async function removeChatGptFile( directory: string, fileName: string ): Promise< boolean > {
	await removeLeftoverTempFiles( directory, fileName );
	try {
		await fs.rm( path.join( directory, fileName ), { force: true } );
		return true;
	} catch {
		return false;
	}
}

/**
 * Takes the lockfile at `lockPath` in an existing directory, waiting up to
 * `wait` ms for another holder; resolves to its release.
 */
export async function lockChatGptFile(
	lockPath: string,
	{ wait, stale }: { wait: number; stale: number }
): Promise< () => Promise< void > > {
	const deadline = Date.now() + wait;
	for (;;) {
		try {
			await lockFileAsync( lockPath, { wait: Math.max( deadline - Date.now(), 0 ), stale } );
			return () => unlockFileAsync( lockPath );
		} catch ( error ) {
			const racing = isErrnoException( error ) && LOCK_RACE_ERRORS.has( error.code ?? '' );
			if ( ! racing || Date.now() >= deadline ) {
				throw error;
			}
			await new Promise( ( resolve ) => setTimeout( resolve, LOCK_RACE_RETRY_MS ) );
		}
	}
}

async function updateIndex< T >( update: ( index: AccountIndex ) => T ): Promise< T > {
	const directory = getConfigDirectory();
	await fs.mkdir( directory, { recursive: true } );
	const release = await lockChatGptFile( path.join( directory, `${ ACCOUNTS_FILE }.lock` ), {
		wait: LOCKFILE_WAIT_TIME,
		stale: LOCKFILE_STALE_TIME,
	} );
	try {
		const index = await readIndex();
		const result = update( index );
		await writeChatGptFileAtomically(
			directory,
			ACCOUNTS_FILE,
			JSON.stringify( index, null, 2 ) + '\n'
		);
		return result;
	} finally {
		await release();
	}
}

function findAccount( index: AccountIndex, registrationId: string ): ChatGptAccount {
	const account = index.accounts.find( ( item ) => item.registrationId === registrationId );
	if ( ! account ) {
		throw new ChatGptConnectionError( 'not-found' );
	}
	return account;
}

function distinctLabel( accounts: ChatGptAccount[], base: string ): string {
	const taken = new Set( accounts.map( ( account ) => account.label ) );
	let label = base;
	for ( let copy = 2; taken.has( label ); copy++ ) {
		label = `${ base } (${ copy })`;
	}
	return label;
}

/**
 * Runs `check` whenever the account list may have changed, in this process or
 * another, and at least every `pollMs` in case watching misses a change or
 * isn't available, until the returned function stops it. Checks never
 * overlap; a failed one is left for the next.
 */
export function watchChatGptAccounts( check: () => Promise< void >, pollMs: number ): () => void {
	const directory = getConfigDirectory();
	let stopped = false;
	let checking = false;
	let again = false;
	let watcher: FSWatcher | undefined;
	const timer = setInterval( () => run(), pollMs );
	timer.unref?.();
	const stop = () => {
		stopped = true;
		clearInterval( timer );
		watcher?.close();
	};
	const run = () => {
		// A check reads the current config directory; once that isn't the one
		// watched, its reads would go elsewhere.
		if ( stopped || getConfigDirectory() !== directory ) {
			stop();
			return;
		}
		if ( checking ) {
			again = true;
			return;
		}
		checking = true;
		void check()
			.catch( () => undefined )
			.finally( () => {
				checking = false;
				if ( again ) {
					again = false;
					run();
				}
			} );
	};
	try {
		// The directory, not the file: every write renames a new file over it.
		watcher = watch( directory, { persistent: false }, ( _event, fileName ) => {
			if ( ! fileName || fileName.startsWith( ACCOUNTS_FILE ) ) {
				run();
			}
		} );
		watcher.on( 'error', () => watcher?.close() );
	} catch {
		// Polling alone keeps the bound.
	}
	return stop;
}

/**
 * This host's `ext_agent_host_id`, in the `urn:uuid:` form: generated the
 * first time it is asked for and saved before it is returned.
 */
export async function getChatGptHostId(): Promise< string > {
	const { hostId } = await readIndex();
	if ( hostId ) {
		return hostId;
	}
	return updateIndex( ( index ) => ( index.hostId ??= `urn:uuid:${ randomUUID() }` ) );
}

export async function readChatGptAccounts(): Promise< ChatGptAccount[] > {
	return ( await readIndex() ).accounts.map( toAccount );
}

/** The registration, or null when there is none by that id. */
export async function readChatGptAccount(
	registrationId: string
): Promise< ChatGptAccount | null > {
	if ( ! isChatGptRegistrationId( registrationId ) ) {
		return null;
	}
	const account = ( await readIndex() ).accounts.find(
		( item ) => item.registrationId === registrationId
	);
	return account ? toAccount( account ) : null;
}

/** Adds a registration for a new sign-in, at revision 1. */
export function createChatGptAccount(
	registrationId: string,
	signIn: ChatGptAccountSignIn
): Promise< ChatGptAccount > {
	return updateIndex( ( index ) => {
		if ( index.accounts.some( ( account ) => account.registrationId === registrationId ) ) {
			throw new Error( 'A registration with this id already exists.' );
		}
		const now = new Date().toISOString();
		const account: ChatGptAccount = {
			registrationId,
			issuer: signIn.issuer,
			subject: signIn.subject,
			email: signIn.email ?? null,
			clientId: signIn.clientId,
			label: distinctLabel( index.accounts, signIn.label?.trim() || signIn.email || 'ChatGPT' ),
			revision: 1,
			logoutGeneration: 0,
			storage: signIn.storage,
			state: 'signed-in',
			createdAt: now,
			updatedAt: now,
		};
		index.accounts.push( account );
		return toAccount( account );
	} );
}

/**
 * Records a sign-in again to an existing registration, which began at its
 * `logoutGeneration`. Only the same identity may sign in to it, and never over
 * a sign-out that began since; a new issued client starts a new revision.
 */
export function updateChatGptAccountSignIn(
	registrationId: string,
	signIn: ChatGptAccountSignIn,
	logoutGeneration: number
): Promise< ChatGptAccount > {
	return updateIndex( ( index ) => {
		const account = findAccount( index, registrationId );
		if ( ! isSameChatGptIdentity( account, signIn ) ) {
			throw new ChatGptConnectionError( 'identity-mismatch' );
		}
		if ( account.logoutGeneration !== logoutGeneration ) {
			throw new ChatGptConnectionError( 'signed-out' );
		}
		if ( account.clientId !== signIn.clientId ) {
			account.clientId = signIn.clientId;
			account.revision += 1;
		}
		account.email = signIn.email ?? account.email;
		account.storage = signIn.storage;
		account.state = 'signed-in';
		account.updatedAt = new Date().toISOString();
		return toAccount( account );
	} );
}

/**
 * The first step of a sign-out: a new logout generation, and no more use of
 * the registration's tokens. The registration and its client stay.
 */
export function startChatGptSignOut( registrationId: string ): Promise< ChatGptAccount > {
	return updateIndex( ( index ) => {
		const account = findAccount( index, registrationId );
		account.logoutGeneration += 1;
		account.state = 'signed-out';
		account.updatedAt = new Date().toISOString();
		return toAccount( account );
	} );
}

/** Marks a signed-in registration as needing a sign-in again, unless it was signed out since `logoutGeneration`. */
export function markChatGptSignInNeeded(
	registrationId: string,
	logoutGeneration: number
): Promise< void > {
	return updateIndex( ( index ) => {
		const account = index.accounts.find( ( item ) => item.registrationId === registrationId );
		if (
			account &&
			account.state === 'signed-in' &&
			account.logoutGeneration === logoutGeneration
		) {
			account.state = 'needs-sign-in';
			account.updatedAt = new Date().toISOString();
		}
	} );
}
