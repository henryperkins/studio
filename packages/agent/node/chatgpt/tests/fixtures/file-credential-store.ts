import fs from 'node:fs';
import type { OsCredentialStore } from '@studio/common/lib/os-credential-store';

/**
 * A stand-in for the system keychain that several processes share through one
 * JSON file, so a test never reaches the real keychain.
 */
export function createFileCredentialStore( filePath: string ): OsCredentialStore {
	const read = (): Record< string, string > => {
		try {
			return JSON.parse( fs.readFileSync( filePath, 'utf8' ) );
		} catch {
			return {};
		}
	};
	const write = ( items: Record< string, string > ) => {
		const temp = `${ filePath }.${ process.pid }.tmp`;
		fs.writeFileSync( temp, JSON.stringify( items ) );
		fs.renameSync( temp, filePath );
	};
	return {
		check: async () => ( { available: true } ),
		get: async ( account ) => read()[ account ] ?? null,
		set: async ( account, secret ) => write( { ...read(), [ account ]: secret } ),
		delete: async ( account ) => {
			const items = read();
			delete items[ account ];
			write( items );
		},
	};
}
