import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A provider-qualified eval case's own process manager, so the sites it runs
 * never run under the owner's daemon. Development only, for the eval runner.
 * Imports Node built-ins only: the entry applies it before any application
 * module loads, since the CLI reads its process manager home once, when
 * first imported. A case on the default path keeps the daemon it always had.
 */

const CASE_DAEMON_PREFIX = 'studio-eval-daemon-';

/** Whether the run names a provider, in the environment or in the case's `provider` var. */
export function namesEvalProvider( argv: readonly string[], env: NodeJS.ProcessEnv ): boolean {
	if ( env.STUDIO_EVAL_PROVIDER?.trim() ) {
		return true;
	}
	let vars: unknown;
	try {
		vars = JSON.parse( argv[ 4 ] ?? '' )?.vars;
	} catch {
		return false;
	}
	const provider = ( vars as { provider?: unknown } | null | undefined )?.provider;
	return typeof provider === 'string' && provider.trim() !== '';
}

/**
 * For a run that names a provider: a new process manager home in the system's
 * temporary folder, set as `STUDIO_PROCESS_MANAGER_HOME`. Returns it, or null
 * (and changes nothing) for a run on the default path.
 */
export function isolateCaseProcessManager(
	argv: readonly string[],
	env: NodeJS.ProcessEnv,
	tmpdir: string = os.tmpdir()
): string | null {
	if ( ! namesEvalProvider( argv, env ) ) {
		return null;
	}
	const home = fs.realpathSync( fs.mkdtempSync( path.join( tmpdir, CASE_DAEMON_PREFIX ) ) );
	env.STUDIO_PROCESS_MANAGER_HOME = home;
	return home;
}

const sameFolder = ( a: string, b: string ) => path.relative( a, b ) === '';

/** The process manager home `isolateCaseProcessManager` made for this case, if it made one. */
export function caseProcessManagerHome(
	env: NodeJS.ProcessEnv,
	tmpdir: string = os.tmpdir()
): string | null {
	const home = env.STUDIO_PROCESS_MANAGER_HOME;
	if ( ! home || ! path.basename( home ).startsWith( CASE_DAEMON_PREFIX ) ) {
		return null;
	}
	let realTmpdir = tmpdir;
	try {
		realTmpdir = fs.realpathSync( tmpdir );
	} catch {
		// Compared as named.
	}
	const parent = path.dirname( home );
	return sameFolder( parent, tmpdir ) || sameFolder( parent, realTmpdir ) ? home : null;
}

export interface StopCaseProcessManager {
	/** The case's own home, from `caseProcessManagerHome`, or null. */
	home: string | null;
	/** The home this process's daemon client was loaded with. */
	processManagerHome: string;
	/** Ends that daemon and the sites it runs; throws when none is running. */
	kill(): Promise< void >;
	disconnect(): Promise< void >;
	warn( what: string, error?: unknown ): void;
}

/**
 * Ends the case's own process manager, with every site it still runs, and
 * removes its home. Only ever the case's own: a daemon client loaded with any
 * other home is left alone.
 */
export async function stopCaseProcessManager( {
	home,
	processManagerHome,
	kill,
	disconnect,
	warn,
}: StopCaseProcessManager ): Promise< 'stopped' | 'not-own' | 'none' > {
	if ( ! home ) {
		return 'none';
	}
	if ( ! sameFolder( home, processManagerHome ) ) {
		warn( 'the case’s process manager was not the one this process uses, so it was left running' );
		return 'not-own';
	}
	try {
		await kill();
	} catch {
		// No daemon was running for the case.
	}
	await disconnect().catch( () => undefined );
	try {
		fs.rmSync( home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 } );
	} catch ( error ) {
		warn( `could not remove the case folder ${ path.basename( home ) }`, error );
	}
	return 'stopped';
}
