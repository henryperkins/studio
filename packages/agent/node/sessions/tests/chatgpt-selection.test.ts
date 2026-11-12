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
// Windows refuses to open a lockfile for a moment while another program
// deletes it; a test makes the selection's lock refused that many times.
const lockRace = vi.hoisted( () => ( { refusals: 0 } ) );
vi.mock( '@studio/common/lib/lockfile', async ( original ) => {
	const actual = await original< typeof import('@studio/common/lib/lockfile') >();
	return {
		...actual,
		lockFileAsync: async ( ...args: Parameters< typeof actual.lockFileAsync > ) => {
			if ( args[ 0 ].endsWith( '.settings.lock' ) && lockRace.refusals > 0 ) {
				lockRace.refusals--;
				throw Object.assign( new Error( 'EPERM: operation not permitted, open' ), {
					code: 'EPERM',
				} );
			}
			return actual.lockFileAsync( ...args );
		},
	};
} );
const A = 'f84d75a0-4e60-4168-a1ab-3134542c637a';
const B = '1c8e270b-9b5c-4687-b989-de052014b9e8';
const selection = { connectionId: A, revision: 1, model: 'gpt-6-luna', reasoningEffort: 'medium' };
let root: string;
beforeEach( async () => {
	lockRace.refusals = 0;
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
		await setSessionChatGptSelection( root, id, { ...selection, reasoningEffort: 'low' } );
		const { entries } = await loadAiSession( root, id );
		expect( readChatGptSessionSelection( entries ) ).toEqual( {
			...selection,
			reasoningEffort: 'low',
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
				model: { providerId: 'chatgpt-oauth', modelId: 'gpt-6-luna' },
			},
		} );
	} );

	it.each( [
		[ 'a model the route isn’t qualified for', { model: 'gpt-6-astra' }, /“gpt-6-astra” yet/ ],
		[ 'an effort the model isn’t qualified for', { reasoningEffort: 'high' }, /“High” reasoning/ ],
	] )(
		'refuses %s and keeps the saved choice, never a nearby one',
		async ( _name, change, why ) => {
			const { id } = await createAiSession( root );
			await setSessionChatGptSelection( root, id, selection );

			await expect(
				setSessionChatGptSelection( root, id, { ...selection, ...change } )
			).rejects.toThrow( why );

			const { entries } = await loadAiSession( root, id );
			expect( readChatGptSessionSelection( entries ) ).toEqual( selection );
		}
	);

	it( 'takes the selection’s lock that Windows refuses for a moment while another process lets it go', async () => {
		const { id } = await createAiSession( root );
		lockRace.refusals = 3;
		await setSessionChatGptSelection( root, id, selection );
		expect( lockRace.refusals ).toBe( 0 );

		const other = await createAiSession( root );
		lockRace.refusals = 3;
		await setSessionProvider( root, other.id, 'wpcom', 'balanced' );
		lockRace.refusals = 3;
		await setSessionModel( root, other.id, 'fast' );
		expect( lockRace.refusals ).toBe( 0 );
		expect( readChatGptSessionSelection( ( await loadAiSession( root, id ) ).entries ) ).toEqual(
			selection
		);
	} );

	it( 'records the model and effort only where the ChatGPT reader looks, and still reads a record written before', async () => {
		const { id } = await createAiSession( root );
		await setSessionChatGptSelection( root, id, selection );

		const records = ( await loadAiSession( root, id ) ).entries.flatMap( ( entry ) =>
			entry.type === 'custom' && entry.customType === 'studio.session_context'
				? [ entry.data as Record< string, unknown > ]
				: []
		);
		expect( records ).toEqual( [
			{
				provider: 'chatgpt-oauth',
				connectionId: A,
				revision: 1,
				chatGpt: { model: 'gpt-6-luna', reasoningEffort: 'medium' },
			},
		] );

		// As this branch wrote it before: the model and effort in the shared fields.
		const earlier = await createAiSession( root );
		await appendStudioEntry( root, earlier.id, 'studio.session_context', {
			provider: 'chatgpt-oauth',
			...selection,
			reasoningEffort: 'low',
		} );
		const { entries } = await loadAiSession( root, earlier.id );
		expect( readChatGptSessionSelection( entries ) ).toEqual( {
			...selection,
			reasoningEffort: 'low',
		} );
		expect(
			resolveConnectionSelection( entries, {
				connections: await listChatGptConnections(),
				settings: null,
			} )
		).toMatchObject( {
			ok: true,
			selection: { model: { providerId: 'chatgpt-oauth', modelId: 'gpt-6-luna' } },
		} );
		await setSessionChatGptSelection( root, earlier.id, selection );
		expect(
			readChatGptSessionSelection( ( await loadAiSession( root, earlier.id ) ).entries )
		).toEqual( selection );
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
