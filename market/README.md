# Submitting to the DSH plugin list

The DSH plugin market discovers plugins through
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).
A submission is **one YAML file** in that repository:

```
data/plugins/Making-acid__dsh-approval-preflight.yml
```

The content to use is prepared in [`awesome-dsh-plugin-entry.yml`](awesome-dsh-plugin-entry.yml).

## Submission record

| When | What |
|---|---|
| 2026-10-30 | Submitted [PR #10567](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10567) — one entry file, no other entries touched. |
| 2026-10-30 | `check` (PR check) and `Submission gate` both **success**; gate verdict `Entries look good`. |
| 2026-10-30 | **Merged** at `2026-10-30T17:04:42Z` (merge commit `0ab7948`); entry is live at `data/plugins/Making-acid__dsh-approval-preflight.yml`. |
| 2026-11-09 | Released [`v2.1.2`](https://github.com/Making-acid/dsh-approval-preflight/releases/tag/v2.1.2) with the version-independent tarball `dsh-approval-preflight.tgz` (DSH 0.2.1/0.2.2 compatibility). The existing entry needs no new PR — it carries no version, and the market reads the repository. |

## Version updates after listing

Entries contain no version field. A plugin update is therefore: bump `package.json` in this
repository, push `main`, and publish a GitHub Release whose asset name stays
**version-independent** (`dsh-approval-preflight.tgz`). Markets and the awesome-dsh-plugin index
pick the new version up from the repository on their next build — no new PR per release.

Prefer the pinned-tag download URL if a release page is ever reworked:

```yaml
tarball: https://github.com/Making-acid/dsh-approval-preflight/releases/latest/download/dsh-approval-preflight.tgz
```

## Checklist (from the list's contributing guide)

| Requirement | Status in this repo |
|---|---|
| `package.json` declares `dsh.bundle.patch` | ✅ `./cordis.patch.yml` |
| `cordis.patch.yml` next to `package.json`, inserts the plugin row | ✅ Host row `approval-preflight` |
| Real working code (not a placeholder or wrapper) | ✅ `index.js` + `client.js` + `lib/`, verified live on 2026-10-30 |
| Repository at least 1 day old | ✅ created `2026-10-26T12:06:08Z` |
| Repository actively maintained | ✅ CI runs the three test suites on every push |
| `dsh-plugin` topic on the repository | ✅ set (`dsh`, `deepseek-harness`, `cordis`, `approval`, `permission`, `workflow` too) |
| Accurate, non-marketing description | ✅ graph-first, per-node one-shot approvals, timeout switch, audit trail — matches the code |
| Category matches what it does | `workflow` |
| `category` is one of the list's values | ✅ `workflow` is in the published list |
| Optional storefront icon (GitHub-hosted **raster**) | ✅ `assets/icon-180.png` (SVG would be refused) |
| Optional screenshots via `screenshots.json` | ✅ `assets/screenshot-1.png` (v2 panel) + `assets/screenshot-2-live-switch.png` (live 2.1.0 run) |
| Optional npm package (improves install) | ⏳ not published: the npm name `dsh-approval-preflight` is still free, but the repository has no `NPM_TOKEN` Actions secret, so the market installs from source / the GitHub Release tarball. |
| Optional release tarball | not needed — the repo root is installable from source |

## Steps

1. ~~Wait until the repository is at least 24 hours old~~ — done (`2026-10-26` → submitted `2026-10-30`).
2. ~~Fork `awesome-dsh-plugin/awesome-dsh-plugin`, add the entry file, open one PR~~ — done: [PR #10567](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10567) from branch `Making-acid:add/dsh-approval-preflight`, based on the fork's freshly fast-forwarded `main`.
3. Keep the entry minimal: `url`, `name`, `category`, `description.en` (required),
   `description.zh`, `icon`. Do **not** add an `npm:` key — the registry mapping is
   automatic, and a hand-written one is rejected.
4. After the PR merges, the site and both markets pick the entry up on the next
   build (usually within a day). Later changes to screenshots only need a push
   here — no new PR.

## If the PR needs changes

Push to the same fork branch and leave one comment describing the change. A
maintainer's `held: author` label is not a rejection; it means the PR is paused
until someone re-reads it.

## Network note (this machine)

`api.github.com` and `github.com:443` are both reachable. `git push` fails through
the Windows schannel backend (`SEC_E_NO_CREDENTIALS`) and through the sandboxed
`gh auth git-credential` helper (`couldn't create signal pipe`), so push with an
explicit token URL and the OpenSSL backend instead:

```powershell
$tok = gh auth token
git -c http.sslBackend=openssl push "https://x-access-token:$tok@github.com/Making-acid/dsh-approval-preflight.git" HEAD:main
```

The token is never written to the repository config with this form.
