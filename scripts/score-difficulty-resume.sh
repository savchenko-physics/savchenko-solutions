#!/bin/bash
# Top up the difficulty run as the batch queue's rolling token budget frees up.
#
# The gpt-4.1-mini batch queue allows 2,000,000 enqueued tokens on a rolling window, and
# all 2,023 problems come to roughly 4.2M. So the run cannot be done in one sitting: it
# submits whatever fits, exits when the queue refuses more, and is called again later.
#
# flock keeps two invocations from fighting over difficulty-run.json — the state file is
# what makes the run resumable, and two writers would lose scores that were already paid for.
cd /home/ubuntu/savchenko-solutions || exit 1
exec /usr/bin/flock -n /tmp/score-difficulty.lock \
    /usr/bin/node scripts/score-difficulty.js \
        --model gpt-4.1-mini --budget 1.20 --chunk 200 --poll 60 --resume \
    >> /tmp/score-difficulty-cron.log 2>&1
