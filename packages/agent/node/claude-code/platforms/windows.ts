import path from 'path';
import { findPolicyLocations, managedPolicyFiles, policyFinding } from './policy';
import type {
	ClaudeArch,
	ClaudeBinaryHeader,
	ClaudeByteReader,
	ClaudeManagedPolicySource,
	ClaudePlatformAdapter,
} from '../platform';

const IMAGE_FILE_EXECUTABLE_IMAGE = 0x0002;
const IMAGE_FILE_DLL = 0x2000;
const PE32_PLUS = 0x20b;
const MACHINES: Readonly< Record< number, ClaudeArch > > = Object.freeze( {
	0x8664: 'x64',
	0xaa64: 'arm64',
} );

/** Windows PowerShell 5.1 under the system root, never one found on PATH. */
export function trustedPowerShellPath( env: NodeJS.ProcessEnv = process.env ): string {
	const systemRoot = Object.entries( env ).find(
		( [ name ] ) => name.toUpperCase() === 'SYSTEMROOT'
	)?.[ 1 ];
	if ( ! systemRoot || ! path.win32.isAbsolute( systemRoot ) )
		throw new Error( 'Windows system root unavailable' );
	return path.win32.join( systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe' );
}

/** Arguments that run `script` in Windows PowerShell without a profile or a prompt. */
export function encodedPowerShellArgs( script: string ): string[] {
	return [
		'-NoProfile',
		'-NonInteractive',
		'-EncodedCommand',
		Buffer.from( script, 'utf16le' ).toString( 'base64' ),
	];
}

/** A PowerShell expression for a string passed as UTF-8 base64, so no path is ever parsed as script. */
export function powerShellString( value: string ): string {
	return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${ Buffer.from(
		value,
		'utf8'
	).toString( 'base64' ) }'))`;
}

/** Reads a PE32+ executable image: `MZ`, the PE signature, the COFF header and the optional header's magic. */
export async function readPeHeader(
	read: ClaudeByteReader
): Promise< ClaudeBinaryHeader | undefined > {
	const dos = await read( 0, 64 );
	if ( dos.length !== 64 || dos.toString( 'latin1', 0, 2 ) !== 'MZ' ) return;
	const offset = dos.readUInt32LE( 60 );
	if ( offset < 64 || offset > 1024 * 1024 ) return;
	const pe = await read( offset, 26 );
	if ( pe.length !== 26 || pe.readUInt32LE( 0 ) !== 0x4550 ) return;
	const characteristics = pe.readUInt16LE( 22 );
	if (
		! ( characteristics & IMAGE_FILE_EXECUTABLE_IMAGE ) ||
		characteristics & IMAGE_FILE_DLL ||
		pe.readUInt16LE( 20 ) < 2 ||
		pe.readUInt16LE( 24 ) !== PE32_PLUS
	)
		return;
	const architecture = MACHINES[ pe.readUInt16LE( 4 ) ];
	return { format: 'pe', architectures: architecture ? [ architecture ] : [] };
}

/** The organization the vendor's Authenticode certificate names (code.claude.com/docs/en/setup). */
const WINDOWS_SIGNER = 'Anthropic, PBC';
const SIGNATURE_REFUSED = 3;

const WINDOWS_ENVIRONMENT: readonly string[] = Object.freeze( [
	'PATH',
	'SYSTEMROOT',
	'WINDIR',
	'COMSPEC',
	'PATHEXT',
	'USERPROFILE',
	'HOMEDRIVE',
	'HOMEPATH',
	'APPDATA',
	'LOCALAPPDATA',
	'TEMP',
	'TMP',
	'PROGRAMFILES',
	'PROGRAMFILES(X86)',
	'PROGRAMDATA',
	'CLAUDE_CODE_GIT_BASH_PATH',
] );

function environmentValue( env: NodeJS.ProcessEnv, name: string ): string | undefined {
	return Object.entries( env ).find( ( [ key ] ) => key.toUpperCase() === name )?.[ 1 ];
}

function minimalEnvironment( env: NodeJS.ProcessEnv ): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries( env ).filter( ( [ key ] ) => WINDOWS_ENVIRONMENT.includes( key.toUpperCase() ) )
	);
}

