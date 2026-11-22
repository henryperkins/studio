import { createHash, randomUUID } from 'crypto';
import { link, mkdir, open, readFile, readdir, rm, unlink } from 'fs/promises';
import path from 'path';
import { writeFile as atomicWriteFile } from 'atomically';
import type { ProcessIdentity, ProcessIdentityCheck } from '@studio/common/lib/owned-process';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A turn's run lock, version 2. Created before the turn does anything, and
 * moved through its stages by its owner only, so that once the owner is gone a
 * recovery can prove the run has ended before releasing it.
 */
export interface ClaudeRunLockRecord {
	version: 2;
	purpose: 'run';
	token: string;
	conversationId: string;
	/** The OS the identities were read on; they are compared only there. */
	platform: NodeJS.Platform;
	/** The process that holds the lock and runs the turn. */
	owner: ProcessIdentity;
	/** For display only. A lock's age is never a reason to release it. */
	createdAt: string;
	runId: string;
	turnId: string;
	connection: { id: string; revision: number };
	/** The conversation's native workspace binding the turn ran with. */
	workspace: { siteId: string | null; workingDirectory: string; configDirectory: string };
	/**
	 * `locked`: Studio has not asked the SDK to start the turn's native process,
	 * so no process has the conversation's session or a prompt. Studio may
	 * already have run the native executable, outside any job, to read its
	 * version and sign-in status: a command that reads and exits, bounded by a
	 * timeout its caller enforces, which can outlive an owner that dies while it
	 * runs. `starting`, written before the SDK starts: the turn's native process
	 * may have started, for `session`. `owned`, written once Studio confirmed
	 * owning its tree and before any prompt: `processes`.
	 */
	stage: 'locked' | 'starting' | 'owned';
	session?: { nativeSessionId: string; resume: boolean };
	processes?: { native: ProcessIdentity; guardian?: ProcessIdentity };
}

export type ClaudeRunLockInput = Pick<
	ClaudeRunLockRecord,
	'owner' | 'runId' | 'turnId' | 'connection' | 'workspace'
>;

export type ClaudeRunLockStage =
	| { stage: 'starting'; session: NonNullable< ClaudeRunLockRecord[ 'session' ] > }
	| { stage: 'owned'; processes: NonNullable< ClaudeRunLockRecord[ 'processes' ] > };

/**
 * What holds a conversation's lock: nothing; a lock that predates owner
 * records (a bare token); one held for something other than a turn, such as
 * a deletion; a turn's run lock, with its exact bytes; or something unreadable.
 */
export type ClaudeLockInspection =
	| { state: 'none' }
	| { state: 'legacy' }
	| { state: 'held' }
	| { state: 'changing-target' }
	| { state: 'unreadable' }
	| { state: 'run'; record: ClaudeRunLockRecord; raw: string };

function isRecord( value: unknown ): value is Record< string, unknown > {
	return !! value && typeof value === 'object' && ! Array.isArray( value );
}

function identityOf( value: unknown ): ProcessIdentity | undefined {
	if (
		! isRecord( value ) ||
		typeof value.pid !== 'number' ||
		! Number.isSafeInteger( value.pid ) ||
		value.pid <= 0 ||
		typeof value.start !== 'string' ||
		! /^[\w:.+ -]{1,200}$/.test( value.start )
	)
		return undefined;
	return { pid: value.pid, start: value.start };
}

