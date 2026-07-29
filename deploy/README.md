# deploy/

Production configuration that lives outside the app but can still break the site.
Kept here so it is reviewable and revertible like the rest of the codebase.

## Caddyfile

Deployed copy of `/etc/caddy/Caddyfile` on the EC2 box. Caddy terminates TLS and is the
only thing that should reach the Node apps — they bind to `127.0.0.1` (see `index.js`),
because `0.0.0.0:3000` was reachable from the internet and, with `trust proxy: 1` set,
that made `req.ip` forgeable by anyone willing to send their own `X-Forwarded-For`.

**Two traps in this file, both encountered the hard way:**

1. It contains **three commented-out copies** of the `savchenkosolutions.com` block. `#`
   comments only its own line, so inserting a directive inside one of those blocks makes
   it a top-level directive and Caddy rejects the entire config. Anchor edits to a
   start-of-line `savchenkosolutions.com {`.

2. `reverse_proxy` **appends** to `X-Forwarded-For`. With Express `trust proxy: 1` that
   means `req.ip` is correct and the raw header is attacker-controlled — the opposite of
   the usual assumption. Never read `req.headers['x-forwarded-for']`; never take
   `.split(',')[0]`.

To apply a change:

    sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
    sudo caddy validate --config /etc/caddy/Caddyfile   # ALWAYS, before reloading
    sudo systemctl reload caddy                          # reload, not restart

A failed `reload` leaves the previous config serving. A failed `restart` takes the site
down — prefer reload.

## Access log

`log` writes JSON to `/var/log/caddy/access.log`, rolling at 20 MiB, 5 files, 7 days
(~30 MiB steady state, since Caddy gzips rolled files). The box runs at ~89% disk, so do
not raise those numbers without checking `df -h /` first. The log captures `User-Agent`
and `Accept-Language`, which are the two headers `botgate.js` classifies on; read it with
`scripts/traffic-report.js` or plain `jq`.
