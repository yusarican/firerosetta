#!/usr/bin/env bash
# FireRosetta release bundles: build them, publish them, fetch them.
#
# Three bundles, one per trained model, so you only download what you need:
#   data       harmonization model output + the hotspot table it was built from (~250 MB)
#   earlywarn  supervised 1-3 month early-warning model + its inference tables (~35 MB)
#   static     unsupervised static-heat-source detector + scored site table (~14 MB)
#
# Every bundle stores its files under the data/ subdirectory they belong in, so all three
# extract the same way (tar -xzf <bundle> -C data) and nothing needs per-bundle routing.
#
#   ./scripts/release.sh fetch            # download + verify + extract all three
#   ./scripts/release.sh fetch static     # just one
#   ./scripts/release.sh build all        # rebuild the tarballs from local data/
#   ./scripts/release.sh publish all      # create/update the GitHub releases
#   ./scripts/release.sh list             # what is published right now
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${FIREROSETTA_REPO:-yusarican/firerosetta}"
DATA="$ROOT/data"
MODELS="$DATA/models"
BUNDLES=(data earlywarn static)

tag_for()   { case "$1" in data) echo data-v1;; earlywarn) echo earlywarn-v1;; static) echo static-v1;; esac; }
file_for()  { echo "firerosetta-$1.tar.gz"; }
title_for() {
  case "$1" in
    data)      echo "FireRosetta data + harmonization model v1";;
    earlywarn) echo "FireRosetta early-warning model v1";;
    static)    echo "FireRosetta static-source detector v1";;
  esac
}

die() { echo "Error: $*" >&2; exit 1; }

expand() {  # "" or "all" -> every bundle; otherwise validate what was asked for
  local want=("$@")
  if [[ ${#want[@]} -eq 0 || "${want[0]}" == "all" ]]; then printf '%s\n' "${BUNDLES[@]}"; return; fi
  for b in "${want[@]}"; do
    [[ " ${BUNDLES[*]} " == *" $b "* ]] || die "unknown bundle '$b' (pick from: ${BUNDLES[*]}, all)"
    echo "$b"
  done
}

sha_of() { sha256sum "$1" | cut -d' ' -f1; }

# ---------------------------------------------------------------- build
build_data() {
  # Only the base pipeline's own output. The forecast_* and static_* tables live in their
  # own bundles, so nothing is shipped twice and each model can be re-released on its own.
  local need=(staged/hotspots.parquet processed/cell_month.parquet processed/cells.parquet
              processed/harmonized.parquet processed/metrics.json)
  for f in "${need[@]}"; do
    [[ -f "$DATA/$f" ]] || die "missing $DATA/$f - run the pipeline first (./start.sh --rebuild)"
  done
  mkdir -p "$MODELS"
  echo "==> building $(file_for data)"
  tar -czf "$MODELS/$(file_for data)" -C "$DATA" "${need[@]}"
}

build_one() {
  case "$1" in
    data)      build_data;;
    # These two know how to package themselves, including the metrics sidecar.
    earlywarn) echo "==> building $(file_for earlywarn)"
               (cd "$ROOT/backend" && uv run python -m firerosetta.forecast --package >/dev/null);;
    static)    echo "==> building $(file_for static)"
               (cd "$ROOT/backend" && uv run python -m firerosetta.static --package >/dev/null);;
  esac
  local f="$MODELS/$(file_for "$1")"
  [[ -f "$f" ]] || die "build produced no $f"
  echo "$(sha_of "$f")  $(basename "$f")" > "$MODELS/firerosetta-$1.sha256"
  printf '    %s (%s)\n    sha256 %s\n' "$(basename "$f")" \
    "$(du -h "$f" | cut -f1)" "$(sha_of "$f")"
}

# ---------------------------------------------------------------- publish
publish_one() {
  local b="$1" tag file target
  tag="$(tag_for "$b")"; file="$MODELS/$(file_for "$b")"
  [[ -f "$file" ]] || die "$file not built yet - run: $0 build $b"
  target="${RELEASE_TARGET:-$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)}"

  # The tag is cut from this commit, so it must already exist on the remote.
  git -C "$ROOT" ls-remote --exit-code --heads origin "$target" >/dev/null 2>&1 \
    || die "branch '$target' is not pushed yet; push it before publishing (the tag is cut from it)"

  if gh release view "$tag" -R "$REPO" >/dev/null 2>&1; then
    echo "==> $tag exists, replacing its assets"
    gh release upload "$tag" "$file" "$MODELS/firerosetta-$b.sha256" -R "$REPO" --clobber
  else
    echo "==> creating release $tag on branch '$target'"
    gh release create "$tag" "$file" "$MODELS/firerosetta-$b.sha256" \
      -R "$REPO" --target "$target" --title "$(title_for "$b")" \
      --notes-file <(notes_for "$b")
  fi
}

notes_for() {
  cat <<NOTES
Extract into \`data/\`, or let the script do it:

\`\`\`bash
./scripts/release.sh fetch $1
\`\`\`

Verify by hand:

\`\`\`bash
tar -xzf $(file_for "$1") -C data
sha256sum -c firerosetta-$1.sha256
\`\`\`

sha256: \`$(sha_of "$MODELS/$(file_for "$1")")\`
NOTES
}

# ---------------------------------------------------------------- fetch
download() {  # <tag> <filename> <dest>
  local tag="$1" name="$2" dest="$3"
  # gh first: it carries credentials, so this keeps working while the repo is private and
  # needs no token from the user. Plain curl is the fallback once the repo is public.
  if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
    gh release download "$tag" -R "$REPO" -p "$name" -O "$dest" --clobber >/dev/null 2>&1 && return 0
  fi
  curl -fSL --retry 3 --retry-delay 2 -o "$dest" \
    "https://github.com/$REPO/releases/download/$tag/$name" 2>/dev/null
}

fetch_one() {
  local b="$1" tag file tmp
  tag="$(tag_for "$b")"; file="$(file_for "$b")"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN

  echo "==> fetching $b ($tag)"
  if ! download "$tag" "$file" "$tmp/$file"; then
    echo "    could not download $file from $REPO@$tag" >&2
    return 1
  fi
  if download "$tag" "firerosetta-$b.sha256" "$tmp/sum"; then
    # The checksum file names the tarball, so verify from the directory holding it.
    (cd "$tmp" && sha256sum -c <(sed "s|  .*|  $file|" sum) >/dev/null) \
      || die "checksum mismatch for $file - refusing to extract"
    echo "    checksum OK"
  else
    echo "    warning: no published checksum for $b, extracting unverified" >&2
  fi
  mkdir -p "$DATA"
  tar -xzf "$tmp/$file" -C "$DATA"
  echo "    extracted into $DATA"
}

# ---------------------------------------------------------------- main
cmd="${1:-fetch}"; shift || true
case "$cmd" in
  build)   for b in $(expand "$@"); do build_one "$b"; done;;
  publish) for b in $(expand "$@"); do publish_one "$b"; done;;
  fetch)
    ok=0; fail=0
    for b in $(expand "$@"); do fetch_one "$b" && ok=$((ok+1)) || fail=$((fail+1)); done
    echo "==> $ok bundle(s) installed, $fail failed"
    [[ $fail -eq 0 ]];;
  list)    gh release list -R "$REPO";;
  *)       sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 1;;
esac
