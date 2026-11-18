import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrowserContextOptions, Page } from 'playwright';

export interface ClaudeWebScope {
	targetOrigin: string | null;
	localSiteUrls: readonly string[];
	sitePath?: string;
	signal: AbortSignal;
	onDiscard?: ( cleanup: () => Promise< void > | void ) => void;
}

export interface ClaudeWebPageOptions {
	headed?: boolean;
	documentOrigin?: string;
	allowAutoLogin?: boolean;
	trustedEditor?: boolean;
	designPreview?: { html: string; images: ReadonlyMap< string, { mime: string; bytes: Buffer } > };
}

export type ClaudeWebPageSettings = Pick<
	BrowserContextOptions,
	'viewport' | 'userAgent' | 'deviceScaleFactor' | 'isMobile' | 'hasTouch' | 'colorScheme'
>;
export interface ClaudeWebGetOptions {
	purpose: 'seo' | 'font-css' | 'font-file';
	userAgent?: string;
}

export interface ClaudeWebMeasurement {
	url: string;
	resourceType: string;
	mainDocument: boolean;
	firstByteMs: number;
	wireBytes: number;
}

export interface ClaudeWebCall {
	readonly signal: AbortSignal;
	readonly targetOrigin: string | null;
	readonly sitePath?: string;
	check(): void;
	onDiscard( cleanup: () => Promise< void > | void ): void;
	networkMeasurements?(): readonly ClaudeWebMeasurement[];
	newPage( settings?: ClaudeWebPageSettings, options?: ClaudeWebPageOptions ): Promise< Page >;
	get( url: string, options: ClaudeWebGetOptions ): Promise< Response >;
}

const calls = new AsyncLocalStorage< ClaudeWebCall >();
export function currentClaudeWebCall(): ClaudeWebCall | undefined {
	return calls.getStore();
}

export function runInClaudeWebCall< T >(
	call: ClaudeWebCall,
	operation: () => Promise< T >
): Promise< T > {
	return calls.run( call, operation );
}
