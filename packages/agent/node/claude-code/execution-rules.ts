import { readdirSync } from 'fs';
import path from 'path';
import { getSharedConfigPath } from '@studio/common/lib/well-known-paths';
import { z } from 'zod';
import { IMAGE_NOT_GENERATED_CANCELLED } from '../image-generation';
import { getPayloadLimitViolation } from '../runtime/tool-safety';
import { getSkillPath } from '../skills';
import { createPreviewTool } from '../tools/create-preview';
import { createSiteTool } from '../tools/create-site';
import { deletePreviewTool } from '../tools/delete-preview';
import { deleteSiteTool } from '../tools/delete-site';
import { exportSiteTool } from '../tools/export-site';
import { generateImagesTool } from '../tools/generate-images';
import { importSiteTool } from '../tools/import-site';
import { inspectDesignTool } from '../tools/inspect-design';
import { installTaxonomyScriptsTool } from '../tools/install-taxonomy-scripts';
import { listConnectedRemoteSitesTool } from '../tools/list-connected-remote-sites';
import { listPreviewsTool } from '../tools/list-previews';
import { listSitesTool } from '../tools/list-sites';
import { auditPerformanceTool } from '../tools/need-for-speed';
import { openAnnotationBrowserTool } from '../tools/open-annotation-browser';
import { pickDesignTool } from '../tools/pick-design';
import { pullSiteTool } from '../tools/pull-site';
import { pushSiteTool } from '../tools/push-site';
import { auditSeoTool } from '../tools/rank-me-up';
import { refreshBrowserTool } from '../tools/refresh-browser';
import { scaffoldThemeSlug, scaffoldThemeTool } from '../tools/scaffold-theme';
import { sendFeedbackTool } from '../tools/send-feedback';
import { getSiteInfoTool } from '../tools/site-info';
import { startSiteTool } from '../tools/start-site';
import { stopSiteTool } from '../tools/stop-site';
import { takeScreenshotTool } from '../tools/take-screenshot';
import { updatePreviewTool } from '../tools/update-preview';
import { validateBlocksTool } from '../tools/validate-blocks';
import { runWpCliTool, splitCommandArgs } from '../tools/wp-cli';
import { wpcomRequestTool } from '../tools/wpcom-request';
import { isInside } from './local-paths';
import { hasOnlyKeys, hasOwn, plainData, plainList, plainStrings } from './plain-data';
import { classifyWpCliArgs, wpCliRouteCommands } from './wp-cli-rules';
import { wpcomBodyFiles, wpcomScope } from './wpcom-rules';
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk/core';
import type {
	FileEditInput,
	FileReadInput,
	FileWriteInput,
	GlobInput,
	GrepInput,
} from '@anthropic-ai/claude-agent-sdk/sdk-tools';
import type {
	ClaudeHostOperationName,
	ClaudeOperationClass,
	ClaudeStudioTarget,
} from '@studio/agent/protocol/claude-code';

// What each operation is, independent of any turn. The execution policy applies
// these rules immediately before execution.

export interface ClaudeEnabledTools {
	readonly native: readonly string[];
	readonly studio: readonly string[];
}

/**
 * What a Claude turn may run in this build. Widening it is a reviewed change,
 * and listing a Studio tool here is not enough: it runs only once its rule is
 * qualified.
 */
