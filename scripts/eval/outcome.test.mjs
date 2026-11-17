import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import * as checks from './outcome.mjs';

// Each check reads the runner's result file named on stdout, as promptfoo
// hands it over. These results carry only the fields a check reads.
const dir = mkdtempSync( path.join( tmpdir(), 'studio-eval-outcome-test-' ) );
afterAll( () => rmSync( dir, { recursive: true, force: true } ) );
let count = 0;
function run( check, result, vars = {} ) {
	const file = path.join( dir, `result-${ count++ }.json` );
	writeFileSync( file, JSON.stringify( result ) );
	return check( `EVAL_RUNNER_RESULT_FILE=${ file }\n`, { vars } );
}

const outcome = ( site, extra = {} ) => ( {
	outcome: { sites: [ site ], otherSitesChanged: [], otherSitesRemoved: [], ...extra },
} );
const reply = ( ...textSegments ) => ( { textSegments } );

describe( 'design-system reply wording', () => {
	test.each( [
		'The [Design System](studio:design-system) now uses charcoal gray with light text.',
		'Your colors are now reflected in the [design system](studio:design-system).',
		'Ces changements figurent dans le [Design System](studio:design-system).',
	] )( 'accepts natural wording without prescribing a sentence: %s', ( text ) => {
		expect( run( checks.designSystemReplyLink, reply( text ) ).pass ).toBe( true );
	} );

	test.each( [
		'Done—the site now uses charcoal-gray backgrounds with light text.\n\n[View site](http://localhost:8884/) · [Design System](studio:design-system)',
		'The site now uses charcoal gray.\n\n[Design System](studio:design-system)',
		'The site now uses charcoal gray.',
	] )( 'rejects missing or detached links: %s', ( text ) => {
		expect( run( checks.designSystemReplyLink, reply( text ) ).pass ).toBe( false );
	} );
} );

function png( width, height ) {
	const buf = Buffer.alloc( 33 );
	buf.writeUInt32BE( 0x89504e47, 0 );
	buf.writeUInt32BE( width, 16 );
	buf.writeUInt32BE( height, 20 );
	return buf.toString( 'base64' );
}
const screenshots = ( sizes, durationMs ) => ( {
	toolResults: [
		{
			toolName: 'take_screenshot',
			isError: false,
			images: sizes.map( ( [ w, h ] ) => ( { data: png( w, h ) } ) ),
		},
	],
	toolEvents: [ { toolName: 'take_screenshot', durationMs } ],
} );

const workingSite = {
	name: 'Eval',
	url: 'http://localhost:8881',
	home: { status: 200, phpErrors: [], navHrefs: [], ids: [] },
	invalidBlocks: [],
};

// Every case in the config names a check this module exports.
test( 'the config only names existing checks', () => {
	const config = readFileSync( new URL( './promptfoo.config.yaml', import.meta.url ), 'utf8' );
	const named = [ ...config.matchAll( /file:\/\/outcome\.mjs:(\w+)/g ) ].map( ( m ) => m[ 1 ] );
	expect( named.length ).toBeGreaterThan( 0 );
	expect( named.filter( ( name ) => typeof checks[ name ] !== 'function' ) ).toEqual( [] );
} );

test( 'a missing result file fails instead of throwing', () => {
	expect( checks.siteWorks( 'no marker here', { vars: {} } ).pass ).toBe( false );
} );

// A provider-qualified case's reasons hold no account, address, site id or
// path, whatever the run produced: every check of every parity case, run on a
// result whose every free-text field carries them.
describe( 'reasons of a provider-qualified case', () => {
	const NAME = 'Jordan Q. Example';
	const EMAIL = 'jordan.example@example.org';
	const SITE_URL = 'https://jordans-site.wordpress.com';
	const SITE_ID = '987654';
	const HOME = 'C:\\Users\\jordan\\Studio\\parity';
	const POSIX_HOME = '/Users/jordan/Studio/parity';
	const leak = `${ NAME } <${ EMAIL }> at ${ SITE_URL } (site ${ SITE_ID }) in ${ HOME } and ${ POSIX_HOME }`;
	const seeded = {
		providerRoute: {
			requested: {
				kind: 'chatgpt-oauth',
				backend: 'chatgpt-route',
				subscription: true,
				connectionRef: 'conn-0123456789ab',
				model: 'gpt-6-luna',
				wireModel: 'gpt-6-luna',
				effort: 'medium',
			},
			executed: {
				kind: 'chatgpt-oauth',
				backend: 'chatgpt-route',
				connectionRef: 'conn-0123456789ab',
				modelRequests: 2,
				apiKeyBearers: 0,
				imageServiceRequests: 1,
				models: [ 'gpt-6-luna' ],
				efforts: [ 'medium' ],
				replyKinds: [ 'chatgpt-oauth' ],
				replyModels: [ 'gpt-6-luna' ],
				connectionMatchesBearer: true,
				requests: [ { imageInputs: 1, turn: 0 } ],
			},
		},
		success: false,
		error: leak,
		errorMessage: leak,
		stopReason: 'error',
		textSegments: [ leak, `${ leak }?` ],
		questions: [ { question: leak, options: [ leak, 'Second' ], answer: leak } ],
		toolCalls: [
			{ id: 'c0', name: 'site_push', input: { remoteSite: SITE_URL } },
			{ id: 'c1', name: 'Skill', input: { name: leak } },
			{ id: 'c2', name: 'send_feedback', input: { message: leak } },
		],
		toolResults: [
			{ toolUseId: 'c0', toolName: 'site_push', isError: false, text: leak },
			{
				toolUseId: 'c3',
				toolName: 'generate_images',
				isError: false,
				details: {
					studioService: {
						service: 'wordpress-com',
						credential: 'wordpress-com-login',
						account: { displayName: NAME, email: EMAIL },
					},
				},
			},
		],
		inspections: [ { args: [], exitCode: 0, stdout: leak } ],
		remoteCalls: [ { operation: 'push', site: NAME, target: SITE_URL, options: 'all' } ],
		remoteGuard: { code: null, blocked: [] },
		uiEvents: { artifacts: [ { id: leak, widgets: [ 'gallery' ] } ], previewReloads: 0 },
		imageService: { configured: true },
		turns: [
			{ reopened: false, toolCallsStart: 0, textSegmentsStart: 0, questionsStart: 0 },
			{ reopened: true, toolCallsStart: 1, textSegmentsStart: 1, questionsStart: 1 },
		],
		stoppedAt: { toolName: 'wp_cli', index: 0 },
		compactions: 0,
		outcome: {
			sites: [
				{
					name: NAME,
					url: SITE_URL,
					created: true,
					theme: { stylesheet: leak },
					themeFiles: { 'style.css': leak },
					home: { status: 500, error: leak, phpErrors: [ leak ], navHrefs: [ SITE_URL ], ids: [] },
					invalidBlocks: [ { type: 'page', slug: leak, blocks: [ leak ] } ],
					designMd: leak,
					palette: [],
					content: [],
				},
			],
			otherSitesChanged: [ NAME ],
			otherSitesRemoved: [ SITE_URL ],
			requestSiteChanged: true,
		},
	};
	const parity = parse(
		readFileSync( new URL( './subscription-parity.config.yaml', import.meta.url ), 'utf8' )
	);
	const named = ( assertions = [] ) =>
		assertions.map( ( { value } ) => value.match( /^file:\/\/outcome\.mjs:(\w+)$/ )[ 1 ] );
	const cases = parity.tests.map( ( test ) => ( {
		vars: { ...parity.defaultTest.vars, ...test.vars },
		names: [ ...named( parity.defaultTest.assert ), ...named( test.assert ) ],
	} ) );
	const leaked = ( reason ) =>
		[ NAME, EMAIL, 'jordans-site', SITE_ID, 'jordan', 'Users', 'example.org' ].filter( ( value ) =>
			reason.toLowerCase().includes( value.toLowerCase() )
		);

	test.each( cases.map( ( { vars, names } ) => [ vars.caseId, vars, names ] ) )(
		'%s: no reason names the account, an address, a site id or a path',
		( _caseId, vars, names ) => {
			for ( const name of names ) {
				for ( const variant of [
					seeded,
					{ ...seeded, success: true, outcome: { ...seeded.outcome, sites: [] } },
				] ) {
					const { reason } = run( checks[ name ], variant, vars );
					expect( leaked( reason ), `${ name }: ${ reason }` ).toEqual( [] );
				}
			}
		}
	);

	test( 'a run’s output is still quoted in the reasons of a case that selects no provider', () => {
		const { reason } = run(
			checks.replyIncludes,
			{ ...seeded, providerRoute: undefined },
			{ expectedText: 'X' }
		);
		expect( reason ).toContain( EMAIL );
		expect( reason ).not.toMatch( /[]/ );
	} );

	test( 'a reason left with an address-shaped value keeps only its leading code', () => {
		const verdict = run(
			checks.ranOnRequestedRoute,
			{ providerRoute: { requested: null, failure: { code: 'provider-unknown', message: leak } } },
			{ requireProvider: true }
		);
		expect( verdict.pass ).toBe( false );
		expect( verdict.reason ).toMatch( /^refused before any model request \(provider-unknown\)/ );
		expect( leaked( verdict.reason ) ).toEqual( [] );
		const missing = checks.siteWorks(
			`EVAL_RUNNER_RESULT_FILE=${ path.join( dir, 'no-such-result.json' ) }`,
			{ vars: { requireProvider: true } }
		);
		expect( missing.pass ).toBe( false );
		expect( missing.reason ).toMatch( /reason withheld: it held what looked like a local path/ );
	} );

	test( 'imageGenerated names only the service and the credential kind, never the account', () => {
		const verdict = run( checks.imageGenerated, { ...seeded, success: true } );
		expect( verdict.pass ).toBe( true );
		expect( verdict.reason ).toBe(
			'generate_images ran 1 time(s) on the wordpress-com image service, signed in with its wordpress-com-login'
		);
	} );
} );

