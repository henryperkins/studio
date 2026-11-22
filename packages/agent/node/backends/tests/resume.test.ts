import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveClaudeResume } from '../resume';
import type { ClaudeBackendSessionRef } from '@studio/agent/protocol/backend-sessions';

describe( 'Claude transcript provenance', () => {
	let root: string;
	let session: ClaudeBackendSessionRef;

	beforeEach( async () => {
		root = await fs.realpath(
			await fs.mkdtemp( path.join( os.tmpdir(), 'studio-claude-resume-' ) )
		);
		const workingDirectory = path.join( root, 'Site' );
		const configDirectory = path.join( root, 'Config' );
		const transcriptPath = path.join( configDirectory, 'Projects', 'native-session.jsonl' );
		await fs.mkdir( workingDirectory );
		await fs.mkdir( path.dirname( transcriptPath ), { recursive: true } );
		await fs.writeFile( transcriptPath, '' );
		session = {
			backend: 'claude-code',
			nativeSessionId: 'native-session',
			connectionId: 'connection',
			conversationId: 'chat',
			siteId: 'site',
			workingDirectory,
			configDirectory,
			transcriptPath,
		};
	} );

	afterEach( async () => {
		await fs.rm( root, { recursive: true, force: true } );
	} );

	it( 'requires explicit transcript evidence', async () => {
		await expect( resolveClaudeResume( session, session, undefined ) ).resolves.toEqual( {
			status: 'rebind-required',
		} );
		await expect( resolveClaudeResume( session, session, [] ) ).resolves.toEqual( {
			status: 'missing',
		} );
	} );

	it( 'rejects a matching native ID in another project', async () => {
		const other = path.join( root, 'Other' );
		await fs.mkdir( other );
		await expect(
			resolveClaudeResume( session, session, [ { ...session, workingDirectory: other } ] )
		).resolves.toEqual( { status: 'rebind-required' } );
	} );

	it( 'rejects multiple transcript copies for one native ID', async () => {
		const duplicatePath = path.join( session.configDirectory, 'native-session.jsonl' );
		await fs.copyFile( session.transcriptPath!, duplicatePath );
		await expect(
			resolveClaudeResume( session, session, [
				session,
				{ ...session, transcriptPath: duplicatePath },
			] )
		).resolves.toEqual( { status: 'ambiguous' } );
	} );

	it( 'rejects changes in configuration, workspace, site, conversation or connection', async () => {
		const other = path.join( root, 'Other' );
		await fs.mkdir( other );
		for ( const changed of [
			{ configDirectory: other },
			{ workingDirectory: other },
			{ siteId: 'different' },
			{ conversationId: 'different' },
			{ connectionId: 'different' },
		] ) {
			await expect(
				resolveClaudeResume( session, { ...session, ...changed }, [ session ] )
			).resolves.toEqual( { status: 'rebind-required' } );
		}
	} );

	it( 'binds transcript provenance under the verified configuration directory', async () => {
		const outside = path.join( root, 'outside.jsonl' );
		await fs.copyFile( session.transcriptPath!, outside );
		await expect(
			resolveClaudeResume( { ...session, transcriptPath: undefined }, session, [
				{ ...session, transcriptPath: outside },
			] )
		).resolves.toEqual( { status: 'rebind-required' } );
	} );

	it( 'rejects a replacement transcript path after the original was bound', async () => {
		const changed = path.join( session.configDirectory, 'another.jsonl' );
		await fs.rename( session.transcriptPath!, changed );
		await expect(
			resolveClaudeResume( session, session, [ { ...session, transcriptPath: changed } ] )
		).resolves.toEqual( { status: 'rebind-required' } );
	} );

	it( 'rejects a moved workspace even if the old path now links to it', async () => {
		const moved = path.join( root, 'Moved' );
		await fs.rename( session.workingDirectory, moved );
		await fs.symlink( moved, session.workingDirectory, 'junction' );
		await expect(
			resolveClaudeResume( session, session, [ { ...session, workingDirectory: moved } ] )
		).resolves.toEqual( { status: 'rebind-required' } );
	} );

	it( 'accepts equivalent canonical workspace and config aliases without counting the same transcript twice', async () => {
		const workspaceAlias = path.join( root, 'LinkedSite' );
		const configAlias = path.join( root, 'LinkedConfig' );
		await fs.symlink( session.workingDirectory, workspaceAlias, 'junction' );
		await fs.symlink( session.configDirectory, configAlias, 'junction' );
		const alias = { workingDirectory: workspaceAlias, configDirectory: configAlias };
		const aliasPath = path.join( configAlias, 'Projects', 'native-session.jsonl' );
		await expect(
			resolveClaudeResume( session, { ...session, ...alias }, [
				session,
				{ ...session, ...alias, transcriptPath: aliasPath },
			] )
		).resolves.toEqual( { status: 'ready', session } );
	} );

	it.skipIf( process.platform !== 'win32' )(
		'resolves Windows case aliases through the filesystem',
		async () => {
			await expect(
				resolveClaudeResume(
					session,
					{
						...session,
						workingDirectory: session.workingDirectory.toLowerCase(),
						configDirectory: session.configDirectory.toLowerCase(),
					},
					[ session ]
				)
			).resolves.toEqual( { status: 'ready', session } );
		}
	);
} );
