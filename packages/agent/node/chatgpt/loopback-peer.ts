import { readFile } from 'node:fs/promises';
import { endianness } from 'node:os';

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

export type LoopbackPeerOwner = 'same-user' | 'root' | 'other-user' | 'unknown';

/** A connection as the listener sees it: `remote` is the peer's end, `local` the listener's. */
export interface LoopbackConnection {
	remoteAddress: string;
	remotePort: number;
	localAddress: string;
	localPort: number;
}

const TCP_HEADER =
	/^\s*sl\s+local_address\s+rem_address\s+st\s+tx_queue\s+rx_queue\s+tr\s+tm->when\s+retrnsmt\s+uid\s+timeout\s+inode\s*$/;
const TCP6_HEADER =
	/^\s*sl\s+local_address\s+remote_address\s+st\s+tx_queue\s+rx_queue\s+tr\s+tm->when\s+retrnsmt\s+uid\s+timeout\s+inode\s*$/;
// The kernel's default; /proc/sys/kernel/overflowuid says otherwise when changed.
const DEFAULT_OVERFLOW_UID = 65534;
// timer_active 3: a TIME_WAIT socket, whose uid the kernel prints as 0.
const TIME_WAIT_TIMER = '03';

interface Row {
	local: string;
	remote: string;
	timer: string;
	uid: number;
}

// One table's rows, or none when its header isn't the layout above.
function parseTable( text: string | undefined, header: RegExp, addressDigits: number ): Row[] {
	const [ first, ...lines ] = ( text ?? '' ).split( '\n' );
	if ( ! header.test( first ?? '' ) ) {
		return [];
	}
	const endpoint = new RegExp( `^[0-9A-F]{${ addressDigits }}:[0-9A-F]{4}$`, 'i' );
	const rows: Row[] = [];
	for ( const line of lines ) {
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
			continue;
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
 * listener's, in either table. `unknown` whenever that can't be established:
 * no such row, rows that disagree, an address that isn't IPv4, a table in
 * another layout, or a uid the kernel couldn't map into this user namespace.
 */
export function findLoopbackPeerOwner(
	tables: { tcp?: string; tcp6?: string },
	connection: LoopbackConnection,
	ownUid: number,
	{
		littleEndian = endianness() === 'LE',
		overflowUid = DEFAULT_OVERFLOW_UID,
	}: { littleEndian?: boolean; overflowUid?: number } = {}
): LoopbackPeerOwner {
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
			rows: parseTable( tables.tcp, TCP_HEADER, 8 ),
			local: `${ word( peer, littleEndian ) }:${ port( connection.remotePort ) }`,
			remote: `${ word( listener, littleEndian ) }:${ port( connection.localPort ) }`,
		},
		{
			rows: parseTable( tables.tcp6, TCP6_HEADER, 32 ),
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
	if ( uid === overflowUid ) {
		return 'unknown';
	}
	return uid === 0 ? 'root' : 'other-user';
}

interface LoopbackPeerReader {
	/** Reads a file under /proc; rejects when it can't. */
	readText?: ( file: string ) => Promise< string >;
	/** This process's uid; none where there is no such thing. */
	uid?: number;
	littleEndian?: boolean;
}

/** `findLoopbackPeerOwner` over this machine's tables, as this process's user. */
export async function readLoopbackPeerOwner(
	connection: LoopbackConnection,
	{
		readText = ( file ) => readFile( file, 'utf8' ),
		uid = process.getuid?.(),
		littleEndian = endianness() === 'LE',
	}: LoopbackPeerReader = {}
): Promise< LoopbackPeerOwner > {
	if ( uid === undefined ) {
		return 'unknown';
	}
	const read = ( file: string ) => readText( file ).catch( () => undefined );
	const [ tcp, tcp6, overflow ] = await Promise.all( [
		read( '/proc/net/tcp' ),
		read( '/proc/net/tcp6' ),
		read( '/proc/sys/kernel/overflowuid' ),
	] );
	const overflowUid = /^\d+$/.test( overflow?.trim() ?? '' )
		? Number( overflow?.trim() )
		: DEFAULT_OVERFLOW_UID;
	return findLoopbackPeerOwner( { tcp, tcp6 }, connection, uid, { littleEndian, overflowUid } );
}
