import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import {
	acceptanceRunPaths,
	applyAcceptanceIsolation,
	findRealProfileHazard,
} from '../acceptance-isolation';
import { cleanupClaudeAcceptanceSite } from '../claude-acceptance';
import { createClaudeAcceptanceSite } from '../claude-acceptance-site';

const execute = promisify( execFile );

it( 'waits for an in-flight site create to exit after Stop before giving control to cleanup', async () => {
	const root = await realpath( await mkdtemp( path.join( os.tmpdir(), 'studio-c5-stop-' ) ) );
	const paths = acceptanceRunPaths( root );
	vi.stubEnv( 'DEV_CONFIG_DIR', paths.profileDir );
	try {
		for ( const wp of [
			path.join( root, 'wp-files/latest/wordpress' ),
			path.join( paths.profileDir, 'server-files/wordpress-versions/latest' ),
		] ) {
			await mkdir( path.join( wp, 'wp-includes' ), { recursive: true } );
			await writeFile( path.join( wp, 'wp-includes/version.php' ), "$wp_version = '7.0';" );
		}
		const cliPath = path.join( root, 'fixture.cjs' );
		await writeFile(
			cliPath,
			`
			const fs = require('node:fs');
			fs.writeFileSync('entered', '');
			const poll = setInterval(() => {
				if (fs.existsSync('release')) {
					clearInterval(poll);
					fs.writeFileSync('exited', '');
				}
			}, 10);
			setTimeout(() => process.exit(1), 5_000).unref();
		`
		);
		const controller = new AbortController();
		const outcome = createClaudeAcceptanceSite( {
			cliPath,
			paths,
			sitePath: path.join( paths.sitesDir, 'test' ),
			siteName: 'Test',
			signal: controller.signal,
		} ).catch( ( error: unknown ) => error );
		await vi.waitFor( () => expect( existsSync( path.join( root, 'entered' ) ) ).toBe( true ), {
			timeout: 4000,
		} );
		controller.abort();
		await writeFile( path.join( root, 'release' ), '' );
		expect( await outcome ).toBe( controller.signal.reason );
		expect( existsSync( path.join( root, 'exited' ) ) ).toBe( true );
	} finally {
		vi.unstubAllEnvs();
		await rm( root, { recursive: true, force: true } );
	}
} );

it.runIf( process.env.STUDIO_TEST_CLAUDE_FIXTURE === '1' )(
	'provisions and reads a real disposable WordPress without a provider',
	{ timeout: 300_000 },
	async () => {
		expect( findRealProfileHazard( os.homedir() ) ).toBeNull();
		const root = await realpath( await mkdtemp( path.join( os.tmpdir(), 'studio-c5-fixture-' ) ) );
		const env: NodeJS.ProcessEnv = {};
		const isolated = applyAcceptanceIsolation( env, {
			runDir: root,
			mustBeNew: true,
			home: os.homedir(),
		} );
		if ( ! isolated.ok ) throw new Error( isolated.problem );
		const { paths } = isolated;
		for ( const key of Object.keys( process.env ).filter( ( name ) => /^E2E_/i.test( name ) ) )
			vi.stubEnv( key, undefined );
		for ( const [ key, value ] of Object.entries( env ) ) vi.stubEnv( key, value );
		const cliPath = path.resolve( import.meta.dirname, '../../dist/cli/main.mjs' );
		const sitePath = path.join( paths.sitesDir, 'claude-acceptance' );
		const runCli = async ( args: string[] ) => {
			const { stdout } = await execute( process.execPath, [ cliPath, ...args ], {
				cwd: root,
				windowsHide: true,
				timeout: 120_000,
			} );
			return stdout.trim();
		};
		try {
			expect( JSON.parse( await runCli( [ 'site', 'list', '--format', 'json' ] ) ) ).toEqual( [] );
			await createClaudeAcceptanceSite( {
				cliPath,
				paths,
				sitePath,
				siteName: 'Claude Acceptance',
				signal: new AbortController().signal,
			} );
			const wp = ( ...args: string[] ) => runCli( [ 'wp', '--path', sitePath, ...args ] );
			await wp( 'option', 'add', 'studio_acceptance_read', 'LocalFixtureValue' );
			expect( await wp( 'option', 'get', 'studio_acceptance_read' ) ).toBe( 'LocalFixtureValue' );
			const id = await wp(
				'post',
				'create',
				'--post_status=draft',
				'--post_title=FixtureDraft',
				'--porcelain',
				'--meta_input={"studio_acceptance":"LocalMetaValue"}',
				'--post_content=LocalBody'
			);
			expect( id ).toMatch( /^\d+$/ );
			expect( await wp( 'post', 'meta', 'get', id, 'studio_acceptance' ) ).toBe( 'LocalMetaValue' );
		} finally {
			try {
				await cleanupClaudeAcceptanceSite( runCli, root, sitePath );
				await rm( root, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 } );
			} finally {
				vi.unstubAllEnvs();
			}
		}
	}
);
