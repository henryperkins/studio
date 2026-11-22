import {
	findOwnFreeFormOptionLabel,
	SKIPPED_QUESTION,
	STOPPED_WITHOUT_ANSWER,
} from '@studio/agent/protocol/tools';
import { __, sprintf } from '@wordpress/i18n';
import { SearchIcon } from 'lucide-react';
import { useState, type ReactNode, type Ref } from 'react';
import { useLocalMediaDataUrl } from '@/data/queries/use-local-media';
import { QuestionOptionViewer } from '@/features/chats/session-view/conversation/agent-question/option-viewer';
import { joinedAttributes, type Joined } from '@/features/chats/session-view/conversation/joined';
import {
	Button,
	Textarea,
	IconButton,
	Questionnaire,
	QuestionnaireAnswer,
	QuestionnaireChoice,
	QuestionnaireChoices,
	QuestionnaireDescription,
	QuestionnaireTitle,
} from '@/lib/ui';
import styles from './style.module.css';
import type { AgentQuestionRenderItem } from '@/features/chats/session-view/conversation/transcript-items';

function focusAnswerInput( node: HTMLTextAreaElement | null ) {
	node?.focus();
}

function getAnswerLetter(
	options: AgentQuestionRenderItem[ 'options' ],
	pickedLabel: string
): string | undefined {
	const index = options.findIndex( ( option ) => option.label === pickedLabel );
	return index < 0 ? undefined : String.fromCharCode( 65 + index );
}

