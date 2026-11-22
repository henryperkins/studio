import { buildClaudeEnvironment } from './auth-status';
import {
	CLAUDE_AGENT_SDK_VERSION,
	CLAUDE_QUALIFICATION_MATRIX,
	claudePlatformTarget,
	defaultClaudePlatformSeams,
	qualifyClaudeRuntime,
	resolveClaudeMachineTarget,
	selectClaudePlatformAdapter,
} from './platform';
import type {
	ClaudeArch,
	ClaudeBinaryHeader,
	ClaudeExecutableFormat,
	ClaudeExecutableIdentity,
	ClaudeFileStat,
	ClaudeHostFinding,
	ClaudePlatformSeams,
	ClaudePlatformTarget,
	ClaudeProvenance,
	ClaudeQualificationReason,
	ClaudeQualificationRecord,
	ClaudeQualificationResult,
} from './platform';

export { trustedPowerShellPath } from './platforms/windows';

export const QUALIFIED_CLAUDE_CODE_VERSION = '2.1.319';

/** A check of the selected file itself that failed. */
export type ClaudeExecutableCheck =
	| 'absolute-native-executable-required'
	| 'executable-unavailable'
	| 'invalid-executable-format'
	| 'architecture-unqualified'
	| 'libc-unsupported'
	| 'signature-invalid'
	| 'signature-unverifiable'
	| 'version-unreadable'
	| 'executable-changed';

export type ClaudeExecutableReason = ClaudeExecutableCheck | ClaudeQualificationReason;

/** What inspection safely learned about a selected executable; never a credential. */
export interface ClaudeExecutableMetadata {
	selectedPath: string;
	executablePath?: string;
	format?: ClaudeExecutableFormat;
	architectures?: ClaudeArch[];
	libc?: ClaudeBinaryHeader[ 'libc' ];
	provenance?: ClaudeProvenance;
	identity?: ClaudeExecutableIdentity;
	version?: string;
}

export type ClaudeExecutableInspection =
	| {
			ok: true;
			executablePath: string;
			version: string;
			platform: string;
			architecture: string;
			target: ClaudePlatformTarget;
			format: ClaudeExecutableFormat;
			architectures: ClaudeArch[];
			libc?: ClaudeBinaryHeader[ 'libc' ];
			provenance: ClaudeProvenance;
			identity: ClaudeExecutableIdentity;
			qualification: { state: 'qualified'; record: ClaudeQualificationRecord };
	  }
	| {
			ok: false;
			reason: ClaudeExecutableReason;
			/** On an unqualified platform: the check of the file that failed, if one did. */
			check?: ClaudeExecutableCheck;
			/**
			 * With `platform-unqualified`: Studio's process runs translated on other
			 * hardware, or the hardware could not be established. Nothing was run.
			 */
			host?: ClaudeHostFinding;
			executable?: ClaudeExecutableMetadata;
			qualification?: ClaudeQualificationResult;
	  };

function isUnchanged( before: ClaudeFileStat, after: ClaudeFileStat ): boolean {
	return (
		after.kind === before.kind &&
		after.size === before.size &&
		after.device === before.device &&
		after.inode === before.inode &&
		after.modified === before.modified &&
		after.changed === before.changed
	);
}

/**
 * Inspects a selected native executable on this platform: the path, format,
 * architecture and vendor signature, all before anything runs it; then its
 * version and the qualified matrix. Every result is typed and safe to show.
 */
