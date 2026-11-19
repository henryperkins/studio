import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import {
	createNativeSessionStore,
	getClaudeSessionStoreRoot,
} from '@studio/agent/node/claude-code/sessions';
import { loadAiSession } from '@studio/agent/node/sessions/store';
import {
	getClaudeApprovalDisplayArgs,
	isSameClaudeTarget,
	resolveClaudeSession,
} from '@studio/agent/protocol/claude-code';
import { runClaudeAcceptanceTurn } from './claude-acceptance-process';
import type { Observations } from './acceptance-evidence';
import type {
	ClaudeAcceptanceApproval,
	ClaudeAcceptanceTurnOptions,
} from './claude-acceptance-process';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';
import type { ClaudeEffort, ClaudeSessionSelection } from '@studio/agent/protocol/claude-code';

export interface ClaudeAcceptanceWorkflowInput {
	cliPath: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	sessionsRoot: string;
	sessionId: string;
	site: { id: string; path: string; name: string };
	connectionId: string;
	revision: number;
	selection: ClaudeSessionSelection;
	nextEffort: ClaudeEffort;
	signal: AbortSignal;
	runCli: ( args: string[] ) => Promise< string >;
}

export interface ClaudeAcceptanceWorkflowStage {
	name: string;
	status: 'passed' | 'failed';
	code?: string;
	observations: Observations;
}

class WorkflowFailure extends Error {}

function check( condition: unknown, code: string ): asserts condition {
	if ( ! condition ) throw new WorkflowFailure( code );
}

interface Post {
	id: number;
	title: string;
	status: string;
	content: string;
}

async function readPosts( input: ClaudeAcceptanceWorkflowInput ): Promise< Post[] > {
	const stdout = await input.runCli( [
		'wp',
		'--path',
		input.site.path,
		'post',
		'list',
		'--post_type=post',
		'--post_status=publish,future,draft,pending,private,trash,auto-draft,inherit',
		'--posts_per_page=-1',
		'--fields=ID,post_title,post_status,post_content',
		'--format=json',
	] );
	const rows: unknown = JSON.parse( stdout );
	check( Array.isArray( rows ), 'invalid-post-list' );
	const ids = new Set< number >();
	return rows
		.map( ( row ) => {
			const id = Number( row?.ID );
			check(
				( typeof row?.ID === 'number' ||
					( typeof row?.ID === 'string' && /^\d+$/.test( row.ID ) ) ) &&
					Number.isSafeInteger( id ) &&
					id > 0 &&
					! ids.has( id ) &&
					typeof row.post_title === 'string' &&
					typeof row.post_status === 'string' &&
					typeof row.post_content === 'string',
				'invalid-post-list'
			);
			ids.add( id );
			return { id, title: row.post_title, status: row.post_status, content: row.post_content };
		} )
		.sort( ( a, b ) => a.id - b.id );
}

async function readSession( input: ClaudeAcceptanceWorkflowInput ) {
	const workspacePath = await realpath( input.site.path );
	const { entries, summary } = await loadAiSession( input.sessionsRoot, input.sessionId );
	const session = resolveClaudeSession( entries );
	const native = await createNativeSessionStore(
		getClaudeSessionStoreRoot( input.sessionsRoot )
	).load( input.sessionId );
	check(
		summary.id === input.sessionId &&
			summary.backend === 'claude-code' &&
			session &&
			session.binding.connectionId === input.connectionId &&
			session.binding.siteId === input.site.id &&
			session.binding.workingDirectory === workspacePath &&
			isSameClaudeTarget( session.target, { environment: 'local', siteId: input.site.id } ) &&
			native?.connectionId === input.connectionId &&
			native.siteId === input.site.id &&
			native.workingDirectory === session.binding.workingDirectory &&
			native.configDirectory === session.binding.configDirectory &&
			native.accountKey,
		'session-binding-mismatch'
	);
	return {
		workspacePath,
		selection: session.selection,
		nativeId: native.nativeSessionId,
		account: native.accountKey,
	};
}

