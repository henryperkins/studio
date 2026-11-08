import { describe, expect, it } from 'vitest';
import {
	describeConnectionSelectionError,
	resolveConnectionSelection,
	type ConnectionRegistry,
	type ConnectionRegistryEntry,
} from '@studio/agent/protocol/connections';
import { readLatestRecordedModelId, readRecordedSessionModel } from '@studio/agent/protocol/models';
import {
	AI_PROVIDER_IDS,
	AI_PROVIDER_LABELS,
	ANTHROPIC_PI_PROVIDER,
	CHATGPT_PI_PROVIDER,
	getAiModelFamilyProvider,
	getAiProviderModels,
	getEffectiveSessionProvider,
	isAiProviderConnected,
	OPENAI_PI_PROVIDER,
	readLastReplyProvider,
	type AiProviderId,
	type AiSettings,
} from '@studio/agent/protocol/providers';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

const entryId = () => Math.random().toString( 36 ).slice( 2 );

const contextEntry = ( data: Record< string, unknown > ): SessionEntry =>
	( {
		type: 'custom',
		id: entryId(),
		parentId: null,
		timestamp: new Date( 0 ).toISOString(),
		customType: 'studio.session_context',
		data,
	} ) as unknown as SessionEntry;

const modelChange = ( modelId: string ): SessionEntry =>
	( {
		type: 'model_change',
		id: entryId(),
		parentId: null,
		timestamp: new Date( 0 ).toISOString(),
		modelId,
	} ) as unknown as SessionEntry;

const message = ( role: 'user' | 'assistant', provider?: string ): SessionEntry =>
	( {
		type: 'message',
		id: entryId(),
		parentId: null,
		timestamp: new Date( 0 ).toISOString(),
		message:
			role === 'user'
				? { role, content: 'Hello', timestamp: 0 }
				: { role, content: [], provider, model: 'retired', timestamp: 0 },
	} ) as unknown as SessionEntry;

// Opaque, as sign-in mints them: nothing may read meaning into it.
const CHATGPT_CONNECTION_ID = 'a1f0c9e2-6d3b-4c55-9b8e-3f2d7c1e8a40';

const chatGptConnection = (
	overrides: Partial< ConnectionRegistryEntry > = {}
): ConnectionRegistryEntry => ( {
	connectionId: CHATGPT_CONNECTION_ID,
	providerId: 'chatgpt-oauth',
	backend: 'pi',
	revision: 3,
	identity: { subject: 'user-subject-1', email: 'someone@example.com' },
	authStatus: 'connected',
	...overrides,
} );

// A ChatGPT pin or per-turn record: it names the connection and its revision.
const chatGptRecord = ( data: Record< string, unknown > = {} ) =>
	contextEntry( {
		provider: 'chatgpt-oauth',
		connectionId: CHATGPT_CONNECTION_ID,
		revision: 3,
		model: 'gpt-6.1-sol',
		...data,
	} );

type LegacySettings = Pick< AiSettings, 'provider' | 'hasAnthropicApiKey' >;

const settings = ( provider: AiProviderId, hasAnthropicApiKey = false ): LegacySettings => ( {
	provider,
	hasAnthropicApiKey,
} );

const registry = ( overrides: Partial< ConnectionRegistry > = {} ): ConnectionRegistry => ( {
	connections: [ chatGptConnection() ],
	settings: settings( 'wpcom' ),
	...overrides,
} );

// What a legacy provider's implicit connection resolves to.
const legacy = ( providerId: AiProviderId, modelId: string ) => ( {
	ok: true,
	selection: { connectionId: providerId, model: { providerId, modelId }, revision: 0 },
} );

const chatGpt = ( modelId = 'gpt-6.1-sol', revision = 3 ) => ( {
	ok: true,
	selection: {
		connectionId: CHATGPT_CONNECTION_ID,
		model: { providerId: 'chatgpt-oauth', modelId },
		revision,
	},
} );

describe( 'ChatGPT provider identity', () => {
	it( 'is appended to the persisted ids, which keep their places', () => {
		expect( AI_PROVIDER_IDS ).toEqual( [
			'wpcom',
			'anthropic-api-key',
			'openai-api-key',
			'chatgpt-oauth',
		] );
		expect( AI_PROVIDER_LABELS[ 'chatgpt-oauth' ] ).toBe( 'ChatGPT' );
	} );

	it( 'has a pi provider of its own, apart from the API key’s and pi’s built-in one', () => {
		expect( [ OPENAI_PI_PROVIDER, ANTHROPIC_PI_PROVIDER, CHATGPT_PI_PROVIDER ] ).toEqual( [
			'studio-openai',
			'anthropic',
			'studio-chatgpt',
		] );
	} );
} );

