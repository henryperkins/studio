import { __ } from '@wordpress/i18n';
import { useState, useRef } from 'react';
import { useConnector } from '@/data/core';
import { claudeMediaPath } from './claude-media-path';
import { AgentQuestionBatch } from './conversation/agent-question';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';

export function ClaudeQuestionBatch( {
	request,
	active,
	resolution,
	cancelled,
	sessionId,
	sessionFile,
}: {
	request: Extract< BackendTurnEvent, { type: 'question.asked' } >;
	active: boolean;
	resolution?: Extract< BackendTurnEvent, { type: 'question.resolved' } >;
	cancelled: boolean;
	sessionId: string;
	sessionFile: string;
} ) {
	const connector = useConnector();
	const [ drafts, setDrafts ] = useState< Record< string, string > >( {} );
	const [ sent, setSent ] = useState< Record< string, string > >();
	const [ busy, setBusy ] = useState( false );
	const [ error, setError ] = useState( '' );
	const inFlight = useRef( false );
	const open = active && ! resolution && ! sent && ! cancelled;
	const answers = resolution ? resolution.answers : sent;
	const questions = request.questions.map( ( item, index ) => ( {
		...item,
		key: String( index ),
		options: item.options.map( ( option ) => ( {
			...option,
			image: claudeMediaPath( sessionFile, option.image ),
		} ) ),
		pickedLabel:
			answers && Object.prototype.hasOwnProperty.call( answers, item.question )
				? answers[ item.question ]
				: undefined,
	} ) );
	const answer = async ( question: string, value: string ) => {
		if ( ! open || inFlight.current ) return;
		const next = { ...drafts, [ question ]: value };
		if (
			! questions.every( ( item ) => Object.prototype.hasOwnProperty.call( next, item.question ) )
		) {
			setDrafts( next );
			return;
		}
		inFlight.current = true;
		setBusy( true );
		setError( '' );
		try {
			await connector.answerAgentQuestion( request.runId, next, request.requestId );
			setSent( next );
		} catch ( failure ) {
			setError(
				failure instanceof Error
					? failure.message
					: __( 'Could not send your answer. Please try again.' )
			);
		} finally {
			inFlight.current = false;
			setBusy( false );
		}
	};
	return (
		<div aria-busy={ busy }>
			<div inert={ busy }>
				<AgentQuestionBatch
					questions={ questions }
					claudeSessionId={ sessionId }
					pendingQuestions={ new Set( open ? questions.map( ( item ) => item.question ) : [] ) }
					pendingAnswers={ open ? drafts : {} }
					onAnswer={ answer }
				/>
			</div>
			{ ! answers && ( cancelled || resolution?.answers === null ) && (
				<p>{ __( 'Question cancelled' ) }</p>
			) }
			{ error && open && <p role="alert">{ error }</p> }
		</div>
	);
}
