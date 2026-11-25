'use client';
import { createContext, useContext } from 'react';
import type {
  ResolvedBlock,
  ResolvedDocument,
  ResolvedFieldLink,
  ResolvedInline,
} from '@/domain/resolution/model';
import { plainIssue, type Issue, type IssueField } from './api';

/** Lets a live preview link values back to their questions; absent on sample previews. */
export type PreviewLinks = {
  activeFieldIds: string[];
  highlightClause: string | null;
  candidateKey: string;
  onField?: (field: ResolvedFieldLink) => void;
  onSignatures?: () => void;
};
const Links = createContext<PreviewLinks | null>(null);

function blockClass(block: ResolvedBlock, links: PreviewLinks | null) {
  if (!links || !block.clauseKey) return '';
  if (block.clauseKey === links.candidateKey) return 'doc-candidate';
  return block.clauseKey === links.highlightClause ? 'doc-highlight' : '';
}

function Runs({ runs }: { runs: ResolvedInline[] }) {
  const links = useContext(Links);
  return (
    <>
      {runs.map((run, index) => {
        if ('break' in run) return <br key={index} />;
        let node: React.ReactNode = run.text;
        if (run.marks?.includes('strike')) node = <s>{node}</s>;
        if (run.marks?.includes('underline')) node = <u>{node}</u>;
        if (run.marks?.includes('italic')) node = <em>{node}</em>;
        if (run.marks?.includes('bold')) node = <strong>{node}</strong>;
        const field = run.field;
        if (field && links) {
          const className = `doc-field${field.missing ? ' missing' : ''}${links.activeFieldIds.includes(field.id) ? ' active' : ''}`;
          return links.onField ? (
            <button
              type="button"
              key={index}
              className={className}
              data-doc-field={field.id}
              onClick={() => links.onField?.(field)}
            >
              {node}
            </button>
          ) : (
            <span key={index} className={className} data-doc-field={field.id}>
              {node}
            </span>
          );
        }
        return <span key={index}>{node}</span>;
      })}
    </>
  );
}

function Blocks({ blocks }: { blocks: ResolvedBlock[] }) {
  const links = useContext(Links);
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'paragraph':
            return (
              <p
                key={index}
                style={{
                  textAlign: block.align,
                  marginLeft: block.indent ? `${block.indent * 2}em` : undefined,
                }}
                className={
                  `${block.number ? 'numbered ' : ''}${blockClass(block, links)}`.trim() ||
                  undefined
                }
              >
                {block.number ? <span className="clause-number">{block.number}</span> : null}
                <span>
                  <Runs runs={block.runs} />
                </span>
              </p>
            );
          case 'heading': {
            const Tag = (['h2', 'h3', 'h4'] as const)[block.level - 1];
            return (
              <Tag
                key={index}
                className={blockClass(block, links) || undefined}
                style={{ textAlign: block.align }}
              >
                <Runs runs={block.runs} />
              </Tag>
            );
          }
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';
            return (
              <Tag key={index} className={blockClass(block, links) || undefined}>
                {block.items.map((item, i) => (
                  <li key={i}>
                    <Blocks blocks={item} />
                  </li>
                ))}
              </Tag>
            );
          }
          case 'table':
            return (
              <div
                className={`document-table ${block.border && block.border !== 'grid' ? `border-${block.border} ` : ''}${blockClass(block, links)}`.trim()}
                key={index}
              >
                <table>
                  {block.columnWidths ? (
                    <colgroup>
                      {block.columnWidths.map((width, i) => (
                        <col key={i} style={{ width: `${width}%` }} />
                      ))}
                    </colgroup>
                  ) : null}
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>
                        {row.cells.map((cell, c) =>
                          row.header ? (
                            <th key={c} scope="col">
                              <Blocks blocks={cell} />
                            </th>
                          ) : (
                            <td key={c}>
                              <Blocks blocks={cell} />
                            </td>
                          ),
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'pageBreak':
            return (
              <div key={index} className="document-page-break" role="separator">
                <span>Page break</span>
              </div>
            );
          case 'section':
            return (
              <div key={index} className="document-page-break" role="separator">
                <span>New page, {block.orientation}</span>
              </div>
            );
          case 'signatures':
            return (
              <div key={index} className="document-signatures">
                {block.heading ? <p className="signature-heading">{block.heading}</p> : null}
                {links?.onSignatures ? (
                  <button type="button" className="doc-signers-link" onClick={links.onSignatures}>
                    Change signers
                  </button>
                ) : null}
                <div
                  className="signature-grid"
                  style={{ gridTemplateColumns: `repeat(${block.columns}, minmax(0, 1fr))` }}
                >
                  {block.signers.map((signer, i) => (
                    <div key={i} className="signature">
                      <div className="signature-line" />
                      <div>{signer.label || signer.name}</div>
                      {block.showDate ? <div className="signature-date">Date:</div> : null}
                    </div>
                  ))}
                </div>
                {!block.signers.length ? (
                  <p className="metadata">No signers selected for this role.</p>
                ) : null}
              </div>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

/** Page-like view of the same resolved document the DOCX renderer consumes. */
export function DocumentPreview({
  document,
  issues = [],
  onIssue,
  fields,
  links = null,
  plain = false,
}: {
  document: ResolvedDocument | null;
  issues?: Issue[];
  onIssue?: (issue: Issue) => void;
  /** Lets issues name the field as the reader sees it. */
  fields?: IssueField[];
  links?: PreviewLinks | null;
  /** Only the page, for a panel that shows issues and notes itself. */
  plain?: boolean;
}) {
  return (
    <div className="document-preview">
      {issues.length ? (
        <div className="warning" role="alert">
          <strong>To resolve before generating</strong>
          <ul>
            {issues.map((issue, index) => (
              <li key={index}>
                {onIssue ? (
                  <button type="button" className="text-button" onClick={() => onIssue(issue)}>
                    {plainIssue(issue, fields)}
                  </button>
                ) : (
                  plainIssue(issue, fields)
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {document ? (
        <>
          {plain ? null : (
            <details className="advanced-filters">
              <summary>Preview details</summary>
              <dl className="record-meta">
                <div>
                  <dt>Pagination</dt>
                  <dd>Final page breaks are set by Word</dd>
                </div>
                {document.containsSamples ? (
                  <div>
                    <dt>Values</dt>
                    <dd>Fictional samples</dd>
                  </div>
                ) : null}
              </dl>
            </details>
          )}
          <div className="document-scroll">
            <article
              className="document-page"
              aria-label={`Preview of ${document.title}`}
              style={{
                fontFamily: document.layout.fontFamily,
                fontSize: `${document.layout.fontSizePt}pt`,
                padding: `${document.layout.marginsMm.top}mm ${document.layout.marginsMm.right}mm ${document.layout.marginsMm.bottom}mm ${document.layout.marginsMm.left}mm`,
              }}
            >
              {document.layout.header ? (
                <div className="document-running">
                  {document.layout.headerRuns?.length ? (
                    <span>
                      <Runs runs={document.layout.headerRuns} />
                    </span>
                  ) : (
                    document.layout.header
                  )}
                </div>
              ) : null}
              <Links.Provider value={links}>
                <Blocks blocks={document.blocks} />
              </Links.Provider>
              {document.layout.footer ? (
                <div className="document-running footer">
                  {document.layout.footerRuns?.length ? (
                    <span>
                      <Runs runs={document.layout.footerRuns} />
                    </span>
                  ) : (
                    document.layout.footer
                  )}
                </div>
              ) : null}
            </article>
          </div>
        </>
      ) : null}
    </div>
  );
}
