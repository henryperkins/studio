import { describe, expect, it } from 'vitest';
import { buildSkillInvocationPrompt } from '@studio/agent/protocol/slash-commands';
import { buildClaudeInstructions, claudeSkillCommand } from '../instructions';

describe( 'Studio guidance in the Claude Code preset', () => {
	it( 'routes bare and expanded Studio commands, preserving user arguments', () => {
		const skills = [ 'feedback' ];
		const bare = claudeSkillCommand( '/feedback', skills );
		expect( bare ).toContain( 'mcp__studio__Skill' );
		expect( bare ).toContain( 'feedback' );
		expect( claudeSkillCommand( buildSkillInvocationPrompt( 'feedback' ), skills ) ).toBe( bare );
		expect( claudeSkillCommand( '/feedback the preview is blank', skills ) ).toBe(
			bare + '\n\nthe preview is blank'
		);
		expect( claudeSkillCommand( '/rank-me-up', skills ) ).toBe( '/rank-me-up' );
		expect( claudeSkillCommand( 'Please help with /feedback', skills ) ).toBe(
			'Please help with /feedback'
		);
	} );

	it( 'supplies the selected WordPress.com site ID for a live conversation', () => {
		const text = buildClaudeInstructions( [ 'wpcom_request' ], [], {
			environment: 'live',
			siteId: 'local-site',
			wpcomSiteId: 412,
		} );
		expect( text ).toContain( 'live WordPress.com site 412' );
		expect( text ).toContain( 'mcp__studio__wpcom_request' );
	} );

	it( 'gives text-only and noninteractive turns the design workflow they can perform', () => {
		const global = { environment: 'global' } as const;
		const tools = [ 'Skill', 'pick_design' ];
		const skills = [ 'visual-design' ];
		const solo = buildClaudeInstructions( tools, skills, global );
		expect( solo ).toContain( 'options set to 1' );
		expect( solo ).not.toMatch(
			/AskUserQuestion|present_design_options|validate_blocks|load imagery/i
		);
		const asking = buildClaudeInstructions( [ ...tools, 'AskUserQuestion' ], skills, global );
		expect( asking ).toContain( 'text choices' );
		expect( asking ).not.toContain( 'present_design_options' );
		const visual = buildClaudeInstructions(
			[ ...tools, 'AskUserQuestion', 'present_design_options' ],
			skills,
			global
		);
		expect( visual ).toContain( 'Respect a request to redraw' );
	} );
} );
