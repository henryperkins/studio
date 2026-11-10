import {
	getOpenAiReasoningEffortLabel,
	getOpenAiReasoningModeLabel,
	isOpenAiReasoningEffort,
	isOpenAiReasoningMode,
	OPENAI_REASONING_MODES,
	type OpenAiModelCapabilities,
	type OpenAiReasoningEffort,
	type OpenAiReasoningMode,
} from '@studio/agent/protocol/openai-models';
import { __, sprintf } from '@wordpress/i18n';
import { ChevronDownIcon } from '@/lib/icons';
import { Button, Menu } from '@/lib/ui';
import styles from './style.module.css';

interface ReasoningPickerProps {
	capabilities?: Pick< OpenAiModelCapabilities, 'reasoningEfforts' | 'reasoningModes' >;
	// Plain strings: a stored value the model doesn't support still shows.
	effort: string;
	mode: string;
	disabled: boolean;
	onChange: ( effort: OpenAiReasoningEffort, mode: OpenAiReasoningMode ) => void;
}

function effortLabel( effort: string ): string {
	return isOpenAiReasoningEffort( effort ) ? getOpenAiReasoningEffortLabel( effort ) : effort;
}

function modeLabel( mode: string ): string {
	return isOpenAiReasoningMode( mode ) ? getOpenAiReasoningModeLabel( mode ) : mode;
}

/** The reasoning effort and mode of an OpenAI chat, applied from its next message. */
export function ReasoningPicker( {
	capabilities,
	effort,
	mode,
	disabled,
	onChange,
}: ReasoningPickerProps ) {
	const label =
		mode === 'pro'
			? sprintf(
					/* translators: %s: reasoning effort, e.g. "High"; the chat also uses Pro mode. */
					__( '%s · Pro' ),
					effortLabel( effort )
			  )
			: effortLabel( effort );
	const description = sprintf(
		/* translators: 1: reasoning effort, e.g. "High", 2: reasoning mode, e.g. "Standard". */
		__( '%1$s effort, %2$s mode. Changes apply from your next message.' ),
		effortLabel( effort ),
		modeLabel( mode )
	);
	const modes = OPENAI_REASONING_MODES.filter(
		( value ) => capabilities?.reasoningModes.includes( value )
	);

	return (
		<Menu.Root>
			<Menu.Trigger
				render={
					<Button
						variant="ghost"
						shape="round"
						aria-label={ __( 'Reasoning' ) }
						aria-description={ description }
						title={ description }
						disabled={ disabled || ! capabilities }
					/>
				}
			>
				<span>{ label }</span>
				<ChevronDownIcon data-icon="inline-end" data-dropdown-indicator />
			</Menu.Trigger>
			<Menu.Popup className={ styles.reasoningMenu }>
				<Menu.Group>
					<Menu.GroupLabel>{ __( 'Reasoning effort' ) }</Menu.GroupLabel>
					<Menu.RadioGroup
						value={ effort }
						onValueChange={ ( value ) =>
							onChange( value as OpenAiReasoningEffort, mode as OpenAiReasoningMode )
						}
					>
						{ capabilities?.reasoningEfforts.map( ( value ) => (
							<Menu.RadioItem key={ value } value={ value }>
								{ getOpenAiReasoningEffortLabel( value ) }
							</Menu.RadioItem>
						) ) }
					</Menu.RadioGroup>
				</Menu.Group>
				{ modes.length > 1 ? (
					<>
						<Menu.Separator />
						<Menu.Group>
							<Menu.GroupLabel>{ __( 'Mode' ) }</Menu.GroupLabel>
							<Menu.RadioGroup
								value={ mode }
								onValueChange={ ( value ) =>
									onChange( effort as OpenAiReasoningEffort, value as OpenAiReasoningMode )
								}
							>
								{ modes.map( ( value ) => (
									<Menu.RadioItem key={ value } value={ value }>
										<span className={ styles.reasoningOption }>
											{ getOpenAiReasoningModeLabel( value ) }
											<span className={ styles.reasoningHint }>
												{ value === 'pro'
													? __( 'More model work per answer: slower, uses more tokens' )
													: __( 'The model’s usual execution' ) }
											</span>
										</span>
									</Menu.RadioItem>
								) ) }
							</Menu.RadioGroup>
						</Menu.Group>
					</>
				) : null }
			</Menu.Popup>
		</Menu.Root>
	);
}
