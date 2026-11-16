#!/usr/bin/env bash
# Run the integration suite against the stunt node AS IT STANDS.
# Nothing else: no snapshot restore, no deploy. For those, see
# restore-deploy-test.sh, which composes them under its own name.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

# A proof run: a spec whose fixture is not present FAILS instead of skipping
# (tests/integration/fixtures/stunt-node.ts, skipIfFixtureMissing) — a fixture
# that fell over never reads as green.
echo "=== ANAS integration tests (node as it stands) ==="
cd "$PROJECT_ROOT"
ANAS_REQUIRE_FIXTURES=1 npx playwright test --project=integration "$@"
