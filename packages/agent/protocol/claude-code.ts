import { __, sprintf } from '@wordpress/i18n';
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

/** Whether an operation of this class only reads. Studio journals every other one before it runs. */
export function isClaudeReadOnlyClass( operationClass: unknown ): boolean {
	return operationClass === 'read' || operationClass === 'remote-read';
}

/**
 * Why Studio did not recover a locked Claude conversation. A blocked recovery
 * leaves the run lock on disk and the native history exactly as they were. It
 * leaves nothing of its own either, except a claim file it could not remove.
 * The journal's entries are unchanged too, with one exception:
 * `recovery-failed` or `lock-changed` returned when releasing the lock failed
 * or found it replaced, after the recovery's record was written. The journal
 * then holds that record once and whole: the dead turn's pending approvals
 * resolved, its interrupted outcome (unless the turn recorded its own) and its
 * `turn.recovered` entry. A later recovery of the same lock adds nothing and
 * only releases it; a lock that replaced it is never touched.
 */
export const CLAUDE_RECOVERY_BLOCKED_REASONS = [
	/** The Claude Code experiment is off. */
	'runtime-disabled',
	/** The chat is not a Claude conversation, or its workspace binding is unreadable. */
	'not-claude-session',
	/** Nothing holds the conversation's lock. */
	'not-locked',
	/** The chat is being deleted. */
	'deletion-pending',
	/** The lock predates owner records, so nothing shows which process holds it. */
	'legacy-lock',
	/** The lock could not be read, or is not a lock record Studio knows. */
	'lock-unreadable',
	/** The lock is held for something other than a turn, such as a deletion. */
	'lock-not-a-run',
	/** The lock names another conversation. */
	'lock-other-conversation',
	/** The lock was written on another operating system. */
	'platform-mismatch',
	/** The process that holds the lock is still running. */
	'owner-alive',
	/** Whether the process that holds the lock is still running could not be read. */
	'owner-unverifiable',
	/** A Claude Code process may have started that Studio never confirmed owning. */
	'native-unowned',
	/** The turn's Claude Code process is still running. */
	'native-alive',
	'native-unverifiable',
	/** Studio's helper that ends the turn's process tree is still running. */
	'guardian-alive',
	'guardian-unverifiable',
	/** A process that may belong to the turn is still running. */
	'descendants-alive',
	/** Whether every process of the turn has ended could not be read. */
	'descendants-unverifiable',
	/** The lock names another connection, workspace or configuration than the chat. */
	'binding-mismatch',
	/** The workspace or the native configuration folder no longer exists as recorded. */
	'workspace-missing',
	/** The native session the lock or the chat records is not the chat's own. */
	'native-session-mismatch',
	/** The turn resumed a native session the chat no longer records. */
	'native-session-missing',
	/** The native history could not be found or verified. */
	'native-history-missing',
	'journal-unreadable',
	/** The lock changed after it was inspected. */
	'lock-changed',
	/** Another recovery of this lock is under way, or its claimant cannot be checked. */
	'recovery-in-progress',
	/** A claim on this lock's recovery is empty or names no process, as an interrupted creation leaves it. */
	'recovery-claim-unreadable',
	/** Recording the recovery failed; the lock was kept. */
	'recovery-failed',
] as const;
export type ClaudeRecoveryBlockedReason = ( typeof CLAUDE_RECOVERY_BLOCKED_REASONS )[ number ];

/**
 * An operation of an interrupted turn that may or may not have run, and has
 * no recorded result. Nothing retries it.
 */
export interface ClaudeUncertainOperation {
	toolCallId: string;
	/** Display-safe: the canonical Studio tool, native tool or host operation. */
	tool: string;
	/** Absent for a tool Studio does not recognize, which is never taken to only read. */
	operationClass?: ClaudeOperationClass;
	/** The turn's target, when the journal recorded it. */
	target?: ClaudeStudioTarget;
	/** Display-safe, as an approval shows it. */
	description: string;
	/**
	 * What the journal shows of it: Studio let it run (`authorized`), asked
	 * for its approval (`requested`), or saw a tool it does not recognize start
	 * (`started`).
	 */
	evidence: 'authorized' | 'requested' | 'started';
	/** The approval it was asked for, if any. */
	requestId?: string;
	/** Whether that approval was recorded as answered. The answer itself never is. */
	resolved?: boolean;
}

/** What recovering a locked Claude conversation did. Serializable, for every Studio app. */
export type ClaudeRecoveryResult =
	| {
			status: 'recovered';
			runId: string;
			turnId: string;
			/** False when the interrupted turn had already recorded its own outcome. */
			recordedTerminal: boolean;
			/** Approval requests of the interrupted run that can no longer be answered. */
			invalidatedApprovals: string[];
			uncertainOperations: ClaudeUncertainOperation[];
	  }
	| {
			status: 'blocked';
			reason: ClaudeRecoveryBlockedReason;
			runId?: string;
			turnId?: string;
	  };

/**
 * The repository document with the procedure for unlocking by hand a chat
 * Studio cannot recover by itself.
 */
export const CLAUDE_RECOVERY_PROCEDURE_DOCUMENT = 'docs/design-docs/claude-code-recovery.md';

function byHand( what: string ): string {
	return sprintf(
		/* translators: 1: why Studio cannot recover the chat. 2: a documentation file in the Studio repository. */
		__( '%1$s To unlock it by hand, follow the procedure in %2$s.' ),
		what,
		CLAUDE_RECOVERY_PROCEDURE_DOCUMENT
	);
}

