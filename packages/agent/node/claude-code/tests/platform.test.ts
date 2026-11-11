import { readFile } from 'fs/promises';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { inspectClaudeExecutable } from '../discovery';
import {
	CLAUDE_AGENT_SDK_VERSION,
	CLAUDE_QUALIFICATION_MATRIX,
	claudePlatformTarget,
	isClaudeRuntimeSurfaceEnabled,
	qualifyClaudeRuntime,
} from '../platform';

const TARGETS = [
	'windows-x64',
	'windows-arm64',
	'macos-x64',
	'macos-arm64',
	'linux-x64',
	'linux-arm64',
] as const;

describe( 'Claude qualified runtime matrix', () => {
	it( 'has a record for each of the six targets and qualifies only SDK 0.3.319 with Windows x64 runtime 2.1.319', () => {
		expect( CLAUDE_QUALIFICATION_MATRIX.map( ( record ) => record.target ).sort() ).toEqual(
			[ ...TARGETS ].sort()
		);
		for ( const record of CLAUDE_QUALIFICATION_MATRIX ) {
			expect( record ).toMatchObject( { sdkVersion: '0.3.319', runtimeVersion: '2.1.319' } );
		}
		expect(
			CLAUDE_QUALIFICATION_MATRIX.filter( ( record ) => record.state === 'qualified' )
		).toEqual( [
			expect.objectContaining( {
				target: 'windows-x64',
				sdkVersion: '0.3.319',
				runtimeVersion: '2.1.319',
			} ),
		] );
		for ( const record of CLAUDE_QUALIFICATION_MATRIX.filter(
			( item ) => item.target !== 'windows-x64'
		) )
			expect( record ).toMatchObject( {
				state: 'unqualified',
				reason: 'no-native-qualification-run',
			} );
	} );

	it( 'cannot be changed at run time', () => {
		expect( Object.isFrozen( CLAUDE_QUALIFICATION_MATRIX ) ).toBe( true );
		for ( const record of CLAUDE_QUALIFICATION_MATRIX )
			expect( Object.isFrozen( record ) ).toBe( true );
		expect( () =>
			( CLAUDE_QUALIFICATION_MATRIX as unknown as unknown[] ).push( {
				target: 'macos-arm64',
				state: 'qualified',
			} )
		).toThrow();
	} );

	it( 'names the target by the actual OS and architecture, and nothing outside the six', () => {
		expect( claudePlatformTarget( { platform: 'win32', arch: 'x64' } ) ).toBe( 'windows-x64' );
		expect( claudePlatformTarget( { platform: 'win32', arch: 'arm64' } ) ).toBe( 'windows-arm64' );
		expect( claudePlatformTarget( { platform: 'darwin', arch: 'x64' } ) ).toBe( 'macos-x64' );
		expect( claudePlatformTarget( { platform: 'darwin', arch: 'arm64' } ) ).toBe( 'macos-arm64' );
		expect( claudePlatformTarget( { platform: 'linux', arch: 'x64' } ) ).toBe( 'linux-x64' );
		expect( claudePlatformTarget( { platform: 'linux', arch: 'arm64' } ) ).toBe( 'linux-arm64' );
		for ( const host of [
			{ platform: 'win32', arch: 'ia32' },
			{ platform: 'linux', arch: 'arm' },
			{ platform: 'freebsd', arch: 'x64' },
			{ platform: 'aix', arch: 'ppc64' },
		] )
			expect( claudePlatformTarget( host ) ).toBeUndefined();
	} );

	it( 'answers each SDK/runtime/platform question with a typed reason', () => {
		const sdkVersion = '0.3.319';
		expect(
			qualifyClaudeRuntime( { target: 'windows-x64', runtimeVersion: '2.1.319', sdkVersion } )
		).toMatchObject( {
			state: 'qualified',
			record: { target: 'windows-x64', runtimeVersion: '2.1.319' },
		} );
		for ( const runtimeVersion of [ '2.1.318', '2.1.320', '2.2.0', undefined ] )
			expect(
				qualifyClaudeRuntime( { target: 'windows-x64', runtimeVersion, sdkVersion } )
			).toEqual( {
				state: 'unqualified',
				reason: 'version-unqualified',
				supportedRuntimeVersions: [ '2.1.319' ],
			} );
		expect(
			qualifyClaudeRuntime( {
				target: 'windows-x64',
				runtimeVersion: '2.1.319',
				sdkVersion: '0.3.320',
			} )
		).toEqual( {
			state: 'unqualified',
			reason: 'sdk-unqualified',
			supportedRuntimeVersions: [ '2.1.319' ],
		} );
		for ( const target of TARGETS.filter( ( item ) => item !== 'windows-x64' ) )
			expect( qualifyClaudeRuntime( { target, runtimeVersion: '2.1.319', sdkVersion } ) ).toEqual( {
				state: 'unqualified',
				reason: 'platform-unqualified',
				record: expect.objectContaining( {
					target,
					state: 'unqualified',
					reason: 'no-native-qualification-run',
				} ),
				supportedRuntimeVersions: [],
			} );
		expect(
			qualifyClaudeRuntime( { target: undefined, runtimeVersion: '2.1.319', sdkVersion } )
		).toEqual( {
			state: 'unqualified',
			reason: 'platform-unsupported',
			supportedRuntimeVersions: [],
		} );
	} );

	it( 'pins the Agent SDK version Studio installs', async () => {
		const read = async ( file: string ) =>
			JSON.parse( await readFile( path.resolve( file ), 'utf8' ) ) as {
				version?: string;
				dependencies?: Record< string, string >;
			};
		expect(
			( await read( 'node_modules/@anthropic-ai/claude-agent-sdk/package.json' ) ).version
		).toBe( CLAUDE_AGENT_SDK_VERSION );
		expect(
			( await read( 'packages/agent/package.json' ) ).dependencies?.[
				'@anthropic-ai/claude-agent-sdk'
			]
		).toBe( CLAUDE_AGENT_SDK_VERSION );
	} );
} );

