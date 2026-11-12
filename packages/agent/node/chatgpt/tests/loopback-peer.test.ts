// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
	findLoopbackPeerOwner,
	readLoopbackPeerOwner,
	type LoopbackConnection,
} from '@studio/agent/node/chatgpt/loopback-peer';

/**
 * The socket tables as Linux prints them. The layout is the kernel's own
 * (Documentation/networking/proc_net_tcp.rst): tcp4_seq_show() and
 * get_tcp4_sock() / get_timewait4_sock() in net/ipv4/tcp_ipv4.c pad every line
 * of /proc/net/tcp to 149 characters; tcp6_seq_show() and get_tcp6_sock() in
 * net/ipv6/tcp_ipv6.c print /proc/net/tcp6 unpadded. Addresses are each 32-bit
 * word of the address in network order, printed with %08X on the host, so a
 * little-endian machine shows 127.0.0.1 as 0100007F; ports are %04X.
 */

const OWN_UID = 1000;
const LISTENER_PORT = 0xa3f1;
const PEER_PORT = 0xc0de;

const TCP_HEADER =
	'  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const TCP6_HEADER =
	'  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

const hex4 = ( port: number ) => port.toString( 16 ).toUpperCase().padStart( 4, '0' );
// 127.0.0.<n> as a little-endian host prints it.
const v4 = ( last: number ) => `${ last.toString( 16 ).toUpperCase().padStart( 2, '0' ) }00007F`;
// ::ffff:127.0.0.<n>, word by word, as a little-endian host prints it.
const mapped = ( last: number ) => `0000000000000000FFFF0000${ v4( last ) }`;

// "%4d: %08X:%04X %08X:%04X %02X %08X:%08X %02X:%08lX %08X %5u %8d %llu %d 0 %lu %lu %u %u %d"
function tcpRow(
	slot: number,
	local: string,
	remote: string,
	{ state = '01', uid = OWN_UID }: { state?: string; uid?: number } = {}
) {
	return `${ String( slot ).padStart(
		4
	) }: ${ local } ${ remote } ${ state } 00000000:00000000 00:00000000 00000000 ${ String(
		uid
	).padStart( 5 ) } ${ '0'.padStart( 8 ) } ${ 41000 + slot } 1 0 20 4 0 10 -1`.padEnd( 149 );
}

// "%4d: %08X:%04X %08X:%04X %02X %08X:%08X %02X:%08lX %08X %5d %8d %d %d 0": no owner, uid printed as 0.
function timeWaitRow( slot: number, local: string, remote: string ) {
	return `${ String( slot ).padStart(
		4
	) }: ${ local } ${ remote } 06 00000000:00000000 03:00000F9A 00000000 ${ '0'.padStart(
		5
	) } ${ '0'.padStart( 8 ) } 0 3 0`.padEnd( 149 );
}

// "%4d: %08X%08X%08X%08X:%04X %08X%08X%08X%08X:%04X %02X %08X:%08X %02X:%08lX %08X %5u %8d %llu %d 0 %lu %lu %u %u %d\n"
function tcp6Row( slot: number, local: string, remote: string, uid: number ) {
	return `${ String( slot ).padStart(
		4
	) }: ${ local } ${ remote } 01 00000000:00000000 00:00000000 00000000 ${ String( uid ).padStart(
		5
	) } ${ '0'.padStart( 8 ) } ${ 52000 + slot } 1 0 20 4 0 10 -1`;
}

const tcpTable = ( ...rows: string[] ) =>
	[ TCP_HEADER.padEnd( 149 ), ...rows ].map( ( line ) => `${ line }\n` ).join( '' );
const tcp6Table = ( ...rows: string[] ) =>
	[ TCP6_HEADER, ...rows ].map( ( line ) => `${ line }\n` ).join( '' );

const at = ( port: number, address = v4( 1 ) ) => `${ address }:${ hex4( port ) }`;

// The request the listener is answering: the browser's end and the listener's.
const connection: LoopbackConnection = {
	remoteAddress: '127.0.0.1',
	remotePort: PEER_PORT,
	localAddress: '127.0.0.1',
	localPort: LISTENER_PORT,
};

const LISTENING = tcpRow( 0, at( LISTENER_PORT ), at( 0, '00000000' ), { state: '0A' } );
// The listener's own end of the connection: always this user's, never the peer's.
const ACCEPTED = tcpRow( 1, at( LISTENER_PORT ), at( PEER_PORT ) );
const peerRow = ( uid: number, slot = 2 ) =>
	tcpRow( slot, at( PEER_PORT ), at( LISTENER_PORT ), { uid } );

const ownerIn = ( tables: { tcp?: string; tcp6?: string }, peer = connection ) =>
	findLoopbackPeerOwner( tables, peer, OWN_UID );

