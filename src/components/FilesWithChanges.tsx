import React from 'react';
import { Check, Eye, FileText, FolderGit2, X } from 'lucide-react';
import type { FileChangeItem } from '../services/fileChanges';
import { computeLineDiff } from '../services/diffUtils';
import './FilesWithChanges.css';

export interface FilesWithChangesProps {
  changes: FileChangeItem[];
  originalContent?: string;
  status?: 'pending' | 'accepted' | 'rejected';
  onReview?: (change: FileChangeItem) => void;
  onAccept?: (change: FileChangeItem) => void;
  onReject?: (change: FileChangeItem) => void;
}

export const FilesWithChanges: React.FC<FilesWithChangesProps> = ({
  changes,
  originalContent = '',
  status = 'pending',
  onReview,
  onAccept,
  onReject,
}) => {
  if (!changes || changes.length === 0) return null;

  return (
    <div className="antigravity-files-with-changes-card" role="region" aria-label="Files with changes">
      <div className="files-header">
        <div className="files-title">
          <FolderGit2 size={15} className="files-icon" />
          <span className="files-heading">Files with changes</span>
          <span className="files-count">({changes.length})</span>
        </div>
        <span className={`files-status-badge status-${status}`}>
          {status === 'pending' && '검토 대기'}
          {status === 'accepted' && '✓ 수락됨'}
          {status === 'rejected' && '✕ 거절됨'}
        </span>
      </div>

      <div className="files-list">
        {changes.map(change => {
          const diffResult = computeLineDiff(originalContent, change.proposedContent);
          const { added, removed } = diffResult.stats;

          return (
            <div key={change.id} className="file-item-row">
              <div className="file-item-info">
                <FileText size={14} className="file-doc-icon" />
                <span className="file-name" title={change.filename}>
                  {change.filename}
                </span>
                <div className="file-diff-stats">
                  {added > 0 && <span className="stat-added">+{added}</span>}
                  {removed > 0 && <span className="stat-removed">-{removed}</span>}
                  {added === 0 && removed === 0 && <span className="stat-unchanged">0</span>}
                </div>
              </div>

              <div className="file-item-actions">
                {status === 'pending' && (
                  <>
                    {onReview && (
                      <button
                        type="button"
                        className="file-action-btn btn-review"
                        onClick={() => onReview(change)}
                        title="가운데 에디터에서 인라인 Diff 검토"
                        aria-label="가운데 창에서 검토"
                      >
                        <Eye size={13} />
                        <span>검토</span>
                      </button>
                    )}
                    {onAccept && (
                      <button
                        type="button"
                        className="file-action-btn btn-accept"
                        onClick={() => onAccept(change)}
                        title="변경 사항 본문에 수락 반영 (⌘↵)"
                        aria-label="수락"
                      >
                        <Check size={13} />
                        <span>수락</span>
                      </button>
                    )}
                    {onReject && (
                      <button
                        type="button"
                        className="file-action-btn btn-reject"
                        onClick={() => onReject(change)}
                        title="변경 사항 거절 (Esc)"
                        aria-label="거절"
                      >
                        <X size={13} />
                        <span>거절</span>
                      </button>
                    )}
                  </>
                )}
                {status === 'accepted' && (
                  <span className="file-settled-text text-accepted">본문에 적용됨</span>
                )}
                {status === 'rejected' && (
                  <span className="file-settled-text text-rejected">제안 기각됨</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default FilesWithChanges;
