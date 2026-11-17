// @vitest-environment node
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { listChatGptConnections } from '@studio/agent/node/chatgpt/credential-broker';
import { setSessionChatGptSelection } from '@studio/agent/node/sessions/chatgpt-selection';
import { setSessionOpenAiSelection } from '@studio/agent/node/sessions/openai-selection';
import { setSessionModel, setSessionProvider } from '@studio/agent/node/sessions/selection';
import {
	appendStudioEntry,
	createAiSession,
	loadAiSession,
} from '@studio/agent/node/sessions/store';
import { canPinChatGptInPlace, readChatGptSessionSelection } from '@studio/agent/protocol/chatgpt';
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
const lockRace = vi.hoisted( () => ( { refusals: 0, held: false, failRelease: false } ) );
// A file operation the system refused, as Node raises it: with its errno and system call.
const systemError = vi.hoisted(
	() => ( message: string, code: string, errno: number, syscall: string, file: string ) =>
		Object.assign( new Error( message ), { code, errno, syscall, path: file } )
);
vi.mock( '@studio/common/lib/lockfile', async ( original ) => {
	const actual = await original< typeof import('@studio/common/lib/lockfile') >();
	return {
		...actual,
		lockFileAsync: async ( ...args: Parameters< typeof actual.lockFileAsync > ) => {
			if ( args[ 0 ].endsWith( '.settings.lock' ) && lockRace.refusals > 0 ) {
				lockRace.refusals--;
				throw systemError(
					`EPERM: operation not permitted, open '${ args[ 0 ] }'`,
					'EPERM',
					-4048,
					'open',
					args[ 0 ]
				);
			}
			// As the lockfile package gives up once another process held the lock past the wait.
			if ( args[ 0 ].endsWith( '.settings.lock' ) && lockRace.held ) {
				throw systemError(
					`EEXIST: file already exists, open '${ args[ 0 ] }'`,
					'EEXIST',
					-4075,
					'open',
					args[ 0 ]
				);
			}
			return actual.lockFileAsync( ...args );
		},
		unlockFileAsync: async ( lockPath: string ) => {
			await actual.unlockFileAsync( lockPath );
			if ( lockPath.endsWith( '.settings.lock' ) && lockRace.failRelease ) {
				throw systemError(
					`EPERM: operation not permitted, unlink '${ lockPath }'`,
					'EPERM',
					-4048,
					'unlink',
					lockPath
				);
			}
		},
	};
} );
// A defect inside the selection, as a bug in the session writer would raise it.
const writerFault = vi.hoisted( () => ( { next: undefined as Error | undefined } ) );
vi.mock( '@studio/agent/node/sessions/store', async ( original ) => {
	const actual = await original< typeof import('@studio/agent/node/sessions/store') >();
	return {
		...actual,
		appendStudioEntry: async ( ...args: Parameters< typeof actual.appendStudioEntry > ) => {
			const fault = writerFault.next;
			if ( fault ) {
				writerFault.next = undefined;
				throw fault;
			}
			return actual.appendStudioEntry( ...args );
		},
	};
} );
const A = 'f84d75a0-4e60-4168-a1ab-3134542c637a';
const B = '1c8e270b-9b5c-4687-b989-de052014b9e8';
const selection = { connectionId: A, revision: 1, model: 'gpt-6-luna', reasoningEffort: 'medium' };
let root: string;
let logged: {
	error: MockInstance< typeof console.error >;
	warn: MockInstance< typeof console.warn >;
};
beforeEach( async () => {
	lockRace.refusals = 0;
	lockRace.held = false;
	lockRace.failRelease = false;
	writerFault.next = undefined;
	logged = {
		error: vi.spyOn( console, 'error' ).mockImplementation( () => undefined ),
		warn: vi.spyOn( console, 'warn' ).mockImplementation( () => undefined ),
	};
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
	logged.error.mockRestore();
	logged.warn.mockRestore();
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

	it( 'says only that the choice wasn’t saved when the session’s lock stays held, naming no path', async () => {
		const { id } = await createAiSession( root );
		lockRace.held = true;
		const failures = await Promise.allSettled( [
			setSessionProvider( root, id, 'wpcom', 'balanced' ),
			setSessionModel( root, id, 'fast' ),
			setSessionChatGptSelection( root, id, selection ),
			setSessionOpenAiSelection( root, id, {
				model: 'gpt-6-luna',
				reasoningEffort: 'medium',
				reasoningMode: 'standard',
			} ),
		] );

		for ( const failure of failures ) {
			expect( failure ).toEqual( {
				status: 'rejected',
				reason: expect.objectContaining( {
					name: 'ChatGptSettingsError',
					message: 'Studio couldn’t save the model for this chat. Try again.',
					cause: expect.objectContaining( { code: 'EEXIST' } ),
				} ),
			} );
		}
		// A held lock is expected: never recorded as an unexpected failure.
		expect( logged.error ).not.toHaveBeenCalled();
		lockRace.held = false;
		await setSessionProvider( root, id, 'wpcom', 'balanced' );
	} );

	it( 'says only that the choice wasn’t saved for a session that can’t be read', async () => {
		const failures = await Promise.allSettled( [
			setSessionProvider( root, 'missing-session', 'wpcom', 'balanced' ),
			setSessionModel( root, 'missing-session', 'fast' ),
		] );

		for ( const failure of failures ) {
			expect( failure ).toMatchObject( {
				status: 'rejected',
				reason: { message: 'Studio couldn’t save the model for this chat. Try again.' },
			} );
		}
		expect( logged.error ).not.toHaveBeenCalled();
	} );

	it.each( [
		[ 'a provider switch', ( id: string ) => setSessionProvider( root, id, 'wpcom', 'balanced' ) ],
		[ 'a ChatGPT selection', ( id: string ) => setSessionChatGptSelection( root, id, selection ) ],
		[
			'an OpenAI-key selection',
			( id: string ) =>
				setSessionOpenAiSelection( root, id, {
					model: 'gpt-6-luna',
					reasoningEffort: 'medium',
					reasoningMode: 'standard',
				} ),
		],
	] )(
		'keeps a defect inside %s as the cause of the fixed message and records it once, with its stack',
		async ( _name, select ) => {
			const { id } = await createAiSession( root );
			const defect = new TypeError( 'Cannot read properties of undefined (reading ‘provider’)' );
			writerFault.next = defect;

			const failure = await select( id ).then(
				() => undefined,
				( error: unknown ) => error
			);

			expect( failure ).toMatchObject( {
				name: 'ChatGptSettingsError',
				message: 'Studio couldn’t save the model for this chat. Try again.',
			} );
			expect( ( failure as { cause?: unknown } ).cause ).toBe( defect );
			expect( logged.error ).toHaveBeenCalledTimes( 1 );
			expect( logged.error.mock.calls[ 0 ] ).toContain( defect );
			expect( logged.warn ).not.toHaveBeenCalled();
			// Nothing was written; the lock was let go.
			await setSessionProvider( root, id, 'wpcom', 'balanced' );
		}
	);

	// Node's own errors for a bad argument or a failed assertion carry a string code
	// too, but they are defects, not a refusal by the system.
	const raised = ( raise: () => unknown ): Error => {
		try {
			raise();
		} catch ( error ) {
			return error as Error;
		}
		throw new Error( 'Expected the call to throw.' );
	};
	it.each( [
		[
			'an argument of the wrong type',
			() => raised( () => path.join( undefined as unknown as string ) ),
			TypeError,
			'ERR_INVALID_ARG_TYPE',
		],
		[
			'a value out of range',
			() => raised( () => Buffer.alloc( -1 ) ),
			RangeError,
			'ERR_OUT_OF_RANGE',
		],
		[ 'a failed assertion', () => raised( () => assert.ok( false ) ), Error, 'ERR_ASSERTION' ],
	] )(
		'records Node’s error for %s inside a selection as a defect, with its stack, once',
		async ( _name, make, type, code ) => {
			const { id } = await createAiSession( root );
			const defect = make();
			expect( defect ).toBeInstanceOf( type );
			expect( defect ).toMatchObject( { code } );
			writerFault.next = defect;

			const failure = await setSessionProvider( root, id, 'wpcom', 'balanced' ).then(
				() => undefined,
				( error: unknown ) => error
			);

			expect( failure ).toMatchObject( {
				name: 'ChatGptSettingsError',
				message: 'Studio couldn’t save the model for this chat. Try again.',
			} );
			expect( ( failure as { cause?: unknown } ).cause ).toBe( defect );
			expect( logged.error ).toHaveBeenCalledTimes( 1 );
			expect( logged.error.mock.calls[ 0 ] ).toContain( defect );
			expect( logged.warn ).not.toHaveBeenCalled();
		}
	);

	it.each( [
		[
			'a provider switch',
			async ( id: string ) => {
				await setSessionProvider( root, id, 'wpcom', 'balanced' );
				return undefined;
			},
			{ provider: 'wpcom', model: 'balanced' },
			undefined,
		],
		[
			'a ChatGPT selection',
			( id: string ) => setSessionChatGptSelection( root, id, selection ),
			{
				provider: 'chatgpt-oauth',
				connectionId: A,
				revision: 1,
				chatGpt: { model: 'gpt-6-luna', reasoningEffort: 'medium' },
			},
			selection,
		],
		[
			'an OpenAI-key selection',
			( id: string ) =>
				setSessionOpenAiSelection( root, id, {
					model: 'gpt-6-luna',
					reasoningEffort: 'medium',
					reasoningMode: 'standard',
				} ),
			{
				provider: 'openai-api-key',
				model: 'gpt-6-luna',
				reasoningEffort: 'medium',
				reasoningMode: 'standard',
			},
			{ model: 'gpt-6-luna', reasoningEffort: 'medium', reasoningMode: 'standard' },
		],
	] )(
		'keeps %s it saved when its lock can’t be let go afterwards, and records that',
		async ( _name, select, written, returned ) => {
			const { id } = await createAiSession( root );
			lockRace.failRelease = true;

			await expect( select( id ) ).resolves.toEqual( returned );

			const records = ( await loadAiSession( root, id ) ).entries.flatMap( ( entry ) =>
				entry.type === 'custom' && entry.customType === 'studio.session_context'
					? [ entry.data ]
					: []
			);
			expect( records ).toEqual( [ written ] );
			expect( logged.warn ).toHaveBeenCalledTimes( 1 );
			expect( String( logged.warn.mock.calls[ 0 ] ) ).toContain( 'EPERM' );
			expect( logged.error ).not.toHaveBeenCalled();
		}
	);

	it.each( [
		[
			'a provider Studio doesn’t know',
			() => setSessionProvider( root, 'any', 'unknown-provider', 'balanced' ),
			'Choose a model this provider supports.',
		],
		[
			'a model the provider doesn’t serve',
			() => setSessionProvider( root, 'any', 'anthropic-api-key', 'gpt-6-luna' ),
			'Choose a model this provider supports.',
		],
		[
			'an unknown model',
			() => setSessionModel( root, 'any', 'unknown-model' ),
			'Choose a supported model.',
		],
	] )( 'refuses %s with a known message', async ( _name, write, message ) => {
		await expect( write() ).rejects.toMatchObject( { name: 'ChatGptSettingsError', message } );
	} );

	it( 'pins a chat on its site to ChatGPT where it is while nothing has happened in it, as the apps start one', async () => {
		const { id } = await createAiSession( root, {
			site: { id: 'one', name: 'Example', path: root },
		} );
		const before = ( await loadAiSession( root, id ) ).entries;
		expect( canPinChatGptInPlace( before ) ).toBe( true );

		await setSessionChatGptSelection( root, id, selection );

		expect( readChatGptSessionSelection( ( await loadAiSession( root, id ) ).entries ) ).toEqual(
			selection
		);
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
