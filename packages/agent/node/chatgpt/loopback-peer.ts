import { open } from 'node:fs/promises';
import { endianness } from 'node:os';
import { isErrnoException } from '@studio/common/lib/is-errno-exception';

/**
 * Which local user owns the other end of a TCP connection to a 127.0.0.1
 * listener, read from Linux's socket tables. Nothing is spawned: the kernel
 * lists every TCP socket of this network namespace, with its owner, in
 * /proc/net/tcp (IPv4 sockets) and /proc/net/tcp6 (IPv6 sockets, including
 * one an IPv6 socket opened to an IPv4-mapped 127.0.0.1).
 *
 * The layout is the kernel's (Documentation/networking/proc_net_tcp.rst;
 * tcp4_seq_show() and get_tcp4_sock() in net/ipv4/tcp_ipv4.c, tcp6_seq_show()
 * and get_tcp6_sock() in net/ipv6/tcp_ipv6.c): a header line, then a row per
 * socket, "%4d: %08X:%04X %08X:%04X %02X %08X:%08X %02X:%08lX %08X %5u ...",
 * that is slot, local address:port, remote address:port, state,
 * tx:rx queue, timer:expiry, retransmits and uid. An address is each 32-bit
 * word of it in network order printed with %08X on the host, so 127.0.0.1 is
 * 0100007F on a little-endian machine; a port is %04X.
 */

/**
 * `unreadable` when a table couldn't be read or parsed for any reason but the
 * kernel hiding it from this process; `unknown` when the tables could be read
 * (or are hidden) and still don't prove an owner.
 */
export type LoopbackPeerOwner = 'same-user' | 'root' | 'other-user' | 'unknown' | 'unreadable';

/** A connection as the listener sees it: `remote` is the peer's end, `local` the listener's. */
export interface LoopbackConnection {
	remoteAddress: string;
	remotePort: number;
	localAddress: string;
	localPort: number;
}

const TCP_FILE = '/proc/net/tcp';
const TCP6_FILE = '/proc/net/tcp6';
const OVERFLOW_UID_FILE = '/proc/sys/kernel/overflowuid';
const UID_MAP_FILE = '/proc/self/uid_map';

const TCP_HEADER =
	/^\s*sl\s+local_address\s+rem_address\s+st\s+tx_queue\s+rx_queue\s+tr\s+tm->when\s+retrnsmt\s+uid\s+timeout\s+inode\s*$/;
const TCP6_HEADER =
	/^\s*sl\s+local_address\s+remote_address\s+st\s+tx_queue\s+rx_queue\s+tr\s+tm->when\s+retrnsmt\s+uid\s+timeout\s+inode\s*$/;
// The kernel's default; /proc/sys/kernel/overflowuid says otherwise when changed.
const DEFAULT_OVERFLOW_UID = 65534;
// timer_active 3: a TIME_WAIT socket, whose uid the kernel prints as 0.
const TIME_WAIT_TIMER = '03';
// A row takes about 150 bytes, so this is some 28,000 sockets in a table, where
// a desktop lists hundreds; up to it, reading and parsing a table stays quick.
const MAX_TABLE_BYTES = 4 * 1024 * 1024;
const MAX_SETTING_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
// A lookup normally takes milliseconds; a browser waiting this long for its
// answer is still fine, and a stalled read refuses rather than hold a request.
const LOOKUP_TIMEOUT_MS = 2_000;
// How the kernel says a table isn't this process's to see: absent (a kernel
// without IPv6, say) or forbidden (a hardened /proc).
const HIDDEN_CODES = new Set( [ 'ENOENT', 'EACCES', 'EPERM' ] );

const isHidden = ( error: unknown ) =>
	isErrnoException( error ) && HIDDEN_CODES.has( error.code ?? '' );

interface Row {
	local: string;
	remote: string;
	timer: string;
	uid: number;
}