describe( 'the same model slug under an API key and a ChatGPT connection', () => {
	it( 'resolves to two different connections and models', () => {
		expect(
			resolveConnectionSelection(
				[ contextEntry( { provider: 'openai-api-key', model: 'gpt-6.1-sol' } ) ],
				registry()
			)
		).toEqual( legacy( 'openai-api-key', 'gpt-6.1-sol' ) );
		expect( resolveConnectionSelection( [ chatGptRecord() ], registry() ) ).toEqual( chatGpt() );
	} );

	it( 'routes an OpenAI model recorded without a provider to the API key, as before', () => {
		// Per-turn records carry only the model; its family names the API key.
		const entries = [ contextEntry( { model: 'gpt-6.1-sol' } ) ];
		expect( resolveConnectionSelection( entries, registry() ) ).toEqual(
			legacy( 'openai-api-key', 'gpt-6.1-sol' )
		);
		expect( getEffectiveSessionProvider( entries, settings( 'wpcom' ) ) ).toBe( 'openai-api-key' );
	} );

	it( 'never reads a model recorded under ChatGPT as the API model of that slug', () => {
		const entries = [ chatGptRecord() ];
		expect( readRecordedSessionModel( entries ) ).toBeUndefined();
		expect( readLatestRecordedModelId( entries ) ).toBeUndefined();
		// The API conversation it was switched from keeps its own model.
		const switched = [
			contextEntry( { provider: 'openai-api-key', model: 'gpt-6-luna' } ),
			chatGptRecord(),
		];
		expect( readRecordedSessionModel( switched ) ).toBe( 'gpt-6-luna' );
		expect( resolveConnectionSelection( switched, registry() ) ).toEqual( chatGpt() );
	} );

	it( 'keeps a ChatGPT conversation on ChatGPT whatever keys and default are saved', () => {
		const entries = [ chatGptRecord() ];
		for ( const saved of [
			settings( 'openai-api-key', true ),
			settings( 'anthropic-api-key', true ),
			settings( 'wpcom' ),
			null,
		] ) {
			expect( getEffectiveSessionProvider( entries, saved ) ).toBe( 'chatgpt-oauth' );
			expect( resolveConnectionSelection( entries, registry( { settings: saved } ) ) ).toEqual(
				chatGpt()
			);
		}
	} );
} );

describe( 'a model Studio no longer offers', () => {
	it( 'keeps an OpenAI conversation on the API key with the model it recorded', () => {
		const entries = [
			contextEntry( { model: 'gpt-5.6-sol' } ),
			message( 'user' ),
			message( 'assistant', 'studio-openai' ),
		];
		expect( resolveConnectionSelection( entries, registry() ) ).toEqual(
			legacy( 'openai-api-key', 'gpt-5.6-sol' )
		);
	} );

	it( 'never sends a conversation that recorded one to ChatGPT', () => {
		for ( const model of [ 'gpt-5.6-sol', 'gpt-7-preview', 'claude-retired-4' ] ) {
			const entries = [ contextEntry( { model } ), message( 'user' ) ];
			expect( resolveConnectionSelection( entries, registry() ) ).toEqual(
				legacy( 'wpcom', 'fast' )
			);
			// Without a reply it starts on the OpenAI default, whose turn then
			// reports the model it can't use.
			expect(
				resolveConnectionSelection(
					entries,
					registry( { settings: settings( 'openai-api-key' ) } )
				)
			).toEqual( legacy( 'openai-api-key', model ) );
		}
	} );
} );

