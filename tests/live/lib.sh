# Live matrix helpers. Usage: source lib.sh (zsh). run.sh sets LIVE_MATRIX_DIR to the run folder.
# pi always starts with the temporary agent folder <run>/agent and with only the extension of this repo.
# No function in this file reads or writes ~/.pi/agent.
S=${LIVE_MATRIX_DIR:?set LIVE_MATRIX_DIR to the run folder}
LIVE=${${(%):-%x}:A:h}
REPO=${LIVE:h:h}
AGENT=$S/agent
PI_BIN=${PI_BIN:-$HOME/.local/bin/pi}
# The shell of the tool that runs this file can wrap grep. Use the system grep.
grep() { /usr/bin/grep "$@"; }
# wait_idle <session> <stable_polls> <timeout> <interval>: wait until the pane text is the same for N polls
wait_idle() { local target=$1 need=${2:-3} timeout=${3:-60} interval=${4:-1} prev="" cur="" stable=0 deadline
  deadline=$(( $(date +%s) + timeout ))
  while (( $(date +%s) < deadline )); do
    cur=$(tmux capture-pane -p -t "$target" -S -200 2>/dev/null)
    if [[ -n "$cur" && "$cur" == "$prev" ]]; then stable=$((stable+1)); (( stable >= need )) && return 0; else stable=0; fi
    prev=$cur; sleep $interval
  done
  echo "wait_idle: $target did not stay unchanged for $need polls in ${timeout}s" >&2; return 1; }
# pi_session <tag> <provider> <model> <thinking> [more pi arguments]: start pi in the tmux session md-<tag>.
# Set MD_FAMILY_UPDATE=1 to let this session get family data from GitHub.
# The file live-target holds the name of the newest session. live_view reads it.
pi_session() { local tag=$1 extra=${5:-} noupdate="PI_MODEL_DISCOVERY_NO_FAMILY_UPDATE=1 "
  [ -n "${MD_FAMILY_UPDATE:-}" ] && noupdate=""
  mkdir -p $S/ev/$tag/sessions; : > $S/ev/$tag/wire.jsonl
  tmux kill-session -t md-$tag 2>/dev/null
  echo md-$tag >> $S/tmux-sessions.txt
  tmux new-session -d -s md-$tag -x 200 -y 46 "cd '$S/work' && PI_CODING_AGENT_DIR='$AGENT' ${noupdate}PI_MODEL_DISCOVERY_WIRE_LOG='$S/ev/$tag/wire.jsonl' '$PI_BIN' --no-context-files --no-extensions -e '$REPO/extensions/index.ts' --session-dir '$S/ev/$tag/sessions' --provider $2 --model '$3' --thinking ${4:-off} $extra"
  echo md-$tag > $S/live-target; }
# live_view: the loop of the viewer session md-live. One time each second it draws the screen of the newest pi session.
# It reads the screen with capture-pane. It is not a tmux client of the pi session, thus it cannot change the window size
# and it cannot send a key.
live_view() { local t; printf '\e[?7l\e[?25l'
  while :; do t=$(cat $S/live-target 2>/dev/null)
    if [ -n "$t" ] && tmux has-session -t "=$t" 2>/dev/null; then printf '\e[H%s\e[J' "$(tmux capture-pane -e -p -t "=$t:" 2>/dev/null | tail -n $(tput lines) | sed $'s/$/\e[0m\e[K/')"
    else printf '\e[H\e[J%s' "md-live: no pi session is live now. The next session shows here when it starts."; fi
    sleep 1; done; }
