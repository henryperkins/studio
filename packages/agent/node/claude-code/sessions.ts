import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import {
	appendFile,
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rm,
	stat,
	writeFile,
} from 'fs/promises';
import path from 'path';
import { createInterface } from 'readline';
import { checkProcessIdentity } from '@studio/common/lib/owned-process';
import { writeFile as atomicWriteFile } from 'atomically';
import { resolveClaudeResume } from '../backends/resume';
import { createRunLocks } from './run-lock';
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

// Appends `line` and syncs the file to disk through the same handle.
async function appendSynced( file: string, line: string ): Promise< void > {
	const handle = await open( file, 'a', 0o600 );
	try {
		await handle.appendFile( line );
		await handle.sync();
	} finally {
		await handle.close();
	}
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
	const locks = createRunLocks( root, lockPath );
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
			await locks.removeLeftovers( conversationId, checkClaimant );
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
				/**
				 * Appends `event`. The entry that lets an operation run is synced to
				 * disk before this settles, so it survives a power loss too.
				 */
				append( event: ClaudeTurnJournalEvent ) {
					if ( event.turnId !== turnId ) throw new Error( 'Turn mismatch' );
					pending = pending.then( async () => {
						if ( ! indexed ) {
							await index( conversationId, path.basename( journalPath ) );
							indexed = true;
						}
						const line = JSON.stringify( event ) + '\n';
						if ( event.type === 'operation.authorized' ) await appendSynced( journalPath, line );
						else await appendFile( journalPath, line, { mode: 0o600 } );
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
		lockTurn: locks.lockTurn,
		lockRun: locks.lockRun,
		inspectLock: locks.inspectLock,
		holdsLock: locks.holdsLock,
		releaseRecoveredLock: locks.releaseRecoveredLock,
		claimRecovery: locks.claimRecovery,
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
