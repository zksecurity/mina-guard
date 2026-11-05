# Deployment: Architecture & Security Notes

This document describes the in-repo **deployment assets** (`deploy/`): the GitHub
workflows and scripts that build, attest and verify the AWS mainnet release. The
frontend deployment is a fund-safety surface: an attacker who can serve altered
JavaScript can mislead owners into signing an unintended transaction. A host does
not hold owner private keys, but host compromise can still affect what owners see
and approve ([`security-audit-guide.md`](./security-audit-guide.md)). Operational security
(AWS hosting, the gateway, firewalls, CI, secrets) lives in the private ops repo,
`mina-guard-ops/architecture.md`, shared with auditors on request.

The two application tiers deployed here are documented in
[`ui-audit-guide.md`](./ui-audit-guide.md) (frontend) and
[`backend-audit-guide.md`](./backend-audit-guide.md) (indexer + API).

---

## General overview

The only deployment is AWS mainnet. This repository builds and signs the images
and holds the verifiers; the private `mina-guard-ops` repository owns the hosts,
the gateway and the rollout. The release path is:

1. A reviewed PR copies the current `main` tree into the protected `production`
   branch (*Release from production* below).
2. `.github/workflows/mainnet-image-build.yml` builds the frontend and backend
   images from that exact production commit on GitHub-hosted runners, pushes
   them to GHCR by digest, attests them, and publishes signed manifests
   (*AWS mainnet image build*).
3. The ops rollout and the public-content watcher verify the attested digests,
   manifests and served bytes with the scripts in `deploy/` before and after
   traffic is opened (*Release verification before AWS deployment* and *Watch
   the content served to owners*).

Nothing in this repository deploys to a host. No workflow here runs on a
self-hosted runner or holds credentials for the AWS environment.

## Architecture

### Files

| File | Purpose |
|---|---|
| `validate-mainnet-build-config.py` | Rejects incomplete or visibly non-mainnet public URLs, endpoints on more than one origin, and the test-only `NEXT_PUBLIC_E2E_TEST` flag before a mainnet image build |
| `verify-mainnet-release.py` | Verifies one attested mainnet build: workflow signer identity, source commit, manifest bytes, image digests, the pinned `MAINNET_VK_HASH`, and a live endpoint reporting mainnet |
| `mainnet-content-integrity.py` | `baseline` records the approved frontend bytes from the pinned image; `check` compares the public site and its security headers against that record |
| `production-promotion.py` | Checks a production release record against one attested mainnet build; `--check-preview` also checks the restricted production-origin preview from the operator machine |
| `resolve-mainnet-deployment.py` | Resolves the last successful ops-authored mainnet deployment receipt for the watcher |
| `prepare-legacy-watch.py` | Prepares an older main-branch release for the independent watcher |
| `check-production-pr.py` | Production branch check: the PR merge tree must equal the reviewed `main` tree named by its `Release-main:` line |
| `tests/` | Unit tests for the scripts above; CI runs them in the `mainnet-release-integrity` job |

The container images are built from `preview-env/Dockerfile.backend` and
`preview-env/Dockerfile.frontend`. The same Dockerfiles build the E2E test
stack, so a change to either affects both the tests and the release.

### Verification key hash

`MINAGUARD_VK_HASH` is a property of the contract source. CI reuses compiled
testnet and mainnet hashes when their circuit-input fingerprint matches a
cached result. On a cache miss, it compiles both circuits in parallel. It
writes `contracts/.vk-hash` as a downloadable artifact and derives the
`devnet=` entry from testnet because both use `Field(2)`. Release
jobs download that manifest for the exact source commit and verify it before
selecting a hash. The backend uses the selected hash to filter contract
discovery. A local checkout can compile either network with
`MINA_NETWORK_DOMAIN=<network> bun run dev-helpers/cli.ts vk-hash compile`
for debugging; local results do not need to be committed. The compiler selects
the corresponding o1js network before compilation. A mainnet hash produced
using o1js's default devnet setting must not be used as the expected mainnet hash.

### AWS mainnet image build

`.github/workflows/mainnet-image-build.yml` runs on pushes to `production` when
`MAINNET_BUILD_ENABLED=true`, or can be dispatched from that branch. GitHub's
workflow builds the exact production commit on GitHub-hosted runners and pushes
the frontend and backend images to the dedicated `mainnet-*` GHCR packages.
`mainnet-images-<sha>` records the exact image digests; `mainnet-content.json`
records frontend HTML and static hashes. The workflow signs both images and
both manifests. The build does not deploy the app or start Mina.

