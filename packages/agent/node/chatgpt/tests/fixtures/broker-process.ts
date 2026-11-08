import fs from 'node:fs';
import readline from 'node:readline';

/**
 * One Studio process for the cross-process tests, run from the sources by bare
 * Node: `node broker-process.ts <command> <keychain file> <token service URL> [registration id]`.
 * The workspace links resolve `@studio/*` to the TypeScript sources, whose
 * types Node strips. It reports one JSON line on stdout.
 */
const [ command, keychainFile, serviceUrl, registrationId ] = process.argv.slice( 2 );
// How long to wait for a line from the test, so a lost one fails the test rather than hanging it.
const LINE_TIMEOUT_MS = Number( process.env.STUDIO_TEST_LINE_TIMEOUT_MS ) || 20_000;

// Every line is kept from the moment it arrives, whether or not anything waits for one yet.
const received: string[] = [];
const readers: Array< ( line: string ) => void > = [];
readline.createInterface( { input: process.stdin } ).on( 'line', ( line ) => {
	const reader = readers.shift();
	if ( reader ) {
		reader( line );
	} else {
		received.push( line );
	}
} );

function nextLine(): Promise< string > {
	const line = received.shift();
	if ( line !== undefined ) {
		return Promise.resolve( line );
	}
	return new Promise( ( resolve, reject ) => {
		const reader = ( value: string ) => {
			clearTimeout( timer );
			resolve( value );
		};
		const timer = setTimeout( () => {
			readers.splice( readers.indexOf( reader ), 1 );
			reject( Object.assign( new Error( 'No line came from the test.' ), { code: 'no-line' } ) );
		}, LINE_TIMEOUT_MS );
		readers.push( reader );
	} );
}

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
	} else if ( command === 'hold-turn' ) {
		const handle = await broker.beginTurn( registrationId );
		await handle.getAccessToken();
		// A stream that runs until the turn's signal stops it, as the transport's will.
		let chunks = 0;
		const stream = setInterval( () => {
			if ( ! handle.signal.aborted ) {
				console.log( `chunk ${ ++chunks }` );
			}
		}, 20 );
		handle.signal.addEventListener( 'abort', () => {
			const reason = handle.signal.reason as { code?: unknown } | undefined;
			console.log( JSON.stringify( { aborted: reason?.code ?? null } ) );
			handle.end();
			// Whatever the stream still sends after the abort shows up before the report.
			setTimeout( () => {
				clearInterval( stream );
				finish( { ok: true, value: chunks } );
			}, 200 );
		} );
		console.log( 'streaming' );
	} else if ( command === 'echo-late-line' ) {
		// Starts reading only after the test's line has arrived.
		await new Promise( ( resolve ) => setTimeout( resolve, 300 ) );
		await report( () => nextLine() );
	} else {
		finish( { ok: false, code: 'unknown-command' } );
	}
}

main().catch( ( error: unknown ) =>
	finish( { ok: false, code: ( error as { code?: unknown } ).code ?? 'fixture-failed' } )
);
