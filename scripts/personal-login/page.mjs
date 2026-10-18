export const messages = {
  ready: 'まだログインしていません。下のボタンから本人の認証画面へ進みます。',
  waiting:
    '認証画面で操作してください。10 分以内にこのページへ戻ると結果を確認できます。途中で閉じた場合は、取り消してから再試行できます。',
  success:
    'あなたのログインを確認しました。認証画面で必要な初期設定を終え、登録済みの本人として認証されました。',
  error:
    'ログインを確認できませんでした。通信、認証結果、または戻り先の検証に失敗しました。認証画面のタブを閉じ、再試行してください。',
  cancelled: 'この入口でのログインを取り消しました。認証画面で完了した設定は元に戻りません。',
  expired: '確認の有効期限が切れました。もう一度ログインしてください。',
  logout:
    'この入口の確認状態を消去しました。認証サーバーのログアウトは、別タブの確認画面で完了してください。ここでは完了を確認していません。',
};
export function page({
  status,
  csrf,
  styleNonce,
  productDisplayName = '記憶サービス',
  ownerInitialPasswordUrl,
  cloudProject = '',
}) {
  const product = escapeHtml(productDisplayName);
  const ownerSecretSteps = ownerInitialPasswordUrl
    ? `<ol><li>既存の Google Cloud プロジェクトにアクセスできる Google アカウントで、<a href="${escapeHtml(ownerInitialPasswordUrl)}" target="_blank" rel="noopener noreferrer">初回パスワードの保管場所を開く（別タブ）</a>。</li>
  <li>Secret Manager の「バージョン」で、有効なバージョン <strong>1</strong> の操作メニューから「シークレットの値を表示」を選びます。値は次の認証画面だけに入力し、チャットやこのページに貼り付けないでください。</li>
  <li>上のログインボタンを押し、ユーザー名 <strong>owner</strong> と初回パスワードを入力します。画面に従って新しいパスワードと認証アプリを設定してください。</li></ol>`
    : '<p>初回パスワードの保管場所は設定されていません。管理者に確認してください。</p>';
  const project = escapeHtml(cloudProject);
  const form = (path, label, extra = '') =>
    `<form method="post" action="${path}" ${extra}><input type="hidden" name="csrf" value="${csrf}"><button>${label}</button></form>`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>あなたのログイン — ${product}</title><style nonce="${styleNonce}">
  :root{font-family:system-ui,sans-serif;color:#24382f;background:#f5f4ed;line-height:1.75}body{margin:0}main{max-width:760px;margin:0 auto;padding:36px 22px 70px}header{border-bottom:1px solid #c9d3c7;padding-bottom:22px}h1{font-size:2rem;margin:.3em 0}h2{font-size:1.2rem}section{background:#fff;border:1px solid #d3d9d0;border-radius:16px;padding:22px;margin-top:22px}button{font:inherit;border:0;border-radius:8px;background:#245641;color:#fff;padding:12px 20px;cursor:pointer;margin:8px 0}a{color:#185f46}a:focus-visible,button:focus-visible,summary:focus-visible{outline:3px solid #b15d10;outline-offset:4px}.note{color:#4f6056;font-size:.95rem}.badge{font-size:.85rem;letter-spacing:.12em}.status{border-left:5px solid #397454;padding-left:16px}li{margin:10px 0}code{overflow-wrap:anywhere}footer{margin-top:26px}form{display:inline-block;margin-right:12px}
  </style></head><body><main><header><div class="badge">${product} · PERSONAL MEMORY</div><h1>あなたのログイン</h1><p>あなたと、あなたが許可する AI のための記憶サービス。</p><p class="note">このページはあなたのパソコンで動くログイン確認用の入口です。</p></header>
  <section aria-labelledby="state-title"><h2 id="state-title">現在の状態</h2><p class="status" role="status" aria-live="polite">${messages[status]}</p>
  ${status === 'waiting' ? `${form('/cancel', '取り消す')}<a href="/">状態を更新</a>` : form('/login', status === 'ready' ? 'ログインして初期設定へ' : 'もう一度ログイン')}
  ${form('/logout', '認証サーバーでログアウトを確認', 'target="_blank" rel="noopener"')}
  <p class="note">ログインすると ${product} の認証サーバー（Keycloak）へ移動し、この入口へ戻ります。中断するときは、ターミナルに表示された入口の URL を開き直して「取り消す」を押し、認証画面のタブを閉じてください。パスワード・認証コードは認証画面だけに入力してください。</p></section>
  <section><h2>本人の初期設定</h2><p>現在の認証設定では、初回に仮パスワードから自分のパスワードへの変更と、認証アプリの設定を求められます。ユーザー名は <strong>owner</strong> です。</p><p>以下の保管場所を開く手順は、初回パスワードをまだ受け取っていない場合に使う、現在の構成の受け渡し方法です。すでに受け取った場合は、ログインへ進んでください。</p>
  ${ownerSecretSteps}
  <p>設定済みなら、現在のパスワードと認証アプリを使います。途中まで設定した場合も完了済みの設定は保持されます。初回パスワードを再利用・再発行しないでください。</p>
  <details><summary>パスワードを取得できない・認証アプリを紛失した</summary><p>アクセス拒否なら、プロジェクト ${project} にアクセスできる Google アカウントを確認してください。バージョン 1 が無効・不存在、権限がない、現在のパスワードや認証アプリを紛失した場合は、ここでは回復できません。作業を中断してください。この個人サービスには回復窓口やセルフサービスの復旧手順がまだ定義されていません。あなたの既存のプロジェクトアクセスを確認したうえで、Secret Manager の権限・バージョン状態、または Keycloak の本人アカウントの回復方法を別途確認する作業が必要です。作業を依頼する場合は秘密を渡さず、エラーの種類だけを伝え、変更内容を確認してから復旧してください。この入口は認証の省略や設定のリセットを行いません。</p></details></section>
  <section><h2>AI に許可すること</h2><p><strong>サービス接続：未確認（API は非公開）</strong></p><p>この入口で確認できるのは本人のログインと認証に必要な初期設定です。記憶の閲覧・編集や外部 AI からの接続は、まだこの入口では確認できません。</p><p>AI への許可では、どのアプリが、どの記憶を、読む・書く・削除するかを個別に確認します。本人がログインしても AI の権限は追加されません。ログアウトでも既存の AI への許可は取り消されません。接続の準備・権限確認は別途必要です。</p></section>
  <footer class="note">終了するには、この入口を起動したターミナルで Ctrl+C を押します。確認状態は保存されません。認証サーバーのセッションを終える場合は上のログアウト確認を使ってください。</footer></main></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  );
}
