// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	findLoopbackPeerOwner,
	openLoopbackPeerLookup,
	type LoopbackConnection,
	type LoopbackPeerLookup,
} from '@studio/agent/node/chatgpt/loopback-peer';
import {
	INITIAL_UID_MAP,
	OTHER_UID,
	OVERFLOW_UID_FILE,
	OWN_UID,
	TCP6_FILE,
	TCP_FILE,
	TCP_HEADER,
	TCP6_HEADER,
	UID_MAP_FILE,
	at,
	createFakeProc,
	hex4,
	mapped,
	systemError,
	tcp6Row,
	tcp6Table,
	tcpRow,
	tcpTable,
	timeWaitRow,
	v4,
} from './fixtures/proc-net-tcp';

// Every answer here comes from the tables and values a test gives: the uid,
// byte order, files and line endings of the machine running it play no part.

const LISTENER_PORT = 0xa3f1;
const PEER_PORT = 0xc0de;
const NOBODY = 65534;

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
const peerRow6 = ( uid: number, slot = 0 ) =>
	tcp6Row(
		slot,
		`${ mapped( 1 ) }:${ hex4( PEER_PORT ) }`,
		`${ mapped( 1 ) }:${ hex4( LISTENER_PORT ) }`,
		uid
	);

const ownerIn = (
	tables: { tcp?: string; tcp6?: string },
	peer = connection,
	options: { overflowUid?: number; uidMap?: string } = {}
) => findLoopbackPeerOwner( tables, peer, OWN_UID, { littleEndian: true, ...options } );

