import { getAiModelLabel } from '@studio/agent/protocol/models';
import {
	AI_PROVIDER_LABELS,
	getAiProviderModels,
	type AiProviderId,
} from '@studio/agent/protocol/providers';
import { getStudioCodeAiAccessState } from '@studio/common/lib/studio-assistant-quota';
import { useQueries } from '@tanstack/react-query';
import { __, sprintf } from '@wordpress/i18n';
import { InfoIcon, PlugIcon, SparklesIcon } from 'lucide-react';
import { useRef, useState, type RefObject, ComponentType } from 'react';
import { useConnector } from '@/data/core';
import { useStudioAssistantQuota } from '@/data/queries/use-assistant-quota';
import { chatGptModelsQuery, nameChatGptAccount } from '@/data/queries/use-chatgpt-settings';
import { useUserPreferences } from '@/data/queries/use-user-preferences';
import { useOpenSettings } from '@/data/use-open-settings';
import { getCreditsLabel, getModelDescription } from '@/features/composer/model-options';
import { PlusIcon, ChevronDownIcon, ClaudeIcon, WordPressIcon } from '@/lib/icons';
import { Button, CommandList, Popover, type Command, type CommandGroup } from '@/lib/ui';
import styles from './style.module.css';
import type { AiModelId } from '@/data/core';
import type { ModelLockReason } from '@/features/composer/use-model-access';
import type { ChatGptAccountView } from '@studio/agent/protocol/chatgpt';

// Brand names, not translated.
const PROVIDER_BRANDS: Record< AiProviderId, { name: string; icon: ComponentType } > = {
	wpcom: { name: 'WordPress', icon: WordPressIcon },
	'anthropic-api-key': { name: 'Claude', icon: ClaudeIcon },
	'openai-api-key': { name: 'OpenAI', icon: SparklesIcon },
	'chatgpt-oauth': { name: 'ChatGPT', icon: SparklesIcon },
};

interface ModelPickerProps {
	open: boolean;
	onOpenChange: ( open: boolean ) => void;
	model: AiModelId;
	// The providers this chat can use, and the one it is on.
	providers: AiProviderId[];
	sessionProvider: AiProviderId;
	getModelLockReason: ( id: AiModelId ) => ModelLockReason | undefined;
	disabled: boolean;
	anchor: HTMLElement | null;
	onChange: ( provider: AiProviderId, model: AiModelId ) => void;
	onAddCredits: ( returnFocus: RefObject< HTMLElement | null > ) => void;
	chatGptAccounts?: ChatGptAccountView[];
	// A ChatGPT chat's plan and account, which the Model button says in place of its provider.
	chatGptConnection?: string;
	chatGptModel?: string;
	chatGptModelId?: string;
	chatGptConnectionId?: string;
	onChatGptChange?: ( account: ChatGptAccountView, model: string ) => void;
}

