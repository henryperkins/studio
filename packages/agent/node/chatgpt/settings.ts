import { createOsCredentialStore } from '@studio/common/lib/os-credential-store';
import { __ } from '@wordpress/i18n';
import { describeChatGptError } from '@studio/agent/protocol/chatgpt-errors';
import {
	describeChatGptReasoningProblem,
	resolveChatGptReasoning,
} from '@studio/agent/protocol/chatgpt-models';
import {
	ChatGptConnectionError,
	isChatGptRegistrationId,
	readChatGptAccounts,
} from './account-store';
import { beginChatGptTurn, listChatGptConnections, signOutChatGpt } from './credential-broker';
import { applyChatGptModelList, fetchChatGptModels } from './models';
import {
	beginChatGptSignIn,
	cancelChatGptSignIn,
	ChatGptSignInError,
	waitForChatGptSignIn,
} from './oauth';
import type {
	ChatGptSessionSelection,
	ChatGptSettings,
	ChatGptSignInOptions,
	ChatGptSignInOutcome,
	ChatGptSignInStart,
	ChatGptSignOutResult,
} from '@studio/agent/protocol/chatgpt';
import type { ChatGptModelAvailability } from '@studio/agent/protocol/connections';

export class ChatGptSettingsError extends Error {
	constructor( message: string ) {
		super( message );
		this.name = 'ChatGptSettingsError';
	}
}

export function isChatGptEnabled(): boolean {
	return process.env.STUDIO_EXPERIMENTAL_CHATGPT === '1';
}

export function assertChatGptEnabled(): void {
	if ( ! isChatGptEnabled() ) {
		throw new ChatGptSettingsError( __( 'ChatGPT plan connections are not enabled in this app.' ) );
	}
}

/** Only known, locally generated messages may cross an application boundary. */
export async function chatGptSettingsAction< T >( action: () => Promise< T > ): Promise< T > {
	try {
		return await action();
	} catch ( error ) {
		if ( error instanceof ChatGptSettingsError ) {
			throw error;
		}
		if ( error instanceof ChatGptSignInError ) {
			throw new ChatGptSettingsError( new ChatGptSignInError( error.code ).message );
		}
		if ( error instanceof ChatGptConnectionError ) {
			throw new ChatGptSettingsError( new ChatGptConnectionError( error.code ).message );
		}
		throw new ChatGptSettingsError(
			__( 'Studio couldn’t complete the ChatGPT action. Try again.' )
		);
	}
}

export function readChatGptSettings( signInSupported = true ): Promise< ChatGptSettings > {
	return chatGptSettingsAction( async () => {
		const enabled = isChatGptEnabled();
		if ( ! enabled ) {
			return { enabled, signInSupported: false, secureStorage: 'unavailable', accounts: [] };
		}
		const accounts = await readChatGptAccounts();
		const [ connections, secureStorage ] = await Promise.all( [
			listChatGptConnections(),
			createOsCredentialStore()
				.check()
				.catch( () => ( { available: false } ) ),
		] );
		return {
			enabled,
			signInSupported,
			secureStorage: secureStorage.available ? 'available' : 'unavailable',
			accounts: accounts.map( ( account ) => ( {
				connectionId: account.registrationId,
				providerId: 'chatgpt-oauth',
				backend: 'pi',
				revision: account.revision,
				identity: {
					subject: account.subject,
					...( account.email ? { email: account.email } : {} ),
				},
				authStatus:
					account.state === 'signed-in' &&
					connections.some(
						( connection ) =>
							connection.connectionId === account.registrationId &&
							connection.revision === account.revision &&
							connection.authStatus === 'connected'
					)
						? 'connected'
						: 'disconnected',
				label: account.label,
				email: account.email,
				storage: account.storage,
				state: account.state,
			} ) ),
		};
	} );
}

function requireRegistration( value: unknown ): asserts value is string {
	if ( ! isChatGptRegistrationId( value ) ) {
		throw new ChatGptSettingsError( __( 'Choose a saved ChatGPT account.' ) );
	}
}

const isObject = ( value: unknown ): value is Record< string, unknown > =>
	!! value && typeof value === 'object' && ! Array.isArray( value );