The shared backend and frontend Dockerfiles pin the multi-platform `oven/bun:1`
base image by OCI digest. Review and update that digest deliberately in both
Dockerfiles when upgrading Bun; the same files also build the E2E test
stack. The frontend's `apt-get` package resolution is still time-dependent.

Set these **public build-time** repository variables to the intended
browser-reachable HTTPS services before enabling the build:

| Variable | Frontend use |
|---|---|
| `MAINNET_API_BASE_URL` | Indexer/API origin or base URL |
| `MAINNET_MINA_ENDPOINT` | Mina mainnet GraphQL endpoint |
| `MAINNET_ARCHIVE_ENDPOINT` | Mainnet archive GraphQL endpoint |

Transaction and address links use `https://minascan.io/mainnet`, pinned in the
reviewed workflow and independently enforced by ops. Changing the explorer
requires reviewed changes in both repositories.

The workflow refuses missing, non-HTTPS, local, or visibly testnet/devnet/trail
URLs, URLs with credentials or query strings, and a nonempty base path. It also
refuses an API, node and archive URL that do not share one origin, because the
mainnet Content-Security-Policy lets the page connect only to its own origin
(`docs/ui-audit-guide.md`, focus point 7), and any nonempty
`NEXT_PUBLIC_E2E_TEST`, a test-only flag that makes the browser trust the
backend's vault security verdict and adds test hooks. These
values are **baked into public JavaScript**; never put a secret or API token in
them. The `vk-hashes` job generates a manifest tied to the checked-out commit;
the release verifies that source SHA and selects the **mainnet** VK hash with
`read-vk-hash.sh mainnet`. On the `production` branch the `vk-hashes` job never
restores the Actions cache and always compiles, because a cache entry can be
written by any job running in default-branch scope. The selected hash must also
equal `MAINNET_VK_HASH` in `deploy/verify-mainnet-release.py`;
`validate-mainnet-build-config.py` fails the build otherwise, and the release
verifier rejects a manifest carrying any other value. A circuit change therefore
updates that constant in the same reviewed commit. The Docker builds receive both
`NEXT_PUBLIC_MINA_NETWORK=mainnet` and `MINA_NETWORK_DOMAIN=mainnet`, plus that
mainnet hash. The frontend production build checks their agreement. The backend
image records the same domain and hash; the AWS runtime must still explicitly
set `MINA_NETWORK_DOMAIN=mainnet` and compare its `MINAGUARD_VK_HASH` against the
release manifest.

### Release verification before AWS deployment

For the first operator-controlled release, review the successful production
build, its full source commit, run ID, exact image digests and the SHA-256 of
`mainnet-images.json`. The separate ops rollout retrieves the same build
artifact and validates its source commit, workflow identity, both image
attestations and both signed manifests. On an operator machine with read-only
GitHub and GHCR access, the verifier can be run explicitly:

```bash
python3 deploy/verify-mainnet-release.py \
  --manifest release/mainnet-images.json \
  --content-manifest release/mainnet-content.json \
  --approved-sha "$APPROVED_SHA" \
  --approved-manifest-sha256 "$APPROVED_MANIFEST_SHA256" \
  --bundle-dir release/ > release/verified.json
```

The verifier requires the exact `mainnet-image-build.yml@refs/heads/production`
signer, source commit and manifest bytes, GitHub-hosted attester, the fixed GHCR
repositories, and a live Mina endpoint reporting mainnet. It verifies the
signed outputs of the GitHub-hosted build workflow. A successful attestation is not
a substitute for the initial live browser, proof, signing and restore tests.

### Release from production

