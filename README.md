# Thymesis

**Persistent, evolving memory for personal AI agents.**

Thymesis は、複数の Personal AI が長期にわたり知識・意思決定・経験を共有し、根拠と時間的な変化を保ちながら再利用するための **Memory Service** です。会話や文書の保存庫ではなく、取り込み・照合・確定・想起・再評価・忘却までを担います。

## プロダクト原則

- **AI-first:** 人間が継続的に分類・整理することを前提とせず、AI が自動的に候補を抽出・統合する。
- **Grounded:** 情報源・発言者・権限・時間を追跡し、AI の提案とユーザーの決定を混同しない。
- **Evolving:** 新しい根拠によって記憶を補強・改訂し、矛盾・失効・忘却を処理する。
- **Agent-agnostic:** ChatGPT、Dots、Claude、Codex などから独立した共通記憶として使える。
- **Separated:** Ariadne は共有状態・Action の正本、Thymesis は長期記憶の正本。互いの DB に依存しない。
- **Operational:** 技術比較ではなく、完成形の価値・品質・運用要件を実現することを優先する。

## 設計文書

- [PRODUCT.md](PRODUCT.md) — 対象ユーザー、完成形のサービス要件、運用モデル、非機能要件、受け入れ基準
- [ARCHITECTURE.md](ARCHITECTURE.md) — サービス境界、採用技術、論理データモデル、API、非同期処理、検索、認可、障害・忘却対応
- [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md) — 依存関係付き開発バックログ、成果物、テスト、検収ゲート、運用準備

## 採用アーキテクチャ（設計ベースライン）

**GCP Cloud Run（TypeScript/Node.js API + private Curator）+ Cloud Tasks + Cloud Scheduler + Neon PostgreSQL（pgvector, pg_trgm）**。大量・長時間再処理ではCloud Run Jobsを条件付きで利用する。LLM Curatorは交換可能、MCPはRESTへの薄いアダプター。独立したGraph DB / Vector DBは採用しない。

詳細な選定理由・制約・検証条件は [ARCHITECTURE.md](ARCHITECTURE.md) と [ADR-0001: GCP + Neon採用](docs/adr/0001-gcp-cloud-run-neon.md) に記載する。

## ステータス

**設計仕様確定・実装前。** 本リポジトリのドキュメントは完成形のサービス契約と実装計画を示します。性能値・コスト・可用性などの目標は受け入れ条件であり、実測またはサービス提供を保証するものではありません。

## License

未設定。公開利用条件はライセンスが追加されるまで明示されていません。
