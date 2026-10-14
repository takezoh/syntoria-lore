# Thymesis — Architecture

- Version: 1.0 (design baseline)
- Date: 2026-10-14
- Status: **Implementation specification; deployment/benchmarks pending**
- Product contract: [PRODUCT.md](PRODUCT.md)
- Delivery plan: [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md)

## 1. Architecture decision

**採用：Cloudflare Workers (TypeScript) + Neon PostgreSQL (pgvector + pg_trgm) + Hyperdrive + Cloudflare Queues/Cron + model-agnostic Curator + REST/Remote MCP.**

記憶とその履歴・関係・全文検索・ベクトルをPostgreSQLに集約し、トランザクションと認可を強固にする。専用Graph DBや外付けVector DBは導入しない。これはMVP暫定技術ではなく、PRODUCT.mdで定義する標準・高負荷ワークロードに対応する**完成形の技術ベースライン**とする。

追加サービスの導入条件は、受け入れ条件の未達を実測で示し、運用・費用・セキュリティを含めた改善が明確な場合だけとする。

### Technology decisions and rationale

| Concern | Selected | Reason / constraint |
| --- | --- | --- |
| Public API | Workers + TypeScript | 低運用負荷、RESTとMCPアダプターを共用 |
| Source of truth | Neon PostgreSQL | ACID、制約・RLS・時間/履歴・Relation管理 |
| Semantic | pgvector | 正本と共存、Embedding更新は派生操作 |
| Lexical | pg_trgm + optional PostgreSQL text search | 日本語の部分一致、固有名詞検索（日本語FTSは評価し調整） |
| Relationship | Relation tables / recursive SQL | 必要な範囲の経路探索。Graph DB追加なし |
| DB access | Hyperdrive (query cache disabled) | Connection pooling。強い可視性/RLSとの整合 |
| Async | Cloudflare Queues + DB outbox | At-least-once配送を冪等性で吸収 |
| Schedule | Workers Cron | 再評価・失効・未処理Outbox/ジョブ回収 |
| LLM | Provider adapter | Curator/Ranking/Embeddingをモデル依存にしない |
| Identity | Standards-compatible OAuth authorization server | MCPの認証情報を検証。MCP自身はresource server |
| Scope defense | App authorization + PostgreSQL RLS | APIとDBの二重防御 |

公式参考資料（導入時に現行仕様を再確認）：
- https://developers.cloudflare.com/workers/tutorials/postgres/
- https://developers.cloudflare.com/hyperdrive/get-started/
- https://developers.cloudflare.com/queues/reference/delivery-guarantees/
- https://developers.cloudflare.com/queues/configuration/dead-letter-queues/
- https://neon.com/docs/extensions/pgvector
- https://www.postgresql.org/docs/current/pgtrgm.html
- https://modelcontextprotocol.io/specification/

## 2. Component diagram and boundaries

```mermaid
flowchart TB
    A[ChatGPT / Dots / Claude / Codex] -->|OAuth token + scope| M[MCP Adapter]
    A -->|REST| API[Worker API]
    M --> API
    API --> AUTH[AuthN / AuthZ / Policy]
    AUTH --> CORE[Memory Core]
    CORE --> REC[Recall Engine]
    CORE --> CUR[Curator Orchestrator]
    CORE --> GOV[Governance / Forget]
    CORE --> PG[(Neon PostgreSQL)]
    REC --> PG
    CUR --> PG
    CUR --> LLM[LLM and Embedding Providers]
    PG --> OUT[Transactional Outbox]
    OUT --> Q[Cloudflare Queues]
    Q --> CUR
    Q --> IDX[Index worker / Re-evaluation]
    IDX --> PG
    CRON[Workers Cron] --> OUT
    CRON --> IDX
    EXT[Authorized source connectors] -->|Capture| API
    A -->|independent access| AR[Ariadne state store]
```

Workers内の構成はモジュラーモノリスを基本とし、最初からマイクロサービスへ分割しない。各コンポーネントは境界が明確なモジュールとし、Queue consumerはWorkerを別エントリーポイントとして配備可能にする。

**AriadneはMemory Serviceの下位依存ではない。** Action、タスク進捗、状態同期を本サービスに複製しない。根拠が必要な場合はAriadneのURI/IDと出来事を参照する。