Keep `main` protected and open a reviewed PR into protected `production` whose
files match the current `main`. The production check
loads its checker from the trusted `main` commit that supplied the workflow,
using `github.workflow_sha`. It reads Git objects without running the PR code
and requires the proposed merge and PR head trees to match the current `main` tree, including file modes and
submodules. The PR body must include exactly one `Release-main: <full SHA>`
line identifying the selected `main` commit. Reviewers approve that explicit
snapshot; the check does not promise it remains the latest if main advances
after the check finishes.
Require that check and human review, require an up-to-date base, allow merge or
squash merges (not rebase merges), and disallow direct pushes and bypasses.
These settings keep the checked merge tree aligned with the merged tree. After
the PR merges, the exact merge
commit triggers the gated build. No `production-release.json` PR is needed.
The ops workflow waits for successful CI, E2E and image-build runs of the
current protected production commit, then deploys its verified digest-pinned images after the
first manual launch and explicit automation setup. If a build fails or the
production branch advances, the ops workflow must not substitute a build of
another commit. Automatic rollout accepts only the production push's build;
manual dispatch is for operator use. Once the current commit was deployed, a
rebuild does not replace it; a new reviewed production commit is required to
deploy changed images. Before opening traffic, the app host rechecks the production
head and refuses an older release. A merge just after that check can still race
with activation; the next serialized poll handles the newer commit.

A direct PR from `main` works when it is up to date with `production`. After a
release merge, those branches can have different history even when their files
match. To satisfy the up-to-date rule without merging production back into main,
create a release branch from production and copy the current main tree into it:

```sh
git fetch origin main production
git worktree add -b release/my-release ../mina-guard-release origin/production
cd ../mina-guard-release
git read-tree --reset -u origin/main
git commit -m "Release current main to production"
git push -u origin release/my-release
gh pr create --base production --head release/my-release \
  --body "Release-main: $(git rev-parse origin/main)"
```

Use a new branch and worktree path for each release. `git read-tree --reset -u`
replaces the worktree files, so run it only in the newly created clean worktree.
If main advances, recreate or update the release branch before merging. The
release PR remains the human approval; no separate release-info PR is needed.

The checker must be merged into protected `main` before the first production
PR. It does not need to exist on `production` yet: the first production PR runs
the same checks as later releases. Once a successful check is available, make
it required on `production` before merging the release PR.
If main changes after the check, the PR still selects its explicit commit.
If the newer changes are desired, update the release branch and the selected
SHA and rerun the check before approving and merging.

### Watch the content served to owners

Before first public launch, use the ops `Approve mainnet preview for independent
watcher` workflow with the reviewed production SHA, successful push build ID,
and manifest hash. It creates a separate `mainnet-preview` receipt; the normal
production watcher never consumes that environment. In `mina-guard-ops`, run
`Mainnet public-content watch` with mode `preview`. It reports its runner IPv4 address and sends a test
alert to the configured channel. While the job waits, use the ops `preview`
command to change the existing restricted preview to that runner's address.
The job resolves the preview receipt, verifies the same saved release evidence,
and checks the real production-origin response. Confirm the test alert and job
success before opening public traffic. The operator can restore their own IP
with the same preview command. After activation, enable the scheduled watcher
and confirm its first production receipt and run. The manual
`production-promotion.py --check-preview` remains an additional local check.

After the verified release is serving at `https://app.minaguard.com`, configure
`MAINNET_WATCH_ENABLED=true` in `mina-guard-ops`, along with its registry-read
credentials and the `Production` environment alert webhook described in the
ops runtime guide. Test the webhook and run
`Mainnet public-content watch` manually once. Its GitHub-hosted runner then
checks about every 15 minutes: it downloads that exact run's saved release evidence,
verifies its attestations and image digests, and compares public HTML for `/`,
`/transactions`, `/transactions/new`, `/accounts/new`, `/settings`, and `/guide`
plus every Next static asset from the approved frontend image. A changed inline
script, an injected script, a changed worker chunk, a missing file, a failed
verification, or an unreachable site makes the run fail and sends an alert with
the run link. The watcher never learns its expected hashes from the public site.

Each of those HTML pages must also carry the approved security headers, or the
run fails the same way: exactly one `Content-Security-Policy` equal to
`EXPECTED_CONTENT_SECURITY_POLICY` in `mainnet-content-integrity.py`,
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and
`Strict-Transport-Security` with `includeSubDomains` and a `max-age` of at
least one year. A page whose bytes match but whose headers were dropped could
be framed by another site or lose its script and connection limits. The app
sends the policy (`ui/content-security-policy.mjs`), and the gateway adds the
frame and HSTS headers. A deploy test fails if the watcher's copy of the policy
differs from the app's. The ops watcher runs this script from a pinned
mina-guard commit, so these checks start only after ops moves that pin to a
release that includes them, and only once the deployed gateway passes the
policy through and sends the other headers.

