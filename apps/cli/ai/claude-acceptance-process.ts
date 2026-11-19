import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isCompleteClaudeAnswer } from '@studio/agent/node/claude-code/questions';
import { isClaudeEffort, isClaudeModelId } from '@studio/agent/protocol/claude-code';
import { acceptanceRunPaths } from './acceptance-isolation';
import { endProcessTree, hasExited } from './acceptance-process-tree';
import type {
	BackendApprovalOperation,
	BackendTurnEvent,
} from '@studio/agent/protocol/backend-events';
import type { StudioAiSessionInputPayload } from '@studio/agent/protocol/chat-images';

type Question = Extract< BackendTurnEvent, { type: 'question.asked' } >;

export interface ClaudeAcceptanceApproval {
	toolName: string;
	operation: BackendApprovalOperation;
	decision: 'allow' | 'deny' | 'interrupt';
}

export interface ClaudeAcceptanceTurnOptions {
	cliPath: string;
	/** The isolated run directory where the Studio CLI owner starts. */
	cwd: string;
	env: NodeJS.ProcessEnv;
	sessionId: string;
	payload: Omit< StudioAiSessionInputPayload, 'runId' | 'turnId' > &
		Required< Pick< StudioAiSessionInputPayload, 'claudeSelection' | 'claudeContext' > >;
	/** Each occurrence admits one start with this name. */
	allowedTools: readonly string[];
	approvals?: readonly ClaudeAcceptanceApproval[];
	question?: {
		toolName: string;
		questions: Question[ 'questions' ];
		answers: Record< string, string >;
	};
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Transient observation only. Persist the workflow's derived checks, never the raw event. */
	onEvent?: ( event: BackendTurnEvent ) => void;
}

function initialObservations() {
	return {
		terminalSuccess: false,
		terminalInterrupted: false,
		exitMatched: false,
		approvalRequests: 0,
		approvalsResolved: 0,
		lateAnswerSent: false,
		questionAnswered: false,
		confirmedBlocks: 0,
		toolResults: 0,
	};
}

type Failure =
	| 'invalid-input'
	| 'launch-failed'
	| 'interrupted'
	| 'timeout'
	| 'ipc-failed'
	| 'wrong-turn'
	| 'unexpected-event'
	| 'unexpected-tool'
	| 'unexpected-approval'
	| 'unexpected-question'
	| 'unexpected-terminal'
	| 'missing-evidence'
	| 'exit-mismatch'
	| 'cleanup-unconfirmed'
	| 'observer-failed';