describe( 'a connection that is gone', () => {
	const disconnected = {
		ok: false,
		error: {
			code: 'disconnected',
			providerId: 'chatgpt-oauth',
			connectionId: CHATGPT_CONNECTION_ID,
		},
	};

	it( 'fails a ChatGPT conversation whose connection was removed, rather than move it', () => {
		const entries = [
			chatGptRecord(),
			message( 'user' ),
			message( 'assistant', 'studio-chatgpt' ),
		];
		for ( const saved of [ settings( 'wpcom' ), settings( 'openai-api-key', true ), null ] ) {
			expect( resolveConnectionSelection( entries, { connections: [], settings: saved } ) ).toEqual(
				disconnected
			);
			expect( getEffectiveSessionProvider( entries, saved ) ).toBe( 'chatgpt-oauth' );
		}
	} );

	it( 'fails one whose connection is signed out', () => {
		expect(
			resolveConnectionSelection(
				[ chatGptRecord() ],
				registry( { connections: [ chatGptConnection( { authStatus: 'disconnected' } ) ] } )
			)
		).toEqual( disconnected );
	} );

	it( 'fails one whose connection claims to be connected without a verified identity', () => {
		for ( const identity of [ null, { subject: '' } ] ) {
			expect(
				resolveConnectionSelection(
					[ chatGptRecord() ],
					registry( { connections: [ chatGptConnection( { identity } ) ] } )
				)
			).toEqual( disconnected );
		}
	} );

	it( 'fails one whose connection changed since it last ran', () => {
		expect(
			resolveConnectionSelection(
				[ chatGptRecord() ],
				registry( { connections: [ chatGptConnection( { revision: 4 } ) ] } )
			)
		).toEqual( {
			ok: false,
			error: {
				code: 'changed',
				providerId: 'chatgpt-oauth',
				connectionId: CHATGPT_CONNECTION_ID,
				recordedRevision: 3,
				currentRevision: 4,
			},
		} );
	} );

	it( 'keeps the API-key rules when a key is removed', () => {
		// OpenAI stays put and shows as disconnected; Anthropic runs on WordPress.com.
		expect(
			resolveConnectionSelection(
				[ contextEntry( { provider: 'openai-api-key', model: 'gpt-6.1-sol' } ) ],
				registry()
			)
		).toEqual( legacy( 'openai-api-key', 'gpt-6.1-sol' ) );
		expect(
			resolveConnectionSelection(
				[ contextEntry( { provider: 'anthropic-api-key', model: 'claude-sonnet-5' } ) ],
				registry()
			)
		).toEqual( legacy( 'wpcom', 'fast' ) );
	} );
} );

describe( 'a reply without a pin', () => {
	it( 'reads each reply by the pi provider that wrote it', () => {
		const lastReply = ( provider: string ) =>
			readLastReplyProvider( [ message( 'user' ), message( 'assistant', provider ) ] );
		expect( lastReply( 'studio-openai' ) ).toBe( 'openai-api-key' );
		expect( lastReply( 'anthropic' ) ).toBe( 'anthropic-api-key' );
		expect( lastReply( 'studio-wpcom' ) ).toBe( 'wpcom' );
		expect( lastReply( 'studio-chatgpt' ) ).toBe( 'chatgpt-oauth' );
		// pi's own ChatGPT provider isn't Studio's route.
		expect( lastReply( 'openai-codex' ) ).toBe( 'wpcom' );
	} );

	it( 'routes old replies as before', () => {
		const openAiDefault = registry( { settings: settings( 'openai-api-key' ) } );
		const after = ( provider: string ) => [ message( 'user' ), message( 'assistant', provider ) ];
		expect( resolveConnectionSelection( after( 'studio-openai' ), registry() ) ).toEqual(
			legacy( 'openai-api-key', 'gpt-6.1-sol' )
		);
		expect( resolveConnectionSelection( after( 'anthropic' ), openAiDefault ) ).toEqual(
			legacy( 'wpcom', 'fast' )
		);
		expect( resolveConnectionSelection( after( 'studio-wpcom' ), openAiDefault ) ).toEqual(
			legacy( 'wpcom', 'fast' )
		);
		expect( resolveConnectionSelection( after( 'openai-codex' ), openAiDefault ) ).toEqual(
			legacy( 'wpcom', 'fast' )
		);
	} );

	it( 'keeps a conversation that ran on ChatGPT there with no record, and fails it', () => {
		const unsupported = { ok: false, error: { code: 'unsupported', providerId: 'chatgpt-oauth' } };
		for ( const entries of [
			[ message( 'user' ), message( 'assistant', 'studio-chatgpt' ) ],
			// Nor does a record of an OpenAI model take it to the API key.
			[
				contextEntry( { model: 'gpt-6.1-sol' } ),
				message( 'user' ),
				message( 'assistant', 'studio-chatgpt' ),
			],
		] ) {
			for ( const saved of [
				settings( 'openai-api-key', true ),
				settings( 'anthropic-api-key', true ),
				settings( 'wpcom' ),
				null,
			] ) {
				expect( getEffectiveSessionProvider( entries, saved ) ).toBe( 'chatgpt-oauth' );
				// A connected ChatGPT connection doesn't help: no record names it.
				expect( resolveConnectionSelection( entries, registry( { settings: saved } ) ) ).toEqual(
					unsupported
				);
			}
		}
	} );
} );

