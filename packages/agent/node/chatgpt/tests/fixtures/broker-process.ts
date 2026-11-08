import fs from 'node:fs';
import readline from 'node:readline';

/**
 * One Studio process for the cross-process tests, run from the sources by bare
 * Node: `node broker-process.ts <command> <keychain file> <token service URL> [registration id]`.
 * The workspace links resolve `@studio/*` to the TypeScript sources, whose
 * types Node strips. It reports one JSON line on stdout.
 */
const [ command, keychainFile, serviceUrl, registrationId ] = process.argv.slice( 2 );

const lines = readline.createInterface( { input: process.stdin } );
const nextLine = () => new Promise< string >( ( resolve ) => lines.once( 'line', resolve ) );

function finish( result: unknown ): void {
	process.stdout.write( `${ JSON.stringify( result ) }\n`, () => process.exit( 0 ) );
}

async function report( task: () => Promise< unknown > ): Promise< void > {
	try {
		finish( { ok: true, value: await task() } );
	} catch ( error ) {
		finish( { ok: false, code: ( error as { code?: unknown } ).code ?? null } );
	}
}

async function main(): Promise< void > {
	if ( command === 'crash-before-vault-rename' ) {
		// The app is killed after a record's temp file is written and before it
		// replaces the record. Patched before the vault's file module loads.
		const rename = fs.rename;
		Object.assign( fs, {
			rename: ( from: fs.PathLike, to: fs.PathLike, callback: fs.NoParamCallback ) => {
				if ( String( to ).endsWith( '.vault' ) ) {
					process.kill( process.pid, 'SIGKILL' );
				}
				rename( from, to, callback );
			},
		} );
	}

	const { createChatGptCredentialBroker } = await import(
		'@studio/agent/node/chatgpt/credential-broker'
	);
	const { createFileCredentialStore } = await import( './file-credential-store.ts' );
	const { createHttpTokenClient } = await import( './http-token-client.ts' );
	const broker = createChatGptCredentialBroker( {
		credentialStore: createFileCredentialStore( keychainFile ),
		tokenClient: createHttpTokenClient( serviceUrl ),
	} );

	if ( command === 'get-access-token' ) {
		console.log( 'ready' );
		// Every process starts on the same signal.
		await nextLine();
		await report( () => broker.getAccessToken( registrationId ) );
	} else if ( command === 'crash-before-vault-rename' ) {
		const signIn = JSON.parse( await nextLine() );
		await report( () => broker.saveSignIn( signIn ) );
	} else {
		finish( { ok: false, code: 'unknown-command' } );
	}
}

void main();