## 3. Module contracts

| Module | Responsibility | Not allowed |
| --- | --- | --- |
| Capture | 入力検証、Source/Observation/Evidence、idempotency、ジョブ作成 | 推論結果を明示的Owner指示と偽る |
| Curator | Extract→Resolve→Match→Reconcile→Propose | 自分の提案をDBへ無検証で適用 |
| Policy engine | 帰属・Authority・自動確定/保留ルール | LLMのconfidenceだけで権限を決める |
| Memory Core | ChangeSet検証、Revision、トランザクション、履歴 | 分散非原子的な正本更新 |
| Recall | Hybrid retrieval、関連展開、Context Pack、coverage | 権限外候補の取得、推測の事実化 |
| Governance | Forget、retention、source ACL、export、監査 | Forget本文を監査ログへ保存 |
| Change Feed | Scope別順序、cursor、tombstone | commit順逆転による差分欠落 |
| Indexer | Embedding、トリグラム/全文検索、派生View更新 | 索引を正本として扱う |

## 4. Logical data model

### 4.1 Entities and relations

| Table | Key attributes / constraints |
| --- | --- |
| `owners` | owner_id、account subject、status |
| `scopes` | scope_id、owner_id、name、policy、auth_epoch |
| `scope_grants` | principal_id、scope_id、capability、expiry |
| `subjects` | subject_id、scope_id、kind、canonical_name |
| `subject_aliases` | alias、language、valid_from/to、evidence reference |
| `sources` | source_id、scope_id、connector、external_id、revision、visibility、rights_state |
| `observations` | observation_id、source_id、actor/source attribution、occurred_at、captured_at、content hash |
| `evidence` | evidence_id、observation_id/source locator、snippet、access policy、provenance chain |
| `episodes` | episode_id、scope_id、scenario、action、outcome、time |
| `memories` | memory_id、scope_id、kind、current_version、lifecycle、epistemic flags、revision |
| `memory_versions` | memory_id、version、statement、semantic payload、valid_from/to、recorded_at、superseded_at |
| `memory_evidence` | memory_id/version、evidence_id、support_role（supports/contradicts） |
| `relations` | scope_id、from_id、to_id、relation_type、valid_from/to、evidence |
| `embeddings` | memory_id/version、model_id、model_version、dimension、vector、indexed_at |
| `changesets` / `change_ops` | scope_id、base revisions、operation payload、status、decision rationale |
| `scope_offsets` | scope_id、last_seq（トランザクション内の確定順） |
| `change_log` | scope_id、seq、operation、resource_id、revision、opaque metadata |
| `outbox` | event_id、scope_id、event type、payload、attempt/state |
| `capture_jobs` | input idempotency key、status、attempt、model/prompt version、error |
| `deletion_requests` | target selector、scope、block_at、purge state、deadline |
| `idempotency_keys` | actor、scope、key、request_hash、response reference、expiry |
| `audit_events` | actor、operation、resource ref、result、time、no sensitive bodies |

物理スキーマでは、FK、UNIQUE、NOT NULL、CHECK、適用可能な部分Indexを設定する。`scope_id`は派生レコードにも保持し、cross-scope参照をトランザクションで検証する。Relationの全件を汎用三つ組として表す必要はなく、プロダクトが要求する型付き関係（`supersedes`/`supports`/`contradicts`/`related_to`/`same_subject`/`depends_on_context`）だけを定義する。

### 4.2 Semantic invariant

- **Observation != verified truth**：記録された主張の帰属と主張内容の真偽を区別する。
- **Owner explicit != externally verified**：Ownerの決定を確定しても、外部製品の技術事実を検証済みと扱わない。
- **KnowledgeView != Evidence**：AIが作った要約を独立の裏付けとして再投入しない。
- **Valid Time != Record Time**：いつ成立したかといつ知ったかを区別する。未知時刻はnull/範囲として表す。
- **Contested != obsolete**：矛盾は認識状態、有効/置換はライフサイクル。
- **Supersede != Retract != Forget**：歴史的有効、誤りの撤回、内容の消去を分ける。
- **Episode != atomic fact**：作業の条件・行動・結果を破壊しない。

### 4.3 Memory shape (logical example)