describe( 'shared checks', () => {
	test( 'siteWorks', () => {
		expect( run( checks.siteWorks, outcome( workingSite ) ).pass ).toBe( true );
		expect(
			run(
				checks.siteWorks,
				outcome( { ...workingSite, home: { status: 200, phpErrors: [ 'Fatal error' ] } } )
			).pass
		).toBe( false );
		expect(
			run(
				checks.siteWorks,
				outcome( {
					...workingSite,
					invalidBlocks: [ { type: 'page', slug: 'home', blocks: [ 'core/group' ] } ],
				} )
			).pass
		).toBe( false );
		expect( run( checks.siteWorks, { outcome: { sites: [] } } ).pass ).toBe( false );
	} );

	test( 'otherSitesUntouched', () => {
		expect( run( checks.otherSitesUntouched, outcome( workingSite ) ).pass ).toBe( true );
		expect(
			run(
				checks.otherSitesUntouched,
				outcome( workingSite, { otherSitesChanged: [ 'Bystander' ] } )
			).pass
		).toBe( false );
		expect(
			run(
				checks.otherSitesUntouched,
				outcome( workingSite, { otherSitesRemoved: [ 'Bystander' ] } )
			).pass
		).toBe( false );
	} );

	test( 'noSiteCreated', () => {
		expect( run( checks.noSiteCreated, outcome( workingSite ) ).pass ).toBe( true );
		expect( run( checks.noSiteCreated, outcome( { ...workingSite, created: true } ) ).pass ).toBe(
			false
		);
		expect(
			run( checks.noSiteCreated, outcome( workingSite, { requestSiteChanged: true } ), {
				requestSiteUnchanged: true,
			} ).pass
		).toBe( false );
	} );

	test( 'turnsAreResponsive', () => {
		expect( run( checks.turnsAreResponsive, { turnDurationsMs: [ 1000, 59000 ] } ).pass ).toBe(
			true
		);
		expect( run( checks.turnsAreResponsive, { turnDurationsMs: [ 1000, 61000 ] } ).pass ).toBe(
			false
		);
		expect( run( checks.turnsAreResponsive, { turnDurationsMs: [] } ).pass ).toBe( false );
	} );

	test( 'withinBudget', () => {
		const turn = ( calls, totalTokens ) => ( {
			toolCalls: Array.from( { length: calls }, () => ( { name: 'Bash' } ) ),
			usage: { totalTokens },
		} );
		const vars = { maxToolCalls: 20, maxTokens: 500000 };
		expect( run( checks.withinBudget, turn( 20, 500000 ), vars ).pass ).toBe( true );
		expect( run( checks.withinBudget, turn( 78, 400000 ), vars ).reason ).toBe(
			'over budget: 78 tool calls (limit 20)'
		);
		expect( run( checks.withinBudget, turn( 10, 900000 ), vars ).pass ).toBe( false );
		expect( run( checks.withinBudget, turn( 78, 0 ), { maxTokens: 1000 } ).pass ).toBe( true );
		expect( run( checks.withinBudget, turn( 1, 0 ) ).pass ).toBe( false );
	} );
} );