// One table's rows; null when it isn't in the layout above, or a row of it isn't.
function parseTable( text: string, header: RegExp, addressDigits: number ): Row[] | null {
	const [ first, ...lines ] = text.split( '\n' );
	if ( ! header.test( first ) ) {
		return null;
	}
	const endpoint = new RegExp( `^[0-9A-F]{${ addressDigits }}:[0-9A-F]{4}$`, 'i' );
	const rows: Row[] = [];
	for ( const line of lines ) {
		if ( line.trim() === '' ) {
			continue;
		}
		const [ slot, local, remote, state, queues, timers, retransmits, uid ] = line
			.trim()
			.split( /\s+/ );
		if (
			! /^\d+:$/.test( slot ?? '' ) ||
			! endpoint.test( local ?? '' ) ||
			! endpoint.test( remote ?? '' ) ||
			! /^[0-9A-F]{2}$/i.test( state ?? '' ) ||
			! /^[0-9A-F]{8}:[0-9A-F]{8}$/i.test( queues ?? '' ) ||
			! /^[0-9A-F]{2}:[0-9A-F]{8,16}$/i.test( timers ?? '' ) ||
			! /^[0-9A-F]{8}$/i.test( retransmits ?? '' ) ||
			! /^\d{1,10}$/.test( uid ?? '' )
		) {
			return null;
		}
		rows.push( {
			local: local.toUpperCase(),
			remote: remote.toUpperCase(),
			timer: timers.slice( 0, 2 ),
			uid: Number( uid ),
		} );
	}
	return rows;
}

/**
 * Whether a /proc/self/uid_map maps every uid, so the kernel never shows an
 * owner as the overflow uid. Each line of the map is three numbers delimited
 * by white space (user_namespaces(7), "User and group ID mappings"); the
 * initial user namespace's is the single line "0 0 4294967295", which maps
 * every uid but (uid_t) -1.
 */
function mapsEveryUid( uidMap: string ): boolean {
	const lines = uidMap.split( '\n' ).filter( ( line ) => line.trim() !== '' );
	const fields = lines.length === 1 ? lines[ 0 ].trim().split( /\s+/ ) : [];
	return (
		fields.length === 3 &&
		fields.every( ( field ) => /^\d+$/.test( field ) ) &&
		fields.map( Number ).join( ' ' ) === '0 0 4294967295'
	);
}

// The four bytes of an IPv4 address, plain or IPv4-mapped; null for anything else.
function ipv4Bytes( address: string ): number[] | null {
	const plain = address.toLowerCase().replace( /^::ffff:/, '' );
	const parts = plain.split( '.' );
	if ( parts.length !== 4 || ! parts.every( ( part ) => /^\d{1,3}$/.test( part ) ) ) {
		return null;
	}
	const bytes = parts.map( Number );
	return bytes.every( ( byte ) => byte <= 255 ) ? bytes : null;
}

// One 32-bit word of an address, as %08X prints it on this host.
const word = ( bytes: number[], littleEndian: boolean ) =>
	( littleEndian ? [ ...bytes ].reverse() : bytes )
		.map( ( byte ) => byte.toString( 16 ).toUpperCase().padStart( 2, '0' ) )
		.join( '' );

const port = ( value: number ) => value.toString( 16 ).toUpperCase().padStart( 4, '0' );

/**
 * Whose socket the peer's end of `connection` is: its row is the one whose
 * local end is the peer's address and port and whose remote end is the
 * listener's, in either table. A table left out is one the kernel hides.
 * `unreadable` when a table isn't in the kernel's layout. `unknown` whenever
 * the tables don't prove an owner: no such row, rows that disagree, an
 * address that isn't IPv4, or the overflow uid, which stands for an owner the
 * kernel couldn't map into this user namespace, unless `uidMap` maps every uid.
 */
