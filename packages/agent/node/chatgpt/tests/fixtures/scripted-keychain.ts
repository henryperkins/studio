import {
	createOsCredentialStore,
	type CommandResult,
	type CommandRunner,
} from '@studio/common/lib/os-credential-store';

export type KeychainPlatform = 'darwin' | 'linux' | 'win32';

export const answer = ( code: number, stderr: string ): CommandResult => ( {
	code,
	stdout: '',
	stderr,
} );

// How each tool says nothing is saved under a name.
const NOTHING_SAVED: Record< KeychainPlatform, CommandResult > = {
	darwin: answer(
		44,
		'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.'
	),
	linux: answer( 1, '' ),
	win32: answer( 3, '' ),
};

/**
 * Each platform's keychain tool, keeping secrets by service and account, behind
 * the real store for that platform. While `saysNothingSaved` is set, it answers
 * every read and removal as it does when nothing is saved, though its items are
 * still there: what libsecret may answer once an unlock prompt was dismissed. A
 * write goes through, as one whose unlock prompt was accepted would, and ends
 * that.
 */
export function scriptedKeychain( platform: KeychainPlatform ) {
	const items = new Map< string, string >();
	const state = { saysNothingSaved: false };
	const calls: Array< { args: readonly string[]; input?: string } > = [];
	// The service/account name of every item written, in order.
	const writes: string[] = [];
	const ok = ( stdout = '' ): CommandResult => ( { code: 0, stdout, stderr: '' } );
	const write = ( name: string, secret: string ) => {
		writes.push( name );
		items.set( name, secret );
		state.saysNothingSaved = false;
		return ok();
	};
	const read = ( name: string ) => {
		const secret = items.get( name );
		if ( state.saysNothingSaved || secret === undefined ) {
			return NOTHING_SAVED[ platform ];
		}
		return ok( platform === 'darwin' ? `${ secret }\n` : secret );
	};
	const remove = ( name: string ) =>
		! state.saysNothingSaved && items.delete( name ) ? ok() : NOTHING_SAVED[ platform ];
	const run: CommandRunner = async ( _command, args, { input } ) => {
		calls.push( { args, input } );
		if ( platform === 'linux' ) {
			const name = `${ args[ args.indexOf( 'service' ) + 1 ] }/${
				args[ args.indexOf( 'account' ) + 1 ]
			}`;
			if ( args[ 0 ] === 'store' ) {
				return write( name, input ?? '' );
			}
			return args[ 0 ] === 'clear' ? remove( name ) : read( name );
		}
		if ( platform === 'darwin' ) {
			const added = /^add-generic-password -U -s (\S+) -a (\S+) -w (\S+)\n$/.exec( input ?? '' );
			if ( args[ 0 ] === '-i' && added ) {
				return write( `${ added[ 1 ] }/${ added[ 2 ] }`, added[ 3 ] );
			}
			const name = `${ args[ args.indexOf( '-s' ) + 1 ] }/${ args[ args.indexOf( '-a' ) + 1 ] }`;
			return args[ 0 ] === 'delete-generic-password' ? remove( name ) : read( name );
		}
		const script = Buffer.from( args[ args.length - 1 ], 'base64' ).toString( 'utf16le' );
		const named = /\('([^']+)', '([^']+)'/.exec( script );
		const name = named ? `${ named[ 1 ] }/${ named[ 2 ] }` : '';
		if ( script.includes( '[Console]::In.ReadToEnd()' ) ) {
			return write( name, input ?? '' );
		}
		return script.includes( '$vault.Remove($credential)' ) ? remove( name ) : read( name );
	};
	return { store: createOsCredentialStore( { platform, run } ), items, state, calls, writes };
}
