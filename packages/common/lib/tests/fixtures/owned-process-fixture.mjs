// Test processes for owned-process and the native lifecycle tests. Every role
// carries the caller's marker in its arguments, announces itself with a
// `ready` line and exits on its own once its lifetime ends, so nothing it
// starts can outlive a crashed test by more than that.
//
//   leaf  <marker> <lifetime> [stubborn]   prints `ready <pid> <ppid>`; stubborn ignores SIGTERM
//   tree  <marker> <lifetime> [ignore-eof] starts a leaf through the platform shell and prints
//                                          `ready <pid> <shell pid> <leaf pid>`; exits on stdin EOF.
//                                          A `spawn` line starts another stubborn leaf (`spawned <pid>`);
//                                          a `fork` line runs a double fork (`forked <middle pid> <leaf pid>`)
//   fork  <marker> <lifetime>              starts a stubborn leaf and exits at once
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

function stubbornLeaf( detached ) {
	return spawn( process.execPath, [ script, 'leaf', marker, String( lifetime ), 'stubborn' ], {
		detached,
		stdio: 'ignore',
		windowsHide: true,
	} );
}

async function tree() {
	const shell = startLeaf( [ 'ignore', 'pipe', 'ignore' ] );
	const [ , leafPid, shellPid ] = ( await firstLine( shell.stdout ) ).split( ' ' );
	process.stdout.write( `ready ${ process.pid } ${ shellPid } ${ leafPid }\n` );
	let buffer = '';
	process.stdin.setEncoding( 'utf8' );
	process.stdin.on( 'data', async ( chunk ) => {
		buffer += chunk;
		for ( let end = buffer.indexOf( '\n' ); end >= 0; end = buffer.indexOf( '\n' ) ) {
			const line = buffer.slice( 0, end ).trim();
			buffer = buffer.slice( end + 1 );
			if ( line === 'spawn' ) process.stdout.write( `spawned ${ stubbornLeaf( false ).pid }\n` );
			if ( line === 'fork' ) {
				const middle = spawn( process.execPath, [ script, 'fork', marker, String( lifetime ) ], {
					stdio: [ 'ignore', 'pipe', 'ignore' ],
					windowsHide: true,
				} );
				process.stdout.write( `${ await firstLine( middle.stdout ) }\n` );
			}
		}
	} );
	process.stdin.on( 'end', () => {
		if ( option !== 'ignore-eof' ) process.exit( 0 );
	} );
}

// A double fork: starts a leaf and exits at once, leaving it without a parent.
// On Windows the leaf is detached, so it is not in this process's own job.
function fork() {
	const leaf = stubbornLeaf( process.platform === 'win32' );
	process.stdout.write( `forked ${ process.pid } ${ leaf.pid }\n`, () => process.exit( 0 ) );
}

async function owner() {
	const { prepareProcessOwner } = await import( pathToFileURL( option ).href );
	const owner = prepareProcessOwner();
	if ( ! ( await owner.prepared() ) ) process.exit( 3 );
	const owned = owner.spawn(
		process.execPath,
		[ script, 'tree', marker, String( lifetime ), 'ignore-eof' ],
		{
			env: process.env,
			supervise: true,
		}
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
} else if ( role === 'fork' ) {
	fork();
} else if ( role === 'owner' ) {
	owner().catch( () => process.exit( 1 ) );
} else {
	process.exit( 2 );
}
