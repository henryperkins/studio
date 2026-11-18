import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createDesignPreviewResponder, DESIGN_PREVIEW_URL } from './design-preview-resource';
import { runInClaudeWebCall } from './web-call';
import { checkedWebUrl, guardedWebGet, isWebRedirect, requestWebHop, WebRefusal } from './web-http';
import type {
	ClaudeWebCall,
	ClaudeWebMeasurement,
	ClaudeWebPageOptions,
	ClaudeWebPageSettings,
	ClaudeWebScope,
} from './web-call';
import type { Browser } from 'playwright';

export async function hasClaudeChromium(): Promise< boolean > {
	try {
		const { chromium } = await import( 'playwright' );
		const resolveFromPlaywright = createRequire(
			import.meta.resolve( 'playwright/package.json' )
		).resolve;
		const manifest = path.join(
			path.dirname( resolveFromPlaywright( 'playwright-core/package.json' ) ),
			'browsers.json'
		);
		const [ raw ] = await Promise.all( [
			readFile( manifest, 'utf8' ),
			access( chromium.executablePath(), constants.X_OK ),
		] );
		const pinned = (
			JSON.parse( raw ) as { browsers: { name: string; browserVersion: string }[] }
		 ).browsers.find( ( entry ) => entry.name === 'chromium' );
		return supportsBrowserGuard( pinned?.browserVersion ?? '' );
	} catch {
		return false;
	}
}

function supportsBrowserGuard( version: string ) {
	return Number.parseInt( version, 10 ) >= 156;
}

const connectionPolicy = '("http://*:*/*" "https://*:*/*");redirects=allow';
const forwardedHeaders = new Set( [
	'content-type',
	'content-encoding',
	'content-language',
	'location',
	'vary',
	'last-modified',
	'access-control-allow-origin',
	'access-control-allow-credentials',
	'access-control-expose-headers',
	'content-security-policy',
	'referrer-policy',
	'cross-origin-resource-policy',
	'cross-origin-opener-policy',
	'cross-origin-embedder-policy',
	'x-frame-options',
	'x-content-type-options',
	'permissions-policy',
] );

