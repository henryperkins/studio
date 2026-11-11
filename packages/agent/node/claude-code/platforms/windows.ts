import path from 'path';
import type {
	ClaudeArch,
	ClaudeBinaryHeader,
	ClaudeByteReader,
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

export const windowsAdapter: ClaudePlatformAdapter = Object.freeze< ClaudePlatformAdapter >( {
	os: 'windows',
	path: path.win32,
	requiresExecutePermission: false,
	environment: Object.freeze( {
		allowed: Object.freeze( [
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
		] ),
		caseInsensitiveNames: true,
	} ),
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
} );