describe( 'whose socket a loopback connection comes from', () => {
	it.each( [
		[ 'same-user', OWN_UID ],
		[ 'root', 0 ],
		[ 'other-user', OTHER_UID ],
	] as const )( 'is %s when the peer’s row says so', ( owner, uid ) => {
		expect( ownerIn( { tcp: tcpTable( LISTENING, ACCEPTED, peerRow( uid ) ) } ) ).toBe( owner );
	} );

	it( 'is unknown when the peer’s row is absent, even though the listener’s own end is there', () => {
		expect( ownerIn( { tcp: tcpTable( LISTENING, ACCEPTED ) } ) ).toBe( 'unknown' );
		expect( ownerIn( { tcp: tcpTable() } ) ).toBe( 'unknown' );
		expect( ownerIn( { tcp: tcpTable(), tcp6: tcp6Table() } ) ).toBe( 'unknown' );
	} );

	it( 'is unknown when the kernel shows it neither table', () => {
		expect( ownerIn( {} ) ).toBe( 'unknown' );
	} );

	it( 'is unreadable when a table is empty or in a layout it doesn’t know, whatever the other says', () => {
		const known = tcpTable( LISTENING, ACCEPTED, peerRow( OWN_UID ) );

		expect( ownerIn( { tcp: '' } ) ).toBe( 'unreadable' );
		// A uid column it can't be sure of.
		expect(
			ownerIn( {
				tcp: [ TCP_HEADER.replace( '   uid', '  user' ), peerRow( OTHER_UID ) ].join( '\n' ),
			} )
		).toBe( 'unreadable' );
		// The other table's header.
		expect( ownerIn( { tcp: [ TCP6_HEADER, peerRow( OWN_UID ) ].join( '\n' ) } ) ).toBe(
			'unreadable'
		);
		expect( ownerIn( { tcp: known, tcp6: 'not a socket table\n' } ) ).toBe( 'unreadable' );
		expect( ownerIn( { tcp: known, tcp6: tcpTable() } ) ).toBe( 'unreadable' );
	} );

	// Rows that aren't the request's, however garbled, can't hide its own: an
	// emulated /proc, or a row form the kernel changes, doesn't stop every sign-in.
	it.each( [
		[ 'with no remote end', `   7: ${ at( PEER_PORT ) }` ],
		[ 'that isn’t a row at all', 'not a row at all' ],
		[
			'with ends that aren’t hex',
			`   7: 0100007G:${ hex4( PEER_PORT ) } ${ at( LISTENER_PORT ) } 01`,
		],
		[
			'of another socket, its uid garbled',
			tcpRow( 7, at( PEER_PORT, v4( 2 ) ), at( LISTENER_PORT ), { uid: OTHER_UID } ).replace(
				/\s+1001\s/,
				' 10x1 '
			),
		],
		[ 'of another socket, cut short', tcpRow( 7, at( 443 ), at( LISTENER_PORT ) ).slice( 0, 60 ) ],
		[
			'of another socket, in a future form',
			`   7: ${ at( 443 ) } ${ at( LISTENER_PORT ) } 01 new-column`,
		],
	] )( 'skips a row %s, and answers from the request’s own', ( _name, garbled ) => {
		expect( ownerIn( { tcp: tcpTable( garbled, peerRow( OTHER_UID, 8 ) ) } ) ).toBe( 'other-user' );
		expect( ownerIn( { tcp: tcpTable( peerRow( OWN_UID, 8 ), garbled ) } ) ).toBe( 'same-user' );
		expect( ownerIn( { tcp: tcpTable( garbled ) } ) ).toBe( 'unknown' );
	} );

	it.each( [
		[ 'uid', peerRow( OTHER_UID ).replace( /\s+1001\s/, ' 10x1 ' ) ],
		[ 'uid, missing', peerRow( OTHER_UID ).slice( 0, 75 ) ],
		[ 'state', peerRow( OTHER_UID ).replace( ' 01 00000000:', ' 1Z 00000000:' ) ],
		[ 'timer', peerRow( OTHER_UID ).slice( 0, 60 ) ],
		[ 'slot', peerRow( OTHER_UID ).replace( '   2:', '  2x:' ) ],
	] )( 'is unreadable when the request’s own row has a %s it can’t parse', ( _name, garbled ) => {
		expect( ownerIn( { tcp: tcpTable( garbled ) } ) ).toBe( 'unreadable' );
		expect( ownerIn( { tcp: tcpTable( garbled, peerRow( OWN_UID, 8 ) ) } ) ).toBe( 'unreadable' );
		const garbled6 = peerRow6( OTHER_UID ).replace( /\s+1001\s/, ' 10x1 ' );
		expect( ownerIn( { tcp: tcpTable( peerRow( OWN_UID ) ), tcp6: tcp6Table( garbled6 ) } ) ).toBe(
			'unreadable'
		);
	} );

	it( 'reads past blank lines and the padding the kernel adds', () => {
		const table = `${ tcpTable( LISTENING, peerRow( OTHER_UID ) ) }\n   \n`;

		expect( ownerIn( { tcp: table } ) ).toBe( 'other-user' );
	} );

	it( 'matches the address as well as the port', () => {
		// 127.0.0.2 on the peer's port number, owned by another user.
		const elsewhere = tcpRow( 3, at( PEER_PORT, v4( 2 ) ), at( LISTENER_PORT ), {
			uid: OTHER_UID,
		} );

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
			tcpRow( 3, at( PEER_PORT, v4( 2 ) ), at( LISTENER_PORT ), { uid: OTHER_UID } ),
			tcpRow( 4, at( PEER_PORT, v4( 3 ) ), at( LISTENER_PORT, v4( 3 ) ), { uid: 1002 } ),
			tcpRow( 5, at( PEER_PORT ), at( 443, 'C0A80001' ), { uid: 1003 } ),
			peerRow( OWN_UID, 6 ),
		];

		expect( ownerIn( { tcp: tcpTable( ...rows ) } ) ).toBe( 'same-user' );
	} );

	it( 'ignores a TIME_WAIT row, whose uid the kernel prints as 0, rather than read it as root', () => {
		const closed = timeWaitRow( 3, at( PEER_PORT ), at( LISTENER_PORT ) );

		expect( ownerIn( { tcp: tcpTable( LISTENING, closed ) } ) ).toBe( 'unknown' );
		expect( ownerIn( { tcp: tcpTable( LISTENING, closed, peerRow( OTHER_UID ) ) } ) ).toBe(
			'other-user'
		);
	} );

	it( 'is unknown when rows for the peer disagree about its owner', () => {
		expect( ownerIn( { tcp: tcpTable( peerRow( OTHER_UID, 2 ), peerRow( OWN_UID, 3 ) ) } ) ).toBe(
			'unknown'
		);
	} );

	it( 'is unknown for the overflow uid, which stands for an owner this user namespace can’t map', () => {
		expect( ownerIn( { tcp: tcpTable( peerRow( NOBODY ) ) } ) ).toBe( 'unknown' );
		expect(
			ownerIn( { tcp: tcpTable( peerRow( 70000 ) ) }, connection, { overflowUid: 70000 } )
		).toBe( 'unknown' );
		expect(
			ownerIn( { tcp: tcpTable( peerRow( NOBODY ) ) }, connection, { overflowUid: 70000 } )
		).toBe( 'other-user' );
	} );

	describe( 'where every uid is mapped, as in the initial user namespace', () => {
		const nobody = { tcp: tcpTable( peerRow( NOBODY ) ) };

		it.each( [
			[ 'as the kernel prints it', INITIAL_UID_MAP ],
			[ 'with single spaces', '0 0 4294967295' ],
			[ 'with tabs, extra spaces and blank lines', '\n \t0\t  0   4294967295 \t\n\n' ],
		] )( 'reads the overflow uid as the real account it is, with the map %s', ( _name, uidMap ) => {
			expect( ownerIn( nobody, connection, { uidMap } ) ).toBe( 'other-user' );
			expect(
				ownerIn( { tcp: tcpTable( peerRow( 70000 ) ) }, connection, {
					overflowUid: 70000,
					uidMap,
				} )
			).toBe( 'other-user' );
		} );

		it.each( [
			[ 'a container’s', '         0     100000      65536\n' ],
			[ 'a partial identity', '0 0 1000\n' ],
			[ 'two ranges', '0 0 1000\n1000 1000 4294966295\n' ],
			[ 'an unwritten (empty)', '' ],
			[ 'a garbled', '0 0 4294967295 1\n' ],
			[ 'a non-numeric', 'zero zero all\n' ],
		] )( 'leaves it unknown with %s map', ( _name, uidMap ) => {
			expect( ownerIn( nobody, connection, { uidMap } ) ).toBe( 'unknown' );
		} );
	} );

	it( 'finds a peer that connected from an IPv6 socket, which only /proc/net/tcp6 lists', () => {
		const tcp6 = tcp6Table( peerRow6( OTHER_UID ) );

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
						OTHER_UID
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

		expect( ownerIn( { tcp: tcpTable( peerRow( OTHER_UID ) ) }, peer ) ).toBe( 'other-user' );
	} );

	it( 'is unknown for a peer address that isn’t IPv4', () => {
		const tcp = tcpTable( peerRow( OTHER_UID ) );

		expect( ownerIn( { tcp }, { ...connection, remoteAddress: '::1' } ) ).toBe( 'unknown' );
		expect( ownerIn( { tcp }, { ...connection, remoteAddress: 'localhost' } ) ).toBe( 'unknown' );
	} );

	it( 'reads the addresses in the byte order it is told the host has', () => {
		const bigEndian = tcpTable(
			tcpRow( 2, `7F000001:${ hex4( PEER_PORT ) }`, `7F000001:${ hex4( LISTENER_PORT ) }`, {
				uid: OTHER_UID,
			} )
		);

		expect(
			findLoopbackPeerOwner( { tcp: bigEndian }, connection, OWN_UID, { littleEndian: false } )
		).toBe( 'other-user' );
		expect( ownerIn( { tcp: bigEndian } ) ).toBe( 'unknown' );
	} );
} );

