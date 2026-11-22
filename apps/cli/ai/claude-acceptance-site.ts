import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_PHP_VERSION } from '@studio/common/constants';
import { getWordPressVersion } from '@studio/common/lib/get-wordpress-version';
import { getDefaultConfigDirectory } from '@studio/common/lib/well-known-paths';
import { getPhpBinaryPath } from 'cli/lib/dependency-management/paths';
import { isInsideAcceptanceRun } from './acceptance-isolation';
import type { AcceptanceRunPaths } from './acceptance-isolation';

const execute = promisify( execFile );

export async function createClaudeAcceptanceSite( options: {
	cliPath: string;
	paths: AcceptanceRunPaths;
	sitePath: string;
	siteName: string;
	signal: AbortSignal;
} ) {
	const { cliPath, paths, sitePath, siteName, signal } = options;
	signal.throwIfAborted();
	const cache = path.join( paths.profileDir, 'server-files', 'wordpress-versions', 'latest' );
	const bundled = path.join( path.dirname( cliPath ), 'wp-files', 'latest', 'wordpress' );
	const version = getWordPressVersion( bundled );
	const profile = await realpath( paths.profileDir );
	if (
		version === '-' ||
		getWordPressVersion( cache ) !== version ||
		! isInsideAcceptanceRun( await realpath( cache ), profile )
	)
		throw new Error( 'The isolated profile needs the bundled WordPress files.' );

	// A dev build may omit packaged PHP. The CLI migration copies only its configured
	// default PHP package from this source into the writable, per-run profile.
	const phpSource =
		process.env.STUDIO_BUNDLED_PHP_BIN_ROOT ?? path.join( getDefaultConfigDirectory(), 'php-bin' );
	const phpPath = getPhpBinaryPath( DEFAULT_PHP_VERSION );
	if ( ! isInsideAcceptanceRun( phpPath, paths.profileDir ) )
		throw new Error( 'The PHP cache must be inside the isolated Studio profile.' );
	const processOptions = { cwd: paths.runDir, windowsHide: true, timeout: 600_000 };
	// A latest-site create checks wordpress.org even with a fresh cache. Exercise the CLI's
	// offline fallback only for creation. Complete each CLI command before cleanup can begin.
	await using offlineProxy = createServer( ( socket ) => socket.destroy() );
	offlineProxy.listen( 0, '127.0.0.1' );
	await once( offlineProxy, 'listening' );
	const address = offlineProxy.address();
	if ( ! address || typeof address === 'string' ) throw new Error( 'Fixture proxy unavailable.' );
	const proxyUrl = `http://127.0.0.1:${ address.port }`;
	const local = 'localhost,127.0.0.1,::1,[::1]';
	signal.throwIfAborted();
	await execute(
		process.execPath,
		[
			'--use-env-proxy',
			cliPath,
			'site',
			'create',
			'--wp',
			'latest',
			'--path',
			sitePath,
			'--name',
			siteName,
			'--no-start',
			'--skip-browser',
			'--skip-log-details',
			'--avoid-telemetry',
		],
		{
			...processOptions,
			env: {
				...process.env,
				STUDIO_BUNDLED_PHP_BIN_ROOT: phpSource,
				HTTP_PROXY: proxyUrl,
				HTTPS_PROXY: proxyUrl,
				NO_PROXY: local,
				http_proxy: proxyUrl,
				https_proxy: proxyUrl,
				no_proxy: local,
			},
		}
	);
	signal.throwIfAborted();
	if ( getWordPressVersion( sitePath ) !== version )
		throw new Error( 'Fixture core version mismatch.' );
	if (
		! isInsideAcceptanceRun( await realpath( phpPath ), profile ) ||
		! ( await stat( phpPath ) ).isFile()
	)
		throw new Error( 'The isolated profile needs the default PHP binary.' );
	await execute(
		process.execPath,
		[
			cliPath,
			'site',
			'start',
			'--path',
			sitePath,
			'--skip-browser',
			'--skip-log-details',
			'--avoid-telemetry',
		],
		processOptions
	);
	signal.throwIfAborted();
}
