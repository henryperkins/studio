import { execFile } from 'child_process';
import { open, realpath } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { buildClaudeEnvironment } from './auth-status';

const execFileAsync = promisify( execFile );
export function trustedPowerShellPath(): string {
	if ( ! process.env.SystemRoot || ! path.isAbsolute( process.env.SystemRoot ) )
		throw new Error( 'Windows system root unavailable' );
	return path.join(
		process.env.SystemRoot,
		'System32',
		'WindowsPowerShell',
		'v1.0',
		'powershell.exe'
	);
}
export type ClaudeExecutableInspection =
	| { ok: false; reason: string }
	| { ok: true; executablePath: string; version: string; platform: string; architecture: string };

export async function inspectClaudeExecutable(
	selectedPath: string
): Promise< ClaudeExecutableInspection > {
	if ( process.platform !== 'win32' ) return { ok: false, reason: 'platform-unqualified' };
	if ( ! path.isAbsolute( selectedPath ) || path.extname( selectedPath ).toLowerCase() !== '.exe' )
		return { ok: false, reason: 'absolute-native-executable-required' };
	try {
		const executablePath = await realpath( selectedPath );
		const file = await open( executablePath, 'r' );
		let machine: number;
		try {
			const dos = Buffer.alloc( 64 );
			if (
				( await file.read( dos, 0, 64, 0 ) ).bytesRead !== 64 ||
				dos.toString( 'ascii', 0, 2 ) !== 'MZ'
			)
				return { ok: false, reason: 'invalid-pe' };
			const offset = dos.readUInt32LE( 60 );
			const pe = Buffer.alloc( 6 );
			if (
				offset > 1024 * 1024 ||
				( await file.read( pe, 0, 6, offset ) ).bytesRead !== 6 ||
				pe.readUInt32LE( 0 ) !== 0x4550
			)
				return { ok: false, reason: 'invalid-pe' };
			machine = pe.readUInt16LE( 4 );
		} finally {
			await file.close();
		}
		if ( machine !== 0x8664 || process.arch !== 'x64' )
			return { ok: false, reason: 'architecture-unqualified' };
		const encoded = Buffer.from( executablePath, 'utf8' ).toString( 'base64' );
		const script = `$ErrorActionPreference='Stop'; Import-Module "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${ encoded }')); $s=Get-AuthenticodeSignature -LiteralPath $p; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch '(^|,\\s*)O="?Anthropic, PBC"?(,|$)') { exit 1 }`;
		await execFileAsync(
			trustedPowerShellPath(),
			[
				'-NoProfile',
				'-NonInteractive',
				'-EncodedCommand',
				Buffer.from( script, 'utf16le' ).toString( 'base64' ),
			],
			{ env: buildClaudeEnvironment( process.env ).env, timeout: 10000, windowsHide: true }
		);
		const { stdout } = await execFileAsync( executablePath, [ '--version' ], {
			env: buildClaudeEnvironment( process.env ).env,
			timeout: 10000,
			windowsHide: true,
			maxBuffer: 4096,
		} );
		const version = /^(\d+\.\d+\.\d+)\s/.exec( stdout.trim() )?.[ 1 ];
		if ( version !== '2.1.319' ) return { ok: false, reason: 'version-unqualified' };
		return {
			ok: true,
			executablePath,
			version,
			platform: process.platform,
			architecture: process.arch,
		};
	} catch {
		return { ok: false, reason: 'unavailable-or-untrusted' };
	}
}
