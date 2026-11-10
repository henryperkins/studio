import { __ } from '@wordpress/i18n';
import { useId, useRef, useState } from 'react';
import {
	Button,
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Field,
	FieldLabel,
	Textarea,
} from '@/lib/ui';
import styles from './style.module.css';

export function ConnectionSwitchDialog( {
	target,
	inFlight,
	error,
	onCancel,
	onConfirm,
}: {
	target: string;
	inFlight: boolean;
	error?: string;
	onCancel: () => void;
	onConfirm: ( summary: string ) => void;
} ) {
	const [ summary, setSummary ] = useState( '' );
	const cancelRef = useRef< HTMLButtonElement >( null );
	const id = useId();
	return (
		<Dialog open onOpenChange={ ( open ) => ! open && ! inFlight && onCancel() }>
			<DialogContent layout="compact" initialFocus={ cancelRef } closeButtonDisabled={ inFlight }>
				<DialogHeader>
					<DialogTitle>{ __( 'Start a new chat?' ) }</DialogTitle>
					<DialogDescription className={ styles.dialogDescription }>
						{ __(
							'Changing the account or billing connection starts a new chat. The previous history, draft and attachments stay in the original chat. Only a summary you enter below carries over.'
						) }
					</DialogDescription>
				</DialogHeader>
				<p className={ styles.connectionTarget }>{ target }</p>
				<Field>
					<FieldLabel htmlFor={ id }>{ __( 'Context summary (optional)' ) }</FieldLabel>
					<Textarea
						id={ id }
						value={ summary }
						disabled={ inFlight }
						onChange={ ( event ) => setSummary( event.target.value ) }
						rows={ 3 }
					/>
				</Field>
				{ error ? (
					<p role="alert" className={ styles.connectionError }>
						{ error }
					</p>
				) : null }
				<DialogFooter>
					<DialogClose
						ref={ cancelRef }
						disabled={ inFlight }
						render={ <Button variant="outline" /> }
					>
						{ __( 'Cancel' ) }
					</DialogClose>
					<Button
						variant="accent"
						disabled={ inFlight }
						loading={ inFlight }
						loadingAnnouncement={ __( 'Starting new chat' ) }
						onClick={ () => onConfirm( summary ) }
					>
						{ __( 'Start new chat' ) }
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
