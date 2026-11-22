import { setChatGptToolImagesForLiveCheck } from '@studio/agent/node/chatgpt/tool-images';

/**
 * Development only. Loaded with `--import`, after the request observer, into
 * the one Studio CLI process the ChatGPT acceptance runner starts for gate
 * T1: turns images in tool results on for that process's turn, so the live
 * check can observe whether the route accepts one. Nothing else loads it.
 */
setChatGptToolImagesForLiveCheck( true );
