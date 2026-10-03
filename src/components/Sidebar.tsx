import React, { useEffect, useRef } from 'react';
import { 
  Plus, 
  BookMarked, 
  ShieldCheck, 
  Cpu,
  X,
  Folder,
  ArrowRightLeft,
  Settings,
  Cloud
} from 'lucide-react';

interface SidebarProps {
  projectName: string;
  documents: { id: string; title: string; version: number }[];
  onOpenDocument: (id: string) => void;
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
      aria-label="대화 메뉴"
      onKeyDown={handleMobileKeyDown}
    >
      {/* Top Section: Brand, Project Switcher, New Theory Action */}
      <div className="sidebar-top-section">
        {/* Brand Header (Click to switch / manage project) */}
        <div className="sidebar-brand-wrapper">
          <button
            type="button"
            className="sidebar-brand-btn"
            onClick={onChangeProject}
            title="프로젝트 관리 / 전환 화면으로 이동"
            aria-label="프로젝트 관리 / 전환 화면으로 이동"
          >
            <div className="brand-logo">
              <Cpu className="brand-icon" size={22} />
            </div>
            <div className="brand-text">
              <span className="brand-title">Qaxiom</span>
              <span className="brand-subtitle">Research Intelligence</span>
            </div>
          </button>
          {mobileOpen && (
            <button ref={closeButtonRef} type="button" className="mobile-menu-close" onClick={onCloseMobile} aria-label="대화 메뉴 닫기">
              <X size={20} />
            </button>
          )}
        </div>

        {/* Project Switcher Card */}
        <button
          type="button"
          className="sidebar-project-card"
          onClick={onChangeProject}
          title="클릭하여 프로젝트 전환 또는 관리"
          aria-label={`현재 프로젝트: ${projectName}. 클릭하여 프로젝트 관리 화면으로 이동`}
        >
          <div className="project-card-header">
            <Folder size={14} className="project-icon" />
            <span className="project-label">현재 프로젝트</span>
            <ArrowRightLeft size={12} className="project-switch-icon" />
          </div>
          <strong className="project-name">{projectName}</strong>
        </button>

        {/* Primary document action */}
        <div className="sidebar-actions">
          <button id="new-theory-btn" className="new-chat-button" onClick={onOpenTheory}>
            <Plus size={18} />
            <span>새 연구 문서</span>
          </button>
        </div>

        {/* Research Documents moved right below 새 연구 문서 */}
        <div className="sidebar-section sidebar-documents">
          <div className="section-label"><BookMarked size={13} /><span>연구 문서 ({documents.length})</span></div>
          <div className="session-list">
            {!documents.length && <p className="empty-sessions">아직 만든 연구 문서가 없습니다.</p>}
            {documents.map(document => (
              <button
                type="button"
                className="sidebar-document"
                key={document.id}
                onClick={() => onOpenDocument(document.id)}
              >
                {document.title} <small>v{document.version}</small>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Spacer pushing the following elements to the bottom */}
      <div className="sidebar-spacer" />

      {/* Bottom Section: Wiki, References, and Footer Actions */}
      <div className="sidebar-bottom-section">

        {/* Wiki uses the authoritative theory-document workspace. */}
        <div className="sidebar-section wiki-banner-section">
          <div className="wiki-banner">
            <div className="wiki-banner-icon">
              <BookMarked size={16} />
            </div>
            <div className="wiki-banner-content">
              <div className="wiki-banner-title">LLM Research Wiki</div>
              <div className="wiki-banner-desc">연구 문서에서 주장·원문 탐색</div>
            </div>
            <span className="coming-tag">문서 내</span>
          </div>
        </div>

        {/* Sidebar Footer */}
        <div className="sidebar-footer">
          <button className="settings-button" type="button" onClick={onOpenReferences}>
            <BookMarked size={15} />
            <span>레퍼런스 검색</span>
          </button>

          <div className="sidebar-footer-actions">
            <button
              type="button"
              className="sidebar-action-btn signin"
              onClick={() => alert('클라우드 동기화 및 협업 서비스는 준비 중입니다.')}
              title="클라우드 로그인 (준비 중)"
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
              title="설정 (API 키)"
              aria-label="설정 (API 키)"
            >
              <Settings size={14} />
              <span>설정</span>
            </button>
          </div>

          <div className="storage-badge">
            <ShieldCheck size={12} className="shield-icon" />
            <span>Local-First (PC 로컬 저장)</span>
          </div>
        </div>
      </div>
    </aside>
  );
};
