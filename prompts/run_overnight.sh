#!/bin/bash
# run_overnight.sh — Run Claude Code prompts sequentially overnight
# Usage: chmod +x run_overnight.sh && ./run_overnight.sh

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

PROMPTS_DIR="prompts"
LOG_FILE="overnight_run_$(date +%Y%m%d_%H%M%S).log"

echo "Starting overnight run at $(date)" | tee "$LOG_FILE"
echo "Project directory: $PROJECT_DIR" | tee -a "$LOG_FILE"
echo "==========================================" | tee -a "$LOG_FILE"

run_prompt() {
  local prompt_file="$1"
  local prompt_name="$2"
  
  echo "" | tee -a "$LOG_FILE"
  echo "=== $prompt_name ===" | tee -a "$LOG_FILE"
  echo "Started at $(date)" | tee -a "$LOG_FILE"
  
  if claude -p "$(cat "$prompt_file")" \
    --dangerously-skip-permissions \
    --model claude-opus-4-6 \
    --effort max \
    2>&1 | tee -a "$LOG_FILE"; then
    echo "$prompt_name completed successfully at $(date)" | tee -a "$LOG_FILE"
  else
    echo "$prompt_name FAILED at $(date)" | tee -a "$LOG_FILE"
    echo "Continuing to next prompt..." | tee -a "$LOG_FILE"
  fi
  
  echo "==========================================" | tee -a "$LOG_FILE"
  
  # 10-second pause between sessions to avoid rate limits
  sleep 10
}

# Run prompts in order
run_prompt "$PROMPTS_DIR/prompt3.md" "PROMPT 3: Solution Page Redesign"
run_prompt "$PROMPTS_DIR/prompt4.md" "PROMPT 4: Admin Dashboard"
run_prompt "$PROMPTS_DIR/prompt5.md" "PROMPT 5: Search Index"
run_prompt "$PROMPTS_DIR/prompt6.md" "PROMPT 6: User Profile Redesign"
run_prompt "$PROMPTS_DIR/prompt7.md" "PROMPT 7: Contributors Page"
run_prompt "$PROMPTS_DIR/prompt8.md" "PROMPT 8: Unsolved + Settings + Cleanup"

echo "" | tee -a "$LOG_FILE"
echo "==========================================" | tee -a "$LOG_FILE"
echo "ALL PROMPTS COMPLETED at $(date)" | tee -a "$LOG_FILE"
echo "Log saved to $LOG_FILE"
