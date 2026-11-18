import { resolveSkillFromPrompt } from '@studio/agent/protocol/slash-commands';
import { AGENT_IDENTITY, buildUserInstructionsSection } from '../system-prompt';
import { studioMcpToolName } from './execution-rules';
import type { ClaudeStudioTarget } from '@studio/agent/protocol/claude-code';

export function claudeSkillCommand( prompt: string, skills: readonly string[] ) {
	const name = resolveSkillFromPrompt( prompt );
	if ( ! name || ! skills.includes( name ) ) return prompt;
	const trimmed = prompt.trim();
	const args = trimmed.startsWith( '/' ) ? trimmed.slice( name.length + 1 ).trim() : '';
	return [
		`Load the Studio ${ name } skill with ${ studioMcpToolName(
			'Skill'
		) } and follow its instructions.`,
		args,
	]
		.filter( Boolean )
		.join( '\n\n' );
}

export function buildClaudeInstructions(
	tools: readonly string[],
	skills: readonly string[],
	target: ClaudeStudioTarget,
	userInstructions?: string
): string {
	const sections = [
		AGENT_IDENTITY,
		'Use Studio tools for WordPress operations. Use wp_cli for WP-CLI. Apply only validated block content to a site.',
	];
	sections.push(
		target.environment === 'global'
			? 'This is a global conversation. Select or create a site through Studio before changing a site.'
			: target.environment === 'local'
			? `Work on the selected local Studio site (ID ${ JSON.stringify(
					target.siteId
			  ) }). Publishing or syncing requires the corresponding Studio tool and its approval.`
			: `This conversation targets live WordPress.com site ${ target.wpcomSiteId }. Use wpcom_request for its content and respect Studio approvals.`
	);
	const has = ( name: string ) => tools.includes( name );
	if ( has( 'validate_blocks' ) )
		sections.push( 'Validate generated block content with validate_blocks before applying it.' );
	sections.push(
		'Studio tools in this turn: ' +
			tools.map( studioMcpToolName ).join( ', ' ) +
			'. Runbooks use the short Studio tool names.'
	);
	if ( skills.length && has( 'Skill' ) ) {
		const routes: Record< string, string > = {
			'build-site': 'Before building or redesigning a site, load build-site.',
			'edit-manage-site': 'For work on an existing local site, start with edit-manage-site.',
			'edit-manage-remote-site': 'Use edit-manage-remote-site for a live WordPress.com site.',
			'plugin-recommendations':
				'For forms, newsletters, shops, courses, polls, events, galleries, embeds and plugin choices, load plugin-recommendations before choosing an implementation and before the first write.',
			'visual-design': 'Load visual-design before writing design files, styles, layouts or markup.',
			'block-content':
				'Load block-content before writing or validating page, post or template markup.',
			'visual-polish': 'Load visual-polish when inspecting the rendered design.',
			imagery: 'Load imagery and generate the images before writing markup that references them.',
		};
		sections.push(
			'Use ' +
				studioMcpToolName( 'Skill' ) +
				' to load bundled Studio workflows. Available skills: ' +
				skills.join( ', ' ) +
				'.',
			...skills.map( ( skill ) => routes[ skill ] ).filter( Boolean )
		);
	}
	if ( has( 'AskUserQuestion' ) )
		sections.push(
			'Use the Studio AskUserQuestion tool for clarifications and wait for its answer.'
		);
	if ( has( 'present_design_options' ) && has( 'pick_design' ) )
		sections.push(
			'Use pick_design to find candidates, then present_design_options to show previews and wait for the user’s choice. Respect a request to redraw.'
		);
	else if ( has( 'pick_design' ) )
		sections.push(
			has( 'AskUserQuestion' )
				? 'Offer design recipes from pick_design as text choices through AskUserQuestion.'
				: 'Use pick_design with options set to 1.'
		);
	if ( ! has( 'generate_images' ) )
		sections.push(
			'There is no image generation service in this turn. Adapt the layout to available assets.'
		);
	return sections.join( '\n\n' ) + buildUserInstructionsSection( userInstructions );
}
