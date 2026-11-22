import { loadHydratedAiSession } from '@studio/agent/node/sessions/manage';
import {
	CLAUDE_EFFORTS,
	CLAUDE_RECOVERY_BLOCKED_REASONS,
	type ClaudeRecoveryResult,
	parseClaudeSessionSelection,
	type ClaudeModelCatalog,
	type ClaudeSessionSelection,
	type CreateClaudeSessionRequest,
} from '@studio/agent/protocol/claude-code';
import { CliCommandError, runCliCommand } from '@studio/common/lib/cli-process';
import { getSessionsDirectory } from '@studio/common/lib/well-known-paths';
import { z } from 'zod';
import { executeCliCommand } from 'src/modules/cli/lib/execute-command';

const catalogSchema = z.discriminatedUnion( 'ok', [
	z.object( { ok: z.literal( false ), blockers: z.array( z.string() ) } ),
	z.object( {
		ok: z.literal( true ),
		models: z.array(
			z.object( {
				id: z.string(),
				displayName: z.string(),
				efforts: z.array( z.enum( CLAUDE_EFFORTS ) ),
				imageInput: z.boolean().optional(),
				toolResultImages: z.boolean().optional(),
			} )
		),
	} ),
] );

function workspaceArgs( connectionId: string, siteId?: string | null ): string[] {
	if ( typeof connectionId !== 'string' || ( siteId != null && typeof siteId !== 'string' ) ) {
		throw new Error( 'Select a Claude Code connection.' );
	}
	return [ '--connection=' + connectionId, ...( siteId == null ? [] : [ '--site=' + siteId ] ) ];
}

function selectionArgs( input: ClaudeSessionSelection ) {
	const { model, effort } = parseClaudeSessionSelection( input );
	return [ '--model=' + model, '--effort=' + effort ];
}

export function getClaudeModelCatalogViaCli(
	connectionId: string,
	siteId?: string | null
): Promise< ClaudeModelCatalog > {
	return runCliCommand(
		executeCliCommand,
		[ 'code', 'claude', 'models', ...workspaceArgs( connectionId, siteId ) ],
		catalogSchema
	);
}

export async function createClaudeSessionViaCli( request: CreateClaudeSessionRequest ) {
	const { id } = await runCliCommand(
		executeCliCommand,
		[
			'code',
			'claude',
			'new',
			...workspaceArgs( request?.connectionId, request?.siteId ),
			...selectionArgs( request.selection ),
		],
		z.object( { id: z.string() } )
	);
	return ( await loadHydratedAiSession( getSessionsDirectory(), id ) ).summary;
}

export async function setClaudeSelectionViaCli(
	sessionId: string,
	selection: ClaudeSessionSelection
) {
	await runCliCommand(
		executeCliCommand,
		[ 'code', 'claude', 'select', '--session=' + sessionId, ...selectionArgs( selection ) ],
		z.object( { ok: z.literal( true ) } )
	);
}

const blockedRecovery = z.object( {
	status: z.literal( 'blocked' ),
	reason: z.enum( CLAUDE_RECOVERY_BLOCKED_REASONS ),
	runId: z.string().optional(),
	turnId: z.string().optional(),
} );

const completedRecovery = z.object( {
	status: z.literal( 'recovered' ),
	runId: z.string(),
	turnId: z.string(),
	recordedTerminal: z.boolean(),
	invalidatedApprovals: z.array( z.string() ),
	uncertainOperations: z.array(
		z.object( {
			toolCallId: z.string(),
			tool: z.string(),
			description: z.string().optional(),
			requestId: z.string().optional(),
			resolved: z.boolean().optional(),
			evidence: z.enum( [ 'authorized', 'requested', 'started' ] ),
			operationClass: z
				.enum( [
					'read',
					'remote-read',
					'local-change',
					'local-overwrite',
					'remote-change',
					'remote-overwrite',
					'external-message',
					'command',
				] )
				.optional(),
			target: z
				.discriminatedUnion( 'environment', [
					z.object( { environment: z.literal( 'global' ) } ),
					z.object( { environment: z.literal( 'local' ), siteId: z.string() } ),
					z.object( {
						environment: z.literal( 'live' ),
						siteId: z.string(),
						wpcomSiteId: z.number(),
					} ),
				] )
				.optional(),
		} )
	),
} );

export async function recoverClaudeSessionViaCli(
	sessionId: string
): Promise< ClaudeRecoveryResult > {
	try {
		return await runCliCommand(
			executeCliCommand,
			[ 'code', 'claude', 'recover', '--session=' + sessionId ],
			completedRecovery
		);
	} catch ( error ) {
		// The terminal command exits 1 for a blocked recovery and prints its typed result.
		if ( error instanceof CliCommandError && error.exitCode === 1 && error.cliCommandResult ) {
			try {
				const result = blockedRecovery.safeParse( JSON.parse( error.cliCommandResult.stdout ) );
				if ( result.success ) return result.data;
			} catch {
				// A CLI failure may have printed diagnostics instead of a recovery result.
			}
		}
		throw error;
	}
}
