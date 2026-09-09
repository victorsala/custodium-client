#!/bin/sh
# Construeix el commit del mirall públic (victorsala/custodium-client): l'arbre
# del commit actual sense CLAUDE.md ni .github/, encadenat a l'últim commit
# publicat (la branca local public-mirror, que és la història del repo públic).
#
# Escriu el hash a stdout: `npm run deploy` el desa a public/VERSION, i després
# es publica amb `git push origin-public public-mirror:main`. Si l'arbre no ha
# canviat des de l'últim mirall, reutilitza el commit anterior (VERSION estable).
set -e
cd "$(git rev-parse --show-toplevel)"
GIT_INDEX_FILE="$(git rev-parse --git-dir)/public-mirror-index"
export GIT_INDEX_FILE
trap 'rm -f "$GIT_INDEX_FILE"' EXIT

PARENT=$(git rev-parse -q --verify refs/heads/public-mirror) || {
  echo "Falta la branca public-mirror. Crea-la amb:" >&2
  echo "  git fetch origin-public main && git branch public-mirror FETCH_HEAD" >&2
  exit 1
}

git read-tree HEAD
git rm -r --cached -q --ignore-unmatch CLAUDE.md .github
TREE=$(git write-tree)

if [ "$TREE" = "$(git rev-parse "$PARENT^{tree}")" ]; then
  COMMIT=$PARENT
else
  COMMIT=$(git log -1 --pretty=%B HEAD | git commit-tree "$TREE" -p "$PARENT" -F -)
  git update-ref refs/heads/public-mirror "$COMMIT"
fi
echo "$COMMIT"
