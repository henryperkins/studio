import { escapeClaudeApprovalText } from '@studio/agent/protocol/claude-code';
import { __, sprintf } from '@wordpress/i18n';
import { useId, type ReactNode } from 'react';
import { Button } from '@/lib/ui';
import styles from './style.module.css';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';
import type { ClaudeStudioTarget } from '@studio/agent/protocol/claude-code';

type ClaudeApprovalRequest = Extract< BackendTurnEvent, { type: 'approval.requested' } >;

// The labels of the argument names the Studio tools' approvals carry. Any other
// name is shown as it is.
function getFieldLabel( name: string ): string {
	switch ( name ) {
		case 'method':
			return __( 'Method' );
		case 'path':
			return __( 'Path' );
		case 'type':
			return __( 'Type' );
		case 'message':
			return __( 'Message' );
		case 'images':
			return __( 'Images' );
		case 'subject':
			return __( 'Subject' );
		case 'pageContext':
			return __( 'Page context' );
		case 'style':
			return __( 'Style' );
		case 'aspectRatio':
			return __( 'Aspect ratio' );
		case 'siteContext':
			return __( 'Site context' );
		case 'imageGrade':
			return __( 'Image grade' );
		case 'direction':
			return __( 'Direction' );
		case 'remoteSite':
			return __( 'WordPress.com site' );
		case 'overwrites':
			return __( 'Replaces' );
		case 'id':
			return __( 'ID' );
		case 'name':
			return __( 'Name' );
		case 'address':
			return __( 'Address' );
		case 'kind':
			return __( 'Kind' );
		default:
			return escapeClaudeApprovalText( name );
	}
}

function getTargetLabel( target: ClaudeStudioTarget, siteName?: string ): string {
	if ( target.environment === 'global' ) return __( 'Studio as a whole, not one site' );
	const site = escapeClaudeApprovalText( siteName ?? target.siteId );
	if ( target.environment === 'live' )
		return sprintf(
			/* translators: 1: a site's name, 2: the numeric ID of its WordPress.com site. */
			__( '%1$s, the live site on WordPress.com (site %2$s)' ),
			site,
			String( target.wpcomSiteId )
		);
	return sprintf(
		/* translators: %s: a site's name. */
		__( '%s, the local site' ),
		site
	);
}

// The arguments arrive as escaped JSON. Parsing turns an escape back into the
// character it stands for, so every string is escaped again before it is shown.
function parseArguments( args: string ): { value: unknown } | undefined {
	try {
		return { value: JSON.parse( args ) as unknown };
	} catch {
		return undefined;
	}
}

function Field( { label, children }: { label: string; children: ReactNode } ) {
	return (
		<div className={ styles.field }>
			<dt className={ styles.label }>{ label }</dt>
			<dd className={ styles.value }>{ children }</dd>
		</div>
	);
}

function ShownValue( { value }: { value: unknown } ) {
	if ( typeof value === 'string' )
		return <span className={ styles.text }>{ escapeClaudeApprovalText( value ) }</span>;
	if ( value === null || typeof value !== 'object' )
		return <span className={ styles.text }>{ String( value ) }</span>;
	if ( Array.isArray( value ) ) {
		if ( ! value.length ) return <span className={ styles.none }>{ __( 'None' ) }</span>;
		if ( value.length === 1 ) return <ShownValue value={ value[ 0 ] } />;
		return (
			<ol className={ styles.items }>
				{ value.map( ( item, index ) => (
					<li key={ index }>
						<ShownValue value={ item } />
					</li>
				) ) }
			</ol>
		);
	}
	const entries = Object.entries( value );
	if ( ! entries.length ) return <span className={ styles.none }>{ __( 'None' ) }</span>;
	return (
		<dl className={ styles.nested }>
			{ entries.map( ( [ name, item ] ) => (
				<Field key={ name } label={ getFieldLabel( name ) }>
					<ShownValue value={ item } />
				</Field>
			) ) }
		</dl>
	);
}

/**
 * A Claude Code approval: everything the execution policy shows of the one
 * operation it covers, as the terminal's approver shows it, and its answers.
 */
export function ClaudeApprovalCard( {
	request,
	siteName,
	onAllow,
	onDeny,
}: {
	request: ClaudeApprovalRequest;
	/** The name of the Studio site the operation's target names, when Studio knows it. */
	siteName?: string;
	onAllow: () => void;
	onDeny: () => void;
} ) {
	const id = useId();
	const { operation, draft } = request;
	const args = parseArguments( operation.args );
	const described = `${ id }-description ${ id }-details`;
	return (
		<div role="group" aria-labelledby={ `${ id }-title` } className={ styles.card }>
			<p id={ `${ id }-title` } className={ styles.title }>
				{ __( 'Allow this operation?' ) }
			</p>
			<p id={ `${ id }-description` } className={ styles.description }>
				{ request.description }
			</p>
			<dl id={ `${ id }-details` } className={ styles.fields }>
				<Field label={ __( 'Operation' ) }>
					<span className={ styles.code }>{ operation.tool }</span>
				</Field>
				<Field label={ __( 'Acts on' ) }>{ getTargetLabel( operation.target, siteName ) }</Field>
				{ operation.localPaths.length ? (
					<Field label={ __( 'Local files and folders' ) }>
						<ul className={ styles.paths }>
							{ operation.localPaths.map( ( localPath, index ) => (
								<li key={ index } className={ styles.code }>
									{ localPath }
								</li>
							) ) }
						</ul>
					</Field>
				) : null }
				{ operation.remote ? (
					<Field label={ __( 'Remote' ) }>
						<span className={ styles.text }>{ operation.remote }</span>
					</Field>
				) : null }
				<Field label={ __( 'Details' ) }>
					{ args ? (
						<ShownValue value={ args.value } />
					) : (
						<pre className={ styles.raw }>{ operation.args }</pre>
					) }
				</Field>
				{ draft ? (
					<>
						<Field label={ __( 'Site' ) }>{ draft.siteName }</Field>
						<Field label={ __( 'Draft title' ) }>{ draft.title }</Field>
						{ draft.content !== undefined ? (
							<Field label={ __( 'Content' ) }>
								<pre className={ styles.raw }>{ draft.content }</pre>
							</Field>
						) : null }
					</>
				) : null }
			</dl>
			<div className={ styles.actions }>
				<Button aria-describedby={ described } onClick={ onAllow }>
					{ __( 'Allow' ) }
				</Button>
				<Button variant="outline" aria-describedby={ described } onClick={ onDeny }>
					{ __( 'Deny' ) }
				</Button>
			</div>
		</div>
	);
}
