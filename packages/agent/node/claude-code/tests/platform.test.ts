import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { inspectClaudeExecutable } from '../discovery';
import {
	CLAUDE_AGENT_SDK_VERSION,
	CLAUDE_QUALIFICATION_MATRIX,
	claudePlatformTarget,
	claudeShellSandbox,
	defaultClaudePlatformSeams,
	executeClaudeSignIn,
	inspectClaudeManagedPolicy,
	planClaudeSignIn,
	isClaudeExecutableUnchanged,
	isClaudeRuntimeSurfaceEnabled,
	isSameClaudePath,
	probeClaudeMachineArchitecture,
	qualifyClaudeRuntime,
	resolveClaudePathKey,
	verifyClaudeExecutableIdentity,
} from '../platform';
import { linuxAdapter, readElfHeader } from '../platforms/linux';
import { readMachOHeader } from '../platforms/macos';
import {
	AUTHENTICODE_SIGNER_CHECK,
	encodedPowerShellArgs,
	readPeHeader,
	trustedPowerShellPath,
} from '../platforms/windows';
import {
	CPU_TYPE_ARM64,
	CPU_TYPE_POWERPC64,
	CPU_TYPE_X86_64,
	EM_AARCH64,
	EM_RISCV,
	EM_X86_64,
	GLIBC_ARM64,
	GLIBC_X64,
	MUSL_X64,
	elfBinary,
	exitWith,
	machOBinary,
	peBinary,
	recordingRunner,
	sha256,
	simulatedHost,
	spawnFailure,
	universalBinary,
} from './fixtures/native-binaries';
import type { ClaudeQualificationRecord } from '../platform';

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
				confirmationsRequired: expect.arrayContaining( [ 'machine-architecture-probe' ] ),
			} );
		expect(
			CLAUDE_QUALIFICATION_MATRIX.find( ( item ) => item.target === 'windows-x64' )
		).not.toHaveProperty( 'confirmationsRequired' );
	} );

	it( 'cannot be changed at run time', () => {
		expect( Object.isFrozen( CLAUDE_QUALIFICATION_MATRIX ) ).toBe( true );
		for ( const record of CLAUDE_QUALIFICATION_MATRIX ) {
			expect( Object.isFrozen( record ) ).toBe( true );
			if ( record.confirmationsRequired )
				expect( Object.isFrozen( record.confirmationsRequired ) ).toBe( true );
		}
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

	it( 'refuses an unqualified host with a typed reason and runs nothing for a missing file, and never touches a file on an unsupported host', async () => {
		for ( const host of [
			{ platform: 'win32', arch: 'arm64' },
			{ platform: 'darwin', arch: 'x64' },
			{ platform: 'darwin', arch: 'arm64' },
			{ platform: 'linux', arch: 'x64' },
			{ platform: 'linux', arch: 'arm64' },
		] ) {
			const runner = recordingRunner( () => new Error( 'unexpected' ) );
			const windows = host.platform === 'win32';
			const { seams } = simulatedHost( host, windows ? path.win32 : path.posix, {
				run: runner.run,
			} );
			await expect(
				inspectClaudeExecutable(
					windows ? 'C:\\nonexistent\\claude.exe' : '/nonexistent/claude',
					seams
				),
				host.platform
			).resolves.toMatchObject( {
				ok: false,
				reason: 'platform-unqualified',
				check: 'executable-unavailable',
				qualification: { state: 'unqualified', reason: 'platform-unqualified' },
			} );
			expect( runner.calls, `${ host.platform }-${ host.arch }` ).toEqual( [] );
		}
		const runner = recordingRunner( () => new Error( 'unexpected' ) );
		const unsupported = simulatedHost( { platform: 'freebsd', arch: 'x64' }, path.posix, {
			run: runner.run,
		} );
		const reads = denied( unsupported.fs.files, [] );
		unsupported.fs.write(
			'/usr/local/bin/claude',
			elfBinary( EM_X86_64, { interpreter: GLIBC_X64 } )
		);
		await expect(
			inspectClaudeExecutable( '/usr/local/bin/claude', {
				...unsupported.seams,
				files: reads.files,
			} )
		).resolves.toMatchObject( { ok: false, reason: 'platform-unsupported' } );
		expect( runner.calls ).toEqual( [] );
		expect( reads.contents.read ).toBe( 0 );
	} );
} );

describe( 'Claude machine architecture', () => {
	const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

	it( 'reads the Windows machine from IsWow64Process2, which names the native machine even to an emulated process', async () => {
		for ( const [ answer, expected ] of [
			[ '34404', 'x64' ],
			[ '43620', 'arm64' ],
			[ '332', undefined ],
			[ '', undefined ],
			[ '43620 ', 'arm64' ],
			[ '0x8664', undefined ],
			[ exitWith( 2 ), undefined ],
			[ spawnFailure(), undefined ],
		] as const ) {
			const runner = recordingRunner( () => answer );
			const { seams } = simulatedHost( { platform: 'win32', arch: 'x64' }, path.win32, {
				env: { SystemRoot: 'C:\\Windows', PROCESSOR_ARCHITECTURE: 'AMD64', Secret: 'x' },
				run: runner.run,
				osMachine: () => 'x86_64',
			} );
			await expect(
				probeClaudeMachineArchitecture( { ...seams, machineArchitecture: undefined } ),
				String( answer )
			).resolves.toBe( expected );
			expect( runner.calls ).toHaveLength( 1 );
			expect( runner.calls[ 0 ] ).toMatchObject( {
				file: powershell,
				env: { SystemRoot: 'C:\\Windows' },
			} );
			expect( runner.calls[ 0 ].env.Secret ).toBeUndefined();
			const script = decodedScript( runner.calls[ 0 ].args );
			expect( script ).toContain( 'IsWow64Process2' );
			expect( script ).not.toMatch( /PROCESSOR_ARCHITECTURE|GetNativeSystemInfo/ );
		}
		const { seams } = simulatedHost( { platform: 'win32', arch: 'x64' }, path.win32, {
			env: { PROCESSOR_ARCHITECTURE: 'AMD64' },
		} );
		await expect(
			probeClaudeMachineArchitecture( { ...seams, machineArchitecture: undefined } )
		).resolves.toBeUndefined();
	} );

	it( 'reads the Mac hardware from hw.optional.arm64, which Rosetta does not hide', async () => {
		for ( const [ answer, expected ] of [
			[ '1\n', 'arm64' ],
			[ '0\n', 'x64' ],
			[ exitWith( 1 ), undefined ],
			[ 'yes', undefined ],
			[ '', undefined ],
		] as const ) {
			const runner = recordingRunner( () => answer );
			const { seams } = simulatedHost( { platform: 'darwin', arch: 'x64' }, path.posix, {
				run: runner.run,
				osMachine: () => 'x86_64',
			} );
			await expect(
				probeClaudeMachineArchitecture( { ...seams, machineArchitecture: undefined } ),
				String( answer )
			).resolves.toBe( expected );
			expect( runner.calls.map( ( { file, args } ) => [ file, ...args ] ) ).toEqual( [
				[ '/usr/sbin/sysctl', '-n', 'hw.optional.arm64' ],
			] );
		}
	} );

	it( 'reads the Linux machine from uname, the only fact the kernel gives', async () => {
		for ( const [ machine, expected ] of [
			[ 'x86_64', 'x64' ],
			[ 'aarch64', 'arm64' ],
			[ 'armv7l', undefined ],
			[ '', undefined ],
		] as const ) {
			const { seams } = simulatedHost( { platform: 'linux', arch: 'x64' }, path.posix, {
				osMachine: () => machine,
			} );
			await expect(
				probeClaudeMachineArchitecture( { ...seams, machineArchitecture: undefined } ),
				machine
			).resolves.toBe( expected );
		}
		const { seams } = simulatedHost( { platform: 'linux', arch: 'x64' }, path.posix, {
			osMachine: () => {
				throw new Error( 'uname failed' );
			},
		} );
		await expect(
			probeClaudeMachineArchitecture( { ...seams, machineArchitecture: undefined } )
		).resolves.toBeUndefined();
	} );

	it( 'selects the target by the machine, and refuses a translated process or an unknown machine before running anything', async () => {
		const windows = ( arch: 'x64' | 'arm64', machine: 'x64' | 'arm64' | undefined ) => {
			const runner = recordingRunner( ( command ) =>
				command.args[ 0 ] === '--version' ? versionOutput( '2.1.319' ) : authenticodeOk
			);
			const host = simulatedHost( { platform: 'win32', arch }, path.win32, {
				env: { SystemRoot: 'C:\\Windows' },
				run: runner.run,
				machineArchitecture: async () => machine,
			} );
			host.fs.write(
				'C:\\Claude\\claude.exe',
				peBinary( { machine: arch === 'x64' ? 0x8664 : 0xaa64 } )
			);
			return { ...host, calls: runner.calls };
		};
		const native = windows( 'x64', 'x64' );
		await expect(
			inspectClaudeExecutable( 'C:\\Claude\\claude.exe', native.seams )
		).resolves.toMatchObject( { ok: true, target: 'windows-x64' } );

		const emulated = windows( 'x64', 'arm64' );
		const translated = await inspectClaudeExecutable( 'C:\\Claude\\claude.exe', emulated.seams );
		expect( translated ).toMatchObject( {
			ok: false,
			reason: 'platform-unqualified',
			host: {
				check: 'process-translated',
				processArchitecture: 'x64',
				machineArchitecture: 'arm64',
			},
			qualification: {
				state: 'unqualified',
				reason: 'platform-unqualified',
				record: { target: 'windows-arm64', reason: 'no-native-qualification-run' },
			},
		} );
		expect( emulated.calls ).toEqual( [] );

		const rosetta = simulatedHost( { platform: 'darwin', arch: 'x64' }, path.posix, {
			run: recordingRunner( () => new Error( 'unexpected' ) ).run,
			machineArchitecture: async () => 'arm64',
		} );
		rosetta.fs.write( '/Users/tester/.local/bin/claude', machOBinary( CPU_TYPE_X86_64 ) );
		await expect(
			inspectClaudeExecutable( '/Users/tester/.local/bin/claude', rosetta.seams )
		).resolves.toMatchObject( {
			ok: false,
			reason: 'platform-unqualified',
			host: {
				check: 'process-translated',
				processArchitecture: 'x64',
				machineArchitecture: 'arm64',
			},
			qualification: { record: { target: 'macos-arm64' } },
		} );

		const arm = windows( 'arm64', 'arm64' );
		const nativeArm = await inspectClaudeExecutable( 'C:\\Claude\\claude.exe', arm.seams );
		expect( nativeArm ).toMatchObject( {
			ok: false,
			reason: 'platform-unqualified',
			qualification: { record: { target: 'windows-arm64' } },
		} );
		expect( nativeArm ).not.toHaveProperty( 'host' );

		const unknown = windows( 'x64', undefined );
		const unestablished = await inspectClaudeExecutable( 'C:\\Claude\\claude.exe', unknown.seams );
		expect( unestablished ).toEqual( {
			ok: false,
			reason: 'platform-unqualified',
			host: { check: 'machine-architecture-unknown', processArchitecture: 'x64' },
			executable: expect.objectContaining( { format: 'pe', architectures: [ 'x64' ] } ),
			qualification: {
				state: 'unqualified',
				reason: 'platform-unqualified',
				supportedRuntimeVersions: [],
			},
		} );
		expect( unknown.calls ).toEqual( [] );

		const probed = recordingRunner( ( command ) =>
			decodedScript( command.args ).includes( 'IsWow64Process2' ) ? '43620' : authenticodeOk
		);
		const wired = simulatedHost( { platform: 'win32', arch: 'x64' }, path.win32, {
			env: { SystemRoot: 'C:\\Windows' },
			run: probed.run,
			machineArchitecture: undefined,
		} );
		wired.fs.write( 'C:\\Claude\\claude.exe', peBinary() );
		await expect(
			inspectClaudeExecutable( 'C:\\Claude\\claude.exe', wired.seams )
		).resolves.toMatchObject( { host: { check: 'process-translated' } } );
		expect( probed.calls ).toHaveLength( 1 );
	} );

	it.runIf( process.platform === 'win32' && process.arch === 'x64' )(
		'establishes this Windows x64 machine as x64 through the real probe',
		async () => {
			await expect( probeClaudeMachineArchitecture() ).resolves.toBe( 'x64' );
			await expect( defaultClaudePlatformSeams().machineArchitecture() ).resolves.toBe( 'x64' );
		}
	);
} );

