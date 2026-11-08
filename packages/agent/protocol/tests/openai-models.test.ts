import { describe, expect, it } from 'vitest';
import { AI_MODELS, aiModelSupportsImages } from '@studio/agent/protocol/models';
import {
	describeOpenAiSettingsProblem,
	getInitialOpenAiReasoningEffort,
	getOpenAiModelCapabilities,
	OPENAI_DEFAULT_MAX_OUTPUT_TOKENS,
	OPENAI_DEFAULT_MODEL,
	OPENAI_MODEL_CAPABILITIES,
	OPENAI_MODEL_CATALOG_VERSION,
	OPENAI_MODEL_IDS,
	OPENAI_REASONING_EFFORTS,
	resolveOpenAiSessionSelection,
	resolveOpenAiTurnSettings,
	type OpenAiModelId,
} from '@studio/agent/protocol/openai-models';
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

const modelChangeEntry = ( modelId: string ): SessionEntry =>
	( {
		type: 'model_change',
		id: Math.random().toString( 36 ).slice( 2 ),
		parentId: null,
		timestamp: new Date( 0 ).toISOString(),
		provider: '',
		modelId,
	} ) as unknown as SessionEntry;

const valid = ( overrides: Partial< Parameters< typeof resolveOpenAiTurnSettings >[ 0 ] > = {} ) =>
	resolveOpenAiTurnSettings( {
		model: 'gpt-6.1-sol',
		reasoningEffort: 'medium',
		reasoningMode: 'standard',
		maxOutputTokens: OPENAI_DEFAULT_MAX_OUTPUT_TOKENS,
		...overrides,
	} );

describe( 'OpenAI model catalog', () => {
	it( 'describes every OpenAI model Studio offers, and nothing else', () => {
		const offered = AI_MODELS.filter( ( model ) => model.family === 'openai' ).map(
			( model ) => model.id
		);
		expect( Object.keys( OPENAI_MODEL_CAPABILITIES ).sort() ).toEqual( [ ...offered ].sort() );
		expect( OPENAI_MODEL_IDS ).toEqual( offered );
		expect( OPENAI_MODEL_IDS ).toContain( OPENAI_DEFAULT_MODEL );
	} );

	it.each( OPENAI_MODEL_IDS )( 'keeps a consistent, documented entry for %s', ( id ) => {
		const capabilities = OPENAI_MODEL_CAPABILITIES[ id ];
		expect( capabilities.responsesApi ).toBe( true );
		expect( capabilities.functionTools ).toBe( true );
		expect( capabilities.reasoningEfforts.length ).toBeGreaterThan( 0 );
		for ( const effort of capabilities.reasoningEfforts ) {
			expect( OPENAI_REASONING_EFFORTS ).toContain( effort );
		}
		if ( capabilities.defaultReasoningEffort ) {
			expect( capabilities.reasoningEfforts ).toContain( capabilities.defaultReasoningEffort );
		}
		expect( capabilities.maxOutputTokens ).toBeLessThan( capabilities.maxInputTokens );
		expect( capabilities.maxInputTokens ).toBeLessThanOrEqual( capabilities.contextWindow );
		expect( capabilities.documentation.modelPage ).toBe(
			`https://developers.openai.com/api/docs/models/${ capabilities.apiModelId }`
		);
		expect( capabilities.documentation.checked ).toBe( OPENAI_MODEL_CATALOG_VERSION );
		// Screenshot tools are offered from the shared model list's flag.
		expect( aiModelSupportsImages( id ) ).toBe( capabilities.imageInput );
	} );

	// Each set is copied from the model's page (checked 2026-11-07). A change
	// here must come with a new documentation check, not a guess.
	it.each( [
		[ 'gpt-6.1-sol', [ 'low', 'medium', 'high', 'xhigh', 'max' ], 'medium' ],
		[ 'gpt-6-astra', [ 'low', 'medium', 'high', 'xhigh', 'max' ], undefined ],
		[ 'gpt-6.1-terra', [ 'none', 'low', 'medium', 'high', 'xhigh', 'max' ], 'medium' ],
		[ 'gpt-6-luna', [ 'none', 'low', 'medium', 'high', 'xhigh', 'max' ], 'medium' ],
	] as const )( '%s supports exactly the documented efforts', ( id, efforts, defaultEffort ) => {
		expect( OPENAI_MODEL_CAPABILITIES[ id ].reasoningEfforts ).toEqual( efforts );
		expect( OPENAI_MODEL_CAPABILITIES[ id ].defaultReasoningEffort ).toBe( defaultEffort );
		expect( OPENAI_MODEL_CAPABILITIES[ id ].reasoningModes ).toEqual( [ 'standard', 'pro' ] );
		expect( OPENAI_MODEL_CAPABILITIES[ id ].maxOutputTokens ).toBe( 128_000 );
	} );

	it( 'has no capabilities for models outside the catalog', () => {
		expect( getOpenAiModelCapabilities( 'text-embedding-4-large' ) ).toBeUndefined();
		expect( getOpenAiModelCapabilities( 'gpt-7-preview' ) ).toBeUndefined();
		expect( getOpenAiModelCapabilities( 'claude-opus-5' ) ).toBeUndefined();
	} );

	it.each( OPENAI_MODEL_IDS )( 'starts %s at medium effort, which it supports', ( id ) => {
		expect( getInitialOpenAiReasoningEffort( id ) ).toBe( 'medium' );
	} );
} );