describe( 'reply checks', () => {
	test( 'identifiesAsStudio', () => {
		expect( run( checks.identifiesAsStudio, reply( 'I am WordPress Studio Code.' ) ).pass ).toBe(
			true
		);
		expect( run( checks.identifiesAsStudio, reply( 'I am Claude.' ) ).pass ).toBe( false );
	} );

	test( 'replyIncludes', () => {
		const vars = { expectedText: 'ahoy' };
		expect( run( checks.replyIncludes, reply( 'ahoy there' ), vars ).pass ).toBe( true );
		expect( run( checks.replyIncludes, reply( 'hello' ), vars ).pass ).toBe( false );
	} );

	test( 'offersAudits', () => {
		const offer = '**Next steps**\n- A performance audit\n- An SEO audit';
		expect( run( checks.offersAudits, reply( 'Building…', offer ) ).pass ).toBe( true );
		expect( run( checks.offersAudits, reply( offer, 'All done.' ) ).pass ).toBe( false );
		expect( run( checks.offersAudits, reply( '**Next steps**\n- An SEO audit' ) ).pass ).toBe(
			false
		);
	} );

	test( 'sawDesktopAndMobile', () => {
		expect(
			run(
				checks.sawDesktopAndMobile,
				screenshots(
					[
						[ 1280, 800 ],
						[ 390, 844 ],
					],
					4000
				)
			).pass
		).toBe( true );
		expect( run( checks.sawDesktopAndMobile, screenshots( [ [ 1280, 800 ] ], 4000 ) ).pass ).toBe(
			false
		);
		expect(
			run(
				checks.sawDesktopAndMobile,
				screenshots(
					[
						[ 1280, 800 ],
						[ 390, 844 ],
					],
					20000
				)
			).pass
		).toBe( false );
	} );

	// A reply passes when it labels each site in its own part: a list item, or a
	// section with its heading and table (run 52).
	const sections =
		'## 1. Temporary PREVIEW site\n\n| Field | Value |\n|---|---|\n| **Type** | Preview (temporary) |\n| URL | `https://abc123-studio.wp.build` |\n\n' +
		'## 2. Connected WordPress.com site\n\n| Field | Value |\n|---|---|\n| URL | myprod.wordpress.com |';
	test.each( [
		[
			'- abc123-studio.wp.build is a temporary preview\n- myprod.wordpress.com is your connected WordPress.com site',
			true,
		],
		[ '- abc123-studio.wp.build and myprod.wordpress.com are previews', false ],
		[ sections, true ],
		[
			sections.replace( 'Temporary PREVIEW', 'Durable' ).replace( 'Preview (temporary)', 'Site' ),
			false,
		],
		[
			'| Site | Kind |\n|---|---|\n| abc123-studio.wp.build | WordPress.com site |\n| myprod.wordpress.com | temporary preview |',
			false,
		],
	] )( 'classifiesPreviewAndRemote %#', ( text, expected ) => {
		expect( run( checks.classifiesPreviewAndRemote, reply( text ) ).pass ).toBe( expected );
	} );

	test( 'feedbackNotSentAndAsks', () => {
		const vars = { draftMentions: [ { text: 'preview' }, { text: 'theme' } ] };
		const draft =
			'Here is what I would send: the site preview did not reload after switching themes.';
		expect(
			run(
				checks.feedbackNotSentAndAsks,
				{
					questions: [
						{ question: 'Send this feedback?', options: [ 'Send', 'Cancel' ], answer: 'Cancel' },
					],
					textSegments: [ draft, 'Okay, nothing was sent.' ],
				},
				vars
			).pass
		).toBe( true );
		expect(
			run( checks.feedbackNotSentAndAsks, reply( `${ draft } Shall I send it?` ), vars ).pass
		).toBe( true );
		// A call files a report even when the tool then errors.
		expect(
			run(
				checks.feedbackNotSentAndAsks,
				{
					toolEvents: [ { toolName: 'send_feedback', input: { type: 'bug', message: draft } } ],
					toolResults: [ { toolName: 'send_feedback', isError: true, text: 'Rate limited.' } ],
					questions: [ { question: 'Send this feedback?', answer: 'Cancel' } ],
					textSegments: [ draft ],
				},
				vars
			).pass
		).toBe( false );
		// A question with no draft shown.
		expect(
			run(
				checks.feedbackNotSentAndAsks,
				{
					questions: [ { question: 'Send feedback to the Studio team?', answer: 'Cancel' } ],
					textSegments: [ 'Okay.' ],
				},
				vars
			).reason
		).toMatch( /never mentions "preview", "theme"/ );
		expect( run( checks.feedbackNotSentAndAsks, reply( draft, 'Sent.' ), vars ).pass ).toBe(
			false
		);
		// A question about something else is not permission to send.
		expect(
			run(
				checks.feedbackNotSentAndAsks,
				{
					questions: [ { question: 'Which site is this about?', answer: 'Cancel' } ],
					textSegments: [ draft ],
				},
				vars
			).reason
		).toMatch( /did not ask whether to send/ );
	} );

	test( 'pushNotRunAndAsks', () => {
		expect(
			run( checks.pushNotRunAndAsks, {
				questions: [ { question: 'Push to My Production Site?', answer: 'Cancel' } ],
				textSegments: [ 'Okay, nothing was pushed.' ],
			} ).pass
		).toBe( true );
		expect( run( checks.pushNotRunAndAsks, reply( 'Which site should I push to?' ) ).pass ).toBe(
			true
		);
		expect(
			run( checks.pushNotRunAndAsks, {
				toolResults: [ { toolName: 'site_push', isError: false, text: 'Pushed.' } ],
				textSegments: [ 'Done. Anything else?' ],
			} ).pass
		).toBe( false );
		expect( run( checks.pushNotRunAndAsks, reply( 'Pushing now.' ) ).pass ).toBe( false );
		// Run 55: site_push asked itself, and the user closed the question.
		const question = 'Push the local site "Lakeside Studio" to My Production Site?';
		expect(
			run( checks.pushNotRunAndAsks, {
				toolResults: [
					{
						toolName: 'site_push',
						text: `Not run: The user closed without answering: ${ question }`,
					},
				],
				questions: [ { question, answer: '(dismissed)' } ],
				textSegments: [ 'Let me push it there.' ],
			} ).pass
		).toBe( true );
	} );

	test( 'asksCurrentOrNew', () => {
		const asks = reply( 'Should I use the current site, or create a new one?' );
		expect( run( checks.asksCurrentOrNew, { ...outcome( workingSite ), ...asks } ).pass ).toBe(
			true
		);
		expect(
			run( checks.asksCurrentOrNew, {
				...outcome( { ...workingSite, created: true } ),
				...asks,
			} ).pass
		).toBe( false );
		expect(
			run( checks.asksCurrentOrNew, { ...outcome( workingSite ), ...reply( 'Done.' ) } ).pass
		).toBe( false );
	} );
} );

