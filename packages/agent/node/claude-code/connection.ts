import { execFile } from 'child_process';
import { lstat, realpath, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { readSharedConfig, updateSharedConfigFrom } from '@studio/common/lib/shared-config';
import { assessClaudeAuth, buildClaudeEnvironment } from './auth-status';
import { inspectClaudeConfiguration } from './configuration';
import { inspectClaudeExecutable, trustedPowerShellPath } from './discovery';

const execFileAsync = promisify( execFile );

export { inspectClaudeConfiguration } from './configuration';
async function inspectManagedPolicy(): Promise< boolean > {
	if ( process.platform !== 'win32' || ! process.env.ProgramFiles ) return false;
	try {
		const script = `$ErrorActionPreference='Stop'; if ((Test-Path 'HKLM:\\SOFTWARE\\Policies\\ClaudeCode') -or (Test-Path 'HKCU:\\SOFTWARE\\Policies\\ClaudeCode')) { exit 1 }`;
		await execFileAsync(
			trustedPowerShellPath(),
			[
				'-NoProfile',
				'-NonInteractive',
				'-EncodedCommand',
				Buffer.from( script, 'utf16le' ).toString( 'base64' ),
			],
			{ env: buildClaudeEnvironment( process.env ).env, timeout: 10000, windowsHide: true }
		);
		for ( const name of [ 'managed-settings.json', 'managed-settings.d', 'managed-mcp.json' ] ) {
			try {
				await lstat( path.join( process.env.ProgramFiles, 'ClaudeCode', name ) );
				return false;
			} catch ( error ) {
				if ( ( error as NodeJS.ErrnoException ).code !== 'ENOENT' ) return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}
export type ClaudeConnection = { id: string; executablePath: string; configDirectory?: string };
function connections( value: unknown ): ClaudeConnection[] {
	if ( ! Array.isArray( value ) ) return [];
	return value
		.filter(
			( item ): item is ClaudeConnection =>
				!! item &&
				typeof item === 'object' &&
				typeof item.id === 'string' &&
				typeof item.executablePath === 'string' &&
				( item.configDirectory === undefined || typeof item.configDirectory === 'string' )
		)
		.map( ( item ) => ( {
			id: item.id,
			executablePath: item.executablePath,
			...( item.configDirectory === undefined ? {} : { configDirectory: item.configDirectory } ),
		} ) );
}
function retiredIds( value: unknown ): string[] {
	return Array.isArray( value )
		? value.filter( ( item ): item is string => typeof item === 'string' )
		: [];
}
export function resolveClaudeConfigContext(
	selected: string | undefined,
	env: NodeJS.ProcessEnv
): { mode: 'default' | 'explicit' | 'conflict'; directory?: string } {
	const inherited = Object.entries( env ).find(
		( [ key ] ) => key.toUpperCase() === 'CLAUDE_CONFIG_DIR'
	)?.[ 1 ];
	if ( selected && ! path.isAbsolute( selected ) ) return { mode: 'conflict' };
	if (
		selected &&
		inherited &&
		path.resolve( selected ).toLowerCase() !== path.resolve( inherited ).toLowerCase()
	)
		return { mode: 'conflict' };
	const directory = selected ?? inherited;
	return directory ? { mode: 'explicit', directory } : { mode: 'default' };
}
export async function resolveClaudeProjectsDirectory(
	configDirectory: string,
	reported: string
): Promise< string > {
	const expected = path.join( configDirectory, 'projects' );
	if (
		! path.isAbsolute( reported ) ||
		path.resolve( reported ).toLowerCase() !== expected.toLowerCase()
	)
		throw new Error( 'Unexpected projects directory' );
	try {
		const canonical = await realpath( reported );
		if (
			canonical.toLowerCase() !== expected.toLowerCase() ||
			! ( await stat( canonical ) ).isDirectory()
		)
			throw new Error( 'Unexpected projects directory' );
		return canonical;
	} catch ( error ) {
		if ( ( error as NodeJS.ErrnoException ).code === 'ENOENT' ) return expected;
		throw error;
	}
}
async function readNativeStatus(
	executablePath: string,
	cwd: string,
	env: NodeJS.ProcessEnv
): Promise< Record< string, unknown > > {
	let stdout: string;
	try {
		( { stdout } = await execFileAsync( executablePath, [ 'auth', 'status', '--json' ], {
			cwd,
			env,
			timeout: 10000,
			maxBuffer: 65536,
			windowsHide: true,
		} ) );
	} catch ( error ) {
		const failure = error as { code?: unknown; stdout?: unknown; killed?: boolean };
		if ( failure.code !== 1 || failure.killed || typeof failure.stdout !== 'string' ) throw error;
		stdout = failure.stdout;
	}
	const status: unknown = JSON.parse( stdout );
	if ( ! status || typeof status !== 'object' || Array.isArray( status ) )
		throw new Error( 'Invalid auth status' );
	return status as Record< string, unknown >;
}

// Internal only: callers must finish the SDK account and inventory checks before sending a prompt.
export async function prepareClaudeInvocation(
	executablePath: string,
	cwd: string,
	configDirectory?: string
) {
	if ( process.env.STUDIO_EXPERIMENTAL_CLAUDE_CODE !== '1' )
		return { ok: false as const, blockers: [ 'experimental-feature-disabled' ] };
	const child = buildClaudeEnvironment( process.env );
	const context = resolveClaudeConfigContext( configDirectory, process.env );
	if ( child.conflicts.length )
		return {
			ok: false as const,
			blockers: child.conflicts.map( ( name ) => `environment:${ name }` ),
		};
	if ( context.mode === 'conflict' )
		return { ok: false as const, blockers: [ 'config-directory-conflict' ] };
	try {
		const canonicalCwd = await realpath( cwd );
		if ( ! ( await stat( canonicalCwd ) ).isDirectory() ) throw new Error();
		const resolvedConfig = await realpath(
			context.directory ?? path.join( os.homedir(), '.claude' )
		);
		if ( ! ( await stat( resolvedConfig ) ).isDirectory() ) throw new Error();
		const configuration = await inspectClaudeConfiguration( canonicalCwd, resolvedConfig );
		if ( ! ( await inspectManagedPolicy() ) )
			configuration.blockers.push( 'managed-policy-unverified' );
		if ( configuration.blockers.length )
			return {
				ok: false as const,
				blockers: configuration.blockers,
				findings: configuration.findings,
			};
		const executable = await inspectClaudeExecutable( executablePath );
		if ( ! executable.ok )
			return { ok: false as const, blockers: [ executable.reason ], executable };
		if ( context.mode === 'explicit' ) child.env.CLAUDE_CONFIG_DIR = context.directory;
		const status = await readNativeStatus( executable.executablePath, canonicalCwd, child.env );
		if ( ! assessClaudeAuth( status ).qualified )
			return {
				ok: false as const,
				blockers: [ 'native-auth-unqualified' ],
				executable,
				auth: {
					qualified: false,
					method: typeof status.authMethod === 'string' ? status.authMethod : undefined,
				},
			};
		if (
			typeof status.configDirectory !== 'string' ||
			typeof status.projectsDirectory !== 'string' ||
			! path.isAbsolute( status.configDirectory ) ||
			! path.isAbsolute( status.projectsDirectory )
		)
			return { ok: false as const, blockers: [ 'native-paths-unqualified' ], executable };
		if (
			( await realpath( status.configDirectory ) ).toLowerCase() !== resolvedConfig.toLowerCase()
		)
			return { ok: false as const, blockers: [ 'config-directory-mismatch' ], executable };
		const projectsDirectory = await resolveClaudeProjectsDirectory(
			resolvedConfig,
			status.projectsDirectory
		);
		const identity = {
			email: typeof status.email === 'string' ? status.email : undefined,
			organization: typeof status.orgName === 'string' ? status.orgName : undefined,
		};
		return {
			ok: true as const,
			executablePath: executable.executablePath,
			cwd: canonicalCwd,
			configDirectory: resolvedConfig,
			configMode: context.mode,
			projectsDirectory,
			env: child.env,
			identity,
			version: executable.version,
			findings: configuration.findings,
		};
	} catch {
		return { ok: false as const, blockers: [ 'preflight-unavailable' ] };
	}
}

export async function inspectClaudeConnection( executablePath: string, configDirectory?: string ) {
	const result = await prepareClaudeInvocation( executablePath, process.cwd(), configDirectory );
	if ( ! result.ok ) return { ...result, qualified: false as const };
	return {
		qualified: false as const,
		executable: {
			ok: true as const,
			executablePath: result.executablePath,
			version: result.version,
			platform: process.platform,
			architecture: process.arch,
		},
		config: { mode: result.configMode, directory: result.configDirectory },
		auth: { qualified: true, method: 'claude.ai' },
		findings: result.findings,
		blockers: [ 'runtime-inventory-unverified' ],
	};
}
export async function getClaudeConnections(): Promise< ClaudeConnection[] > {
	return connections( ( await readSharedConfig() ).claudeConnections );
}
export async function saveClaudeConnection( connection: ClaudeConnection ): Promise< void > {
	if (
		! connection.id ||
		! path.isAbsolute( connection.executablePath ) ||
		( connection.configDirectory && ! path.isAbsolute( connection.configDirectory ) )
	)
		throw new Error( 'Invalid Claude connection' );
	await updateSharedConfigFrom( ( config ) => {
		const existing = connections( config.claudeConnections );
		const previous = existing.find( ( item ) => item.id === connection.id );
		if (
			retiredIds( config.claudeConnectionRetiredIds ).includes( connection.id ) ||
			( previous &&
				( previous.executablePath !== connection.executablePath ||
					previous.configDirectory !== connection.configDirectory ) )
		)
			throw new Error( 'Claude connection ID cannot be reused' );
		return {
			claudeConnections: previous
				? existing
				: [
						...existing,
						{
							id: connection.id,
							executablePath: connection.executablePath,
							...( connection.configDirectory
								? { configDirectory: connection.configDirectory }
								: {} ),
						},
				  ],
		};
	} );
}
export async function disconnectClaudeConnection( connectionId: string ): Promise< void > {
	await updateSharedConfigFrom( ( config ) => {
		const existing = connections( config.claudeConnections );
		const retired = retiredIds( config.claudeConnectionRetiredIds );
		return {
			claudeConnections: existing.filter( ( item ) => item.id !== connectionId ),
			claudeConnectionRetiredIds: existing.some( ( item ) => item.id === connectionId )
				? [ ...new Set( [ ...retired, connectionId ] ) ]
				: retired,
		};
	} );
}
export async function openClaudeNativeSignIn( connectionId: string ): Promise< void > {
	if ( process.env.STUDIO_EXPERIMENTAL_CLAUDE_CODE !== '1' )
		throw new Error( 'Claude Code is disabled' );
	const connection = connections( ( await readSharedConfig() ).claudeConnections ).find(
		( item ) => item.id === connectionId
	);
	if ( ! connection ) throw new Error( 'Unknown Claude connection' );
	const executable = await inspectClaudeExecutable( connection.executablePath );
	const child = buildClaudeEnvironment( process.env );
	const config = resolveClaudeConfigContext( connection.configDirectory, process.env );
	if ( ! executable.ok || child.conflicts.length || config.mode === 'conflict' )
		throw new Error( 'Claude connection is not qualified for sign-in' );
	const configuration = await inspectClaudeConfiguration(
		process.cwd(),
		config.directory ?? path.join( os.homedir(), '.claude' )
	);
	if ( configuration.blockers.length || ! ( await inspectManagedPolicy() ) )
		throw new Error( 'Claude configuration is not qualified for sign-in' );
	if ( config.mode === 'explicit' ) child.env.CLAUDE_CONFIG_DIR = config.directory;
	const encodedPath = Buffer.from( executable.executablePath, 'utf8' ).toString( 'base64' );
	const script = `Start-Process -FilePath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${ encodedPath }'))) -ArgumentList @('auth','login')`;
	await execFileAsync(
		trustedPowerShellPath(),
		[
			'-NoProfile',
			'-NonInteractive',
			'-EncodedCommand',
			Buffer.from( script, 'utf16le' ).toString( 'base64' ),
		],
		{ env: child.env, timeout: 10000, windowsHide: true }
	);
}
