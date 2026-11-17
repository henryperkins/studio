import { spawn } from 'child_process';

// On macOS and Windows the address travels in the opener's environment, never
// its arguments, which other local users can read (`ps` on macOS). A fixed
// command reads it there as plain text, so nothing in an address is ever run.
// On Linux xdg-open takes it only as an argument; the ChatGPT sign-in listener
// checks which user each request comes from there instead.
const ADDRESS_VARIABLE = 'STUDIO_OPEN_URL';

export async function openBrowser( url: string ): Promise< void > {
	const platform = process.platform;
	let cmd: string;
	let args: string[];
	let env: NodeJS.ProcessEnv | undefined;

	switch ( platform ) {
		case 'darwin':
			// AppleScript Language Guide, Commands Reference: `system attribute`
			// returns an environment variable's value, `open location` opens a
			// URL with the appropriate program.
			cmd = '/usr/bin/osascript';
			args = [ '-e', `open location (system attribute "${ ADDRESS_VARIABLE }")` ];
			env = { ...process.env, [ ADDRESS_VARIABLE ]: url };
			break;
		case 'win32':
			cmd = 'PowerShell';
			args = [
				'-NoProfile',
				'-NonInteractive',
				'-ExecutionPolicy',
				'Bypass',
				'-Command',
				`Start-Process -FilePath $env:${ ADDRESS_VARIABLE }`,
			];
			env = { ...process.env, [ ADDRESS_VARIABLE ]: url };
			break;
		case 'linux':
			cmd = 'xdg-open';
			args = [ url ];
			break;
		default:
			return Promise.reject( new Error( 'Unsupported platform' ) );
	}

	return new Promise( ( resolve, reject ) => {
		const child = env ? spawn( cmd, args, { env } ) : spawn( cmd, args );

		child.on( 'error', reject );

		child.on( 'exit', ( code ) => {
			if ( code === 0 ) {
				resolve();
			} else {
				reject( new Error( 'Failed to open browser' ) );
			}
		} );
	} );
}