function runLockOf( data: Record< string, unknown > ): ClaudeRunLockRecord | undefined {
	const { connection, workspace, session, processes } = data;
	const owner = identityOf( data.owner );
	if (
		data.purpose !== 'run' ||
		typeof data.platform !== 'string' ||
		! data.platform ||
		! owner ||
		typeof data.createdAt !== 'string' ||
		typeof data.runId !== 'string' ||
		! data.runId ||
		typeof data.turnId !== 'string' ||
		! data.turnId ||
		! isRecord( connection ) ||
		typeof connection.id !== 'string' ||
		! connection.id ||
		typeof connection.revision !== 'number' ||
		! Number.isSafeInteger( connection.revision ) ||
		! isRecord( workspace ) ||
		! (
			workspace.siteId === null ||
			( typeof workspace.siteId === 'string' && workspace.siteId )
		) ||
		typeof workspace.workingDirectory !== 'string' ||
		! path.isAbsolute( workspace.workingDirectory ) ||
		typeof workspace.configDirectory !== 'string' ||
		! path.isAbsolute( workspace.configDirectory ) ||
		! [ 'locked', 'starting', 'owned' ].includes( data.stage as string )
	)
		return undefined;
	const record: ClaudeRunLockRecord = {
		version: 2,
		purpose: 'run',
		token: data.token as string,
		conversationId: data.conversationId as string,
		platform: data.platform as NodeJS.Platform,
		owner,
		createdAt: data.createdAt,
		runId: data.runId,
		turnId: data.turnId,
		connection: { id: connection.id, revision: connection.revision },
		workspace: {
			siteId: workspace.siteId as string | null,
			workingDirectory: workspace.workingDirectory,
			configDirectory: workspace.configDirectory,
		},
		stage: data.stage as ClaudeRunLockRecord[ 'stage' ],
	};
	if ( record.stage === 'locked' )
		return session === undefined && processes === undefined ? record : undefined;
	if (
		! isRecord( session ) ||
		typeof session.nativeSessionId !== 'string' ||
		! UUID.test( session.nativeSessionId ) ||
		typeof session.resume !== 'boolean'
	)
		return undefined;
	record.session = { nativeSessionId: session.nativeSessionId, resume: session.resume };
	if ( record.stage === 'starting' ) return processes === undefined ? record : undefined;
	const native = isRecord( processes ) ? identityOf( processes.native ) : undefined;
	if ( ! native || ! isRecord( processes ) ) return undefined;
	const guardian = processes.guardian === undefined ? undefined : identityOf( processes.guardian );
	if ( processes.guardian !== undefined && ! guardian ) return undefined;
	record.processes = { native, ...( guardian ? { guardian } : {} ) };
	return record;
}

function inspectLockContent( raw: string ): ClaudeLockInspection {
	if ( UUID.test( raw ) ) return { state: 'legacy' };
	let data: unknown;
	try {
		data = JSON.parse( raw );
	} catch {
		return { state: 'unreadable' };
	}
	if (
		! isRecord( data ) ||
		data.version !== 2 ||
		typeof data.token !== 'string' ||
		! UUID.test( data.token ) ||
		typeof data.conversationId !== 'string' ||
		! data.conversationId
	)
		return { state: 'unreadable' };
	if ( data.purpose === 'target' ) return { state: 'changing-target' };
	if ( data.purpose === 'delete' ) return { state: 'held' };
	const record = runLockOf( data );
	return record ? { state: 'run', record, raw } : { state: 'unreadable' };
}

/** A digest of a lock's token that names it in the journal and in recovery claims. */
export function claudeLockDigest( token: string ): string {
	return createHash( 'sha256' ).update( token ).digest( 'hex' );
}

/** The outcome of claiming a lock's recovery. */
export type ClaudeRecoveryClaim =
	| { state: 'claimed'; release(): Promise< void > }
	| { state: 'held' }
	| { state: 'unreadable' };

// The process a recovery claim names; `released` when the claim is no longer
// there; `unreadable` for a claim that is empty, cannot be read or names none.
async function readClaimant(
	file: string
): Promise< ProcessIdentity | 'released' | 'unreadable' > {
	let held: unknown;
	try {
		held = JSON.parse( await readFile( file, 'utf8' ) );
	} catch ( error ) {
		return ( error as NodeJS.ErrnoException ).code === 'ENOENT' ? 'released' : 'unreadable';
	}
	return ( isRecord( held ) && identityOf( held.claimant ) ) || 'unreadable';
}