```json
{
  "id": "mem_...",
  "scope_id": "project:thymesis",
  "kind": "decision",
  "statement": "完成形要件と運用モデルに基づいて技術選定する",
  "subjects": ["project:thymesis"],
  "attribution": {"actor_kind": "owner", "authority": "explicit_decision"},
  "context": {"applies_to": "service_architecture"},
  "time": {"valid_from": "2026-10-14", "recorded_at": "2026-10-14T11:53:00Z"},
  "epistemic": {"status": "supported", "contested": false},
  "lifecycle": "active",
  "evidence_ids": ["ev_..."],
  "revision": 1
}
```

これはAPIを固定するサンプルではなくデータ意味の例。日時・値は実データではない。

### 4.4 Storage and indexing

- PostgreSQLの正本レコードはSQLで直接参照可能とする。Embeddingは正本の代替にしない。
- 標準Query：`scope_id + lifecycle + valid-time`、`subject + relation type`、`source locator`、`scope_id + seq` の複合Index。
- 語彙検索：`pg_trgm`（日本語固有名詞を含む）と必要に応じたFTS。日本語の分かち書き・短語/固有名詞について固定評価セットを用意する。
- 意味検索：`pgvector`。Embedding dimensionをモデルごとに明示し、異次元・異モデルを比較しない。モデル変更時は二重索引/再生成で切替。
- まずScope内の正確検索/SQLフィルタを使い、ANN（例：HNSW）は計測上有効な場合に作成する。ANNを用いる場合はScopeフィルタによる候補欠落を測定し、exact search fallbackを用意。
- ベクトル検索・Relation展開・全文検索はRecall Engineの内部詳細であり、外部APIの意味契約を変えない。

## 5. Write and curation transaction

```mermaid
sequenceDiagram
    participant AI as AI/Connector
    participant API as Memory API
    participant DB as PostgreSQL
    participant Q as Queue
    participant CUR as Curator
    AI->>API: capture(input, idempotency_key)
    API->>DB: insert observation + capture_job + outbox (transaction)
    API-->>AI: 202 Accepted + job_id
    DB-->>Q: outbox publisher (retryable)
    Q->>CUR: process job
    CUR->>DB: retrieve existing memories/evidence
    CUR->>CUR: extract / resolve / reconcile / propose
    CUR->>DB: validate + commit ChangeSet (single transaction)
    DB-->>Q: outbox index / maintenance
    Q->>DB: update derived indexes
```

Curatorの段階：
1. **Extract**：入力から根拠単位を抽出（観測事実と記憶候補を分離）。
2. **Resolve**：Subjectと別名、時間・適用範囲を解決。
3. **Match**：既存の同対象・関連記憶を候補として集める。
4. **Reconcile**：CREATE / CORROBORATE / REFINE / SUPERSEDE / CONTEST / RELATE / RETRACT / NO_OPから提案。
5. **Validate**：権限・根拠・状態遷移・対象Revision・Scope・操作スキーマ検証。
6. **Commit**：同一DBトランザクションでMemory/Version/Relation/Evidence/ChangeLog/Outbox更新。

FORGETはCurator一般変更操作から除外し、認証・権限を伴う専用フローに限定する。

### Auto-commit policy

| Evidence/intent | Policy |
| --- | --- |
| 認証済みOwnerの明示的Remember/Correction | Sync commit（対象適用範囲を検証） |
| Ownerの明確な方針決定 | 明示的発言に基づき自動確定候補 |
| 外部Source中の第三者意見 | 主張者に帰属させる。Ownerの決定にはしない |
| LLMの推測 | 推測のまま保持/候補止まり |
| 検証可能なTool結果 | 結果と対象バージョンをEvidenceとして保存 |
| 重大な衝突・曖昧なAuthority | contested/hold、人間確認を要求可能 |

LLMの出力した`authority: owner`等は信用しない。認証トークン、入力メッセージのspeaker、信頼できるsource metadataの一致をCoreで検証する。

## 6. Concurrency, change cursor and idempotency

### Commit atomicity and conflict

- Memory更新は`expected_revision`を必須とし、古いRevisionなら `409 REVISION_CONFLICT`。
- ChangeSetは全操作成功または全失敗。LLMによる再照合は失敗トランザクション外で実施する。
- 操作IDとリクエストハッシュに基づき再送に同じ結果を返す。異なる内容に同じKeyが使われた場合は409。
- Outboxは**正本と同じDBトランザクション**で作り、Publisher/Queueは重複配信に耐える。

