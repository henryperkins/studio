import { getAiModelLabel } from '@studio/agent/protocol/models';
import { describeOpenAiError } from '@studio/agent/protocol/openai-errors';
import {
	getInitialOpenAiReasoningEffort,
	getOpenAiModelCapabilities,
	getOpenAiReasoningEffortLabel,
	getOpenAiReasoningModeLabel,
	OPENAI_DEFAULT_REASONING_MODE,
	OPENAI_MIN_MAX_OUTPUT_TOKENS,
	OPENAI_MODEL_IDS,
	type OpenAiModelId,
	type OpenAiReasoningEffort,
	type OpenAiReasoningMode,
} from '@studio/agent/protocol/openai-models';
import { __, sprintf } from '@wordpress/i18n';
import { useState } from 'react';
import {
	useAiSettings,
	useRefreshOpenAiModels,
	useRemoveOpenAiApiKey,
	useSaveOpenAiApiKey,
	useSetAiProvider,
	useSetOpenAiDefaults,
} from '@/data/queries/use-ai-settings';
import { Badge, Button, Input } from '@/lib/ui';
import { connectedBadge, SettingsGroup, SettingsRow, SettingsSelect } from './rows';
import styles from './style.module.css';
import type { OpenAiProviderSettings } from '@studio/agent/protocol/providers';

const sessionBadge = () => (
	<Badge size="xs" variant="muted">
		{ __( 'This session only' ) }
	</Badge>
);

/** The OpenAI row of the Providers card, with its key form. */
export function OpenAiProviderRow( { disabled }: { disabled?: boolean } ) {
	const settings = useAiSettings();
	const save = useSaveOpenAiApiKey();
	const remove = useRemoveOpenAiApiKey();
	const setProvider = useSetAiProvider();
	const [ formOpen, setFormOpen ] = useState( false );
	const [ key, setKey ] = useState( '' );
	const openAi = settings.data?.openAi;
	const hasKey = !! settings.data?.hasOpenAiApiKey;
	const secureStorage = openAi?.secureStorage !== 'unavailable';
	const pending = disabled || settings.isLoading || save.isPending || remove.isPending;

	const closeForm = () => {
		setKey( '' );
		setFormOpen( false );
		save.reset();
		remove.reset();
	};
	const submit = () => {
		const value = key.trim();
		const storage = secureStorage ? 'keychain' : 'session';
		// The key leaves the field as soon as it is sent, whatever happens next.
		setKey( '' );
		save.mutate(
			{ key: value, storage },
			{
				onSuccess: () => {
					closeForm();
					// Like Anthropic, a first connection becomes the default for new
					// chats. A session-only key doesn't, so a restart can't leave new
					// chats on a provider with no key.
					if ( ! hasKey && storage === 'keychain' ) {
						setProvider.mutate( 'openai-api-key' );
					}
				},
			}
		);
	};

	const keyDescription = ! secureStorage
		? __(
				'Your system keychain isn’t available, so Studio can’t save the key. A key you enter here is kept only until Studio quits; a key saved in the keychain earlier stays there, and Studio uses it again once the keychain is available.'
		  )
		: openAi?.keyStorage === 'session'
		? __(
				'This key is kept only until Studio quits. After that, Studio uses a key saved in the system keychain, if there is one. Usage is billed through your OpenAI account.'
		  )
		: __(
				'Studio saves the key to your system keychain and never shows it again. Usage is billed through your OpenAI account.'
		  );

	return (
		<>
			<SettingsRow
				title={ __( 'OpenAI' ) }
				badge={
					hasKey ? ( openAi?.keyStorage === 'session' ? sessionBadge() : connectedBadge() ) : null
				}
				description={
					hasKey && openAi?.keyHint
						? sprintf(
								/* translators: %s: the last characters of the saved key, e.g. "…abcd". */
								__( 'Use GPT models with your own API key (ending %s).' ),
								openAi.keyHint
						  )
						: __( 'Use GPT models with your own API key.' )
				}
			>
				<Button
					variant="outline"
					aria-expanded={ formOpen }
					disabled={ pending }
					onClick={ () => ( formOpen ? closeForm() : setFormOpen( true ) ) }
				>
					{ hasKey ? __( 'Manage' ) : __( 'Connect' ) }
				</Button>
			</SettingsRow>
			{ formOpen ? (
				<form
					aria-label={ __( 'OpenAI connection' ) }
					onSubmit={ ( event ) => {
						event.preventDefault();
						if ( ! pending && key.trim() ) {
							submit();
						}
					} }
				>
					<SettingsRow
						title={ __( 'OpenAI API key' ) }
						description={ keyDescription }
						error={ ( save.error ?? remove.error )?.message }
						stacked
					>
						<div className={ styles.keyForm }>
							<Input
								className={ styles.apiKeyInput }
								type="password"
								autoComplete="off"
								spellCheck={ false }
								aria-label={ __( 'OpenAI API key' ) }
								placeholder={ openAi?.keyHint ?? 'sk-…' }
								value={ key }
								disabled={ pending }
								onChange={ ( event ) => setKey( event.target.value ) }
							/>
							<Button
								variant="accent"
								type="submit"
								disabled={ pending || ! key.trim() }
								loading={ save.isPending }
								loadingAnnouncement={ __( 'Saving' ) }
							>
								{ secureStorage ? __( 'Save' ) : __( 'Use for this session' ) }
							</Button>
							{ hasKey ? (
								<Button
									variant="outline"
									disabled={ pending }
									onClick={ () => remove.mutate( undefined, { onSuccess: closeForm } ) }
								>
									{ __( 'Remove key' ) }
								</Button>
							) : null }
						</div>
					</SettingsRow>
				</form>
			) : null }
		</>
	);
}

