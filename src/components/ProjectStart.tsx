import { useState } from 'react';
import { Cloud, FolderOpen } from 'lucide-react';
import { chooseWorkspaceDirectory, workspaceDirectoryPicker, type WorkspaceDirectoryHandle } from '../services/folderExport';

export interface OpenedProject {
  name: string;
  folderName: string;
  directory: WorkspaceDirectoryHandle;
}

export default function ProjectStart({ onOpen, onReconnect, onSelectProject, remembered, projects, initialError }: {
  onOpen: (project: OpenedProject) => Promise<void>;
  onReconnect: () => Promise<void>;
  onSelectProject?: (project: OpenedProject) => Promise<void>;
  remembered?: OpenedProject | null;
  projects?: OpenedProject[];
  initialError?: string;
}) {
  const [name, setName] = useState('');
  const [directory, setDirectory] = useState<WorkspaceDirectoryHandle | null>(null);
  const [folderName, setFolderName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const supported = Boolean(workspaceDirectoryPicker());

  const projectList: OpenedProject[] = (projects && projects.length > 0)
    ? projects
    : (remembered ? [remembered] : []);

  const chooseFolder = async () => {
    setBusy(true); setError('');
    try {
      const selected = await chooseWorkspaceDirectory();
      setDirectory(selected);
      setFolderName((selected as WorkspaceDirectoryHandle & { name?: string }).name || '선택한 폴더');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '폴더를 열지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const run = async (task: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await task(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '프로젝트를 열지 못했습니다.'); }
    finally { setBusy(false); }
  };

  return <main className="project-start" aria-labelledby="project-start-heading">
    <div className="project-start-card">
      <div className="project-start-top-bar">
        <span className="project-start-eyebrow">Qaxiom Research Workspace</span>
        <button
          type="button"
          className="signin-btn"
          onClick={() => alert('클라우드 서비스 및 계정 동기화 로그인은 준비 중입니다.')}
          title="클라우드 로그인 (준비 중)"
          aria-label="Sign In"
        >
          <Cloud size={14} />
          <span>Sign In</span>
        </button>
      </div>
      <h1 id="project-start-heading">Projects</h1>
      <p className="project-start-desc">작업할 연구 프로젝트를 선택하거나 새로운 로컬 프로젝트를 생성하세요.</p>
      {projectList.length > 0 && <section className="project-start-section" aria-label="Projects">
        <h2>Projects</h2>
        <div className="projects-list">
          {projectList.map((proj, idx) => (
            <div key={proj.name + idx} className="project-list-item">
              <div className="project-list-info">
                <div className="project-list-title-row">
                  <FolderOpen size={16} className="project-list-icon" />
                  <strong className="project-list-title">{proj.name}</strong>
                </div>
                <span className="project-list-folder">선택한 폴더: {proj.folderName}</span>
              </div>
              <button
                type="button"
                className="project-open-btn"
                disabled={busy}
                onClick={() => void run(() => onSelectProject ? onSelectProject(proj) : onReconnect())}
              >
                열기
              </button>
            </div>
          ))}
        </div>
      </section>}
      <section className="project-start-section" aria-label="새 프로젝트 설정">
        <h2>새 프로젝트</h2>
        <label htmlFor="project-name">프로젝트 이름</label>
        <input id="project-name" value={name} maxLength={200} onChange={event => setName(event.target.value)} placeholder="예: 양자 스핀 모형" />
        <div className="project-start-folder">
          <button type="button" disabled={busy || !supported} onClick={() => void chooseFolder()}>로컬 폴더 지정</button>
          <span>{directory ? `선택한 폴더: ${folderName}` : '폴더를 선택하지 않았습니다.'}</span>
        </div>
        {!supported && <p role="note">이 브라우저에서는 로컬 폴더 선택을 사용할 수 없습니다. 지원 브라우저에서 다시 열어 주세요.</p>}
        <p className="project-start-warning">현재 화면 구성 단계입니다. 프로젝트별 데이터 분리와 폴더의 .md 정본 저장은 아직 연결되지 않았습니다. 문서·대화는 브라우저 저장소에 남고, 선택한 폴더에 자동 저장되지 않습니다.</p>
        {(error || initialError) && <p role="alert" className="project-start-error">{error || initialError}</p>}
        <button type="button" className="project-start-primary" disabled={busy || !name.trim() || !directory}
          onClick={() => void run(() => onOpen({ name: name.trim(), folderName, directory: directory! }))}>채팅 화면 열기</button>
      </section>
    </div>
  </main>;
}
