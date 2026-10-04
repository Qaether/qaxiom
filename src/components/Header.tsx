import React from 'react';
import { Settings, Menu, Folder, Cloud, FileText, Atom } from 'lucide-react';

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
          aria-label="대화 메뉴 열기"
          aria-expanded={sidebarOpen}
          aria-controls="chat-sidebar"
        >
          <Menu size={18} />
        </button>

        <button
          type="button"
          className="top-navbar-brand-btn"
          onClick={onOpenProject}
          title="프로젝트 관리 / 전환 화면으로 이동"
          aria-label="Qaxiom 홈 및 프로젝트 관리 화면으로 이동"
        >
          <div className="top-brand-icon">
            <Atom size={16} />
          </div>
          <span className="top-brand-title">Qaxiom</span>
        </button>

        {projectName && (
          <button
            type="button"
            className="header-project-chip"
            onClick={onOpenProject}
            title="프로젝트 관리 / 전환 화면으로 이동"
            aria-label={`현재 프로젝트: ${projectName}. 클릭하여 프로젝트 관리 화면으로 이동`}
          >
            <Folder size={13} className="header-project-icon" />
            <span className="header-project-name">{projectName}</span>
          </button>
        )}
      </div>

      {/* Center: Current active document title or workspace status */}
      <div className="header-center">
        {activeDocumentTitle ? (
          <div className="active-doc-badge" title={`현재 연구노트: ${activeDocumentTitle}`}>
            <FileText size={13} className="active-doc-icon" />
            <span className="active-doc-title">{activeDocumentTitle}</span>
          </div>
        ) : (
          <div className="active-doc-badge empty" title="연구노트 작업 공간">
            <FileText size={13} className="active-doc-icon" />
            <span className="active-doc-title">연구노트 작업공간</span>
          </div>
        )}
      </div>

      {/* Right Controls: Sign In & Settings */}
      <div className="header-right">
        {/* Sign In Button */}
        <button
          type="button"
          className="header-signin-btn"
          onClick={() => alert('클라우드 동기화 및 협업 서비스는 준비 중입니다.')}
          title="클라우드 로그인 (준비 중)"
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
          title="설정 (API 키)"
          aria-label="설정 (API 키)"
        >
          <Settings size={15} />
        </button>
      </div>
    </header>
  );
};
