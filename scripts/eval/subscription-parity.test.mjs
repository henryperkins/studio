// Checks subscription-parity.config.yaml without running a case: it parses,
// names only checks outcome.mjs exports, gives the runner only vars it reads
// (parsed by the runner's own parser) or a check reads, keeps destructive
// remote operations mocked outside the separated staging cases, and holds no
// identifier or credential.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { EVAL_RUNNER_VARS, parseEvalRunnerVars } from '../../apps/cli/ai/eval-input.ts';
import * as checks from './outcome.mjs';

const configText = readFileSync(
	path.join( import.meta.dirname, 'subscription-parity.config.yaml' ),
	'utf8'
);
const config = parse( configText );
const mainConfig = parse(
	readFileSync( path.join( import.meta.dirname, 'promptfoo.config.yaml' ), 'utf8' )
);
const outcomeSource = readFileSync( path.join( import.meta.dirname, 'outcome.mjs' ), 'utf8' );
// Every var a check reads, as `vars.<name>`.
const checkVars = new Set(
	[ ...outcomeSource.matchAll( /\bvars\.(\w+)/g ) ].map( ( [ , name ] ) => name )
);
const named = ( assertions = [] ) =>
	assertions.map( ( { value } ) => value.match( /^file:\/\/outcome\.mjs:(\w+)$/ )?.[ 1 ] );
const cases = config.tests.map( ( test ) => ( {
	...test,
	vars: { ...config.defaultTest.vars, ...test.vars },
	checks: [ ...named( config.defaultTest.assert ), ...named( test.assert ) ],
} ) );

