import { getAiModelLabel } from '@studio/agent/protocol/models';
import {
	AI_PROVIDER_LABELS,
	getAiProviderModels,
	type AiProviderId,
} from '@studio/agent/protocol/providers';
import { getStudioCodeAiAccessState } from '@studio/common/lib/studio-assistant-quota';
import { __, sprintf } from '@wordpress/i18n';
import { PlugIcon, SparklesIcon } from 'lucide-react';
import { useRef, useState, type RefObject, ComponentType } from 'react';
import { useStudioAssistantQuota } from '@/data/queries/use-assistant-quota';
import { useUserPreferences } from '@/data/queries/use-user-preferences';
import { useOpenSettings } from '@/data/use-open-settings';
import { getCreditsLabel, getModelDescription } from '@/features/composer/model-options';
import { PlusIcon, ChevronDownIcon, ClaudeIcon, WordPressIcon } from '@/lib/icons';
import { Button, CommandSheet, Popover, type Command, type CommandGroup } from '@/lib/ui';
import type { AiModelId } from '@/data/core';
import type { ModelLockReason } from '@/features/composer/use-model-access';

// Brand names, not translated.
const PROVIDER_BRANDS: Record< AiProviderId, { name: string; icon: ComponentType } > = {
	wpcom: { name: 'WordPress', icon: WordPressIcon },
	'anthropic-api-key': { name: 'Claude', icon: ClaudeIcon },
	'openai-api-key': { name: 'OpenAI', icon: SparklesIcon },
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
}: ModelPickerProps ) {
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

	const modelLabel = getAiModelLabel( model );
	const credits = getCreditsLabel( isQuotaError ? null : quota, preferences?.locale );
	const canPurchaseCredits =
		isWpcom &&
		!! quota &&
		credits.hasCredits &&
		getStudioCodeAiAccessState( quota ) === 'available' &&
		quota.hasPaymentMethod;
	const modelDetails = [ modelLabel, AI_PROVIDER_LABELS[ sessionProvider ] ];
	if ( isWpcom ) {
		modelDetails.push( credits.label );
	}
	const pickCommand = ( value: string ) => {
		onOpenChange( false );
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
					setHighlight( model );
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
			<CommandSheet
				label={ __( 'Choose a model' ) }
				groups={ groups }
				highlighted={ highlight }
				onHighlight={ setHighlight }
				onSelect={ pickCommand }
				listRef={ listRef }
				anchor={ anchor }
				initialFocus={ listRef }
				finalFocus={ triggerRef }
			/>
		</Popover.Root>
	);
}
