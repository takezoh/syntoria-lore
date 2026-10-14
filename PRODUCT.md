# Thymesis — Product Specification

- Version: 1.0 (design baseline)
- Date: 2026-10-14
- Status: **Adopted design / not yet implemented**
- Owner: Personal AI Assistant
- Related: [ARCHITECTURE.md](ARCHITECTURE.md), [Development Plan](docs/DEVELOPMENT_PLAN.md)

## 1. Product definition

**Thymesis is an independent, long-term memory service that enables multiple personal AI agents to learn from conversations, documents, decisions and work outcomes, and recall reliable, temporally correct context with provenance.**

日本語定義：複数のPersonal AIが、人間とAIの活動から長期記憶を獲得・整理・確定・更新・想起・忘却し、次の判断や行動の質を上げるためのサービス。

成果は「何件保存したか」ではなく、**過去の文脈を再説明する負荷が減り、事実誤認や方針の取り違えが減り、AIのタスク成功率が改善すること**で測る。

### Product principles

1. **Outcome-first** — 技術評価や概念実験を目的化しない。完成形の要件と運用負荷からアーキテクチャを選ぶ。
2. **AI-first, human-controlled** — 通常の分類・整理は自動、人間が指定する確定・訂正・忘却は優先する。
3. **Evidence before confidence** — LLMの自己評価より、原本・発言者・認証主体・適用範囲・時点を優先する。
4. **History without confusion** — 過去の事実と現在の事実、主張と決定、提案と実装を混同しない。
5. **Multi-agent, provider-neutral** — 特定モデル、AI製品、原本サービスに依存しない。
6. **Privacy by design** — 明示的な接続・認可範囲のみを取り込み、不要な複製を避ける。
7. **Low management overhead** — 人間による日常的な手動整理や常設インフラの運用を前提にしない。

## 2. Responsibilities and boundaries

| Component | Source of truth | Responsibility |
| --- | --- | --- |
| Personal AI (ChatGPT/Dots/Claude/Codex etc.) | 実行中の判断・タスク文脈 | 意図理解、推論、行動、どの記憶を使うかの選択 |
| **Thymesis** | 長期記憶・根拠・記憶改訂・記憶差分 | 抽出・統合・確定・想起・再評価・忘却 |
| **Ariadne** | Action、状態、依存関係、共有作業状態 | 人間・AI間の状態共有と状態変化 |
| External sources | 文書、メール、Slack、Issue、会議録等の原本 | 一次情報の保管・アクセス制御 |

AriadneとThymesisは独立したサービス・API・データ所有権・デプロイとする。共有DB、相互必須API、分散トランザクションは設けない。双方を必要とする操作はPersonal AI側でオーケストレーションする。

**Out of scope:** タスク管理、カレンダー同期、メール送信、原本ドキュメント編集、会話アプリの代替、汎用ナレッジグラフ製品、大量原本文書の正本保管。

## 3. Users and trust actors

- **Owner:** 記憶の所有者。自身の記憶、アクセス権、削除を制御する。
- **AI client:** 委任された範囲でRecall/Capture/Rememberを行う。認証済みクライアントであってもOwner本人とは限らない。
- **Curator:** サーバー側の意味抽出・照合・変更提案器。権限を自ら決定しない。
- **Source connector:** 外部原本から権限範囲内でデータを持ち込む。
- **Administrator/operator:** 障害復旧・監査・コスト監視。本文の閲覧は別途最小権限で制御。

初期運用は単一Ownerの個人サービス。データ設計はScopeを持ち、複数Ownerに拡張可能とするが、大規模SaaSの組織管理UIは初期成果物に含めない。

## 4. Core user experiences

| ID | Scenario | Required outcome |
| --- | --- | --- |
| UC-01 | 数か月前の話題を再開 | 必要な決定・背景・根拠だけを取得 |
| UC-02 | ユーザーが方針を明示 | 対象Scopeに反映し直後のRecallで見える |
| UC-03 | AwhenがAriadneへ改名 | 同一Subjectとして扱い、名称の時系列を保持 |
| UC-04 | AIが技術を推奨 | 提案をユーザーの決定や実装済み事実に昇格しない |
| UC-05 | 別のAIが経験を利用 | 異なるクライアント間で根拠と意味が一致 |
| UC-06 | 作業で失敗し改善 | 条件・操作・結果・根拠を経験として再利用 |
| UC-07 | 相反する資料を取得 | 主張者・対象・時点を区別し、未解決矛盾を明示 |
| UC-08 | 古い資料を再処理 | 既存の最新決定を過去の内容で上書きしない |
| UC-09 | 前回以降の変更を取得 | Cursorで権限範囲内の変更を欠落なく取得 |
| UC-10 | 特定の記憶を忘却 | Recallから即時除外し派生物・正本を削除 |
| UC-11 | 原本の権限が失効 | 原本内容と権限依存派生情報の提供を停止 |
| UC-12 | 根拠不足の質問を受ける | 不足/矛盾を返し、作話しない |

