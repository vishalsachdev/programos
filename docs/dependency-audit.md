# Dependency audit

The triage of every `npm audit` finding in this repo, run on 2026-11-20 for issue 21. Each finding is **FIXED** (upgraded), **NOT REACHABLE** (the reason is given), or **ACCEPTED** (not fixed; the risk and its owner are given). Run the commands again before a security review: the advisory database changes even when the lockfile does not.

## Commands

Run in the repo root, in `container/agent-runner/` and in `inbound/`, each after `npm ci`:

```
npm audit --json
```

Fixes were taken with `npx npm@11.6.2 audit fix --before=2026-11-13` (npm 10.9 stops with an internal error on vitest's peer dependencies). `--before` keeps to the 7-day minimum release age set in `.npmrc`. `npm install --package-lock-only` with npm 10 then brought the lockfile in line with what `npm ci` on npm 10 (the CI version) expects. In `inbound/`, the exact `vitest` pin was raised by hand. No `package.json` range changed outside `inbound/`, and no `overrides` entry was added.

## Counts

| Where | Critical | High | Moderate | Low | Total |
|---|---|---|---|---|---|
| root, before | 1 | 12 | 10 | 1 | 24 |
| root, after | 0 | 1 | 7 | 1 | 9 |
| `container/agent-runner/`, before | 0 | 3 | 5 | 0 | 8 |
| `container/agent-runner/`, after | 0 | 0 | 0 | 0 | 0 |
| `inbound/`, before | 1 | 0 | 1 | 0 | 2 |
| `inbound/`, after | 0 | 0 | 0 | 0 | 0 |

"Before" is `main` at `eb41d56`. The README said 26 for the root. On 2026-11-19 issue 21 counted 24 with the same lockfile, so the advisory database changed in between.

The 9 still reported at the root are `xlsx` (high, accepted with a mitigation), `esbuild` (low, not reachable), and one `minimatch` advisory (moderate, not reachable), which npm counts seven times: once for `minimatch` and once for each of the six typescript-eslint packages that pull it in.

## Findings

One row per package that `npm audit` reported before the change. "Where it comes from" names the package that pulls it in and whether it runs in the service or only in development. Advisory ids link at `https://github.com/advisories/<id>`.

| Where | Package | Severity | Advisories | Where it comes from | Decision | Reason |
|---|---|---|---|---|---|---|
| root | `@humanfs/node` | moderate | GHSA-p498-v437-472g | eslint (dev, lint only) | **FIXED** | 0.16.7 → 0.16.8. |
| root | `@typescript-eslint/eslint-plugin` | moderate | via `@typescript-eslint/type-utils`, `@typescript-eslint/utils` | typescript-eslint (dev) | **NOT REACHABLE** | As typescript-eslint. |
| root | `@typescript-eslint/parser` | moderate | via `@typescript-eslint/typescript-estree` | typescript-eslint (dev) | **NOT REACHABLE** | As typescript-eslint. |
| root | `@typescript-eslint/type-utils` | moderate | via `@typescript-eslint/typescript-estree`, `@typescript-eslint/utils` | typescript-eslint (dev) | **NOT REACHABLE** | As typescript-eslint. |
| root | `@typescript-eslint/typescript-estree` | moderate | via `minimatch` | typescript-eslint (dev) | **NOT REACHABLE** | As typescript-eslint. |
| root | `@typescript-eslint/utils` | moderate | via `@typescript-eslint/typescript-estree` | typescript-eslint (dev) | **NOT REACHABLE** | As typescript-eslint. |
| root | `@vitest/mocker` | moderate | GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8 | vitest (dev) | **FIXED** | 4.0.18 → 4.1.12 with vitest. |
| root | `@xmldom/xmldom` | high | GHSA-27p8-2357-5qqv, GHSA-4w3w-2rp5-g8jm, GHSA-6gmq-8vp8-gcm6, GHSA-6h8r-xr42-gp59, GHSA-8344-3jmq-59r6, GHSA-93r5-fhx6-vmg9, GHSA-965w-775f-mr7g, GHSA-c7q8-3ch8-vqpv, GHSA-w2rr-34g9-rvrj, GHSA-x4fp-j954-r2f4 | mammoth (runtime; parses untrusted .docx attachments) | **FIXED** | 0.8.13 → 0.8.15. |
| root | `brace-expansion` | high | GHSA-3jxr-9vmj-r5cp, GHSA-6j4f-fj2g-mc7p, GHSA-jxxr-4gwj-5jf2, GHSA-mh99-v99m-4gvg, GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-rgw5-rvv9-x895 | minimatch, under eslint and typescript-eslint (dev, lint only) | **FIXED** | 1.1.14 → 1.1.22 and 5.0.5 → 5.0.13. |
| root | `esbuild` | low | GHSA-g7r4-m6w7-qqqr | tsx and vite (dev) | **NOT REACHABLE** | Still 0.27.3: `tsx` 4.21.0 requires `~0.27.0` and the fix is 0.28.1. The advisory needs esbuild's development server (`esbuild --serve`) on Windows. Nothing in this repo starts it; `tsx` uses the transform API, and production runs `node dist/`. No untrusted input reaches it. |
| root | `fast-copy` | moderate | GHSA-jggr-w7fw-pc2j | pino-pretty (runtime logger) | **FIXED** | 4.0.2 → 4.3.1. |
| root | `js-yaml` | high | GHSA-2883-xcg3-v3hh, GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj, GHSA-h67p-54hq-rp68 | @eslint/eslintrc (dev, lint only) | **FIXED** | 4.1.1 → 4.3.2. No file of ours imports js-yaml. |
| root | `linkify-it` | high | GHSA-22p9-wv53-3rq4, GHSA-v245-v573-v5vm | mailparser (runtime; untrusted mail) | **FIXED** | 5.0.0 → 5.0.2. |
| root | `mailparser` | high | via `linkify-it`, `nodemailer` | Direct, runtime: parses every inbound mail (`src/document-extractor.ts`, `src/channels/webhook.ts`, `src/cc-context.ts`, `src/email-loop-detection.ts`, `src/channels/webhook-threading.ts`) | **FIXED** | 3.9.8 → 3.14.3 (range `^3.9.6` unchanged). Untrusted input: yes. Its own advisories are through linkify-it and nodemailer, below. |
| root | `minimatch` | moderate | GHSA-g3hv-75wg-m249 | @typescript-eslint/typescript-estree (dev, lint only) | **NOT REACHABLE** | Now 10.2.6, still in the range. The fix (11.0.9) comes with typescript-eslint 8.73.0, published 2026-11-16, younger than the 7-day minimum release age in `.npmrc`. Only `npm run lint` uses it, on glob patterns from our own config; no untrusted input reaches it, and neither CI nor the running service runs lint. Take 8.73.0 from 2026-11-23. |
| root | `nanoid` | high | GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8, GHSA-xwg4-73v4-xw9w | postcss (dev) | **FIXED** | 3.3.11 → 3.3.20. |
| root | `nodemailer` | high | GHSA-268h-hp4c-crq3, GHSA-2x7j-588g-ccc2, GHSA-39m8-27wv-hr27, GHSA-4ffr-jq9g-5ffx, GHSA-4g23-2xm8-66gc, GHSA-6vj9-mwq6-2f5v, GHSA-85x2-q946-cp5h, GHSA-8c8m-p3m8-cjg8, GHSA-8m3c-c648-2xjj, GHSA-8vvx-rff5-p5rq, GHSA-cc9r-2j5m-2m83, GHSA-g73g-hqqh-jr95, GHSA-m943-m63m-w62w, GHSA-p6gq-j5cr-w38f, GHSA-r7g4-qg5f-qqm2, GHSA-v53p-9fqp-m79j, GHSA-wmmp-3585-3rmp, GHSA-wqvq-jvpq-h66f | mailparser (runtime; untrusted mail) | **FIXED** | 8.0.5 → 10.5.0, as mailparser 3.14.3 requires. Our code does not import nodemailer; mailparser uses its address parser on untrusted headers, which several advisories name. |
| root | `postcss` | high | GHSA-fxqj-rqcc-2cmp, GHSA-r28c-9q8g-f849 | vite (dev) | **FIXED** | 8.5.12 → 8.5.32. |
| root | `source-map-js` | high | GHSA-68fv-2mgg-jv7q | postcss (dev) | **FIXED** | 1.2.1 → 1.2.2. |
| root | `typescript-eslint` | moderate | via `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, `@typescript-eslint/typescript-estree`, `@typescript-eslint/utils` | Direct, dev only: lint | **NOT REACHABLE** | 8.57.1 → 8.72.2. Flagged only for the minimatch above; same reason. |
| root | `vite` | high | GHSA-587h-7wmj-h5pm, GHSA-698v-4r3x-3vcv, GHSA-9jrq-w75r-8gcw, GHSA-fx2h-pf6j-xcff, GHSA-r825-w8mm-5pxw, GHSA-rq7h-c2jc-7f22, GHSA-v6wh-96g9-6wx3 | vitest (dev) | **FIXED** | 7.3.2 → 8.3.8, the version vitest 4.1.12 resolves. Our code never runs a Vite dev server; it is vitest's transform layer only. |
| root | `vitest` | critical | GHSA-5xrq-8626-4rwp, GHSA-82fw-gwwq-j7x9 | Direct, dev only: the test runner | **FIXED** | 4.0.18 → 4.1.12 (lockfile; range `^4.0.18` unchanged). The UI and browser-mode servers the advisories need are never started; full suite passes. |
| root | `xlsx` | high | GHSA-4r6h-8v6p-xvw6, GHSA-5pgg-2g8v-p4x9 | Direct, runtime: `src/document-extractor.ts` parses .xlsx and .xls attachments from inbound mail and Telegram | **ACCEPTED, mitigated** | Reachable: untrusted attachments go straight to `XLSX.read`. The registry has no fixed version (0.18.5 is the last on npm). Mitigation in this change: the parse runs in a worker thread with an empty environment, so prototype pollution stays in the worker's realm and a slow parse does not block the host; output for valid files is unchanged (a test compares it with an in-process parse). Remaining risk: a crafted file can still hang or exhaust that worker. Owner: the deployment's operator. Follow-up: issue linked below. |
| root | `zod` | high | GHSA-mrhx-c7xc-m3w5 | Direct dependency, but no file in `src/`, `setup/` or `scripts/` imports it | **FIXED** | 4.3.6 → 4.6.7 (range `^4.3.6` unchanged). |
| container/agent-runner | `@hono/node-server` | moderate | GHSA-jpvv-r467-5p4w, GHSA-qv5m-9pm6-hqp3, GHSA-rmxm-3fg6-px4f | @modelcontextprotocol/sdk (HTTP transport, unused) | **FIXED** | 2.1.1 → 2.1.8. |
| container/agent-runner | `@modelcontextprotocol/sdk` | high | GHSA-22jm-h49p-29qw, GHSA-46jr-4wx8-v453, GHSA-6prh-2h8m-c8cw, GHSA-6qxp-vccf-f47h, GHSA-rvq5-wwqv-78pq | Direct, in the agent container: the stdio MCP server `container/agent-runner/src/ipc-mcp-stdio.ts` | **FIXED** | 1.30.1 → 1.32.2 (range unchanged). We use the stdio transport; the HTTP, OAuth and bearer-auth paths the advisories name are not used. |
| container/agent-runner | `body-parser` | high | GHSA-27r3-jxmh-p828 | @modelcontextprotocol/sdk via express (unused) | **FIXED** | 2.3.0 → 2.4.0. |
| container/agent-runner | `fast-uri` | moderate | GHSA-333x-w4r6-6crp, GHSA-w74x-v6f9-j3xg, GHSA-wjr9-j795-jxcr, GHSA-xhq7-xmqj-769h | ajv, under @modelcontextprotocol/sdk | **FIXED** | 3.1.8 → 3.1.9. |
| container/agent-runner | `hono` | moderate | GHSA-3gg2-335m-rxc6, GHSA-46wx-v44x-9hh2, GHSA-4h7h-rv7c-7m2v, GHSA-4m76-xfj5-7975, GHSA-5r4p-p66f-jhc7, GHSA-h7mg-cq63-vhpq | @modelcontextprotocol/sdk (HTTP transport, unused) | **FIXED** | 4.13.9 → 4.13.18. |
| container/agent-runner | `ip-address` | moderate | GHSA-rxp7-6hxx-x8q5 | express-rate-limit, under @modelcontextprotocol/sdk (unused) | **FIXED** | 10.7.2 → 10.7.6. |
| container/agent-runner | `qs` | moderate | GHSA-6pq8-jhm2-2vcw | express, under @modelcontextprotocol/sdk (unused) | **FIXED** | 6.16.0 → 6.17.1. |
| container/agent-runner | `zod` | high | GHSA-mrhx-c7xc-m3w5 | Direct, in the agent container | **FIXED** | 4.6.5 → 4.6.7. |
| inbound | `@vitest/mocker` | moderate | GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8 | vitest (dev) | **FIXED** | 4.0.18 → 4.1.12. |
| inbound | `vitest` | critical | GHSA-5xrq-8626-4rwp, GHSA-82fw-gwwq-j7x9 | Direct, dev only (owned `inbound/`, pinned exactly) | **FIXED** | `4.0.18` → `4.1.12` in `inbound/package.json`; 33 tests pass. |

## Parsers of untrusted input

Inbound mail and its attachments are untrusted. These packages read them:

| Package | Reads | Audit finding |
|---|---|---|
| `mailparser` (with `nodemailer`'s address parser, `linkify-it`, `html-to-text`) | every inbound message | Fixed: 3.9.8 → 3.14.3 |
| `mammoth` (with `@xmldom/xmldom`) | `.docx` attachments | `@xmldom/xmldom` fixed: 0.8.13 → 0.8.15 |
| `xlsx` | `.xlsx` and `.xls` attachments | No fixed version on npm. Mitigated, accepted (below) |
| `pdf-parse` | `.pdf` attachments | None reported |
| `htmlparser2` | inbound HTML, for addresses (`src/inbound-html-addresses.ts`) | None reported |
| `sharp` | image attachments, only after `src/image.ts` has matched the leading bytes to one of four raster formats | None reported |

The `mailparser` upgrade brings `html-to-text` 10 (was 9), which turns an HTML-only mail into the text the bot reads. The test suite passes with it. A real HTML mail was not compared before and after.

### `xlsx`

`xlsx` 0.18.5 is the last version on the npm registry, and both its advisories (GHSA-4r6h-8v6p-xvw6, prototype pollution when reading a crafted file; GHSA-5pgg-2g8v-p4x9, ReDoS) are open there. `src/document-extractor.ts` gives it attachments from mail and Telegram, so the finding is reachable.

This change runs the parse in a worker thread with an empty environment. A polluted `Object.prototype` then stays in the worker's own realm and cannot change objects in the host, such as the delivery gate, the allowlists or the config. A slow parse no longer blocks the host's event loop. Output for a valid file is the same: `src/document-extractor.test.ts` compares it with an in-process parse of the same workbook.

What is not covered: a crafted file can still hang the worker or use up its memory, and then that one attachment is never extracted. No time or memory limit was added, because a limit changes what happens to a large valid file and that is the owner's decision. Owner of the remaining risk: the deployment's operator. Follow-up: issue 64 (the vendor's fixed build from its own site, a time limit setting, or a different parser).

## Added after the audit: `nodemailer` as a direct dependency (2026-11-20, issue 9)

The SMTP outbound provider (`src/outbound-email-smtp.ts`, used only with `OUTBOUND_MAIL_PROVIDER=smtp`) imports `nodemailer`'s SMTP client and message composer. This is the first code of ours that imports it; the row above that says "our code does not import nodemailer" was true when written.

- `nodemailer` `^10.5.0`, locked at 10.5.0: the same version `mailparser` 3.14.3 already pulls in, so the lockfile gains no second copy. It has no dependencies of its own. `npm audit` reports nothing for it (the advisories above end at 10.1.3). 10.6.0 existed but was 5 days old, under the 7-day minimum in `.npmrc`.
- Dev only, for the tests' local mail server: `smtp-server` 3.21.4 (pins `nodemailer` 10.5.0; brings `ipv6-normalize` and `punycode.js`), `@types/nodemailer` 8.0.2, `@types/smtp-server` 3.5.13. 3.21.6 existed and was 4 days old.
- Root count after the change: 9, the same nine as above.
- Untrusted input that reaches it: a reply's `In-Reply-To` and `References` come from the inbound mail's `Message-ID`, and the subject can echo the inbound subject. The provider strips line breaks from every header value before the library sees it and sets the envelope recipients itself from the allowlist-checked list; a test sends a line break in both and checks that no header or recipient is added. The server's replies are also untrusted input to the client; the session is TLS with certificate checks, so they come from the configured server.
- The type package is for major version 8 while the library is 10. The calls used (`SMTPConnection` connect, login, send; `MailComposer`) typecheck and are exercised by the tests against a real local server.

## Versions that now differ from the source

The repo keeps the source's exact versions on purpose. After this change, `package-lock.json` and `container/agent-runner/package-lock.json` differ from the source for the packages above marked FIXED, plus the packages they pull in. The direct dependencies that moved: `vitest` 4.1.12, `mailparser` 3.14.3, `zod` 4.6.7, `typescript-eslint` 8.72.2 (root) and `@modelcontextprotocol/sdk` 1.32.2, `zod` 4.6.7 (agent container). The reason is this audit. The lockfiles are exported code, so the consolidated patch records them. `src/document-extractor.ts` (the worker) is recorded the same way.
