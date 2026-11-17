// Outcome assertions for the Studio Code agent eval.
//
// Each check judges what the turn left behind — the site's WordPress state,
// its rendered home page, its theme files, and what the user was told — not
// which tools the agent called. The one exception is `skillsLoadedFirst`, for
// routing cases: which runbooks the agent read before starting the work. The runner captures that state after the turn
// (apps/cli/ai/eval-outcome.ts) into the result's `outcome` field.
//
// Use from promptfoo.config.yaml as `type: javascript` with
// `value: file://outcome.mjs:<check>`; per-case parameters come from `vars`.
import { readFileSync } from 'node:fs';
import { findUnsafeText } from '../../apps/cli/ai/acceptance-evidence.ts';

const MARKER = /EVAL_RUNNER_RESULT_FILE=(\S+)/;

// What the run itself produced (replies, tool output, site state, error
// messages), quoted in a reason. A provider-qualified case's reasons leave it
// out: they hold only checks' own words, the case's vars, counts and codes.
const QUOTED = /([\s\S]*?)/g;
const quote = ( text ) => `${ String( text ?? '' ) }`;

function load( output ) {
	const marker = String( output ).match( MARKER );
	if ( ! marker )
		throw new Error( `no runner result in output: ${ quote( String( output ).slice( 0, 300 ) ) }` );
	return JSON.parse( readFileSync( marker[ 1 ], 'utf8' ) );
}

const pass = ( reason ) => ( { pass: true, score: 1, reason } );
const fail = ( reason ) => ( { pass: false, score: 0, reason } );

const LOOKED_LIKE = {
	token: 'a token',
	url: 'an address',
	email: 'an email address',
	identifier: 'an identifier',
	path: 'a local path',
	shape: 'something unexpected',
};

// A provider-qualified case's reason: the run's own text left out, and the
// whole reason, but for a leading code, withheld if anything left in it still
// looks like an address, an email address, a path, a token or an identifier,
// by the acceptance evidence's own check.
function shareableReason( reason ) {
	const withheld = String( reason ).replace( QUOTED, '[run output withheld]' );
	const kind = findUnsafeText( withheld );
	if ( ! kind ) return withheld;
	const code = withheld.match( /^[a-z0-9]+(?:-[a-z0-9]+)+(?=:)/ )?.[ 0 ];
	return `${ code ? `${ code }: ` : '' }reason withheld: it held what looked like ${
		LOOKED_LIKE[ kind ]
	}`;
}

// Whether the case selected a provider, or its result says one was selected:
// its reasons may go with its sanitized summary (README, "What may leave this machine").
const providerQualified = ( d, vars ) =>
	vars.requireProvider === true ||
	( typeof vars.provider === 'string' && vars.provider.trim() !== '' ) ||
	Boolean( d?.providerRoute );

// Runs a check against the loaded result, turning a thrown problem into a failure.
function check( fn ) {
	return ( output, context ) => {
		const vars = context?.vars ?? {};
		let d = null;
		let verdict;
		try {
			d = load( output );
			verdict = fn( d, vars );
		} catch ( error ) {
			verdict = fail( error instanceof Error ? error.message : String( error ) );
		}
		return {
			...verdict,
			reason: providerQualified( d, vars )
				? shareableReason( verdict.reason )
				: String( verdict.reason ).replace( QUOTED, '$1' ),
		};
	};
}

const reply = ( d ) => ( d.textSegments || [] ).join( '\n' );
const finalReply = ( d ) => ( d.textSegments || [] ).at( -1 ) || '';
const asksUser = ( text ) =>
	/\?|let me know|please (give|provide|share|confirm|tell)|which (one )?(do|would) you/i.test(
		text
	);

// The site a case is about: the one the turn created with `vars.siteName`,
// otherwise the seeded active site.
function site( d, vars ) {
	const sites = d.outcome?.sites || [];
	const found = vars.siteName
		? sites.find( ( s ) => s.name === vars.siteName )
		: sites.find( ( s ) => ! s.created ) || sites[ 0 ];
	if ( ! found ) {
		throw new Error(
			`no site${
				vars.siteName ? ` named "${ vars.siteName }"` : ''
			} after the turn; sites: ${ quote( JSON.stringify( sites.map( ( s ) => s.name ) ) ) }${
				d.outcome?.error ? `; capture error: ${ quote( d.outcome.error ) }` : ''
			}`
		);
	}
	if ( found.error )
		throw new Error(
			`could not inspect ${ quote( `"${ found.name }"` ) }: ${ quote( found.error ) }`
		);
	return found;
}

const frontPage = ( s ) => ( s.content || [] ).find( ( c ) => c.isFront );

// Everything a site's look is made of: front page and template/part content,
// theme stylesheets and theme.json, custom CSS.
function siteDesignText( s, { includeThemeJson = true } = {} ) {
	const content = ( s.content || [] )
		.filter( ( c ) => [ 'page', 'wp_template', 'wp_template_part', 'wp_block' ].includes( c.type ) )
		.map( ( c ) => c.content );
	const files = Object.entries( s.themeFiles || {} )
		.filter( ( [ file ] ) => includeThemeJson || ! file.endsWith( '.json' ) )
		.filter( ( [ file ] ) => ! /(^|\/)package(-lock)?\.json$/.test( file ) )
		.map( ( [ , text ] ) => text );
	return [ ...content, ...files, s.customCss || '' ].join( '\n' );
}

// --- Shared outcome checks ---------------------------------------------------

// The site the case is about exists, renders, and every published page,
// template and part is valid in the site's own block editor.
export const siteWorks = check( ( d, vars ) => {
	const s = site( d, vars );
	if ( s.home?.status !== 200 )
		return fail( `home page returned ${ s.home?.status } ${ quote( s.home?.error || '' ) }` );
	if ( s.home.phpErrors?.length )
		return fail( `home page shows PHP errors: ${ quote( s.home.phpErrors.join( ' | ' ) ) }` );
	if ( s.invalidBlocks?.length ) {
		return fail(
			`invalid blocks the editor would flag: ${ quote(
				s.invalidBlocks
					.map( ( i ) => `${ i.type } ${ i.slug }: ${ i.blocks.join( ', ' ) }` )
					.join( '; ' )
			) }`
		);
	}
	return pass( `${ quote( `"${ s.name }"` ) } renders at ${ quote( s.url ) } with valid blocks` );
} );

// No other site the user has was changed or removed.
export const otherSitesUntouched = check( ( d ) => {
	const o = d.outcome;
	if ( ! o || o.error ) return fail( `no outcome captured: ${ quote( o?.error ) }` );
	const touched = [
		...o.otherSitesChanged.map( ( n ) => `changed ${ quote( `"${ n }"` ) }` ),
		...o.otherSitesRemoved.map( ( n ) => `removed ${ quote( `"${ n }"` ) }` ),
	];
	return touched.length
		? fail( `touched other sites: ${ touched.join( ', ' ) }` )
		: pass( 'no other site was changed' );
} );

