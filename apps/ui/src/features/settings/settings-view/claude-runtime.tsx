import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { __, sprintf } from '@wordpress/i18n';
import { useId, useState } from 'react';
import { useConnector } from '@/data/core';
import { describeClaudeIssue } from '@/data/queries/claude-runtime';
import { Button, Field, FieldLabel, Input } from '@/lib/ui';
import { ImageServiceSettingsRow } from './image-service-row';
import { SettingsGroup, SettingsRow } from './rows';
import styles from './style.module.css';
import type { ClaudeRuntimeAction } from '@studio/agent/protocol/claude-code';

function describeAuth( method?: string ) {
	switch ( method ) {
		case 'claude.ai':
			return __( 'Claude Code reports Claude.ai authentication.' );
		case 'none':
			return __( 'Signed out of Claude Code.' );
		case 'apiKey':
			return __( 'Claude Code reports API key authentication.' );
		default:
			return __( 'Subscription sign-in could not be confirmed.' );
	}
}

const configurationFiles: Record< string, string > = {
	'user-settings.json-present': 'settings.json',
	'user-settings.local.json-present': 'settings.local.json',
	'user-CLAUDE.md-present': 'CLAUDE.md',
	'user-rules-present': 'rules',
	'user-plugins-present': 'plugins',
	'user-projects-present': 'projects',
	'config-local-state-present': '.claude.json',
	'global-config-present': '~/.claude.json',
	'project-settings-present': '.claude/settings.json',
	'project-local-settings-present': '.claude/settings.local.json',
	'project-mcp-present': '.mcp.json',
	'project-instructions-present': 'CLAUDE.md',
	'project-rules-present': '.claude/rules',
};