describe( 'resolveOpenAiTurnSettings', () => {
	it.each(
		OPENAI_MODEL_IDS.flatMap( ( id ) =>
			OPENAI_MODEL_CAPABILITIES[ id ].reasoningEfforts.flatMap( ( effort ) =>
				( [ 'standard', 'pro' ] as const ).map( ( mode ) => [ id, effort, mode ] as const )
			)
		)
	)( 'accepts %s with %s effort in %s mode', ( model, reasoningEffort, reasoningMode ) => {
		const result = valid( { model, reasoningEffort, reasoningMode } );
		expect( result ).toEqual( {
			ok: true,
			settings: {
				model,
				apiModelId: OPENAI_MODEL_CAPABILITIES[ model ].apiModelId,
				reasoningEffort,
				reasoningMode,
				maxOutputTokens: OPENAI_DEFAULT_MAX_OUTPUT_TOKENS,
			},
		} );
	} );

	it.each( [
		[ 'gpt-6-astra', 'none' ],
		[ 'gpt-6.1-sol', 'none' ],
		[ 'gpt-6.1-sol', 'minimal' ],
		[ 'gpt-6.1-terra', 'minimal' ],
		[ 'gpt-6-luna', 'minimal' ],
		[ 'gpt-6-luna', 'ultra' ],
	] as const )( 'rejects %s with %s effort instead of picking another', ( model, effort ) => {
		const result = valid( { model, reasoningEffort: effort } );
		expect( result ).toEqual( {
			ok: false,
			problem: {
				code: 'unsupported-effort',
				model,
				effort,
				supported: OPENAI_MODEL_CAPABILITIES[ model ].reasoningEfforts,
			},
		} );
	} );

	it( 'rejects a mode the model does not offer', () => {
		expect( valid( { reasoningMode: 'turbo' } ) ).toMatchObject( {
			ok: false,
			problem: { code: 'unsupported-mode', mode: 'turbo', supported: [ 'standard', 'pro' ] },
		} );
	} );

	it( 'reports a model outside the catalog instead of guessing its capabilities', () => {
		expect( valid( { model: 'gpt-7-preview' } ) ).toEqual( {
			ok: false,
			problem: { code: 'unknown-model', model: 'gpt-7-preview' },
		} );
	} );

	it( 'rules out a model only when the account’s list is known and lacks it', () => {
		expect( valid( { availableModelIds: [ 'gpt-6-luna' ] } ) ).toEqual( {
			ok: false,
			problem: { code: 'model-not-available', model: 'gpt-6.1-sol' },
		} );
		expect( valid( { availableModelIds: [ 'gpt-6.1-sol' ] } ).ok ).toBe( true );
		expect( valid( { availableModelIds: null } ).ok ).toBe( true );
	} );

	it.each( [ 1_023, 128_001, 32_000.5, Number.NaN ] )(
		'rejects an output cap of %s',
		( maxOutputTokens ) => {
			expect( valid( { maxOutputTokens } ) ).toMatchObject( {
				ok: false,
				problem: { code: 'invalid-max-output-tokens', min: 1_024, max: 128_000 },
			} );
		}
	);

	it( 'accepts the documented maximum output cap', () => {
		expect( valid( { maxOutputTokens: 128_000 } ).ok ).toBe( true );
	} );

	it( 'explains each problem with the way to fix it', () => {
		const effort = valid( { model: 'gpt-6-astra', reasoningEffort: 'none' } );
		const unknown = valid( { model: 'gpt-7-preview' } );
		const unavailable = valid( { availableModelIds: [] } );
		expect( effort.ok || describeOpenAiSettingsProblem( effort.problem ) ).toBe(
			'GPT-6 Astra doesn’t support “None” reasoning. Choose one of: Low, Medium, High, Extra high, Max.'
		);
		expect( unknown.ok || describeOpenAiSettingsProblem( unknown.problem ) ).toMatch(
			/gpt-7-preview.*Choose another model/
		);
		expect( unavailable.ok || describeOpenAiSettingsProblem( unavailable.problem ) ).toMatch(
			/GPT-6\.1 Sol isn’t in your OpenAI project’s model list/
		);
	} );
} );

describe( 'resolveOpenAiSessionSelection', () => {
	const defaults = {
		model: 'gpt-6.1-sol' as OpenAiModelId,
		reasoningEffort: 'medium',
		reasoningMode: 'standard',
	};

	it( 'uses the defaults for a conversation that chose nothing', () => {
		expect( resolveOpenAiSessionSelection( [], defaults ) ).toEqual( defaults );
	} );

	it( 'keeps each choice from the latest entry that made it', () => {
		const entries = [
			contextEntry( {
				provider: 'openai-api-key',
				model: 'gpt-6-astra',
				reasoningEffort: 'xhigh',
				reasoningMode: 'pro',
			} ),
			contextEntry( { provider: 'openai-api-key', model: 'gpt-6-astra', reasoningEffort: 'max' } ),
			modelChangeEntry( 'gpt-6.1-terra' ),
		];
		expect( resolveOpenAiSessionSelection( entries, defaults ) ).toEqual( {
			model: 'gpt-6.1-terra',
			reasoningEffort: 'max',
			reasoningMode: 'pro',
		} );
	} );

	it( 'keeps a model Studio no longer offers, so it can be reported', () => {
		const entries = [ contextEntry( { provider: 'openai-api-key', model: 'gpt-5.6-sol' } ) ];
		expect( resolveOpenAiSessionSelection( entries, defaults ).model ).toBe( 'gpt-5.6-sol' );
	} );
} );
