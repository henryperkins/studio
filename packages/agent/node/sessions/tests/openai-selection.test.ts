import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSessionOpenAiSelection } from '@studio/agent/node/sessions/openai-selection';
import { createAiSession, loadAiSession } from '@studio/agent/node/sessions/store';
import { OpenAiSettingsError } from '@studio/agent/node/settings-store';
import { resolveOpenAiSessionSelection } from '@studio/agent/protocol/openai-models';
import { getEffectiveSessionProvider } from '@studio/agent/protocol/providers';

vi.mock( '@studio/common/lib/shared-config', async ( importOriginal ) => ( {
	...( await importOriginal< object >() ),
	readSharedSession: async () => undefined,
} ) );

const DEFAULTS = { model: 'gpt-6.1-sol', reasoningEffort: 'medium', reasoningMode: 'standard' };

describe( 'setSessionOpenAiSelection', () => {
	let root: string;

	beforeEach( async () => {
		root = await fs.mkdtemp( path.join( os.tmpdir(), 'studio-openai-selection-' ) );
	} );

	afterEach( () => fs.rm( root, { recursive: true, force: true } ) );

	it( 'pins the conversation, which keeps its choice after a reload', async () => {
		const { id } = await createAiSession( root );

		await setSessionOpenAiSelection( root, id, {
			model: 'gpt-6-astra',
			reasoningEffort: 'max',
			reasoningMode: 'pro',
		} );

		// What a restarted app reads back from disk.
		const { entries } = await loadAiSession( root, id );
		expect( getEffectiveSessionProvider( entries, null ) ).toBe( 'openai-api-key' );
		expect( resolveOpenAiSessionSelection( entries, DEFAULTS ) ).toEqual( {
			model: 'gpt-6-astra',
			reasoningEffort: 'max',
			reasoningMode: 'pro',
		} );
	} );

	it( 'changes only its own conversation', async () => {
		const first = await createAiSession( root );
		const second = await createAiSession( root );

		await setSessionOpenAiSelection( root, first.id, {
			model: 'gpt-6-luna',
			reasoningEffort: 'none',
			reasoningMode: 'standard',
		} );

		const { entries } = await loadAiSession( root, second.id );
		expect( resolveOpenAiSessionSelection( entries, DEFAULTS ) ).toEqual( DEFAULTS );
	} );

	it.each( [
		[ { model: 'gpt-6-astra', reasoningEffort: 'none', reasoningMode: 'standard' } ],
		[ { model: 'gpt-6.1-sol', reasoningEffort: 'medium', reasoningMode: 'turbo' } ],
		[ { model: 'gpt-7-preview', reasoningEffort: 'medium', reasoningMode: 'standard' } ],
		[ { model: 'gpt-6-luna', reasoningEffort: 3, reasoningMode: 'standard' } ],
	] )( 'refuses %j and writes nothing', async ( selection ) => {
		const { id } = await createAiSession( root );
		const before = ( await loadAiSession( root, id ) ).entries.length;

		await expect( setSessionOpenAiSelection( root, id, selection ) ).rejects.toBeInstanceOf(
			OpenAiSettingsError
		);
		expect( ( await loadAiSession( root, id ) ).entries ).toHaveLength( before );
	} );
} );
