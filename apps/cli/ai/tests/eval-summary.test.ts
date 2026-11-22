// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findUnsafeRecord, openAcceptanceEvidence } from 'cli/ai/acceptance-evidence';
import { liveEvalRunFacts } from 'cli/ai/eval-run-facts';
import {
	evalCaseSummary,
	evalSummaryDirectory,
	writeEvalCaseSummary,
	type EvalRunFacts,
	type EvalSummarySource,
} from 'cli/ai/eval-summary';
import type { ExecutedRoute, RequestedRoute } from 'cli/ai/eval-provider';

// Test values only.
const NAME = 'Jordan Q. Example';
const EMAIL = 'jordan.example@example.org';
const SITE_URL = 'https://jordans-site.wordpress.com';
const SITE_ID = '987654';
const HOME = 'C:\\Users\\jordan\\Studio\\parity';
const leak = `${ NAME } <${ EMAIL }> at ${ SITE_URL } (site ${ SITE_ID }) in ${ HOME }`;
const FACTS: EvalRunFacts = {
	source: { sha: '0123456789abcdef0123456789abcdef01234567', dirty: true },
	platform: { os: 'win32', release: '10.0.26320', arch: 'x64' },
	runtime: { node: '24.22.1', npm: '11.13.0' },
	build: { cliVersion: '1.2.3', buildId: '0123456789ab' },
};

const requested: RequestedRoute = {
	kind: 'chatgpt-oauth',
	backend: 'chatgpt-route',
	subscription: true,
	connectionRef: 'conn-0123456789ab',
	model: 'gpt-6-luna',
	wireModel: 'gpt-6-luna',
	effort: 'medium',
};
const executed = ( overrides: Partial< ExecutedRoute > = {} ): ExecutedRoute => ( {
	kind: 'chatgpt-oauth',
	backend: 'chatgpt-route',
	modelRequests: 3,
	apiKeyBearers: 0,
	imageServiceRequests: 0,
	models: [ 'gpt-6-luna' ],
	efforts: [ 'medium' ],
	replyKinds: [ 'chatgpt-oauth' ],
	replyModels: [ 'gpt-6-luna' ],
	connectionRef: 'conn-0123456789ab',
	connectionMatchesBearer: true,
	requests: [],
	...overrides,
} );

// A result whose every free-text field carries an account, an address, a site id and a path.
const seeded = ( overrides: Record< string, unknown > = {} ) =>
	( {
		success: true,
		timedOut: false,
		error: leak,
		errorMessage: leak,
		textSegments: [ leak ],
		toolCalls: [ { id: 'c0', name: 'site_push', input: { remoteSite: SITE_URL } } ],
		toolResults: [
			{
				toolName: 'generate_images',
				text: leak,
				details: { studioService: { account: { displayName: NAME, email: EMAIL } } },
			},
		],
		remoteCalls: [ { operation: 'push', site: NAME, target: SITE_URL, designated: true } ],
		remoteGuard: { code: null, blocked: [], allowed: [ { method: 'POST', via: 'http' } ] },
		providerRoute: { requested, executed: executed() },
		turns: [ {}, {} ],
		compactions: 1,
		sessionFile: path.join( HOME, 'session.jsonl' ),
		phaseTimingsMs: { total_eval_ms: 12_345 },
		...overrides,
	} ) as unknown as EvalSummarySource;

const forCase = { caseId: 'parity-push-approved', provider: 'chatgpt-oauth' };

