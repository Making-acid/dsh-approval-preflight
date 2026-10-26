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
| `cordis.patch.yml` present and inserts the plugin row | ✅ Host row `approval-preflight` |
| Real working code (not a placeholder or wrapper) | ✅ `index.js` + `client.js` + `lib/`, verified live |
| Repository at least 1 day old | ⏳ create the repository first |
| Repository is actively maintained | ✅ |
| `dsh-plugin` topic added to the repository | ⏳ after creating the repo |
| Accurate, non-marketing one-line description | ✅ plan-first batch grants, verified in the desktop profile |
| Category matches what it does | `workflow` (confirm against the list catalog) |
| Optional storefront icon (GitHub-hosted raster) | ⚠️ `icon.svg` is SVG; add `icon-180.png` if a raster is required |
| Optional screenshots via `screenshots.json` | ✅ `docs/screenshot-panel.png` |
| Optional npm package (improves install) | ⏳ `npm publish` when ready |

## Steps

1. Create the plugin repository (this folder can be its root) and add the
   `dsh-plugin` topic.
2. Wait until the repository is at least 24 hours old (CI checks creation date).
3. Fork `awesome-dsh-plugin/awesome-dsh-plugin`, add
   `data/plugins/Making-acid__dsh-approval-preflight.yml` with the prepared
   content, and open one PR (at most 3 entries per PR).
4. To also get the npm install path and download counts, publish the package
   (`npm publish --access public`).
5. After the PR merges, the site and both markets pick the entry up on the next
   build (usually within a day).
