# Contributing to Graphium

Thanks for helping. Graphium aims to stay small, fast and easy to read, so
the best changes are the ones that make it work better for everyday browsing
without adding much code.

## Before you start

- **Bugs:** open an issue with steps to reproduce, your system and the
  Graphium version.
- **New features:** open an issue first so we can agree it fits. Graphium
  deliberately leaves out AI features, accounts, sync and Chrome extensions.
- **Security problems:** follow [SECURITY.md](SECURITY.md), not a public issue.

## Setup

You need [Node.js](https://nodejs.org) 22 or newer.

```sh
git clone https://github.com/Pascalllllll/Graphium-Browser.git
cd Graphium-Browser
npm install
npm start
```

## Code

- Plain JavaScript, HTML and CSS. No frameworks and no build step.
- Match the style of the file you're editing: 2-space indent, single quotes,
  semicolons.
- Internal pages live in `src/pages/` and are served from `graphium://`.
  Only those pages get the `window.graphium` API; never expose it to web pages.
- Keep memory use in mind. If a change could affect it, compare with
  `npx electron test/memory.js` before and after.

## Tests

```sh
npm test
```

This starts the real browser and runs end-to-end checks. It needs an internet
connection, and on Linux without a display run it under `xvfb-run`. Add a
check to `test/smoke.js` when you fix a bug or add a feature.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep each pull request to one change, and describe what it fixes and how
   you tested it.
3. Make sure `npm test` passes.

By contributing you agree that your work is released under the
[MIT license](LICENSE) and that you follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
