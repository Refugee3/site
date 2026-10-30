#!/usr/bin/env bash
# DragonGrader: one-click start on this computer (Linux; macOS uses start-grader.command).
# Checks Node.js, installs and builds the app when needed, starts it on http://localhost:3000 and opens the browser.
# Press Ctrl+C to stop.
cd "$(dirname "$0")" || exit 1

pause_and_exit() {
  echo
  read -r -p "Press Enter to close this window." _ || true
  exit "$1"
}

if ! command -v node >/dev/null 2>&1; then
  echo
  echo " Node.js is not installed on this computer."
  echo " Install the LTS version from https://nodejs.org, then start the grader again."
  pause_and_exit 1
fi

if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"; then
  echo
  echo " This Node.js ($(node -v)) is too old: the grader needs version 22.13 or newer."
  echo " Install the LTS version from https://nodejs.org, then start the grader again."
  pause_and_exit 1
fi

if ! node scripts/start-grader.mjs; then
  echo
  echo " The grader could not start. Read the messages above, fix what they say, then try again."
  pause_and_exit 1
fi
