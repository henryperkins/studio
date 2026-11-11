import { execFile } from 'child_process';
import { realpath, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { readSharedConfig, updateSharedConfigFrom } from '@studio/common/lib/shared-config';
import { assessClaudeAuth, buildClaudeEnvironment } from './auth-status';
import { inspectClaudeConfiguration } from './configuration';
import { inspectClaudeExecutable } from './discovery';
import {
	claudeEnvironmentValues,
	claudePathModule,
	currentClaudeHost,
	defaultClaudePlatformSeams,
	executeClaudeSignIn,
	inspectClaudeManagedPolicy,
	isSameClaudePath,
	isSameClaudePathText,
	planClaudeSignIn,
	resolveClaudePathKey,
	verifyClaudeExecutableIdentity,
} from './platform';
import type { ClaudeAuthIdentity } from './auth-status';
import type { ClaudeExecutableReason } from './discovery';
import type {
	ClaudeExecutableIdentity,
	ClaudeFileAccess,
	ClaudePlatformSeams,
	ClaudeSignInResult,
} from './platform';

const execFileAsync = promisify( execFile );

export { inspectClaudeConfiguration } from './configuration';
// `revision` moves each time Studio re-establishes the connection's sign-in; a
// record that has never been re-established is at revision 1.
export type ClaudeConnection = {
	id: string;
	executablePath: string;
	configDirectory?: string;
	revision?: number;
};
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
			...( Number.isSafeInteger( item.revision ) && ( item.revision as number ) > 1
				? { revision: item.revision }
				: {} ),
		} ) );
}

export function claudeConnectionRevision(
	connection: Pick< ClaudeConnection, 'revision' >
): number {
	return connection.revision ?? 1;
}
function retiredIds( value: unknown ): string[] {
	return Array.isArray( value )
		? value.filter( ( item ): item is string => typeof item === 'string' )
		: [];
}
export async function resolveClaudeConfigContext(
	selected: string | undefined,
	env: NodeJS.ProcessEnv,
	overrides: Partial< ClaudePlatformSeams > = {}
): Promise< { mode: 'default' | 'explicit' | 'conflict'; directory?: string } > {
	const host = overrides.host ?? currentClaudeHost();
	const inheritedValues = claudeEnvironmentValues( env, 'CLAUDE_CONFIG_DIR', host );
	if ( inheritedValues.length > 1 ) return { mode: 'conflict' };
	const [ inherited ] = inheritedValues;
	if ( selected && ! claudePathModule( host ).isAbsolute( selected ) ) return { mode: 'conflict' };
	if ( selected && inherited && ! ( await isSameClaudePath( selected, inherited, overrides ) ) )
		return { mode: 'conflict' };
	const directory = selected ?? inherited;
	return directory ? { mode: 'explicit', directory } : { mode: 'default' };
}
export async function resolveClaudeProjectsDirectory(
	configDirectory: string,
	reported: string,
	overrides: Partial< ClaudePlatformSeams > = {}
): Promise< string > {
	const seams = defaultClaudePlatformSeams( overrides );
	const pathModule = claudePathModule( seams.host );
	const expected = pathModule.join( configDirectory, 'projects' );
	if (
		! pathModule.isAbsolute( reported ) ||
		! ( await isSameClaudePath( reported, expected, seams ) )
	)
		throw new Error( 'Unexpected projects directory' );
	let canonical: string;
	try {
		canonical = await seams.files.realpath( reported );
	} catch ( error ) {
		if ( ( error as NodeJS.ErrnoException ).code === 'ENOENT' ) return expected;
		throw error;
	}
	// The folder must be the configuration directory's own entry, not a link elsewhere.
	const { caseSensitive } = await resolveClaudePathKey( configDirectory, seams );
	if (
		! isSameClaudePathText(
			pathModule.dirname( canonical ),
			await seams.files.realpath( configDirectory ),
			caseSensitive,
			seams.host
		) ||
		! isSameClaudePathText(
			pathModule.basename( canonical ),
			'projects',
			caseSensitive,
			seams.host
		) ||
		( await seams.files.stat( canonical ) ).kind !== 'directory'
	)
		throw new Error( 'Unexpected projects directory' );
	return canonical;
}
/** Runs a native command and returns its output; it rejects on a non-zero exit. */
export type ClaudeProcessRunner = (
	file: string,
	args: string[],
	options: {
		cwd: string;
		env: NodeJS.ProcessEnv;
		timeout: number;
		maxBuffer: number;
		windowsHide: boolean;
	}
) => Promise< { stdout: string } >;

