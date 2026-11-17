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
	ChatGptAccountView,
	ChatGptCredentialStorage,
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
			throw new ChatGptSettingsError(
				new ChatGptConnectionError( error.code, error.detail ).message
			);
		}
		throw new ChatGptSettingsError(
			__( 'Studio couldn’t complete the ChatGPT action. Try again.' )
		);
	}
}

type SecureStorage = ChatGptSettings[ 'secureStorage' ];

/**
 * Whether the system keychain can keep sign-ins, as last checked. A check runs
 * the keychain's tool, which a Secret Service may answer with a prompt, so the
 * settings, read every few seconds, never check: the first read that needs the
 * answer does, and after that only an explicit recheck, or what a sign-in that
 * starts learns from its own read of the key.
 */
const secureStorage: {
	known?: SecureStorage;
	checking?: Promise< SecureStorage >;
	checks: number;
} = { checks: 0 };

function checkSecureStorage(): Promise< SecureStorage > {
	const check = ++secureStorage.checks;
	const checking = createOsCredentialStore()
		.check()
		.then(
			( status ): SecureStorage => ( status.available ? 'available' : 'unavailable' ),
			(): SecureStorage => 'unavailable'
		)
		.then( ( answer ) => {
			// A later check's answer stands over an earlier one that finished after it.
			if ( check === secureStorage.checks ) {
				secureStorage.known = answer;
				secureStorage.checking = undefined;
			}
			return answer;
		} );
	secureStorage.checking = checking;
	return checking;
}

// What a sign-in's own read of the keychain found stands, over a check still out.
function learnSecureStorage( answer: SecureStorage ): void {
	secureStorage.checks++;
	secureStorage.known = answer;
	secureStorage.checking = undefined;
}

function knownSecureStorage(): Promise< SecureStorage > {
	return secureStorage.known
		? Promise.resolve( secureStorage.known )
		: secureStorage.checking ?? checkSecureStorage();
}

const disabledSettings = (): ChatGptSettings => ( {
	enabled: false,
	signInSupported: false,
	secureStorage: 'unavailable',
	accounts: [],
} );

export function readChatGptSettings( signInSupported = true ): Promise< ChatGptSettings > {
	return chatGptSettingsAction( async () =>
		isChatGptEnabled()
			? readEnabledSettings( signInSupported, knownSecureStorage() )
			: disabledSettings()
	);
}

/**
 * The settings, after checking the system keychain again: for when the user
 * opens the ChatGPT settings or asks to retry, never for a polled read.
 */
export function recheckChatGptSettings( signInSupported = true ): Promise< ChatGptSettings > {
	return chatGptSettingsAction( async () =>
		isChatGptEnabled()
			? readEnabledSettings( signInSupported, checkSecureStorage() )
			: disabledSettings()
	);
}

async function readEnabledSettings(
	signInSupported: boolean,
	storage: Promise< SecureStorage >
): Promise< ChatGptSettings > {
	const accounts = await readChatGptAccounts();
	const [ connections, available ] = await Promise.all( [ listChatGptConnections(), storage ] );
	return {
		enabled: true,
		signInSupported,
		secureStorage: available,
		accounts: accounts.map( ( account ) => ( {
			connectionId: account.registrationId,
			providerId: 'chatgpt-oauth',
			backend: 'pi',
			revision: account.revision,
			// The subject stays in the backend: a renderer only needs to know there is one.
			identity: {
				verified: true,
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
		// The settings read after it learn of the keychain without its tool run
		// beside the start's own runs, which a Secret Service may each answer
		// with a prompt: a sign-in kept in the vault checks the key itself, and
		// what that found is the answer; one kept for this session only asks the
		// keychain nothing of its own, so it is checked once the start is done.
		// A check already out, as when the settings were opened, runs first.
		await secureStorage.checking;
		const chosen: { storage?: ChatGptCredentialStorage } = {};
		try {
			const { attemptId } = await beginChatGptSignIn(
				registrationId,
				options as ChatGptSignInOptions,
				{
					storageChosen( storage, keychain ) {
						chosen.storage = storage;
						if ( keychain ) {
							learnSecureStorage( keychain );
						}
					},
				}
			);
			return { attemptId };
		} finally {
			if ( chosen.storage === 'session' ) {
				void checkSecureStorage();
			}
		}
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

/**
 * The saved sign-ins there are to sign out of, whether or not ChatGPT is
 * turned on: removing Studio's access never depends on an experimental flag.
 */
export function readSavedChatGptSignIns(): Promise<
	Array< Pick< ChatGptAccountView, 'connectionId' | 'label' | 'email' > >
> {
	return chatGptSettingsAction( async () =>
		( await readChatGptAccounts() )
			.filter( ( account ) => account.state === 'signed-in' )
			.map( ( account ) => ( {
				connectionId: account.registrationId,
				label: account.label,
				email: account.email,
			} ) )
	);
}

// Not behind the flag: removing Studio's access never depends on it.
export function disconnectChatGpt( connectionId: unknown ): Promise< ChatGptSignOutResult > {
	return chatGptSettingsAction( async () => {
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
