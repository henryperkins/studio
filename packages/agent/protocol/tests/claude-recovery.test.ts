import { readFileSync } from 'fs';
import path from 'path';
import { resetLocaleData, setLocaleData } from '@wordpress/i18n';
import { afterEach, describe, expect, it } from 'vitest';
import {
	CLAUDE_RECOVERY_BLOCKED_REASONS,
	CLAUDE_RECOVERY_PROCEDURE_DOCUMENT,
	getClaudeRecoveryBlockedMessage,
	getClaudeUncertainOperationDescription,
	type ClaudeRecoveryBlockedReason,
} from '../claude-code';

afterEach( () => resetLocaleData() );

// Reasons with no automatic way forward, or none once waiting or retrying has
// not helped: their message names the manual procedure.
const BY_HAND: ClaudeRecoveryBlockedReason[] = [
	'deletion-pending',
	'legacy-lock',
	'lock-unreadable',
	'lock-not-a-run',
	'lock-other-conversation',
	'platform-mismatch',
	'owner-unverifiable',
	'native-unowned',
	'native-alive',
	'native-unverifiable',
	'guardian-alive',
	'guardian-unverifiable',
	'descendants-alive',
	'descendants-unverifiable',
	'binding-mismatch',
	'native-session-mismatch',
	'recovery-claim-unreadable',
	'recovery-failed',
	...( [
		'workspace-missing',
		'native-session-missing',
		'native-history-missing',
		'journal-unreadable',
	] as const ),
];

// Reasons that leave a chat that cannot be resumed with its lock, so that it
// cannot be deleted either until the lock is cleared by hand.
const NOT_RESUMABLE: ClaudeRecoveryBlockedReason[] = [
	'workspace-missing',
	'native-session-missing',
	'native-history-missing',
	'journal-unreadable',
];
const CLEARING_SECTION = '## Clearing the lock of a chat that cannot be resumed';

// Reasons that can resolve by waiting for, or closing, another Studio app or process.
const BY_WAITING: ClaudeRecoveryBlockedReason[] = [
	'deletion-pending',
	'lock-not-a-run',
	'owner-alive',
	'native-alive',
	'guardian-alive',
	'descendants-alive',
	'recovery-in-progress',
];

describe( 'why Studio did not recover a Claude chat, and what to do next', () => {
	it.each( CLAUDE_RECOVERY_BLOCKED_REASONS )( 'says what to do next for %s', ( reason ) => {
		expect( getClaudeRecoveryBlockedMessage( reason ) ).toMatch(
			/\b(wait|try again|quit|turn it on|send your next message|start a new|restore it|reload|follow the procedure)\b/i
		);
	} );

	it.each( BY_HAND )( 'names the manual procedure for %s', ( reason ) => {
		expect( getClaudeRecoveryBlockedMessage( reason ) ).toContain(
			CLAUDE_RECOVERY_PROCEDURE_DOCUMENT
		);
	} );

	it.each( BY_WAITING )( 'says to wait for or quit the other app for %s', ( reason ) => {
		expect( getClaudeRecoveryBlockedMessage( reason ) ).toMatch( /\b(wait|quit)\b/i );
	} );

	it( 'gives a deletion that holds the lock its own wording', () => {
		const message = getClaudeRecoveryBlockedMessage( 'lock-not-a-run' );
		expect( message ).toMatch( /delet/i );
		expect( message ).not.toBe( getClaudeRecoveryBlockedMessage( 'lock-unreadable' ) );
	} );

	it( 'keeps the manual procedure in the repository, with a section for every reason that names it', () => {
		const document = readFileSync( path.resolve( CLAUDE_RECOVERY_PROCEDURE_DOCUMENT ), 'utf8' );
		for ( const reason of BY_HAND ) expect( document, reason ).toContain( `\`${ reason }\`` );
		// It tells the reader how to find the chat's processes, never by name alone,
		// to keep the lock as evidence, and how to confirm afterwards.
		expect( document ).toContain( '--resume=' );
		expect( document ).toContain( '--session-id=' );
		expect( document ).toContain( 'CLAUDE_CONFIG_DIR' );
		expect( document ).toMatch( /never end a process by its name/i );
		expect( document ).toMatch( /\.claim-/ );
		expect( document ).toMatch( /\.manual-/ );
		expect( document ).toContain( 'studio code claude recover --session' );
	} );

	it.each( NOT_RESUMABLE )(
		'says for %s that the chat keeps its lock until it is cleared by hand, and has a section that clears it so the chat can be deleted',
		( reason ) => {
			expect( getClaudeRecoveryBlockedMessage( reason ) ).toMatch( /lock/i );
			expect( getClaudeRecoveryBlockedMessage( reason ) ).toMatch( /delete/i );
			const document = readFileSync( path.resolve( CLAUDE_RECOVERY_PROCEDURE_DOCUMENT ), 'utf8' );
			const start = document.indexOf( CLEARING_SECTION );
			expect( start ).toBeGreaterThan( -1 );
			const end = document.indexOf( '\n## ', start + CLEARING_SECTION.length );
			const section = document.slice( start, end === -1 ? undefined : end );
			expect( section ).toContain( `\`${ reason }\`` );
			// The same proof first, the lock kept as evidence, then a normal deletion.
			expect( section ).toMatch( /step 4/i );
			expect( section ).toMatch( /\.manual-|set .* aside/i );
			expect( section ).toContain( 'studio code sessions delete' );
		}
	);
} );

describe( 'what an app shows for an operation that may or may not have taken effect', () => {
	const target = { environment: 'local' as const, siteId: 'site' };

	it( 'words an operation Studio does not recognize in the current language, when it is shown', () => {
		const unknown = { toolCallId: 'call', tool: 'future_tool', evidence: 'started' as const };
		expect( getClaudeUncertainOperationDescription( unknown ) ).toBe(
			'Run an operation Studio does not recognize: future_tool'
		);
		setLocaleData( {
			'Run an operation Studio does not recognize: %s': [
				'Exécuter une opération que Studio ne reconnaît pas : %s',
			],
		} );
		expect( getClaudeUncertainOperationDescription( unknown ) ).toBe(
			'Exécuter une opération que Studio ne reconnaît pas : future_tool'
		);
	} );

	it( 'shows any other operation as its approval described it', () => {
		expect(
			getClaudeUncertainOperationDescription( {
				toolCallId: 'call',
				tool: 'sites.wpCli',
				operationClass: 'command',
				target,
				description: 'Create a draft post on the current local site',
				evidence: 'authorized',
			} )
		).toBe( 'Create a draft post on the current local site' );
	} );
} );
