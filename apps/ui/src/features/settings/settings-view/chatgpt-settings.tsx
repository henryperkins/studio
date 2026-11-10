import { useQueryClient } from '@tanstack/react-query';
import { __, sprintf } from '@wordpress/i18n';
import { useEffect, useRef, useState } from 'react';
import { useConnector } from '@/data/core';
import {
	holdChatGptConnection,
	refreshChatGptSettings,
	useChatGptModels,
	useChatGptSettings,
} from '@/data/queries/use-chatgpt-settings';
import { useOffline } from '@/lib/hooks';
import { Badge, Button } from '@/lib/ui';
import { connectedBadge, SettingsGroup, SettingsRow, SettingsSelect } from './rows';
import styles from './style.module.css';
import type { ChatGptCredentialStorage } from '@studio/agent/protocol/chatgpt';

interface SignInAttempt {
	id?: string;
	cancelled: boolean;
}

export function ChatGptSettingsGroup() {
	const connector = useConnector();
	const queryClient = useQueryClient();
	const settings = useChatGptSettings();
	const offline = useOffline();
	const [ selectedId, setSelectedId ] = useState< string >();
	const [ storage, setStorage ] = useState< ChatGptCredentialStorage >( 'vault' );
	const [ pending, setPending ] = useState( false );
	const [ signingOut, setSigningOut ] = useState( false );
	const [ message, setMessage ] = useState( '' );
	const [ error, setError ] = useState( '' );
	const [ reconsent, setReconsent ] = useState( false );
	const attempt = useRef< SignInAttempt | null >( null );
	const mounted = useRef( true );
	const accounts = settings.data?.accounts ?? [];
	const account = selectedId
		? accounts.find( ( item ) => item.connectionId === selectedId )
		: accounts[ 0 ];
	const models = useChatGptModels( account, false );

	useEffect( () => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			const active = attempt.current;
			if ( active ) {
				active.cancelled = true;
				if ( active.id ) {
					void connector.cancelChatGptSignIn( active.id ).catch( () => {} );
				}
			}
		};
	}, [ connector ] );

	const signIn = async ( registrationId?: string ) => {
		const active: SignInAttempt = { cancelled: false };
		attempt.current = active;
		setPending( true );
		setMessage( '' );
		setError( '' );
		try {
			const started = await connector.beginChatGptSignIn( registrationId, {
				storage,
				...( reconsent ? { reconsent: true } : {} ),
			} );
			active.id = started.attemptId;
			if ( active.cancelled ) {
				await connector.cancelChatGptSignIn( active.id );
				return;
			}
			const outcome = await connector.waitForChatGptSignIn( active.id );
			if ( ! mounted.current || attempt.current !== active ) {
				return;
			}
			if ( outcome.ok ) {
				setSelectedId( outcome.registrationId );
				setMessage( __( 'ChatGPT account connected.' ) );
				setReconsent( false );
			} else {
				setMessage( outcome.message );
				setReconsent( outcome.code === 'permission-missing' );
			}
		} catch ( failure ) {
			if ( mounted.current ) {
				setError(
					failure instanceof Error ? failure.message : __( 'ChatGPT sign-in failed. Try again.' )
				);
			}
		} finally {
			await refreshChatGptSettings( queryClient );
			if ( mounted.current && attempt.current === active ) {
				attempt.current = null;
				setPending( false );
			}
		}
	};

	const cancel = async () => {
		const active = attempt.current;
		if ( ! active ) return;
		active.cancelled = true;
		try {
			if ( active.id ) await connector.cancelChatGptSignIn( active.id );
			setMessage( __( 'Signing in was cancelled.' ) );
		} catch ( failure ) {
			setError(
				failure instanceof Error ? failure.message : __( 'Couldn’t cancel sign-in. Try again.' )
			);
		}
	};

	const signOut = async () => {
		if ( ! account ) return;
		setSigningOut( true );
		setError( '' );
		setMessage( '' );
		try {
			await holdChatGptConnection( queryClient, account.connectionId );
			const result = await connector.signOutChatGpt( account.connectionId );
			if ( mounted.current ) {
				setMessage(
					! result.localCleared
						? __( 'Studio couldn’t clear this sign-in. Try signing out again.' )
						: result.remoteRevocationConfirmed
						? __( 'Signed out locally. Remote revocation confirmed.' )
						: __(
								'Signed out locally. Remote revocation wasn’t confirmed; you can remove Studio in your ChatGPT account settings.'
						  )
				);
			}
		} catch ( failure ) {
			if ( mounted.current )
				setError(
					failure instanceof Error ? failure.message : __( 'Couldn’t sign out. Try again.' )
				);
		} finally {
			await refreshChatGptSettings( queryClient );
			if ( mounted.current ) setSigningOut( false );
		}
	};

	if ( ! settings.data?.enabled ) {
		return settings.isError ? (
			<SettingsGroup title={ __( 'ChatGPT plan' ) }>
				<SettingsRow title={ __( 'Couldn’t load ChatGPT accounts.' ) }>
					<Button variant="outline" onClick={ () => void settings.refetch() }>
						{ __( 'Retry' ) }
					</Button>
				</SettingsRow>
			</SettingsGroup>
		) : null;
	}
	const busy = pending || signingOut;
	const canSignIn =
		! busy &&
		! offline &&
		settings.data.signInSupported &&
		( storage === 'session' || settings.data.secureStorage === 'available' );
	const connected = account?.authStatus === 'connected';
	const availability = models.data?.models;

	return (
		<SettingsGroup
			title={ __( 'ChatGPT plan' ) }
			description={ __(
				'Use your ChatGPT plan in Studio. Choose the account and model in each chat; usage counts toward that account’s plan limits.'
			) }
		>
			{ accounts.length > 0 ? (
				<SettingsRow
					title={ __( 'Saved ChatGPT account' ) }
					description={
						account
							? `${ account.email ?? account.label } · ${ account.connectionId.slice( 0, 8 ) }`
							: __( 'Choose a saved account.' )
					}
					badge={
						connected ? (
							connectedBadge()
						) : (
							<Badge size="xs" variant="muted">
								{ account?.state === 'signed-out' ? __( 'Signed out' ) : __( 'Needs sign-in' ) }
							</Badge>
						)
					}
				>
					<SettingsSelect
						label={ __( 'Saved ChatGPT account' ) }
						value={ account?.connectionId ?? '' }
						disabled={ busy }
						options={ accounts.map( ( item ) => ( {
							value: item.connectionId,
							label: `${ item.label } · ${ item.connectionId.slice( 0, 8 ) }`,
						} ) ) }
						onChange={ ( id ) => {
							setSelectedId( id );
							setMessage( '' );
							setError( '' );
						} }
					/>
				</SettingsRow>
			) : null }
			<SettingsRow
				title={ __( 'Keep ChatGPT sign-in' ) }
				description={
					settings.data.secureStorage === 'unavailable'
						? __(
								'Secure storage is unavailable. Choose “This app session” to keep the sign-in only until this Studio app closes.'
						  )
						: account?.storage === 'session'
						? __(
								'This account is signed in only for this app session. Choose where to keep your next sign-in.'
						  )
						: __(
								'Secure storage keeps your sign-in across restarts. This app session keeps it only until this Studio app closes.'
						  )
				}
			>
				<SettingsSelect< ChatGptCredentialStorage >
					label={ __( 'Keep ChatGPT sign-in' ) }
					value={ storage }
					disabled={ busy }
					onChange={ setStorage }
					options={ [
						{
							value: 'vault',
							label: __( 'Secure storage' ),
							disabled: settings.data.secureStorage === 'unavailable',
						},
						{ value: 'session', label: __( 'This app session' ) },
					] }
				/>
			</SettingsRow>
			<SettingsRow
				title={ __( 'ChatGPT sign-in' ) }
				stacked
				error={ error || undefined }
				description={
					! settings.data.signInSupported ? (
						__( 'Open Studio on localhost to sign in to ChatGPT on this computer.' )
					) : pending ? (
						<span role="status" aria-label={ __( 'ChatGPT sign-in status' ) }>
							{ __( 'Complete sign-in in your browser. You can cancel here.' ) }
						</span>
					) : message ? (
						<span role="status" aria-label={ __( 'ChatGPT sign-in status' ) }>
							{ message }
						</span>
					) : (
						__(
							'Sign-in opens in your system browser. Grant permission to use models with your ChatGPT plan.'
						)
					)
				}
			>
				<div className={ styles.keyForm }>
					{ pending ? (
						<Button variant="outline" onClick={ () => void cancel() }>
							{ __( 'Cancel sign-in' ) }
						</Button>
					) : (
						<>
							<Button variant="accent" disabled={ ! canSignIn } onClick={ () => void signIn() }>
								{ accounts.length ? __( 'Add account' ) : __( 'Start sign-in' ) }
							</Button>
							{ account ? (
								<>
									<Button
										variant="outline"
										disabled={ ! canSignIn }
										onClick={ () => void signIn( account.connectionId ) }
									>
										{ __( 'Sign in again' ) }
									</Button>
									<Button
										variant="outline"
										disabled={ busy }
										loading={ signingOut }
										loadingAnnouncement={ __( 'Signing out' ) }
										onClick={ () => void signOut() }
									>
										{ __( 'Sign out' ) }
									</Button>
								</>
							) : null }
						</>
					) }
				</div>
			</SettingsRow>
			{ account ? (
				<SettingsRow
					title={ __( 'Available ChatGPT models' ) }
					error={ models.error?.message }
					description={
						availability
							? availability.length
								? sprintf(
										/* translators: %s: comma-separated model names. */ __(
											'This account lists %s.'
										),
										availability.map( ( model ) => model.label ).join( ', ' )
								  )
								: __( 'This account lists none of the models Studio supports.' )
							: __( 'Check which supported models this account can use.' )
					}
				>
					<Button
						variant="outline"
						disabled={ busy || ! connected || offline || models.isFetching }
						loading={ models.isFetching }
						loadingAnnouncement={ __( 'Checking models' ) }
						onClick={ () => void models.refetch() }
					>
						{ __( 'Refresh models' ) }
					</Button>
				</SettingsRow>
			) : null }
		</SettingsGroup>
	);
}
