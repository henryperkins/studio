// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findUnsafeRecord } from 'cli/ai/acceptance-evidence';
import {
	evalCaseSummary,
	evalSummaryDirectory,
	writeEvalCaseSummary,
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

	beforeEach( () => {
		dir = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-eval-summary-test-' ) );
	} );

	afterEach( () => {
		fs.rmSync( dir, { recursive: true, force: true, maxRetries: 5 } );
	} );

	it( 'holds the case id, its verdict, the route’s counts and booleans and the guard’s counts, nothing the run wrote', () => {
		const record = writeEvalCaseSummary( seeded(), { ...forCase, directory: dir } );
		expect( record ).toEqual( {
			schemaVersion: 1,
			run: 1,
			scenario: 'eval-chatgpt-oauth',
			stage: 'parity-push-approved',
			status: 'passed',
			durationS: 12.3,
			observations: {
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
		expect( findUnsafeRecord( record ) ).toBeNull();
		const written = fs.readFileSync( path.join( dir, 'eval-summary.ndjson' ), 'utf8' );
		expect( JSON.parse( written ) ).toEqual( record );
		for ( const value of [ NAME, EMAIL, 'jordans-site', SITE_ID, 'jordan', 'Users', 'example' ] ) {
			expect( written.toLowerCase() ).not.toContain( value.toLowerCase() );
		}
	} );

	it.each( [
		[
			'refused before it ran',
			{ success: false, refusal: { code: 'connection-signed-out', message: leak } },
			'blocked',
			'connection-signed-out',
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
		const record = writeEvalCaseSummary( seeded( overrides ), { ...forCase, directory: dir } );
		expect( record ).toMatchObject( { status, code } );
		expect( findUnsafeRecord( record ) ).toBeNull();
		expect( JSON.stringify( record ) ).not.toMatch( /jordan|example/i );
	} );

	it( 'falls back, as the acceptance evidence does, when anything in it would be unsafe', () => {
		const record = writeEvalCaseSummary(
			seeded( { refusal: { code: 'sk-abcdefgh12345678', message: leak } } ),
			{ ...forCase, directory: dir }
		);
		expect( record ).toEqual( {
			schemaVersion: 1,
			run: 1,
			scenario: 'eval-chatgpt-oauth',
			stage: 'parity-push-approved',
			status: 'failed',
			code: 'unsafe-evidence',
			durationS: 12.3,
			observations: {},
		} );
		expect( findUnsafeRecord( record ) ).toBeNull();
	} );

	it( 'never names a case by an unsafe id, and counts each case’s runs apart', () => {
		const unnamed = writeEvalCaseSummary( seeded(), {
			caseId: `case-${ SITE_URL }`,
			provider: 'chatgpt-oauth',
			directory: dir,
		} );
		expect( unnamed.stage ).toBe( 'unnamed-case' );
		expect(
			writeEvalCaseSummary( seeded(), {
				caseId: 'jordan-example-org-0123456789abcdef0123',
				provider: 'chatgpt-oauth',
				directory: dir,
			} ).stage
		).toBe( 'unnamed-case' );
		expect( writeEvalCaseSummary( seeded(), { ...forCase, directory: dir } ).run ).toBe( 1 );
		expect( writeEvalCaseSummary( seeded(), { ...forCase, directory: dir } ).run ).toBe( 2 );
		const lines = fs
			.readFileSync( path.join( dir, 'eval-summary.ndjson' ), 'utf8' )
			.trim()
			.split( '\n' )
			.map( ( line ) => JSON.parse( line ) );
		expect( lines.map( ( line ) => [ line.stage, line.run ] ) ).toEqual( [
			[ 'unnamed-case', 1 ],
			[ 'unnamed-case', 2 ],
			[ 'parity-push-approved', 1 ],
			[ 'parity-push-approved', 2 ],
		] );
		for ( const line of lines ) {
			expect( findUnsafeRecord( line ) ).toBeNull();
		}
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
} );