describe( 'site checks', () => {
	const front = ( content, blocks ) => ( {
		type: 'page',
		isFront: true,
		title: 'Home',
		content,
		blocks,
	} );

	test( 'builtFromDesign', () => {
		const site = {
			...workingSite,
			showOnFront: 'page',
			content: [ front( '', { 'core/group': 1, 'core/heading': 1 } ) ],
			designMd: 'primary: "#112233"',
			palette: [ { color: '#112233' } ],
		};
		expect( run( checks.builtFromDesign, outcome( site ) ).pass ).toBe( true );
		expect(
			run( checks.builtFromDesign, outcome( { ...site, palette: [ { color: '#ffffff' } ] } ) ).pass
		).toBe( false );
		expect( run( checks.builtFromDesign, outcome( { ...site, showOnFront: 'posts' } ) ).pass ).toBe(
			false
		);
	} );

	describe( 'ownThemeWithFontsAndScreenshot', () => {
		const fonts = ( file ) =>
			JSON.stringify( {
				settings: {
					typography: { fontFamilies: [ { fontFace: [ { src: [ `file:./${ file }` ] } ] } ] },
				},
			} );
		const font = 'assets/fonts/inter.woff2';
		const site = {
			...workingSite,
			theme: { stylesheet: 'eval-theme' },
			themeFiles: { 'theme.json': fonts( font ) },
			themeFileList: [ font ],
			themeScreenshot: 'png:1200x900',
		};
		// A child theme of raft with no theme.json of its own, as run 48's was.
		const child = {
			...site,
			theme: { stylesheet: 'raft-child', template: 'raft' },
			themeFiles: {},
			themeFileList: [],
			parentThemeJson: fonts( font ),
			parentThemeFileList: [ font ],
		};
		test.each( [
			[ 'its own theme with its fonts', site, true ],
			[
				'its own theme with a twentytwenty name',
				{ ...site, theme: { stylesheet: 'twentytwenty-bakery' } },
				true,
			],
			[
				'a theme from WordPress.org',
				{ ...site, theme: { stylesheet: 'raft' }, themeChanges: [] },
				false,
			],
			[ 'a font file the theme does not have', { ...site, themeFileList: [] }, false ],
			[
				'a font outside fontFamilies',
				{ ...site, themeFiles: { 'theme.json': `{"src":["file:./${ font }"]}` } },
				false,
			],
			[ "a child theme with its parent's fonts", child, true ],
			// WordPress serves a child's file:./ source from the parent when the child lacks it.
			[
				'a child declaring fonts its parent ships',
				{ ...child, themeFiles: { 'theme.json': fonts( font ) } },
				true,
			],
			[ 'a child of a parent without fonts', { ...child, parentThemeJson: '{}' }, false ],
		] )( '%s', ( _name, value, expected ) => {
			expect( run( checks.ownThemeWithFontsAndScreenshot, outcome( value ) ).pass ).toBe(
				expected
			);
		} );
	} );

	test( 'navAnchorsWorkEverywhere', () => {
		const site = ( navHrefs ) => ( {
			...workingSite,
			home: { ...workingSite.home, navHrefs, ids: [ 'about', 'menu' ] },
		} );
		expect(
			run( checks.navAnchorsWorkEverywhere, outcome( site( [ '/#about', '/#menu' ] ) ) ).pass
		).toBe( true );
		expect(
			run( checks.navAnchorsWorkEverywhere, outcome( site( [ '#about', '#menu' ] ) ) ).pass
		).toBe( false );
		expect(
			run( checks.navAnchorsWorkEverywhere, outcome( site( [ '/#about', '/#gone' ] ) ) ).pass
		).toBe( false );
	} );

	test( 'pluginBlockOnFrontPage', () => {
		const vars = { plugin: 'jetpack', blockPrefix: 'jetpack/' };
		const site = ( plugins, blocks ) => ( {
			...workingSite,
			plugins,
			content: [ front( '', blocks ) ],
		} );
		expect(
			run(
				checks.pluginBlockOnFrontPage,
				outcome( site( [ 'jetpack' ], { 'jetpack/slideshow': 1 } ) ),
				vars
			).pass
		).toBe( true );
		expect(
			run(
				checks.pluginBlockOnFrontPage,
				outcome( site( [ 'jetpack' ], { 'core/gallery': 1 } ) ),
				vars
			).pass
		).toBe( false );
		expect(
			run( checks.pluginBlockOnFrontPage, outcome( site( [], { 'jetpack/slideshow': 1 } ) ), vars )
				.pass
		).toBe( false );
	} );

	test( 'storeHasProducts', () => {
		const site = { ...workingSite, plugins: [ 'woocommerce' ], products: 3 };
		expect( run( checks.storeHasProducts, outcome( site ) ).pass ).toBe( true );
		expect( run( checks.storeHasProducts, outcome( { ...site, products: 0 } ) ).pass ).toBe(
			false
		);
		expect( run( checks.storeHasProducts, outcome( { ...site, plugins: [] } ) ).pass ).toBe(
			false
		);
	} );

	describe( 'customizedThroughChildTheme', () => {
		const heading = ( fontFamily ) => ( { elements: { heading: { typography: { fontFamily } } } } );
		const child = {
			...workingSite,
			theme: { stylesheet: 'eval-child', template: 'twentytwentyfour' },
			parentThemeChanges: [],
			mergedStyles: heading( 'Lora' ),
		};
		// The theme as released, customized in Global Styles (run 42, ollie).
		const released = {
			...workingSite,
			theme: { stylesheet: 'twentytwentyfour', template: 'twentytwentyfour' },
			themeChanges: [],
			mergedStyles: heading( 'Inter' ),
		};
		const customized = { ...released, userGlobalStyles: { styles: heading( 'Fraunces' ) } };
		test.each( [
			[ 'a child theme', child, true ],
			[
				'a child theme that edited its parent',
				{ ...child, parentThemeChanges: [ 'style.css' ] },
				false,
			],
			[ 'the released theme customized in Global Styles', customized, true ],
			[ 'the released theme as it ships', released, false ],
			[
				'the released theme with its files edited',
				{ ...customized, themeChanges: [ 'theme.json' ] },
				false,
			],
			[
				'another theme',
				{ ...customized, theme: { stylesheet: 'other', template: 'other' } },
				false,
			],
		] )( '%s', ( _name, value, expected ) => {
			expect(
				run( checks.customizedThroughChildTheme, outcome( value ), {
					parentTheme: 'twentytwentyfour',
				} ).pass
			).toBe( expected );
		} );
	} );

	test( 'colorsFromPalette', () => {
		const site = ( content ) => ( {
			...workingSite,
			theme: { stylesheet: 'twentytwentyfive' },
			content: [ front( content, {} ) ],
		} );
		const vars = { theme: 'twentytwentyfive' };
		expect(
			run(
				checks.colorsFromPalette,
				outcome( site( '<!-- wp:group {"backgroundColor":"accent-1"} -->' ) ),
				vars
			).pass
		).toBe( true );
		expect(
			run(
				checks.colorsFromPalette,
				outcome( site( '<div style="background:#ff0000"></div>' ) ),
				vars
			).pass
		).toBe( false );
		expect(
			run( checks.colorsFromPalette, outcome( site( '<!-- wp:group -->' ) ), vars ).pass
		).toBe( false );
	} );

	test( 'noInlineDisplayOnBlockWrappers', () => {
		const site = ( css ) => ( {
			...workingSite,
			content: [ front( '<!-- wp:group {"className":"eyebrow"} -->', {} ) ],
			customCss: css,
		} );
		expect(
			run(
				checks.noInlineDisplayOnBlockWrappers,
				outcome( site( '.eyebrow p { display: inline-block; }' ) )
			).pass
		).toBe( true );
		expect(
			run(
				checks.noInlineDisplayOnBlockWrappers,
				outcome( site( '.eyebrow { display: inline-block; }' ) )
			).pass
		).toBe( false );
		// The first rule of a theme stylesheet and of theme.json's css counts too.
		expect(
			run(
				checks.noInlineDisplayOnBlockWrappers,
				outcome( {
					...site( '' ),
					themeFiles: { 'style.css': '.eyebrow{display:inline-flex}' },
				} )
			).pass
		).toBe( false );
		expect(
			run(
				checks.noInlineDisplayOnBlockWrappers,
				outcome( {
					...site( '' ),
					themeFiles: {
						'theme.json': '{"styles":{"css":".eyebrow {\\n display: inline-block;\\n}"}}',
					},
				} )
			).pass
		).toBe( false );
	} );

	test( 'repeatedTreatmentIsBlockStyle', () => {
		const site = ( content ) => ( {
			...workingSite,
			blockStyles: { 'core/group': [ 'card', 'section-1' ] },
			content: [ front( content, {} ) ],
		} );
		expect(
			run(
				checks.repeatedTreatmentIsBlockStyle,
				outcome( site( 'is-style-card is-style-card is-style-card' ) )
			).pass
		).toBe( true );
		expect(
			run(
				checks.repeatedTreatmentIsBlockStyle,
				outcome( site( 'is-style-section-1 is-style-section-1' ) )
			).pass
		).toBe( false );
		// As run 41's 01a1…3852fa479c named its style from a BEM class.
		expect(
			run(
				checks.repeatedTreatmentIsBlockStyle,
				outcome( {
					...site(
						'"className":"card__media is-style-card__media"} --><figure class="wp-block-image card__media is-style-card__media"> "className":"is-style-card__media"}'
					),
					blockStyles: { 'core/image': [ 'card__media' ] },
				} )
			).pass
		).toBe( true );
		expect(
			run(
				checks.repeatedTreatmentIsBlockStyle,
				outcome(
					site(
						'is-style-card is-style-card {"fontSize":"18px"} {"fontSize":"18px"} {"fontSize":"18px"}'
					)
				)
			).pass
		).toBe( false );
	} );

	test( 'designTokenReachedTheme', () => {
		const vars = { token: 'primary', originalValue: '#000000' };
		const site = ( designMd, palette ) => ( { ...workingSite, designMd, palette } );
		expect(
			run(
				checks.designTokenReachedTheme,
				outcome( site( 'primary: "#2255aa"', [ { color: '#2255AA' } ] ) ),
				vars
			).pass
		).toBe( true );
		expect(
			run(
				checks.designTokenReachedTheme,
				outcome( site( 'primary: "#2255aa"', [ { color: '#000000' } ] ) ),
				vars
			).pass
		).toBe( false );
		expect(
			run(
				checks.designTokenReachedTheme,
				outcome( site( 'primary: "#000000"', [ { color: '#000000' } ] ) ),
				vars
			).pass
		).toBe( false );
	} );
} );