export async function inspectClaudeExecutable(
	selectedPath: string,
	options: Partial< ClaudePlatformSeams > = {}
): Promise< ClaudeExecutableInspection > {
	const seams = defaultClaudePlatformSeams( options );
	const target = claudePlatformTarget( seams.host );
	const adapter = selectClaudePlatformAdapter( seams.host );
	if ( ! target || ! adapter )
		return {
			ok: false,
			reason: 'platform-unsupported',
			qualification: qualifyClaudeRuntime( {
				target: undefined,
				runtimeVersion: undefined,
				sdkVersion: CLAUDE_AGENT_SDK_VERSION,
			} ),
		};
	const records = CLAUDE_QUALIFICATION_MATRIX.filter( ( item ) => item.target === target );
	const platformQualified = records.some( ( item ) => item.state === 'qualified' );
	const executable: ClaudeExecutableMetadata = { selectedPath };
	const unqualifiedPlatform = () =>
		qualifyClaudeRuntime( {
			target,
			runtimeVersion: executable.version,
			sdkVersion: CLAUDE_AGENT_SDK_VERSION,
		} );
	const fail = ( check: ClaudeExecutableCheck ): ClaudeExecutableInspection =>
		platformQualified
			? { ok: false, reason: check, executable }
			: {
					ok: false,
					reason: 'platform-unqualified',
					check,
					executable,
					qualification: unqualifiedPlatform(),
			  };
	const { files } = seams;

	if ( ! adapter.isSelectablePath( selectedPath ) )
		return fail( 'absolute-native-executable-required' );
	let before: ClaudeFileStat;
	try {
		executable.executablePath = await files.realpath( selectedPath );
		before = await files.stat( executable.executablePath );
	} catch {
		return fail( 'executable-unavailable' );
	}
	if ( before.kind !== 'file' || ( adapter.requiresExecutePermission && ! before.executable ) )
		return fail( 'executable-unavailable' );
	const executablePath = executable.executablePath;
	let header: ClaudeBinaryHeader | undefined;
	try {
		header = await adapter.readBinaryHeader( ( position, length ) =>
			files.read( executablePath, position, length )
		);
	} catch {
		return fail( 'executable-unavailable' );
	}
	if ( ! header ) return fail( 'invalid-executable-format' );
	executable.format = header.format;
	executable.architectures = header.architectures;
	if ( header.libc ) executable.libc = header.libc;
	if ( ! header.architectures.includes( seams.host.arch as ClaudeArch ) )
		return fail( 'architecture-unqualified' );

	const machine = await resolveClaudeMachineTarget( seams );
	if ( ! machine.ok ) {
		const machineRecords = CLAUDE_QUALIFICATION_MATRIX.filter(
			( item ) => item.target === machine.target
		);
		const record =
			machineRecords.find( ( item ) => item.sdkVersion === CLAUDE_AGENT_SDK_VERSION ) ??
			machineRecords[ 0 ];
		return {
			ok: false,
			reason: 'platform-unqualified',
			host: machine.host,
			executable,
			qualification: {
				state: 'unqualified',
				reason: 'platform-unqualified',
				...( record ? { record } : {} ),
				supportedRuntimeVersions: [],
			},
		};
	}

	let sha256: string;
	try {
		sha256 = await files.sha256( executablePath );
		if ( ! isUnchanged( before, await files.stat( executablePath ) ) )
			return fail( 'executable-changed' );
	} catch {
		return fail( 'executable-unavailable' );
	}
	executable.identity = {
		path: executablePath,
		size: before.size,
		device: before.device,
		inode: before.inode,
		modified: before.modified,
		changed: before.changed,
		sha256,
	};
	const env = buildClaudeEnvironment( seams.env, seams.host.platform ).env;
	const verification = await adapter.verifyBinary(
		{ executablePath, sha256, header, records, env },
		seams
	);
	if ( ! verification.ok ) return fail( verification.reason );
	executable.provenance = verification.provenance;

	try {
		const { stdout } = await seams.run( executablePath, [ '--version' ], {
			env,
			timeout: 10000,
			windowsHide: true,
			maxBuffer: 4096,
		} );
		executable.version = /^(\d+\.\d+\.\d+)(?:\s|$)/.exec( stdout.trim() )?.[ 1 ];
	} catch {
		// Reported below as unreadable.
	}
	try {
		if ( ! isUnchanged( before, await files.stat( executablePath ) ) )
			return fail( 'executable-changed' );
	} catch {
		return fail( 'executable-changed' );
	}
	if ( ! executable.version ) return fail( 'version-unreadable' );
	const qualification = qualifyClaudeRuntime( {
		target,
		runtimeVersion: executable.version,
		sdkVersion: CLAUDE_AGENT_SDK_VERSION,
	} );
	if ( qualification.state !== 'qualified' )
		return { ok: false, reason: qualification.reason, executable, qualification };
	const manifestVersion = verification.provenance.manifestRuntimeVersion;
	if ( manifestVersion && manifestVersion !== executable.version )
		return fail( 'signature-invalid' );
	return {
		ok: true,
		executablePath,
		version: executable.version,
		platform: seams.host.platform,
		architecture: seams.host.arch,
		target,
		format: header.format,
		architectures: header.architectures,
		...( header.libc ? { libc: header.libc } : {} ),
		provenance: verification.provenance,
		identity: executable.identity,
		qualification,
	};
}
