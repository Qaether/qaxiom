export interface ResearchContract {
  purpose: string;
  assumptions: string;
  definitions: string;
  symbols: string;
  scope: string;
  openQuestions: string;
}

export const EMPTY_CONTRACT: ResearchContract = {
  purpose: '', assumptions: '', definitions: '', symbols: '', scope: '', openQuestions: ''
};

export interface ContractAnchor { blockId: string; blockHash: string }
export type ContractAnchors = Partial<Record<keyof ResearchContract, ContractAnchor>>;

export interface ResearchProject {
  id: string;
  title: string;
  canonicalDocumentId: string;
  createdAt: number;
  sourcePolicy?: ProjectSourcePolicy;
}
export interface ProjectSourcePolicy { scope: 'external_review' | 'research'; revision: number; allowedSourceIds: string[] }

export interface TheoryDocument {
  id: string;
  projectId: string;
  role: 'theory';
  currentVersionId: string;
  createdAt: number;
  updatedAt: number;
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  number: number;
  parentVersionId: string | null;
  restoredFromVersionId: string | null;
  title: string;
  markdown: string;
  contentHash: string;
  contract: ResearchContract;
  contractAnchors: ContractAnchors;
  createdAt: number;
}

export interface DocumentBlock {
  id: string;
  versionId: string;
  documentId: string;
  position: number;
  kind: 'heading' | 'paragraph' | 'code' | 'math';
  startOffset: number;
  endOffset: number;
  text: string;
  contentHash: string;
  predecessorIds: string[];
}

export interface TheoryData {
  projects: ResearchProject[];
  theoryDocuments: TheoryDocument[];
  documentVersions: DocumentVersion[];
  documentBlocks: DocumentBlock[];
}

export interface TheorySnapshot {
  document: TheoryDocument;
  version: DocumentVersion;
  blocks: DocumentBlock[];
  history: DocumentVersion[];
}
