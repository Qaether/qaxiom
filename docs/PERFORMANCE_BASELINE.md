# 로컬 검색 성능 기준선

측정일: 2026-10-03. macOS arm64, Node v25.9.0, 로컬 Playwright Chromium. 합성 Markdown형 원문 100구간/자료, 동일 길이의 짧은 문단과 약 1/97 비율의 질의 일치 문단을 사용했다. 실제 PDF·수식·긴 문단·다중 탭의 분포가 아니다.

| 경로 | 구간 수 | 측정값 | 범위 |
| --- | ---: | --- | --- |
| `npm run bench:retrieval` | 10,000 | 평균 12.44 ms, p99 19.04 ms, 121표본 | 로컬 JS BM25 토큰화·점수 계산. Worker/브라우저 복제·IndexedDB 제외 |
| `npm run bench:retrieval` | 50,000 | 평균 63.69 ms, p99 72.70 ms, 24표본 | 동일 |
| `npm run bench:browser-retrieval` | 10,000 | 중앙값 15.5 ms, p95 17.7 ms, 20표본 | 따뜻한 Chromium Worker 왕복. 입력 structured clone·검색·결과 12개 포함 |
| `npm run bench:browser-retrieval` | 50,000 | 중앙값 81.6 ms, p95 82.7 ms, 20표본 | 동일 |
| `npm run bench:browser-retrieval` IndexedDB 경로 | 10,000 | 자료 읽기 중앙값 125.6 ms/p95 126.7 ms; 전체 중앙값 147.5 ms/p95 158.5 ms, 10표본 | 100개 자료 선택, IndexedDB 읽기·새 Worker 시작/입력 복제·BM25·12개 결과 |
| `npm run bench:browser-retrieval` IndexedDB 경로 | 50,000 | 자료 읽기 중앙값 244.3 ms/p95 260.7 ms; 전체 중앙값 331.3 ms/p95 347.4 ms, 10표본 | 500개 자료 선택, 동일 |

첫 브라우저 Worker 행은 시작 후 워밍 1회 뒤 같은 메모리 데이터를 다시 보내며 측정했다. IndexedDB 행은 5만 구간을 별도 브라우저 프로필에 미리 저장하고, 매 표본마다 실제 `loadReferenceSelection`과 새 Worker를 호출한 뒤 워밍 1회를 제외했다. 각 검색 호출에서 BM25 토큰화·점수를 다시 계산한다. 질의는 `quantum spin needle`, 결과 한도는 12개다. 결과는 단일 기기의 단일 실행 관측이며 통계적 수용 판정이 아니다. 합성 DB 자료의 hash/오프셋은 실제 원문과 맞춘 데이터가 아니므로 **원문·구간 무결성 검증 결과가 아니다.** 실제 앱 검색 경로도 검색 후보를 보여 주는 단계에서는 모든 원문 hash를 재계산하지 않으며, 전송 전에는 별도 검사가 필요하다. 이 측정은 512차원 벡터·RRF, 선택 미리보기·전송 전 검증, UI long task·메모리, 1만 메시지 로드, PDF Worker와 LLM 지연을 포함하지 않았다.

현재 관측값은 계획의 1만 구간 warm 검색 p95 500 ms 목표를 이 합성 자료의 로드+Worker 경로에서는 넘지 않는다. 5만 구간에서는 자료 읽기만 p95 260.7 ms로 전체 347.4 ms의 큰 부분을 차지했다. 그러나 실제 애플리케이션 전체 경로의 p95 500 ms 달성으로 판정하지 않는다. 다음은 정확한 source/span/hash가 있는 현실적인 분포에서 무결성 검사·벡터/RRF·UI 표시까지 포함한 브라우저 측정, 1만 메시지 세션 로드, 메모리/long task와 반복 실행이다.
