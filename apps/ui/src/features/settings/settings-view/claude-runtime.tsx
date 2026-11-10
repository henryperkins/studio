import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { __ } from '@wordpress/i18n';
import { useId, useState } from 'react';
import { useConnector } from '@/data/core';
import { Button, Field, FieldLabel, Input } from '@/lib/ui';
import { SettingsGroup, SettingsRow } from './rows';
import styles from './style.module.css';
import type { ClaudeRuntimeAction } from '@studio/agent/protocol/claude-code';

export function ClaudeRuntimeSettings() {
	const connector = useConnector();
	const client = useQueryClient();
	const id = useId();
	const state = useQuery( {
		queryKey: [ 'claude-runtime' ],
		queryFn: () => connector.getClaudeRuntimeState(),
	} );
	const action = useMutation( {
		mutationFn: ( value: ClaudeRuntimeAction ) => connector.configureClaudeRuntime( value ),
		onSuccess: () => client.invalidateQueries( { queryKey: [ 'claude-runtime' ] } ),
	} );
	const [ executablePath, setExecutablePath ] = useState( '' );
	const [ configDirectory, setConfigDirectory ] = useState( '' );
	if ( ! state.data?.enabled ) return null;
	return (
		<SettingsGroup
			title={ __( 'Claude Code Runtime' ) }
			description={ __(
				'Connect a local Claude Code executable for explicit local-site chats. This is separate from the Claude Code MCP plugin. Account information is not verified, and Studio cannot guarantee the billing route.'
			) }
		>
			<Button
				variant="outline"
				disabled={ state.isFetching }
				onClick={ () => void state.refetch() }
			>
				{ state.isFetching ? __( 'Checking runtime…' ) : __( 'Recheck status' ) }
			</Button>
			{ state.data.connections.map( ( connection ) => (
				<SettingsRow
					key={ connection.id }
					title={ connection.executablePath }
					stacked
					description={
						<>
							{ connection.version ? (
								<span>
									{ connection.version }
									<br />
								</span>
							) : null }
							<span>
								{ connection.authMethod ?? __( 'Authentication method unknown' ) }
								<br />
							</span>
							{ connection.configDirectory && (
								<span>
									{ connection.configDirectory }
									<br />
								</span>
							) }
							{ [ ...connection.blockers, ...connection.findings ].map( ( item ) => (
								<span key={ item }>
									{ item }
									<br />
								</span>
							) ) }
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
							onClick={ () => action.mutate( { type: 'disconnect', connectionId: connection.id } ) }
						>
							{ __( 'Disconnect Claude runtime' ) }
						</Button>
					</div>
				</SettingsRow>
			) ) }
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
					error={ action.error?.message }
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
		</SettingsGroup>
	);
}
