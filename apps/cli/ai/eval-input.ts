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
	// Messages the conversation already holds before the first turn, the
	// assistant's recorded as a reply on the run's selected route (so only with
	// a provider selection). `contextTokens` is the context size that reply
	// reported: a fixture reaches a limit, such as the compaction threshold,
	// without sending a request that size.
	history: z
		.array(
			z.object( {
				role: z.enum( [ 'user', 'assistant' ] ),
				text: z.string(),
				contextTokens: z.number().int().nonnegative().optional(),
			} )
		)
		.optional(),
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
const followUpsSchema = z.array(
	z.object( { prompt: z.string(), reopen: z.boolean().optional() } )
);
const answersSchema = z.array( z.object( { label: z.string() } ) );
const attachmentsSchema = z.array( z.object( { fixture: z.string() } ) );

/** Every var the runner itself reads; the rest are the outcome checks' parameters. */
export const EVAL_RUNNER_VARS = [
	'caseId',
	'prompt',
	'ui',
	'followUps',
	'answers',
	'timeoutMs',
	'stopAt',
	'seed',
	'model',
	'provider',
	'effort',
	'requireProvider',
	'remote',
	'imageService',
	'attachments',
	'resumeAfterStop',
	'needsToolImages',
] as const;

export interface EvalRunnerVars {
	ui: boolean;
	// The case's id, which names it in a provider-qualified case's sanitized summary.
	caseId?: string;
	prompt?: string;
	// Sent in order, each as a new user message in the same session once the
	// previous one finishes, so a case can measure a multi-message conversation.
	// `reopen` first reopens the conversation from its file in a fresh agent,
	// as a resumed chat is.
	followUps?: Array< { prompt: string; reopen?: boolean } >;
	// Scripted replies for the questions the agent asks the user, in order:
	// each question takes the next label, and `@first` takes its first option.
	// With answers set, the turn runs with Studio chat's ask-the-user handler,
	// so AskUserQuestion and tools that confirm with the user work; once they
	// run out, the user cancels.
	answers?: Array< { label: string } >;
	timeoutMs?: number;
	seed?: EvalSeed;
	// Ends the run at the first tool call matching one of these rules, before
	// any follow-ups unless `resumeAfterStop`; the result's `stoppedAt` names it.
	stopAt?: StopRule[];
	// The follow-ups still run after a `stopAt` interrupt, as a user who
	// cancelled a turn and went on in the same chat.
	resumeAfterStop: boolean;
	// `mock`: every push, pull and preview change is recorded and answered with
	// a fixture, never run. `staging`: they run for real, only against the
	// disposable staging site the environment designates.
	remote?: 'mock' | 'staging';
	// `off`: the run has no image service (and no WordPress.com login).
	// `required`: it is refused unless Studio's separate WordPress.com image
	// service is configured. `unused`: the login is kept, and any image request
	// fails the case.
	imageService?: 'off' | 'required' | 'unused';
	// Files from scripts/eval/fixtures attached to the first message.
	attachments?: Array< { fixture: string } >;
	// The case is judged on images a tool returns to the model (screenshots),
	// so on a route whose capability table doesn't qualify the model for them
	// it is blocked before it runs.
	needsToolImages: boolean;
}

/** Parses the vars the runner reads; zod errors name a malformed one. */
export function parseEvalRunnerVars( vars: Record< string, unknown > ): EvalRunnerVars {
	return {
		ui: vars.ui === true,
		...( typeof vars.caseId === 'string' ? { caseId: vars.caseId } : {} ),
		...( vars.prompt !== undefined ? { prompt: vars.prompt as string } : {} ),
		followUps: vars.followUps ? followUpsSchema.parse( vars.followUps ) : undefined,
		answers: vars.answers ? answersSchema.parse( vars.answers ) : undefined,
		timeoutMs: typeof vars.timeoutMs === 'number' ? vars.timeoutMs : undefined,
		stopAt: vars.stopAt ? z.array( stopRuleSchema ).parse( vars.stopAt ) : undefined,
		seed: vars.seed ? evalSeedSchema.parse( vars.seed ) : undefined,
		resumeAfterStop: vars.resumeAfterStop === true,
		remote:
			vars.remote !== undefined ? z.enum( [ 'mock', 'staging' ] ).parse( vars.remote ) : undefined,
		imageService:
			vars.imageService !== undefined
				? z.enum( [ 'off', 'required', 'unused' ] ).parse( vars.imageService )
				: undefined,
		attachments: vars.attachments ? attachmentsSchema.parse( vars.attachments ) : undefined,
		needsToolImages: vars.needsToolImages === true,
	};
}