describe( 'the sanitized summary of a provider-qualified eval case', () => {
	let dir: string;
	const write = ( result: EvalSummarySource, options: Record< string, unknown > = {} ) =>
		writeEvalCaseSummary( result, {
			...forCase,
			directory: dir,
			facts: FACTS,
			createdOn: '2026-11-17',
			...options,
		} );
	const runDirectory = ( provider = 'chatgpt-oauth', stage = 'parity-push-approved' ) =>
		path.join( dir, provider, stage );
	const everything = () =>
		fs
			.readdirSync( dir, { recursive: true, withFileTypes: true } )
			.filter( ( entry ) => entry.isFile() )
			.map( ( entry ) => fs.readFileSync( path.join( entry.parentPath, entry.name ), 'utf8' ) )
			.join( '\n' );

	beforeEach( () => {
		dir = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-eval-summary-test-' ) );
	} );

	afterEach( () => {
		fs.rmSync( dir, { recursive: true, force: true, maxRetries: 5 } );
	} );

	it( 'records the route it judges, says it judges none of the case’s checks, and holds counts and booleans, nothing the run wrote', () => {
		const { location, record } = write( seeded() );
		expect( record ).toEqual( {
			schemaVersion: 1,
			run: 1,
			scenario: 'eval-route-chatgpt-oauth',
			stage: 'parity-push-approved',
			status: 'passed',
			durationS: 12.3,
			observations: {
				judgesCaseChecks: false,
				everyCheckRecorded: false,
				success: true,
				timedOut: false,
				modelRequests: 3,
				apiKeyBearers: 0,
				imageServiceRequests: 0,
				kindMatches: true,
				backendMatches: true,
				connectionMatches: true,
				bearerMatches: true,
				bearerUnverified: false,
				otherModels: 0,
				otherEfforts: 0,
				otherReplyProviders: 0,
				replyModelsMatchRequests: true,
				guardRefused: 0,
				stagingWritesAllowed: 1,
				remoteCalls: 1,
				designatedRemoteCalls: 1,
				turns: 2,
				toolCalls: 1,
				compactions: 1,
			},
		} );
		expect( location ).toEqual( {
			directory: runDirectory(),
			run: 1,
			stage: 'parity-push-approved',
		} );
		expect( findUnsafeRecord( record ) ).toBeNull();
		const evidence = openAcceptanceEvidence( runDirectory(), 'chatgpt-oauth' );
		expect( evidence.readRecords() ).toEqual( [ record ] );
		const written = everything();
		for ( const value of [ NAME, EMAIL, 'jordans-site', SITE_ID, 'jordan', 'Users', 'example' ] ) {
			expect( written.toLowerCase() ).not.toContain( value.toLowerCase() );
		}
	} );

	it( 'identifies the model, the reasoning effort and the source revision each run ran with, in the evidence manifest', () => {
		write( seeded() );
		write( seeded(), {
			facts: { ...FACTS, source: { sha: null, dirty: null } },
			createdOn: '2026-11-18',
		} );
		const manifest = openAcceptanceEvidence( runDirectory(), 'chatgpt-oauth' ).readManifest();
		expect( manifest ).toEqual( {
			schemaVersion: 1,
			provider: 'chatgpt-oauth',
			runs: [
				{
					run: 1,
					scenario: 'eval-chatgpt-oauth',
					createdOn: '2026-11-17',
					...FACTS,
					model: 'gpt-6-luna',
					effort: 'medium',
					gates: [],
				},
				{
					run: 2,
					scenario: 'eval-chatgpt-oauth',
					createdOn: '2026-11-18',
					...FACTS,
					source: { sha: null, dirty: null },
					model: 'gpt-6-luna',
					effort: 'medium',
					gates: [],
				},
			],
		} );
	} );

	it( 'names what a run refused before its route was resolved selected, a legacy provider’s effort as none, and anything else as unresolved', () => {
		write( { success: false, refusal: { code: 'connection-signed-out' } } as EvalSummarySource, {
			selection: { model: 'gpt-6-luna', effort: 'low' },
		} );
		write( { success: false, refusal: { code: 'provider-unknown' } } as EvalSummarySource, {
			selection: { model: SITE_URL, effort: EMAIL },
		} );
		write(
			seeded( {
				providerRoute: {
					requested: { ...requested, kind: 'wpcom', model: 'claude-sonnet-5', effort: null },
					executed: executed(),
				},
			} )
		);
		const runs = openAcceptanceEvidence( runDirectory(), 'chatgpt-oauth' ).readManifest()?.runs;
		expect( runs?.map( ( run ) => [ run.model, run.effort ] ) ).toEqual( [
			[ 'gpt-6-luna', 'low' ],
			[ 'unresolved', 'unresolved' ],
			[ 'claude-sonnet-5', 'none' ],
		] );
	} );

	it.each( [
		[
			'refused before it ran',
			{ success: false, refusal: { code: 'connection-signed-out', message: leak } },
			'blocked',
			'connection-signed-out',
		],
		[
			'refused because its profile was not its own',
			{ success: false, refusal: { code: 'case-profile-not-isolated', message: leak } },
			'blocked',
			'case-profile-not-isolated',
		],
		[
			'blocked by the route’s capabilities',
			{ success: false, blocked: { code: 'tool-images-not-qualified', message: leak } },
			'blocked',
			'tool-images-not-qualified',
		],
		[
			'stopped by the write guard',
			{
				success: false,
				remoteGuard: { code: 'wpcom-write-under-mock', blocked: [ {} ] },
			},
			'failed',
			'wpcom-write-under-mock',
		],
		[ 'timed out', { timedOut: true }, 'failed', 'timed-out' ],
		[
			'run on an API key',
			{ providerRoute: { requested, executed: executed( { apiKeyBearers: 1 } ) } },
			'failed',
			'api-key-bearer',
		],
		[
			'served by another account',
			{ providerRoute: { requested, executed: executed( { connectionMatchesBearer: false } ) } },
			'failed',
			'connection-mismatch',
		],
		[
			'without a comparable bearer',
			{
				providerRoute: {
					requested,
					executed: executed( { connectionMatchesBearer: 'unverified' } ),
				},
			},
			'failed',
			'connection-unverified',
		],
		[
			'on another backend',
			{
				providerRoute: {
					requested,
					executed: executed( { kind: 'openai-api-key', backend: 'openai-api' } ),
				},
			},
			'failed',
			'route-mismatch',
		],
		[
			'with no model request',
			{ providerRoute: { requested, executed: executed( { modelRequests: 0 } ) } },
			'failed',
			'no-model-request',
		],
		[
			'naming another model',
			{ providerRoute: { requested, executed: executed( { models: [ 'gpt-6.1-sol' ] } ) } },
			'failed',
			'model-mismatch',
		],
		[ 'failing on its own', { success: false }, 'failed', 'run-failed' ],
	] )( 'is %s: %s with its code', ( _name, overrides, status, code ) => {
		const { record } = write( seeded( overrides ) );
		expect( record ).toMatchObject( { status, code } );
		expect( findUnsafeRecord( record ) ).toBeNull();
		expect( JSON.stringify( record ) ).not.toMatch( /jordan|example/i );
	} );

	it( 'says every check of the case writes a record only when the case’s configuration declares it', () => {
		expect( write( seeded() ).record.observations ).toMatchObject( { everyCheckRecorded: false } );
		expect( write( seeded(), { everyCheckRecorded: false } ).record.observations ).toMatchObject( {
			everyCheckRecorded: false,
		} );
		expect( write( seeded(), { everyCheckRecorded: true } ).record.observations ).toMatchObject( {
			everyCheckRecorded: true,
		} );
		expect(
			evalCaseSummary( seeded(), { ...forCase, everyCheckRecorded: true } ).observations
		).toMatchObject( { everyCheckRecorded: true } );
	} );

	it( 'records a run that threw as run-failed, not as a route without a model request', () => {
		const thrown = { success: false, error: leak } as EvalSummarySource;
		expect( evalCaseSummary( thrown, { ...forCase } ) ).toMatchObject( {
			code: 'no-model-request',
		} );
		const { record } = write( thrown, { threw: true } );
		expect( record ).toMatchObject( {
			scenario: 'eval-route-chatgpt-oauth',
			status: 'failed',
			code: 'run-failed',
		} );
		expect( everything() ).not.toMatch( /jordan|example/i );
	} );

	it( 'falls back, as the acceptance evidence does, when anything in it would be unsafe', () => {
		const { record } = write(
			seeded( { refusal: { code: 'sk-abcdefgh12345678', message: leak } } )
		);
		expect( record ).toEqual( {
			schemaVersion: 1,
			run: 1,
			scenario: 'eval-route-chatgpt-oauth',
			stage: 'parity-push-approved',
			status: 'failed',
			code: 'unsafe-evidence',
			durationS: 12.3,
			observations: {},
		} );
		expect( findUnsafeRecord( record ) ).toBeNull();
		expect( everything() ).not.toContain( 'sk-abcdefgh' );
	} );

	it( 'never names a case by an unsafe id, and counts each case’s runs apart on each provider', () => {
		const unnamed = write( seeded(), { caseId: `case-${ SITE_URL }` } );
		expect( unnamed.record.stage ).toBe( 'unnamed-case' );
		expect(
			write( seeded(), { caseId: 'jordan-example-org-0123456789abcdef0123' } ).record.stage
		).toBe( 'unnamed-case' );
		expect( write( seeded() ).record.run ).toBe( 1 );
		expect( write( seeded() ).record.run ).toBe( 2 );
		expect( write( seeded(), { provider: 'anthropic-api-key' } ).location.directory ).toBe(
			runDirectory( 'anthropic-api-key' )
		);
		const runsOf = ( provider: string, stage: string ) =>
			openAcceptanceEvidence( runDirectory( provider, stage ), provider )
				.readRecords()
				.map( ( record ) => [ record.scenario, record.stage, record.run ] );
		expect( runsOf( 'chatgpt-oauth', 'unnamed-case' ) ).toEqual( [
			[ 'eval-route-chatgpt-oauth', 'unnamed-case', 1 ],
			[ 'eval-route-chatgpt-oauth', 'unnamed-case', 2 ],
		] );
		expect( runsOf( 'chatgpt-oauth', 'parity-push-approved' ) ).toEqual( [
			[ 'eval-route-chatgpt-oauth', 'parity-push-approved', 1 ],
			[ 'eval-route-chatgpt-oauth', 'parity-push-approved', 2 ],
		] );
		expect( runsOf( 'anthropic-api-key', 'parity-push-approved' ) ).toEqual( [
			[ 'eval-route-anthropic-api-key', 'parity-push-approved', 1 ],
		] );
		expect( everything() ).not.toMatch( /jordan|example/i );
	} );

	it( 'is written where STUDIO_EVAL_SUMMARY_DIR says, else in the system temporary folder', () => {
		expect( evalSummaryDirectory( { STUDIO_EVAL_SUMMARY_DIR: dir } ) ).toBe( dir );
		expect( evalSummaryDirectory( {} ) ).toBe( path.join( os.tmpdir(), 'studio-eval-summary' ) );
	} );

	it( 'reads nothing of a legacy-provider route that has no bearer comparison', () => {
		const summary = evalCaseSummary(
			seeded( {
				providerRoute: {
					requested: {
						...requested,
						kind: 'wpcom',
						backend: 'wpcom-ai-proxy',
						subscription: false,
					},
					executed: executed( {
						kind: 'wpcom',
						backend: 'wpcom-ai-proxy',
						connectionRef: 'conn-0123456789ab',
						connectionMatchesBearer: null,
						replyKinds: [ 'wpcom' ],
					} ),
				},
			} ),
			{ caseId: 'parity-identity', provider: 'wpcom' }
		);
		expect( summary.status ).toBe( 'passed' );
		expect( summary.observations ).not.toHaveProperty( 'bearerMatches' );
	} );

	it( 'reads this run’s facts in a form the manifest accepts', () => {
		const facts = liveEvalRunFacts( dir );
		expect( facts.source.sha === null || /^[0-9a-f]{40}$/.test( facts.source.sha ) ).toBe( true );
		expect( facts.runtime.node ).toBe( process.versions.node );
		write( seeded(), { facts } );
		expect(
			openAcceptanceEvidence( runDirectory(), 'chatgpt-oauth' ).readManifest()?.runs
		).toHaveLength( 1 );
	} );
} );