/** The documented system directory; `%ProgramFiles%` is checked as well where it differs. */
const DOCUMENTED_POLICY_DIRECTORY = 'C:\\Program Files\\ClaudeCode';
const POLICY_KEY = 'SOFTWARE\\Policies\\ClaudeCode';
// Exit codes for which documented registry keys exist; any other failure means
// the registry could not be read.
const REGISTRY_FOUND: Readonly< Record< number, Array< 'machine' | 'user' > > > = Object.freeze( {
	11: [ 'machine' ],
	12: [ 'user' ],
	13: [ 'machine', 'user' ],
} );

export const windowsAdapter: ClaudePlatformAdapter = Object.freeze< ClaudePlatformAdapter >( {
	os: 'windows',
	path: path.win32,
	requiresExecutePermission: false,
	environment: Object.freeze( { allowed: WINDOWS_ENVIRONMENT, caseInsensitiveNames: true } ),
	isSelectablePath: ( selected: string ) =>
		path.win32.isAbsolute( selected ) && path.win32.extname( selected ).toLowerCase() === '.exe',
	readBinaryHeader: readPeHeader,
	async verifyBinary( input, seams ) {
		let powershell: string;
		try {
			powershell = trustedPowerShellPath( seams.env );
		} catch {
			return { ok: false, reason: 'signature-unverifiable' };
		}
		const script = `$ErrorActionPreference='Stop'; Import-Module "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"; $p=${ powerShellString(
			input.executablePath
		) }; $s=Get-AuthenticodeSignature -LiteralPath $p; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch '(^|,\\s*)O="?Anthropic, PBC"?(,|$)') { exit ${ SIGNATURE_REFUSED } }; exit 0`;
		try {
			await seams.run( powershell, encodedPowerShellArgs( script ), {
				env: input.env,
				timeout: 20000,
				windowsHide: true,
			} );
		} catch ( error ) {
			return {
				ok: false,
				reason:
					( error as { code?: unknown } ).code === SIGNATURE_REFUSED
						? 'signature-invalid'
						: 'signature-unverifiable',
			};
		}
		return {
			ok: true,
			provenance: {
				verification: 'authenticode',
				signer: WINDOWS_SIGNER,
				vendorPlatform: input.records[ 0 ]?.vendorPlatform,
			},
		};
	},
	/**
	 * The documented Windows sources (code.claude.com/docs/en/managed-settings):
	 * the system directory's files and the `Settings` value under the HKLM and
	 * HKCU policy keys. Any key there counts, whatever its values.
	 */
	async inspectManagedPolicy( seams ) {
		const directories = new Map< string, string >( [
			[ DOCUMENTED_POLICY_DIRECTORY.toLowerCase(), DOCUMENTED_POLICY_DIRECTORY ],
		] );
		const programFiles = environmentValue( seams.env, 'PROGRAMFILES' );
		if ( programFiles && path.win32.isAbsolute( programFiles ) ) {
			const directory = path.win32.join( programFiles, 'ClaudeCode' );
			directories.set( directory.toLowerCase(), directory );
		}
		const files = [ ...directories.values() ].flatMap( ( directory ) =>
			managedPolicyFiles( directory, path.win32 )
		);
		const registry: ClaudeManagedPolicySource[] = [
			{ kind: 'registry', scope: 'machine', location: `HKLM\\${ POLICY_KEY }` },
			{ kind: 'registry', scope: 'user', location: `HKCU\\${ POLICY_KEY }` },
		];
		const { present, unreadable } = await findPolicyLocations( files, seams.files );
		const script = `$ErrorActionPreference='Stop'; $m=Test-Path -LiteralPath 'HKLM:\\${ POLICY_KEY }'; $u=Test-Path -LiteralPath 'HKCU:\\${ POLICY_KEY }'; if($m -and $u) { exit 13 }; if($m) { exit 11 }; if($u) { exit 12 }; exit 0`;
		try {
			await seams.run( trustedPowerShellPath( seams.env ), encodedPowerShellArgs( script ), {
				env: minimalEnvironment( seams.env ),
				timeout: 10000,
				windowsHide: true,
			} );
		} catch ( error ) {
			const code = ( error as { code?: unknown } ).code;
			const found = typeof code === 'number' ? REGISTRY_FOUND[ code ] : undefined;
			if ( found )
				present.push( ...registry.filter( ( source ) => found.includes( source.scope ) ) );
			else unreadable.push( ...registry );
		}
		return policyFinding( [ ...files, ...registry ], present, unreadable );
	},
} );
