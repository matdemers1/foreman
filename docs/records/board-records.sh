#!/usr/bin/env bash
# FRM-REQ-165…172 and FRM-ADR-016 for the innovation board.
#
# Written as a script because Cloudflare rate-limited the session that built the feature. Run it
# once, from a shell with FOREMAN_URL and FOREMAN_WRITE_TOKEN set; it is not idempotent, so check
# `foreman_search` for FRM-REQ-165 before re-running.
set -euo pipefail
: "${FOREMAN_URL:?}" "${FOREMAN_WRITE_TOKEN:?}"
H=(-H "authorization: Bearer $FOREMAN_WRITE_TOKEN" -H 'content-type: application/json' -H 'user-agent: curl/8.7.1')

req() { sleep 2; curl -sS -X POST "$FOREMAN_URL/api/projects/FRM/requirements" "${H[@]}" -d "{\"statement\":\"$1\",\"priority\":\"$2\"}" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('humanId','ERR'),'|',d.get('earsPattern'))"; }

req "Where a deployment is configured as an innovation board, Foreman shall offer member management, scoring, discussion and funding." M
req "Where a deployment is configured as solo, Foreman shall answer every innovation-board endpoint as not found." M
req "Foreman shall record the account that submitted a project idea, and shall leave it absent when a token submitted one." M
req "Foreman shall disclose a project idea's scores only to a reviewer or an administrator." M
req "If a submitter attempts to change the status of any project idea, then Foreman shall refuse the change." M
req "When an innovation board funds a project idea, Foreman shall record the amount and a public reason, and shall email the submitter." M
req "Foreman shall issue an invitation as a hashed, single-use, expiring token, and shall not grant a session when one is accepted." M
req "Foreman shall attach discussion and scoring to project ideas only, and to no requirement, task, phase, finding or decision record." M

sleep 2
curl -sS -X POST "$FOREMAN_URL/api/projects/FRM/adrs" "${H[@]}" --data-binary @"$(dirname "$0")/adr016.json" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('humanId','ERR'),'|',d.get('status'),'|',d.get('title'))"

for to in FRM-ADR-002 FRM-ADR-015; do
  sleep 1
  curl -sS -X POST "$FOREMAN_URL/api/links" "${H[@]}" -d "{\"from\":\"FRM-ADR-016\",\"to\":\"$to\",\"kind\":\"extends\"}" \
    -o /dev/null -w "FRM-ADR-016 extends $to -> %{http_code}\n"
done
