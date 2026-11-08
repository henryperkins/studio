import { spawn } from 'node:child_process';

/**
 * The user's system keychain — macOS Keychain, the Secret Service on Linux
 * (GNOME Keyring, KWallet), or Windows Credential Manager — reached through
 * each platform's own command-line tool, so no native module is needed.
 *
 * A secret only ever travels over the tool's stdin: command-line arguments
 * are visible to other processes, stdin is not.
 *
 * This protects a secret at rest. It doesn't isolate it from other programs
 * running as the same user, which can ask the keychain for it too.
 */

export type CredentialStoreStatus =
	| { available: true }
	| {
			available: false;
			reason: string;
			/**
			 * True when this machine has no keychain Studio can use at all, as opposed
			 * to one it can't reach right now (locked, or no session bus over SSH).
			 */
			absent?: true;
	  };

export interface OsCredentialStore {
	/** Whether the keychain can keep secrets on this machine. */
	check(): Promise< CredentialStoreStatus >;
	/** The secret saved under `account`, or null when there is none. */
	get( account: string ): Promise< string | null >;
	set( account: string, secret: string ): Promise< void >;
	/** Removes the secret; succeeds when there was none. */
	delete( account: string ): Promise< void >;
}

/** The keychain can't be used, or refused an operation. */
export class SecureStorageError extends Error {
	constructor( message: string ) {
		super( message );
		this.name = 'SecureStorageError';
	}
}

export interface CommandResult {
	/** Exit code, or null when the command couldn't start or was killed. */
	code: number | null;
	stdout: string;
	stderr: string;
	/** Set when the command couldn't be started (e.g. `ENOENT`). */
	spawnError?: NodeJS.ErrnoException;
}

export type CommandRunner = (
	command: string,
	args: readonly string[],
	options: { input?: string; timeoutMs: number }
) => Promise< CommandResult >;

const COMMAND_TIMEOUT_MS = 15_000;
// Keychain item names: no spaces or quotes, so no tool needs them escaped.
const ITEM_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export const runCommand: CommandRunner = ( command, args, { input, timeoutMs } ) =>
	new Promise( ( resolve ) => {
		let stdout = '';
		let stderr = '';
		let settled = false;
		const finish = ( result: CommandResult ) => {
			if ( ! settled ) {
				settled = true;
				resolve( result );
			}
		};
		const child = spawn( command, [ ...args ], {
			stdio: [ 'pipe', 'pipe', 'pipe' ],
			windowsHide: true,
			timeout: timeoutMs,
		} );
		child.stdout.setEncoding( 'utf8' );
		child.stderr.setEncoding( 'utf8' );
		child.stdout.on( 'data', ( chunk: string ) => ( stdout += chunk ) );
		child.stderr.on( 'data', ( chunk: string ) => ( stderr += chunk ) );
		child.on( 'error', ( error: NodeJS.ErrnoException ) =>
			finish( { code: null, stdout, stderr, spawnError: error } )
		);
		child.on( 'close', ( code ) => finish( { code, stdout, stderr } ) );
		child.stdin.on( 'error', () => {
			// The tool may exit before reading stdin; its exit code reports why.
		} );
		child.stdin.end( input ?? '' );
	} );

function assertItemName( value: string ): void {
	if ( ! ITEM_NAME.test( value ) ) {
		throw new Error( `Invalid keychain item name: ${ value }` );
	}
}

// Error text from a tool must never echo a secret back; tools that read the
// secret from stdin don't, but strip it anyway.
function toolError( action: string, result: CommandResult, secret?: string ): SecureStorageError {
	const raw = ( result.spawnError?.message ?? result.stderr ).trim();
	const text = secret ? raw.split( secret ).join( '[redacted]' ) : raw;
	return new SecureStorageError(
		text
			? `Couldn't ${ action } the system keychain: ${ text }`
			: `Couldn't ${ action } the system keychain.`
	);
}

interface PlatformAdapter {
	check(): Promise< CredentialStoreStatus >;
	get( account: string ): Promise< string | null >;
	set( account: string, secret: string ): Promise< void >;
	delete( account: string ): Promise< void >;
}