const reader = ( bytes: Buffer ) => async ( position: number, length: number ) =>
	Buffer.from( bytes.subarray( position, position + length ) );

describe( 'Claude executable headers', () => {
	it( 'reads a PE32+ executable image and its architecture, and nothing else', async () => {
		expect( await readPeHeader( reader( peBinary( { machine: 0x8664 } ) ) ) ).toEqual( {
			format: 'pe',
			architectures: [ 'x64' ],
		} );
		expect( await readPeHeader( reader( peBinary( { machine: 0xaa64 } ) ) ) ).toEqual( {
			format: 'pe',
			architectures: [ 'arm64' ],
		} );
		expect( await readPeHeader( reader( peBinary( { machine: 0x14c } ) ) ) ).toEqual( {
			format: 'pe',
			architectures: [],
		} );
		for ( const bytes of [
			peBinary( { optionalMagic: 0x10b } ),
			peBinary( { characteristics: 0x2022 } ),
			peBinary( { characteristics: 0x0020 } ),
			peBinary( { signature: 0x4551 } ),
			peBinary().subarray( 0, 70 ),
			Buffer.from( '@echo off\r\nclaude.exe %*\r\n' ),
			elfBinary( EM_X86_64, { interpreter: GLIBC_X64 } ),
			machOBinary( CPU_TYPE_X86_64 ),
		] )
			expect( await readPeHeader( reader( bytes ) ) ).toBeUndefined();
	} );

	it( 'reads thin and universal 64-bit Mach-O architectures, and refuses other layouts', async () => {
		expect( await readMachOHeader( reader( machOBinary( CPU_TYPE_X86_64 ) ) ) ).toEqual( {
			format: 'mach-o',
			architectures: [ 'x64' ],
		} );
		expect( await readMachOHeader( reader( machOBinary( CPU_TYPE_ARM64 ) ) ) ).toEqual( {
			format: 'mach-o',
			architectures: [ 'arm64' ],
		} );
		expect(
			await readMachOHeader( reader( universalBinary( [ CPU_TYPE_X86_64, CPU_TYPE_ARM64 ] ) ) )
		).toEqual( { format: 'mach-o-universal', architectures: [ 'x64', 'arm64' ] } );
		expect(
			await readMachOHeader(
				reader( universalBinary( [ CPU_TYPE_ARM64, CPU_TYPE_X86_64 ], { wide: true } ) )
			)
		).toEqual( { format: 'mach-o-universal', architectures: [ 'arm64', 'x64' ] } );
		expect( await readMachOHeader( reader( machOBinary( CPU_TYPE_POWERPC64 ) ) ) ).toEqual( {
			format: 'mach-o',
			architectures: [],
		} );
		for ( const bytes of [
			machOBinary( CPU_TYPE_X86_64, { magic: 0xfeedface } ),
			machOBinary( CPU_TYPE_X86_64, { bigEndian: true } ),
			universalBinary( [ CPU_TYPE_X86_64 ], { count: 52 } ),
			universalBinary( [ CPU_TYPE_X86_64, CPU_TYPE_ARM64 ], { count: 3 } ),
			universalBinary( [] ),
			machOBinary( CPU_TYPE_X86_64 ).subarray( 0, 6 ),
			Buffer.from( '#!/bin/sh\nexec claude "$@"\n' ),
			peBinary(),
			elfBinary( EM_AARCH64, { interpreter: GLIBC_ARM64 } ),
		] )
			expect( await readMachOHeader( reader( bytes ) ) ).toBeUndefined();
	} );

	it( 'reads a 64-bit little-endian ELF executable, its architecture and the C library its loader names', async () => {
		expect(
			await readElfHeader( reader( elfBinary( EM_X86_64, { interpreter: GLIBC_X64 } ) ) )
		).toEqual( { format: 'elf', architectures: [ 'x64' ], libc: 'glibc' } );
		expect(
			await readElfHeader( reader( elfBinary( EM_AARCH64, { interpreter: GLIBC_ARM64 } ) ) )
		).toEqual( { format: 'elf', architectures: [ 'arm64' ], libc: 'glibc' } );
		expect(
			await readElfHeader( reader( elfBinary( EM_X86_64, { interpreter: MUSL_X64 } ) ) )
		).toEqual( { format: 'elf', architectures: [ 'x64' ], libc: 'musl' } );
		expect( await readElfHeader( reader( elfBinary( EM_X86_64, { type: 2 } ) ) ) ).toEqual( {
			format: 'elf',
			architectures: [ 'x64' ],
			libc: 'static',
		} );
		expect( await readElfHeader( reader( elfBinary( EM_RISCV ) ) ) ).toEqual( {
			format: 'elf',
			architectures: [],
			libc: 'static',
		} );
		for ( const bytes of [
			elfBinary( EM_X86_64, { elfClass: 1 } ),
			elfBinary( EM_X86_64, { data: 2 } ),
			elfBinary( EM_X86_64, { type: 1 } ),
			elfBinary( EM_X86_64, { interpreter: GLIBC_X64 } ).subarray( 0, 40 ),
			Buffer.from( '#!/usr/bin/env node\n' ),
			peBinary(),
			machOBinary( CPU_TYPE_ARM64 ),
		] )
			expect( await readElfHeader( reader( bytes ) ) ).toBeUndefined();
	} );
} );

const authenticodeOk = '';
const versionOutput = ( version: string ) => `${ version } (Claude Code)\n`;
const decodedScript = ( args: string[] ) =>
	Buffer.from( args[ args.indexOf( '-EncodedCommand' ) + 1 ], 'base64' ).toString( 'utf16le' );

