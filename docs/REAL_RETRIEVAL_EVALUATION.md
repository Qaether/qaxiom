# 실문헌 검색 평가 입력 계약

이 도구는 사용자가 별도로 라벨한 질문·정답 구간을 Qaxiom 작업공간 백업의 원문과 대조해 **로컬 BM25**를 평가한다. 실제 논문 corpus나 독립 연구자 라벨은 아직 제공되지 않았으므로 제품 검색 품질 수용 결과는 없다. 라벨 작성자의 독립성·정답의 의미적 타당성은 프로그램으로 증명할 수 없다.

1. 평가에 사용할 자료가 들어 있는 Qaxiom 작업공간 JSON 백업을 준비한다. API 키는 백업에 포함되지 않지만 연구 원문은 포함되므로 파일을 비공개로 보관한다.
2. 별도 JSON 라벨 파일을 만든다. `sourceId`/`sourceHash`는 백업의 `data.references`, `spanId`/`spanHash`는 `data.referenceSpans`에서 확인한다. 정답 구간은 검색 결과를 보고 역으로 채우지 말고 원문을 검토해 지정한다. 개발/보류 질문을 분리하고 각 질문의 선택 자료 범위와 정답 없음의 이유도 기록한다.
3. 백업과 라벨 파일을 예를 들어 `evaluation/private/`에 보관한다. 이 경로는 Git에서 제외된다. 다음 명령은 두 파일을 로컬에서만 읽고 원문 텍스트 없이 점수·놓친 질의 ID를 출력한다.

```sh
QAXIOM_EVAL_BACKUP=/absolute/path/workspace.json QAXIOM_EVAL_LABELS=/absolute/path/labels.json npm run eval:real-retrieval
```

라벨 파일 구조:

```json
{
  "format": "qaxiom-labelled-retrieval",
  "version": 1,
  "labeler": "researcher-or-reviewer-id",
  "sources": [{ "sourceId": "source-id-from-backup", "sourceHash": "64-character-sha256-from-backup" }],
  "cases": [
    {
      "id": "dev-001",
      "category": "definition",
      "split": "development",
      "query": "질문",
      "selectedSourceIds": ["source-id-from-backup"],
      "expected": [{ "spanId": "span-id-from-backup", "spanHash": "64-character-span-sha256" }],
      "rationale": "원문을 읽고 이 구간을 정답으로 지정한 이유"
    },
    {
      "id": "holdout-001",
      "category": "no_evidence",
      "split": "holdout",
      "query": "근거가 없는 질문",
      "selectedSourceIds": ["source-id-from-backup"],
      "expected": [],
      "rationale": "선택 자료에서 근거가 없다고 판정한 이유"
    }
  ]
}
```

평가기는 형식·중복 ID·개발/보류 분할·선택 범위·원문/구간 실제 SHA-256·구간의 원문 오프셋과 정답 ID/hash를 검증한다. 변경된 자료나 범위 밖 정답이 있으면 점수를 내지 않는다. 출력은 Recall@5/20, MRR, 근거 없음 정확도, 범위 밖 회수, 유형/분할별 결과와 놓친 질의 ID다. 이는 인용의 의미적 지지·LLM Issue 정확도·이론 정합성 평가와 별개다. 실제 사람이 라벨한 60질의 이상과 독립 보류 평가가 확보되기 전에는 [RAG 설계의 수용 목표](./RAG_DESIGN_PLAN.md)를 달성했다고 쓰지 않는다.
