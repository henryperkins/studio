import os from 'node:os';
import path from 'node:path';
import { applyAcceptanceIsolation, readAcceptanceArgument } from './acceptance-isolation';

const argv = process.argv.slice( 2 );
const abort = new AbortController();
for ( const signal of [ 'SIGINT', 'SIGTERM', 'SIGHUP' ] as const ) {
	process.on( signal, () => abort.abort() );
}
async function main() {
	if ( ! argv.includes( '--live' ) ) {
		console.error(
			'Usage: claude-acceptance --live --run-dir <new-directory> --executable <native-path> --config-directory <signed-in-directory> --model <model> [--effort low --next-effort medium]'
		);
		return 2;
	}
	const isolated = applyAcceptanceIsolation( process.env, {
		runDir: readAcceptanceArgument( argv, '--run-dir' ),
		mustBeNew: true,
		home: os.homedir(),
	} );
	if ( ! isolated.ok ) {
		console.error( isolated.problem );
		return 2;
	}
	// Some Studio modules resolve their profile at import time.
	const { runClaudeAcceptance } = await import( './claude-acceptance' );
	return runClaudeAcceptance(
		argv,
		isolated.paths,
		path.join( import.meta.dirname, 'main.mjs' ),
		abort.signal
	);
}

void main().then(
	( code ) => process.exit( code ),
	() => {
		console.error( 'Claude acceptance could not start.' );
		process.exit( 1 );
	}
);
