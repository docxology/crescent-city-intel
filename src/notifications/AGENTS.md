# AGENTS.md — crescent-city-intel/src/notifications

`push.ts` — desktop push notifications for the Crescent City Intel GUI.
Two paths: (1) webhook via `ALERT_WEBHOOK_URL` (fire-and-forget POST);
(2) VAPID Web Push via `PUSH_PUBLIC_KEY` / `PUSH_PRIVATE_KEY` for browser
push. Both degrade gracefully when their env vars are absent — no hard
dependency on notification delivery.