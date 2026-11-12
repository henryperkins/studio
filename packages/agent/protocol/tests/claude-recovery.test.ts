import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
	CLAUDE_RECOVERY_BLOCKED_REASONS,
	CLAUDE_RECOVERY_PROCEDURE_DOCUMENT,
	getClaudeRecoveryBlockedMessage,
	type ClaudeRecoveryBlockedReason,
} from '../claude-code';

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
];

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
} );