describe( 'subscription parity config', () => {
	test( 'runs the same eval runner as the main suite, one case at a time', () => {
		expect( config.providers.map( ( provider ) => provider.id ) ).toEqual(
			mainConfig.providers.map( ( provider ) => provider.id )
		);
		expect( config.evaluateOptions.maxConcurrency ).toBe( 1 );
	} );

	test( 'needs an explicit provider and judges every case on the route it ran on', () => {
		expect( config.defaultTest.vars ).toMatchObject( { requireProvider: true, remote: 'mock' } );
		for ( const { vars, checks: names } of cases ) {
			expect( names, vars.caseId ).toContain( 'ranOnRequestedRoute' );
			// Under remote: mock, a write to WordPress.com fails the case.
			expect( names, vars.caseId ).toContain( 'noWordPressComWrites' );
			// The selection comes from the environment, never from a case.
			expect( vars, vars.caseId ).not.toHaveProperty( 'provider' );
			expect( vars, vars.caseId ).not.toHaveProperty( 'model' );
			expect( vars, vars.caseId ).not.toHaveProperty( 'effort' );
		}
	} );

	test( 'a case that says one step comes before another checks that order', () => {
		const pending = cases.find( ( { vars } ) => vars.caseId === 'parity-pending-work' );
		expect( pending.checks ).toContain( 'toolsInOrder' );
		expect( pending.vars.toolOrder ).toEqual( [
			{ name: 'generate_images' },
			{ name: 'take_screenshot' },
		] );
		expect( pending.description ).not.toMatch( /settles/ );
	} );

	test( 'a case judged on images a tool returns to the model says so, so a route not qualified for them blocks it', () => {
		const judgedOnToolImages = cases.filter(
			( { vars, checks: names } ) =>
				names.includes( 'sawDesktopAndMobile' ) ||
				vars.caseId === 'parity-screenshot-interpretation'
		);
		expect( judgedOnToolImages.map( ( { vars } ) => vars.caseId ).sort() ).toEqual( [
			'parity-screenshot-desktop-mobile',
			'parity-screenshot-interpretation',
		] );
		for ( const { vars } of judgedOnToolImages ) {
			expect( vars.needsToolImages, vars.caseId ).toBe( true );
		}
		expect(
			cases.filter( ( { vars } ) => vars.needsToolImages ).map( ( { vars } ) => vars.caseId )
		).toHaveLength( 2 );
	} );

	test( 'every case has a unique id, a description and checks outcome.mjs exports', () => {
		const ids = cases.map( ( { vars } ) => vars.caseId );
		expect( new Set( ids ).size ).toBe( ids.length );
		for ( const { description, vars, checks: names } of cases ) {
			expect( description, vars.caseId ).toMatch( /^(parity|staging)[: [ ]/ );
			expect( names.length, vars.caseId ).toBeGreaterThan( 1 );
			expect(
				names.filter( ( name ) => typeof checks[ name ] !== 'function' ),
				vars.caseId
			).toEqual( [] );
		}
	} );

	test( 'gives the runner only vars it reads, in the shapes it parses, or vars a check reads', () => {
		const runnerVars = new Set( EVAL_RUNNER_VARS );
		for ( const { vars } of cases ) {
			const unknown = Object.keys( vars ).filter(
				( name ) => name !== 'caseId' && ! runnerVars.has( name ) && ! checkVars.has( name )
			);
			expect( unknown, vars.caseId ).toEqual( [] );
			expect( () => parseEvalRunnerVars( vars ), vars.caseId ).not.toThrow();
		}
	} );

	// promptfoo expands a var that is an array of plain values into one test per element.
	test( 'list vars are lists of objects', () => {
		for ( const { vars } of cases ) {
			const scalarLists = Object.entries( vars ).filter(
				( [ , value ] ) =>
					Array.isArray( value ) && value.some( ( item ) => typeof item !== 'object' )
			);
			expect(
				scalarLists.map( ( [ name ] ) => name ),
				vars.caseId
			).toEqual( [] );
		}
	} );

	test( 'keeps remote operations mocked, except in the separated staging cases', () => {
		for ( const { description, vars, checks: names } of cases ) {
			const staging = description.startsWith( 'staging:' );
			expect( vars.remote, vars.caseId ).toBe( staging ? 'staging' : 'mock' );
			if ( staging ) {
				expect( vars.caseId ).toMatch( /^staging-/ );
			}
			if ( names.includes( 'remoteOperationRan' ) ) {
				expect( vars.operation, vars.caseId ).toMatch(
					/^(push|pull|preview-(create|update|delete))$/
				);
			}
		}
		// The staging cases come last, apart from the automatic ones.
		const firstStaging = cases.findIndex( ( { description } ) =>
			description.startsWith( 'staging:' )
		);
		expect( cases.slice( firstStaging ).every( ( { vars } ) => vars.remote === 'staging' ) ).toBe(
			true
		);
	} );

	test( 'marks the cases that need the image service, and covers it on and off', () => {
		const byService = ( value ) => cases.filter( ( { vars } ) => vars.imageService === value );
		for ( const { description } of byService( 'required' ) ) {
			expect( description ).toMatch( /\[image service\]/ );
		}
		expect( byService( 'required' ).length ).toBeGreaterThan( 0 );
		expect( byService( 'off' ).length ).toBeGreaterThan( 0 );
		for ( const { description, vars } of cases ) {
			if ( vars.seed?.history ) {
				expect( description, vars.caseId ).toMatch( /\[fixture-forced compaction\]/ );
			}
		}
	} );

	test( 'states the image service for every case that runs on the mocked remote', () => {
		const mocked = cases.filter( ( { vars } ) => vars.remote !== 'staging' );
		expect( mocked.length ).toBeGreaterThan( 0 );
		for ( const { description, vars } of mocked ) {
			expect( [ 'off', 'required', 'unused' ], description ).toContain( vars.imageService );
			if ( description.includes( '[image service]' ) ) {
				expect( vars.imageService, description ).toBe( 'required' );
			}
		}
	} );

	test( 'keeps the WordPress.com login in every mocked case that needs a signed-in state', () => {
		const remoteChecks = [ 'pushNotRunAndAsks', 'noRemoteOperation', 'remoteOperationRan' ];
		for ( const { description, vars, checks: names } of cases ) {
			if ( vars.remote === 'staging' || vars.imageService !== 'off' ) {
				continue;
			}
			expect( vars.seed?.connectedWpcomSites, description ).toBeUndefined();
			expect( vars.operation, description ).toBeUndefined();
			expect(
				names.filter( ( name ) => remoteChecks.includes( name ) ),
				description
			).toEqual( [] );
		}
	} );

	test( 'covers the parity workflows', () => {
		const used = new Set( cases.flatMap( ( { checks: names } ) => names ) );
		for ( const name of [
			'identifiesAsStudio',
			'replyIncludes',
			'skillsLoadedFirst',
			'siteWorks',
			'asksCurrentOrNew',
			'themeFileIncludes',
			'questionnaireSkip',
			'designChosen',
			'sawDesktopAndMobile',
			'usedOnlyTools',
			'previewRefreshed',
			'designTokenReachedTheme',
			'artifactShown',
			'attachmentReachedModel',
			'pushNotRunAndAsks',
			'noRemoteOperation',
			'remoteOperationRan',
			'cancelledThenContinued',
			'resumedFromDisk',
			'compacted',
			'imageGenerated',
			'imageGenerationUnavailable',
			'inspectionIncludes',
			'inspectionMatches',
		] ) {
			expect( used, name ).toContain( name );
		}
	} );

	test( 'holds no identifier, address or credential', () => {
		expect( configText ).not.toMatch(
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
		);
		expect( configText ).not.toMatch( /[\w.+-]+@[\w-]+\.[\w.]+/ );
		expect( configText ).not.toMatch( /\bsk-[\w-]{8,}|eyJ[\w-]+\.|Bearer\s/ );
		expect( configText ).not.toMatch( /STUDIO_EVAL_CONNECTION=\S*[0-9a-f]{8}/i );
	} );
} );
