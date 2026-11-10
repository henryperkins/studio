import http from 'node:http';
import {
	CHATGPT_TERMINAL_REFRESH_ERRORS,
	type ChatGptTokenClient,
} from '@studio/agent/node/chatgpt/credential-broker';

function post(
	url: string,
	form: Record< string, string >,
	signal: AbortSignal
): Promise< { status: number; body: string } > {
	return new Promise( ( resolve, reject ) => {
		const body = new URLSearchParams( form ).toString();
		const request = http.request(
			url,
			{
				method: 'POST',
				// No keep-alive socket, so a test process exits once its work is done.
				agent: false,
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					'content-length': Buffer.byteLength( body ),
				},
				signal,
			},
			( response ) => {
				let text = '';
				response.setEncoding( 'utf8' );
				response.on( 'data', ( chunk: string ) => ( text += chunk ) );
				response.on( 'end', () => resolve( { status: response.statusCode ?? 0, body: text } ) );
			}
		);
		request.on( 'error', reject );
		request.end( body );
	} );
}

/** A token client for the mock token service, classifying its errors as the real one does. */
export function createHttpTokenClient( baseUrl: string ): ChatGptTokenClient {
	return {
		async refresh( { clientId, refreshToken, signal } ) {
			try {
				const response = await post(
					`${ baseUrl }/token`,
					{ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken },
					signal
				);
				const body = response.body ? JSON.parse( response.body ) : {};
				if ( response.status === 200 ) {
					return {
						ok: true,
						value: {
							accessToken: body.access_token,
							refreshToken: body.refresh_token,
							tokenType: body.token_type,
							expiresIn: body.expires_in,
							scope: body.scope,
						},
					};
				}
				const terminal = CHATGPT_TERMINAL_REFRESH_ERRORS.includes( body.error );
				return {
					ok: false,
					error: {
						kind: terminal ? 'terminal' : 'transient',
						code: body.error,
						status: response.status,
					},
				};
			} catch {
				return { ok: false, error: { kind: 'transient' } };
			}
		},
		async revoke( { clientId, refreshToken, signal } ) {
			try {
				const response = await post(
					`${ baseUrl }/revoke`,
					{ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId },
					signal
				);
				if ( response.status === 200 ) {
					return { ok: true, value: undefined };
				}
				return {
					ok: false,
					error: {
						kind: response.status >= 500 ? 'transient' : 'terminal',
						status: response.status,
					},
				};
			} catch {
				return { ok: false, error: { kind: 'transient' } };
			}
		},
	};
}
