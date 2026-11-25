'use client';
import { useState } from 'react';
import Link from 'next/link';
import type { OfficerEvent } from '@/domain/model';
import type { ResolutionCase } from '@/domain/resolution/model';
import { caseStatus } from '@/domain/resolution/cases';
import { Empty, formatDate, formatDay, useWorkspace } from '@/components/workspace';
import { UploadForm } from '@/components/forms';
import { getJson, kindLabel } from '@/components/resolution/api';
import { Drawer } from '@/components/resolution/drawer';
import { LoadState, useLoad } from '@/components/resolution/use-load';

/** The Resolutions tab of a company record. */
export function CompanyResolutions({
  companyId,
  companyName,
}: {
  companyId: string;
  companyName: string;
}) {
  const { data } = useWorkspace();
  const resolutions = useLoad(
    () =>
      getJson<{ cases: ResolutionCase[] }>(
        '/api/resolution-cases?companyId=' + encodeURIComponent(companyId),
      ),
    [companyId],
  );
  return (
    <>
      <LoadState
        loading={resolutions.loading && !resolutions.data}
        error={resolutions.error}
        reload={() => void resolutions.reload()}
        label="resolutions"
      />
      {resolutions.data ? (
        resolutions.data.cases.length ? (
          <div className="table-wrap">
            <table className="records-table company-resolutions-table">
              <caption className="sr-only">Resolutions for {companyName}</caption>
              <thead>
                <tr>
                  <th>Resolution</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {resolutions.data.cases.map((item) => {
                  const status = caseStatus(
                    item,
                    (userId) => data?.users.find((u) => u.id === userId)?.name || userId,
                  );
                  return (
                    <tr key={item.id}>
                      <td title={item.title}>
                        <Link href={'/resolutions/' + item.id}>{item.title}</Link>
                      </td>
                      <td title={kindLabel(item.kind)}>{kindLabel(item.kind)}</td>
                      <td title={status}>{status}</td>
                      <td>{formatDay(item.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No resolutions</Empty>
        )
      ) : null}
    </>
  );
}

/** The Documents tab of a company record. */
export function CompanyDocuments({ companyId }: { companyId: string }) {
  const { data } = useWorkspace();
  const [uploading, setUploading] = useState(false);
  if (!data) return null;
  const documents = data.documents.filter((d) => d.companyId === companyId);
  const canUpload = data.actor.capabilities.includes('prepare_job');
  return (
    <>
      {canUpload ? (
        <div className="record-toolbar record-toolbar-end">
          <button type="button" onClick={() => setUploading(true)}>
            Upload document
          </button>
        </div>
      ) : null}
      {documents.length ? (
        <div className="table-wrap">
          <table className="records-table company-documents-table">
            <caption className="sr-only">Documents</caption>
            <thead>
              <tr>
                <th>Document</th>
                <th>File</th>
                <th>Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((document) => (
                <tr key={document.id}>
                  <td title={document.title}>
                    <a href={'/api/documents/' + document.id}>{document.title}</a>
                  </td>
                  <td title={document.originalName}>{document.originalName}</td>
                  <td>{formatDay(document.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No documents</Empty>
      )}
      {uploading ? (
        <Drawer title="Upload document" onClose={() => setUploading(false)}>
          <UploadForm companyId={companyId} />
        </Drawer>
      ) : null}
    </>
  );
}

/** The History tab of a company record: officer events with their source evidence. */
export function CompanyHistory({ companyId }: { companyId: string }) {
  const { data } = useWorkspace();
  const record = useLoad(
    () => getJson<{ events?: OfficerEvent[] }>('/api/companies/' + encodeURIComponent(companyId)),
    [companyId],
  );
  return (
    <>
      <LoadState
        loading={record.loading && !record.data}
        error={record.error}
        reload={() => void record.reload()}
        label="history"
      />
      {record.data ? (
        record.data.events?.length ? (
          <ul className="list-plain record-history">
            {record.data.events.map((event) => (
              <li key={event.id}>
                <strong>{event.personName}</strong>,{' '}
                <span className="event-route">{event.route.replaceAll('_', ' ')}</span>
                <p className="metadata">
                  Effective {formatDate(event.effectiveDate)}, entered {formatDay(event.recordedAt)}
                </p>
                {event.evidenceIds
                  .filter((evidenceId) => data?.documents.some((d) => d.id === evidenceId))
                  .map((evidenceId) => (
                    <a
                      className="evidence-link"
                      key={evidenceId}
                      href={'/api/documents/' + evidenceId}
                    >
                      View source evidence
                    </a>
                  ))}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No history yet</Empty>
        )
      ) : null}
    </>
  );
}
