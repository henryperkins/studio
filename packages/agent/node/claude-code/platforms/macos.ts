import path from 'path';
import { findPolicyLocations, managedPolicyFiles, policyFinding } from './policy';
import { isRemoteSession, sandboxFact, signInScript } from './terminal';
import type {
	ClaudeArch,
	ClaudeBinaryHeader,
	ClaudeByteReader,
	ClaudeManagedPolicySource,
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
const SYSCTL = '/usr/sbin/sysctl';
// codesign exits 1 when a signature is missing or broken and 3 when it does not
// satisfy the requirement; anything else means it could not check.
const CODESIGN_REFUSED = new Set( [ 1, 3 ] );
const MANAGED_PREFERENCES = '/Library/Managed Preferences';
const PREFERENCES_DOMAIN = 'com.anthropic.claudecode';
const TERMINAL_APP = '/System/Applications/Utilities/Terminal.app';
const OPEN = '/usr/bin/open';
const OSASCRIPT = '/usr/bin/osascript';
// The only argument is the sign-in script's shell-inert path, the only part of
// the line Terminal's login shell parses that is not fixed here.
const TERMINAL_SCRIPT: readonly string[] = Object.freeze( [
	'on run argv',
	'tell application "Terminal"',
	'activate',
	'do script "exec /bin/sh " & (item 1 of argv)',
	'end tell',
	'end run',
] );

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
	/**
	 * `hw.optional.arm64` is 1 where "the platform uses the ARM ISA" (Apple,
	 * "Determining Instruction Set Characteristics"), a fact about the
	 * hardware that Rosetta does not translate, unlike `uname -m` and
	 * `os.machine()`. `sysctl.proc_translated` describes only the process that
	 * reads it, and that would be this child, not Studio. Only an explicit 0
	 * means Intel: an Intel Mac without the key is not established.
	 */
	async probeMachineArchitecture( seams ) {
		const { stdout } = await seams.run( SYSCTL, [ '-n', 'hw.optional.arm64' ], {
			env: {},
			timeout: 10000,
			windowsHide: true,
		} );
		const value = stdout.trim();
		if ( value === '1' ) return 'arm64';
		if ( value === '0' ) return 'x64';
		return undefined;
	},
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
	/**
	 * The documented macOS sources (code.claude.com/docs/en/managed-settings): the
	 * system directory's files and the `com.anthropic.claudecode` managed
	 * preferences domain. The documentation names the domain, not a file. The
	 * device and per-user paths below are where macOS stores configuration
	 * profile preferences, but until a native qualification run confirms them a
	 * missing file there proves nothing: each preferences source is reported
	 * present when found and unreadable otherwise, never absent.
	 */
	async inspectManagedPolicy( seams ) {
		const files = managedPolicyFiles( '/Library/Application Support/ClaudeCode', path.posix );
		const machine: ClaudeManagedPolicySource = {
			kind: 'managed-preferences',
			scope: 'machine',
			location: `${ MANAGED_PREFERENCES }/${ PREFERENCES_DOMAIN }.plist`,
		};
		const username = seams.username();
		const knownUser = !! username && ! username.includes( '/' ) && username !== '..';
		const user: ClaudeManagedPolicySource = {
			kind: 'managed-preferences',
			scope: 'user',
			location: `${ MANAGED_PREFERENCES }/${
				knownUser ? username : '(unknown user)'
			}/${ PREFERENCES_DOMAIN }.plist`,
		};
		const preferences = knownUser ? [ machine, user ] : [ machine ];
		const found = await findPolicyLocations( [ ...files, ...preferences ], seams.files );
		const unconfirmed = [ machine, user ].filter(
			( source ) => ! found.present.includes( source ) && ! found.unreadable.includes( source )
		);
		return policyFinding( [ ...files, machine, user ], found.present, [
			...found.unreadable,
			...unconfirmed,
		] );
	},
	/**
	 * Asks Terminal to run the login. Terminal hands a command line to the
	 * user's login shell, which may be fish or csh, where POSIX quoting is not
	 * safe; so that line is `exec /bin/sh <script>`, and the user's paths and
	 * values reach only `/bin/sh`, inside a Studio-owned script.
	 */
	async planSignIn( request, seams ) {
		if ( isRemoteSession( seams.env ) )
			return { state: 'user-action-needed', reason: 'no-display' };
		for ( const [ required, reason ] of [
			[ TERMINAL_APP, 'no-terminal' ],
			[ OPEN, 'no-browser' ],
		] as const ) {
			try {
				await seams.files.stat( required );
			} catch {
				return { state: 'user-action-needed', reason };
			}
		}
		const prepared = await signInScript( request, seams );
		if ( 'state' in prepared ) return prepared;
		return {
			state: 'ready',
			launch: {
				mode: 'run',
				file: OSASCRIPT,
				args: [ ...TERMINAL_SCRIPT.flatMap( ( line ) => [ '-e', line ] ), prepared.script.path ],
				env: request.env,
				cwd: request.cwd,
				script: prepared.script,
			},
		};
	},
	shellSandbox: sandboxFact( {
		available: true,
		mechanism: 'seatbelt',
		requires: [],
		optional: [],
		limitations: [
			'reads-outside-workspace-by-default',
			'ssh-git-remotes-fail',
			'tls-verification-may-fail',
		],
	} ),
} );
