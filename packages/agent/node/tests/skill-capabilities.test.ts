import { expect, it } from 'vitest';
import { loadDesignCatalog } from '../design-catalog';
import { getSkillPath, loadSkills, readBundledMarkdown } from '../skills';
import { bindTool } from '../tools/define-tool';
import { createPickDesignTool } from '../tools/pick-design';
import { createSkillTool, renderSkill } from '../tools/skill';
import { createFakeHost } from './fake-host';

const detached = {
	canAskUser: false,
	designPreviews: false,
	imageGeneration: false,
	browserTools: false,
};

it( 'renders only capabilities available to the run in the index and nested skill guidance', () => {
	const tool = createSkillTool( detached )!;
	const skills = loadSkills( detached );
	const text = skills.map( ( skill ) => renderSkill( skill.name, detached ) ).join( '\n' );
	for ( const name of [ 'imagery', 'annotate', 'visual-polish', 'need-for-speed', 'rank-me-up' ] ) {
		expect( tool.description ).not.toContain( '- ' + name + ':' );
		expect( () => renderSkill( name, detached ) ).toThrow( 'Unknown skill' );
	}
	expect( text ).not.toMatch(
		/\b(AskUserQuestion|present_design_options|generate_images|take_screenshot|inspect_design|validate_blocks)\b|the .imagery. skill/
	);
	expect( renderSkill( 'build-site', detached ) ).toContain( 'options: 1' );
	expect( renderSkill( 'visual-design', detached ) ).not.toContain( '## Sneak peeks' );
	const attached = { ...detached, canAskUser: true, browserTools: true, designPreviews: true };
	expect( renderSkill( 'build-site', attached ) ).toContain( 'present_design_options' );
	expect( renderSkill( 'build-site', attached ) ).toContain( 'AskUserQuestion' );
	expect( renderSkill( 'build-site', attached ) ).not.toContain( 'generate_images' );
	expect( renderSkill( 'build-site', { ...attached, imageGeneration: true } ) ).toContain(
		'generate_images'
	);
	for ( const caps of [ attached, detached, undefined ] ) {
		expect(
			loadSkills( caps )
				.map( ( skill ) => skill.body )
				.join( '\n' )
		).not.toMatch( /{{(?:#|\/|else)/ );
	}
} );

it( 'keeps image-generation wait guidance for each available rendering tool', () => {
	const previews = '`present_design_options` waits for the images';
	const browser = '`take_screenshot` and `inspect_design` wait for the images';
	const defaults = renderSkill( 'imagery' );
	expect( defaults ).toContain( browser );
	expect( defaults ).toContain( previews );
	const browserOnly = renderSkill( 'imagery', {
		...detached,
		imageGeneration: true,
		browserTools: true,
	} );
	expect( browserOnly ).toContain( browser );
	expect( browserOnly ).not.toContain( 'present_design_options' );
	const headless = renderSkill( 'imagery', { ...detached, imageGeneration: true } );
	expect( headless ).not.toMatch( /take_screenshot|inspect_design|present_design_options/ );
} );

it( 'offers one entry without an asker and keeps redraw exclusions within the run', async () => {
	const host = createFakeHost();
	const entries = loadDesignCatalog( 'directions' ).slice( 0, 2 );
	const args = {
		catalog: 'directions' as const,
		options: 2,
		chosen: entries.map( ( entry ) => ( { name: entry.name, reason: 'Fits the brief' } ) ),
	};
	const create = ( canAskUser: boolean ) =>
		bindTool( createPickDesignTool( { canAskUser } ), host );
	const a = create( true );
	const result = await a.rawHandler( args );
	expect( result.content[ 0 ] ).toMatchObject( {
		type: 'text',
		text: expect.stringContaining( 'Option 2' ),
	} );
	await expect( a.rawHandler( args ) ).rejects.toThrow( 'Already shown' );
	await expect( create( true ).rawHandler( args ) ).resolves.toEqual( result );
	const single = await create( false ).rawHandler( args );
	expect( single.content[ 0 ] ).toMatchObject( {
		text: expect.stringContaining( 'one entry came back' ),
	} );
} );

it( 'reads the registered bundled Markdown and rejects paths outside it', () => {
	expect( readBundledMarkdown( getSkillPath( 'build-site', 'SKILL.md' ) ) ).toContain(
		'name: build-site'
	);
	expect( () => readBundledMarkdown( getSkillPath( '..', 'system-prompt.ts' ) ) ).toThrow(
		'verify a bundled'
	);
} );