export function ModelPicker( {
	open,
	onOpenChange,
	model,
	providers,
	sessionProvider,
	getModelLockReason,
	disabled,
	anchor,
	onChange,
	onAddCredits,
	chatGptAccounts = [],
	chatGptConnection,
	chatGptModel,
	chatGptModelId,
	chatGptConnectionId,
	onChatGptChange,
}: ModelPickerProps ) {
	const connector = useConnector();
	const catalogs = useQueries( {
		queries: chatGptAccounts.map( ( account ) => chatGptModelsQuery( connector, account, open ) ),
	} );
	const [ highlight, setHighlight ] = useState< string >();
	const listRef = useRef< HTMLDivElement | null >( null );
	const triggerRef = useRef< HTMLButtonElement | null >( null );
	const openSettings = useOpenSettings();
	const {
		data: quota,
		isError: isQuotaError,
		refetch: refetchQuota,
	} = useStudioAssistantQuota( { refetchOnWindowFocus: 'always' } );
	const { data: preferences } = useUserPreferences();
	const isWpcom = sessionProvider === 'wpcom';

	const modelLabel = chatGptModel ?? getAiModelLabel( model );
	const credits = getCreditsLabel( isQuotaError ? null : quota, preferences?.locale );
	const canPurchaseCredits =
		isWpcom &&
		!! quota &&
		credits.hasCredits &&
		getStudioCodeAiAccessState( quota ) === 'available' &&
		quota.hasPaymentMethod;
	const modelDetails = [ modelLabel, chatGptConnection ?? AI_PROVIDER_LABELS[ sessionProvider ] ];
	if ( isWpcom ) {
		modelDetails.push( credits.label );
	}
	const accountName = ( account: ChatGptAccountView ) =>
		nameChatGptAccount( account, chatGptAccounts );
	const chatGptCommands = chatGptAccounts.flatMap( ( account, index ) =>
		( catalogs[ index ].data?.models ?? [] ).map( ( item ) => ( {
			value: `chatgpt:${ account.connectionId }:${ item.id }`,
			account,
			model: item,
		} ) )
	);
	const pickCommand = ( value: string ) => {
		const retryIndex = chatGptAccounts.findIndex(
			( account ) => value === `refresh:${ account.connectionId }`
		);
		if ( retryIndex !== -1 ) {
			void catalogs[ retryIndex ].refetch();
			return;
		}
		onOpenChange( false );
		const chatGptCommand = chatGptCommands.find( ( command ) => command.value === value );
		if ( chatGptCommand ) {
			onChatGptChange?.( chatGptCommand.account, chatGptCommand.model.id );
			return;
		}
		if ( value === 'get-credits' ) {
			onAddCredits( triggerRef );
		} else if ( value === 'connect-provider' ) {
			openSettings( 'ai' );
		} else {
			const provider = providers.find( ( id ) =>
				getAiProviderModels( id ).some( ( item ) => item.id === value )
			);
			if ( provider ) {
				onChange( provider, value as AiModelId );
			}
		}
	};
	const chatGptAccountItems = ( account: ChatGptAccountView, index: number ): Command[] =>
		account.authStatus !== 'connected'
			? [
					{
						value: `disconnected:${ account.connectionId }`,
						label: __( 'Sign in to this ChatGPT account in Settings' ),
						// Why the account offers no models here, in Settings' words for it.
						description:
							account.state === 'signed-out' ? __( 'Signed out' ) : __( 'Needs sign-in' ),
						disabled: true,
						icon: PlugIcon,
					},
			  ]
			: chatGptCommands.some( ( command ) => command.account === account )
			? chatGptCommands
					.filter( ( command ) => command.account === account )
					.map( ( command ) => ( {
						value: command.value,
						label: command.model.label,
						description: __( 'ChatGPT plan' ),
						icon: SparklesIcon,
					} ) )
			: [
					{
						value: `refresh:${ account.connectionId }`,
						label: catalogs[ index ].isFetching
							? __( 'Checking ChatGPT models…' )
							: catalogs[ index ].isError
							? __( 'Retry ChatGPT models' )
							: __( 'No supported ChatGPT models. Refresh' ),
						description: catalogs[ index ].error?.message,
						disabled: catalogs[ index ].isFetching,
						icon: SparklesIcon,
					},
			  ];
	// Says an account offers more without naming or offering those models. Kept outside the
	// option list so it wraps and can't be chosen.
	const unqualifiedNotes = chatGptAccounts.flatMap( ( account, index ) =>
		account.authStatus === 'connected' && catalogs[ index ].data?.listsUnqualifiedModels
			? [
					{
						connectionId: account.connectionId,
						heading: accountName( account ),
					},
			  ]
			: []
	);
	const groups: CommandGroup[] = [
		{
			label: __( 'Models' ),
			items: providers.flatMap( ( provider ) =>
				getAiProviderModels( provider ).map( ( { id } ): Command => {
					const description = sprintf(
						/* translators: 1: the model's provider, 2: what the model is good at. */
						__( '%1$s · %2$s' ),
						PROVIDER_BRANDS[ provider ].name,
						getModelDescription( id )
					);
					const lockReason = getModelLockReason( id );
					return {
						value: id,
						label: getAiModelLabel( id ),
						description: lockReason
							? `${ description } · ${
									lockReason === 'credits'
										? __( 'Purchased credits required' )
										: __( 'Not in your OpenAI project' )
							  }`
							: description,
						icon: PROVIDER_BRANDS[ provider ].icon,
						disabled: !! lockReason,
					};
				} )
			),
		},
		...chatGptAccounts.map(
			( account, index ): CommandGroup => ( {
				label: sprintf(
					/* translators: %s: the ChatGPT account a chat runs on. */
					__( 'ChatGPT plan · %s' ),
					accountName( account )
				),
				heading: accountName( account ),
				items: chatGptAccountItems( account, index ),
			} )
		),
		{
			label: __( 'Actions' ),
			heading: __( 'Actions' ),
			items: [
				...( canPurchaseCredits
					? [
							{
								value: 'get-credits',
								label: __( 'Get more credits' ),
								description: credits.label,
								icon: PlusIcon,
							},
					  ]
					: [] ),
				{
					value: 'connect-provider',
					label: __( 'Connect provider…' ),
					description: __( 'Add or manage your providers' ),
					icon: PlugIcon,
				},
			],
		},
	];

	return (
		<Popover.Root
			open={ open }
			onOpenChange={ ( next ) => {
				onOpenChange( next );
				if ( next ) {
					setHighlight(
						chatGptConnectionId && chatGptModelId
							? `chatgpt:${ chatGptConnectionId }:${ chatGptModelId }`
							: model
					);
					if ( isWpcom ) {
						void refetchQuota();
					}
				}
			} }
		>
			<Popover.Trigger
				render={
					<Button
						ref={ triggerRef }
						variant="ghost"
						shape="round"
						aria-label={ __( 'Model' ) }
						aria-description={ modelDetails.join( ' · ' ) }
						title={ modelDetails.join( ' · ' ) }
						disabled={ disabled }
					/>
				}
			>
				<span>{ modelLabel }</span>
				<ChevronDownIcon data-icon="inline-end" data-dropdown-indicator />
			</Popover.Trigger>
			<Popover.Popup
				variant="commands"
				side="top"
				anchor={ anchor }
				initialFocus={ listRef }
				finalFocus={ triggerRef }
				aria-label={ __( 'Choose a model' ) }
			>
				<CommandList
					label={ __( 'Choose a model' ) }
					groups={ groups }
					highlighted={ highlight }
					onHighlight={ setHighlight }
					onSelect={ pickCommand }
					listRef={ listRef }
					className={ styles.pickerList }
				/>
				{ unqualifiedNotes.length ? (
					<div className={ styles.pickerNotes }>
						{ unqualifiedNotes.map( ( { connectionId, heading } ) => (
							<p key={ connectionId } role="note" className={ styles.pickerNote }>
								<InfoIcon className={ styles.pickerNoteIcon } aria-hidden="true" />
								<span>
									{ unqualifiedNotes.length > 1 ? (
										<span className={ styles.pickerNoteAccount }>{ heading } </span>
									) : null }
									{ __( 'Some models this account offers aren’t supported in Studio yet' ) }
								</span>
							</p>
						) ) }
					</div>
				) : null }
			</Popover.Popup>
		</Popover.Root>
	);
}
