import React, { useEffect, useRef } from 'react';
import {
  Plus,
  BookMarked,
  ShieldCheck,
  X,
  Folder,
  ArrowRightLeft,
  Settings,
  Cloud,
  Trash2
} from 'lucide-react';
import { QaxiomLogo } from './QaxiomLogo';

interface SidebarProps {
  projectName: string;
  documents: { id: string; title: string; version: number }[];
  onOpenDocument: (id: string) => void;
  onDeleteDocument: (id: string, trigger: HTMLButtonElement) => void;
  onChangeProject: () => void;
  onOpenTheory: () => void;
  onOpenReferences: () => void;
  onOpenSettings: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  width?: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  projectName,
  documents,
  onOpenDocument,
  onDeleteDocument,
  onChangeProject,
  onOpenTheory,
  onOpenReferences,
  onOpenSettings,
  mobileOpen,
  onCloseMobile,
  width
}) => {
  const sidebarRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (mobileOpen) closeButtonRef.current?.focus();
  }, [mobileOpen]);

  const handleMobileKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!mobileOpen) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCloseMobile();
      return;
    }
    if (event.key !== 'Tab' || !sidebarRef.current) return;
    const focusable = Array.from(sidebarRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'))
      .filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible');
    if (!focusable.length) return;
    if (event.shiftKey && document.activeElement === focusable[0]) {
      event.preventDefault();
      focusable[focusable.length - 1].scrollIntoView({ block: 'nearest' });
      focusable[focusable.length - 1].focus({ preventScroll: true });
    } else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) {
      event.preventDefault();
      focusable[0].focus();
    }
  };

  return (
    <aside
      ref={sidebarRef}
      id="chat-sidebar"
      className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}
      style={{ width: width ? `${width}px` : undefined }}
      role={mobileOpen ? 'dialog' : undefined}
      aria-modal={mobileOpen ? 'true' : undefined}
      aria-label="Chat menu"
      onKeyDown={handleMobileKeyDown}
    >
      {/* Top Section: Brand, Project Switcher, New Theory Action */}
      <div className="sidebar-top-section">
        {/* Brand Header (Click to switch / manage project) */}
        <div className="sidebar-brand-wrapper">
          <button
            type="button"
            className="sidebar-brand-btn topbar-tooltip"
            onClick={onChangeProject}
            data-tooltip="Manage projects"
            aria-label="Go to project management / switcher"
          >
            <div className="brand-logo">
              <QaxiomLogo size={24} />
            </div>
            <div className="brand-text">
              <span className="brand-title">Qaxiom</span>
              <span className="brand-subtitle">Research Intelligence</span>
            </div>
          </button>
          {mobileOpen && (
            <button ref={closeButtonRef} type="button" className="mobile-menu-close topbar-tooltip" onClick={onCloseMobile} data-tooltip="Close chat menu" aria-label="Close chat menu">
              <X size={20} />
            </button>
          )}
        </div>

        {/* Project Switcher Card */}
        <button
          type="button"
          className="sidebar-project-card"
          onClick={onChangeProject}
          title="Click to switch or manage projects"
          aria-label={`Current project: ${projectName}. Click to open project management`}
        >
          <div className="project-card-header">
            <Folder size={14} className="project-icon" />
            <span className="project-label">Current Project</span>
            <ArrowRightLeft size={12} className="project-switch-icon" />
          </div>
          <strong className="project-name">{projectName}</strong>
        </button>

        {/* Primary document action */}
        <div className="sidebar-actions">
          <button id="new-theory-btn" className="new-chat-button" onClick={onOpenTheory}>
            <Plus size={18} />
            <span>New Research Note</span>
          </button>
        </div>

        {/* Research Documents moved right below New Research Note */}
        <div className="sidebar-section sidebar-documents">
          <div className="section-label"><BookMarked size={13} /><span>Research Notes ({documents.length})</span></div>
          <div className="session-list">
            {!documents.length && <p className="empty-sessions">No research notes yet.</p>}
            {documents.map(document => (
              <div className="sidebar-document-row" key={document.id}>
                <button
                  type="button"
                  className="sidebar-document"
                  onClick={() => onOpenDocument(document.id)}
                >
                  <span className="sidebar-document-title">{document.title}</span>
                  <small>v{document.version}</small>
                </button>
                <button
                  type="button"
                  className="sidebar-document-delete"
                  aria-label={`Delete document ${document.title}`}
                  title={`Delete document ${document.title}`}
                  onClick={event => onDeleteDocument(document.id, event.currentTarget)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Spacer pushing the following elements to the bottom */}
      <div className="sidebar-spacer" />

      {/* Bottom Section: References and Footer Actions */}
      <div className="sidebar-bottom-section">
        {/* Sidebar Footer */}
        <div className="sidebar-footer">
          <button className="settings-button" type="button" onClick={onOpenReferences}>
            <BookMarked size={15} />
            <span>Project References</span>
          </button>

          <div className="sidebar-footer-actions">
            <button
              type="button"
              className="sidebar-action-btn signin"
              onClick={() => alert('Cloud sync and collaboration features are coming soon.')}
              title="Cloud sign-in (coming soon)"
              aria-label="Sign In"
            >
              <Cloud size={14} />
              <span>Sign In</span>
            </button>

            <button
              id="open-settings-btn"
              type="button"
              className="sidebar-action-btn settings"
              onClick={onOpenSettings}
              title="Settings (Local CLI)"
              aria-label="Settings (Local CLI)"
            >
              <Settings size={14} />
              <span>Settings</span>
            </button>
          </div>

          <div className="storage-badge">
            <ShieldCheck size={12} className="shield-icon" />
            <span>Local-First (Saved Locally)</span>
          </div>
        </div>
      </div>
    </aside>
  );
};
