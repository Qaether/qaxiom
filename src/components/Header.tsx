import React from 'react';
import { Settings, Menu, Folder, Cloud, FileText } from 'lucide-react';
import { QaxiomLogo } from './QaxiomLogo';

interface HeaderProps {
  projectName?: string;
  onOpenProject?: () => void;
  onOpenSettings: () => void;
  onOpenSidebar: () => void;
  sidebarOpen: boolean;
  menuButtonRef: React.RefObject<HTMLButtonElement | null>;
  activeDocumentTitle?: string;
}

export const Header: React.FC<HeaderProps> = ({
  projectName,
  onOpenProject,
  onOpenSettings,
  onOpenSidebar,
  sidebarOpen,
  menuButtonRef,
  activeDocumentTitle
}) => {
  return (
    <header className="chat-header top-navbar">
      {/* Brand & Project Switcher */}
      <div className="header-left">
        <button
          ref={menuButtonRef}
          type="button"
          id="mobile-menu-btn"
          className="mobile-menu-btn"
          onClick={onOpenSidebar}
          aria-label="Open chat menu"
          aria-expanded={sidebarOpen}
          aria-controls="chat-sidebar"
        >
          <Menu size={18} />
        </button>

        <button
          type="button"
          className="top-navbar-brand-btn"
          onClick={onOpenProject}
          title="Go to project management / switcher"
          aria-label="Go to Qaxiom home and project management"
        >
          <div className="top-brand-icon">
            <QaxiomLogo size={18} />
          </div>
          <span className="top-brand-title">Qaxiom</span>
        </button>

        {projectName && (
          <button
            type="button"
            className="header-project-chip"
            onClick={onOpenProject}
            title="Go to project management / switcher"
            aria-label={`Current project: ${projectName}. Click to open project management`}
          >
            <Folder size={13} className="header-project-icon" />
            <span className="header-project-name">{projectName}</span>
          </button>
        )}
      </div>

      {/* Center: Current active document title or workspace status */}
      <div className="header-center">
        {activeDocumentTitle ? (
          <div className="active-doc-badge" title={`Current research note: ${activeDocumentTitle}`}>
            <FileText size={13} className="active-doc-icon" />
            <span className="active-doc-title">{activeDocumentTitle}</span>
          </div>
        ) : (
          <div className="active-doc-badge empty" title="Research note workspace">
            <FileText size={13} className="active-doc-icon" />
            <span className="active-doc-title">Research Note Workspace</span>
          </div>
        )}
      </div>

      {/* Right Controls: Sign In & Settings */}
      <div className="header-right">
        {/* Sign In Button */}
        <button
          type="button"
          className="header-signin-btn"
          onClick={() => alert('Cloud sync and collaboration features are coming soon.')}
          title="Cloud sign-in (coming soon)"
          aria-label="Sign In"
        >
          <Cloud size={14} />
          <span>Sign In</span>
        </button>

        {/* Settings Button */}
        <button
          id="open-settings-btn"
          className="header-btn primary"
          onClick={onOpenSettings}
          title="Settings (API Keys)"
          aria-label="Settings (API Keys)"
        >
          <Settings size={15} />
        </button>
      </div>
    </header>
  );
};