function observeTurn() {
	const calls = new Set< string >();
	const results: Array< { isError: boolean; value?: string } > = [];
	let lastText = '';
	return {
		onEvent( event: BackendTurnEvent ) {
			if ( event.type === 'content.confirmed' && event.blockType === 'text' )
				lastText = event.text.trim();
			if ( event.type === 'tool.started' && event.name === 'wp_cli' ) calls.add( event.toolCallId );
			if ( event.type === 'tool.result' && calls.has( event.toolCallId ) ) {
				// The Studio bridge escapes CR in Windows WP-CLI output before display.
				results.push( {
					isError: event.isError,
					value: event.message?.trim().replace( /\\u000d$/, '' ),
				} );
			}
		},
		textMatches: ( expected: string ) => lastText === expected,
		result: () => ( calls.size === 1 && results.length === 1 ? results[ 0 ] : undefined ),
	};
}

const OPTION = 'studio_acceptance_read';
const META_KEY = 'studio_acceptance';

function fixtureValue() {
	return randomBytes( 12 ).toString( 'hex' );
}

type Turn = Awaited< ReturnType< typeof runClaudeAcceptanceTurn > >;

function verifyTurn( result: Turn, observations: Observations, interrupted = false ) {
	Object.assign( observations, result.observations );
	check( result.ok, result.failure ?? 'turn-failed' );
	check(
		result.observations.exitMatched &&
			( interrupted
				? result.observations.terminalInterrupted
				: result.observations.terminalSuccess ),
		'terminal-mismatch'
	);
}

