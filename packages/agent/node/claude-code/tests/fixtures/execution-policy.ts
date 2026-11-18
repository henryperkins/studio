import { mkdir, mkdtemp, realpath, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { expect, vi } from 'vitest';
import { createFakeHost, fakeSite } from '../../../tests/fake-host';
import {
	CLAUDE_EXECUTION_POLICY_REVISION,
	createClaudeExecutionPolicy,
} from '../../execution-policy';
import { CLAUDE_ENABLED_TOOLS, CLAUDE_NAVIGATION_RULE_REVISION } from '../../execution-rules';
import type { StudioAgentHost } from '../../../host';
import type { ClaudeExecutionContext, ClaudeExecutionPolicy } from '../../execution-policy';
import type {
	BackendTurnEvent,
	ClaudeOperationJournalEvent,
} from '@studio/agent/protocol/backend-events';

export const targetOrigin = new URL( fakeSite.url ).origin;

// Host-level tests exercise the second authorization, after the bridge has admitted its tool.
export async function admitWpCliRead(
	policy: ClaudeExecutionPolicy,
	host: StudioAgentHost,
	toolCallId = 'call'
) {
	expect(
		await policy.authorizeStudioCall( {
			host,
			name: 'wp_cli',
			args: { nameOrPath: 'site', command: 'post list' },
			toolCallId,
		} )
	).toBe( true );
}

// Everything a browser-layer guard must guarantee before a tool may drive a browser.
export const navigationGuarantees = [
	'checksEveryRequest',
	'checksEveryRedirect',
	'appliesOriginRule',
	'checksResolvedAddresses',
	'pinsCheckedAddress',
	'confinesFileDocuments',
	'blocksUncheckedChannels',
	'failsClosed',
] as const;
export const completeGuard = ( origin: string | null ) => ( {
	ruleRevision: CLAUDE_NAVIGATION_RULE_REVISION,
	targetOrigin: origin,
	...Object.fromEntries( navigationGuarantees.map( ( key ) => [ key, true ] ) ),
} );
export const guarded = ( origin: string | null ) =>
	( { mode: 'guarded', guard: completeGuard( origin ) } ) as never;

export const inherit = ( prototype: object, own: object = {} ): object =>
	Object.assign( Object.create( prototype ), own );
export const withAccessor = ( base: object, key: string, get: () => unknown ): object =>
	Object.defineProperty( { ...base }, key, { get, enumerable: true, configurable: true } );
export const withHidden = ( base: object, key: string | symbol, value: unknown ): object =>
	Object.defineProperty( { ...base }, key, { value, enumerable: false, configurable: true } );
export class Declared {
	constructor( fields: object ) {
		Object.assign( this, fields );
	}
}
const throwing = (): never => {
	throw new Error( 'trap' );
};

/** Navigation declarations no policy may verify for `origin`, each with a label. */
export function unverifiableNavigation( origin: string | null ): Array< [ string, unknown ] > {
	const complete: Record< string, unknown > = completeGuard( origin );
	const guard = ( value: unknown ) => ( { mode: 'guarded', guard: value } );
	const without = ( key: string ) => {
		const { [ key ]: _omitted, ...rest } = complete;
		return rest;
	};
	return [
		[ 'mode none', { mode: 'none' } ],
		[ 'no guard', { mode: 'guarded' } ],
		[ 'undefined guard', guard( undefined ) ],
		[ 'null guard', guard( null ) ],
		[ 'string guard', guard( 'verified' ) ],
		[ 'array guard', guard( [ complete ] ) ],
		[ 'unknown mode', { mode: 'unknown', guard: complete } ],
		[ 'mode none with a guard', { mode: 'none', guard: complete } ],
		...navigationGuarantees.flatMap(
			( key ): Array< [ string, unknown ] > => [
				[ `missing ${ key }`, guard( without( key ) ) ],
				[ `false ${ key }`, guard( { ...complete, [ key ]: false } ) ],
				[ `string ${ key }`, guard( { ...complete, [ key ]: 'true' } ) ],
				[ `number ${ key }`, guard( { ...complete, [ key ]: 1 } ) ],
				[ `boxed ${ key }`, guard( { ...complete, [ key ]: Object( true ) } ) ],
				[ `inherited ${ key }`, guard( inherit( { [ key ]: true }, without( key ) ) ) ],
				[ `accessor ${ key }`, guard( withAccessor( without( key ), key, () => true ) ) ],
				[ `hidden ${ key }`, guard( withHidden( without( key ), key, true ) ) ],
			]
		),
		[ 'undefined revision', guard( { ...complete, ruleRevision: undefined } ) ],
		[
			'next revision',
			guard( { ...complete, ruleRevision: CLAUDE_NAVIGATION_RULE_REVISION + 1 } ),
		],
		[
			'previous revision',
			guard( { ...complete, ruleRevision: CLAUDE_NAVIGATION_RULE_REVISION - 1 } ),
		],
		[ 'string revision', guard( { ...complete, ruleRevision: '2' } ) ],
		[ 'another origin', guard( { ...complete, targetOrigin: 'http://localhost:8889' } ) ],
		[ 'origin with a slash', guard( { ...complete, targetOrigin: `${ origin }/` } ) ],
		[ 'opposite origin', guard( { ...complete, targetOrigin: origin === null ? '' : null } ) ],
		[ 'undefined origin', guard( { ...complete, targetOrigin: undefined } ) ],
		[ 'missing origin', guard( without( 'targetOrigin' ) ) ],
		[ 'extra guard list', guard( { ...complete, allowPrivateAddresses: [ '127.0.0.1' ] } ) ],
		[ 'extra guard key', guard( { ...complete, exceptions: [] } ) ],
		[ 'hidden guard key', guard( withHidden( complete, 'exceptions', [ '127.0.0.1' ] ) ) ],
		[ 'symbol guard key', guard( { ...complete, [ Symbol( 'exceptions' ) ]: [] } ) ],
		[ 'hidden symbol guard key', guard( withHidden( complete, Symbol( 'exceptions' ), [] ) ) ],
		[ 'guard inheriting everything', guard( inherit( complete ) ) ],
		[ 'guard as a class instance', guard( new Declared( complete ) ) ],
		[ 'guard as a Map', guard( new Map( Object.entries( complete ) ) ) ],
		[ 'guard as a proxy', guard( new Proxy( { ...complete }, {} ) ) ],
		[ 'guard as a function', guard( Object.assign( () => true, complete ) ) ],
		[ 'extra top-level list', { ...guard( complete ), exceptions: [ '127.0.0.1' ] } ],
		[ 'extra top-level flag', { ...guard( complete ), allowPrivateAddresses: true } ],
		[ 'hidden top-level key', withHidden( guard( complete ), 'exceptions', [] ) ],
		[ 'symbol top-level key', { ...guard( complete ), [ Symbol.for( 'exceptions' ) ]: [] } ],
		[ 'inherited declaration', inherit( guard( complete ) ) ],
		[ 'inherited mode', inherit( { mode: 'guarded' }, { guard: complete } ) ],
		[ 'inherited guard', inherit( { guard: complete }, { mode: 'guarded' } ) ],
		[ 'accessor mode', withAccessor( { guard: complete }, 'mode', () => 'guarded' ) ],
		[ 'accessor guard', withAccessor( { mode: 'guarded' }, 'guard', () => complete ) ],
		[ 'throwing accessor', withAccessor( guard( complete ), 'mode', throwing ) ],
		[ 'declaration as a class instance', new Declared( guard( complete ) ) ],
		[ 'declaration as a Map', new Map( Object.entries( guard( complete ) ) ) ],
		[ 'declaration as a proxy', new Proxy( guard( complete ), {} ) ],
		[
			'declaration as a throwing proxy',
			new Proxy( {}, { get: throwing, ownKeys: throwing, getPrototypeOf: throwing } ),
		],
		[ 'declaration as an array', [ 'guarded', complete ] ],
		[ 'declaration as a function', Object.assign( () => true, guard( complete ) ) ],
		[ 'declaration as a string', 'guarded' ],
		[ 'declaration as a number', 1 ],
		[ 'null declaration', null ],
		[ 'undefined declaration', undefined ],
	];
}

// A policy for a local-site turn on a real temporary site directory, with a fake
// host whose operations are spies. A second site, `other`, lives next to it.
export async function createPolicyFixture(
	overrides: ( paths: {
		site: string;
		other: string;
		config: string;
		parent: string;
	} ) => Partial< ClaudeExecutionContext > = () => ( {} )
) {
	const parent = await realpath(
		await mkdtemp( path.join( os.tmpdir(), 'studio-claude-policy-' ) )
	);
	const site = path.join( parent, 'site' );
	const other = path.join( parent, 'other' );
	const config = path.join( parent, 'config' );
	await mkdir( site );
	await mkdir( other );
	await mkdir( config );
	const host = createFakeHost( parent );
	const localSite = { ...fakeSite, path: site };
	const otherSite = {
		...fakeSite,
		id: 'other-site',
		name: 'Other',
		path: other,
		url: 'http://other-site.example:8890',
	};
	const byReference = ( reference: string ) =>
		reference === 'other' || path.resolve( reference ) === other ? otherSite : localSite;
	host.sites.resolve = vi.fn( async ( reference: string ) => byReference( reference ) );
	host.sites.findByFolder = vi.fn( async ( folder: string ) =>
		[ site, other ].includes( path.resolve( folder ) ) ? byReference( folder ) : undefined
	);
	host.sites.all = vi.fn( async () => [ localSite, otherSite ] );
	const controller = new AbortController();
	const events: BackendTurnEvent[] = [];
	// What the policy wrote to the turn's journal before letting an operation run.
	const journal: ClaudeOperationJournalEvent[] = [];
	const clock = { now: 0 };
	const context: ClaudeExecutionContext = {
		runId: 'run',
		turnId: 'turn',
		connectionId: 'connection',
		connectionRevision: 1,
		policyRevision: CLAUDE_EXECUTION_POLICY_REVISION,
		target: { environment: 'local', siteId: fakeSite.id },
		workspace: { siteId: fakeSite.id, workingDirectory: site, configDirectory: config },
		targetSite: { id: fakeSite.id, path: site, url: fakeSite.url },
		localRoots: [ site ],
		isStudioSite: async ( folder ) => !! ( await host.sites.findByFolder( folder ) ),
		enabledTools: CLAUDE_ENABLED_TOOLS,
		shellConfinement: { mode: 'none' },
		navigationConfinement: { mode: 'none' },
		signal: controller.signal,
		approve: vi.fn( async () => 'allow' as const ),
		approvalTimeoutMs: 100,
		ready: () => true,
		stillConnected: vi.fn( async () => true ),
		verifyAccount: vi.fn( async () => 'same' as const ),
		accountVerifiedAt: 0,
		now: () => clock.now,
		verifyTarget: vi.fn( async () => true ),
		onEvent: ( event ) => events.push( event ),
		recordOperation: async ( event ) => {
			journal.push( event );
		},
		...overrides( { site, other, config, parent } ),
	};
	return {
		policy: createClaudeExecutionPolicy( context ),
		context,
		host,
		localSite,
		otherSite,
		controller,
		events,
		journal,
		clock,
		site,
		other,
		config,
		parent,
		cleanup: () => rm( parent, { recursive: true, force: true } ),
	};
}
