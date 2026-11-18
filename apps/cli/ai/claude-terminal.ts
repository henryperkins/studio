import { createInterface, type Interface } from 'node:readline/promises';

let previous = Promise.resolve();

// Approvals and questions share stdin. Only one readline interface can own it.
export function withClaudeTerminal< T >(
	signal: AbortSignal,
	prompt: ( terminal: Interface, signal: AbortSignal ) => Promise< T >
): Promise< T > {
	const result = previous.then( async () => {
		signal.throwIfAborted();
		const terminal = createInterface( { input: process.stdin, output: process.stderr } );
		const closed = new AbortController();
		terminal.once( 'close', () => closed.abort() );
		terminal.once( 'SIGINT', () => {
			closed.abort();
			process.emit( 'SIGINT', 'SIGINT' );
		} );
		try {
			return await prompt( terminal, AbortSignal.any( [ signal, closed.signal ] ) );
		} finally {
			terminal.close();
		}
	} );
	previous = result.then(
		() => {},
		() => {}
	);
	return result;
}
