import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
	parseClaudeSessionSelection,
	type ClaudeModelCatalog,
	type ClaudeRuntimeState,
} from '@studio/agent/protocol/claude-code';
import { getSessionsDirectory } from '@studio/common/lib/well-known-paths';
import { collectLiveFacts } from './acceptance-build-facts';
import { openAcceptanceEvidence, type StageRecord } from './acceptance-evidence';
import {
	checkDedicatedProfile,
	findRealProfileHazard,
	isInsideAcceptanceRun,
	readAcceptanceArgument,
	type AcceptanceRunPaths,
} from './acceptance-isolation';
import { createClaudeAcceptanceSite } from './claude-acceptance-site';
import { runClaudeAcceptanceWorkflows } from './claude-acceptance-workflows';

const execute = promisify( execFile );
const siteName = 'Claude Acceptance';
type RunCli = ( args: string[] ) => Promise< string >;
type Site = { id: string; path: string; name: string };
type Report = Pick< StageRecord, 'stage' | 'status' | 'observations' | 'code' >;
class Refusal extends Error {}

function requireCondition( value: unknown, code: string ): asserts value {
	if ( ! value ) throw new Refusal( code );
}
const samePath = ( a: string, b: string ) =>
	path.relative( fs.realpathSync.native( a ), fs.realpathSync.native( b ) ) === '';

export function acceptanceConnection(
	state: ClaudeRuntimeState,
	executable: string,
	config: string
) {
	requireCondition( state.enabled && state.connections.length === 1, 'connection-unavailable' );
	const connection = state.connections[ 0 ];
	requireCondition(
		connection.authMethod === 'claude.ai' &&
			Array.isArray( connection.blockers ) &&
			! connection.blockers.length,
		'subscription-unqualified'
	);
	requireCondition(
		connection.version && connection.supportedVersions?.includes( connection.version ),
		'version-unqualified'
	);
	requireCondition(
		connection.configDirectory &&
			samePath( connection.configDirectory, config ) &&
			samePath( connection.executablePath, executable ),
		'connection-mismatch'
	);
	const revision = connection.revision;
	requireCondition(
		typeof revision === 'number' && Number.isSafeInteger( revision ) && !! connection.id,
		'connection-mismatch'
	);
	return { connectionId: connection.id, revision };
}

async function listedSites( runCli: RunCli ): Promise< Site[] > {
	const sites: unknown = JSON.parse( await runCli( [ 'site', 'list', '--format', 'json' ] ) );
	requireCondition(
		Array.isArray( sites ) &&
			sites.every(
				( site ) =>
					typeof site?.path === 'string' &&
					typeof site.id === 'string' &&
					typeof site.name === 'string'
			),
		'site-list-invalid'
	);
	return sites;
}

function checkOwnedSitePath( runDir: string, sitePath: string ) {
	const real = fs.realpathSync.native( sitePath );
	requireCondition(
		path.relative( fs.realpathSync.native( runDir ), real ) ===
			path.join( 'sites', 'claude-acceptance' ),
		'site-path-mismatch'
	);
}

export async function cleanupClaudeAcceptanceSite(
	runCli: RunCli,
	runDir: string,
	sitePath: string
) {
	const sites = await listedSites( runCli );
	requireCondition( sites.length <= 1, 'unexpected-site' );
	const [ site ] = sites;
	if ( fs.existsSync( sitePath ) ) checkOwnedSitePath( runDir, sitePath );
	if ( site ) {
		requireCondition(
			site.name === siteName && samePath( site.path, sitePath ),
			'unexpected-site'
		);
		await runCli( [ 'site', 'stop', '--path', sitePath ] );
		await runCli( [ 'site', 'delete', sitePath, '--no-files' ] );
		requireCondition( ( await listedSites( runCli ) ).length === 0, 'site-still-registered' );
	}
	await runCli( [ 'site', 'stop', '--all' ] );
	if ( fs.existsSync( sitePath ) ) {
		checkOwnedSitePath( runDir, sitePath );
		fs.rmSync( sitePath, { recursive: true } );
	}
}

