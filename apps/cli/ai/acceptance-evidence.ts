import fs from 'node:fs';
import path from 'node:path';

/**
 * Sanitized, versioned evidence for development-only acceptance runners that
 * sign in to a real account: `manifest.json` (what was run, where and on which
 * source), an append-only `evidence.ndjson` with one record per stage, and
 * `state.json` for local test identifiers that never leave the machine.
 *
 * Everything is checked before it is written. A stage record holds a stage
 * name, a status, a typed code and bounded counts, booleans and durations,
 * nothing else; any string that looks like a token, a URL, an email address,
 * an account identifier or a local path is refused. Provider-neutral, so each
 * provider's runner writes the same format.
 */

export const ACCEPTANCE_EVIDENCE_SCHEMA_VERSION = 1;

const MANIFEST_FILE = 'manifest.json';
const EVIDENCE_FILE = 'evidence.ndjson';
const STATE_FILE = 'state.json';

export type StageStatus = 'passed' | 'failed' | 'blocked' | 'skipped';
export type Observations = Record< string, number | boolean >;

export interface StageRecord {
	schemaVersion: typeof ACCEPTANCE_EVIDENCE_SCHEMA_VERSION;
	/** The manifest run this record belongs to, from 1. */
	run: number;
	scenario: string;
	stage: string;
	status: StageStatus;
	/** A typed failure or blocking code, never a message. */
	code?: string;
	durationS: number;
	observations: Observations;
}

export interface ManifestRun {
	run: number;
	scenario: string;
	/** The day the run started, `YYYY-MM-DD`. */
	createdOn: string;
	source: { sha: string | null; dirty: boolean | null };
	/** `release` is null when the system's release string isn't a plain version. */
	platform: { os: string; release: string | null; arch: string };
	runtime: { node: string; npm: string | null };
	build: { cliVersion: string; buildId: string | null };
	model: string;
	effort: string;
	gates: string[];
}

interface AcceptanceManifest {
	schemaVersion: typeof ACCEPTANCE_EVIDENCE_SCHEMA_VERSION;
	provider: string;
	runs: ManifestRun[];
}

export type UnsafeKind = 'token' | 'url' | 'email' | 'identifier' | 'path' | 'shape';

export interface UnsafeFinding {
	/** Where in the value: a field path, with an unsafe key itself withheld. */
	path: string;
	kind: UnsafeKind;
}

/** Something was about to be written that evidence may not hold. Names where, never what. */
export class UnsafeEvidenceError extends Error {
	readonly finding: UnsafeFinding;

	constructor( finding: UnsafeFinding ) {
		super( `Refused to write ${ finding.kind }-shaped evidence at ${ finding.path }.` );
		this.name = 'UnsafeEvidenceError';
		this.finding = finding;
	}
}

