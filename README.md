# VoxBox

A runnable video-sharing application built on the project's React app. It includes an Express API, a SQLite local/test adapter, PostgreSQL production persistence, Redis-backed shared sessions, Mux-managed video uploads/transcoding/CDN playback and RTMP ingest, Resend verification/recovery email, and Stripe subscriptions. Production replicas share PostgreSQL and Redis; they do not rely on local SQLite or process-local session state.

## Requirements

- Node.js 20.19+ or 22.12+ (Node 24 is supported)
- npm
- Docker Engine and Compose for the bundled production-style PostgreSQL/Redis deployment
- Optional for local development: Stripe test account/CLI, Mux account, and Resend account

## Run locally

1. Install packages: `npm install`
2. Start the API and React development server: `npm run dev`
3. Open `http://localhost:3000`

The API listens on `http://localhost:5000`; the React development server proxies `/api` and `/media` requests to it. Local development and tests use SQLite and require no database or Redis server. No RapidAPI key or external video catalog is needed. The first run creates a small sample catalog. Sign up to publish your own content.

For a production-style local build, run `npm run build`, then `npm start` and open `http://localhost:5000`.

## Included features

- Email/password registration and sign-in, scrypt password hashes, persistent HttpOnly cookie sessions, same-origin mutation checks, and basic login throttling
- Production email verification, one-time password recovery links, session invalidation after password changes, and account-action throttling
- Video search and category browsing, public catalog, per-account watch history, saved videos, likes, comments, and channel subscriptions
- Authenticated creator Studio with Mux direct/Tus uploads, Mux transcoding and CDN playback, lifecycle webhooks, visibility, and owner-managed videos
- Private/unlisted Mux playback uses signed, short-lived playback tokens; private videos are owner-only
- A collaborative/content-affinity recommendation endpoint that uses a user's likes, watch history, and channel subscriptions, with a popularity fallback
- Mux RTMP live stream creation, one-time display of stream keys, key rotation, live lifecycle webhooks, and Mux HLS playback. The RTMP server URL is `rtmp://global-live.mux.com:5222/app`.
- Externally hosted HTTPS HLS (`.m3u8`) entries remain available for local development and compatibility.
- Stripe Checkout, customer portal, signed webhooks, membership synchronization, and explicit test/live mode key matching
- Linux Docker image and Compose deployment with PostgreSQL/Redis health checks and persistent data volumes

## Local provider setup

1. Add desired values from `.env.example` to the existing local `.env`; preserve existing values and keep provider secrets out of source control.
2. For Mux, configure API access tokens and a webhook endpoint at `https://<app-host>/api/media/mux/webhook` for `video.upload.asset_created`, `video.asset.ready`, `video.asset.errored`, `video.live_stream.active`, and `video.live_stream.idle`. Set the signing key ID and private key to enable signed playback. Use Mux test assets in non-production environments.
3. For Resend, verify the sender domain, set `RESEND_API_KEY` and `EMAIL_FROM`, and set `PUBLIC_APP_URL` to the app's origin. Set `REQUIRE_EMAIL_VERIFICATION=true` to exercise verification locally.
4. For Stripe test billing, set `STRIPE_MODE=test`, a matching `sk_test_` key, test recurring price, and webhook secret. Forward `checkout.session.completed` and `customer.subscription.*` to `/api/billing/webhook`. Checkout links stay on the configured `PUBLIC_APP_URL`.

Stripe never collects or stores card numbers in this application. Billing mode is explicit, and the secret key prefix must match it. Production-mode startup accepts either matching test or live Stripe credentials, and requires a configured webhook secret. Premium status is changed only by signature-verified Stripe webhooks.

## Render staging environment

The included [`render.yaml`](./render.yaml) defines a Docker-based staging deployment on Render with its own managed PostgreSQL database and Redis service. The database, Redis, test billing mode, and staging app are separate from any public deployment. The selected Render plans are paid services and incur provider charges.

