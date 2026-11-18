import { randomUUID } from 'node:crypto';
import {
	buildInspectorPageScript,
	parseInspectorMessage,
} from '../../protocol/inspector/page-script';
import type { BrowserAnnotation } from './inspector-inject';
import type { InspectorEvent } from '../../protocol/inspector/page-script';
import type { ClaudeWebCall } from '../claude-code/web-call';
import type { Page } from 'playwright';

type Result = BrowserAnnotation[] | null;
type BindPicker = (
	event: ( value: InspectorEvent ) => void,
	render: () => Promise< void >
) => Promise< void >;

/** Only the top-frame isolated world has the picker binding. The private editor lives in another context. */
export async function runGuardedPicker(
	url: string,
	timeoutMs: number,
	call: ClaudeWebCall,
	configure: (
		page: Page,
		editor: Page,
		finish: ( result: Result ) => void,
		bind: BindPicker
	) => Promise< void >
): Promise< Result > {
	const page = await call.newPage(
		{ viewport: null },
		{ headed: true, documentOrigin: new URL( url ).origin }
	);
	const editor = await call.newPage( { viewport: null }, { headed: true, trustedEditor: true } );
	const session = await page.context().newCDPSession( page );
	let resolve!: ( result: Result ) => void;
	let reject!: ( error: unknown ) => void;
	const promise = new Promise< Result >( ( done, fail ) => {
		resolve = done;
		reject = fail;
	} );
	// Setup includes asynchronous browser navigation; retain any close/error before it finishes.
	void promise.catch( () => undefined );
	const onStop = () => reject( new Error( 'The annotation session stopped.' ) );
	const onClose = () => resolve( null );
	page.once( 'close', onClose );
	editor.once( 'close', onClose );
	call.signal.addEventListener( 'abort', onStop, { once: true } );
	const timer = setTimeout(
		() => reject( new Error( 'The annotation session timed out.' ) ),
		timeoutMs
	);
	const bind: BindPicker = async ( accept, render ) => {
		const world = 'studio-picker-' + randomUUID();
		const name = '__studioPicker';
		let context: number | undefined;
		await session.send( 'Runtime.enable' );
		await session.send( 'Page.enable' );
		await session.send( 'Runtime.addBinding', { name, executionContextName: world } );
		session.on( 'Runtime.bindingCalled', ( message ) => {
			if ( call.signal.aborted || message.name !== name || message.executionContextId !== context )
				return;
			const event = parseInspectorMessage( message.payload );
			if ( event && ( event.type !== 'pick' || event.target.url === page.url() ) ) accept( event );
		} );
		const install = async () => {
			const { frameTree } = await session.send( 'Page.getFrameTree' );
			const { executionContextId } = await session.send( 'Page.createIsolatedWorld', {
				frameId: frameTree.frame.id,
				worldName: world,
			} );
			context = executionContextId;
			const result = await session.send( 'Runtime.evaluate', {
				expression: buildInspectorPageScript( name ),
				contextId: executionContextId,
			} );
			if ( result.exceptionDetails ) throw new Error( 'The annotation picker could not start.' );
			await render();
		};
		session.on( 'Runtime.executionContextDestroyed', ( event ) => {
			if ( event.executionContextId === context ) context = undefined;
		} );
		session.on( 'Runtime.executionContextsCleared', () => {
			context = undefined;
		} );
		page.on( 'domcontentloaded', () => {
			void install().catch( reject );
		} );
	};

	try {
		call.check();
		await configure( page, editor, resolve, bind );
		await page.goto( url, { waitUntil: 'domcontentloaded', timeout: 30_000 } );
		await page.bringToFront();
		const result = await promise;
		call.check();
		return result;
	} finally {
		clearTimeout( timer );
		call.signal.removeEventListener( 'abort', onStop );
		page.off( 'close', onClose );
		editor.off( 'close', onClose );
		await Promise.allSettled( [ editor.close(), page.close() ] );
	}
}
