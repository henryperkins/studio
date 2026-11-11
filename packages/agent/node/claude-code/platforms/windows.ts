import path from 'path';
import { findPolicyLocations, managedPolicyFiles, policyFinding } from './policy';
import { isRemoteSession, sandboxFact } from './terminal';
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

/**
 * A PowerShell function that walks a certificate subject's DER encoding and is
 * true only when it holds exactly one Organization (2.5.4.10) attribute, alone
 * in its relative distinguished name, whose UTF8String, PrintableString or
 * BMPString value is ordinally equal to the vendor's. Ordinal, because `-ceq`
 * compares by culture and ignores characters such as a soft hyphen. Any
 * encoding it cannot read throws, so the signer cannot be verified.
 */
export const AUTHENTICODE_SIGNER_CHECK = [
	'function Test-StudioClaudeSigner([byte[]]$Name) {',
	`$expected = '${ WINDOWS_SIGNER }'`,
	'$utf8 = New-Object System.Text.UTF8Encoding($false, $true)',
	'$bmp = New-Object System.Text.UnicodeEncoding($true, $false, $true)',
	'function Read-Element([int]$At, [int]$End) {',
	"if ($At + 2 -gt $End) { throw 'Truncated subject' }",
	'$length = [int]$Name[$At + 1]',
	'$start = $At + 2',
	'if ($length -ge 0x80) {',
	'$count = $length - 0x80',
	"if ($count -lt 1 -or $count -gt 2 -or $start + $count -gt $End) { throw 'Unsupported length' }",
	'$length = 0',
	'for ($k = 0; $k -lt $count; $k++) { $length = $length * 256 + $Name[$start + $k] }',
	'$start += $count',
	'}',
	"if ($start + $length -gt $End) { throw 'Truncated subject' }",
	'return ,@([int]$Name[$At], $start, ($start + $length))',
	'}',
	'$subject = Read-Element 0 $Name.Length',
	"if ($subject[0] -ne 0x30 -or $subject[2] -ne $Name.Length) { throw 'Not a subject' }",
	'$organizations = 0',
	'$matched = $false',
	'$at = $subject[1]',
	'while ($at -lt $subject[2]) {',
	'$rdn = Read-Element $at $subject[2]',
	"if ($rdn[0] -ne 0x31) { throw 'Not a relative distinguished name' }",
	'$attributes = 0',
	'$value = $null',
	'$isOrganization = $false',
	'$inner = $rdn[1]',
	'while ($inner -lt $rdn[2]) {',
	'$attribute = Read-Element $inner $rdn[2]',
	"if ($attribute[0] -ne 0x30) { throw 'Not an attribute' }",
	'$type = Read-Element $attribute[1] $attribute[2]',
	"if ($type[0] -ne 0x06) { throw 'Not an attribute type' }",
	'$data = Read-Element $type[2] $attribute[2]',
	"if ($data[2] -ne $attribute[2]) { throw 'Unexpected attribute data' }",
	'$attributes++',
	'if ($type[2] - $type[1] -eq 3 -and $Name[$type[1]] -eq 0x55 -and $Name[$type[1] + 1] -eq 0x04 -and $Name[$type[1] + 2] -eq 0x0A) {',
	'$organizations++',
	'$isOrganization = $true',
	'$length = $data[2] - $data[1]',
	'if ($data[0] -eq 0x0C -or $data[0] -eq 0x13) { $value = $utf8.GetString($Name, $data[1], $length) }',
	'elseif ($data[0] -eq 0x1E) { $value = $bmp.GetString($Name, $data[1], $length) }',
	'}',
	'$inner = $attribute[2]',
	'}',
	"if ($attributes -lt 1) { throw 'Empty relative distinguished name' }",
	'if ($isOrganization -and $attributes -eq 1 -and $value -is [string] -and [string]::Equals($value, $expected, [System.StringComparison]::Ordinal)) { $matched = $true }',
	'$at = $rdn[2]',
	'}',
	'return ($organizations -eq 1 -and $matched)',
	'}',
].join( '\n' );

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

