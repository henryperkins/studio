import {
	escapeClaudeApprovalText,
	getClaudeApprovalDisplayArgs,
} from '@studio/agent/protocol/claude-code';
import { createInterpolateElement } from '@wordpress/element';
import { __, _x, sprintf } from '@wordpress/i18n';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Button, VisuallyHidden } from '@/lib/ui';
import styles from './style.module.css';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';
import type { ClaudeStudioTarget } from '@studio/agent/protocol/claude-code';

type ClaudeApprovalRequest = Extract< BackendTurnEvent, { type: 'approval.requested' } >;

// The labels of the argument names the Studio tools' approvals carry. Any other
// name is shown as it is.
function getFieldLabel( name: string ): string {
	switch ( name ) {
		case 'method':
			return _x( 'Method', 'Claude approval field label' );
		case 'path':
			return _x( 'Path', 'Claude approval field label' );
		case 'type':
			return _x( 'Type', 'Claude approval field label' );
		case 'message':
			return _x( 'Message', 'Claude approval field label' );
		case 'images':
			return _x( 'Images', 'Claude approval field label' );
		case 'subject':
			return _x( 'Subject', 'Claude approval field label' );
		case 'pageContext':
			return _x( 'Page context', 'Claude approval field label' );
		case 'style':
			return _x( 'Style', 'Claude approval field label' );
		case 'aspectRatio':
			return _x( 'Aspect ratio', 'Claude approval field label' );
		case 'siteContext':
			return _x( 'Site context', 'Claude approval field label' );
		case 'imageGrade':
			return _x( 'Image grade', 'Claude approval field label' );
		case 'direction':
			return _x( 'Direction', 'Claude approval field label' );
		case 'remoteSite':
			return _x( 'WordPress.com site', 'Claude approval field label' );
		case 'overwrites':
			return _x( 'Replaces', 'Claude approval field label' );
		case 'id':
			return _x( 'ID', 'Claude approval field label' );
		case 'name':
			return _x( 'Name', 'Claude approval field label' );
		case 'address':
			return _x( 'Address', 'Claude approval field label' );
		case 'kind':
			return _x( 'Kind', 'Claude approval field label' );
		case 'deleteFiles':
			return _x( 'Delete files on disk', 'Claude approval field label' );
		case 'mode':
			return _x( 'Mode', 'Claude approval field label' );
		case 'command':
			return _x( 'Command', 'Claude approval field label' );
		case 'siteId':
			return _x( 'Site ID', 'Claude approval field label' );
		case 'fileNames':
			return _x( 'File names', 'Claude approval field label' );
		case 'ready':
			return _x( 'Completed attachments', 'Claude approval field label' );
		case 'failed':
			return _x( 'Failed attachments', 'Claude approval field label' );
		default:
			return escapeClaudeApprovalText( name );
	}
}

function getTargetLabel( target: ClaudeStudioTarget, siteName?: string ): ReactNode {
	if ( target.environment === 'global' ) return __( 'Studio as a whole, not one site' );
	const local = <ShownText value={ siteName ?? target.siteId } />;
	if ( target.environment === 'live' )
		return createInterpolateElement(
			/* translators: <remote/> is the WordPress.com site ID. <local/> is the connected local site's name. */
			__( 'The live WordPress.com site <remote/>, connected to <local/>' ),
			{ remote: <bdi>{ target.wpcomSiteId }</bdi>, local }
		);
	return createInterpolateElement(
		/* translators: <local/> is the local site's name. */
		__( '<local/>, the local site' ),
		{ local }
	);
}

// The arguments arrive as escaped JSON. Parsing turns an escape back into the
// character it stands for, so every string is escaped again before it is shown.
function parseArguments( tool: string, args: string ): { value: unknown } | undefined {
	try {
		return { value: getClaudeApprovalDisplayArgs( tool, JSON.parse( args ) as unknown ) };
	} catch {
		return undefined;
	}
}

function Field( { id, label, children }: { id?: string; label: string; children: ReactNode } ) {
	return (
		<div id={ id } className={ styles.field }>
			<dt className={ styles.label }>{ label }</dt>
			<dd className={ styles.value }>{ children }</dd>
		</div>
	);
}

