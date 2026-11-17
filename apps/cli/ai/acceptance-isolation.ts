import fs from 'node:fs';
import path from 'node:path';

/**
 * Where a development-only acceptance run keeps everything it touches: one
 * absolute run directory holding its own Studio profile, process manager
 * home, sites and request observations. Imports Node built-ins only, so an
 * entry can apply it before any application module reads the environment.
 */

export interface AcceptanceRunPaths {
	runDir: string;
	/** `DEV_CONFIG_DIR`: the run's own Studio profile. */
	profileDir: string;
	/** `STUDIO_PROCESS_MANAGER_HOME`: the run's own process manager. */
	daemonDir: string;
	/** `E2E_SITES_ROOT`: where the run's disposable sites live. */
	sitesDir: string;
	/** `E2E_APP_DATA_PATH`: the platform app-data folder the CLI would otherwise read. */
	appDataDir: string;
	/** Per-turn request observations, read back into bounded counts. */
	observerDir: string;
	/** WP-CLI's global config, cache and packages, instead of `~/.wp-cli`. */
	wpCliDir: string;
}

export type AcceptanceIsolationProblem =
	| 'run-dir-missing'
	| 'run-dir-relative'
	| 'run-dir-not-empty'
	| 'run-dir-not-found'
	| 'run-dir-in-studio-profile'
	| 'run-dir-folder-outside';

export type AcceptanceRunDirectoryCheck =
	| { ok: true; paths: AcceptanceRunPaths }
	| { ok: false; problem: AcceptanceIsolationProblem };

/** Whether a scenario starts a run, in a new or empty directory, rather than continuing one. */
export function acceptanceStartsNewRun( scenario: string | undefined ): boolean {
	return scenario === 'saved' || scenario === 'provision';
}

/** The value of `--name value` or `--name=value`, without parsing anything else. */
export function readAcceptanceArgument(
	argv: readonly string[],
	name: string
): string | undefined {
	for ( let index = 0; index < argv.length; index++ ) {
		const argument = argv[ index ];
		if ( argument === name ) {
			const value = argv[ index + 1 ];
			return value === undefined || value.startsWith( '--' ) ? undefined : value;
		}
		if ( argument.startsWith( `${ name }=` ) ) {
			return argument.slice( name.length + 1 );
		}
	}
	return undefined;
}

export function acceptanceRunPaths( runDir: string ): AcceptanceRunPaths {
	return {
		runDir,
		profileDir: path.join( runDir, 'profile' ),
		daemonDir: path.join( runDir, 'daemon' ),
		sitesDir: path.join( runDir, 'sites' ),
		appDataDir: path.join( runDir, 'appdata' ),
		observerDir: path.join( runDir, 'observer' ),
		wpCliDir: path.join( runDir, 'wp-cli' ),
	};
}

