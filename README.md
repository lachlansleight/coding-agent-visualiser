# Coding agent visualiser

A fullscreen web page that shows what a Claude Code agent is doing while it works: the reply and thinking as they stream, files as they are read, written and edited, shell commands with their output, subagents, and the commit graph.

A small local program, the **forwarder**, collects this from Claude Code and serves the page. Everything stays on your machine.

Developed and tested on Windows. The macOS steps below are the same commands, but they have not been run on a Mac yet.

## What you need

- [Node.js](https://nodejs.org/) 22 or newer
- git
- The Claude Code CLI (`claude`), signed in. Run `claude auth login` if it is not.
- Windows only: Git for Windows, which Claude Code already requires.

## Setup

The same on Windows (PowerShell) and macOS (Terminal):

```
git clone https://github.com/lachlansleight/coding-agent-visualiser.git
cd coding-agent-visualiser
npm install
npm run hooks:on
npm start
```

Then open http://127.0.0.1:4517/ and make it fullscreen.

- `npm run hooks:on` adds the forwarder's hooks to your user-level Claude Code settings (`~/.claude/settings.json`), creating the file if needed. Other settings and hooks are left alone, and the first change leaves a copy beside it as `settings.json.before-agent-vis`. When the forwarder is not running, the hooks fail quietly and sessions carry on as normal.
- `npm start` runs the forwarder. Leave it running in its own terminal.

## Watching a session

Start Claude Code with this project's settings file, which sends its model requests through the forwarder so the page can show them token by token.

macOS:

```
claude --settings ~/path/to/coding-agent-visualiser/claude-settings.json
```

Windows:

```
claude --settings C:\path\to\coding-agent-visualiser\claude-settings.json
```

The forwarder must be running for a session started this way, or its requests will fail. Your normal sign-in is used; the forwarder passes requests through unchanged.

A shortcut saves typing the path. On macOS, add this to `~/.zshrc`:

```
alias claude-vis='claude --settings "$HOME/path/to/coding-agent-visualiser/claude-settings.json"'
```

On Windows, add this to your PowerShell profile (`notepad $PROFILE`):

```
function claude-vis { claude --settings "C:\path\to\coding-agent-visualiser\claude-settings.json" @args }
```

To send every terminal session through the forwarder without the flag, run `npm run proxy:on` (and `npm run proxy:off` to undo it). While it is on, every terminal session depends on the forwarder running.

### What each kind of session shows

| Session | What the page gets |
|---|---|
| Terminal, started with the settings file | Everything: reply, thinking and tool calls as they stream, plus hooks and commits |
| Terminal, started normally | Tool activity as it happens; reply text a block at a time, a second or two late |
| Claude desktop app | The same as a normal terminal session. The app does not allow its requests to be routed through a local proxy while signed in with a Claude account. |

Thinking only appears when the session streams thinking text. One-shot runs (`claude -p`) ask for it to be left out.

## Live shell output

Showing a command's output while it is still running works by adding a short prefix to the agent's Bash commands, which copies their output to a file the forwarder watches (`forwarder/tee.sh`).

- **Windows:** on by default.
- **macOS:** off by default, because it has not been tested there. To try it, start the forwarder with `AGENT_VIS_TEE=1 npm start`. Then ask the agent to run `echo hello; echo oops >&2; exit 3` and check that it reports `hello`, `oops` and exit code 3. If it does not, turn it off again.
- It is always skipped for sessions in auto mode, where changing a command after it has been reviewed makes the agent issue it twice.
- To turn it off on Windows: `$env:AGENT_VIS_TEE = '0'; npm start`.

Without it, a command's output appears when the command finishes.

## Using the page

- Each thing the agent does gets a tile that grows while it is happening and shrinks and fades afterwards. When a new turn starts, what is left of the last one fades out over ten seconds.
- Content taller than its tile scrolls itself. Scroll a tile yourself to take over; click the "manual scroll" chip in its header to hand it back.
- Every session is shown. The active one opens and the rest fold to a strip. Click a session's header to pin it open.
- The bar at the bottom has "expand all", how long a session stays open once opened, and a switch for the commit graph.
- http://127.0.0.1:4517/log is a plain list of every event, for debugging.

## Recording and replay

```
npm run record -- recordings/my-session.jsonl
```

records everything the forwarder sees until you stop it with Ctrl+C. Replay it at http://127.0.0.1:4517/?replay=my-session. Add `&speed=2` to go faster or `&loop=1` to repeat. A sample is included: http://127.0.0.1:4517/?replay=sample.

Recordings contain your prompts, file contents and command output. Files named `recordings/rec-*.jsonl` are ignored by git.

## Tuning

Timings, tile sizes and limits are in `visualiser/config.js`: how fast each kind of tile rises and fades, how much room it asks for, how many tiles a session shows at once.

## Changing the port

The forwarder listens on port 4517. To use another, set `AGENT_VIS_PORT` when running `npm start` and the `hooks:` and `proxy:` scripts, and change the address in `claude-settings.json` to match.

## Turning it off

```
npm run hooks:off
npm run proxy:off
```

and stop the forwarder. `hooks:off` removes only the hooks this project added.

## Privacy

- The forwarder listens on `127.0.0.1` only, and its event stream refuses connections from other web pages.
- Sign-in credentials pass through the forwarder to Anthropic's API. They are never stored, logged or sent to the page.
- Nothing is sent anywhere other than Anthropic's API, which is where Claude Code was sending it already.

## What is where

| Path | What it is |
|---|---|
| `forwarder/server.mjs` | Receives hooks, proxies the API, tails transcripts and command output, watches git, serves the page |
| `forwarder/tee.sh` | The helper behind live shell output |
| `visualiser/` | The page: `model.js` turns events into tiles, `layout.js` arranges them, `render.js` draws them |
| `viewer/` | The plain event log at `/log` |
| `scripts/` | Recording, and switching the hooks and proxy settings on and off |
| `claude-settings.json` | Settings file for sessions that should go through the proxy |
