import '@/lib/theme/tokens.css';
import '@/lib/theme/base.css';
import '@/index.css';
import {
	escapeClaudeApprovalText,
	getClaudeApprovalDisplayArgs,
} from '@studio/agent/protocol/claude-code';
import { useState } from 'react';
import { ClaudeApprovalCard } from '@/features/chats/session-view/claude-approval-card';
import { renderPlayground } from './playground';
import styles from './style.module.css';
import type {
	BackendApprovalOperation,
	BackendTurnEvent,
} from '@studio/agent/protocol/backend-events';

// The approval card of a Claude Code chat for each operation whose approval
// shows what it sends or changes, as the execution policy sends it: the
// arguments as escaped, indented JSON, the local paths and the remote. Every
// site, address and message is made up.
type Request = Extract< BackendTurnEvent, { type: 'approval.requested' } >;

const SITE = { id: 'harbor-bakery', name: 'Harbor Bakery', path: '/sites/harbor-bakery' };
const AFTER_RECOVERY =
	'The previous turn was interrupted, so an attempt it made may already have taken effect.';

const approval = (
	requestId: string,
	description: string,
	operation: Omit< BackendApprovalOperation, 'args' | 'target' | 'localPaths' > & {
		args: unknown;
		target?: BackendApprovalOperation[ 'target' ];
		localPaths?: string[];
	},
	draft?: Request[ 'draft' ]
): Request => ( {
	type: 'approval.requested',
	runId: 'run',
	turnId: 'turn',
	requestId,
	toolCallId: requestId,
	description: escapeClaudeApprovalText( description ),
	operation: {
		...operation,
		target: operation.target ?? { environment: 'local', siteId: SITE.id },
		args: escapeClaudeApprovalText(
			JSON.stringify( getClaudeApprovalDisplayArgs( operation.tool, operation.args ), null, 2 )
		),
		localPaths: ( operation.localPaths ?? [] ).map( escapeClaudeApprovalText ),
	},
	...( draft ? { draft } : {} ),
} );

const push = (
	requestId: string,
	remoteSite: { id: number; name: string; address: string; kind: 'production' | 'staging' }
) => {
	const destination = `a ${ remoteSite.kind } site, ${
		remoteSite.address
	}, named ${ JSON.stringify( remoteSite.name ) }`;
	return approval(
		requestId,
		`Change or delete work on WordPress.com: sync.push. It uploads this local site to the connected WordPress.com site ${ remoteSite.id } (${ destination }) with the options all, replacing the database and every file in wp-content on that site. If it is interrupted, the import of what it uploaded may still be running on WordPress.com`,
		{
			tool: 'sync.push',
			operationClass: 'remote-overwrite',
			args: [
				{
					direction: 'push',
					remoteSite,
					overwrites: [ 'the database and every file in wp-content' ],
				},
			],
			localPaths: [ SITE.path ],
			remote: `WordPress.com site ${ remoteSite.id }: ${ destination }`,
		}
	);
};

const siteDelete = ( requestId: string, deleteFiles: boolean ) =>
	approval( requestId, 'Change or delete local work: sites.delete', {
		tool: 'sites.delete',
		operationClass: 'local-overwrite',
		args: [ deleteFiles ],
		localPaths: [ SITE.path ],
	} );

const draft = {
	siteName: SITE.name,
	title: 'Saturday bake sale',
	content: 'The bread counter opens at nine.',
};

const FEEDBACK =
	'Send a message outside Studio: send_feedback. It sends the type and message shown, with a line naming this Studio version and operating system, to the WordPress Studio team at Automattic through WordPress.com, signed in as the WordPress.com account Studio is logged in to';

const images = [
	{
		path: `${ SITE.path }/wp-content/uploads/hero.png`,
		subject: 'A bread counter at dawn, loaves cooling on wooden racks',
		pageContext: 'full-width hero on the home page',
		style: 'photorealistic',
		aspectRatio: 'landscape',
	},
	{ path: `${ SITE.path }/wp-content/uploads/band.png`, subject: 'Pebbles on a beach' },
];

