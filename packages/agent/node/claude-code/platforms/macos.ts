import path from 'path';
import type {
	ClaudeArch,
	ClaudeBinaryHeader,
	ClaudeByteReader,
	ClaudePlatformAdapter,
} from '../platform';

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
// Real universal binaries carry a handful of slices; a Java class file shares
// FAT_MAGIC and reads as a count in the dozens.
const MAX_SLICES = 16;
const CPU_TYPES: Readonly< Record< number, ClaudeArch > > = Object.freeze( {
	0x01000007: 'x64',
	0x0100000c: 'arm64',
} );

function known( cpuType: number ): ClaudeArch[] {
	const architecture = CPU_TYPES[ cpuType ];
	return architecture ? [ architecture ] : [];
}

/** Reads a little-endian 64-bit Mach-O header, or a universal binary's slice table. */
export async function readMachOHeader(
	read: ClaudeByteReader
): Promise< ClaudeBinaryHeader | undefined > {
	const head = await read( 0, 8 );
	if ( head.length !== 8 ) return;
	if ( head.readUInt32LE( 0 ) === MH_MAGIC_64 )
		return { format: 'mach-o', architectures: known( head.readInt32LE( 4 ) ) };
	const magic = head.readUInt32BE( 0 );
	if ( magic !== FAT_MAGIC && magic !== FAT_MAGIC_64 ) return;
	const count = head.readUInt32BE( 4 );
	if ( count < 1 || count > MAX_SLICES ) return;
	const entry = magic === FAT_MAGIC_64 ? 32 : 20;
	const table = await read( 8, entry * count );
	if ( table.length !== entry * count ) return;
	const architectures: ClaudeArch[] = [];
	for ( let index = 0; index < count; index++ )
		for ( const architecture of known( table.readInt32BE( entry * index ) ) )
			if ( ! architectures.includes( architecture ) ) architectures.push( architecture );
	return { format: 'mach-o-universal', architectures };
}

/**
 * The vendor's documented macOS signer is "Anthropic PBC" with Apple
 * notarization (code.claude.com/docs/en/setup). The documentation names no
 * team identifier, so the requirement pins a Developer ID Application
 * certificate issued through Apple to that organization, and nothing more.
 */
const MACOS_SIGNER = 'Anthropic PBC';
const DEVELOPER_ID_REQUIREMENT = `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.O] = "${ MACOS_SIGNER }"`;
const CODESIGN = '/usr/bin/codesign';
// codesign exits 1 when a signature is missing or broken and 3 when it does not
// satisfy the requirement; anything else means it could not check.
const CODESIGN_REFUSED = new Set( [ 1, 3 ] );

export const macosAdapter: ClaudePlatformAdapter = Object.freeze< ClaudePlatformAdapter >( {
	os: 'macos',
	path: path.posix,
	requiresExecutePermission: true,
	environment: Object.freeze( {
		allowed: Object.freeze( [
			'HOME',
			'USER',
			'LOGNAME',
			'SHELL',
			'PATH',
			'TMPDIR',
			'LANG',
			'LC_ALL',
			'LC_CTYPE',
			'__CF_USER_TEXT_ENCODING',
		] ),
		caseInsensitiveNames: false,
	} ),
	isSelectablePath: ( selected: string ) => path.posix.isAbsolute( selected ),
	readBinaryHeader: readMachOHeader,
	async verifyBinary( input, seams ) {
		try {
			await seams.run(
				CODESIGN,
				[ '--verify', '--strict', '-R', `=${ DEVELOPER_ID_REQUIREMENT }`, input.executablePath ],
				{ env: input.env, timeout: 30000, windowsHide: true }
			);
		} catch ( error ) {
			const code = ( error as { code?: unknown } ).code;
			return {
				ok: false,
				reason:
					typeof code === 'number' && CODESIGN_REFUSED.has( code )
						? 'signature-invalid'
						: 'signature-unverifiable',
			};
		}
		return {
			ok: true,
			provenance: {
				verification: 'apple-code-signature',
				signer: MACOS_SIGNER,
				vendorPlatform: input.records[ 0 ]?.vendorPlatform,
			},
		};
	},
} );
