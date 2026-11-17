import '@/lib/theme/tokens.css';
import '@/lib/theme/base.css';
import '@/index.css';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app';
import { createInMemoryConnector, makeSession, makeSite } from '@/test/in-memory-connector';
import {
	assistantTextEntry,
	assistantToolCallEntry,
	promptEntry,
	toolResultEntry,
	turnClosedEntry,
} from '@/test/session-entries';
import type { SessionEntry } from '@/data/core';
import type { ChatGptAccountView } from '@studio/agent/protocol/chatgpt';
import type { ImageServiceState } from '@studio/agent/protocol/image-service';

// A ChatGPT chat with Studio's image service in each state: as the
// WordPress.com account, with a token set for it, or not set up. The model
// picker's account lists models Studio hasn't qualified, and the chat holds a
// generate_images result that records the account that made its images.
const params = new URLSearchParams( window.location.search );
const scheme = params.get( 'scheme' ) === 'dark' ? 'dark' : 'light';
const service = params.get( 'service' ) ?? 'account';
const view = params.get( 'view' ) === 'settings' ? 'settings' : 'chat';
// The chat's account signed out or needing sign-in; or every read after the first failing.
const accountState = params.get( 'account' );
const signedOut = accountState === 'signed-out' || accountState === 'needs-sign-in';
const failingReads = params.get( 'read' ) === 'failing';

const CONNECTION_ID = 'f84d75a0-4e60-4168-a1ab-3134542c637a';
const sampleUser = { id: 1, email: 'sample@example.test', displayName: 'Sample Account' };
const account: ChatGptAccountView = {
	connectionId: CONNECTION_ID,
	providerId: 'chatgpt-oauth',
	backend: 'pi',
	revision: 1,
	identity: { subject: 'sample-subject', email: 'plan@example.test' },
	authStatus: signedOut ? 'disconnected' : 'connected',
	label: 'Personal',
	email: 'plan@example.test',
	state: signedOut ? ( accountState as ChatGptAccountView[ 'state' ] ) : 'signed-in',
	storage: 'vault',
};
const chatGpt = {
	enabled: true,
	signInSupported: true,
	secureStorage: 'available' as const,
	accounts: [ account ],
};
let reads = 0;
const failRead = async (): Promise< never > => {
	throw new Error( 'Studio couldn’t complete the ChatGPT action. Try again.' );
};
const imageService: ImageServiceState | undefined =
	service === 'token'
		? { available: true, service: 'wordpress-com', credential: 'environment-token', account: null }
		: undefined;
const site = makeSite( { id: 'image-service-site', name: 'Bakery', running: true } );
const session = makeSession( {
	id: 'image-service-chat',
	title: 'A hero image',
	ownerSiteId: site.id,
	ownerSitePath: site.path,
} );
const generated = toolResultEntry(
	'Generating 1 image in the background. Use them in the markup now:\n- /sites/image-service-site/wp-content/uploads/hero.png'
) as SessionEntry & { message: object };
const entries: SessionEntry[] = [
	{
		type: 'custom',
		id: 'selection',
		parentId: null,
		timestamp: '2026-06-05T11:59:00.000Z',
		customType: 'studio.session_context',
		data: {
			provider: 'chatgpt-oauth',
			connectionId: CONNECTION_ID,
			revision: 1,
			model: 'gpt-6-luna',
			reasoningEffort: 'medium',
		},
	} as SessionEntry,
	promptEntry( 'Add a hero image of a sunlit bakery counter.' ),
	assistantToolCallEntry( 'generate_images', {
		images: [
			{ path: '/sites/image-service-site/wp-content/uploads/hero.png', subject: 'A counter' },
		],
	} ),
	{
		...generated,
		message: {
			...generated.message,
			details: {
				studioService: {
					service: 'wordpress-com',
					credential: service === 'token' ? 'environment-token' : 'wordpress-com-login',
					account:
						service === 'token'
							? null
							: { displayName: 'Sample Account', email: 'sample@example.test' },
				},
			},
		},
	} as SessionEntry,
	assistantTextEntry( 'The hero image is on the home page.' ),
	turnClosedEntry( 'success' ),
];

const connector = createInMemoryConnector(
	{
		sites: [ site ],
		user: service === 'off' ? null : sampleUser,
		imageService,
		preferences: { colorScheme: scheme },
		chatGpt,
		sessions: [ { summary: session, entries } ],
	},
	{
		...( failingReads
			? {
					getChatGptSettings: async () =>
						reads++ === 0 ? structuredClone( chatGpt ) : failRead(),
					recheckChatGptSettings: failRead,
			  }
			: {} ),
		getOnboardingCompleted: async () => true,
		getChatGptModels: async ( connectionId, revision ) => ( {
			connectionId,
			revision,
			checkedAt: new Date().toISOString(),
			models: [ { id: 'gpt-6-luna', label: 'GPT-6 Luna' } ],
			listsUnqualifiedModels: true,
			lastError: null,
		} ),
	}
);

const link = ( changes: Record< string, string > ) =>
	`?${ new URLSearchParams( {
		scheme,
		service,
		view,
		...( accountState ? { account: accountState } : {} ),
		...( failingReads ? { read: 'failing' } : {} ),
		...changes,
	} ) }`;

createRoot( document.getElementById( 'root' )! ).render(
	<StrictMode>
		<App
			connector={ connector }
			queryClient={ new QueryClient() }
			history={ createMemoryHistory( {
				initialEntries: [
					`/sessions/${ session.id }${ view === 'settings' ? '?settings=ai' : '' }`,
				],
			} ) }
		/>
		<nav
			aria-label="Image service preview"
			style={ {
				position: 'fixed',
				top: 64,
				right: 24,
				zIndex: 100,
				display: 'flex',
				flexWrap: 'wrap',
				gap: 16,
				maxWidth: 520,
				fontSize: 13,
				padding: 12,
				background: 'var(--chrome)',
				border: '1px solid var(--border)',
				borderRadius: 'var(--radius-lg)',
			} }
		>
			<a href={ link( { service: 'account' } ) }>As the WordPress.com account</a>
			<a href={ link( { service: 'token' } ) }>With a token</a>
			<a href={ link( { service: 'off' } ) }>Not set up</a>
			<a href={ link( { account: 'signed-out', read: '' } ) }>Account signed out</a>
			<a href={ link( { account: 'needs-sign-in', read: '' } ) }>Account needs sign-in</a>
			<a href={ link( { account: '', read: 'failing' } ) }>Reads failing</a>
			<a href={ link( { view: view === 'chat' ? 'settings' : 'chat' } ) }>
				{ view === 'chat' ? 'Settings › AI' : 'Chat' }
			</a>
			<a href={ link( { scheme: scheme === 'dark' ? 'light' : 'dark' } ) }>
				{ scheme === 'dark' ? 'Light mode' : 'Dark mode' }
			</a>
		</nav>
	</StrictMode>
);