export function findLoopbackPeerOwner(
	tables: { tcp?: string; tcp6?: string },
	connection: LoopbackConnection,
	ownUid: number,
	{
		littleEndian = endianness() === 'LE',
		overflowUid = DEFAULT_OVERFLOW_UID,
		uidMap,
	}: { littleEndian?: boolean; overflowUid?: number; uidMap?: string } = {}
): LoopbackPeerOwner {
	const tcpRows = tables.tcp === undefined ? [] : parseTable( tables.tcp, TCP_HEADER, 8 );
	const tcp6Rows = tables.tcp6 === undefined ? [] : parseTable( tables.tcp6, TCP6_HEADER, 32 );
	if ( ! tcpRows || ! tcp6Rows ) {
		return 'unreadable';
	}
	const peer = ipv4Bytes( connection.remoteAddress );
	const listener = ipv4Bytes( connection.localAddress );
	if ( ! peer || ! listener ) {
		return 'unknown';
	}
	const mapped = ( bytes: number[] ) =>
		`${ word( [ 0, 0, 0, 0 ], littleEndian ) }${ word( [ 0, 0, 0, 0 ], littleEndian ) }${ word(
			[ 0, 0, 0xff, 0xff ],
			littleEndian
		) }${ word( bytes, littleEndian ) }`;
	const candidates = [
		{
			rows: tcpRows,
			local: `${ word( peer, littleEndian ) }:${ port( connection.remotePort ) }`,
			remote: `${ word( listener, littleEndian ) }:${ port( connection.localPort ) }`,
		},
		{
			rows: tcp6Rows,
			local: `${ mapped( peer ) }:${ port( connection.remotePort ) }`,
			remote: `${ mapped( listener ) }:${ port( connection.localPort ) }`,
		},
	];
	const owners = new Set(
		candidates.flatMap( ( { rows, local, remote } ) =>
			rows
				.filter(
					( row ) => row.local === local && row.remote === remote && row.timer !== TIME_WAIT_TIMER
				)
				.map( ( row ) => row.uid )
		)
	);
	if ( owners.size !== 1 ) {
		return 'unknown';
	}
	const [ uid ] = owners;
	if ( uid === ownUid ) {
		return 'same-user';
	}
	if ( uid === overflowUid && ! mapsEveryUid( uidMap ?? '' ) ) {
		return 'unknown';
	}
	return uid === 0 ? 'root' : 'other-user';
}

/** A file under /proc, kept open and read again from its start whenever asked. */
export interface ProcFile {
	/** Reads into `buffer` from byte `position` of the file; resolves with how many bytes it read. */
	read( buffer: Buffer, position: number ): Promise< number >;
	close(): Promise< void >;
}

/** Whose socket a request comes from, for as long as the listener lasts. */
export interface LoopbackPeerLookup {
	/** Read from the tables as they are now. */
	ownerOf( connection: LoopbackConnection ): Promise< LoopbackPeerOwner >;
	/** Closes the tables, once any lookup in progress is done; later lookups are `unreadable`. */
	close(): Promise< void >;
}

interface LoopbackPeerSystem {
	/** Opens a file under /proc; rejects, with the system's code, when it can't. */
	open?: ( file: string ) => Promise< ProcFile >;
	/** This process's uid, null when it has none; left out, the process's own. */
	uid?: number | null;
	littleEndian?: boolean;
	/** Replaced only by tests: how long a lookup may take, from when it is asked. */
	timeoutMs?: number;
}

async function openProcFile( file: string ): Promise< ProcFile > {
	const handle = await open( file, 'r' );
	return {
		read: async ( buffer, position ) =>
			( await handle.read( buffer, 0, buffer.length, position ) ).bytesRead,
		close: () => handle.close(),
	};
}

// The whole file, from its start. The kernel's seq_file, behind every file
// read here, supports pread and starts over when read at offset 0
// (fs/seq_file.c), so a file kept open reads afresh each time.
async function readFromStart( file: ProcFile, limit: number ): Promise< string > {
	const chunks: Buffer[] = [];
	let length = 0;
	for (;;) {
		const chunk = Buffer.alloc( READ_CHUNK_BYTES );
		const read = await file.read( chunk, length );
		if ( read === 0 ) {
			return Buffer.concat( chunks, length ).toString( 'utf8' );
		}
		length += read;
		if ( length > limit ) {
			throw new RangeError( 'The file is larger than Studio reads.' );
		}
		chunks.push( chunk.subarray( 0, read ) );
	}
}

function within< T >( work: Promise< T >, ms: number ): Promise< T > {
	let timer: ReturnType< typeof setTimeout > | undefined;
	const late = new Promise< never >( ( _resolve, reject ) => {
		timer = setTimeout( () => reject( new Error( 'The lookup took too long.' ) ), ms );
		timer.unref?.();
	} );
	return Promise.race( [ work, late ] ).finally( () => clearTimeout( timer ) );
}

