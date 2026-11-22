import path from 'path';
import { resolveLinuxTerminalCommandLaunch } from '@studio/common/lib/user-settings/terminal';
import { findPolicyLocations, managedPolicyFiles, policyFinding } from './policy';
import { sandboxFact, signInScript } from './terminal';
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
	 * The kernel's machine name. Linux has no system translation layer; a
	 * user-mode emulator (qemu-user, FEX, Box64) reports its guest machine
	 * here, which this probe cannot see through, so native qualification has
	 * to record it.
	 */
	async probeMachineArchitecture( seams ) {
		const machine = seams.osMachine();
		if ( machine === 'x86_64' ) return 'x64';
		if ( machine === 'aarch64' || machine === 'arm64' ) return 'arm64';
		return undefined;
	},
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
	/** The documented Linux sources (code.claude.com/docs/en/managed-settings): `/etc/claude-code`. */
	async inspectManagedPolicy( seams ) {
		const files = managedPolicyFiles( '/etc/claude-code', path.posix );
		const { present, unreadable } = await findPolicyLocations( files, seams.files );
		return policyFinding( files, present, unreadable );
	},
	/**
	 * Starts a terminal that runs `/bin/sh <script>`, in the script's shell-inert
	 * temporary directory. Some terminals, or what `x-terminal-emulator` points
	 * to, join their command into one string for a shell; every argument Studio
	 * gives them is shell-inert, and the user's paths and values reach only
	 * `/bin/sh`, inside the script. The login opens the browser with
	 * `xdg-open`; without a display, a terminal or that opener the user has to
	 * run the login themselves.
	 */
	async planSignIn( request, seams ) {
		if ( ! seams.env.DISPLAY && ! seams.env.WAYLAND_DISPLAY )
			return { state: 'user-action-needed', reason: 'no-display' };
		if ( ! resolveLinuxTerminalCommandLaunch( '/', [], seams.findOnPath ) )
			return { state: 'user-action-needed', reason: 'no-terminal' };
		if ( ! seams.findOnPath( 'xdg-open' ) )
			return { state: 'user-action-needed', reason: 'no-browser' };
		const prepared = await signInScript( request, seams );
		if ( 'state' in prepared ) return prepared;
		const terminal = resolveLinuxTerminalCommandLaunch(
			prepared.base,
			prepared.command,
			seams.findOnPath
		);
		if ( ! terminal ) return { state: 'user-action-needed', reason: 'no-terminal' };
		return {
			state: 'ready',
			launch: {
				mode: 'detached',
				file: terminal.file,
				args: terminal.args,
				env: request.env,
				cwd: terminal.cwd,
				script: prepared.script,
			},
		};
	},
	shellSandbox: sandboxFact( {
		available: true,
		mechanism: 'bubblewrap',
		requires: [ 'bubblewrap', 'socat' ],
		optional: [ 'seccomp-filter' ],
		limitations: [
			'reads-outside-workspace-by-default',
			'ubuntu-apparmor-user-namespaces',
			'unprivileged-container-proc',
		],
	} ),
} );
