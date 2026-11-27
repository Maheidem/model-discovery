#!/usr/bin/env python3
"""Build one self-contained HTML evidence page from the live-test output in ./ev.

Usage: python3 build_evidence.py
Input:  <this folder>/ev/   (read only)
Output: <this folder>/evidence.html
"""
import datetime
import glob
import html
import json
import os
import re
import sys

# ---------------------------------------------------------------- constants
# Fill this list by hand. Each item is one sentence.
NOT_COVERED = [
    "Desktop (llama-swap): only the model list. No request was sent, because no model may be loaded there in these tests. The llama.cpp settings maxTokensField and supportsStore were not checked for the same reason.",
    "Ollama and LM Studio: the top-level reasoning_effort rule has unit tests only. No live server of these types exists here.",
    "The server log shows that a request arrived and how many tokens it made. It does not show the chat_template_kwargs. The wire log of pi is the source for those values.",
    "mac-m3, Gemma 4, image case: the run used pi with tools off, so that the OCR extension did not load a second model on that server.",
    "Inkling 2 Mini at level off sends reasoning_effort none. The model card says that some reasoning can still appear.",
    "The panel shows v0.10.0 in the pictures. The version number changes to 0.11.0 only after these tests.",
]

VERSION = os.environ.get("LIVE_MATRIX_VERSION", "0.11.0")
MAX_BYTES = 14 * 1024 * 1024
HERE = os.environ["LIVE_MATRIX_DIR"]  # the work folder of the run
EV = os.path.join(HERE, "ev")
OUT = os.path.join(HERE, "evidence.html")
EV_OTHER = os.path.join(EV, "other")
EV_FIRST = os.path.join(HERE, "ev-first-try")
NOT_CHAT_RE = re.compile(r"asr|rerank|embed|tts|aligner|markitdown", re.I)
OTHER_CASES = [("list", "Model list: chat models only"), ("desktop", "Desktop model list"), ("hidden", "Hidden model row"),
               ("config", "Config: no loss"), ("families", "Family data update")]

ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
SAMPLING_KEYS = ["temperature", "top_p", "top_k", "min_p", "presence_penalty"]

_QWEN_OFF = {"temperature": 0.7, "top_p": 0.8, "top_k": 20, "presence_penalty": 1.5}
_QWEN_ON = {"temperature": 0.6, "top_p": 0.95, "top_k": 20, "presence_penalty": 0}
_Q38_OFF = {"temperature": 0.7, "top_p": 0.8, "top_k": 20, "min_p": 0, "presence_penalty": 1.5}
_Q38_ON = {"temperature": 1, "top_p": 0.95, "top_k": 20, "min_p": 0, "presence_penalty": 0}
_GEMMA = {"temperature": 1, "top_p": 0.95, "top_k": 64}


def _q38(efforts):
    d = {"off": {"kwargs": {"enable_thinking": False, "preserve_thinking": True}, "sampling": _Q38_OFF}}
    for lvl, eff in zip(ALL_LEVELS[1:], efforts):
        d[lvl] = {"kwargs": {"enable_thinking": True, "reasoning_effort": eff, "preserve_thinking": True},
                  "sampling": _Q38_ON}
    return d


# Expected values for each family.
#   label: the text that the panel "family:" line must name.
#   levels: the offered thinking levels, in order.
#   wire: for each level, the expected request.chat_template_kwargs and the expected sampling fields.
#   top_level_effort_absent: the request must have no top-level reasoning_effort field.
#   off_thinking_can_show: at level off the session can hold thinking text (show the number, no fail).
EXPECTED = {
    "gemma4": {
        "label": "Gemma 4", "levels": ["off", "high"], "top_level_effort_absent": True,
        "wire": {"off": {"kwargs": {"enable_thinking": False}, "sampling": _GEMMA},
                 "high": {"kwargs": {"enable_thinking": True}, "sampling": _GEMMA}},
    },
    "qwen35": {
        "label": "Qwen 3.5", "levels": ["off", "high"], "top_level_effort_absent": True,
        "wire": {"off": {"kwargs": {"enable_thinking": False}, "sampling": _QWEN_OFF},
                 "high": {"kwargs": {"enable_thinking": True}, "sampling": _QWEN_ON}},
    },
    "qwen36": {
        "label": "Qwen 3.6", "levels": ["off", "high"], "top_level_effort_absent": True,
        "wire": {"off": {"kwargs": {"enable_thinking": False, "preserve_thinking": True}, "sampling": _QWEN_OFF},
                 "high": {"kwargs": {"enable_thinking": True, "preserve_thinking": True}, "sampling": _QWEN_ON}},
    },
    "qwen38": {
        "label": "Qwen 3.8", "levels": ALL_LEVELS,
        "wire": _q38(["low", "low", "medium", "xhigh", "xhigh", "xhigh"]),
    },
    "qwen38flash": {
        "label": "Qwen 3.8", "levels": ALL_LEVELS,
        "wire": _q38(["low", "low", "medium", "high", "xhigh", "xhigh"]),
    },
    "inkling2mini": {
        "label": "Inkling 2 Mini", "levels": ALL_LEVELS, "off_thinking_can_show": True,
        "wire": {lvl: {"kwargs": {"reasoning_effort": eff}, "sampling": {"temperature": 1}}
                 for lvl, eff in zip(ALL_LEVELS, ["none", "minimal", "low", "medium", "high", "xhigh", "max"])},
    },
}


def family_of(model_id):
    m = (model_id or "").lower()
    if "gemma" in m:
        return "gemma4"
    if "inkling" in m:
        return "inkling2mini"
    if re.search(r"qwen3[.\-_]?8", m):
        return "qwen38flash" if "flash" in m else "qwen38"
    if re.search(r"qwen3[.\-_]?6", m):
        return "qwen36"
    if re.search(r"qwen3[.\-_]?5", m):
        return "qwen35"
    return None


CASES = [("panel", "Panel"), ("auto", "Automatic defaults"), ("customize", "Customize"), ("edit", "Edit"),
         ("fixed", "Fixed alias"), ("image", "Image"), ("tool", "Tool call")]
ROLES = [("auto", "base model run"), ("adapt", "adaptive alias run"), ("fixcfg", "fixed alias setup"),
         ("fixed", "fixed alias run"), ("img", "image run, vision on"), ("imgoff", "image run, vision off"),
         ("imgback", "vision reset run")]
ROLE_NAME = dict(ROLES)
CODING_PROMPTS = ("reverses a string", "n-th prime number")
ERROR_RE = re.compile(r"\berror\b|Unknown reasoning_effort|raise_exception", re.I)
# A screen holds the answer of the model, which can contain the word "error". Look for request errors only.
SCREEN_ERROR_RE = re.compile(r"Unknown reasoning_effort|raise_exception|^\s*Error:|\b(400|422|500) \b.*(status|error)|API error", re.I)