# start <tag> <provider> <model> [thinking]
start() { pi_session $1 $2 "$3" ${4:-off}; wait_idle md-$1 3 60 1 >/dev/null; }
# shot <tag> <name>: save the pane with colours as SVG and text
shot() { tmux capture-pane -e -p -t md-$1 > $S/ev/$1/$2.ansi; tmux capture-pane -p -t md-$1 > $S/ev/$1/$2.txt
  python3 - "$S/ev/$1/$2" <<'PY'
import sys
from rich.console import Console
from rich.text import Text
b=sys.argv[1]; c=Console(record=True,width=200,file=open('/dev/null','w'))
c.print(Text.from_ansi(open(b+'.ansi').read())); c.save_svg(b+'.svg',title=b.split('/')[-2]+' / '+b.split('/')[-1])
PY
}
keys() { local t=$1; shift; tmux send-keys -t md-$t "$@"; }
# say <tag> <text>: type a prompt, send it, wait for the answer to end
say() { tmux send-keys -t md-$1 -l "$2"; sleep 0.5; tmux send-keys -t md-$1 Enter; sleep 2; wait_idle md-$1 4 ${3:-240} 1 >/dev/null; }
stop() { tmux kill-session -t md-$1 2>/dev/null; }
wire() { jq -c '{piModel,thinkingLevel,imageCount,toolCount,model:.request.model,ctk:.request.chat_template_kwargs,re:.request.reasoning_effort,temperature:.request.temperature,top_p:.request.top_p,top_k:.request.top_k,min_p:.request.min_p,presence_penalty:.request.presence_penalty,repetition_penalty:.request.repetition_penalty}' $S/ev/$1/wire.jsonl; }
# pane_tail <tag> <n>: the last n lines of the pane that are not empty lines at the end
pane_tail() { tmux capture-pane -p -t md-$1 | awk -v n=$2 'NF{last=NR} {l[NR]=$0} END{for(i=(last>n?last-n+1:1);i<=last;i++)print l[i]}'; }
# cmd <tag> <slash command>: run a slash command in the TUI (the first Enter can accept a completion).
# The second Enter goes out only when the full command text is still in the editor at the end of the screen.
cmd() { tmux send-keys -t md-$1 -l "$2"; sleep 0.7; tmux send-keys -t md-$1 Enter; sleep 1.5
  if pane_tail $1 6 | grep -qF -- "$2"; then tmux send-keys -t md-$1 Enter; sleep 1.5; fi; }
# open_model <tag> <provider> <model> [picture name]: open the model panel through the source panel.
# Each key is sent only when the cursor row is known. Any other state stops the function.
# With a picture name, the function saves the source panel before it opens the model row.
open_model() { cmd $1 "/discover source open $2"; sleep 1; local i pane cur
  for i in $(seq 1 40); do
    pane=$(tmux capture-pane -p -t md-$1)
    grep -q "^╭ Source: $2 " <<<"$pane" || { echo "open_model: not in the source panel" >&2; return 1; }
    cur=$(grep -E "^│ › " <<<"$pane" | head -1)
    if grep -qE "^│ › $3 (\[|·)" <<<"$cur"; then [ -n "${4:-}" ] && shot $1 $4; tmux send-keys -t md-$1 Enter; sleep 1.5; return 0; fi
    if grep -qE "^│   $3 (\[|·)" <<<"$pane" && grep -q "› next page" <<<"$cur"; then tmux send-keys -t md-$1 Up; sleep 0.5; continue; fi
    if grep -q "› next page" <<<"$cur"; then tmux send-keys -t md-$1 Enter; sleep 0.8; continue; fi
    if grep -qE "^│ › [^ ]+ (\[|·)" <<<"$cur" && grep -q "^│   next page" <<<"$pane"; then tmux send-keys -t md-$1 Down; sleep 0.5; continue; fi
    echo "open_model: unknown cursor row: $cur" >&2; return 1
  done; echo "open_model: $3 not found" >&2; return 1; }