describe( 'whose socket a loopback connection comes from', () => {
	it.each( [
		[ 'same-user', OWN_UID ],
		[ 'root', 0 ],
		[ 'other-user', 1001 ],
	] as const )( 'is %s when the peer’s row says so', ( owner, uid ) => {
		expect( ownerIn( { tcp: tcpTable( LISTENING, ACCEPTED, peerRow( uid ) ) } ) ).toBe( owner );
	} );

	it( 'is unknown when the peer’s row is absent, even though the listener’s own end is there', () => {
		expect( ownerIn( { tcp: tcpTable( LISTENING, ACCEPTED ) } ) ).toBe( 'unknown' );
		expect( ownerIn( { tcp: tcpTable() } ) ).toBe( 'unknown' );
	} );

	it( 'is unknown when there is no table, or one it can’t read', () => {
		expect( ownerIn( {} ) ).toBe( 'unknown' );
		expect( ownerIn( { tcp: '' } ) ).toBe( 'unknown' );
		// A layout it doesn't know: a uid column it can't be sure of.
		expect(
			ownerIn( {
				tcp: [ TCP_HEADER.replace( '   uid', '  user' ), peerRow( 1001 ) ].join( '\n' ),
			} )
		).toBe( 'unknown' );
	} );

	it( 'skips rows it can’t parse, and answers from the peer’s row when that one is whole', () => {
		const garbled = [
			peerRow( 1001 ).replace( /\s+1001\s/, ' 10x1 ' ),
			peerRow( 1001 ).slice( 0, 60 ),
			`   7: ${ at( PEER_PORT ) }`,
			'not a row at all',
		];

		expect( ownerIn( { tcp: tcpTable( ...garbled ) } ) ).toBe( 'unknown' );
		expect( ownerIn( { tcp: tcpTable( ...garbled, peerRow( 1001, 8 ) ) } ) ).toBe( 'other-user' );
	} );

	it( 'matches the address as well as the port', () => {
		// 127.0.0.2 on the peer's port number, owned by another user.
		const elsewhere = tcpRow( 3, at( PEER_PORT, v4( 2 ) ), at( LISTENER_PORT ), { uid: 1001 } );

		expect( ownerIn( { tcp: tcpTable( LISTENING, ACCEPTED, elsewhere ) } ) ).toBe( 'unknown' );
		expect(
			ownerIn( { tcp: tcpTable( LISTENING, ACCEPTED, elsewhere, peerRow( OWN_UID ) ) } )
		).toBe( 'same-user' );
	} );

	it( 'tells apart sockets on the same port number with other addresses or other remote ends', () => {
		const rows = [
			LISTENING,
			ACCEPTED,
			// The same port number on other loopback addresses, and the same local end connected elsewhere.
			tcpRow( 3, at( PEER_PORT, v4( 2 ) ), at( LISTENER_PORT ), { uid: 1001 } ),
			tcpRow( 4, at( PEER_PORT, v4( 3 ) ), at( LISTENER_PORT, v4( 3 ) ), { uid: 1002 } ),
			tcpRow( 5, at( PEER_PORT ), at( 443, 'C0A80001' ), { uid: 1003 } ),
			peerRow( OWN_UID, 6 ),
		];

		expect( ownerIn( { tcp: tcpTable( ...rows ) } ) ).toBe( 'same-user' );
	} );

	it( 'ignores a TIME_WAIT row, whose uid the kernel prints as 0, rather than read it as root', () => {
		const closed = timeWaitRow( 3, at( PEER_PORT ), at( LISTENER_PORT ) );

		expect( ownerIn( { tcp: tcpTable( LISTENING, closed ) } ) ).toBe( 'unknown' );
		expect( ownerIn( { tcp: tcpTable( LISTENING, closed, peerRow( 1001 ) ) } ) ).toBe(
			'other-user'
		);
	} );

	it( 'is unknown when rows for the peer disagree about its owner', () => {
		expect( ownerIn( { tcp: tcpTable( peerRow( 1001, 2 ), peerRow( OWN_UID, 3 ) ) } ) ).toBe(
			'unknown'
		);
	} );

	it( 'is unknown for a uid the kernel couldn’t map into this user namespace', () => {
		expect( ownerIn( { tcp: tcpTable( peerRow( 65534 ) ) } ) ).toBe( 'unknown' );
		expect(
			findLoopbackPeerOwner( { tcp: tcpTable( peerRow( 70000 ) ) }, connection, OWN_UID, {
				overflowUid: 70000,
			} )
		).toBe( 'unknown' );
		expect(
			findLoopbackPeerOwner( { tcp: tcpTable( peerRow( 65534 ) ) }, connection, OWN_UID, {
				overflowUid: 70000,
			} )
		).toBe( 'other-user' );
	} );

	it( 'finds a peer that connected from an IPv6 socket, which only /proc/net/tcp6 lists', () => {
		const tcp6 = tcp6Table(
			tcp6Row(
				0,
				`${ mapped( 1 ) }:${ hex4( PEER_PORT ) }`,
				`${ mapped( 1 ) }:${ hex4( LISTENER_PORT ) }`,
				1001
			)
		);

		expect( ownerIn( { tcp: tcpTable( LISTENING, ACCEPTED ), tcp6 } ) ).toBe( 'other-user' );
		expect( ownerIn( { tcp6 } ) ).toBe( 'other-user' );
		// ::1 is another address, not 127.0.0.1.
		const loopback6 = `${ '0'.repeat( 24 ) }01000000`;
		expect(
			ownerIn( {
				tcp6: tcp6Table(
					tcp6Row(
						0,
						`${ loopback6 }:${ hex4( PEER_PORT ) }`,
						`${ loopback6 }:${ hex4( LISTENER_PORT ) }`,
						1001
					)
				),
			} )
		).toBe( 'unknown' );
	} );

	it( 'reads an IPv4-mapped peer address as the IPv4 address', () => {
		const peer = {
			...connection,
			remoteAddress: '::ffff:127.0.0.1',
			localAddress: '::ffff:127.0.0.1',
		};

		expect( ownerIn( { tcp: tcpTable( peerRow( 1001 ) ) }, peer ) ).toBe( 'other-user' );
	} );

	it( 'is unknown for a peer address that isn’t IPv4', () => {
		expect(
			ownerIn( { tcp: tcpTable( peerRow( 1001 ) ) }, { ...connection, remoteAddress: '::1' } )
		).toBe( 'unknown' );
		expect(
			ownerIn( { tcp: tcpTable( peerRow( 1001 ) ) }, { ...connection, remoteAddress: 'localhost' } )
		).toBe( 'unknown' );
	} );

	it( 'reads the addresses in the host’s byte order', () => {
		const bigEndian = tcpTable(
			tcpRow( 2, `7F000001:${ hex4( PEER_PORT ) }`, `7F000001:${ hex4( LISTENER_PORT ) }`, {
				uid: 1001,
			} )
		);

		expect(
			findLoopbackPeerOwner( { tcp: bigEndian }, connection, OWN_UID, { littleEndian: false } )
		).toBe( 'other-user' );
		expect( ownerIn( { tcp: bigEndian } ) ).toBe( 'unknown' );
	} );
} );

