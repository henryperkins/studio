/**
 * A host name as every check compares it: lowercase, without IPv6 brackets and
 * without trailing dots, which name the same host. `URL` has already applied
 * IDNA, so a parsed host name is in its punycode form.
 */
export function normalizeHostname( hostname: string ): string {
	return hostname
		.toLowerCase()
		.replace( /^\[|\]$/g, '' )
		.replace( /\.+$/, '' );
}

/**
 * Whether a host name belongs to this machine or a private network: loopback,
 * private, link-local and unique-local addresses, `localhost` and `.local`.
 */
export function isLocalHostname( hostname: string ): boolean {
	const host = normalizeHostname( hostname );
	if (
		! host ||
		host === 'localhost' ||
		host.endsWith( '.localhost' ) ||
		host.endsWith( '.local' )
	)
		return true;
	// IPv4-mapped and IPv4-compatible IPv6 addresses carry an IPv4 address.
	const mapped = /^::(?:ffff:)?(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(
		host
	);
	const ipv4 = mapped
		? mapped[ 1 ] ??
		  [ parseInt( mapped[ 2 ], 16 ), parseInt( mapped[ 3 ], 16 ) ]
				.flatMap( ( word ) => [ word >> 8, word & 255 ] )
				.join( '.' )
		: host;
	const octets = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec( ipv4 )?.slice( 1 ).map( Number );
	if ( octets ) {
		const [ a, b ] = octets;
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			( a === 100 && b >= 64 && b <= 127 ) ||
			( a === 169 && b === 254 ) ||
			( a === 172 && b >= 16 && b <= 31 ) ||
			( a === 192 && b === 168 )
		);
	}
	return (
		host.includes( ':' ) &&
		( host === '::' ||
			host === '::1' ||
			/^f[cd][0-9a-f]{0,2}:/.test( host ) ||
			/^fe[89ab][0-9a-f]?:/.test( host ) )
	);
}