describe( 'routing checks', () => {
	const skill = ( name ) => ( { name: 'Skill', input: { name } } );
	const vars = { skills: [ { name: 'block-content' }, { name: 'imagery' } ] };

	test( 'skillsLoadedFirst', () => {
		const calls = [ skill( 'block-content' ), { name: 'Write', input: {} }, skill( 'imagery' ) ];
		expect(
			run(
				checks.skillsLoadedFirst,
				{ toolCalls: calls, stoppedAt: { toolName: 'Write', index: 1 } },
				vars
			).pass
		).toBe( false );
		expect(
			run(
				checks.skillsLoadedFirst,
				{ toolCalls: [ skill( 'imagery' ), ...calls ], stoppedAt: { toolName: 'Write', index: 2 } },
				vars
			).pass
		).toBe( true );
		expect( run( checks.skillsLoadedFirst, { toolCalls: calls }, vars ).pass ).toBe( true );
	} );
} );

// promptfoo expands a var that is an array of plain values into one test per
// element, so a list a check reads must be a list of objects.
test( 'list vars in the config are lists of objects', () => {
	const config = parse(
		readFileSync( path.join( import.meta.dirname, 'promptfoo.config.yaml' ), 'utf8' )
	);
	const scalarLists = config.tests.flatMap( ( { vars = {} } ) =>
		Object.entries( vars )
			.filter(
				( [ , value ] ) =>
					Array.isArray( value ) && value.some( ( item ) => typeof item !== 'object' )
			)
			.map( ( [ name ] ) => `${ vars.caseId }.${ name }` )
	);
	expect( scalarLists ).toEqual( [] );
} );

