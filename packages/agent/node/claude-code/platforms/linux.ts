import path from 'path';
import type {
	ClaudeArch,
	ClaudeBinaryHeader,
	ClaudeByteReader,
	ClaudePlatformAdapter,
} from '../platform';

const ELF_CLASS_64 = 2;
const ELF_DATA_LITTLE_ENDIAN = 1;
const ET_EXEC = 2;
const ET_DYN = 3;
const PT_INTERP = 3;
const PROGRAM_HEADER_SIZE = 56;
const MAX_PROGRAM_HEADERS = 128;
const MACHINES: Readonly< Record< number, ClaudeArch > > = Object.freeze( {
	62: 'x64',
	183: 'arm64',
} );

function libcOf( interpreter: string ): NonNullable< ClaudeBinaryHeader[ 'libc' ] > {
	const name = path.posix.basename( interpreter );
	if ( name.startsWith( 'ld-linux-' ) ) return 'glibc';
	if ( name.startsWith( 'ld-musl-' ) ) return 'musl';
	return 'unknown';
}

/** Reads a 64-bit little-endian ELF executable header and its program interpreter. */
export async function readElfHeader(
	read: ClaudeByteReader
): Promise< ClaudeBinaryHeader | undefined > {
	const head = await read( 0, 64 );
	if (
		head.length !== 64 ||
		head.readUInt32BE( 0 ) !== 0x7f454c46 ||
		head[ 4 ] !== ELF_CLASS_64 ||
		head[ 5 ] !== ELF_DATA_LITTLE_ENDIAN ||
		head[ 6 ] !== 1
	)
		return;
	const type = head.readUInt16LE( 16 );
	if ( type !== ET_EXEC && type !== ET_DYN ) return;
	const architecture = MACHINES[ head.readUInt16LE( 18 ) ];
	const offset = head.readBigUInt64LE( 32 );
	const count = head.readUInt16LE( 56 );
	if (
		head.readUInt16LE( 54 ) !== PROGRAM_HEADER_SIZE ||
		count > MAX_PROGRAM_HEADERS ||
		offset > BigInt( 1024 * 1024 )
	)
		return;
	const table = await read( Number( offset ), PROGRAM_HEADER_SIZE * count );
	if ( table.length !== PROGRAM_HEADER_SIZE * count ) return;
	let libc: NonNullable< ClaudeBinaryHeader[ 'libc' ] > = 'static';
	for ( let index = 0; index < count; index++ ) {
		const entry = table.subarray( index * PROGRAM_HEADER_SIZE );
		if ( entry.readUInt32LE( 0 ) !== PT_INTERP ) continue;
		const size = entry.readBigUInt64LE( 32 );
		if ( size < BigInt( 2 ) || size > BigInt( 4096 ) ) return;
		const interpreter = await read( Number( entry.readBigUInt64LE( 8 ) ), Number( size ) );
		if ( interpreter.length !== Number( size ) ) return;
		libc = libcOf( interpreter.toString( 'latin1' ).replace( /\0+$/, '' ) );
		break;
	}
	return { format: 'elf', architectures: architecture ? [ architecture ] : [], libc };
}

export const linuxAdapter: ClaudePlatformAdapter = Object.freeze< ClaudePlatformAdapter >( {
	os: 'linux',
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
			'XDG_CONFIG_HOME',
			'XDG_DATA_HOME',
			'XDG_CACHE_HOME',
			'XDG_STATE_HOME',
			'XDG_RUNTIME_DIR',
			'XDG_SESSION_TYPE',
			'DISPLAY',
			'WAYLAND_DISPLAY',
			'XAUTHORITY',
			'DBUS_SESSION_BUS_ADDRESS',
		] ),
		caseInsensitiveNames: false,
	} ),
	isSelectablePath: ( selected: string ) => path.posix.isAbsolute( selected ),
	readBinaryHeader: readElfHeader,
	/**
	 * Linux binaries carry no code signature; the vendor's integrity check is its
	 * GPG-signed release manifest (code.claude.com/docs/en/setup). Studio has no
	 * OpenPGP verifier, so a qualification run verifies the manifest's signature
	 * and copies the binary's checksum into the matrix; without that record the
	 * binary cannot be verified and never runs.
	 */
	async verifyBinary( input, seams ) {
		if ( input.header.libc !== 'glibc' || seams.hostLibc() !== 'glibc' )
			return { ok: false, reason: 'libc-unsupported' };
		const pinned = input.records.filter( ( record ) => record.manifestSha256 );
		if ( ! pinned.length ) return { ok: false, reason: 'signature-unverifiable' };
		const match = pinned.find( ( record ) => record.manifestSha256 === input.sha256 );
		if ( ! match ) return { ok: false, reason: 'signature-invalid' };
		return {
			ok: true,
			provenance: {
				verification: 'signed-manifest-checksum',
				vendorPlatform: match.vendorPlatform,
				libc: 'glibc',
				manifestRuntimeVersion: match.runtimeVersion,
			},
		};
	},
} );
