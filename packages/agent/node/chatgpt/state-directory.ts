import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isErrnoException } from '@studio/common/lib/is-errno-exception';
import { getConfigDirectory, getDefaultConfigDirectory } from '@studio/common/lib/well-known-paths';

/**
 * Where this process keeps its ChatGPT sign-ins: the account index, the sealed
 * credential records and their lockfiles. The Studio config directory, unless
 * set otherwise in this process.
 */

/**
 * `unresolved`: its real path couldn't be read for a reason other than a part
 * of it not existing yet, so the keychain item of its vault key can't be named.
 */
export type ChatGptStateDirectoryProblem =
	| 'not-absolute'
	| 'not-a-directory'
	| 'in-use'
	| 'unresolved';

export class ChatGptStateDirectoryError extends Error {
	readonly code: ChatGptStateDirectoryProblem;

	constructor( code: ChatGptStateDirectoryProblem, reason?: string ) {
		super(
			code === 'unresolved'
				? `The ChatGPT state directory's real path couldn't be read (${ reason ?? 'unknown' }).`
				: `The ChatGPT state directory was refused (${ code }).`
		);
		this.name = 'ChatGptStateDirectoryError';
		this.code = code;
	}
}

let override: string | null = null;
let used = false;

export function getChatGptStateDirectory(): string {
	used = true;
	return override ?? getConfigDirectory();
}

// Development only: the eval runner points this process's ChatGPT state at a
// dedicated test profile while each case keeps a config directory of its own.
// No app, CLI command or server calls it.
export function setChatGptStateDirectory( directory: string | null ): void {
	if ( directory !== null ) {
		if ( ! path.isAbsolute( directory ) ) {
			throw new ChatGptStateDirectoryError( 'not-absolute' );
		}
		let isDirectory = false;
		try {
			isDirectory = fs.statSync( directory ).isDirectory();
		} catch {
			isDirectory = false;
		}
		if ( ! isDirectory ) {
			throw new ChatGptStateDirectoryError( 'not-a-directory' );
		}
	}
	const current = path.resolve( override ?? getConfigDirectory() );
	if ( used && path.resolve( directory ?? getConfigDirectory() ) !== current ) {
		throw new ChatGptStateDirectoryError( 'in-use' );
	}
	override = directory;
}

// The default profile's item: the name every profile shared before keys were kept per profile.
const VAULT_KEY_ACCOUNT = 'chatgpt-vault-key';
const VAULT_KEY_SUFFIX_DIGITS = 16;

// One spelling of a Windows drive: `c:\…` and `C:\…` are the same directory.
const withDriveLetterUpperCase = ( directory: string ) =>
	process.platform === 'win32'
		? directory.replace( /^[a-z](?=:)/, ( drive ) => drive.toUpperCase() )
		: directory;

/**
 * The directory with every link resolved, as far as it exists; the rest as
 * named. Only a part that doesn't exist yet is passed over: any other failure
 * to read a real path throws, so one directory is never named two ways.
 */
function realDirectory( directory: string ): string {
	const resolved = path.resolve( directory );
	const missing: string[] = [];
	for ( let current = resolved; ; current = path.dirname( current ) ) {
		try {
			return withDriveLetterUpperCase( path.join( fs.realpathSync.native( current ), ...missing ) );
		} catch ( error ) {
			if ( ! isErrnoException( error ) || error.code !== 'ENOENT' ) {
				throw new ChatGptStateDirectoryError(
					'unresolved',
					isErrnoException( error ) ? error.code : undefined
				);
			}
			if ( path.dirname( current ) === current ) {
				return withDriveLetterUpperCase( resolved );
			}
			missing.unshift( path.basename( current ) );
		}
	}
}

/**
 * The keychain items that hold the vault key of the current ChatGPT state
 * directory. The default profile's is `chatgpt-vault-key`, as it always was.
 * Every other directory's is that name and a hash of the directory's real
 * path, so one profile never replaces another's key; `shared` is then the
 * default profile's item, which records sealed before keys were kept per
 * profile may still need, to read and never to write. Throws
 * `ChatGptStateDirectoryError` (`unresolved`) when a real path can't be read,
 * before any item is read or written.
 */
export function getChatGptVaultKeyAccounts(): { own: string; shared: string | null } {
	const directory = realDirectory( getChatGptStateDirectory() );
	if ( directory === realDirectory( getDefaultConfigDirectory() ) ) {
		return { own: VAULT_KEY_ACCOUNT, shared: null };
	}
	const suffix = createHash( 'sha256' )
		.update( directory, 'utf8' )
		.digest( 'hex' )
		.slice( 0, VAULT_KEY_SUFFIX_DIGITS );
	return { own: `${ VAULT_KEY_ACCOUNT }-${ suffix }`, shared: VAULT_KEY_ACCOUNT };
}