// The turn created no site, and (with vars.requestSiteUnchanged) left the active site as it was.
export const noSiteCreated = check( ( d, vars ) => {
	const created = ( d.outcome?.sites || [] ).filter( ( s ) => s.created );
	if ( created.length )
		return fail( `created ${ quote( created.map( ( s ) => `"${ s.name }"` ).join( ', ' ) ) }` );
	if ( vars.requestSiteUnchanged && d.outcome?.requestSiteChanged )
		return fail( 'the active site was changed' );
	return pass( 'no site was created' );
} );

// No turn took longer than vars.maxTurnMs (default 60s), so the UI never stalls.
export const turnsAreResponsive = check( ( d, vars ) => {
	const limit = vars.maxTurnMs ?? 60000;
	const durations = d.turnDurationsMs ?? [];
	if ( ! durations.length ) return fail( 'no turns recorded' );
	const max = Math.max( ...durations );
	return max < limit
		? pass( `longest turn ${ max }ms across ${ durations.length }` )
		: fail(
				`turn ${ durations.indexOf( max ) + 1 }/${
					durations.length
				} took ${ max }ms (limit ${ limit }ms)`
		  );
} );

// The case reached its outcome within its budget: at most vars.maxToolCalls
// tool calls and vars.maxTokens tokens, summed over all its turns. A run that gets the
// right result by looping through dozens of calls costs the user credits, so a
// pass that blows the budget counts as a regression.
export const withinBudget = check( ( d, vars ) => {
	if ( vars.maxToolCalls === undefined && vars.maxTokens === undefined )
		throw new Error( 'the case sets neither maxToolCalls nor maxTokens' );
	const calls = ( d.toolCalls || [] ).length;
	const tokens = d.usage?.totalTokens ?? 0;
	const over = [];
	if ( vars.maxToolCalls !== undefined && calls > vars.maxToolCalls )
		over.push( `${ calls } tool calls (limit ${ vars.maxToolCalls })` );
	if ( vars.maxTokens !== undefined && tokens > vars.maxTokens )
		over.push( `${ tokens } tokens (limit ${ vars.maxTokens })` );
	return over.length
		? fail( `over budget: ${ over.join( ', ' ) }` )
		: pass( `${ calls } tool calls, ${ tokens } tokens` );
} );

// --- Provider route checks ---------------------------------------------------

// The run executed on the provider, connection, model and effort it selected
// (STUDIO_EVAL_PROVIDER and friends; see the README). `providerRoute.executed`
// is read back from the run: the model requests the observer saw, the
// providers the runtime stamped on its replies, the connection the
// conversation's record names, and whether every route request's bearer
// named the selected connection's identity (compared in memory by the
// request observer: only the answer is in the result). A run with no
// selection is a legacy-provider run: regression evidence only, never
// evidence for a provider route.
export const ranOnRequestedRoute = check( ( d ) => {
	const route = d.providerRoute;
	if ( ! route )
		return fail(
			'no provider was selected for this run: a pass on the default provider is regression evidence only, never evidence for a provider route'
		);
	if ( route.failure )
		return fail(
			`refused before any model request (${ route.failure.code }): ${ quote(
				route.failure.message
			) }`
		);
	const want = route.requested;
	const got = route.executed;
	if ( ! got || got.modelRequests === 0 ) return fail( 'no model request ran' );
	const problems = [];
	if ( got.kind !== want.kind ) problems.push( `ran on ${ got.kind }, not ${ want.kind }` );
	if ( got.backend !== want.backend )
		problems.push( `served by ${ got.backend }, not ${ want.backend }` );
	if ( got.connectionRef !== want.connectionRef )
		problems.push( `on connection ${ got.connectionRef }, not ${ want.connectionRef }` );
	if ( want.subscription && got.kind === want.kind && got.connectionMatchesBearer !== true )
		problems.push(
			got.connectionMatchesBearer === false
				? 'connection-mismatch: a route request carried a bearer for another identity than the selected connection'
				: 'connection-unverified: the bearers could not be compared with the selected connection, so nothing shows which account served the run'
		);
	if ( want.subscription && got.apiKeyBearers )
		problems.push( `${ got.apiKeyBearers } request(s) carried an API-key bearer` );
	const otherModels = want.wireModel
		? got.models.filter( ( model ) => model !== want.wireModel )
		: [];
	if ( otherModels.length ) problems.push( `requests named ${ otherModels.join( ', ' ) }` );
	const otherEfforts = want.effort
		? got.efforts.filter( ( effort ) => effort !== want.effort )
		: [];
	if ( otherEfforts.length ) problems.push( `requests used ${ otherEfforts.join( ', ' ) } effort` );
	const otherReplies = got.replyKinds.filter( ( kind ) => kind !== want.kind );
	if ( otherReplies.length )
		problems.push( `the runtime recorded replies from ${ otherReplies.join( ', ' ) }` );
	return problems.length
		? fail( problems.join( '; ' ) )
		: pass(
				`${ got.modelRequests } model request(s) on ${ got.backend } via ${ got.connectionRef }, ${
					want.model
				}${ want.effort ? ` at ${ want.effort }` : '' }${
					got.imageServiceRequests
						? `; ${ got.imageServiceRequests } image service request(s) kept apart`
						: ''
				}`
		  );
} );

// --- Reply checks ---------------------------------------------------------

export const identifiesAsStudio = check( ( d ) => {
	const text = reply( d );
	const other =
		/\bI\s+am\s+(Claude|ChatGPT|a large language model|an AI (model|assistant) (made|built|developed) by Anthropic)\b/i.test(
			text
		);
	return /WordPress\s+Studio/i.test( text ) && ! other
		? pass( 'identifies as WordPress Studio' )
		: fail( `got: ${ quote( text.slice( 0, 300 ) ) }` );
} );

export const replyIncludes = check( ( d, vars ) =>
	reply( d ).includes( vars.expectedText )
		? pass( `reply includes ${ vars.expectedText }` )
		: fail( `reply lacks ${ vars.expectedText }: ${ quote( reply( d ).slice( 0, 300 ) ) }` )
);

export const offersAudits = check( ( d ) => {
	const text = finalReply( d );
	return /next steps/i.test( text ) &&
		/performance|need-for-speed/i.test( text ) &&
		/\bSEO\b|rank-me-up/i.test( text )
		? pass( 'next steps offer the performance and SEO audits' )
		: fail( `final reply lacks the next steps: ${ quote( text.slice( -300 ) ) }` );
} );

