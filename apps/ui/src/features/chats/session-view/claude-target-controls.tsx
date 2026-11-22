import { useMutation, useQueryClient } from '@tanstack/react-query';
import { __, sprintf } from '@wordpress/i18n';
import { toast } from '@/data/app-messages';
import { useConnector, type SiteDetails } from '@/data/core';
import { useConnectedWpcomSites } from '@/data/queries/use-connected-wpcom-sites';
import { SESSIONS_QUERY_KEY } from '@/data/queries/use-sessions';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/lib/ui';
import type { ClaudeStudioTarget } from '@studio/agent/protocol/claude-code';

export function useClaudeTargetChange( sessionId: string ) {
	const connector = useConnector();
	const client = useQueryClient();
	return useMutation( {
		mutationFn: ( {
			expected,
			target,
		}: {
			expected: ClaudeStudioTarget;
			target: ClaudeStudioTarget;
		} ) => connector.setClaudeSessionTarget( sessionId, expected, target ),
		onError: ( error ) =>
			toast.error( __( 'Couldn’t switch the site this chat works on' ), {
				description: error.message,
			} ),
		onSettled: () => client.invalidateQueries( { queryKey: [ ...SESSIONS_QUERY_KEY, sessionId ] } ),
	} );
}

function TargetSelect( {
	label,
	value,
	items,
	disabled,
	change,
}: {
	label: string;
	value: string;
	items: { value: string; label: string; disabled?: boolean }[];
	disabled: boolean;
	change: ( value: string ) => void;
} ) {
	return (
		<Select
			items={ items }
			value={ value }
			disabled={ disabled }
			onValueChange={ ( next, details ) => {
				if ( details.reason === 'none' ) {
					details.cancel();
					return;
				}
				if (
					next &&
					next !== value &&
					items.some( ( item ) => item.value === next && ! item.disabled )
				)
					change( next );
			} }
		>
			<SelectTrigger aria-label={ label }>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{ items.map( ( item ) => (
					<SelectItem value={ item.value } key={ item.value } disabled={ item.disabled }>
						{ item.label }
					</SelectItem>
				) ) }
			</SelectContent>
		</Select>
	);
}

export function ClaudeTargetControls( {
	workspaceSiteId,
	target,
	sites,
	sitesPending,
	disabled,
	onChange,
}: {
	workspaceSiteId?: string;
	target: ClaudeStudioTarget;
	sites: SiteDetails[];
	sitesPending: boolean;
	disabled: boolean;
	onChange: ( next: ClaudeStudioTarget ) => void;
} ) {
	const siteId = target.environment === 'global' ? undefined : target.siteId;
	const site = sites.find( ( item ) => item.id === siteId );
	const missingSite = sitesPending ? __( 'Loading site…' ) : __( 'Unavailable site' );
	const connected = useConnectedWpcomSites( siteId );
	const remotes = connected.data ?? [];
	const siteOptions = [
		{ value: 'global', label: __( 'All of Studio' ) },
		...sites.map( ( item ) => ( { value: 'site:' + item.id, label: item.name } ) ),
	];
	if ( siteId && ! site ) siteOptions.push( { value: 'site:' + siteId, label: missingSite } );
	const environments: { value: string; label: string; disabled?: boolean }[] = [
		{
			value: 'local',
			label: sprintf(
				/* translators: %s: local site name. */ __( '%s · Local' ),
				site?.name ?? missingSite
			),
			disabled: ! site,
		},
		...remotes.map( ( remote ) => ( {
			value: 'live:' + remote.id,
			label: sprintf(
				/* translators: %s: remote WordPress.com URL. */ __( '%s · Live' ),
				remote.url
			),
		} ) ),
	];
	if (
		target.environment === 'live' &&
		! remotes.some( ( remote ) => remote.id === target.wpcomSiteId )
	) {
		environments.push( {
			value: 'live:' + target.wpcomSiteId,
			label: sprintf(
				/* translators: %d: remote site ID. */ __( 'WordPress.com site %d · Live' ),
				target.wpcomSiteId
			),
			disabled: true,
		} );
	}
	return (
		<>
			{ ! workspaceSiteId && (
				<TargetSelect
					label={ __( 'Acting site' ) }
					value={ siteId ? 'site:' + siteId : 'global' }
					items={ siteOptions }
					disabled={ disabled }
					change={ ( value ) => {
						if ( value === 'global' ) onChange( { environment: 'global' } );
						else {
							const next = sites.find( ( item ) => 'site:' + item.id === value );
							if ( next ) onChange( { environment: 'local', siteId: next.id } );
						}
					} }
				/>
			) }
			{ siteId && (
				<TargetSelect
					label={ workspaceSiteId ? __( 'Acting site' ) : __( 'Acting environment' ) }
					value={ target.environment === 'live' ? 'live:' + target.wpcomSiteId : 'local' }
					items={ environments }
					disabled={ disabled }
					change={ ( value ) => {
						if ( value === 'local' ) onChange( { environment: 'local', siteId } );
						else {
							const remote = remotes.find( ( item ) => 'live:' + item.id === value );
							if ( remote ) onChange( { environment: 'live', siteId, wpcomSiteId: remote.id } );
						}
					} }
				/>
			) }
		</>
	);
}