// macOS: /usr/bin/security. `add-generic-password` only takes the password as
// an argument, so it runs inside `security -i`, which reads the command line
// from stdin.
function createMacAdapter( run: CommandRunner, service: string ): PlatformAdapter {
	const SECURITY = '/usr/bin/security';
	// errSecItemNotFound.
	const NOT_FOUND = 44;
	return {
		async check() {
			const result = await run( SECURITY, [ 'default-keychain', '-d', 'user' ], {
				timeoutMs: COMMAND_TIMEOUT_MS,
			} );
			return result.code === 0
				? { available: true }
				: { available: false, reason: toolError( 'open', result ).message };
		},
		async get( account ) {
			const result = await run(
				SECURITY,
				[ 'find-generic-password', '-s', service, '-a', account, '-w' ],
				{ timeoutMs: COMMAND_TIMEOUT_MS }
			);
			if ( result.code === NOT_FOUND ) {
				return null;
			}
			if ( result.code !== 0 ) {
				throw toolError( 'read from', result );
			}
			return result.stdout.replace( /\r?\n$/, '' );
		},
		async set( account, secret ) {
			const result = await run( SECURITY, [ '-i' ], {
				input: `add-generic-password -U -s ${ service } -a ${ account } -w ${ secret }\n`,
				timeoutMs: COMMAND_TIMEOUT_MS,
			} );
			// `security -i` can exit 0 after a failed command, so the caller
			// reads the secret back to confirm the write.
			if ( result.code !== 0 ) {
				throw toolError( 'save to', result, secret );
			}
		},
		async delete( account ) {
			const result = await run(
				SECURITY,
				[ 'delete-generic-password', '-s', service, '-a', account ],
				{ timeoutMs: COMMAND_TIMEOUT_MS }
			);
			if ( result.code !== 0 && result.code !== NOT_FOUND ) {
				throw toolError( 'remove from', result );
			}
		},
	};
}

// Linux: libsecret's `secret-tool`, which reads the secret to store from stdin.
// `lookup` exits 1 with no output when nothing matches; any other failure
// (no D-Bus session, no Secret Service, a locked keyring the user dismissed)
// writes to stderr.
function createLinuxAdapter( run: CommandRunner, service: string ): PlatformAdapter {
	const SECRET_TOOL = 'secret-tool';
	const attributes = ( account: string ) => [ 'service', service, 'account', account ];
	return {
		async check() {
			const result = await run(
				SECRET_TOOL,
				[ 'lookup', ...attributes( '__studio_keychain_check__' ) ],
				{ timeoutMs: COMMAND_TIMEOUT_MS }
			);
			if ( result.spawnError?.code === 'ENOENT' ) {
				return {
					available: false,
					reason:
						'secret-tool is not installed. Install libsecret-tools and a Secret Service keyring such as GNOME Keyring.',
					absent: true,
				};
			}
			if ( result.code === 0 || ( result.code === 1 && ! result.stderr.trim() ) ) {
				return { available: true };
			}
			return { available: false, reason: toolError( 'open', result ).message };
		},
		async get( account ) {
			const result = await run( SECRET_TOOL, [ 'lookup', ...attributes( account ) ], {
				timeoutMs: COMMAND_TIMEOUT_MS,
			} );
			if ( result.code === 1 && ! result.stderr.trim() ) {
				return null;
			}
			if ( result.code !== 0 ) {
				throw toolError( 'read from', result );
			}
			return result.stdout.replace( /\r?\n$/, '' );
		},
		async set( account, secret ) {
			const result = await run(
				SECRET_TOOL,
				[ 'store', `--label=WordPress Studio (${ account })`, ...attributes( account ) ],
				{ input: secret, timeoutMs: COMMAND_TIMEOUT_MS }
			);
			if ( result.code !== 0 ) {
				throw toolError( 'save to', result, secret );
			}
		},
		async delete( account ) {
			const result = await run( SECRET_TOOL, [ 'clear', ...attributes( account ) ], {
				timeoutMs: COMMAND_TIMEOUT_MS,
			} );
			if ( result.code !== 0 && ! ( result.code === 1 && ! result.stderr.trim() ) ) {
				throw toolError( 'remove from', result );
			}
		},
	};
}

