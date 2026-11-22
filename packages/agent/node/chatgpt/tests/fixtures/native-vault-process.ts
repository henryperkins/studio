import { createOsCredentialStore } from '@studio/common/lib/os-credential-store';
import { nativeTestIdentityForRun } from '@studio/common/lib/tests/utils/native-credential-store';
import { ChatGptConnectionError } from '@studio/agent/node/chatgpt/account-store';
import { createChatGptCredentialBroker } from '@studio/agent/node/chatgpt/credential-broker';

/**
 * A fresh Studio process for the opt-in native vault test, run from the
 * sources by bare Node with DEV_CONFIG_DIR set to the test's profile:
 * `node native-vault-process.ts <run id> <registration id>`. It opens the
 * registration's vault record with the key the run's own keychain service
 * holds, and compares its access token with the one on stdin. It prints one
 * JSON line, whether it matched or the error's code: never a token.
 */
const [ runId, registrationId ] = process.argv.slice( 2 );

async function readStdin(): Promise< string > {
	let text = '';
	process.stdin.setEncoding( 'utf8' );
	for await ( const chunk of process.stdin ) {
		text += chunk;
	}
	return text;
}

async function main(): Promise< Record< string, unknown > > {
	const { service } = nativeTestIdentityForRun( runId );
	const expected = await readStdin();
	const broker = createChatGptCredentialBroker( {
		// The record is fresh: nothing here may reach the token service.
		tokenClient: {
			refresh: async () => ( { ok: false, error: { kind: 'transient' } } ),
			revoke: async () => ( { ok: false, error: { kind: 'transient' } } ),
		},
		credentialStore: createOsCredentialStore( { service } ),
	} );
	return { matches: ( await broker.getAccessToken( registrationId ) ) === expected };
}

main().then(
	( report ) => process.stdout.write( `${ JSON.stringify( report ) }\n` ),
	( error: unknown ) => {
		const code = error instanceof ChatGptConnectionError ? error.code : 'unexpected-error';
		process.stdout.write( `${ JSON.stringify( { code } ) }\n` );
		process.exitCode = 1;
	}
);
