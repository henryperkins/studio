import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import { createReadStream, statSync } from 'fs';
import { lstat, open, realpath, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { linuxAdapter } from './platforms/linux';
import { macosAdapter } from './platforms/macos';
import { windowsAdapter } from './platforms/windows';
import type { BigIntStats } from 'fs';
import type { PlatformPath } from 'path';

export type ClaudeOs = 'windows' | 'macos' | 'linux';
export type ClaudeArch = 'x64' | 'arm64';
export type ClaudePlatformTarget = `${ ClaudeOs }-${ ClaudeArch }`;

/** The OS and architecture Studio runs as: `process.platform` and `process.arch`. */
export interface ClaudeHost {
	platform: string;
	arch: string;
}

/** The Agent SDK version Studio installs; `packages/agent/package.json` pins the same. */
export const CLAUDE_AGENT_SDK_VERSION = '0.3.319';

/** How a target proves a selected executable is the vendor's published binary. */
export type ClaudeBinaryVerification =
	| 'authenticode'
	| 'apple-code-signature'
	| 'signed-manifest-checksum';

/** The vendor's name for a platform in its release manifest (`platforms.<name>`). */
export type ClaudeVendorPlatform =
	| 'win32-x64'
	| 'win32-arm64'
	| 'darwin-x64'
	| 'darwin-arm64'
	| 'linux-x64'
	| 'linux-arm64';

interface ClaudeQualificationFacts {
	sdkVersion: string;
	runtimeVersion: string;
	target: ClaudePlatformTarget;
	vendorPlatform: ClaudeVendorPlatform;
	verification: ClaudeBinaryVerification;
	/** Linux only: the C library the qualified binary and host use. */
	libc?: 'glibc';
	/**
	 * Linux only: the binary's SHA-256 from the vendor's release manifest, copied
	 * here only after the manifest's GPG signature was verified during the
	 * target's native qualification. Without it a Linux binary cannot be verified.
	 */
	manifestSha256?: string;
}

export type ClaudeQualificationRecord = Readonly<
	ClaudeQualificationFacts &
		( { state: 'qualified' } | { state: 'unqualified'; reason: 'no-native-qualification-run' } )
>;

function record( value: ClaudeQualificationRecord ): ClaudeQualificationRecord {
	return Object.freeze( { ...value } );
}

const unqualified = { state: 'unqualified', reason: 'no-native-qualification-run' } as const;

/**
 * Every SDK/runtime/platform pair Studio knows about. A pair becomes qualified
 * only after its native qualification run passes on that platform.
 */
export const CLAUDE_QUALIFICATION_MATRIX: readonly ClaudeQualificationRecord[] = Object.freeze( [
	record( {
		sdkVersion: '0.3.319',
		runtimeVersion: '2.1.319',
		target: 'windows-x64',
		vendorPlatform: 'win32-x64',
		verification: 'authenticode',
		state: 'qualified',
	} ),
	record( {
		sdkVersion: '0.3.319',
		runtimeVersion: '2.1.319',
		target: 'windows-arm64',
		vendorPlatform: 'win32-arm64',
		verification: 'authenticode',
		...unqualified,
	} ),
	record( {
		sdkVersion: '0.3.319',
		runtimeVersion: '2.1.319',
		target: 'macos-x64',
		vendorPlatform: 'darwin-x64',
		verification: 'apple-code-signature',
		...unqualified,
	} ),
	record( {
		sdkVersion: '0.3.319',
		runtimeVersion: '2.1.319',
		target: 'macos-arm64',
		vendorPlatform: 'darwin-arm64',
		verification: 'apple-code-signature',
		...unqualified,
	} ),
	record( {
		sdkVersion: '0.3.319',
		runtimeVersion: '2.1.319',
		target: 'linux-x64',
		vendorPlatform: 'linux-x64',
		verification: 'signed-manifest-checksum',
		libc: 'glibc',
		...unqualified,
	} ),
	record( {
		sdkVersion: '0.3.319',
		runtimeVersion: '2.1.319',
		target: 'linux-arm64',
		vendorPlatform: 'linux-arm64',
		verification: 'signed-manifest-checksum',
		libc: 'glibc',
		...unqualified,
	} ),
] );

const OS_BY_PLATFORM: Readonly< Record< string, ClaudeOs > > = Object.freeze( {
	win32: 'windows',
	darwin: 'macos',
	linux: 'linux',
} );

export function claudePlatformTarget( host: ClaudeHost ): ClaudePlatformTarget | undefined {
	const os = Object.prototype.hasOwnProperty.call( OS_BY_PLATFORM, host.platform )
		? OS_BY_PLATFORM[ host.platform ]
		: undefined;
	if ( ! os || ( host.arch !== 'x64' && host.arch !== 'arm64' ) ) return;
	return `${ os }-${ host.arch }`;
}

export type ClaudeQualificationReason =
	| 'platform-unsupported'
	| 'platform-unqualified'
	| 'sdk-unqualified'
	| 'version-unqualified';

export type ClaudeQualificationResult =
	| { state: 'qualified'; record: ClaudeQualificationRecord }
	| {
			state: 'unqualified';
			reason: ClaudeQualificationReason;
			/** For `platform-unqualified`: the target's record and why it is unqualified. */
			record?: ClaudeQualificationRecord;
			/** The runtime versions qualified for this target and SDK. */
			supportedRuntimeVersions: string[];
	  };

export function qualifyClaudeRuntime( input: {
	target: ClaudePlatformTarget | undefined;
	runtimeVersion: string | undefined;
	sdkVersion: string;
} ): ClaudeQualificationResult {
	const { target, runtimeVersion, sdkVersion } = input;
	if ( ! target )
		return { state: 'unqualified', reason: 'platform-unsupported', supportedRuntimeVersions: [] };
	const records = CLAUDE_QUALIFICATION_MATRIX.filter( ( item ) => item.target === target );
	const qualified = records.filter( ( item ) => item.state === 'qualified' );
	if ( ! qualified.length )
		return {
			state: 'unqualified',
			reason: 'platform-unqualified',
			record:
				records.find(
					( item ) => item.sdkVersion === sdkVersion && item.runtimeVersion === runtimeVersion
				) ?? records[ 0 ],
			supportedRuntimeVersions: [],
		};
	const forSdk = qualified.filter( ( item ) => item.sdkVersion === sdkVersion );
	const supportedRuntimeVersions = [
		...new Set( ( forSdk.length ? forSdk : qualified ).map( ( item ) => item.runtimeVersion ) ),
	];
	if ( ! forSdk.length )
		return { state: 'unqualified', reason: 'sdk-unqualified', supportedRuntimeVersions };
	const match = forSdk.find( ( item ) => item.runtimeVersion === runtimeVersion );
	if ( ! match )
		return { state: 'unqualified', reason: 'version-unqualified', supportedRuntimeVersions };
	return { state: 'qualified', record: match };
}

/**
 * Whether the experimental Claude surface is offered: the flag is on and the
 * host is one of the matrix's targets. Qualification is decided per executable.
 */
export function isClaudeRuntimeSurfaceEnabled( host: ClaudeHost, env: NodeJS.ProcessEnv ): boolean {
	return env.STUDIO_EXPERIMENTAL_CLAUDE_CODE === '1' && !! claudePlatformTarget( host );
}

export function currentClaudeHost(): ClaudeHost {
	return { platform: process.platform, arch: process.arch };
}

export type ClaudeExecutableFormat = 'pe' | 'mach-o' | 'mach-o-universal' | 'elf';

/** What a binary's header says about it, before anything runs it. */
export interface ClaudeBinaryHeader {
	format: ClaudeExecutableFormat;
	/** The architectures it has code for; empty when none Studio knows. */
	architectures: ClaudeArch[];
	/** ELF only: the C library its program interpreter belongs to. */
	libc?: 'glibc' | 'musl' | 'static' | 'unknown';
}

export type ClaudeByteReader = ( position: number, length: number ) => Promise< Buffer >;

export interface ClaudeFileStat {
	kind: 'file' | 'directory' | 'symlink' | 'other';
	size: number;
	device: string;
	inode: string;
	/** Modification and status-change times, as nanosecond strings. */
	modified: string;
	changed: string;
	/** Whether any execute permission bit is set (always true where the OS has none). */
	executable: boolean;
}

/** The filesystem as platform code sees it, so other OSes' layouts can be simulated. */
export interface ClaudeFileAccess {
	realpath( target: string ): Promise< string >;
	stat( target: string ): Promise< ClaudeFileStat >;
	lstat( target: string ): Promise< ClaudeFileStat >;
	statSync( target: string ): ClaudeFileStat;
	read( target: string, position: number, length: number ): Promise< Buffer >;
	sha256( target: string ): Promise< string >;
}

/** Runs a native command without a shell and returns its output; it rejects on a non-zero exit. */
export type ClaudeCommandRunner = (
	file: string,
	args: string[],
	options: {
		env: NodeJS.ProcessEnv;
		timeout: number;
		windowsHide: boolean;
		maxBuffer?: number;
		cwd?: string;
	}
) => Promise< { stdout: string } >;

/** Starts a long-lived program without a shell or waiting for it, settling once it has started. */
export type ClaudeDetachedLauncher = (
	file: string,
	args: string[],
	options: { env: NodeJS.ProcessEnv; cwd: string }
) => Promise< void >;

/** Everything platform code reads from or does to the machine, injectable for tests. */
export interface ClaudePlatformSeams {
	host: ClaudeHost;
	env: NodeJS.ProcessEnv;
	files: ClaudeFileAccess;
	run: ClaudeCommandRunner;
	launchDetached: ClaudeDetachedLauncher;
	findOnPath( command: string ): string | null;
	username(): string;
	hostLibc(): 'glibc' | 'musl' | 'unknown';
}

/** The file inspection qualified: what sign-in and execution check again before using it. */
export interface ClaudeExecutableIdentity {
	path: string;
	size: number;
	device: string;
	inode: string;
	modified: string;
	changed: string;
	sha256: string;
}

export interface ClaudeProvenance {
	verification: ClaudeBinaryVerification;
	vendorPlatform?: ClaudeVendorPlatform;
	/** The signer the platform's code signature names. */
	signer?: string;
	libc?: 'glibc';
	/** For a manifest checksum: the release the matching manifest describes. */
	manifestRuntimeVersion?: string;
}

export type ClaudeBinaryVerificationResult =
	| { ok: true; provenance: ClaudeProvenance }
	| { ok: false; reason: 'signature-invalid' | 'signature-unverifiable' | 'libc-unsupported' };

export interface ClaudeBinaryVerificationInput {
	executablePath: string;
	sha256: string;
	header: ClaudeBinaryHeader;
	/** The matrix records for the host's target. */
	records: readonly ClaudeQualificationRecord[];
	/** The minimal environment any helper command runs with. */
	env: NodeJS.ProcessEnv;
}

/** What differs between Windows, macOS and Linux. */
export interface ClaudePlatformAdapter {
	readonly os: ClaudeOs;
	readonly path: PlatformPath;
	/** Whether the OS has execute permission bits a native executable must carry. */
	readonly requiresExecutePermission: boolean;
	/** Whether a selected path can name a native executable at all, before touching the file. */
	isSelectablePath( selected: string ): boolean;
	readBinaryHeader( read: ClaudeByteReader ): Promise< ClaudeBinaryHeader | undefined >;
	/** Proves the binary is the vendor's published one, without running it. */
	verifyBinary(
		input: ClaudeBinaryVerificationInput,
		seams: ClaudePlatformSeams
	): Promise< ClaudeBinaryVerificationResult >;
}

export function selectClaudePlatformAdapter( host: ClaudeHost ): ClaudePlatformAdapter | undefined {
	const target = claudePlatformTarget( host );
	if ( ! target ) return;
	if ( target.startsWith( 'windows-' ) ) return windowsAdapter;
	if ( target.startsWith( 'macos-' ) ) return macosAdapter;
	return linuxAdapter;
}

function fileStat( value: BigIntStats ): ClaudeFileStat {
	let kind: ClaudeFileStat[ 'kind' ] = 'other';
	if ( value.isFile() ) kind = 'file';
	else if ( value.isDirectory() ) kind = 'directory';
	else if ( value.isSymbolicLink() ) kind = 'symlink';
	return {
		kind,
		size: Number( value.size ),
		device: value.dev.toString(),
		inode: value.ino.toString(),
		modified: value.mtimeNs.toString(),
		changed: value.ctimeNs.toString(),
		executable: process.platform === 'win32' || ( Number( value.mode ) & 0o111 ) !== 0,
	};
}

const nodeFiles: ClaudeFileAccess = {
	realpath: ( target ) => realpath( target ),
	stat: async ( target ) => fileStat( await stat( target, { bigint: true } ) ),
	lstat: async ( target ) => fileStat( await lstat( target, { bigint: true } ) ),
	statSync: ( target ) => fileStat( statSync( target, { bigint: true } ) ),
	async read( target, position, length ) {
		const handle = await open( target, 'r' );
		try {
			const buffer = Buffer.alloc( length );
			const { bytesRead } = await handle.read( buffer, 0, length, position );
			return buffer.subarray( 0, bytesRead );
		} finally {
			await handle.close();
		}
	},
	sha256: ( target ) =>
		new Promise( ( resolve, reject ) => {
			const hash = createHash( 'sha256' );
			createReadStream( target )
				.on( 'error', reject )
				.on( 'data', ( chunk ) => hash.update( chunk ) )
				.on( 'end', () => resolve( hash.digest( 'hex' ) ) );
		} ),
};

const execFileAsync = promisify( execFile );

const nodeRun: ClaudeCommandRunner = async ( file, args, options ) => {
	const { stdout } = await execFileAsync( file, args, { ...options, encoding: 'utf8' } );
	return { stdout };
};

const nodeLaunchDetached: ClaudeDetachedLauncher = ( file, args, options ) =>
	new Promise( ( resolve, reject ) => {
		const child = spawn( file, args, {
			cwd: options.cwd,
			env: options.env,
			detached: true,
			stdio: 'ignore',
		} );
		child.once( 'error', reject );
		child.once( 'spawn', () => {
			child.unref();
			resolve();
		} );
	} );

function findOnSearchPath( command: string, env: NodeJS.ProcessEnv ): string | null {
	for ( const directory of ( env.PATH ?? '' ).split( path.posix.delimiter ) ) {
		if ( ! path.posix.isAbsolute( directory ) ) continue;
		const candidate = path.posix.join( directory, command );
		try {
			const found = statSync( candidate );
			if ( found.isFile() && ( found.mode & 0o111 ) !== 0 ) return candidate;
		} catch {
			// Not in this directory.
		}
	}
	return null;
}

let libc: 'glibc' | 'musl' | 'unknown' | undefined;
function nodeHostLibc(): 'glibc' | 'musl' | 'unknown' {
	if ( libc ) return libc;
	const header = ( process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } )
		?.header;
	libc = header?.glibcVersionRuntime ? 'glibc' : 'unknown';
	return libc;
}

