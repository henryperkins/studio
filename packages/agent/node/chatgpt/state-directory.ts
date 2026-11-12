import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getConfigDirectory, getDefaultConfigDirectory } from '@studio/common/lib/well-known-paths';

/**
 * Where this process keeps its ChatGPT sign-ins: the account index, the sealed
 * credential records and their lockfiles. The Studio config directory, unless
 * set otherwise in this process.
 */

export type ChatGptStateDirectoryProblem = 'not-absolute' | 'not-a-directory' | 'in-use';

export class ChatGptStateDirectoryError extends Error {
	readonly code: ChatGptStateDirectoryProblem;

	constructor( code: ChatGptStateDirectoryProblem ) {
		super( `The ChatGPT state directory was refused (${ code }).` );
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

// The directory with every link resolved, as far as it exists; the rest as named.
function realDirectory( directory: string ): string {
	const resolved = path.resolve( directory );
	const missing: string[] = [];
	let current = resolved;
	while ( path.dirname( current ) !== current ) {
		try {
			return path.join( fs.realpathSync.native( current ), ...missing );
		} catch {
			missing.unshift( path.basename( current ) );
			current = path.dirname( current );
		}
	}
	return resolved;
}

/**
 * The keychain items that hold the vault key of the current ChatGPT state
 * directory. The default profile's is `chatgpt-vault-key`, as it always was.
 * Every other directory's is that name and a hash of the directory's real
 * path, so one profile never replaces another's key; `shared` is then the
 * default profile's item, which records sealed before keys were kept per
 * profile may still need, to read and never to write.
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