export async function withClaudeWebCall< T >(
	scope: ClaudeWebScope,
	action: () => Promise< T >
): Promise< T > {
	const controller = new AbortController();
	const signal = AbortSignal.any( [ scope.signal, controller.signal ] );
	const browsers = new Map< boolean, Promise< Browser > >();
	const closing = new Map< Browser, Promise< void > >();
	const cleanups: ( () => Promise< void > | void )[] = [];
	let bytesReceived = 0;
	const measurements: ClaudeWebMeasurement[] = [];
	const consumeBytes = ( count: number ) => {
		bytesReceived += count;
		return bytesReceived <= 128 * 1024 * 1024;
	};
	function close( browser: Browser ) {
		if ( ! closing.has( browser ) ) closing.set( browser, browser.close() );
		return closing.get( browser )!;
	}
	const stop = () => {
		for ( const pending of browsers.values() ) void pending.then( close ).catch( () => {} );
	};
	const refuse = ( reason: string ) => {
		if ( ! signal.aborted ) controller.abort( new WebRefusal( reason ) );
	};
	signal.throwIfAborted();
	signal.addEventListener( 'abort', stop, { once: true } );

	async function launch( headed: boolean ) {
		const { chromium } = await import( 'playwright' );
		signal.throwIfAborted();
		// The browser has no direct transport. CDP fulfills each allowed request with bytes from
		// the checked Node connection. Other targets inherit offline mode and a non-resolving proxy.
		const browser = await chromium.launch( {
			executablePath: chromium.executablePath(),
			headless: ! headed,
			chromiumSandbox: true,
			args: [
				'--proxy-server=http://studio-blocked.invalid:9',
				'--proxy-bypass-list=<-loopback>',
				'--host-resolver-rules=MAP * ~NOTFOUND',
				'--dns-prefetch-disable',
				'--disable-quic',
				'--webrtc-ip-handling-policy=disable_non_proxied_udp',
				'--disable-blink-features=DirectSockets',
				'--disable-background-networking',
				'--disable-extensions',
				'--disable-component-update',
			],
		} );
		if ( ! supportsBrowserGuard( browser.version() ) || signal.aborted ) {
			await close( browser );
			signal.throwIfAborted();
			throw new Error( 'The installed Chromium does not support Studio’s browser guard.' );
		}
		return browser;
	}

	async function newPage(
		settings: ClaudeWebPageSettings = {},
		options: ClaudeWebPageOptions = {}
	) {
		signal.throwIfAborted();
		if (
			options.allowAutoLogin &&
			( ! scope.targetOrigin || options.documentOrigin !== scope.targetOrigin )
		)
			throw new WebRefusal( 'the editor requires the selected site origin' );
		const headed = options.headed === true;
		if ( ! browsers.has( headed ) ) browsers.set( headed, launch( headed ) );
		const browser = await browsers.get( headed )!;
		signal.throwIfAborted();
		const preview =
			options.designPreview &&
			createDesignPreviewResponder(
				options.designPreview,
				( url, purpose ) =>
					guardedWebGet(
						url,
						scope,
						{ purpose, userAgent: 'Mozilla/5.0 AppleWebKit/537.36 Chrome/156.0.0.0 Safari/537.36' },
						AbortSignal.any( [ signal, AbortSignal.timeout( 2500 ) ] ),
						consumeBytes
					),
				signal
			);
		const context = await browser.newContext( {
			...settings,
			javaScriptEnabled: ! preview,
			serviceWorkers: 'block',
			acceptDownloads: false,
			offline: true,
			ignoreHTTPSErrors: false,
			permissions: [],
		} );
		const registrationDenied = 'Studio blocked service worker registration.';
		const transportDenied = 'Studio blocked a direct browser transport.';
		context.on( 'console', ( message ) => {
			if ( message.text() === registrationDenied ) refuse( 'this page requires a service worker' );
			if ( message.text() === transportDenied )
				refuse( 'this page requires a direct browser transport' );
		} );
		await context.addInitScript(
			( { warning, direct } ) => {
				const report = console.warn.bind( console );
				for ( const name of [ 'RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport' ] ) {
					if ( name in globalThis )
						Object.defineProperty( globalThis, name, {
							writable: false,
							configurable: false,
							value: class {
								constructor() {
									report( direct );
									throw new DOMException( direct, 'SecurityError' );
								}
							},
						} );
				}
				if ( typeof ServiceWorkerContainer !== 'undefined' ) {
					Object.defineProperty( ServiceWorkerContainer.prototype, 'register', {
						writable: false,
						configurable: false,
						value: async () => {
							report( warning );
							throw new DOMException( warning, 'SecurityError' );
						},
					} );
				}
			},
			{ warning: registrationDenied, direct: transportDenied }
		);
		await context.routeWebSocket( '**/*', async ( socket ) => {
			refuse( 'web sockets are unavailable to this tool' );
			await socket.close();
		} );
		const page = await context.newPage();
		context.on( 'page', ( extra ) => {
			if ( extra !== page ) refuse( 'this tool cannot open extra windows' );
		} );
		page.on( 'download', () => refuse( 'this tool cannot download files through Chromium' ) );
		if ( ! options.trustedEditor )
			page.on( 'filechooser', () =>
				refuse( 'this tool cannot open local files through Chromium' )
			);
		const session = await context.newCDPSession( page );
		await session.send( 'Network.enable' );
		session.on( 'Network.webTransportCreated', () =>
			refuse( 'this page requires a direct browser transport' )
		);
		await session.send( 'Network.setBlockedURLs', {
			urls: [ 'file:*', 'filesystem:*', 'ftp:*', 'ws:*', 'wss:*' ],
		} );
		await session.send( 'Network.emulateNetworkConditionsByRule', {
			offline: true,
			emulateOfflineServiceWorker: true,
			matchedNetworkConditions: [
				{
					urlPattern: '',
					latency: 0,
					downloadThroughput: 0,
					uploadThroughput: 0,
					packetLoss: 100,
					offline: true,
				},
			],
		} );
		await session.send( 'Network.setCacheDisabled', { cacheDisabled: true } );
		await session.send( 'Audits.enable' );
		session.on( 'Audits.issueAdded', ( { issue } ) => {
			if (
				issue.details.contentSecurityPolicyIssueDetails?.violatedDirective.startsWith(
					'worker-src'
				)
			)
				refuse( 'this page requires an unguarded worker' );
		} );
		const failedRequest = ( errorText: string ) => {
			if (
				/ERR_(?:INTERNET_DISCONNECTED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|ACCESS_DENIED|BLOCKED_BY_CLIENT)/.test(
					errorText
				)
			)
				refuse( 'a browser request could not use the guarded connection' );
		};
		session.on( 'Network.loadingFailed', ( { errorText } ) => failedRequest( errorText ) );
		context.on( 'requestfailed', ( request ) =>
			failedRequest( request.failure()?.errorText ?? '' )
		);
		const { frameTree } = await session.send( 'Page.getFrameTree' );
		const mainFrame = frameTree.frame.id;
		const parents = new Map< string, string >();
		const publicDocuments = new Set< string >();
		session.on( 'Page.frameAttached', ( { frameId, parentFrameId } ) =>
			parents.set( frameId, parentFrameId )
		);
		const mayVisitSite = ( id: string ): boolean => {
			for ( let frame: string | undefined = id; frame; frame = parents.get( frame ) ) {
				if ( publicDocuments.has( frame ) ) return false;
				if ( frame === mainFrame ) return true;
			}
			return false;
		};
		await session.send( 'Page.enable' );
		let loginUsed = false;
		let requests = 0;
		const redirectDepth = new Map< string, number >();
		session.on( 'Fetch.requestPaused', async ( event ) => {
			const { requestId, request, resourceType } = event;
			const deadline = AbortSignal.any( [ signal, AbortSignal.timeout( 20000 ) ] );
			try {
				signal.throwIfAborted();
				if ( preview ) {
					if ( request.method !== 'GET' ) throw new WebRefusal( 'design previews are read-only' );
					const response = await preview( request.url, resourceType, event.frameId === mainFrame );
					signal.throwIfAborted();
					await session.send( 'Fetch.fulfillRequest', { requestId, ...response } );
					return;
				}
				if ( options.trustedEditor ) throw new WebRefusal( 'the annotation editor is offline' );
				if ( ++requests > 1500 ) throw new WebRefusal( 'the page exceeded the request limit' );
				const top = resourceType === 'Document' && event.frameId === mainFrame;
				const autoLogin = !! options.allowAutoLogin && top && ! loginUsed && requests === 1;
				if ( request.method !== 'GET' && request.method !== 'HEAD' )
					throw new WebRefusal( 'this browser only reads pages' );
				const url = checkedWebUrl( request.url, scope, {
					purpose: 'page',
					method: request.method,
					autoLogin,
				} );
				if ( options.allowAutoLogin && url.origin !== scope.targetOrigin )
					throw new WebRefusal( 'authenticated browsing is limited to the selected site' );
				if (
					scope.targetOrigin &&
					url.origin !== scope.targetOrigin &&
					mayVisitSite( event.frameId ) &&
					! [ 'Image', 'Font', 'Media', 'Document' ].includes( resourceType )
				)
					throw new WebRefusal(
						'a selected-site document cannot load active cross-origin content'
					);
				if ( url.origin === scope.targetOrigin && ! mayVisitSite( event.frameId ) )
					throw new WebRefusal( 'a public document cannot request the selected site' );
				if ( resourceType === 'Document' && url.origin !== scope.targetOrigin )
					publicDocuments.add( event.frameId );
				if ( top && options.documentOrigin && url.origin !== options.documentOrigin )
					throw new WebRefusal( 'the document left its authorized site' );
				if ( url.pathname === '/studio-auto-login' ) loginUsed = true;
				const depth = event.redirectedRequestId
					? ( redirectDepth.get( event.redirectedRequestId ) ?? 0 ) + 1
					: 0;
				redirectDepth.set( requestId, depth );
				if ( depth > 8 ) throw new WebRefusal( 'too many browser redirects' );
				const authenticated = url.origin === scope.targetOrigin && !! options.allowAutoLogin;
				const headers: Record< string, string > = {};
				for ( const [ name, value ] of Object.entries( request.headers ) ) {
					const key = name.toLowerCase();
					if ( [ 'accept', 'accept-language', 'user-agent', 'range', 'origin' ].includes( key ) )
						headers[ key ] = value;
					if ( authenticated && key === 'x-wp-nonce' ) headers[ key ] = value;
				}
				if ( authenticated ) {
					const cookies = await context.cookies( url.href );
					if ( cookies.length )
						headers.cookie = cookies.map( ( c ) => c.name + '=' + c.value ).join( '; ' );
				}
				const reply = await requestWebHop(
					url,
					scope,
					{
						method: request.method,
						headers,
						purpose: 'page',
						autoLogin,
						consumeBytes,
						onMeasurement: ( firstByteMs, wireBytes ) =>
							measurements.push( {
								url:
									autoLogin && url.pathname === '/studio-auto-login'
										? url.origin + url.pathname
										: url.href,
								resourceType,
								mainDocument: top,
								firstByteMs,
								wireBytes,
							} ),
					},
					deadline
				);
				if ( /^\s*attachment(?:\s*;|\s*$)/i.test( reply.headers[ 'content-disposition' ] ?? '' ) )
					throw new WebRefusal( 'this tool cannot download files through Chromium' );
				if ( isWebRedirect( reply.status ) && reply.headers.location ) {
					const dest = checkedWebUrl( new URL( reply.headers.location, url ).href, scope, {
						purpose: 'page',
						method: request.method,
					} );
					if ( options.allowAutoLogin && dest.origin !== scope.targetOrigin )
						throw new WebRefusal( 'authenticated browsing is limited to the selected site' );
					if (
						dest.origin === scope.targetOrigin &&
						( url.origin !== scope.targetOrigin || ! mayVisitSite( event.frameId ) )
					)
						throw new WebRefusal( 'a public redirect cannot enter the selected site' );
					if ( top && options.documentOrigin && dest.origin !== options.documentOrigin )
						throw new WebRefusal( 'the redirect left the authorized site' );
				}
				const responseHeaders = Object.entries( reply.headers ).flatMap( ( [ name, value ] ) => {
					if (
						! value ||
						( ! forwardedHeaders.has( name ) && ! ( authenticated && name === 'set-cookie' ) )
					)
						return [];
					return ( Array.isArray( value ) ? value : [ value ] ).map( ( item ) => ( {
						name,
						value: item,
					} ) );
				} );
				responseHeaders.push(
					{ name: 'Cache-Control', value: 'no-store' },
					{ name: 'Connection-Allowlist', value: connectionPolicy },
					{
						name: 'Content-Security-Policy',
						value:
							"worker-src 'none'; object-src 'none'; frame-src http: https:; sandbox allow-same-origin allow-scripts allow-forms",
					}
				);
				signal.throwIfAborted();
				await session.send( 'Fetch.fulfillRequest', {
					requestId,
					responseCode: reply.status,
					responseHeaders,
					body: reply.body.toString( 'base64' ),
				} );
			} catch ( error ) {
				if ( deadline.aborted && ! signal.aborted ) controller.abort( deadline.reason );
				else if ( error instanceof WebRefusal && ! signal.aborted ) controller.abort( error );
				else if ( ! signal.aborted && ! page.isClosed() )
					refuse( 'the resource could not be verified or retrieved' );
				await session
					.send( 'Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' } )
					.catch( () => {} );
			}
		} );
		await session.send( 'Fetch.enable', {
			patterns: [ { urlPattern: '*', requestStage: 'Request' } ],
		} );
		page.on( 'framenavigated', ( frame ) => {
			const url = frame.url();
			if (
				( preview && url !== DESIGN_PREVIEW_URL && url !== 'about:blank' ) ||
				( options.trustedEditor && url !== 'about:blank' ) ||
				( ! options.trustedEditor && ! /^(?:https?:|about:(?:blank|srcdoc)$)/.test( url ) )
			)
				refuse( 'the document used an unsupported scheme' );
		} );
		page.on( 'close', () => void context.close().catch( () => {} ) );
		signal.throwIfAborted();
		return page;
	}

	const call: ClaudeWebCall = {
		targetOrigin: scope.targetOrigin,
		sitePath: scope.sitePath,
		signal,
		check: () => signal.throwIfAborted(),
		onDiscard: ( cleanup ) => cleanups.push( cleanup ),
		networkMeasurements: () => measurements.slice(),
		newPage,
		get: async ( url, options ) => {
			try {
				return await guardedWebGet( url, scope, options, signal, consumeBytes );
			} catch ( error ) {
				if ( ! signal.aborted )
					controller.abort(
						error instanceof WebRefusal ||
							( error instanceof Error && error.name === 'TimeoutError' )
							? error
							: new WebRefusal( 'the resource could not be verified or retrieved' )
					);
				throw signal.reason;
			}
		},
	};
	try {
		let result: T;
		try {
			result = await runInClaudeWebCall( call, action );
			signal.throwIfAborted();
		} catch ( error ) {
			signal.throwIfAborted();
			throw error;
		} finally {
			signal.removeEventListener( 'abort', stop );
			controller.abort();
			const launched = await Promise.allSettled( browsers.values() );
			await Promise.all(
				launched.map( ( entry ) => entry.status === 'fulfilled' && close( entry.value ) )
			);
		}
		scope.signal.throwIfAborted();
		cleanups.forEach( ( cleanup ) => scope.onDiscard?.( cleanup ) );
		return result;
	} catch ( error ) {
		const failures: unknown[] = [];
		for ( const cleanup of cleanups.reverse() ) {
			try {
				await cleanup();
			} catch ( failure ) {
				failures.push( failure );
			}
		}
		if ( failures.length )
			throw Object.assign(
				new Error( 'Studio could not discard all unfinished browser artifacts.' ),
				{ cause: error, failures }
			);
		scope.signal.throwIfAborted();
		throw error;
	}
}
