import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { isManifestVersion } from './acceptance-evidence';
import type { EvalRunFacts } from './eval-summary';

/**
 * What an eval case's summary records about the run that made it: the source
 * revision and whether the working tree has changes, read as the acceptance
 * runners read them, with `git rev-parse HEAD` and `git status --porcelain`
 * (fixed arguments, never a shell); the platform; Node's version and npm's,
 * from the user agent `npm run` sets (no command); the CLI's version and a
 * hash of the script that runs. A value a manifest can't hold is null.
 * Development only, for the eval runner.
 */
export function liveEvalRunFacts( cwd: string = import.meta.dirname ): EvalRunFacts {
	const git = ( args: string[] ) => {
		const result = spawnSync( 'git', args, {
			cwd,
			encoding: 'utf8',
			windowsHide: true,
			timeout: 15_000,
		} );
		return result.status === 0 ? result.stdout.trim() : null;
	};
	const sha = git( [ 'rev-parse', 'HEAD' ] );
	const status = sha ? git( [ 'status', '--porcelain' ] ) : null;
	const npm = /^npm\/(\S+)/.exec( process.env.npm_config_user_agent ?? '' )?.[ 1 ] ?? null;
	const release = os.release();
	const script = process.argv[ 1 ];
	let buildId: string | null = null;
	try {
		buildId =
			script && script.endsWith( '.mjs' )
				? createHash( 'sha256' ).update( fs.readFileSync( script ) ).digest( 'hex' ).slice( 0, 12 )
				: null;
	} catch {
		buildId = null;
	}
	return {
		source: {
			sha: sha && /^[0-9a-f]{40}$/.test( sha ) ? sha : null,
			dirty: status === null ? null : status.length > 0,
		},
		platform: {
			os: process.platform,
			release: isManifestVersion( release ) ? release : null,
			arch: process.arch,
		},
		runtime: {
			node: process.versions.node,
			npm: npm && isManifestVersion( npm ) ? npm : null,
		},
		build: {
			cliVersion:
				typeof __STUDIO_CLI_VERSION__ === 'string' && isManifestVersion( __STUDIO_CLI_VERSION__ )
					? __STUDIO_CLI_VERSION__
					: '0.0.0',
			buildId,
		},
	};
}