describe( 'no implicit ChatGPT selection', () => {
	it( 'never starts a conversation on ChatGPT from the saved default', () => {
		for ( const hasAnthropicApiKey of [ false, true ] ) {
			const saved = settings( 'chatgpt-oauth', hasAnthropicApiKey );
			expect( getEffectiveSessionProvider( [], saved ) ).toBe( 'wpcom' );
			expect( resolveConnectionSelection( [], registry( { settings: saved } ) ) ).toEqual(
				legacy( 'wpcom', 'fast' )
			);
		}
	} );

	it( 'offers ChatGPT neither through a model family nor as a connected provider', () => {
		expect( getAiProviderModels( 'chatgpt-oauth' ) ).toEqual( [] );
		expect(
			( [ 'studio', 'anthropic', 'openai' ] as const ).map( getAiModelFamilyProvider )
		).toEqual( [ 'wpcom', 'anthropic-api-key', 'openai-api-key' ] );
		expect(
			isAiProviderConnected( 'chatgpt-oauth', {
				hasWpcomAuth: true,
				settings: { hasAnthropicApiKey: true, hasOpenAiApiKey: true },
			} )
		).toBe( false );
	} );
} );

describe( 'ChatGPT records', () => {
	it.each( [
		[ 'no connection', { connectionId: undefined } ],
		[ 'an empty connection id', { connectionId: '' } ],
		[ 'no revision', { revision: undefined } ],
		[ 'a revision that isn’t a whole number', { revision: '3' } ],
		[ 'no model', { model: '' } ],
	] )( 'refuses one with %s', ( _label, data ) => {
		const result = resolveConnectionSelection( [ chatGptRecord( data ) ], registry() );
		expect( result.ok ? result.selection : result.error.code ).toBe( 'unsupported' );
	} );

	it( 'never runs one on another provider’s connection', () => {
		const entries = [ chatGptRecord( { connectionId: 'openai-api-key' } ) ];
		expect( resolveConnectionSelection( entries, registry() ) ).toEqual( {
			ok: false,
			error: { code: 'disconnected', providerId: 'chatgpt-oauth', connectionId: 'openai-api-key' },
		} );
		// Even a registry that lists the API key under that id.
		const listed = registry( {
			connections: [
				chatGptConnection( { connectionId: 'openai-api-key', providerId: 'openai-api-key' } ),
			],
		} );
		expect( resolveConnectionSelection( entries, listed ) ).toEqual( {
			ok: false,
			error: { code: 'unsupported', providerId: 'chatgpt-oauth', connectionId: 'openai-api-key' },
		} );
	} );

	it( 'refuses a ChatGPT connection on another backend', () => {
		expect(
			resolveConnectionSelection(
				[ chatGptRecord() ],
				registry( { connections: [ chatGptConnection( { backend: 'claude-code' } ) ] } )
			)
		).toEqual( {
			ok: false,
			error: {
				code: 'unsupported',
				providerId: 'chatgpt-oauth',
				connectionId: CHATGPT_CONNECTION_ID,
			},
		} );
	} );

	it( 'takes the connection and model from the latest ChatGPT record only', () => {
		const entries = [
			chatGptRecord( { model: 'gpt-6-astra', revision: 2 } ),
			chatGptRecord( { model: 'gpt-6-luna' } ),
			// Neither names a provider, so neither speaks for ChatGPT.
			contextEntry( { model: 'fast' } ),
			modelChange( 'claude-opus-5' ),
		];
		expect( resolveConnectionSelection( entries, registry() ) ).toEqual( chatGpt( 'gpt-6-luna' ) );
	} );

	it( 'follows an explicit switch to another provider', () => {
		const switched = [
			message( 'user' ),
			message( 'assistant', 'studio-chatgpt' ),
			contextEntry( { provider: 'anthropic-api-key', model: 'claude-sonnet-5' } ),
		];
		const withKey = registry( { settings: settings( 'wpcom', true ) } );
		expect( resolveConnectionSelection( [ chatGptRecord(), ...switched ], withKey ) ).toEqual(
			legacy( 'anthropic-api-key', 'claude-sonnet-5' )
		);
		// Also from a conversation that ran on ChatGPT with no record.
		expect( resolveConnectionSelection( switched, withKey ) ).toEqual(
			legacy( 'anthropic-api-key', 'claude-sonnet-5' )
		);
	} );

	it( 'explains each failure under the ChatGPT name', () => {
		for ( const code of [ 'disconnected', 'changed', 'unsupported' ] as const ) {
			const text = describeConnectionSelectionError( { code, providerId: 'chatgpt-oauth' } );
			expect( text ).toContain( 'ChatGPT' );
			expect( text ).not.toMatch( /codex/i );
		}
	} );
} );

