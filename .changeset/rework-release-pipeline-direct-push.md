---
"claudemux": patch
---

Rework the release pipeline onto direct-push beta + GA and drop the self-built workaround layer. release-next no longer rewrites pre.json internal state (the `prepare-prerelease-changesets` script is removed) and sets `HUSKY=0` so the bot's version-bump push is not blocked by the local pre-push changeset check — a check that misfires on the release commit because the bump touches a release-surface file (`package.json`) whose changeset is already consumed. GA moves off the never-run `workflow_dispatch` promote button onto a push-to-main workflow that exits pre mode, versions, and pushes the GA commit directly; `reset-next-pre` then fast-forwards next to main's GA state and re-enters beta pre mode so the next prerelease cycle versions from the GA base instead of re-consuming shipped changesets.