function formatCheckedAt( checkedAt: string ): string {
	return new Date( checkedAt ).toLocaleString( undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
	} );
}

function describeAvailability( openAi: OpenAiProviderSettings ): string {
	const { availableModelIds, checkedAt } = openAi.models;
	if ( ! checkedAt || ! availableModelIds ) {
		return __(
			'Studio hasn’t confirmed which models your OpenAI project can use. Every model below can be chosen; OpenAI reports one it refuses.'
		);
	}
	if ( availableModelIds.length === 0 ) {
		return sprintf(
			/* translators: %s: date and time of the last check. */
			__( 'Your OpenAI project lists none of the models Studio supports. Checked %s.' ),
			formatCheckedAt( checkedAt )
		);
	}
	return sprintf(
		/* translators: 1: comma-separated model names, 2: date and time of the last check. */
		__( 'Your project lists %1$s. Checked %2$s.' ),
		availableModelIds.map( ( id ) => getAiModelLabel( id ) ).join( ', ' ),
		formatCheckedAt( checkedAt )
	);
}

function OutputLimitInput( {
	value,
	max,
	disabled,
	onCommit,
}: {
	value: number;
	max: number;
	disabled: boolean;
	onCommit: ( value: number ) => void;
} ) {
	const [ draft, setDraft ] = useState< string | null >( null );
	const commit = () => {
		if ( draft === null ) {
			return;
		}
		const next = Number( draft );
		setDraft( null );
		if ( draft.trim() && next !== value ) {
			onCommit( next );
		}
	};
	return (
		<Input
			className={ styles.tokenLimitInput }
			type="number"
			inputMode="numeric"
			min={ OPENAI_MIN_MAX_OUTPUT_TOKENS }
			max={ max }
			step={ 1000 }
			aria-label={ __( 'Output token limit' ) }
			value={ draft ?? String( value ) }
			disabled={ disabled }
			onChange={ ( event ) => setDraft( event.target.value ) }
			onBlur={ commit }
			onKeyDown={ ( event ) => {
				if ( event.key === 'Enter' ) {
					event.preventDefault();
					commit();
				}
			} }
		/>
	);
}

