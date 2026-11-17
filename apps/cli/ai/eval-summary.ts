import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
	findUnsafeRecord,
	findUnsafeText,
	type Observations,
	type StageRecord,
} from './acceptance-evidence';
import type { ExecutedRoute, RequestedRoute } from './eval-provider';

/**
 * The one output of a provider-qualified eval case that may leave the machine:
 * a record in the acceptance runners' stage-record shape, checked with their
 * record guard before it is written. It holds the case id, whether the case
 * ran on its selected route with nothing refused, typed codes, and counts and
 * booleans read from the run, never a transcript, a tool's output, an address,
 * an account, an identifier or a path. Development only, for the eval runner.
 */

const SUMMARY_FILE = 'eval-summary.ndjson';
const UNNAMED_CASE = 'unnamed-case';
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The parts of a runner result the summary reads. */
export interface EvalSummarySource {
	success?: unknown;
	timedOut?: unknown;
	refusal?: { code?: unknown } | null;
	blocked?: { code?: unknown } | null;
	providerRoute?: {
		requested: RequestedRoute | null;
		executed?: ExecutedRoute;
		failure?: { code?: unknown };
	} | null;
	remoteGuard?: { code?: unknown; blocked?: unknown[]; allowed?: unknown[] } | null;
	remoteCalls?: Array< { designated?: unknown } > | null;
	turns?: unknown[] | null;
	toolCalls?: unknown[] | null;
	compactions?: unknown;
	phaseTimingsMs?: { total_eval_ms?: unknown } | null;
}

const kebab = ( value: unknown ): string | undefined =>
	typeof value === 'string' && KEBAB.test( value ) ? value : undefined;

// A name the summary may carry: kebab-case, at most 64 characters, and nothing
// the evidence check would refuse.
const safeName = ( value: unknown ): string | undefined => {
	const name = kebab( value );
	return name && name.length <= 64 && ! findUnsafeText( name ) ? name : undefined;
};

const count = ( value: unknown ): number =>
	typeof value === 'number' && Number.isFinite( value ) ? value : 0;

/** Why the route the run took is not the one it selected, as a typed code, or null. */
function evalRouteProblem(
	requested: RequestedRoute | null | undefined,
	executed: ExecutedRoute | undefined
): string | null {
	if ( ! requested || ! executed || executed.modelRequests === 0 ) {
		return 'no-model-request';
	}
	if (
		executed.kind !== requested.kind ||
		executed.backend !== requested.backend ||
		executed.connectionRef !== requested.connectionRef
	) {
		return 'route-mismatch';
	}
	if ( requested.subscription && executed.apiKeyBearers > 0 ) {
		return 'api-key-bearer';
	}
	if ( requested.subscription && executed.connectionMatchesBearer === false ) {
		return 'connection-mismatch';
	}
	if ( requested.subscription && executed.connectionMatchesBearer !== true ) {
		return 'connection-unverified';
	}
	if ( requested.wireModel && executed.models.some( ( model ) => model !== requested.wireModel ) ) {
		return 'model-mismatch';
	}
	if ( requested.effort && executed.efforts.some( ( effort ) => effort !== requested.effort ) ) {
		return 'effort-mismatch';
	}
	if ( executed.replyKinds.some( ( kind ) => kind !== requested.kind ) ) {
		return 'reply-provider-mismatch';
	}
	return null;
}

function routeObservations(
	requested: RequestedRoute | null | undefined,
	executed: ExecutedRoute | undefined
): Observations {
	if ( ! requested || ! executed ) {
		return {};
	}
	return {
		modelRequests: executed.modelRequests,
		apiKeyBearers: executed.apiKeyBearers,
		imageServiceRequests: executed.imageServiceRequests,
		kindMatches: executed.kind === requested.kind,
		backendMatches: executed.backend === requested.backend,
		connectionMatches: executed.connectionRef === requested.connectionRef,
		...( executed.connectionMatchesBearer === null
			? {}
			: {
					bearerMatches: executed.connectionMatchesBearer === true,
					bearerUnverified: executed.connectionMatchesBearer === 'unverified',
			  } ),
		otherModels: requested.wireModel
			? executed.models.filter( ( model ) => model !== requested.wireModel ).length
			: 0,
		otherEfforts: requested.effort
			? executed.efforts.filter( ( effort ) => effort !== requested.effort ).length
			: 0,
		otherReplyProviders: executed.replyKinds.filter( ( kind ) => kind !== requested.kind ).length,
		replyModelsMatchRequests:
			executed.replyModels.length > 0 &&
			executed.replyModels.every( ( model ) => executed.models.includes( model ) ),
	};
}

