import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * An eval case's own Studio profile and site registry. The runner's entry
 * makes them, and points the process at them, before the runner or any
 * application module loads: some modules fix a path under the Studio profile
 * when they first load (the folder `wpcom_request` names for payload files,
 * the certificates folder), so the overrides must be in place by then. Each
 * runner process runs one case. Imports Node built-ins only. Development only,
 * for the eval runner.
 */

const PROFILE_PREFIX = 'studio-eval-config-';
const REGISTRY_PREFIX = 'studio-eval-registry-';

// What Studio downloads once per machine, which every case reads through a
// link into the source profile, as the user's own Studio does. The one shared,
// append-only exception: a download a case needs that the source doesn't have
// yet lands in the source through the link. Not `mu-plugins`: a site start
// writes there, so each case keeps its own.
const STUDIO_DOWNLOADS = [ 'server-files', 'php-bin', 'import-runtime' ];

export interface CaseProfile {
	/** The case's own Studio profile: `DEV_CONFIG_DIR` and `E2E_SHARED_CONFIG_PATH` for the whole run. */
	profile: string;
	/** The case's own site registry: `E2E_CLI_CONFIG_PATH`. */
	registry: string;
	/** The profile the process started with, which the case only reads: never written. */
	source: string;
	/** Ports already given to the user's sites and to other eval cases' sites. */
	reservedPorts: number[];
}

let made: CaseProfile | null = null;
let failure: string | null = null;

/** The Studio profile a process reads before any override, as `getConfigDirectory` resolves it. */
export function sourceConfigDirectory(
	env: NodeJS.ProcessEnv,
	home: string = os.homedir()
): string {
	if ( env.DEV_CONFIG_DIR ) {
		return env.DEV_CONFIG_DIR;
	}
	if ( env.E2E && env.E2E_SHARED_CONFIG_PATH ) {
		return env.E2E_SHARED_CONFIG_PATH;
	}
	return path.join( home, '.studio' );
}

// The site registry a process reads before any override, as `getCliConfigPath` resolves it.
function sourceRegistryFile( env: NodeJS.ProcessEnv, source: string ): string {
	return env.E2E && env.E2E_CLI_CONFIG_PATH
		? path.join( env.E2E_CLI_CONFIG_PATH, 'cli.json' )
		: path.join( source, 'cli.json' );
}

function readJson( file: string ): Record< string, unknown > | undefined {
	try {
		const parsed: unknown = JSON.parse( fs.readFileSync( file, 'utf8' ) );
		return typeof parsed === 'object' && parsed !== null
			? ( parsed as Record< string, unknown > )
			: undefined;
	} catch {
		return undefined;
	}
}

function sitePorts( registryFile: string ): number[] {
	const sites = readJson( registryFile )?.sites;
	return ( Array.isArray( sites ) ? sites : [] )
		.map( ( site ) => ( site as { port?: unknown } | null )?.port )
		.filter( ( port ): port is number => Number.isSafeInteger( port ) );
}

const text = ( value: unknown ) => ( typeof value === 'string' ? value : undefined );

/**
 * Whether a case reads the Anthropic API key and the provider setting: one on
 * the default path (no provider named) and one that selects `anthropic-api-key`.
 * The provider is named in the environment, in the case's `provider` var, or
 * both. A case on any other provider never reads them.
 */
export function caseUsesAnthropicKey( argv: readonly string[], env: NodeJS.ProcessEnv ): boolean {
	let vars: unknown;
	try {
		vars = JSON.parse( argv[ 4 ] ?? '' )?.vars;
	} catch {
		vars = undefined;
	}
	const named = [ env.STUDIO_EVAL_PROVIDER, ( vars as { provider?: unknown } | null )?.provider ]
		.map( ( provider ) => ( typeof provider === 'string' ? provider.trim() : '' ) )
		.filter( Boolean );
	return named.length === 0 || named.includes( 'anthropic-api-key' );
}

/**
 * Makes the case's profile and registry in `tmpdir` and points `env` at them
 * (`DEV_CONFIG_DIR`, which every Studio path helper reads first,
 * `E2E_SHARED_CONFIG_PATH` and `E2E_CLI_CONFIG_PATH`). From the source it
 * takes only a copy of what `shared.json` holds for signing in (the
 * WordPress.com login) and, for a case that uses them (`caseUsesAnthropicKey`),
 * the AI provider and its Anthropic key (read from the source's registry when
 * `shared.json` has neither, as Studio reads them), links to Studio's downloads, and the ports the user's
 * sites have. Throws when the source has no readable `shared.json`, leaving
 * nothing behind.
 */