const STAGE_STATUSES: readonly StageStatus[] = [ 'passed', 'failed', 'blocked', 'skipped' ];
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OBSERVATION_KEY = /^[a-z][A-Za-z0-9]{0,63}$/;
const MAX_KEBAB_LENGTH = 64;
const MAX_OBSERVATIONS = 64;
const MAX_MAGNITUDE = 1e9;
const MAX_DURATION_S = 7 * 24 * 60 * 60;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\./;
const API_KEY = /\b(?:sk|rk|pk|sess)-[A-Za-z0-9_-]{8,}/;
const BEARER = /\bbearer\s+\S+/i;
const URL_SHAPES = [
	/\b[a-z][a-z0-9+.-]*:\/\//i,
	/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/i,
	/\[::1\]/,
	/\bwww\./i,
	/[?&](?:code|state|token|access_token|refresh_token|id_token|nonce|client_id)=/i,
	/\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|ai|dev|app|co|me|test|local|example)\b/i,
];
const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/;
const LOCAL_PATH = [
	/\b[A-Za-z]:[\\/]/,
	/(?:^|[\s"'(=])\/(?:home|Users|root|var|tmp|private|mnt)\//,
	/\\\\[^\\\s]+\\/,
];
const OPAQUE_RUN = /[A-Za-z0-9_-]{24,}/g;

// A long run of token characters that mixes digits and letters, or both cases:
// what an opaque token, a key or a hash looks like, unlike a kebab-case code.
function hasOpaqueRun( text: string ): boolean {
	for ( const [ run ] of text.matchAll( OPAQUE_RUN ) ) {
		const digits = run.replace( /[^0-9]/g, '' ).length;
		const letters = run.replace( /[^A-Za-z]/g, '' ).length;
		const mixedCase = /[a-z]/.test( run ) && /[A-Z]/.test( run );
		if ( ( digits >= 2 && letters >= 1 ) || ( mixedCase && run.length >= 32 ) ) {
			return true;
		}
	}
	return false;
}

/**
 * What a string looks like, if it looks like anything evidence may not hold.
 * `state.json` allows identifiers and paths: it stays on the machine.
 */
export function findUnsafeText(
	text: string,
	allow: { identifiers?: boolean; paths?: boolean } = {}
): UnsafeKind | null {
	if ( EMAIL.test( text ) ) {
		return 'email';
	}
	if ( URL_SHAPES.some( ( shape ) => shape.test( text ) ) ) {
		return 'url';
	}
	if ( JWT.test( text ) || API_KEY.test( text ) || BEARER.test( text ) ) {
		return 'token';
	}
	const isPath = LOCAL_PATH.some( ( shape ) => shape.test( text ) );
	if ( isPath ) {
		// A folder name a system tool generated can look opaque; a path is only ever a path.
		return allow.paths ? null : 'path';
	}
	if ( UUID.test( text ) ) {
		if ( allow.identifiers ) {
			return hasOpaqueRun( text.replace( new RegExp( UUID.source, 'gi' ), '' ) ) ? 'token' : null;
		}
		return 'identifier';
	}
	return hasOpaqueRun( text ) ? 'token' : null;
}

const isRecord = ( value: unknown ): value is Record< string, unknown > =>
	typeof value === 'object' && value !== null && ! Array.isArray( value );

const isKebab = ( value: unknown ): value is string =>
	typeof value === 'string' &&
	value.length <= MAX_KEBAB_LENGTH &&
	KEBAB.test( value ) &&
	findUnsafeText( value ) === null;

const isBoundedNumber = ( value: unknown, min: number, max: number ): value is number =>
	typeof value === 'number' && Number.isFinite( value ) && value >= min && value <= max;

const RECORD_KEYS = new Set( [
	'schemaVersion',
	'run',
	'scenario',
	'stage',
	'status',
	'code',
	'durationS',
	'observations',
] );

/** The first thing a stage record holds that evidence may not, or null. */
export function findUnsafeRecord( record: unknown ): UnsafeFinding | null {
	const shape = ( fieldPath: string ): UnsafeFinding => ( { path: fieldPath, kind: 'shape' } );
	if ( ! isRecord( record ) ) {
		return shape( '' );
	}
	for ( const key of Object.keys( record ) ) {
		if ( ! RECORD_KEYS.has( key ) ) {
			return shape( OBSERVATION_KEY.test( key ) && ! findUnsafeText( key ) ? key : '<unsafe key>' );
		}
	}
	if ( record.schemaVersion !== ACCEPTANCE_EVIDENCE_SCHEMA_VERSION ) {
		return shape( 'schemaVersion' );
	}
	if ( ! Number.isSafeInteger( record.run ) || ( record.run as number ) < 1 ) {
		return shape( 'run' );
	}
	for ( const field of [ 'scenario', 'stage' ] as const ) {
		if ( ! isKebab( record[ field ] ) ) {
			return shape( field );
		}
	}
	if ( ! STAGE_STATUSES.includes( record.status as StageStatus ) ) {
		return shape( 'status' );
	}
	if ( record.code !== undefined && ! isKebab( record.code ) ) {
		return shape( 'code' );
	}
	if ( ! isBoundedNumber( record.durationS, 0, MAX_DURATION_S ) ) {
		return shape( 'durationS' );
	}
	const { observations } = record;
	if ( ! isRecord( observations ) || Object.keys( observations ).length > MAX_OBSERVATIONS ) {
		return shape( 'observations' );
	}
	for ( const [ key, value ] of Object.entries( observations ) ) {
		if ( ! OBSERVATION_KEY.test( key ) || findUnsafeText( key ) ) {
			return shape( 'observations.<unsafe key>' );
		}
		if ( typeof value !== 'boolean' && ! isBoundedNumber( value, -MAX_MAGNITUDE, MAX_MAGNITUDE ) ) {
			return shape( `observations.${ key }` );
		}
	}
	return null;
}

const SHA = /^[0-9a-f]{40}$/;
const BUILD_ID = /^[0-9a-f]{8,16}$/;
const VERSION = /^[0-9]+(?:\.[0-9A-Za-z-]+){0,4}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z0-9][a-z0-9.+-]{0,63}$/;
const GATE = /^[A-Z][0-9]{1,2}$/;

/** Whether a version string is one a manifest may hold. */
export function isManifestVersion( value: string ): boolean {
	return VERSION.test( value );
}

/** The first field of a manifest run that isn't one of its known, bounded values, or null. */
function findUnsafeManifestRun( run: unknown ): UnsafeFinding | null {
	const shape = ( fieldPath: string ): UnsafeFinding => ( { path: fieldPath, kind: 'shape' } );
	if ( ! isRecord( run ) ) {
		return shape( 'run' );
	}
	const { source, platform, runtime, build } = run;
	if ( ! Number.isSafeInteger( run.run ) || ( run.run as number ) < 1 ) {
		return shape( 'run' );
	}
	if ( ! isKebab( run.scenario ) ) {
		return shape( 'scenario' );
	}
	if ( typeof run.createdOn !== 'string' || ! DAY.test( run.createdOn ) ) {
		return shape( 'createdOn' );
	}
	if (
		! isRecord( source ) ||
		! ( source.sha === null || ( typeof source.sha === 'string' && SHA.test( source.sha ) ) ) ||
		! ( source.dirty === null || typeof source.dirty === 'boolean' )
	) {
		return shape( 'source' );
	}
	if (
		! isRecord( platform ) ||
		! [ platform.os, platform.arch ].every(
			( value ) => typeof value === 'string' && SLUG.test( value )
		) ||
		! (
			platform.release === null ||
			( typeof platform.release === 'string' && VERSION.test( platform.release ) )
		)
	) {
		return shape( 'platform' );
	}
	if (
		! isRecord( runtime ) ||
		typeof runtime.node !== 'string' ||
		! VERSION.test( runtime.node ) ||
		! ( runtime.npm === null || ( typeof runtime.npm === 'string' && VERSION.test( runtime.npm ) ) )
	) {
		return shape( 'runtime' );
	}
	if (
		! isRecord( build ) ||
		typeof build.cliVersion !== 'string' ||
		! VERSION.test( build.cliVersion ) ||
		! (
			build.buildId === null ||
			( typeof build.buildId === 'string' && BUILD_ID.test( build.buildId ) )
		)
	) {
		return shape( 'build' );
	}
	for ( const field of [ 'model', 'effort' ] as const ) {
		const value = run[ field ];
		if ( typeof value !== 'string' || ! SLUG.test( value ) || findUnsafeText( value ) ) {
			return shape( field );
		}
	}
	if (
		! Array.isArray( run.gates ) ||
		! run.gates.every( ( gate ) => typeof gate === 'string' && GATE.test( gate ) )
	) {
		return shape( 'gates' );
	}
	const known = new Set( [
		'run',
		'scenario',
		'createdOn',
		'source',
		'platform',
		'runtime',
		'build',
		'model',
		'effort',
		'gates',
	] );
	const extra = Object.keys( run ).find( ( key ) => ! known.has( key ) );
	return extra === undefined ? null : shape( '<unknown field>' );
}

/** The first value under `state` that looks like a secret, a URL or an email address, or null. */
function findUnsafeState( value: unknown, fieldPath = '' ): UnsafeFinding | null {
	if ( typeof value === 'string' ) {
		const kind = findUnsafeText( value, { identifiers: true, paths: true } );
		return kind ? { path: fieldPath || '<root>', kind } : null;
	}
	if ( value === null || typeof value === 'number' || typeof value === 'boolean' ) {
		return null;
	}
	if ( Array.isArray( value ) ) {
		for ( const [ index, item ] of value.entries() ) {
			const found = findUnsafeState( item, `${ fieldPath }[${ index }]` );
			if ( found ) {
				return found;
			}
		}
		return null;
	}
	if ( isRecord( value ) ) {
		for ( const [ key, item ] of Object.entries( value ) ) {
			const keyKind = findUnsafeText( key, { identifiers: true } );
			if ( keyKind ) {
				return { path: `${ fieldPath }.<unsafe key>`, kind: keyKind };
			}
			const found = findUnsafeState( item, fieldPath ? `${ fieldPath }.${ key }` : key );
			if ( found ) {
				return found;
			}
		}
		return null;
	}
	return { path: fieldPath || '<root>', kind: 'shape' };
}

// Written whole or not at all: a reader never sees half a file.
function writeAtomically( filePath: string, contents: string ): void {
	const temporary = `${ filePath }.${ process.pid }.tmp`;
	fs.writeFileSync( temporary, contents, { encoding: 'utf8', mode: 0o600 } );
	fs.renameSync( temporary, filePath );
}

function readJson( filePath: string ): unknown {
	let text: string;
	try {
		text = fs.readFileSync( filePath, 'utf8' );
	} catch ( error ) {
		if ( ( error as NodeJS.ErrnoException ).code === 'ENOENT' ) {
			return undefined;
		}
		throw error;
	}
	return JSON.parse( text );
}

export interface AcceptanceEvidence {
	readonly runDir: string;
	/** The manifest, or null before the first run; throws when it isn't one this version reads. */
	readManifest(): AcceptanceManifest | null;
	/** Appends a run to the manifest and returns its number. */
	startRun( run: Omit< ManifestRun, 'run' > ): number;
	/** Appends one stage record; refuses, writing nothing, anything evidence may not hold. */
	record( record: Omit< StageRecord, 'schemaVersion' > ): StageRecord;
	readRecords(): StageRecord[];
	readState(): Record< string, unknown > | null;
	writeState( state: Record< string, unknown > ): void;
}

function isManifest( value: unknown, provider: string ): value is AcceptanceManifest {
	return (
		isRecord( value ) &&
		value.schemaVersion === ACCEPTANCE_EVIDENCE_SCHEMA_VERSION &&
		value.provider === provider &&
		Array.isArray( value.runs ) &&
		value.runs.every( ( run ) => findUnsafeManifestRun( run ) === null )
	);
}

export class AcceptanceManifestError extends Error {
	constructor() {
		super( 'The run directory’s manifest.json is not one this runner can read.' );
		this.name = 'AcceptanceManifestError';
	}
}

/** The evidence files of one run directory, which must already exist. */
export function openAcceptanceEvidence( runDir: string, provider: string ): AcceptanceEvidence {
	const manifestPath = path.join( runDir, MANIFEST_FILE );
	const evidencePath = path.join( runDir, EVIDENCE_FILE );
	const statePath = path.join( runDir, STATE_FILE );

	function readManifest(): AcceptanceManifest | null {
		let parsed: unknown;
		try {
			parsed = readJson( manifestPath );
		} catch {
			throw new AcceptanceManifestError();
		}
		if ( parsed === undefined ) {
			return null;
		}
		if ( ! isManifest( parsed, provider ) ) {
			throw new AcceptanceManifestError();
		}
		return parsed;
	}

	return {
		runDir,
		readManifest,
		startRun( run ) {
			const manifest = readManifest() ?? {
				schemaVersion: ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
				provider,
				runs: [],
			};
			const numbered = { run: manifest.runs.length + 1, ...run };
			const finding = findUnsafeManifestRun( numbered );
			if ( finding ) {
				throw new UnsafeEvidenceError( finding );
			}
			writeAtomically(
				manifestPath,
				JSON.stringify( { ...manifest, runs: [ ...manifest.runs, numbered ] }, null, 2 ) + '\n'
			);
			return numbered.run;
		},
		record( input ) {
			const record: StageRecord = { schemaVersion: ACCEPTANCE_EVIDENCE_SCHEMA_VERSION, ...input };
			const finding = findUnsafeRecord( record );
			if ( finding ) {
				throw new UnsafeEvidenceError( finding );
			}
			fs.appendFileSync( evidencePath, JSON.stringify( record ) + '\n', {
				encoding: 'utf8',
				mode: 0o600,
				flush: true,
			} );
			return record;
		},
		readRecords() {
			let text: string;
			try {
				text = fs.readFileSync( evidencePath, 'utf8' );
			} catch ( error ) {
				if ( ( error as NodeJS.ErrnoException ).code === 'ENOENT' ) {
					return [];
				}
				throw error;
			}
			return text
				.split( /\r?\n/ )
				.filter( Boolean )
				.map( ( line ) => JSON.parse( line ) as StageRecord );
		},
		readState() {
			const parsed = readJson( statePath );
			return isRecord( parsed ) ? parsed : null;
		},
		writeState( state ) {
			const finding = findUnsafeState( state );
			if ( finding ) {
				throw new UnsafeEvidenceError( finding );
			}
			writeAtomically( statePath, JSON.stringify( state, null, 2 ) + '\n' );
		},
	};
}