function retryThenByHand( what: string ): string {
	return sprintf(
		/* translators: 1: why Studio cannot recover the chat. 2: a documentation file in the Studio repository. */
		__(
			'%1$s Try again in a moment. If this keeps happening, follow the procedure in %2$s to unlock it by hand.'
		),
		what,
		CLAUDE_RECOVERY_PROCEDURE_DOCUMENT
	);
}

/** A display message for why a conversation was not recovered, and what to do next. */
export function getClaudeRecoveryBlockedMessage( reason: ClaudeRecoveryBlockedReason ): string {
	switch ( reason ) {
		case 'runtime-disabled':
			return __( 'The Claude Code experiment is turned off. Turn it on and try again.' );
		case 'not-claude-session':
			return __(
				'This chat does not use Claude Code, or its workspace binding cannot be read, so there is nothing to recover. To continue with Claude Code, start a new chat.'
			);
		case 'not-locked':
			return __(
				'This chat is not locked, so there is nothing to recover. Send your next message.'
			);
		case 'deletion-pending':
			return sprintf(
				/* translators: %s: a documentation file in the Studio repository. */
				__(
					'This chat is being deleted. Wait for that to finish, or delete the chat again to finish it. If Studio reports that the chat is locked, follow the procedure in %s.'
				),
				CLAUDE_RECOVERY_PROCEDURE_DOCUMENT
			);
		case 'legacy-lock':
			return byHand(
				__(
					'This chat was locked by an earlier version of Studio, which did not record the process that held the lock, so Studio cannot prove it has ended.'
				)
			);
		case 'lock-unreadable':
			return retryThenByHand(
				__( 'Studio could not read the lock on this chat, or does not recognize it.' )
			);
		case 'lock-not-a-run':
			return sprintf(
				/* translators: %s: a documentation file in the Studio repository. */
				__(
					'A deletion of this chat holds its lock. Wait for the deletion to finish. If no Studio app is deleting the chat, the deletion was interrupted and Studio cannot tell which process held it: follow the procedure in %s.'
				),
				CLAUDE_RECOVERY_PROCEDURE_DOCUMENT
			);
		case 'lock-other-conversation':
		case 'platform-mismatch':
			return byHand(
				__( 'Studio does not recognize the lock on this chat, so it left it in place.' )
			);
		case 'owner-alive':
			return __(
				'The Studio process that ran the last turn is still running. Wait for the turn to finish, or quit that Studio app, then try again.'
			);
		case 'native-alive':
		case 'guardian-alive':
		case 'descendants-alive':
			return sprintf(
				/* translators: %s: a documentation file in the Studio repository. */
				__(
					'A process of the last Claude Code turn is still running. Wait for it to end, or quit the Studio app that started it, then try again. If it is still running once every Studio app is closed, follow the procedure in %s.'
				),
				CLAUDE_RECOVERY_PROCEDURE_DOCUMENT
			);
		case 'owner-unverifiable':
		case 'native-unverifiable':
		case 'guardian-unverifiable':
		case 'descendants-unverifiable':
			return retryThenByHand(
				__( 'Studio could not check whether every process of the last turn has ended.' )
			);
		case 'native-unowned':
			return byHand(
				__(
					'A Claude Code process of the last turn may have started without Studio confirming that it owned it, so Studio cannot prove it has ended.'
				)
			);
		case 'binding-mismatch':
		case 'native-session-mismatch':
			return sprintf(
				/* translators: %s: a documentation file in the Studio repository. */
				__(
					'The lock does not match this chat’s Claude workspace and session. To continue, start a new Claude chat; this chat’s history stays available. To unlock this chat by hand, follow the procedure in %s.'
				),
				CLAUDE_RECOVERY_PROCEDURE_DOCUMENT
			);
		case 'workspace-missing':
			return sprintf(
				/* translators: %s: a documentation file in the Studio repository. */
				__(
					'This chat’s workspace or Claude configuration folder is no longer available. Restore it where it was and try again, or start a new Claude chat. Until then this chat keeps its lock and cannot be deleted; to clear the lock by hand so you can delete it, follow the procedure in %s.'
				),
				CLAUDE_RECOVERY_PROCEDURE_DOCUMENT
			);
		case 'native-session-missing':
		case 'native-history-missing':
			return sprintf(
				/* translators: %s: a documentation file in the Studio repository. */
				__(
					'This chat’s Claude Code history could not be found or verified. To continue, start a new Claude chat; this chat’s history stays available. This chat keeps its lock and cannot be deleted; to clear the lock by hand so you can delete it, follow the procedure in %s.'
				),
				CLAUDE_RECOVERY_PROCEDURE_DOCUMENT
			);
		case 'journal-unreadable':
			return sprintf(
				/* translators: %s: a documentation file in the Studio repository. */
				__(
					'Studio could not read this chat’s journal. Try again in a moment. If this keeps happening, start a new Claude chat. This chat keeps its lock and cannot be deleted; to clear the lock by hand so you can delete it, follow the procedure in %s.'
				),
				CLAUDE_RECOVERY_PROCEDURE_DOCUMENT
			);
		case 'lock-changed':
			return __(
				'The lock on this chat changed while Studio was checking it, so another Studio app may have recovered or used the chat. Reload the chat and try again.'
			);
		case 'recovery-in-progress':
			return __(
				'Another Studio app is recovering this chat, or may be. Wait for it to finish, or quit the other Studio apps, then try again.'
			);
		case 'recovery-claim-unreadable':
			return retryThenByHand(
				__(
					'A claim on recovering this chat cannot be read. A recovery that was interrupted while it created the claim leaves it so.'
				)
			);
		case 'recovery-failed':
			return retryThenByHand(
				__( 'Studio could not record the recovery or release the lock, so it kept the lock.' )
			);
	}
}

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
