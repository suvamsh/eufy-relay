# eufy-relay

Scheduled sweep that pulls security-camera event bundles from on-device
storage and forwards them for review.

- `app/sweep.mjs` — the sweep. Restores a stored session (supplied as an
  Actions secret at runtime; never committed), connects to each camera
  station, queries its event database since a per-station watermark,
  downloads thumbnails for all new records and clips for person-flagged /
  priority-camera records, and writes one bundle per record.
- `.github/workflows/relay.yml` — runs the sweep every 15 minutes.
  Bundles and sweep state are committed to a separate **private** data
  repository over SSH with a write deploy key.
- `app/listener.mjs` — the push listener (Stage 1 of the security-guard
  program). A long-lived, self-chaining job holds the client's FCM push
  registration; the moment a camera event pushes, it pulls that event's
  snapshot + clip by the push's exact file path and commits a priority
  bundle (`source: "push"`, `priority: true`) to the data repo, plus a
  heartbeat (`listener-state.json`). `.github/workflows/listener.yml`
  runs the links. The sweep remains the backstop; the listener never
  touches sweep state.

This repository intentionally contains **code and workflow only**: no
secrets, no session data, no state, and no camera media.
