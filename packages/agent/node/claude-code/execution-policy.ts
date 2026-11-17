import { createHash, randomUUID } from 'crypto';
import { realpath } from 'fs/promises';
import os from 'os';
import path from 'path';
import { getConnectedWpcomSitesForLocalSite } from '@studio/common/lib/connected-sites';
import { normalizeHostname as normalizeSiteAddress } from '@studio/common/lib/normalize-hostname';
import { getCurrentUserId } from '@studio/common/lib/shared-config';
import { isReprintPullEnabled } from '@studio/common/lib/sync/reprint-pull';
import { getCliConfigPath, getSharedConfigPath } from '@studio/common/lib/well-known-paths';
import {
	escapeClaudeApprovalText,
	isClaudeReadOnlyClass,
} from '@studio/agent/protocol/claude-code';
import { getCreatedSiteFromArtifact } from '../sessions/placement';
import {
	finalizeAttachmentsArgs,
	readReservedAttachments,
	reserveAttachmentsArgs,
} from '../tools/media-library';
import {
	CLAUDE_ACCOUNT_RECHECK_MS,
	CLAUDE_NATIVE_TOOL_RULES,
	CLAUDE_STUDIO_TOOL_RULES,
	HOST_OPERATION_CLASSES,
	claudeNativeTools,
	claudeRouteNote,
	claudeStudioTools,
	claudeTargetOrigin,
	describeClaudeOperation,
	isContainedPattern,
	isLocalHostname,
	isRecord,
	normalizeHostname,
	requiresClaudeApproval,
	studioToolName,
} from './execution-rules';
import {
	isAllowedNativePath,
	isBundledFolder,
	isInsideCanonicalRoot,
	isJudgeable,
	isOutsideReach,
	resolveAllowedNewPath,
	resolveAllowedPath,
} from './local-paths';
import { classifyWpCliArgs, hasWpCliOverrides, wpCliOption } from './wp-cli-rules';
import type {
	ClaudeEnabledTools,
	ClaudeNavigationConfinement,
	ClaudeShellConfinement,
	HostOperationName,
} from './execution-rules';
import type { HostOperationOptions, HostSite, MediaAttachment, StudioAgentHost } from '../host';
import type {
	BackendApprovalOperation,
	BackendTurnEvent,
	ClaudeOperationJournalEvent,
} from '@studio/agent/protocol/backend-events';
import type { ClaudeOperationClass, ClaudeStudioTarget } from '@studio/agent/protocol/claude-code';
import type { SyncSite } from '@studio/common/types/sync';

/**
 * The single place that decides what a Claude turn may execute. The SDK
 * PreToolUse hook, the native permission request, Studio's in-process MCP tools
 * and every host operation they reach ask it, immediately before execution.
 * Anything it does not know is denied.
 */

/** Changes whenever what this policy allows changes; turns and approvals carry it. */
export const CLAUDE_EXECUTION_POLICY_REVISION = 1;

/** One operation as it will run. An approval covers exactly this, for one call. */
export interface ClaudeOperation {
	/** Canonical Studio tool, native tool or host operation name. */
	readonly tool: string;
	readonly operationClass: ClaudeOperationClass;
	/** The exact arguments that will run. */
	readonly args: unknown;
	/** The local site its arguments name. */
	readonly siteId?: string;
	readonly localPaths: readonly string[];
	/** The remote resource it reaches, for display. */
	readonly remote?: string;
	readonly description: string;
	readonly draft?: { readonly siteName: string; readonly title: string; readonly content?: string };
}

/** Immutable: what the user is asked to allow, and everything the answer is scoped to. */
export interface ClaudeApprovalRequest {
	readonly requestId: string;
	readonly runId: string;
	readonly turnId: string;
	readonly toolCallId: string;
	readonly connectionId: string;
	readonly connectionRevision: number;
	readonly policyRevision: number;
	readonly target: Readonly< ClaudeStudioTarget >;
	readonly operation: ClaudeOperation;
}

export type ClaudeApprover = (
	request: ClaudeApprovalRequest,
	signal: AbortSignal
) => Promise< 'allow' | 'deny' >;

/** An allowed approval, usable once for its exact operation. */
export interface ClaudeApprovalGrant {
	readonly requestId: string;
}

export interface ClaudeExecutionContext {
	runId: string;
	turnId: string;
	connectionId: string;
	connectionRevision: number;
	/** The revision the turn was sent with; any other than this build's denies everything. */
	policyRevision: number;
	/** The target the turn was sent with. */
	target: ClaudeStudioTarget;
	/** The native workspace: its site (null when global) and canonical folders. */
	workspace: { siteId: string | null; workingDirectory: string; configDirectory: string };
	/** The target site, its canonical folder and its URL; absent for a global target. */
	targetSite?: { id: string; path: string; url?: string };
	/** Canonical folders native file tools may reach. */
	localRoots: readonly string[];
	enabledTools: ClaudeEnabledTools;
	/** How the turn's launch confines shell commands. */
	shellConfinement: ClaudeShellConfinement;
	/** The browser-layer guard the turn's browser tools run under, if any. */
	navigationConfinement: ClaudeNavigationConfinement;
	signal: AbortSignal;
	approve: ClaudeApprover;
	approvalTimeoutMs: number;
	/** Native startup was verified; nothing runs before it. */
	ready: () => boolean;
	/** The connection the turn started on is still attached, at the same revision. */
	stillConnected: () => Promise< boolean >;
	/** Reads the native sign-in now and compares it with the turn's account. */
	verifyAccount: () => Promise< ClaudeAccountCheck >;
	/** When the turn last read the native sign-in, by `now`. */
	accountVerifiedAt: number;
	now: () => number;
	/** The conversation still has the turn's native binding and this persisted target. */
	verifyTarget: ( expected: ClaudeStudioTarget ) => Promise< boolean >;
	onEvent: ( event: BackendTurnEvent ) => void;
	/**
	 * Writes an entry to the turn's journal and resolves once it is on disk.
	 * Every operation that does more than read is recorded this way before it runs.
	 */
	recordOperation: ( event: ClaudeOperationJournalEvent ) => Promise< void >;
	/**
	 * The turn carries the note of a recovery that left at least one operation
	 * of the interrupted turn uncertain. For this turn only, everything that
	 * does more than read asks first, saying so.
	 */
	uncertainAfterRecovery?: boolean;
}

/** What an approval the recovery gate asks for adds to its description. */
const AFTER_RECOVERY =
	'The previous turn was interrupted, so an attempt it made may already have taken effect.';

/**
 * The outcome of reading the native sign-in: the turn's account, another
 * account or none, or a read that failed and so proves nothing.
 */
export type ClaudeAccountCheck = 'same' | 'changed' | 'unverified';

export interface ClaudeToolUse {
	toolName: string;
	input: unknown;
	toolUseId?: string;
	mcpServer?: { name: string; source: string };
}

export interface ClaudeStudioCall {
	/** The unguarded host, used to resolve the site the call names. */
	host: StudioAgentHost;
	name: string;
	args: unknown;
	toolCallId: string;
	/** Aborts when the caller gives up on the call. */
	signal?: AbortSignal;
}

export interface ClaudeExecutionPolicy {
	/** Aborts when the turn ends or anything it was authorized against changes. */
	readonly signal: AbortSignal;
	/** The Studio tools this turn may run: enabled, qualified and, when they drive a browser, guarded. */
	readonly studioTools: readonly string[];
	/**
	 * The SDK PreToolUse hook and the native permission request. `signal` is the
	 * caller's own: when it aborts, the decision is deny.
	 */
	authorizeToolUse( use: ClaudeToolUse, signal?: AbortSignal ): Promise< boolean >;
	/** A Studio MCP tool call, before its handler runs. */
	authorizeStudioCall( call: ClaudeStudioCall ): Promise< boolean >;
	/**
	 * The host a Studio tool call runs against: every operation with an effect is
	 * fenced. Once `signal` or the turn aborts, it refuses every host operation
	 * and the app showing the conversation hears nothing from it. The caller
	 * aborts `signal` when the call settles, however it ended, since the SDK
	 * aborts a call's own signal only when it cancels the call. It changes the
	 * conversation's site only to a site this turn created from a conversation
	 * without a site, and only once that change is journaled.
	 */
	guardHost( host: StudioAgentHost, toolCallId: string, signal?: AbortSignal ): StudioAgentHost;
	requestApproval(
		operation: ClaudeOperation,
		toolCallId: string,
		signal?: AbortSignal
	): Promise< ClaudeApprovalGrant | undefined >;
	/** Spends a grant immediately before execution, if it covers exactly this operation. */
	authorizeExecution(
		grant: ClaudeApprovalGrant,
		operation: ClaudeOperation,
		toolCallId: string,
		signal?: AbortSignal
	): Promise< boolean >;
	/**
	 * Reads the native sign-in again when the last read is older than the bound.
	 * A different or unreadable account ends the turn's authority.
	 */
	refreshAccount(): Promise< boolean >;
	/**
	 * Why the policy refused something a call asked for, in words the model may
	 * hear: fixed sentences, never an argument, a path or a value. Reading them
	 * forgets them.
	 */
	takeRefusals( toolCallId: string ): readonly string[];
	dispose(): void;
}

