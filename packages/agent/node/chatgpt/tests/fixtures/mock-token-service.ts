import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockTokenService {
	url: string;
	/** The refresh token each refresh request presented, in arrival order. */
	refreshes: string[];
	/** The token each revocation request named. */
	revocations: string[];
	/** What the latest successful refresh issued, or null before one. */
	issued(): { accessToken: string; refreshToken: string } | null;
	close(): Promise< void >;
}

/**
 * A local token endpoint that rotates refresh tokens as the real one does: a
 * refresh token works once, and presenting it again is reported as reuse. Each
 * successful refresh is answered after `delayMs`, so racing processes overlap.
 */
export async function startMockTokenService( {
	refreshToken,
	delayMs = 0,
}: {
	refreshToken: string;
	delayMs?: number;
} ): Promise< MockTokenService > {
	let current = refreshToken;
	let generation = 0;
	let issued: { accessToken: string; refreshToken: string } | null = null;
	const refreshes: string[] = [];
	const revocations: string[] = [];

	const server = http.createServer( ( request, response ) => {
		let body = '';
		request.setEncoding( 'utf8' );
		request.on( 'data', ( chunk: string ) => ( body += chunk ) );
		request.on( 'end', () => {
			const form = new URLSearchParams( body );
			const reply = ( status: number, payload?: unknown ) => {
				response.writeHead( status, { 'content-type': 'application/json' } );
				response.end( payload === undefined ? '' : JSON.stringify( payload ) );
			};
			if ( request.url === '/token' && form.get( 'grant_type' ) === 'refresh_token' ) {
				const presented = form.get( 'refresh_token' ) ?? '';
				refreshes.push( presented );
				if ( presented !== current ) {
					reply( 400, { error: 'refresh_token_reused' } );
					return;
				}
				generation += 1;
				const next = {
					accessToken: `test-access-token-rotated-${ generation }`,
					refreshToken: `test-refresh-token-rotated-${ generation }`,
				};
				// Spent the moment it arrives.
				current = next.refreshToken;
				issued = next;
				setTimeout(
					() =>
						reply( 200, {
							access_token: next.accessToken,
							refresh_token: next.refreshToken,
							token_type: 'Bearer',
							expires_in: 3600,
							scope:
								'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
						} ),
					delayMs
				);
				return;
			}
			if ( request.url === '/revoke' ) {
				revocations.push( form.get( 'token' ) ?? '' );
				reply( 200 );
				return;
			}
			reply( 404 );
		} );
	} );

	await new Promise< void >( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${ port }`,
		refreshes,
		revocations,
		issued: () => issued,
		close: () => new Promise< void >( ( resolve ) => server.close( () => resolve() ) ),
	};
}
