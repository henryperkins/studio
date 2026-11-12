import type { ProcFile } from '@studio/agent/node/chatgpt/loopback-peer';

/**
 * The socket tables as Linux prints them. The layout is the kernel's own
 * (Documentation/networking/proc_net_tcp.rst): tcp4_seq_show() and
 * get_tcp4_sock() / get_timewait4_sock() in net/ipv4/tcp_ipv4.c pad every line
 * of /proc/net/tcp to 149 characters; tcp6_seq_show() and get_tcp6_sock() in
 * net/ipv6/tcp_ipv6.c print /proc/net/tcp6 unpadded. Addresses are each 32-bit
 * word of the address in network order, printed with %08X on the host, so a
 * little-endian machine shows 127.0.0.1 as 0100007F; ports are %04X. Lines end
 * with "\n" whatever the machine running the tests uses.
 */

export const OWN_UID = 1000;
export const OTHER_UID = 1001;

export const TCP_FILE = '/proc/net/tcp';
export const TCP6_FILE = '/proc/net/tcp6';
export const OVERFLOW_UID_FILE = '/proc/sys/kernel/overflowuid';
export const UID_MAP_FILE = '/proc/self/uid_map';

export const TCP_HEADER =
	'  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
export const TCP6_HEADER =
	'  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

export const hex4 = ( port: number ) => port.toString( 16 ).toUpperCase().padStart( 4, '0' );
// 127.0.0.<n> as a little-endian host prints it.
export const v4 = ( last: number ) =>
	`${ last.toString( 16 ).toUpperCase().padStart( 2, '0' ) }00007F`;
// ::ffff:127.0.0.<n>, word by word, as a little-endian host prints it.
export const mapped = ( last: number ) => `0000000000000000FFFF0000${ v4( last ) }`;

export const at = ( port: number, address = v4( 1 ) ) => `${ address }:${ hex4( port ) }`;

// "%4d: %08X:%04X %08X:%04X %02X %08X:%08X %02X:%08lX %08X %5u %8d %llu %d 0 %lu %lu %u %u %d"
export function tcpRow(
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
export function timeWaitRow( slot: number, local: string, remote: string ) {
	return `${ String( slot ).padStart(
		4
	) }: ${ local } ${ remote } 06 00000000:00000000 03:00000F9A 00000000 ${ '0'.padStart(
		5
	) } ${ '0'.padStart( 8 ) } 0 3 0`.padEnd( 149 );
}

// "%4d: %08X%08X%08X%08X:%04X %08X%08X%08X%08X:%04X %02X %08X:%08X %02X:%08lX %08X %5u %8d %llu %d 0 %lu %lu %u %u %d\n"
export function tcp6Row( slot: number, local: string, remote: string, uid: number ) {
	return `${ String( slot ).padStart(
		4
	) }: ${ local } ${ remote } 01 00000000:00000000 00:00000000 00000000 ${ String( uid ).padStart(
		5
	) } ${ '0'.padStart( 8 ) } ${ 52000 + slot } 1 0 20 4 0 10 -1`;
}

export const tcpTable = ( ...rows: string[] ) =>
	[ TCP_HEADER.padEnd( 149 ), ...rows ].map( ( line ) => `${ line }\n` ).join( '' );
export const tcp6Table = ( ...rows: string[] ) =>
	[ TCP6_HEADER, ...rows ].map( ( line ) => `${ line }\n` ).join( '' );

// The initial user namespace's map as uid_m_show() prints it, "%10u %10u %10u\n" (user_namespaces(7)).
export const INITIAL_UID_MAP = `${ '0'.padStart( 10 ) } ${ '0'.padStart( 10 ) } 4294967295\n`;

/** An error as Node's file system reports one, with its errno code. */
export const systemError = ( code: string ) =>
	Object.assign( new Error( `${ code }: test-proc-error` ), { code, syscall: 'read' } );

/** What the next read of a file from its start does instead of reading it as it is. */
type NextRead = Error | { stallMs: number } | { text: string };

/**
 * The files under /proc a lookup opens, as a scriptable stand-in. A read from
 * a file's start sees its content at that moment and the reads after it go on
 * through that same text, as the kernel's seq_file does; a test can make the
 * next open of a file fail, or the next read from its start fail, stall or
 * return other text.
 */
export function createFakeProc( files: Record< string, string > ) {
	const content = new Map( Object.entries( files ) );
	const opens: string[] = [];
	const closes: string[] = [];
	const reads: Array< { file: string; position: number } > = [];
	const openFailures = new Map< string, Error[] >();
	const nextReads = new Map< string, NextRead[] >();

	const queue = < T >( map: Map< string, T[] >, file: string, item: T ) =>
		map.set( file, [ ...( map.get( file ) ?? [] ), item ] );

	async function open( file: string ): Promise< ProcFile > {
		opens.push( file );
		const failure = openFailures.get( file )?.shift();
		if ( failure ) {
			throw failure;
		}
		if ( ! content.has( file ) ) {
			throw systemError( 'ENOENT' );
		}
		let pass = Buffer.alloc( 0 );
		return {
			read: async ( buffer, position ) => {
				reads.push( { file, position } );
				if ( position === 0 ) {
					const next = nextReads.get( file )?.shift();
					if ( next instanceof Error ) {
						throw next;
					}
					if ( next && 'stallMs' in next ) {
						await new Promise( ( resolve ) => setTimeout( resolve, next.stallMs ) );
					}
					pass = Buffer.from( next && 'text' in next ? next.text : content.get( file ) ?? '' );
				}
				if ( position >= pass.length ) {
					return 0;
				}
				return pass.copy( buffer, 0, position, Math.min( pass.length, position + buffer.length ) );
			},
			close: async () => {
				closes.push( file );
			},
		};
	}

	return {
		open,
		content,
		opens,
		closes,
		reads,
		failNextOpen: ( file: string, error: Error ) => queue( openFailures, file, error ),
		failNextRead: ( file: string, next: NextRead ) => queue( nextReads, file, next ),
	};
}

export type FakeProc = ReturnType< typeof createFakeProc >;
