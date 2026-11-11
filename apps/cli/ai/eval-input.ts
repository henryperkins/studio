/**
 * The vars an eval case passes the runner, parsed. Imports nothing that reads
 * the environment or the disk, so configs can be checked without running a case.
 */
import { snapshotSchema } from '@studio/common/types/snapshot';
import { syncSiteSchema } from '@studio/common/types/sync';
import { z } from 'zod';
import { stopRuleSchema, type StopRule } from './eval-stop';

// Optional fixtures a test can pre-seed before the agent turn, so flows that
// depend on connected remote sites and/or preview sites can be exercised
// deterministically and offline (no real WordPress.com connection/preview).
const evalSeedSchema = z.object( {
	localSite: z
		.object( {
			id: z.string(),
			name: z.string(),
			path: z.string(),
			port: z.number().default( 8881 ),
			url: z.string().optional(),
			phpVersion: z.string().default( '8.2' ),
		} )
		.optional(),
	connectedWpcomSites: z.array( syncSiteSchema ).optional(),
	snapshots: z.array( snapshotSchema ).optional(),
	globalInstructions: z.string().optional(),
	// A real (stopped) site under STUDIO_SITES_ROOT, active for the turn, with
	// `files` written relative to its root, then each `wpCli` argv run in order
	// (e.g. to activate a theme or seed database rows). Each `inspect` argv runs
	// after the turn and its output lands in the result's `inspections`, so
	// assertions can check site state before the site is deleted.
	activeSite: z
		.object( {
			name: z.string(),
			files: z.record( z.string(), z.string() ).optional(),
			wpCli: z.array( z.array( z.string() ) ).optional(),
			inspect: z.array( z.array( z.string() ) ).optional(),
			// WordPress.com sites connected to this site, whose id is only known
			// once it exists.
			connectedWpcomSites: z.array( syncSiteSchema.omit( { localSiteId: true } ) ).optional(),
		} )
		.optional(),
	// One of the user's WordPress.com sites, active for the turn as when it is
	// picked in the app or CLI. Nothing is created; the site must exist.
	remoteActiveSite: z
		.object( {
			name: z.string(),
			url: z.string(),
			wpcomSiteId: z.number(),
		} )
		.optional(),
} );
export type EvalSeed = z.infer< typeof evalSeedSchema >;

// Objects rather than strings: promptfoo expands an array of strings into one
// test case per element.
const followUpsSchema = z.array( z.object( { prompt: z.string() } ) );
const answersSchema = z.array( z.object( { label: z.string() } ) );

export interface EvalRunnerVars {
	ui: boolean;
	prompt?: string;
	// Sent in order, each as a new user message in the same session once the
	// previous one finishes, so a case can measure a multi-message conversation.
	followUps?: Array< { prompt: string } >;
	// Scripted replies for the questions the agent asks the user, in order:
	// each question takes the next label. With answers set, the turn runs with
	// Studio chat's ask-the-user handler, so AskUserQuestion and tools that
	// confirm with the user work; once they run out, the user cancels.
	answers?: Array< { label: string } >;
	timeoutMs?: number;
	seed?: EvalSeed;
	// Ends the run at the first tool call matching one of these rules, before
	// any follow-ups; the result's `stoppedAt` names it.
	stopAt?: StopRule[];
}

/** Parses the vars the runner reads; zod errors name a malformed one. */
export function parseEvalRunnerVars( vars: Record< string, unknown > ): EvalRunnerVars {
	return {
		ui: vars.ui === true,
		...( vars.prompt !== undefined ? { prompt: vars.prompt as string } : {} ),
		followUps: vars.followUps ? followUpsSchema.parse( vars.followUps ) : undefined,
		answers: vars.answers ? answersSchema.parse( vars.answers ) : undefined,
		timeoutMs: typeof vars.timeoutMs === 'number' ? vars.timeoutMs : undefined,
		stopAt: vars.stopAt ? z.array( stopRuleSchema ).parse( vars.stopAt ) : undefined,
		seed: vars.seed ? evalSeedSchema.parse( vars.seed ) : undefined,
	};
}
