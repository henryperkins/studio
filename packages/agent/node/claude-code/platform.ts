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
