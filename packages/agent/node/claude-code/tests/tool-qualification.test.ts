import { randomUUID } from 'crypto';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { studioToolDefinitions } from '../../tools';
import { createAskUserQuestionTool } from '../../tools/ask-user-question';
import { createPresentDesignOptionsTool } from '../../tools/present-design-options';
import { createSkillTool } from '../../tools/skill';
import {
	CLAUDE_ENABLED_TOOLS,
	CLAUDE_NATIVE_TOOL_RULES,
	CLAUDE_STUDIO_TOOL_RULES,
	CLAUDE_TOOL_CHANNELS,
	claudeNativeTools,
	claudeStudioTools,
	claudeToolInventory,
	isQualifiedStudioRule,
	isVerifiedNavigationGuard,
	selectClaudeStudioTools,
} from '../execution-rules';
import {
	Declared,
	completeGuard,
	createPolicyFixture,
	guarded,
	inherit,
	targetOrigin,
	unverifiableNavigation,
	withAccessor,
	withHidden,
} from './fixtures/execution-policy';
import {
	browserLayer,
	channelEvidence,
	evidenceFiles,
	linksBrowser,
	studioToolModules,
} from './fixtures/tool-sources';

const cleanups: Array< () => Promise< void > > = [];
afterEach( async () => {
	await Promise.all( cleanups.splice( 0 ).map( ( cleanup ) => cleanup() ) );
} );
async function setup( ...args: Parameters< typeof createPolicyFixture > ) {
	const fixture = await createPolicyFixture( ...args );
	cleanups.push( fixture.cleanup );
	return fixture;
}

const studioServer = { name: 'studio', source: 'sdk' };
const channelNames = [
	'readsLocalFiles',
	'writesLocalFiles',
	'drivesBrowser',
	'requestsNetwork',
	'spawnsProcess',
	'runsWpCli',
	'callsHostOperation',
	'reachesWpcom',
];
const noChannels: Record< string, unknown > = Object.fromEntries(
	channelNames.map( ( channel ) => [ channel, false ] )
);
const verifiedSandbox = {
	mode: 'sandbox' as const,
	sandbox: { enabled: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false },
};
const allStudioTools = () => [ ...CLAUDE_STUDIO_TOOL_RULES.keys() ];

// What a tool that acts on the site it names only through the host declares.
const throughHost = {
	...noChannels,
	runsWpCli: [ 'site', 'host' ],
	callsHostOperation: [ 'site', 'host' ],
};
// The tools this build qualifies, each with the channels it declares.
const QUALIFIED: Record< string, Record< string, unknown > > = {
	wp_cli: { ...noChannels, runsWpCli: [ 'site', 'host' ], callsHostOperation: [ 'host' ] },
	site_info: throughHost,
	site_start: throughHost,
	site_stop: throughHost,
	site_delete: throughHost,
	site_import: throughHost,
	site_export: throughHost,
	install_taxonomy_scripts: {
		...throughHost,
		readsLocalFiles: [ 'bundled' ],
		writesLocalFiles: [ 'paths' ],
	},
	refresh_browser: { ...noChannels, runsWpCli: [ 'host' ], callsHostOperation: [ 'host' ] },
	site_create: { ...noChannels, runsWpCli: [ 'host' ], callsHostOperation: [ 'host' ] },
	site_list: {
		...noChannels,
		readsLocalFiles: [ 'config' ],
		runsWpCli: [ 'host' ],
		callsHostOperation: [ 'host' ],
		reachesWpcom: [ 'host' ],
	},
	preview_list: throughHost,
	site_connected_remote_sites: {
		...throughHost,
		readsLocalFiles: [ 'config' ],
		requestsNetwork: [ 'scope' ],
		reachesWpcom: [ 'scope' ],
	},
	wpcom_request: {
		...noChannels,
		readsLocalFiles: [ 'config', 'payloads' ],
		runsWpCli: [ 'host' ],
		callsHostOperation: [ 'host' ],
		requestsNetwork: [ 'scope' ],
		reachesWpcom: [ 'scope' ],
	},
};

// Code a qualified tool's module links but the tool never runs. The scan reads
// whole files, so a helper the tool does not call shows a channel the tool does
// not use. Each entry names the channels, the only files that show them, and
// why the tool never runs that code; it holds only while those files are the
// only ones that show them and the tool declares those channels unused.
const SHARED_CONFIG_SAVE = {
	channels: [ 'spawnsProcess' ],
	files: [ '../common/lib/hide-dir-windows.ts' ],
	why: 'shared-config runs `attrib` only when it saves into a folder it has just created; the tool only reads the stored login (`readAuthToken`)',
};
const UNREACHED: Record<
	string,
	ReadonlyArray< { channels: string[]; files: string[]; why: string } >
