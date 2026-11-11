import { isStudioCustomEntryOfType } from './sessions/entry-types';
import type { ClaudeBackendSessionBinding } from './backend-sessions';
import type { StudioSiteSelectedData } from './sessions/entry-types';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

export const CLAUDE_EFFORTS = [ 'low', 'medium', 'high', 'xhigh', 'max' ] as const;
export type ClaudeEffort = ( typeof CLAUDE_EFFORTS )[ number ];

export interface ClaudeSessionSelection {
	model: string;
	effort: ClaudeEffort;
}

export type ClaudeWorkspaceBinding = Omit< ClaudeBackendSessionBinding, 'conversationId' >;

/**
 * The Studio target a Claude turn acts on, selected before Send. It is separate
 * from the conversation's native workspace and history, which never move: a
 * new target takes effect on the next turn.
 */
export type ClaudeStudioTarget =
	| { environment: 'global' }
	| { environment: 'local'; siteId: string }
	| { environment: 'live'; siteId: string; wpcomSiteId: number };

/** What a Claude operation can change; the execution policy decides which need approval. */
export type ClaudeOperationClass =
	| 'read'
	| 'remote-read'
	| 'local-change'
	| 'local-overwrite'
	| 'remote-change'
	| 'remote-overwrite'
	| 'external-message'
	| 'command';

export function isSameClaudeTarget( a: ClaudeStudioTarget, b: ClaudeStudioTarget ): boolean {
	if ( a.environment === 'global' || b.environment === 'global' )
		return a.environment === b.environment;
	if ( a.environment === 'live' )
		return b.environment === 'live' && a.siteId === b.siteId && a.wpcomSiteId === b.wpcomSiteId;
	return b.environment === 'local' && a.siteId === b.siteId;
}

/**
 * Whether a conversation may act on a target. A conversation started on a site
 * works in that site's folder, so it may only act on that site, locally or live.
 * A global conversation works in its own folder and may act on any site.
 */
export function isClaudeTargetAllowed(
	workspaceSiteId: string | null,
	target: ClaudeStudioTarget
): boolean {
	if ( target.environment !== 'global' ) {
		if ( typeof target.siteId !== 'string' || ! target.siteId ) return false;
		if (
			target.environment === 'live' &&
			( ! Number.isSafeInteger( target.wpcomSiteId ) || target.wpcomSiteId <= 0 )
		)
			return false;
	}
	return (
		workspaceSiteId === null ||
		( target.environment !== 'global' && target.siteId === workspaceSiteId )
	);
}

/**
 * The target a conversation's next turn acts on: its latest explicit site
 * selection, or else its own site, or Studio as a whole for a global
 * conversation. Throws when a selection cannot name its target or would move a
 * site conversation to another site.
 */
export function resolveClaudeTarget(
	entries: readonly SessionEntry[],
	binding: Pick< ClaudeWorkspaceBinding, 'siteId' >
): ClaudeStudioTarget {
	let data: StudioSiteSelectedData | undefined;
	let selected = false;
	for ( const item of entries )
		if ( isStudioCustomEntryOfType( item, 'studio.site_selected' ) ) {
			selected = true;
			data = item.data;
		}
	let target: ClaudeStudioTarget;
	if ( ! selected ) {
		target =
			binding.siteId === null
				? { environment: 'global' }
				: { environment: 'local', siteId: binding.siteId };
	} else {
		const siteId = data?.siteId;
		if ( typeof siteId !== 'string' || ! siteId ) throw new Error( 'Invalid Claude Code target.' );
		target =
			data?.remote === true
				? { environment: 'live', siteId, wpcomSiteId: data.wpcomSiteId as number }
				: { environment: 'local', siteId };
	}
	if ( ! isClaudeTargetAllowed( binding.siteId, target ) )
		throw new Error( 'Invalid Claude Code target.' );
	return target;
}

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
	/** Absent for a global conversation, which works in Studio's dedicated global workspace. */
	siteId?: string;
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
		! [ binding.connectionId, binding.workingDirectory, binding.configDirectory ].every(
			( item ) => typeof item === 'string' && item.length > 0
		) ||
		! ( binding.siteId === null || ( typeof binding.siteId === 'string' && binding.siteId ) )
	) {
		throw new Error( 'Invalid Claude Code workspace binding.' );
	}
	return {
		binding,
		selection: parseClaudeSessionSelection( entry?.data ),
		target: resolveClaudeTarget( entries, binding ),
	};
}