describe( 'reading the socket tables', () => {
	const CONTAINER_UID_MAP = '         0     100000      65536\n';
	const lookups: LoopbackPeerLookup[] = [];

	// This machine's /proc as a test sets it: no row for the peer yet.
	function proc( files: Record< string, string > = {} ) {
		return createFakeProc( {
			[ TCP_FILE ]: tcpTable( LISTENING, ACCEPTED ),
			[ TCP6_FILE ]: tcp6Table(),
			[ OVERFLOW_UID_FILE ]: `${ NOBODY }\n`,
			[ UID_MAP_FILE ]: CONTAINER_UID_MAP,
			...files,
		} );
	}

	function lookUp(
		fake: ReturnType< typeof proc >,
		options: { uid?: number | null; timeoutMs?: number } = {}
	) {
		const lookup = openLoopbackPeerLookup( {
			open: fake.open,
			uid: OWN_UID,
			littleEndian: true,
			...options,
		} );
		lookups.push( lookup );
		return lookup;
	}

	const fromStart = ( fake: ReturnType< typeof proc >, file: string ) =>
		fake.reads.filter( ( read ) => read.file === file && read.position === 0 ).length;

	afterEach( async () => {
		vi.useRealTimers();
		await Promise.all( lookups.splice( 0 ).map( ( lookup ) => lookup.close() ) );
	} );

	it( 'opens each table once, as it starts, and reads it again from its start for every lookup', async () => {
		const fake = proc();
		const lookup = lookUp( fake );

		// Opened before anyone could ask.
		expect( fake.opens ).toEqual(
			expect.arrayContaining( [ TCP_FILE, TCP6_FILE, OVERFLOW_UID_FILE, UID_MAP_FILE ] )
		);
		await expect( lookup.ownerOf( connection ) ).resolves.toBe( 'unknown' );
		fake.content.set( TCP_FILE, tcpTable( LISTENING, ACCEPTED, peerRow( OTHER_UID ) ) );
		await expect( lookup.ownerOf( connection ) ).resolves.toBe( 'other-user' );
		fake.content.set( TCP_FILE, tcpTable( LISTENING, ACCEPTED, peerRow( OWN_UID ) ) );
		await expect( lookup.ownerOf( connection ) ).resolves.toBe( 'same-user' );

		for ( const file of [ TCP_FILE, TCP6_FILE, OVERFLOW_UID_FILE, UID_MAP_FILE ] ) {
			expect( fake.opens.filter( ( opened ) => opened === file ) ).toHaveLength( 1 );
		}
		expect( fromStart( fake, TCP_FILE ) ).toBe( 3 );
		expect( fromStart( fake, TCP6_FILE ) ).toBe( 3 );
		// The two settings were read once and closed at once; the tables stay open.
		expect( [ ...fake.closes ].sort() ).toEqual( [ OVERFLOW_UID_FILE, UID_MAP_FILE ].sort() );

		await lookup.close();

		expect( [ ...fake.closes ].sort() ).toEqual(
			[ TCP_FILE, TCP6_FILE, OVERFLOW_UID_FILE, UID_MAP_FILE ].sort()
		);
		const opened = fake.opens.length;
		await expect( lookup.ownerOf( connection ) ).resolves.toBe( 'unreadable' );
		expect( fake.opens ).toHaveLength( opened );
	} );

	it( 'reads the overflow uid the kernel names', async () => {
		const fake = proc( {
			[ TCP_FILE ]: tcpTable( peerRow( OTHER_UID ) ),
			[ OVERFLOW_UID_FILE ]: `${ OTHER_UID }\n`,
		} );

		await expect( lookUp( fake ).ownerOf( connection ) ).resolves.toBe( 'unknown' );
	} );

	describe.each( [ TCP_FILE, TCP6_FILE ] )( 'when %s', ( file ) => {
		it.each( [ 'EMFILE', 'ENFILE', 'ENOMEM', 'EIO' ] )(
			'is unreadable for a read that fails with %s, and answers again once it reads',
			async ( code ) => {
				const fake = proc( { [ TCP_FILE ]: tcpTable( peerRow( OWN_UID ) ) } );
				const lookup = lookUp( fake );
				fake.failNextRead( file, systemError( code ) );

				await expect( lookup.ownerOf( connection ) ).resolves.toBe( 'unreadable' );
				await expect( lookup.ownerOf( connection ) ).resolves.toBe( 'same-user' );
			}
		);

		it( 'is unreadable for a read that fails with an error it doesn’t expect', async () => {
			const fake = proc( { [ TCP_FILE ]: tcpTable( peerRow( OWN_UID ) ) } );
			const lookup = lookUp( fake );
			fake.failNextRead( file, new TypeError( 'test-unexpected-read' ) );

			await expect( lookup.ownerOf( connection ) ).resolves.toBe( 'unreadable' );
			await expect( lookup.ownerOf( connection ) ).resolves.toBe( 'same-user' );
		} );

		it.each( [ 'EMFILE', 'ENFILE', 'ENOMEM', 'EIO' ] )(
			'opens it again at a lookup after it failed to open with %s, unreadable until it opens',
			async ( code ) => {
				const fake = proc( { [ TCP_FILE ]: tcpTable( peerRow( OWN_UID ) ) } );
				// As it starts, and again at the first lookup.
				fake.failNextOpen( file, systemError( code ) );
				fake.failNextOpen( file, systemError( code ) );
				const lookup = lookUp( fake );

				await expect( lookup.ownerOf( connection ) ).resolves.toBe( 'unreadable' );
				await expect( lookup.ownerOf( connection ) ).resolves.toBe( 'same-user' );
				await expect( lookup.ownerOf( connection ) ).resolves.toBe( 'same-user' );

				expect( fake.opens.filter( ( opened ) => opened === file ) ).toHaveLength( 3 );
			}
		);

		// A busy host's table, over the 4 MiB an earlier bound refused.
		function busyTable( uid: number ) {
			const others = Array.from( { length: 40_000 }, ( _, slot ) =>
				file === TCP_FILE
					? tcpRow( slot + 10, at( 20_000 + slot, v4( 9 ) ), at( 443, 'C0A80001' ), {
							uid: OTHER_UID,
					  } )
					: tcp6Row(
							slot + 10,
							`${ mapped( 9 ) }:${ hex4( 20_000 + slot ) }`,
							`${ mapped( 9 ) }:01BB`,
							OTHER_UID
					  )
			);
			const table =
				file === TCP_FILE
					? tcpTable( ...others, peerRow( uid ) )
					: tcp6Table( ...others, peerRow6( uid ) );
			expect( Buffer.byteLength( table ) ).toBeGreaterThan( 5 * 1024 * 1024 );
			return table;
		}

		it( 'finds the request’s row at the very end of a table over 4 MiB, reading it through one buffer, contiguously from offset 0', async () => {
			const fake = proc( { [ file ]: busyTable( OWN_UID ) } );
			const lookup = lookUp( fake );

			await expect( lookup.ownerOf( connection ) ).resolves.toBe( 'same-user' );
			fake.content.set( file, busyTable( OTHER_UID ) );
			const before = fake.reads.length;
			await expect( lookup.ownerOf( connection ) ).resolves.toBe( 'other-user' );

			const pass = fake.reads.slice( before ).filter( ( read ) => read.file === file );
			expect( pass.length ).toBeGreaterThan( 80 );
			expect( pass[ 0 ].position ).toBe( 0 );
			for ( let index = 1; index < pass.length; index++ ) {
				expect( pass[ index ].position ).toBe(
					pass[ index - 1 ].position + pass[ index - 1 ].bytes
				);
			}
			expect( pass.at( -1 )!.bytes ).toBe( 0 );
			expect( new Set( pass.map( ( read ) => read.buffer ) ).size ).toBe( 1 );
		} );

		it( 'parses a row split across reads, inside its addresses, its uid or anywhere else', async () => {
			const own = file === TCP_FILE ? peerRow( OTHER_UID ) : peerRow6( OTHER_UID );
			const before = file === TCP_FILE ? tcpTable( LISTENING ).length : tcp6Table().length;
			const table = file === TCP_FILE ? tcpTable( LISTENING, own ) : tcp6Table( own );
			const peerEnd =
				file === TCP_FILE ? at( PEER_PORT ) : `${ mapped( 1 ) }:${ hex4( PEER_PORT ) }`;
			const listenerEnd =
				file === TCP_FILE ? at( LISTENER_PORT ) : `${ mapped( 1 ) }:${ hex4( LISTENER_PORT ) }`;
			const local = own.indexOf( peerEnd );
			const remote = own.indexOf( listenerEnd, local + 1 );
			const uid = own.indexOf( ` ${ OTHER_UID } ` );
			expect( [ local, remote, uid ].every( ( found ) => found > 0 ) ).toBe( true );
			const fake = proc( { [ file ]: table } );
			const lookup = lookUp( fake );

			// Inside its local address, its remote address and its uid, and at its start.
			for ( const offset of [ local + 5, remote + 3, uid + 3, 0 ] ) {
				fake.cutReadsAt( file, [ before + offset ] );
				await expect( lookup.ownerOf( connection ) ).resolves.toBe( 'other-user' );
			}
			// Every byte its own read: every split at once, the header's too.
			fake.cutReadsAt(
				file,
				Array.from( { length: table.length }, ( _, offset ) => offset + 1 )
			);
			await expect( lookup.ownerOf( connection ) ).resolves.toBe( 'other-user' );
		} );

		it( 'is unreadable for a read that fails partway through, and answers again once it reads', async () => {
			const fake = proc( { [ file ]: busyTable( OWN_UID ) } );
			const lookup = lookUp( fake );
			fake.failNextRead( file, { failAfter: 300_000, error: systemError( 'EIO' ) } );

			await expect( lookup.ownerOf( connection ) ).resolves.toBe( 'unreadable' );
			await expect( lookup.ownerOf( connection ) ).resolves.toBe( 'same-user' );
		} );
	} );

	it.each( [ 'ENOENT', 'EACCES', 'EPERM' ] )(
		'takes a table the kernel hides with %s, as it opens or as it reads, as no table, and goes on deciding from the other',
		async ( code ) => {
			const hiddenAtOpen = proc( { [ TCP6_FILE ]: tcp6Table( peerRow6( OTHER_UID ) ) } );
			hiddenAtOpen.failNextOpen( TCP_FILE, systemError( code ) );
			const hiddenAtRead = proc( { [ TCP6_FILE ]: tcp6Table( peerRow6( OWN_UID ) ) } );
			hiddenAtRead.failNextRead( TCP_FILE, systemError( code ) );
			const bothHidden = proc();
			bothHidden.failNextOpen( TCP_FILE, systemError( code ) );
			bothHidden.failNextOpen( TCP6_FILE, systemError( code ) );

			await expect( lookUp( hiddenAtOpen ).ownerOf( connection ) ).resolves.toBe( 'other-user' );
			await expect( lookUp( hiddenAtRead ).ownerOf( connection ) ).resolves.toBe( 'same-user' );
			await expect( lookUp( bothHidden ).ownerOf( connection ) ).resolves.toBe( 'unknown' );
			// A table hidden as it opened isn't asked for again.
			expect( hiddenAtOpen.opens.filter( ( opened ) => opened === TCP_FILE ) ).toHaveLength( 1 );
		}
	);

	it( 'gives up on a lookup that takes 2 seconds, stops reading at its next read, and answers the next once the table reads', async () => {
		vi.useFakeTimers();
		// More than one read's worth, the request's row last.
		const others = Array.from( { length: 2_000 }, ( _, slot ) =>
			tcpRow( slot + 10, at( 20_000 + slot, v4( 9 ) ), at( 443, 'C0A80001' ) )
		);
		const fake = proc( { [ TCP_FILE ]: tcpTable( ...others, peerRow( OWN_UID ) ) } );
		const lookup = lookUp( fake );
		fake.failNextRead( TCP_FILE, { stallMs: 5_000 } );
		let answer: string | undefined;

		void lookup.ownerOf( connection ).then( ( owner ) => ( answer = owner ) );
		await vi.advanceTimersByTimeAsync( 1_999 );
		expect( answer ).toBeUndefined();
		await vi.advanceTimersByTimeAsync( 1 );
		expect( answer ).toBe( 'unreadable' );
		await vi.advanceTimersByTimeAsync( 3_000 );

		// The stalled read came back, and nothing more of that table was read.
		expect( fake.reads.filter( ( read ) => read.file === TCP_FILE ) ).toHaveLength( 1 );
		await expect( lookup.ownerOf( connection ) ).resolves.toBe( 'same-user' );
		expect( fake.reads.filter( ( read ) => read.file === TCP_FILE ).length ).toBeGreaterThan( 3 );
	} );

	it( 'answers one lookup at a time, so no two read a table at once', async () => {
		const fake = proc( { [ TCP_FILE ]: tcpTable( peerRow( OWN_UID ) ) } );
		const lookup = lookUp( fake );
		fake.failNextRead( TCP_FILE, { stallMs: 100 } );

		const first = lookup.ownerOf( connection );
		const second = lookup.ownerOf( connection );
		await new Promise( ( resolve ) => setTimeout( resolve, 50 ) );

		expect( fromStart( fake, TCP_FILE ) ).toBe( 1 );
		await expect( Promise.all( [ first, second ] ) ).resolves.toEqual( [
			'same-user',
			'same-user',
		] );
		expect( fromStart( fake, TCP_FILE ) ).toBe( 2 );
	} );

	it( 'is unknown, opening nothing, for a process with no uid', async () => {
		const fake = proc( { [ TCP_FILE ]: tcpTable( peerRow( OTHER_UID ) ) } );

		await expect( lookUp( fake, { uid: null } ).ownerOf( connection ) ).resolves.toBe( 'unknown' );
		expect( fake.opens ).toEqual( [] );
	} );

	describe( 'the uid map', () => {
		const nobody = { [ TCP_FILE ]: tcpTable( peerRow( NOBODY ) ) };

		it.each( [
			[ 'the initial namespace’s', INITIAL_UID_MAP ],
			[ 'the initial namespace’s with extra whitespace', '  0\t0     4294967295  \n\n' ],
		] )( 'reads the overflow uid as another user with %s map', async ( _name, uidMap ) => {
			const fake = proc( { ...nobody, [ UID_MAP_FILE ]: uidMap } );

			await expect( lookUp( fake ).ownerOf( connection ) ).resolves.toBe( 'other-user' );
		} );

		it( 'leaves the overflow uid unknown with another map', async () => {
			const fake = proc( { ...nobody, [ UID_MAP_FILE ]: CONTAINER_UID_MAP } );

			await expect( lookUp( fake ).ownerOf( connection ) ).resolves.toBe( 'unknown' );
		} );

		it.each( [ 'ENOENT', 'EACCES', 'EMFILE', 'EIO' ] )(
			'leaves the overflow uid unknown when the map can’t be read (%s)',
			async ( code ) => {
				const atOpen = proc( { ...nobody, [ UID_MAP_FILE ]: INITIAL_UID_MAP } );
				atOpen.failNextOpen( UID_MAP_FILE, systemError( code ) );
				const atRead = proc( { ...nobody, [ UID_MAP_FILE ]: INITIAL_UID_MAP } );
				atRead.failNextRead( UID_MAP_FILE, systemError( code ) );

				await expect( lookUp( atOpen ).ownerOf( connection ) ).resolves.toBe( 'unknown' );
				await expect( lookUp( atRead ).ownerOf( connection ) ).resolves.toBe( 'unknown' );
			}
		);
	} );
} );