> = {
	site_list: [ SHARED_CONFIG_SAVE ],
	site_connected_remote_sites: [ SHARED_CONFIG_SAVE ],
	wpcom_request: [ SHARED_CONFIG_SAVE ],
	preview_list: [
		{
			channels: [ 'requestsNetwork', 'reachesWpcom' ],
			files: [ '../common/lib/snapshots.ts' ],
			why: '`fetchSnapshotUsage` asks WordPress.com for the account’s preview count; the tool only formats the previews the host lists (`getSnapshotLink`, `isSnapshotExpired`)',
		},
	],
};
const isQualifiedName = ( name: string ) => Object.prototype.hasOwnProperty.call( QUALIFIED, name );
// In the order the rule table, and so every enabled list, names them.
const qualifiedTools = () => allStudioTools().filter( isQualifiedName );

// A rule as a later qualification would write it.
const named = ( args: unknown ) => ( args as { nameOrPath?: string } ).nameOrPath;
const noPaths = () => [];
const pageUrl = ( args: unknown ) => [ ( args as { url: string } ).url ];
const account = () => ( {} );
const byMethod = () => 'remote-read' as const;
const qualifiedRule = ( elements: object, channels: unknown ) =>
	( {
		operationClass: 'read',
		approval: 'tool',
		...elements,
		qualification: { qualified: true, channels },
	} ) as never;

