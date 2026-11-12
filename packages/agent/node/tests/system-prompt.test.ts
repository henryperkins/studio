import fs from 'fs';
import os from 'os';
import path from 'path';
import { getSiteEmailDirectory } from '@studio/common/sites/site-email';
import { describe, expect, it } from 'vitest';
import { loadSkills } from '@studio/agent/node/skills';
import { buildSystemPrompt } from '@studio/agent/node/system-prompt';
import { resolveStudioTools, type StudioToolsOptions } from '@studio/agent/node/tools';
import { createFakeHost } from './fake-host';
import type { StudioAgentHost } from '@studio/agent/node/host';

function extractReferencedSkillNames( prompt: string ): string[] {
	return [
		...new Set( Array.from( prompt.matchAll( /`([a-z0-9-]+)` skill/g ), ( match ) => match[ 1 ] ) ),
	].sort();
}

const toolsFor = ( options: StudioToolsOptions, host: StudioAgentHost = createFakeHost() ) =>
	resolveStudioTools( host, options ).map( ( tool ) => ( {
		name: tool.name,
		promptSnippet: tool.promptSnippet,
	} ) );

describe( 'buildSystemPrompt', () => {
	it( 'routes plugin-specific feature work to the plugin recommendations skill', () => {
		const prompt = buildSystemPrompt();

		expect( prompt ).toContain( 'plugin-recommendations' );
		expect( prompt ).toContain( 'any feature that core WordPress blocks do not cleanly provide' );
		expect( prompt ).not.toContain( '## Jetpack Forms' );
		expect( prompt ).not.toContain( 'wp_cli jetpack module activate contact-form' );
	} );

	it( 'routes block markup recipes to the block content skill', () => {
		const prompt = buildSystemPrompt();

		expect( prompt ).toContain( 'block-content' );
		expect( prompt ).toContain( 'page/post content, template or template-part content' );
		expect( prompt ).not.toContain( '## Block-theme layout cascade' );
		expect( prompt ).not.toContain( 'core/post-content' );
	} );

	it( 'routes site builds to the build-site skill in every runtime', () => {
		for ( const prompt of [ buildSystemPrompt( {} ), buildSystemPrompt( { external: true } ) ] ) {
			expect( prompt ).toContain( 'load the `build-site` skill first' );
		}
	} );

	it( 'carries the remote-site runbook only when a WordPress.com site is active', () => {
		const remote = buildSystemPrompt( {
			activeSite: {
				name: 'Live',
				path: '',
				running: false,
				remote: true,
				url: 'https://example.wordpress.com',
				wpcomSiteId: 123,
			},
		} );
		const local = buildSystemPrompt( {
			activeSite: { name: 'My Site', path: '/sites/my-site', running: true },
		} );
		const runbook = loadSkills().find( ( skill ) => skill.name === 'edit-manage-remote-site' );

		expect( remote ).toContain( runbook?.body );
		expect( remote.indexOf( '## Active site' ) ).toBeLessThan(
			remote.indexOf( '## Common wp/v2 Endpoints' )
		);
		expect( local ).not.toContain( '## Common wp/v2 Endpoints' );
		expect( buildSystemPrompt( {} ) ).not.toContain( '## Common wp/v2 Endpoints' );
	} );

	it( 'lists the remote-site skill with what it covers, for sites the user names', () => {
		const runbook = loadSkills().find( ( skill ) => skill.name === 'edit-manage-remote-site' );

		expect( runbook?.userInvokable ).toBe( true );
		expect( runbook?.description ).toContain( 'live remote sites' );
	} );

	it( 'leaves plan questions to the hosting-plans-helper skill index entry', () => {
		const helper = loadSkills().find( ( skill ) => skill.name === 'hosting-plans-helper' );

		expect( helper?.description ).toContain( 'Load before answering ANY plan' );
		expect( buildSystemPrompt() ).not.toContain( 'hosting-plans-helper' );
	} );

	it( 'references only bundled skills', () => {
		const availableSkillNames = new Set( loadSkills().map( ( skill ) => skill.name ) );
		const missingSkillNames = extractReferencedSkillNames( buildSystemPrompt() ).filter(
			( skillName ) => ! availableSkillNames.has( skillName )
		);

		expect( missingSkillNames ).toEqual( [] );
	} );

	it( 'lists the registered tools that have a snippet', () => {
		const prompt = buildSystemPrompt( {
			tools: [
				{ name: 'wp_cli', promptSnippet: 'Run WP-CLI commands on a running site' },
				{ name: 'hidden' },
			],
		} );
		expect( prompt ).toContain(
			'## Available tools\n\n- wp_cli: Run WP-CLI commands on a running site'
		);
		expect( prompt ).not.toContain( '- hidden' );
	} );

	it( "gives external agents their own intro instead of Studio Code's identity and cadence", () => {
		const prompt = buildSystemPrompt( { external: true } );
		expect( prompt ).toContain( 'Edit site files with your own file tools' );
		expect( prompt ).not.toContain( 'WordPress Studio Code' );
		expect( prompt ).not.toContain( '## Working cadence' );
	} );

	it( 'describes the screenshot and inspect tools for models without vision', () => {
		const withVision = buildSystemPrompt( { tools: toolsFor( { visionEnabled: true } ) } );
		expect( withVision ).toContain( 'Pair with take_screenshot' );
		expect( withVision ).not.toContain( 'You cannot view' );

		const textOnly = buildSystemPrompt( { tools: toolsFor( { visionEnabled: false } ) } );
		expect( textOnly ).toContain( 'it still sets the theme screenshot' );
		expect( textOnly ).not.toContain( 'Pair with take_screenshot' );
	} );

	describe( 'imagery guidance', () => {
		const IMAGERY_ROUTING =
			'and you can make images (generate_images, or an image tool of your own), load the `imagery` skill';

		it( 'routes imagery to the imagery skill when generate_images is registered', () => {
			const prompt = buildSystemPrompt( { tools: toolsFor( { imageGeneration: true } ) } );

			expect( prompt ).toContain( '- generate_images:' );
			expect( prompt ).toContain( IMAGERY_ROUTING );
			expect( prompt ).not.toContain( 'cannot make images' );
		} );

		it( 'on the ChatGPT route, gives no image-generation guidance without the image service, only how to do without images', () => {
			const prompt = buildSystemPrompt( {
				tools: toolsFor( { imageGeneration: false } ),
				chatGptRoute: true,
			} );

			expect( prompt ).not.toContain( 'generate_images' );
			expect( prompt ).not.toContain( '`imagery` skill' );
			expect( prompt ).toContain( 'You cannot make images in this conversation' );
			expect( prompt ).toContain( 'never source images from web URLs' );
			expect(
				buildSystemPrompt( { tools: toolsFor( { imageGeneration: true } ), chatGptRoute: true } )
			).toContain( IMAGERY_ROUTING );
		} );

		// Trunk's section before this branch (merge base 8672a64e7), byte for byte.
		const TRUNK_SKILL_ROUTING = `## Skill routing

When the request is to create, build, make, design, redesign, or rebuild a site, load the \`build-site\` skill first — it starts by picking or creating the site — and follow it to the end, even when the prompt already answers its questions. Any other work on an existing local site — answering questions about it, adding a page or section, adjusting styles, plugin work — loads the \`edit-manage-site\` skill first.

For any site creation, redesign, landing page, homepage, layout, style, CSS, typography, color, or motion work, load the \`visual-design\` skill before writing design files or block markup.

For any page/post content, template or template-part content, change to an existing theme's files, block markup, block-theme layout, full-width section, or \`core/html\` use, load the \`block-content\` skill before writing markup or validating block content. For long CSS or page-content files (>~200 lines), use its skeleton-first recipes instead of writing the full payload at once.

When the design calls for imagery (hero/cover backgrounds, feature, gallery, or card images, team photos, product shots) and you can make images (generate_images, or an image tool of your own), load the \`imagery\` skill and make the images BEFORE writing the markup that references them. Never source images from web URLs and never leave a broken image reference — if an image cannot be generated, adapt the layout instead.

For verifying and polishing a built or redesigned site — checking the rendered result against intent and diagnosing layout/width, spacing, button, background, or hover issues — load the \`visual-polish\` skill and use \`inspect_design\` to root-cause from the rendered DOM before fixing.

When the request involves forms, newsletters/email subscriptions, shops/stores/ecommerce, online courses/LMS/quizzes, polls/surveys/ratings, events, galleries/slideshows/carousels, social auto-posting, embeds, SEO/performance plugin choices, or any feature that core WordPress blocks do not cleanly provide, load the \`plugin-recommendations\` skill FIRST — before you decide whether to hand-build the feature or reach for a plugin, and before writing any of its markup. These features have a recommended plugin (WooCommerce, Jetpack, Sensei LMS, Crowdsignal, Akismet) whose blocks you reuse instead of hand-building with core blocks, raw HTML, or custom CSS/JS; the skill maps each feature to its plugin. Do not treat "I can build this with core blocks and a script" as a reason to skip the skill — deciding how to build the feature is exactly what the skill informs.`;

		it.each( [
			[ 'with a WordPress.com login (the image service)', { imageGeneration: true }, {} ],
			[ 'on an API key without a WordPress.com login', { imageGeneration: false }, {} ],
			[ 'for an MCP client', { imageGeneration: false }, { external: true } ],
		] as const )(
			'off the ChatGPT route, %s, is trunk’s prompt: its skill routing byte for byte, whatever image tool there is',
			( _context, toolOptions, promptOptions ) => {
				const tools = toolsFor( toolOptions );
				const prompt = buildSystemPrompt( { ...promptOptions, tools } );

				expect( prompt ).toContain( `\n\n${ TRUNK_SKILL_ROUTING }\n` );
				expect( prompt ).not.toContain( 'cannot make images' );
				// The image service changes nothing but the tool list, as on trunk.
				const withService = buildSystemPrompt( {
					...promptOptions,
					tools: toolsFor( { ...toolOptions, imageGeneration: true } ),
				} );
				const serviceLine = withService
					.split( '\n' )
					.find( ( line ) => line.startsWith( '- generate_images:' ) );
				expect( serviceLine ).toBeDefined();
				expect( withService.split( `${ serviceLine }\n` ).join( '' ) ).toBe(
					tools.some( ( tool ) => tool.name === 'generate_images' )
						? buildSystemPrompt( {
								...promptOptions,
								tools: tools.filter( ( tool ) => tool.name !== 'generate_images' ),
						  } )
						: prompt
				);
			}
		);
	} );

	it( 'lists refresh_browser only when a Studio UI is attached', () => {
		const ui = { showArtifact: () => {}, reloadPreview: () => {} };
		expect( buildSystemPrompt( { tools: toolsFor( {}, { ...createFakeHost(), ui } ) } ) ).toContain(
			'- refresh_browser:'
		);
		expect( buildSystemPrompt( { tools: toolsFor( {} ) } ) ).not.toContain( 'refresh_browser' );
	} );

	it( 'states the active site in its own section, above the user instructions', () => {
		const prompt = buildSystemPrompt( {
			userInstructions: 'Always answer in French.',
			activeSite: { name: 'My Site', path: '/sites/my-site', running: true },
		} );

		expect( prompt ).toContain( '## Active site\n\n"My Site" at /sites/my-site (running)' );
		expect( prompt.indexOf( '## Active site' ) ).toBeLessThan(
			prompt.indexOf( "## User's global instructions" )
		);
		expect( buildSystemPrompt( {} ) ).not.toContain( '## Active site' );
	} );

	it( 'states a WordPress.com active site with its ID and URL', () => {
		const prompt = buildSystemPrompt( {
			activeSite: {
				name: 'Live',
				path: '',
				running: false,
				remote: true,
				url: 'https://example.wordpress.com',
				wpcomSiteId: 123,
			},
		} );

		expect( prompt ).toContain(
			'## Active site\n\n"Live" (ID: 123) at https://example.wordpress.com (WordPress.com)'
		);
	} );

	it( "names the active site's design system when it has a DESIGN.md", () => {
		const sitePath = fs.mkdtempSync( path.join( os.tmpdir(), 'studio-active-site-' ) );
		try {
			fs.writeFileSync( path.join( sitePath, 'DESIGN.md' ), '# Design' );
			const prompt = buildSystemPrompt( {
				activeSite: { name: 'Designed', path: sitePath, running: false },
			} );
			expect( prompt ).toContain(
				`"Designed" at ${ sitePath } (stopped), design system: ${ path.join(
					sitePath,
					'DESIGN.md'
				) }`
			);
		} finally {
			fs.rmSync( sitePath, { recursive: true, force: true } );
		}
	} );

	it( "names the folder where Studio saves the active site's email", () => {
		const prompt = buildSystemPrompt( {
			activeSite: { id: 'site-1', name: 'Mailer', path: '/sites/mailer', running: true },
		} );

		expect( prompt ).toContain(
			`"Mailer" at /sites/mailer (running), email it sends: ${ getSiteEmailDirectory(
				'site-1'
			) } (one .eml file per message)`
		);
	} );

	it( 'appends the user global instructions when set', () => {
		const prompt = buildSystemPrompt( { userInstructions: 'Always answer in French.' } );
		expect( prompt ).toContain( "## User's global instructions" );
		expect( prompt ).toContain( 'Always answer in French.' );
		expect( buildSystemPrompt( {} ) ).not.toContain( "## User's global instructions" );
	} );

	it( 'truncates oversized global instructions with a visible notice', () => {
		const prompt = buildSystemPrompt( { userInstructions: 'a'.repeat( 20_000 ) } );

		expect( prompt ).toContain( 'was truncated here' );
		expect( prompt ).not.toContain( 'a'.repeat( 17_000 ) );
	} );
} );
