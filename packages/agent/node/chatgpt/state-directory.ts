import fs from 'node:fs';
import path from 'node:path';
import { getConfigDirectory } from '@studio/common/lib/well-known-paths';

/**
 * Where this process keeps its ChatGPT sign-ins: the account index, the sealed
 * credential records and their lockfiles. The Studio config directory, unless
 * set otherwise in this process.
 */

export type ChatGptStateDirectoryProblem = 'not-absolute' | 'not-a-directory' | 'in-use';

export class ChatGptStateDirectoryError extends Error {
	readonly code: ChatGptStateDirectoryProblem;

	constructor( code: ChatGptStateDirectoryProblem ) {
		super( `The ChatGPT state directory was refused (${ code }).` );
		this.name = 'ChatGptStateDirectoryError';
		this.code = code;
	}
}

let override: string | null = null;
let used = false;

export function getChatGptStateDirectory(): string {
	used = true;
	return override ?? getConfigDirectory();
}

// Development only: the eval runner points this process's ChatGPT state at a
// dedicated test profile while each case keeps a config directory of its own.
// No app, CLI command or server calls it.
export function setChatGptStateDirectory( directory: string | null ): void {
	if ( directory !== null ) {
		if ( ! path.isAbsolute( directory ) ) {
			throw new ChatGptStateDirectoryError( 'not-absolute' );
		}
		let isDirectory = false;
		try {
			isDirectory = fs.statSync( directory ).isDirectory();
		} catch {
			isDirectory = false;
		}
		if ( ! isDirectory ) {
			throw new ChatGptStateDirectoryError( 'not-a-directory' );
		}
	}
	const current = path.resolve( override ?? getConfigDirectory() );
	if ( used && path.resolve( directory ?? getConfigDirectory() ) !== current ) {
		throw new ChatGptStateDirectoryError( 'in-use' );
	}
	override = directory;
}
