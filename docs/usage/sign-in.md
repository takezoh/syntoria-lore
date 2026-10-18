# Sign in to Syntoria Lore

Your Lore account protects your memories. You sign in with a password and an authenticator app on the account page. The account page is only for your sign-in settings: memories are recalled and changed through your AIs, not browsed there.

## Your account page

[Open your account page](https://lore-identity-533289977919.asia-southeast1.run.app/realms/lore/account/)

You need only a browser; no repository, command line or local software is involved.

## First sign-in

Your username is **owner**. The initial password is stored for you in Google Cloud Secret Manager: open the [initial password](https://console.cloud.google.com/security/secret-manager/secret/lore-owner-initial-password/versions?project=syntoria) with your own Google account and use version **1**. Enter it only on the sign-in screen; do not paste it into a chat, a note or a message, and do not send it to anyone. If you cannot open it, check your access to the Google Cloud project rather than asking someone to forward the password.

After the first sign-in you are asked to choose a new password and to set up an authenticator app (TOTP). When you have finished both steps and returned to the account page, your account is ready. From then on the page shows your security settings and active sessions.

## Coming back and signing out

Open the same account page to come back. After you sign out, or after your session expires, you are asked to sign in again with your password and authenticator code.

Signing out ends your session on the account page. It does not withdraw the access you have given to an AI; that permission is managed separately.

## If you lose your password or authenticator

There is no self-service recovery yet. Do not create a new account or switch off the authenticator to get back in; recovery has to be arranged for the existing account so that your memories stay protected.

## Your account and your AIs

Signing in does not connect an AI to your memories, and connecting AI assistants to the hosted service is not open yet. Each AI receives its own permission—read-only, or with write access—and that permission can be withdrawn without affecting your sign-in.

See [use cases](use-cases.md) for what you can ask your AI once it is connected.
