#!/bin/zsh
# tests/live/run.sh [--only tag,tag] [--list]
#
# The one command of the live test matrix. It runs each row of matrix.json in the real pi
# terminal interface (tmux) against the real servers. Then it builds the evidence page.
#
#   npm run test:live                               all rows
#   npm run test:live -- --only gemma-local,flash-m3
#   npm run test:live -- --list                     print the rows and the preflight result, run nothing
#
# Progress: on a terminal, one status line shows the row, a bar, the case and the time of the row.
# Not on a terminal (a pipe, CI): one plain line shows each case start. No escape code is written.
# When a row ends, one line shows a ✓ or a ✗ for each case. One more line shows each check that did not pass.
# To see the live pi session (read-only): tmux attach -r -t md-live
#
# pi runs with a temporary agent folder (<run>/agent) that holds a copy of the config.
# The script never writes ~/.pi/agent. Only the extension of this repo is loaded.
# Output: .live-matrix/<date-time>/ (evidence.html, result.json, run.log, ev/).
# Exit code: 0 only when each check passes. A row that cannot run is a failure.

LIVE=${0:A:h}
REPO=${LIVE:h:h}
MATRIX=$LIVE/matrix.json
REAL_AGENT=$HOME/.pi/agent
REAL_CFG=$REAL_AGENT/model-discovery.json
REAL_SET=$REAL_AGENT/settings.json
OUT_ROOT=$REPO/.live-matrix
LOCK=$OUT_ROOT/lock
PI_BIN=${PI_BIN:-$HOME/.local/bin/pi}
export PI_BIN

ONLY=""; LIST=""
while (( $# )); do
  case $1 in
    --only) ONLY=$2; shift 2 ;;
    --only=*) ONLY=${1#--only=}; shift ;;
    --list) LIST=1; shift ;;
    *) echo "usage: run.sh [--only tag,tag] [--list]" >&2; exit 2 ;;
  esac
done

mq() { jq -r "$@" $MATRIX; }                 # read the matrix
sha() { if [ -f "$1" ]; then shasum -a 256 "$1" | cut -d' ' -f1; else echo absent; fi; }

# ---------------------------------------------------------------- preflight
PRE_FAIL=0
pre() { if [ "$1" = ok ]; then echo "  ok    $2"; else echo "  FAIL  $2"; PRE_FAIL=$((PRE_FAIL+1)); fi; }
preflight() {
  local tool src tag
  echo "Preflight:"
  for tool in tmux jq node python3 timeout shasum git awk; do
    command -v $tool >/dev/null 2>&1 && pre ok "$tool" || pre fail "$tool is not in PATH"
  done
  python3 -c 'import rich' 2>/dev/null && pre ok "python3 module rich" || pre fail "python3 module rich is absent (pip install rich)"
  node --experimental-strip-types -e '' 2>/dev/null && pre ok "node runs TypeScript files" || pre fail "node cannot run TypeScript files (Node 22.18 or newer is necessary)"
  [ -x "$PI_BIN" ] && pre ok "pi: $PI_BIN" || pre fail "pi is not at $PI_BIN (set PI_BIN)"
  jq -e . $MATRIX >/dev/null 2>&1 && pre ok "matrix.json" || { pre fail "matrix.json is absent or is not JSON"; return; }
  [ -f $LIVE/fixtures/word.png ] && [ "$(head -1 $LIVE/fixtures/notes.txt 2>/dev/null)" = "PINEAPPLE-7781 is the first line." ] \
    && pre ok "fixtures" || pre fail "fixtures/word.png or fixtures/notes.txt is wrong"
  if [ -f $REAL_CFG ] && jq -e 'type=="array"' $REAL_CFG >/dev/null 2>&1; then
    pre ok "config: $REAL_CFG"
    for src in ${(f)"$(mq '.sources|keys[]')"}; do
      jq -e --arg s "$src" 'any(.[]; .name==$s)' $REAL_CFG >/dev/null && pre ok "source $src is in the config" || pre fail "source $src is not in the config"
    done
  else
    pre fail "config $REAL_CFG is absent or is not a JSON array"
  fi
  [ "$(mq '[.rows[].tag]|length')" = "$(mq '[.rows[].tag]|unique|length')" ] || pre fail "matrix.json has a tag two times"
  for src in ${(f)"$(mq '.rows[].source')"}; do
    mq -e --arg s "$src" '.sources|has($s)' >/dev/null || pre fail "matrix.json: source $src of a row is not in sources"
  done
  for tag in ${(s:,:)ONLY}; do
    mq -e --arg t "$tag" 'any(.rows[]; .tag==$t)' >/dev/null || pre fail "--only: matrix.json has no row $tag"
  done
  if [ -f $LOCK ] && kill -0 "$(cat $LOCK 2>/dev/null)" 2>/dev/null; then pre fail "another run holds the lock (pid $(cat $LOCK))"; else pre ok "lock is free"; fi
}

