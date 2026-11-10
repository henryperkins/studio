import { createChatGptCredentialBroker } from '@studio/agent/node/chatgpt/credential-broker';
import { createFakeCredentialStore } from '../fake-credential-store.ts';

// A native fork using the real broker and IPC protocol, with test credentials only.
const connectionId = process.env.STUDIO_CHATGPT_SESSIONS_OFFERED?.split( ',' )[ 0 ];
if ( ! connectionId ) {
	throw new Error( 'No test connection was offered.' );
}
const broker = createChatGptCredentialBroker( {
	credentialStore: createFakeCredentialStore().store,
	tokenClient: {
		refresh: async () => {
			throw new Error( 'The parent owns refresh.' );
		},
		revoke: async () => {
			throw new Error( 'The parent owns revocation.' );
		},
	},
} );
broker.acceptSessionTokensFromParent();

function report( message: string ): void {
	process.send?.( { type: 'info', timestamp: new Date().toISOString(), message } );
}

let token: string;
let commands = Promise.resolve();
process.on( 'disconnect', () => process.exit( 0 ) );
process.on( 'message', ( message: unknown ) => {
	if ( ! message || typeof message !== 'object' || ! ( 'type' in message ) ) {
		return;
	}
	if ( message.type === 'interrupt' ) {
		report( 'interrupt-received' );
		return;
	}
	if (
		message.type === 'studio.chatgpt-session-token' &&
		'requestId' in message &&
		message.requestId === 'after-interrupt'
	) {
		report(
			'accessToken' in message && message.accessToken === null
				? 'token-blocked'
				: 'unexpected-token'
		);
		return;
	}
	if ( message.type !== 'answer' || ! ( 'answers' in message ) ) {
		return;
	}
	const { action } = message.answers as Record< string, string >;
	commands = commands
		.then( async () => {
			if ( action === 'reject' ) {
				await broker.invalidateAccessToken( connectionId, token );
				token = await broker.getAccessToken( connectionId );
				report( token === 'test-access-token-renewed' ? 'renewed' : 'unexpected-token' );
			} else if ( action === 'request-after-interrupt' ) {
				process.send?.( {
					type: 'studio.chatgpt-session-token.request',
					requestId: 'after-interrupt',
					connectionId,
					logoutGeneration: 0,
				} );
			} else if ( action === 'finish' ) {
				process.exit( 0 );
			}
		} )
		.catch( () => report( 'command-failed' ) );
} );

void broker.getAccessToken( connectionId ).then(
	( accessToken ) => {
		token = accessToken;
		report( token === 'test-access-token-initial' ? 'ready' : 'unexpected-token' );
	},
	() => {
		report( 'startup-failed' );
		process.exit( 1 );
	}
);
