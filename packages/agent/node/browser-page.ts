import { getSharedBrowser } from './browser-utils';
import { currentClaudeWebCall } from './claude-code/web-call';
import type { BrowserContextOptions, Page } from 'playwright';

type PageOptions = Pick< BrowserContextOptions, 'viewport' | 'deviceScaleFactor' >;

export async function openToolPage(
	options: PageOptions,
	documentOrigin?: string,
	allowAutoLogin = false
): Promise< Page > {
	const call = currentClaudeWebCall();
	if ( call ) {
		if ( documentOrigin && documentOrigin !== call.targetOrigin )
			throw new Error( 'Audit the selected local site.' );
		return call.newPage( options, { documentOrigin, allowAutoLogin } );
	}
	const browser = await getSharedBrowser();
	return browser.newPage( { ...options, ignoreHTTPSErrors: true } );
}