export async function runClaudeAcceptance(
	argv: string[],
	paths: AcceptanceRunPaths,
	cliPath: string,
	signal: AbortSignal
) {
	const argument = ( key: string ) => readAcceptanceArgument( argv, key );
	const { runDir } = paths;
	const sitePath = path.join( paths.sitesDir, 'claude-acceptance' );
	let stage = 'prerequisites';
	let report: ( value: Report ) => void = () => {};
	let needsCleanup = false;
	let ok = false;
	const cli = async ( args: string[], cwd = runDir, cleanup = false ) => {
		if ( ! cleanup ) signal.throwIfAborted();
		// Let an in-flight administrative command finish before cleanup starts.
		const { stdout } = await execute( process.execPath, [ cliPath, ...args ], {
			cwd,
			env: process.env,
			windowsHide: true,
			encoding: 'utf8',
			maxBuffer: 4 * 1024 * 1024,
			timeout: 10 * 60_000,
		} );
		if ( ! cleanup ) signal.throwIfAborted();
		return stdout.trim();
	};
	try {
		requireCondition(
			argv.includes( '--live' ) && process.env.STUDIO_EXPERIMENTAL_CLAUDE_CODE === '1',
			'live-opt-in-required'
		);
		const executable = argument( '--executable' );
		const config = argument( '--config-directory' );
		requireCondition(
			executable &&
				path.isAbsolute( executable ) &&
				fs.statSync( executable, { throwIfNoEntry: false } )?.isFile(),
			'native-executable-required'
		);
		requireCondition(
			config && ! checkDedicatedProfile( config, { home: os.homedir(), configDirectory: runDir } ),
			'separate-native-config-required'
		);
		requireCondition(
			! findRealProfileHazard( os.homedir() ) &&
				process.env.DEV_CONFIG_DIR === paths.profileDir &&
				process.env.STUDIO_PROCESS_MANAGER_HOME === paths.daemonDir &&
				isInsideAcceptanceRun( getSessionsDirectory(), runDir ),
			'profile-isolation-required'
		);
		const model = argument( '--model' );
		requireCondition( model && /^[a-z][a-z0-9.-]{0,63}$/.test( model ), 'explicit-model-required' );
		const selection = parseClaudeSessionSelection( {
			model,
			effort: argument( '--effort' ) ?? 'low',
		} );
		const { effort: nextEffort } = parseClaudeSessionSelection( {
			model,
			effort: argument( '--next-effort' ) ?? 'medium',
		} );
		requireCondition( selection.effort !== nextEffort, 'different-efforts-required' );
		// Exclusive creation prevents two invocations claiming the same fixture.
		requireCondition( ! fs.existsSync( runDir ), 'run-directory-already-exists' );
		fs.mkdirSync( runDir, { mode: 0o700 } );
		const evidence = openAcceptanceEvidence( runDir, 'claude-code' );
		const scenario = 'tool-workflow';
		const run = evidence.startRun( {
			scenario,
			createdOn: new Date().toISOString().slice( 0, 10 ),
			...( await collectLiveFacts( path.dirname( cliPath ) ) ),
			model,
			effort: selection.effort,
			gates: [ 'C5' ],
		} );
		let since = Date.now();
		report = ( record ) => {
			evidence.record( {
				run,
				scenario,
				...record,
				durationS: Math.round( ( Date.now() - since ) / 1000 ),
			} );
			since = Date.now();
			console.log( [ record.stage, record.status, record.code ].filter( Boolean ).join( ' ' ) );
		};
		stage = 'native-connection';
		await cli( [
			'code',
			'claude',
			'configure',
			'--executable',
			executable,
			'--config-directory',
			config,
		] );
		const connection = acceptanceConnection(
			JSON.parse( await cli( [ 'code', 'claude', 'status' ] ) ),
			executable,
			config
		);
		report( { stage, status: 'passed', observations: { signedIn: true, supportedVersion: true } } );
		stage = 'disposable-site';
		requireCondition( ( await listedSites( cli ) ).length === 0, 'unexpected-site' );
		needsCleanup = true;
		await createClaudeAcceptanceSite( { cliPath, paths, sitePath, siteName, signal } );
		const sites = await listedSites( cli );
		checkOwnedSitePath( runDir, sitePath );
		const site = sites[ 0 ];
		requireCondition(
			sites.length === 1 && site.name === siteName && samePath( site.path, sitePath ),
			'fixture-site-mismatch'
		);
		report( { stage, status: 'passed', observations: { registered: true } } );
		stage = 'workspace-catalog';
		const inWorkspace = ( args: string[] ) => cli( args, sitePath );
		const workspaceConnection = acceptanceConnection(
			JSON.parse( await inWorkspace( [ 'code', 'claude', 'status' ] ) ),
			executable,
			config
		);
		requireCondition(
			connection.connectionId === workspaceConnection.connectionId &&
				connection.revision === workspaceConnection.revision,
			'workspace-connection-mismatch'
		);
		const scope = [ '--connection', connection.connectionId, '--site', site.id ];
		const catalog: ClaudeModelCatalog = JSON.parse(
			await inWorkspace( [ 'code', 'claude', 'models', ...scope ] )
		);
		requireCondition(
			catalog.ok &&
				catalog.models.some(
					( item ) =>
						item.id === model &&
						item.efforts.includes( selection.effort ) &&
						item.efforts.includes( nextEffort )
				),
			'selection-unavailable'
		);
		report( {
			stage,
			status: 'passed',
			observations: { availableModels: catalog.models.length, bothEfforts: true },
		} );
		stage = 'new-session';
		const session = JSON.parse(
			await inWorkspace( [
				'code',
				'claude',
				'new',
				...scope,
				'--model',
				model,
				'--effort',
				selection.effort,
			] )
		);
		requireCondition(
			session.backend === 'claude-code' && typeof session.id === 'string' && !! session.id,
			'wrong-session-backend'
		);
		report( { stage, status: 'passed', observations: { nativeBackend: true } } );
		stage = 'tool-workflows';
		ok = await runClaudeAcceptanceWorkflows(
			{
				cliPath,
				cwd: runDir,
				env: process.env,
				sessionsRoot: getSessionsDirectory(),
				sessionId: session.id,
				site,
				...connection,
				selection,
				nextEffort,
				signal,
				runCli: inWorkspace,
			},
			( value ) =>
				report( {
					stage: value.name,
					status: value.status,
					code: value.code,
					observations: value.observations,
				} )
		);
	} catch ( error ) {
		const code =
			error instanceof Refusal ? error.message : signal.aborted ? 'interrupted' : 'command-failed';
		report( { stage, status: 'failed', code, observations: {} } );
		if ( stage === 'prerequisites' ) console.error( code );
	} finally {
		if ( needsCleanup ) {
			try {
				await cleanupClaudeAcceptanceSite(
					( args ) => cli( args, runDir, true ),
					runDir,
					sitePath
				);
				report( { stage: 'cleanup', status: 'passed', observations: { removedSite: true } } );
			} catch {
				ok = false;
				report( { stage: 'cleanup', status: 'failed', code: 'cleanup-failed', observations: {} } );
			}
		}
	}
	return ok ? 0 : 1;
}