function ShownText( { value }: { value: string } ) {
	const text = escapeClaudeApprovalText( value );
	return /[\n\u2028\u2029]/u.test( text ) ? (
		<blockquote className={ styles.quotation } dir="auto">
			{ text }
		</blockquote>
	) : (
		<bdi className={ styles.text }>{ text }</bdi>
	);
}

function ShownValue( { value }: { value: unknown } ) {
	if ( typeof value === 'string' ) return <ShownText value={ value } />;
	if ( typeof value === 'boolean' )
		return (
			<bdi>
				{ value ? _x( 'Yes', 'Claude approval value' ) : _x( 'No', 'Claude approval value' ) }
			</bdi>
		);
	if ( value === null || typeof value !== 'object' ) return <bdi>{ String( value ) }</bdi>;
	if ( Array.isArray( value ) ) {
		if ( ! value.length )
			return <bdi className={ styles.none }>{ _x( 'None', 'Claude approval value' ) }</bdi>;
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
	if ( ! entries.length )
		return <bdi className={ styles.none }>{ _x( 'None', 'Claude approval value' ) }</bdi>;
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
	const args = parseArguments( operation.tool, operation.args );
	const description = escapeClaudeApprovalText( request.description );
	const [ announced, setAnnounced ] = useState( false );
	useEffect( () => {
		const frame = requestAnimationFrame( () => setAnnounced( true ) );
		return () => cancelAnimationFrame( frame );
	}, [] );
	const described = `${ id }-description`;
	const labels = [ `${ id }-title`, `${ id }-tool` ];
	if ( operation.remote ) labels.push( `${ id }-remote` );
	if ( operation.tool === 'sites.delete' ) labels.push( `${ id }-details` );
	return (
		<div role="group" aria-labelledby={ labels.join( ' ' ) } className={ styles.card }>
			<VisuallyHidden role="status" aria-live="polite">
				{ announced &&
					sprintf(
						/* translators: %s describes the operation awaiting approval. */
						__( 'Approval requested. %s' ),
						description
					) }
			</VisuallyHidden>
			<p id={ `${ id }-title` } className={ styles.title }>
				{ __( 'Allow this operation?' ) }
			</p>
			<p id={ `${ id }-description` } className={ styles.description }>
				{ description }
			</p>
			<dl className={ styles.fields }>
				<Field label={ _x( 'Operation', 'Claude approval field label' ) }>
					<bdi id={ `${ id }-tool` } className={ styles.code }>
						{ escapeClaudeApprovalText( operation.tool ) }
					</bdi>
				</Field>
				<Field label={ __( 'Acts on' ) }>{ getTargetLabel( operation.target, siteName ) }</Field>
				{ operation.localPaths.length ? (
					<Field label={ __( 'Local files and folders' ) }>
						<ul className={ styles.paths }>
							{ operation.localPaths.map( ( localPath, index ) => (
								<li key={ index } className={ styles.code }>
									<ShownText value={ localPath } />
								</li>
							) ) }
						</ul>
					</Field>
				) : null }
				{ operation.remote ? (
					<Field label={ _x( 'Remote', 'Claude approval field label' ) }>
						<div id={ `${ id }-remote` }>
							<ShownText value={ operation.remote } />
						</div>
					</Field>
				) : null }
				<Field id={ `${ id }-details` } label={ _x( 'Details', 'Claude approval field label' ) }>
					{ args ? (
						<ShownValue value={ args.value } />
					) : (
						<div className={ styles.raw }>
							<ShownText value={ operation.args } />
						</div>
					) }
				</Field>
				{ draft ? (
					<>
						<Field label={ _x( 'Site', 'Claude approval field label' ) }>
							<ShownText value={ draft.siteName } />
						</Field>
						<Field label={ __( 'Draft title' ) }>
							<ShownText value={ draft.title } />
						</Field>
						{ draft.content !== undefined ? (
							<Field label={ _x( 'Content', 'Claude approval field label' ) }>
								<div className={ styles.raw }>
									<ShownText value={ draft.content } />
								</div>
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
