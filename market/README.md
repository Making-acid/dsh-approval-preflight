# Submitting to the DSH plugin list

The DSH plugin market discovers plugins through
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).
A submission is **one YAML file** in that repository:

```
data/plugins/Making-acid__dsh-approval-preflight.yml
```

The content to use is prepared in [`awesome-dsh-plugin-entry.yml`](awesome-dsh-plugin-entry.yml).

## Checklist (from the list's contributing guide)

| Requirement | Status in this repo |
|---|---|
| `package.json` declares `dsh.bundle.patch` | ✅ `./cordis.patch.yml` |
| `cordis.patch.yml` next to `package.json`, inserts the plugin row | ✅ Host row `approval-preflight` |
| Real working code (not a placeholder or wrapper) | ✅ `index.js` + `client.js` + `lib/`, verified live |
| Repository at least 1 day old | ⏳ created `2026-10-26T12:06:08Z`; submit after `2026-10-27T12:06:08Z` |
| Repository actively maintained | ✅ CI runs the three test suites on every push |
| `dsh-plugin` topic on the repository | ✅ set (`dsh`, `deepseek-harness`, `cordis`, `approval`, `permission`, `workflow` too) |
| Accurate, non-marketing description | ✅ plan-first batch grants, count matches the three tools |
| Category matches what it does | `workflow` |
| `category` is one of the list's values | ✅ `workflow` is in the published list |
| Optional storefront icon (GitHub-hosted **raster**) | ✅ `assets/icon-180.png` (SVG would be refused) |
| Optional screenshots via `screenshots.json` | ✅ `assets/screenshot-1.png` |
| Optional npm package (improves install) | ⏳ `npm publish` when ready; `repository` already points here |
| Optional release tarball | not needed — the repo root is installable from source |

## Steps

1. Wait until the repository is at least 24 hours old (CI checks creation date).
2. Fork `awesome-dsh-plugin/awesome-dsh-plugin`, add
   `data/plugins/Making-acid__dsh-approval-preflight.yml` with the prepared
   content, and open one PR (at most 3 entries per PR).
3. Keep the entry minimal: `url`, `name`, `category`, `description.en` (required),
   `description.zh`, `icon`. Do **not** add an `npm:` key — the registry mapping is
   automatic, and a hand-written one is rejected.
4. After the PR merges, the site and both markets pick the entry up on the next
   build (usually within a day). Later changes to screenshots only need a push
   here — no new PR.

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