// Windows: Credential Manager through the WinRT PasswordVault, from Windows
// PowerShell. The script travels as -EncodedCommand (it holds no secret) and
// the secret, when there is one, over stdin.
function createWindowsAdapter( run: CommandRunner, service: string ): PlatformAdapter {
	const POWERSHELL = 'powershell.exe';
	// HRESULT for "Element not found", which PasswordVault.Retrieve throws.
	const NOT_FOUND_HRESULT = -2147023728;
	const NOT_FOUND_EXIT = 3;
	const prelude = `$ErrorActionPreference = 'Stop'
[void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
$vault = New-Object Windows.Security.Credentials.PasswordVault`;
	const retrieve = ( account: string ) => `try {
	$credential = $vault.Retrieve('${ service }', '${ account }')
} catch {
	if ($_.Exception.HResult -eq ${ NOT_FOUND_HRESULT } -or $_.Exception.InnerException.HResult -eq ${ NOT_FOUND_HRESULT }) { exit ${ NOT_FOUND_EXIT } }
	throw
}`;
	const runScript = ( script: string, input?: string ) =>
		run(
			POWERSHELL,
			[
				'-NoProfile',
				'-NonInteractive',
				'-ExecutionPolicy',
				'Bypass',
				'-EncodedCommand',
				Buffer.from( `${ prelude }\n${ script }`, 'utf16le' ).toString( 'base64' ),
			],
			{ input, timeoutMs: COMMAND_TIMEOUT_MS }
		);
	return {
		async check() {
			const result = await runScript( 'exit 0' );
			return result.code === 0
				? { available: true }
				: { available: false, reason: toolError( 'open', result ).message };
		},
		async get( account ) {
			const result = await runScript(
				`${ retrieve( account ) }
$credential.RetrievePassword()
[Console]::Out.Write($credential.Password)`
			);
			if ( result.code === NOT_FOUND_EXIT ) {
				return null;
			}
			if ( result.code !== 0 ) {
				throw toolError( 'read from', result );
			}
			return result.stdout;
		},
		// PasswordVault has no documented replace, so the previous credential is
		// removed first and put back if adding the new one fails.
		async set( account, secret ) {
			const result = await runScript(
				`$secret = [Console]::In.ReadToEnd()
$previous = $null
try {
	$existing = $vault.Retrieve('${ service }', '${ account }')
	$existing.RetrievePassword()
	$previous = $existing
} catch {}
if ($previous) { $vault.Remove($previous) }
try {
	$vault.Add((New-Object Windows.Security.Credentials.PasswordCredential('${ service }', '${ account }', $secret)))
} catch {
	$failure = $_
	if ($previous) { try { $vault.Add($previous) } catch {} }
	throw $failure
}`,
				secret
			);
			if ( result.code !== 0 ) {
				throw toolError( 'save to', result, secret );
			}
		},
		async delete( account ) {
			const result = await runScript(
				`${ retrieve( account ) }
$vault.Remove($credential)`
			);
			if ( result.code !== 0 && result.code !== NOT_FOUND_EXIT ) {
				throw toolError( 'remove from', result );
			}
		},
	};
}

function createUnsupportedAdapter( platform: string ): PlatformAdapter {
	const reason = `Studio can't use a system keychain on ${ platform }.`;
	const fail = async (): Promise< never > => {
		throw new SecureStorageError( reason );
	};
	return {
		check: async () => ( { available: false, reason, absent: true } ),
		get: fail,
		set: fail,
		delete: fail,
	};
}

export function createOsCredentialStore( {
	service = 'wordpress-studio',
	platform = process.platform,
	run = runCommand,
}: {
	service?: string;
	platform?: NodeJS.Platform;
	run?: CommandRunner;
} = {} ): OsCredentialStore {
	assertItemName( service );
	const adapter =
		platform === 'darwin'
			? createMacAdapter( run, service )
			: platform === 'linux'
			? createLinuxAdapter( run, service )
			: platform === 'win32'
			? createWindowsAdapter( run, service )
			: createUnsupportedAdapter( platform );

	return {
		check: () => adapter.check(),
		async get( account ) {
			assertItemName( account );
			return adapter.get( account );
		},
		async set( account, secret ) {
			assertItemName( account );
			if ( ! secret || /[\s"'\\]/.test( secret ) ) {
				// Every tool above would need the secret escaped otherwise.
				throw new SecureStorageError( 'This secret contains characters the keychain can’t store.' );
			}
			await adapter.set( account, secret );
			if ( ( await adapter.get( account ) ) !== secret ) {
				throw new SecureStorageError(
					'The system keychain didn’t keep the secret. Check that it is unlocked and try again.'
				);
			}
		},
		async delete( account ) {
			assertItemName( account );
			await adapter.delete( account );
		},
	};
}
