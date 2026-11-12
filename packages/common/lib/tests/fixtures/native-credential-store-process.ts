import { createOsCredentialStore } from '@studio/common/lib/os-credential-store';
import { nativeTestIdentityForRun } from '@studio/common/lib/tests/utils/native-credential-store';

/**
 * A second process for the opt-in native keychain test, run from the sources
 * by bare Node: `node native-credential-store-process.ts <run id> <account>
 * <read|write>`. The value to compare or to write comes on stdin, never on the
 * command line. It touches only the run's own keychain service and prints one
 * JSON line of booleans, or the name of the error that stopped it: never a
 * secret.
 */
const [ runId, account, operation ] = process.argv.slice( 2 );

async function readStdin(): Promise< string > {
	let text = '';
	process.stdin.setEncoding( 'utf8' );
	for await ( const chunk of process.stdin ) {
		text += chunk;
	}
	return text;
}

async function main(): Promise< Record< string, boolean > > {
	const store = createOsCredentialStore( { service: nativeTestIdentityForRun( runId ).service } );
	const value = await readStdin();
	if ( operation === 'read' ) {
		const found = await store.get( account );
		return { found: found !== null, matches: found === value };
	}
	if ( operation === 'write' ) {
		await store.set( account, value );
		return { written: true };
	}
	throw new Error( 'Unknown operation.' );
}

main().then(
	( report ) => process.stdout.write( `${ JSON.stringify( report ) }\n` ),
	( error: unknown ) => {
		process.stdout.write(
			`${ JSON.stringify( { failed: error instanceof Error ? error.name : 'unknown' } ) }\n`
		);
		process.exitCode = 1;
	}
);
