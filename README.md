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

This repository intentionally contains **code and workflow only**: no
secrets, no session data, no state, and no camera media.