export function startChatGptSignIn(
	registrationId?: unknown,
	options: unknown = {},
	signInSupported = true
): Promise< ChatGptSignInStart > {
	return chatGptSettingsAction( async () => {
		assertChatGptEnabled();
		if ( ! signInSupported ) {
			throw new ChatGptSettingsError(
				__( 'Open Studio on localhost to sign in to ChatGPT on this computer.' )
			);
		}
		if ( registrationId !== undefined ) {
			requireRegistration( registrationId );
		}
		if (
			! isObject( options ) ||
			Object.keys( options ).some( ( key ) => key !== 'storage' && key !== 'reconsent' ) ||
			( options.storage !== undefined &&
				options.storage !== 'vault' &&
				options.storage !== 'session' ) ||
			( options.reconsent !== undefined && typeof options.reconsent !== 'boolean' )
		) {
			throw new ChatGptSettingsError( __( 'Choose how to keep the ChatGPT sign-in.' ) );
		}
		const { attemptId } = await beginChatGptSignIn(
			registrationId,
			options as ChatGptSignInOptions
		);
		return { attemptId };
	} );
}

export function finishChatGptSignIn( attemptId: unknown ): Promise< ChatGptSignInOutcome > {
	return chatGptSettingsAction( async () => {
		assertChatGptEnabled();
		requireRegistration( attemptId );
		const outcome = await waitForChatGptSignIn( attemptId );
		return outcome.ok
			? {
					ok: true,
					registrationId: outcome.registrationId,
					label: outcome.label,
					email: outcome.email,
			  }
			: { ok: false, code: outcome.code, message: new ChatGptSignInError( outcome.code ).message };
	} );
}

export function stopChatGptSignIn( attemptId: unknown ): Promise< boolean > {
	return chatGptSettingsAction( async () => {
		assertChatGptEnabled();
		requireRegistration( attemptId );
		return cancelChatGptSignIn( attemptId );
	} );
}

export function disconnectChatGpt( connectionId: unknown ): Promise< ChatGptSignOutResult > {
	return chatGptSettingsAction( async () => {
		assertChatGptEnabled();
		requireRegistration( connectionId );
		const { localCleared, remoteRevocationConfirmed } = await signOutChatGpt( connectionId );
		return { localCleared, remoteRevocationConfirmed };
	} );
}

async function requireConnection( connectionId: unknown, revision: unknown ): Promise< void > {
	requireRegistration( connectionId );
	if ( typeof revision !== 'number' || ! Number.isSafeInteger( revision ) || revision < 1 ) {
		throw new ChatGptSettingsError( __( 'Choose the current ChatGPT account registration.' ) );
	}
	const connection = ( await listChatGptConnections() ).find(
		( item ) => item.connectionId === connectionId
	);
	if ( ! connection || connection.authStatus !== 'connected' ) {
		throw new ChatGptConnectionError( 'needs-sign-in' );
	}
	if ( connection.revision !== revision ) {
		throw new ChatGptConnectionError( 'changed' );
	}
}

export function readChatGptModels(
	connectionId: unknown,
	revision: unknown
): Promise< ChatGptModelAvailability > {
	return chatGptSettingsAction( async () => {
		assertChatGptEnabled();
		requireRegistration( connectionId );
		await requireConnection( connectionId, revision );
		const turn = await beginChatGptTurn( connectionId );
		try {
			const result = await fetchChatGptModels( connectionId, turn.signal, {
				getAccessToken: () => turn.getAccessToken(),
				invalidateAccessToken: ( token ) => turn.invalidateAccessToken( token ),
			} );
			await turn.assertActive();
			await requireConnection( connectionId, revision );
			if ( ! result.ok ) {
				throw new ChatGptSettingsError( describeChatGptError( result.error ) );
			}
			return applyChatGptModelList( null, { connectionId, revision: revision as number }, result );
		} finally {
			turn.end();
		}
	} );
}

export function validateChatGptSelection( input: unknown ): Promise< ChatGptSessionSelection > {
	return chatGptSettingsAction( async () => {
		assertChatGptEnabled();
		if (
			! isObject( input ) ||
			Object.keys( input ).some(
				( key ) => ! [ 'connectionId', 'revision', 'model', 'reasoningEffort' ].includes( key )
			)
		) {
			throw new ChatGptSettingsError(
				__( 'Choose a ChatGPT account, model and reasoning effort.' )
			);
		}
		const { connectionId, revision, model, reasoningEffort } = input;
		requireRegistration( connectionId );
		if ( typeof model !== 'string' || typeof reasoningEffort !== 'string' ) {
			throw new ChatGptSettingsError( __( 'Choose a ChatGPT model and reasoning effort.' ) );
		}
		const reasoning = resolveChatGptReasoning( model, reasoningEffort );
		if ( ! reasoning.ok ) {
			throw new ChatGptSettingsError( describeChatGptReasoningProblem( reasoning.problem ) );
		}
		await requireConnection( connectionId, revision );
		return { connectionId, revision: revision as number, model, reasoningEffort: reasoning.effort };
	} );
}
