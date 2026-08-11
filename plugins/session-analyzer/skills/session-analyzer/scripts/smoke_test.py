#!/usr/bin/env python3
"""
Self-check for parse_session.py. Pure stdlib. Not part of normal analysis usage —
run this after editing parse_session.py to confirm it still works.

Every fixture is synthetic and lives in a temp directory: this test never reads
real ~/.claude data, so it is safe to run on any machine and its results do not
depend on which sessions happen to exist locally.

Usage:
  python3 scripts/smoke_test.py
"""

import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import parse_session as ps  # noqa: E402

results = []


def check(name, condition, detail=""):
    results.append((name, bool(condition), detail))
    mark = "PASS" if condition else "FAIL"
    print(f"[{mark}] {name}" + (f" — {detail}" if detail and not condition else ""))


# --- fixture builders -------------------------------------------------------

def rec_user(text, ts="2026-01-01T00:00:00.000Z", **extra):
    return {"type": "user", "timestamp": ts, "message": {"content": text}, **extra}


def rec_assistant(content, ts="2026-01-01T00:01:00.000Z", model="claude-sonnet-5",
                  request_id=None, **extra):
    return {
        "type": "assistant",
        "timestamp": ts,
        "request_id": request_id,
        "message": {
            "model": model,
            "content": content,
            "usage": {"input_tokens": 10, "output_tokens": 5,
                      "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
        },
        **extra,
    }


def write_session(project_dir: Path, sid: str, records):
    project_dir.mkdir(parents=True, exist_ok=True)
    path = project_dir / f"{sid}.jsonl"
    with open(path, "w", encoding="utf-8") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")
    return path


def teammate_records(team, agent_name, brief, cwd="/tmp/x", branch="main"):
    """A teammate transcript: team fields on the envelope, brief as the opening
    <teammate-message>, one assistant turn so it has usage."""
    head = {"teamName": team, "agentName": agent_name, "cwd": cwd,
            "gitBranch": branch, "isSidechain": False}
    return [
        rec_user(brief, **head),
        rec_assistant([{"type": "text", "text": "ok"}], request_id="req-1", **head),
    ]


BRIEF = "<teammate-message from=\"lead\">You are {verb} the renderer.</teammate-message>"


def main():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)

        # ---------------------------------------------------------------
        # 1. scan_team_index: matches by teamName across two different project
        #    slugs, ignores non-matching teams and non-UUID filenames.
        # ---------------------------------------------------------------
        proj = tmp / "projects"
        slug_a = proj / "-Users-x-src-app"
        slug_b = proj / "-Users-x-src-app--worktrees-sub"

        lead_sid = "aaaaaaaa-0000-4000-8000-000000000001"
        team = ps.team_name_for(lead_sid)

        tm1 = "bbbbbbbb-0000-4000-8000-000000000001"
        tm2 = "cccccccc-0000-4000-8000-000000000002"
        other = "dddddddd-0000-4000-8000-000000000003"

        write_session(slug_a, lead_sid, [rec_user("lead session")])
        write_session(slug_a, tm1, teammate_records(team, "impl", BRIEF.format(verb="implementing")))
        write_session(slug_b, tm2, teammate_records(team, "rev", BRIEF.format(verb="reviewing")))
        write_session(slug_a, other, teammate_records("session-ffffffff", "nope", "x"))
        # non-UUID stem must be ignored entirely
        write_session(slug_a, "not-a-uuid", teammate_records(team, "ignored", "x"))

        index, stats = ps.scan_team_index(proj)
        check("scan_team_index: finds both teammates across two slugs",
              sorted(p.stem for p in index.get(team, [])) == sorted([tm1, tm2]),
              str(sorted(p.stem for p in index.get(team, []))))
        check("scan_team_index: unrelated team indexed separately",
              [p.stem for p in index.get("session-ffffffff", [])] == [other])
        check("scan_team_index: non-UUID file ignored",
              all("not-a-uuid" not in p.stem for v in index.values() for p in v))
        check("scan_team_index: counts only UUID files scanned",
              stats["files_scanned"] == 4, str(stats["files_scanned"]))
        check("scan_team_index: no unreadable files", stats["unreadable_files"] == [])
        check("scan_team_index: memoized per projects_dir",
              ps.scan_team_index(proj)[0] is index)

        # ---------------------------------------------------------------
        # 2. infer_role on four literal briefs.
        # ---------------------------------------------------------------
        def role_of(text):
            return ps.infer_role([rec_user(text)])

        check("infer_role: implementing -> implement",
              role_of(BRIEF.format(verb="implementing"))[:2] == ("implement", "brief_heuristic"))
        check("infer_role: reviewing -> review",
              role_of(BRIEF.format(verb="reviewing"))[:2] == ("review", "brief_heuristic"))
        check("infer_role: red-teaming -> red-team",
              role_of(BRIEF.format(verb="red-teaming"))[:2] == ("red-team", "brief_heuristic"))
        check("infer_role: no match -> (None, unmatched)",
              role_of("<teammate-message>Do the thing.</teammate-message>")[:2]
              == (None, "unmatched"))
        check("infer_role: gemination undone (running -> run)",
              role_of(BRIEF.format(verb="running"))[0] == "run",
              str(role_of(BRIEF.format(verb="running"))[0]))
        check("infer_role: returns brief excerpt for spawn_description fallback",
              role_of(BRIEF.format(verb="auditing"))[2].startswith("<teammate-message"))

        # ---------------------------------------------------------------
        # 3. extract_agent_spawns: input.name is the teammate discriminator,
        #    and a failed spawn is captured.
        # ---------------------------------------------------------------
        spawn_lines = [
            rec_assistant([
                {"type": "tool_use", "id": "t1", "name": "Agent",
                 "input": {"name": "impl", "description": "build it",
                           "subagent_type": "general-purpose"}},
                {"type": "tool_use", "id": "t2", "name": "Agent",
                 "input": {"description": "in-process only",
                           "subagent_type": "Explore"}},
                {"type": "tool_use", "id": "t3", "name": "Agent",
                 "input": {"name": "final-review", "description": "review"}},
                {"type": "tool_use", "id": "t4", "name": "Read",
                 "input": {"file_path": "/x"}},
            ], request_id="req-s"),
            {"type": "user", "timestamp": "2026-01-01T00:02:00.000Z", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": "started"},
                {"type": "tool_result", "tool_use_id": "t3", "is_error": True,
                 "content": "Could not determine pane count for current window"},
            ]}},
        ]
        sp = ps.extract_agent_spawns(spawn_lines)
        check("extract_agent_spawns: counts Agent calls only", sp["agent_tool_calls"] == 3,
              str(sp["agent_tool_calls"]))
        check("extract_agent_spawns: in-process spawn has no input.name",
              sp["in_process_subagent_spawns"] == 1)
        check("extract_agent_spawns: teammate spawns keyed by name",
              sorted(sp["teammate_spawns"]) == ["final-review", "impl"])
        check("extract_agent_spawns: captures the failed spawn",
              len(sp["failed_spawns"]) == 1
              and sp["failed_spawns"][0]["name"] == "final-review"
              and "pane count" in sp["failed_spawns"][0]["error"])

        # ---------------------------------------------------------------
        # 4. collect_team: adopts both teammates, tags roles, records slugs.
        # ---------------------------------------------------------------
        visited = {str((slug_a / f"{lead_sid}.jsonl").resolve()), lead_sid}
        state = ps.new_team_state()
        team_data = ps.collect_team(lead_sid, index, visited,
                                    spawns=sp["teammate_spawns"], state=state)
        adopted = [t for t in team_data if t["kind"] == "teammate"]
        check("collect_team: adopts both teammates", len(adopted) == 2, str(len(adopted)))
        check("collect_team: agent_type keyed by role, not agentName",
              sorted(t["agent_type"] for t in adopted)
              == ["teammate:implement", "teammate:review"])
        check("collect_team: records both project slugs",
              len(state["project_slugs"]) == 2)
        check("collect_team: matched_spawn set for the spawned teammate",
              any(t["agent_name"] == "impl" and t["matched_spawn"] for t in adopted))
        check("collect_team: unspawned teammate is adopted anyway (orphan)",
              any(t["agent_name"] == "rev" and not t["matched_spawn"] for t in adopted))

        # ---------------------------------------------------------------
        # 5. Self-adoption guard: the target's own file carrying the target's
        #    own teamName must adopt nothing.
        # ---------------------------------------------------------------
        proj_self = tmp / "projects_self"
        slug_s = proj_self / "-slug"
        write_session(slug_s, lead_sid,
                      teammate_records(team, "itself", BRIEF.format(verb="reviewing")))
        idx_s, _ = ps.scan_team_index(proj_self)
        v_s = {str((slug_s / f"{lead_sid}.jsonl").resolve()), lead_sid}
        out_s = ps.collect_team(lead_sid, idx_s, v_s, state=ps.new_team_state())
        check("collect_team: self-adoption guard adopts nothing", out_s == [], str(len(out_s)))

        # ---------------------------------------------------------------
        # 6. Cycle + depth cap: A's team contains B, B's team contains A.
        # ---------------------------------------------------------------
        proj_cyc = tmp / "projects_cycle"
        slug_c = proj_cyc / "-cyc"
        a_sid = "eeeeeeee-0000-4000-8000-00000000000a"
        b_sid = "ffffffff-0000-4000-8000-00000000000b"
        # B carries A's teamName, A carries B's teamName -> mutual adoption.
        write_session(slug_c, a_sid, teammate_records(ps.team_name_for(b_sid), "a",
                                                      BRIEF.format(verb="implementing")))
        write_session(slug_c, b_sid, teammate_records(ps.team_name_for(a_sid), "b",
                                                      BRIEF.format(verb="reviewing")))
        idx_c, _ = ps.scan_team_index(proj_cyc)
        v_c = {str((slug_c / f"{a_sid}.jsonl").resolve()), a_sid}
        out_c = ps.collect_team(a_sid, idx_c, v_c, state=ps.new_team_state())
        check("collect_team: cycle terminates and adopts each file once",
              len(out_c) == 1 and out_c[0]["session_id"] == b_sid,
              str([t["session_id"] for t in out_c]))

        st_cap = ps.new_team_state()
        v_cap = {str((slug_c / f"{a_sid}.jsonl").resolve()), a_sid}
        out_cap = ps.collect_team(a_sid, idx_c, v_cap, max_depth=0, state=st_cap)
        check("collect_team: max_depth=0 adopts nothing", out_cap == [])
        check("collect_team: depth cap is reported, not silent",
              st_cap["depth_capped"] == [a_sid], str(st_cap["depth_capped"]))

        # ---------------------------------------------------------------
        # 7. Disjointness assertion trips instead of double counting.
        # ---------------------------------------------------------------
        dup = [{"session_id": "shared-id"}]
        try:
            ps.assert_disjoint(dup, [], [{"session_id": "shared-id"}])
            tripped = False
        except AssertionError:
            tripped = True
        check("assert_disjoint: raises when a session is counted twice", tripped)
        check("assert_disjoint: passes on disjoint sets",
              ps.assert_disjoint([{"session_id": "a"}], [], [{"session_id": "b"}]) is None)

        # ---------------------------------------------------------------
        # 8. build_result regression guard: called the Desktop way (six
        #    positional args, no teammate_data/coverage) it must emit exactly
        #    today's keys — no teammate_sessions, no coverage, no new totals.
        # ---------------------------------------------------------------
        main_data = ps.analyze_session(slug_a / f"{lead_sid}.jsonl")
        base = ps.build_result("sid", "/dir", main_data, [], [], "2026-01-01-0000")
        check("build_result: no teammate_sessions key without coverage",
              "teammate_sessions" not in base)
        check("build_result: no new totals keys without coverage",
              not ({"coverage", "cost_scope", "core_cost_usd", "span_wall_seconds",
                    "agent_seconds", "concurrency_ratio", "wall_seconds_covers_team"}
                   & set(base["totals"])),
              str(sorted(set(base["totals"]))))
        check("build_result: top-level shape unchanged",
              sorted(base) == ["main_session", "report_timestamp", "session_dir",
                               "session_id", "subagent_sessions", "totals",
                               "workflow_sessions"],
              str(sorted(base)))

        withcov = ps.build_result("sid", "/dir", ps.analyze_session(slug_a / f"{lead_sid}.jsonl"),
                                  [], [], "2026-01-01-0000",
                                  teammate_data=adopted,
                                  coverage=ps.build_coverage(True, team, sp, adopted,
                                                             state, stats))
        tw = withcov["totals"]
        check("build_result: teammates fold into by_agent",
              "teammate:implement" in tw["by_agent"])
        check("build_result: by_agent sums to totals",
              all(sum(v[k] for v in tw["by_agent"].values()) == tw[k]
                  for k in ("input_tokens", "output_tokens",
                            "cache_creation_input_tokens", "cache_read_input_tokens")))
        check("build_result: core_cost_usd excludes teammates",
              tw["core_cost_usd"] == main_data["estimated_cost_usd"])
        check("build_result: cost_scope names the scope",
              tw["cost_scope"] == "main+subagents+teammates")

        # ---------------------------------------------------------------
        # 9. Coverage flag semantics: complete vs reconciled answer different
        #    questions — an orphan clears reconciled but never complete.
        # ---------------------------------------------------------------
        cov = tw["coverage"]
        check("coverage: complete is true with no missing volume", cov["complete"] is True,
              str(cov["incomplete_reasons"]))
        check("coverage: an orphan clears reconciled, not complete",
              cov["reconciled"] is False and cov["teammates"]["orphan_adopted"] == 1)
        check("coverage: failed spawn does not clear complete",
              cov["spawns"]["failed"] == 1 and cov["complete"] is True)
        check("coverage: incomplete_reasons explains the orphan",
              any("no matching Agent call" in r for r in cov["incomplete_reasons"]))

        disabled = ps.build_coverage(False, team, None, [], None, None)
        check("coverage: --no-teammates is incomplete and distinguishable",
              disabled["enabled"] is False and disabled["complete"] is False
              and disabled["discovery"]["broad_scan"] is False)
        check("coverage: scan that ran and found nothing differs from disabled",
              ps.build_coverage(True, team, None, [], None, stats)["discovery"]["broad_scan"]
              is True)

        # ---------------------------------------------------------------
        # 10. main(): team_membership is populated when the analyzed target is
        #     itself a teammate, and null otherwise. Exercised through main()
        #     with CLAUDE_PROJECTS_DIR pointed at the temp tree.
        # ---------------------------------------------------------------
        def run_main(target):
            saved_argv, saved_dir = sys.argv, ps.CLAUDE_PROJECTS_DIR
            ps.CLAUDE_PROJECTS_DIR = proj
            sys.argv = ["parse_session.py", str(target)]
            try:
                buf = io.StringIO()
                with redirect_stdout(buf):
                    ps.main()
                return json.loads(buf.getvalue())
            finally:
                sys.argv, ps.CLAUDE_PROJECTS_DIR = saved_argv, saved_dir

        as_lead = run_main(slug_a / f"{lead_sid}.jsonl")
        check("main: leader has null team_membership",
              as_lead["main_session"]["team_membership"] is None)
        check("main: leader adopts its teammates",
              len([t for t in as_lead["teammate_sessions"]
                   if t["kind"] == "teammate"]) == 2)
        # Hermeticity: the scan saw exactly the 4 UUID files in the temp tree. If
        # this ever counts more, the test has started reading real ~/.claude data.
        check("main: broad scan stayed inside the temp tree",
              as_lead["totals"]["coverage"]["discovery"]["files_scanned"] == 4,
              str(as_lead["totals"]["coverage"]["discovery"]["files_scanned"]))

        as_teammate = run_main(slug_a / f"{tm1}.jsonl")
        check("main: teammate target reports its own membership",
              as_teammate["main_session"]["team_membership"]
              == {"team_name": team, "agent_name": "impl"})
        check("main: teammate target adopts nothing (leads no team)",
              as_teammate["teammate_sessions"] == [])

    failed = [r for r in results if not r[1]]
    print()
    print(f"{len(results) - len(failed)}/{len(results)} checks passed.")
    if failed:
        for name, _, detail in failed:
            print(f"  FAILED: {name}" + (f" — {detail}" if detail else ""))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
