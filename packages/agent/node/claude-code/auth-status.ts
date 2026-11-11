import { createHash } from 'crypto';
const conflicts = new Set( [
	'ANTHROPIC_API_KEY',
	'ANTHROPIC_AUTH_TOKEN',
	'CLAUDE_CODE_OAUTH_TOKEN',
	'ANTHROPIC_BASE_URL',
	'CLAUDE_CODE_USE_BEDROCK',
	'CLAUDE_CODE_USE_VERTEX',
	'CLAUDE_CODE_USE_FOUNDRY',
	'AWS_PROFILE',
	'AWS_BEARER_TOKEN_BEDROCK',
	'GOOGLE_APPLICATION_CREDENTIALS',
	'HTTPS_PROXY',
	'HTTP_PROXY',
	'ALL_PROXY',
	'CLAUDE_CODE_SIMPLE',
] );
const allowed = new Set( [
	'PATH',
	'SYSTEMROOT',
	'WINDIR',
	'COMSPEC',
	'PATHEXT',
	'USERPROFILE',
	'HOMEDRIVE',
	'HOMEPATH',
	'APPDATA',
	'LOCALAPPDATA',
	'TEMP',
	'TMP',
	'PROGRAMFILES',
	'PROGRAMFILES(X86)',
	'PROGRAMDATA',
	'CLAUDE_CODE_GIT_BASH_PATH',
] );
export type ClaudeAuthIdentity = {
	email?: string;
	organization?: string;
	subscriptionType?: string;
	tokenSource?: string;
	apiKeySource?: string;
	apiProvider?: string;
};
export function buildClaudeEnvironment( input: NodeJS.ProcessEnv ): {
	env: NodeJS.ProcessEnv;
	conflicts: string[];
} {
	const env: NodeJS.ProcessEnv = {};
	const found: string[] = [];
	for ( const [ key, value ] of Object.entries( input ) ) {
		const upper = key.toUpperCase();
		if (
			value &&
			( conflicts.has( upper ) ||
				upper.startsWith( 'ANTHROPIC_' ) ||
				upper.startsWith( 'AWS_' ) ||
				upper.startsWith( 'GOOGLE_CLOUD_' ) ||
				upper.startsWith( 'AZURE_' ) ||
				upper.endsWith( '_PROXY' ) )
		)
			found.push( upper );
		if ( allowed.has( upper ) ) env[ key ] = value;
	}
	return { env, conflicts: [ ...new Set( found ) ].sort() };
}
export function assessClaudeAuth( status: Record< string, unknown > ): { qualified: boolean } {
	return {
		qualified:
			status.loggedIn === true &&
			status.authMethod === 'claude.ai' &&
			status.apiProvider === 'firstParty' &&
			status.storedClaudeAiLogin === true &&
			typeof status.subscriptionType === 'string' &&
			/^(pro|max)$/i.test( status.subscriptionType ),
	};
}
function samePlan( a: string | undefined, b: string | undefined ): boolean {
	const plan = ( value: string | undefined ) =>
		/^(?:claude )?(pro|max)(?: plan)?$/i.exec( value ?? '' )?.[ 1 ]?.toLowerCase();
	return !! plan( a ) && plan( a ) === plan( b );
}

/** Whether two native sign-ins are the same account on the same plan. */
export function isSameClaudeAccount( a: ClaudeAuthIdentity, b: ClaudeAuthIdentity ): boolean {
	return (
		!! a.email &&
		a.email.toLowerCase() === b.email?.toLowerCase() &&
		( a.organization ?? '' ).toLowerCase() === ( b.organization ?? '' ).toLowerCase() &&
		samePlan( a.subscriptionType, b.subscriptionType )
	);
}

/** A stable key for the account a conversation runs on, without storing the address. */
export function claudeAccountKey( identity: ClaudeAuthIdentity ): string | undefined {
	if ( ! identity.email ) return;
	return createHash( 'sha256' )
		.update(
			`${ identity.email.toLowerCase() }\n${ ( identity.organization ?? '' ).toLowerCase() }`
		)
		.digest( 'hex' );
}

export function compareClaudeExecutionAuth(
	preflight: ClaudeAuthIdentity,
	current: ClaudeAuthIdentity
): boolean {
	if ( ! preflight.email || ! current.email ) return false;
	if ( current.apiProvider !== 'firstParty' ) return false;
	const nativePlan = /^(pro|max)$/i.exec( preflight.subscriptionType ?? '' )?.[ 1 ];
	const sdkPlan = /^(?:claude )?(pro|max)(?: plan)?$/i.exec(
		current.subscriptionType ?? ''
	)?.[ 1 ];
	if ( ! nativePlan || nativePlan.toLowerCase() !== sdkPlan?.toLowerCase() ) return false;
	if (
		current.tokenSource !== undefined ||
		( current.apiKeySource !== undefined && current.apiKeySource !== 'none' )
	)
		return false;
	for ( const key of [ 'email', 'organization' ] as const ) {
		if (
			preflight[ key ] &&
			current[ key ] &&
			preflight[ key ]?.toLowerCase() !== current[ key ]?.toLowerCase()
		)
			return false;
	}
	return true;
}
