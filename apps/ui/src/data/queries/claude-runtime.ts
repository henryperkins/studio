import { __, sprintf } from '@wordpress/i18n';

/** Both transports carry native sign-in errors in the message, including Electron's IPC prefix. */
export function describeClaudeIssue( issue: string ): string {
	const code = /claude-sign-in-(?:action-required|refused):([\w-]+)/.exec( issue )?.[ 1 ] ?? issue;
	const environment = /^environment:([a-z_][a-z\d_]*)$/i.exec( code );
	if ( environment ) {
		return sprintf(
			/* translators: %s is the name of an environment variable, never its value. */
			__(
				'The environment variable %s changes how Claude connects. Restart Studio with it unset.'
			),
			environment[ 1 ]
		);
	}
	switch ( code ) {
		case 'native-auth-unqualified':
			return __( 'Sign in to a Claude subscription with Claude Code, then recheck its status.' );
		case 'connection-not-found':
		case 'Unknown Claude connection':
			return __( 'This connection was removed. Select another connection or add it again.' );
		case 'version-unqualified':
			return __( 'Select a supported Claude Code version, or update Studio and recheck.' );
		case 'sdk-unqualified':
		case 'platform-unsupported':
		case 'platform-unqualified':
		case 'libc-unsupported':
			return __(
				'This Studio build has no verified Claude Code runtime for this platform. Check for a Studio update.'
			);
		case 'architecture-unqualified':
		case 'absolute-native-executable-required':
		case 'invalid-executable-format':
		case 'executable-path-unsupported':
		case 'Invalid Claude connection':
			return __( 'Select the full path to the native Claude Code executable for this computer.' );
		case 'signature-invalid':
		case 'signature-unverifiable':
		case 'executable-unavailable':
		case 'version-unreadable':
			return __(
				'Studio could not verify the executable. Check its path and the Claude Code installation.'
			);
		case 'executable-changed':
			return __( 'Claude Code changed during the check. Recheck its installed version.' );
		case 'no-display':
		case 'no-interactive-desktop':
			return __( 'Open Studio on an interactive desktop to sign in with Claude Code.' );
		case 'no-terminal':
		case 'terminal-permission-denied':
			return __( 'Allow Studio to open a terminal on this computer, then try signing in again.' );
		case 'no-browser':
			return __( 'Set a default browser on this computer, then try signing in again.' );
		case 'managed-policy-unverified':
			return __( 'Studio could not verify the managed Claude policy. Contact your administrator.' );
		case 'config-directory-conflict':
		case 'config-directory-mismatch':
		case 'native-paths-unqualified':
			return __(
				'Check that the selected configuration directory matches the one Claude Code uses.'
			);
		case 'configuration-unreadable':
		case 'configuration-unqualified':
		case 'settings-routing-override':
		case 'environment-conflict':
			return __(
				'Check Claude Code’s configuration and environment for settings that change its connection.'
			);
		case 'experimental-feature-disabled':
			return __( 'The Claude Code runtime is disabled in this Studio instance.' );
		case 'local-site-not-found':
			return __( 'This local site is unavailable. Choose another workspace.' );
		case 'native-runtime-unqualified':
		case 'preflight-unavailable':
			return __(
				'Studio could not verify the runtime for this workspace. Check its connection in Settings and try again.'
			);
		default:
			return __(
				'Studio could not complete the Claude Code check. Recheck the connection in Settings.'
			);
	}
}