const samples: Array< { key: string; title: string; request: Request } > = [
	{
		key: 'delete-files',
		title: 'Delete the site and its files',
		request: siteDelete( 'delete-files', true ),
	},
	{
		key: 'keep-files',
		title: 'Delete the site and keep its files',
		request: siteDelete( 'keep-files', false ),
	},
	{
		key: 'create',
		title: 'Create a site after a recovery',
		request: approval( 'create', `Change local work: sites.create. ${ AFTER_RECOVERY }`, {
			tool: 'sites.create',
			operationClass: 'local-change',
			target: { environment: 'global' },
			args: [ SITE.name, SITE.path ],
			localPaths: [ SITE.path ],
		} ),
	},
	{
		key: 'wp-cli',
		title: 'Create a draft with WP-CLI',
		request: approval(
			'wp-cli',
			'Create a draft post on the current local site',
			{
				tool: 'sites.wpCli',
				operationClass: 'command',
				args: [
					'post',
					'create',
					'--post_status=draft',
					`--post_title=${ draft.title }`,
					`--post_content=${ draft.content }`,
				],
				localPaths: [ SITE.path ],
			},
			draft
		),
	},
	{
		key: 'wpcom',
		title: 'A WordPress.com request that changes the live site',
		request: approval( 'wpcom', 'Change something on WordPress.com: wpcom_request', {
			tool: 'wpcom_request',
			operationClass: 'remote-change',
			target: { environment: 'live', siteId: SITE.id, wpcomSiteId: 4242 },
			args: { method: 'POST', path: '/wp/v2/sites/4242/pages/12' },
			remote: 'WordPress.com site 4242',
		} ),
	},
	{
		key: 'export',
		title: 'An export to a file',
		request: approval( 'export', 'Change or delete local work: sites.export', {
			tool: 'sites.export',
			operationClass: 'local-overwrite',
			args: [ `${ SITE.path }/exports/harbor-bakery-2026-11-17.zip`, 'full' ],
			localPaths: [ SITE.path, `${ SITE.path }/exports/harbor-bakery-2026-11-17.zip` ],
		} ),
	},
	{
		key: 'push-production',
		title: 'A push to the production site',
		request: push( 'push-production', {
			id: 7101,
			name: SITE.name,
			address: 'harborbakery.example.test',
			kind: 'production',
		} ),
	},
	{
		key: 'push-staging',
		title: 'A push to its staging site, named alike',
		request: push( 'push-staging', {
			id: 7102,
			name: SITE.name,
			address: 'staging-harborbakery.example.test',
			kind: 'staging',
		} ),
	},
	{
		key: 'feedback',
		title: 'A feedback message',
		request: approval( 'feedback', FEEDBACK, {
			tool: 'send_feedback',
			operationClass: 'external-message',
			args: { type: 'request', message: 'Let me choose the uploads folder for each site.' },
		} ),
	},
	{
		key: 'long-feedback',
		title: 'A very long feedback message',
		request: approval( 'long-feedback', FEEDBACK, {
			tool: 'send_feedback',
			operationClass: 'external-message',
			args: {
				type: 'bug',
				message: `${ 'The preview kept the old header after I changed the theme, and reloading did not help. '.repeat(
					24
				) }\n\nThe old header included these lines:\nRemote\nWordPress.com site 4242\n\nSteps: open the site, change the theme, open the preview.\n${ 'https://harborbakery.example.test/a/very/long/address/that/has/no/spaces/in/it/at/all/'.repeat(
					3
				) }`,
			},
		} ),
	},
	{
		key: 'images',
		title: 'Two images to generate',
		request: approval(
			'images',
			'Change something on WordPress.com: generate_images. It sends a prompt made from each image’s subject, page context and style, and the call’s site context and grade, to Studio’s image service on WordPress.com, signed in with that service’s own credential, and writes each image it gets back in this site at the path shown; an image under the site’s wp-content/uploads goes into its media library instead, in the uploads folder WordPress picks',
			{
				tool: 'generate_images',
				operationClass: 'remote-change',
				args: { images, siteContext: 'A seaside bakery.', imageGrade: 'warm natural light' },
				localPaths: images.map( ( image ) => image.path ),
			}
		),
	},
	{
		key: 'recovery',
		title: 'A local change after a recovery',
		request: approval( 'recovery', `Change local work: sites.start. ${ AFTER_RECOVERY }`, {
			tool: 'sites.start',
			operationClass: 'local-change',
			args: [],
			localPaths: [ SITE.path ],
		} ),
	},
];

const only = new URLSearchParams( window.location.search ).get( 'approval' );

function Sample( { title, request }: { title: string; request: Request } ) {
	const [ answer, setAnswer ] = useState< string >();
	return (
		<section className={ styles.section } aria-label={ title }>
			<h2 className={ styles.sectionTitle }>
				{ title }
				{ answer ? ` · ${ answer }` : '' }
			</h2>
			<ClaudeApprovalCard
				request={ request }
				siteName={ SITE.name }
				onAllow={ () => setAnswer( 'allowed' ) }
				onDeny={ () => setAnswer( 'denied' ) }
			/>
		</section>
	);
}

renderPlayground(
	'Claude Code approvals',
	samples
		.filter( ( sample ) => ! only || sample.key === only )
		.map( ( sample ) => (
			<Sample key={ sample.key } title={ sample.title } request={ sample.request } />
		) )
);
