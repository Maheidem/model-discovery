#!/bin/zsh
# run_model.sh <tag> <provider> <model> : all live cases of one model. Output goes to ev/<tag>*/ and stdout.
# run.sh starts this script. It sets LIVE_MATRIX_DIR (the run folder) and IMGFLAGS (more pi arguments for the image step).
source "${0:A:h}/lib.sh"
T=$1; P=$2; M=$3
echo "### $T $P/$M start $(date '+%F %T')"
# A "## <n> <name>" line starts a log section of build_evidence.py. run.sh shows each "## <n>" and "#> <n>" line as progress.
# Case 2 has a "#>" line: its lines must stay in section 1.
echo "## 1 panel"
start $T-auto $P "$M" off
open_model $T-auto $P "$M" && shot $T-auto panel && tmux capture-pane -p -t md-$T-auto | grep -E "family:|thinking:|Reasoning|Vision|Recommended"
esc $T-auto 3
echo "#> 2 automatic defaults"
levels $T-auto auto; wire $T-auto
echo "## 7 tool call"
say $T-auto "Use the read tool on the file notes.txt in the current folder. Then reply with its first line exactly." 400; shot $T-auto tool
sess $T-auto | tail -3
echo "## 3 customize"
cmd $T-auto "/discover preset defaults $P $M --yes"; sleep 3; shot $T-auto customize; tmux capture-pane -p -t md-$T-auto | grep -iE "preset|adaptive|copied" | tail -3
stop $T-auto; cfg $P "$M"
start $T-adapt $P "$M@adaptive" off; levels $T-adapt adaptive; wire $T-adapt
echo "## 4 edit: instruct-or-lowest preset temperature 0.33"
SLUG=$(cfg $P "$M" | jq -r '.routing.levels.off')
[ "$(level $T-adapt)" = "off" ] || echo "EDIT: level is not off: $(level $T-adapt)"
cmd $T-adapt "/discover preset set $P $M $SLUG temperature 0.33"; sleep 3
say $T-adapt "Reply with the single word: ok" 300; shot $T-adapt edit; wire $T-adapt | tail -1
stop $T-adapt
echo "## 5 fixed alias: show one preset as a model"
FIX=$(cfg $P "$M" | jq -r '.routing.levels.high')
start $T-fixcfg $P "$M" off
open_model $T-fixcfg $P "$M" && goto_row $T-fixcfg "Model: " "Thinking & presets" && keys $T-fixcfg Enter && sleep 1.5 \
 && goto_row $T-fixcfg "Presets" "› $FIX " && keys $T-fixcfg Enter && sleep 1.5 \
 && goto_row $T-fixcfg "Preset: $FIX" "Show as fixed model" && keys $T-fixcfg Enter && sleep 1 \
 && goto_row $T-fixcfg "Preset: $FIX" "Save preset" && shot $T-fixcfg editor && keys $T-fixcfg Enter && sleep 3
tmux capture-pane -p -t md-$T-fixcfg | grep -E "^╭" | tail -1
esc $T-fixcfg 5; stop $T-fixcfg; cfg $P "$M" | jq -c "[.presets[]|{slug,exposeAsModel}]"
[ "$(cfg $P "$M" | jq -r --arg s "$FIX" '.presets[]|select(.slug==$s)|.exposeAsModel')" = "true" ] || { echo "FIXED ALIAS NOT SET"; }
start $T-fixed $P "$M@$FIX" off; echo "start level=$(level $T-fixed) footer=$(footer $T-fixed)"; levels $T-fixed fixed; wire $T-fixed; stop $T-fixed
echo "## restore config copy"; restore_cfg
echo "## 6 image"
img() { local t=$1
  pi_session $t $P "$M" off "${IMGFLAGS:-} @word.png 'What word is written in this image? Reply with the word only.'"
  sleep 5; wait_idle md-$t 4 400 1 >/dev/null; shot $t image; tmux capture-pane -p -t md-$t | grep -iE "zebra|image|vision" | tail -3; wire $t | jq -c '{imageCount,piModel}'; }
img $T-img
# One more run when the answer has no ZEBRA42. The first answer stays in ev-first-try/ for the page.
if ! grep -q ZEBRA42 $S/ev/$T-img/image.txt; then
  echo "image: the first answer has no ZEBRA42. The step runs one more time."
  stop $T-img; sleep 1; rm -rf $S/ev-first-try/$T-img; mkdir -p $S/ev-first-try; mv $S/ev/$T-img $S/ev-first-try/$T-img
  img $T-img
fi
cmd $T-img "/discover model $M vision off --source $P"; sleep 2; stop $T-img; cfg $P "$M" | jq -c .override
img $T-imgoff; stop $T-imgoff
start $T-imgback $P "$M" off; cmd $T-imgback "/discover model $M vision auto --source $P"; sleep 2; stop $T-imgback; cfg $P "$M" | jq -c .override
restore_cfg
echo "### $T end $(date '+%F %T')"
