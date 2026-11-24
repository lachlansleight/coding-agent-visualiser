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
# agent would see a short or empty result. Each copy leaves a marker file when
# it has finished; the trap closes the shell's ends of the pipes and waits for
# both markers. The wait is capped (a second or two): a command that leaves a
# background process holding the output open would otherwise keep the shell
# from ever exiting.
#
# Written to run under bash (including the old 3.2 on macOS) and zsh. It has
# only been verified with Git Bash on Windows.

__agent_vis_log=$1
exec > >(tee -a "$__agent_vis_log"; : > "$__agent_vis_log.out-done")
exec 2> >(tee -a "$__agent_vis_log" >&2; : > "$__agent_vis_log.err-done")

__agent_vis_flush() {
  exec >&- 2>&-
  __agent_vis_tries=0
  while [ ! -e "$__agent_vis_log.out-done" ] || [ ! -e "$__agent_vis_log.err-done" ]; do
    __agent_vis_tries=$((__agent_vis_tries + 1))
    [ "$__agent_vis_tries" -gt 16 ] && break
    sleep 0.05
  done
  rm -f "$__agent_vis_log.out-done" "$__agent_vis_log.err-done"
}
trap __agent_vis_flush EXIT
