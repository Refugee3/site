#!/usr/bin/env bash
# DragonGrader on a Mac: double-click this file in Finder (the first time, right-click → Open).
# It runs start-grader.sh in this folder: checks Node.js, installs and builds when needed, starts the grader and opens
# http://localhost:3000. Press Ctrl+C or close the Terminal window to stop.
cd "$(dirname "$0")" || exit 1
exec bash ./start-grader.sh