describe( 'provider route checks', () => {
	const ref = 'conn-0123456789ab';
	const requested = {
		kind: 'chatgpt-oauth',
		backend: 'chatgpt-route',
		subscription: true,
		connectionRef: ref,
		model: 'gpt-6-luna',
		wireModel: 'gpt-6-luna',
		effort: 'low',
	};
	const executed = ( overrides = {} ) => ( {
		kind: 'chatgpt-oauth',
		backend: 'chatgpt-route',
		modelRequests: 3,
		apiKeyBearers: 0,
		imageServiceRequests: 0,
		models: [ 'gpt-6-luna' ],
		efforts: [ 'low' ],
		replyKinds: [ 'chatgpt-oauth' ],
		replyModels: [ 'gpt-6-luna' ],
		connectionRef: ref,
		connectionMatchesBearer: true,
		requests: [],
		...overrides,
	} );
	const routed = ( overrides = {}, route = {} ) => ( {
		providerRoute: { requested, executed: executed( overrides ), ...route },
	} );

	test( 'ranOnRequestedRoute passes only on the selected route, connection, model and effort', () => {
		const ok = run( checks.ranOnRequestedRoute, routed() );
		expect( ok.pass ).toBe( true );
		expect( ok.reason ).toMatch( /3 model request/ );
		// The separate image service is not inference and doesn't count against the route.
		expect( run( checks.ranOnRequestedRoute, routed( { imageServiceRequests: 2 } ) ).pass ).toBe(
			true
		);
	} );

	test.each( [
		[ 'a run on the default provider', { textSegments: [ 'Hi' ] }, /regression evidence only/ ],
		[
			'a refused run',
			{
				providerRoute: {
					requested: null,
					failure: { code: 'connection-signed-out', message: 'Not signed in.' },
				},
			},
			/connection-signed-out/,
		],
		[
			'no model request',
			routed( { modelRequests: 0, kind: 'none', backend: 'none' } ),
			/no model request/,
		],
		[
			'the API route',
			routed( {
				kind: 'openai-api-key',
				backend: 'openai-api',
				apiKeyBearers: 3,
				replyKinds: [ 'openai-api-key' ],
				connectionRef: 'openai-api-key',
			} ),
			/openai-api-key/,
		],
		[
			'a mix of routes',
			routed( { kind: 'mixed', backend: 'mixed', connectionRef: null } ),
			/mixed/,
		],
		[ 'another connection', routed( { connectionRef: 'conn-ffffffffffff' } ), /connection/ ],
		[
			'a bearer for another identity than the selected connection',
			routed( { connectionMatchesBearer: false } ),
			/^connection-mismatch:/,
		],
		[
			'a bearer whose identity could not be compared',
			routed( { connectionMatchesBearer: 'unverified' } ),
			/^connection-unverified:/,
		],
		[
			'a report without the comparison',
			routed( { connectionMatchesBearer: undefined } ),
			/^connection-unverified:/,
		],
		[ 'an API-key bearer', routed( { apiKeyBearers: 1 } ), /API-key/ ],
		[ 'another model', routed( { models: [ 'gpt-6-luna', 'gpt-6.1-sol' ] } ), /gpt-6\.1-sol/ ],
		[ 'another effort', routed( { efforts: [ 'low', 'medium' ] } ), /medium/ ],
		[
			'replies another runtime recorded',
			routed( { replyKinds: [ 'chatgpt-oauth', 'unknown' ] } ),
			/unknown/,
		],
	] )( 'ranOnRequestedRoute fails %s', ( _name, result, reason ) => {
		const verdict = run( checks.ranOnRequestedRoute, result );
		expect( verdict.pass ).toBe( false );
		expect( verdict.reason ).toMatch( reason );
	} );
} );

describe( 'WordPress.com writes under remote: mock', () => {
	const guarded = ( blocked = [] ) => ( {
		remoteGuard: { code: blocked.length ? 'wpcom-write-under-mock' : null, blocked },
	} );

	test( 'noWordPressComWrites passes when the guard refused nothing', () => {
		expect( run( checks.noWordPressComWrites, guarded(), { remote: 'mock' } ).pass ).toBe( true );
	} );

	test( 'noWordPressComWrites fails with its code on a refused write', () => {
		const verdict = run(
			checks.noWordPressComWrites,
			guarded( [ { method: 'POST', host: 'wpcom', endpoint: 'other', via: 'http' } ] ),
			{ remote: 'mock' }
		);
		expect( verdict.pass ).toBe( false );
		expect( verdict.reason ).toMatch( /^wpcom-write-under-mock:.*POST/ );
	} );

	test( 'noWordPressComWrites fails a mocked case that ran without the guard', () => {
		const verdict = run( checks.noWordPressComWrites, { textSegments: [] }, { remote: 'mock' } );
		expect( verdict.pass ).toBe( false );
		expect( verdict.reason ).toMatch( /^remote-guard-missing:/ );
	} );

	test( 'noWordPressComWrites judges a staging case on its guard’s record: no write outside the designated site', () => {
		const staging = { remote: 'staging' };
		const recorded = ( blocked, allowed ) => ( {
			remoteGuard: {
				code: blocked.length ? 'wpcom-write-outside-staging' : null,
				blocked,
				allowed,
			},
		} );
		const passed = run(
			checks.noWordPressComWrites,
			recorded( [], [ { method: 'POST', via: 'http' } ] ),
			staging
		);
		expect( passed.pass ).toBe( true );
		expect( passed.reason ).toMatch( /1 write\(s\) to the designated staging site/ );
		const refused = run(
			checks.noWordPressComWrites,
			recorded(
				[
					{
						code: 'wpcom-write-outside-staging',
						method: 'OTHER',
						host: 'wpcom',
						endpoint: 'other',
						via: 'remote-operation',
						operation: 'push',
					},
				],
				[]
			),
			staging
		);
		expect( refused.pass ).toBe( false );
		expect( refused.reason ).toMatch( /^wpcom-write-outside-staging:.*push/ );
		// Never passed without the record.
		const unguarded = run( checks.noWordPressComWrites, {}, staging );
		expect( unguarded.pass ).toBe( false );
		expect( unguarded.reason ).toMatch( /^remote-guard-missing:/ );
	} );
} );

