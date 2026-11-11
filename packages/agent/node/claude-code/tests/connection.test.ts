import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSameClaudeAccount } from '../auth-status';
import {
	readClaudeAccountStatus,
	resolveClaudeConfigContext,
	resolveClaudeProjectsDirectory,
} from '../connection';
import { memoryFileSystem, sha256, simulatedHost } from './fixtures/native-binaries';

describe( 'Claude config context', () => {
	it( 'preserves default mode and blocks conflicting inherited directories', async () => {
		await expect( resolveClaudeConfigContext( undefined, {} ) ).resolves.toEqual( {
			mode: 'default',
		} );
		await expect(
			resolveClaudeConfigContext( 'C:\\selected', { CLAUDE_CONFIG_DIR: 'C:\\other' } )
		).resolves.toEqual( { mode: 'conflict' } );
	} );

	it( 'treats an inherited directory as the selected one only when the filesystem says so', async () => {
		const windows = simulatedHost(
			{ platform: 'win32', arch: 'x64' },
			path.win32,
			{},
			{
				caseInsensitive: [ 'C:\\' ],
			}
		);
		windows.fs.directory( 'C:\\Users\\Tester\\Claude Profile' );
		await expect(
			resolveClaudeConfigContext(
				'C:\\Users\\Tester\\Claude Profile',
				{ claude_config_dir: 'c:\\users\\tester\\claude profile' },
				windows.seams
			)
		).resolves.toEqual( { mode: 'explicit', directory: 'C:\\Users\\Tester\\Claude Profile' } );

		const linux = simulatedHost( { platform: 'linux', arch: 'x64' }, path.posix );
		linux.fs.directory( '/home/tester/Claude' );
		linux.fs.directory( '/home/tester/claude' );
		linux.fs.link( '/home/tester/profile', '/home/tester/Claude' );
		await expect(
			resolveClaudeConfigContext(
				'/home/tester/Claude',
				{ CLAUDE_CONFIG_DIR: '/home/tester/claude' },
				linux.seams
			)
		).resolves.toEqual( { mode: 'conflict' } );
		await expect(
			resolveClaudeConfigContext(
				'/home/tester/Claude',
				{ CLAUDE_CONFIG_DIR: '/home/tester/profile' },
				linux.seams
			)
		).resolves.toEqual( { mode: 'explicit', directory: '/home/tester/Claude' } );
		await expect(
			resolveClaudeConfigContext(
				'/home/tester/Claude',
				{ claude_config_dir: '/home/tester/claude' },
				linux.seams
			)
		).resolves.toEqual( { mode: 'explicit', directory: '/home/tester/Claude' } );
	} );
} );

describe( 'Claude projects directory identity', () => {
	it( 'accepts a reported projects folder that differs only in case on a case-insensitive volume', async () => {
		const { fs, seams } = simulatedHost(
			{ platform: 'win32', arch: 'x64' },
			path.win32,
			{},
			{
				caseInsensitive: [ 'C:\\' ],
			}
		);
		fs.directory( 'C:\\Users\\Tester\\.claude' );
		await expect(
			resolveClaudeProjectsDirectory(
				'C:\\Users\\Tester\\.claude',
				'c:\\users\\tester\\.CLAUDE\\Projects',
				seams
			)
		).resolves.toBe( 'C:\\Users\\Tester\\.claude\\projects' );
		fs.directory( 'C:\\Users\\Tester\\.claude\\Projects' );
		await expect(
			resolveClaudeProjectsDirectory(
				'C:\\Users\\Tester\\.claude',
				'c:\\users\\tester\\.claude\\projects',
				seams
			)
		).resolves.toBe( 'C:\\Users\\Tester\\.claude\\Projects' );
	} );

	it( 'refuses a case variant on Linux and a projects folder that leads elsewhere', async () => {
		const { fs, seams } = simulatedHost( { platform: 'linux', arch: 'x64' }, path.posix );
		fs.directory( '/home/tester/.claude' );
		fs.directory( '/home/tester/elsewhere' );
		await expect(
			resolveClaudeProjectsDirectory(
				'/home/tester/.claude',
				'/home/tester/.claude/Projects',
				seams
			)
		).rejects.toThrow();
		await expect(
			resolveClaudeProjectsDirectory(
				'/home/tester/.claude',
				'/home/tester/.claude/projects',
				seams
			)
		).resolves.toBe( '/home/tester/.claude/projects' );
		fs.link( '/home/tester/.claude/projects', '/home/tester/elsewhere' );
		await expect(
			resolveClaudeProjectsDirectory(
				'/home/tester/.claude',
				'/home/tester/.claude/projects',
				seams
			)
		).rejects.toThrow();
	} );
} );

