# Speed-test module

This directory owns the download-check feature. Keep it independent from ordinary subscription import, proxy switching and renderer page state.

## Boundaries

- `controller.ts` — task lifecycle, worker concurrency, budgets, cancellation and result policy.
- `service.ts` — Mihomo API adapter used by the controller.
- `runtime.ts` — private loopback listeners and hidden selector groups injected into the core runtime config.
- `download.ts` — explicit HTTP CONNECT/TLS streaming downloader with no direct fallback.
- `cleanup.ts` — acknowledgement-based cleanup of connections owned by one private listener.
- `model.ts` — pure node graph expansion, URL validation and result policy.
- `../shared/speedtest.ts` — IPC-safe shared types and fixed limits.
- `*.test.ts` — pure, transport, controller, cleanup and isolated Mihomo integration tests.

New selection policies should be added as pure model/controller behavior first, then exposed through `service.ts` and the renderer. Do not add subscription credentials, public node addresses or real acceptance reports to this directory.