export async function runClaudeAcceptanceWorkflows(
	input: ClaudeAcceptanceWorkflowInput,
	report: ( stage: ClaudeAcceptanceWorkflowStage ) => void | Promise< void >
): Promise< boolean > {
	let stageName = 'site-read';
	let observations: Observations = {};
	async function stage( name: string, run: () => Promise< void > ) {
		stageName = name;
		observations = {};
		check( ! input.signal.aborted, 'cancelled' );
		await run();
		await report( { name, status: 'passed', observations } );
	}

	let selection = input.selection;
	const target = { environment: 'local' as const, siteId: input.site.id };
	const marker = fixtureValue();
	let firstSession: Awaited< ReturnType< typeof readSession > >;
	let previousTurn: Turn;
	async function turn(
		prompt: string,
		allowedTools: string[],
		approvals?: ClaudeAcceptanceApproval[]
	) {
		const evidence = observeTurn();
		const options: ClaudeAcceptanceTurnOptions = {
			cliPath: input.cliPath,
			cwd: input.cwd,
			env: input.env,
			sessionId: input.sessionId,
			payload: {
				prompt,
				claudeSelection: selection,
				claudeContext: { connectionId: input.connectionId, revision: input.revision, target },
			},
			allowedTools,
			approvals,
			signal: input.signal,
			onEvent: evidence.onEvent,
		};
		const result = await runClaudeAcceptanceTurn( options );
		return { result, evidence };
	}

	async function draft( decision: ClaudeAcceptanceApproval[ 'decision' ] ) {
		const title = 'StudioDraft' + fixtureValue();
		const body = 'StudioBody' + fixtureValue();
		const metadata = fixtureValue();
		// The standard local post create is allowed directly. Adding genuine post metadata
		// exercises the generic WP-CLI approval and gives the readback another independent check.
		const metaArg = `--meta_input=${ JSON.stringify( { [ META_KEY ]: metadata } ) }`;
		const argv = [
			'post',
			'create',
			'--post_status=draft',
			`--post_title=${ title }`,
			'--porcelain',
			metaArg,
			`--post_content=${ body }`,
		];
		const command = argv.map( ( arg ) => ( arg === metaArg ? `'${ arg }'` : arg ) ).join( ' ' );
		const before = await readPosts( input );
		const { evidence, result } = await turn(
			`On the current local site, call Studio wp_cli exactly once. Set nameOrPath to ${ JSON.stringify(
				input.site.name
			) }. Use this literal command:\n${ command }\nKeep every argument as written. After it returns, report the outcome briefly. A denial is final; do not retry or use other tools.`,
			[ 'wp_cli' ],
			[
				{
					toolName: 'wp_cli',
					decision,
					operation: {
						tool: 'sites.wpCli',
						operationClass: 'command',
						target,
						args: JSON.stringify( getClaudeApprovalDisplayArgs( 'sites.wpCli', argv ) ),
						localPaths: [ firstSession.workspacePath ],
					},
				},
			]
		);
		// Observe WordPress after the owner has exited, including when the protocol check failed.
		const after = await readPosts( input );
		const previousIds = new Set( before.map( ( post ) => post.id ) );
		const added = after.filter( ( post ) => ! previousIds.has( post.id ) );
		observations.previousPostsUnchanged = isDeepStrictEqual(
			before,
			after.filter( ( post ) => previousIds.has( post.id ) )
		);
		observations.newPosts = added.length;
		verifyTurn( result, observations, decision === 'interrupt' );
		check( result.observations.approvalRequests === 1, 'missing-approval' );
		check( observations.previousPostsUnchanged, 'prior-post-changed' );
		if ( decision === 'interrupt' ) {
			check( result.observations.lateAnswerSent, 'missing-late-answer' );
			check( added.length === 0, 'stopped-draft-written' );
			return;
		}
		check( result.observations.approvalsResolved === 1, 'unresolved-approval' );
		const wp = evidence.result();
		check( wp && wp.isError === ( decision === 'deny' ), 'wrong-tool-result' );
		if ( decision === 'deny' ) {
			check( added.length === 0, 'denied-draft-written' );
			return;
		}
		check( added.length === 1, 'draft-count' );
		const [ post ] = added;
		observations.draftMatches =
			post.title === title && post.status === 'draft' && post.content === body;
		observations.returnedIdMatches = wp.value === String( post.id );
		check( observations.draftMatches && observations.returnedIdMatches, 'draft-mismatch' );
		const meta = await input.runCli( [
			'wp',
			'--path',
			input.site.path,
			'post',
			'meta',
			'get',
			String( post.id ),
			META_KEY,
		] );
		observations.metadataMatches = meta.trim() === metadata;
		check( observations.metadataMatches, 'meta-mismatch' );
		previousTurn = result;
	}

	try {
		await stage( 'site-read', async () => {
			await input.runCli( [ 'wp', '--path', input.site.path, 'option', 'add', OPTION, marker ] );
			const { evidence, result } = await turn(
				`Use Studio wp_cli exactly once to run "option get ${ OPTION }" on the selected local site. Set nameOrPath to its Studio ID ${ JSON.stringify(
					input.site.id
				) }. Reply with only the value returned. Use no other tools.`,
				[ 'wp_cli' ]
			);
			verifyTurn( result, observations );
			const read = evidence.result();
			observations.toolReadMatches = read?.isError === false && read.value === marker;
			observations.answerMatches = evidence.textMatches( marker );
			check( observations.toolReadMatches && observations.answerMatches, 'site-read-mismatch' );
			firstSession = await readSession( input );
			check( isDeepStrictEqual( firstSession.selection, selection ), 'selection-mismatch' );
		} );
		await stage( 'denied-draft', () => draft( 'deny' ) );
		await stage( 'allowed-draft', () => draft( 'allow' ) );
		await stage( 'change-effort', async () => {
			check( input.nextEffort !== selection.effort, 'effort-unchanged' );
			selection = { model: selection.model, effort: input.nextEffort };
			await input.runCli( [
				'code',
				'claude',
				'select',
				'--session',
				input.sessionId,
				'--model',
				selection.model,
				'--effort',
				selection.effort,
			] );
			const saved = await readSession( input );
			observations.selectionPersisted = isDeepStrictEqual( saved.selection, selection );
			check( observations.selectionPersisted, 'selection-mismatch' );
		} );
		await stage( 'fresh-owner-resume', async () => {
			const { evidence, result } = await turn(
				'Reply only with the exact WordPress option value you read at the start of this conversation. Use the conversation history without calling tools.',
				[]
			);
			verifyTurn( result, observations );
			const saved = await readSession( input );
			observations.freshOwner =
				!! result.ownerPid &&
				!! previousTurn.ownerPid &&
				previousTurn.ownerPid !== result.ownerPid &&
				previousTurn.runId !== result.runId &&
				previousTurn.turnId !== result.turnId;
			observations.sameNativeSession =
				saved.nativeId === firstSession.nativeId && saved.account === firstSession.account;
			observations.selectionPersisted = isDeepStrictEqual( saved.selection, selection );
			observations.historyRecalled = evidence.textMatches( marker );
			check(
				observations.freshOwner &&
					observations.sameNativeSession &&
					observations.selectionPersisted &&
					observations.historyRecalled,
				'resume-mismatch'
			);
		} );
		await stage( 'stop-pending-approval', () => draft( 'interrupt' ) );
		return true;
	} catch ( error ) {
		await report( {
			name: stageName,
			status: 'failed',
			code: error instanceof WorkflowFailure ? error.message : 'workflow-error',
			observations,
		} );
		return false;
	}
}
