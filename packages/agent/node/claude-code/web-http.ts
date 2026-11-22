import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import { rootCertificates } from 'node:tls';
import { brotliDecompress, gunzip, inflate } from 'node:zlib';
import { getCertificatesPath } from '@studio/common/lib/well-known-paths';
import { openBrowserToolFile } from './browser-tool-files';
import { isLocalHostname, normalizeHostname } from './web-hostname';
import type { ClaudeWebGetOptions, ClaudeWebScope } from './web-call';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';

export class WebRefusal extends Error {
	constructor( reason: string ) {
		super( 'Studio refused the web request: ' + reason + '.' );
	}
}

const reserved = new BlockList();
for ( const [ address, prefix ] of [
	[ '192.0.0.0', 24 ],
	[ '192.0.2.0', 24 ],
	[ '192.88.99.0', 24 ],
	[ '198.18.0.0', 15 ],
	[ '198.51.100.0', 24 ],
	[ '203.0.113.0', 24 ],
	[ '224.0.0.0', 4 ],
	[ '240.0.0.0', 4 ],
] as const )
	reserved.addSubnet( address, prefix, 'ipv4' );
for ( const [ address, prefix ] of [
	[ '2001::', 23 ],
	[ '2001:db8::', 32 ],
	[ '2002::', 16 ],
	[ '3fff::', 20 ],
] as const )
	reserved.addSubnet( address, prefix, 'ipv6' );

export function publicWebAddress( address: string ): boolean {
	if ( isIP( address ) === 4 )
		return ! isLocalHostname( address ) && ! reserved.check( address, 'ipv4' );
	return isIP( address ) === 6 && /^[23]/i.test( address ) && ! reserved.check( address, 'ipv6' );
}

export async function untilAbort< T >( pending: Promise< T >, signal: AbortSignal ): Promise< T > {
	signal.throwIfAborted();
	let rejectAbort!: ( error: unknown ) => void;
	const interrupted = new Promise< never >( ( _resolve, reject ) => ( rejectAbort = reject ) );
	const stop = () => rejectAbort( signal.reason );
	signal.addEventListener( 'abort', stop, { once: true } );
	try {
		return await Promise.race( [ pending, interrupted ] );
	} finally {
		signal.removeEventListener( 'abort', stop );
	}
}

interface WebHttpOptions {
	consumeBytes?: ( count: number ) => boolean;
	onMeasurement?: ( firstByteMs: number, wireBytes: number ) => void;
	method: 'GET' | 'HEAD';
	headers?: OutgoingHttpHeaders;
	purpose: 'page' | ClaudeWebGetOptions[ 'purpose' ];
	autoLogin?: boolean;
}