describe( 'reading the socket tables', () => {
	const files = ( entries: Record< string, string > ) => async ( file: string ) => {
		if ( ! ( file in entries ) ) {
			throw Object.assign( new Error( `ENOENT: ${ file }` ), { code: 'ENOENT' } );
		}
		return entries[ file ];
	};

	it( 'reads both tables and the overflow uid, and answers for this process’s user', async () => {
		const tcp6 = tcp6Table(
			tcp6Row(
				0,
				`${ mapped( 1 ) }:${ hex4( PEER_PORT ) }`,
				`${ mapped( 1 ) }:${ hex4( LISTENER_PORT ) }`,
				1001
			)
		);
		const read: string[] = [];
		const readText = async ( file: string ) => {
			read.push( file );
			return files( {
				'/proc/net/tcp': tcpTable( LISTENING, ACCEPTED ),
				'/proc/net/tcp6': tcp6,
				'/proc/sys/kernel/overflowuid': '1001\n',
			} )( file );
		};

		await expect(
			readLoopbackPeerOwner( connection, { readText, uid: OWN_UID, littleEndian: true } )
		).resolves.toBe( 'unknown' );
		expect( read.sort() ).toEqual( [
			'/proc/net/tcp',
			'/proc/net/tcp6',
			'/proc/sys/kernel/overflowuid',
		] );
	} );

	it( 'is unknown when the tables can’t be read, or the process has no uid', async () => {
		await expect(
			readLoopbackPeerOwner( connection, {
				readText: files( {} ),
				uid: OWN_UID,
				littleEndian: true,
			} )
		).resolves.toBe( 'unknown' );
		await expect(
			readLoopbackPeerOwner( connection, {
				readText: files( { '/proc/net/tcp': tcpTable( peerRow( 1001 ) ) } ),
				uid: undefined,
				littleEndian: true,
			} )
		).resolves.toBe( 'unknown' );
	} );

	it( 'answers from whichever table it could read', async () => {
		await expect(
			readLoopbackPeerOwner( connection, {
				readText: files( { '/proc/net/tcp': tcpTable( peerRow( 1001 ) ) } ),
				uid: OWN_UID,
				littleEndian: true,
			} )
		).resolves.toBe( 'other-user' );
	} );
} );
