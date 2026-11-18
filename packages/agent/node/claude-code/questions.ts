import { randomUUID } from 'node:crypto';
import type { AskUserQuestion } from '@studio/agent/node/types';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';

type QuestionRequest = Extract< BackendTurnEvent, { type: 'question.asked' } >;
type Answers = Record< string, string >;

export class ClaudeQuestionInputError extends Error {}

export type ClaudeQuestionAsker = (
	request: QuestionRequest,
	signal: AbortSignal
) => Promise< Answers >;

export function isCompleteClaudeAnswer(
	request: QuestionRequest,
	answers: unknown
): answers is Answers {
	if ( ! answers || typeof answers !== 'object' || Array.isArray( answers ) ) return false;
	const fields = Object.entries( answers );
	const names = new Set( request.questions.map( ( q ) => q.question ) );
	return (
		names.size === request.questions.length &&
		fields.length === names.size &&
		fields.every(
			( [ key, value ] ) => names.has( key ) && typeof value === 'string' && value.trim()
		)
	);
}

export async function askClaudeQuestions(
	{
		runId,
		turnId,
		toolCallId,
	}: Pick< QuestionRequest, 'runId' | 'turnId' > & { toolCallId: string },
	questions: AskUserQuestion[],
	signal: AbortSignal,
	askUser: ClaudeQuestionAsker,
	emit: ( event: BackendTurnEvent ) => void | Promise< void >,
	onPresented?: () => void
): Promise< Answers > {
	signal.throwIfAborted();
	if (
		questions.length < 1 ||
		questions.length > 4 ||
		new Set( questions.map( ( q ) => q.question.trim() ) ).size !== questions.length
	)
		throw new ClaudeQuestionInputError( 'Ask between one and four distinct questions.' );
	for ( const q of questions ) {
		const labels = q.options.map( ( option ) => option.label.trim() );
		// The visual picker adds “Show other options” after up to four previews.
		const maximum = q.options.some( ( option ) => option.image ) ? 5 : 4;
		if (
			! q.question.trim() ||
			labels.length < 2 ||
			labels.length > maximum ||
			labels.includes( '' ) ||
			new Set( labels ).size !== labels.length
		)
			throw new ClaudeQuestionInputError(
				'Each question needs text and distinct, nonempty options.'
			);
	}

	const requestId = randomUUID();
	const request: QuestionRequest = {
		type: 'question.asked',
		runId,
		turnId,
		toolCallId,
		requestId,
		questions,
	};
	const lifetime = new AbortController();
	const waiting = AbortSignal.any( [ signal, lifetime.signal ] );
	let answers: Answers | null = null;
	try {
		// Register the receiver first: a local transport can reply during publication.
		const response = new Promise< Answers >( ( resolve, reject ) => {
			waiting.addEventListener( 'abort', () => reject( waiting.reason ), { once: true } );
			askUser( request, waiting ).then( resolve, reject );
		} );
		// Observe a Stop during the journal write, then finish publication in order.
		void response.catch( () => {} );
		await emit( request );
		onPresented?.();
		const reply = await response;
		waiting.throwIfAborted();
		if ( ! isCompleteClaudeAnswer( request, reply ) )
			throw new Error( 'The reply did not answer this batch of questions.' );
		answers = reply;
		return reply;
	} finally {
		lifetime.abort();
		await emit( { type: 'question.resolved', runId, turnId, toolCallId, requestId, answers } );
	}
}
