import { describe, expect, it } from 'vitest';
import {
	AI_PROVIDER_IDS,
	getAiProviderDefaultModel,
	getAiProviderModels,
	getEffectiveSessionProvider,
	isAiProviderConnected,
	resolveConversationProvider,
} from '@studio/agent/protocol/providers';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

const contextEntry = ( data: Record< string, unknown > ): SessionEntry =>
	( {
		type: 'custom',
		id: Math.random().toString( 36 ).slice( 2 ),
		parentId: null,
		timestamp: new Date( 0 ).toISOString(),
		customType: 'studio.session_context',
		data,
	} ) as unknown as SessionEntry;

const settings = (
	provider: ( typeof AI_PROVIDER_IDS )[ number ],
	{ hasAnthropicApiKey = false, hasOpenAiApiKey = false } = {}
) => ( { provider, hasAnthropicApiKey, hasOpenAiApiKey } );

describe( 'OpenAI provider identity', () => {
	it( 'is appended to the persisted provider list', () => {
		expect( AI_PROVIDER_IDS ).toEqual( [ 'wpcom', 'anthropic-api-key', 'openai-api-key' ] );
	} );

	it( 'serves only the OpenAI family', () => {
		expect( getAiProviderModels( 'openai-api-key' ).map( ( model ) => model.id ) ).toEqual( [
			'gpt-6.1-sol',
			'gpt-6-astra',
			'gpt-6.1-terra',
			'gpt-6-luna',
		] );
		expect( getAiProviderModels( 'wpcom' ).every( ( model ) => model.family === 'studio' ) ).toBe(
			true
		);
		expect(
			getAiProviderModels( 'anthropic-api-key' ).every( ( model ) => model.family === 'anthropic' )
		).toBe( true );
	} );

	it( 'defaults to the saved OpenAI default model', () => {
		expect( getAiProviderDefaultModel( 'openai-api-key' ) ).toBe( 'gpt-6.1-sol' );
		expect(
			getAiProviderDefaultModel( 'openai-api-key', { openAiDefaultModel: 'gpt-6-luna' } )
		).toBe( 'gpt-6-luna' );
	} );

	it( 'is connected by an OpenAI key alone', () => {
		expect(
			isAiProviderConnected( 'openai-api-key', {
				hasWpcomAuth: false,
				settings: { hasAnthropicApiKey: false, hasOpenAiApiKey: true },
			} )
		).toBe( true );
		expect(
			isAiProviderConnected( 'openai-api-key', {
				hasWpcomAuth: true,
				settings: { hasAnthropicApiKey: true, hasOpenAiApiKey: false },
			} )
		).toBe( false );
	} );
} );

describe( 'resolveConversationProvider', () => {
	it( 'runs a new conversation on OpenAI without WordPress.com or an Anthropic key', () => {
		expect(
			getEffectiveSessionProvider( [], settings( 'openai-api-key', { hasOpenAiApiKey: true } ) )
		).toBe( 'openai-api-key' );
	} );

	it( 'keeps an OpenAI conversation on OpenAI after its key is removed', () => {
		const entries = [ contextEntry( { provider: 'openai-api-key', model: 'gpt-6.1-sol' } ) ];
		expect( getEffectiveSessionProvider( entries, settings( 'wpcom' ) ) ).toBe( 'openai-api-key' );
		expect( getEffectiveSessionProvider( entries, null ) ).toBe( 'openai-api-key' );
	} );

	it( 'keeps an unpinned conversation that ran on OpenAI there', () => {
		const entries = [ contextEntry( { model: 'gpt-6-luna' } ) ];
		expect(
			getEffectiveSessionProvider(
				entries,
				settings( 'anthropic-api-key', { hasAnthropicApiKey: true } )
			)
		).toBe( 'openai-api-key' );
	} );

	it( 'does not move conversations that ran elsewhere onto a new OpenAI default', () => {
		const global = settings( 'openai-api-key', { hasOpenAiApiKey: true } );
		expect( getEffectiveSessionProvider( [ contextEntry( { model: 'fast' } ) ], global ) ).toBe(
			'wpcom'
		);
		expect(
			getEffectiveSessionProvider( [ contextEntry( { model: 'claude-sonnet-5' } ) ], {
				...global,
				hasAnthropicApiKey: true,
			} )
		).toBe( 'anthropic-api-key' );
		// The Anthropic rule below still applies to such a conversation.
		expect(
			getEffectiveSessionProvider( [ contextEntry( { model: 'claude-sonnet-5' } ) ], global )
		).toBe( 'wpcom' );
	} );

	it( 'keeps the existing WordPress.com and Anthropic rules', () => {
		const pinnedAnthropic = [
			contextEntry( { provider: 'anthropic-api-key', model: 'claude-sonnet-5' } ),
		];
		expect( getEffectiveSessionProvider( pinnedAnthropic, settings( 'wpcom' ) ) ).toBe( 'wpcom' );
		expect(
			getEffectiveSessionProvider(
				pinnedAnthropic,
				settings( 'wpcom', { hasAnthropicApiKey: true } )
			)
		).toBe( 'anthropic-api-key' );
		expect(
			getEffectiveSessionProvider(
				[],
				settings( 'anthropic-api-key', { hasAnthropicApiKey: true } )
			)
		).toBe( 'anthropic-api-key' );
		expect( getEffectiveSessionProvider( [], null ) ).toBe( 'wpcom' );
		expect(
			resolveConversationProvider( { pinnedProvider: 'wpcom', hasAnthropicApiKey: true } )
		).toBe( 'wpcom' );
	} );
} );
