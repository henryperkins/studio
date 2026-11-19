import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptanceRunPaths } from '../acceptance-isolation';
import {
	acceptanceConnection,
	cleanupClaudeAcceptanceSite,
	runClaudeAcceptance,
} from '../claude-acceptance';
import type { ClaudeRuntimeState } from '@studio/agent/protocol/claude-code';

let directory: string;
let executable: string;
let config: string;
let site: string;
beforeEach( () => {
	directory = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-claude-acceptance-test-' ) );
	executable = path.join( directory, 'native' );
	config = path.join( directory, 'config' );
	site = path.join( directory, 'sites', 'claude-acceptance' );
	fs.writeFileSync( executable, '' );
	fs.mkdirSync( config );
	fs.mkdirSync( site, { recursive: true } );
} );
afterEach( () => {
	fs.rmSync( directory, { recursive: true, force: true } );
	vi.restoreAllMocks();
} );

const state = (): ClaudeRuntimeState => ( {
	enabled: true,
	connections: [
		{
			id: 'fixture',
			revision: 1,
			executablePath: executable,
			configDirectory: config,
			version: '2.1.319',
			supportedVersions: [ '2.1.319' ],
			authMethod: 'claude.ai',
			blockers: [],
			findings: [],
		},
	],
} );

describe( 'Claude tool workflow acceptance', () => {
	it( 'requires live opt-in before creating files or starting a CLI', async () => {
		const paths = acceptanceRunPaths( path.join( directory, 'unclaimed' ) );
		vi.spyOn( console, 'error' ).mockImplementation( () => {} );
		expect( await runClaudeAcceptance( [], paths, executable, new AbortController().signal ) ).toBe(
			1
		);
		expect( fs.existsSync( paths.runDir ) ).toBe( false );
	} );
	it( 'requires the exact executable, native config, subscription and qualified version', () => {
		expect( acceptanceConnection( state(), executable, config ) ).toEqual( {
			connectionId: 'fixture',
			revision: 1,
		} );
		for ( const patch of [
			{ authMethod: 'api_key' },
			{ blockers: [ 'billing-unknown' ] },
			{ version: '2.1.320' },
			{ revision: undefined },
			{ configDirectory: directory },
			{ executablePath: config },
		] ) {
			const status = state();
			Object.assign( status.connections[ 0 ], patch );
			expect( () => acceptanceConnection( status, executable, config ) ).toThrow();
		}
	} );
	it( 'stops and removes only the allocated site and rechecks the registration', async () => {
		const registration = JSON.stringify( [
			{ id: 'fixture', name: 'Claude Acceptance', path: site },
		] );
		const cli = vi
			.fn< ( args: string[] ) => Promise< string > >()
			.mockResolvedValueOnce( registration )
			.mockResolvedValueOnce( '' )
			.mockResolvedValueOnce( '' )
			.mockResolvedValueOnce( '[]' )
			.mockResolvedValueOnce( '' );
		await cleanupClaudeAcceptanceSite( cli, directory, site );
		expect( cli.mock.calls.map( ( [ args ] ) => args ) ).toEqual( [
			[ 'site', 'list', '--format', 'json' ],
			[ 'site', 'stop', '--path', site ],
			[ 'site', 'delete', site, '--no-files' ],
			[ 'site', 'list', '--format', 'json' ],
			[ 'site', 'stop', '--all' ],
		] );
		expect( fs.existsSync( site ) ).toBe( false );
		expect( fs.existsSync( executable ) ).toBe( true );
	} );
	it( 'cleans a partial create that never registered its site', async () => {
		const cli = vi.fn().mockResolvedValue( '[]' );
		await cleanupClaudeAcceptanceSite( cli, directory, site );
		expect( cli.mock.calls ).toHaveLength( 2 );
		expect( fs.existsSync( site ) ).toBe( false );
	} );
	it( 'preserves a site and its files when its registered identity differs', async () => {
		const cli = vi
			.fn()
			.mockResolvedValue(
				JSON.stringify( [ { id: 'other', name: 'Claude Acceptance', path: config } ] )
			);
		await expect( cleanupClaudeAcceptanceSite( cli, directory, site ) ).rejects.toThrow(
			'unexpected-site'
		);
		expect( cli ).toHaveBeenCalledTimes( 1 );
		expect( fs.existsSync( site ) ).toBe( true );
	} );
} );