describe( 'Claude executable inspection on Windows', () => {
	const env = { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32' };
	const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
	const selected = 'C:\\Users\\Ünïcode User\\Claude Tools\\claude.exe';

	function windows(
		arch: 'x64' | 'arm64',
		answers: { signature?: string | Error; version?: string | Error } = {}
	) {
		const runner = recordingRunner( ( command ) => {
			if ( command.file === powershell ) return answers.signature ?? authenticodeOk;
			if ( command.args[ 0 ] === '--version' ) return answers.version ?? versionOutput( '2.1.319' );
			return new Error( 'unexpected' );
		} );
		const { fs, seams } = simulatedHost( { platform: 'win32', arch }, path.win32, {
			env,
			run: runner.run,
		} );
		return { fs, seams, calls: runner.calls };
	}

	it( 'qualifies the vendor-signed x64 runtime at a path with spaces and Unicode, returning safe metadata', async () => {
		const { fs, seams, calls } = windows( 'x64' );
		const bytes = peBinary();
		fs.write( selected, bytes );
		const result = await inspectClaudeExecutable( selected, seams );
		expect( result ).toEqual( {
			ok: true,
			executablePath: selected,
			version: '2.1.319',
			platform: 'win32',
			architecture: 'x64',
			target: 'windows-x64',
			format: 'pe',
			architectures: [ 'x64' ],
			provenance: {
				verification: 'authenticode',
				signer: 'Anthropic, PBC',
				vendorPlatform: 'win32-x64',
			},
			identity: expect.objectContaining( {
				path: selected,
				size: bytes.length,
				sha256: sha256( bytes ),
			} ),
			qualification: {
				state: 'qualified',
				record: expect.objectContaining( { target: 'windows-x64', runtimeVersion: '2.1.319' } ),
			},
		} );
		expect( calls.map( ( { file, args } ) => [ file, args[ 0 ] ] ) ).toEqual( [
			[ powershell, '-NoProfile' ],
			[ selected, '--version' ],
		] );
		const script = decodedScript( calls[ 0 ].args );
		expect( script ).toContain( 'Get-AuthenticodeSignature -LiteralPath $p' );
		expect( script ).toContain( AUTHENTICODE_SIGNER_CHECK );
		expect( script ).toContain(
			'Test-StudioClaudeSigner $s.SignerCertificate.SubjectName.RawData'
		);
		expect( script ).toContain( '[System.StringComparison]::Ordinal' );
		expect( script ).not.toMatch( /-[ci]?(not)?(match|like)\b|\.Subject\b/i );
		expect( script ).toContain( Buffer.from( selected, 'utf8' ).toString( 'base64' ) );
		expect( script ).not.toContain( 'Ünïcode' );
		expect( JSON.stringify( result ) ).not.toMatch( /token|secret|credential/i );
	} );

	it( 'inspects and runs the file a symlink resolves to', async () => {
		const { fs, seams, calls } = windows( 'x64' );
		const real = 'C:\\Users\\tester\\.local\\share\\claude\\versions\\2.1.319.exe';
		fs.write( real, peBinary() );
		fs.link( 'C:\\Users\\tester\\.local\\bin\\claude.exe', real );
		await expect(
			inspectClaudeExecutable( 'C:\\Users\\tester\\.local\\bin\\claude.exe', seams )
		).resolves.toMatchObject( {
			ok: true,
			executablePath: real,
			identity: { path: real },
		} );
		expect( calls.at( -1 ) ).toMatchObject( { file: real, args: [ '--version' ] } );
	} );

	it( 'refuses names, scripts, other formats and other architectures before running anything', async () => {
		const { fs, seams, calls } = windows( 'x64' );
		fs.write( 'C:\\tools\\claude.cmd', Buffer.from( '@echo off\r\n' ) );
		fs.write( 'C:\\tools\\script.exe', Buffer.from( '@echo off\r\n' ) );
		fs.write( 'C:\\tools\\linux.exe', elfBinary( EM_X86_64, { interpreter: GLIBC_X64 } ) );
		fs.write( 'C:\\tools\\arm.exe', peBinary( { machine: 0xaa64 } ) );
		fs.write( 'C:\\tools\\x86.exe', peBinary( { machine: 0x14c } ) );
		fs.directory( 'C:\\tools\\folder.exe' );
		for ( const [ candidate, reason ] of [
			[ 'claude', 'absolute-native-executable-required' ],
			[ 'claude.exe', 'absolute-native-executable-required' ],
			[ 'C:\\tools\\claude.cmd', 'absolute-native-executable-required' ],
			[ 'C:\\tools\\absent.exe', 'executable-unavailable' ],
			[ 'C:\\tools\\folder.exe', 'executable-unavailable' ],
			[ 'C:\\tools\\script.exe', 'invalid-executable-format' ],
			[ 'C:\\tools\\linux.exe', 'invalid-executable-format' ],
			[ 'C:\\tools\\arm.exe', 'architecture-unqualified' ],
			[ 'C:\\tools\\x86.exe', 'architecture-unqualified' ],
		] )
			await expect( inspectClaudeExecutable( candidate, seams ), candidate ).resolves.toMatchObject(
				{ ok: false, reason }
			);
		expect( calls ).toEqual( [] );
	} );

	it( 'never runs a binary whose Authenticode signature is not the vendor’s or cannot be checked', async () => {
		for ( const [ signature, reason ] of [
			[ exitWith( 3 ), 'signature-invalid' ],
			[ exitWith( 1 ), 'signature-unverifiable' ],
			[ spawnFailure(), 'signature-unverifiable' ],
			[
				Object.assign( new Error( 'timeout' ), { killed: true, code: null } ),
				'signature-unverifiable',
			],
		] as const ) {
			const { fs, seams, calls } = windows( 'x64', { signature } );
			fs.write( selected, peBinary() );
			await expect( inspectClaudeExecutable( selected, seams ) ).resolves.toMatchObject( {
				ok: false,
				reason,
			} );
			expect( calls.some( ( { args } ) => args[ 0 ] === '--version' ) ).toBe( false );
		}
		const { fs, seams, calls } = windows( 'x64' );
		fs.write( selected, peBinary() );
		await expect(
			inspectClaudeExecutable( selected, { ...seams, env: { Path: 'C:\\Windows' } } )
		).resolves.toMatchObject( { ok: false, reason: 'signature-unverifiable' } );
		expect( calls ).toEqual( [] );
	} );

	it( 'keeps an auto-updated or unreadable version visible and unqualified', async () => {
		const updated = windows( 'x64', { version: versionOutput( '2.1.320' ) } );
		updated.fs.write( selected, peBinary() );
		await expect( inspectClaudeExecutable( selected, updated.seams ) ).resolves.toEqual( {
			ok: false,
			reason: 'version-unqualified',
			executable: expect.objectContaining( {
				executablePath: selected,
				version: '2.1.320',
				architectures: [ 'x64' ],
				provenance: expect.objectContaining( { verification: 'authenticode' } ),
			} ),
			qualification: {
				state: 'unqualified',
				reason: 'version-unqualified',
				supportedRuntimeVersions: [ '2.1.319' ],
			},
		} );
		for ( const version of [ 'Claude Code', exitWith( 3 ), '' ] ) {
			const unreadable = windows( 'x64', { version } );
			unreadable.fs.write( selected, peBinary() );
			await expect( inspectClaudeExecutable( selected, unreadable.seams ) ).resolves.toMatchObject(
				{ ok: false, reason: 'version-unreadable' }
			);
		}
	} );

	it( 'refuses a binary that changes while it is inspected', async () => {
		const host = simulatedHost( { platform: 'win32', arch: 'x64' }, path.win32, { env } );
		const runner = recordingRunner( ( command ) => {
			if ( command.args[ 0 ] !== '--version' ) return authenticodeOk;
			host.fs.write( selected, peBinary( { body: 'replaced' } ) );
			return versionOutput( '2.1.319' );
		} );
		host.fs.write( selected, peBinary() );
		await expect(
			inspectClaudeExecutable( selected, { ...host.seams, run: runner.run } )
		).resolves.toMatchObject( {
			ok: false,
			reason: 'executable-changed',
		} );
	} );

	it( 'reports an ARM64 host as unqualified while still showing what it found', async () => {
		const { fs, seams } = windows( 'arm64' );
		fs.write( selected, peBinary( { machine: 0xaa64 } ) );
		await expect( inspectClaudeExecutable( selected, seams ) ).resolves.toMatchObject( {
			ok: false,
			reason: 'platform-unqualified',
			executable: {
				version: '2.1.319',
				architectures: [ 'arm64' ],
				provenance: { verification: 'authenticode', vendorPlatform: 'win32-arm64' },
			},
			qualification: {
				state: 'unqualified',
				reason: 'platform-unqualified',
				record: { target: 'windows-arm64', reason: 'no-native-qualification-run' },
			},
		} );
	} );
} );

describe.skipIf( process.platform !== 'win32' )(
	'Authenticode signer check (Windows only: it runs the production PowerShell function natively)',
	() => {
		const der = ( tag: number, ...content: Buffer[] ) => {
			const body = Buffer.concat( content );
			let length = Buffer.from( [ body.length ] );
			if ( body.length >= 0x100 )
				length = Buffer.from( [ 0x82, body.length >> 8, body.length & 0xff ] );
			else if ( body.length >= 0x80 ) length = Buffer.from( [ 0x81, body.length ] );
			return Buffer.concat( [ Buffer.from( [ tag ] ), length, body ] );
		};
		const ORGANIZATION = Buffer.from( [ 0x06, 0x03, 0x55, 0x04, 0x0a ] );
		const organization = ( tag: number, value: Buffer ) =>
			der( 0x30, ORGANIZATION, der( tag, value ) );
		const subject = ( ...attributes: Buffer[] ) =>
			der( 0x30, ...attributes.map( ( attribute ) => der( 0x31, attribute ) ) );
		const utf8 = ( value: string ) => Buffer.from( value, 'utf8' );
		// The subject of the certificate that signs the vendor's 2.1.319 Windows binary.
		const vendorSubject =
			'3081cd31133011060b2b0601040182373c0201031302555331193017060b2b0601040182373c020102130844656c6177617265311d301b060355040f0c1450726976617465204f7267616e697a6174696f6e3110300e0603550405130734383630363231310b3009060355040613025553311330110603550408130a43616c69666f726e6961311630140603550407130d53616e204672616e636973636f31173015060355040a130e416e7468726f7069632c20504243311730150603550403130e416e7468726f7069632c20504243';
		const exact = organization( 0x13, utf8( 'Anthropic, PBC' ) );

		it( 'accepts only a subject whose one single-valued Organization is exactly the vendor’s, compared ordinally', async () => {
			const samples: Array< [ string, { dn: string } | { der: Buffer }, string ] > = [
				[ 'the vendor certificate', { der: Buffer.from( vendorSubject, 'hex' ) }, 'accepted' ],
				[ 'exactly the vendor', { dn: 'O="Anthropic, PBC"' }, 'accepted' ],
				[
					'extra RDNs before and after',
					{
						dn: 'CN="Anthropic, PBC", O="Anthropic, PBC", L=San Francisco, S=California, C=US',
					},
					'accepted',
				],
				[
					'a UTF8String value',
					{ der: subject( organization( 0x0c, utf8( 'Anthropic, PBC' ) ) ) },
					'accepted',
				],
				[
					'a BMPString value',
					{
						der: subject(
							organization( 0x1e, Buffer.from( 'Anthropic, PBC', 'utf16le' ).swap16() )
						),
					},
					'accepted',
				],
				[
					'O= inside another RDN, another O',
					{ dn: 'CN="Evil, O=Anthropic, PBC", O=Evil Corp' },
					'refused',
				],
				[ 'another case', { dn: 'O="ANTHROPIC, pbc"' }, 'refused' ],
				[ 'a longer value', { dn: 'O="Anthropic, PBC Evil"' }, 'refused' ],
				[ 'lower case', { dn: 'O="anthropic, pbc"' }, 'refused' ],
				[ 'O= quoted inside OU', { dn: 'OU="O=Anthropic, PBC", CN=Evil' }, 'refused' ],
				[ 'no Organization', { dn: 'CN="Anthropic, PBC"' }, 'refused' ],
				[ 'a multi-valued RDN', { dn: 'C=US + O="Anthropic, PBC", CN=Claude' }, 'refused' ],
				[ 'a second Organization', { dn: 'O="Anthropic, PBC", O=Evil Corp' }, 'refused' ],
				[ 'the vendor twice', { der: subject( exact, exact ) }, 'refused' ],
				[
					'a soft hyphen',
					{ der: subject( organization( 0x0c, utf8( 'Anthropic,­ PBC' ) ) ) },
					'refused',
				],
				[
					'a zero-width joiner',
					{ der: subject( organization( 0x0c, utf8( 'Anthropic,‍ PBC' ) ) ) },
					'refused',
				],
				[
					'a trailing space',
					{ der: subject( organization( 0x13, utf8( 'Anthropic, PBC ' ) ) ) },
					'refused',
				],
				[
					'a Cyrillic A',
					{ der: subject( organization( 0x0c, utf8( 'Аnthropic, PBC' ) ) ) },
					'refused',
				],
				[
					'an undecoded string type',
					{ der: subject( organization( 0x14, utf8( 'Anthropic, PBC' ) ) ) },
					'refused',
				],
				[ 'a truncated name', { der: subject( exact ).subarray( 0, -1 ) }, 'cannot verify' ],
				[
					'data after the name',
					{ der: Buffer.concat( [ subject( exact ), Buffer.from( [ 0 ] ) ] ) },
					'cannot verify',
				],
				[ 'an empty RDN', { der: der( 0x30, der( 0x31 ), der( 0x31, exact ) ) }, 'cannot verify' ],
				[
					'invalid UTF-8',
					{ der: subject( organization( 0x0c, Buffer.from( [ 0xc3, 0x28 ] ) ) ) },
					'cannot verify',
				],
			];
			const data = Buffer.from(
				JSON.stringify(
					samples.map( ( [ , sample ] ) =>
						'der' in sample ? { der: sample.der.toString( 'base64' ) } : sample
					)
				),
				'utf8'
			).toString( 'base64' );
			const harness = [
				"$ErrorActionPreference='Stop'",
				AUTHENTICODE_SIGNER_CHECK,
				`$samples = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${ data }')))`,
				'$results = foreach ($sample in $samples) {',
				'try {',
				'if ($sample.der) { $name = [Convert]::FromBase64String($sample.der) }',
				'else { $name = (New-Object System.Security.Cryptography.X509Certificates.X500DistinguishedName($sample.dn)).RawData }',
				"if (Test-StudioClaudeSigner $name) { 'accepted' } else { 'refused' }",
				"} catch { 'cannot verify' }",
				'}',
				'[Console]::Out.Write($results -join [char]10)',
			].join( '\n' );
			const { execFile } = await import( 'child_process' );
			const { promisify } = await import( 'util' );
			const { stdout } = await promisify( execFile )(
				trustedPowerShellPath( process.env ),
				encodedPowerShellArgs( harness ),
				{ windowsHide: true, timeout: 60000 }
			);
			expect(
				samples.map( ( [ name ], index ) => [ name, stdout.split( '\n' )[ index ] ] )
			).toEqual( samples.map( ( [ name, , expected ] ) => [ name, expected ] ) );
		} );
	}
);

describe( 'Claude executable inspection on macOS', () => {
	const codesign = '/usr/bin/codesign';
	const launcher = '/Users/tester/.local/bin/claude';
	const installed = '/Users/tester/.local/share/claude/versions/2.1.319';

	function macos(
		arch: 'x64' | 'arm64',
		answers: { signature?: string | Error; version?: string | Error } = {}
	) {
		const runner = recordingRunner( ( command ) => {
			if ( command.file === codesign ) return answers.signature ?? '';
			if ( command.args[ 0 ] === '--version' ) return answers.version ?? versionOutput( '2.1.319' );
			return new Error( 'unexpected' );
		} );
		const { fs, seams } = simulatedHost( { platform: 'darwin', arch }, path.posix, {
			env: { HOME: '/Users/tester', PATH: '/usr/bin:/bin' },
			run: runner.run,
		} );
		return { fs, seams, calls: runner.calls };
	}

	it.each( [
		[ 'x64', machOBinary( CPU_TYPE_X86_64 ) ],
		[ 'arm64', machOBinary( CPU_TYPE_ARM64 ) ],
		[ 'x64', universalBinary( [ CPU_TYPE_X86_64, CPU_TYPE_ARM64 ] ) ],
		[ 'arm64', universalBinary( [ CPU_TYPE_X86_64, CPU_TYPE_ARM64 ], { wide: true } ) ],
	] as const )(
		'verifies the Apple code signature of the installed %s binary and reports the platform unqualified',
		async ( arch, bytes ) => {
			const { fs, seams, calls } = macos( arch );
			fs.write( installed, bytes );
			fs.link( launcher, installed );
			await expect( inspectClaudeExecutable( launcher, seams ) ).resolves.toMatchObject( {
				ok: false,
				reason: 'platform-unqualified',
				executable: {
					selectedPath: launcher,
					executablePath: installed,
					version: '2.1.319',
					provenance: {
						verification: 'apple-code-signature',
						signer: 'Anthropic PBC',
						vendorPlatform: arch === 'x64' ? 'darwin-x64' : 'darwin-arm64',
					},
					identity: { path: installed, sha256: sha256( bytes ) },
				},
				qualification: { reason: 'platform-unqualified' },
			} );
			expect( calls[ 0 ] ).toEqual( {
				file: codesign,
				args: [
					'--verify',
					'--strict',
					'-R',
					'=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.O] = "Anthropic PBC"',
					installed,
				],
				env: { HOME: '/Users/tester', PATH: '/usr/bin:/bin' },
			} );
			expect( calls[ 1 ] ).toMatchObject( { file: installed, args: [ '--version' ] } );
		}
	);

	it( 'never runs a binary that is unsigned, signed by someone else, or whose signature cannot be checked', async () => {
		for ( const [ signature, check ] of [
			[ exitWith( 1 ), 'signature-invalid' ],
			[ exitWith( 3 ), 'signature-invalid' ],
			[ spawnFailure(), 'signature-unverifiable' ],
		] as const ) {
			const { fs, seams, calls } = macos( 'arm64', { signature } );
			fs.write( installed, machOBinary( CPU_TYPE_ARM64 ) );
			await expect( inspectClaudeExecutable( installed, seams ) ).resolves.toMatchObject( {
				ok: false,
				reason: 'platform-unqualified',
				check,
			} );
			expect( calls.some( ( { args } ) => args[ 0 ] === '--version' ) ).toBe( false );
		}
	} );

	it( 'refuses other formats, missing slices and non-executable files before running anything', async () => {
		const { fs, seams, calls } = macos( 'arm64' );
		fs.write( '/opt/claude/x64-only', machOBinary( CPU_TYPE_X86_64 ) );
		fs.write( '/opt/claude/universal-x64', universalBinary( [ CPU_TYPE_X86_64 ] ) );
		fs.write( '/opt/claude/linux', elfBinary( EM_AARCH64, { interpreter: GLIBC_ARM64 } ) );
		fs.write( '/opt/claude/script', Buffer.from( '#!/bin/sh\n' ) );
		fs.write( '/opt/claude/not-executable', machOBinary( CPU_TYPE_ARM64 ), { mode: 0o644 } );
		for ( const [ candidate, check ] of [
			[ 'claude', 'absolute-native-executable-required' ],
			[ '/opt/claude/absent', 'executable-unavailable' ],
			[ '/opt/claude/not-executable', 'executable-unavailable' ],
			[ '/opt/claude/script', 'invalid-executable-format' ],
			[ '/opt/claude/linux', 'invalid-executable-format' ],
			[ '/opt/claude/x64-only', 'architecture-unqualified' ],
			[ '/opt/claude/universal-x64', 'architecture-unqualified' ],
		] )
			await expect( inspectClaudeExecutable( candidate, seams ), candidate ).resolves.toMatchObject(
				{ ok: false, reason: 'platform-unqualified', check }
			);
		expect( calls ).toEqual( [] );
	} );
} );

describe( 'Claude executable inspection on Linux', () => {
	const installed = '/home/tester/.local/share/claude/versions/2.1.319';

	it( 'never runs a binary without a signed-manifest checksum recorded for its platform', async () => {
		for ( const arch of [ 'x64', 'arm64' ] as const ) {
			const runner = recordingRunner( () => new Error( 'unexpected' ) );
			const { fs, seams } = simulatedHost( { platform: 'linux', arch }, path.posix, {
				run: runner.run,
			} );
			fs.write(
				installed,
				elfBinary( arch === 'x64' ? EM_X86_64 : EM_AARCH64, {
					interpreter: arch === 'x64' ? GLIBC_X64 : GLIBC_ARM64,
				} )
			);
			await expect( inspectClaudeExecutable( installed, seams ) ).resolves.toMatchObject( {
				ok: false,
				reason: 'platform-unqualified',
				check: 'signature-unverifiable',
				executable: { format: 'elf', architectures: [ arch ], libc: 'glibc' },
			} );
			expect( runner.calls ).toEqual( [] );
		}
	} );

	it( 'refuses musl binaries and hosts, other formats and other architectures', async () => {
		const { fs, seams } = simulatedHost( { platform: 'linux', arch: 'x64' }, path.posix );
		fs.write( '/opt/musl', elfBinary( EM_X86_64, { interpreter: MUSL_X64 } ) );
		fs.write( '/opt/static', elfBinary( EM_X86_64 ) );
		fs.write( '/opt/glibc', elfBinary( EM_X86_64, { interpreter: GLIBC_X64 } ) );
		fs.write( '/opt/arm', elfBinary( EM_AARCH64, { interpreter: GLIBC_ARM64 } ) );
		fs.write( '/opt/mac', machOBinary( CPU_TYPE_X86_64 ) );
		for ( const [ candidate, check, host ] of [
			[ '/opt/musl', 'libc-unsupported', 'glibc' ],
			[ '/opt/static', 'libc-unsupported', 'glibc' ],
			[ '/opt/glibc', 'libc-unsupported', 'musl' ],
			[ '/opt/glibc', 'libc-unsupported', 'unknown' ],
			[ '/opt/arm', 'architecture-unqualified', 'glibc' ],
			[ '/opt/mac', 'invalid-executable-format', 'glibc' ],
		] as const )
			await expect(
				inspectClaudeExecutable( candidate, { ...seams, hostLibc: () => host } ),
				`${ candidate } on ${ host }`
			).resolves.toMatchObject( { ok: false, reason: 'platform-unqualified', check } );
	} );

	it( 'accepts only the checksum a qualification copied from the signed manifest', async () => {
		const bytes = elfBinary( EM_X86_64, { interpreter: GLIBC_X64 } );
		const record = CLAUDE_QUALIFICATION_MATRIX.find( ( item ) => item.target === 'linux-x64' )!;
		const pinned: ClaudeQualificationRecord = { ...record, manifestSha256: sha256( bytes ) };
		const header = {
			format: 'elf' as const,
			architectures: [ 'x64' as const ],
			libc: 'glibc' as const,
		};
		const { seams } = simulatedHost( { platform: 'linux', arch: 'x64' }, path.posix );
		const verify = ( records: ClaudeQualificationRecord[], digest: string ) =>
			linuxAdapter.verifyBinary(
				{ executablePath: installed, sha256: digest, header, records, env: {} },
				defaultClaudePlatformSeams( seams )
			);
		await expect( verify( [ pinned ], sha256( bytes ) ) ).resolves.toEqual( {
			ok: true,
			provenance: {
				verification: 'signed-manifest-checksum',
				vendorPlatform: 'linux-x64',
				libc: 'glibc',
				manifestRuntimeVersion: '2.1.319',
			},
		} );
		await expect( verify( [ pinned ], sha256( Buffer.from( 'changed' ) ) ) ).resolves.toEqual( {
			ok: false,
			reason: 'signature-invalid',
		} );
		await expect( verify( [ record ], sha256( bytes ) ) ).resolves.toEqual( {
			ok: false,
			reason: 'signature-unverifiable',
		} );
	} );
} );

describe( 'Claude executable identity', () => {
	const selected = '/home/tester/.local/bin/claude';
	const first = '/home/tester/.local/share/claude/versions/2.1.319';
	const second = '/home/tester/.local/share/claude/versions/2.1.320';

	async function identityFor( bytes: Buffer ) {
		const { fs } = simulatedHost( { platform: 'linux', arch: 'x64' }, path.posix );
		fs.write( first, bytes );
		fs.write( second, Buffer.from( 'next version' ) );
		fs.link( selected, first );
		const stat = await fs.files.stat( first );
		return {
			fs,
			identity: {
				path: first,
				size: stat.size,
				device: stat.device,
				inode: stat.inode,
				modified: stat.modified,
				changed: stat.changed,
				sha256: sha256( bytes ),
			},
		};
	}

	it( 'stays verified only while the selected path resolves to the same, unchanged file', async () => {
		const bytes = elfBinary( EM_X86_64, { interpreter: GLIBC_X64 } );
		const { fs, identity } = await identityFor( bytes );
		const verify = () =>
			verifyClaudeExecutableIdentity( identity, {
				selectedPath: selected,
				files: fs.files,
			} );
		await expect( verify() ).resolves.toBe( true );
		expect( isClaudeExecutableUnchanged( identity, fs.files ) ).toBe( true );

		fs.link( selected, second );
		await expect( verify() ).resolves.toBe( false );
		fs.link( selected, first );
		await expect( verify() ).resolves.toBe( true );

		fs.write( first, Buffer.from( bytes ), { inPlace: true } );
		await expect( verify() ).resolves.toBe( false );
		expect( isClaudeExecutableUnchanged( identity, fs.files ) ).toBe( false );
	} );

	it( 'detects a same-size replacement by content even when metadata is restored', async () => {
		const bytes = elfBinary( EM_X86_64, { interpreter: GLIBC_X64, body: 'aaaa' } );
		const { fs, identity } = await identityFor( bytes );
		const tampered = elfBinary( EM_X86_64, { interpreter: GLIBC_X64, body: 'bbbb' } );
		const files = {
			...fs.files,
			stat: async () => ( {
				kind: 'file' as const,
				size: identity.size,
				device: identity.device,
				inode: identity.inode,
				modified: identity.modified,
				changed: identity.changed,
				executable: true,
			} ),
			sha256: async () => sha256( tampered ),
		};
		await expect( verifyClaudeExecutableIdentity( identity, { files } ) ).resolves.toBe( false );
		await expect(
			verifyClaudeExecutableIdentity( identity, { files, content: false } )
		).resolves.toBe( true );
	} );

	it( 'treats a missing file as changed rather than throwing', async () => {
		const { fs, identity } = await identityFor( Buffer.from( 'x' ) );
		fs.remove( first );
		await expect(
			verifyClaudeExecutableIdentity( identity, { selectedPath: selected, files: fs.files } )
		).resolves.toBe( false );
		expect( isClaudeExecutableUnchanged( identity, fs.files ) ).toBe( false );
	} );
} );

describe.runIf( process.platform === 'win32' && process.arch === 'x64' )(
	'Claude executable inspection on this Windows x64 machine’s filesystem',
	() => {
		it( 'follows a junction to a folder with spaces, Unicode and shell characters, and notices the file changing', async () => {
			const root = await realpath(
				await mkdtemp( path.join( os.tmpdir(), 'Studio Claude Platform Évidence ' ) )
			);
			try {
				const folder = path.join( root, 'Claude Édition $HOME `x` [1]' );
				const junction = path.join( root, 'linked folder' );
				await mkdir( folder );
				const executable = path.join( folder, 'claude.exe' );
				await writeFile( executable, peBinary() );
				await symlink( folder, junction, 'junction' );
				const runner = recordingRunner( ( command ) =>
					command.args[ 0 ] === '--version' ? versionOutput( '2.1.319' ) : authenticodeOk
				);
				const selectedPath = path.join( junction, 'claude.exe' );
				const result = await inspectClaudeExecutable( selectedPath, {
					run: runner.run,
					machineArchitecture: () => probeClaudeMachineArchitecture(),
				} );
				expect( result ).toMatchObject( { ok: true, executablePath: executable } );
				expect( runner.calls.at( -1 ) ).toMatchObject( {
					file: executable,
					args: [ '--version' ],
				} );
				if ( ! result.ok ) return;
				await expect(
					verifyClaudeExecutableIdentity( result.identity, { selectedPath } )
				).resolves.toBe( true );
				expect( isClaudeExecutableUnchanged( result.identity ) ).toBe( true );
				await writeFile( executable, peBinary( { body: 'auto-updated' } ) );
				await expect(
					verifyClaudeExecutableIdentity( result.identity, { selectedPath } )
				).resolves.toBe( false );
				expect( isClaudeExecutableUnchanged( result.identity ) ).toBe( false );
			} finally {
				await rm( root, { recursive: true, force: true, maxRetries: 4 } );
			}
		} );
	}
);

describe( 'Claude path identity', () => {
	it( 'compares Windows paths regardless of letter case, as NTFS does, and resolves aliases', async () => {
		const { fs, seams } = simulatedHost(
			{ platform: 'win32', arch: 'x64' },
			path.win32,
			{},
			{
				caseInsensitive: [ 'C:\\' ],
			}
		);
		fs.directory( 'C:\\Users\\Tester\\.claude' );
		fs.directory( 'C:\\Users\\Tester\\.claude-work' );
		fs.link( 'C:\\Users\\Tester\\profile', 'C:\\Users\\Tester\\.claude' );
		const same = ( a: string, b: string ) => isSameClaudePath( a, b, seams );
		await expect(
			same( 'C:\\Users\\Tester\\.claude', 'c:\\users\\tester\\.CLAUDE' )
		).resolves.toBe( true );
		await expect(
			same( 'C:\\Users\\Tester\\.claude\\projects', 'C:\\USERS\\tester\\.claude\\Projects' )
		).resolves.toBe( true );
		await expect(
			same( 'C:\\Users\\Tester\\profile', 'C:\\Users\\Tester\\.claude' )
		).resolves.toBe( true );
		await expect(
			same( 'C:\\Users\\Tester\\.claude', 'C:\\Users\\Tester\\.claude-work' )
		).resolves.toBe( false );
		await expect(
			resolveClaudePathKey( 'c:\\users\\tester\\.claude', seams )
		).resolves.toMatchObject( {
			canonical: 'C:\\Users\\Tester\\.claude',
			caseSensitive: false,
			caseSource: 'probed',
		} );
	} );

	it( 'keeps Linux paths that differ only in case distinct and never folds them, while resolving symlinks', async () => {
		const { fs, seams } = simulatedHost(
			{ platform: 'linux', arch: 'x64' },
			path.posix,
			{},
			{
				caseInsensitive: [ '/mnt/usb' ],
			}
		);
		fs.directory( '/home/tester/Claude' );
		fs.directory( '/home/tester/claude' );
		fs.directory( '/home/tester/.claude' );
		fs.link( '/home/tester/alias', '/home/tester/.claude' );
		fs.directory( '/mnt/usb/Claude' );
		const same = ( a: string, b: string ) => isSameClaudePath( a, b, seams );
		await expect( same( '/home/tester/Claude', '/home/tester/claude' ) ).resolves.toBe( false );
		await expect(
			same( '/home/tester/.claude/projects', '/home/tester/.claude/Projects' )
		).resolves.toBe( false );
		await expect( same( '/home/tester/alias', '/home/tester/.claude' ) ).resolves.toBe( true );
		await expect(
			same( '/home/tester/alias/projects', '/home/tester/.claude/projects' )
		).resolves.toBe( true );
		await expect( same( '/mnt/usb/Claude', '/mnt/usb/claude' ) ).resolves.toBe( true );
		await expect( same( '/mnt/usb/Claude/projects', '/mnt/usb/Claude/Projects' ) ).resolves.toBe(
			false
		);
		await expect( resolveClaudePathKey( '/home/tester/Claude', seams ) ).resolves.toMatchObject( {
			canonical: '/home/tester/Claude',
			caseSensitive: true,
			caseSource: 'os-default',
		} );
	} );

	it( 'follows the macOS volume: default APFS ignores case, case-sensitive APFS does not', async () => {
		const { fs, seams } = simulatedHost(
			{ platform: 'darwin', arch: 'arm64' },
			path.posix,
			{},
			{
				caseInsensitive: [ '/Users' ],
				devices: { '/Volumes/Sensitive': '9' },
			}
		);
		fs.directory( '/Users/tester/.claude' );
		fs.directory( '/Volumes/Sensitive/Claude' );
		fs.directory( '/Volumes/Sensitive/claude' );
		const same = ( a: string, b: string ) => isSameClaudePath( a, b, seams );
		await expect( same( '/Users/tester/.claude', '/users/TESTER/.claude' ) ).resolves.toBe( true );
		await expect(
			same( '/Users/tester/.claude/projects', '/Users/tester/.claude/Projects' )
		).resolves.toBe( true );
		await expect( same( '/Volumes/Sensitive/Claude', '/Volumes/Sensitive/claude' ) ).resolves.toBe(
			false
		);
		await expect(
			same( '/Volumes/Sensitive/Claude/projects', '/Volumes/Sensitive/Claude/Projects' )
		).resolves.toBe( false );
		await expect( resolveClaudePathKey( '/Users/tester/.claude', seams ) ).resolves.toMatchObject( {
			caseSensitive: false,
			caseSource: 'probed',
		} );
		await expect(
			resolveClaudePathKey( '/Volumes/Sensitive/Claude', seams )
		).resolves.toMatchObject( { caseSensitive: true, caseSource: 'probed' } );
	} );

	it( 'falls back to the OS default only where the filesystem cannot answer', async () => {
		for ( const [ host, pathModule, root, expected ] of [
			[ { platform: 'darwin', arch: 'x64' }, path.posix, '/', false ],
			[ { platform: 'win32', arch: 'x64' }, path.win32, 'C:\\', false ],
			[ { platform: 'linux', arch: 'x64' }, path.posix, '/', true ],
		] as const ) {
			const { fs, seams } = simulatedHost( host, pathModule );
			fs.directory( pathModule.join( root, '1234' ) );
			await expect(
				resolveClaudePathKey( pathModule.join( root, 'Missing', 'Child' ), seams ),
				host.platform
			).resolves.toMatchObject( { caseSensitive: expected, caseSource: 'os-default' } );
			await expect(
				isSameClaudePath(
					pathModule.join( root, '1234', 'Child' ),
					pathModule.join( root, '1234', 'child' ),
					seams
				),
				host.platform
			).resolves.toBe( ! expected );
		}
	} );

	it( 'tells distinct folders on this machine apart and resolves its own aliases', async () => {
		const root = await realpath( await mkdtemp( path.join( os.tmpdir(), 'Studio Claude Path ' ) ) );
		try {
			const first = path.join( root, 'Profile Ünï' );
			const second = path.join( root, 'Profile Two' );
			await mkdir( first );
			await mkdir( second );
			await symlink( first, path.join( root, 'alias' ), 'junction' );
			await expect( isSameClaudePath( first, second ) ).resolves.toBe( false );
			await expect( isSameClaudePath( path.join( root, 'alias' ), first ) ).resolves.toBe( true );
			await expect(
				isSameClaudePath( path.join( root, 'alias', 'projects' ), path.join( first, 'projects' ) )
			).resolves.toBe( true );
			if ( process.platform === 'win32' )
				await expect( isSameClaudePath( first, first.toUpperCase() ) ).resolves.toBe( true );
			if ( process.platform === 'linux' )
				await expect( isSameClaudePath( first, first.toUpperCase() ) ).resolves.toBe( false );
		} finally {
			await rm( root, { recursive: true, force: true, maxRetries: 4 } );
		}
	} );
} );

function denied( files: ReturnType< typeof simulatedHost >[ 'fs' ][ 'files' ], blocked: string[] ) {
	const contents = { read: 0 };
	return {
		contents,
		files: {
			...files,
			lstat: async ( target: string ) => {
				if ( blocked.some( ( prefix ) => target.startsWith( prefix ) ) )
					throw Object.assign( new Error( 'EACCES' ), { code: 'EACCES' } );
				return files.lstat( target );
			},
			read: async ( ...args: Parameters< typeof files.read > ) => {
				contents.read++;
				return files.read( ...args );
			},
			sha256: async ( target: string ) => {
				contents.read++;
				return files.sha256( target );
			},
		},
	};
}

describe( 'Claude managed policy', () => {
	const windowsFiles = [
		'managed-settings.json',
		'managed-settings.d',
		'managed-mcp.json',
	] as const;

	function windows( registry: string | Error = '', programFiles = 'C:\\Program Files' ) {
		const runner = recordingRunner( () => registry );
		const host = simulatedHost( { platform: 'win32', arch: 'x64' }, path.win32, {
			env: { SystemRoot: 'C:\\Windows', ProgramFiles: programFiles },
			run: runner.run,
		} );
		return { ...host, calls: runner.calls };
	}

	it( 'finds no policy on Windows only after checking every documented file and both registry keys', async () => {
		const { fs, seams, calls } = windows();
		const guarded = denied( fs.files, [] );
		fs.directory( 'C:\\Program Files\\ClaudeCode' );
		const finding = await inspectClaudeManagedPolicy( { ...seams, files: guarded.files } );
		expect( finding ).toEqual( {
			state: 'absent',
			present: [],
			unreadable: [],
			checked: [
				...windowsFiles.map( ( name ) => ( {
					kind: expect.any( String ),
					scope: 'machine',
					location: `C:\\Program Files\\ClaudeCode\\${ name }`,
				} ) ),
				{
					kind: 'registry',
					scope: 'machine',
					location: 'HKLM\\SOFTWARE\\Policies\\ClaudeCode',
				},
				{ kind: 'registry', scope: 'user', location: 'HKCU\\SOFTWARE\\Policies\\ClaudeCode' },
			],
		} );
		expect( guarded.contents.read ).toBe( 0 );
		const script = decodedScript( calls[ 0 ].args );
		expect( script ).toContain( "Test-Path -LiteralPath 'HKLM:\\SOFTWARE\\Policies\\ClaudeCode'" );
		expect( script ).toContain( "Test-Path -LiteralPath 'HKCU:\\SOFTWARE\\Policies\\ClaudeCode'" );
		expect( script ).not.toMatch( /Get-ItemProperty|Get-Content|credentials/i );
	} );

	it( 'reports each documented Windows source that is present, including a symlinked file', async () => {
		for ( const [ name, kind ] of [
			[ 'managed-settings.json', 'settings-file' ],
			[ 'managed-settings.d', 'settings-directory' ],
			[ 'managed-mcp.json', 'mcp-file' ],
		] as const ) {
			const { fs, seams } = windows();
			if ( name === 'managed-settings.d' )
				fs.directory( `C:\\Program Files\\ClaudeCode\\${ name }` );
			else fs.link( `C:\\Program Files\\ClaudeCode\\${ name }`, 'C:\\Policies\\elsewhere.json' );
			await expect( inspectClaudeManagedPolicy( seams ), name ).resolves.toMatchObject( {
				state: 'present',
				present: [
					{ kind, scope: 'machine', location: `C:\\Program Files\\ClaudeCode\\${ name }` },
				],
			} );
		}
		for ( const [ exit, scopes ] of [
			[ 11, [ 'machine' ] ],
			[ 12, [ 'user' ] ],
			[ 13, [ 'machine', 'user' ] ],
		] as const ) {
			const { seams } = windows( exitWith( exit ) );
			const finding = await inspectClaudeManagedPolicy( seams );
			expect( finding.state ).toBe( 'present' );
			expect( finding.present.map( ( source ) => [ source.kind, source.scope ] ) ).toEqual(
				scopes.map( ( scope ) => [ 'registry', scope ] )
			);
		}
	} );

	it( 'checks the documented C:\\Program Files folder too when Program Files lives elsewhere', async () => {
		const { fs, seams } = windows( '', 'D:\\Program Files' );
		fs.write( 'C:\\Program Files\\ClaudeCode\\managed-settings.json', Buffer.from( '{}' ) );
		const finding = await inspectClaudeManagedPolicy( seams );
		expect( finding.state ).toBe( 'present' );
		expect( finding.checked.map( ( source ) => source.location ) ).toEqual(
			expect.arrayContaining( [
				'D:\\Program Files\\ClaudeCode\\managed-settings.json',
				'C:\\Program Files\\ClaudeCode\\managed-settings.json',
			] )
		);
	} );

	it( 'cannot call a Windows policy absent when a location or the registry cannot be read', async () => {
		for ( const registry of [ exitWith( 1 ), spawnFailure() ] ) {
			const { seams } = windows( registry );
			await expect( inspectClaudeManagedPolicy( seams ) ).resolves.toMatchObject( {
				state: 'unverifiable',
				unreadable: [
					{ kind: 'registry', scope: 'machine' },
					{ kind: 'registry', scope: 'user' },
				],
			} );
		}
		const { fs, seams } = windows();
		await expect(
			inspectClaudeManagedPolicy( {
				...seams,
				files: denied( fs.files, [ 'C:\\Program Files\\ClaudeCode' ] ).files,
			} )
		).resolves.toMatchObject( { state: 'unverifiable' } );
		await expect(
			inspectClaudeManagedPolicy( { ...seams, env: { ProgramFiles: 'C:\\Program Files' } } )
		).resolves.toMatchObject( { state: 'unverifiable' } );
	} );

	it( 'inspects the macOS file locations, never calls the undocumented managed-preferences paths absent, and never reads contents', async () => {
		const macos = () =>
			simulatedHost( { platform: 'darwin', arch: 'arm64' }, path.posix, {
				username: () => 'tester',
			} );
		const preferences = [
			{
				kind: 'managed-preferences',
				scope: 'machine',
				location: '/Library/Managed Preferences/com.anthropic.claudecode.plist',
			},
			{
				kind: 'managed-preferences',
				scope: 'user',
				location: '/Library/Managed Preferences/tester/com.anthropic.claudecode.plist',
			},
		];
		const empty = macos();
		const guarded = denied( empty.fs.files, [] );
		await expect(
			inspectClaudeManagedPolicy( { ...empty.seams, files: guarded.files } )
		).resolves.toEqual( {
			state: 'unverifiable',
			present: [],
			unreadable: preferences,
			checked: [
				{
					kind: 'settings-file',
					scope: 'machine',
					location: '/Library/Application Support/ClaudeCode/managed-settings.json',
				},
				{
					kind: 'settings-directory',
					scope: 'machine',
					location: '/Library/Application Support/ClaudeCode/managed-settings.d',
				},
				{
					kind: 'mcp-file',
					scope: 'machine',
					location: '/Library/Application Support/ClaudeCode/managed-mcp.json',
				},
				{
					kind: 'managed-preferences',
					scope: 'machine',
					location: '/Library/Managed Preferences/com.anthropic.claudecode.plist',
				},
				{
					kind: 'managed-preferences',
					scope: 'user',
					location: '/Library/Managed Preferences/tester/com.anthropic.claudecode.plist',
				},
			],
		} );
		expect( guarded.contents.read ).toBe( 0 );

		const profile = macos();
		profile.fs.write(
			'/Library/Managed Preferences/tester/com.anthropic.claudecode.plist',
			Buffer.from( 'plist' )
		);
		await expect( inspectClaudeManagedPolicy( profile.seams ) ).resolves.toMatchObject( {
			state: 'present',
			present: [ { kind: 'managed-preferences', scope: 'user' } ],
			unreadable: [ preferences[ 0 ] ],
		} );
		const deployed = macos();
		deployed.fs.write(
			'/Library/Application Support/ClaudeCode/managed-settings.json',
			Buffer.from( '{}' )
		);
		await expect( inspectClaudeManagedPolicy( deployed.seams ) ).resolves.toMatchObject( {
			state: 'present',
			present: [ { kind: 'settings-file' } ],
		} );
		expect(
			CLAUDE_QUALIFICATION_MATRIX.filter( ( record ) => record.target.startsWith( 'macos-' ) ).map(
				( record ) => record.confirmationsRequired
			)
		).toEqual( [
			expect.arrayContaining( [ 'managed-preferences-locations' ] ),
			expect.arrayContaining( [ 'managed-preferences-locations' ] ),
		] );

		const nameless = macos();
		await expect(
			inspectClaudeManagedPolicy( { ...nameless.seams, username: () => '' } )
		).resolves.toMatchObject( { state: 'unverifiable' } );
	} );

	it( 'inspects the Linux file locations and fails closed when /etc/claude-code cannot be read', async () => {
		const linux = () => simulatedHost( { platform: 'linux', arch: 'x64' }, path.posix );
		const empty = linux();
		await expect( inspectClaudeManagedPolicy( empty.seams ) ).resolves.toMatchObject( {
			state: 'absent',
			checked: [
				{ location: '/etc/claude-code/managed-settings.json' },
				{ location: '/etc/claude-code/managed-settings.d' },
				{ location: '/etc/claude-code/managed-mcp.json' },
			],
		} );
		const mcp = linux();
		mcp.fs.write( '/etc/claude-code/managed-mcp.json', Buffer.from( '{}' ) );
		await expect( inspectClaudeManagedPolicy( mcp.seams ) ).resolves.toMatchObject( {
			state: 'present',
			present: [ { kind: 'mcp-file', location: '/etc/claude-code/managed-mcp.json' } ],
		} );
		const locked = linux();
		await expect(
			inspectClaudeManagedPolicy( {
				...locked.seams,
				files: denied( locked.fs.files, [ '/etc/claude-code' ] ).files,
			} )
		).resolves.toMatchObject( { state: 'unverifiable', unreadable: [ {}, {}, {} ] } );
	} );

	it( 'cannot vouch for a host outside the matrix', async () => {
		await expect(
			inspectClaudeManagedPolicy( { host: { platform: 'freebsd', arch: 'x64' } } )
		).resolves.toEqual( { state: 'unverifiable', present: [], unreadable: [], checked: [] } );
	} );
} );

const posixShell = (
	process.platform === 'win32'
		? [ 'C:\\Program Files\\Git\\usr\\bin\\sh.exe', 'C:\\Program Files\\Git\\bin\\sh.exe' ]
		: [ '/bin/sh' ]
).find( ( candidate ) => existsSync( candidate ) );

describe( 'Claude native sign-in launch', () => {
	const hostile = 'Claude Édition $HOME `whoami` "quoted" \'single\' [1] & | ;';

	it( 'opens the vendor login in a new Windows console through ShellExecute, with no path in the script', async () => {
		const executablePath = `C:\\Users\\Tester\\${ hostile }\\claude.exe`;
		const cwd = `C:\\Users\\Tester\\${ hostile }`;
		const env = { SystemRoot: 'C:\\Windows', CLAUDE_CONFIG_DIR: 'C:\\Users\\Tester\\.claude' };
		const runner = recordingRunner( () => '' );
		const { seams } = simulatedHost( { platform: 'win32', arch: 'x64' }, path.win32, {
			env: { SystemRoot: 'C:\\Windows' },
			run: runner.run,
		} );
		const plan = await planClaudeSignIn(
			{ executablePath, args: [ 'auth', 'login' ], cwd, env },
			seams
		);
		expect( plan ).toMatchObject( {
			state: 'ready',
			launch: {
				mode: 'run',
				file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
				env,
			},
		} );
		if ( plan.state !== 'ready' ) return;
		await expect( executeClaudeSignIn( plan.launch, seams ) ).resolves.toEqual( {
			state: 'launched',
		} );
		const script = decodedScript( runner.calls[ 0 ].args );
		expect( script ).toContain( 'System.Diagnostics.ProcessStartInfo' );
		expect( script ).toContain( '$i.UseShellExecute=$true' );
		expect( script ).toContain( "$i.Arguments='auth login'" );
		expect( script ).toContain( '[System.Diagnostics.ProcessWindowStyle]::Normal' );
		expect( script ).toContain( Buffer.from( executablePath, 'utf8' ).toString( 'base64' ) );
		expect( script ).toContain( Buffer.from( cwd, 'utf8' ).toString( 'base64' ) );
		expect( script ).not.toContain( 'Édition' );
		expect( script ).not.toContain( 'Start-Process' );
		expect( script ).not.toMatch( /wsl/i );
		expect( runner.calls[ 0 ].env ).toEqual( env );
	} );

	it( 'asks for the user’s action instead of opening an invisible Windows console', async () => {
		for ( const name of [ 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY' ] ) {
			const { seams } = simulatedHost( { platform: 'win32', arch: 'x64' }, path.win32, {
				env: { SystemRoot: 'C:\\Windows', [ name ]: '10.0.0.2 50000 10.0.0.1 22' },
			} );
			await expect(
				planClaudeSignIn(
					{ executablePath: 'C:\\c\\claude.exe', args: [ 'auth', 'login' ], cwd: 'C:\\', env: {} },
					seams
				)
			).resolves.toEqual( { state: 'user-action-needed', reason: 'no-interactive-desktop' } );
		}
	} );

	// Characters a login shell can act on: fish ends single quotes at \', csh
	// expands ! inside them, and the rest are quoting, expansion and option syntax.
	const shellHostile = '-lead \\\' ! $HOME `id` "q" [1] & | ; \nnext';
	const SHELL_INERT_PATH = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
	const posixQuote = ( value: string ) => `'${ value.replace( /'/g, "'\\''" ) }'`;
	const scriptFor = ( script: { directory: string; path: string }, cwd: string, argv: string[] ) =>
		[
			`/bin/rm -f -- ${ posixQuote( script.path ) }`,
			`/bin/rmdir -- ${ posixQuote( script.directory ) }`,
			`cd -- ${ posixQuote( cwd ) } || exit 1`,
			`exec ${ argv.map( posixQuote ).join( ' ' ) }`,
			'',
		].join( '\n' );
	const expectInert = ( parsed: string ) => {
		for ( const character of [ '\\', "'", '!', '$', '`', '\n', '"', ';', '&', '|' ] )
			expect( parsed, JSON.stringify( character ) ).not.toContain( character );
		expect( parsed ).not.toMatch( /(^|\s)-/ );
	};

	function macos(
		present: string[] = [ '/System/Applications/Utilities/Terminal.app', '/usr/bin/open' ],
		tempDirectory = '/var/folders/ab/T'
	) {
		const writes: Array< { directory: string; path: string; contents: string } > = [];
		const removed: string[] = [];
		const host = simulatedHost( { platform: 'darwin', arch: 'arm64' }, path.posix, {
			env: { HOME: '/Users/tester', PATH: '/usr/bin:/bin' },
			tempDirectory: () => tempDirectory,
			writePrivateScript: async ( script ) => {
				writes.push( script );
			},
			removePrivateScript: async ( directory ) => {
				removed.push( directory );
			},
		} );
		host.fs.directory( '/private/var/folders/ab/T' );
		host.fs.link( '/var', '/private/var' );
		host.fs.directory( '/private/tmp' );
		host.fs.link( '/tmp', '/private/tmp' );
		for ( const item of present ) host.fs.write( item, Buffer.from( 'x' ) );
		return { ...host, writes, removed };
	}

	it( 'has Terminal’s login shell parse only `exec /bin/sh` and a Studio-chosen script path on macOS', async () => {
		const executablePath = `/Users/tester/${ shellHostile }/claude`;
		const cwd = `/Users/tester/-${ shellHostile }`;
		const env = {
			HOME: '/Users/tester',
			PATH: '/usr/bin:/bin',
			LANG: `-${ shellHostile }`,
			CLAUDE_CONFIG_DIR: `/Users/tester/${ shellHostile }/config`,
		};
		const runner = recordingRunner( () => '' );
		const { seams, writes, removed } = macos();
		const plan = await planClaudeSignIn(
			{ executablePath, args: [ 'auth', 'login' ], cwd, env },
			{ ...seams, run: runner.run }
		);
		expect( plan.state ).toBe( 'ready' );
		if ( plan.state !== 'ready' || ! plan.launch.script ) throw new Error( 'expected a script' );
		const { script } = plan.launch;
		expect( script.directory ).toMatch(
			/^\/private\/var\/folders\/ab\/T\/studio-claude-sign-in-[0-9a-f]{16}$/
		);
		expect( script.path ).toBe( `${ script.directory }/sign-in.sh` );
		expect( plan.launch ).toMatchObject( { mode: 'run', file: '/usr/bin/osascript', env } );
		const appleScript = plan.launch.args.slice( 0, -1 );
		expect( appleScript.filter( ( _, index ) => index % 2 === 0 ) ).toEqual(
			appleScript.filter( ( _, index ) => index % 2 === 0 ).map( () => '-e' )
		);
		expect( appleScript ).toContain( 'do script "exec /bin/sh " & (item 1 of argv)' );
		expect( appleScript.join( '\n' ) ).not.toContain( 'quoted form of' );
		expect( plan.launch.args.at( -1 ) ).toBe( script.path );
		const parsed = `exec /bin/sh ${ script.path }`;
		expect( parsed ).toMatch( /^exec \/bin\/sh \/[A-Za-z0-9._/-]+$/ );
		expect( SHELL_INERT_PATH.test( script.path ) ).toBe( true );
		expectInert( parsed );
		expect( script.contents ).toBe(
			scriptFor( script, cwd, [
				'/usr/bin/env',
				'-i',
				`CLAUDE_CONFIG_DIR=/Users/tester/${ shellHostile }/config`,
				'HOME=/Users/tester',
				`LANG=-${ shellHostile }`,
				'PATH=/usr/bin:/bin',
				executablePath,
				'auth',
				'login',
			] )
		);

		await expect(
			executeClaudeSignIn( plan.launch, { ...seams, run: runner.run } )
		).resolves.toEqual( { state: 'launched' } );
		expect( writes ).toEqual( [ script ] );
		expect( runner.calls.map( ( { file, args } ) => [ file, args ] ) ).toEqual( [
			[ '/usr/bin/osascript', plan.launch.args ],
		] );
		expect( removed ).toEqual( [] );
	} );

	it( 'falls back to /tmp for a temporary directory a shell could parse, and refuses when none is safe', async () => {
		const request = {
			executablePath: '/Users/tester/claude',
			args: [ 'auth', 'login' ],
			cwd: '/Users/tester',
			env: {},
		};
		const quirky = macos( undefined, "/Users/tester/it's $TMP" );
		quirky.fs.directory( "/Users/tester/it's $TMP" );
		const plan = await planClaudeSignIn( request, quirky.seams );
		expect( plan.state === 'ready' && plan.launch.script?.directory ).toMatch(
			/^\/private\/tmp\/studio-claude-sign-in-[0-9a-f]{16}$/
		);
		const none = macos( undefined, '/missing' );
		none.fs.remove( '/tmp' );
		await expect( planClaudeSignIn( request, none.seams ) ).rejects.toThrow();
	} );

	it( 'asks for the user’s action on macOS without a display, Terminal, browser or Automation permission', async () => {
		const request = {
			executablePath: '/Users/tester/claude',
			args: [ 'auth', 'login' ],
			cwd: '/Users/tester',
			env: {},
		};
		const remote = macos();
		await expect(
			planClaudeSignIn( request, {
				...remote.seams,
				env: { SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22' },
			} )
		).resolves.toEqual( { state: 'user-action-needed', reason: 'no-display' } );
		await expect(
			planClaudeSignIn( request, macos( [ '/usr/bin/open' ] ).seams )
		).resolves.toEqual( {
			state: 'user-action-needed',
			reason: 'no-terminal',
		} );
		await expect(
			planClaudeSignIn( request, macos( [ '/System/Applications/Utilities/Terminal.app' ] ).seams )
		).resolves.toEqual( { state: 'user-action-needed', reason: 'no-browser' } );
		await expect(
			planClaudeSignIn( { ...request, executablePath: '/Users/tester/a=b/claude' }, macos().seams )
		).resolves.toEqual( { state: 'user-action-needed', reason: 'executable-path-unsupported' } );

		const denied = macos();
		const plan = await planClaudeSignIn( request, denied.seams );
		if ( plan.state !== 'ready' ) throw new Error( 'expected a plan' );
		await expect(
			executeClaudeSignIn( plan.launch, {
				...denied.seams,
				run: async () => {
					throw Object.assign( new Error( 'exit 1' ), {
						code: 1,
						stderr: 'execution error: Not authorized to send Apple events to Terminal. (-1743)',
					} );
				},
			} )
		).resolves.toEqual( { state: 'user-action-needed', reason: 'terminal-permission-denied' } );
		await expect(
			executeClaudeSignIn( plan.launch, {
				...denied.seams,
				run: async () => {
					throw Object.assign( new Error( 'exit 1' ), { code: 1, stderr: 'other failure' } );
				},
			} )
		).rejects.toThrow();
		expect( denied.writes ).toHaveLength( 2 );
		expect( denied.removed ).toEqual( [
			plan.launch.script?.directory,
			plan.launch.script?.directory,
		] );
	} );

	function linux(
		commands: string[],
		env: NodeJS.ProcessEnv = { DISPLAY: ':0' },
		launch: ( file: string ) => void = () => {}
	) {
		const launches: Array< { file: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string } > =
			[];
		const writes: Array< { directory: string; path: string; contents: string } > = [];
		const removed: string[] = [];
		const host = simulatedHost( { platform: 'linux', arch: 'x64' }, path.posix, {
			env,
			findOnPath: ( command ) => ( commands.includes( command ) ? `/usr/bin/${ command }` : null ),
			launchDetached: async ( file, args, options ) => {
				launch( file );
				launches.push( { file, args, ...options } );
			},
			tempDirectory: () => '/tmp',
			writePrivateScript: async ( script ) => {
				writes.push( script );
			},
			removePrivateScript: async ( directory ) => {
				removed.push( directory );
			},
		} );
		host.fs.directory( '/tmp' );
		return { ...host, launches, writes, removed };
	}

	it( 'gives every Linux terminal only `/bin/sh` and a Studio-chosen script path, which runs the login in a cleared environment', async () => {
		const executablePath = `/home/tester/${ shellHostile }/claude`;
		const cwd = `/home/tester/-${ shellHostile }`;
		const env = {
			HOME: '/home/tester',
			DISPLAY: ':0',
			LANG: `-${ shellHostile }`,
			CLAUDE_CONFIG_DIR: '/home/tester/.claude',
		};
		for ( const terminal of [ 'gnome-terminal', 'x-terminal-emulator', 'konsole', 'xterm' ] ) {
			const { seams, launches, writes } = linux( [ terminal, 'xdg-open' ], {
				WAYLAND_DISPLAY: 'wayland-0',
			} );
			const plan = await planClaudeSignIn(
				{ executablePath, args: [ 'auth', 'login' ], cwd, env },
				seams
			);
			if ( plan.state !== 'ready' || ! plan.launch.script ) throw new Error( 'expected a script' );
			const { script } = plan.launch;
			expect( script.directory ).toMatch( /^\/tmp\/studio-claude-sign-in-[0-9a-f]{16}$/ );
			expect( plan.launch ).toMatchObject( {
				mode: 'detached',
				file: `/usr/bin/${ terminal }`,
				env,
				cwd: '/tmp',
			} );
			expect( plan.launch.args.slice( -2 ), terminal ).toEqual( [ '/bin/sh', script.path ] );
			for ( const argument of plan.launch.args )
				expect( argument, terminal ).toMatch( /^[A-Za-z0-9._/=:-]+$/ );
			expectInert( plan.launch.args.slice( -2 ).join( ' ' ) );
			expect( script.contents ).toBe(
				scriptFor( script, cwd, [
					'/usr/bin/env',
					'-i',
					'CLAUDE_CONFIG_DIR=/home/tester/.claude',
					'DISPLAY=:0',
					'HOME=/home/tester',
					`LANG=-${ shellHostile }`,
					executablePath,
					'auth',
					'login',
				] )
			);
			await expect( executeClaudeSignIn( plan.launch, seams ) ).resolves.toEqual( {
				state: 'launched',
			} );
			expect( writes ).toEqual( [ script ] );
			expect( launches ).toEqual( [
				{ file: plan.launch.file, args: plan.launch.args, env, cwd: '/tmp' },
			] );
		}
		const failing = linux( [ 'xterm', 'xdg-open' ], undefined, () => {
			throw new Error( 'spawn EACCES' );
		} );
		const plan = await planClaudeSignIn(
			{ executablePath, args: [ 'auth', 'login' ], cwd, env },
			failing.seams
		);
		if ( plan.state !== 'ready' ) throw new Error( 'expected a plan' );
		await expect( executeClaudeSignIn( plan.launch, failing.seams ) ).rejects.toThrow();
		expect( failing.removed ).toEqual( [ plan.launch.script?.directory ] );
	} );

	it.skipIf( ! posixShell )(
		`parses every quoted value back exactly in a real POSIX shell (${
			posixShell ?? 'skipped: no POSIX sh on this machine'
		})`,
		async () => {
			const { writes, seams } = linux( [ 'xterm', 'xdg-open' ] );
			const values = [
				shellHostile,
				`-${ shellHostile }`,
				"'",
				"\\'",
				'!!',
				'$(id)',
				'a\nb\n',
				'',
				'Édition',
			];
			const plan = await planClaudeSignIn(
				{
					executablePath: `/home/tester/${ shellHostile }/claude`,
					args: [ 'auth', 'login' ],
					cwd: `/home/tester/-${ shellHostile }`,
					env: Object.fromEntries( values.map( ( value, index ) => [ `V${ index }`, value ] ) ),
				},
				seams
			);
			if ( plan.state !== 'ready' ) throw new Error( 'expected a plan' );
			await executeClaudeSignIn( plan.launch, seams );
			const { contents } = writes[ 0 ];
			const words = contents.slice( contents.indexOf( '\nexec ' ) + '\nexec '.length );
			const directory = await mkdtemp( path.join( os.tmpdir(), 'studio-claude-quoting-' ) );
			try {
				const probe = path.join( directory, 'probe.sh' );
				await writeFile( probe, `printf '%s\\0' ${ words }` );
				const { execFile } = await import( 'child_process' );
				const { promisify } = await import( 'util' );
				const { stdout } = await promisify( execFile )( posixShell!, [ probe ], {
					encoding: 'utf8',
					windowsHide: true,
				} );
				expect( stdout.split( '\0' ).slice( 0, -1 ) ).toEqual( [
					'/usr/bin/env',
					'-i',
					...values.map( ( value, index ) => `V${ index }=${ value }` ).sort(),
					`/home/tester/${ shellHostile }/claude`,
					'auth',
					'login',
				] );
			} finally {
				await rm( directory, { recursive: true, force: true } );
			}
		}
	);

	it( 'writes the script exclusively, never through an existing entry, and only its owner can enter the folder', async () => {
		const base = await realpath(
			await mkdtemp( path.join( os.tmpdir(), 'studio-claude-script-' ) )
		);
		try {
			const { writePrivateScript, removePrivateScript } = defaultClaudePlatformSeams();
			const directory = path.join( base, 'studio-claude-sign-in-0123456789abcdef' );
			const script = {
				directory,
				path: path.join( directory, 'sign-in.sh' ),
				contents: 'exit 0\n',
			};
			await writePrivateScript( script );
			await expect( readFile( script.path, 'utf8' ) ).resolves.toBe( 'exit 0\n' );
			if ( process.platform !== 'win32' ) {
				const { stat } = await import( 'fs/promises' );
				expect( ( await stat( directory ) ).mode & 0o777 ).toBe( 0o700 );
				expect( ( await stat( script.path ) ).mode & 0o077 ).toBe( 0 );
			}
			await expect( writePrivateScript( script ) ).rejects.toMatchObject( { code: 'EEXIST' } );
			await removePrivateScript( directory );
			await mkdir( directory );
			await expect( writePrivateScript( script ) ).rejects.toMatchObject( { code: 'EEXIST' } );
			expect( existsSync( directory ) ).toBe( true );
			await rm( directory, { recursive: true } );
			const elsewhere = path.join( base, 'elsewhere' );
			await mkdir( elsewhere );
			await symlink( elsewhere, directory, 'junction' );
			await expect( writePrivateScript( script ) ).rejects.toMatchObject( { code: 'EEXIST' } );
			await expect( readFile( path.join( elsewhere, 'sign-in.sh' ) ) ).rejects.toMatchObject( {
				code: 'ENOENT',
			} );
			const abandoned = path.join( base, 'studio-claude-sign-in-fedcba9876543210' );
			await expect(
				writePrivateScript( {
					directory: abandoned,
					path: path.join( base, 'missing', 'sign-in.sh' ),
					contents: '',
				} )
			).rejects.toMatchObject( { code: 'ENOENT' } );
			expect( existsSync( abandoned ) ).toBe( false );
		} finally {
			await rm( base, { recursive: true, force: true, maxRetries: 4 } );
		}
	} );

	it( 'asks for the user’s action on Linux without a display, a terminal or a browser opener', async () => {
		const request = {
			executablePath: '/home/tester/claude',
			args: [ 'auth', 'login' ],
			cwd: '/home/tester',
			env: {},
		};
		for ( const [ commands, env, reason ] of [
			[ [ 'xterm', 'xdg-open' ], {}, 'no-display' ],
			[ [ 'xdg-open' ], { DISPLAY: ':0' }, 'no-terminal' ],
			[ [ 'tilix', 'xdg-open' ], { DISPLAY: ':0' }, 'no-terminal' ],
			[ [ 'xterm' ], { WAYLAND_DISPLAY: 'wayland-0' }, 'no-browser' ],
		] as const ) {
			const { seams, launches } = linux( [ ...commands ], env );
			await expect( planClaudeSignIn( request, seams ), reason ).resolves.toEqual( {
				state: 'user-action-needed',
				reason,
			} );
			expect( launches ).toEqual( [] );
		}
	} );
} );

describe( 'Claude shell sandbox facts', () => {
	it( 'records, as plain data from the vendor sources, whether shell commands can be confined on each OS', () => {
		const windows = claudeShellSandbox( { platform: 'win32', arch: 'x64' } )!;
		expect( windows ).toMatchObject( { available: false, requires: [] } );
		expect( windows.sources.join( ' ' ) ).toContain( 'code.claude.com/docs/en/sandboxing' );
		expect( claudeShellSandbox( { platform: 'win32', arch: 'arm64' } ) ).toEqual( windows );

		const macos = claudeShellSandbox( { platform: 'darwin', arch: 'arm64' } )!;
		expect( macos ).toMatchObject( { available: true, mechanism: 'seatbelt', requires: [] } );

		const linux = claudeShellSandbox( { platform: 'linux', arch: 'x64' } )!;
		expect( linux ).toMatchObject( {
			available: true,
			mechanism: 'bubblewrap',
			requires: [ 'bubblewrap', 'socat' ],
		} );
		expect( linux.limitations ).toEqual(
			expect.arrayContaining( [ 'ubuntu-apparmor-user-namespaces', 'unprivileged-container-proc' ] )
		);
		for ( const fact of [ windows, macos, linux ] ) {
			expect( JSON.parse( JSON.stringify( fact ) ) ).toEqual( fact );
			expect( Object.isFrozen( fact ) ).toBe( true );
			expect( fact.sources.length ).toBeGreaterThan( 0 );
		}
		expect( claudeShellSandbox( { platform: 'freebsd', arch: 'x64' } ) ).toBeUndefined();
	} );
} );