const comparable = ( value: string ) => {
	const resolved = path.resolve( value );
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** Whether `inner` is `outer` or inside it. */
function isWithin( inner: string, outer: string ): boolean {
	const relative = path.relative( comparable( outer ), comparable( inner ) );
	return relative === '' || ( ! relative.startsWith( '..' ) && ! path.isAbsolute( relative ) );
}

const realStudioProfile = ( home: string ) => path.join( home, '.studio' );

/**
 * The path with every link resolved as far as it exists, and the rest as
 * named, so a directory a run would create is placed where it would really be.
 */
const resolvedPath = ( value: string ) => {
	const missing: string[] = [];
	for ( let current = path.resolve( value ); ; current = path.dirname( current ) ) {
		try {
			return path.join( fs.realpathSync.native( current ), ...missing );
		} catch {
			if ( path.dirname( current ) === current ) {
				return path.resolve( value );
			}
			missing.unshift( path.basename( current ) );
		}
	}
};

/** Whether `inner` is in the user's Studio profile, as named or once links resolve. */
function isInStudioProfile( inner: string, home: string ): boolean {
	const studio = realStudioProfile( home );
	const resolved = resolvedPath( inner );
	return [ studio, resolvedPath( studio ) ].some(
		( outer ) => isWithin( inner, outer ) || isWithin( resolved, outer )
	);
}

/**
 * Whether a folder of the run, where it exists at all, resolves strictly
 * inside the run directory's real path: a link there could point the run, and
 * the vault key item its profile names, at another profile or process manager.
 */
function staysInRun( folder: string, realRunDir: string ): boolean {
	try {
		fs.lstatSync( folder );
	} catch ( error ) {
		return ( error as NodeJS.ErrnoException ).code === 'ENOENT';
	}
	let real: string;
	try {
		real = fs.realpathSync.native( folder );
	} catch {
		// A link that leads nowhere.
		return false;
	}
	return isWithin( real, realRunDir ) && comparable( real ) !== comparable( realRunDir );
}

/**
 * Checks a run directory without creating it: absolute, outside the user's
 * Studio profile (also once links resolve), and new or empty for a run that
 * starts one (`mustBeNew`), or existing for a run that continues one, with
 * every folder of it that exists really inside it.
 */
export function checkAcceptanceRunDirectory(
	runDir: string | undefined,
	{ mustBeNew, home }: { mustBeNew: boolean; home: string }
): AcceptanceRunDirectoryCheck {
	if ( ! runDir ) {
		return { ok: false, problem: 'run-dir-missing' };
	}
	if ( ! path.isAbsolute( runDir ) ) {
		return { ok: false, problem: 'run-dir-relative' };
	}
	if ( isInStudioProfile( runDir, home ) ) {
		return { ok: false, problem: 'run-dir-in-studio-profile' };
	}
	let entries: string[] | null;
	try {
		entries = fs.readdirSync( runDir );
	} catch ( error ) {
		if ( ( error as NodeJS.ErrnoException ).code !== 'ENOENT' ) {
			throw error;
		}
		entries = null;
	}
	if ( mustBeNew && entries && entries.length > 0 ) {
		return { ok: false, problem: 'run-dir-not-empty' };
	}
	if ( ! mustBeNew && ! entries ) {
		return { ok: false, problem: 'run-dir-not-found' };
	}
	const paths = acceptanceRunPaths( runDir );
	if ( entries && entries.length > 0 ) {
		const realRunDir = fs.realpathSync.native( runDir );
		const { runDir: _run, ...folders } = paths;
		if ( ! Object.values( folders ).every( ( folder ) => staysInRun( folder, realRunDir ) ) ) {
			return { ok: false, problem: 'run-dir-folder-outside' };
		}
	}
	return { ok: true, paths };
}

/**
 * The environment that keeps a run inside its directory. `E2E` arms every
 * `E2E_*` path the Studio path helpers read, so each of them is set here.
 * WP-CLI, which the CLI runs with this environment, would otherwise read
 * `~/.wp-cli/config.yml` and `~/.wp-cli/packages` and write `~/.wp-cli/cache`;
 * the home directory itself stays as it is for the keychain and the browser.
 */
function acceptanceIsolationEnvironment( paths: AcceptanceRunPaths ): Record< string, string > {
	return {
		DEV_CONFIG_DIR: paths.profileDir,
		STUDIO_PROCESS_MANAGER_HOME: paths.daemonDir,
		// Also keeps telemetry and Tracks quiet, as in the eval runner.
		E2E: '1',
		E2E_SITES_ROOT: paths.sitesDir,
		E2E_APP_DATA_PATH: paths.appDataDir,
		E2E_CLI_CONFIG_PATH: paths.profileDir,
		E2E_SHARED_CONFIG_PATH: paths.profileDir,
		WP_CLI_CONFIG_PATH: path.join( paths.wpCliDir, 'config.yml' ),
		WP_CLI_CACHE_DIR: path.join( paths.wpCliDir, 'cache' ),
		WP_CLI_PACKAGES_DIR: path.join( paths.wpCliDir, 'packages' ),
	};
}

/**
 * Checks the run directory and, only when it is acceptable, drops every
 * inherited `E2E_*` variable and points the profile, process manager, sites,
 * app data and WP-CLI's own files at it. Creates nothing.
 */
export function applyAcceptanceIsolation(
	env: NodeJS.ProcessEnv,
	options: { runDir: string | undefined; mustBeNew: boolean; home: string }
): AcceptanceRunDirectoryCheck {
	const check = checkAcceptanceRunDirectory( options.runDir, options );
	if ( check.ok ) {
		for ( const name of Object.keys( env ) ) {
			if ( /^E2E_/i.test( name ) ) {
				delete env[ name ];
			}
		}
		Object.assign( env, acceptanceIsolationEnvironment( check.paths ) );
	}
	return check;
}

export type RealProfileHazard = 'legacy-process-manager-home';

/**
 * A state of the user's real Studio profile that a CLI process the run starts
 * would change, whatever its environment: CLI migration 03 renames
 * `~/.studio/pm2` to `~/.studio/daemon` under the home directory. Only reads
 * whether the two folders exist.
 */
export function findRealProfileHazard( home: string ): RealProfileHazard | null {
	const profile = realStudioProfile( home );
	return fs.existsSync( path.join( profile, 'pm2' ) ) &&
		! fs.existsSync( path.join( profile, 'daemon' ) )
		? 'legacy-process-manager-home'
		: null;
}

/**
 * The variable that would let the run reach the user's real Studio profile:
 * unset (so the default under the home directory applies) or inside it.
 */
export function findRealProfileLeak(
	env: NodeJS.ProcessEnv,
	home: string
): 'DEV_CONFIG_DIR' | 'STUDIO_PROCESS_MANAGER_HOME' | null {
	for ( const name of [ 'DEV_CONFIG_DIR', 'STUDIO_PROCESS_MANAGER_HOME' ] as const ) {
		const value = env[ name ];
		if ( ! value || isWithin( value, realStudioProfile( home ) ) ) {
			return name;
		}
	}
	return null;
}

/** Whether `inner` is inside `outer`, as the run's checks compare paths. */
export function isInsideAcceptanceRun( inner: string, outer: string ): boolean {
	return isWithin( inner, outer );
}

export type DedicatedProfileProblem =
	| 'profile-relative'
	| 'profile-not-found'
	| 'profile-in-studio-profile'
	| 'profile-is-config-directory';

/**
 * Checks, without changing anything, a dedicated test profile a development
 * runner signs in to for testing: absolute, an existing directory, neither
 * the user's Studio profile nor inside it (also once links resolve), and not
 * where this process keeps its own Studio config, which would put what a run
 * seeds into the test profile.
 */
export function checkDedicatedProfile(
	profileDir: string,
	{ home, configDirectory }: { home: string; configDirectory: string }
): DedicatedProfileProblem | null {
	if ( ! path.isAbsolute( profileDir ) ) {
		return 'profile-relative';
	}
	try {
		if ( ! fs.statSync( profileDir ).isDirectory() ) {
			return 'profile-not-found';
		}
	} catch {
		return 'profile-not-found';
	}
	const profile = resolvedPath( profileDir );
	if ( isInStudioProfile( profileDir, home ) ) {
		return 'profile-in-studio-profile';
	}
	return isWithin( resolvedPath( configDirectory ), profile ) ||
		isWithin( configDirectory, profileDir )
		? 'profile-is-config-directory'
		: null;
}