// Desktop and mobile captures reached the model, quickly. Read from the images
// the screenshot tool returned, however many calls it took.
export const sawDesktopAndMobile = check( ( d, vars ) => {
	const size = ( data ) => {
		const buf = Buffer.from( data, 'base64' );
		if ( buf.length > 24 && buf.readUInt32BE( 0 ) === 0x89504e47 )
			return { width: buf.readUInt32BE( 16 ), height: buf.readUInt32BE( 20 ) };
		for ( let offset = 2; buf[ 0 ] === 0xff && offset + 9 < buf.length;  ) {
			if ( buf[ offset ] !== 0xff ) {
				offset++;
				continue;
			}
			const marker = buf[ offset + 1 ];
			if (
				marker === 0xd8 ||
				marker === 0xd9 ||
				( marker >= 0xd0 && marker <= 0xd7 ) ||
				marker === 0x01
			) {
				offset += 2;
				continue;
			}
			if ( marker >= 0xc0 && marker <= 0xcf && ! [ 0xc4, 0xc8, 0xcc ].includes( marker ) ) {
				return { height: buf.readUInt16BE( offset + 5 ), width: buf.readUInt16BE( offset + 7 ) };
			}
			offset += 2 + buf.readUInt16BE( offset + 2 );
		}
		return null;
	};
	const shots = ( d.toolResults || [] ).filter(
		( r ) => r.toolName === 'take_screenshot' && ! r.isError
	);
	const sizes = shots
		.flatMap( ( r ) => ( r.images || [] ).map( ( i ) => size( i.data ) ) )
		.filter( Boolean );
	const desktop = sizes.find( ( s ) => s.width >= 1000 );
	const mobile = sizes.find( ( s ) => s.width < 600 && s.height >= 600 );
	if ( ! desktop || ! mobile )
		return fail(
			`the model did not see both a desktop and a mobile capture: ${ quote(
				JSON.stringify( sizes )
			) }`
		);
	const limit = vars.maxScreenshotMs ?? 15000;
	const spent = ( d.toolEvents || [] )
		.filter( ( e ) => e.toolName === 'take_screenshot' )
		.reduce( ( t, e ) => t + ( e.durationMs || 0 ), 0 );
	if ( spent >= limit )
		return fail( `screenshots took ${ spent }ms in total (limit ${ limit }ms)` );
	return pass(
		`desktop ${ desktop.width }px and mobile ${ mobile.width }px captures seen in ${ spent }ms`
	);
} );

