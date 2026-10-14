# ADR-0001 — GCP Cloud Run + Neon PostgreSQLを採用

- Status: **Accepted**
- Date: 2026-10-14
- Scope: Thymesis runtime infrastructure (the [Product Contract](../../PRODUCT.md) is unchanged)
- Supersedes: Cloudflare Workers + Queues + Cron + Neon baseline in Architecture v1.0
- Related: [Architecture](../../ARCHITECTURE.md), [Development Plan](../DEVELOPMENT_PLAN.md)

## Context

Thymesisは複数Personal AI向けの根拠付き長期記憶サービス。同期的なRemember/Recall、長時間のLLM Curator、バッチ再処理、更新履歴・差分取得、忘却、復旧の一貫性が必要。

当初のCloudflare Workers + Queues + Cronは低固定費・低運用負荷で魅力的だった。しかし、API/LLM処理の実行環境をNode.jsコンテナで統一し、長時間再処理やバッチを運用できる設計の柔軟性、既存のGCP Cloud Run運用経験、SLO/費用の計測容易性を重視して再評価した。

**要件を満たすサービスを完成させるのが目的であり、クラウド/DBの技術比較そのものを目的としない。**

## Decision

| Concern | Adopted |
| --- | --- |
| API / Remote MCP | GCP Cloud Run (public HTTPS with application OAuth authorization) |
| Curator / async handler | Private GCP Cloud Run service (service-account OIDC + IAM) |
| Job dispatch | Cloud Tasks (authenticated HTTP tasks; bounded retries) |
| Periodic recovery | Cloud Scheduler (OIDC protected endpoint) |
| Reliable DB→Task propagation | Transactional Outbox (PostgreSQL) |
| Long-running bulk operations | Cloud Run Jobs **only when needed** (e.g. tasks > 30 min) |
| Primary database | Neon PostgreSQL (TLS + pooled connection endpoint) |
| Vector / lexical / relations | pgvector / pg_trgm / relational edges in PostgreSQL |
| Application language | TypeScript + Node.js, reusable domain modules |
| GCP operations | Secret Manager, IAM, Cloud Logging/Monitoring, declarative IaC |
| LLM | Model-provider agnostic, external APIs |

**Neon remains the source of truth.** GCP Cloud SQL, Railway PostgreSQL, D1, dedicated Graph DB and dedicated Vector DB are not part of the selected topology.

## Why GCP over Cloudflare, AWS and Railway

| Alternative | Decision basis |
| --- | --- |
| Cloudflare Workers + Queues + Cron | 非常に低運用負荷だが、Curatorの重い/長時間バッチに通常コンテナ/Cloud Run Jobsの選択肢があり、GCPの運用経験を活かせることを重視 |
| AWS Lambda + SQS + EventBridge | 機能要件は満たす。個人運用における既存GCP資産/経験を優先 |
| Railway Services + Worker + Neon | デプロイは簡単。Cloud Tasks/Schedulerの実行制御とscale-to-zeroを採用 |
| Railway PostgreSQL | 正本のバックアップ/PITR・専門運用をNeonへ委ねる |
| GCP Cloud SQL | 単一GCP内の選択肢だが、想定負荷に対する固定費・運用性の評価からNeonを採用 |
| Cloudflare D1 + Vectorize | 複数正本/索引基盤より、PostgreSQLへ履歴/Relation/semantic searchを集約 |

選定理由は定性的な運用設計判断。GCPが常に最安/最高性能であるとは主張しない。サービス料金やNeonリージョンの可用性はデプロイ時に確認する。

## Important implementation constraints

### 1. Task execution and recovery

