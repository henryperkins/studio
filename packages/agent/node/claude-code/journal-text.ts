/** The journal's original encoding. Apply current display escaping when showing its text. */
export function escapeClaudeJournalText( value: string ): string {
	return value.replace(
		/(?![\n\t])[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
		( character ) => '\\u' + character.charCodeAt( 0 ).toString( 16 ).padStart( 4, '0' )
	);
}
