# Deploy on a Synology NAS

One way to run Kee+ at home: a git clone on the NAS, built and run with
Container Manager's `docker compose`, reached only over Tailscale, through
`tailscale serve` (HTTPS). Replace the placeholders:

- `<nas>`: an SSH host alias for the NAS
- `<repo-url>`: where you host your clone (GitHub, or your own Gitea)
- `/volume1/docker/mynotes`: the folder for the clone on the NAS
- `<nas-name>.<tailnet>.ts.net`: the NAS's MagicDNS name (Tailscale admin
  console, Machines)

## First-time setup

The container listens on `127.0.0.1:8090` only, so nothing on the LAN can
reach it. `tailscale serve` on the NAS puts it on the tailnet over HTTPS.

1. In the Tailscale admin console, under DNS, turn on MagicDNS and HTTPS
   Certificates.
2. Clone and start:

```sh
ssh <nas> 'git clone <repo-url> /volume1/docker/mynotes \
  && git -C /volume1/docker/mynotes config core.fileMode false \
  && cd /volume1/docker/mynotes && /usr/local/bin/docker compose up -d --build --remove-orphans'
```

`core.fileMode false` is needed because DSM's ACLs mark every file as
executable.

3. Tell the server its name, so it accepts that `Host` (anything else gets
   421), then restart:

   ```sh
   ssh <nas> 'cd /volume1/docker/mynotes \
     && echo MYNOTES_HOSTS=<nas-name>.<tailnet>.ts.net > .env \
     && /usr/local/bin/docker compose up -d --remove-orphans'
   ```

   `.env` is ignored by git, so pulls keep it.
4. Proxy HTTPS on the tailnet to the container. `--bg` keeps it across
   reboots:

   ```sh
   ssh <nas> 'sudo /var/packages/Tailscale/target/bin/tailscale serve --bg 8090'
   ```

   `tailscale serve status` shows it. Open
   `https://<nas-name>.<tailnet>.ts.net`; the first request can take a few
   seconds while the certificate is issued.
5. Restrict who on the tailnet can reach the NAS (see Access control).

## Access control

By default every device in the tailnet can reach every other. Tag the NAS
(admin console, Machines, the NAS, Edit ACL tags: `tag:nas`) and allow only
your own user in the policy file (Access controls). Replace the default
allow-all rule:

```json
{
  "tagOwners": { "tag:nas": ["autogroup:admin"] },
  "grants": [
    { "src": ["autogroup:member"], "dst": ["autogroup:self"], "ip": ["*"] },
    { "src": ["<you>@example.com"], "dst": ["tag:nas"],
      "ip": ["tcp:443", "tcp:22", "tcp:5000-5001"] }
  ]
}
```

`tcp:443` is Kee+; 22 and 5000–5001 are SSH and DSM, drop what you don't
use over Tailscale. Tagging a machine disables its key expiry and takes it
off your user, so Tailscale SSH rules for it must name the tag. Check with
the policy file's Preview rules tab, then from another device:
`tailscale ping <nas-name>` should still work for you.

## Deploy an update

Work happens in a clone on your PC. The NAS clone only pulls; never edit
files there.

1. Commit on the PC and push.
2. Pull on the NAS and rebuild the container:

   ```sh
   ssh <nas> 'cd /volume1/docker/mynotes && git -c safe.directory="*" pull && /usr/local/bin/docker compose up -d --build --remove-orphans'
   ```

`safe.directory` is needed when the NAS folder's owner differs from the SSH
user.

Open clients reload themselves at their next sync after a deploy that
changes `public/`.

## Data

The database and attachments live in `./data` next to the clone
(`/volume1/docker/mynotes/data`). It is ignored by git: back it up
separately, for example with Hyper Backup.

## Open it on the iPhone

1. Install Tailscale from the App Store and sign in to the same tailnet as
   the NAS.
2. Turn on VPN On Demand in Tailscale's settings, so the app works at home
   and away with one address.
3. Open `https://<nas-name>.<tailnet>.ts.net` in Safari.

To get an app icon, use Share, then Add to Home Screen, in Safari.

## Moving from the old `http://<ip>:8090` address

Each address keeps its own local copy (`localStorage`), and the new one
starts empty. Notes the server has come back at the first sync, but edits
a device has not synced yet stay behind on the old address, and per-device
settings (sort, zoom, sidebar) start at their defaults.

1. Before deploying, open the old address on every device and let it sync
   (online, and wait a few seconds after the last edit).
2. Deploy. The old address stops working.
3. On each device, open the new address and add it to the home screen
   again; delete the old icon.

## Remove

```sh
ssh <nas> 'cd /volume1/docker/mynotes && /usr/local/bin/docker compose down --rmi all'
ssh <nas> 'rm -r /volume1/docker/mynotes'
```

The second command also deletes `./data`, so every note and attachment.
