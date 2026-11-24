# Sourced at the start of a Bash tool command (see teeRewrite in server.mjs):
#
#   . '/path/to/tee.sh' '/path/to/output.log'; <the agent's command>
#
# Copies the command's stdout and stderr into the log file, which the forwarder
# tails to show output live. Both streams still reach Claude Code separately and
# the exit status is untouched.
#
# The copies are made by two background `tee` processes. Without the EXIT trap
# below the shell could exit before they had passed the last output on, and the
# agent would see a short or empty result. The trap closes the shell's ends of
# the pipes and waits for both to finish. The wait is capped (a second or two):
# a command that leaves a background process holding the output open would
# otherwise keep the shell from ever exiting.

exec > >(tee -a "$1")
__agent_vis_out=$!
exec 2> >(tee -a "$1" >&2)
__agent_vis_err=$!

__agent_vis_flush() {
  exec >&- 2>&-
  local tries=0
  while kill -0 "$__agent_vis_out" 2>/dev/null || kill -0 "$__agent_vis_err" 2>/dev/null; do
    tries=$((tries + 1))
    [ "$tries" -gt 16 ] && break
    sleep 0.05
  done
}
trap __agent_vis_flush EXIT