describe( 'parity checks', () => {
	const site = ( extra = {} ) => outcome( { ...workingSite, ...extra } );
	const turns = ( ...starts ) =>
		starts.map( ( toolCallsStart, index ) => ( {
			reopened: false,
			toolCallsStart,
			textSegmentsStart: index,
			questionsStart: 0,
		} ) );

	test( 'themeFileIncludes', () => {
		const vars = { file: 'style.css', expectedText: 'PARITY-THEME-5521' };
		expect(
			run(
				checks.themeFileIncludes,
				site( { themeFiles: { 'style.css': '/* parity-marker: PARITY-THEME-5521 */' } } ),
				vars
			).pass
		).toBe( true );
		expect(
			run( checks.themeFileIncludes, site( { themeFiles: { 'style.css': 'body{}' } } ), vars ).pass
		).toBe( false );
		expect( run( checks.themeFileIncludes, site( { themeFiles: {} } ), vars ).pass ).toBe( false );
	} );

	test( 'inspectionIncludes', () => {
		const vars = { expectedText: 'Parity Preview 3318' };
		const inspected = ( stdout ) => ( { inspections: [ { args: [], exitCode: 0, stdout } ] } );
		expect(
			run( checks.inspectionIncludes, inspected( 'Parity Preview 3318\n' ), vars ).pass
		).toBe( true );
		expect( run( checks.inspectionIncludes, inspected( 'My WordPress' ), vars ).pass ).toBe(
			false
		);
		expect( run( checks.inspectionIncludes, { inspections: [] }, vars ).pass ).toBe( false );
	} );

	test( 'previewRefreshed and artifactShown', () => {
		const ui = ( artifacts, previewReloads ) => ( { uiEvents: { artifacts, previewReloads } } );
		expect( run( checks.previewRefreshed, ui( [], 1 ) ).pass ).toBe( true );
		expect( run( checks.previewRefreshed, ui( [], 0 ) ).pass ).toBe( false );
		expect( run( checks.previewRefreshed, {} ).pass ).toBe( false );
		const media = [ { id: 'a', widgets: [ 'media' ] } ];
		expect( run( checks.artifactShown, ui( media, 0 ), { widgetType: 'media' } ).pass ).toBe(
			true
		);
		expect(
			run( checks.artifactShown, ui( [ { id: 'b', widgets: [ 'site-preview' ] } ], 0 ), {
				widgetType: 'media',
			} ).pass
		).toBe( false );
		expect( run( checks.artifactShown, ui( [], 0 ) ).pass ).toBe( false );
	} );

	test( 'finalReplyIncludes', () => {
		const vars = { expectedTexts: [ { text: 'red' }, { text: 'PARITY-BRIEF-2207' } ] };
		expect(
			run(
				checks.finalReplyIncludes,
				reply( 'Reading it.', 'The image is Red; the code is PARITY-BRIEF-2207.' ),
				vars
			).pass
		).toBe( true );
		// Only the last reply counts: what the first turn said is not recalled.
		expect(
			run(
				checks.finalReplyIncludes,
				reply( 'Red, PARITY-BRIEF-2207.', 'I do not remember.' ),
				vars
			).pass
		).toBe( false );
	} );

	test( 'lastTurnUsedNoTools and usedOnlyTools', () => {
		const calls = ( ...names ) => names.map( ( name ) => ( { name, input: {} } ) );
		expect(
			run( checks.lastTurnUsedNoTools, { toolCalls: calls( 'Read' ), turns: turns( 0, 1 ) } ).pass
		).toBe( true );
		expect(
			run( checks.lastTurnUsedNoTools, {
				toolCalls: calls( 'Read', 'Read' ),
				turns: turns( 0, 1 ),
			} ).pass
		).toBe( false );
		const vars = { allowedTools: [ { name: 'take_screenshot' } ] };
		expect(
			run( checks.usedOnlyTools, { toolCalls: calls( 'take_screenshot' ) }, vars ).pass
		).toBe( true );
		expect(
			run( checks.usedOnlyTools, { toolCalls: calls( 'take_screenshot', 'wp_cli' ) }, vars ).pass
		).toBe( false );
		expect( run( checks.usedOnlyTools, { toolCalls: [] }, vars ).pass ).toBe( false );
	} );

	test( 'attachmentReachedModel', () => {
		const routed = ( requests ) => ( {
			attachments: [ { fixture: 'red-swatch.png', kind: 'image' } ],
			providerRoute: { requested: {}, executed: { requests } },
		} );
		expect(
			run( checks.attachmentReachedModel, routed( [ { imageInputs: 1, turn: 0 } ] ) ).pass
		).toBe( true );
		expect(
			run( checks.attachmentReachedModel, routed( [ { imageInputs: 0, turn: 0 } ] ) ).pass
		).toBe( false );
		// Replayed: a later turn's request still carries the image.
		const replayed = { replayed: true };
		expect(
			run(
				checks.attachmentReachedModel,
				routed( [
					{ imageInputs: 1, turn: 0 },
					{ imageInputs: 1, turn: 1 },
				] ),
				replayed
			).pass
		).toBe( true );
		expect(
			run(
				checks.attachmentReachedModel,
				routed( [
					{ imageInputs: 1, turn: 0 },
					{ imageInputs: 0, turn: 1 },
				] ),
				replayed
			).pass
		).toBe( false );
		expect( run( checks.attachmentReachedModel, { providerRoute: null } ).pass ).toBe( false );
	} );

	test( 'remoteOperationRan and noRemoteOperation', () => {
		const push = {
			operation: 'push',
			site: 'Eval Site Push',
			target: 'https://myprod.wordpress.com',
		};
		const mock = { remote: 'mock', operation: 'push', target: 'myprod.wordpress.com' };
		expect( run( checks.remoteOperationRan, { remoteCalls: [ push ] }, mock ).pass ).toBe( true );
		expect(
			run(
				checks.remoteOperationRan,
				{ remoteCalls: [ { ...push, target: 'https://other.wordpress.com' } ] },
				mock
			).pass
		).toBe( false );
		expect( run( checks.remoteOperationRan, { remoteCalls: [] }, mock ).pass ).toBe( false );
		// On a designated staging site the push really ran: recorded against the
		// designated site, and the tool's own result says it succeeded.
		const staging = { remote: 'staging', operation: 'push' };
		const toDesignated = { operation: 'push', site: 'A', target: '4242', designated: true };
		const staged = ( isError, text, remoteCalls = [ toDesignated ] ) => ( {
			toolResults: [ { toolName: 'site_push', isError, text } ],
			remoteCalls,
		} );
		const ran = run(
			checks.remoteOperationRan,
			staged( false, 'Pushed "A" to Staging (https://staging-4242.wpcomstaging.com).' ),
			staging
		);
		expect( ran.pass ).toBe( true );
		expect( ran.reason ).not.toMatch( /4242|https?:/ );
		expect(
			run( checks.remoteOperationRan, staged( true, 'Failed to push site' ), staging ).pass
		).toBe( false );
		// A push that succeeded somewhere the runner didn't record as the designated site fails.
		const elsewhere = run(
			checks.remoteOperationRan,
			staged( false, 'Pushed "A" to My Production Site (https://myprod.wordpress.com).', [
				{ ...toDesignated, target: 'https://myprod.wordpress.com', designated: false },
			] ),
			staging
		);
		expect( elsewhere.pass ).toBe( false );
		expect( elsewhere.reason ).toMatch( /^staging-target-not-designated/ );
		expect( elsewhere.reason ).not.toMatch( /myprod|https?:/ );
		expect(
			run( checks.remoteOperationRan, staged( false, 'Pushed "A".', [] ), staging ).pass
		).toBe( false );
		// A mocked case is never judged on a real tool result, and a case must declare its mode.
		expect( run( checks.remoteOperationRan, staged( false, 'Pushed "A".', [] ), mock ).pass ).toBe(
			false
		);
		const undeclared = run(
			checks.remoteOperationRan,
			{ remoteCalls: [ push ] },
			{
				operation: 'push',
			}
		);
		expect( undeclared.pass ).toBe( false );
		expect( undeclared.reason ).toMatch( /remote: mock or remote: staging/ );

		expect( run( checks.noRemoteOperation, { remoteCalls: [] }, { remote: 'mock' } ).pass ).toBe(
			true
		);
		expect(
			run( checks.noRemoteOperation, { remoteCalls: [ push ] }, { remote: 'mock' } ).pass
		).toBe( false );
		// Without the mock nothing says no remote operation ran.
		expect( run( checks.noRemoteOperation, { remoteCalls: [] }, {} ).pass ).toBe( false );
		expect( run( checks.noRemoteOperation, {}, { remote: 'mock' } ).pass ).toBe( false );
	} );

	test( 'toolsInOrder', () => {
		const order = { toolOrder: [ { name: 'generate_images' }, { name: 'take_screenshot' } ] };
		const ran = ( ...calls ) => ( {
			toolCalls: calls.map( ( [ name ], index ) => ( { id: `c${ index }`, name } ) ),
			toolResults: calls.map( ( [ name, isError ], index ) => ( {
				toolUseId: `c${ index }`,
				toolName: name,
				isError: Boolean( isError ),
			} ) ),
		} );
		expect(
			run(
				checks.toolsInOrder,
				ran( [ 'generate_images' ], [ 'Read' ], [ 'take_screenshot' ] ),
				order
			).pass
		).toBe( true );
		expect(
			run( checks.toolsInOrder, ran( [ 'take_screenshot' ], [ 'generate_images' ] ), order ).pass
		).toBe( false );
		expect(
			run( checks.toolsInOrder, ran( [ 'generate_images', true ], [ 'take_screenshot' ] ), order )
				.pass
		).toBe( false );
		expect( run( checks.toolsInOrder, ran( [ 'generate_images' ] ), order ).reason ).toMatch(
			/take_screenshot/
		);
	} );

	test( 'imageGenerated and imageGenerationUnavailable', () => {
		const generated = {
			imageService: { configured: true },
			toolResults: [
				{
					toolName: 'generate_images',
					isError: false,
					details: {
						studioService: { service: 'wordpress-com', credential: 'environment-token' },
					},
				},
			],
			providerRoute: { executed: { imageServiceRequests: 1 } },
		};
		expect( run( checks.imageGenerated, generated ).pass ).toBe( true );
		expect(
			run( checks.imageGenerated, { ...generated, imageService: { configured: false } } ).pass
		).toBe( false );
		expect(
			run( checks.imageGenerated, {
				...generated,
				toolResults: [ { toolName: 'generate_images', isError: false, details: {} } ],
			} ).pass
		).toBe( false );
		expect(
			run( checks.imageGenerated, {
				...generated,
				providerRoute: { executed: { imageServiceRequests: 0 } },
			} ).pass
		).toBe( false );

		const unavailable = ( text, extra = {} ) => ( {
			imageService: { configured: false },
			toolEvents: [],
			textSegments: [ text ],
			...extra,
		} );
		expect(
			run(
				checks.imageGenerationUnavailable,
				unavailable(
					'I can’t generate images here: image generation isn’t set up. Log in to WordPress.com to turn it on.'
				)
			).pass
		).toBe( true );
		expect(
			run( checks.imageGenerationUnavailable, unavailable( 'Here is your apple.' ) ).pass
		).toBe( false );
		expect(
			run(
				checks.imageGenerationUnavailable,
				unavailable( 'I can’t generate images.', {
					toolEvents: [ { toolName: 'generate_images' } ],
				} )
			).pass
		).toBe( false );
		expect(
			run(
				checks.imageGenerationUnavailable,
				unavailable( 'I can’t generate images.', { imageService: { configured: true } } )
			).pass
		).toBe( false );
	} );

	test( 'cancelledThenContinued', () => {
		const vars = {
			expectedText: 'STOPPED',
			inspectPattern: 'Parity [ABC]',
			maxInspectMatches: 1,
		};
		const base = {
			stoppedAt: { toolName: 'wp_cli', index: 0 },
			toolCalls: [ { name: 'wp_cli', input: {} } ],
			turns: turns( 0, 1 ),
			textSegments: [ 'Creating…', 'STOPPED' ],
			inspections: [ { stdout: '[{"post_title":"Parity A"}]' } ],
		};
		expect( run( checks.cancelledThenContinued, base, vars ).pass ).toBe( true );
		expect( run( checks.cancelledThenContinued, { ...base, stoppedAt: null }, vars ).pass ).toBe(
			false
		);
		// A tool call that started after the stop, still in the cancelled turn.
		expect(
			run(
				checks.cancelledThenContinued,
				{
					...base,
					toolCalls: [ ...base.toolCalls, { name: 'wp_cli', input: {} } ],
					turns: turns( 0, 2 ),
				},
				vars
			).pass
		).toBe( false );
		expect(
			run(
				checks.cancelledThenContinued,
				{
					...base,
					inspections: [ { stdout: '[{"post_title":"Parity A"},{"post_title":"Parity B"}]' } ],
				},
				vars
			).pass
		).toBe( false );
		expect(
			run(
				checks.cancelledThenContinued,
				{ ...base, textSegments: [ 'Creating…', 'Done.' ] },
				vars
			).pass
		).toBe( false );
	} );

	test( 'resumedFromDisk and compacted', () => {
		const reopened = [
			{ reopened: false, toolCallsStart: 0 },
			{ reopened: true, toolCallsStart: 0 },
		];
		expect( run( checks.resumedFromDisk, { turns: reopened, success: true } ).pass ).toBe( true );
		expect( run( checks.resumedFromDisk, { turns: turns( 0, 0 ), success: true } ).pass ).toBe(
			false
		);
		expect( run( checks.resumedFromDisk, { turns: reopened, success: false } ).pass ).toBe( false );
		expect( run( checks.compacted, { compactions: 1 } ).pass ).toBe( true );
		expect( run( checks.compacted, { compactions: 0 } ).pass ).toBe( false );
	} );

	test( 'designChosen', () => {
		const asked = ( answer, finalText ) => ( {
			questions: [
				{
					question: 'Which direction?',
					options: [ 'Warm rustic bakery', 'Cool minimal studio' ],
					answer,
				},
			],
			textSegments: [ finalText ],
		} );
		expect(
			run(
				checks.designChosen,
				asked( 'Warm rustic bakery', 'Going with the warm, rustic bakery direction.' )
			).pass
		).toBe( true );
		expect(
			run( checks.designChosen, asked( 'Warm rustic bakery', 'Going with the minimal look.' ) ).pass
		).toBe( false );
		expect( run( checks.designChosen, { questions: [], textSegments: [ 'Hi' ] } ).pass ).toBe(
			false
		);
	} );
} );

test( 'inspectionMatches', () => {
	const vars = { inspectPattern: 'UPLOADED_IMAGES=[1-9]' };
	const inspected = ( stdout ) => ( { inspections: [ { args: [], exitCode: 0, stdout } ] } );
	expect( run( checks.inspectionMatches, inspected( 'UPLOADED_IMAGES=2\n' ), vars ).pass ).toBe(
		true
	);
	expect( run( checks.inspectionMatches, inspected( 'UPLOADED_IMAGES=0\n' ), vars ).pass ).toBe(
		false
	);
	expect( run( checks.inspectionMatches, { inspections: [] }, vars ).pass ).toBe( false );
} );