### Gap-free cursor semantics

**単にDB Sequenceで発番した数字を公開しない。** DB sequence発番順とcommit順が逆転すると、先に進めたCursorが後から確定したイベントを欠落させる。

採用方式：

1. 全変更トランザクションが対象Scopeの`scope_offsets`レコードを`UPDATE last_seq = last_seq + 1 RETURNING last_seq`で更新し、行ロックをcommitまで保持。
2. 同じトランザクション内でそのseqの`change_log(scope_id, seq)`とOutboxを作成。
3. 同一Scopeで次の変更は前のcommit/rollback後に確定するため、Scope単位の順序・欠落防止を保証。
4. 複数Scopeの購読は**ScopeごとのCursorベクトル**（opaque token）とし、グローバル順序を約束しない。
5. Cursorにはscope集合・ACL epoch・形式versionを署名して埋め込み、権限変更時は再認可/必要に応じ再同期。
6. TombstoneをChange Feedへ出すがForgetされた本文は含めない。期限切れCursorには明示的な`CURSOR_EXPIRED`と再同期方針を返す。

この設計はScope内の書き込み直列化コストがある。標準/高負荷ワークロードでは許容範囲か性能試験で検証する。

### Read-after-write

DB正本が確定した`committed_revision`と、Embedding等の`indexed_revision`を区別。明示的Remember直後のRecallは正本検索/changed-since経路を併用し、派生索引の遅延で記憶を欠落させない。Hyperdriveの**SQL query cachingを無効化**し、書き込み直後の整合性を破らない。read replica/キャッシュを将来導入する場合も契約を維持する。

## 7. Retrieval pipeline

```mermaid
flowchart LR
    Q[Query + mode + token_budget + scopes] --> ACL[AuthZ / scope/source rights]
    ACL --> C[Structured + lexical + vector candidates]
    C --> REL[Subject resolution + relation traversal]
    REL --> V[Valid-time + lifecycle + evidence filter]
    V --> R[Ranking + diversification + coverage]
    R --> P[Context Pack + citations + uncertainty]
```

- **Precise:** 決定/固有名詞/IDを正確に返す。exact lexical優先。
- **Contextual:** 現在有効な方針・背景・適用条件を返す。
- **Historical:** 指定時点のvalid-time（必要なら当時のrecord-time）で復元する。
- **Exploratory:** 関連する経験・仮説も含めるが、確定情報と明示的に区別する。
- **Changes:** 直前からの変更の差分を返す。全文検索では代用しない。

各候補の採否は権限→有効時刻→信頼根拠→関連性→予算の順に制約。トークン切り詰め時も根拠参照と不確実性フラグは落とさない。回答不能な場合は`insufficient_evidence`を返す。

## 8. REST API and MCP contract

API v1（レスポンスは`request_id`、`scope`、`revision`、`trace_id`、型付きエラーを統一）：

| Operation | Method / endpoint | Notes |
| --- | --- | --- |
| Capture | POST /v1/captures | idempotency key、202 + job_id |
| Capture status | GET /v1/captures/{id} | queued/processing/committed/held/failed |
| Explicit remember | POST /v1/memories:remember | immediate commit + revision |
| Recall | POST /v1/recall | query/mode/as_of/token_budget/min_revision |
| Get memory | GET /v1/memories/{id} | provenance, versions, relation, ACL |
| Propose | POST /v1/changesets | validated proposal |
| Commit | POST /v1/changesets/{id}:commit | optimistic concurrency |
| Changes | GET /v1/changes?cursor=… | opaque, per-scope sequence |
| Review | GET /v1/review | candidate/contested/stale |
| Forget | POST /v1/forget | immediate suppression + purge status |
| Forget status | GET /v1/forget/{id} | pending/blocked/purged |
| Export | POST /v1/exports | async portable export; encrypted storage |
| Health | GET /healthz | minimal public info; internal metrics protected |

