import { createHash, randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import {
	appendFile,
	link,
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rm,
	stat,
	unlink,
	writeFile,
} from 'fs/promises';
import path from 'path';
import { createInterface } from 'readline';
import { checkProcessIdentity } from '@studio/common/lib/owned-process';
import { writeFile as atomicWriteFile } from 'atomically';
import { resolveClaudeResume } from '../backends/resume';
import type { ClaudeTranscriptCandidate } from '../backends/resume';
import type {
	BackendTurnEvent,
	ClaudeJournalEvent,
	ClaudeTurnJournalEvent,
} from '@studio/agent/protocol/backend-events';
import type {
	ClaudeBackendSessionBinding,
	ClaudeBackendSessionRef,
} from '@studio/agent/protocol/backend-sessions';
import type { ProcessIdentity, ProcessIdentityCheck } from '@studio/common/lib/owned-process';

function key( conversationId: string ) {
	if ( ! conversationId ) throw new Error( 'Missing conversation ID' );
	return createHash( 'sha256' ).update( conversationId ).digest( 'hex' );
}

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

// An approval journaled before requests named their operation is kept for
// display only, under its own type, so it can never be taken for a live request.
function readJournalEvent( line: string ): ClaudeJournalEvent {
	const event = JSON.parse( line ) as BackendTurnEvent;
	if ( event.type !== 'approval.requested' ) return event;
	const operation: unknown = event.operation;
	if (
		operation &&
		typeof operation === 'object' &&
		typeof ( operation as { tool?: unknown } ).tool === 'string'
	)
		return event;
	const { runId, turnId, toolCallId, requestId, description, draft } = event;
	return {
		type: 'approval.legacy',
		runId,
		turnId,
		toolCallId,
		requestId,
		description: typeof description === 'string' ? description : '',
		...( draft ? { draft } : {} ),
	};
}

async function readJournalFile( file: string ): Promise< ClaudeJournalEvent[] > {
	const lines = ( await readFile( file, 'utf8' ) ).split( '\n' );
	// Every committed entry ends with a newline. A killed writer can leave a partial tail.
	lines.pop();
	return lines.filter( Boolean ).map( readJournalEvent );
}
function validate( value: unknown ): ClaudeBackendSessionRef {
	if ( ! value || typeof value !== 'object' ) throw new Error( 'Invalid native session' );
	const record = value as Record< string, unknown >;
	if (
		record.backend !== 'claude-code' ||
		typeof record.nativeSessionId !== 'string' ||
		! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			record.nativeSessionId
		) ||
		typeof record.connectionId !== 'string' ||
		! record.connectionId ||
		typeof record.conversationId !== 'string' ||
		! record.conversationId ||
		! ( record.siteId === null || ( typeof record.siteId === 'string' && record.siteId ) ) ||
		typeof record.workingDirectory !== 'string' ||
		! path.isAbsolute( record.workingDirectory ) ||
		typeof record.configDirectory !== 'string' ||
		! path.isAbsolute( record.configDirectory ) ||
		( record.transcriptPath !== undefined &&
			( typeof record.transcriptPath !== 'string' ||
				! path.isAbsolute( record.transcriptPath ) ) ) ||
		( record.accountKey !== undefined &&
			( typeof record.accountKey !== 'string' || ! /^[0-9a-f]{64}$/.test( record.accountKey ) ) )
	)
		throw new Error( 'Invalid native session' );
	return {
		backend: 'claude-code',
		nativeSessionId: record.nativeSessionId,
		connectionId: record.connectionId,
		conversationId: record.conversationId,
		siteId: record.siteId as string | null,
		workingDirectory: record.workingDirectory,
		configDirectory: record.configDirectory,
		...( record.transcriptPath ? { transcriptPath: record.transcriptPath as string } : {} ),
		...( record.accountKey ? { accountKey: record.accountKey as string } : {} ),
	};
}
export function getClaudeSessionStoreRoot( sessionsRoot: string ): string {
	return `${ sessionsRoot }.claude-code`;
}

/** The native workspace every global Claude conversation runs in. */
export function getClaudeGlobalWorkspace( storeRoot: string ): string {
	return path.join( storeRoot, 'global-workspace' );
}