describe( 'Claude account status', () => {
	afterEach( () => vi.unstubAllEnvs() );
	// Inherited routing variables would make every read unverifiable.
	const isolate = () => {
		for ( const name of Object.keys( process.env ) )
			if ( /^(ANTHROPIC_|AWS_|GOOGLE_|AZURE_|CLAUDE_)|_PROXY$/i.test( name ) )
				vi.stubEnv( name, '' );
	};
	const signedIn = {
		loggedIn: true,
		authMethod: 'claude.ai',
		apiProvider: 'firstParty',
		storedClaudeAiLogin: true,
		subscriptionType: 'max',
		email: 'user@example.com',
		orgName: 'Studio',
	};
	const selected = '/home/tester/.local/bin/claude';
	const inspected = '/home/tester/.local/share/claude/versions/2.1.319';
	async function prepared() {
		const disk = memoryFileSystem( path.posix );
		disk.write( inspected, Buffer.from( 'inspected binary' ) );
		disk.link( selected, inspected );
		const found = await disk.files.stat( inspected );
		const request = {
			selectedPath: selected,
			executablePath: inspected,
			executableIdentity: {
				path: inspected,
				size: found.size,
				device: found.device,
				inode: found.inode,
				modified: found.modified,
				changed: found.changed,
				sha256: sha256( Buffer.from( 'inspected binary' ) ),
			},
			cwd: process.cwd(),
		};
		return { disk, request };
	}
	type Runner = NonNullable< Parameters< typeof readClaudeAccountStatus >[ 1 ] >[ 'run' ];
	const read = async ( run: Runner ) => {
		const { disk, request } = await prepared();
		return readClaudeAccountStatus( request, { run, files: disk.files } );
	};

	it( 'reads the signed-in account through `claude auth status` with the prepared binary', async () => {
		isolate();
		const run = vi.fn( async () => ( { stdout: JSON.stringify( signedIn ) } ) );
		await expect( read( run ) ).resolves.toEqual( {
			state: 'signed-in',
			identity: { email: 'user@example.com', organization: 'Studio', subscriptionType: 'max' },
		} );
		expect( run ).toHaveBeenCalledWith(
			inspected,
			[ 'auth', 'status', '--json' ],
			expect.objectContaining( { timeout: expect.any( Number ) } )
		);
	} );

	it( 'runs nothing when the selected path no longer leads to the prepared, unchanged binary', async () => {
		isolate();
		const changes: Array< [ string, ( disk: ReturnType< typeof memoryFileSystem > ) => void ] > = [
			[
				're-pointed launcher',
				( disk ) => {
					disk.write( '/home/tester/.local/share/claude/versions/2.1.320', Buffer.from( 'next' ) );
					disk.link( selected, '/home/tester/.local/share/claude/versions/2.1.320' );
				},
			],
			[ 'replaced file', ( disk ) => disk.write( inspected, Buffer.from( 'replaced binary' ) ) ],
			[
				'edited in place',
				( disk ) => disk.write( inspected, Buffer.from( 'inspected binary' ), { inPlace: true } ),
			],
			[ 'removed file', ( disk ) => disk.remove( inspected ) ],
		];
		for ( const [ name, change ] of changes ) {
			const { disk, request } = await prepared();
			change( disk );
			const run = vi.fn( async () => ( { stdout: JSON.stringify( signedIn ) } ) );
			await expect(
				readClaudeAccountStatus( request, { run, files: disk.files } ),
				name
			).resolves.toEqual( { state: 'unavailable' } );
			expect( run, name ).not.toHaveBeenCalled();
		}
		const { disk, request } = await prepared();
		const run = vi.fn( async () => ( { stdout: JSON.stringify( signedIn ) } ) );
		await expect(
			readClaudeAccountStatus(
				{ ...request, executablePath: selected },
				{ run, files: disk.files }
			)
		).resolves.toEqual( { state: 'unavailable' } );
		expect( run ).not.toHaveBeenCalled();
	} );

	it( 'discards a status read while the prepared binary was being replaced', async () => {
		isolate();
		const { disk, request } = await prepared();
		const run = vi.fn( async () => {
			disk.write( inspected, Buffer.from( 'auto-updated binary' ) );
			return { stdout: JSON.stringify( signedIn ) };
		} );
		await expect( readClaudeAccountStatus( request, { run, files: disk.files } ) ).resolves.toEqual(
			{ state: 'unavailable' }
		);
		expect( run ).toHaveBeenCalledOnce();
	} );

	it( 'tells a signed-out or unqualified account apart from a status it could not read', async () => {
		isolate();
		const signedOut = Object.assign( new Error( 'exit 1' ), {
			code: 1,
			stdout: JSON.stringify( { loggedIn: false } ),
		} );
		await expect(
			read( async () => {
				throw signedOut;
			} )
		).resolves.toEqual( { state: 'not-qualified' } );
		await expect(
			read( async () => ( { stdout: JSON.stringify( { ...signedIn, authMethod: 'api-key' } ) } ) )
		).resolves.toEqual( { state: 'not-qualified' } );
		for ( const failure of [
			async () => ( { stdout: 'not json' } ),
			async () => {
				throw Object.assign( new Error( 'timed out' ), { killed: true, code: null } );
			},
			async () => {
				throw Object.assign( new Error( 'exit 2' ), { code: 2, stdout: '' } );
			},
		] )
			await expect( read( failure ) ).resolves.toEqual( { state: 'unavailable' } );
		vi.stubEnv( 'ANTHROPIC_BASE_URL', 'https://gateway.example' );
		await expect( read( async () => ( { stdout: JSON.stringify( signedIn ) } ) ) ).resolves.toEqual(
			{ state: 'unavailable' }
		);
	} );

	it( 'compares accounts by address, organization and plan', () => {
		const account = { email: 'User@Example.com', organization: 'Studio', subscriptionType: 'max' };
		expect(
			isSameClaudeAccount( account, {
				...account,
				email: 'user@example.com',
				subscriptionType: 'Claude Max',
			} )
		).toBe( true );
		expect( isSameClaudeAccount( account, { ...account, email: 'other@example.com' } ) ).toBe(
			false
		);
		expect( isSameClaudeAccount( account, { ...account, organization: 'Other' } ) ).toBe( false );
		expect( isSameClaudeAccount( account, { ...account, subscriptionType: 'pro' } ) ).toBe( false );
		expect( isSameClaudeAccount( { ...account, email: undefined }, account ) ).toBe( false );
	} );
} );
