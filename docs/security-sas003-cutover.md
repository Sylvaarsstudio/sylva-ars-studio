# SAS-003 Admin identity cutover

SAS-003 uses a separate Google Workspace OpenID Connect Web Application client.
It does not use or modify the Gmail Desktop OAuth client, Gmail refresh token, or
`gmail.send` scope.

## Required external configuration

Create a Google OAuth Web Application client with this authorized redirect URI:

`https://sylvaarsstudio.com/admin-auth/callback`

Configure these Netlify Production variables without committing their values:

- `ADMIN_OIDC_CLIENT_ID`
- `ADMIN_OIDC_CLIENT_SECRET`
- `ADMIN_OIDC_HOSTED_DOMAIN`
- `ADMIN_OIDC_REDIRECT_URI`
- `ADMIN_BOOTSTRAP_OWNER_EMAIL`
- `ADMIN_BOOTSTRAP_VIEWER_EMAIL` (leave unset until the owner explicitly
  requests a real read-only audit identity)
- `ADMIN_SESSION_SECRET` (create and retain a new independent high-entropy value)
- `ADMIN_LEGACY_LOGIN_ENABLED=true` only during the controlled migration window

The bootstrap emails are configuration supplied by the owner. On the first
successful Google sign-in, the application binds the verified immutable Google
`sub` to an `admin_users` row. Later authorization uses that subject and the
current server-side database role, not the email or a browser-provided role.

In Google Workspace, enforce two-step verification for the owner and for any
future viewer before that identity is activated. Prefer passkeys or hardware
security keys; TOTP is acceptable. The application also requires recent
`auth_time` and multifactor/passkey evidence in the verified ID token.
Password-only and SMS-only authentication evidence is rejected.

In Google Auth Platform, keep the app restricted to the Workspace organization
with the **Internal** audience. Google does not require public app verification
for this audience. Enable both Security Bundle advanced settings:

- **Session age claims** for `auth_time`
- **Authentication strength claims** for `amr`

If Google omits either claim, sign-in fails closed even when it was requested.

## Controlled cutover

1. Deploy the additive migration and identity capability with
   `ADMIN_LEGACY_LOGIN_ENABLED=true`.
2. Sign in as the configured owner through Google Workspace and complete MFA.
3. Confirm the owner can read and perform one harmless reversible write.
4. Confirm the automated authorization suite proves Viewer GET/HEAD access and
   rejects representative mutations with `403 admin_forbidden`, including
   requests that forge a role in headers, query parameters, or JSON. Do not
   provision a live Viewer during this phase.
5. Set `ADMIN_LEGACY_LOGIN_ENABLED=false` and publish the configuration change.
6. Confirm Google owner access again. Confirm old shared-password and
   legacy-session access is rejected.
7. Only after those checks pass, remove `ADMIN_PASSWORD` from Netlify.

Live Viewer provisioning is deferred. It requires a future explicit owner
request, a named identity, Workspace MFA, and a separate production read-only
verification before that identity is used for audit access.

Do not delete or rotate the Gmail OAuth credentials as part of this cutover.

## Role model

- `owner_admin`: all existing Admin reads and mutations.
- `viewer`: GET/HEAD access to Admin data; every POST, PATCH, PUT, and DELETE is
  rejected centrally before request parsing or business persistence.
- `disabled`: rejected as unauthorized. The database status and role are loaded
  on every API request.

## SAS-004 boundary

SAS-003 sessions are random, signed, HttpOnly, Secure, SameSite=Lax, and expire
after eight hours. User status and role changes take effect on the next API
request. A persistent session registry, per-session remote revocation, session
inventory, device management, and global logout remain SAS-004 work.
