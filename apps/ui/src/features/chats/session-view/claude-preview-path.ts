import { DESIGN_SYSTEM_PREVIEW_PATH } from '@studio/agent/protocol/chat-artifacts';

export function claudeSitePreviewPaths(
	widgets: Array< { type: string; widgetProps: Record< string, unknown > } >,
	siteId: string | null
): string[] {
	if ( ! siteId ) return [];
	return widgets.flatMap( ( { type, widgetProps } ) => {
		const { path } = widgetProps;
		if (
			type !== 'site-preview' ||
			( widgetProps.siteId !== undefined && widgetProps.siteId !== siteId ) ||
			typeof path !== 'string'
		)
			return [];
		return path === DESIGN_SYSTEM_PREVIEW_PATH ||
			( /^\/(?!\/)/.test( path ) &&
				! /[\\\s]/.test( path ) &&
				! Array.from( path ).some( ( char ) => char.charCodeAt( 0 ) < 32 ) )
			? [ path ]
			: [];
	} );
}