### Example — decision lifecycle

1. AIが「D1を採用しては」と提案 → **AI提案**として観測。ユーザーの決定ではない。
2. Ownerが「技術選定は完成形要件の後」と明示 → **Ownerの決定**として記憶。
3. 後日Ownerが方針を修正 → 有効期間を分け、旧決定をSupersededにする。
4. 別AIの「現在の方針は？」 → 最新の決定を提示し、必要なら変更経緯を添付。
5. 「当時の方針は？」 → 当時のValid Timeに沿って回答。

## 5. Functional requirements

### FR-CAP: Capture

- **FR-CAP-01** 認証済みの会話、文書、ツール結果、作業EpisodeをSourceとObservationとして取り込める。
- **FR-CAP-02** 原本ID、版、箇所、発言者、発生時刻、取得時刻、権利とScopeを保持する。
- **FR-CAP-03** 同じ入力・再送・再試行を冪等に扱い、重複Evidenceを増殖させない。
- **FR-CAP-04** 連携ごとに明示的な有効化と同期範囲を設定し、停止できる。
- **FR-CAP-05** 明示的Remember/Correctionは同期確定、それ以外のCaptureは非同期処理可能とする。

### FR-CUR: Curate and consolidate

- **FR-CUR-01** 有益なFact、Decision、Preference、Hypothesis、Experience、Procedureを抽出する。
- **FR-CUR-02** Subjectの同一性・別名、記憶の重複・詳細化・置換・矛盾を検出する。
- **FR-CUR-03** 帰属、適用範囲、Valid Time、Record Timeを維持する。
- **FR-CUR-04** 根拠・方針に基づき自動確定/候補保持/人間確認/棄却を選択する。
- **FR-CUR-05** 自己生成サマリーの反復を独立した複数根拠とみなさない。
- **FR-CUR-06** Evidenceを再処理しても、現在の明示的決定を無断で逆転させない。

### FR-REC: Recall and context

- **FR-REC-01** Precise / Contextual / Historical / Exploratory / Changesの意図に対応する。
- **FR-REC-02** Structured + lexical + semantic retrievalに加え、必要なRelationを展開する。
- **FR-REC-03** Token budget内でContext Packを組み立て、優先度、根拠、鮮度、不確実性を返す。
- **FR-REC-04** 正本からの最新変更の可視性を保証し、索引遅延で明示的Rememberを見失わない。
- **FR-REC-05** 不足情報、矛盾、古い可能性を返せる。情報がない場合に架空の記憶を生成しない。
- **FR-REC-06** Scopeと元データの権利を検索候補選択の段階から強制する。

### FR-LIFE: Revision, time and forgetting

- **FR-LIFE-01** Supersede（当時有効）、Retract（誤りとして撤回）、Forget（利用停止・削除）を区別する。
- **FR-LIFE-02** 変更をChangeSetとRevisionで整合的に確定する。競合更新は黙って上書きしない。
- **FR-LIFE-03** 不変の監査メタデータと必要な内容履歴を保持する。ただしForget対象の内容は消去する。
- **FR-LIFE-04** Change Cursorを提供し、更新・置換・削除を欠落なく取得可能にする。
- **FR-LIFE-05** 原本の変更、時効、ユーザー訂正、利用結果を契機に再評価する。
- **FR-LIFE-06** Forgetは即時利用停止と非同期物理削除を区別し、バックアップ復元後の再出現を防ぐ。

### FR-GOV: Security, operations, portability

- **FR-GOV-01** OAuthベースの委任認証、Owner/Scope/Operationごとの認可を実施する。
- **FR-GOV-02** MCPのread-onlyとwrite-capableを別の認可ポリシーを持つ入口で提供する。
- **FR-GOV-03** Capture/Curator/Recall/Forgetに計測と監査イベントを設ける。本文や秘密をログに出さない。
- **FR-GOV-04** 原本アクセス停止・削除のイベントで権限依存派生記憶を再評価/遮断する。
- **FR-GOV-05** 記憶・関係・根拠・履歴を可搬な形式でExportできる。
- **FR-GOV-06** 特定のLLM・Embeddingモデルを切り替えられる。モデルのVersionを記録する。

## 6. Meaning and authority model

- **Observation:** 原本から観測した発言/記述/出来事。「誰がそう主張したか」という事実。
- **Memory:** 再利用可能な意味単位。観測から得た解釈/知識であり、主張の真偽とは別に評価する。
- **Knowledge View:** 複数Memoryの派生Context。正本でも独立したEvidenceでもない。
- **Episode:** 行動・条件・結果を一体として保持する経験の単位。単純な一文へ過度に分割しない。
- **Lifecycle:** Candidate / Active / Superseded / Retracted / Forgotten。Contestedは別軸のepistemic flag。
- **Authority:** Ownerによる本人の選好・方針決定、第三者の主張、実測による実装状態など、**対象に依存した権限**。単一の信用スコアで代替しない。