// Filesystems without hard links refuse `link` with one of these.
const LINKLESS = new Set( [ 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EISDIR', 'EINVAL' ] );

// Creates `file` exclusively and writes and syncs `content` through that handle.
async function writeExclusive( file: string, content: string ): Promise< void > {
	const handle = await open( file, 'wx', 0o600 );
	try {
		await handle.writeFile( content );
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/**
 * Creates `file` with `content` only if it does not exist, and complete or not
 * at all: the content is written and synced under a unique name, then linked
 * into place, which fails if the file exists. A crash leaves at most that
 * unique `.tmp` file behind. Where hard links are unavailable it falls back to
 * an exclusive create, written and synced through the same handle, after which
 * a crash can leave the file empty: an unreadable lock or claim, which nothing
 * takes for one anyone holds.
 */
async function createExclusive( file: string, content: string ): Promise< void > {
	const temporary = `${ file }.${ randomUUID() }.tmp`;
	await writeExclusive( temporary, content );
	try {
		await link( temporary, file );
	} catch ( error ) {
		if ( ! LINKLESS.has( ( error as NodeJS.ErrnoException ).code ?? '' ) ) throw error;
		await writeExclusive( file, content );
	} finally {
		await unlink( temporary ).catch( () => {} );
	}
}

function ownershipChanged(): Error {
	return new Error( 'Run lock ownership changed' );
}

/** A run lock's holder asked to move or release it after it had released it. */
export class ClaudeRunLockReleasedError extends Error {
	readonly code = 'ERR_CLAUDE_RUN_LOCK_RELEASED';
	constructor() {
		super( 'Run lock already released' );
		this.name = 'ClaudeRunLockReleasedError';
	}
}

/**
 * The run locks of the conversations whose files are in `root`, at the path
 * `lockPath` gives for each, and the claims on their recovery.
 */
export function createRunLocks( root: string, lockPath: ( conversationId: string ) => string ) {
	async function readLock( conversationId: string ): Promise< string | undefined > {
		try {
			return await readFile( lockPath( conversationId ), 'utf8' );
		} catch ( error ) {
			if ( ( error as NodeJS.ErrnoException ).code === 'ENOENT' ) return undefined;
			throw error;
		}
	}
	const claimPrefix = ( conversationId: string, token: string ) =>
		`${ path.basename( lockPath( conversationId ) ) }.${ claudeLockDigest( token ).slice(
			0,
			32
		) }.claim-`;
	return {
		/**
		 * Removes what interrupted lock and claim creations left for the
		 * conversation, and every claim on its recovery whose process is
		 * provably gone. A claim that may still run, or cannot be read, stays.
		 */
		async removeLeftovers(
			conversationId: string,
			checkClaimant: ( identity: ProcessIdentity ) => Promise< ProcessIdentityCheck >
		): Promise< void > {
			const lockName = path.basename( lockPath( conversationId ) );
			const leftovers = ( await readdir( root ) ).filter( ( name ) =>
				name.startsWith( `${ lockName }.` )
			);
			const UUID_TMP = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp';
			const created = new RegExp( `^(?:[0-9a-f]{32}\\.claim-\\d{1,6}\\.)?${ UUID_TMP }$`, 'i' );
			const claim = /^[0-9a-f]{32}\.claim-\d{1,6}$/;
			await Promise.all(
				leftovers.map( async ( name ) => {
					const rest = name.slice( lockName.length + 1 );
					const file = path.join( root, name );
					if ( created.test( rest ) ) return rm( file, { force: true } );
					if ( ! claim.test( rest ) ) return;
					const claimant = await readClaimant( file );
					if (
						typeof claimant === 'object' &&
						( await checkClaimant( claimant ).catch( () => 'unknown' ) ) === 'gone'
					)
						await rm( file, { force: true } );
				} )
			);
		},
		/** Holds the conversation for something other than a turn, such as its deletion. */
		async lockTurn( conversationId: string, purpose: 'delete' | 'target' = 'delete' ) {
			await mkdir( root, { recursive: true } );
			const lock = lockPath( conversationId );
			const token = randomUUID();
			await createExclusive(
				lock,
				JSON.stringify( {
					version: 2,
					purpose,
					token,
					conversationId,
					createdAt: new Date().toISOString(),
				} )
			);
			return async () => {
				let held: unknown;
				try {
					held = JSON.parse( await readFile( lock, 'utf8' ) );
				} catch {
					throw ownershipChanged();
				}
				if ( ! isRecord( held ) || held.token !== token ) throw ownershipChanged();
				await unlink( lock );
			};
		},
		/**
		 * Takes the conversation's run lock for a turn, complete with its owner,
		 * or fails with EEXIST. The lock path is only ever created by exclusive
		 * create. After that, only its holder writes it: each stage whole, by
		 * atomic rename over a lock it has just read as its own. Its updates and
		 * its release run one at a time, in order, and once it is released every
		 * later update or release is refused with `ClaudeRunLockReleasedError`, so
		 * no rename can land after the removal.
		 */
		async lockRun( conversationId: string, input: ClaudeRunLockInput ) {
			await mkdir( root, { recursive: true } );
			const lock = lockPath( conversationId );
			let record: ClaudeRunLockRecord = {
				version: 2,
				purpose: 'run',
				token: randomUUID(),
				conversationId,
				platform: process.platform,
				owner: { pid: input.owner.pid, start: input.owner.start },
				createdAt: new Date().toISOString(),
				runId: input.runId,
				turnId: input.turnId,
				connection: { id: input.connection.id, revision: input.connection.revision },
				workspace: {
					siteId: input.workspace.siteId,
					workingDirectory: input.workspace.workingDirectory,
					configDirectory: input.workspace.configDirectory,
				},
				stage: 'locked',
			};
			if ( ! runLockOf( { ...record } ) ) throw new Error( 'Invalid run lock' );
			await createExclusive( lock, JSON.stringify( record ) );
			const own = async () => {
				const found = inspectLockContent(
					await readFile( lock, 'utf8' ).catch( () => {
						throw ownershipChanged();
					} )
				);
				if ( found.state !== 'run' || found.record.token !== record.token )
					throw ownershipChanged();
			};
			let pending = Promise.resolve();
			let released = false;
			const serialized = ( work: () => Promise< void > ): Promise< void > => {
				const result = pending.then( work );
				pending = result.catch( () => {} );
				return result;
			};
			return {
				update( next: ClaudeRunLockStage ): Promise< void > {
					return serialized( async () => {
						if ( released ) throw new ClaudeRunLockReleasedError();
						const updated = { ...record, ...next };
						if ( ! runLockOf( { ...updated } ) ) throw new Error( 'Invalid run lock' );
						await own();
						await atomicWriteFile( lock, JSON.stringify( updated ), { mode: 0o600 } );
						record = updated;
					} );
				},
				release(): Promise< void > {
					return serialized( async () => {
						if ( released ) throw new ClaudeRunLockReleasedError();
						released = true;
						await own();
						await unlink( lock );
					} );
				},
			};
		},
		async inspectLock( conversationId: string ): Promise< ClaudeLockInspection > {
			let raw: string | undefined;
			try {
				raw = await readLock( conversationId );
			} catch {
				return { state: 'unreadable' };
			}
			return raw === undefined ? { state: 'none' } : inspectLockContent( raw );
		},
		/** Whether the lock on disk is still exactly `raw`. */
		async holdsLock( conversationId: string, raw: string ): Promise< boolean > {
			return ( await readLock( conversationId ) ) === raw;
		},
		/**
		 * Removes the lock only while it is still exactly `raw`. Called by a
		 * recovery that holds the claim on it, after proving its owner gone, so
		 * nothing else can replace it between the check and the removal.
		 */
		async releaseRecoveredLock( conversationId: string, raw: string ): Promise< boolean > {
			if ( ( await readLock( conversationId ) ) !== raw ) return false;
			await unlink( lockPath( conversationId ) );
			return true;
		},
		/**
		 * Claims the recovery of the lock with `token`, for `claimant`. One claim
		 * per generation is created exclusively; a later generation is taken only
		 * when the claimant of the latest one is gone. `held` when another claim
		 * is held, or its claimant is alive or cannot be checked; `unreadable`
		 * when the latest claim is empty or names no claimant, as one whose
		 * creation was interrupted on a filesystem without hard links does.
		 */
		async claimRecovery(
			conversationId: string,
			token: string,
			claimant: ProcessIdentity,
			check: ( identity: ProcessIdentity ) => Promise< ProcessIdentityCheck >
		): Promise< ClaudeRecoveryClaim > {
			const prefix = claimPrefix( conversationId, token );
			const generations = ( await readdir( root ) ).flatMap( ( name ) => {
				const generation = name.startsWith( prefix ) ? name.slice( prefix.length ) : '';
				return /^\d{1,6}$/.test( generation ) ? [ Number( generation ) ] : [];
			} );
			let next = 0;
			if ( generations.length ) {
				const latest = Math.max( ...generations );
				const holder = await readClaimant( path.join( root, prefix + latest ) );
				if ( holder === 'unreadable' ) return { state: 'unreadable' };
				// A claim released since it was listed: its recovery has just ended.
				if ( holder === 'released' || ( await check( holder ) ) !== 'gone' )
					return { state: 'held' };
				next = latest + 1;
			}
			try {
				await createExclusive(
					path.join( root, prefix + next ),
					JSON.stringify( { version: 1, claimant } )
				);
			} catch ( error ) {
				if ( ( error as NodeJS.ErrnoException ).code === 'EEXIST' ) return { state: 'held' };
				throw error;
			}
			return {
				state: 'claimed',
				async release() {
					await Promise.all(
						[ ...generations, next ].map( ( generation ) =>
							rm( path.join( root, prefix + generation ), { force: true } )
						)
					);
				},
			};
		},
	};
}
