# SAS-007 global security headers and CSP

Date: 2026-11-14

## Pre-change production state

The repository had no `[[headers]]` rules, no published `_headers` file, and no
global response middleware. `netlify.toml` only selected `web/` as the publish
directory, selected the Functions directory, and applied `admin-auth` to
`/admin/*`. Individual Functions set operational headers such as
`Cache-Control`, but did not define a shared browser security baseline.

Observed on production before this change:

| Route | Status | Security headers |
| --- | ---: | --- |
| `/` | 200 | `Strict-Transport-Security: max-age=31536000` |
| `/artworks/still-here.html` | 200 | `Strict-Transport-Security: max-age=31536000` |
| `/admin-login.html` | 200 | `Strict-Transport-Security: max-age=31536000` |
| `/admin/` | 302 | `Strict-Transport-Security: max-age=31536000` |
| `/api/inquiries` | 200 | HSTS above plus `X-Content-Type-Options: nosniff` |
| `/css/main.css` | 200 | `Strict-Transport-Security: max-age=31536000` |

None of the sampled responses had a repository-defined CSP,
`Referrer-Policy`, `Permissions-Policy`, or framing policy. Static HTML and
assets also lacked `X-Content-Type-Options`.

## Browser resource inventory

- `'self'`: all first-party scripts, styles, images, video, JSON, form/API
  requests, Admin APIs, document templates, and the same-origin document
  preview iframe.
- `https://challenges.cloudflare.com`: the dynamically loaded Turnstile API
  script and Turnstile iframe. It is also allowed in `connect-src` so widget
  communication and any configured same-page pre-clearance flow can be
  observed safely during the report-only stage.
- `https://cdnjs.cloudflare.com`: the Font Awesome stylesheet on `contact.html`
  and the stylesheet's relative font files.
- The Admin printable-document flow creates a `blob:` URL and opens it as a
  top-level window. It is not embedded and does not require a CSP source
  allowance.
- One executable inline script exists in `admin-login.html`. The report-only
  policy pins its exact SHA-256 hash. No `unsafe-inline` or `unsafe-eval`
  allowance is present. The inline `application/json` block on the home page is
  data, not executable script.
- Google OIDC is a top-level redirect assembled server-side. Google token/JWK
  access, Gmail API access, Cloudflare Siteverify, and EasyPost are
  server-to-server calls. Those origins are intentionally absent from the
  browser CSP.
- Instagram, Pinterest, and YouTube are outbound links, not embedded resources.
  No analytics or third-party embeds were found.

## Repository-defined baseline

The `security-headers` Edge Function runs first on `/*`, calls the remainder of
the Netlify request chain, and adds the same headers to static files, Functions,
Admin redirects, errors, and assets without changing bodies, statuses, cookies,
content types, locations, or cache directives.

Headers:

```text
Content-Security-Policy-Report-Only: default-src 'self'; base-uri 'self'; connect-src 'self' https://challenges.cloudflare.com; font-src 'self' https://cdnjs.cloudflare.com; form-action 'self'; frame-ancestors 'self'; frame-src 'self' https://challenges.cloudflare.com; img-src 'self'; media-src 'self'; object-src 'none'; script-src 'self' https://challenges.cloudflare.com 'sha256-VztvFvtZkwdqKX67kAa2H8qpggaUSFpAzou9u5KSBrE='; script-src-attr 'none'; style-src 'self' https://cdnjs.cloudflare.com
Permissions-Policy: camera=(), geolocation=(), microphone=(), payment=(), usb=()
Referrer-Policy: strict-origin-when-cross-origin
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
```

`SAMEORIGIN`, rather than `DENY`, is required by the Admin document preview.
HSTS deliberately preserves the production value already served by Netlify;
it does not add `includeSubDomains` or `preload`. Cross-origin isolation headers
are omitted because they are not required and would add compatibility risk to
Turnstile, OIDC navigation, and printable-document windows.

The CSP is intentionally `Report-Only`. There is no `report-uri` or `report-to`
because the project has no existing safe CSP report collector. Browser console
and network inspection are the first-stage observation mechanism. Enforcement
requires a later evidence-based decision after representative authenticated
Admin usage has been observed; it is not part of SAS-007.
