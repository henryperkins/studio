import os from 'node:os';
import { __ } from '@wordpress/i18n';
import {
	acceptanceStartsNewRun,
	applyAcceptanceIsolation,
	readAcceptanceArgument,
} from './acceptance-isolation';

// Development only. The run's Studio profile, process manager and sites are
// set before any application module loads: some of them read their paths from
// the environment once, when first imported. An unacceptable run directory
// leaves the environment as it was, and the runner refuses it.
const argv = process.argv.slice( 2 );
applyAcceptanceIsolation( process.env, {
	runDir: readAcceptanceArgument( argv, '--run-dir' ),
	mustBeNew: acceptanceStartsNewRun( readAcceptanceArgument( argv, '--scenario' ) ),
	home: os.homedir(),
} );

void ( async () => {
	const { createLiveChatGptAcceptanceDependencies, runChatGptAcceptance } = await import(
		'./chatgpt-acceptance'
	);
	return runChatGptAcceptance( argv, createLiveChatGptAcceptanceDependencies() );
} )().then(
	// Watchers and handles the app modules keep open would otherwise hold the process.
	( code ) => process.exit( code ),
	() => {
		process.stderr.write( `${ __( 'The ChatGPT acceptance runner couldn’t start.' ) }\n` );
		process.exit( 1 );
	}
);
