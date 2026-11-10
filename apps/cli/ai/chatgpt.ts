import {
	ChatGptSettingsError,
	disconnectChatGpt,
	finishChatGptSignIn,
	readChatGptModels,
	readChatGptSettings,
	startChatGptSignIn,
	stopChatGptSignIn,
	validateChatGptSelection,
} from '@studio/agent/node/chatgpt/settings';
import { readChatGptSessionSelection } from '@studio/agent/protocol/chatgpt';
import { getChatGptModelCapabilities } from '@studio/agent/protocol/chatgpt-models';
import { getOpenAiReasoningEffortLabel } from '@studio/agent/protocol/openai-models';
import { __, sprintf } from '@wordpress/i18n';
import type {
	ChatGptAccountView,
	ChatGptCredentialStorage,
	ChatGptSettings,
} from '@studio/agent/protocol/chatgpt';
import type { SlashCommandContext } from 'cli/ai/slash-commands';

async function choose< T >(
	ctx: SlashCommandContext,
	question: string,
	options: Array< { label: string; value: T; description?: string } >
): Promise< T | undefined > {
	if ( options.length === 0 ) return undefined;
	const answers = await ctx.ui.askUser( [
		{
			question,
			options: options.map( ( option ) => ( {
				label: option.label,
				description: option.description ?? '',
			} ) ),
		},
	] );
	return options.find( ( option ) => option.label === Object.values( answers )[ 0 ] )?.value;
}

async function pickAccount( ctx: SlashCommandContext, settings: ChatGptSettings ) {
	return choose(
		ctx,
		__( 'Saved ChatGPT account' ),
		settings.accounts.map( ( account ) => ( {
			label: `${ account.label } · ${ account.connectionId }`,
			value: account,
			description: `${ account.email ?? '' } · ${
				account.authStatus === 'connected' ? __( 'Connected' ) : __( 'Needs sign-in' )
			}`,
		} ) )
	);
}

async function signIn(
	ctx: SlashCommandContext,
	settings: ChatGptSettings,
	account?: ChatGptAccountView
) {
	const storage = await choose< ChatGptCredentialStorage >( ctx, __( 'Keep ChatGPT sign-in' ), [
		...( settings.secureStorage === 'available'
			? [ { value: 'vault' as const, label: __( 'Secure storage' ) } ]
			: [] ),
		{
			value: 'session',
			label: __( 'This app session' ),
			description: __( 'Forgotten when this Studio Code session exits.' ),
		},
	] );
	if ( ! storage ) return;
	let attemptId: string | undefined;
	let cancelled = false;
	ctx.ui.onInterrupt = () => {
		cancelled = true;
		if ( attemptId ) void stopChatGptSignIn( attemptId ).catch( () => {} );
	};
	ctx.ui.setBusy( true );
	ctx.ui.showInfo( __( 'Complete ChatGPT sign-in in your browser. Press Esc to cancel.' ) );
	try {
		const started = await startChatGptSignIn( account?.connectionId, {
			storage,
			...( account?.state === 'needs-sign-in' ? { reconsent: true } : {} ),
		} );
		attemptId = started.attemptId;
		if ( cancelled ) {
			await stopChatGptSignIn( attemptId );
			return;
		}
		const outcome = await finishChatGptSignIn( attemptId );
		ctx.ui.showInfo(
			outcome.ok
				? sprintf(
						/* translators: %s: saved ChatGPT account label. */
						__( 'Connected %s. Use /chatgpt to select this account for a new chat.' ),
						outcome.label
				  )
				: outcome.message
		);
	} finally {
		ctx.ui.onInterrupt = null;
		ctx.ui.setBusy( false );
	}
}

