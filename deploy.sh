#!/bin/sh
# Update this clone to the latest commit and rebuild the container.
# Run it on the host that runs Kee+ (e.g. the NAS), from anywhere:
#   ./deploy.sh            or   ssh <nas> /volume1/docker/<folder>/deploy.sh
# Never edit files in this clone by hand: the pull only fast-forwards.
set -eu

cd "$(dirname "$0")"

# Synology's docker lives outside the default PATH of an SSH session.
DOCKER=$(command -v docker || true)
[ -n "$DOCKER" ] || DOCKER=/usr/local/bin/docker
[ -x "$DOCKER" ] || { echo "deploy: docker not found" >&2; exit 1; }

before=$(git -c safe.directory='*' rev-parse --short HEAD)
# safe.directory: the folder's owner can differ from the SSH user on a NAS.
git -c safe.directory='*' pull --ff-only
after=$(git -c safe.directory='*' rev-parse --short HEAD)

if [ "$before" = "$after" ]; then
  echo "deploy: already at $after; rebuilding anyway"
else
  echo "deploy: $before -> $after"
  git -c safe.directory='*' --no-pager log --oneline "$before..$after"
fi

"$DOCKER" compose up -d --build --remove-orphans
"$DOCKER" compose ps
