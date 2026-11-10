import { createHash, randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import {
	appendFile,
	lstat,
	mkdir,
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
import { writeFile as atomicWriteFile } from 'atomically';
import { resolveClaudeResume } from '../backends/resume';
import type { ClaudeTranscriptCandidate } from '../backends/resume';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';
import type {
	ClaudeBackendSessionBinding,
	ClaudeBackendSessionRef,
} from '@studio/agent/protocol/backend-sessions';

function key( conversationId: string ) {
	if ( ! conversationId ) throw new Error( 'Missing conversation ID' );
	return createHash( 'sha256' ).update( conversationId ).digest( 'hex' );
}

async function readJournalFile( file: string ): Promise< BackendTurnEvent[] > {
	const lines = ( await readFile( file, 'utf8' ) ).split( '\n' );
	// Every committed entry ends with a newline. A killed writer can leave a partial tail.
	lines.pop();
	return lines.filter( Boolean ).map( ( line ) => JSON.parse( line ) as BackendTurnEvent );
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
		typeof record.siteId !== 'string' ||
		! record.siteId ||
		typeof record.workingDirectory !== 'string' ||
		! path.isAbsolute( record.workingDirectory ) ||
		typeof record.configDirectory !== 'string' ||
		! path.isAbsolute( record.configDirectory ) ||
		( record.transcriptPath !== undefined &&
			( typeof record.transcriptPath !== 'string' || ! path.isAbsolute( record.transcriptPath ) ) )
	)
		throw new Error( 'Invalid native session' );
	return {
		backend: 'claude-code',
		nativeSessionId: record.nativeSessionId,
		connectionId: record.connectionId,
		conversationId: record.conversationId,
		siteId: record.siteId,
		workingDirectory: record.workingDirectory,
		configDirectory: record.configDirectory,
		...( record.transcriptPath ? { transcriptPath: record.transcriptPath as string } : {} ),
	};
}
export function getClaudeSessionStoreRoot( sessionsRoot: string ): string {
	return `${ sessionsRoot }.claude-code`;
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
		async clearConversation(
			conversationId: string,
			removeSession: () => Promise< void >
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
			await removeSession();
			await rm( marker, { force: true } );
		},
		async readJournals( conversationId: string ): Promise< BackendTurnEvent[][] > {
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
			return entries.filter( ( entry ): entry is BackendTurnEvent[] => entry !== undefined );
		},
		journal( conversationId: string, turnId: string ) {
			const journalPath = path.join(
				root,
				`${ key( conversationId ) }-${ key( turnId ) }.journal.jsonl`
			);
			let pending = Promise.resolve();
			let indexed = false;
			return {
				append( event: BackendTurnEvent ) {
					if ( event.turnId !== turnId ) throw new Error( 'Turn mismatch' );
					pending = pending.then( async () => {
						if ( ! indexed ) {
							await mkdir( root, { recursive: true } );
							const name = path.basename( journalPath );
							const order = await orderedNames( conversationId );
							if ( ! order.includes( name ) ) order.push( name );
							await atomicWriteFile(
								orderPath( conversationId ),
								JSON.stringify( { version: 1, entries: order } ),
								{ mode: 0o600 }
							);
							indexed = true;
						}
						await appendFile( journalPath, JSON.stringify( event ) + '\n', { mode: 0o600 } );
					} );
					return pending;
				},
				async read(): Promise< BackendTurnEvent[] > {
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
		async lockTurn( conversationId: string ) {
			await mkdir( root, { recursive: true } );
			const lock = lockPath( conversationId );
			const token = randomUUID();
			await writeFile( lock, token, { flag: 'wx', mode: 0o600 } );
			return async () => {
				if ( ( await readFile( lock, 'utf8' ) ) !== token )
					throw new Error( 'Run lock ownership changed' );
				await unlink( lock );
			};
		},
		async create( input: ClaudeBackendSessionRef ) {
			const record = validate( input );
			await mkdir( root, { recursive: true } );
			await writeFile( filename( record.conversationId ), JSON.stringify( record ), {
				flag: 'wx',
				mode: 0o600,
			} );
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
