# Third-Party Notices

NCrawl uses the following open-source software as unmodified dependencies.
Full license texts ship inside each package under `node_modules/<package>/`.

| Component | License | Copyright / source |
|---|---|---|
| Playwright (`playwright`, `playwright-core`) 1.64.1 | Apache-2.0 | Microsoft Corporation — https://github.com/microsoft/playwright |
| Chromium (downloaded by Playwright, build 1248) | BSD-3-Clause and bundled third-party licenses | The Chromium Authors — https://www.chromium.org |
| Zod 4.6.7 | MIT | Colin McDonnell — https://github.com/colinhacks/zod |
| TypeScript 7.0.2 (development only) | Apache-2.0 | Microsoft Corporation |
| @types/node 24.19.2 (development only) | MIT | DefinitelyTyped contributors |

Playwright's NOTICE file must accompany any redistribution of Playwright.
If a Docker image or installer ever bundles the Chromium binary, include Chromium's
license files (shipped next to the binary in `~/.cache/ms-playwright/chromium-*/`).

No source code from Steel Browser, Stagehand, Browser Use, or other evaluated
projects is included.
