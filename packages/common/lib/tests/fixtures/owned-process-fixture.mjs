// Test processes for owned-process and the native lifecycle tests. Every role
// carries the caller's marker in its arguments, announces itself with a
// `ready` line and exits on its own once its lifetime ends, so nothing it
// starts can outlive a crashed test by more than that.
//
//   leaf  <marker> <lifetime> [stubborn]   prints `ready <pid> <ppid>`; stubborn ignores SIGTERM
//   tree  <marker> <lifetime> [ignore-eof] starts a leaf through the platform shell and prints
//                                          `ready <pid> <shell pid> <leaf pid>`; exits on stdin EOF
//   owner <marker> <lifetime> <bundle>     owns a tree through the bundled owned-process module and
//                                          reports its processes over IPC
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath( import.meta.url );
const [ role, marker, lifetimeText, option ] = process.argv.slice( 2 );
const lifetime = Number( lifetimeText ) || 45_000;
setTimeout( () => process.exit( 0 ), lifetime );
process.stdout.on( 'error', () => {} );

function firstLine( stream ) {
	return new Promise( ( resolve, reject ) => {
		let buffer = '';
		stream.setEncoding( 'utf8' );
		stream.on( 'data', ( chunk ) => {
			buffer += chunk;
			const end = buffer.indexOf( '\n' );
			if ( end >= 0 ) resolve( buffer.slice( 0, end ).trim() );
		} );
		stream.once( 'end', () => reject( new Error( 'No ready line' ) ) );
	} );
}

function startLeaf( stdio ) {
	const leaf = `"${ process.execPath }" "${ script }" leaf ${ marker } ${ lifetime } stubborn`;
	// A POSIX shell runs a lone command in place; the trailing `exit` keeps it as the leaf's parent.
	return spawn( process.platform === 'win32' ? leaf : `${ leaf }; exit`, {
		shell: true,
		stdio,
		windowsHide: true,
	} );
}

async function tree() {
	const shell = startLeaf( [ 'ignore', 'pipe', 'ignore' ] );
	const [ , leafPid, shellPid ] = ( await firstLine( shell.stdout ) ).split( ' ' );
	process.stdout.write( `ready ${ process.pid } ${ shellPid } ${ leafPid }\n` );
	process.stdin.resume();
	process.stdin.on( 'end', () => {
		if ( option !== 'ignore-eof' ) process.exit( 0 );
	} );
}

async function owner() {
	const { spawnOwnedProcess } = await import( pathToFileURL( option ).href );
	const owned = spawnOwnedProcess(
		process.execPath,
		[ script, 'tree', marker, String( lifetime ), 'ignore-eof' ],
		{ env: process.env, supervise: true }
	);
	const ready = await owned.ready();
	const [ , treePid, shellPid, leafPid ] = ( await firstLine( owned.child.stdout ) ).split( ' ' );
	// Makes the keeper look now rather than at its next poll.
	const { live } = await owned.inspect();
	process.send( {
		type: 'ready',
		ready,
		tree: Number( treePid ),
		shell: Number( shellPid ),
		leaf: Number( leafPid ),
		tracked: live.map( ( identity ) => identity.pid ),
	} );
	process.on( 'message', async ( message ) => {
		if ( message === 'shutdown' ) {
			const clean = await owned.shutdown( { graceMs: 500 } );
			process.send( { type: 'shutdown', clean }, () => process.exit( 0 ) );
		}
	} );
}

if ( role === 'leaf' ) {
	if ( option === 'stubborn' ) process.on( 'SIGTERM', () => {} );
	process.stdout.write( `ready ${ process.pid } ${ process.ppid }\n` );
} else if ( role === 'tree' ) {
	tree().catch( () => process.exit( 1 ) );
} else if ( role === 'owner' ) {
	owner().catch( () => process.exit( 1 ) );
} else {
	process.exit( 2 );
}
