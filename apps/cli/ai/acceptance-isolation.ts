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
	/** Per-turn request observations, read back into bounded counts. */
	observerDir: string;
}

export type AcceptanceIsolationProblem =
	| 'run-dir-missing'
	| 'run-dir-relative'
	| 'run-dir-not-empty'
	| 'run-dir-not-found'
	| 'run-dir-in-studio-profile';

export type AcceptanceRunDirectoryCheck =
	| { ok: true; paths: AcceptanceRunPaths }
	| { ok: false; problem: AcceptanceIsolationProblem };

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
		observerDir: path.join( runDir, 'observer' ),
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
 * Checks a run directory without creating it: absolute, outside the user's
 * Studio profile, and new or empty for a run that starts one (`mustBeNew`), or
 * existing for a run that continues one.
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
	if ( isWithin( runDir, realStudioProfile( home ) ) ) {
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
	return { ok: true, paths: acceptanceRunPaths( runDir ) };
}

/** The environment that keeps a run inside its directory. */
function acceptanceIsolationEnvironment( paths: AcceptanceRunPaths ): Record< string, string > {
	return {
		DEV_CONFIG_DIR: paths.profileDir,
		STUDIO_PROCESS_MANAGER_HOME: paths.daemonDir,
		// Also keeps telemetry and Tracks quiet, as in the eval runner.
		E2E: '1',
		E2E_SITES_ROOT: paths.sitesDir,
	};
}

/**
 * Checks the run directory and, only when it is acceptable, points the
 * profile, process manager and sites at it. Creates nothing.
 */
export function applyAcceptanceIsolation(
	env: NodeJS.ProcessEnv,
	options: { runDir: string | undefined; mustBeNew: boolean; home: string }
): AcceptanceRunDirectoryCheck {
	const check = checkAcceptanceRunDirectory( options.runDir, options );
	if ( check.ok ) {
		Object.assign( env, acceptanceIsolationEnvironment( check.paths ) );
	}
	return check;
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