Common errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND`（非公開情報の存在は秘匿）, `409 REVISION_CONFLICT / IDEMPOTENCY_CONFLICT`, `410 CURSOR_EXPIRED`, `422 INVALID_SEMANTICS`, `429 RATE_LIMITED`, `503 PROVIDER_UNAVAILABLE`。

### Recall request / response sample

```json
{
  "query": "Thymesisの現在の技術方針は？",
  "mode": "contextual",
  "scope_ids": ["project:thymesis"],
  "token_budget": 2000,
  "include_evidence": true,
  "min_revision": 42
}
```

```json
{
  "context_pack": {
    "memories": [{
      "id": "mem_...",
      "revision": 7,
      "kind": "decision",
      "statement": "完成形の要件から技術選定を行う",
      "valid_from": "2026-10-14",
      "attribution": "owner_explicit",
      "evidence_refs": ["source:conversation/..."],
      "epistemic": "supported"
    }],
    "uncertainties": [],
    "coverage": "sufficient"
  },
  "committed_revision": 42,
  "indexed_revision": 40,
  "next_cursor": null
}
```

Scope単位seqは変更配信用。Memory単位revisionと区別する。複数Scopeの`min_revision`等はScope別マップで表現する正式SchemaをOpenAPIで定義する（サンプルは単一Scope）。

### MCP

- RESTの薄いアダプターとして実装し、Memory Coreのルールを再実装しない。
- 別のMCP入口（例：`/mcp/read`と`/mcp/write`）を用意するか、別リソース/ホストで分離し、独立のscope/audience検証を強制。
- HTTP MCPは当該時点の正式MCP Authorization仕様に従う：OAuth resource server、Protected Resource Metadata、tokenのissuer/audience/scope/expiry検証、PKCEはpublic client側のフローで適用。
- MCPのTool単位の「公開/非公開」切替だけに依存しない。読み取り入口では書き込みTokenも実行パスを持たない。
- プライベート原本をLLMプロンプトへ渡す際は最小範囲にし、ログ/トレースから除外する。

## 9. Security and ownership

**Authentication:** JWT等の署名/発行者/対象/audience/期限を検証。Clientに明示委任されたscopeとoperationを認可。セッションCookieだけでMCP書き込みを成立させない。

**Authorization:** Owner/Scope/Principal/Source-rightsの積集合が可視範囲。Application層だけでなくPostgreSQL RLSでもOwner・Scopeを限定する。Service roleとmigrationsの高権限資格情報はrequest pathから分離。

**RLS + pooled connections:** DBアクセスはトランザクション開始後に`SET LOCAL app.owner_id / app.scope_ids`等を設定し、同じトランザクション内でクエリする。セッションレベルのSETはpool越しに権限が漏れる危険があるため禁止。内部ジョブも認可されたScopeを渡す。RLSをバイパスできるロールを通常APIに使わない。

**Source ACL changes:** コネクタの権利喪失を確認したら、対応Source/Evidenceとそこからのみ導かれる派生記憶を**安全側に即時遮断**し、再評価をキューへ投入。内容の再掲が権利違反となるときは派生要約も保護対象。

**Prompt injection:** Source本文はdataのみ。引用に含まれる命令をsystem/developer/user instructionへ昇格しない。Curator結果はJSON schema validationだけでなく、policy authorizationとevidence IDsが実在することを検証。

**Audit/PII:** Access logはactor、scope、resource ID、action、結果、traceのみ。原文・credential・Embedding・個人情報を出力しない。暗号化、鍵回転、secret manager、権限棚卸し、依存脆弱性検査を運用する。

## 10. Forget, deletion and restoration

1. 認可されたForget要求を受け、対象Memory/Evidence/Sourceおよび派生物を求める。
2. **同期トランザクションでdeny/tombstone登録**し、すべてのRecall/Export/Change Feed経路から内容を遮断。
3. Purge Workerが正本Version、Evidence snippets、Embedding、KnowledgeView/キャッシュ、参照元派生を消去する。ソフト削除だけでは完了扱いにしない。
4. Delete対象の本文をAudit/Event/Dead Letter Queueへ複製しない。削除済みを示す最低限の非内容メタデータ（不可逆なID/時刻/範囲）だけ残す。
5. 原本が同じconnectorから再出現しても再学習させないよう、Source locatorの抑止/同意状態を適用する。
6. バックアップに削除対象内容が残る可能性を運用上明示し、バックアップ保持期限を定め、復元前にTombstone/削除台帳を再適用する。バックアップ物理消去と通常Recallの即時遮断を混同しない。

忘却、原本削除、スコープ取消を異なるイベントとして扱う。Export中もForgetを優先し、エクスポート成果物へのアクセスと期限付き削除を規定する。

## 11. Async delivery and recovery

- Queuesはat-least-once。`capture_id`/`operation_id`/`outbox_event_id`で冪等処理。
- Outbox publisherは一定間隔で未送信をQueueへ再投入。送信完了記録の前後で重複しても安全。
- Queue consumerはretry/backoffし、retry限界後はDLQに入れ、運用者に通知。DLQ保持上限に依存せず、ジョブ状態/再投入可能性はDBに残す。
- 長いLLM処理は小さな再試行単位へ分割し、Source/content hash、prompt_version、model_versionを記録。
- Index更新はMemoryVersionを照合してから反映し、古いEmbeddingが現行Versionを上書きしない。
- Fail closed：認証・Source rights・Forget stateを検証できない場合、該当Memoryは返さない。
- APIのread pathはCurator/Embedding API障害時も可能な範囲で正本検索にフォールバック。推測で結果を補完しない。

## 12. Observability, backup and cost

### Tracing and metrics

`capture_accepted`, `curation_completed`, `changeset_held`, `recall_result`, `source_acl_blocked`, `forget_suppressed`, `purge_completed`, `outbox_lag`, `queue_retry`を計測。本文を含めない。

- Latency p50/p95/p99（mode別）、error rate、queue lag、index lag、recall insufficiency
- Candidate採用/保留率、重複率、矛盾率、古い記憶の誤利用、評価セット正答率
- Token cost per Capture/Recall、embedding cost/100k Memory、固定DB/Worker費用、バックアップ費用
- DB backups/PITR、RPO/RTO演習、復元時Forget再適用の検証

### Initial SLO / operations targets

PRODUCT.mdのp95、99.9%、品質評価値、100k/1m Memory負荷を使用する。運用Runbook（シークレット失効、Source revocation、PG障害、Queue backlog、忘却失敗、コスト超過）を納品前に用意。運用障害時はOwnerにとって「どの記憶が新鮮ではないか」を把握可能にする。

## 13. Trade-offs and rejected options

- **D1 + Vectorize:** 使用可能だが、完成形のVersion/Relation/多表トランザクション・ハイブリッド検索を単一DBで運用する方が単純と判断。
- **Dedicated Graph DB:** 現在のRelation深度・件数要件に対して別DB/整合性/権限管理が過剰。
- **Dedicated Vector DB:** Vector/関係/変更履歴の正本分離を避ける。
- **All-in-one long Markdown:** 矛盾・根拠・時間・権限・差分の保証が困難。
- **LLM直接DB更新:** 決定・推測の混同と競合/セキュリティ破綻を防げない。
- **Always LLM-on-Recall:** 遅延・費用・不確実性が増加。必要な場合のみ再構成。
- **Full event sourcing everywhere:** データ内容のForgetを複雑化する。Version+ChangeLogの限定追記で要件を満たす。

## 14. Design validation gates

実装着手後、次の条件を回帰テストで満たす。達成不能が確認された場合は代替実装を選び、API契約と意味制約を維持する。

1. 同一入力の並列Captureで1件に収束。
2. Scope内change seqのcommit-order、rollback、Cursorページングで欠落なし。
3. Different ScopeでRLS越境ゼロ。Pool再利用で権限残存ゼロ。
4. 同時変更でRevision conflict。ユーザー決定をCuratorが逆転させない。
5. 明示Remember→即時Recall。Index遅延中も取得できる。
6. Forget→全読み取り遮断→正本/派生物消去→復元再遮断。
7. 矛盾・履歴・不明への回答保留とEvidence trace。
8. 標準/高負荷ワークロードのp95、品質、月次総コストを計測。
9. MCPクライアントのOAuth flow、read-onlyからwrite不可を検証。
10. Import/Exportとモデル/Embedding世代切替で意味・根拠を維持。

**実装タスク、依存関係、成果物と検収ゲートは [Development Plan](docs/DEVELOPMENT_PLAN.md) を正とする。**
