import fs from 'fs';
import path from 'path';

export interface Skill {
	name: string;
	description: string;
	body: string;
	// A top-level skill: something users ask for directly (`user-invokable: true`),
	// as opposed to a runbook other skills load. Plugins expose these as their own skills.
	userInvokable: boolean;
}

export function parseSkillContents( contents: string ): Skill | null {
	const match = contents.replace( /\r\n/g, '\n' ).match( /^---\n([\s\S]*?)\n---\n([\s\S]*)$/ );
	if ( ! match ) return null;
	const [ , frontmatter, body ] = match;

	const name = frontmatter.match( /^name:\s*(.+)$/m )?.[ 1 ]?.trim();
	const description = frontmatter.match( /^description:\s*(.+)$/m )?.[ 1 ]?.trim();
	if ( ! name || ! description ) return null;

	const userInvokable = /^user-invokable:\s*true\s*$/m.test( frontmatter );
	return { name, description, body: body.trim(), userInvokable };
}

// Bundled Markdown is trusted instruction text. Refuse linked directories, special files
// and hard links before reading from the open descriptor, even in an unpackaged checkout.
export function readBundledMarkdown( file: string ): string {
	const root = getSkillsRoot();
	const relative = path.relative( root, file );
	const refuse = () => new Error( 'Studio could not verify a bundled skill asset.' );
	if (
		relative.startsWith( '..' ) ||
		path.isAbsolute( relative ) ||
		path.relative( file, fs.realpathSync( file ) ) !== ''
	)
		throw refuse();
	const before = fs.lstatSync( file, { bigint: true } );
	const maxBytes = 1024 * 1024;
	if ( ! before.isFile() || before.nlink !== BigInt( 1 ) || before.size > BigInt( maxBytes ) )
		throw refuse();
	const fd = fs.openSync( file, 'r' );
	try {
		const opened = fs.fstatSync( fd, { bigint: true } );
		if (
			! opened.isFile() ||
			opened.nlink !== BigInt( 1 ) ||
			opened.dev !== before.dev ||
			opened.ino !== before.ino ||
			opened.size !== before.size ||
			path.relative( file, fs.realpathSync( file ) ) !== ''
		)
			throw refuse();
		const buffer = Buffer.alloc( Number( opened.size ) + 1 );
		const count = fs.readSync( fd, buffer, 0, buffer.length, 0 );
		if ( count !== Number( opened.size ) ) throw refuse();
		return buffer.toString( 'utf8', 0, count );
	} finally {
		fs.closeSync( fd );
	}
}

export interface SkillCapabilities {
	canAskUser: boolean;
	designPreviews: boolean;
	imageGeneration: boolean;
	browserTools: boolean;
}

// The canonical runbooks carry alternatives for hosts with different tool inventories.
function renderSkillCapabilities( body: string, capabilities?: SkillCapabilities ): string {
	// Resolve innermost sections first: making a look image requires both a
	// preview surface and an image-generation tool.
	const section = /\{\{#(\w+)\}\}((?:(?!\{\{#)[\s\S])*?)\{\{\/\1\}\}/g;
	while ( body.includes( '{{#' ) ) {
		const rendered = body.replace( section, ( _, key: keyof SkillCapabilities, text: string ) => {
			const [ enabled, disabled = '' ] = text.split( '{{else}}' );
			return ( capabilities ? capabilities[ key ] : true ) ? enabled : disabled;
		} );
		if ( rendered === body ) throw new Error( 'Malformed capability section in a bundled skill.' );
		body = rendered;
	}
	return body;
}

let cachedSkills: Skill[] | null = null;

// Resolves the skills directory. In source this is `packages/agent/node/skills`
// (next to this file); after bundling everything collapses into the CLI
// out dir and the `viteStaticCopy` step places skills at `<outDir>/skills`
// (e.g. `dist/cli/skills`), which is again next to this (bundled) file.
// Resolving relative to `import.meta.dirname` therefore works in both
// cases — callers that need a skill asset MUST go through this helper
// rather than hand-rolling their own relative path.
export function getSkillsRoot(): string {
	return path.resolve( import.meta.dirname, 'skills' );
}

// Returns the absolute path to a file/dir inside a specific skill, e.g.
// `getSkillPath( 'taxonomist', 'scripts' )`.
export function getSkillPath( skillName: string, ...segments: string[] ): string {
	return path.join( getSkillsRoot(), skillName, ...segments );
}

// Discovers `packages/agent/node/skills/<name>/SKILL.md` files at startup; cached
// for the process lifetime since skills never change at runtime.
function discoverSkills(): Skill[] {
	if ( cachedSkills ) return cachedSkills;

	const skillsRoot = getSkillsRoot();

	if ( ! fs.existsSync( skillsRoot ) ) {
		// Loud warning so a broken bundle path doesn't silently disable Skill.
		console.warn(
			`[skills] skills directory not found at ${ skillsRoot } — Skill tool will be unavailable.`
		);
		cachedSkills = [];
		return cachedSkills;
	}

	const skills: Skill[] = [];
	for ( const entry of fs.readdirSync( skillsRoot, { withFileTypes: true } ) ) {
		if ( ! entry.isDirectory() ) continue;
		const skillPath = path.join( skillsRoot, entry.name, 'SKILL.md' );
		if ( ! fs.existsSync( skillPath ) ) continue;
		const skill = parseSkillContents( readBundledMarkdown( skillPath ) );
		if ( skill?.name === entry.name ) skills.push( skill );
	}
	cachedSkills = skills;
	return skills;
}

export function loadSkills( capabilities?: SkillCapabilities ): Skill[] {
	return discoverSkills()
		.filter( ( skill ) => {
			if ( ! capabilities ) return true;
			if ( skill.name === 'imagery' ) return capabilities.imageGeneration;
			return (
				capabilities.browserTools ||
				! [ 'annotate', 'visual-polish', 'need-for-speed', 'rank-me-up' ].includes( skill.name )
			);
		} )
		.map( ( skill ) => ( {
			...skill,
			body: renderSkillCapabilities( skill.body, capabilities ),
		} ) );
}

export function findSkill( name: string, capabilities?: SkillCapabilities ): Skill | undefined {
	return loadSkills( capabilities ).find( ( skill ) => skill.name === name );
}