async function configure(
	ctx: SlashCommandContext,
	account: ChatGptAccountView,
	reasoningOnly = false
) {
	if ( account.authStatus !== 'connected' )
		throw new ChatGptSettingsError( __( 'Sign in to this ChatGPT account first.' ) );
	const current = readChatGptSessionSelection( await ctx.getSessionEntries() );
	const catalog = await readChatGptModels( account.connectionId, account.revision );
	const models = catalog.models ?? [];
	const model = reasoningOnly
		? current?.model
		: await choose(
				ctx,
				__( 'ChatGPT model' ),
				models.map( ( item ) => ( {
					label: `${ item.label } · ${ item.id }`,
					value: item.id,
				} ) )
		  );
	if ( ! model ) {
		if ( models.length === 0 )
			ctx.ui.showInfo( __( 'This account lists none of the models Studio supports.' ) );
		return;
	}
	const capabilities = getChatGptModelCapabilities( model );
	if ( ! capabilities || ! models.some( ( item ) => item.id === model ) ) {
		throw new ChatGptSettingsError(
			__( 'Choose a supported model listed for this ChatGPT account.' )
		);
	}
	const effort = await choose(
		ctx,
		__( 'ChatGPT reasoning effort' ),
		capabilities.reasoningEfforts.map( ( value ) => ( {
			label: getOpenAiReasoningEffortLabel( value ),
			value,
		} ) )
	);
	if ( ! effort ) return;
	const selection = await validateChatGptSelection( {
		connectionId: account.connectionId,
		revision: account.revision,
		model,
		reasoningEffort: effort,
	} );
	const newConversation =
		ctx.currentProvider !== 'chatgpt-oauth' ||
		current?.connectionId !== selection.connectionId ||
		current.revision !== selection.revision;
	if ( newConversation ) {
		const confirmed = await choose(
			ctx,
			__(
				'Changing the account or billing connection starts a new chat. Previous history stays in the original chat.'
			),
			[
				{ label: __( 'Cancel' ), value: false },
				{ label: __( 'Start new chat' ), value: true },
			]
		);
		if ( ! confirmed ) return;
	}
	await ctx.selectChatGpt( selection );
	ctx.ui.showInfo(
		`${ __( 'ChatGPT plan' ) } · ${ account.label } · ${ account.connectionId.slice(
			0,
			8
		) } · ${ model } · ${ getOpenAiReasoningEffortLabel( effort ) }`
	);
}

export async function runChatGptCommand(
	ctx: SlashCommandContext,
	selectionOnly?: 'model' | 'reasoning'
): Promise< 'continue' > {
	try {
		const settings = await readChatGptSettings();
		if ( ! settings.enabled )
			throw new ChatGptSettingsError(
				__( 'ChatGPT plan connections are not enabled in this app.' )
			);
		if ( selectionOnly ) {
			const current = readChatGptSessionSelection( await ctx.getSessionEntries() );
			const account = settings.accounts.find(
				( item ) =>
					item.connectionId === current?.connectionId && item.revision === current.revision
			);
			if ( ! account )
				throw new ChatGptSettingsError(
					__( 'This chat’s ChatGPT connection is unavailable. Use /chatgpt to start a new chat.' )
				);
			await configure( ctx, account, selectionOnly === 'reasoning' );
			return 'continue';
		}
		const action = await choose( ctx, __( 'ChatGPT plan' ), [
			{ label: __( 'Start sign-in' ), value: 'sign-in' },
			...( settings.accounts.length
				? [
						{ label: __( 'Select saved account' ), value: 'select' },
						{ label: __( 'Sign in again' ), value: 'reauthenticate' },
						{ label: __( 'Refresh models' ), value: 'models' },
						{ label: __( 'Sign out' ), value: 'sign-out' },
				  ]
				: [] ),
		] );
		if ( action === 'sign-in' ) {
			await signIn( ctx, settings );
		} else if ( action ) {
			const account = await pickAccount( ctx, settings );
			if ( ! account ) return 'continue';
			if ( action === 'select' ) await configure( ctx, account );
			if ( action === 'reauthenticate' ) await signIn( ctx, settings, account );
			if ( action === 'models' ) {
				const catalog = await readChatGptModels( account.connectionId, account.revision );
				ctx.ui.showInfo(
					catalog.models?.map( ( model ) => model.label ).join( ', ' ) ||
						__( 'No supported models listed.' )
				);
			}
			if ( action === 'sign-out' ) {
				const result = await disconnectChatGpt( account.connectionId );
				ctx.ui.showInfo(
					! result.localCleared
						? __( 'Couldn’t clear this sign-in. Try again.' )
						: result.remoteRevocationConfirmed
						? __( 'Signed out locally. Remote revocation confirmed.' )
						: __(
								'Signed out locally. Remote revocation wasn’t confirmed; remove Studio in ChatGPT account settings if needed.'
						  )
				);
			}
		}
	} catch ( error ) {
		ctx.ui.showError(
			error instanceof ChatGptSettingsError
				? error.message
				: __( 'Couldn’t complete the ChatGPT action. Try again.' )
		);
	}
	return 'continue';
}