describe( 'Claude platform gates', () => {
	const flag = { STUDIO_EXPERIMENTAL_CLAUDE_CODE: '1' };

	it( 'offers the experimental surface on every target in the matrix, and only with the flag', () => {
		for ( const host of [
			{ platform: 'win32', arch: 'x64' },
			{ platform: 'win32', arch: 'arm64' },
			{ platform: 'darwin', arch: 'x64' },
			{ platform: 'darwin', arch: 'arm64' },
			{ platform: 'linux', arch: 'x64' },
			{ platform: 'linux', arch: 'arm64' },
		] ) {
			expect( isClaudeRuntimeSurfaceEnabled( host, flag ) ).toBe( true );
			expect( isClaudeRuntimeSurfaceEnabled( host, {} ) ).toBe( false );
			expect(
				isClaudeRuntimeSurfaceEnabled( host, { STUDIO_EXPERIMENTAL_CLAUDE_CODE: 'true' } )
			).toBe( false );
		}
		expect( isClaudeRuntimeSurfaceEnabled( { platform: 'freebsd', arch: 'x64' }, flag ) ).toBe(
			false
		);
		expect( isClaudeRuntimeSurfaceEnabled( { platform: 'win32', arch: 'ia32' }, flag ) ).toBe(
			false
		);
	} );

	it( 'refuses an unqualified or unsupported host with a typed reason before running anything', async () => {
		for ( const host of [
			{ platform: 'win32', arch: 'arm64' },
			{ platform: 'darwin', arch: 'x64' },
			{ platform: 'darwin', arch: 'arm64' },
			{ platform: 'linux', arch: 'x64' },
			{ platform: 'linux', arch: 'arm64' },
		] )
			await expect(
				inspectClaudeExecutable( '/nonexistent/claude', { host } )
			).resolves.toMatchObject( {
				ok: false,
				reason: 'platform-unqualified',
				qualification: { state: 'unqualified', reason: 'platform-unqualified' },
			} );
		await expect(
			inspectClaudeExecutable( '/nonexistent/claude', {
				host: { platform: 'freebsd', arch: 'x64' },
			} )
		).resolves.toMatchObject( { ok: false, reason: 'platform-unsupported' } );
	} );
} );