describe( 'Claude Studio tool qualification', () => {
	it( 'gives every registered tool, and every tool the sources define, a rule with an explicit qualification state', () => {
		const skill = createSkillTool();
		const registered = [
			...studioToolDefinitions,
			createAskUserQuestionTool( async () => ( {} ) ),
			createPresentDesignOptionsTool(),
			...( skill ? [ skill ] : [] ),
		].map( ( definition ) => definition.name );
		const defined = [ ...new Set( studioToolModules().flatMap( ( module ) => module.names ) ) ];
		expect( defined.sort() ).toEqual( allStudioTools().sort() );
		for ( const name of registered ) expect( defined, name ).toContain( name );

		for ( const [ name, rule ] of CLAUDE_STUDIO_TOOL_RULES ) {
			const state: unknown = Object.getOwnPropertyDescriptor( rule, 'qualification' )?.value;
			expect( Object.prototype.toString.call( state ), name ).toBe( '[object Object]' );
			const { qualified, ...rest } = state as Record< string, unknown >;
			expect( typeof qualified, name ).toBe( 'boolean' );
			if ( qualified ) {
				expect( Object.keys( rest ), name ).toEqual( [ 'channels' ] );
				expect( Object.keys( rest.channels as object ).sort(), name ).toEqual(
					[ ...channelNames ].sort()
				);
			} else {
				const { unbound, ...unknown } = rest;
				expect( unknown, name ).toEqual( {} );
				if ( unbound !== undefined ) {
					expect( ( unbound as string[] ).length, name ).toBeGreaterThan( 0 );
					for ( const channel of unbound as string[] )
						expect( channelNames, name ).toContain( channel );
				}
			}
			expect( isQualifiedStudioRule( rule ), name ).toBe( qualified );
		}
	} );

	it( 'qualifies exactly the tools this build runs, each with every channel declared', () => {
		expect( CLAUDE_TOOL_CHANNELS ).toEqual( channelNames );
		const qualified = [ ...CLAUDE_STUDIO_TOOL_RULES ]
			.filter( ( [ , rule ] ) => isQualifiedStudioRule( rule ) )
			.map( ( [ name ] ) => name );
		expect( qualified ).toEqual( qualifiedTools() );
		expect( [ ...qualified ].sort() ).toEqual( [ ...CLAUDE_ENABLED_TOOLS.studio ].sort() );
		for ( const [ name, channels ] of Object.entries( QUALIFIED ) )
			expect( CLAUDE_STUDIO_TOOL_RULES.get( name )?.qualification, name ).toEqual( {
				qualified: true,
				channels,
			} );
	} );

	it( 'never enables an unqualified tool, whatever the host, confinement or guard declares', async () => {
		const all = allStudioTools();
		const hostLists = [
			all,
			[ ...all ].reverse(),
			[ ...all, ...all ],
			all.filter( ( name ) => name !== 'wp_cli' ),
			...all.map( ( name ) => [ name ] ),
			[ ...all, '__proto__', 'constructor', 'toString', 'hasOwnProperty', '' ],
			[ 'WP_CLI', ' wp_cli', 'wp_cli ', 'mcp__studio__wp_cli', 'mcp__studio__site_push' ],
		];
		const navigations: unknown[] = [
			...unverifiableNavigation( targetOrigin ).map( ( [ , declared ] ) => declared ),
			guarded( targetOrigin ),
			guarded( null ),
		];
		const shells = [ { mode: 'none' }, { mode: 'approval-only' }, verifiedSandbox ];
		const workspace = path.resolve( 'workspace' );
		const native = [ ...CLAUDE_NATIVE_TOOL_RULES.keys() ];
		for ( const origin of [ targetOrigin, null ] )
			for ( const navigation of navigations )
				for ( const studio of hostLists ) {
					const expected = studio.filter( isQualifiedName );
					expect( claudeStudioTools( { native, studio }, navigation as never, origin ) ).toEqual(
						expected
					);
					for ( const shell of shells )
						expect(
							claudeToolInventory(
								{ native, studio },
								shell as never,
								workspace,
								navigation as never,
								origin
							).filter( ( name ) => name.startsWith( 'mcp__' ) )
						).toEqual( expected.map( ( name ) => `mcp__studio__${ name }` ) );
				}

		// The same holds where calls are decided, with everything a host could declare.
		const { policy, host, context } = await setup( ( paths ) => ( {
			enabledTools: { native, studio: all },
			navigationConfinement: guarded( targetOrigin ),
			shellConfinement: {
				mode: 'sandbox',
				sandbox: { ...verifiedSandbox.sandbox, filesystem: { allowWrite: [ paths.site ] } },
			},
		} ) );
		for ( const name of all.filter( ( tool ) => ! isQualifiedName( tool ) ) ) {
			expect(
				await policy.authorizeStudioCall( {
					host,
					name,
					args: { nameOrPath: 'site', url: `${ targetOrigin }/`, siteId: 42, method: 'GET' },
					toolCallId: randomUUID(),
				} ),
				name
			).toBe( false );
			expect(
				await policy.authorizeToolUse( {
					toolName: `mcp__studio__${ name }`,
					input: {},
					toolUseId: randomUUID(),
					mcpServer: studioServer,
				} ),
				name
			).toBe( false );
		}
		expect( context.approve ).not.toHaveBeenCalled();
		expect(
			await policy.authorizeToolUse( {
				toolName: 'mcp__studio__wp_cli',
				input: {},
				mcpServer: studioServer,
			} )
		).toBe( true );
	} );

	it( 'returns no tool, without throwing, for a tool list that is not a plain list of names', () => {
		const smuggle = () => [ 'site_push' ];
		const lists: unknown[] = [
			null,
			undefined,
			'wp_cli',
			[ 'wp_cli' ],
			{},
			{ studio: null },
			{ studio: 'wp_cli' },
			{ studio: { 0: 'wp_cli', length: 1, filter: smuggle } },
			{ studio: Object.assign( [ 'wp_cli' ], { filter: smuggle } ) },
			{ studio: new Proxy( [ 'wp_cli' ], {} ) },
			{ studio: [ Object( 'wp_cli' ) ] },
			{ studio: [ { toString: () => 'wp_cli' } ] },
			{ studio: [ 'wp_cli', 7 ] },
			{ studio: Object.assign( new Array( 3 ), { 0: 'wp_cli', 2: 'site_push' } ) },
			{ studio: new ( class extends Array< string > {} )( 'wp_cli', 'site_push' ) },
			inherit( { studio: [ 'wp_cli' ] } ),
			withAccessor( {}, 'studio', () => [ 'wp_cli' ] ),
			new Declared( { studio: [ 'wp_cli' ] } ),
		];
		for ( const enabled of lists ) {
			let tools: unknown;
			expect( () => {
				tools = claudeStudioTools( enabled as never, guarded( targetOrigin ), targetOrigin );
			} ).not.toThrow();
			expect( tools ).toEqual( [] );
		}
	} );

	it( 'does not count a rule as qualified without a complete channel declaration', () => {
		const accepted: Array< [ string, unknown ] > = [
			[ 'no channels', qualifiedRule( {}, noChannels ) ],
			[ 'a null-prototype declaration', qualifiedRule( {}, inherit( null as never, noChannels ) ) ],
			[
				'WP-CLI through the host',
				qualifiedRule(
					{ site: named, approval: 'host', operationClass: 'command' },
					{ ...noChannels, runsWpCli: [ 'site', 'host' ], callsHostOperation: [ 'host' ] }
				),
			],
			[
				'a browser under the guard',
				qualifiedRule(
					{ urls: pageUrl, navigates: true },
					{ ...noChannels, drivesBrowser: [ 'navigates', 'urls' ] }
				),
			],
			[
				'files by path',
				qualifiedRule(
					{ paths: noPaths, operationClass: 'local-change' },
					{ ...noChannels, readsLocalFiles: [ 'paths' ], writesLocalFiles: [ 'paths' ] }
				),
			],
			[
				'files by path under an approval that shows them',
				qualifiedRule(
					{ paths: noPaths, operationClass: 'local-overwrite' },
					{ ...noChannels, writesLocalFiles: [ 'paths', 'class' ] }
				),
			],
			[
				'files Studio ships, read from the folder the rule names',
				qualifiedRule(
					{ bundled: () => 'skills' },
					{ ...noChannels, readsLocalFiles: [ 'bundled' ] }
				),
			],
			[
				'Studio’s own configuration, read from the files the rule names',
				qualifiedRule(
					{ config: () => [ 'shared.json' ] },
					{ ...noChannels, readsLocalFiles: [ 'config' ] }
				),
			],
			[
				'files read from Studio’s payload folder, which the rule names',
				qualifiedRule(
					{ payloads: () => ( { folder: 'payloads', files: [] } ) },
					{ ...noChannels, readsLocalFiles: [ 'payloads' ] }
				),
			],
			[
				'a message by approval',
				qualifiedRule(
					{ operationClass: 'external-message' },
					{ ...noChannels, requestsNetwork: [ 'class' ] }
				),
			],
			[
				'WordPress.com by scope',
				qualifiedRule(
					{ remote: account, classify: byMethod, operationClass: 'remote-overwrite' },
					{ ...noChannels, reachesWpcom: [ 'scope' ] }
				),
			],
		];
		const base = { operationClass: 'read', approval: 'tool' };
		const without = ( key: string ) => {
			const { [ key ]: _omitted, ...rest } = noChannels;
			return rest;
		};
		const rejected: Array< [ string, unknown ] > = [
			[ 'no qualification', base ],
			[ 'unqualified', { ...base, qualification: { qualified: false } } ],
			[
				'unqualified with a declaration',
				{ ...base, qualification: { qualified: false, channels: noChannels } },
			],
			[ 'qualified without a declaration', { ...base, qualification: { qualified: true } } ],
			[
				'qualified as a number',
				{ ...base, qualification: { qualified: 1, channels: noChannels } },
			],
			[
				'qualified as a string',
				{ ...base, qualification: { qualified: 'true', channels: noChannels } },
			],
			[
				'an extra qualification key',
				{ ...base, qualification: { qualified: true, channels: noChannels, waived: true } },
			],
			...channelNames.flatMap(
				( channel ): Array< [ string, unknown ] > => [
					[ `missing ${ channel }`, qualifiedRule( {}, without( channel ) ) ],
					[
						`undefined ${ channel }`,
						qualifiedRule( {}, { ...noChannels, [ channel ]: undefined } ),
					],
					[ `null ${ channel }`, qualifiedRule( {}, { ...noChannels, [ channel ]: null } ) ],
					[ `true ${ channel }`, qualifiedRule( {}, { ...noChannels, [ channel ]: true } ) ],
					[ `unbound ${ channel }`, qualifiedRule( {}, { ...noChannels, [ channel ]: [] } ) ],
					[
						`${ channel } bound by a name`,
						qualifiedRule( { site: named }, { ...noChannels, [ channel ]: 'site' } ),
					],
					[
						`${ channel } bound by trust`,
						qualifiedRule( {}, { ...noChannels, [ channel ]: [ 'trust' ] } ),
					],
					[
						`inherited ${ channel }`,
						qualifiedRule( {}, inherit( { [ channel ]: false }, without( channel ) ) ),
					],
					[
						`accessor ${ channel }`,
						qualifiedRule(
							{},
							withAccessor( without( channel ), channel, () => false )
						),
					],
				]
			),
			[ 'an unknown channel', qualifiedRule( {}, { ...noChannels, readsEnvironment: false } ) ],
			[
				'a hidden channel',
				qualifiedRule( {}, withHidden( noChannels, 'readsEnvironment', [ 'class' ] ) ),
			],
			[
				'a symbol channel',
				qualifiedRule( {}, { ...noChannels, [ Symbol( 'channel' ) ]: false } ),
			],
			// A binding must name something the rule has.
			[
				'site the rule lacks',
				qualifiedRule( {}, { ...noChannels, runsWpCli: [ 'host', 'site' ] } ),
			],
			[
				'paths the rule lacks',
				qualifiedRule( {}, { ...noChannels, writesLocalFiles: [ 'paths' ] } ),
			],
			[
				'urls the rule lacks',
				qualifiedRule( {}, { ...noChannels, requestsNetwork: [ 'urls' ] } ),
			],
			[ 'scope the rule lacks', qualifiedRule( {}, { ...noChannels, reachesWpcom: [ 'scope' ] } ) ],
			[
				'approval the class does not ask for',
				qualifiedRule( {}, { ...noChannels, requestsNetwork: [ 'class' ] } ),
			],
			[
				'approval a narrowed class may skip',
				qualifiedRule(
					{ classify: byMethod, operationClass: 'remote-overwrite' },
					{ ...noChannels, requestsNetwork: [ 'class' ] }
				),
			],
			// A binding must be one that can bound that channel.
			[
				'files bound by the site name alone',
				qualifiedRule( { site: named }, { ...noChannels, writesLocalFiles: [ 'site' ] } ),
			],
			// An approval of a call shows the local paths its rule names, so a file
			// channel bound by the approval alone would ask the user without them.
			[
				'files written under an approval that names no paths',
				qualifiedRule(
					{ operationClass: 'local-overwrite' },
					{ ...noChannels, writesLocalFiles: [ 'class' ] }
				),
			],
			[
				'files read under an approval that names no paths',
				qualifiedRule(
					{ operationClass: 'external-message' },
					{ ...noChannels, readsLocalFiles: [ 'class' ] }
				),
			],
			// Bundled files are bounded by the folder the rule names, which the
			// policy checks; reading them binds no other channel.
			[
				'bundled files the rule does not name',
				qualifiedRule( {}, { ...noChannels, readsLocalFiles: [ 'bundled' ] } ),
			],
			[
				'files written as if bundled',
				qualifiedRule(
					{ bundled: () => 'skills' },
					{ ...noChannels, readsLocalFiles: [ 'bundled' ], writesLocalFiles: [ 'bundled' ] }
				),
			],
			[
				'a bundled folder without the file channel',
				qualifiedRule( { bundled: () => 'skills' }, noChannels ),
			],
			[
				'a bundled folder that is not a function',
				qualifiedRule( { bundled: 'skills' }, noChannels ),
			],
			// Studio's own configuration is bounded by the files the rule names,
			// which the policy checks; reading them binds no other channel.
			[
				'configuration the rule does not name',
				qualifiedRule( {}, { ...noChannels, readsLocalFiles: [ 'config' ] } ),
			],
			[
				'configuration written as if read',
				qualifiedRule(
					{ config: () => [ 'shared.json' ] },
					{ ...noChannels, readsLocalFiles: [ 'config' ], writesLocalFiles: [ 'config' ] }
				),
			],
			[
				'configuration without the file channel',
				qualifiedRule( { config: () => [ 'shared.json' ] }, noChannels ),
			],
			[
				'configuration that is not a function',
				qualifiedRule( { config: [ 'shared.json' ] }, noChannels ),
			],
			// Files a tool sends from Studio's payload folder are bounded by the
			// files the rule names there, which the policy checks and the approval
			// shows; reading them binds no other channel.
			[
				'payload files the rule does not name',
				qualifiedRule( {}, { ...noChannels, readsLocalFiles: [ 'payloads' ] } ),
			],
			[
				'payload files written as if read',
				qualifiedRule(
					{ payloads: () => ( { folder: 'payloads', files: [] } ) },
					{ ...noChannels, readsLocalFiles: [ 'payloads' ], writesLocalFiles: [ 'payloads' ] }
				),
			],
			[
				'payload files without the file channel',
				qualifiedRule( { payloads: () => ( { folder: 'payloads', files: [] } ) }, noChannels ),
			],
			[
				'payload files that are not a function',
				qualifiedRule( { payloads: { folder: 'payloads', files: [] } }, noChannels ),
			],
			[
				'a process bound by the host guard',
				qualifiedRule( {}, { ...noChannels, spawnsProcess: [ 'host' ] } ),
			],
			[
				'WP-CLI outside the host guard',
				qualifiedRule( { site: named }, { ...noChannels, runsWpCli: [ 'site' ] } ),
			],
			[
				'a browser outside the navigation guard',
				qualifiedRule( { urls: pageUrl }, { ...noChannels, drivesBrowser: [ 'urls' ] } ),
			],
			// The declaration must cover what the rule itself shows.
			[
				'a guard gate without the browser channel',
				qualifiedRule( { navigates: true }, noChannels ),
			],
			[ 'paths without a file channel', qualifiedRule( { paths: noPaths }, noChannels ) ],
			[
				'urls without a browser or network channel',
				qualifiedRule( { urls: pageUrl }, noChannels ),
			],
			[
				'a scope without the WordPress.com channel',
				qualifiedRule( { remote: account }, noChannels ),
			],
			[
				'host approval without the host channel',
				qualifiedRule( { approval: 'host', operationClass: 'command' }, noChannels ),
			],
			// A rule approved at its host operation is admitted without an approval of
			// its own, so files it wrote itself would be written without one that
			// shows them, whatever its class.
			...( [ 'local-change', 'local-overwrite' ] as const ).map(
				( operationClass ): [ string, unknown ] => [
					`files written by a ${ operationClass } rule approved at its host operation`,
					qualifiedRule(
						{ approval: 'host', operationClass, site: named, paths: noPaths },
						{
							...noChannels,
							writesLocalFiles: [ 'paths' ],
							callsHostOperation: [ 'site', 'host' ],
						}
					),
				]
			),
			// A rule has only the elements a rule can have, each of its own kind.
			[
				'an unknown rule element',
				{ ...( qualifiedRule( {}, noChannels ) as object ), navigate: true },
			],
			[ 'a hidden rule element', withHidden( qualifiedRule( {}, noChannels ), 'navigates', true ) ],
			[ 'a mark that is not true', qualifiedRule( { urlsOnSite: 1 }, noChannels ) ],
			[
				'a guard gate that is not true',
				qualifiedRule(
					{ urls: pageUrl, navigates: 'true' },
					{ ...noChannels, drivesBrowser: [ 'navigates', 'urls' ] }
				),
			],
			[ 'an element that is not a function', qualifiedRule( { site: 'site' }, noChannels ) ],
			[ 'an unknown operation class', qualifiedRule( { operationClass: 'harmless' }, noChannels ) ],
			[ 'an unknown approval', qualifiedRule( { approval: 'none' }, noChannels ) ],
			// Only plain data counts.
			[
				'an inherited qualification',
				inherit( { qualification: { qualified: true, channels: noChannels } }, base ),
			],
			[
				'an inherited declaration',
				{ ...base, qualification: inherit( { channels: noChannels }, { qualified: true } ) },
			],
			[
				'an accessor qualification',
				withAccessor( base, 'qualification', () => ( { qualified: true, channels: noChannels } ) ),
			],
			[
				'an accessor declaration',
				{
					...base,
					qualification: withAccessor( { qualified: true }, 'channels', () => noChannels ),
				},
			],
			[ 'a declaration as a class instance', qualifiedRule( {}, new Declared( noChannels ) ) ],
			[ 'a declaration as a Map', qualifiedRule( {}, new Map( Object.entries( noChannels ) ) ) ],
			[ 'a declaration as a proxy', qualifiedRule( {}, new Proxy( { ...noChannels }, {} ) ) ],
			[
				'bindings as a proxy',
				qualifiedRule(
					{ paths: noPaths },
					{ ...noChannels, writesLocalFiles: new Proxy( [ 'paths' ], {} ) }
				),
			],
			[
				'bindings with a gap',
				qualifiedRule(
					{ paths: noPaths },
					{ ...noChannels, writesLocalFiles: Object.assign( new Array( 2 ), { 1: 'paths' } ) }
				),
			],
			[ 'a rule as a class instance', new Declared( qualifiedRule( {}, noChannels ) ) ],
			[ 'a rule as a proxy', new Proxy( qualifiedRule( {}, noChannels ) as object, {} ) ],
			[ 'a rule as a string', 'qualified' ],
			[ 'a null rule', null ],
			[ 'no rule', undefined ],
		];
		const enabled = { native: [], studio: [ 'tool' ] };
		const select = ( rule: unknown ) =>
			selectClaudeStudioTools(
				new Map( [ [ 'tool', rule ] ] ) as never,
				enabled,
				guarded( targetOrigin ),
				targetOrigin
			);
		for ( const [ label, rule ] of accepted ) {
			expect( isQualifiedStudioRule( rule ), label ).toBe( true );
			expect( select( rule ), label ).toEqual( [ 'tool' ] );
		}
		for ( const [ label, rule ] of rejected ) {
			let qualified: unknown;
			let tools: unknown;
			expect( () => {
				qualified = isQualifiedStudioRule( rule );
				tools = select( rule );
			}, label ).not.toThrow();
			expect( qualified, label ).toBe( false );
			expect( tools, label ).toEqual( [] );
		}
	} );

	it( 'enables a qualified browser tool only under a verified navigation guard', () => {
		const rules = new Map( [
			[
				'browse',
				qualifiedRule(
					{ urls: pageUrl, navigates: true },
					{ ...noChannels, drivesBrowser: [ 'navigates', 'urls' ] }
				),
			],
			[ 'plain', qualifiedRule( {}, noChannels ) ],
			[
				'pending',
				{ operationClass: 'read', approval: 'tool', qualification: { qualified: false } },
			],
		] ) as never;
		const enabled = { native: [], studio: [ 'browse', 'plain', 'pending', 'unknown' ] };
		for ( const origin of [ targetOrigin, null ] ) {
			expect( selectClaudeStudioTools( rules, enabled, guarded( origin ), origin ) ).toEqual( [
				'browse',
				'plain',
			] );
			for ( const [ label, declared ] of unverifiableNavigation( origin ) )
				expect(
					selectClaudeStudioTools( rules, enabled, declared as never, origin ),
					label
				).toEqual( [ 'plain' ] );
		}
		expect( selectClaudeStudioTools( rules, enabled, guarded( targetOrigin ), null ) ).toEqual( [
			'plain',
		] );
		expect( selectClaudeStudioTools( rules, enabled, guarded( null ), targetOrigin ) ).toEqual( [
			'plain',
		] );
	} );

	it( 'keeps its rules and the enabled set out of reach of run-time changes', () => {
		const forged = {
			operationClass: 'read',
			approval: 'tool',
			qualification: { qualified: true, channels: noChannels },
		};
		const table = CLAUDE_STUDIO_TOOL_RULES as unknown as Map< string, unknown >;
		const rule = ( name: string ) =>
			CLAUDE_STUDIO_TOOL_RULES.get( name ) as never as {
				qualification: { qualified: boolean; channels: Record< string, string[] > };
			};
		const attempts: Array< () => unknown > = [
			() => table.set( 'site_push', forged ),
			() => Map.prototype.set.call( table, 'site_push', forged ),
			() => Map.prototype.delete.call( table, 'wp_cli' ),
			() => table.clear(),
			() => Object.assign( table, { get: () => forged } ),
			() => Object.assign( rule( 'site_push' ), forged ),
			() => ( rule( 'site_push' ).qualification.qualified = true ),
			() =>
				Object.defineProperty( rule( 'site_push' ), 'qualification', {
					value: forged.qualification,
				} ),
			() => Object.setPrototypeOf( rule( 'site_push' ), forged ),
			() => Object.assign( rule( 'take_screenshot' ), { navigates: undefined } ),
			() => rule( 'wp_cli' ).qualification.channels.runsWpCli.pop(),
			() => ( rule( 'wp_cli' ).qualification.channels.callsHostOperation = [] ),
			() => ( CLAUDE_NATIVE_TOOL_RULES as unknown as Map< string, unknown > ).set( 'Bash', forged ),
			() => Object.assign( CLAUDE_NATIVE_TOOL_RULES.get( 'Bash' ) as object, { shell: undefined } ),
			() => ( CLAUDE_ENABLED_TOOLS.studio as string[] ).push( 'site_push' ),
			() => ( CLAUDE_TOOL_CHANNELS as unknown as string[] ).pop(),
		];
		for ( const attempt of attempts ) expect( attempt ).toThrow( TypeError );

		const all = { native: [ ...CLAUDE_NATIVE_TOOL_RULES.keys() ], studio: allStudioTools() };
		const enabledNow = () => [
			claudeStudioTools( all, guarded( targetOrigin ), targetOrigin ),
			claudeNativeTools( all, { mode: 'none' }, path.resolve( 'workspace' ) ),
		];
		const unconfinedNative = [ 'Read', 'Grep', 'Glob', 'LS', 'Write', 'Edit', 'MultiEdit' ];
		expect( enabledNow() ).toEqual( [ qualifiedTools(), unconfinedNative ] );
		expect( rule( 'site_push' ).qualification ).toEqual( { qualified: false } );

		// Values planted on the prototype every plain object shares are not declarations.
		const planted: Record< string, unknown > = {
			qualification: forged.qualification,
			qualified: true,
			channels: noChannels,
			mode: 'guarded',
			guard: completeGuard( targetOrigin ),
			...completeGuard( targetOrigin ),
			studio: [ 'site_push' ],
			classify: () => 'read',
			remote: account,
			urls: pageUrl,
			paths: noPaths,
			urlsOnSite: true,
			shell: true,
		};
		const elements = [ 'classify', 'remote', 'urls', 'paths', 'urlsOnSite', 'shell' ];
		const stated = ( item: unknown ) =>
			elements.map( ( key ) => typeof ( item as Record< string, unknown > )[ key ] );
		const prototype = Object.prototype as unknown as Record< string, unknown >;
		let whilePlanted: unknown[] = [];
		try {
			Object.assign( prototype, planted );
			whilePlanted = [
				enabledNow(),
				claudeStudioTools( {} as never, {} as never, targetOrigin ),
				isQualifiedStudioRule( { operationClass: 'read', approval: 'tool' } ),
				isVerifiedNavigationGuard( {} as never, targetOrigin ),
				isVerifiedNavigationGuard( { mode: 'guarded', guard: {} } as never, targetOrigin ),
				// A rule has only the elements it states, so none of the planted ones:
				// `wp_cli` states only its own `classify`, which still applies.
				stated( rule( 'wp_cli' ) ),
				( rule( 'wp_cli' ) as never as { classify( args: unknown ): unknown } ).classify( {
					nameOrPath: 'site',
					command: 'post create --post_status=draft --post_title=Hello',
				} ),
				stated( CLAUDE_NATIVE_TOOL_RULES.get( 'Read' ) ),
			];
		} finally {
			for ( const key of Object.keys( planted ) ) delete prototype[ key ];
		}
		expect( ( {} as Record< string, unknown > ).qualification ).toBeUndefined();
		expect( whilePlanted ).toEqual( [
			[ qualifiedTools(), unconfinedNative ],
			[],
			false,
			false,
			false,
			elements.map( ( key ) => ( key === 'classify' ? 'function' : 'undefined' ) ),
			'command',
			elements.map( () => 'undefined' ),
		] );
	} );
} );

