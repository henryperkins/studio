import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isManifestVersion, type ManifestRun } from './acceptance-evidence';

type RunFacts = Pick< ManifestRun, 'source' | 'platform' | 'runtime' | 'build' >;

/** This machine's platform as the manifest records it: a release it can't read is null. */
export function acceptancePlatform( release: string = os.release() ): RunFacts[ 'platform' ] {
	return {
		os: process.platform,
		release: isManifestVersion( release ) ? release : null,
		arch: process.arch,
	};
}

export async function collectLiveFacts( cliDirectory: string ): Promise< RunFacts > {
	const repositoryRoot = path.resolve( cliDirectory, '..', '..', '..', '..' );
	const run = ( command: string, args: string[], shell = false ) => {
		const result = spawnSync( command, args, {
			cwd: repositoryRoot,
			encoding: 'utf8',
			shell,
			windowsHide: true,
		} );
		return result.status === 0 ? result.stdout.trim() : null;
	};
	const sha = run( 'git', [ 'rev-parse', 'HEAD' ] );
	const status = sha ? run( 'git', [ 'status', '--porcelain' ] ) : null;
	const npm = run( 'npm --version', [], true );
	const mainScript = path.join( cliDirectory, 'main.mjs' );
	return {
		source: {
			sha: sha && /^[0-9a-f]{40}$/.test( sha ) ? sha : null,
			dirty: status === null ? null : status.length > 0,
		},
		platform: acceptancePlatform(),
		runtime: {
			node: process.versions.node,
			npm: npm && isManifestVersion( npm ) ? npm : null,
		},
		build: {
			cliVersion:
				typeof __STUDIO_CLI_VERSION__ === 'string' && isManifestVersion( __STUDIO_CLI_VERSION__ )
					? __STUDIO_CLI_VERSION__
					: '0.0.0',
			buildId: fs.existsSync( mainScript )
				? createHash( 'sha256' )
						.update( fs.readFileSync( mainScript ) )
						.digest( 'hex' )
						.slice( 0, 12 )
				: null,
		},
	};
}