export function checkedWebUrl(
	value: string,
	scope: ClaudeWebScope,
	options: WebHttpOptions
): URL {
	let url: URL;
	try {
		url = new URL( value );
	} catch {
		throw new WebRefusal( 'invalid URL' );
	}
	if ( ! [ 'http:', 'https:' ].includes( url.protocol ) || url.username || url.password )
		throw new WebRefusal( 'an HTTP or HTTPS URL without credentials is required' );
	const host = normalizeHostname( url.hostname );
	const own = url.origin === scope.targetOrigin;
	if (
		! own &&
		( isLocalHostname( host ) ||
			scope.localSiteUrls.some(
				( site ) => normalizeHostname( new URL( site ).hostname ) === host
			) )
	)
		throw new WebRefusal( 'the destination is outside the selected site' );
	switch ( options.purpose ) {
		case 'seo':
			if ( ! own ) throw new WebRefusal( 'the audit resource is outside the selected site' );
			break;
		case 'font-css':
			if ( url.origin !== 'https://fonts.googleapis.com' || url.pathname !== '/css2' )
				throw new WebRefusal( 'the stylesheet is outside the Google Fonts endpoint' );
			break;
		case 'font-file':
			if ( url.origin !== 'https://fonts.gstatic.com' )
				throw new WebRefusal( 'the font is outside the Google Fonts asset host' );
			break;
	}
	if ( ( url.pathname + url.search ).includes( '/studio-auto-login' ) ) {
		const redirect = url.searchParams.get( 'redirect_to' );
		if (
			! options.autoLogin ||
			! own ||
			url.pathname !== '/studio-auto-login' ||
			! redirect ||
			! /^\/wp-admin(?:[/?#]|$)/.test( redirect ) ||
			redirect.includes( '\\' ) ||
			new URL( redirect, url ).origin !== scope.targetOrigin
		)
			throw new WebRefusal( 'the automatic sign-in is outside the authorized editor navigation' );
	}
	return url;
}

const limits = {
	'font-css': 512 * 1024,
	'font-file': 8 * 1024 * 1024,
	seo: 2 * 1024 * 1024,
	page: 16 * 1024 * 1024,
};
export interface WebReply {
	status: number;
	headers: IncomingHttpHeaders;
	body: Buffer;
}

const studioCAs = new WeakMap< ClaudeWebScope, Promise< Buffer > >();
const publicCAs = Array.from( rootCertificates );
async function readStudioCA() {
	const root = getCertificatesPath();
	const opened = await openBrowserToolFile( root, path.join( root, 'studio-ca.crt' ) );
	await using handle = opened.handle;
	const size = Number( opened.info.size );
	if ( ! size || size > 64 * 1024 ) throw new WebRefusal( 'invalid Studio certificate size' );
	const certificate = Buffer.alloc( size );
	let position = 0;
	while ( position < size ) {
		const { bytesRead } = await handle.read( certificate, position, size - position, position );
		if ( ! bytesRead ) throw new WebRefusal( 'the Studio certificate changed while reading' );
		position += bytesRead;
	}
	return certificate;
}
function selectedSiteCA( scope: ClaudeWebScope ): Promise< Buffer > {
	let cert = studioCAs.get( scope );
	if ( ! cert ) {
		cert = readStudioCA();
		studioCAs.set( scope, cert );
	}
	return cert;
}

export async function requestWebHop(
	url: URL,
	scope: ClaudeWebScope,
	options: WebHttpOptions,
	signal: AbortSignal,
	resolveHost = ( host: string ) => lookup( host, { all: true, order: 'verbatim' } )
): Promise< WebReply > {
	const started = performance.now();
	const hostname = normalizeHostname( url.hostname );
	const literal = isIP( hostname );
	const addresses = literal
		? [ { address: hostname, family: literal } ]
		: await untilAbort( resolveHost( hostname ), signal );
	signal.throwIfAborted();
	const siteException =
		options.purpose !== 'font-file' &&
		options.purpose !== 'font-css' &&
		url.origin === scope.targetOrigin;
	if (
		! addresses.length ||
		( ! siteException && addresses.some( ( entry ) => ! publicWebAddress( entry.address ) ) )
	)
		throw new WebRefusal( 'the destination has no verified public address' );
	if (
		siteException &&
		addresses.some(
			( { address } ) =>
				! ( ( isIP( address ) === 4 && address.startsWith( '127.' ) ) || address === '::1' )
		)
	)
		throw new WebRefusal( 'the selected site does not resolve exclusively to loopback' );
	// Prefer IPv4 for Studio's local servers, which commonly listen on 127.0.0.1 only.
	const remote =
		( siteException && addresses.find( ( entry ) => entry.family === 4 ) ) || addresses[ 0 ];
	const ca =
		siteException && url.protocol === 'https:'
			? await untilAbort( selectedSiteCA( scope ), signal )
			: publicCAs;
	const request = url.protocol === 'https:' ? https.request : http.request;
	const reply = await new Promise< WebReply >( ( resolve, reject ) => {
		const req = request(
			{
				// Connect to the selected IP. Host, SNI and certificate validation still identify the original URL.
				hostname: remote.address,
				port: url.port || ( url.protocol === 'https:' ? 443 : 80 ),
				method: options.method,
				path: url.pathname + url.search,
				agent: false,
				servername: literal ? undefined : hostname,
				ca,
				rejectUnauthorized: true,
				headers: {
					...options.headers,
					Host: url.host,
					'Accept-Encoding': options.purpose === 'page' ? 'gzip, deflate, br' : 'identity',
					Connection: 'close',
				},
				signal,
			},
			( response ) => {
				const firstByteMs = performance.now() - started;
				const chunks: Buffer[] = [];
				let length = 0;
				const fail = ( error: Error ) => {
					reject( error );
					response.destroy();
				};
				response.on( 'error', reject );
				response.on( 'aborted', () => reject( new Error( 'The web response was interrupted.' ) ) );
				response.on( 'data', ( chunk: Buffer ) => {
					length += chunk.length;
					if (
						length > limits[ options.purpose ] ||
						options.consumeBytes?.( chunk.length ) === false
					)
						return fail( new WebRefusal( 'the response exceeds the size limit' ) );
					chunks.push( chunk );
				} );
				response.on( 'end', () => {
					options.onMeasurement?.( firstByteMs, length );
					resolve( {
						status: response.statusCode ?? 502,
						headers: response.headers,
						body: Buffer.concat( chunks, length ),
					} );
				} );
			}
		);
		req.once( 'error', reject );
		req.once( 'upgrade', ( _response, socket ) => {
			socket.destroy();
			reject( new WebRefusal( 'protocol upgrades are unavailable to this tool' ) );
		} );
		req.end();
	} );
	const encoding = reply.headers[ 'content-encoding' ]?.toLowerCase();
	if ( reply.body.length && encoding && encoding !== 'identity' ) {
		const decode = new Map( [
			[ 'gzip', gunzip ],
			[ 'br', brotliDecompress ],
			[ 'deflate', inflate ],
		] ).get( encoding );
		if ( ! decode ) throw new WebRefusal( 'unsupported content encoding' );
		const decoded = await untilAbort(
			new Promise< Buffer >( ( resolve, reject ) => {
				decode( reply.body, { maxOutputLength: limits[ options.purpose ] }, ( error, result ) => {
					if ( error )
						reject(
							new WebRefusal( 'the encoded response was invalid or exceeded the size limit' )
						);
					else resolve( result );
				} );
			} ),
			signal
		);
		if ( options.consumeBytes?.( Math.max( 0, decoded.length - reply.body.length ) ) === false )
			throw new WebRefusal( 'the call exceeds the size limit' );
		reply.body = decoded;
	}
	delete reply.headers[ 'content-encoding' ];
	return reply;
}

export const isWebRedirect = ( status: number ) => [ 301, 302, 303, 307, 308 ].includes( status );

export async function guardedWebGet(
	value: string,
	scope: ClaudeWebScope,
	options: ClaudeWebGetOptions,
	signal: AbortSignal,
	consumeBytes?: ( count: number ) => boolean
): Promise< Response > {
	const deadline = AbortSignal.any( [ signal, AbortSignal.timeout( 20000 ) ] );
	const request: WebHttpOptions = {
		consumeBytes,
		purpose: options.purpose,
		method: 'GET',
		headers:
			options.purpose === 'font-css' && options.userAgent
				? { 'User-Agent': options.userAgent }
				: {},
	};
	let url = checkedWebUrl( value, scope, request );
	if (
		options.purpose === 'seo' &&
		! [ '/robots.txt', '/sitemap.xml', '/sitemap_index.xml' ].includes( url.pathname )
	)
		throw new WebRefusal( 'unknown audit resource' );
	for ( let n = 0; n <= 8; n++ ) {
		const reply = await untilAbort( requestWebHop( url, scope, request, deadline ), deadline );
		if ( isWebRedirect( reply.status ) && reply.headers.location ) {
			url = checkedWebUrl( new URL( reply.headers.location, url ).href, scope, request );
			continue;
		}
		const type = reply.headers[ 'content-type' ];
		return new Response(
			[ 204, 205, 304 ].includes( reply.status ) ? null : new Uint8Array( reply.body ),
			{
				status: reply.status,
				headers: type ? { 'Content-Type': type } : {},
			}
		);
	}
	throw new WebRefusal( 'too many redirects' );
}
