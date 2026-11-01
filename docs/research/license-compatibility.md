# License Compatibility Report

Not legal advice — have counsel confirm before commercial distribution.

## Dependencies actually used

| Package | Version | License | Use | Obligations |
|---|---|---|---|---|
| playwright / playwright-core | 1.64.1 | Apache-2.0 | Browser automation | Keep LICENSE + NOTICE when redistributing; state changes if modified (we don't modify) |
| Chromium (downloaded by Playwright) | build pinned by Playwright 1.64.1 | BSD-3-Clause + bundled third-party licenses | Browser engine | Ship Chromium's license files if NCrawl redistributes the browser binary (e.g. in a Docker image) |
| zod | 4.6.7 | MIT | Schema validation | Keep copyright notice |
| typescript (dev) | 7.0.2 | Apache-2.0 | Type checking | Dev only, not distributed |
| @types/node (dev) | 24.19.2 | MIT | Types | Dev only |

All are permissive and commercially compatible. Attribution is collected in
`THIRD_PARTY_NOTICES.md`.

## Evaluated, not used

| Project | License | Compatible? | Why not used |
|---|---|---|---|
| Steel Browser | Apache-2.0 | Yes | Functional/policy conflict (see research report), not license |
| Stagehand | MIT | Yes | LLM-first; cloud SDK dependency |
| Browser Use | MIT | Yes | Python LLM agent; mandatory LLM SDKs and analytics client |
| Puppeteer | Apache-2.0 | Yes | Overlaps with Playwright |
| Playwright MCP | Apache-2.0 | Yes | Possible future adapter reference |

No GPL/AGPL/SSPL code is involved. If code is ever adapted from an Apache-2.0
project, keep its license header and add the project to `THIRD_PARTY_NOTICES.md`.

NCrawl's own license has not been chosen; that is the owner's decision.
