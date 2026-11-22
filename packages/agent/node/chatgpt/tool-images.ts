/**
 * Whether a ChatGPT turn sends images in tool results, which the route isn't
 * qualified for: off, until the live check that observes whether it accepts
 * them turns it on in its own process. Nothing here reads the environment.
 */

let onForLiveCheck = false;

// Development only: the ChatGPT acceptance runner's gate T1 turns this on in
// the one CLI process it starts for its check, through a preload only it
// loads. No app, CLI command or server calls it.
export function setChatGptToolImagesForLiveCheck( enabled: boolean ): void {
	onForLiveCheck = enabled;
}

export function isChatGptToolImageLiveCheckOn(): boolean {
	return onForLiveCheck;
}