/**
 * A provider-qualified case's result as a stage record without its run
 * number: `blocked` when it was refused or blocked before it ran (with that
 * code), `failed` when the guard refused a write, it timed out, its route was
 * not the one selected or the run failed (each with a typed code), `passed`
 * otherwise. The case's own outcome checks are judged in promptfoo; this says
 * whether it ran on its selected route with nothing refused.
 */
export function evalCaseSummary(
	result: EvalSummarySource,
	{ caseId, provider }: { caseId: unknown; provider: unknown }
): Omit< StageRecord, 'run' > {
	const route = result.providerRoute ?? undefined;
	const blockedCode =
		kebab( result.refusal?.code ) ?? kebab( route?.failure?.code ) ?? kebab( result.blocked?.code );
	const guardCode = kebab( result.remoteGuard?.code );
	const routeProblem = evalRouteProblem( route?.requested, route?.executed );
	let status: StageRecord[ 'status' ] = 'passed';
	let code: string | undefined;
	if ( result.refusal || route?.failure || result.blocked ) {
		status = 'blocked';
		code = blockedCode ?? 'refused';
	} else if ( guardCode ) {
		status = 'failed';
		code = guardCode;
	} else if ( result.timedOut === true ) {
		status = 'failed';
		code = 'timed-out';
	} else if ( routeProblem ) {
		status = 'failed';
		code = routeProblem;
	} else if ( result.success !== true ) {
		status = 'failed';
		code = 'run-failed';
	}
	const calls = result.remoteCalls ?? [];
	const totalMs = count( result.phaseTimingsMs?.total_eval_ms );
	return {
		schemaVersion: ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
		scenario: safeName( `eval-${ kebab( provider ) ?? 'unselected' }` ) ?? 'eval-unselected',
		stage: safeName( caseId ) ?? UNNAMED_CASE,
		status,
		...( code ? { code } : {} ),
		durationS: Math.round( totalMs / 100 ) / 10,
		observations: {
			success: result.success === true,
			timedOut: result.timedOut === true,
			...routeObservations( route?.requested, route?.executed ),
			...( result.remoteGuard
				? {
						guardRefused: ( result.remoteGuard.blocked ?? [] ).length,
						...( result.remoteGuard.allowed
							? { stagingWritesAllowed: result.remoteGuard.allowed.length }
							: {} ),
				  }
				: {} ),
			...( result.remoteCalls
				? {
						remoteCalls: calls.length,
						designatedRemoteCalls: calls.filter( ( call ) => call.designated === true ).length,
				  }
				: {} ),
			turns: ( result.turns ?? [] ).length,
			toolCalls: ( result.toolCalls ?? [] ).length,
			compactions: count( result.compactions ),
		},
	};
}

/** Where the summary goes: `STUDIO_EVAL_SUMMARY_DIR`, or a folder in the system temporary folder. */
export function evalSummaryDirectory( env: NodeJS.ProcessEnv = process.env ): string {
	return env.STUDIO_EVAL_SUMMARY_DIR?.trim() || path.join( os.tmpdir(), 'studio-eval-summary' );
}

function earlierRuns( file: string, stage: string ): number {
	let text: string;
	try {
		text = fs.readFileSync( file, 'utf8' );
	} catch {
		return 0;
	}
	return text
		.split( /\r?\n/ )
		.filter( Boolean )
		.filter( ( line ) => {
			try {
				return ( JSON.parse( line ) as { stage?: unknown } ).stage === stage;
			} catch {
				return false;
			}
		} ).length;
}

/**
 * Appends the case's summary to `eval-summary.ndjson` in `directory`, its run
 * number counting that case's earlier records there. A record the guard
 * refuses is written instead as the acceptance runners write one: `failed`,
 * `unsafe-evidence`, no observations.
 */
export function writeEvalCaseSummary(
	result: EvalSummarySource,
	options: { caseId: unknown; provider: unknown; directory: string }
): StageRecord {
	fs.mkdirSync( options.directory, { recursive: true } );
	const file = path.join( options.directory, SUMMARY_FILE );
	const summary = evalCaseSummary( result, options );
	const run = earlierRuns( file, summary.stage ) + 1;
	let record: StageRecord = { ...summary, run };
	if ( findUnsafeRecord( record ) ) {
		record = {
			schemaVersion: ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
			run,
			scenario: summary.scenario,
			stage: summary.stage,
			status: 'failed',
			code: 'unsafe-evidence',
			durationS: summary.durationS,
			observations: {},
		};
		if ( findUnsafeRecord( record ) ) {
			record = {
				...record,
				scenario: 'eval-unselected',
				stage: UNNAMED_CASE,
				durationS: 0,
			};
		}
	}
	fs.appendFileSync( file, JSON.stringify( record ) + '\n', { encoding: 'utf8', mode: 0o600 } );
	return record;
}