/** The fixed sentences `takeRefusals` gives. */
const REFUSALS = {
	wpCli: 'This WP-CLI command is outside what Studio runs on the Claude route.',
	notApproved: 'The user did not approve this operation, or did not answer in time.',
	outsideFolders:
		'A file Studio reads or writes for this operation must be an absolute path inside the site’s folder or this conversation’s workspace, and not one that holds credentials.',
	plainPath:
		'Studio reads or writes a file for this operation only by a plain absolute path: one with no `..` segment and, on Windows, no colon but the one after the drive letter, so no stream name and no device path written with a colon. Name the file by its folder’s path and its own name.',
	createInSite:
		'A conversation works on one site, and this conversation already has its site. Ask the user to start a new conversation to create another one.',
	withoutSite:
		'A conversation works on one site, and this conversation already has its site, so Studio runs this tool only in a conversation without a site.',
	createAfterChange:
		'A conversation works on one site, and this turn has already made, or tried to make, a site it created this conversation’s site. Ask the user to start a new conversation to create another one.',
	withoutSiteAfterChange:
		'A conversation works on one site, and this turn has already made, or tried to make, a site it created this conversation’s site, so Studio runs this tool only in a conversation without a site.',
	createdInTurn: 'Studio creates one site in a turn, and this turn has already created one.',
	siteBinding:
		'Studio did not make that site this conversation’s site: only a site this turn created, in a conversation without a site, can become it.',
	siteFolderMissing:
		'The new site is now this conversation’s site, but Studio could not find its folder, so this turn acts on no site.',
	createInFlight:
		'Studio creates one site at a time, and this turn is already creating one. Wait for that call’s result.',
	payloads:
		'A file this operation sends must be an existing file in Studio’s payload folder, which the tool’s description names, and only a change the user approves sends one.',
	wpcomRequest:
		'On this route Studio sends a WordPress.com request only with a plain path and no query key that changes its method, route, namespace or origin. It reads a site, or WordPress.com’s plan features at !/plans/features, and does not read the account’s profile (!/me) on this connection, nor anything else of the account; it changes something in a site only through that site’s WordPress REST API (wp/v2) with POST or PUT, both sent as a POST, and sends no DELETE, which Studio’s WordPress.com client would send as a POST that deletes nothing.',
	wpcomSite:
		'Studio sends a WordPress.com request for a site only to this conversation’s own WordPress.com site.',
	wpcomConnection:
		'Studio changes a WordPress.com site only while it is connected to this conversation’s site under the WordPress.com login Studio is signed in with, as site_connected_remote_sites lists it.',
	wpcomLogin:
		'Studio acts on WordPress.com only while it is signed in to WordPress.com, and only under the login it was signed in with when the operation was prepared and the user was asked: an operation whose login changed before it started does not run.',
	stores:
		'Studio acts on WordPress.com only while the files where it keeps its WordPress.com login, its connections and its previews lie outside every folder this conversation reaches.',
	preview:
		'Studio updates or deletes a preview only when it is one of this conversation’s site’s own previews, named by the address preview_list gives for it.',
	previewOverwrite:
		'Studio updates a preview only from the site it was made from, so overwrite must be false or left out.',
	scratch:
		'Studio runs this operation only while the system’s temporary folder, where its command keeps the archive it sends or receives, lies outside every folder this conversation reaches.',
	remoteSite:
		'Studio pushes to or pulls from a WordPress.com site only when it is connected to this conversation’s site, as site_connected_remote_sites lists it, named by its numeric ID or its address; in a conversation on a live site, only that site.',
	syncOptions:
		'Studio pushes or pulls only with options from this list, each once, separated by commas: all (alone), sqls, uploads, plugins, themes, contents.',
	reprintPull:
		'On this route Studio pulls a site only with its default engine; the Reprint pull (STUDIO_ENABLE_PULL_REPRINT) keeps its state in a folder outside Studio’s configuration folder, which this route does not bind.',
	siteFiles:
		'A file this tool writes must be an absolute path inside the folder of this conversation’s site, through every link it passes.',
	mediaUploads:
		'Studio adds an image to a site’s media library only while WordPress keeps that site’s uploads inside the site’s own folder, and this site’s uploads folder lies outside it.',
} as const;

// What a push or pull with each option overwrites on the side it copies to:
// the options the CLI's commands take that the tools describe. `paths` is
// left out: it needs a list of paths no tool passes.
const SYNC_OVERWRITES: Readonly< Record< string, string > > = Object.freeze( {
	all: 'the database and every file in wp-content',
	sqls: 'the database',
	uploads: 'the uploads',
	plugins: 'the plugins',
	themes: 'the themes',
	contents: 'every file in wp-content',
} );

// The options a push or pull runs with, as the CLI reads a comma-separated
// list: each one it takes and the tools describe, once, `all` alone.
// Undefined for anything else.
function syncSelection( options: unknown ): string[] | undefined {
	if ( typeof options !== 'string' ) return;
	const items = options.split( ',' ).map( ( item ) => item.trim() );
	if (
		items.some( ( item ) => ! Object.prototype.hasOwnProperty.call( SYNC_OVERWRITES, item ) ) ||
		new Set( items ).size !== items.length ||
		( items.includes( 'all' ) && items.length > 1 )
	)
		return;
	return items;
}

// What an approval shows of a WordPress.com site a push or pull syncs with:
// what Studio's connection record holds of it, its name, its address as the
// CLI normalizes it and whether it is a staging or a production site, beside
// its numeric ID. The user's own site, shown to the user; never the account
// it is connected under.
function shownConnection( site: SyncSite ) {
	return {
		id: site.id,
		name: String( site.name ).replace( /\s+/g, ' ' ).trim(),
		address: normalizeSiteAddress( String( site.url ) ),
		kind: site.isStaging ? ( 'staging' as const ) : ( 'production' as const ),
	};
}

// The same, in one line.
function connectionLabel( site: SyncSite ): string {
	const { id, name, address, kind } = shownConnection( site );
	return `WordPress.com site ${ id }: ${ name }, ${ address }, a ${ kind } site`;
}

// What an approval of a push or pull, and so its journal entry, says of it
// after its class and name: the site it syncs with, as Studio keeps its
// connection, the options and what they replace where the copy lands, and
// what an interrupted one may have left, which a recovery then says. A pull
// also says what the CLI's default engine and importer replace or move
// whatever the options, and where they unpack the backup.
function syncNote( name: 'sync.push' | 'sync.pull', site: SyncSite, options: string[] ): string {
	const { id, name: siteName, address, kind } = shownConnection( site );
	const connected = `the connected WordPress.com site ${ id } (${ siteName }, ${ address }, a ${ kind } site)`;
	const overwrites = options
		.map( ( option ) => SYNC_OVERWRITES[ option ] )
		.join( ' and ' )
		.replace( / and (?=.* and )/g, ', ' );
	const chosen = `with the options ${ options.join( ', ' ) }`;
	if ( name === 'sync.push' )
		return `It uploads this local site to ${ connected } ${ chosen }, replacing ${ overwrites } on that site. If it is interrupted, the import of what it uploaded may still be running on WordPress.com`;
	return `It copies ${ connected } into this local site ${ chosen }, replacing ${ overwrites } in this local site, and stops the site while it runs if it is running. It downloads a backup of that site into a temporary folder and extracts it into a second one; it replaces the site’s wp-config.php with the backup’s when the backup has one, and moves the site’s previous database to the operating system’s trash before importing the backup’s when the backup holds one. If it is interrupted, the site’s server may be left stopped and its database emptied, with the previous one in the operating system’s trash`;
}

function deepFreeze< T >( value: T ): T {
	if ( value && typeof value === 'object' && ! Object.isFrozen( value ) ) {
		Object.freeze( value );
		for ( const item of Object.values( value ) ) deepFreeze( item );
	}
	return value;
}

function canonicalJson( value: unknown ): string {
	return JSON.stringify( value, ( _key, item: unknown ) =>
		isRecord( item )
			? Object.fromEntries(
					Object.entries( item ).sort( ( [ a ], [ b ] ) => ( a < b ? -1 : a > b ? 1 : 0 ) )
			  )
			: item
	);
}

/** A file a host operation reads, when it must exist, or writes. */
interface HostFile< Path = unknown > {
	path: Path;
	existing: boolean;
}

interface HostRequest {
	name: HostOperationName;
	site?: HostSite;
	args: unknown[];
	localPaths?: string[];
	remote?: string;
	/**
	 * The file the operation reads or writes, as the caller named it. The
	 * operation receives it as checked, the path it resolved to, never as named:
	 * it is the operation's first argument, before `args`, and one of its paths.
	 */
	file?: HostFile;
	/**
	 * The preview the operation acts on, by the address the caller named. It
	 * must be one of the previews of the site the turn acts on, and the
	 * operation receives that preview's own address: the operation's first
	 * argument, before `args`, and what it reaches.
	 */
	preview?: unknown;
	/**
	 * The command keeps the archive it sends or receives in the system's
	 * temporary folder, under a name it makes up, and follows a link it finds
	 * there; that folder must lie outside every folder the turn reaches.
	 */
	scratch?: true;
	/**
	 * The WordPress.com site a push or pull syncs with, by the numeric ID or
	 * address the caller named. It must be connected to the site the turn acts
	 * on, and in a conversation on a live site be that site; the operation
	 * receives its numeric ID. `syncOptions` come with it.
	 */
	wpcomSite?: unknown;
	/** The sync options as the caller named them; the operation receives them as checked. */
	syncOptions?: unknown;
	/**
	 * A pull, which runs only with the CLI's default engine: the Reprint engine
	 * keeps a site's pull state under the home folder, whatever Studio's
	 * configuration folder is, and that state decides what later pulls do.
	 */
	defaultPull?: true;
	/** What the approval and the journal say of the operation after its class and name: a fixed sentence. */
	note?: string;
}

/** A preview of the site the turn acts on: its address, and the WordPress.com site that holds it. */
interface TargetPreview {
	url: string;
	atomicSiteId: number;
}

/** What an operation receives in place of what its caller named: the values as checked. */
interface CheckedHostValues {
	file?: string;
	preview?: string;
	wpcomSite?: string;
	syncOptions?: string;
}

interface PreparedHostOperation {
	operation: ClaudeOperation;
	grant?: ClaudeApprovalGrant;
	site?: HostSite;
	/** The file as checked. */
	file?: HostFile< string >;
	/** The preview as checked. */
	preview?: TargetPreview;
	scratch?: true;
	/** The WordPress.com site, as Studio keeps its connection, and the sync options as checked. */
	wpcomSite?: SyncSite;
	syncOptions?: string;
	defaultPull?: true;
	/** The user id of the WordPress.com login the operation was prepared under. */
	login?: number;
}

const WP_CLI_ISOLATION = [ '--skip-packages', '--skip-plugins', '--skip-themes' ];

// The host operations that act on WordPress.com under the login Studio is
// signed in with: the CLI's commands read that login as they start. Each runs
// only under the login it was prepared under, which the user was asked under.
const WPCOM_OPERATIONS: ReadonlySet< string > = new Set( [
	'previews.create',
	'previews.update',
	'previews.delete',
	'sync.push',
	'sync.pull',
] );