export function AgentQuestion( {
	question,
	options,
	multiSelect = false,
	isInteractive,
	pickedLabel,
	selectedLabels = [],
	onSelectionChange,
	onSkip,
	onBack,
	pager,
	submitLabel,
	freeFormActive = false,
	onAnswer,
	onChooseFreeForm,
	onTypedAnswer,
	claudeSessionId,
	ref,
	tabIndex,
	...joined
}: {
	question: string;
	options: Array< { label: string; description: string; image?: string } >;
	multiSelect?: boolean;
	isInteractive: boolean;
	pickedLabel: string | undefined;
	selectedLabels?: string[];
	onSelectionChange?: ( labels: string[] ) => void;
	onSkip?: () => void;
	onBack?: () => void;
	pager?: ReactNode;
	submitLabel?: string;
	freeFormActive?: boolean;
	onAnswer?: () => void;
	onChooseFreeForm: () => void;
	onTypedAnswer?: ( answer: string ) => void;
	claudeSessionId?: string;
	ref?: Ref< HTMLFieldSetElement >;
	tabIndex?: number;
} & Joined ) {
	const answered =
		!! pickedLabel &&
		pickedLabel !== STOPPED_WITHOUT_ANSWER &&
		pickedLabel !== SKIPPED_QUESTION &&
		! isInteractive;
	const inactive = ! isInteractive && ! answered;
	const exactAnswer = options.find( ( option ) => option.label === pickedLabel );
	const selectedOptions = exactAnswer
		? [ exactAnswer ]
		: multiSelect
		? options.filter( ( option ) => pickedLabel?.split( ', ' ).includes( option.label ) )
		: [];
	const answerOptions =
		selectedOptions.map( ( option ) => option.label ).join( ', ' ) === pickedLabel
			? selectedOptions
			: [];
	const ownFreeFormLabel =
		claudeSessionId && ! onTypedAnswer ? undefined : findOwnFreeFormOptionLabel( options );
	const viewable = options.filter( ( option ) => option.image );
	const hasImages = viewable.length > 0;
	const [ viewing, setViewing ] = useState< number | null >( null );
	const [ typing, setTyping ] = useState( false );
	const [ draft, setDraft ] = useState( '' );
	const canViewHistory = !! claudeSessionId && hasImages && ! isInteractive;
	const choose = ( label: string ) => {
		if ( label === ownFreeFormLabel ) {
			onSelectionChange?.( [] );
			if ( onTypedAnswer ) setTyping( true );
			else onChooseFreeForm();
		} else {
			setTyping( false );
			onSelectionChange?.(
				multiSelect
					? options
							.map( ( option ) => option.label )
							.filter( ( other ) => ( other === label ) !== selectedLabels.includes( other ) )
					: [ label ]
			);
		}
	};
	const letter = ( index: number ) => String.fromCharCode( 65 + index );

	return (
		<div
			className={ styles.questionCard }
			data-state={ inactive ? 'inactive' : undefined }
			data-viewable-history={ canViewHistory || undefined }
			{ ...joinedAttributes( joined ) }
		>
			<Questionnaire
				ref={ ref }
				tabIndex={ tabIndex }
				multiple={ multiSelect }
				shortcuts={ isInteractive && ! typing }
				disabled={ inactive && ! canViewHistory }
				className={ styles.questionnaire }
			>
				<QuestionnaireTitle>{ question }</QuestionnaireTitle>
				{ answered && ! canViewHistory ? (
					answerOptions.length ? (
						<QuestionnaireChoices>
							{ answerOptions.map( ( option ) => (
								<QuestionnaireAnswer
									key={ option.label }
									letter={ getAnswerLetter( options, option.label ) }
								>
									{ option.label }
								</QuestionnaireAnswer>
							) ) }
						</QuestionnaireChoices>
					) : (
						<QuestionnaireAnswer>{ pickedLabel }</QuestionnaireAnswer>
					)
				) : (
					<>
						{ multiSelect && isInteractive ? (
							<QuestionnaireDescription>
								{ __( 'Select all that apply.' ) }
							</QuestionnaireDescription>
						) : null }
						<QuestionnaireChoices layout={ hasImages ? 'grid' : 'list' }>
							{ options.map( ( option, index ) => {
								const isOwnFreeForm = option.label === ownFreeFormLabel;
								return (
									<QuestionnaireChoice
										key={ index }
										label={ option.label }
										description={ claudeSessionId ? option.description : undefined }
										shortcut={ letter( index ) }
										checked={
											canViewHistory
												? answerOptions.includes( option )
												: isOwnFreeForm
												? ( freeFormActive || typing ) && selectedLabels.length === 0
												: selectedLabels.includes( option.label )
										}
										disabled={ ! isInteractive }
										muted={ isOwnFreeForm }
										wide={ hasImages && ! option.image }
										media={
											option.image ? (
												<QuestionOptionImage
													path={ option.image }
													claudeSessionId={ claudeSessionId }
												/>
											) : null
										}
										action={
											option.image ? (
												<IconButton
													className={ styles.questionOptionZoom }
													size="icon-2xs"
													icon={ <SearchIcon /> }
													label={ sprintf(
														// translators: %s: name of a design option.
														__( 'View %s larger' ),
														option.label
													) }
													onClick={ () => setViewing( viewable.indexOf( option ) ) }
												/>
											) : null
										}
										onSelect={ () => choose( option.label ) }
									/>
								);
							} ) }
						</QuestionnaireChoices>
						{ hasImages ? (
							<QuestionOptionViewer
								options={ viewable }
								claudeSessionId={ claudeSessionId }
								index={ viewing }
								onIndexChange={ setViewing }
								onChoose={ isInteractive && ! multiSelect ? choose : undefined }
							/>
						) : null }
					</>
				) }
				{ canViewHistory && answered && ! answerOptions.length && (
					<QuestionnaireAnswer>{ pickedLabel }</QuestionnaireAnswer>
				) }
				{ claudeSessionId && pickedLabel === SKIPPED_QUESTION && (
					<QuestionnaireDescription>{ __( 'Skipped' ) }</QuestionnaireDescription>
				) }
				{ isInteractive && onTypedAnswer && typing && (
					<Textarea
						aria-label={ __( 'Your answer' ) }
						value={ draft }
						onChange={ ( event ) => setDraft( event.target.value ) }
						ref={ focusAnswerInput }
					/>
				) }
				{ isInteractive ? (
					<div className={ styles.questionFooter }>
						{ pager }
						{ onTypedAnswer && ! typing && ! ownFreeFormLabel && (
							<Button variant="ghost" onClick={ () => setTyping( true ) }>
								{ __( 'Write an answer' ) }
							</Button>
						) }
						<div className={ styles.questionActions }>
							{ onBack ? (
								<Button variant="outline" onClick={ onBack }>
									{ __( 'Back' ) }
								</Button>
							) : null }
							<Button variant="outline" onClick={ onSkip }>
								{ __( 'Skip' ) }
							</Button>
							<Button
								variant="accent"
								disabled={ typing && ! draft.trim() }
								onClick={ typing ? () => onTypedAnswer?.( draft.trim() ) : onAnswer }
							>
								{ submitLabel }
							</Button>
						</div>
					</div>
				) : null }
			</Questionnaire>
		</div>
	);
}

function QuestionOptionImage( {
	path,
	claudeSessionId,
}: {
	path: string;
	claudeSessionId?: string;
} ) {
	const localFileQuery = useLocalMediaDataUrl( path, claudeSessionId );

	if ( localFileQuery.isError ) {
		return (
			<span className={ styles.questionOptionImageUnavailable } aria-hidden="true">
				{ __( 'Preview unavailable' ) }
			</span>
		);
	}
	if ( ! localFileQuery.data ) {
		return <span className={ styles.questionOptionImageLoading } aria-hidden="true" />;
	}
	return (
		<span className={ styles.questionOptionImage }>
			<img src={ localFileQuery.data } alt="" />
		</span>
	);
}