/**
 * The IMAGE_FILE_MACHINE_* values IsWow64Process2 reports as the host's
 * native machine. Its documentation defines that output as the native
 * architecture of the host system, whatever the calling process is, while
 * GetSystemInfo, GetNativeSystemInfo (and so `os.machine()`) and the process's
 * PROCESSOR_ARCHITECTURE describe the emulated machine to an x64 process on ARM64.
 */
const NATIVE_MACHINES: Readonly< Record< string, ClaudeArch > > = Object.freeze( {
	'34404': 'x64',
	'43620': 'arm64',
} );
const NATIVE_MACHINE_PROBE = [
	"$ErrorActionPreference='Stop'",
	'Add-Type -Namespace StudioClaude -Name NativeMachine -MemberDefinition \'[DllImport("kernel32.dll", SetLastError = true)] public static extern bool IsWow64Process2(IntPtr process, out ushort processMachine, out ushort nativeMachine);\'',
	'$process = [uint16]0',
	'$native = [uint16]0',
	'if (-not [StudioClaude.NativeMachine]::IsWow64Process2([System.Diagnostics.Process]::GetCurrentProcess().Handle, [ref]$process, [ref]$native)) { exit 2 }',
	'[Console]::Out.Write($native)',
].join( '\n' );

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
	async probeMachineArchitecture( seams ) {
		const { stdout } = await seams.run(
			trustedPowerShellPath( seams.env ),
			encodedPowerShellArgs( NATIVE_MACHINE_PROBE ),
			{ env: minimalEnvironment( seams.env ), timeout: 30000, windowsHide: true }
		);
		const value = stdout.trim();
		return Object.prototype.hasOwnProperty.call( NATIVE_MACHINES, value )
			? NATIVE_MACHINES[ value ]
			: undefined;
	},
	async verifyBinary( input, seams ) {
		let powershell: string;
		try {
			powershell = trustedPowerShellPath( seams.env );
		} catch {
			return { ok: false, reason: 'signature-unverifiable' };
		}
		const script = [
			"$ErrorActionPreference='Stop'",
			'Import-Module "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"',
			AUTHENTICODE_SIGNER_CHECK,
			`$p=${ powerShellString( input.executablePath ) }`,
			'$s=Get-AuthenticodeSignature -LiteralPath $p',
			`if ($s.Status -ne 'Valid' -or -not $s.SignerCertificate) { exit ${ SIGNATURE_REFUSED } }`,
			`if (-not (Test-StudioClaudeSigner $s.SignerCertificate.SubjectName.RawData)) { exit ${ SIGNATURE_REFUSED } }`,
			'exit 0',
		].join( '\n' );
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
	/**
	 * Opens the login in a new console window through ShellExecute, as
	 * `Start-Process` does, but by `ProcessStartInfo`: `Start-Process -FilePath`
	 * expands wildcards, so a path with `[1]` could start another program. The
	 * paths reach PowerShell only as base64 data. A remote session's window would
	 * open on a desktop the user cannot see, so it asks the user to act instead.
	 * There is no WSL fallback.
	 */
	async planSignIn( request, seams ) {
		if ( isRemoteSession( seams.env ) )
			return { state: 'user-action-needed', reason: 'no-interactive-desktop' };
		if ( ! request.args.every( ( argument ) => /^[a-z][a-z-]*$/.test( argument ) ) )
			throw new Error( 'Unexpected sign-in arguments' );
		const script = `$ErrorActionPreference='Stop'; $i=New-Object System.Diagnostics.ProcessStartInfo; $i.FileName=${ powerShellString(
			request.executablePath
		) }; $i.Arguments='${ request.args.join( ' ' ) }'; $i.WorkingDirectory=${ powerShellString(
			request.cwd
		) }; $i.UseShellExecute=$true; $i.WindowStyle=[System.Diagnostics.ProcessWindowStyle]::Normal; [void][System.Diagnostics.Process]::Start($i)`;
		return {
			state: 'ready',
			launch: {
				mode: 'run',
				file: trustedPowerShellPath( seams.env ),
				args: encodedPowerShellArgs( script ),
				env: request.env,
				cwd: request.cwd,
			},
		};
	},
	shellSandbox: sandboxFact( {
		available: false,
		requires: [],
		optional: [],
		limitations: [ 'native-windows-runs-commands-unsandboxed' ],
	} ),
} );