export function defaultClaudePlatformSeams(
	overrides: Partial< ClaudePlatformSeams > = {}
): ClaudePlatformSeams {
	const env = overrides.env ?? process.env;
	return {
		host: currentClaudeHost(),
		env,
		files: nodeFiles,
		run: nodeRun,
		launchDetached: nodeLaunchDetached,
		findOnPath: ( command ) => findOnSearchPath( command, env ),
		username: () => {
			try {
				return os.userInfo().username;
			} catch {
				return env.USER ?? '';
			}
		},
		hostLibc: nodeHostLibc,
		...overrides,
	};
}

function sameFile( identity: ClaudeExecutableIdentity, current: ClaudeFileStat ): boolean {
	return (
		current.kind === 'file' &&
		current.size === identity.size &&
		current.device === identity.device &&
		current.inode === identity.inode &&
		current.modified === identity.modified &&
		current.changed === identity.changed
	);
}

/**
 * Whether the file inspection qualified is still there unchanged, judged by
 * metadata alone so it can run synchronously right before a process is spawned.
 */
export function isClaudeExecutableUnchanged(
	identity: ClaudeExecutableIdentity,
	files: ClaudeFileAccess = nodeFiles
): boolean {
	try {
		return sameFile( identity, files.statSync( identity.path ) );
	} catch {
		return false;
	}
}

/**
 * Whether the selected path still resolves to the file inspection qualified,
 * with the same metadata and, unless `content` is false, the same contents.
 */
export async function verifyClaudeExecutableIdentity(
	identity: ClaudeExecutableIdentity,
	options: { selectedPath?: string; files?: ClaudeFileAccess; content?: boolean } = {}
): Promise< boolean > {
	const files = options.files ?? nodeFiles;
	try {
		if (
			options.selectedPath !== undefined &&
			( await files.realpath( options.selectedPath ) ) !== identity.path
		)
			return false;
		if ( ! sameFile( identity, await files.stat( identity.path ) ) ) return false;
		if ( options.content === false ) return true;
		if ( ( await files.sha256( identity.path ) ) !== identity.sha256 ) return false;
		return sameFile( identity, await files.stat( identity.path ) );
	} catch {
		return false;
	}
}