esc() { local i; for i in $(seq 1 ${2:-4}); do tmux send-keys -t md-$1 Escape; sleep 0.5; done; }
# goto_row <tag> <header regex> <row regex>: move the cursor down to a row. Stops when the panel is not the expected one.
goto_row() { local i pane cur
  for i in $(seq 1 30); do
    pane=$(tmux capture-pane -p -t md-$1); grep -qE "^╭ $2" <<<"$pane" || { echo "goto_row: panel is not '$2'" >&2; return 1; }
    cur=$(grep -E "^│ › " <<<"$pane" | head -1)
    grep -qE "$3" <<<"$cur" && return 0
    tmux send-keys -t md-$1 Down; sleep 0.4
  done; echo "goto_row: row '$3' not found" >&2; return 1; }
# level <tag>: the thinking level in the footer of pi. The footer line ends with "<model> • thinking off" or "<model> • <level>".
# A model with reasoning off has no level text. Then the result is empty.
level() { pane_tail $1 4 | grep -oE " • (thinking off|minimal|low|medium|high|xhigh|max) *$" | tail -1 | awk '{print $NF}'; }
footer() { tmux capture-pane -p -t md-$1 | grep -oE "(defaults|preset|fixed preset): [^•]+" | tail -1; }
# levels <tag> <prefix>: one coding prompt at each offered level (Shift-Tab), with a picture of each
levels() { local first l n=0; first=$(level $1)
  while :; do l=$(level $1); say $1 "Write a Python function that returns the n-th prime number. Think about the edge cases first. Reply with the code only." 400
    shot $1 "$2-$l"; echo "level=$l footer=$(footer $1)"; n=$((n+1)); tmux send-keys -t md-$1 BTab; sleep 1.2
    [ "$(level $1)" = "$first" ] && break; [ $n -ge 8 ] && break; done; }
# restore_cfg: put the pristine copy back into the temporary agent folder
restore_cfg() { cp -p $AGENT/model-discovery.json.pristine $AGENT/model-discovery.json; }
# cfg <source> <model>: the presets, the routing and the override of a model in the config copy
cfg() { MD_CFG=$AGENT/model-discovery.json node -e 'const c=JSON.parse(require("fs").readFileSync(process.env.MD_CFG,"utf8")).find(p=>p.name===process.argv[1]);console.log(JSON.stringify({presets:(c.modelProfiles||{})[process.argv[2]],routing:(c.modelProfileRouting||{})[process.argv[2]],override:(c.modelOverrides||{})[process.argv[2]]}))' "$1" "$2"; }
sess() { find $S/ev/$1/sessions -name '*.jsonl' | while read -r f; do jq -c 'select(.type=="message" and .message.role=="assistant") | {model:.message.model, thinkingChars:([.message.content[]?|select(.type=="thinking")|.thinking|length]|add // 0), text:([.message.content[]?|select(.type=="text")|.text]|join(" ")|.[0:90]), tools:[.message.content[]?|select(.type=="toolCall")|{name,arguments}], out:.message.usage.output}' "$f"; done; }
# server_lines <tag> [ssh host]: copy the oMLX log lines of the time window of the run to ev/<tag>.server.log
server_lines() { local a b; a=$(/usr/bin/grep -m1 "^### $1 " $S/ev/$1.log | /usr/bin/grep -oE "[0-9-]{10} [0-9:]{8}"); b=$(/usr/bin/grep "^### $1 end" $S/ev/$1.log | /usr/bin/grep -oE "[0-9-]{10} [0-9:]{8}")
  [ -n "$a" ] && [ -n "$b" ] || { echo "server_lines: no time window for $1" >&2; return 1; }
  local prog='$1" "$2 >= a && $1" "$2 <= b"z" && /omlx\.(server|engine_pool)|ERROR|WARNING/ && !/httpx/'
  if [ -n "$2" ]; then timeout 30 ssh -o BatchMode=yes -o ConnectTimeout=8 $2 "cat ~/.omlx/logs/server.log" | awk -v a="$a" -v b="$b" "$prog" > $S/ev/$1.server.log
  else awk -v a="$a" -v b="$b" "$prog" ~/.omlx/logs/server.log > $S/ev/$1.server.log; fi; wc -l < $S/ev/$1.server.log; }