export function createNativeSessionStore( root: string ) {
	const filename = ( conversationId: string ) =>
		path.join( root, `${ key( conversationId ) }.json` );
	const orderPath = ( conversationId: string ) =>
		path.join( root, `${ key( conversationId ) }.journal-order.json` );
	const lockPath = ( conversationId: string ) => filename( conversationId ) + '.lock';
	const deletionPath = ( conversationId: string ) => filename( conversationId ) + '.deleting';
	const journalPrefix = ( conversationId: string ) => `${ key( conversationId ) }-`;
	async function journalNames( conversationId: string ): Promise< string[] > {
		try {
			const prefix = journalPrefix( conversationId );
			return ( await readdir( root ) ).filter(
				( name ) =>
					name.startsWith( prefix ) &&
					/^[a-f0-9]{64}\.journal\.jsonl$/.test( name.slice( prefix.length ) )
			);
		} catch ( error ) {
			if ( ( error as NodeJS.ErrnoException ).code === 'ENOENT' ) return [];
			throw error;
		}
	}
	async function readOrder( conversationId: string ): Promise< string[] > {
		let data: unknown;
		try {
			data = JSON.parse( await readFile( orderPath( conversationId ), 'utf8' ) );
		} catch ( error ) {
			if ( ( error as NodeJS.ErrnoException ).code === 'ENOENT' ) return [];
			throw error;
		}
		const record = data as { version?: unknown; entries?: unknown } | null;
		const prefix = journalPrefix( conversationId );
		if (
			record?.version !== 1 ||
			! Array.isArray( record.entries ) ||
			record.entries.some(
				( name: unknown ) =>
					typeof name !== 'string' ||
					! name.startsWith( prefix ) ||
					! /^[a-f0-9]{64}\.journal\.jsonl$/.test( name.slice( prefix.length ) )
			) ||
			new Set( record.entries ).size !== record.entries.length
		)
			throw new Error( 'Invalid journal order' );
		return record.entries as string[];
	}
	async function orderedNames( conversationId: string ): Promise< string[] > {
		const [ names, order ] = await Promise.all( [
			journalNames( conversationId ),
			readOrder( conversationId ),
		] );
		const orderedSet = new Set( order );
		const legacy = await Promise.all(
			names
				.filter( ( name ) => ! orderedSet.has( name ) )
				.map( async ( name ) => ( {
					name,
					time: ( await stat( path.join( root, name ) ) ).birthtimeMs,
				} ) )
		);
		legacy.sort( ( a, b ) => a.time - b.time || a.name.localeCompare( b.name ) );
		return [ ...legacy.map( ( entry ) => entry.name ), ...order ];
	}
	// Records `name` in the conversation's journal order, after every journal it has.
	async function index( conversationId: string, name: string ): Promise< void > {
		await mkdir( root, { recursive: true } );
		const order = await orderedNames( conversationId );
		if ( ! order.includes( name ) ) order.push( name );
		await atomicWriteFile(
			orderPath( conversationId ),
			JSON.stringify( { version: 1, entries: order } ),
			{ mode: 0o600 }
		);
	}
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
		async isTurnLocked( conversationId: string ): Promise< boolean > {
			try {
				await lstat( lockPath( conversationId ) );
				return true;
			} catch ( error ) {
				return ( error as NodeJS.ErrnoException ).code !== 'ENOENT';
			}
		},
		async isPendingDeletion( conversationId: string ): Promise< boolean > {
			try {
				await lstat( deletionPath( conversationId ) );
				return true;
			} catch ( error ) {
				return ( error as NodeJS.ErrnoException ).code !== 'ENOENT';
			}
		},
		/**
		 * Removes the conversation's files while its deletion holds the lock: its
		 * native session record, its journals, and what interrupted lock and
		 * claim creations left. A recovery claim goes only once the process it
		 * names is provably gone; one that may still run, or cannot be read,
		 * stays. A lock set aside by hand (`.manual-…`) stays too.
		 */
		async clearConversation(
			conversationId: string,
			removeSession: () => Promise< void >,
			checkClaimant: (
				identity: ProcessIdentity
			) => Promise< ProcessIdentityCheck > = checkProcessIdentity
		): Promise< void > {
			const marker = deletionPath( conversationId );
			await writeFile( marker, '', { flag: 'a', mode: 0o600 } );
			const names = await journalNames( conversationId );
			await Promise.all(
				[
					filename( conversationId ),
					orderPath( conversationId ),
					...names.map( ( name ) => path.join( root, name ) ),
				].map( ( file ) => rm( file, { force: true } ) )
			);
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
			await removeSession();
			await rm( marker, { force: true } );
		},
		async readJournals( conversationId: string ): Promise< ClaudeJournalEvent[][] > {
			const names = await orderedNames( conversationId );
			const entries = await Promise.all(
				names.map( async ( name ) => {
					try {
						return await readJournalFile( path.join( root, name ) );
					} catch ( error ) {
						if ( ( error as NodeJS.ErrnoException ).code === 'ENOENT' ) return undefined;
						throw error;
					}
				} )
			);
			return entries.filter( ( entry ): entry is ClaudeJournalEvent[] => entry !== undefined );
		},
		journal( conversationId: string, turnId: string ) {
			const journalPath = path.join(
				root,
				`${ key( conversationId ) }-${ key( turnId ) }.journal.jsonl`
			);
			let pending = Promise.resolve();
			let indexed = false;
			return {
				append( event: ClaudeTurnJournalEvent ) {
					if ( event.turnId !== turnId ) throw new Error( 'Turn mismatch' );
					pending = pending.then( async () => {
						if ( ! indexed ) {
							await index( conversationId, path.basename( journalPath ) );
							indexed = true;
						}
						await appendFile( journalPath, JSON.stringify( event ) + '\n', { mode: 0o600 } );
					} );
					return pending;
				},
				async read(): Promise< ClaudeJournalEvent[] > {
					await pending;
					try {
						return await readJournalFile( journalPath );
					} catch ( error ) {
						if ( ( error as NodeJS.ErrnoException ).code === 'ENOENT' ) return [];
						throw error;
					}
				},
			};
		},
		async resolve(
			record: ClaudeBackendSessionRef,
			binding: ClaudeBackendSessionBinding,
			projects: string
		) {
			const candidates: ClaudeTranscriptCandidate[] = [];
			try {
				if ( ( await realpath( projects ) ) !== path.join( record.configDirectory, 'projects' ) )
					return { status: 'rebind-required' as const };
				async function scan( directory: string ): Promise< void > {
					for ( const entry of await readdir( directory, { withFileTypes: true } ) ) {
						const full = path.join( directory, entry.name );
						if ( entry.isDirectory() ) await scan( full );
						else if ( entry.isFile() && entry.name === `${ record.nativeSessionId }.jsonl` ) {
							if ( ( await stat( full ) ).size > 50 * 1024 * 1024 )
								throw new Error( 'Transcript too large' );
							let cwd: string | undefined;
							let validId = false;
							const lines = createInterface( {
								input: createReadStream( full ),
								crlfDelay: Infinity,
							} );
							for await ( const line of lines ) {
								if ( ! line.trim() ) continue;
								const entryData: unknown = JSON.parse( line );
								if ( ! entryData || typeof entryData !== 'object' )
									throw new Error( 'Invalid transcript' );
								const data = entryData as Record< string, unknown >;
								if ( data.sessionId !== undefined && data.sessionId !== record.nativeSessionId )
									throw new Error( 'Session mismatch' );
								if ( data.sessionId === record.nativeSessionId ) validId = true;
								if ( typeof data.cwd === 'string' ) {
									if ( cwd && cwd !== data.cwd ) throw new Error( 'Workspace mismatch' );
									cwd = data.cwd;
								}
							}
							candidates.push( {
								nativeSessionId: record.nativeSessionId,
								workingDirectory: validId ? cwd : undefined,
								configDirectory: record.configDirectory,
								transcriptPath: full,
							} );
						}
					}
				}
				await scan( projects );
			} catch ( error ) {
				if ( ( error as NodeJS.ErrnoException ).code !== 'ENOENT' )
					return { status: 'rebind-required' as const };
			}
			return resolveClaudeResume( record, binding, candidates );
		},
		/** Holds the conversation for something other than a turn, such as its deletion. */
		async lockTurn( conversationId: string ) {
			await mkdir( root, { recursive: true } );
			const lock = lockPath( conversationId );
			const token = randomUUID();
			await createExclusive(
				lock,
				JSON.stringify( {
					version: 2,
					purpose: 'delete',
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
		/**
		 * Records what recovering the lock with `token` adds to the journal, once:
		 * in its own journal file, written whole, after every existing journal.
		 * False when it was already recorded.
		 */
		async recordRecovery(
			conversationId: string,
			token: string,
			events: ClaudeJournalEvent[]
		): Promise< boolean > {
			const name = `${ key( conversationId ) }-${ key( `recovery:${ token }` ) }.journal.jsonl`;
			await index( conversationId, name );
			const file = path.join( root, name );
			try {
				await stat( file );
				return false;
			} catch ( error ) {
				if ( ( error as NodeJS.ErrnoException ).code !== 'ENOENT' ) throw error;
			}
			await atomicWriteFile(
				file,
				events.map( ( event ) => JSON.stringify( event ) + '\n' ).join( '' ),
				{ mode: 0o600 }
			);
			return true;
		},
		async create( input: ClaudeBackendSessionRef ) {
			const record = validate( input );
			await mkdir( root, { recursive: true } );
			await writeFile( filename( record.conversationId ), JSON.stringify( record ), {
				flag: 'wx',
				mode: 0o600,
			} );
		},
		/**
		 * Records the account a conversation that predates account binding runs on.
		 * A conversation already bound to an account keeps it.
		 */
		async bindAccount( conversationId: string, accountKey: string ): Promise< void > {
			const record = validate( JSON.parse( await readFile( filename( conversationId ), 'utf8' ) ) );
			if ( record.conversationId !== conversationId ) throw new Error( 'Conversation mismatch' );
			if ( record.accountKey === accountKey ) return;
			if ( record.accountKey ) throw new Error( 'Conversation bound to another account' );
			const bound = validate( { ...record, accountKey } );
			await atomicWriteFile( filename( conversationId ), JSON.stringify( bound ), { mode: 0o600 } );
		},
		async load( conversationId: string ): Promise< ClaudeBackendSessionRef | undefined > {
			try {
				const result = validate(
					JSON.parse( await readFile( filename( conversationId ), 'utf8' ) )
				);
				if ( result.conversationId !== conversationId ) throw new Error( 'Conversation mismatch' );
				return result;
			} catch ( error ) {
				if ( ( error as NodeJS.ErrnoException ).code === 'ENOENT' ) return;
				throw error;
			}
		},
	};
}