/** Models and defaults for new OpenAI chats, once a key is connected. */
export function OpenAiSettingsGroup() {
	const settings = useAiSettings();
	const refresh = useRefreshOpenAiModels();
	const setDefaults = useSetOpenAiDefaults();
	const openAi = settings.data?.openAi;
	if ( ! settings.data?.hasOpenAiApiKey || ! openAi ) {
		return null;
	}
	const pending = refresh.isPending || setDefaults.isPending;
	const available = openAi.models.availableModelIds;
	const capabilities = getOpenAiModelCapabilities( openAi.defaultModel );
	const lastError = openAi.models.lastError;

	const changeModel = ( model: OpenAiModelId ) => {
		const next = getOpenAiModelCapabilities( model )!;
		// The effort and mode stay when the new model has them; otherwise the form
		// shows the model's starting values with the change.
		setDefaults.mutate( {
			model,
			reasoningEffort: next.reasoningEfforts.includes( openAi.defaultReasoningEffort )
				? openAi.defaultReasoningEffort
				: getInitialOpenAiReasoningEffort( model ),
			reasoningMode: next.reasoningModes.includes( openAi.defaultReasoningMode )
				? openAi.defaultReasoningMode
				: OPENAI_DEFAULT_REASONING_MODE,
		} );
	};

	return (
		<SettingsGroup
			title={ __( 'OpenAI' ) }
			description={
				openAi.keyStorage === 'session'
					? __(
							'Studio keeps this key in memory until it quits, out of its settings, chats and logs. Studio’s agent runs commands as your user account, and programs you run may be able to read Studio’s memory, so this doesn’t isolate the key from them. Image generation in chats uses your WordPress.com connection, not OpenAI, and is off without one.'
					  )
					: __(
							'Studio keeps your key in the system keychain, out of its settings, chats and logs. Studio’s agent runs commands as your user account, so this protects the key at rest; it doesn’t isolate it from programs you run. Image generation in chats uses your WordPress.com connection, not OpenAI, and is off without one.'
					  )
			}
		>
			<SettingsRow
				title={ __( 'Available models' ) }
				description={ describeAvailability( openAi ) }
				error={ lastError ? describeOpenAiError( lastError ) : undefined }
			>
				<Button
					variant="outline"
					disabled={ pending }
					loading={ refresh.isPending }
					loadingAnnouncement={ __( 'Checking models' ) }
					onClick={ () => refresh.mutate() }
				>
					{ __( 'Refresh' ) }
				</Button>
			</SettingsRow>
			<SettingsRow
				title={ __( 'Default OpenAI model' ) }
				description={ __( 'The model new OpenAI chats start with.' ) }
				error={ setDefaults.error?.message }
			>
				<SettingsSelect< OpenAiModelId >
					label={ __( 'Default OpenAI model' ) }
					value={ openAi.defaultModel }
					disabled={ pending }
					options={ OPENAI_MODEL_IDS.map( ( id ) => ( {
						value: id,
						label:
							available && ! available.includes( id )
								? sprintf(
										/* translators: %s: OpenAI model name. */
										__( '%s (not in your project)' ),
										getAiModelLabel( id )
								  )
								: getAiModelLabel( id ),
						disabled: !! available && ! available.includes( id ),
					} ) ) }
					onChange={ changeModel }
				/>
			</SettingsRow>
			<SettingsRow
				title={ __( 'Reasoning effort' ) }
				description={ __(
					'How much the model reasons before it answers. Higher effort is slower and uses more tokens. Each chat can change it.'
				) }
			>
				<SettingsSelect< OpenAiReasoningEffort >
					label={ __( 'Reasoning effort' ) }
					value={ openAi.defaultReasoningEffort }
					disabled={ pending }
					options={ ( capabilities?.reasoningEfforts ?? [] ).map( ( value ) => ( {
						value,
						label: getOpenAiReasoningEffortLabel( value ),
					} ) ) }
					onChange={ ( reasoningEffort ) => setDefaults.mutate( { reasoningEffort } ) }
				/>
			</SettingsRow>
			<SettingsRow
				title={ __( 'Reasoning mode' ) }
				description={ __(
					'Pro applies more model work to each answer. It is slower and uses more tokens, billed at the model’s standard rates.'
				) }
			>
				<SettingsSelect< OpenAiReasoningMode >
					label={ __( 'Reasoning mode' ) }
					value={ openAi.defaultReasoningMode }
					disabled={ pending }
					options={ ( capabilities?.reasoningModes ?? [] ).map( ( value ) => ( {
						value,
						label: getOpenAiReasoningModeLabel( value ),
					} ) ) }
					onChange={ ( reasoningMode ) => setDefaults.mutate( { reasoningMode } ) }
				/>
			</SettingsRow>
			<SettingsRow
				title={ __( 'Output token limit' ) }
				description={ sprintf(
					/* translators: 1: smallest allowed limit, 2: largest allowed limit. */
					__(
						'The most tokens one response may use, from %1$s to %2$s. Reasoning tokens count toward it, so a low limit can cut a response short.'
					),
					OPENAI_MIN_MAX_OUTPUT_TOKENS.toLocaleString(),
					( capabilities?.maxOutputTokens ?? 0 ).toLocaleString()
				) }
			>
				<OutputLimitInput
					value={ openAi.maxOutputTokens }
					max={ capabilities?.maxOutputTokens ?? OPENAI_MIN_MAX_OUTPUT_TOKENS }
					disabled={ pending }
					onCommit={ ( maxOutputTokens ) => setDefaults.mutate( { maxOutputTokens } ) }
				/>
			</SettingsRow>
		</SettingsGroup>
	);
}