export const CLAUDE_ENABLED_TOOLS: ClaudeEnabledTools = Object.freeze( {
	native: Object.freeze( [ 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash' ] ),
	studio: Object.freeze( [
		runWpCliTool.name,
		getSiteInfoTool.name,
		listSitesTool.name,
		listPreviewsTool.name,
		createPreviewTool.name,
		updatePreviewTool.name,
		deletePreviewTool.name,
		listConnectedRemoteSitesTool.name,
		pushSiteTool.name,
		pullSiteTool.name,
		wpcomRequestTool.name,
		startSiteTool.name,
		stopSiteTool.name,
		deleteSiteTool.name,
		importSiteTool.name,
		exportSiteTool.name,
		installTaxonomyScriptsTool.name,
		refreshBrowserTool.name,
		createSiteTool.name,
		sendFeedbackTool.name,
		generateImagesTool.name,
		'Ls',
		scaffoldThemeTool.name,
		validateBlocksTool.name,
		takeScreenshotTool.name,
		inspectDesignTool.name,
		auditPerformanceTool.name,
		auditSeoTool.name,
		openAnnotationBrowserTool.name,
	] ),
} );

/** How long the user has to answer an approval. */
export const CLAUDE_APPROVAL_TIMEOUT_MS = 120_000;

/**
 * The PreToolUse hook's timeout, in seconds. A native approval waits inside the
 * hook, so the hook must outlast it; Claude Code blocks a tool call whose hook
 * times out.
 */
export const CLAUDE_HOOK_TIMEOUT_SECONDS = 180;

/**
 * How long an operation that needs no approval may rely on the last real check
 * of the native sign-in. Once it is older, the policy reads the sign-in again
 * before allowing anything, so no operation runs longer than this after the
 * stored account changes.
 */
export const CLAUDE_ACCOUNT_RECHECK_MS = 10_000;

/**
 * How shell commands are confined. A shell tool can be enabled only under a
 * mode the policy verifies: an SDK sandbox whose writes stay in the workspace,
 * or `approval-only`, where every command needs its own approval and the user
 * is told it is not confined.
 */
export type ClaudeShellConfinement =
	| { readonly mode: 'none' }
	| { readonly mode: 'approval-only' }
	| { readonly mode: 'sandbox'; readonly sandbox: SandboxSettings | undefined };

/** Used during discovery and when the turn has no qualified shell. */
export const CLAUDE_SHELL_CONFINEMENT: ClaudeShellConfinement = Object.freeze( { mode: 'none' } );

/**
 * The revision of what a navigation guard must guarantee: the origin rule and
 * the guarantees below. A guard built for an earlier revision does not verify.
 */
export const CLAUDE_NAVIGATION_RULE_REVISION = 2;

/**
 * What a browser-layer guard guarantees for every page a Studio tool opens. A
 * host name check cannot bind a browser: a public name can resolve to this
 * machine, and a page can redirect or load from anywhere. So a tool that
 * drives a browser can be enabled only under a guard declaring all of these,
 * for this rule revision and this turn's target.
 */
export interface ClaudeNavigationGuard {
	/** `CLAUDE_NAVIGATION_RULE_REVISION`. */
	readonly ruleRevision: number;
	/** The target site's own origin, or null for a global target. */
	readonly targetOrigin: string | null;
	/**
	 * Every HTTP, HTTPS and WebSocket request the browser sends for the tool
	 * passes the guard before it connects: navigations, frames, subresources,
	 * fetches, dedicated, shared and service workers, WebSockets and
	 * prefetches, not only the first URL. Anything else a page can open is
	 * `blocksUncheckedChannels`'s to stop.
	 */
	readonly checksEveryRequest: true;
	/** Each redirect hop is checked as a new request before it is followed. */
	readonly checksEveryRedirect: true;
	/**
	 * The policy's origin rule, on host names normalized as `normalizeHostname`
	 * does: http and https only, no credentials, and a local host name or a
	 * local site's host name only at `targetOrigin`. The one document
	 * `confinesFileDocuments` admits is the only exception to the scheme.
	 */
	readonly appliesOriginRule: true;
	/**
	 * The guard resolves every host name and refuses a loopback, unspecified,
	 * private, shared, link-local or unique-local address, in any IPv4 or IPv6
	 * form, unless the request is to `targetOrigin`.
	 */
	readonly checksResolvedAddresses: true;
	/** The browser connects only to the address the guard checked; nothing resolves the name again. */
	readonly pinsCheckedAddress: true;
	/**
	 * A `file:` URL loads only as the top-level document of a page the host
	 * itself wrote for the call, which names that exact URL to the guard.
	 * Everything that document then loads or opens (subresources, frames,
	 * workers, fetches and navigations) passes the same origin rule as any
	 * other request, so it reaches a local address only at `targetOrigin`, and
	 * a `file:` subresource, frame, worker or navigation is refused. No other
	 * page loads a `file:` URL at all.
	 */
	readonly confinesFileDocuments: true;
	/**
	 * Every way a page can reach the network other than the requests the guard
	 * checks is disabled or refused: WebRTC (ICE, STUN and TURN), WebTransport
	 * and QUIC, and any other channel the browser exposes. A request
	 * interceptor or a proxy does not see these, so checking requests is not
	 * enough.
	 */
	readonly blocksUncheckedChannels: true;
	/**
	 * A refused or unverifiable request fails, and the tool reports an error; a
	 * guard that cannot start stops the tool. Nothing is retried without it.
	 */
	readonly failsClosed: true;
}

export type ClaudeNavigationConfinement =
	| { readonly mode: 'none' }
	| { readonly mode: 'guarded'; readonly guard: ClaudeNavigationGuard | undefined };

/** Discovery and turns without a guarded Chromium omit browser tools. */
export const CLAUDE_NAVIGATION_CONFINEMENT: ClaudeNavigationConfinement = Object.freeze( {
	mode: 'none',
} );

export function claudeBrowserConfinement(
	targetOrigin: string | null
): ClaudeNavigationConfinement {
	return Object.freeze( {
		mode: 'guarded',
		guard: Object.freeze( {
			ruleRevision: CLAUDE_NAVIGATION_RULE_REVISION,
			targetOrigin,
			...navigationGuarantees,
		} ),
	} );
}

const navigationGuarantees = {
	checksEveryRequest: true,
	checksEveryRedirect: true,
	appliesOriginRule: true,
	checksResolvedAddresses: true,
	pinsCheckedAddress: true,
	confinesFileDocuments: true,
	blocksUncheckedChannels: true,
	failsClosed: true,
} satisfies Record< Exclude< keyof ClaudeNavigationGuard, 'ruleRevision' | 'targetOrigin' >, true >;
const NAVIGATION_GUARANTEES = Object.keys( navigationGuarantees );
const NAVIGATION_GUARD_KEYS: ReadonlySet< string > = new Set( [
	'ruleRevision',
	'targetOrigin',
	...NAVIGATION_GUARANTEES,
] );
const NAVIGATION_CONFINEMENT_KEYS: ReadonlySet< string > = new Set( [ 'mode', 'guard' ] );

/**
 * Whether a declared navigation guard can be verified: the declaration and its
 * guard are plain data that state every guarantee and nothing else, apply
 * this rule revision and are bound to this turn's target origin. Anything
 * else is unverified; a malformed declaration never throws.
 */
export function isVerifiedNavigationGuard(
	confinement: ClaudeNavigationConfinement,
	targetOrigin: string | null
): boolean {
	const declared = plainData( confinement );
	if (
		! declared ||
		declared.mode !== 'guarded' ||
		! hasOnlyKeys( declared, NAVIGATION_CONFINEMENT_KEYS ) ||
		( targetOrigin !== null && typeof targetOrigin !== 'string' )
	)
		return false;
	const guard = plainData( declared.guard );
	return (
		!! guard &&
		hasOnlyKeys( guard, NAVIGATION_GUARD_KEYS ) &&
		guard.ruleRevision === CLAUDE_NAVIGATION_RULE_REVISION &&
		guard.targetOrigin === targetOrigin &&
		NAVIGATION_GUARANTEES.every( ( key ) => guard[ key ] === true )
	);
}

/** The origin of a turn's target site, or null for a global target or a site without a URL. */
export function claudeTargetOrigin(
	target: ClaudeStudioTarget,
	targetSite: { url?: string } | undefined
): string | null {
	if ( target.environment !== 'local' || ! targetSite?.url ) return null;
	try {
		const { origin } = new URL( targetSite.url );
		return origin === 'null' ? null : origin;
	} catch {
		return null;
	}
}

const STUDIO_MCP_PREFIX = 'mcp__studio__';

const UNPROMPTED_CLASSES: ReadonlySet< ClaudeOperationClass > = new Set( [
	'read',
	'remote-read',
	'local-change',
] );

/**
 * Reads and ordinary local edits run without asking; everything that can delete
 * or overwrite work, reach beyond this machine with a change, send a message or
 * run an unstructured command needs the user's approval of that exact call.
 */
export function requiresClaudeApproval( operationClass: ClaudeOperationClass ): boolean {
	return ! UNPROMPTED_CLASSES.has( operationClass );
}

export function isRecord( value: unknown ): value is Record< string, unknown > {
	return !! value && typeof value === 'object' && ! Array.isArray( value );
}

/**
 * Every way a Studio tool's implementation can have an effect or learn
 * something outside the conversation:
 * - `readsLocalFiles`, `writesLocalFiles`: it reads, or creates, changes or
 *   deletes, local files itself.
 * - `drivesBrowser`: it opens or scripts a page in a browser.
 * - `requestsNetwork`: it or a helper composes and sends a network request,
 *   outside a browser.
 * - `spawnsProcess`: it starts a process itself, other than through a host
 *   operation.
 * - `runsWpCli`: it runs a WP-CLI command on a site.
 * - `callsHostOperation`: it calls an operation of the Studio host.
 * - `reachesWpcom`: it reads or changes something on WordPress.com.
 */
export const CLAUDE_TOOL_CHANNELS = Object.freeze( [
	'readsLocalFiles',
	'writesLocalFiles',
	'drivesBrowser',
	'requestsNetwork',
	'spawnsProcess',
	'runsWpCli',
	'callsHostOperation',
	'reachesWpcom',
] as const );

export type ClaudeToolChannel = ( typeof CLAUDE_TOOL_CHANNELS )[ number ];

/**
 * What bounds a channel a tool uses, immediately before it runs:
 * - `site`, `paths`, `urls`, `navigates`: that element of the tool's rule.
 * - `scope`: the rule's `remote` element.
 * - `class`: the rule's operation class, which asks the user to approve every
 *   exact call. A file channel takes it only next to `paths`, so the approval
 *   shows the files.
 * - `host`: the effect is a host operation, which runs only through
 *   `guardHost`.
 * - `bundled`: the rule's `bundled` element, a folder of files Studio ships
 *   itself, which the policy checks before every call. It bounds reading only.
 * - `config`: the rule's `config` element, files of Studio's own configuration
 *   at locations Studio fixes, which the policy checks before every call. It
 *   bounds reading only.
 * - `payloads`: the rule's `payloads` element, files a call names in Studio's
 *   payload folder, which the policy checks before every call and again as the
 *   last step before the tool runs, and which only an approval that shows them
 *   lets the tool read. It bounds reading only.
 */
export type ClaudeChannelBinding =
	| 'site'
	| 'paths'
	| 'urls'
	| 'navigates'
	| 'scope'
	| 'class'
	| 'host'
	| 'bundled'
	| 'config'
	| 'payloads'
	| 'directoryListing'
	| 'webRequests'
	| 'screenshots';

/** For every channel, `false` when the implementation does not use it, or what bounds it. */
export type ClaudeToolChannelDeclaration = {
	readonly [ Channel in ClaudeToolChannel ]: false | readonly ClaudeChannelBinding[];
};

/**
 * Whether a tool has been qualified to run. Having a rule does not qualify it:
 * a rule written before anyone traced the tool's implementation can miss a
 * route through it. So a tool is unqualified until a reviewed change records,
 * for every channel, that its implementation does not use it or what bounds
 * it. `unbound` names channels an unqualified tool is known to use that
 * nothing in its rule bounds yet.
 */
export type ClaudeToolQualification =
	| { readonly qualified: false; readonly unbound?: readonly ClaudeToolChannel[] }
	| { readonly qualified: true; readonly channels: ClaudeToolChannelDeclaration };

export interface ClaudeStudioToolRule {
	/** Whether the tool may be enabled at all. No host declaration replaces it. */
	readonly qualification: ClaudeToolQualification;
	/** The class, or for a tool classified by its arguments the widest class it can reach. */
	readonly operationClass: ClaudeOperationClass;
	/** Narrows the class from a call's arguments; undefined denies the call. */
	readonly classify?: ( args: unknown ) => ClaudeOperationClass | undefined;
	/** Studio's directory listing checks the directory and each returned entry. */
	readonly directoryListing?: true;
	/** Direct GETs use the call's destination-specific transport. */
	readonly webRequests?: true;
	readonly screenshots?: true;
	/**
	 * The local site a call names. It must resolve to the turn's target site; a
	 * missing reference denies the call.
	 */
	readonly site?: ( args: unknown ) => string | undefined;
	/**
	 * Local paths the tool writes itself, given the named site's folder. Each must
	 * lie in the target site's folder; undefined denies the call.
	 */
	readonly paths?: ( args: unknown, siteFolder: string | undefined ) => string[] | undefined;
	/**
	 * The folder of files Studio ships itself that the tool reads. It must lie in
	 * Studio's own bundled skills, outside every folder the turn reaches.
	 */
	readonly bundled?: () => string;
	/**
	 * Files of Studio's own configuration the tool reads, at locations Studio
	 * fixes and no argument names, such as the stored WordPress.com login in
	 * `shared.json`. Each must lie outside every folder the turn reaches, so
	 * nothing the conversation writes is read as Studio's own.
	 */
	readonly config?: () => readonly string[];
	/**
	 * The files a call names in a folder Studio keeps for staged request
	 * payloads, as the tool resolves them, which the tool reads and sends. Each
	 * must be an existing file in that folder through every link and short name,
	 * and the call must be one the user approves, seeing them. Undefined denies
	 * the call.
	 */
	readonly payloads?: (
		args: unknown
	) => { readonly folder: string; readonly files: readonly string[] } | undefined;
	/**
	 * The WordPress.com scope a call reaches directly: a site, which must be the
	 * turn's live target, or the account; and the request as it is sent, which an
	 * approval of the call shows in place of the call's arguments. An approval of
	 * a call with a scope never shows its arguments. Undefined denies the call.
	 */
	readonly remote?: ( args: unknown ) =>
		| {
				readonly wpcomSiteId?: number;
				readonly request?: { readonly method: string; readonly path: string };
		  }
		| undefined;
	/**
	 * The URLs a call opens, given the named site's URL; undefined denies the call.
	 * Only http and https are allowed. A local address must be the target site's
	 * own origin; a public page is an external read.
	 */
	readonly urls?: ( args: unknown, siteUrl: string | undefined ) => string[] | undefined;
	/** Every URL the call opens must be the named site's own origin. */
	readonly urlsOnSite?: true;
	/**
	 * Runs only in a conversation that has no site yet: anywhere else the call
	 * is refused before anything is journaled.
	 */
	readonly withoutSite?: true;
	/**
	 * Creates the site the conversation then works on, so a turn runs one such
	 * call at a time. Only a rule that runs `withoutSite` can create a site.
	 */
	readonly createsSite?: true;
	/**
	 * Lists every local site and the WordPress.com sites the stored login
	 * reaches, through the guarded host, which gives those listings only inside
	 * a call of a tool whose rule says so, in a conversation without a site.
	 */
	readonly lists?: true;
	/**
	 * Drives a browser, whether it opens a URL from its arguments, a page of the
	 * named site or a document it wrote itself; it can be enabled only under a
	 * verified navigation guard.
	 */
	readonly navigates?: true;
	/**
	 * Where a call that needs approval is approved: at the host operation that
	 * carries its effect, with that operation's exact arguments, or for the tool
	 * call itself when its effect does not go through the host.
	 */
	readonly approval: 'host' | 'tool';
	/**
	 * What an approval of the call, and its journal entry, say of it after its
	 * class and name: a fixed sentence, never a value of the call. A message's
	 * says what goes with the arguments the approval shows, and where.
	 */
	readonly note?: string;
}

function namedSite( args: unknown ): string | undefined {
	return isRecord( args ) && typeof args.nameOrPath === 'string' ? args.nameOrPath : undefined;
}

type StudioRuleElements = Omit< ClaudeStudioToolRule, 'qualification' >;

function studioRule(
	operationClass: ClaudeOperationClass,
	options: Partial< Omit< StudioRuleElements, 'operationClass' > > = {}
): StudioRuleElements {
	return { operationClass, approval: 'tool', ...options };
}

function onSite(
	operationClass: ClaudeOperationClass,
	options: Partial< Omit< StudioRuleElements, 'operationClass' > > = {}
): StudioRuleElements {
	return studioRule( operationClass, { site: namedSite, ...options } );
}

function unqualified(
	rule: StudioRuleElements,
	unbound?: readonly ClaudeToolChannel[]
): ClaudeStudioToolRule {
	return { ...rule, qualification: unbound ? { qualified: false, unbound } : { qualified: false } };
}

function qualified(
	rule: StudioRuleElements,
	channels: ClaudeToolChannelDeclaration
): ClaudeStudioToolRule {
	return { ...rule, qualification: { qualified: true, channels } };
}

// Browser startup reads the pinned Playwright installation and the selected site's TLS trust file.
const browserChannels = {
	readsLocalFiles: [ 'navigates' ],
	drivesBrowser: [ 'navigates' ],
	requestsNetwork: [ 'navigates' ],
	spawnsProcess: [ 'navigates' ],
} as const;

// Operations on the selected site, including WP-CLI, are bound by the host guard.
const LOCAL_SITE_HOST_CHANNELS: Partial< ClaudeToolChannelDeclaration > = {
	runsWpCli: [ 'site', 'host' ],
	callsHostOperation: [ 'site', 'host' ],
};

const taxonomistScripts = () => getSkillPath( 'taxonomist', 'scripts' );

// Where `readAuthToken` reads the stored WordPress.com login: Studio's shared
// configuration.
const storedLogin = () => [ getSharedConfigPath() ];

// The WordPress.com scope of a request whose code asks only for the account's
// own listing of its sites, whatever the call's arguments.
const accountListing = () => ( {} );

// Where `install_taxonomy_scripts` writes in a site: its folder and a copy of
// every file the bundled folder holds. Undefined, which denies the call, when
// either cannot be named.
function taxonomistDestinations( siteFolder: string | undefined ): string[] | undefined {
	if ( ! siteFolder ) return;
	const destination = path.join( siteFolder, 'tmp', 'taxonomist' );
	try {
		const files = readdirSync( taxonomistScripts(), { recursive: true, encoding: 'utf8' } );
		return [ destination, ...files.map( ( file ) => path.join( destination, file ) ) ];
	} catch {
		return;
	}
}

// What `send_feedback` sends besides the type and message an approval shows,
// and where: `sendStudioFeedback` adds a line naming Studio's version and the
// operating system, and sends the report to the WordPress.com MCP server's
// feedback tool with the stored login.
const FEEDBACK_NOTE =
	'It sends the type and message shown, with a line naming this Studio version and operating system, to the WordPress Studio team at Automattic through WordPress.com, signed in as the WordPress.com account Studio is logged in to';

// What `generate_images` sends besides the specs an approval shows, where, and
// where an image goes once it is made.
const IMAGES_NOTE =
	'It sends a prompt made from each image’s subject, page context and style, and the call’s site context and grade, to Studio’s image service on WordPress.com, signed in with that service’s own credential, and writes each image it gets back in this site at the path shown; an image under the site’s wp-content/uploads goes into its media library instead, in the uploads folder WordPress picks';

// The files `generate_images` writes, as it resolves the paths the call names;
// undefined, which denies the call, when one is not an absolute path.
function imageFiles( args: unknown ): string[] | undefined {
	const images = isRecord( args ) ? args.images : undefined;
	if ( ! Array.isArray( images ) ) return;
	const files = images.map( ( image ) => ( isRecord( image ) ? image.path : undefined ) );
	if ( ! files.every( ( file ) => typeof file === 'string' && path.isAbsolute( file ) ) ) return;
	return ( files as string[] ).map( ( file ) => path.resolve( file ) );
}

// A declaration that marks every channel it does not name as unused.
function using( used: Partial< ClaudeToolChannelDeclaration > ): ClaudeToolChannelDeclaration {
	return {
		readsLocalFiles: false,
		writesLocalFiles: false,
		drivesBrowser: false,
		requestsNetwork: false,
		spawnsProcess: false,
		runsWpCli: false,
		callsHostOperation: false,
		reachesWpcom: false,
		...used,
	};
}

function frozen< Value >( value: Value ): Value {
	if ( value && typeof value === 'object' && ! Object.isFrozen( value ) ) {
		Object.freeze( value );
		for ( const item of Object.values( value ) ) frozen( item );
	}
	return value;
}

// A `Map` accepts `set` and `delete` whatever type it is declared with, so the
// rule tables are exposed only as this frozen view, over frozen rules: nothing
// can add, replace or loosen a rule at run time. A rule has no prototype
// either, so it has no element but those it states.
function ruleTable< Rule extends object >(
	entries: ReadonlyArray< readonly [ string, Rule ] >
): ReadonlyMap< string, Rule > {
	const rules = new Map(
		entries.map( ( [ name, rule ] ) => [
			name,
			frozen< Rule >( Object.assign( Object.create( null ), rule ) ),
		] )
	);
	const table: ReadonlyMap< string, Rule > = {
		get size() {
			return rules.size;
		},
		get: ( name ) => rules.get( name ),
		has: ( name ) => rules.has( name ),
		forEach: ( callback, thisArg ) =>
			rules.forEach( ( rule, name ) => callback.call( thisArg, rule, name, table ) ),
		entries: () => rules.entries(),
		keys: () => rules.keys(),
		values: () => rules.values(),
		[ Symbol.iterator ]: () => rules[ Symbol.iterator ](),
	};
	return Object.freeze( table );
}

function pageUrls( args: unknown ): string[] | undefined {
	return isRecord( args ) && typeof args.url === 'string' ? [ args.url ] : undefined;
}

// A site audit opens `${ siteUrl }${ path }`. The path must be a plain path on
// that site, which the policy then checks again on the composed URL.
function auditUrls( args: unknown, siteUrl: string | undefined ): string[] | undefined {
	const urlPath = isRecord( args ) && args.path !== undefined ? args.path : '/';
	if (
		! siteUrl ||
		typeof urlPath !== 'string' ||
		! /^\/(?![/\\])[^\\\s]*$/.test( urlPath ) ||
		[ ...urlPath ].some( ( character ) => character < ' ' || character === '\u007f' )
	)
		return;
	return [ `${ siteUrl.replace( /\/+$/, '' ) }${ urlPath }` ];
}

export { isLocalHostname, normalizeHostname } from './web-hostname';

// Tool annotations describe these tools to hosts; they are hints. The classes
// here decide, and the tests require each to be at least as strict as the
// tool's annotations.
//
// Only a qualified tool can be enabled. The rules of the unqualified tools are
// where each one's qualification starts, not a claim that they are complete.
export const CLAUDE_STUDIO_TOOL_RULES: ReadonlyMap< string, ClaudeStudioToolRule > = ruleTable( [
	[
		'Ls',
		qualified(
			studioRule( 'read', { directoryListing: true } ),
			using( { readsLocalFiles: [ 'directoryListing' ] } )
		),
	],
	[
		createSiteTool.name,
		// It creates a site with the CLI's own command, in Studio's sites folder
		// and only from a conversation without a site; resolves that site; makes
		// it the conversation's site; and shows it. The guarded host journals the
		// creation, the selection and the showing before each runs, and refuses
		// them for any other site. Its module links `tools/utils.ts`, whose
		// `runWpCli` runs only through the host.
		qualified(
			studioRule( 'local-change', { approval: 'host', withoutSite: true, createsSite: true } ),
			using( { runsWpCli: [ 'host' ], callsHostOperation: [ 'host' ] } )
		),
	],
	[
		listSitesTool.name,
		// It lists the local sites and the WordPress.com sites the stored login
		// reaches, both through the guarded host, which gives them only inside a
		// call of this tool, in a conversation without a site, while the call
		// lives, and of each local site only the fields every site has. A
		// conversation that has its site works on that one, so there the call is
		// refused. The tool reads the stored login itself and hands it to the
		// host. Its module links `tools/utils.ts`, whose `runWpCli` runs only
		// through the host.
		qualified(
			studioRule( 'remote-read', { withoutSite: true, lists: true, config: storedLogin } ),
			using( {
				readsLocalFiles: [ 'config' ],
				runsWpCli: [ 'host' ],
				callsHostOperation: [ 'host' ],
				reachesWpcom: [ 'host' ],
			} )
		),
	],
	[
		getSiteInfoTool.name,
		// It resolves the site it names and reads that site's status from the
		// host, which the guarded host allows for the target site only. Like
		// every site tool, its module links `tools/utils.ts`, whose `runWpCli`
		// can reach WP-CLI only through the guarded host.
		qualified( onSite( 'read' ), using( LOCAL_SITE_HOST_CHANNELS ) ),
	],
	// These resolve the site they name and run the CLI's own command for it
	// through the host, which binds it to the target site, journals it, asks
	// for what its class asks for and fences it immediately before it starts.
	[
		startSiteTool.name,
		qualified( onSite( 'local-change', { approval: 'host' } ), using( LOCAL_SITE_HOST_CHANNELS ) ),
	],
	[
		stopSiteTool.name,
		qualified( onSite( 'local-change', { approval: 'host' } ), using( LOCAL_SITE_HOST_CHANNELS ) ),
	],
	[
		deleteSiteTool.name,
		qualified(
			onSite( 'local-overwrite', { approval: 'host' } ),
			using( LOCAL_SITE_HOST_CHANNELS )
		),
	],
	[
		createPreviewTool.name,
		// It resolves the site it names and makes a new preview of it through the
		// host, which runs the CLI's own `preview create` for the site the turn
		// acts on only. The user approves it, told that a copy of the site's
		// content becomes visible to anyone with the preview's public address,
		// and it is journaled before it runs. The command keeps its archive in the
		// system's temporary folder, which must lie out of the turn's reach. Its
		// module links `tools/utils.ts`, whose `runWpCli` runs only through the
		// host.
		qualified(
			onSite( 'remote-change', { approval: 'host' } ),
			using( { ...LOCAL_SITE_HOST_CHANNELS, reachesWpcom: [ 'host' ] } )
		),
	],
	[
		listPreviewsTool.name,
		// It resolves the site it names and lists that site's previews from the
		// host, which reads Studio's own record of them, and the guarded host
		// allows that for the target site only. It formats what the host lists
		// and asks WordPress.com nothing itself.
		qualified( onSite( 'read' ), using( LOCAL_SITE_HOST_CHANNELS ) ),
	],
	// These act on a preview by the address the call names, through the host,
	// which runs the CLI's own `preview update` or `preview delete`. The guarded
	// host binds the preview to the site the turn acts on: the one preview of
	// that site the host lists at that address, checked again immediately
	// before the command, which receives that preview's own address. The user
	// approves each, seeing the preview, and it is journaled before it runs. An
	// update comes only from the site the preview was made from. Their modules
	// link `tools/utils.ts`, whose `runWpCli` runs only through the host.
	[
		updatePreviewTool.name,
		qualified(
			onSite( 'remote-overwrite', { approval: 'host' } ),
			using( { ...LOCAL_SITE_HOST_CHANNELS, reachesWpcom: [ 'host' ] } )
		),
	],
	[
		deletePreviewTool.name,
		qualified(
			studioRule( 'remote-overwrite', { approval: 'host' } ),
			using( { runsWpCli: [ 'host' ], callsHostOperation: [ 'host' ], reachesWpcom: [ 'host' ] } )
		),
	],
	[
		runWpCliTool.name,
		// The host independently classifies the arguments that actually reach WP-CLI.
		qualified(
			onSite( 'command', {
				approval: 'host',
				classify: ( args ) => {
					const command = isRecord( args ) ? args.command : undefined;
					return typeof command === 'string'
						? classifyWpCliArgs( splitCommandArgs( command ) )
						: undefined;
				},
			} ),
			{
				readsLocalFiles: false,
				writesLocalFiles: false,
				drivesBrowser: false,
				requestsNetwork: false,
				spawnsProcess: false,
				runsWpCli: [ 'site', 'host' ],
				callsHostOperation: [ 'host' ],
				reachesWpcom: false,
			}
		),
	],
	[
		scaffoldThemeTool.name,
		qualified(
			onSite( 'local-change', {
				webRequests: true,
				paths: ( args, folder ) => {
					if (
						! folder ||
						! isRecord( args ) ||
						typeof args.name !== 'string' ||
						( args.slug !== undefined && typeof args.slug !== 'string' )
					)
						return;
					const slug = scaffoldThemeSlug( args.name, args.slug );
					if ( ! /^[a-z0-9][a-z0-9-]*$/.test( slug ) ) return;
					const themes = path.join( folder, 'wp-content', 'themes' );
					const paths = [ path.join( folder, 'DESIGN.md' ), path.join( themes, slug ) ];
					if ( args.parentTheme !== undefined && typeof args.parentTheme !== 'string' ) return;
					if ( typeof args.parentTheme === 'string' && args.parentTheme.trim() ) {
						if ( ! /^[a-z0-9][a-z0-9-]*$/.test( args.parentTheme.trim() ) ) return;
						paths.push( path.join( themes, args.parentTheme.trim(), 'style.css' ) );
					}
					return paths;
				},
			} ),
			using( {
				readsLocalFiles: [ 'paths' ],
				writesLocalFiles: [ 'paths' ],
				requestsNetwork: [ 'webRequests' ],
				runsWpCli: [ 'site', 'host' ],
				callsHostOperation: [ 'site', 'host' ],
			} )
		),
	],
	[ pickDesignTool.name, unqualified( studioRule( 'read' ) ) ],
	[
		validateBlocksTool.name,
		qualified(
			onSite( 'local-overwrite', {
				navigates: true,
				classify: ( args ) =>
					isRecord( args ) && args.filePath !== undefined ? 'local-overwrite' : 'read',
				paths: ( args, siteFolder ) => {
					const file = isRecord( args ) ? args.filePath : undefined;
					if ( file === undefined ) return [];
					if ( typeof file !== 'string' || ! siteFolder ) return;
					return [ path.resolve( siteFolder, file ) ];
				},
			} ),
			using( {
				...browserChannels,
				readsLocalFiles: [ 'paths', 'navigates' ],
				writesLocalFiles: [ 'paths' ],
				callsHostOperation: [ 'site', 'host' ],
			} )
		),
	],
	[
		takeScreenshotTool.name,
		qualified(
			studioRule( 'local-overwrite', {
				screenshots: true,
				classify: ( args ) =>
					isRecord( args ) && args.themeScreenshot !== undefined
						? 'local-overwrite'
						: 'local-change',
				urls: pageUrls,
				navigates: true,
				paths: ( args ) => {
					const directory = isRecord( args ) ? args.themeScreenshot : undefined;
					if ( directory === undefined ) return [];
					if ( typeof directory !== 'string' || ! path.isAbsolute( directory ) ) return;
					return [ path.resolve( directory, 'screenshot.jpg' ) ];
				},
			} ),
			using( {
				...browserChannels,
				readsLocalFiles: [ 'screenshots', 'navigates' ],
				writesLocalFiles: [ 'screenshots', 'paths' ],
				callsHostOperation: [ 'host' ],
			} )
		),
	],
	[
		inspectDesignTool.name,
		qualified(
			studioRule( 'read', { urls: pageUrls, navigates: true } ),
			using( browserChannels )
		),
	],
	[
		generateImagesTool.name,
		// It reads the image service's credential (`STUDIO_IMAGE_API_TOKEN`, or
		// else the stored login) and sends one prompt per image, made from the
		// call's specs, to Studio's image service on WordPress.com itself,
		// outside the host, at an address its code fixes (or
		// `WPCOM_AI_PROXY_BASE_URL`, which no call shapes). It writes each image
		// it gets back itself: at the path the call names, which must lie in the
		// site the turn acts on; or, for an image under `wp-content/uploads`, at
		// the file of the attachment the guarded host's `media.reserve` gives,
		// which the host requires to lie in that site too. Those media-library
		// steps are host operations whose WP-CLI commands are Studio's own code,
		// journaled before they run; `wp_cli` still refuses `eval`. Every call
		// asks the user, whose approval shows the specs and paths and says what
		// is sent where; never the credential. The registry offers it only to a
		// turn that found the image service. Its module links `tools/utils.ts`,
		// whose `runWpCli` runs only through the host.
		qualified(
			studioRule( 'remote-change', {
				paths: imageFiles,
				config: storedLogin,
				note: IMAGES_NOTE,
			} ),
			using( {
				readsLocalFiles: [ 'config' ],
				writesLocalFiles: [ 'paths', 'class' ],
				runsWpCli: [ 'host' ],
				callsHostOperation: [ 'host' ],
				requestsNetwork: [ 'class' ],
				reachesWpcom: [ 'class' ],
			} )
		),
	],
	[
		installTaxonomyScriptsTool.name,
		// It copies Studio's own Taxonomist scripts into `tmp/taxonomist` in the
		// site it names: it reads only that bundled folder, and writes only the
		// files the rule lists, each of which must resolve inside the target
		// site's folder.
		qualified(
			onSite( 'local-change', {
				bundled: taxonomistScripts,
				paths: ( _args, siteFolder ) => taxonomistDestinations( siteFolder ),
			} ),
			using( {
				...LOCAL_SITE_HOST_CHANNELS,
				readsLocalFiles: [ 'bundled' ],
				writesLocalFiles: [ 'paths' ],
			} )
		),
	],
	[
		auditPerformanceTool.name,
		qualified(
			onSite( 'read', { urls: auditUrls, urlsOnSite: true, navigates: true } ),
			using( { ...browserChannels, callsHostOperation: [ 'site', 'host' ] } )
		),
	],
	[
		auditSeoTool.name,
		qualified(
			onSite( 'read', { urls: auditUrls, urlsOnSite: true, navigates: true, webRequests: true } ),
			using( {
				...browserChannels,
				requestsNetwork: [ 'navigates', 'webRequests' ],
				callsHostOperation: [ 'site', 'host' ],
			} )
		),
	],
	[
		listConnectedRemoteSitesTool.name,
		// It resolves the site it names, which the guarded host allows for the
		// target site only, and reads that site's connections and the stored
		// login from Studio's shared configuration. It then sends one request
		// itself, outside the host: the account's own listing of its sites, which
		// its code fixes and no argument shapes, with the stored login. It keeps
		// the connected ones and says nothing of the login. Its module links
		// `tools/utils.ts`, whose `runWpCli` runs only through the host.
		qualified(
			onSite( 'remote-read', { remote: accountListing, config: storedLogin } ),
			using( {
				...LOCAL_SITE_HOST_CHANNELS,
				readsLocalFiles: [ 'config' ],
				requestsNetwork: [ 'scope' ],
				reachesWpcom: [ 'scope' ],
			} )
		),
	],
	[
		wpcomRequestTool.name,
		// It reads the stored login and, for a change, the body files it names in
		// Studio's payload folder, and sends one request itself, outside the host,
		// with Studio's WordPress.com client. The scope decides from that request
		// as the tool composes it and the client parses it: a read of the
		// conversation's own WordPress.com site, or of WordPress.com's plan
		// features, runs unprompted; a change of something in that site
		// through its WordPress REST API runs once the user approves it, seeing
		// the method sent, the site, the path and the body files, never the
		// body, the query or the login. Its module links `tools/utils.ts`, whose
		// `runWpCli` runs only through the host.
		qualified(
			studioRule( 'remote-overwrite', {
				classify: ( args ) => {
					const method = isRecord( args ) ? args.method : undefined;
					if ( method === 'GET' ) return 'remote-read';
					if ( method === 'POST' || method === 'PUT' || method === 'DELETE' )
						return 'remote-overwrite';
				},
				remote: wpcomScope,
				config: storedLogin,
				payloads: wpcomBodyFiles,
			} ),
			using( {
				readsLocalFiles: [ 'config', 'payloads' ],
				runsWpCli: [ 'host' ],
				callsHostOperation: [ 'host' ],
				requestsNetwork: [ 'scope' ],
				reachesWpcom: [ 'scope' ],
			} )
		),
	],
	[
		pushSiteTool.name,
		// It resolves the site it names and pushes it through the host, which runs
		// the CLI's own `push` for the site the turn acts on only. The guarded
		// host binds the WordPress.com site to one connected to that site, by its
		// numeric ID, and in a conversation on a live site to that site, checked
		// again immediately before the command, which receives that ID; it takes
		// only the options the command takes and the tool describes. The user
		// approves it, seeing the direction, the site and what it overwrites
		// there, and it is journaled before it runs. Its module links
		// `tools/utils.ts`, whose `runWpCli` runs only through the host.
		qualified(
			onSite( 'remote-overwrite', { approval: 'host' } ),
			using( { ...LOCAL_SITE_HOST_CHANNELS, reachesWpcom: [ 'host' ] } )
		),
	],
	[
		pullSiteTool.name,
		// It resolves the site it names and pulls into it through the host, which
		// runs the CLI's own `pull` for the site the turn acts on only, bound as
		// `site_push` is: a WordPress.com site connected to it, by its numeric ID,
		// checked again immediately before the command, with only the options the
		// command takes. The user approves it, seeing the direction, the site and
		// what it overwrites in the local site, and it is journaled before it
		// runs. It changes local work, so its class is a local one. Only the
		// CLI's default engine runs: the Reprint engine keeps its state under the
		// home folder whatever Studio's configuration folder is, so the host
		// refuses it. Its module links `tools/utils.ts`, whose `runWpCli` runs
		// only through the host.
		qualified(
			onSite( 'local-overwrite', { approval: 'host' } ),
			using( { ...LOCAL_SITE_HOST_CHANNELS, reachesWpcom: [ 'host' ] } )
		),
	],
	// The CLI's import reads, and its export writes, the file the call names.
	// The host binds that file to the conversation's own folders, resolved
	// through links and short names, when it prepares the operation and again
	// immediately before the command starts; the approval shows it.
	[
		importSiteTool.name,
		qualified(
			onSite( 'local-overwrite', { approval: 'host' } ),
			using( LOCAL_SITE_HOST_CHANNELS )
		),
	],
	[
		exportSiteTool.name,
		qualified(
			onSite( 'local-overwrite', { approval: 'host' } ),
			using( LOCAL_SITE_HOST_CHANNELS )
		),
	],
	[
		openAnnotationBrowserTool.name,
		qualified(
			studioRule( 'local-change', { urls: pageUrls, navigates: true } ),
			using( browserChannels )
		),
	],
	[
		refreshBrowserTool.name,
		// It asks the app that shows the conversation to reload its preview,
		// through the guarded host, whose `ui` does nothing once the call has
		// ended. The registry offers it only to a host with that app. Its module
		// links `tools/utils.ts`, whose `runWpCli` runs only through the host.
		qualified(
			studioRule( 'read' ),
			using( { runsWpCli: [ 'host' ], callsHostOperation: [ 'host' ] } )
		),
	],
	[
		sendFeedbackTool.name,
		// It reads the stored login and sends one report itself, outside the
		// host: the call's type and message, with a line naming Studio's version
		// and the operating system, to the WordPress.com MCP server's feedback
		// tool at an address its code fixes, signed in with that login. Every
		// call asks the user, whose approval shows the type and message and says
		// what goes with them and where; never the login. Its module links
		// `tools/utils.ts`, whose `runWpCli` runs only through the host.
		qualified(
			studioRule( 'external-message', { config: storedLogin, note: FEEDBACK_NOTE } ),
			using( {
				readsLocalFiles: [ 'config' ],
				runsWpCli: [ 'host' ],
				callsHostOperation: [ 'host' ],
				requestsNetwork: [ 'class' ],
				reachesWpcom: [ 'class' ],
			} )
		),
	],
	// Tools built by factories for the host's capabilities.
	[ 'AskUserQuestion', unqualified( studioRule( 'read' ) ) ],
	[ 'Skill', unqualified( studioRule( 'read' ) ) ],
	[
		'present_design_options',
		// It renders HTML the model supplies: it writes that HTML to a file in the
		// host's screenshot folder, loads the file in the shared browser, and
		// first reads every image the HTML names by absolute path or `file:` URL.
		// No argument names those files, so nothing in the rule bounds either
		// file channel yet.
		unqualified( studioRule( 'local-change', { navigates: true } ), [
			'readsLocalFiles',
			'writesLocalFiles',
		] ),
	],
] );

export interface ClaudeNativeToolRule {
	readonly operationClass: ClaudeOperationClass;
	/** The input field naming the path the tool reaches, checked against the target's folders. */
	readonly path?: {
		readonly field: string;
		readonly required: boolean;
		readonly allowRoot: boolean;
	};
	/** Rejects input the policy cannot bound. */
	readonly accepts?: ( input: Record< string, unknown > ) => boolean;
	/** Runs an unstructured command; it can be enabled only under a verified confinement. */
	readonly shell?: true;
}

export const SHELL_TIMEOUT_LIMIT_MS = 10 * 60 * 1000;

// A shell command is never judged safe by its text: every call needs approval
// of the exact command. These bounds keep it in the foreground, where the turn's
// cancellation reaches it, and refuse a request to run outside any sandbox.
function isBoundedShellInput( input: Record< string, unknown > ): boolean {
	const {
		command,
		timeout,
		description,
		run_in_background: background,
		dangerouslyDisableSandbox: unsandboxed,
		...rest
	} = input;
	return (
		Object.keys( rest ).length === 0 &&
		typeof command === 'string' &&
		command.trim().length > 0 &&
		! command.includes( '\0' ) &&
		( timeout === undefined ||
			( Number.isInteger( timeout ) &&
				( timeout as number ) > 0 &&
				( timeout as number ) <= SHELL_TIMEOUT_LIMIT_MS ) ) &&
		( description === undefined || typeof description === 'string' ) &&
		( background === undefined || background === false ) &&
		( unsandboxed === undefined || unsandboxed === false )
	);
}

// A file pattern: letters, digits, '.', '_', '-', '/', '*', '?' and brace
// groups of two or more non-empty alternatives made of the same characters
// without '/'. Nothing else: no backslash, extglob, '(', ')', '|', '[', '!',
// '~', ':', whitespace, nested or unbalanced group.
const GLOB_PATTERN = /^(?:[A-Za-z0-9._*?/-]|\{[A-Za-z0-9._*?-]+(?:,[A-Za-z0-9._*?-]+)+\})+$/;
const GLOB_MAX_LENGTH = 512;
const GLOB_MAX_EXPANSIONS = 256;

// A segment with a leading dot whose wildcards can make it `..`. A shell lists
// `.` and `..` for such a segment, so `.*/x` can reach the parent.
function mayNameParent( segment: string ): boolean {
	if ( ! segment.startsWith( '.' ) ) return false;
	const source = segment.replace( /\./g, '\\.' ).replace( /\*+/g, '.*' ).replace( /\?/g, '.' );
	return new RegExp( `^${ source }$` ).test( '..' );
}

/**
 * A file pattern that cannot match above the folder it is searched from, for
 * any glob engine: it is in the grammar above, it is relative, and none of the
 * patterns its brace groups expand to contains `..`, an empty segment (an
 * engine that drops a leading `./` would make `.//` absolute) or a segment
 * that can match `..`. Stricter than any engine, so a legitimate pattern may
 * need rewording.
 */
export function isContainedPattern( pattern: unknown ): boolean {
	if (
		typeof pattern !== 'string' ||
		pattern.length > GLOB_MAX_LENGTH ||
		pattern.startsWith( '/' ) ||
		! GLOB_PATTERN.test( pattern )
	)
		return false;
	let expansions = [ '' ];
	for ( const part of pattern.split( /(\{[^{}]*\})/ ) ) {
		const choices = part.startsWith( '{' ) ? part.slice( 1, -1 ).split( ',' ) : [ part ];
		if ( expansions.length * choices.length > GLOB_MAX_EXPANSIONS ) return false;
		expansions = expansions.flatMap( ( prefix ) => choices.map( ( choice ) => prefix + choice ) );
	}
	return expansions.every(
		( expansion ) =>
			! expansion.includes( '..' ) &&
			! expansion.includes( '//' ) &&
			! expansion.split( '/' ).some( mayNameParent )
	);
}

const filePath = { field: 'file_path', required: true, allowRoot: false } as const;
const searchPath = { field: 'path', required: false, allowRoot: true } as const;

// The SDK's sdk-tools.d.ts defines the file operations. It has no native LS.
const globPattern = z.string().refine( isContainedPattern );
const count = z.number().int().nonnegative().optional();
const read = z.strictObject( {
	file_path: z.string(),
	offset: count,
	limit: count,
	// The runtime interprets the page selection within the already checked file.
	pages: z.string().optional(),
	allow_large: z.boolean().optional(),
} satisfies Record< keyof FileReadInput, z.ZodType > );
const grep = z.strictObject( {
	pattern: z.string(),
	path: z.string().optional(),
	glob: globPattern.optional(),
	type: z
		.string()
		.regex( /^[a-zA-Z0-9][a-zA-Z0-9_+.-]*$/ )
		.optional(),
	output_mode: z.enum( [ 'content', 'files_with_matches', 'count' ] ).optional(),
	'-B': count,
	'-A': count,
	'-C': count,
	context: count,
	head_limit: count,
	offset: count,
	'-n': z.boolean().optional(),
	'-i': z.boolean().optional(),
	'-o': z.boolean().optional(),
	multiline: z.boolean().optional(),
} satisfies Record< keyof GrepInput, z.ZodType > );
const glob = z.strictObject( {
	pattern: globPattern,
	path: z.string().optional(),
} satisfies Record< keyof GlobInput, z.ZodType > );
const write = z.strictObject( {
	file_path: z.string(),
	content: z.string(),
} satisfies Record< keyof FileWriteInput, z.ZodType > );
const edit = z
	.strictObject( {
		file_path: z.string(),
		old_string: z.string(),
		new_string: z.string(),
		replace_all: z.boolean().optional(),
	} satisfies Record< keyof FileEditInput, z.ZodType > )
	.refine( ( input ) => input.old_string !== input.new_string );

export function getClaudeNativePayloadRefusal(
	toolName: string,
	input: Record< string, unknown >
): string | undefined {
	if ( toolName === 'Bash' ) return getPayloadLimitViolation( toolName, input );
	if ( toolName !== 'Write' && toolName !== 'Edit' ) return;
	const payload =
		toolName === 'Write'
			? input
			: { edits: [ { oldText: input.old_string, newText: input.new_string } ] };
	if ( getPayloadLimitViolation( toolName, payload ) )
		return 'Split the file change into smaller Write or Edit calls within Studio’s 14 KiB limit.';
}

export const CLAUDE_NATIVE_TOOL_RULES: ReadonlyMap< string, ClaudeNativeToolRule > =
	ruleTable< ClaudeNativeToolRule >( [
		[
			'Read',
			{
				operationClass: 'read',
				path: filePath,
				accepts: ( input ) => read.safeParse( input ).success,
			},
		],
		[
			'Grep',
			{
				operationClass: 'read',
				path: searchPath,
				accepts: ( input ) => grep.safeParse( input ).success,
			},
		],
		[
			'Glob',
			{
				operationClass: 'read',
				path: searchPath,
				accepts: ( input ) => glob.safeParse( input ).success,
			},
		],
		[
			'Write',
			{
				operationClass: 'local-change',
				path: filePath,
				accepts: ( input ) => write.safeParse( input ).success,
			},
		],
		[
			'Edit',
			{
				operationClass: 'local-change',
				path: filePath,
				accepts: ( input ) => edit.safeParse( input ).success,
			},
		],
		[ 'MultiEdit', { operationClass: 'local-change', path: filePath } ],
		[ 'Bash', { operationClass: 'command', accepts: isBoundedShellInput, shell: true } ],
	] );

// The sandbox settings a verified confinement may use. Everything else is
// refused, including what the SDK describes as weakening isolation or letting
// commands out (excludedCommands, allowNestedUserNamespaces, allowAppleEvents,
// enableWeakerNestedSandbox, enableWeakerNetworkIsolation, ignoreViolations,
// filesystem.disabled, network exceptions, and replaced sandbox binaries).
const SANDBOX_KEYS: ReadonlySet< string > = new Set( [
	'enabled',
	'failIfUnavailable',
	'autoAllowBashIfSandboxed',
	'allowUnsandboxedCommands',
	'filesystem',
	'network',
] );
const SANDBOX_FILESYSTEM_KEYS: ReadonlySet< string > = new Set( [
	'allowRead',
	'allowWrite',
	'denyWrite',
	'denyRead',
] );

const SHELL_CONFINEMENT_KEYS: ReadonlySet< string > = new Set( [ 'mode', 'sandbox' ] );

/**
 * Whether a declared confinement can be verified. A sandbox counts only when
 * it uses no setting outside a short list, is enabled, refuses to run without
 * its dependencies, never lets a command out, leaves every command to the
 * user's approval and writes only in the workspace. The declaration is read
 * as plain data at every level, so what is verified is what the SDK receives;
 * a malformed one is unverified and never throws.
 */
export function isVerifiedShellConfinement(
	confinement: ClaudeShellConfinement,
	workspace: string
): boolean {
	const declared = plainData( confinement );
	if ( ! declared || typeof workspace !== 'string' ) return false;
	if ( declared.mode === 'approval-only' ) return Object.keys( declared ).length === 1;
	if ( declared.mode !== 'sandbox' || ! hasOnlyKeys( declared, SHELL_CONFINEMENT_KEYS ) )
		return false;
	const sandbox = plainData( declared.sandbox );
	if ( ! sandbox || ! hasOnlyKeys( sandbox, SANDBOX_KEYS ) ) return false;
	const network = plainData( sandbox.network );
	if (
		! network ||
		Object.keys( network ).length !== 2 ||
		network.strictAllowlist !== true ||
		plainStrings( network.allowedDomains )?.length !== 0
	)
		return false;
	const filesystem = sandbox.filesystem === undefined ? {} : plainData( sandbox.filesystem );
	if ( ! filesystem || ! hasOnlyKeys( filesystem, SANDBOX_FILESYSTEM_KEYS ) ) return false;
	const lists = new Map(
		Object.entries( filesystem ).map( ( [ key, value ] ) => [ key, plainStrings( value ) ] )
	);
	return (
		sandbox.enabled === true &&
		sandbox.failIfUnavailable === true &&
		sandbox.allowUnsandboxedCommands === false &&
		sandbox.autoAllowBashIfSandboxed === false &&
		[ ...lists.values() ].every( ( list ) => !! list ) &&
		( lists.get( 'allowRead' ) ?? [] ).every(
			( root ) => root === workspace && path.isAbsolute( root )
		) &&
		( lists.get( 'allowWrite' ) ?? [] ).every(
			( root ) => path.isAbsolute( root ) && isInside( workspace, path.resolve( root ) )
		)
	);
}

/** The native tools a turn may run: enabled, known, and confined when they are shells. */
export function claudeNativeTools(
	enabled: ClaudeEnabledTools,
	confinement: ClaudeShellConfinement,
	workspace: string
): string[] {
	let confined: boolean | undefined;
	return ( plainStrings( plainData( enabled )?.native ) ?? [] ).filter( ( name ) => {
		const rule = CLAUDE_NATIVE_TOOL_RULES.get( name );
		return (
			!! rule &&
			( ! rule.shell || ( confined ??= isVerifiedShellConfinement( confinement, workspace ) ) )
		);
	} );
}

// The bindings that can bound each channel. One of `needs` must be among those
// a declaration names: a browser is bounded only under the navigation guard,
// and WP-CLI and host operations only through the host guard. A file is bounded
// by checked paths, not by naming a site, and never by an approval alone: an
// approval shows the local paths the rule names, so one that names none would
// ask about files without showing them. Files Studio ships itself, and
// Studio's own configuration, bound reading, never writing. A request Studio
// sends is bounded by a scope or an approval, not by a URL check, which cannot
// see where a name resolves.
const CHANNEL_BOUNDS: Readonly<
	Record<
		ClaudeToolChannel,
		{
			readonly admits: readonly ClaudeChannelBinding[];
			readonly needs?: readonly ClaudeChannelBinding[];
		}
	>
> = {
	readsLocalFiles: {
		admits: [
			'paths',
			'class',
			'bundled',
			'config',
			'payloads',
			'directoryListing',
			'screenshots',
			'navigates',
		],
		needs: [
			'paths',
			'bundled',
			'config',
			'payloads',
			'directoryListing',
			'screenshots',
			'navigates',
		],
	},
	writesLocalFiles: {
		admits: [ 'paths', 'class', 'screenshots' ],
		needs: [ 'paths', 'screenshots' ],
	},
	drivesBrowser: { admits: [ 'navigates', 'urls', 'site' ], needs: [ 'navigates' ] },
	requestsNetwork: { admits: [ 'scope', 'class', 'navigates', 'webRequests' ] },
	spawnsProcess: { admits: [ 'class', 'navigates' ] },
	runsWpCli: { admits: [ 'host', 'site' ], needs: [ 'host' ] },
	callsHostOperation: { admits: [ 'host', 'site' ], needs: [ 'host' ] },
	reachesWpcom: { admits: [ 'scope', 'class', 'host' ] },
};

const QUALIFIED_KEYS: ReadonlySet< string > = new Set( [ 'qualified', 'channels' ] );

// The elements a qualified rule may have, and whether each is a function, a
// mark or a sentence.
const RULE_ELEMENTS: Readonly<
	Record< keyof ClaudeStudioToolRule, 'function' | 'mark' | 'text' | 'other' >
> = {
	qualification: 'other',
	directoryListing: 'mark',
	webRequests: 'mark',
	screenshots: 'mark',
	operationClass: 'other',
	approval: 'other',
	classify: 'function',
	site: 'function',
	paths: 'function',
	bundled: 'function',
	config: 'function',
	payloads: 'function',
	remote: 'function',
	urls: 'function',
	urlsOnSite: 'mark',
	navigates: 'mark',
	withoutSite: 'mark',
	createsSite: 'mark',
	lists: 'mark',
	note: 'text',
};

function isRuleElement( [ key, value ]: [ string, unknown ] ): boolean {
	if ( ! hasOwn( RULE_ELEMENTS, key ) ) return false;
	const kind = RULE_ELEMENTS[ key as keyof ClaudeStudioToolRule ];
	if ( kind === 'other' || value === undefined ) return true;
	if ( kind === 'mark' ) return value === true;
	if ( kind === 'text' ) return typeof value === 'string' && value.trim().length > 0;
	return typeof value === 'function';
}

function isOperationClass( value: unknown ): value is ClaudeOperationClass {
	return typeof value === 'string' && hasOwn( CLASS_DESCRIPTIONS, value );
}

// Whether a rule has what a binding names. `class` bounds a channel only when
// every call is approved: the class asks, no argument narrows it, and the call
// itself is what the user approves, not the host operations it reaches.
function ruleHas( rule: Record< string, unknown >, binding: unknown ): boolean {
	switch ( binding ) {
		case 'site':
			return typeof rule.site === 'function';
		case 'paths':
			return typeof rule.paths === 'function';
		case 'urls':
			return typeof rule.urls === 'function';
		case 'webRequests':
			return rule.webRequests === true;
		case 'screenshots':
			return rule.screenshots === true && rule.navigates === true;
		case 'navigates':
			return rule.navigates === true;
		case 'scope':
			return typeof rule.remote === 'function';
		case 'class':
			return (
				isOperationClass( rule.operationClass ) &&
				requiresClaudeApproval( rule.operationClass ) &&
				rule.classify === undefined &&
				rule.approval === 'tool'
			);
		case 'host':
			return true;
		case 'bundled':
			return typeof rule.bundled === 'function';
		case 'config':
			return typeof rule.config === 'function';
		case 'payloads':
			return typeof rule.payloads === 'function';
		case 'directoryListing':
			return rule.directoryListing === true && rule.operationClass === 'read';
		default:
			return false;
	}
}

// The elements of a rule that is qualified, or undefined. Read as plain data,
// so a qualification cannot be inherited, computed or planted on a prototype.
function qualifiedElements( rule: unknown ): Record< string, unknown > | undefined {
	const elements = plainData( rule );
	const qualification = plainData( elements?.qualification );
	if (
		! elements ||
		! qualification ||
		qualification.qualified !== true ||
		! hasOnlyKeys( qualification, QUALIFIED_KEYS ) ||
		! Object.entries( elements ).every( isRuleElement ) ||
		! isOperationClass( elements.operationClass ) ||
		( elements.approval !== 'host' && elements.approval !== 'tool' )
	)
		return;
	const channels = plainData( qualification.channels );
	if ( ! channels || Object.keys( channels ).length !== CLAUDE_TOOL_CHANNELS.length ) return;
	const used = new Set< ClaudeToolChannel >();
	for ( const channel of CLAUDE_TOOL_CHANNELS ) {
		if ( ! hasOwn( channels, channel ) ) return;
		if ( channels[ channel ] === false ) continue;
		const bindings = plainList( channels[ channel ] );
		const { admits, needs } = CHANNEL_BOUNDS[ channel ];
		if (
			! bindings?.length ||
			! bindings.every(
				( binding ) =>
					admits.includes( binding as ClaudeChannelBinding ) && ruleHas( elements, binding )
			) ||
			( needs && ! needs.some( ( binding ) => bindings.includes( binding ) ) )
		)
			return;
		used.add( channel );
	}
	// The declaration has to cover what the rule itself shows the tool does.
	const covers =
		( elements.navigates === true ) === used.has( 'drivesBrowser' ) &&
		( elements.webRequests !== true || used.has( 'requestsNetwork' ) ) &&
		( elements.screenshots !== true || used.has( 'writesLocalFiles' ) ) &&
		( elements.remote === undefined || used.has( 'reachesWpcom' ) ) &&
		( elements.paths === undefined ||
			used.has( 'readsLocalFiles' ) ||
			used.has( 'writesLocalFiles' ) ) &&
		( elements.bundled === undefined || used.has( 'readsLocalFiles' ) ) &&
		( elements.config === undefined || used.has( 'readsLocalFiles' ) ) &&
		( elements.payloads === undefined || used.has( 'readsLocalFiles' ) ) &&
		( elements.directoryListing !== true || used.has( 'readsLocalFiles' ) ) &&
		( elements.urls === undefined ||
			used.has( 'drivesBrowser' ) ||
			used.has( 'requestsNetwork' ) ) &&
		( elements.approval !== 'host' || used.has( 'callsHostOperation' ) ) &&
		// An approval of a message shows its arguments; it also says what goes
		// with them and where.
		( elements.operationClass !== 'external-message' || typeof elements.note === 'string' ) &&
		( elements.createsSite !== true || elements.withoutSite === true ) &&
		// The listings are host operations, one of which reaches WordPress.com.
		( elements.lists !== true ||
			( used.has( 'callsHostOperation' ) && used.has( 'reachesWpcom' ) ) ) &&
		( ! used.has( 'runsWpCli' ) || used.has( 'callsHostOperation' ) ) &&
		// A rule approved at its host operations is admitted without an approval
		// of its own, so files it wrote itself would be written without an
		// approval that shows them.
		( elements.approval !== 'host' || ! used.has( 'writesLocalFiles' ) );
	return covers ? elements : undefined;
}

/**
 * Whether a rule is qualified: marked so, with a declaration that covers every
 * channel, binds each one it uses by something the rule has and that can bound
 * that channel, and accounts for what the rule's own elements show.
 */
export function isQualifiedStudioRule( rule: unknown ): boolean {
	return !! qualifiedElements( rule );
}

/**
 * The tools of a rule table a turn may run: named by the host, qualified, and
 * under a verified navigation guard when they drive a browser. Nothing the
 * host, a confinement or a guard declares enables a tool that is not
 * qualified, and a malformed list or declaration enables nothing.
 */
export function selectClaudeStudioTools(
	rules: ReadonlyMap< string, ClaudeStudioToolRule >,
	enabled: ClaudeEnabledTools,
	navigation: ClaudeNavigationConfinement,
	targetOrigin: string | null
): string[] {
	let guarded: boolean | undefined;
	return ( plainStrings( plainData( enabled )?.studio ) ?? [] ).filter( ( name ) => {
		const elements = qualifiedElements( rules.get( name ) );
		return (
			!! elements &&
			( elements.navigates !== true ||
				( guarded ??= isVerifiedNavigationGuard( navigation, targetOrigin ) ) )
		);
	} );
}

/** The Studio tools a turn may run in this build. */
export function claudeStudioTools(
	enabled: ClaudeEnabledTools,
	navigation: ClaudeNavigationConfinement,
	targetOrigin: string | null
): string[] {
	return selectClaudeStudioTools( CLAUDE_STUDIO_TOOL_RULES, enabled, navigation, targetOrigin );
}

/** Every tool name the native runtime may report for a turn. */
export function claudeToolInventory(
	enabled: ClaudeEnabledTools,
	confinement: ClaudeShellConfinement,
	workspace: string,
	navigation: ClaudeNavigationConfinement,
	targetOrigin: string | null
): string[] {
	return [
		...claudeNativeTools( enabled, confinement, workspace ),
		...claudeStudioTools( enabled, navigation, targetOrigin ).map( studioMcpToolName ),
	];
}

/**
 * What this route runs of what a tool's canonical description offers, written
 * from the rules that decide it; undefined for a tool whose description holds
 * as it is. The canonical description, which every route shares, is unchanged.
 */
export function claudeRouteNote( name: string ): string | undefined {
	if ( name === scaffoldThemeTool.name )
		return 'Studio creates a new theme in the selected local site. External fonts must come from Google Fonts. Activation is limited to the new theme.';
	const rule = CLAUDE_STUDIO_TOOL_RULES.get( name );
	if ( rule?.navigates && rule.qualification.qualified )
		return [
			rule.site
				? 'Studio opens the selected local site for this call.'
				: 'Studio can open a public page or the exact origin of the selected local site.',
			'Each call starts a fresh browser. Authenticated editor requests stay on the selected origin. Pages that require unsupported network access stop the tool.',
		].join( ' ' );
	if ( name !== runWpCliTool.name ) return;
	const commands = wpCliRouteCommands();
	const groups = [
		[ 'read', 'Read' ],
		[ 'local-change', 'Change the local site' ],
		[ 'local-overwrite', 'Ask before deleting or replacing local work' ],
		[ 'command', 'Ask before running the command' ],
	] as const;
	const descriptions = groups.map( ( [ operationClass, label ] ) => {
		const forms = commands.filter( ( row ) => row.operationClass === operationClass );
		return label + ': ' + forms.map( ( { usage } ) => `\`${ usage }\`` ).join( ', ' ) + '.';
	} );
	return [
		'Studio runs WP-CLI on the selected local site. Use literal arguments. Pass site-local paths for files.',
		...descriptions,
		'Other commands or unrecognized options require approval for the full argument list. Studio has not checked what an unrecognized command reads or writes. Redirecting the site, loading external configuration, interactive prompts and WP-CLI management are refused.',
		'After an interrupted operation with uncertain effects, ordinary changes also require approval.',
	].join( '\n' );
}

// Why an image failed, as this route tells Claude: of the image service's
// answer only its HTTP status and error code, and Studio's own reasons as they
// are; never the rest of what the service or the network said.
function imageFailureReason( error: string ): string {
	if ( error === IMAGE_NOT_GENERATED_CANCELLED ) return error;
	if ( error.startsWith( 'Image safety filter rejected the prompt' ) )
		return 'the image service’s safety filter refused the prompt; rewrite the subject to avoid the sensitive element and call generate_images again for this image';
	const status = /^(?:Image proxy )?HTTP (\d{3}):/.exec( error )?.[ 1 ];
	if ( ! status ) return 'the image service gave no usable image';
	const code =
		/"code"\s*:\s*"([A-Za-z0-9_.-]{1,64})"/.exec( error )?.[ 1 ] ??
		/"error"\s*:\s*"([A-Za-z0-9_.-]{1,64})"/.exec( error )?.[ 1 ];
	return `the image service answered HTTP ${ status }${ code ? `, error code ${ code }` : '' }`;
}

/**
 * What this route passes to Claude of a completed result's text. For
 * `generate_images`, each failed image's line keeps the image's path as the
 * call named it and gives its reason as `imageFailureReason` words it: a
 * service's answer can run over several lines, so each failure runs from its
 * `FAILED <path>: ` to the next one. Any other text is unchanged, and so is the
 * canonical tool's result on every other route.
 */
export function claudeResultText( name: string, args: unknown, text: string ): string {
	if ( name !== generateImagesTool.name || ! text.includes( 'FAILED ' ) ) return text;
	const images = isRecord( args ) && Array.isArray( args.images ) ? args.images : [];
	const paths = images
		.map( ( image ) => ( isRecord( image ) ? image.path : undefined ) )
		.filter( ( named ): named is string => typeof named === 'string' && named.length > 0 )
		// The longest first, so a path that starts another is not taken for it.
		.sort( ( a, b ) => b.length - a.length );
	const starts: Array< { at: number; named: string } > = [];
	for ( const named of paths )
		for (
			let at = text.indexOf( `FAILED ${ named }: ` );
			at >= 0;
			at = text.indexOf( `FAILED ${ named }: `, at + 1 )
		)
			if (
				( at === 0 || text[ at - 1 ] === '\n' ) &&
				! starts.some( ( start ) => start.at === at )
			)
				starts.push( { at, named } );
	starts.sort( ( a, b ) => a.at - b.at );
	const head = text.slice( 0, starts[ 0 ]?.at ?? text.length );
	// A failure line for no image this call named says nothing of its own.
	if ( /(?:^|\n)FAILED /.test( head ) )
		return 'Studio could not tell which images of this call failed.';
	return (
		head +
		starts
			.map( ( { at, named }, index ) => {
				const end = starts[ index + 1 ]?.at ?? text.length;
				const said = text.slice( at + `FAILED ${ named }: `.length, end ).replace( /\n$/, '' );
				return `FAILED ${ named }: ${ imageFailureReason( said ) }`;
			} )
			.join( '\n' )
	);
}

/** The name the native runtime knows a Studio tool by. */
export function studioMcpToolName( name: string ): string {
	return STUDIO_MCP_PREFIX + name;
}

/** The Studio tool a native MCP tool name refers to, when it is one. */
export function studioToolName( name: string ): string | undefined {
	return name.startsWith( STUDIO_MCP_PREFIX ) ? name.slice( STUDIO_MCP_PREFIX.length ) : undefined;
}

export const HOST_OPERATION_CLASSES: Readonly<
	Record< Exclude< ClaudeHostOperationName, 'sites.wpCli' >, ClaudeOperationClass >
> = {
	'sites.create': 'local-change',
	'sites.start': 'local-change',
	'sites.stop': 'local-change',
	'sites.delete': 'local-overwrite',
	'sites.import': 'local-overwrite',
	'sites.export': 'local-overwrite',
	'previews.create': 'remote-change',
	'previews.update': 'remote-overwrite',
	'previews.delete': 'remote-overwrite',
	'sync.push': 'remote-overwrite',
	// A pull reads a WordPress.com site and changes local work: the site's files
	// and database.
	'sync.pull': 'local-overwrite',
	// Attachments for images the same call writes, and their completion or
	// removal; the guarded host lets a call complete or remove only those it
	// reserved itself.
	'media.reserve': 'local-change',
	'media.finalize': 'local-change',
	selectSite: 'local-change',
	'ui.showArtifact': 'local-change',
};

/** Whether a name is one of the host operations a Studio tool reaches. */
export function isClaudeHostOperation( name: string ): boolean {
	return (
		name === 'sites.wpCli' || Object.prototype.hasOwnProperty.call( HOST_OPERATION_CLASSES, name )
	);
}

/**
 * Whether this build has a rule for a tool or host operation of that name.
 * Recovery takes a tool it does not recognise to have done more than read.
 */
export function isKnownClaudeTool( name: string ): boolean {
	return (
		CLAUDE_STUDIO_TOOL_RULES.has( name ) ||
		CLAUDE_NATIVE_TOOL_RULES.has( name ) ||
		isClaudeHostOperation( name )
	);
}

const CLASS_DESCRIPTIONS: Readonly< Record< ClaudeOperationClass, string > > = {
	read: 'Read',
	'remote-read': 'Read from WordPress.com',
	'local-change': 'Change local work',
	'local-overwrite': 'Change or delete local work',
	'remote-change': 'Change something on WordPress.com',
	'remote-overwrite': 'Change or delete work on WordPress.com',
	'external-message': 'Send a message outside Studio',
	command: 'Run a command',
};

/** What the user is asked to allow. A shell command says how far it reaches. */
export function describeClaudeOperation(
	operationClass: ClaudeOperationClass,
	tool: string,
	shell?: ClaudeShellConfinement
): string {
	if ( shell?.mode === 'sandbox' )
		return `Run ${ tool } in a sandbox. The command starts in the first folder shown and can write in the listed folders and to temporary files.`;
	if ( shell )
		return `Run ${ tool } with your account’s permissions. The command can read and change files outside this workspace.`;
	return `${ CLASS_DESCRIPTIONS[ operationClass ] }: ${ tool }`;
}
