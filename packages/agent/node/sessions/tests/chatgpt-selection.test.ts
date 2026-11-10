// @vitest-environment node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listChatGptConnections } from '@studio/agent/node/chatgpt/credential-broker';
import { setSessionChatGptSelection } from '@studio/agent/node/sessions/chatgpt-selection';
import { setSessionOpenAiSelection } from '@studio/agent/node/sessions/openai-selection';
import { setSessionModel, setSessionProvider } from '@studio/agent/node/sessions/selection';
import {
	appendStudioEntry,
	createAiSession,
	loadAiSession,
} from '@studio/agent/node/sessions/store';
import { readChatGptSessionSelection } from '@studio/agent/protocol/chatgpt';
import { resolveConnectionSelection } from '@studio/agent/protocol/connections';

vi.mock( '@studio/agent/node/chatgpt/credential-broker', async ( original ) => ( {
	...( await original< object >() ),
	listChatGptConnections: vi.fn(),
} ) );
vi.mock( '@studio/common/lib/shared-config', async ( original ) => ( {
	...( await original< object >() ),
	readSharedSession: async () => undefined,
} ) );
const A = 'f84d75a0-4e60-4168-a1ab-3134542c637a';
const B = '1c8e270b-9b5c-4687-b989-de052014b9e8';
const selection = { connectionId: A, revision: 1, model: 'gpt-6-luna', reasoningEffort: 'medium' };
let root: string;
beforeEach( async () => {
	root = await fs.mkdtemp( path.join( os.tmpdir(), 'studio-chatgpt-selection-' ) );
	vi.stubEnv( 'STUDIO_EXPERIMENTAL_CHATGPT', '1' );
	vi.mocked( listChatGptConnections ).mockResolvedValue(
		[ A, B ].map( ( connectionId ) => ( {
			connectionId,
			providerId: 'chatgpt-oauth',
			backend: 'pi',
			revision: 1,
			authStatus: 'connected',
			identity: { subject: connectionId, email: 'same@example.test' },
		} ) )
	);
} );
afterEach( async () => {
	vi.unstubAllEnvs();
	await fs.rm( root, { recursive: true, force: true } );
} );

describe( 'ChatGPT session selection', () => {
	it( 'persists one provider-qualified model and effort, surviving a reload', async () => {
		const { id } = await createAiSession( root );
		await setSessionChatGptSelection( root, id, selection );
		await setSessionChatGptSelection( root, id, {
			...selection,
			model: 'gpt-6-astra',
			reasoningEffort: 'high',
		} );
		const { entries } = await loadAiSession( root, id );
		expect( readChatGptSessionSelection( entries ) ).toEqual( {
			...selection,
			model: 'gpt-6-astra',
			reasoningEffort: 'high',
		} );
		expect(
			resolveConnectionSelection( entries, {
				connections: await listChatGptConnections(),
				settings: null,
			} )
		).toMatchObject( {
			ok: true,
			selection: {
				connectionId: A,
				revision: 1,
				model: { providerId: 'chatgpt-oauth', modelId: 'gpt-6-astra' },
			},
		} );
	} );

	it( 'does not repin API history to ChatGPT, even for the same model slug', async () => {
		const { id } = await createAiSession( root );
		await setSessionProvider( root, id, 'openai-api-key', 'gpt-6-luna' );
		await expect( setSessionChatGptSelection( root, id, selection ) ).rejects.toThrow( /new chat/ );
		expect(
			readChatGptSessionSelection( ( await loadAiSession( root, id ) ).entries )
		).toBeUndefined();
	} );

	it( 'does not adopt an unpinned conversation’s messages', async () => {
		const session = await createAiSession( root );
		await fs.appendFile(
			session.filePath,
			JSON.stringify( {
				type: 'message',
				id: 'old',
				message: { role: 'user', content: 'Old private context' },
			} ) + '\n'
		);
		await expect( setSessionChatGptSelection( root, session.id, selection ) ).rejects.toThrow(
			/new chat/
		);
	} );

	it( 'does not adopt an unpinned Studio prompt before the runtime has recorded its message', async () => {
		const { id } = await createAiSession( root );
		await appendStudioEntry( root, id, 'studio.user_prompt', {
			text: 'Previous private prompt',
			source: 'prompt',
		} );
		await expect( setSessionChatGptSelection( root, id, selection ) ).rejects.toThrow( /new chat/ );
	} );

	it( 'refuses another account and every generic provider/model write on an existing ChatGPT chat', async () => {
		const { id } = await createAiSession( root );
		await setSessionChatGptSelection( root, id, selection );
		await expect(
			setSessionChatGptSelection( root, id, { ...selection, connectionId: B } )
		).rejects.toThrow( /new chat/ );
		await expect( setSessionProvider( root, id, 'openai-api-key', 'gpt-6-luna' ) ).rejects.toThrow(
			/new chat/
		);
		await expect(
			setSessionOpenAiSelection( root, id, {
				model: 'gpt-6-luna',
				reasoningEffort: 'medium',
				reasoningMode: 'standard',
			} )
		).rejects.toThrow( /new chat/ );
		await expect( setSessionModel( root, id, 'gpt-6-astra' ) ).rejects.toThrow( /together/ );
		expect( readChatGptSessionSelection( ( await loadAiSession( root, id ) ).entries ) ).toEqual(
			selection
		);
	} );

	it( 'serializes two accounts claiming a fresh session so only one can win', async () => {
		const { id } = await createAiSession( root );
		const results = await Promise.allSettled( [
			setSessionChatGptSelection( root, id, selection ),
			setSessionChatGptSelection( root, id, { ...selection, connectionId: B } ),
		] );
		expect( results.filter( ( result ) => result.status === 'fulfilled' ) ).toHaveLength( 1 );
		expect(
			( await loadAiSession( root, id ) ).entries.filter(
				( entry ) => entry.type === 'custom' && entry.customType === 'studio.session_context'
			)
		).toHaveLength( 1 );
	} );

	it( 'rejects a concurrent API write rather than creating mixed connection history', async () => {
		const { id } = await createAiSession( root );
		const results = await Promise.allSettled( [
			setSessionChatGptSelection( root, id, selection ),
			setSessionProvider( root, id, 'openai-api-key', 'gpt-6-luna' ),
		] );
		expect( results.filter( ( result ) => result.status === 'fulfilled' ) ).toHaveLength( 1 );
	} );

	it( 'releases the session lock after an invalid selection and preserves site placement', async () => {
		const { id } = await createAiSession( root );
		await appendStudioEntry( root, id, 'studio.site_selected', {
			siteName: 'Example',
			sitePath: root,
		} );
		await expect(
			setSessionChatGptSelection( root, id, { ...selection, reasoningMode: 'pro' } )
		).rejects.toThrow();
		await setSessionChatGptSelection( root, id, selection );
		expect(
			( await loadAiSession( root, id ) ).entries.some(
				( entry ) => entry.type === 'custom' && entry.customType === 'studio.site_selected'
			)
		).toBe( true );
	} );
} );
