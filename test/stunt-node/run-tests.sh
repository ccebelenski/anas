#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config.sh"

echo "=== ANAS Integration Test Run ==="
echo

SNAPSHOT="${1:-baseline}"

# Restore snapshot
echo "Restoring '${SNAPSHOT}' snapshot..."
"${SCRIPT_DIR}/restore.sh" "$SNAPSHOT"
echo

# Deploy current code
echo "Deploying current ANAS build..."
"${SCRIPT_DIR}/deploy-anas.sh"
echo

# Run Playwright tests
echo "Running integration tests..."
cd "$PROJECT_ROOT"
npx playwright test --project=integration

echo
echo "=== Integration tests complete ==="