// The host operations that run a WP-CLI command on the site the turn acts on:
// the model's own, classified, and the media library's, which are Studio's.
const WP_CLI_OPERATIONS: ReadonlySet< string > = new Set( [
	'sites.wpCli',
	'media.reserve',
	'media.finalize',
] );

// The most images a `generate_images` call takes, and so the most attachments
// one reservation makes.
const MAX_RESERVED_ATTACHMENTS = 20;

// A file name a reservation takes: a plain name, in no folder, of a PNG image.
function isImageFileName( name: unknown ): name is string {
	return typeof name === 'string' && name.length <= 255 && /^[^\\/:\0]+\.png$/i.test( name );
}

function isAttachmentId( id: unknown ): id is number {
	return Number.isSafeInteger( id ) && ( id as number ) > 0;
}

// Whether a reservation's output lists, for each name, one attachment of its
// own: an ID, a PNG file relative to the site's folder, and a URL.
function isReservation(
	reserved: unknown,
	names: readonly string[]
): reserved is MediaAttachment[] {
	if ( ! Array.isArray( reserved ) || reserved.length !== names.length ) return false;
	const ids = new Set< number >();
	for ( const entry of reserved ) {
		if (
			! isRecord( entry ) ||
			! isAttachmentId( entry.id ) ||
			ids.has( entry.id ) ||
			typeof entry.file !== 'string' ||
			! /\.png$/i.test( entry.file ) ||
			typeof entry.url !== 'string'
		)
			return false;
		ids.add( entry.id );
	}
	return true;
}

type ListedSite = Awaited< ReturnType< StudioAgentHost[ 'sites' ][ 'list' ] > >[ number ];

// What a conversation without a site learns of each local site: the fields
// every site has, which name it, say where it is and whether it runs; nothing
// of its admin account, mail folder, custom domain, settings or operations.
function listedSite( site: ListedSite ): ListedSite {
	const { id, name, path: folder, port, url, phpVersion, running } = site;
	return { id, name, path: folder, port, url, phpVersion, running };
}

function denied(): Error {
	return new Error( 'Denied' );
}

