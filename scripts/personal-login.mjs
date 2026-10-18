import { startPersonalLogin } from './personal-login/server.mjs';
import { createOidc } from './personal-login/oidc.mjs';
import { readCloudIdentityConfig } from './cloud-identity-config.mjs';

try {
  const cloudIdentity = await readCloudIdentityConfig();
  const userInitialPasswordUrl = new URL(
    `https://console.cloud.google.com/secret-manager/secret/${encodeURIComponent(cloudIdentity.userInitialPasswordSecret)}/versions`,
  );
  userInitialPasswordUrl.searchParams.set('project', cloudIdentity.project);
  const config = {
    issuer: `${cloudIdentity.identityUrl}/realms/${cloudIdentity.realm}`,
    clientId: cloudIdentity.publicClientId,
    subject: cloudIdentity.userSubjectId,
    productDisplayName: cloudIdentity.productDisplayName,
    userInitialPasswordUrl: userInitialPasswordUrl.href,
    cloudProject: cloudIdentity.project,
  };
  if (!config.subject || new URL(config.issuer).protocol !== 'https:')
    throw new Error('configuration');
  const helper = await startPersonalLogin({ config, oidcFactory: createOidc });
  console.log(
    `${cloudIdentity.productDisplayName} — あなたのログイン\n同じパソコンのブラウザーで開いてください: ${helper.url}\n終了: Ctrl+C（認証サーバーのログアウトとは別です）`,
  );
  const stop = () => {
    void helper.close().then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  console.error(
    error.code === 'EADDRINUSE'
      ? '起動できません: ポート 18970 は使用中です。既に起動した入口があれば使うか、そのプロセスを終了して再試行してください。'
      : '入口を起動できません。Node.js 24、npm ci 済みの依存関係、設定ファイルと loopback 接続の許可を確認してください。',
  );
  process.exitCode = 1;
}