AIの提案がOwnerの決定を自動上書きすることはない。逆にOwnerの技術的主張を無条件で「検証済みの製品仕様」とはしない。記憶の重複排除も、根拠独立性と時刻・適用範囲を損なってはならない。

## 7. Operating model

| Trigger | Mode | Outcome |
| --- | --- | --- |
| Ownerの「覚えて/訂正して」 | Sync | 認可・整合性検証後に確定、read-after-write |
| 通常の会話/作業記録 | Async | 選択的抽出、統合、方針に従い確定 |
| 外部原本更新/失効 | Async (priority) | 対応する記憶の再評価/必要な即時遮断 |
| 失効期限/Periodic scan | Scheduled | 古さ・矛盾・孤立・索引遅延を検査 |
| AIの作業結果 | Async feedback | 記憶の有用性や適用条件を検証 |
| Forget/権限取消 | Sync deny + async purge | 直ちに利用不可、削除進捗を管理 |

自動運用を基本とし、人間の確認を例外とする。未確定情報をむやみに確定するより、Candidate/Contestedとして分けて保持する。通常の会話の保存と外部データ接続は、Ownerの明示した収集ポリシーの範囲に限定する。

## 8. Quality and service targets

以下は**設計上の受け入れ目標（実測値やSLAではない）**。評価環境、標本数、測定方法を含めて測定する。

| Metric | Target |
| --- | --- |
| 通常Recall p95 | <= 1.5秒（LLMによる複雑な再構成を含まない） |
| 複雑Recall p95 | <= 5秒 |
| 明示的Remember確定 p95 | <= 2秒 |
| 非同期Capture確定 | 95%を5分以内 |
| Change Feed p95 | <= 1秒 |
| Availability | 99.9%を目標（プロバイダー契約SLAとは別） |
| Recall@5 | >= 95%（固定評価セット） |
| Task QA accuracy | >= 90%（固定評価セット） |
| Unknown/abstention correctness | >= 95% |
| 古い情報を現在事実として誤採用 | < 1% |
| Evidence attribution completeness | 根拠付きMemoryでは100% |
| Cross-scope leaks / forgotten resurrection | セキュリティ回帰試験で0件 |

### Planning workload (not observed usage)

| Dimension | Standard | Stress |
| --- | ---: | ---: |
| AI clients | 5 | 20 |
| Capture events/day | 100 | 1,000 |
| Recall/day | 200 | 2,000 |
| Active memories | 100,000 | 1,000,000 |
| Evidence refs | 500,000 | 5,000,000 |
| Historical retention | 5+ years | 5+ years |

コストは月額 **$20–$50（標準負荷の暫定目標、外部AI利用料は本サービスに直接課金される分のみ算入）**を検証する。DB費用・Worker/Queue・ストレージ・Embedding・Curator推論・監視・バックアップを分解計測し、予算超過時は品質に影響しないバッチ化/モデル選択/再計算削減を優先する。費用目標だけを満たすために根拠や忘却の保証を緩めない。

## 9. Product acceptance: end-to-end contracts

- **AC-01 Decision provenance:** AI推奨がOwner決定として保存・返却されない。
- **AC-02 Temporal correctness:** 改名・方針変更を現在/過去/当時認識の3視点で区別できる。
- **AC-03 Consolidation:** 同一情報を再送しても重複増殖せず、別Sourceの独立根拠は失われない。
- **AC-04 Multi-client:** Client Aの明示的変更をClient BのRecallとChange Feedが正しく取得する。
- **AC-05 Source ACL:** Scope・原本権限が失効した内容を返さない。
- **AC-06 Concurrent writes:** 競合Revisionを検出し、lost updateが起きない。
- **AC-07 Forget:** 即時検索不可・最終的な正本/派生データ削除・復元時の再出現防止。
- **AC-08 Poisoning:** 原本や検索結果に埋め込まれた指示でポリシーや別Scopeを変更できない。
- **AC-09 Reprocessing:** 古いEpisodeを再処理しても現在の明示的決定を破壊しない。
- **AC-10 Limited context:** Budget内で根拠・不確実性を保持したContext Packを作る。
- **AC-11 Failure recovery:** LLM/Queue/Index障害から再処理しても確定状態が一貫する。
- **AC-12 Portability:** Exportを別環境でImportして、同じ記憶・根拠・履歴を再現できる。
- **AC-13 Outcome:** 記憶なし/単純要約/Thymesisの比較で、代表タスクの成功率とコストを測定し、有用性を説明できる。

## 10. Release policy

**Release 1 = service-complete**：上記の基本Capabilityを実運用可能な品質で備える。段階的な実装は許すが、プロダクトの完成形を途中で縮小しない。実装順序、各ゲート、優先度は [Development Plan](docs/DEVELOPMENT_PLAN.md) に記載する。

本書の数値は受け入れ目標。制約やトレードオフが実測で明らかになった場合、Product要件・ベンチマーク結果・変更理由をレビューし、文書を更新する。技術選定を目的とした無期限のPoCは行わない。