const runNativeProcess: ClaudeProcessRunner = async ( file, args, options ) => {
	const { stdout } = await execFileAsync( file, args, { ...options, encoding: 'utf8' } );
	return { stdout };
};

async function readNativeStatus(
	executablePath: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	run: ClaudeProcessRunner = runNativeProcess
): Promise< Record< string, unknown > > {
	let stdout: string;
	let signedOutExit = false;
	try {
		( { stdout } = await run( executablePath, [ 'auth', 'status', '--json' ], {
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
		signedOutExit = true;
	}
	const status: unknown = JSON.parse( stdout );
	if ( ! status || typeof status !== 'object' || Array.isArray( status ) )
		throw new Error( 'Invalid auth status' );
	const record = status as Record< string, unknown >;
	if ( signedOutExit && record.loggedIn !== false ) throw new Error( 'Invalid signed-out status' );
	return record;
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
	const context = await resolveClaudeConfigContext( configDirectory, process.env );
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
		const managedPolicy = await inspectClaudeManagedPolicy();
		if ( managedPolicy.state !== 'absent' )
			configuration.blockers.push( 'managed-policy-unverified' );
		if ( configuration.blockers.length )
			return {
				ok: false as const,
				blockers: configuration.blockers,
				findings: configuration.findings,
				managedPolicy,
			};
		const executable = await inspectClaudeExecutable( executablePath );
		if ( ! executable.ok )
			return { ok: false as const, blockers: [ executable.reason ], executable };
		if ( context.mode === 'explicit' ) child.env.CLAUDE_CONFIG_DIR = context.directory;
		if (
			! ( await verifyClaudeExecutableIdentity( executable.identity, {
				selectedPath: executablePath,
				content: false,
			} ) )
		)
			return { ok: false as const, blockers: [ 'executable-changed' ], executable };
		const status = await readNativeStatus( executable.executablePath, canonicalCwd, child.env );
		if (
			! ( await verifyClaudeExecutableIdentity( executable.identity, {
				selectedPath: executablePath,
			} ) )
		)
			return { ok: false as const, blockers: [ 'executable-changed' ], executable };
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
		if ( ! ( await isSameClaudePath( status.configDirectory, resolvedConfig ) ) )
			return { ok: false as const, blockers: [ 'config-directory-mismatch' ], executable };
		const projectsDirectory = await resolveClaudeProjectsDirectory(
			resolvedConfig,
			status.projectsDirectory
		);
		const identity = {
			email: typeof status.email === 'string' ? status.email : undefined,
			organization: typeof status.orgName === 'string' ? status.orgName : undefined,
			subscriptionType:
				typeof status.subscriptionType === 'string' ? status.subscriptionType : undefined,
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
			executable,
			executableIdentity: executable.identity,
			managedPolicy,
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
		executable: result.executable,
		config: { mode: result.configMode, directory: result.configDirectory },
		auth: { qualified: true, method: 'claude.ai' },
		managedPolicy: result.managedPolicy,
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
/** Moves a connection to its next revision, ending turns and approvals made on the last one. */
export async function markClaudeConnectionReestablished( connectionId: string ): Promise< void > {
	await updateSharedConfigFrom( ( config ) => {
		const existing = connections( config.claudeConnections );
		if ( ! existing.some( ( item ) => item.id === connectionId ) )
			throw new Error( 'Unknown Claude connection' );
		return {
			claudeConnections: existing.map( ( item ) =>
				item.id === connectionId
					? { ...item, revision: claudeConnectionRevision( item ) + 1 }
					: item
			),
		};
	} );
}

/**
 * The native sign-in now: a qualified account, no qualified account (signed
 * out, or another kind of sign-in), or a status that could not be read, which
 * proves nothing either way.
 */
export type ClaudeAccountStatus =
	| { state: 'signed-in'; identity: ClaudeAuthIdentity }
	| { state: 'not-qualified' }
	| { state: 'unavailable' };

/** The binary a turn was prepared with, and the path the user selected for it. */
export interface ClaudeAccountStatusRequest {
	selectedPath: string;
	executablePath: string;
	executableIdentity: ClaudeExecutableIdentity;
	cwd: string;
	configDirectory?: string;
}

/**
 * Reads the stored sign-in with the prepared binary only. The selected path
 * must still lead to that file, unchanged, before and after the read;
 * otherwise nothing is run, or the answer is discarded, and the status is
 * unavailable.
 */
export async function readClaudeAccountStatus(
	request: ClaudeAccountStatusRequest,
	options: { run?: ClaudeProcessRunner; files?: ClaudeFileAccess } = {}
): Promise< ClaudeAccountStatus > {
	const child = buildClaudeEnvironment( process.env );
	const context = await resolveClaudeConfigContext( request.configDirectory, process.env );
	if ( child.conflicts.length || context.mode === 'conflict' ) return { state: 'unavailable' };
	if ( context.mode === 'explicit' ) child.env.CLAUDE_CONFIG_DIR = context.directory;
	const unchanged = async () =>
		request.executablePath === request.executableIdentity.path &&
		( await verifyClaudeExecutableIdentity( request.executableIdentity, {
			selectedPath: request.selectedPath,
			files: options.files,
			content: false,
		} ) );
	let status: Record< string, unknown >;
	try {
		if ( ! ( await unchanged() ) ) return { state: 'unavailable' };
		status = await readNativeStatus(
			request.executablePath,
			request.cwd,
			child.env,
			options.run ?? runNativeProcess
		);
		if ( ! ( await unchanged() ) ) return { state: 'unavailable' };
	} catch {
		return { state: 'unavailable' };
	}
	if ( ! assessClaudeAuth( status ).qualified ) return { state: 'not-qualified' };
	return {
		state: 'signed-in',
		identity: {
			email: typeof status.email === 'string' ? status.email : undefined,
			organization: typeof status.orgName === 'string' ? status.orgName : undefined,
			subscriptionType:
				typeof status.subscriptionType === 'string' ? status.subscriptionType : undefined,
		},
	};
}

/**
 * Why Studio will not open the vendor sign-in for a connection: the
 * executable's inspection result, a conflicting environment or configuration
 * directory, an unqualified configuration, a managed policy, or a binary that
 * changed after inspection. Nothing changes when sign-in is refused.
 */
export type ClaudeSignInRefusalReason =
	| ClaudeExecutableReason
	| 'environment-conflict'
	| 'config-directory-conflict'
	| 'configuration-unqualified'
	| 'managed-policy-unverified';

export type ClaudeNativeSignInResult =
	| ClaudeSignInResult
	| { state: 'refused'; reason: ClaudeSignInRefusalReason };

/**
 * Opens the vendor's own `auth login` in a real terminal for the inspected
 * executable, user, working directory and configuration that execution uses.
 * The executable is checked again right before launch, so a binary swapped or
 * updated since inspection never signs in. Where Studio refuses, or no
 * terminal, display or browser can reach the user, nothing changes and the
 * result says why.
 */
export async function openClaudeNativeSignIn(
	connectionId: string,
	overrides: Partial< ClaudePlatformSeams > = {}
): Promise< ClaudeNativeSignInResult > {
	if ( process.env.STUDIO_EXPERIMENTAL_CLAUDE_CODE !== '1' )
		throw new Error( 'Claude Code is disabled' );
	const connection = connections( ( await readSharedConfig() ).claudeConnections ).find(
		( item ) => item.id === connectionId
	);
	if ( ! connection ) throw new Error( 'Unknown Claude connection' );
	const seams = defaultClaudePlatformSeams( overrides );
	const refuse = ( reason: ClaudeSignInRefusalReason ) => ( { state: 'refused', reason } ) as const;
	const executable = await inspectClaudeExecutable( connection.executablePath, seams );
	if ( ! executable.ok ) return refuse( executable.reason );
	const child = buildClaudeEnvironment( seams.env, seams.host.platform );
	if ( child.conflicts.length ) return refuse( 'environment-conflict' );
	const config = await resolveClaudeConfigContext( connection.configDirectory, seams.env, seams );
	if ( config.mode === 'conflict' ) return refuse( 'config-directory-conflict' );
	const cwd = await seams.files.realpath( process.cwd() );
	const configuration = await inspectClaudeConfiguration(
		cwd,
		config.directory ?? path.join( os.homedir(), '.claude' )
	);
	if ( configuration.blockers.length ) return refuse( 'configuration-unqualified' );
	if ( ( await inspectClaudeManagedPolicy( seams ) ).state !== 'absent' )
		return refuse( 'managed-policy-unverified' );
	if ( config.mode === 'explicit' ) child.env.CLAUDE_CONFIG_DIR = config.directory;
	const plan = await planClaudeSignIn(
		{ executablePath: executable.executablePath, args: [ 'auth', 'login' ], cwd, env: child.env },
		seams
	);
	if ( plan.state !== 'ready' ) return plan;
	if (
		! ( await verifyClaudeExecutableIdentity( executable.identity, {
			selectedPath: connection.executablePath,
			files: seams.files,
		} ) )
	)
		return refuse( 'executable-changed' );
	await markClaudeConnectionReestablished( connectionId );
	return executeClaudeSignIn( plan.launch, seams );
}