1. Push this repository to a Git provider, then create a Render Blueprint from it using `render.yaml`. Review the generated resources before applying the Blueprint.
2. Set the Blueprint's `PUBLIC_APP_URL` to the staging service's HTTPS URL. Add staging-only Mux credentials, Resend credentials and sender, and Stripe test credentials (`sk_test_`, test `price_`, and the test-mode `whsec_`). Do not reuse public/production credentials or webhook secrets. The Blueprint keeps these values out of source control and fixes `STRIPE_MODE=test`.
3. Configure the Stripe test webhook at `<staging-url>/api/billing/webhook` for `checkout.session.completed` and `customer.subscription.*`. Configure the staging Mux webhook at `<staging-url>/api/media/mux/webhook`; use test assets and staging keys. Verify Resend delivery using a staging-approved sender.
4. Deploy and check `<staging-url>/api/health`, then exercise registration, uploads/playback, and test checkout on the staging page. Test billing never charges a real card. Keep test accounts and content confined to staging.

Render provisions the resources when the Blueprint is applied; this repository change does not create resources in a Render account. Production remains a separate deployment and should use its own database, Redis, provider credentials, webhook endpoints, and `STRIPE_MODE=live`.

## Linux Docker deployment

1. Install Docker Engine and the Compose plugin. Copy `.env.example` to a protected `.env` file (do not commit it); set strong, URL-safe `POSTGRES_PASSWORD` and `REDIS_PASSWORD` values, plus all production provider settings. Set `PUBLIC_APP_URL` to the HTTPS site origin.
2. Configure a TLS reverse proxy for the app. The Compose app exposes port 5000 only on its private Docker network; attach the proxy to the Compose `videohub` network and proxy to `videohub:5000`, preserving `Host` and `X-Forwarded-Proto`. Configure large streaming request bodies and long-lived uploads.
3. Start with `docker compose up --build -d` and check `docker compose ps` plus `https://<app-host>/api/health`. PostgreSQL and Redis must report healthy before the app starts.
4. Configure Stripe's live webhook at `https://<app-host>/api/billing/webhook` and Mux's webhook at `https://<app-host>/api/media/mux/webhook`. Confirm the sender domain in Resend and verify mail delivery before public registration.
5. For additional app replicas, use `docker compose up --build -d --scale videohub=3`; the reverse proxy must load-balance requests to the service on the private network. PostgreSQL and Redis remain shared dependencies and must be sized/operated independently.

Compose stores PostgreSQL and Redis data in named persistent volumes (Redis AOF is enabled). Back up both volumes and test restores. For managed services, deploy the app with `DATABASE_URL` and `REDIS_URL` set to the managed `postgres://`/`postgresql://` and `redis://`/`rediss://` endpoints; a Compose override should also remove the bundled database dependencies. Production startup validates both URLs, verifies Redis connectivity, and runs a transactional, versioned PostgreSQL schema migration before listening.

## Configuration and data

- `DATA_DIR` selects the local SQLite/media directory; default is `./data`. This adapter is selected only outside production (including tests).
- `PORT` selects the Express server port; default is `5000`.
- Production requires `DATABASE_URL` and `REDIS_URL`; the Compose file constructs these for its internal services from the configured database/user/password variables.
- `PUBLIC_APP_URL`, `TRUST_PROXY`, `REQUIRE_EMAIL_VERIFICATION`, `MUX_*`, `RESEND_API_KEY`, `EMAIL_FROM`, and `STRIPE_*` configure production integrations.
- The real `.env` file, database, media uploads, and build output are git-ignored.
- Legacy local file uploads live on disk; Mux direct uploads do not pass large media through the application server.

## Validation

- `npm test` runs API integration tests plus focused SQL conversion and Redis session-store invalidation tests.
- `npm run build` builds the React client.

## Scale and operational boundaries

Mux provides managed transcoding, HLS delivery, and its edge CDN; Resend and Stripe remain external services. Production uses PostgreSQL for application data and Redis for session storage; password reset and logout revoke shared Redis sessions across replicas. Existing SQLite files continue to receive additive schema migrations for local/test use and are never selected in production. The app does not automatically import SQLite records into PostgreSQL: operators moving an existing SQLite deployment must perform and verify a separate data export/import before cutover. Legacy local file uploads are not accepted in production; use Mux direct uploads or externally hosted HLS. Add monitoring/alerts, tested backups, quotas/abuse controls, legal/tax/support workflows, and a security review before a large public launch. Production secrets, DNS, proxy TLS, provider webhooks, and sender-domain verification must be configured by the operator.