export function isolateCaseProfile(
	env: NodeJS.ProcessEnv,
	{
		tmpdir = os.tmpdir(),
		home = os.homedir(),
		argv = process.argv,
	}: { tmpdir?: string; home?: string; argv?: readonly string[] } = {}
): CaseProfile {
	const source = sourceConfigDirectory( env, home );
	const sourceRegistry = sourceRegistryFile( env, source );
	const shared = JSON.parse(
		fs.readFileSync( path.join( source, 'shared.json' ), 'utf8' )
	) as Record< string, unknown >;
	const legacy =
		shared.aiProvider === undefined && shared.anthropicApiKey === undefined
			? readJson( sourceRegistry ) ?? {}
			: shared;
	const reservedPorts = sitePorts( sourceRegistry );
	for ( const entry of fs.readdirSync( tmpdir ) ) {
		if ( entry.startsWith( REGISTRY_PREFIX ) ) {
			reservedPorts.push( ...sitePorts( path.join( tmpdir, entry, 'cli.json' ) ) );
		}
	}

	const profile = fs.realpathSync( fs.mkdtempSync( path.join( tmpdir, PROFILE_PREFIX ) ) );
	let registry: string | null = null;
	try {
		registry = fs.realpathSync( fs.mkdtempSync( path.join( tmpdir, REGISTRY_PREFIX ) ) );
		for ( const name of STUDIO_DOWNLOADS ) {
			if ( fs.existsSync( path.join( source, name ) ) ) {
				fs.symlinkSync( path.join( source, name ), path.join( profile, name ) );
			}
		}
		fs.writeFileSync(
			path.join( profile, 'shared.json' ),
			JSON.stringify( {
				version: shared.version,
				authToken: shared.authToken,
				...( caseUsesAnthropicKey( argv, env )
					? {
							aiProvider: text( legacy.aiProvider ),
							anthropicApiKey: text( legacy.anthropicApiKey ),
					  }
					: {} ),
			} ),
			{ mode: 0o600 }
		);
	} catch ( error ) {
		removeFolder( profile );
		if ( registry ) {
			removeFolder( registry );
		}
		throw error;
	}
	env.E2E = '1';
	env.E2E_CLI_CONFIG_PATH = registry;
	env.E2E_SHARED_CONFIG_PATH = profile;
	env.DEV_CONFIG_DIR = profile;
	made = { profile, registry, source, reservedPorts };
	failure = null;
	return made;
}

/**
 * What the entry calls: `isolateCaseProfile`, with a failure kept for the
 * runner to refuse the case with rather than thrown before it loads. Only its
 * error code is kept: a message can name a path.
 */
export function prepareCaseProfile( env: NodeJS.ProcessEnv ): void {
	try {
		isolateCaseProfile( env );
	} catch ( error ) {
		made = null;
		const code = ( error as { code?: unknown } )?.code;
		failure =
			typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test( code )
				? code
				: error instanceof SyntaxError
				? 'UNREADABLE_SHARED_CONFIG'
				: 'UNKNOWN';
	}
}

/** The profile this process made for its case, or why it has none. */
export function caseProfile(): { ok: true; profile: CaseProfile } | { ok: false; problem: string } {
	if ( made ) {
		return { ok: true, profile: made };
	}
	return {
		ok: false,
		problem: failure
			? `the entry could not make it (${ failure })`
			: 'the runner was started without the entry that makes it',
	};
}

/** For an `imageService: "off"` case: the WordPress.com login taken out of the case's profile. */
export function withdrawCaseLogin( profile: CaseProfile ): void {
	const file = path.join( profile.profile, 'shared.json' );
	const { authToken: _withdrawn, ...rest } = readJson( file ) ?? {};
	fs.writeFileSync( file, JSON.stringify( rest ), { mode: 0o600 } );
}

// A case's own folder, its links to Studio's downloads removed as links first,
// so nothing they point to is ever touched.
function removeFolder( dir: string ): void {
	for ( const entry of fs.readdirSync( dir, { withFileTypes: true } ) ) {
		if ( entry.isSymbolicLink() ) {
			fs.unlinkSync( path.join( dir, entry.name ) );
		}
	}
	fs.rmSync( dir, { recursive: true, force: true, maxRetries: 5 } );
}

/**
 * Removes the case's profile and registry, if this process made them; never
 * any other folder. Each one that can't be removed is passed to `warn`. The
 * environment keeps naming them: the process ends with its case.
 */
export function removeCaseProfile( warn: ( what: string, error: unknown ) => void ): void {
	if ( ! made ) {
		return;
	}
	const { profile, registry } = made;
	made = null;
	for ( const [ dir, prefix ] of [
		[ profile, PROFILE_PREFIX ],
		[ registry, REGISTRY_PREFIX ],
	] ) {
		if ( ! path.basename( dir ).startsWith( prefix ) ) {
			continue;
		}
		try {
			removeFolder( dir );
		} catch ( error ) {
			if ( ( error as { code?: unknown } )?.code !== 'ENOENT' ) {
				warn( `could not remove the case folder ${ path.basename( dir ) }`, error );
			}
		}
	}
}