export interface ClaudeAcceptanceTurnResult {
	ok: boolean;
	failure?: Failure;
	/** In-memory correlation for the session store. Exclude these fields from the report. */
	runId: string;
	turnId: string;
	ownerPid?: number;
	observations: ReturnType< typeof initialObservations >;
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const isRecord = ( value: unknown ): value is Record< string, unknown > =>
	typeof value === 'object' && value !== null && ! Array.isArray( value );
const hasId = ( value: unknown ): value is string => typeof value === 'string' && value.length > 0;

function turnEnvironment( options: ClaudeAcceptanceTurnOptions, temporaryHome: string ) {
	const { wpCliDir } = acceptanceRunPaths( options.cwd );
	const fixturePaths = new Map( [
		[ 'WP_CLI_CONFIG_PATH', join( wpCliDir, 'config.yml' ) ],
		[ 'WP_CLI_CACHE_DIR', join( wpCliDir, 'cache' ) ],
		[ 'WP_CLI_PACKAGES_DIR', join( wpCliDir, 'packages' ) ],
	] );
	const env = { ...options.env };
	for ( const [ key, value ] of Object.entries( env ) ) {
		const name = process.platform === 'win32' ? key.toUpperCase() : key;
		// WP-CLI overrides are forbidden on a Claude turn. Only remove the runner's own.
		if ( value !== undefined && fixturePaths.get( name ) === value ) delete env[ key ];
		if ( process.platform === 'win32' && name === 'HOME' ) delete env[ key ];
	}
	// Native Claude keeps USERPROFILE and omits HOME on Windows. PHP uses HOME first.
	if ( process.platform === 'win32' ) env.HOME = temporaryHome;
	return env;
}

function matchesOperation( expected: BackendApprovalOperation, actual: BackendApprovalOperation ) {
	if ( ! isRecord( actual ) || typeof actual.args !== 'string' ) return false;
	const { args, ...scope } = actual;
	const { args: expectedArgs, ...expectedScope } = expected;
	try {
		return (
			isDeepStrictEqual( scope, expectedScope ) &&
			isDeepStrictEqual( JSON.parse( args ), JSON.parse( expectedArgs ) )
		);
	} catch {
		return false;
	}
}

function observeChild(
	child: ChildProcess,
	options: ClaudeAcceptanceTurnOptions,
	result: ClaudeAcceptanceTurnResult
): Promise< void > {
	const { observations } = result;
	const approvals = options.approvals ?? [];
	const expectedTools = [ ...options.allowedTools ];
	const calls = new Map<
		string,
		{ name: string; native: boolean; result: boolean; ended: boolean }
	>();
	const seenRequests = new Set< string >();
	const pendingApprovals = new Map<
		string,
		{ toolCallId: string; decision: ClaudeAcceptanceApproval[ 'decision' ] }
	>();
	let pendingQuestion: { requestId: string; toolCallId: string } | undefined;
	let promptSeen = false;
	let terminalSeen = false;
	let stopRequested = false;
	let grace: NodeJS.Timeout | undefined;

	const send = ( message: object, delivered?: () => void ) => {
		if ( ! child.connected ) return fail( 'ipc-failed' );
		try {
			child.send( message, ( error ) => {
				if ( error ) fail( 'ipc-failed' );
				else delivered?.();
			} );
		} catch {
			fail( 'ipc-failed' );
		}
	};
	function fail( failure: Failure ) {
		if ( result.failure ) return;
		result.failure = failure;
		grace = setTimeout( () => {
			endProcessTree( child, {
				onDescendantsMayRemain: () => {
					result.failure = 'cleanup-unconfirmed';
				},
			} );
			if ( ! hasExited( child ) ) child.kill( 'SIGKILL' );
		}, 15_000 );
		if ( child.connected ) send( { type: 'interrupt' } );
	}

	function start( toolCallId: string, name: string, native: boolean ) {
		const index = expectedTools.indexOf( name );
		if ( index < 0 || ! hasId( toolCallId ) || calls.has( toolCallId ) || stopRequested )
			return fail( 'unexpected-tool' );
		expectedTools.splice( index, 1 );
		calls.set( toolCallId, { name, native, result: false, ended: false } );
	}

	function check( event: BackendTurnEvent ) {
		if ( event.runId !== result.runId || event.turnId !== result.turnId )
			return fail( 'wrong-turn' );
		if (
			terminalSeen ||
			( ! promptSeen && event.type !== 'turn.prompt' && event.type !== 'turn.terminal' )
		)
			return fail( 'unexpected-event' );
		switch ( event.type ) {
			case 'turn.prompt':
				if (
					promptSeen ||
					event.text !== ( options.payload.displayMessage ?? options.payload.prompt )
				)
					return fail( 'unexpected-event' );
				promptSeen = true;
				break;
			case 'content.confirmed':
				if (
					! hasId( event.blockId ) ||
					! hasId( event.messageId ) ||
					typeof event.text !== 'string' ||
					( event.blockType !== 'text' && event.blockType !== 'reasoning' )
				)
					return fail( 'unexpected-event' );
				if ( event.blockType === 'text' && event.text.trim() ) observations.confirmedBlocks++;
				break;
			case 'tool.started':
				start( event.toolCallId, event.name, false );
				break;
			case 'native.call': {
				if ( event.state === 'started' ) {
					start( event.toolCallId, event.name, true );
					break;
				}
				const call = calls.get( event.toolCallId );
				if (
					! call?.native ||
					call.name !== event.name ||
					call.ended ||
					( event.state !== 'failed' && event.state !== 'succeeded' )
				)
					return fail( 'unexpected-tool' );
				call.ended = true;
				break;
			}
			case 'tool.progress':
			case 'tool.result': {
				const call = calls.get( event.toolCallId );
				if ( ! call || call.result ) return fail( 'unexpected-tool' );
				if ( event.type === 'tool.result' ) {
					if ( typeof event.isError !== 'boolean' || ( stopRequested && ! event.isError ) )
						return fail( 'unexpected-tool' );
					call.result = true;
					observations.toolResults++;
				}
				break;
			}
			case 'approval.requested': {
				const plan = approvals[ observations.approvalRequests ];
				const call = calls.get( event.toolCallId );
				if (
					! plan ||
					! call ||
					call.name !== plan.toolName ||
					call.result ||
					call.ended ||
					stopRequested ||
					! UUID.test( event.requestId ) ||
					seenRequests.has( event.requestId ) ||
					pendingApprovals.size ||
					! matchesOperation( plan.operation, event.operation )
				)
					return fail( 'unexpected-approval' );
				seenRequests.add( event.requestId );
				pendingApprovals.set( event.requestId, {
					toolCallId: event.toolCallId,
					decision: plan.decision,
				} );
				observations.approvalRequests++;
				if ( plan.decision === 'interrupt' ) {
					stopRequested = true;
					send( { type: 'interrupt' } );
				} else {
					send( { type: 'answer', answers: { [ event.requestId ]: plan.decision } } );
				}
				break;
			}
			case 'approval.resolved': {
				const pending = pendingApprovals.get( event.requestId );
				if ( ! pending || pending.toolCallId !== event.toolCallId )
					return fail( 'unexpected-approval' );
				pendingApprovals.delete( event.requestId );
				observations.approvalsResolved++;
				if ( pending.decision === 'interrupt' ) {
					// Seeing the closure first ensures this exercises an expired approval.
					send( { type: 'answer', answers: { [ event.requestId ]: 'allow' } }, () => {
						observations.lateAnswerSent = true;
					} );
				}
				break;
			}
			case 'question.asked': {
				const plan = options.question;
				const call = event.toolCallId && calls.get( event.toolCallId );
				if (
					! plan ||
					! call ||
					call.result ||
					call.ended ||
					call.name !== plan.toolName ||
					pendingQuestion ||
					stopRequested ||
					observations.questionAnswered ||
					! UUID.test( event.requestId ) ||
					seenRequests.has( event.requestId ) ||
					! isDeepStrictEqual( event.questions, plan.questions ) ||
					! isCompleteClaudeAnswer( event, plan.answers )
				)
					return fail( 'unexpected-question' );
				seenRequests.add( event.requestId );
				pendingQuestion = { requestId: event.requestId, toolCallId: event.toolCallId! };
				send( {
					type: 'question.answer',
					runId: result.runId,
					turnId: result.turnId,
					requestId: event.requestId,
					answers: plan.answers,
				} );
				break;
			}
			case 'question.resolved':
				if (
					! pendingQuestion ||
					pendingQuestion.requestId !== event.requestId ||
					pendingQuestion.toolCallId !== event.toolCallId ||
					! isDeepStrictEqual( event.answers, options.question?.answers )
				)
					return fail( 'unexpected-question' );
				pendingQuestion = undefined;
				observations.questionAnswered = true;
				break;
			case 'turn.terminal':
				terminalSeen = true;
				observations.terminalSuccess = event.outcome?.status === 'success';
				observations.terminalInterrupted = event.outcome?.status === 'interrupted';
				if (
					! ( stopRequested ? observations.terminalInterrupted : observations.terminalSuccess ) ||
					event.outcome.code
				)
					return fail( 'unexpected-terminal' );
				break;
			case 'content.provisional':
			case 'context.compacted':
				break;
			case 'preview.reload':
			case 'chat.artifact':
				if ( ! isDeepStrictEqual( event.target, options.payload.claudeContext.target ) )
					return fail( 'unexpected-event' );
				break;
			default:
				fail( 'unexpected-event' );
		}
	}

	const onMessage = ( message: unknown ) => {
		if ( result.failure ) return;
		// The CLI sends this after yargs returns. Only process exit completes the proof.
		if ( isDeepStrictEqual( message, { action: 'done' } ) ) return;
		// CLI logger progress is independent of the agent protocol.
		if (
			isRecord( message ) &&
			message.type === undefined &&
			typeof message.action === 'string' &&
			typeof message.status === 'string'
		)
			return;
		if ( ! isRecord( message ) || message.type !== 'backend.event' || ! isRecord( message.event ) )
			return fail( 'unexpected-event' );
		try {
			const event = message.event as unknown as BackendTurnEvent;
			check( event );
			if ( ! result.failure ) options.onEvent?.( event );
		} catch {
			fail( 'observer-failed' );
		}
	};
	return new Promise( ( resolve ) => {
		const abort = () => fail( 'interrupted' );
		const timer = setTimeout( () => fail( 'timeout' ), options.timeoutMs ?? 180_000 );
		options.signal?.addEventListener( 'abort', abort, { once: true } );
		child.on( 'message', onMessage );
		child.on( 'error', () => fail( 'ipc-failed' ) );
		child.once( 'close', ( code, signal ) => {
			clearTimeout( timer );
			clearTimeout( grace );
			options.signal?.removeEventListener( 'abort', abort );
			child.off( 'message', onMessage );
			observations.exitMatched = terminalSeen && ! signal && code === ( stopRequested ? 1 : 0 );
			if (
				! promptSeen ||
				! terminalSeen ||
				pendingApprovals.size ||
				pendingQuestion ||
				observations.approvalRequests !== approvals.length ||
				( stopRequested && ! observations.lateAnswerSent ) ||
				( options.question && ! observations.questionAnswered ) ||
				( ! stopRequested &&
					[ ...calls.values() ].some( ( call ) => ( call.native ? ! call.ended : ! call.result ) ) )
			) {
				result.failure ??= 'missing-evidence';
			}
			if ( ! observations.exitMatched ) result.failure ??= 'exit-mismatch';
			result.ok = ! result.failure;
			resolve();
		} );
		if ( options.signal?.aborted ) abort();
	} );
}

export async function runClaudeAcceptanceTurn(
	options: ClaudeAcceptanceTurnOptions
): Promise< ClaudeAcceptanceTurnResult > {
	const result: ClaudeAcceptanceTurnResult = {
		ok: false,
		runId: randomUUID(),
		turnId: randomUUID(),
		observations: initialObservations(),
	};
	const selection = options.payload.claudeSelection;
	const context = options.payload.claudeContext;
	if (
		! UUID.test( options.sessionId ) ||
		! options.payload.prompt?.trim() ||
		! isClaudeModelId( selection?.model ) ||
		! isClaudeEffort( selection?.effort ) ||
		! hasId( context?.connectionId ) ||
		! Number.isSafeInteger( context.revision ) ||
		! context.target ||
		( options.timeoutMs !== undefined &&
			( ! Number.isSafeInteger( options.timeoutMs ) ||
				options.timeoutMs < 1 ||
				options.timeoutMs > 2_147_483_647 ) )
	) {
		return { ...result, failure: 'invalid-input' };
	}
	if ( options.signal?.aborted ) return { ...result, failure: 'interrupted' };
	let directory: string | undefined;
	try {
		directory = await mkdtemp( join( tmpdir(), 'studio-claude-turn-' ) );
		const input = join( directory, 'input.json' );
		await writeFile(
			input,
			JSON.stringify( { ...options.payload, runId: result.runId, turnId: result.turnId } ),
			{ mode: 0o600, flag: 'wx' }
		);
		if ( options.signal?.aborted ) {
			result.failure = 'interrupted';
			return result;
		}
		const child = fork(
			options.cliPath,
			[
				'code',
				'sessions',
				'resume',
				options.sessionId,
				'--input-payload',
				input,
				'--json',
				'--avoid-telemetry',
			],
			{
				cwd: options.cwd,
				env: turnEnvironment( options, directory ),
				execArgv: [],
				detached: process.platform !== 'win32',
				stdio: [ 'ignore', 'ignore', 'ignore', 'ipc' ],
			}
		);
		result.ownerPid = child.pid;
		await observeChild( child, options, result );
	} catch {
		result.failure = 'launch-failed';
	} finally {
		if ( directory ) {
			await rm( directory, { recursive: true, force: true } ).catch( () => {
				result.ok = false;
				result.failure = 'cleanup-unconfirmed';
			} );
		}
	}
	return result;
}
