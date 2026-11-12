import { spawn } from 'child_process';

// Windows: a fixed PowerShell command that reads the address from its
// environment, so nothing in an address is ever run as PowerShell code.
const WINDOWS_ADDRESS_VARIABLE = 'STUDIO_OPEN_URL';

export async function openBrowser( url: string ): Promise< void > {
	const platform = process.platform;
	let cmd: string;
	let args: string[];
	let env: NodeJS.ProcessEnv | undefined;

	switch ( platform ) {
		case 'darwin':
			cmd = 'open';
			args = [ url ];
			break;
		case 'win32':
			cmd = 'PowerShell';
			args = [
				'-NoProfile',
				'-NonInteractive',
				'-ExecutionPolicy',
				'Bypass',
				'-Command',
				`Start-Process -FilePath $env:${ WINDOWS_ADDRESS_VARIABLE }`,
			];
			env = { ...process.env, [ WINDOWS_ADDRESS_VARIABLE ]: url };
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
