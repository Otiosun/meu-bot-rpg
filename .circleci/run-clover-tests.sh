#!/usr/bin/env bash
# Only tests four known draft branches. Does not start the bot, touch a
# production database, push commits, merge PRs or deploy site/backend.
set -uo pipefail

mkdir -p artifacts
main_lock="$(git rev-parse HEAD:package-lock.json)"
overall=0
printf 'PR,Branch,SHA,Status\n' > artifacts/summary.csv

declare -a targets=(
  "337:fix/clover-raid-player-journey-20261115"
  "338:fix/raid-site-join-start-idempotency-20261115"
  "339:fix/clover-squad-star-negative-balance-20261115"
  "340:fix/raid-reward-snapshot-beneficiary-20261115"
)

for target in "${targets[@]}"; do
  pr="${target%%:*}"
  branch="${target#*:}"
  log="artifacts/pr${pr}.log"

  echo "=== PR #${pr}: ${branch} ==="

  if ! git fetch --no-tags origin "+refs/heads/${branch}:refs/remotes/origin/${branch}"; then
    echo "ERROR: failed fetching ${branch}" | tee "${log}"
    printf '%s,%s,%s,%s\n' "${pr}" "${branch}" "unavailable" "FETCH_FAIL" >> artifacts/summary.csv
    overall=1
    continue
  fi

  sha="$(git rev-parse "refs/remotes/origin/${branch}")"
  branch_lock="$(git rev-parse "refs/remotes/origin/${branch}:package-lock.json")"
  git checkout --detach --force "${sha}" || exit 1

  if [[ "${branch_lock}" != "${main_lock}" ]]; then
    echo "Dependencies changed; reinstalling on PR #${pr}"
    if ! npm ci --no-audit --no-fund; then
      echo "ERROR: npm ci failed for PR #${pr}" | tee "${log}"
      printf '%s,%s,%s,%s\n' "${pr}" "${branch}" "${sha}" "INSTALL_FAIL" >> artifacts/summary.csv
      overall=1
      continue
    fi
  fi

  case "${pr}" in
    337)
      files=(tests/raidBotPlayerJourney.test.js tests/continuePlayerJourney.test.js tests/raidHelpCommandContract.test.js)
      ;;
    338)
      files=(tests/raidIdempotentHttp.test.js tests/siteApiCanonicalRaidEvidence.test.js tests/siteApiBaseRaidLifecycleEvidence.test.js)
      ;;
    339)
      files=(tests/squadStarNegativeBalanceContract.test.js tests/captainsSeasonStars.test.js)
      ;;
    340)
      files=(tests/rewardSnapshotIntegrityContract.test.js tests/raidRewardProposalRevisionHistory.test.js tests/raidRewardProposalAuthorshipGuard.test.js)
      ;;
  esac

  if node --test "${files[@]}" > "${log}" 2>&1; then
    printf '%s,%s,%s,%s\n' "${pr}" "${branch}" "${sha}" "PASS" >> artifacts/summary.csv
    echo "PASS PR #${pr} (${sha})"
  else
    printf '%s,%s,%s,%s\n' "${pr}" "${branch}" "${sha}" "FAIL" >> artifacts/summary.csv
    echo "FAIL PR #${pr} (${sha}) — see ${log}"
    overall=1
  fi
  tail -n 15 "${log}"
done

echo
echo "=== CLOVER FREE VALIDATION SUMMARY ==="
cat artifacts/summary.csv
echo "Detailed logs: CircleCI Artifacts > clover-free-tests/"
exit "${overall}"
