import {
	configureClaudeRuntime,
	createClaudeSession,
	getClaudeModelCatalog,
	getClaudeRuntimeState,
	setClaudeSessionSelection,
} from '@studio/agent/node/claude-code/studio-surface';
import { parseClaudeSessionSelection } from '@studio/agent/protocol/claude-code';
import { getSessionsDirectory } from '@studio/common/lib/well-known-paths';
import { __ } from '@wordpress/i18n';
import type { StudioArgv } from 'cli/types';

export const registerCommand = ( yargs: StudioArgv ) =>
	yargs.command( {
		command: 'claude <action>',
		describe: __( 'Manage the experimental Claude Code connection' ),
		builder: ( command ) =>
			command
				.positional( 'action', {
					choices: [
						'list',
						'status',
						'configure',
						'sign-in',
						'disconnect',
						'models',
						'new',
						'select',
					] as const,
					demandOption: true,
				} )
				.option( 'executable', { type: 'string' } )
				.option( 'config-directory', { type: 'string' } )
				.option( 'connection', { type: 'string' } )
				.option( 'site', { type: 'string' } )
				.option( 'session', { type: 'string' } )
				.option( 'model', { type: 'string' } )
				.option( 'effort', { type: 'string' } ),
		handler: async ( argv ) => {
			const requireValue = ( value: unknown, name: string ): string => {
				if ( typeof value !== 'string' || ! value.trim() )
					throw new Error( `--${ name } is required.` );
				return value;
			};
			let result: unknown;
			switch ( argv.action ) {
				case 'list':
				case 'status':
					result = await getClaudeRuntimeState();
					break;
				case 'configure':
					await configureClaudeRuntime( {
						type: 'save',
						executablePath: requireValue( argv.executable, 'executable' ),
						configDirectory: argv.configDirectory as string | undefined,
					} );
					result = { ok: true };
					break;
				case 'sign-in':
				case 'disconnect':
					await configureClaudeRuntime( {
						type: argv.action,
						connectionId: requireValue( argv.connection, 'connection' ),
					} );
					result = { ok: true };
					break;
				case 'models':
					result = await getClaudeModelCatalog(
						requireValue( argv.connection, 'connection' ),
						requireValue( argv.site, 'site' )
					);
					break;
				case 'new':
					result = await createClaudeSession( getSessionsDirectory(), {
						connectionId: requireValue( argv.connection, 'connection' ),
						siteId: requireValue( argv.site, 'site' ),
						selection: parseClaudeSessionSelection( { model: argv.model, effort: argv.effort } ),
					} );
					break;
				case 'select':
					await setClaudeSessionSelection(
						getSessionsDirectory(),
						requireValue( argv.session, 'session' ),
						parseClaudeSessionSelection( { model: argv.model, effort: argv.effort } )
					);
					result = { ok: true };
					break;
			}
			process.stdout.write( JSON.stringify( result, null, 2 ) + '\n' );
		},
	} );