describe( 'Claude Studio tools that drive a browser', () => {
	it( 'gates every tool whose module links the browser layer on the navigation guard, and no other tool', () => {
		const modules = studioToolModules();
		const linked = ( name: string ) => modules.find( ( module ) => module.names.includes( name ) )!;
		// The scan has to see the known routes into the browser, or it proves nothing.
		expect( browserLayer( modules ) ).toEqual( [ 'node/browser-utils.ts' ] );
		expect( linked( 'take_screenshot' ).files ).toContain( 'node/tools/screenshot-helpers.ts' );
		expect( linked( 'open_annotation_browser' ).files ).toContain(
			'node/inspector/inspector-inject.ts'
		);
		expect( linksBrowser( linked( 'take_screenshot' ) ) ).toBe( true );
		expect( linksBrowser( linked( 'open_annotation_browser' ) ) ).toBe( true );
		expect( linksBrowser( linked( 'wp_cli' ) ) ).toBe( false );

		for ( const module of modules )
			for ( const name of module.names )
				expect(
					CLAUDE_STUDIO_TOOL_RULES.get( name )?.navigates === true,
					`${ name } (${ module.file })`
				).toBe( linksBrowser( module ) );
	} );

	it( 'gates present_design_options and leaves it unqualified, with the channels nothing binds on record', () => {
		const rule = CLAUDE_STUDIO_TOOL_RULES.get( 'present_design_options' )!;
		expect( rule.navigates ).toBe( true );
		expect( rule.qualification ).toEqual( {
			qualified: false,
			unbound: [ 'readsLocalFiles', 'writesLocalFiles' ],
		} );
		const module = studioToolModules().find( ( item ) =>
			item.names.includes( 'present_design_options' )
		)!;
		expect( channelEvidence( module ) ).toEqual(
			expect.arrayContaining( [ [ 'drivesBrowser' ], [ 'readsLocalFiles', 'writesLocalFiles' ] ] )
		);
		const enabled = { native: [], studio: [ 'present_design_options', 'take_screenshot' ] };
		for ( const navigation of [ { mode: 'none' }, guarded( targetOrigin ) ] )
			expect( claudeStudioTools( enabled, navigation as never, targetOrigin ) ).toEqual( [] );
	} );

	it( 'declares, for each qualified tool, every channel its module shows', () => {
		const modules = studioToolModules();
		let checked = 0;
		for ( const module of modules )
			for ( const name of module.names ) {
				const rule = CLAUDE_STUDIO_TOOL_RULES.get( name )!;
				if ( ! isQualifiedStudioRule( rule ) ) continue;
				checked++;
				const { channels } = rule.qualification as { channels: Record< string, unknown > };
				const shown = channelEvidence( module );
				for ( const explained of shown ) {
					const used = explained.some( ( channel ) => channels[ channel ] !== false );
					const unreached = UNREACHED[ name ]?.find(
						( entry ) => entry.channels.join() === explained.join()
					);
					if ( unreached && ! used ) {
						expect( evidenceFiles( module, explained ), `${ name }: ${ unreached.why }` ).toEqual(
							unreached.files
						);
						continue;
					}
					expect( used, `${ name } shows ${ explained.join( ' or ' ) }` ).toBe( true );
				}
				// An entry for code the tool no longer links, or for a channel it
				// declares, is out of date.
				for ( const entry of UNREACHED[ name ] ?? [] ) {
					expect(
						shown.map( ( group ) => group.join() ),
						`${ name }: ${ entry.why }`
					).toContain( entry.channels.join() );
					expect(
						entry.channels.every( ( channel ) => channels[ channel ] === false ),
						`${ name }: ${ entry.why }`
					).toBe( true );
				}
			}
		expect( checked ).toBe( CLAUDE_ENABLED_TOOLS.studio.length );
		expect( Object.keys( UNREACHED ).filter( ( name ) => ! isQualifiedName( name ) ) ).toEqual(
			[]
		);
		const wpCli = modules.find( ( module ) => module.names.includes( 'wp_cli' ) )!;
		expect( wpCli.files ).toEqual( [
			'node/tools/wp-cli.ts',
			'node/tools/define-tool.ts',
			'node/tools/wp-cli-post-content.ts',
		] );
		expect( channelEvidence( wpCli ) ).toEqual( [ [ 'callsHostOperation' ], [ 'runsWpCli' ] ] );
	} );
} );
