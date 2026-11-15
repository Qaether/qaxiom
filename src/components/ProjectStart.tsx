import { useState } from 'react';
import { Cloud, FolderOpen, Pencil, Trash2 } from 'lucide-react';
import { chooseWorkspaceDirectory, workspaceDirectoryPicker, type WorkspaceDirectoryHandle } from '../services/folderExport';

export interface OpenedProject {
  name: string;
  folderName: string;
  directory: WorkspaceDirectoryHandle;
}

export default function ProjectStart({ onOpen, onReconnect, onSelectProject, onRenameProject, onDeleteProject, remembered, projects, initialError }: {
  onOpen: (project: OpenedProject) => Promise<void>;
  onReconnect: () => Promise<void>;
  onSelectProject?: (project: OpenedProject) => Promise<void>;
  onRenameProject?: (oldName: string, newName: string) => Promise<void>;
  onDeleteProject?: (project: OpenedProject) => Promise<void>;
  remembered?: OpenedProject | null;
  projects?: OpenedProject[];
  initialError?: string;
}) {
  const [name, setName] = useState('');
  const [directory, setDirectory] = useState<WorkspaceDirectoryHandle | null>(null);
  const [folderName, setFolderName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [confirmDeleteName, setConfirmDeleteName] = useState<string | null>(null);
  const supported = Boolean(workspaceDirectoryPicker());

  const projectList: OpenedProject[] = (projects && projects.length > 0)
    ? projects
    : (remembered ? [remembered] : []);

  const chooseFolder = async () => {
    setBusy(true); setError('');
    try {
      const selected = await chooseWorkspaceDirectory();
      setDirectory(selected);
      setFolderName((selected as WorkspaceDirectoryHandle & { name?: string }).name || 'Selected folder');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to open folder.');
    } finally {
      setBusy(false);
    }
  };

  const run = async (task: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await task(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Failed to open project.'); }
    finally { setBusy(false); }
  };

  return <main className="project-start" aria-labelledby="project-start-heading">
    <div className="project-start-card">
      <div className="project-start-top-bar">
        <span className="project-start-eyebrow">Qaxiom Research Workspace</span>
        <button
          type="button"
          className="signin-btn"
          onClick={() => alert('Cloud sync and account sign-in are coming soon.')}
          title="Cloud sign-in (coming soon)"
          aria-label="Sign In"
        >
          <Cloud size={14} />
          <span>Sign In</span>
        </button>
      </div>
      <h1 id="project-start-heading">Projects</h1>
      <p className="project-start-desc">Select a research project to work on or create a new local project.</p>
      {projectList.length > 0 && <section className="project-start-section" aria-label="Projects">
        <h2>Projects</h2>
        <div className="projects-list">
          {projectList.map((proj, idx) => {
            const isEditing = editingName === proj.name;
            const isConfirmingDelete = confirmDeleteName === proj.name;
            return (
              <div key={proj.name + idx} className="project-list-item">
                <div className="project-list-info">
                  {isEditing ? (
                    <div className="project-rename-row">
                      <input
                        type="text"
                        aria-label={`New project name for ${proj.name}`}
                        value={draftName}
                        maxLength={200}
                        disabled={busy}
                        autoFocus
                        onChange={event => setDraftName(event.target.value)}
                        onKeyDown={event => {
                          if (event.key === 'Enter' && draftName.trim() && onRenameProject) {
                            event.preventDefault();
                            void run(async () => {
                              await onRenameProject(proj.name, draftName.trim());
                              setEditingName(null);
                              setDraftName('');
                            });
                          } else if (event.key === 'Escape') {
                            setEditingName(null);
                            setDraftName('');
                          }
                        }}
                      />
                    </div>
                  ) : (
                    <div className="project-list-title-row">
                      <FolderOpen size={16} className="project-list-icon" />
                      <strong className="project-list-title">{proj.name}</strong>
                    </div>
                  )}
                  <span className="project-list-folder">
                    {isConfirmingDelete
                      ? 'Remove from list? (Local folder files will not be deleted)'
                      : `Selected folder: ${proj.folderName}`}
                  </span>
                </div>
                <div className="project-list-actions">
                  {isEditing ? (
                    <>
                      <button
                        type="button"
                        className="project-save-btn"
                        disabled={busy || !draftName.trim()}
                        onClick={() => void run(async () => {
                          if (!onRenameProject) return;
                          await onRenameProject(proj.name, draftName.trim());
                          setEditingName(null);
                          setDraftName('');
                        })}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="project-secondary-btn"
                        disabled={busy}
                        onClick={() => { setEditingName(null); setDraftName(''); }}
                      >
                        Cancel
                      </button>
                    </>
                  ) : isConfirmingDelete ? (
                    <>
                      <button
                        type="button"
                        className="project-danger-btn"
                        disabled={busy}
                        onClick={() => void run(async () => {
                          if (!onDeleteProject) return;
                          await onDeleteProject(proj);
                          setConfirmDeleteName(null);
                        })}
                      >
                        Confirm delete
                      </button>
                      <button
                        type="button"
                        className="project-secondary-btn"
                        disabled={busy}
                        onClick={() => setConfirmDeleteName(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      {onRenameProject && (
                        <button
                          type="button"
                          className="project-icon-btn"
                          disabled={busy}
                          aria-label={`Rename ${proj.name}`}
                          title="Rename"
                          onClick={() => {
                            setError('');
                            setConfirmDeleteName(null);
                            setEditingName(proj.name);
                            setDraftName(proj.name);
                          }}
                        >
                          <Pencil size={14} />
                        </button>
                      )}
                      {onDeleteProject && (
                        <button
                          type="button"
                          className="project-icon-btn project-icon-danger"
                          disabled={busy}
                          aria-label={`Delete ${proj.name}`}
                          title="Remove from list"
                          onClick={() => {
                            setError('');
                            setEditingName(null);
                            setConfirmDeleteName(proj.name);
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="project-open-btn"
                        disabled={busy}
                        onClick={() => void run(() => onSelectProject ? onSelectProject(proj) : onReconnect())}
                      >
                        Open
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>}
      <section className="project-start-section" aria-label="New project setup">
        <h2>New Project</h2>
        <label htmlFor="project-name">Project name</label>
        <input id="project-name" value={name} maxLength={200} onChange={event => setName(event.target.value)} placeholder="e.g. Quantum Spin Model" />
        <div className="project-start-folder">
          <button type="button" disabled={busy || !supported} onClick={() => void chooseFolder()}>Choose local folder</button>
          <span>{directory ? `Selected folder: ${folderName}` : 'No folder selected.'}</span>
        </div>
        {!supported && <p role="note">Local folder selection is not supported in this browser. Please reopen in a supported browser.</p>}
        <p className="project-start-warning">Prototype stage: per-project data isolation and saving canonical .md files to the folder are not yet connected. Documents and chats remain in browser storage and are not automatically saved to the selected folder.</p>
        {(error || initialError) && <p role="alert" className="project-start-error">{error || initialError}</p>}
        <button type="button" className="project-start-primary" disabled={busy || !name.trim() || !directory}
          onClick={() => void run(() => onOpen({ name: name.trim(), folderName, directory: directory! }))}>Open workspace</button>
      </section>
    </div>
  </main>;
}
