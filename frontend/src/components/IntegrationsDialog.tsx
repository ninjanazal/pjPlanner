import { useEffect, useState } from 'react';
import { api } from '../api';
import { INTEGRATIONS } from '../integrations';
import type { Issue, JiraStatus, Project } from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import { Modal } from './Modal';
import { useAction } from './useAction';

export { ago } from './JiraIntegrationPanel';

interface Props {
  project: Project | null;
  issues?: Issue[];       // the project's issues, to show how many came from Jira
  onChanged: () => void;  // the project (its saved settings) changed
  onImported: () => void; // issues were imported
  onClose: () => void;
}

export function IntegrationsDialog({ project, issues = [], onChanged, onImported, onClose }: Props) {
  const { error, run } = useAction();
  const [status, setStatus] = useState<JiraStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => { run(async () => { setStatus(await api.jiraStatus()); }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const current = INTEGRATIONS.find((i) => i.id === selected) ?? null;
  const back = () => { if (dirty) setLeaving(true); else setSelected(null); };

  return (
    <Modal title="Integrations" onClose={onClose} dirty={dirty}>
      {error && <div className="banner error" role="alert">{error}</div>}
      {!status ? (error ? null : <p>Loading…</p>) : current ? (
        <>
          <button className="integ-back" onClick={back}>← Integrations</button>
          <current.Panel project={project} status={status} issues={issues} onChanged={onChanged} onImported={onImported} onDirty={setDirty} />
        </>
      ) : (
        <>
          <h3 className="integ-heading">Add or manage an integration</h3>
          <div className="integ-grid">
            {INTEGRATIONS.map((i) => {
              const text = i.summary({ project, status });
              return (
                <button key={i.id} className="integ-tile" aria-label={i.name} title={`${i.name}: ${text}`} onClick={() => setSelected(i.id)}>
                  <span aria-hidden="true">{i.icon}</span>
                  <span className={`status-dot integ-tile-dot ${text === 'Enabled' ? 'ok' : 'off'}`} role="img" aria-label={text} />
                </button>
              );
            })}
          </div>
        </>
      )}
      {leaving && (
        <ConfirmDialog title="Discard changes?" message="You have unsaved edits. Going back will discard them."
          confirmLabel="Discard" cancelLabel="Keep editing"
          onConfirm={() => { setLeaving(false); setDirty(false); setSelected(null); }} onCancel={() => setLeaving(false)} />
      )}
    </Modal>
  );
}