- Cloud TasksのHTTPターゲットは **最大30分（通常10分）** のdeadline制限。Cloud Run serviceの最大60分設定とは異なる。
- 1ジョブで処理が終わらない場合は小さな処理へ分割してprogressをDBでcheckpointする。大量再処理はCloud Run Jobsで実行する。
- Cloud Tasksはexactly-onceの処理を保証しない。Workerは`job_id`単位で処理を冪等にし、成功した場合のみ2xxを返す。
- DBとCloud Tasksに分散トランザクションはない。ObservationとOutboxを**同じDB transaction**でCommitし、DispatcherがCloud Tasksへ送信する。送信確認が不確かな場合は再送可能とする。
- Cloud SchedulerがOutbox未送信/失敗Jobを回収する。**Cloud Tasksのnative DLQを前提にしない**。永続的な`failed/held/next_retry_at`はDBが正本。
- Task本文は原文ではなくjob IDを使用。原本/Memoryの内容はNeonから認可後に取り出す。

### 2. Security and data ownership

- Public Cloud Run API: 外部OAuth resource serverとしてissuer/audience/scopeを検証する。
- Private Worker/Dispatcher/Maintenance: Cloud Tasks/Cloud Scheduler専用Service Account OIDC + IAM Invokerで制限。OIDC callerのService AccountはOwnerの行動権限ではない。
- Neon: 最小権限DBロール、PostgreSQL RLS、`SET LOCAL` transaction scope、TLS接続、pool size制御。
- Cloud Runのインスタンス数×DBプール数の上限とNeonプール最大接続数を考慮する。
- Secret ManagerにNeon credentialsとAPI secrets。監査ログには本文や個人情報を出力しない。
- Forgetは即時denyと非同期purgeに分け、DBバックアップ復元時に削除台帳を再適用する。

### 3. Region, cost and operations

- Cloud Runは東京（`asia-northeast1`）を第一候補。Neonで利用可能な**実際の地理リージョンとホスティングプロバイダー**を確認し、通信遅延とデータ所在地/法的制約を満たす配置を決める。
- GCP + Neon間の往復遅延、ネットワーク転送料金、Neon compute/storage、Cloud Runの実行時間、Cloud Tasks/Scheduler、外部LLM/tokenを総コストとして計測する。
- Cloud Runは`min instances=0`から開始し、cold startでPRODUCT.mdのp95 Recall SLOが未達ならmin instancesや実行構成を調整する。
- 各環境（dev/staging/prod）を分離してIaCを適用。CIはSecretを持たずWorkload Identity Federation等の短期認証を使う。
- 失敗の発見・再投入・障害復旧とバックアップ復元テストをRelease Gateに含める。

## Consequences

**Positive:** 一般的なNode.js実行、ジョブ/HTTP処理の独立スケール、GCPマネージドでの認証付き非同期実行、Neon側の統一正本。

**Negative:** GCP + Neonの複数プロバイダー運用、跨Provider通信、Cloud Tasks処理期限、非同期Outbox Dispatcherと失敗回収の設計が必要。

**Non-goal:** 完成形の必要性が示されない段階で他のQueue/Graph/Vector DBを追加すること。技術移行を計画の目的にしない。

## Verification before Release 1

1. Task 30分期限・リトライ枯渇・Scheduler重複呼出し・Outbox再送でもジョブが消えない。
2. Cloud Tasks/Scheduler→Private Cloud Run IAM/OIDC、Public OAuth/Owner Scopeの分離が機能する。
3. Neon pooled endpointでRLS/`SET LOCAL`のContextがリクエスト間に漏れない。
4. Cloud Run cold start、NeonリージョンRTT、100k→1m Memory workloadでp95と実費を測定する。
5. 別モデルへの切り替え、Forgotデータ削除、バックアップ復元を実際に試験する。

**Implementation status:** 採用済み設計。デプロイ/ベンチマーク達成済みではない。

## Official references

- https://cloud.google.com/tasks/docs/creating-http-target-tasks
- https://cloud.google.com/tasks/docs/configuring-queues
- https://cloud.google.com/run/docs/configuring/request-timeout
- https://cloud.google.com/run/docs/create-jobs
- https://cloud.google.com/scheduler/docs/http-target-auth
- https://neon.tech/docs/connect/connection-pooling