export function createClaudeExecutionPolicy(
	context: ClaudeExecutionContext
): ClaudeExecutionPolicy {
	const controller = new AbortController();
	const signal = AbortSignal.any( [ context.signal, controller.signal ] );
	const grants = new Map< string, string >();
	const createdSites = new Set< string >();
	// The targets the conversation may have while this turn runs (carry item
	// 7): the one it was sent with until this turn makes a site it created the
	// conversation's site, and that site once the change is written. A change
	// is accepted from before its write starts, so a check that reads the
	// stored target meanwhile never stops the turn for the turn's own change.
	// A write that failed may or may not have landed, so its target is then
	// accepted next to the ones before it. `targetVersion` counts every change
	// of what is accepted.
	let settledTargets: readonly ClaudeStudioTarget[] = [ context.target ];
	const targetWrites = new Map< Promise< void >, ClaudeStudioTarget >();
	let targetVersion = 0;
	const acceptedTargets = () => [ ...settledTargets, ...targetWrites.values() ];
	// The target the turn acts on, and its site's canonical folder: the ones it
	// was sent with, until a site this turn created has become the
	// conversation's site (its selection journaled and written); from then on
	// that site, for the rest of the turn. Site-bound calls resolve against it.
	let actingTarget: ClaudeStudioTarget = context.target;
	let actingSite: { id: string; path: string } | undefined = context.targetSite;
	// Whether this turn has changed the conversation's site, from the moment
	// that change is made, whether or not the turn then found the site's folder.
	let siteChanged = false;
	// Whether the conversation had its site when the turn started: it was
	// started on one, or its target is one.
	const hadSite = context.workspace.siteId !== null || context.target.environment !== 'global';
	// Whether the conversation has its site: it had one, it acts on one, or this
	// turn changed it. A conversation works on one site.
	const hasSite = () => hadSite || actingTarget.environment !== 'global' || siteChanged;
	// Why a call that runs only in a conversation without a site, or creates
	// the conversation's site, is refused; undefined when it is not. Once this
	// turn has changed the conversation's site, its write may or may not have
	// landed, so the sentence says the turn tried, not that the site is set. A
	// turn creates one site, also where the host cannot make it the
	// conversation's site (a terminal has no `selectSite`).
	const siteRefusal = ( creates: boolean ): string | undefined => {
		if ( hasSite() ) {
			if ( hadSite ) return creates ? REFUSALS.createInSite : REFUSALS.withoutSite;
			return creates ? REFUSALS.createAfterChange : REFUSALS.withoutSiteAfterChange;
		}
		if ( creates && createdSites.size ) return REFUSALS.createdInTurn;
	};
	// The signal each call's guarded host lives by, which aborts once the call
	// has settled, and the call that is creating a site, if any: one at a time.
	const callSignals = new Map< string, AbortSignal >();
	let creatingCall: string | undefined;
	// The Studio tool each call the policy admitted is a call of, until the
	// call settles: what a guarded host gives can depend on the tool it serves.
	const admittedCalls = new Map< string, string >();
	const refusals = new Map< string, Set< string > >();
	const refuse = ( toolCallId: string, reason: string ) => {
		if ( ! refusals.has( toolCallId ) ) refusals.set( toolCallId, new Set() );
		refusals.get( toolCallId )!.add( reason );
	};
	// Whether an operation of this class asks the user first: by its class, or,
	// in the turn after a recovery that left operations uncertain, whenever it
	// does more than read.
	const gatedAfterRecovery = ( operationClass: ClaudeOperationClass ) =>
		context.uncertainAfterRecovery === true &&
		! requiresClaudeApproval( operationClass ) &&
		! isClaudeReadOnlyClass( operationClass );
	const asksFirst = ( operationClass: ClaudeOperationClass ) =>
		requiresClaudeApproval( operationClass ) || gatedAfterRecovery( operationClass );
	// What an approval and the journal say of an operation: with the recovery
	// gate's notice when that gate is what asks.
	const noticed = ( operationClass: ClaudeOperationClass, description: string ) =>
		gatedAfterRecovery( operationClass ) ? `${ description }. ${ AFTER_RECOVERY }` : description;
	const describe = (
		operationClass: ClaudeOperationClass,
		tool: string,
		shell?: ClaudeShellConfinement
	) => noticed( operationClass, describeClaudeOperation( operationClass, tool, shell ) );
	// A tool use is asked about at most once, whether by the hook or by the
	// permission request, so a hook that times out cannot be answered later.
	const askedToolUses = new Set< string >();
	const nativeTools = new Set(
		claudeNativeTools(
			context.enabledTools,
			context.shellConfinement,
			context.workspace.workingDirectory
		)
	);
	const targetOrigin = claudeTargetOrigin( context.target, context.targetSite );
	const studioTools = new Set(
		claudeStudioTools( context.enabledTools, context.navigationConfinement, targetOrigin )
	);
	signal.addEventListener(
		'abort',
		() => {
			grants.clear();
			refusals.clear();
			admittedCalls.clear();
		},
		{ once: true }
	);

	let accountVerifiedAt = context.accountVerifiedAt;
	let accountRead: Promise< boolean > | undefined;

	async function readAccount(): Promise< boolean > {
		const startedAt = context.now();
		const result = await context.verifyAccount().catch( () => 'unverified' as const );
		if ( result !== 'same' ) {
			controller.abort();
			return false;
		}
		accountVerifiedAt = Math.max( accountVerifiedAt, startedAt );
		return ! signal.aborted;
	}

	// `fresh` reads the sign-in now; otherwise a read younger than the bound is
	// enough, and concurrent operations share one read.
	async function accountIsCurrent( fresh: boolean ): Promise< boolean > {
		if ( signal.aborted ) return false;
		if ( fresh ) return readAccount();
		if ( context.now() - accountVerifiedAt < CLAUDE_ACCOUNT_RECHECK_MS ) return true;
		accountRead ??= readAccount().finally( () => {
			accountRead = undefined;
		} );
		return accountRead;
	}

	// Whether the conversation still has a target this turn may act under. A
	// check that found none while this turn's own change of target was being
	// written, or once what is accepted changed, is made again after that
	// write has settled; anything else means the conversation moved.
	async function targetHolds(): Promise< boolean > {
		for ( let attempt = 0; attempt < 3; attempt++ ) {
			const version = targetVersion;
			const writing = [ ...targetWrites.keys() ];
			const results = await Promise.all(
				acceptedTargets().map( ( target ) => context.verifyTarget( target ).catch( () => false ) )
			);
			if ( results.some( Boolean ) ) return true;
			if ( writing.length ) {
				if ( ! ( await settledWhileTurnLives( Promise.all( writing ) ) ) ) return false;
			} else if ( version === targetVersion ) return false;
		}
		return false;
	}

	// Waits for work that never rejects, unless the turn ends first: a write
	// that never settles holds no check past the turn.
	function settledWhileTurnLives( work: Promise< unknown > ): Promise< boolean > {
		return new Promise( ( resolve ) => {
			if ( signal.aborted ) return resolve( false );
			const ended = () => resolve( false );
			signal.addEventListener( 'abort', ended, { once: true } );
			void work.then( () => {
				signal.removeEventListener( 'abort', ended );
				resolve( true );
			} );
		} );
	}

	// Writes this turn's change of the conversation's target, accepting the new
	// target from before the write starts (see `settledTargets`).
	async function writeTarget(
		target: ClaudeStudioTarget,
		write: () => Promise< void > | void
	): Promise< void > {
		const written = Promise.resolve().then( write );
		const settled = written.then(
			() => {},
			() => {}
		);
		targetWrites.set( settled, target );
		targetVersion++;
		let landed = false;
		try {
			await written;
			landed = true;
		} finally {
			targetWrites.delete( settled );
			settledTargets = landed ? [ target ] : [ ...settledTargets, target ];
			targetVersion++;
		}
	}

	async function checkpoint( callSignal?: AbortSignal, freshAccount = false ): Promise< boolean > {
		if (
			signal.aborted ||
			callSignal?.aborted ||
			! context.ready() ||
			context.policyRevision !== CLAUDE_EXECUTION_POLICY_REVISION
		)
			return false;
		const [ connected, targeted ] = await Promise.all( [
			context.stillConnected().catch( () => false ),
			targetHolds(),
		] );
		if ( ! connected || ! targeted ) {
			controller.abort();
			return false;
		}
		if ( ! ( await accountIsCurrent( freshAccount ) ) ) return false;
		return ! signal.aborted && ! callSignal?.aborted;
	}

	// Everything an approval-class operation needs immediately before it runs,
	// including a read of the native sign-in.
	function accountCheckpoint( callSignal?: AbortSignal ): Promise< boolean > {
		return checkpoint( callSignal, true );
	}

	function fingerprint( operation: ClaudeOperation, toolCallId: string ): string {
		return createHash( 'sha256' )
			.update(
				canonicalJson( {
					runId: context.runId,
					turnId: context.turnId,
					toolCallId,
					connectionId: context.connectionId,
					connectionRevision: context.connectionRevision,
					policyRevision: context.policyRevision,
					target: actingTarget,
					operation,
				} )
			)
			.digest( 'hex' );
	}

	function display( operation: ClaudeOperation ): BackendApprovalOperation {
		return {
			tool: escapeClaudeApprovalText( operation.tool ),
			operationClass: operation.operationClass,
			target: { ...actingTarget },
			args: escapeClaudeApprovalText( JSON.stringify( operation.args, null, 2 ) ?? 'null' ),
			localPaths: operation.localPaths.map( escapeClaudeApprovalText ),
			...( operation.remote ? { remote: escapeClaudeApprovalText( operation.remote ) } : {} ),
		};
	}

	async function awaitAnswer(
		request: ClaudeApprovalRequest,
		callSignal?: AbortSignal
	): Promise< boolean > {
		if ( signal.aborted || callSignal?.aborted ) return false;
		const answer = new AbortController();
		const stop = () => answer.abort();
		signal.addEventListener( 'abort', stop, { once: true } );
		callSignal?.addEventListener( 'abort', stop, { once: true } );
		const timer = setTimeout( stop, Math.max( 1, context.approvalTimeoutMs ) );
		try {
			const ended = new Promise< 'deny' >( ( resolve ) =>
				answer.signal.addEventListener( 'abort', () => resolve( 'deny' ), { once: true } )
			);
			const result = await Promise.race( [
				Promise.resolve()
					.then( () => context.approve( request, answer.signal ) )
					.catch( () => 'deny' as const ),
				ended,
			] );
			return result === 'allow' && ! answer.signal.aborted;
		} finally {
			clearTimeout( timer );
			signal.removeEventListener( 'abort', stop );
			callSignal?.removeEventListener( 'abort', stop );
			answer.abort();
		}
	}

	async function requestApproval(
		input: ClaudeOperation,
		toolCallId: string,
		callSignal?: AbortSignal
	): Promise< ClaudeApprovalGrant | undefined > {
		let operation: ClaudeOperation;
		try {
			operation = deepFreeze( structuredClone( input ) );
		} catch {
			return;
		}
		if ( ! ( await accountCheckpoint( callSignal ) ) ) return;
		const request: ClaudeApprovalRequest = deepFreeze( {
			requestId: randomUUID(),
			runId: context.runId,
			turnId: context.turnId,
			toolCallId,
			connectionId: context.connectionId,
			connectionRevision: context.connectionRevision,
			policyRevision: context.policyRevision,
			target: { ...actingTarget },
			operation,
		} );
		// The grant covers the target the user is shown.
		let covered: string;
		try {
			covered = fingerprint( operation, toolCallId );
		} catch {
			return;
		}
		const ids = {
			runId: context.runId,
			turnId: context.turnId,
			toolCallId,
			requestId: request.requestId,
		};
		context.onEvent( {
			type: 'approval.requested',
			...ids,
			description: escapeClaudeApprovalText( operation.description ),
			operation: display( operation ),
			...( operation.draft
				? {
						draft: {
							siteName: escapeClaudeApprovalText( operation.draft.siteName ),
							title: escapeClaudeApprovalText( operation.draft.title ),
							content:
								operation.draft.content === undefined
									? undefined
									: escapeClaudeApprovalText( operation.draft.content ),
						},
				  }
				: {} ),
		} );
		const allowed = await awaitAnswer( request, callSignal );
		context.onEvent( { type: 'approval.resolved', ...ids } );
		if ( ! allowed ) refuse( toolCallId, REFUSALS.notApproved );
		if ( ! allowed || ! ( await accountCheckpoint( callSignal ) ) ) return;
		grants.set( request.requestId, covered );
		return { requestId: request.requestId };
	}

	async function authorizeExecution(
		grant: ClaudeApprovalGrant,
		operation: ClaudeOperation,
		toolCallId: string,
		callSignal?: AbortSignal
	): Promise< boolean > {
		const expected = grants.get( grant.requestId );
		grants.delete( grant.requestId );
		if ( expected === undefined ) return false;
		let actual: string;
		try {
			actual = fingerprint( operation, toolCallId );
		} catch {
			return false;
		}
		return expected === actual && ( await accountCheckpoint( callSignal ) );
	}

	// The last step before anything that does more than read runs: its record
	// in the turn's journal, on disk, so a recovery can name it if the turn ends
	// before its result is recorded. What cannot be recorded does not run, and
	// the turn stops, since it could no longer account for what it runs.
	async function admit(
		operation: Pick< ClaudeOperation, 'tool' | 'operationClass' | 'description' >,
		toolCallId: string | undefined,
		callSignal?: AbortSignal,
		requestId?: string
	): Promise< boolean > {
		if ( isClaudeReadOnlyClass( operation.operationClass ) ) return true;
		if ( ! toolCallId || signal.aborted || callSignal?.aborted ) return false;
		try {
			await context.recordOperation( {
				type: 'operation.authorized',
				runId: context.runId,
				turnId: context.turnId,
				toolCallId,
				...( requestId ? { requestId } : {} ),
				operation: {
					tool: escapeClaudeApprovalText( operation.tool ),
					operationClass: operation.operationClass,
					target: { ...actingTarget },
				},
				description: escapeClaudeApprovalText( operation.description ),
			} );
		} catch {
			controller.abort();
			return false;
		}
		return ! signal.aborted && ! callSignal?.aborted;
	}

	// Asks once, spends the grant and journals the operation. `holds` is what
	// must still be true once the user has answered, checked before anything
	// is journaled.
	async function approveOnce(
		operation: ClaudeOperation,
		toolCallId: string,
		callSignal?: AbortSignal,
		holds: () => Promise< boolean > = async () => true
	) {
		const grant = await requestApproval( operation, toolCallId, callSignal );
		return (
			!! grant &&
			( await authorizeExecution( grant, operation, toolCallId, callSignal ) ) &&
			( await holds() ) &&
			admit( operation, toolCallId, callSignal, grant.requestId )
		);
	}

	async function authorizeToolUse(
		use: ClaudeToolUse,
		callSignal?: AbortSignal
	): Promise< boolean > {
		const { toolName, input, mcpServer } = use;
		if ( callSignal?.aborted ) return false;
		if ( toolName.startsWith( 'mcp__' ) ) {
			const name = studioToolName( toolName );
			// The Studio guard for its tools runs where they execute; this only
			// admits Studio's own in-process server.
			return (
				!! name &&
				mcpServer?.name === 'studio' &&
				mcpServer.source === 'sdk' &&
				studioTools.has( name ) &&
				CLAUDE_STUDIO_TOOL_RULES.has( name ) &&
				( await checkpoint( callSignal ) )
			);
		}
		const rule = CLAUDE_NATIVE_TOOL_RULES.get( toolName );
		if ( ! rule || ! nativeTools.has( toolName ) || ! isRecord( input ) ) return false;
		if ( rule.accepts && ! rule.accepts( input ) ) return false;
		if (
			rule.patterns?.some(
				( field ) => input[ field ] !== undefined && ! isContainedPattern( input[ field ] )
			)
		)
			return false;
		let localPaths = [ context.workspace.workingDirectory ];
		if ( rule.path ) {
			const value = input[ rule.path.field ];
			if ( value !== undefined || rule.path.required ) {
				if (
					typeof value !== 'string' ||
					! ( await isAllowedNativePath(
						value,
						context.localRoots,
						context.workspace.configDirectory,
						rule.path.allowRoot
					) )
				)
					return false;
				localPaths = [ value ];
			}
		}
		const operation = {
			tool: toolName,
			operationClass: rule.operationClass,
			description: describe(
				rule.operationClass,
				toolName,
				rule.shell ? context.shellConfinement : undefined
			),
		};
		if ( ! asksFirst( rule.operationClass ) )
			return ( await checkpoint( callSignal ) ) && admit( operation, use.toolUseId, callSignal );
		const toolUseId = use.toolUseId;
		if ( ! toolUseId || askedToolUses.has( toolUseId ) ) return false;
		askedToolUses.add( toolUseId );
		return approveOnce( { ...operation, args: input, localPaths }, toolUseId, callSignal );
	}

	// Resolves a site reference and requires it to be the turn's target site,
	// still at the canonical folder the turn verified.
	async function resolveTarget(
		host: StudioAgentHost,
		reference: string
	): Promise< HostSite | undefined > {
		const target = actingTarget;
		const targetSite = actingSite;
		if ( target.environment === 'global' || ! targetSite ) return;
		try {
			const current = await host.sites.resolve( reference );
			if (
				current.id !== target.siteId ||
				current.id !== targetSite.id ||
				( await realpath( current.path ) ) !== targetSite.path
			)
				return;
			return current;
		} catch {
			return;
		}
	}

	// The origin a URL may be opened at, if any. Only http and https. A local
	// address, or the address of any local site, must be the target site's own
	// origin; a public page is an external read. A URL a site audit composes
	// must be that site's own origin. Host names are compared normalized; a name
	// that resolves to a local address is the navigation guard's to refuse.
	async function reachableOrigin(
		host: StudioAgentHost,
		url: string,
		onSite: boolean
	): Promise< string | undefined > {
		let parsed: URL;
		try {
			parsed = new URL( url );
		} catch {
			return;
		}
		if (
			( parsed.protocol !== 'http:' && parsed.protocol !== 'https:' ) ||
			parsed.username ||
			parsed.password
		)
			return;
		if ( parsed.origin === targetOrigin ) return parsed.origin;
		if ( onSite ) return;
		const hostname = normalizeHostname( parsed.hostname );
		if ( isLocalHostname( hostname ) ) return;
		try {
			const siteHosts = ( await host.sites.all() ).map( ( item ) =>
				normalizeHostname( new URL( item.url ).hostname )
			);
			if ( siteHosts.includes( hostname ) ) return;
		} catch {
			return;
		}
		return parsed.origin;
	}

	async function authorizeStudioCall( call: ClaudeStudioCall ): Promise< boolean > {
		const { host, name, args, toolCallId, signal: callSignal } = call;
		if ( callSignal?.aborted ) return false;
		const rule = CLAUDE_STUDIO_TOOL_RULES.get( name );
		if ( ! rule || ! studioTools.has( name ) ) return false;
		const siteRefused = rule.withoutSite ? siteRefusal( rule.createsSite === true ) : undefined;
		if ( siteRefused ) {
			refuse( toolCallId, siteRefused );
			return false;
		}
		if ( rule.createsSite ) {
			if ( creatingCall !== undefined ) {
				refuse( toolCallId, REFUSALS.createInFlight );
				return false;
			}
			// Until the call settles, or the turn ends for a call run without a
			// guarded host.
			creatingCall = toolCallId;
			const settled = callSignals.get( toolCallId ) ?? signal;
			const done = () => {
				if ( creatingCall === toolCallId ) creatingCall = undefined;
			};
			if ( settled.aborted ) done();
			else settled.addEventListener( 'abort', done, { once: true } );
		}
		const operationClass = rule.classify ? rule.classify( args ) : rule.operationClass;
		if ( ! operationClass ) return false;
		let site: HostSite | undefined;
		if ( rule.site ) {
			const reference = rule.site( args );
			site = reference ? await resolveTarget( host, reference ) : undefined;
			if ( ! site ) return false;
		}
		let localPaths: string[] = [];
		if ( rule.paths ) {
			const paths = rule.paths( args, site?.path );
			if ( ! paths ) {
				refuse( toolCallId, REFUSALS.siteFiles );
				return false;
			}
			localPaths = paths;
		}
		// The files the call names in Studio's payload folder, which the tool
		// reads and sends: only under an approval of the call that shows them.
		const payload = rule.payloads ? rule.payloads( args ) : { folder: '', files: [] };
		if (
			! payload ||
			( payload.files.length && ( rule.approval !== 'tool' || ! asksFirst( operationClass ) ) )
		) {
			refuse( toolCallId, REFUSALS.payloads );
			return false;
		}
		// The files the tool writes itself lie in the site the turn acts on, what
		// it reads of Studio's own files and configuration is still Studio's own,
		// out of the conversation's reach, and the payload files it sends are in
		// the payload folder.
		const filesHold = async () => {
			const folder = actingSite?.path;
			for ( const file of localPaths )
				if ( ! folder || ! ( await isInsideCanonicalRoot( folder, file ) ) ) {
					refuse(
						toolCallId,
						path.isAbsolute( file ) && ! isJudgeable( file )
							? REFUSALS.plainPath
							: REFUSALS.siteFiles
					);
					return false;
				}
			if ( rule.bundled && ! ( await isBundledFolder( rule.bundled(), context.localRoots ) ) )
				return false;
			for ( const file of rule.config?.() ?? [] )
				if ( ! ( await isOutsideReach( file, context.localRoots ) ) ) return false;
			if ( payload.files.length && ! ( await inPayloadFolder( payload ) ) ) {
				refuse( toolCallId, REFUSALS.payloads );
				return false;
			}
			return true;
		};
		if ( ! ( await filesHold() ) ) return false;
		let remote: string | undefined;
		if ( rule.urls ) {
			const urls = rule.urls( args, site?.url );
			if ( ! urls ) return false;
			for ( const url of urls ) {
				const origin = await reachableOrigin( host, url, rule.urlsOnSite === true );
				if ( ! origin ) return false;
				remote ??= origin;
			}
		}
		// What an approval shows of the call: its arguments, or for a call that
		// reaches WordPress.com the request as it is sent, never its arguments,
		// which can carry a body, query values or file contents.
		let shown: unknown = args;
		// The WordPress.com site a call changes, if it changes one.
		let wpcomChange: number | undefined;
		if ( rule.remote ) {
			const scope = rule.remote( args );
			if ( ! scope ) {
				refuse( toolCallId, REFUSALS.wpcomRequest );
				return false;
			}
			if ( scope.wpcomSiteId !== undefined ) {
				const target = actingTarget;
				if ( target.environment !== 'live' || target.wpcomSiteId !== scope.wpcomSiteId ) {
					refuse( toolCallId, REFUSALS.wpcomSite );
					return false;
				}
				remote = `WordPress.com site ${ scope.wpcomSiteId }`;
				if ( ! isClaudeReadOnlyClass( operationClass ) ) wpcomChange = scope.wpcomSiteId;
			}
			shown = scope.request ?? {};
		}
		// The WordPress.com login the call acts under, by its user id: for a
		// change to a WordPress.com site, the login that site is connected to the
		// site the turn acts on under; for any other call the user approves that
		// reads the stored login, the one in force, or none, when the user is
		// asked. It must still be that login once the user has answered, before
		// anything is journaled, and again as the last step before the tool runs.
		const underLogin =
			wpcomChange !== undefined ||
			( rule.config !== undefined && rule.approval === 'tool' && asksFirst( operationClass ) );
		let login: number | undefined;
		if ( wpcomChange !== undefined ) {
			login = await changeLogin( toolCallId, wpcomChange );
			if ( login === undefined ) return false;
		} else if ( underLogin ) login = await storedLogin();
		const loginHolds = async () => {
			if ( ! underLogin ) return true;
			if ( wpcomChange !== undefined )
				return ( await changeLogin( toolCallId, wpcomChange, login ) ) !== undefined;
			if ( ( await storedLogin() ) === login ) return true;
			refuse( toolCallId, REFUSALS.wpcomLogin );
			return false;
		};
		const described = describeClaudeOperation( operationClass, name );
		const description = noticed(
			operationClass,
			rule.note ? `${ described }. ${ rule.note }` : described
		);
		let authorized: boolean;
		// A tool approved at its host operations is journaled here too: the
		// host operations it reaches are journaled again as they run.
		if ( ! asksFirst( operationClass ) || rule.approval === 'host' )
			authorized =
				( await checkpoint( callSignal ) ) &&
				( await loginHolds() ) &&
				( await admit( { tool: name, operationClass, description }, toolCallId, callSignal ) );
		else {
			// An approval shows the files the rule names; one that names none for
			// this call would ask about files without showing them.
			if ( rule.paths && ! localPaths.length ) return false;
			authorized = await approveOnce(
				{
					tool: name,
					operationClass,
					args: shown,
					siteId: site?.id,
					localPaths: [ ...localPaths, ...payload.files ],
					remote,
					description,
				},
				toolCallId,
				callSignal,
				loginHolds
			);
		}
		// The tool writes its files itself once this returns, so they are checked
		// again last: a link planted meanwhile, while the user read an approval,
		// is not followed. The login too, which the tool reads itself once this
		// returns. Like the fence before a command starts, this comes after the
		// call is journaled.
		const admitted = authorized && ( await filesHold() ) && ( await loginHolds() );
		if ( admitted && ! signal.aborted && ! callSignal?.aborted )
			admittedCalls.set( toolCallId, name );
		return admitted;
	}

	async function prepare(
		host: StudioAgentHost,
		request: HostRequest,
		toolCallId: string,
		callSignal?: AbortSignal
	): Promise< PreparedHostOperation | undefined > {
		const operationClass =
			request.name === 'sites.wpCli'
				? classifyWpCliArgs( request.args )
				: HOST_OPERATION_CLASSES[ request.name ];
		if ( ! operationClass ) {
			if ( request.name === 'sites.wpCli' )
				refuse( toolCallId, `${ REFUSALS.wpCli } ${ claudeRouteNote( 'wp_cli' ) }` );
			return;
		}
		let site: HostSite | undefined;
		const localPaths = [ ...( request.localPaths ?? [] ) ];
		if ( request.site ) {
			site = await resolveTarget( host, request.site.path );
			const targetSite = actingSite;
			if ( ! site || site.id !== request.site.id || ! targetSite ) return;
			localPaths.unshift( targetSite.path );
		} else if ( request.name === 'sites.create' ) {
			// Only a conversation without a site creates one; a conversation works
			// on one site and needs a new conversation for another.
			const sitePath = request.args[ 1 ];
			const siteRefused = siteRefusal( true );
			if ( siteRefused ) {
				refuse( toolCallId, siteRefused );
				return;
			}
			if (
				typeof sitePath !== 'string' ||
				! path.isAbsolute( sitePath ) ||
				path.dirname( path.resolve( sitePath ) ) !== path.resolve( host.sitesRoot )
			)
				return;
		} else if ( context.target.environment === 'global' ) {
			// An operation bound to no site follows the target the turn was sent
			// with: a site this turn created binds site-bound calls only.
			if ( 'preview' in request ) refuse( toolCallId, REFUSALS.preview );
			return;
		}
		let args = request.args;
		let file: HostFile< string > | undefined;
		if ( request.file ) {
			const checked = await conversationFile( request.file );
			if ( ! checked ) {
				// An absolute path no check can judge may look inside, so its form is the reason.
				const named = request.file.path;
				refuse(
					toolCallId,
					typeof named === 'string' && path.isAbsolute( named ) && ! isJudgeable( named )
						? REFUSALS.plainPath
						: REFUSALS.outsideFolders
				);
				return;
			}
			file = { path: checked, existing: request.file.existing };
			args = [ checked, ...args ];
			localPaths.push( checked );
		}
		let preview: TargetPreview | undefined;
		let remote = request.remote;
		if ( request.scratch && ! ( await scratchOutsideReach() ) ) {
			refuse( toolCallId, REFUSALS.scratch );
			return;
		}
		// An operation on WordPress.com is prepared, and so asked about, under
		// the login Studio is signed in with, and what binds it is read under
		// that login, from files that must lie out of the turn's reach.
		let login: number | undefined;
		if ( WPCOM_OPERATIONS.has( request.name ) ) {
			if ( ! ( await storesOutsideReach( 'preview' in request ) ) ) {
				refuse( toolCallId, REFUSALS.stores );
				return;
			}
			login = await storedLogin();
			if ( login === undefined ) {
				refuse( toolCallId, REFUSALS.wpcomLogin );
				return;
			}
		}
		if ( 'preview' in request ) {
			const found = await targetPreview( host, request.preview );
			if ( ! found ) {
				refuse( toolCallId, REFUSALS.preview );
				return;
			}
			if ( found.login !== login ) {
				refuse( toolCallId, REFUSALS.wpcomLogin );
				return;
			}
			preview = found.preview;
			args = [ preview.url, ...args ];
			remote = preview.url;
		}
		let wpcomSite: SyncSite | undefined;
		let syncOptions: string[] | undefined;
		if ( 'wpcomSite' in request ) {
			const connected = await connectedRemote( request.wpcomSite );
			if ( ! connected ) {
				refuse( toolCallId, REFUSALS.remoteSite );
				return;
			}
			if ( connected.login !== login ) {
				refuse( toolCallId, REFUSALS.wpcomLogin );
				return;
			}
			wpcomSite = connected.site;
			syncOptions = syncSelection( request.syncOptions );
			if ( ! syncOptions ) {
				refuse( toolCallId, REFUSALS.syncOptions );
				return;
			}
			// The approval shows which way the copy goes, the WordPress.com site
			// as Studio keeps its connection, so a production site and its
			// staging copy read differently, and what the copy overwrites where
			// it lands.
			args = [
				{
					direction: request.name === 'sync.pull' ? 'pull' : 'push',
					remoteSite: shownConnection( wpcomSite ),
					overwrites: syncOptions.map( ( option ) => SYNC_OVERWRITES[ option ] ),
				},
				...args,
			];
			remote = connectionLabel( wpcomSite );
		}
		if ( request.defaultPull && isReprintPullEnabled() ) {
			refuse( toolCallId, REFUSALS.reprintPull );
			return;
		}
		if ( ! ( await checkpoint( callSignal ) ) ) return;
		// The only WP-CLI command this build runs with approval is the bounded draft.
		const draftTitle =
			request.name === 'sites.wpCli' && operationClass === 'command'
				? wpCliOption( request.args, 'post_title' )
				: undefined;
		const described = describeClaudeOperation( operationClass, request.name );
		const note =
			wpcomSite && syncOptions
				? syncNote(
						request.name === 'sync.pull' ? 'sync.pull' : 'sync.push',
						wpcomSite,
						syncOptions
				  )
				: request.note;
		const operation: ClaudeOperation = {
			tool: request.name,
			operationClass,
			args,
			siteId: site?.id,
			localPaths,
			remote,
			description:
				draftTitle !== undefined && site
					? 'Create a draft post on the current local site'
					: noticed( operationClass, note ? `${ described }. ${ note }` : described ),
			...( draftTitle !== undefined && site
				? {
						draft: {
							siteName: site.name,
							title: draftTitle,
							content: wpCliOption( request.args, 'post_content' ),
						},
				  }
				: {} ),
		};
		const prepared = {
			operation,
			site,
			file,
			preview,
			scratch: request.scratch,
			wpcomSite,
			syncOptions: syncOptions?.join( ',' ),
			defaultPull: request.defaultPull,
			login,
		};
		if ( ! asksFirst( operationClass ) ) return prepared;
		const grant = await requestApproval( operation, toolCallId, callSignal );
		return grant ? { ...prepared, grant } : undefined;
	}

	// Whether the files Studio decides an operation on WordPress.com by lie out
	// of the turn's reach, so nothing the conversation writes is read as
	// Studio's own: its shared configuration, which holds the login and the
	// connections, and for an operation on a preview, the CLI's configuration,
	// which holds the previews.
	async function storesOutsideReach( previews: boolean ): Promise< boolean > {
		try {
			return (
				( await isOutsideReach( getSharedConfigPath(), context.localRoots ) ) &&
				( ! previews || ( await isOutsideReach( getCliConfigPath(), context.localRoots ) ) )
			);
		} catch {
			return false;
		}
	}

	// The WordPress.com login Studio is signed in with, by its user id, read
	// from the login Studio stores in its shared configuration, which must lie
	// out of the turn's reach; never its name or e-mail. Undefined when there
	// is none, or it cannot be read.
	async function storedLogin(): Promise< number | undefined > {
		try {
			if ( ! ( await isOutsideReach( getSharedConfigPath(), context.localRoots ) ) ) return;
			const id = await getCurrentUserId();
			return typeof id === 'number' && Number.isSafeInteger( id ) && id > 0 ? id : undefined;
		} catch {
			return;
		}
	}

	// Reads what Studio keeps for the login it is signed in with, under that
	// login: its user id is read before and after, and must be the same, so
	// what was read is that login's. Undefined when Studio is signed in with no
	// login, the login changed meanwhile, or the read fails.
	async function readUnderLogin< T >(
		read: () => Promise< T >
	): Promise< { login: number; value: T } | undefined > {
		const login = await storedLogin();
		if ( login === undefined ) return;
		try {
			const value = await read();
			return ( await storedLogin() ) === login ? { login, value } : undefined;
		} catch {
			return;
		}
	}

	// The WordPress.com sites Studio keeps as connected to the site the turn
	// acts on for the login it is signed in with, and that login.
	async function loginConnections(): Promise<
		{ login: number; connections: SyncSite[] } | undefined
	> {
		const targetSite = actingSite;
		if ( actingTarget.environment === 'global' || ! targetSite ) return;
		const read = await readUnderLogin( () => getConnectedWpcomSitesForLocalSite( targetSite.id ) );
		return (
			read && {
				login: read.login,
				connections: read.value.filter( ( connected ) => connected.localSiteId === targetSite.id ),
			}
		);
	}

	// The login a change to a WordPress.com site goes out under: the one Studio
	// is signed in with, which must be `expected` when one is given, with that
	// site connected to the site the turn acts on under it. Refused, saying
	// why, otherwise.
	async function changeLogin(
		toolCallId: string,
		wpcomSiteId: number,
		expected?: number
	): Promise< number | undefined > {
		const login = await storedLogin();
		if ( login === undefined || ( expected !== undefined && login !== expected ) ) {
			refuse( toolCallId, REFUSALS.wpcomLogin );
			return;
		}
		const connected = await loginConnections();
		if ( connected && connected.login !== login ) {
			refuse( toolCallId, REFUSALS.wpcomLogin );
			return;
		}
		if ( ! connected?.connections.some( ( site ) => site.id === wpcomSiteId ) ) {
			refuse( toolCallId, REFUSALS.wpcomConnection );
			return;
		}
		return login;
	}

	// The WordPress.com site a push or pull may sync with, by the numeric ID or
	// address the caller named, decided as the CLI finds a site by either: the
	// one connection of the site the turn acts on that matches, which in a
	// conversation on a live site must be that site, read from the connections
	// Studio keeps for the login it is signed in with. That connection as
	// Studio keeps it, and that login; or undefined.
	async function connectedRemote(
		named: unknown
	): Promise< { login: number; site: SyncSite } | undefined > {
		const target = actingTarget;
		if ( typeof named !== 'string' ) return;
		const connected = await loginConnections();
		if ( ! connected ) return;
		try {
			const byId = /^[1-9][0-9]*$/.test( named );
			const matching = connected.connections.filter( ( site ) =>
				byId
					? site.id === Number( named )
					: normalizeSiteAddress( site.url ) === normalizeSiteAddress( named )
			);
			const [ site ] = matching;
			if (
				matching.length !== 1 ||
				! Number.isSafeInteger( site.id ) ||
				site.id <= 0 ||
				( target.environment === 'live' && target.wpcomSiteId !== site.id )
			)
				return;
			return { login: connected.login, site };
		} catch {
			return;
		}
	}

	// Whether the system's temporary folder, where a command keeps the archive
	// it sends or receives, lies outside every folder the turn reaches, so
	// nothing the conversation writes can be a link the command follows there.
	function scratchOutsideReach(): Promise< boolean > {
		return isOutsideReach( os.tmpdir(), context.localRoots );
	}

	// The preview of the site the turn acts on that an address names: the one
	// preview of that site the host lists at exactly that address, as the CLI
	// finds a preview by its address, read under the login Studio is signed in
	// with, which the host lists that site's previews for, from a store that
	// lies out of the turn's reach; and that login. Undefined for anything
	// else, or when the site or its previews cannot be read.
	async function targetPreview(
		host: StudioAgentHost,
		named: unknown
	): Promise< { login: number; preview: TargetPreview } | undefined > {
		const targetSite = actingSite;
		if (
			typeof named !== 'string' ||
			actingTarget.environment === 'global' ||
			! targetSite ||
			! ( await storesOutsideReach( true ) )
		)
			return;
		const site = await resolveTarget( host, targetSite.path );
		if ( ! site ) return;
		const listed = await readUnderLogin( () => host.previews.list( site ) );
		if ( ! listed || ! Array.isArray( listed.value ) ) return;
		const matching = listed.value.filter( ( preview ) => preview?.url === named );
		if (
			matching.length !== 1 ||
			matching[ 0 ].localSiteId !== site.id ||
			! Number.isSafeInteger( matching[ 0 ].atomicSiteId )
		)
			return;
		return {
			login: listed.login,
			preview: { url: matching[ 0 ].url, atomicSiteId: matching[ 0 ].atomicSiteId },
		};
	}

	// The path a file a host operation reads (`existing`) or writes resolves to,
	// once links and short names are resolved, when it lies in the
	// conversation's own folders, outside the native configuration and clear of
	// credential files; undefined otherwise.
	async function conversationFile( {
		path: file,
		existing,
	}: HostFile ): Promise< string | undefined > {
		if ( typeof file !== 'string' ) return;
		const { localRoots, workspace } = context;
		return existing
			? resolveAllowedPath( file, localRoots, workspace.configDirectory )
			: resolveAllowedNewPath( file, localRoots, workspace.configDirectory );
	}

	// Whether every file a call names in the payload folder exists there once
	// links and short names are resolved, outside the native configuration and
	// clear of names that commonly hold credentials. The folder must resolve to
	// itself: one that is, or lies under, a link leads somewhere else, a site's
	// folder perhaps, whose files would pass for payloads under a path the
	// approval would show unresolved.
	async function inPayloadFolder( {
		folder,
		files,
	}: {
		folder: string;
		files: readonly string[];
	} ): Promise< boolean > {
		const root = await realpath( folder ).catch( () => undefined );
		const named = path.resolve( folder );
		if (
			! root ||
			( process.platform === 'win32' ? root.toLowerCase() !== named.toLowerCase() : root !== named )
		)
			return false;
		for ( const file of files )
			if ( ! ( await isAllowedNativePath( file, [ root ], context.workspace.configDirectory ) ) )
				return false;
		return true;
	}

	async function fence(
		host: StudioAgentHost,
		prepared: PreparedHostOperation,
		toolCallId: string,
		callSignal?: AbortSignal
	): Promise< boolean > {
		if ( ! ( await checkpoint( callSignal ) ) ) return false;
		const targetSite = actingSite;
		try {
			if ( prepared.site && ( await realpath( prepared.site.path ) ) !== targetSite?.path )
				return false;
			// The file is checked again, since a link can have moved under it: the
			// path the operation receives must still resolve to itself.
			if ( prepared.file && ( await conversationFile( prepared.file ) ) !== prepared.file.path )
				return false;
			// An operation on WordPress.com runs only while what it was decided by
			// is still out of the turn's reach, and under the login it was
			// prepared, and asked about, under.
			if (
				prepared.login !== undefined &&
				! ( await storesOutsideReach( prepared.preview !== undefined ) )
			) {
				refuse( toolCallId, REFUSALS.stores );
				return false;
			}
			if ( prepared.login !== undefined && ( await storedLogin() ) !== prepared.login ) {
				refuse( toolCallId, REFUSALS.wpcomLogin );
				return false;
			}
			// The preview too: its address must still name the same preview of the
			// site the turn acts on, under that login.
			if ( prepared.preview ) {
				const current = await targetPreview( host, prepared.preview.url );
				if (
					current?.preview.atomicSiteId !== prepared.preview.atomicSiteId ||
					current.login !== prepared.login
				)
					return false;
			}
			if ( prepared.scratch && ! ( await scratchOutsideReach() ) ) {
				refuse( toolCallId, REFUSALS.scratch );
				return false;
			}
			// The host chooses a pull's engine as its command starts.
			if ( prepared.defaultPull && isReprintPullEnabled() ) return false;
			// And the WordPress.com site: still connected to the site the turn acts
			// on under that login.
			if ( prepared.wpcomSite !== undefined ) {
				const current = await connectedRemote( String( prepared.wpcomSite.id ) );
				if ( current?.site.id !== prepared.wpcomSite.id || current.login !== prepared.login )
					return false;
			}
			if (
				WP_CLI_OPERATIONS.has( prepared.operation.tool ) &&
				( ! targetSite || ( await hasWpCliOverrides( targetSite.path ) ) )
			)
				return false;
		} catch {
			return false;
		}
		return ! signal.aborted && ! callSignal?.aborted;
	}

	// Whether a site the host resolved may be handed to a tool: the site the
	// turn acts on, or a site this turn created, which the creating tool
	// resolves to report it.
	async function isReachableSite( site: HostSite ): Promise< boolean > {
		if ( createdSites.has( path.resolve( site.path ) ) ) return true;
		const target = actingTarget;
		const targetSite = actingSite;
		if ( target.environment === 'global' || ! targetSite || site.id !== target.siteId )
			return false;
		try {
			return ( await realpath( site.path ) ) === targetSite.path;
		} catch {
			return false;
		}
	}

	// Whether a site may become the conversation's site: one this turn created,
	// from a conversation without a site, that the host still knows by that id
	// at that folder. Once one has become it, only that one: a conversation
	// works on one site.
	async function isCreatedSite(
		host: StudioAgentHost,
		site: { id?: unknown; path?: unknown }
	): Promise< boolean > {
		if (
			context.workspace.siteId !== null ||
			typeof site.id !== 'string' ||
			! site.id ||
			typeof site.path !== 'string' ||
			! createdSites.has( path.resolve( site.path ) ) ||
			( actingTarget.environment !== 'global' && actingSite?.id !== site.id )
		)
			return false;
		try {
			return ( await host.sites.findByFolder( site.path ) )?.id === site.id;
		} catch {
			return false;
		}
	}

	function guardHost(
		host: StudioAgentHost,
		toolCallId: string,
		callSignal?: AbortSignal
	): StudioAgentHost {
		const operationSignal = callSignal ? AbortSignal.any( [ signal, callSignal ] ) : signal;
		if ( ! operationSignal.aborted ) {
			callSignals.set( toolCallId, operationSignal );
			operationSignal.addEventListener(
				'abort',
				() => {
					if ( callSignals.get( toolCallId ) === operationSignal ) {
						callSignals.delete( toolCallId );
						admittedCalls.delete( toolCallId );
					}
				},
				{ once: true }
			);
		}
		const run = async < T >(
			request: HostRequest,
			execute: (
				site: HostSite | undefined,
				options: HostOperationOptions,
				operation: ClaudeOperation,
				checked: CheckedHostValues
			) => Promise< T >
		): Promise< T > => {
			const prepared = await prepare( host, request, toolCallId, callSignal );
			if ( ! prepared || ! ( await fence( host, prepared, toolCallId, callSignal ) ) )
				throw denied();
			if (
				( prepared.grant &&
					! ( await authorizeExecution(
						prepared.grant,
						prepared.operation,
						toolCallId,
						callSignal
					) ) ) ||
				! ( await admit( prepared.operation, toolCallId, callSignal, prepared.grant?.requestId ) )
			)
				throw denied();
			operationSignal.throwIfAborted();
			return execute(
				prepared.site,
				{
					signal: operationSignal,
					beforeSpawn: async () => {
						if ( ! ( await fence( host, prepared, toolCallId, callSignal ) ) ) throw denied();
					},
				},
				prepared.operation,
				{
					file: prepared.file?.path,
					preview: prepared.preview?.url,
					wpcomSite: prepared.wpcomSite === undefined ? undefined : String( prepared.wpcomSite.id ),
					syncOptions: prepared.syncOptions,
				}
			);
		};
		// A read a tool makes of a site: of a site it may reach, under the turn's
		// authority, while the call lives.
		const reading = async < T >( site: HostSite, read: () => Promise< T > ): Promise< T > => {
			if (
				operationSignal.aborted ||
				! ( await isReachableSite( site ) ) ||
				! ( await checkpoint( callSignal ) )
			)
				throw denied();
			operationSignal.throwIfAborted();
			return read();
		};
		// A listing of every local site, or of the WordPress.com sites the stored
		// login reaches: only inside a call the policy admitted of a tool whose
		// rule lists them, in a conversation without a site, which works on none
		// yet, under the turn's authority, while the call lives.
		const listing = async < T >( list: () => Promise< T > ): Promise< T > => {
			const tool = admittedCalls.get( toolCallId );
			if (
				operationSignal.aborted ||
				! tool ||
				CLAUDE_STUDIO_TOOL_RULES.get( tool )?.lists !== true ||
				hasSite() ||
				! ( await checkpoint( callSignal ) )
			)
				throw denied();
			operationSignal.throwIfAborted();
			if ( hasSite() ) throw denied();
			return list();
		};
		// What no qualified tool needs is refused: every site's full details, and
		// analytics.
		const refused = async (): Promise< never > => {
			throw denied();
		};
		// The attachments this call reserved in the media library of the site the
		// turn acts on: only this call completes or deletes them, each once.
		const reservedAttachments = new Set< number >();
		// One of the media library's fixed WP-CLI commands, Studio's own code, run
		// as the turn runs every WP-CLI command, without the site's own code.
		const mediaCommand = async (
			site: HostSite,
			args: string[],
			options: HostOperationOptions
		): Promise< string > => {
			const { exitCode, stdout } = await host.sites.wpCli(
				site,
				[ ...args, ...WP_CLI_ISOLATION ],
				options
			);
			if ( exitCode !== 0 ) throw new Error( `WP-CLI exited with code ${ exitCode }` );
			return stdout;
		};
		// A change of the conversation's site, to a site this turn created: asked
		// about when the turn asks before every change, journaled, then made.
		const changeSite = async (
			name: 'selectSite' | 'ui.showArtifact',
			site: { id?: string; path: string },
			description: string,
			make: ( siteId: string ) => Promise< void >
		): Promise< void > => {
			if ( operationSignal.aborted ) throw denied();
			const siteId = site.id;
			if ( typeof siteId !== 'string' || ! ( await isCreatedSite( host, site ) ) ) {
				refuse( toolCallId, REFUSALS.siteBinding );
				throw denied();
			}
			if ( ! ( await checkpoint( callSignal ) ) ) throw denied();
			const operationClass = HOST_OPERATION_CLASSES[ name ];
			const operation: ClaudeOperation = {
				tool: name,
				operationClass,
				args: [ siteId ],
				siteId,
				localPaths: [ site.path ],
				description: noticed( operationClass, description ),
			};
			let grant: ClaudeApprovalGrant | undefined;
			if ( asksFirst( operationClass ) ) {
				grant = await requestApproval( operation, toolCallId, callSignal );
				// The site is checked again once the user has answered.
				if (
					! grant ||
					! ( await authorizeExecution( grant, operation, toolCallId, callSignal ) ) ||
					! ( await isCreatedSite( host, site ) )
				)
					throw denied();
			}
			if ( ! ( await admit( operation, toolCallId, callSignal, grant?.requestId ) ) )
				throw denied();
			operationSignal.throwIfAborted();
			siteChanged = true;
			await make( siteId );
		};
		const { ui } = host;
		return {
			...host,
			wpcom: { sites: ( accessToken ) => listing( () => host.wpcom.sites( accessToken ) ) },
			tracks: { record: refused },
			// What a call shows in the conversation is written to the chat's record,
			// so it stops with the call's authority. An artifact the run manager
			// binds the chat to a site with changes the conversation's site, as
			// `selectSite` does, so it shows only a site this turn created, once
			// that change is journaled.
			ui: ui && {
				showArtifact: async ( artifact ) => {
					if ( operationSignal.aborted ) throw denied();
					const binding = getCreatedSiteFromArtifact( artifact );
					if ( ! binding ) return ui.showArtifact( artifact );
					await changeSite(
						'ui.showArtifact',
						{ id: binding.siteId, path: binding.sitePath },
						'Show a site this turn created in the conversation, which then stays with that site',
						async () => {
							await ui.showArtifact( artifact );
						}
					);
				},
				reloadPreview: () => {
					if ( ! operationSignal.aborted ) ui.reloadPreview();
				},
			},
			sites: {
				...host.sites,
				resolve: async ( reference ) => {
					const site = await host.sites.resolve( reference );
					if ( ! ( await isReachableSite( site ) ) ) throw denied();
					return site;
				},
				findByFolder: async ( folder ) => {
					const site = await host.sites.findByFolder( folder );
					if ( site && ! ( await isReachableSite( site ) ) ) throw denied();
					return site;
				},
				all: refused,
				list: () => listing( async () => ( await host.sites.list() ).map( listedSite ) ),
				status: ( site ) => reading( site, () => host.sites.status( site ) ),
				isRunning: ( site ) => reading( site, () => host.sites.isRunning( site ) ),
				create: ( name, sitePath, onProgress ) =>
					run(
						{ name: 'sites.create', args: [ name, sitePath ], localPaths: [ sitePath ] },
						async ( _site, options ) => {
							await host.sites.create( name, sitePath, onProgress, options );
							createdSites.add( path.resolve( sitePath ) );
						}
					),
				start: ( site, onProgress ) =>
					run( { name: 'sites.start', site, args: [] }, ( current, options ) =>
						host.sites.start( current!, onProgress, options )
					),
				stop: ( site, onProgress ) =>
					run( { name: 'sites.stop', site, args: [] }, ( current, options ) =>
						host.sites.stop( current!, onProgress, options )
					),
				delete: ( site, deleteFiles, onProgress ) =>
					run( { name: 'sites.delete', site, args: [ deleteFiles ] }, ( current, options ) =>
						host.sites.delete( current!, deleteFiles, onProgress, options )
					),
				import: ( site, file, onProgress ) =>
					run(
						{ name: 'sites.import', site, args: [], file: { path: file, existing: true } },
						( current, options, _operation, checked ) =>
							host.sites.import( current!, checked.file!, onProgress, options )
					),
				export: ( site, file, mode, onProgress ) =>
					run(
						{ name: 'sites.export', site, args: [ mode ], file: { path: file, existing: false } },
						( current, options, _operation, checked ) =>
							host.sites.export( current!, checked.file!, mode, onProgress, options )
					),
				wpCli: ( site, args ) =>
					run( { name: 'sites.wpCli', site, args: [ ...args ] }, ( current, options, operation ) =>
						host.sites.wpCli(
							current!,
							[ ...( operation.args as readonly string[] ), ...WP_CLI_ISOLATION ],
							options
						)
					),
			},
			previews: {
				...host.previews,
				list: ( site ) => reading( site, () => host.previews.list( site ) ),
				// A new preview of the site the turn acts on, from the archive the CLI's
				// `preview create` makes of it.
				create: ( site, onProgress ) =>
					run(
						{
							name: 'previews.create',
							site,
							args: [],
							remote: 'A new preview site on WordPress.com',
							scratch: true,
							note: 'It uploads a copy of this site’s content, its database included, to a new preview site on WordPress.com, which anyone with the preview’s public address can see',
						},
						( current, options ) => host.previews.create( current!, onProgress, options )
					),
				// A preview of the site the turn acts on, by its address, as that site's
				// own previews list it; checked again immediately before the command.
				// An update comes only from the site the preview was made from, so the
				// CLI's own check of that holds too.
				update: async ( site, hostname, overwrite, onProgress ) => {
					if ( overwrite !== false ) {
						refuse( toolCallId, REFUSALS.previewOverwrite );
						throw denied();
					}
					return run(
						{
							name: 'previews.update',
							site,
							args: [],
							preview: hostname,
							scratch: true,
							note: 'It replaces what a preview of this site on WordPress.com shows with the site’s current content, its database included, which anyone with the preview’s public address can see',
						},
						( current, options, _operation, checked ) =>
							host.previews.update( current!, checked.preview!, false, onProgress, options )
					);
				},
				delete: ( hostname, onProgress ) =>
					run(
						{
							name: 'previews.delete',
							args: [],
							preview: hostname,
							note: 'It deletes a preview of this site from WordPress.com',
						},
						( _site, options, _operation, checked ) =>
							host.previews.delete( checked.preview!, onProgress, options )
					),
			},
			sync: {
				// The site the turn acts on, to a WordPress.com site connected to it,
				// with the options checked; the CLI's `push` receives both as checked,
				// never a remote left for it to pick.
				push: ( site, options, remoteSite, onProgress ) =>
					run(
						{
							name: 'sync.push',
							site,
							args: [],
							wpcomSite: remoteSite,
							syncOptions: options,
							scratch: true,
						},
						( current, fenceOptions, _operation, checked ) =>
							host.sync.push(
								current!,
								checked.syncOptions!,
								checked.wpcomSite!,
								onProgress,
								fenceOptions
							)
					),
				// A WordPress.com site connected to the site the turn acts on, into that
				// site, bound as a push is, by the CLI's default engine only.
				pull: ( site, options, remoteSite, onProgress ) =>
					run(
						{
							name: 'sync.pull',
							site,
							args: [],
							wpcomSite: remoteSite,
							syncOptions: options,
							scratch: true,
							defaultPull: true,
						},
						( current, fenceOptions, _operation, checked ) =>
							host.sync.pull(
								current!,
								checked.syncOptions!,
								checked.wpcomSite!,
								onProgress,
								fenceOptions
							)
					),
			},
			// The media library's fixed operations, for `generate_images`: in the
			// site the turn acts on only, each WP-CLI command Studio's own code,
			// journaled before it runs. `sites.wpCli` still refuses `eval`.
			media: {
				siteContaining: async ( files ) => {
					const targetSite = actingSite;
					if (
						operationSignal.aborted ||
						! targetSite ||
						! Array.isArray( files ) ||
						! files.length
					)
						throw denied();
					for ( const file of files )
						if (
							typeof file !== 'string' ||
							! ( await isInsideCanonicalRoot( targetSite.path, file ) )
						)
							throw denied();
					const site = await resolveTarget( host, targetSite.path );
					if ( ! site || ! ( await checkpoint( callSignal ) ) ) throw denied();
					operationSignal.throwIfAborted();
					return site;
				},
				// The tool writes each image itself, at its attachment's file, so
				// every file must lie in the site the turn acts on; where WordPress
				// keeps the uploads elsewhere, the attachments are deleted again.
				reserve: async ( site, names ) => {
					if (
						! Array.isArray( names ) ||
						! names.length ||
						names.length > MAX_RESERVED_ATTACHMENTS ||
						! names.every( isImageFileName )
					)
						throw denied();
					const requested = [ ...names ];
					return run(
						{
							name: 'media.reserve',
							site,
							args: [ requested ],
							note: 'It adds an attachment for each image to this site’s media library, in the uploads folder WordPress picks, before the image is made',
						},
						async ( current, options ) => {
							const reserved = readReservedAttachments(
								await mediaCommand( current!, reserveAttachmentsArgs( requested ), options )
							);
							if ( ! isReservation( reserved, requested ) ) throw denied();
							const targetSite = actingSite;
							for ( const { file } of reserved )
								if (
									! targetSite ||
									! ( await isInsideCanonicalRoot(
										targetSite.path,
										path.join( current!.path, file )
									) )
								) {
									await mediaCommand(
										current!,
										finalizeAttachmentsArgs(
											[],
											reserved.map( ( { id } ) => id )
										),
										options
									).catch( () => undefined );
									refuse( toolCallId, REFUSALS.mediaUploads );
									throw denied();
								}
							for ( const { id } of reserved ) reservedAttachments.add( id );
							return reserved;
						}
					);
				},
				// Only attachments this call reserved, each once.
				finalize: async ( site, ready, failed ) => {
					const ids =
						Array.isArray( ready ) && Array.isArray( failed ) ? [ ...ready, ...failed ] : [];
					if (
						! ids.length ||
						new Set( ids ).size !== ids.length ||
						! ids.every( ( id ) => reservedAttachments.has( id ) )
					)
						throw denied();
					const completed = [ ...ready ];
					const removed = [ ...failed ];
					await run(
						{
							name: 'media.finalize',
							site,
							args: [ { ready: completed, failed: removed } ],
							note: 'It completes the attachments of this site’s images that were made, with their smaller sizes, and deletes those of the images that failed',
						},
						async ( current, options ) => {
							await mediaCommand(
								current!,
								finalizeAttachmentsArgs( completed, removed ),
								options
							);
							for ( const id of ids ) reservedAttachments.delete( id );
						}
					);
				},
			},
			// Makes a site this turn created the conversation's site. The turn's
			// checks accept the new target from before the change is written, and
			// only it once written (carry item 7); from then on the turn acts on
			// that site, at its canonical folder.
			selectSite: host.selectSite
				? async ( site ) => {
						const selectSite = host.selectSite!;
						await changeSite(
							'selectSite',
							site,
							'Make a site this turn created the conversation’s site',
							async ( siteId ) => {
								const target: ClaudeStudioTarget = { environment: 'local', siteId };
								await writeTarget( target, () => selectSite( site ) );
								// A folder that cannot be resolved binds nothing: calls on
								// the site are then refused, and the turn acts on no site.
								const folder = await realpath( site.path ).catch( () => undefined );
								if ( ! folder ) {
									refuse( toolCallId, REFUSALS.siteFolderMissing );
									return;
								}
								actingTarget = target;
								actingSite = { id: siteId, path: folder };
							}
						);
				  }
				: undefined,
		};
	}

	return {
		signal,
		studioTools: Object.freeze( [ ...studioTools ] ),
		authorizeToolUse,
		authorizeStudioCall,
		guardHost,
		requestApproval,
		authorizeExecution,
		refreshAccount: () => accountIsCurrent( false ),
		takeRefusals: ( toolCallId ) => {
			const reasons = [ ...( refusals.get( toolCallId ) ?? [] ) ];
			refusals.delete( toolCallId );
			return reasons;
		},
		dispose: () => controller.abort(),
	};
}
