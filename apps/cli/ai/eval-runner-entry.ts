import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolateCaseProcessManager } from './eval-case-daemon';
import { prepareCaseProfile, removeCaseProfile } from './eval-case-profile';
import { claimPortRange } from './eval-port-range';

// Each case creates its sites in a folder of its own, so concurrent cases,
// including repeats of one case, never share or delete each other's sites.
// Set before the runner loads: the sites root is read once, when site-paths loads.
const sitesRoot = realpathSync( mkdtempSync( path.join( os.tmpdir(), 'studio-eval-sites-' ) ) );
process.env.E2E = '1';
process.env.E2E_SITES_ROOT = sitesRoot;
// A case that names a provider runs its sites under a process manager of its
// own, which the runner ends with the case; read once, when the CLI's paths load.
const processManagerHome = isolateCaseProcessManager( process.argv, process.env );
// The case's own Studio profile and site registry, for the whole process: some
// modules fix a path under the profile when they load. The runner refuses the
// case if this failed or came too late.
prepareCaseProfile( process.env );

// What the entry made, when it fails before the runner has taken it over: the
// case's profile and registry (copies of the owner's login and key), its
// sites folder and its process manager home, only if it made one (never one
// the environment already named). The messages name no path.
function removeWhatTheEntryMade(): void {
	let leftBehind = false;
	removeCaseProfile( () => {
		leftBehind = true;
	} );
	for ( const folder of [ sitesRoot, ...( processManagerHome ? [ processManagerHome ] : [] ) ] ) {
		try {
			rmSync( folder, { recursive: true, force: true, maxRetries: 5 } );
		} catch {
			leftBehind = true;
		}
	}
	process.stderr.write(
		leftBehind
			? 'The eval runner could not start, and some of what it made could not be removed.\n'
			: 'The eval runner could not start; nothing of the case was kept.\n'
	);
	process.exit( 1 );
}

// Set before the port finder loads: it reads its first port then. A port the
// user picked stays theirs.
void ( async () => {
	let runner: typeof import('./eval-runner');
	try {
		process.env.STUDIO_BASE_PORT ??= String( await claimPortRange() );
		runner = await import( './eval-runner' );
	} catch {
		removeWhatTheEntryMade();
		return;
	}
	await runner.main();
} )();