selected() { [ -z "$ONLY" ] || [[ ",$ONLY," == *",$1,"* ]]; }

echo "Rows of $MATRIX:"
for tag in ${(f)"$(mq '.rows[].tag')"}; do
  selected $tag && mark="run " || mark="skip"
  echo "  $mark  $(mq --arg t "$tag" '.rows[]|select(.tag==$t)|"\(.tag)  \(.source)/\(.model)  \(.imageFlags // "")"')"
done
echo "Source rules: $(mq -c '.sources')"
preflight
if (( PRE_FAIL )); then echo "Preflight: $PRE_FAIL problem(s). Nothing ran."; exit 1; fi
echo "Preflight: all checks pass."
[ -n "$LIST" ] && exit 0

# ---------------------------------------------------------------- run folder, lock, temporary agent folder
RUN=$OUT_ROOT/$(date +%Y%m%d-%H%M%S)
AGENT=$RUN/agent
mkdir -p $RUN/work $RUN/ev/other
: > $RUN/tmux-sessions.txt
log() { echo "[$(date '+%T')] $*" | tee -a $RUN/run.log; }
SHA_CFG=$(sha $REAL_CFG); SHA_SET=$(sha $REAL_SET)

export LIVE_MATRIX_DIR=$RUN
source $LIVE/lib.sh

typeset -A ORIG_LOADED ORIG_SET REACH
CLEANED=""; RESTORE_FAIL=""; CHILD=""

# ---------------------------------------------------------------- progress
TTY=""; [ -t 1 ] && TTY=1
NCASE=$(/usr/bin/grep -cE '^echo "#[#>] [0-9]+ ' $LIVE/run_model.sh)   # the case markers of run_model.sh, in run order
ROW_I=0; ROW_N=$(jq -r --arg o "$ONLY" '[.rows[] | select($o == "" or (.tag as $t | $o | split(",") | index($t)))] | length' $MATRIX)
mmss() { printf '%dm%02ds' $(($1/60)) $(($1%60)); }
# status_line <text>: on a terminal, write the text in place of the last status line
status_line() { [ -n "$TTY" ] && printf '\r\e[K%s' "${1[1,${COLUMNS:-80}-1]}"; return 0; }
status_clear() { [ -n "$TTY" ] && printf '\r\e[K'; return 0; }
bar() { local n=24 f=$(( $2 > 0 ? $1 * 24 / $2 : 0 )); print -rn -- "[${(l:f::#:):-}${(l:n-f::-:):-}]"; }
# watch_row <tag> <label>: show the progress of the run_model.sh child until it ends. The case number is the
# number of marker lines in ev/<tag>.log. The bar shows the cases that are complete in all rows.
watch_row() {
  local tag=$1 label=$2 seen=0 name="start" t0=$SECONDS
  local -a marks
  while :; do
    marks=(${(f)"$(/usr/bin/grep -E '^#[#>] [0-9]+ ' $RUN/ev/$tag.log 2>/dev/null)"})
    while (( seen < $#marks )); do
      seen=$((seen+1)); name=${${marks[seen]#\#? [0-9]* }%%:*}
      [ -z "$TTY" ] && echo "$label case $seen/$NCASE $name"
    done
    status_line "$label $(bar $(( (ROW_I-1)*NCASE + (seen > 0 ? seen-1 : 0) )) $((ROW_N*NCASE))) case $seen/$NCASE $name  $(mmss $((SECONDS-t0)))"
    kill -0 $CHILD 2>/dev/null || break
    sleep 1
  done
  status_clear
}
# row_result <tag> <label> <time text>: one verdict line for the row, then one line for each check that did not pass.
# build_evidence.py --row computes the verdict from the evidence files of the row.
row_result() {
  local js; js=$(python3 $LIVE/build_evidence.py --row $1 $RUN 2>> $RUN/run.log)
  [ -n "$js" ] || { log "$2 no verdict. build_evidence.py --row $1 gave no output. See run.log."; return; }
  jq -r --arg l "$2" --arg t "$3" 'def cut: gsub("\\s+"; " ") | if length > 160 then .[0:160] + "…" else . end;
    ("\($l)  \([.cases[] | (if .status == "pass" then "✓ " else "✗ " end) + .id] | join("  "))  \($t)" | sub(" +$"; "")),
    (.problems[] | "    ✗ [\(.status)] \(.case) / \(.check): expected \(.expected | cut); actual \(.actual | cut)")' <<< "$js" | tee -a $RUN/run.log
}

omlx() { node $LIVE/omlx.mjs $AGENT/model-discovery.json "$@"; }
loaded_of() { local line; line=$(omlx $1 status 2>>$RUN/run.log) || return 1; print -r -- "${line##*loaded: }" | jq -r '.[]'; }

# restore_sources: on each one-model-at-a-time source, load again the models that were loaded before the run
restore_sources() {
  local src cur m
  for src in ${(k)ORIG_SET}; do
    [ -f $AGENT/model-discovery.json ] || { RESTORE_FAIL=1; continue; }
    cur=$(loaded_of $src) || { log "WARNING: $src does not give its load state. Load these models by hand: ${ORIG_LOADED[$src]//$'\n'/, }"; RESTORE_FAIL=1; continue; }
    for m in ${(f)cur}; do
      [[ $'\n'"${ORIG_LOADED[$src]}"$'\n' == *$'\n'"$m"$'\n'* ]] && continue
      omlx $src unload "$m" >>$RUN/run.log 2>&1 || { log "WARNING: $src did not unload $m"; RESTORE_FAIL=1; }
    done
    for m in ${(f)ORIG_LOADED[$src]}; do
      [[ $'\n'"$cur"$'\n' == *$'\n'"$m"$'\n'* ]] && continue
      omlx $src load "$m" >>$RUN/run.log 2>&1 || { log "WARNING: $src did not load $m again. Load it by hand."; RESTORE_FAIL=1; }
    done
    log "$src: models loaded now: $(loaded_of $src | tr '\n' ' ')"
    unset "ORIG_SET[$src]"
  done
}

# cleanup: stop the tmux sessions of this run, load the recorded models again, delete the agent folder (it holds API keys)
cleanup() {
  [ -n "$CLEANED" ] && return; CLEANED=1
  local name
  [ -n "$CHILD" ] && { kill $CHILD 2>/dev/null; wait $CHILD 2>/dev/null; }
  status_clear
  for name in ${(f)"$(sort -u $RUN/tmux-sessions.txt 2>/dev/null)"}; do tmux kill-session -t "$name" 2>/dev/null; done
  restore_sources
  rm -rf $AGENT
  rm -f $LOCK $RUN/live-target
}
echo $$ > $LOCK
trap cleanup EXIT
trap 'status_clear; echo "Stopped."; exit 130' INT TERM

# The temporary agent folder: the config copy, a pristine copy for restore_cfg, and minimal settings.
mkdir -p $AGENT; chmod 700 $AGENT
install -m 600 $REAL_CFG $AGENT/model-discovery.json
install -m 600 $REAL_CFG $AGENT/model-discovery.json.pristine
# A new agent folder has no settings. These two keep the start screen short and send no install telemetry.
print -r -- '{"quietStartup": true, "enableInstallTelemetry": false}' > $AGENT/settings.json
# pi downloads fd and rg into a new agent folder at start. A slow download makes the first command fail.
# Copy the two tools from the real agent folder (read only) so that pi does not download them.
if [ -d $REAL_AGENT/bin ]; then mkdir -p $AGENT/bin; for tool in fd rg; do [ -x $REAL_AGENT/bin/$tool ] && cp -p $REAL_AGENT/bin/$tool $AGENT/bin/; done; fi
cp $LIVE/fixtures/word.png $LIVE/fixtures/notes.txt $RUN/work/

# run.json: the input of build_evidence.py
jq -n --slurpfile m $MATRIX --slurpfile c $AGENT/model-discovery.json --arg v "$(jq -r .version $REPO/package.json)" --arg only "$ONLY" '
  $m[0] as $m | ($only | split(",") | map(select(. != ""))) as $o
  | { version: $v, rows: ($m.rows | map(select(($o | length) == 0 or (.tag as $t | $o | index($t))))),
      hiddenModel: $m.hiddenModel, notRun: {},
      sources: ($m.sources | with_entries(.key as $k | ($c[0][] | select(.name == $k)) as $s
        | .value += { host: ($s.baseUrl | sub("^[a-z]+://"; "") | sub("/.*$"; "")), serverType: $s.serverType })) }' > $RUN/run.json
not_run() { log "row $1: NOT RUN. $2"; jq --arg t "$1" --arg r "$2" '.notRun[$t] = $r' $RUN/run.json > $RUN/run.json.tmp && mv $RUN/run.json.tmp $RUN/run.json
  row_result $1 "[row $ROW_I/$ROW_N] $1" "not run"; }
rule() { mq --arg s "$1" --arg r "$2" '.sources[$s][$r] // empty'; }

pi_plain() { PI_CODING_AGENT_DIR=$AGENT PI_MODEL_DISCOVERY_NO_FAMILY_UPDATE=1 timeout 120 $PI_BIN --no-context-files --no-extensions -e $REPO/extensions/index.ts "$@"; }

log "run folder: $RUN"

# md-live: one tmux session with a stable name. It shows the screen of the newest pi session of the run (live_view of lib.sh).
# The pi sessions have a new name for each case (md-<tag>-auto, md-<tag>-adapt, ...).
# A session group or a linked window is not used: kill-session then leaves the window, and pi stays alive.
# A tmux client in md-live is not used: an attached client changes the height of the pi window from 46 to 45 rows.
echo md-live >> $RUN/tmux-sessions.txt
tmux kill-session -t md-live 2>/dev/null
tmux new-session -d -s md-live -x 200 -y 46 "LIVE_MATRIX_DIR='$RUN' zsh -fc 'source \"$LIVE/lib.sh\"; live_view'"
tmux set-option -t md-live status off
log "To see the live pi session (read-only): tmux attach -r -t md-live"

# ---------------------------------------------------------------- reach check and model lists
: > $RUN/ev/other/list-models.txt
for src in ${(f)"$(mq '.sources|keys[]')"}; do
  pi_plain --list-models $src > $RUN/ev/other/list-$src.txt 2>> $RUN/run.log
  cat $RUN/ev/other/list-$src.txt >> $RUN/ev/other/list-models.txt
  log "$src: $(awk -v s="$src" '$1==s' $RUN/ev/other/list-$src.txt | wc -l | tr -d ' ') model(s) in the list"
done
ANCHOR_SRC=""; ANCHOR_MODEL=""
for tag in ${(f)"$(mq '.rows[].tag')"}; do
  src=$(mq --arg t "$tag" '.rows[]|select(.tag==$t)|.source'); model=$(mq --arg t "$tag" '.rows[]|select(.tag==$t)|.model')
  if awk -v s="$src" -v m="$model" '$1==s && $2==m {f=1} END{exit !f}' $RUN/ev/other/list-$src.txt; then
    REACH[$tag]=1
    [ -z "$ANCHOR_SRC" ] && { ANCHOR_SRC=$src; ANCHOR_MODEL=$model; }
  fi
done
restore_cfg

# ---------------------------------------------------------------- rows
# prepare_source <source> <model>: make <model> the only loaded model of a one-model-at-a-time source.
# Do not call it in $( ): it records the models that were loaded before the run. WHY gets the reason of a failure.
prepare_source() {
  local src=$1 model=$2 cur m
  cur=$(loaded_of $src) || { WHY="the source does not give its load state"; return 1; }
  if [ -z "${ORIG_SET[$src]:-}" ]; then ORIG_SET[$src]=1; ORIG_LOADED[$src]=$cur; log "$src: models loaded before the run: ${cur//$'\n'/ }"; fi
  for m in ${(f)cur}; do
    [ "$m" = "$model" ] && continue
    omlx $src unload "$m" >>$RUN/run.log 2>&1 || { WHY="the source did not unload $m (requests are active, or the server refused)"; return 1; }
  done
  if [[ $'\n'"$cur"$'\n' != *$'\n'"$model"$'\n'* ]]; then
    omlx $src load "$model" >>$RUN/run.log 2>&1 || { WHY="the source did not load $model"; return 1; }
  fi
}

for tag in ${(f)"$(jq -r '.rows[].tag' $RUN/run.json)"}; do
  ROW_I=$((ROW_I+1))
  src=$(mq --arg t "$tag" '.rows[]|select(.tag==$t)|.source'); model=$(mq --arg t "$tag" '.rows[]|select(.tag==$t)|.model')
  flags=$(mq --arg t "$tag" '.rows[]|select(.tag==$t)|.imageFlags // ""')
  if [ -n "$(rule $src listOnly)" ]; then not_run $tag "The source $src has the rule listOnly."; continue; fi
  if [ -z "${REACH[$tag]:-}" ]; then not_run $tag "The model list of $src does not have $model."; continue; fi
  if [ -n "$(rule $src oneModelAtATime)" ]; then
    prepare_source $src "$model" || { not_run $tag "$src: $WHY"; continue; }
  fi
  if ! node --experimental-strip-types $LIVE/expected.mjs $AGENT/model-discovery.json $src "$model" $RUN/ev/$tag.expected.json >> $RUN/run.log 2>&1; then
    not_run $tag "expected.mjs did not write the expected values. See run.log."; continue
  fi
  log "row $tag: start ($src/$model)"
  label="[row $ROW_I/$ROW_N] $tag $src/$model"; T0=$SECONDS
  IMGFLAGS=$flags $LIVE/run_model.sh $tag $src "$model" > $RUN/ev/$tag.log 2>&1 &
  CHILD=$!
  watch_row $tag "$label"
  wait $CHILD 2>/dev/null; CHILD=""
  restore_cfg
  # The server log: the local file, or SSH to the host of the source.
  host=$(rule $src sshHost); [ -n "$host" ] || host=$(jq -r --arg s "$src" '.sources[$s].host | sub(":[0-9]+$"; "")' $RUN/run.json)
  case $host in 127.0.0.1|localhost|"[::1]") host="" ;; esac
  if [ "$(jq -r --arg s "$src" '.sources[$s].serverType' $RUN/run.json)" = "oMLX" ]; then
    lines=$(server_lines $tag $host 2>> $RUN/run.log) && log "row $tag: end. $lines server line(s)" || log "row $tag: end. The server lines were not collected."
  else
    log "row $tag: end. No server log reader for this server type."
  fi
  row_result $tag "[row $ROW_I/$ROW_N] $tag" "$(mmss $((SECONDS-T0)))"
done

# ---------------------------------------------------------------- other cases
# Hidden model row: open the source panel with the checked helpers, save the row and the model panel.
HID_SRC=$(mq '.hiddenModel.source // empty'); HID_MODEL=$(mq '.hiddenModel.model // empty')
if [ -n "$HID_MODEL" ] && [ -n "$ANCHOR_SRC" ]; then
  log "other: hidden model row ($HID_SRC/$HID_MODEL)"
  start other $ANCHOR_SRC "$ANCHOR_MODEL" off
  open_model other $HID_SRC "$HID_MODEL" hidden-row >> $RUN/run.log 2>&1 && shot other hidden-model
  esc other 4; stop other
  restore_cfg
fi

# Family data update: a session that may get family data from GitHub. Then compare the cache with origin/main.
families_compare() {
  local cache=$AGENT/model-discovery-families.json all=true f a b
  [ -f $cache ] || { echo "The cache file is absent."; return; }
  timeout 60 git -C $REPO fetch -q origin main 2>/dev/null && echo "origin/main: fetched now" || echo "origin/main: the fetch failed. The compare uses the local copy of origin/main."
  for f in index.json ${(f)"$(jq -r '.index.files[]' $cache)"}; do
    a=$(git -C $REPO show origin/main:families/$f 2>/dev/null | jq -S -c . 2>/dev/null)
    if [ "$f" = index.json ]; then b=$(jq -S -c '.index' $cache); else b=$(jq -S -c --arg f "$f" '.files[$f]' $cache); fi
    if [ -n "$a" ] && [ "$a" = "$b" ]; then echo "$f same"; else echo "$f DIFFERENT"; all=false; fi
  done
  echo "cache baseUrl: $(jq -r '.baseUrl' $cache) revision: $(jq -r '.index.revision' $cache) rejected: $(jq -c '.rejected' $cache) ALL SAME: $all"
}
if [ -n "$ANCHOR_SRC" ]; then
  log "other: family data update"
  MD_FAMILY_UPDATE=1 start other $ANCHOR_SRC "$ANCHOR_MODEL" off
  cmd other "/discover families update"; sleep 3; wait_idle md-other 3 90 1 >/dev/null
  shot other families; cp $RUN/ev/other/families.txt $RUN/ev/other/families-verbs.txt
  stop other; sleep 1
  families_compare > $RUN/ev/other/families-update.txt 2>> $RUN/run.log
  rm -f $AGENT/model-discovery-families.json
fi

# ---------------------------------------------------------------- end: models, real config proof, page
restore_sources
{
  a=$(sha $REAL_CFG); b=$(sha $REAL_SET)
  echo "model-discovery.json before: ${SHA_CFG[1,12]} after: ${a[1,12]} same: $([ "$a" = "$SHA_CFG" ] && echo true || echo false)"
  echo "settings.json before: ${SHA_SET[1,12]} after: ${b[1,12]} same: $([ "$b" = "$SHA_SET" ] && echo true || echo false)"
} > $RUN/ev/other/real-config.txt
log "real config: $(tr '\n' ' ' < $RUN/ev/other/real-config.txt)"
row_result other "[other cases]" ""

python3 $LIVE/build_evidence.py $RUN > $RUN/build.log 2>&1
CODE=$?
cat $RUN/build.log | tee -a $RUN/run.log
cleanup
[ -n "$RESTORE_FAIL" ] && { echo "WARNING: a source did not get its models back. See run.log."; CODE=1; }
[ -d $AGENT ] && { echo "WARNING: the temporary agent folder is still there: $AGENT"; CODE=1; }
echo "$(jq -r '.totals' $RUN/result.json 2>/dev/null) Exit code $CODE. Page: $RUN/evidence.html"
exit $CODE