export function ClaudeRuntimeSettings() {
	const connector = useConnector();
	const client = useQueryClient();
	const id = useId();
	const state = useQuery( {
		queryKey: [ 'claude-runtime' ],
		queryFn: () => connector.getClaudeRuntimeState(),
	} );
	const recheck = ( connectionId?: string ) =>
		Promise.all( [
			client.invalidateQueries( { queryKey: [ 'claude-runtime' ] } ),
			client.invalidateQueries( {
				queryKey: connectionId ? [ 'claude-models', connectionId ] : [ 'claude-models' ],
			} ),
		] );
	const action = useMutation( {
		mutationFn: ( value: ClaudeRuntimeAction ) => connector.configureClaudeRuntime( value ),
		onSuccess: async ( _, input ) => {
			await recheck( input.type === 'save' ? undefined : input.connectionId );
		},
	} );
	const [ executablePath, setExecutablePath ] = useState( '' );
	const [ configDirectory, setConfigDirectory ] = useState( '' );
	if ( state.isPending || state.data?.enabled === false ) return null;
	return (
		<SettingsGroup
			title={ __( 'Claude Code Runtime' ) }
			description={ __(
				'Choose the Claude Code installation for your chats. Claude Code manages sign-in. Studio checks available models in each workspace and cannot independently verify account or billing details.'
			) }
		>
			<Button
				variant="outline"
				disabled={ state.isFetching || action.isPending }
				onClick={ () => {
					action.reset();
					void recheck();
				} }
			>
				{ state.isFetching ? __( 'Checking runtime…' ) : __( 'Recheck status' ) }
			</Button>
			{ state.isError && (
				<p role="alert">
					{ __( 'Studio could not read the Claude Code connections. Recheck to try again.' ) }
				</p>
			) }
			{ state.data?.connections.map( ( connection ) => {
				const files = [
					...new Set(
						connection.findings.map( ( item ) => configurationFiles[ item ] ).filter( Boolean )
					),
				];
				const selectedAction =
					action.variables?.type !== 'save' && action.variables?.connectionId === connection.id;
				return (
					<SettingsRow
						key={ connection.id }
						title={ connection.executablePath }
						stacked
						error={
							selectedAction && action.error
								? describeClaudeIssue( action.error.message )
								: undefined
						}
						description={
							<>
								{ connection.version ? (
									<span>
										{ sprintf(
											/* translators: %s is the installed Claude Code version. */ __(
												'Detected Claude Code version %s.'
											),
											connection.version
										) }
										<br />
									</span>
								) : null }
								{ !! connection.supportedVersions?.length && (
									<span>
										{ sprintf(
											/* translators: %s lists Claude Code versions supported on this computer. */ __(
												'Supported on this computer: %s.'
											),
											connection.supportedVersions.join( ', ' )
										) }
										<br />
									</span>
								) }
								<span>
									{ describeAuth( connection.authMethod ) }
									<br />
								</span>
								{ connection.configDirectory && (
									<span>
										{ connection.configDirectory }
										<br />
									</span>
								) }
								{ files.length > 0 && (
									<span>
										{ sprintf(
											/* translators: %s lists Claude configuration file or directory names. */ __(
												'Detected configuration: %s.'
											),
											files.join( ', ' )
										) }
										<br />
									</span>
								) }
								{ [ ...new Set( connection.blockers.map( describeClaudeIssue ) ) ].map(
									( item ) => (
										<span key={ item }>
											{ item }
											<br />
										</span>
									)
								) }
								{ selectedAction && action.variables?.type === 'sign-in' && action.isSuccess && (
									<span role="status">
										{ __(
											'Complete or cancel sign-in in the Claude Code terminal, then recheck status here.'
										) }
									</span>
								) }
							</>
						}
					>
						<div className={ styles.keyForm }>
							<Button
								variant="outline"
								disabled={ action.isPending }
								onClick={ () => action.mutate( { type: 'sign-in', connectionId: connection.id } ) }
							>
								{ __( 'Sign in with Claude Code' ) }
							</Button>
							<Button
								variant="outline"
								disabled={ action.isPending }
								onClick={ () =>
									action.mutate( { type: 'disconnect', connectionId: connection.id } )
								}
							>
								{ __( 'Disconnect Claude runtime' ) }
							</Button>
						</div>
					</SettingsRow>
				);
			} ) }
			{ state.data?.enabled && (
				<>
					<form
						onSubmit={ ( event ) => {
							event.preventDefault();
							action.mutate( {
								type: 'save',
								executablePath: executablePath.trim(),
								...( configDirectory.trim() ? { configDirectory: configDirectory.trim() } : {} ),
							} );
						} }
					>
						<SettingsRow
							title={ __( 'Add Claude Code runtime' ) }
							description={ __(
								'Sign-in opens the native Claude Code flow. Disconnecting does not sign you out of Claude Code.'
							) }
							error={
								action.variables?.type === 'save' && action.error
									? describeClaudeIssue( action.error.message )
									: undefined
							}
							stacked
						>
							<div className={ styles.claudeRuntimeForm }>
								<Field>
									<FieldLabel htmlFor={ `${ id }-executable` }>
										{ __( 'Claude executable path' ) }
									</FieldLabel>
									<Input
										id={ `${ id }-executable` }
										value={ executablePath }
										onChange={ ( event ) => setExecutablePath( event.target.value ) }
									/>
								</Field>
								<Field>
									<FieldLabel htmlFor={ `${ id }-config` }>
										{ __( 'Claude configuration directory (optional)' ) }
									</FieldLabel>
									<Input
										id={ `${ id }-config` }
										value={ configDirectory }
										onChange={ ( event ) => setConfigDirectory( event.target.value ) }
									/>
								</Field>
								<Button type="submit" disabled={ action.isPending || ! executablePath.trim() }>
									{ __( 'Add runtime' ) }
								</Button>
							</div>
						</SettingsRow>
					</form>
					<ImageServiceSettingsRow plan="claude" />
				</>
			) }
		</SettingsGroup>
	);
}
