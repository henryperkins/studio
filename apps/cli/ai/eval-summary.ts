import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
	findUnsafeText,
	openAcceptanceEvidence,
	UnsafeEvidenceError,
	type ManifestRun,
	type Observations,
	type StageRecord,
} from './acceptance-evidence';
import type { ExecutedRoute, RequestedRoute } from './eval-provider';

/**
 * The one output of a provider-qualified eval case that may leave the machine:
 * a run directory in the acceptance runners' evidence format for each provider
 * and case, `<summary folder>/<provider>/<case id>/`, written through their
 * evidence writer and its guards. Its `manifest.json` has one entry per run of
 * the case on that provider: the model, the reasoning effort, the source
 * revision and the platform it ran with. Its `evidence.ndjson` has, for each
 * run, the route record the runner writes (whether the case ran on its
 * selected route with nothing refused, which judges none of the case's own
 * checks) and one record per outcome check, which the checks append. Never a
 * transcript, a tool's output, an address, an account, an identifier or a
 * path. Development only, for the eval runner.
 */

const UNNAMED_CASE = 'unnamed-case';
const UNSELECTED = 'unselected';
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// As the manifest takes a model or an effort.
const SLUG = /^[a-z0-9][a-z0-9.+-]{0,63}$/;

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

const slug = ( value: unknown ): string | undefined =>
	typeof value === 'string' && SLUG.test( value ) && ! findUnsafeText( value ) ? value : undefined;

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

/** The provider and case a summary is filed under, as the names it may carry. */
function summaryNames( caseId: unknown, provider: unknown ) {
	return {
		provider: safeName( provider ) ?? UNSELECTED,
		stage: safeName( caseId ) ?? UNNAMED_CASE,
	};
}

/**
 * A provider-qualified case's route record without its run number, named
 * `eval-route-<provider>` for what it judges: `blocked` when the case was
 * refused or blocked before it ran (with that code), `failed` when the run
 * threw (`run-failed`), the guard refused a write, it timed out, its route
 * was not the one selected or the run failed otherwise (each with a typed
 * code), `passed` otherwise. Its `judgesCaseChecks: false` observation says
 * that none of the case's own checks is judged by it: each check appends a
 * record of its own. Its `everyCheckRecorded` observation says whether every
 * check of the case does so, as the case's configuration declares it: false
 * when it doesn't (a check that writes no record can't be seen here).
 */
export function evalCaseSummary(
	result: EvalSummarySource,
	{
		caseId,
		provider,
		threw = false,
		everyCheckRecorded = false,
	}: { caseId: unknown; provider: unknown; threw?: boolean; everyCheckRecorded?: boolean }
): Omit< StageRecord, 'run' > {
	const names = summaryNames( caseId, provider );
	const route = result.providerRoute ?? undefined;
	const blockedCode =
		kebab( result.refusal?.code ) ?? kebab( route?.failure?.code ) ?? kebab( result.blocked?.code );
	const guardCode = kebab( result.remoteGuard?.code );
	let status: StageRecord[ 'status' ] = 'passed';
	let code: string | undefined;
	if ( threw ) {
		status = 'failed';
		code = 'run-failed';
	} else if ( result.refusal || route?.failure || result.blocked ) {
		status = 'blocked';
		code = blockedCode ?? 'refused';
	} else if ( guardCode ) {
		status = 'failed';
		code = guardCode;
	} else if ( result.timedOut === true ) {
		status = 'failed';
		code = 'timed-out';
	} else {
		const routeProblem = evalRouteProblem( route?.requested, route?.executed );
		if ( routeProblem ) {
			status = 'failed';
			code = routeProblem;
		} else if ( result.success !== true ) {
			status = 'failed';
			code = 'run-failed';
		}
	}
	const calls = result.remoteCalls ?? [];
	const totalMs = count( result.phaseTimingsMs?.total_eval_ms );
	return {
		schemaVersion: ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
		scenario: safeName( `eval-route-${ names.provider }` ) ?? `eval-route-${ UNSELECTED }`,
		stage: names.stage,
		status,
		...( code ? { code } : {} ),
		durationS: Math.round( totalMs / 100 ) / 10,
		observations: {
			judgesCaseChecks: false,
			everyCheckRecorded: everyCheckRecorded === true,
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

/** What a run's manifest entry says about the source, the platform, the runtime and the build. */
export type EvalRunFacts = Pick< ManifestRun, 'source' | 'platform' | 'runtime' | 'build' >;

export interface EvalSummaryOptions {
	caseId: unknown;
	provider: unknown;
	/** The summary folder: `evalSummaryDirectory()`. */
	directory: string;
	/** The run threw instead of returning a result. */
	threw?: boolean;
	/** The case's configuration declares that every check of the case writes a record. */
	everyCheckRecorded?: boolean;
	/** What the case selected, for a run refused before its route was resolved. */
	selection?: { model?: unknown; effort?: unknown };
	facts: EvalRunFacts;
	/** The day the run started, `YYYY-MM-DD`. */
	createdOn?: string;
}

/** Where a case's summary is, so its checks can append their records to the same run. */
export interface EvalSummaryLocation {
	/** The case's run directory in the summary folder. */
	directory: string;
	run: number;
	stage: string;
}

/**
 * Starts a run in the case's run directory (`<directory>/<provider>/<case id>/`),
 * its manifest entry naming the model, the effort, the source revision and
 * the platform, numbered after that case's earlier runs on that provider, and
 * appends its route record. A record the guard refuses is written instead as
 * the acceptance runners write one: `failed`, `unsafe-evidence`, no
 * observations.
 */
export function writeEvalCaseSummary(
	result: EvalSummarySource,
	options: EvalSummaryOptions
): { location: EvalSummaryLocation; record: StageRecord } {
	const names = summaryNames( options.caseId, options.provider );
	const summary = evalCaseSummary( result, options );
	const requested = result.providerRoute?.requested ?? null;
	const directory = path.join( options.directory, names.provider, names.stage );
	fs.mkdirSync( directory, { recursive: true } );
	const evidence = openAcceptanceEvidence( directory, names.provider );
	const run = evidence.startRun( {
		scenario: `eval-${ names.provider }`,
		createdOn: options.createdOn ?? new Date().toISOString().slice( 0, 10 ),
		...options.facts,
		model: slug( requested?.model ) ?? slug( options.selection?.model ) ?? 'unresolved',
		effort:
			slug( requested?.effort ) ??
			slug( options.selection?.effort ) ??
			( requested ? 'none' : 'unresolved' ),
		gates: [],
	} );
	const { schemaVersion: _version, ...fields } = summary;
	let record: StageRecord;
	try {
		record = evidence.record( { ...fields, run } );
	} catch ( error ) {
		if ( ! ( error instanceof UnsafeEvidenceError ) ) {
			throw error;
		}
		const fallback = {
			run,
			scenario: summary.scenario,
			stage: summary.stage,
			status: 'failed' as const,
			code: 'unsafe-evidence',
			observations: {},
		};
		try {
			record = evidence.record( { ...fallback, durationS: summary.durationS } );
		} catch {
			record = evidence.record( { ...fallback, durationS: 0 } );
		}
	}
	return { location: { directory, run, stage: names.stage }, record };
}