# ---------------------------------------------------------------- text cleaning
_PATH_RES = [
    (re.compile(r"(?:/private)?/tmp/claude-\d+/[^/\s\"'&<]+/[0-9a-f-]{36}/scratchpad"), "[scratch]"),
    (re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/scratchpad"), "[scratch]"),
    (re.compile(r"(?:/private)?/tmp/claude-\d+/[^\s\"'&<]*"), "[scratch]"),   # a path that was cut short
    (re.compile(r"/(?:Users|home)/[A-Za-z0-9._-]+"), "~"),
]
_MASK_RES = [
    (re.compile(re.escape(os.environ.get("LIVE_MATRIX_M3_HOST", "mac-m3.invalid")) + r"(?::\d+)?"), "mac-m3"),
    (re.compile(r"127\.0\.0\.1:8123"), "local-mac"),
    (re.compile(r"(?<![\d.])\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.])"), "[ip]"),
    (re.compile(r"(Bearer)(\s+|&#160;)[^\s\"'<&]+", re.I), r"\1\2***"),
    (re.compile(r"(?<![A-Za-z0-9])sk-[A-Za-z0-9_\-]{8,}"), "sk-***"),
    (re.compile(r"((?:api[_-]?key|apiKey)\"?\s*[:=]\s*\"?)[^\s\"',}]{6,}", re.I), r"\1***"),
]


def clean(s):
    """Remove local paths, IP addresses and strings that look like a key."""
    s = str(s)
    for rx, rep in _PATH_RES + _MASK_RES:
        s = rx.sub(rep, s)
    return s


def aid(tag):
    """Anchor name for a tag: ASCII letters, digits and hyphens, with a fixed prefix."""
    return "run-" + re.sub(r"[^A-Za-z0-9-]", "-", str(tag))


def e(s):
    return html.escape(clean(s), quote=True)


# ---------------------------------------------------------------- readers (never raise)
def read_text(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


def read_jsonl(path):
    """Return a list of dicts, or None when the file is absent."""
    txt = read_text(path)
    if txt is None:
        return None
    out = []
    for line in txt.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            v = json.loads(line)
            if isinstance(v, dict):
                out.append(v)
        except ValueError:
            pass
    return out


def norm(v):
    """Canonical value for a comparison: 1.0 becomes 1, dict keys are sorted."""
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, float) and v == int(v):
        return int(v)
    if isinstance(v, dict):
        return {k: norm(v[k]) for k in sorted(v)}
    if isinstance(v, list):
        return [norm(x) for x in v]
    return v


def j(v):
    return json.dumps(norm(v), sort_keys=True, ensure_ascii=False)


def same(a, b):
    return j(a) == j(b)


def sampling_of(req):
    req = req if isinstance(req, dict) else {}
    return {k: req[k] for k in SAMPLING_KEYS if req.get(k) is not None}


def kwargs_of(req):
    req = req if isinstance(req, dict) else {}
    v = req.get("chat_template_kwargs")
    return v if isinstance(v, dict) else {}


def fmt_sampling(d):
    return ", ".join("%s %s" % (k, j(d[k])) for k in SAMPLING_KEYS if k in d) or "none"


def parse_log(path):
    """Split the run log into sections. Key = the section number as text ('1', '7', '3', ...)."""
    txt = read_text(path)
    log = {"present": txt is not None, "raw": txt or "", "sections": {}, "provider": None, "model": None,
           "start": None, "end": None}
    cur = None
    for line in (txt or "").splitlines():
        m = re.match(r"^### \S+ (\S+?)/(.+) start (.+)$", line)
        if m:
            log["provider"], log["model"], log["start"] = m.group(1), m.group(2).strip(), m.group(3).strip()
            continue
        m = re.match(r"^### \S+ end (.+)$", line)
        if m:
            log["end"] = m.group(1).strip()
            continue
        m = re.match(r"^## (\d+)?\s*(.*)$", line)
        if m:
            cur = m.group(1) or m.group(2).split(" ")[0]
            log["sections"].setdefault(cur, [])
            continue
        if cur is not None:
            log["sections"][cur].append(line)
    return log


def level_lines(lines):
    """Return [(is_start_line, level, footer)] from 'level=<lvl> footer=<text>' lines."""
    out = []
    for line in lines or []:
        m = re.match(r"^(start )?level=(\S*) footer=(.*)$", line)
        if m:
            out.append((bool(m.group(1)), m.group(2), m.group(3).strip()))
    return out


def json_lines(lines, key):
    out = []
    for line in lines or []:
        line = line.strip()
        if line.startswith("{") and '"%s"' % key in line:
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def parse_sessions(folder):
    """Return a list of turns: {prompt, level, assistants: [{model, level, thinking, text, tools}]}.
    Return None when the folder has no session file."""
    files = sorted(glob.glob(os.path.join(folder, "sessions", "**", "*.jsonl"), recursive=True))
    if not files:
        return None
    turns = []
    for f in files:
        level, model = None, None
        for rec in read_jsonl(f) or []:
            t = rec.get("type")
            if t == "thinking_level_change":
                level = rec.get("thinkingLevel")
            elif t == "model_change":
                model = rec.get("modelId")
            elif t == "message" and isinstance(rec.get("message"), dict):
                msg = rec["message"]
                content = msg.get("content")
                items = [c for c in content if isinstance(c, dict)] if isinstance(content, list) else []
                if msg.get("role") == "user":
                    text = content if isinstance(content, str) else " ".join(
                        str(c.get("text", "")) for c in items if c.get("type") == "text")
                    turns.append({"prompt": text, "level": level, "assistants": []})
                elif msg.get("role") == "assistant":
                    if not turns:
                        turns.append({"prompt": "", "level": level, "assistants": []})
                    usage = msg.get("usage") if isinstance(msg.get("usage"), dict) else {}
                    turns[-1]["assistants"].append({
                        "model": msg.get("model") or model,
                        "level": msg.get("thinkingLevel") or level,
                        "thinking": sum(len(str(c.get("thinking", ""))) for c in items if c.get("type") == "thinking"),
                        "text": " ".join(str(c.get("text", "")) for c in items if c.get("type") == "text"),
                        "tools": [{"name": c.get("name"), "arguments": c.get("arguments")}
                                  for c in items if c.get("type") == "toolCall"],
                        "out": usage.get("output"),
                        "stop": msg.get("stopReason"),
                    })
    return turns


# ---------------------------------------------------------------- checks
def chk(name, expected, actual, ok, source=""):
    """ok: True = pass, False = fail, None = not run (no data), 'info' = shown, not counted."""
    return {"name": name, "expected": expected, "actual": actual, "ok": ok, "source": source}


def load_tag(tag):
    d = {"tag": tag, "log": parse_log(os.path.join(EV, tag + ".log")), "wire": {}, "sess": {}, "txt": {}, "svg": {}}
    for role, _ in ROLES:
        folder = os.path.join(EV, "%s-%s" % (tag, role))
        if not os.path.isdir(folder):
            continue
        d["wire"][role] = read_jsonl(os.path.join(folder, "wire.jsonl"))
        d["sess"][role] = parse_sessions(folder)
        d["txt"][role] = {os.path.basename(p)[:-4]: read_text(p) or ""
                          for p in sorted(glob.glob(os.path.join(folder, "*.txt")))}
        d["svg"][role] = {os.path.basename(p)[:-4]: p for p in sorted(glob.glob(os.path.join(folder, "*.svg")))}
    d["server"] = read_text(os.path.join(EV, tag + ".server.log"))
    log = d["log"]
    d["provider"], d["model"] = log["provider"], log["model"]
    if not d["model"]:
        for w in (d["wire"].get("auto") or []):
            d["provider"], d["model"] = w.get("provider"), (w.get("request") or {}).get("model") or w.get("piModel")
            break
    d["family"] = family_of(d["model"])
    d["exp"] = EXPECTED.get(d["family"])
    d["offered"] = [lvl for _, lvl, _ in level_lines(log["sections"].get("1"))]
    cfgs = json_lines(log["sections"].get("3"), "presets")
    d["cfg"] = cfgs[0] if cfgs else None
    return d


def case_panel(d):
    txt = d["txt"].get("auto", {}).get("panel")
    if txt is None:
        return None
    exp = d["exp"]
    rows = [re.sub(r"^[│\s]+|[│\s]+$", "", ln) for ln in txt.splitlines()]
    src = "panel screen text of the base model run"
    fam = next((r for r in rows if r.startswith("family:")), None)
    think = next((r for r in rows if r.startswith("thinking:")), None)
    vis = next((r for r in rows if "Vision (image input)" in r), None)
    label = exp["label"] if exp else None
    checks = [
        chk("family line names the family", "family: %s …" % label if label else "unknown family (no expected values)",
            fam or "no family line", bool(fam and label and label.lower() in fam.lower()), src),
        chk("thinking line ends with 'from server'", "thinking: … from server", think or "no thinking line",
            bool(think and think.endswith("from server")), src),
    ]
    m = re.search(r"Vision \(image input\)\s+(\S.*?)\s*[\(\[]([^\)\]]+)[\)\]]\s*$", vis or "")
    checks.append(chk("Vision row has a value and a source", "Vision (image input) <value> (<source>)",
                      re.sub(r"\s{2,}", "  ", vis) if vis else "no Vision row", bool(m), src))
    ver = next((re.search(r"Model Discovery v(\S+)", r).group(1) for r in rows if "Model Discovery v" in r), None)
    checks.append(chk("version that the panel shows (information)", VERSION, ver or "not shown", "info", src))
    return checks, label or "?", (fam or "no family line").replace("family:", "").strip()


def auto_lines(d):
    base = d["model"]
    return [w for w in (d["wire"].get("auto") or []) if w.get("piModel") == base]


def coding_turns(d, role):
    turns = d["sess"].get(role)
    if turns is None:
        return None
    return [t for t in turns if any(p in (t.get("prompt") or "") for p in CODING_PROMPTS)]


def wire_checks(prefix, line, level, exp_kwargs, exp_sampling, source, exp_note=""):
    """Compare one wire line with the expected level, kwargs and sampling."""
    if line is None:
        return [chk("%s: wire line" % prefix, "one wire line at level %s" % level, "no wire line", False, source)]
    req = line.get("request") or {}
    return [
        chk("%s: thinking level on the wire" % prefix, level, line.get("thinkingLevel"),
            line.get("thinkingLevel") == level, source),
        chk("%s: chat_template_kwargs%s" % (prefix, exp_note), j(exp_kwargs), j(kwargs_of(req)),
            same(exp_kwargs, kwargs_of(req)), source),
        chk("%s: sampling%s" % (prefix, exp_note), fmt_sampling(exp_sampling), fmt_sampling(sampling_of(req)),
            same(exp_sampling, sampling_of(req)), source),
    ]


def case_auto(d):
    log, exp = d["log"], d["exp"]
    wire = d["wire"].get("auto")
    if not wire and not d["offered"]:
        return None
    checks = []
    exp_levels = exp["levels"] if exp else None
    offered = d["offered"]
    checks.append(chk("offered levels", ", ".join(exp_levels) if exp_levels else "unknown family (no expected values)",
                      ", ".join(offered) if offered else ("no level line in the run log" if log["present"] else "no run log"),
                      (offered == exp_levels) if (offered and exp_levels) else (None if not log["present"] else False),
                      "run log, automatic defaults section"))
    levels = offered or exp_levels or []
    lines = auto_lines(d)
    turns = coding_turns(d, "auto")
    wsrc, ssrc = "wire log of the base model run", "session file of the base model run"
    for i, lvl in enumerate(levels):
        want = (exp or {}).get("wire", {}).get(lvl)
        line = lines[i] if i < len(lines) else None
        if want is None:
            checks.append(chk("level %s: expected values" % lvl, "level is in the expected list", "no expected values for this level", False, wsrc))
        else:
            checks += wire_checks("level %s" % lvl, line, lvl, want["kwargs"], want["sampling"], wsrc)
            if exp.get("top_level_effort_absent") and line is not None:
                re_top = (line.get("request") or {}).get("reasoning_effort")
                checks.append(chk("level %s: top-level reasoning_effort" % lvl, "absent",
                                  "absent" if re_top is None else j(re_top), re_top is None, wsrc))
        # thinking characters in the session file
        if turns is None or i >= len(turns) or not turns[i]["assistants"]:
            checks.append(chk("level %s: thinking characters" % lvl, "0" if lvl == "off" else "> 0", "no session data", None, ssrc))
        else:
            n = sum(a["thinking"] for a in turns[i]["assistants"])
            if lvl == "off" and exp and exp.get("off_thinking_can_show"):
                checks.append(chk("level off: thinking characters (information)",
                                  "any number (off sends 'none'; the model card says that some reasoning can still appear)",
                                  str(n), "info", ssrc))
            else:
                checks.append(chk("level %s: thinking characters" % lvl, "0" if lvl == "off" else "> 0", str(n),
                                  n == 0 if lvl == "off" else n > 0, ssrc))
    # error lines
    hits = []
    for name, txt in sorted(d["txt"].get("auto", {}).items()):
        if name.startswith("auto-"):
            hits += ["screen %s: %s" % (name, ln.strip()[:200]) for ln in txt.splitlines() if SCREEN_ERROR_RE.search(ln)]
    checks.append(chk("error text on the automatic-defaults screens", "0 lines", "%d lines" % len(hits) + ("".join("\n" + h for h in hits[:8])),
                      not hits, "screen texts auto-<level> of the base model run"))
    if d["server"] is None:
        checks.append(chk("error text in the server lines", "0 lines", "server lines not collected", "info", "server log lines"))
    else:
        sh = [ln.strip()[:240] for ln in d["server"].splitlines() if ERROR_RE.search(ln)]
        checks.append(chk("error text in the server lines", "0 lines", "%d lines" % len(sh) + "".join("\n" + h for h in sh[:8]),
                          not sh, "server log lines"))
    return checks, "levels " + (", ".join(exp_levels) if exp_levels else "?"), "levels " + (", ".join(offered) if offered else "?")


def case_customize(d):
    log = d["log"]
    if "3" not in log["sections"] and "adapt" not in d["wire"]:
        return None
    checks = []
    cfg = d["cfg"]
    presets = (cfg or {}).get("presets")
    routing = (cfg or {}).get("routing") or {}
    n_presets = len(presets) if isinstance(presets, list) else 0
    checks.append(chk("config after the command has presets and enabled routing", "presets ≥ 1, routing enabled = true",
                      "no config line in the run log" if cfg is None else "presets %d, routing enabled = %s" % (n_presets, j(routing.get("enabled"))),
                      (n_presets > 0 and routing.get("enabled") is True) if cfg is not None else (None if not log["present"] else False),
                      "run log, customize section"))
    levels = d["offered"] or ((d["exp"] or {}).get("levels") or [])
    base_lines = auto_lines(d)
    adapt = d["wire"].get("adapt")
    wsrc = "wire log of the adaptive alias run"
    for i, lvl in enumerate(levels):
        if adapt is None:
            checks.append(chk("level %s: wire line" % lvl, "same as the base model run", "no wire log", None, wsrc))
            continue
        if i >= len(base_lines):
            checks.append(chk("level %s: wire line" % lvl, "same as the base model run", "no base model wire line to compare", None, wsrc))
            continue
        breq = base_lines[i].get("request") or {}
        checks += wire_checks("level %s" % lvl, adapt[i] if i < len(adapt) else None, lvl, kwargs_of(breq), sampling_of(breq),
                              wsrc, " (expected = base model run)")
    lv = [(lvl, foot) for start, lvl, foot in level_lines(log["sections"].get("3")) if not start]
    if not lv:
        checks.append(chk("footer shows the preset", "preset: <slug>", "no level line in the customize section",
                          None if not log["present"] or "3" not in log["sections"] else False, "run log, customize section"))
    for lvl, foot in lv:
        slug = (routing.get("levels") or {}).get(lvl)
        want = "preset: %s" % (slug if slug else "<slug>")
        ok = (foot == want) if slug else bool(re.match(r"^preset: \S+", foot))
        checks.append(chk("level %s: footer shows the preset" % lvl, want, foot or "no footer text", ok, "run log, customize section"))
    return checks, "presets, routing on", ("presets %d, routing %s" % (n_presets, "on" if routing.get("enabled") is True else "off")) if cfg is not None else "no config line"


def case_edit(d):
    log = d["log"]
    adapt = d["wire"].get("adapt")
    if (log["present"] and "4" not in log["sections"]) or (not log["present"] and adapt is None):
        return None
    src = "last wire line of the adaptive alias run"
    if not adapt:
        return [chk("last wire line", "temperature 0.33, level off", "no wire line", None if adapt is None else False, src)], "temperature 0.33", "no wire line"
    last = adapt[-1]
    t = (last.get("request") or {}).get("temperature")
    checks = [
        chk("temperature of the last wire line", "0.33", j(t), isinstance(t, (int, float)) and not isinstance(t, bool) and abs(t - 0.33) < 1e-9, src),
        chk("thinking level of the last wire line", "off", last.get("thinkingLevel"), last.get("thinkingLevel") == "off", src),
    ]
    return checks, "temperature 0.33", "temperature %s" % j(t)


def case_fixed(d):
    wire = d["wire"].get("fixed")
    if wire is None:
        return None
    log, base = d["log"], d["model"]
    src = "wire log of the fixed alias run"
    slug = (((d["cfg"] or {}).get("routing") or {}).get("levels") or {}).get("high")
    slug_src = "routing preset of level high"
    if not slug and wire:
        pm = str(wire[0].get("piModel") or "")
        slug = pm.rsplit("@", 1)[1] if "@" in pm else None
        slug_src = "first wire line"
    want_alias = "%s@%s" % (base, slug) if slug else "<model>@<slug>"
    if not wire:
        return [chk("wire lines", "≥ 1 line with piModel %s" % want_alias, "no wire line", False, src)], "@" + (slug or "?"), "no wire line"
    pms = sorted({str(w.get("piModel")) for w in wire})
    models = sorted({str((w.get("request") or {}).get("model")) for w in wire})
    sets = sorted({j({"kwargs": kwargs_of(w.get("request")), "sampling": sampling_of(w.get("request"))}) for w in wire})
    checks = [
        chk("piModel of every wire line ends with @<slug> (slug from: %s)" % slug_src, want_alias, ", ".join(pms),
            bool(slug) and all(p.endswith("@" + slug) for p in pms), src),
        chk("request.model of every wire line is the base model id", str(base), ", ".join(models), models == [str(base)], src),
        chk("one constant set of kwargs and sampling in %d wire line(s)" % len(wire), "1 set", "%d set(s): %s" % (len(sets), " | ".join(sets)),
            len(sets) == 1, src),
    ]
    foots = [foot for _, _, foot in level_lines(log["sections"].get("5"))]
    want = "fixed preset: %s" % (slug or "<slug>")
    if not foots:
        checks.append(chk("footer shows the fixed preset", want, "no level line in the fixed alias section",
                          None if not log["present"] else False, "run log, fixed alias section"))
    else:
        checks.append(chk("footer shows the fixed preset (%d line(s))" % len(foots), want, " | ".join(sorted(set(foots))),
                          bool(slug) and all(f == want for f in foots), "run log, fixed alias section"))
    return checks, "@" + (slug or "?"), ", ".join("@" + p.rsplit("@", 1)[1] if "@" in p else p for p in pms)


def case_image(d):
    on, off = d["wire"].get("img"), d["wire"].get("imgoff")
    if on is None and off is None and "img" not in d["txt"]:
        return None
    checks = []
    first = on[0].get("imageCount") if on else None
    checks.append(chk("vision on: imageCount of the first wire line", "1", "no wire line" if not on else j(first),
                      (first == 1) if on else (None if on is None else False), "wire log of the image run, vision on"))
    txt = d["txt"].get("img", {}).get("image")
    found = None if txt is None else "ZEBRA42" in txt
    checks.append(chk("vision on: the screen contains ZEBRA42", "ZEBRA42 on the screen",
                      "no screen text" if txt is None else ("ZEBRA42 on the screen" if found else "ZEBRA42 not on the screen"),
                      found, "image screen text, vision on"))
    counts = [w.get("imageCount") for w in off] if off else []
    checks.append(chk("vision off: imageCount of every wire line", "0 in every line (≥ 1 line)",
                      "no wire log" if off is None else ("no wire line" if not off else "%d line(s): %s" % (len(off), ", ".join(j(c) for c in counts))),
                      None if off is None else (bool(off) and all(c == 0 for c in counts)), "wire log of the image run, vision off"))
    act_off = "?" if not off else ("0" if all(c == 0 for c in counts) else "≠0")
    return checks, "images on 1, off 0", "images on %s, off %s" % ("?" if first is None else j(first), act_off)


def case_tool(d):
    turns = d["sess"].get("auto")
    log = d["log"]
    ran = "7" in log["sections"] or any("notes.txt" in (t.get("prompt") or "") for t in (turns or []))
    if turns is None or not ran:
        return None
    src = "session file of the base model run"
    flat = [a for t in turns for a in t["assistants"]]
    calls, call_at = [], None
    for i, a in enumerate(flat):
        for tc in a["tools"]:
            args = tc.get("arguments") if isinstance(tc.get("arguments"), dict) else {}
            if tc.get("name") == "read" and str(args.get("path", "")).endswith("notes.txt"):
                calls.append(tc)
                call_at = i if call_at is None else call_at
    all_calls = [tc for a in flat for tc in a["tools"]]
    later = [a["text"] for a in flat[call_at + 1:]] if call_at is not None else []
    hit = next((t for t in later if "PINEAPPLE-7781" in t), None)
    checks = [
        chk("tool call read with a path that ends with notes.txt", "≥ 1 call: read {path: …notes.txt}",
            "%d matching call(s); all tool calls: %s" % (len(calls), j(all_calls) if all_calls else "none"), bool(calls), src),
        chk("a later assistant text contains PINEAPPLE-7781", "PINEAPPLE-7781 in the text",
            clean(hit)[:100] if hit else ("no later assistant text with PINEAPPLE-7781" if calls else "no tool call before the text"),
            bool(hit) if calls else False, src),
    ]
    return checks, "read notes.txt, PINEAPPLE-7781", ("read notes.txt" if calls else "no read call") + (", PINEAPPLE-7781" if hit else ", no PINEAPPLE-7781")


CASE_FN = {"panel": case_panel, "auto": case_auto, "customize": case_customize, "edit": case_edit,
           "fixed": case_fixed, "image": case_image, "tool": case_tool}


def case_status(checks):
    """Return (status, passed, counted, missing). status: pass / fail / partial / notrun."""
    counted = [c for c in checks if c["ok"] != "info"]
    passed = sum(1 for c in counted if c["ok"] is True)
    failed = sum(1 for c in counted if c["ok"] is False)
    missing = sum(1 for c in counted if c["ok"] is None)
    if failed:
        st = "fail"
    elif counted and missing == len(counted):
        st = "notrun"
    elif missing:
        st = "partial"
    else:
        st = "pass"
    return st, passed, len(counted), missing


def run_cases(d):
    res = {}
    for cid, _ in CASES:
        try:
            r = CASE_FN[cid](d)
        except Exception as ex:  # a broken input must not stop the page
            r = ([chk("the check ran", "no exception", "%s: %s" % (type(ex).__name__, ex), False, "build script")], "?", "check stopped")
        if r is None:
            res[cid] = None
        else:
            checks, hexp, hact = r
            res[cid] = {"checks": checks, "exp": hexp, "act": hact, "status": case_status(checks)}
    return res


# ---------------------------------------------------------------- pictures
def picture_case(role, name):
    if role == "auto":
        if name == "panel":
            return "panel"
        if name.startswith("auto-"):
            return "auto"
        return {"tool": "tool", "customize": "customize"}.get(name, "auto")
    return {"adapt": "edit" if name == "edit" else "customize", "fixcfg": "fixed", "fixed": "fixed",
            "img": "image", "imgoff": "image", "imgback": "image"}.get(role, "auto")


def essential(pics):
    """The reduced set: panel, each auto level, one adaptive, edit, fixed, image, tool."""
    keep, seen = [], set()
    for role, name, path in pics:
        key = None
        if role == "auto" and (name in ("panel", "tool") or name.startswith("auto-")):
            key = (role, name)
        elif role == "adapt" and name.startswith("adaptive-"):
            key = "adaptive"
        elif role == "adapt" and name == "edit":
            key = "edit"
        elif role == "fixed" and name.startswith("fixed-"):
            key = "fixed"
        elif role == "img" and name == "image":
            key = "image"
        if key and key not in seen:
            seen.add(key)
            keep.append((role, name, path))
    return keep


_SVG_IDS = set()
_TEXT_RE = re.compile(r'(<text\b[^>]*?textLength=")([\d.]+)("[^>]*>)([^<]*)(</text>)')


def _fix_text(m):
    old = m.group(4)
    new = clean(old)
    if new == old:
        return m.group(0)
    n_old, n_new = len(html.unescape(old)) or 1, len(html.unescape(new))
    return "%s%.1f%s%s%s" % (m.group(1), float(m.group(2)) * n_new / n_old, m.group(3), new, m.group(5))


def inline_svg(path):
    svg = read_text(path)
    if not svg or "<svg" not in svg:
        return '<p class="muted">The picture file has no SVG content.</p>'
    svg = svg[svg.index("<svg"):]                                     # drop the XML prolog and the doctype
    svg = re.sub(r"<!--.*?-->", "", svg, flags=re.S)
    svg = re.sub(r"@font-face\s*\{.*?\}", "", svg, flags=re.S)          # no external font
    svg = _TEXT_RE.sub(_fix_text, svg)                                  # mask paths, keep the column width
    svg = re.sub(r"(<title>)(.*?)(</title>)", lambda m: m.group(1) + clean(m.group(2)) + m.group(3), svg, flags=re.S)
    prefixes = set(re.findall(r"terminal-\d+", svg))
    for p in sorted(prefixes):
        if p in _SVG_IDS:                                               # same id set in an earlier picture
            n = 1
            while "%s-u%d" % (p, n) in _SVG_IDS:
                n += 1
            new = "%s-u%d" % (p, n)
            svg = re.sub(re.escape(p) + r"(?!\d)", new, svg)
            _SVG_IDS.add(new)
        else:
            _SVG_IDS.add(p)
    return svg


# ---------------------------------------------------------------- HTML
CSS = """
:root{--bg:#fbfbfa;--fg:#1c1d1f;--muted:#666b73;--line:#d9dbdf;--card:#ffffff;--code:#f1f2f4;--pass:#17703a;--fail:#b3261e;--warn:#8a5a00;--link:#0b57b8;--shot:#292929;--focus:#0b57b8}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#16181b;--fg:#e6e7e9;--muted:#9aa0a8;--line:#353a41;--card:#1d2024;--code:#24282d;--pass:#5fd08a;--fail:#ff8a80;--warn:#e6b455;--link:#8ab4f8;--shot:#292929;--focus:#8ab4f8;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#16181b;--fg:#e6e7e9;--muted:#9aa0a8;--line:#353a41;--card:#1d2024;--code:#24282d;--pass:#5fd08a;--fail:#ff8a80;--warn:#e6b455;--link:#8ab4f8;--shot:#292929;--focus:#8ab4f8;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.page{max-width:1500px;margin:0 auto;padding-block:20px 80px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));overflow-wrap:anywhere}
h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.25rem;margin:44px 0 6px;padding-top:14px;border-top:2px solid var(--line)}
h3{font-size:1.05rem;margin:26px 0 6px}h4{font-size:.95rem;margin:16px 0 4px}
p{margin:6px 0}a{color:var(--link)}.muted{color:var(--muted)}
a:focus-visible,summary:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:2px}
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:6px;background:var(--card);margin:8px 0}
table{border-collapse:collapse;width:100%;font-size:.88rem;font-variant-numeric:tabular-nums}
th,td{padding:5px 9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{background:var(--code);font-weight:600;white-space:nowrap}tr:last-child td{border-bottom:0}
td.mono,pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.8rem}
td.mono{white-space:pre-wrap;word-break:break-word;min-width:9em}
pre{margin:0;padding:10px;background:var(--code);overflow-x:auto;white-space:pre;border-radius:6px;max-width:100%;overflow-wrap:normal}
.pass{color:var(--pass);font-weight:600}.fail{color:var(--fail);font-weight:600}.notrun,.info{color:var(--muted)}.partial{color:var(--warn);font-weight:600}
.sum td{min-width:8.5em;overflow-wrap:normal}
.sum td a{text-decoration:none;color:inherit;display:block}.sum td a:hover{text-decoration:underline}
.sum small{display:block;color:var(--muted);font-weight:400}
.totals{font-size:1rem;margin:10px 0}.banner{border-left:4px solid var(--warn);padding:6px 10px;background:var(--code);margin:8px 0}
details{margin:8px 0;min-width:0;max-width:100%}summary{cursor:pointer;color:var(--link)}
.shot{overflow-x:auto;max-width:100%;border:1px solid var(--line);border-radius:6px;margin:6px 0 16px;background:var(--shot)}
.shot svg{display:block;width:100%;min-width:1000px;height:auto}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(460px,100%),1fr));gap:14px}
.cols>div{min-width:0}
"""
MARK = {True: ('pass', '✓ pass'), False: ('fail', '✗ fail'), None: ('notrun', 'not run'), 'info': ('info', 'information')}


def table(headers, rows, cls=""):
    h = "".join("<th>%s</th>" % x for x in headers)
    return '<div class="wrap"><table class="%s"><thead><tr>%s</tr></thead><tbody>%s</tbody></table></div>' % (cls, h, "".join(rows))


def summary_cell(tag, cid, res):
    if res is None:
        return '<td class="notrun">not run</td>'
    st, passed, counted, missing = res["status"]
    href = "#%s-%s" % (tag if tag == "other" else aid(tag), cid)
    body = "%s = %s" % (e(res["exp"]), e(res["act"])) if st != "notrun" else "not run"
    if st == "pass":
        mark, sub = "✓", "%d/%d checks" % (passed, counted)
    elif st == "fail":
        mark, sub = "✗", "%d/%d checks, %d fail" % (passed, counted, counted - passed - missing)
        if res["exp"] == res["act"]:
            body = "see the checks"
    elif st == "partial":
        mark, sub = "partial", "%d/%d checks, %d not run" % (passed, counted, missing)
    else:
        mark, sub = "", "no data"
    return '<td class="%s"><a href="%s">%s %s<small>%s</small></a></td>' % (st, href, body, mark, sub)


def checks_table(checks):
    rows = []
    for c in checks:
        cls, text = MARK[c["ok"]]
        rows.append('<tr><td>%s</td><td class="mono">%s</td><td class="mono">%s</td><td class="%s">%s</td><td class="muted">%s</td></tr>'
                    % (e(c["name"]), e(c["expected"]), e(c["actual"]), cls, text, e(c["source"])))
    return table(["Check", "Expected", "Actual", "Result", "Source"], rows)


def wire_block(d):
    out = []
    for role, rname in ROLES:
        if role not in d["wire"]:
            continue
        lines = d["wire"][role]
        out.append("<h4>Wire log of the %s</h4>" % e(rname))
        if not lines:
            out.append('<p class="muted">%s</p>' % ("No wire log file." if lines is None else "The wire log has no line."))
            continue
        rows = []
        for w in lines:
            req = w.get("request") or {}
            rows.append("<tr>" + "".join('<td class="mono">%s</td>' % e(x) for x in [
                w.get("time", ""), w.get("piModel", ""), w.get("thinkingLevel", ""), w.get("messageCount", ""),
                w.get("imageCount", ""), w.get("toolCount", ""), req.get("model", ""), j(kwargs_of(req)),
                "absent" if req.get("reasoning_effort") is None else j(req.get("reasoning_effort")), fmt_sampling(sampling_of(req))]) + "</tr>")
        out.append(table(["Time (UTC)", "piModel", "Level", "Messages", "Images", "Tools", "request.model",
                          "chat_template_kwargs", "Top-level reasoning_effort", "Sampling"], rows))
        out.append("<details><summary>Raw wire lines (%d)</summary><pre>%s</pre></details>"
                   % (len(lines), e("\n".join(json.dumps(w, ensure_ascii=False) for w in lines))))
    return "".join(out) or '<p class="muted">not run</p>'


def server_block(d):
    if d["server"] is None:
        return '<p class="muted">server lines not collected</p>'
    lines = [ln for ln in d["server"].splitlines() if ln.strip()]
    chat = [ln for ln in lines if "Chat completion" in ln]
    out = ["<p>%d line(s) from the server log for the time window of the run. %d line(s) are chat completions.</p>" % (len(lines), len(chat))]
    if chat:
        out.append("<pre>%s</pre>" % e("\n".join(chat)))
    out.append("<details><summary>All server lines (%d)</summary><pre>%s</pre></details>" % (len(lines), e("\n".join(lines))))
    return "".join(out)


def session_block(d):
    out = []
    for role, rname in ROLES:
        if role not in d["sess"]:
            continue
        turns = d["sess"][role]
        out.append("<h4>Session file of the %s</h4>" % e(rname))
        rows = []
        for t in turns or []:
            for a in t["assistants"]:
                tools = "; ".join("%s %s" % (tc.get("name"), j(tc.get("arguments"))) for tc in a["tools"]) or "none"
                rows.append("<tr>" + "".join('<td class="mono">%s</td>' % e(x) for x in [
                    clean(t.get("prompt") or "")[:60], a.get("level") or "", a.get("model") or "", a["thinking"],
                    clean(a["text"])[:100], tools, "" if a.get("out") is None else a["out"]]) + "</tr>")
        if not rows:
            out.append('<p class="muted">%s</p>' % ("No session file." if turns is None else "The session file has no assistant message."))
        else:
            out.append(table(["Prompt (first 60 characters)", "Level", "Model", "Thinking characters",
                              "Text (first 100 characters)", "Tool calls", "Output tokens"], rows))
    return "".join(out) or '<p class="muted">not run</p>'


def pictures_block(d, reduced):
    pics = [(role, name, path) for role, _ in ROLES for name, path in sorted(d["svg"].get(role, {}).items())]
    shown = essential(pics) if reduced else pics
    out, by_case = [], {}
    for role, name, path in shown:
        by_case.setdefault(picture_case(role, name), []).append((role, name, path))
    for cid, cname in CASES:
        for role, name, path in by_case.get(cid, []):
            out.append('<h4 id="%s-pic-%s-%s">%s — screen "%s" of the %s</h4>' % (aid(d["tag"]), role, aid(name)[4:], e(cname), e(name), e(ROLE_NAME[role])))
            out.append('<div class="shot">%s</div>' % inline_svg(path))
            txt = d["txt"].get(role, {}).get(name)
            if txt:
                out.append("<details><summary>The same screen as text</summary><pre>%s</pre></details>" % e(txt.rstrip()))
    if reduced and len(shown) < len(pics):
        out.append('<p class="muted">The page limit is 14 MB. %d of %d pictures of this model are shown. The other pictures stay in the evidence folder.</p>'
                   % (len(shown), len(pics)))
    return "".join(out) or '<p class="muted">No picture.</p>'


def model_section(d, res, reduced):
    tag = d["tag"]
    title = "%s/%s" % (d["provider"] or "?", d["model"] or "?")
    out = ['<h2 id="%s">%s — %s</h2>' % (aid(tag), e(tag), e(title))]
    log = d["log"]
    fam = d["family"] or "unknown (no expected values)"
    out.append('<p class="muted">Family for the expected values: %s. Start: %s. End: %s.</p>'
               % (e(fam), e(log["start"] or "not recorded"), e(log["end"] or "not recorded")))
    if not log["present"]:
        out.append('<div class="banner">The run log is absent. Checks that need the run log show "not run".</div>')
    elif not log["end"]:
        out.append('<div class="banner">The run log has no end line. The run was in progress or stopped when the page was built. Later cases can be incomplete.</div>')
    for cid, cname in CASES:
        r = res[cid]
        out.append('<h3 id="%s-%s">%s — %s</h3>' % (aid(tag), cid, e(tag), e(cname)))
        if r is None:
            out.append('<p class="notrun">not run</p>')
            if cid == "image":
                out.append(first_try_note(tag))
            continue
        st, passed, counted, missing = r["status"]
        label = {"pass": "✓ pass", "fail": "✗ fail", "partial": "partial", "notrun": "not run"}[st]
        out.append('<p><span class="%s">%s</span> — %d of %d checks pass, %d fail, %d not run.</p>'
                   % (st, label, passed, counted, counted - passed - missing, missing))
        out.append(checks_table(r["checks"]))
        if cid == "image":
            out.append(first_try_note(tag))
    out.append('<h3 id="%s-telemetry">%s — telemetry</h3>' % (aid(tag), e(tag)))
    out.append('<div class="cols"><div><h4>(a) Wire lines from pi</h4>%s</div><div><h4>(b) Server log lines</h4>%s<h4>(c) Session file facts</h4>%s</div></div>'
               % (wire_block(d), server_block(d), session_block(d)))
    if log["present"]:
        out.append("<details><summary>Run log (raw)</summary><pre>%s</pre></details>" % e(log["raw"].rstrip()))
    out.append('<h3 id="%s-pictures">%s — pictures</h3>' % (aid(tag), e(tag)))
    out.append(pictures_block(d, reduced))
    return "".join(out)


def first_try_note(tag):
    """A note about an earlier image run of the tag. Empty when no such run exists."""
    folder = os.path.join(EV_FIRST, tag + "-img")
    if not os.path.isdir(folder):
        return ""
    turns = parse_sessions(folder) or []
    first = next((a for t in turns for a in t["assistants"]), None)
    if first is None:
        answer = "no assistant message in the session file"
    else:
        answer = clean(first["text"]).strip()[:300] or "an empty text"
    return ('<p class="banner">First attempt: the model answered <code>%s</code>. '
            'The run was done a second time; the result above is the second run.</p>' % e(answer))


def other_cases():
    """The live cases that are not for one model. Input: the folder 'other' in the evidence folder."""
    res, extra = {}, {}
    rd = lambda name: read_text(os.path.join(EV_OTHER, name))
    # A + B: the model list
    txt = rd("list-models.txt")
    if txt is None:
        res["list"] = res["desktop"] = None
    else:
        rows = [ln.split() for ln in txt.splitlines() if len(ln.split()) >= 2 and ln.split()[0].lower() != "provider"]
        per = {}
        for r in rows:
            per[r[0]] = per.get(r[0], 0) + 1
        bad = ["%s %s" % (r[0], r[1]) for r in rows if NOT_CHAT_RE.search(r[1])]
        counts = ", ".join("%s %d" % (k, per[k]) for k in sorted(per)) or "no line"
        src = "output of the model list command"
        ca = [chk("models that are not chat models are absent from the model list",
                  "0 lines with asr, rerank, embed, tts, aligner or markitdown in the model column (≥ 1 line in the list)",
                  "%d such line(s) in %d line(s)%s. Lines per provider: %s" % (len(bad), len(rows), "".join("\n" + b for b in bad), counts),
                  bool(rows) and not bad, src)]
        res["list"] = (ca, "0 models that are not chat models", "%d (%s)" % (len(bad), counts))
        desk = [ln.rstrip() for ln in txt.splitlines() if ln.startswith("Desktop")]
        cb = [chk("Desktop (llama-swap) lists its models with no model load", "≥ 1 line that starts with Desktop",
                  "%d line(s)" % len(desk), bool(desk), src)]
        res["desktop"] = (cb, "≥ 1 Desktop line", "%d Desktop line(s)" % len(desk))
        extra["desktop"] = "<details><summary>Desktop lines (%d)</summary><pre>%s</pre></details>" % (len(desk), e("\n".join(desk)))
    # C: hidden row
    row = rd("hidden-row.txt")
    pics = [n for n in ("hidden-row", "hidden-model") if os.path.isfile(os.path.join(EV_OTHER, n + ".svg"))]
    if row is None and not pics:
        res["hidden"] = None
    else:
        line = next((re.sub(r"^[│\s]+|[│\s]+$", "", ln) for ln in (row or "").splitlines() if "hidden (speech-to-text)" in ln), None)
        cc = [chk("the source panel row shows the hidden model", "a row with 'hidden (speech-to-text)'",
                  "no screen text" if row is None else (line or "no such row"), None if row is None else bool(line),
                  "source panel screen text")]
        res["hidden"] = (cc, "hidden (speech-to-text)", "hidden (speech-to-text)" if line else "no such row")
        h = []
        for n, cap in (("hidden-row", "source panel with the hidden row"), ("hidden-model", "model panel of the hidden model")):
            if n in pics:
                h.append('<h4>Screen: %s</h4><div class="shot">%s</div>' % (cap, inline_svg(os.path.join(EV_OTHER, n + ".svg"))))
                t = rd(n + ".txt")
                if t:
                    h.append("<details><summary>The same screen as text</summary><pre>%s</pre></details>" % e(t.rstrip()))
        extra["hidden"] = "".join(h)
    # D: config readback
    cfg = rd("config-readback.txt")
    if cfg is None:
        res["config"] = None
    else:
        pl = [ln.strip() for ln in cfg.splitlines() if "presets same:" in ln]
        kl = [ln.strip() for ln in cfg.splitlines() if "apiKey same:" in ln]
        pbad = [ln for ln in pl if not ln.endswith("presets same: true routing same: true")]
        kbad = [ln for ln in kl if not re.search(r"apiKey same: true\b", ln)]
        src = "compare of the config after all tests with the backup from before the work"
        cd = [chk("presets and routing: no loss", "every 'presets same:' line ends with 'presets same: true routing same: true' (≥ 1 line)",
                  "%d line(s), %d different%s" % (len(pl), len(pbad), "".join("\n" + b for b in pbad)), bool(pl) and not pbad, src),
              chk("API key: no change", "every 'apiKey same:' line says true",
                  "%d line(s), %d different%s" % (len(kl), len(kbad), "".join("\n" + b for b in kbad)), not kbad, src)]
        res["config"] = (cd, "presets, routing, apiKey same", "%d of %d presets lines same, %d of %d apiKey lines same"
                         % (len(pl) - len(pbad), len(pl), len(kl) - len(kbad), len(kl)))
        extra["config"] = ("<pre>%s</pre><p>The three override changes are the ones that the owner approved on 2026-11-27 "
                           "(remove the stored reasoning and vision settings of the tested models).</p>" % e(cfg.rstrip()))
    # E: family data update
    upd, verbs = rd("families-update.txt"), rd("families-verbs.txt")
    if upd is None and verbs is None:
        res["families"] = None
    else:
        a_same, a_rej = "ALL SAME: true" in (upd or ""), "rejected: []" in (upd or "")
        ce = [chk("family data update from GitHub", "ALL SAME: true and rejected: []",
                  "no compare text" if upd is None else "ALL SAME: true %s, rejected: [] %s" % ("found" if a_same else "not found", "found" if a_rej else "not found"),
                  None if upd is None else (a_same and a_rej), "compare of the family data cache with the bundled family files")]
        res["families"] = (ce, "ALL SAME: true, rejected: []", "ALL SAME %s, rejected [] %s" % ("true" if a_same else "not found", "found" if a_rej else "not found"))
        extra["families"] = "".join("<h4>%s</h4><pre>%s</pre>" % (cap, e(t.rstrip())) for cap, t in
                                    (("Compare of the cache with the bundled files", upd), ("Output of the family data commands", verbs)) if t)
    out = {}
    for cid, _ in OTHER_CASES:
        r = res.get(cid)
        out[cid] = None if r is None else {"checks": r[0], "exp": r[1], "act": r[2], "status": case_status(r[0])}
    return out, extra


def other_section(ores, extra):
    out = ['<h2 id="other">Other live cases</h2><p class="muted">These cases are not for one model. They use the three sources together.</p>']
    for cid, cname in OTHER_CASES:
        r = ores[cid]
        out.append('<h3 id="other-%s">%s</h3>' % (cid, e(cname)))
        if r is None:
            out.append('<p class="notrun">not run</p>')
            continue
        st, passed, counted, missing = r["status"]
        label = {"pass": "✓ pass", "fail": "✗ fail", "partial": "partial", "notrun": "not run"}[st]
        out.append('<p><span class="%s">%s</span> — %d of %d checks pass, %d fail, %d not run.</p>'
                   % (st, label, passed, counted, counted - passed - missing, missing))
        out.append(checks_table(r["checks"]))
        out.append(extra.get(cid, ""))
    return "".join(out)


def method_section():
    items = "".join("<li>%s</li>" % e(x) for x in NOT_COVERED) or '<li class="muted">No item is recorded.</li>'
    return """<h2 id="method">Method</h2>
<ol>
<li>Each case runs in the real pi 1.6.1 terminal interface. A tmux session holds the terminal. The test sends keys and reads the screen.</li>
<li>The switch <code>PI_MODEL_DISCOVERY_WIRE_LOG</code> makes the extension write one JSON line for each request. The line holds the request body without the messages and the tools.</li>
<li>pi writes a session file for each run. The file holds each assistant message with its thinking text, its text and its tool calls.</li>
<li>The server log gives the server view of the same requests. The lines are a copy for the time window of the run.</li>
<li>Each picture is a capture of the terminal screen. The same screen is also saved as text.</li>
<li>This page compares the expected values with the values in these files. A script computes each "pass" and each "fail". Nobody edits the results by hand.</li>
</ol>
<h3>The cases</h3>
<ul>
<li><b>Panel</b>: open the model panel. Read the family line, the thinking line and the Vision row.</li>
<li><b>Automatic defaults</b>: send one coding prompt at each offered thinking level of the base model. Compare the wire line and the thinking characters in the session file.</li>
<li><b>Tool call</b>: ask the model to read a file with the read tool and to repeat the first line.</li>
<li><b>Customize</b>: copy the recommended presets to the model. Send the same prompt at each level of the adaptive alias.</li>
<li><b>Edit</b>: set the temperature of the preset for level off to 0.33. Send one prompt at level off.</li>
<li><b>Fixed alias</b>: show one preset as a fixed model. Send the prompt through the fixed alias.</li>
<li><b>Image</b>: send a picture with the word ZEBRA42. Then set vision to off and send the picture again.</li>
</ul>
<h3>Changes during the session</h3>
<ul>
<li>The thinking prompt changed during the session from "reverses a string" to "n-th prime number". The first prompt was too easy to make Gemma 4 think.</li>
<li>The live tests caused these code fixes:
<ul>
<li>The "Show as fixed model" toggle had no effect.</li>
<li>A preset edit put the thinking level back to the default.</li>
<li>The routing "enabled" toggle wrote the old state.</li>
</ul></li>
</ul>
<h3 id="not-covered">Not covered</h3>
<ul>%s</ul>""" % items


def discover_tags():
    tags = []
    if not os.path.isdir(EV):
        return tags
    for name in sorted(os.listdir(EV)):
        p = os.path.join(EV, name)
        tag = None
        if os.path.isfile(p) and name.endswith(".server.log"):
            tag = name[:-len(".server.log")]
        elif os.path.isfile(p) and name.endswith(".log"):
            tag = name[:-4]
        elif os.path.isdir(p):
            for role, _ in sorted(ROLES, key=lambda r: -len(r[0])):
                if name.endswith("-" + role):
                    tag = name[:-len(role) - 1]
                    break
        if tag and tag not in tags:
            tags.append(tag)
    order = {}
    for t in tags:
        mt = [os.path.getmtime(os.path.join(EV, t + ".log"))] if os.path.isfile(os.path.join(EV, t + ".log")) else []
        order[t] = parse_log(os.path.join(EV, t + ".log"))["start"] or ("9999" if not mt else "9998")
    return sorted(tags, key=lambda t: (order[t], t))


def build(reduced):
    _SVG_IDS.clear()
    data = [load_tag(t) for t in discover_tags()]
    results = [run_cases(d) for d in data]
    dates = sorted({d["log"]["start"][:10] for d in data if d["log"]["start"]})
    date = ", ".join(dates) if dates else "not recorded"
    tot = {"pass": 0, "fail": 0, "partial": 0, "notrun": 0}
    c_pass = c_fail = c_missing = 0
    rows = []
    for d, res in zip(data, results):
        cells = ['<td><a href="#%s"><b>%s</b><small>%s/%s</small></a></td>' % (aid(d["tag"]), e(d["tag"]), e(d["provider"] or "?"), e(d["model"] or "?"))]
        for cid, _ in CASES:
            r = res[cid]
            tot[r["status"][0] if r else "notrun"] += 1
            if r:
                c_pass += r["status"][1]
                c_missing += r["status"][3]
                c_fail += r["status"][2] - r["status"][1] - r["status"][3]
            cells.append(summary_cell(d["tag"], cid, r))
        rows.append("<tr>%s</tr>" % "".join(cells))
    ores, oextra = other_cases()
    for cid, _ in OTHER_CASES:
        r = ores[cid]
        tot[r["status"][0] if r else "notrun"] += 1
        if r:
            c_pass += r["status"][1]
            c_missing += r["status"][3]
            c_fail += r["status"][2] - r["status"][1] - r["status"][3]
    orow = '<tr><td><a href="#other"><b>Other live cases</b><small>all sources</small></a></td>%s</tr>' % "".join(
        summary_cell("other", cid, ores[cid]) for cid, _ in OTHER_CASES)
    totals = ("Totals: %d model run(s), %d cases (%d model cases and %d other live cases). %d pass, %d fail, %d partial, %d not run. "
              "Checks: %d pass, %d fail, %d not run." % (len(data), len(data) * len(CASES) + len(OTHER_CASES), len(data) * len(CASES),
                                                         len(OTHER_CASES), tot["pass"], tot["fail"], tot["partial"], tot["notrun"], c_pass, c_fail, c_missing))
    parts = ["<title>Model Discovery Live Evidence</title>\n",
             '<meta name="claude:viewport-fit-sides" content="cover">\n',
             "<style>%s</style>\n" % CSS,
             '<div class="page">\n',
             "<h1>model-discovery %s — live test evidence</h1>" % VERSION,
             '<p class="muted">Test date: %s. Page built: %s. Each cell shows "expected = actual". Select a cell to see its checks.</p>'
             % (e(date), datetime.datetime.now().strftime("%Y-%m-%d %H:%M")),
             table(["Model run"] + [c for _, c in CASES], rows, "sum") if rows else '<p class="notrun">No evidence folder has data. All cases: not run.</p>',
             table(["Other live cases"] + [c for _, c in OTHER_CASES], [orow], "sum"),
             '<p class="totals">%s</p>' % e(totals),
             '<p class="muted">"partial" = some checks of the case have no data and no check fails. Go to: <a href="#method">Method</a>, <a href="#not-covered">Not covered</a>.</p>']
    for d, res in zip(data, results):
        parts.append(model_section(d, res, reduced))
    parts.append(other_section(ores, oextra))
    parts.append(method_section())
    parts.append("\n</div>\n")
    return "".join(parts), data, results, ores, totals


def main():
    page, data, results, ores, totals = build(reduced=False)
    reduced = False
    if len(page.encode("utf-8")) > MAX_BYTES:
        page, data, results, ores, totals = build(reduced=True)
        reduced = True
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(page)
    # text report on stdout
    size = len(page.encode("utf-8"))
    sym = {"pass": "✓", "fail": "✗", "partial": "partial", "notrun": "not run"}
    print("%-16s" % "tag" + "".join("%-20s" % c for _, c in CASES))
    for d, res in zip(data, results):
        print("%-16s" % d["tag"] + "".join("%-20s" % (sym[res[c]["status"][0]] if res[c] else "not run") for c, _ in CASES))
    print("\n%-16s" % "other" + "".join("%-30s" % c for _, c in OTHER_CASES))
    print("%-16s" % "" + "".join("%-30s" % (sym[ores[c]["status"][0]] if ores[c] else "not run") for c, _ in OTHER_CASES))
    print("\n" + totals)
    print("\nevidence.html: %d bytes (%.2f MB)%s" % (size, size / 1048576.0, ", reduced picture set" if reduced else ""))
    print("\nFailing checks and checks with no data:")
    n = 0
    groups = [(d["tag"], CASES, res) for d, res in zip(data, results)] + [("other", OTHER_CASES, ores)]
    for tag, cases, res in groups:
        for cid, cname in cases:
            for c in (res[cid] or {}).get("checks", []):
                if c["ok"] is False or c["ok"] is None:
                    n += 1
                    print("- [%s] %s / %s / %s\n    expected: %s\n    actual:   %s" % ("fail" if c["ok"] is False else "not run", tag, cname, c["name"], clean(c["expected"]), clean(c["actual"])))
    if not n:
        print("- none")
    return 0


if __name__ == "__main__":
    sys.exit(main())
