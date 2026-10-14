# Muse Security Guard

Open-source camera guard for Muse: a GitHub Actions fleet that pulls
Eufy camera event snapshots and full video clips from on-device storage,
so a Muse agent can review them and alert only on events that actually
matter, instead of Eufy's noisy motion-only notifications.

Status: live and in active testing (first production deployment: October
2026). This repository is the open-source core of Muse Security Guard
and will be part of the MuseGuard installer.

## How it works

- `app/sweep.mjs` - the sweep (`.github/workflows/relay.yml`, every 15
  minutes). Restores a stored Eufy guest session (supplied as an Actions
  secret at runtime; never committed), connects to each camera station,
  and delivers one bundle per new event: snapshot, plus the event's raw
  clip where the camera has a working clip path. Bundles and sweep state
  are committed to a separate **private** data repository over SSH with
  a write deploy key.
- `app/listener.mjs` - the push listener (Stage 1 of the security-guard
  program). A long-lived, self-chaining job holds the client's FCM push
  registration; the moment a camera event pushes, it pulls that event's
  snapshot + clip by the push's exact file path and commits a priority
  bundle (`source: "push"`, `priority: true`) to the data repo, plus a
  heartbeat (`listener-state.json`). `.github/workflows/listener.yml`
  runs the links. The sweep remains the permanent ground-truth backstop;
  the listener never touches sweep state, and it is the fleet's only
  push registrant (every other workflow runs with `EUFY_NO_PUSH=1`).
- `app/session-keeper.mjs` - session permanence. Eufy issues guest
  sessions with a hard ~30-day expiry and no refresh flow, so the keeper
  verifies a canonical session copy kept in the private data repo and
  renews it by a full guest login inside a 72-hour margin.
- `app/liveness.mjs` - per-camera liveness probes (livestream wake and
  frame decode) that distinguish a quiet camera from a dead one.
- `app/away-watch.mjs` / `app/away-state.mjs` - away posture: the indoor
  camera's enabled state arms the system, and a chained watch judges
  livestream person-triggers while the house is empty.

The reviewing agent (the "brain": judging criteria, household registry,
alert escalation) runs on the Muse side and is not in this repository.

## Repository layout

This repository intentionally contains **code and workflow only**: no
secrets, no session data, no state, and no camera media. A deployment
needs, outside this repo:

- a Eufy guest account with the cameras shared to it
- a private companion data repository for state and event bundles
- Actions secrets: `EUFY_USERNAME`, `EUFY_PERSISTENT_JSON`,
  `EUFY_GUEST_PASSWORD` (for keeper renewals), `DATA_DEPLOY_KEY`

## Name history

Renamed from `eufy-relay` to `muse-security-guard` on October 14, 2026.
GitHub redirects the old URL. The private data repository keeps its
internal name (`eufy-relay-data`) for now; the workflows reference it
by that name.