describe( 'parity with the legacy rules', () => {
	const openAiDefault = settings( 'openai-api-key' );
	const openAiPin = contextEntry( { provider: 'openai-api-key', model: 'gpt-6.1-sol' } );
	const anthropicPin = contextEntry( { provider: 'anthropic-api-key', model: 'claude-sonnet-5' } );
	const droppedOpenAi = [
		contextEntry( { model: 'gpt-5.6-sol' } ),
		message( 'user' ),
		message( 'assistant', 'studio-openai' ),
	];
	// providers.test.ts's scenarios, with the provider getEffectiveSessionProvider gives each.
	const cases: Array< [ string, SessionEntry[], LegacySettings | null, AiProviderId, string ] > = [
		[ 'a new chat on the OpenAI default', [], openAiDefault, 'openai-api-key', 'gpt-6.1-sol' ],
		[
			'an OpenAI pin without a key',
			[ openAiPin ],
			settings( 'wpcom' ),
			'openai-api-key',
			'gpt-6.1-sol',
		],
		[ 'an OpenAI pin, settings unloaded', [ openAiPin ], null, 'openai-api-key', 'gpt-6.1-sol' ],
		[
			'an unpinned OpenAI record',
			[ contextEntry( { model: 'gpt-6-luna' } ) ],
			settings( 'anthropic-api-key', true ),
			'openai-api-key',
			'gpt-6-luna',
		],
		[
			'a WordPress.com record, OpenAI default',
			[ contextEntry( { model: 'fast' } ) ],
			openAiDefault,
			'wpcom',
			'fast',
		],
		[
			'an Anthropic record with a key, OpenAI default',
			[ contextEntry( { model: 'claude-sonnet-5' } ) ],
			settings( 'openai-api-key', true ),
			'anthropic-api-key',
			'claude-sonnet-5',
		],
		[
			'an Anthropic record without a key, OpenAI default',
			[ contextEntry( { model: 'claude-sonnet-5' } ) ],
			openAiDefault,
			'wpcom',
			'fast',
		],
		[
			'Anthropic replies on a dropped model',
			[
				contextEntry( { model: 'claude-retired-4' } ),
				message( 'user' ),
				message( 'assistant', 'anthropic' ),
			],
			openAiDefault,
			'wpcom',
			'fast',
		],
		[
			'WordPress.com replies without a record',
			[ message( 'user' ), message( 'assistant', 'studio-wpcom' ) ],
			openAiDefault,
			'wpcom',
			'fast',
		],
		[
			'OpenAI replies on a dropped model, OpenAI default',
			droppedOpenAi,
			openAiDefault,
			'openai-api-key',
			'gpt-5.6-sol',
		],
		[
			'OpenAI replies on a dropped model, WordPress.com default',
			droppedOpenAi,
			settings( 'wpcom' ),
			'openai-api-key',
			'gpt-5.6-sol',
		],
		[
			'a first turn that failed before a reply',
			[ message( 'user' ) ],
			openAiDefault,
			'openai-api-key',
			'gpt-6.1-sol',
		],
		[ 'an Anthropic pin without a key', [ anthropicPin ], settings( 'wpcom' ), 'wpcom', 'fast' ],
		[
			'an Anthropic pin with a key',
			[ anthropicPin ],
			settings( 'wpcom', true ),
			'anthropic-api-key',
			'claude-sonnet-5',
		],
		[
			'a new chat on the Anthropic default',
			[],
			settings( 'anthropic-api-key', true ),
			'anthropic-api-key',
			'claude-sonnet-5',
		],
		[ 'a new chat, settings unloaded', [], null, 'wpcom', 'fast' ],
		[
			'a WordPress.com pin with an Anthropic key',
			[ contextEntry( { provider: 'wpcom', model: 'fast' } ) ],
			settings( 'wpcom', true ),
			'wpcom',
			'fast',
		],
	];

	it.each( cases )( '%s', ( _label, entries, saved, provider, model ) => {
		expect( getEffectiveSessionProvider( entries, saved ) ).toBe( provider );
		// A connected ChatGPT connection changes nothing for a chat without a ChatGPT record.
		expect(
			resolveConnectionSelection( entries, {
				connections: [ chatGptConnection() ],
				settings: saved,
			} )
		).toEqual( legacy( provider, model ) );
	} );
} );