The expected release comes from the latest deployment attempt in `mina-guard-ops`,
which must have a success status authored by the configured personal account. The receipt contains
the deployed production SHA, run ID, and manifest hash. The watcher does not infer
approval from the latest build or the `production` branch alone. Set
`MAINNET_WATCH_ENABLED=false` in ops while the site is intentionally offline; a missing,
failed, or untrusted receipt fails the check and alerts.
The build also publishes the two manifests and their image/file attestation
bundles as a GitHub Release named `mainnet-build-<source-sha>-<run-id>`.
The separate publishing job has repository contents write permission; the image
build job has contents read only. A failed or incomplete evidence publication
fails the build workflow and prevents automatic deployment.
If publication was interrupted and left an incomplete draft release, inspect
and remove that draft before rerunning the build; reruns never overwrite a
published release's evidence.
The watcher and app boot reverify these saved proofs even after workflow run
retention expires. Protect these releases and GHCR images against deletion;
missing evidence or images fails closed. A repository administrator can still
delete a release, so this is durable storage, not an immutable backup.
This monitor runs outside the
app host, but it shares the repository's GitHub trust boundary. It can detect
changes visible to its fetches; it does not prevent first exposure, cover the
HTML of dynamic `/accounts/<address>` or `/transactions/<id>` pages, or prove
what every visitor received. Requests use a browser-like User-Agent rather than
announcing the integrity checker. This is still an HTTP client, not a real
browser; its public behavior, fixed headers, and runner IPs can identify it.
A compromised server can selectively return approved bytes to the watcher and
different code to other visitors. A successful image
build or monitor run alone does not establish that mainnet account creation is
ready. GitHub may delay or skip a scheduled run, so a separate check of the
watcher's run cadence is needed if a missed run must also alert. Each run
downloads the public static assets again; include that traffic in the hosting
egress estimate.

---

## Threat model & assumptions

Frontend integrity and release verification matter because owners may sign
transactions based on content served from this tier. The controls this
repository enforces are the ones above: the production branch check, the
GitHub-hosted attested build, the pinned mainnet VK hash, the release verifier
and the public-content watcher. Network controls (the AWS gateway, edge security
headers, firewalls, TLS) are configured and documented in `mina-guard-ops`; the
watcher checks their visible result on the public pages.

### Cross-origin isolation is required

o1js proof generation in the browser needs `SharedArrayBuffer`, which requires
cross-origin isolation: `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: credentialless`. The app sends both headers itself
(`ui/next.config.mjs`), and the gateway must pass them through unchanged. Do not
add `Cross-Origin-Resource-Policy: same-origin`, which blocks the blob-URL
sub-workers o1js spawns. Losing these headers breaks proving, not fund safety,
but it stops owners from completing any proved action.

---

## File tree

```
deploy/
├── check-production-pr.py          # production PR check: merge tree equals the reviewed main tree
├── mainnet-content-integrity.py    # approved frontend bytes: baseline from the image, check of the public site
├── prepare-legacy-watch.py         # prepares an older main release for the independent watcher
├── production-promotion.py         # checks a release record against one attested mainnet build
├── resolve-mainnet-deployment.py   # resolves the last ops-authored mainnet deployment receipt
├── validate-mainnet-build-config.py # CI check for explicit mainnet frontend build inputs
├── verify-mainnet-release.py       # release verifier (pins MAINNET_VK_HASH)
└── tests/                          # unit tests, run by CI's mainnet-release-integrity job
```

The gated AWS mainnet image build is `.github/workflows/mainnet-image-build.yml`;
`mainnet-promotion.yml` runs the production PR check and `vk-hashes.yml`
generates the per-commit VK manifest both of them consume.

---

## Dependencies

- **GitHub Actions, GHCR and Sigstore attestations.** The build runs on
  GitHub-hosted runners and signs with `actions/attest-build-provenance`
  (keyless: GitHub OIDC, Fulcio, Rekor). Verification with `gh attestation
  verify` depends on those services being reachable.
- **Docker + Docker Compose.** The release images are built with Docker; the
  AWS runtime and its compose or task definitions live in `mina-guard-ops`.
- **Python 3 and the `gh` CLI** for the scripts in `deploy/`.