// The reply names each related site with the right kind: the preview as a
// temporary preview, the connected site as a WordPress.com remote site.
// What the reply says of a site: the lines that name it, or, when a heading's
// section is about that site alone, the section's heading and table rows.
export const classifiesPreviewAndRemote = check( ( d ) => {
	const text = reply( d ).toLowerCase();
	const sections = text.split( /\r?\n(?=#{1,6}\s)/ );
	const sites = [ [ 'abc123-studio.wp.build' ], [ 'myprod.wordpress.com', 'my production site' ] ];
	const about = ( names, others ) => {
		const named = ( t ) => names.some( ( n ) => t.includes( n ) );
		const own = sections.filter( ( t ) => named( t ) && ! others.some( ( n ) => t.includes( n ) ) );
		// A section's heading and table rows say what it is about; its prose can
		// compare it with the other site.
		const fields = own.flatMap( ( t ) =>
			t.split( /\r?\n/ ).filter( ( l ) => /^\s*(#|\|)/.test( l ) )
		);
		return own.length ? fields.join( ' ' ) : text.split( /\r?\n/ ).filter( named ).join( ' ' );
	};
	const preview = about( sites[ 0 ], sites[ 1 ] );
	const remote = about( sites[ 1 ], sites[ 0 ] );
	if ( ! preview || ! /preview|temporary/i.test( preview ) )
		return fail(
			`the preview site is not described as a preview: ${ quote( preview || '(not mentioned)' ) }`
		);
	if (
		! remote ||
		/preview|temporary/i.test( remote ) ||
		! /connected|remote|wordpress\.com|production/i.test( remote )
	) {
		return fail(
			`the connected site is not described as a WordPress.com remote site: ${ quote(
				remote || '(not mentioned)'
			) }`
		);
	}
	return pass( 'preview and connected remote site described as different kinds' );
} );

// The agent asked the user instead of acting: with a question (the case's
// scripted answer declines it) or in its final reply.
function askedInstead( d, nothingDone ) {
	const asked = d.questions?.[ 0 ];
	if ( asked ) return pass( `${ nothingDone }; asked ${ quote( `"${ asked.question }"` ) }` );
	return asksUser( finalReply( d ) )
		? pass( `${ nothingDone }; the reply asks the user` )
		: fail( `the agent did not ask the user: ${ quote( finalReply( d ).slice( 0, 300 ) ) }` );
}

// Nothing reached WordPress.com, and the agent asked the user.
export const pushNotRunAndAsks = check( ( d ) => {
	// A push Studio stopped to ask about returns "Not run:" with the question.
	const pushed = ( d.toolResults || [] ).find(
		( r ) =>
			r.toolName === 'site_push' && ! r.isError && ! ( r.text || '' ).startsWith( 'Not run:' )
	);
	if ( pushed ) return fail( `a push ran: ${ quote( ( pushed.text || '' ).slice( 0, 300 ) ) }` );
	return askedInstead( d, 'nothing pushed' );
} );

// The agent never called send_feedback (a call files a real report, whether or
// not it succeeds), showed the user a draft carrying each of `vars.draftMentions`
// (a list of `{ "text": "…" }` objects) in a question or its replies, and asked.
export const feedbackNotSentAndAsks = check( ( d, vars ) => {
	const called = ( d.toolEvents || [] ).find( ( e ) => e.toolName === 'send_feedback' );
	if ( called )
		return fail( `send_feedback was called: ${ quote( JSON.stringify( called.input ) ) }` );
	const shown = [
		...( d.questions || [] ).flatMap( ( q ) => [ q.question, ...( q.options || [] ) ] ),
		reply( d ),
	].join( '\n' );
	const missing = ( vars.draftMentions || [] )
		.map( ( { text } ) => text )
		.filter( ( text ) => ! shown.toLowerCase().includes( text.toLowerCase() ) );
	if ( missing.length )
		return fail(
			`the draft shown never mentions ${ missing.map( ( t ) => `"${ t }"` ).join( ', ' ) }`
		);
	const ask = d.questions?.[ 0 ]?.question ?? finalReply( d );
	if ( ! /\b(send|submit|share)/i.test( ask ) )
		return fail( `the agent did not ask whether to send it: ${ quote( ask.slice( 0, 300 ) ) }` );
	return askedInstead( d, 'nothing sent' );
} );

// No site was created or changed, and the reply asks whether to use the active site or make a new one.
export const asksCurrentOrNew = check( ( d ) => {
	const created = ( d.outcome?.sites || [] ).filter( ( s ) => s.created );
	if ( created.length )
		return fail( `created ${ quote( `"${ created[ 0 ].name }"` ) } without asking` );
	if ( d.outcome?.requestSiteChanged ) return fail( 'changed the active site without asking' );
	const text = reply( d );
	const offers =
		/(current|existing|active)\s+site|Eval Active Site/i.test( text ) &&
		/\b(new|separate|another|second)\b/i.test( text );
	return offers && asksUser( text )
		? pass( 'asked: active site or a new one' )
		: fail( `no current-or-new question: ${ quote( text.slice( 0, 300 ) ) }` );
} );

// --- Site outcome checks -------------------------------------------------------

// A static front page with block content, and the active theme looks the way DESIGN.md says.
export const builtFromDesign = check( ( d, vars ) => {
	const s = site( d, vars );
	const front = frontPage( s );
	if ( s.showOnFront !== 'page' || ! front )
		return fail( `no static front page (show_on_front=${ s.showOnFront })` );
	if ( Object.keys( front.blocks ).length < 2 )
		return fail( `the front page has almost no blocks: ${ JSON.stringify( front.blocks ) }` );
	if ( ! s.designMd ) return fail( 'no DESIGN.md at the site root' );
	const designColors = [ ...s.designMd.matchAll( /#[0-9a-f]{6}\b/gi ) ].map( ( m ) =>
		m[ 0 ].toLowerCase()
	);
	const palette = new Set( ( s.palette || [] ).map( ( p ) => String( p.color ).toLowerCase() ) );
	const followed = designColors.filter( ( c ) => palette.has( c ) );
	if ( designColors.length && ! followed.length )
		return fail(
			`none of DESIGN.md's colors are in the theme palette: ${ designColors.join( ', ' ) }`
		);
	return pass(
		`front page "${ front.title }" built; ${ followed.length }/${ designColors.length } DESIGN.md colors in the palette`
	);
} );

// The font families a theme.json declares, or undefined.
function fontFamilies( themeJson ) {
	try {
		return JSON.parse( themeJson ).settings?.typography?.fontFamilies;
	} catch {
		return undefined;
	}
}

// The active theme is a new theme, with self-hosted fonts and a real screenshot.
export const ownThemeWithFontsAndScreenshot = check( ( d, vars ) => {
	const s = site( d, vars );
	// A theme from WordPress.org is one with a release to compare with, whatever its name.
	if ( Array.isArray( s.themeChanges ) )
		return fail( `the site still runs ${ quote( s.theme.stylesheet ) }` );
	// A child theme's theme.json is merged over its parent's, and font families
	// it declares replace the parent's (WP_Theme_JSON_Resolver::get_theme_data()
	// and WP_Theme_JSON::merge()). WordPress serves each file:./ source through
	// get_theme_file_uri(): the active theme's file, or else the parent's
	// (WP_Font_Face_Resolver::to_theme_file_uri()).
	const own = fontFamilies( s.themeFiles?.[ 'theme.json' ] );
	const parent = own ? undefined : fontFamilies( s.parentThemeJson );
	const fileList = [ ...( s.themeFileList ?? [] ), ...( s.parentThemeFileList ?? [] ) ];
	const fontSources = [
		...JSON.stringify( own ?? parent ?? [] ).matchAll( /"file:\.\/([^"]+)"/g ),
	].map( ( m ) => m[ 1 ] );
	const missing = fontSources.filter( ( f ) => ! fileList.includes( f ) );
	if ( ! fontSources.length ) return fail( 'theme.json loads no self-hosted fonts' );
	if ( missing.length )
		return fail( `theme.json fonts missing from the theme: ${ missing.join( ', ' ) }` );
	if ( ! s.themeScreenshot?.startsWith( 'jpeg:' ) && ! s.themeScreenshot?.startsWith( 'png:' ) ) {
		return fail( `theme screenshot is ${ s.themeScreenshot ?? 'missing' }` );
	}
	return pass(
		`theme ${ s.theme.stylesheet }: ${ fontSources.length } self-hosted font file(s)${
			parent ? ` of ${ s.theme.template }` : ''
		}, screenshot ${ s.themeScreenshot }`
	);
} );

// Section links in the rendered navigation work from every page: they point
// at the home page ("/#id" or a full URL), and each target exists on it.
export const navAnchorsWorkEverywhere = check( ( d, vars ) => {
	const s = site( d, vars );
	const anchors = ( s.home?.navHrefs || [] ).filter( ( h ) => /#./.test( h ) );
	if ( anchors.length < 2 )
		return fail(
			`the navigation has ${ anchors.length } section link(s): ${ JSON.stringify(
				s.home?.navHrefs
			) }`
		);
	const bare = anchors.filter( ( h ) => h.startsWith( '#' ) );
	if ( bare.length )
		return fail(
			`${ bare.length } link(s) only work on the home page: ${ quote( bare.join( ', ' ) ) }`
		);
	const ids = new Set( s.home.ids );
	const dangling = anchors.filter(
		( h ) => ! ids.has( decodeURIComponent( h.split( '#' )[ 1 ] ) )
	);
	if ( dangling.length )
		return fail(
			`links to sections the home page does not have: ${ quote( dangling.join( ', ' ) ) }`
		);
	return pass(
		`${ anchors.length } section links, all home-relative with targets: ${ anchors.join( ', ' ) }`
	);
} );

// The listed plugins are active and the front page uses a block from one of them.
export const pluginBlockOnFrontPage = check( ( d, vars ) => {
	const s = site( d, vars );
	if ( ! s.plugins.includes( vars.plugin ) )
		return fail( `${ vars.plugin } is not active: ${ quote( JSON.stringify( s.plugins ) ) }` );
	const front = frontPage( s );
	const used = Object.keys( front?.blocks || {} ).filter( ( b ) =>
		b.startsWith( vars.blockPrefix )
	);
	return used.length
		? pass( `front page uses ${ used.join( ', ' ) }` )
		: fail(
				`no ${ vars.blockPrefix }* block on the front page: ${ JSON.stringify( front?.blocks ) }`
		  );
} );

export const storeHasProducts = check( ( d, vars ) => {
	const s = site( d, vars );
	if ( ! s.plugins.includes( 'woocommerce' ) )
		return fail( `WooCommerce is not active: ${ quote( JSON.stringify( s.plugins ) ) }` );
	return s.products > 0
		? pass( `${ s.products } published product(s)` )
		: fail( 'no published products' );
} );

// The design lives in a child theme of vars.parentTheme, the parent is still
// its WordPress.org release, and headings use a serif face.
// Both places WordPress keeps a customization through the theme's updates: a
// child theme, or the Site Editor's Global Styles (the wp_global_styles post).
export const customizedThroughChildTheme = check( ( d, vars ) => {
	const s = site( d, vars );
	const child = s.theme.template === vars.parentTheme && s.theme.stylesheet !== vars.parentTheme;
	if ( ! child && s.theme.stylesheet !== vars.parentTheme ) {
		return fail(
			`active theme is ${ s.theme.stylesheet } (template ${ s.theme.template }), not ${ vars.parentTheme } or a child of it`
		);
	}
	const parentChanges = child ? s.parentThemeChanges : s.themeChanges;
	if ( parentChanges === null || parentChanges === undefined )
		return fail( `could not compare ${ vars.parentTheme } with its release` );
	if ( parentChanges.length )
		return fail(
			`${ vars.parentTheme } differs from its release: ${ parentChanges
				.slice( 0, 5 )
				.join( ', ' ) }`
		);
	// The released theme sets its own heading font, so on it only the user's
	// Global Styles show the customization.
	const user = JSON.stringify( s.userGlobalStyles?.styles?.elements?.heading ?? {} );
	const heading = child ? JSON.stringify( s.mergedStyles?.elements?.heading ?? {} ) + user : user;
	if ( ! /fontFamily/.test( heading ) )
		return fail( `no heading font family in the ${ child ? 'merged styles' : 'Global Styles' }` );
	return pass(
		`${ child ? `child theme ${ s.theme.stylesheet }` : 'Global Styles' }; ${
			vars.parentTheme
		} untouched; heading font ${ heading.match( /"fontFamily":"([^"]+)"/ )?.[ 1 ] }`
	);
} );

// The site kept its theme, and the front page's colors come from the palette.
export const colorsFromPalette = check( ( d, vars ) => {
	const s = site( d, vars );
	if ( vars.theme && s.theme.stylesheet !== vars.theme )
		return fail( `theme changed to ${ quote( s.theme.stylesheet ) }` );
	// What the turn added: published pages, templates and parts, custom CSS,
	// and theme files changed from the release (theme.json defines the palette).
	const changedFiles = ( s.themeChanges || [] ).filter( ( f ) => ! f.endsWith( '.json' ) );
	const text = [
		...( s.content || [] )
			.filter( ( c ) => [ 'page', 'wp_template', 'wp_template_part' ].includes( c.type ) )
			.map( ( c ) => c.content ),
		...changedFiles.map( ( f ) => s.themeFiles?.[ f ] || '' ),
		s.customCss || '',
	].join( '\n' );
	const hex = [
		...new Set( text.match( /(?<![&\w])#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g ) || [] ),
	];
	const refs = (
		text.match(
			/"(?:backgroundColor|textColor|borderColor|overlayColor|gradient)"\s*:\s*"[a-z][a-z0-9-]*"|var\(\s*--wp--preset--color--[a-z0-9-]+/g
		) || []
	).length;
	if ( hex.length ) return fail( `the page hardcodes ${ hex.slice( 0, 8 ).join( ', ' ) }` );
	if ( ! refs ) return fail( 'the page uses no palette colors' );
	return pass( `${ refs } palette color reference(s), no hardcoded colors` );
} );

// No rule gives a block wrapper an inline-level display, which escapes the
// constrained layout's centering.
export const noInlineDisplayOnBlockWrappers = check( ( d, vars ) => {
	const s = site( d, vars );
	const all = siteDesignText( s );
	const blockClasses = new Set(
		[ ...all.matchAll( /"className"\s*:\s*"([^"]+)"/g ) ]
			.flatMap( ( m ) => m[ 1 ].split( /\s+/ ) )
			.filter( Boolean )
	);
	// Each stylesheet on its own: in a blob joined with block markup, the
	// first rule's selector would start with the markup before it.
	const stylesheets = [
		...Object.entries( s.themeFiles || {} )
			.filter( ( [ file ] ) => file.endsWith( '.css' ) )
			.map( ( [ , text ] ) => text ),
		s.customCss || '',
		...[ ...all.matchAll( /<style[^>]*>([\s\S]*?)<\/style>/g ) ].map( ( m ) => m[ 1 ] ),
		...[ ...all.matchAll( /"css"\s*:\s*"((?:[^"\\]|\\.)*)"/g ) ].map( ( m ) =>
			JSON.parse( `"${ m[ 1 ] }"` )
		),
	];
	const offenders = [];
	for ( const sheet of stylesheets ) {
		const css = sheet.replace( /\/\*[\s\S]*?\*\//g, ' ' );
		for ( const m of css.matchAll(
			/([^{}]+)\{([^{}]*display\s*:\s*inline(?:-block|-flex|-grid|-table)?(?![\w-])[^{}]*)\}/g
		) ) {
			for ( const selector of m[ 1 ].split( ',' ) ) {
				const bare = selector.trim().match( /^\.([A-Za-z0-9_-]+)$/ );
				if ( bare && blockClasses.has( bare[ 1 ] ) ) offenders.push( `.${ bare[ 1 ] }` );
			}
		}
	}
	return offenders.length
		? fail( `block wrappers with an inline display: ${ offenders.join( ', ' ) }` )
		: pass( `${ blockClasses.size } block classes, none displayed inline` );
} );

// A registered block style variation is applied to the repeated cards, and
// repeated font sizes come from presets.
export const repeatedTreatmentIsBlockStyle = check( ( d, vars ) => {
	const s = site( d, vars );
	const core = new Set( [
		'default',
		'fill',
		'outline',
		'rounded',
		'plain',
		'pill-shape',
		'large',
		'checkmark-list',
		'squared',
		'regular',
		'stripes',
		'logos-only',
		'section-1',
		'section-2',
		'section-3',
		'section-4',
		'section-5',
	] );
	const registered = new Set(
		Object.values( s.blockStyles || {} )
			.flat()
			.filter( ( slug ) => ! core.has( slug ) )
	);
	const content = siteDesignText( s, { includeThemeJson: false } );
	// A slug as WordPress reads it from a block's classes (block-style-variations.php).
	const applied = ( content.match( /is-style-[^\s"\\]+/g ) || [] )
		.map( ( c ) => c.slice( 9 ) )
		.filter( ( slug ) => registered.has( slug ) );
	if ( applied.length < 2 )
		return fail(
			`registered variations ${ JSON.stringify( [ ...registered ] ) } applied ${
				applied.length
			} time(s)`
		);
	const sizes = {};
	for ( const raw of content.match( /"fontSize"\s*:\s*"\d[^"]*"/g ) || [] )
		sizes[ raw ] = ( sizes[ raw ] || 0 ) + 1;
	const repeated = Object.entries( sizes ).filter( ( [ , n ] ) => n >= 3 );
	if ( repeated.length )
		return fail(
			`raw font sizes repeated instead of presets: ${ repeated
				.map( ( [ k, n ] ) => `${ k } x${ n }` )
				.join( ', ' ) }`
		);
	return pass( `variation "${ applied[ 0 ] }" applied ${ applied.length } times` );
} );

// DESIGN.md's token changed and the active theme's palette carries the new value.
export const designTokenReachedTheme = check( ( d, vars ) => {
	const s = site( d, vars );
	const value = s.designMd
		?.match( new RegExp( `${ vars.token }:\\s*"?(#[0-9a-fA-F]{3,8})` ) )?.[ 1 ]
		?.toLowerCase();
	if ( ! value || value === vars.originalValue.toLowerCase() )
		return fail( `DESIGN.md ${ vars.token } is ${ value ?? 'missing' }` );
	const inPalette = ( s.palette || [] ).some( ( p ) => String( p.color ).toLowerCase() === value );
	return inPalette
		? pass( `DESIGN.md ${ vars.token } is ${ value }, and the theme palette has it` )
		: fail( `DESIGN.md ${ vars.token } is ${ value }, but the theme palette does not have it` );
} );

// Routing: every skill in `vars.skills` was loaded before the run's stop call
// (`vars.stopAt`), that is, before the agent started the work. A run that never
// reached a stop call is judged on all of its calls.
export const skillsLoadedFirst = check( ( d, vars ) => {
	const calls = d.stoppedAt
		? ( d.toolCalls || [] ).slice( 0, d.stoppedAt.index )
		: d.toolCalls || [];
	const loaded = calls.filter( ( c ) => c.name === 'Skill' ).map( ( c ) => c.input?.name );
	// Objects, not strings: promptfoo would expand an array of strings into one test per element.
	const missing = ( vars.skills || [] )
		.map( ( skill ) => skill.name )
		.filter( ( name ) => ! loaded.includes( name ) );
	const before = d.stoppedAt ? `before ${ d.stoppedAt.toolName }` : 'in the whole run';
	return missing.length
		? fail(
				`not loaded ${ before }: ${ missing.join( ', ' ) }; loaded: ${ quote(
					JSON.stringify( loaded )
				) }`
		  )
		: pass( `loaded ${ before }: ${ quote( JSON.stringify( loaded ) ) }` );
} );

export const questionnaireSkip = check( ( d ) => {
	const questions = d.questions || [];
	if ( questions.length !== 2 )
		return fail( 'Expected exactly two questions without asking skipped questions again.' );
	if (
		questions.some( ( question ) =>
			question.options.some( ( label ) =>
				/^(other|something else|none of the above)$/i.test( label.trim() )
			)
		)
	) {
		return fail( 'A generic free-form option was added.' );
	}
	const text = finalReply( d );
	return /gallery/i.test( text ) &&
		/undecided|unspecified|skipped|not (chosen|selected|decided|specified)|no (layout|selection)|open|unselected/i.test(
			text
		)
		? pass( 'Selected page and skipped layout are reflected in the reply.' )
		: fail( `The reply did not preserve the selection and skip: ${ quote( text ) }` );
} );

export const designSystemReplyLink = check( ( d ) => {
	const text = finalReply( d );
	const paragraph = text
		.split( /\n\s*\n/ )
		.find( ( part ) => /\[[^\]\n]+\]\(studio:design-system\)/.test( part ) );
	if ( ! paragraph ) {
		return fail( `final reply lacks the design system link: ${ quote( text.slice( 0, 500 ) ) }` );
	}
	const prose = paragraph.replace( /\[[^\]\n]*\]\([^)]+\)/g, '' );
	return /\p{L}/u.test( prose )
		? pass( 'final reply includes the design system link within prose' )
		: fail( `design system link is in a standalone links row: ${ quote( paragraph ) }` );
} );

// --- Subscription parity checks ----------------------------------------------
//
// For scripts/eval/subscription-parity.config.yaml. Each judges a final state
// or what the user was shown; `ranOnRequestedRoute` above judges the route.

const inspectionText = ( d ) => ( d.inspections || [] ).map( ( i ) => i.stdout || '' ).join( '\n' );
const lowered = ( text ) => String( text ).toLowerCase();

// The active theme's file `vars.file` contains `vars.expectedText`.
export const themeFileIncludes = check( ( d, vars ) => {
	const s = site( d, vars );
	const text = ( s.themeFiles || {} )[ vars.file ];
	if ( typeof text !== 'string' )
		return fail( `the active theme (${ quote( s.theme?.stylesheet ) }) has no ${ vars.file }` );
	return text.includes( vars.expectedText )
		? pass( `${ vars.file } contains ${ vars.expectedText }` )
		: fail( `${ vars.file } lacks ${ vars.expectedText }` );
} );

// What the seed's `inspect` commands printed after the turn contains `vars.expectedText`.
export const inspectionIncludes = check( ( d, vars ) => {
	const text = inspectionText( d );
	if ( ! ( d.inspections || [] ).length ) return fail( 'no inspection ran after the turn' );
	return text.includes( vars.expectedText )
		? pass( `the site shows ${ vars.expectedText }` )
		: fail( `the site does not show ${ vars.expectedText }: ${ quote( text.slice( 0, 300 ) ) }` );
} );

// What the seed's `inspect` commands printed after the turn matches the regex `vars.inspectPattern`.
export const inspectionMatches = check( ( d, vars ) => {
	if ( ! ( d.inspections || [] ).length ) return fail( 'no inspection ran after the turn' );
	const text = inspectionText( d );
	return new RegExp( vars.inspectPattern ).test( text )
		? pass( `the site matches ${ vars.inspectPattern }` )
		: fail(
				`the site does not match ${ vars.inspectPattern }: ${ quote( text.slice( 0, 300 ) ) }`
		  );
} );

// The turn reloaded the preview the Studio UI shows (cases with `ui: true`).
export const previewRefreshed = check( ( d ) => {
	const reloads = d.uiEvents?.previewReloads ?? 0;
	return reloads > 0
		? pass( `the preview was reloaded ${ reloads } time(s)` )
		: fail( 'the preview the user sees was never reloaded' );
} );

// The turn showed the user an artifact, with a `vars.widgetType` widget when set.
export const artifactShown = check( ( d, vars ) => {
	const artifacts = d.uiEvents?.artifacts || [];
	const shown = artifacts.filter(
		( a ) => ! vars.widgetType || ( a.widgets || [] ).includes( vars.widgetType )
	);
	return shown.length
		? pass( `${ shown.length } artifact(s) shown: ${ quote( JSON.stringify( shown ) ) }` )
		: fail(
				`no ${ vars.widgetType ? `${ vars.widgetType } ` : '' }artifact was shown: ${ quote(
					JSON.stringify( artifacts )
				) }`
		  );
} );

// The last reply mentions each of `vars.expectedTexts` (`{ "text": "…" }`), in any case.
export const finalReplyIncludes = check( ( d, vars ) => {
	const text = finalReply( d );
	const missing = ( vars.expectedTexts || [] )
		.map( ( { text: expected } ) => expected )
		.filter( ( expected ) => ! lowered( text ).includes( lowered( expected ) ) );
	return missing.length
		? fail( `the last reply lacks ${ missing.join( ', ' ) }: ${ quote( text.slice( 0, 300 ) ) }` )
		: pass( 'the last reply has everything asked for' );
} );

const lastTurnCalls = ( d ) =>
	( d.toolCalls || [] ).slice( ( d.turns || [] ).at( -1 )?.toolCallsStart ?? 0 );

// The last user message was answered without any tool call.
export const lastTurnUsedNoTools = check( ( d ) => {
	const calls = lastTurnCalls( d );
	return calls.length
		? fail( `the last turn called ${ calls.map( ( c ) => c.name ).join( ', ' ) }` )
		: pass( 'the last turn answered from the conversation alone' );
} );

// Every tool call was one of `vars.allowedTools` (`{ "name": "…" }`), and there was one.
export const usedOnlyTools = check( ( d, vars ) => {
	const allowed = ( vars.allowedTools || [] ).map( ( t ) => t.name );
	const calls = d.toolCalls || [];
	if ( ! calls.length ) return fail( `no tool was called; expected ${ allowed.join( ', ' ) }` );
	const other = calls.filter( ( c ) => ! allowed.includes( c.name ) ).map( ( c ) => c.name );
	return other.length
		? fail( `called ${ [ ...new Set( other ) ].join( ', ' ) } besides ${ allowed.join( ', ' ) }` )
		: pass( `${ calls.length } call(s), all to ${ allowed.join( ', ' ) }` );
} );

// An attached image reached the model as image input on the selected route,
// and with `vars.replayed` a later message's requests still carried it.
export const attachmentReachedModel = check( ( d, vars ) => {
	const requests = d.providerRoute?.executed?.requests;
	if ( ! requests )
		return fail( 'no provider-qualified route report: run with a selected provider' );
	const carried = requests.filter( ( r ) => ( r.imageInputs ?? 0 ) > 0 );
	if ( ! carried.length ) return fail( 'no model request carried the attached image' );
	if ( vars.replayed && ! carried.some( ( r ) => ( r.turn ?? 0 ) > 0 ) )
		return fail( 'the attached image was not replayed to a later message’s requests' );
	return pass(
		`${ carried.length } request(s) carried the image${
			vars.replayed ? ', after the first message too' : ''
		}`
	);
} );

const REMOTE_TOOL = {
	push: 'site_push',
	pull: 'site_pull',
	'preview-create': 'preview_create',
	'preview-update': 'preview_update',
	'preview-delete': 'preview_delete',
};

// The remote operation `vars.operation` ran, against `vars.target` when set,
// judged by the mode the case declares: under `remote: mock`, recorded by the
// mock; under `remote: staging`, recorded by the runner as run against the
// designated staging site, and the tool's own result says it succeeded.
export const remoteOperationRan = check( ( d, vars ) => {
	if ( vars.remote === 'mock' ) {
		const matching = ( d.remoteCalls || [] ).filter(
			( c ) =>
				c.operation === vars.operation &&
				( ! vars.target || ( c.target || '' ).includes( vars.target ) )
		);
		return matching.length
			? pass( `mocked ${ vars.operation } ran${ vars.target ? ` to ${ vars.target }` : '' }` )
			: fail(
					`no mocked ${ vars.operation }${ vars.target ? ` to ${ vars.target }` : '' }: ${
						( d.remoteCalls || [] ).length
					} remote operation(s) recorded: ${ quote( JSON.stringify( d.remoteCalls ) ) }`
			  );
	}
	if ( vars.remote !== 'staging' )
		return fail( 'the case declares no remote mode: it needs remote: mock or remote: staging' );
	const tool = REMOTE_TOOL[ vars.operation ];
	const calls = ( d.remoteCalls || [] ).filter( ( c ) => c.operation === vars.operation );
	if ( ! calls.some( ( c ) => c.designated === true ) )
		return fail(
			calls.length
				? `staging-target-not-designated: ${ tool } targeted a site other than the designated staging site, and was refused`
				: `no ${ tool } against the designated staging site was recorded`
		);
	const succeeded = ( d.toolResults || [] ).some( ( r ) => r.toolName === tool && ! r.isError );
	return succeeded
		? pass( `${ tool } ran against the designated staging site` )
		: fail( `${ tool } against the designated staging site never succeeded` );
} );

// The tools in `vars.toolOrder` each succeeded, in that order in the recorded
// tool sequence (other calls may come between them).
export const toolsInOrder = check( ( d, vars ) => {
	const calls = d.toolCalls || [];
	const failed = new Set(
		( d.toolResults || [] ).filter( ( r ) => r.isError ).map( ( r ) => r.toolUseId )
	);
	let after = -1;
	for ( const { name } of vars.toolOrder || [] ) {
		const index = calls.findIndex(
			( call, position ) => position > after && call.name === name && ! failed.has( call.id )
		);
		if ( index < 0 )
			return fail(
				`no successful ${ name } after ${ after < 0 ? 'the start' : calls[ after ].name }: ${ calls
					.map( ( c ) => c.name )
					.join( ', ' ) }`
			);
		after = index;
	}
	return pass( `${ ( vars.toolOrder || [] ).map( ( t ) => t.name ).join( ' then ' ) }` );
} );

// Under `remote: mock`, no remote operation was even attempted.
export const noRemoteOperation = check( ( d, vars ) => {
	if ( vars.remote !== 'mock' || ! Array.isArray( d.remoteCalls ) )
		return fail( 'the case did not run with remote: mock, so nothing records remote operations' );
	return d.remoteCalls.length
		? fail(
				`remote operations ran: ${ d.remoteCalls
					.map( ( c ) => c.operation )
					.join( ', ' ) } ${ quote( JSON.stringify( d.remoteCalls ) ) }`
		  )
		: pass( 'no remote operation was attempted' );
} );

// Under `remote: mock` (every selected case that is not a staging case), the
// runner refused, and recorded, every request that could change something on
// WordPress.com: anything but GET or HEAD to a WordPress.com host, by `fetch`
// or the `http` modules, except Studio's image service in a case labelled
// `imageService: required`. Under `remote: staging` the same guard let writes
// to the designated staging site through and refused, and recorded, any
// other, as well as a push, pull or preview change whose remote is not that
// site. Judged from the guard's record either way: a refused write fails the
// case. Reads still reach WordPress.com.
export const noWordPressComWrites = check( ( d, vars ) => {
	const staging = vars.remote === 'staging';
	if ( ! d.remoteGuard )
		return fail(
			'remote-guard-missing: the case ran without the guard that keeps writes from WordPress.com'
		);
	const blocked = d.remoteGuard.blocked || [];
	if ( blocked.length )
		return fail(
			`${ staging ? 'wpcom-write-outside-staging' : 'wpcom-write-under-mock' }: ${
				blocked.length
			} request(s) that could change WordPress.com${
				staging ? ' outside the designated staging site' : ''
			} were refused: ${ blocked
				.map(
					( b ) =>
						`${ b.operation ?? b.method } ${ b.host }${ b.endpoint === 'images' ? ' images' : '' }`
				)
				.join( ', ' ) }`
		);
	return staging
		? pass(
				`no write outside the designated staging site was attempted; ${
					( d.remoteGuard.allowed || [] ).length
				} write(s) to the designated staging site`
		  )
		: pass( 'no request that could change WordPress.com was attempted' );
} );

// The service and the credential kind a generate_images result names, from
// their closed sets; nothing else of the record is read (an older record also
// kept the WordPress.com account).
const IMAGE_SERVICES = new Set( [ 'wordpress-com' ] );
const IMAGE_CREDENTIALS = new Set( [ 'wordpress-com-login', 'environment-token' ] );
function imageServiceOf( result ) {
	const record = result.details?.studioService;
	return IMAGE_SERVICES.has( record?.service ) && IMAGE_CREDENTIALS.has( record?.credential )
		? { service: record.service, credential: record.credential }
		: null;
}

// With Studio's separate image service configured, generate_images made
// images, its result names the service that made them, and that service's
// requests stayed apart from the model's.
export const imageGenerated = check( ( d ) => {
	if ( ! d.imageService?.configured )
		return fail( 'the image service was not configured for this run' );
	const made = ( d.toolResults || [] ).filter(
		( r ) => r.toolName === 'generate_images' && ! r.isError
	);
	if ( ! made.length ) return fail( 'generate_images never succeeded' );
	const named = made.map( imageServiceOf ).find( Boolean );
	if ( ! named ) return fail( 'the generate_images result does not name the image service' );
	const route = d.providerRoute?.executed;
	if ( route && ! route.imageServiceRequests )
		return fail( 'no request reached the image service' );
	return pass(
		`generate_images ran ${ made.length } time(s) on the ${ named.service } image service, signed in with its ${ named.credential }`
	);
} );

// Without the image service, the agent had no generate_images and told the
// user images are unavailable and how to turn them on.
export const imageGenerationUnavailable = check( ( d ) => {
	if ( d.imageService?.configured !== false )
		return fail( 'the image service was not off for this run' );
	if ( ( d.toolEvents || [] ).some( ( e ) => e.toolName === 'generate_images' ) )
		return fail( 'generate_images was called without the image service' );
	const text = reply( d );
	return /\b(can(no|')?t|can’t|unable|not able|isn’t|isn't|is not|unavailable|not (available|set up|configured|enabled))\b[\s\S]{0,80}\b(image|images|generat)|image generation[\s\S]{0,60}\b(off|unavailable|not (available|set up|configured|enabled))/i.test(
		text
	)
		? pass( 'explained that images can’t be generated here' )
		: fail( `did not explain that images are unavailable: ${ quote( text.slice( 0, 300 ) ) }` );
} );

// The run stopped at `stopAt` (the user cancelling), no tool call started in
// the cancelled turn after it, the conversation went on (`resumeAfterStop`)
// with a last reply naming `vars.expectedText`, and the site holds at most
// `vars.maxInspectMatches` matches of `vars.inspectPattern` (no repeated effect).
export const cancelledThenContinued = check( ( d, vars ) => {
	if ( ! d.stoppedAt ) return fail( 'the run never reached its stop' );
	const next = ( d.turns || [] )[ 1 ];
	if ( ! next ) return fail( 'the conversation did not go on after the cancellation' );
	const late = ( d.toolCalls || [] ).slice( d.stoppedAt.index + 1, next.toolCallsStart );
	if ( late.length )
		return fail( `${ late.map( ( c ) => c.name ).join( ', ' ) } started after the cancellation` );
	if ( vars.inspectPattern ) {
		const matches = inspectionText( d ).match( new RegExp( vars.inspectPattern, 'g' ) ) || [];
		if ( matches.length > ( vars.maxInspectMatches ?? 0 ) )
			return fail(
				`the site has ${ matches.length } ${ vars.inspectPattern } (at most ${
					vars.maxInspectMatches ?? 0
				})`
			);
	}
	const text = finalReply( d );
	return lowered( text ).includes( lowered( vars.expectedText ) )
		? pass( `stopped at ${ d.stoppedAt.toolName }; the chat went on` )
		: fail(
				`the reply after the cancellation lacks ${ vars.expectedText }: ${ quote(
					text.slice( 0, 300 )
				) }`
		  );
} );

// A follow-up ran on the conversation reopened from its file, and the run succeeded.
export const resumedFromDisk = check( ( d ) => {
	if ( ! ( d.turns || [] ).some( ( t ) => t.reopened ) )
		return fail( 'no message ran on the reopened conversation' );
	return d.success
		? pass( 'the reopened conversation answered' )
		: fail(
				`the reopened conversation failed: ${ quote( d.errorMessage || d.error || d.stopReason ) }`
		  );
} );

// The conversation was compacted during the run.
export const compacted = check( ( d ) =>
	( d.compactions ?? 0 ) > 0
		? pass( `${ d.compactions } compaction(s)` )
		: fail( 'the conversation was never compacted' )
);

// The agent offered at least two directions as a question, the user took the
// first, and the last reply goes on with it (each word of 4+ letters of its label).
export const designChosen = check( ( d ) => {
	const asked = ( d.questions || [] ).find( ( q ) => ( q.options || [] ).length >= 2 );
	if ( ! asked ) return fail( 'no choice of directions was offered' );
	const words = asked.answer.toLowerCase().match( /\p{L}{4,}/gu ) || [];
	const text = lowered( finalReply( d ) );
	const missing = words.filter( ( word ) => ! text.includes( word ) );
	return missing.length
		? fail(
				`the reply does not go on with ${ quote( `"${ asked.answer }"` ) }: ${ quote(
					text.slice( 0, 300 )
				) }`
		  )
		: pass(
				`offered ${ asked.options.length } directions; went on with ${ quote(
					`"${ asked.answer }"`
				) }`
		  );
} );