type Table = { file: ProcFile } | 'hidden' | 'unopened';

/**
 * Opens the socket tables now, for a listener to ask about each request it
 * gets: each lookup reads them again through the same open files, so nothing
 * is opened per request. A table the kernel hides (ENOENT, EACCES, EPERM)
 * counts as no table; any other failure to read or parse one, a table larger
 * than 4 MiB or a lookup slower than 2 seconds makes the answer `unreadable`.
 * A table that failed to open is opened again at the next lookup. Lookups run
 * one at a time. The overflow uid and the uid map are read once, as it opens;
 * when either can't be read, the overflow uid stays an unproven owner.
 */
export function openLoopbackPeerLookup( system: LoopbackPeerSystem = {} ): LoopbackPeerLookup {
	const openFile = system.open ?? openProcFile;
	const uid = system.uid === undefined ? process.getuid?.() ?? null : system.uid;
	const littleEndian = system.littleEndian ?? endianness() === 'LE';
	const timeoutMs = system.timeoutMs ?? LOOKUP_TIMEOUT_MS;
	if ( uid === null ) {
		return { ownerOf: async () => 'unknown', close: async () => undefined };
	}

	const files = [ TCP_FILE, TCP6_FILE ];
	const tables: Table[] = [ 'unopened', 'unopened' ];
	let closed = false;

	async function openTable( index: number ): Promise< void > {
		try {
			tables[ index ] = { file: await openFile( files[ index ] ) };
		} catch ( error ) {
			if ( ! isHidden( error ) ) {
				throw error;
			}
			tables[ index ] = 'hidden';
		}
	}

	async function readSetting( name: string ): Promise< string | undefined > {
		let file: ProcFile | undefined;
		try {
			file = await openFile( name );
			return await readFromStart( file, MAX_SETTING_BYTES );
		} catch {
			return undefined;
		} finally {
			await file?.close().catch( () => undefined );
		}
	}

	// Undefined for a table the kernel hides.
	async function readTable( index: number ): Promise< string | undefined > {
		if ( tables[ index ] === 'unopened' ) {
			await openTable( index );
		}
		const table = tables[ index ];
		if ( table === 'hidden' || table === 'unopened' ) {
			return undefined;
		}
		try {
			return await readFromStart( table.file, MAX_TABLE_BYTES );
		} catch ( error ) {
			if ( isHidden( error ) ) {
				return undefined;
			}
			throw error;
		}
	}

	const opening = Promise.all(
		files.map( ( _file, index ) => openTable( index ).catch( () => undefined ) )
	);
	const settings = Promise.all( [ readSetting( OVERFLOW_UID_FILE ), readSetting( UID_MAP_FILE ) ] );
	let queue: Promise< unknown > = opening;

	async function lookUp(
		connection: LoopbackConnection,
		ownUid: number
	): Promise< LoopbackPeerOwner > {
		if ( closed ) {
			return 'unreadable';
		}
		// One after the other: a lookup that fails has no read left running.
		const tcp = await readTable( 0 );
		const tcp6 = await readTable( 1 );
		const [ overflow, uidMap ] = await settings;
		const overflowUid = /^\d+$/.test( overflow?.trim() ?? '' )
			? Number( overflow?.trim() )
			: DEFAULT_OVERFLOW_UID;
		return findLoopbackPeerOwner( { tcp, tcp6 }, connection, ownUid, {
			littleEndian,
			overflowUid,
			uidMap,
		} );
	}

	return {
		ownerOf( connection ) {
			const lookup = queue.then( () => lookUp( connection, uid ) );
			queue = lookup.catch( () => undefined );
			return within( lookup, timeoutMs ).catch( () => 'unreadable' as const );
		},
		async close() {
			closed = true;
			await queue;
			await Promise.all(
				tables.map( ( table ) =>
					typeof table === 'object' ? table.file.close().catch( () => undefined ) : undefined
				)
			);
		},
	};
}
