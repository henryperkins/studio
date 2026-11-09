import { isStudioCustomEntryOfType } from './sessions/entry-types';
import type { ClaudeBackendSessionBinding } from './backend-sessions';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

export const CLAUDE_EFFORTS = [ 'low', 'medium', 'high', 'xhigh', 'max' ] as const;
export type ClaudeEffort = ( typeof CLAUDE_EFFORTS )[ number ];

export interface ClaudeSessionSelection {
	model: string;
	effort: ClaudeEffort;
}

export type ClaudeWorkspaceBinding = Omit< ClaudeBackendSessionBinding, 'conversationId' >;

export interface ClaudeRuntimeState {
	enabled: boolean;
	connections: Array< {
		id: string;
		executablePath: string;
		configDirectory?: string;
		version?: string;
		authMethod?: string;
		blockers: string[];
		findings: string[];
	} >;
}

export type ClaudeRuntimeAction =
	| { type: 'save'; executablePath: string; configDirectory?: string }
	| { type: 'sign-in' | 'disconnect'; connectionId: string };

export interface ClaudeModelOption {
	id: string;
	displayName: string;
	efforts: ClaudeEffort[];
}

export type ClaudeModelCatalog =
	| { ok: true; models: ClaudeModelOption[] }
	| { ok: false; blockers: string[] };

export interface CreateClaudeSessionRequest {
	siteId: string;
	connectionId: string;
	selection: ClaudeSessionSelection;
}

export function isClaudeEffort( value: unknown ): value is ClaudeEffort {
	return CLAUDE_EFFORTS.some( ( effort ) => effort === value );
}

export function isClaudeModelId( value: unknown ): value is string {
	return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test( value );
}

export function escapeClaudeApprovalText( value: string ): string {
	return value.replace(
		/(?![\n\t])[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
		( character ) => '\\u' + character.charCodeAt( 0 ).toString( 16 ).padStart( 4, '0' )
	);
}

export function parseClaudeSessionSelection( value: unknown ): ClaudeSessionSelection {
	const { model, effort } = ( value ?? {} ) as Partial< ClaudeSessionSelection >;
	if ( ! isClaudeModelId( model ) || ! isClaudeEffort( effort ) ) {
		throw new Error( 'Invalid Claude Code model or effort.' );
	}
	return { model, effort };
}

export function resolveClaudeSession( entries: readonly SessionEntry[] ) {
	const bindings = entries.filter( ( entry ) =>
		isStudioCustomEntryOfType( entry, 'studio.claude_binding' )
	);
	const entry = [ ...entries ]
		.reverse()
		.find( ( item ) => isStudioCustomEntryOfType( item, 'studio.claude_selection' ) );
	if ( ! bindings.length && ! entry ) return undefined;
	const binding = bindings[ 0 ]?.data;
	if (
		bindings.length !== 1 ||
		! binding ||
		! [
			binding.connectionId,
			binding.siteId,
			binding.workingDirectory,
			binding.configDirectory,
		].every( ( item ) => typeof item === 'string' && item.length > 0 )
	) {
		throw new Error( 'Invalid Claude Code workspace binding.' );
	}
	return { binding, selection: parseClaudeSessionSelection( entry?.data ) };
}
