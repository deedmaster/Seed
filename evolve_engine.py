"""
evolve_engine.py
Advisory evolution engine for Seed.

What it DOES:
- Scans the local Seed folder for basic health signals.
- Suggests possible upgrades in plain language.
- Logs evolution-related events to evolve_log.json.
- Provides a "daily brief" style summary Seed can read back to you.

What it does NOT do:
- It does NOT modify any files.
- It does NOT push to GitHub.
- It does NOT auto-update code.

All changes remain under your manual control.
"""

import os
import json
import datetime
from typing import List, Dict, Any


LOG_FILE = "evolve_log.json"
SEED_CORE_FILES = ["seed.py", "evolve_engine.py"]


def _now() -> str:
    return datetime.datetime.utcnow().isoformat() + "Z"


def _ensure_log() -> None:
    if not os.path.exists(LOG_FILE):
        with open(LOG_FILE, "w") as f:
            json.dump({"events": []}, f, indent=2)


def _log(event_type: str, details: Dict[str, Any]) -> None:
    _ensure_log()
    with open(LOG_FILE, "r") as f:
        data = json.load(f)

    data["events"].append(
        {
            "time": _now(),
            "type": event_type,
            "details": details,
        }
    )

    with open(LOG_FILE, "w") as f:
        json.dump(data, f, indent=2)


def scan_files() -> Dict[str, Any]:
    """
    Very lightweight scan of the current directory.
    Looks for core files, size, and timestamps.
    """
    results = {
        "core_files": [],
        "other_files": [],
        "missing_core": [],
    }

    cwd = os.getcwd()
    entries = os.listdir(cwd)

    for name in entries:
        path = os.path.join(cwd, name)
        if not os.path.isfile(path):
            continue

        info = {
            "name": name,
            "size_bytes": os.path.getsize(path),
            "modified": datetime.datetime.utcfromtimestamp(
                os.path.getmtime(path)
            ).isoformat() + "Z",
        }

        if name in SEED_CORE_FILES:
            results["core_files"].append(info)
        else:
            results["other_files"].append(info)

    for core in SEED_CORE_FILES:
        if core not in [f["name"] for f in results["core_files"]]:
            results["missing_core"].append(core)

    _log("scan_files", {"summary": results})
    return results


def suggest_upgrades(scan: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Turn a scan result into human-readable suggestions.
    This is advisory only: no code changes, just ideas.
    """
    suggestions: List[Dict[str, Any]] = []

    # Missing core files
    if scan["missing_core"]:
        suggestions.append(
            {
                "priority": "high",
                "kind": "integrity",
                "message": (
                    "One or more core files are missing: "
                    + ", ".join(scan["missing_core"])
                    + ". Seed may not run correctly until this is fixed."
                ),
            }
        )

    # Large or old files could be flagged for review
    for f in scan["core_files"]:
        if f["size_bytes"] > 200_000:
            suggestions.append(
                {
                    "priority": "medium",
                    "kind": "maintenance",
                    "message": (
                        f"Core file {f['name']} is getting large "
                        f"({f['size_bytes']} bytes). You might later split "
                        "it into smaller modules for clarity."
                    ),
                }
            )

    # Generic “future upgrades” ideas
    suggestions.append(
        {
            "priority": "low",
            "kind": "upgrade_idea",
            "message": (
                "Consider adding a config file (e.g. seed_config.json) "
                "to centralize settings like themes, permissions, and "
                "GitHub metadata instead of hard-coding them."
            ),
        }
    )

    suggestions.append(
        {
            "priority": "low",
            "kind": "upgrade_idea",
            "message": (
                "Consider adding a dedicated logs/ folder and rotating "
                "logs so evolve_log.json does not grow forever."
            ),
        }
    )

    _log("suggest_upgrades", {"count": len(suggestions)})
    return suggestions


def daily_brief() -> Dict[str, Any]:
    """
    Main entry point for a NEKO-style daily brief.

    Seed can call this and then read the result back to you in
    natural language.
    """
    scan = scan_files()
    suggestions = suggest_upgrades(scan)

    brief = {
        "time": _now(),
        "summary": {
            "missing_core_files": scan["missing_core"],
            "core_file_count": len(scan["core_files"]),
            "other_file_count": len(scan["other_files"]),
        },
        "suggestions": suggestions,
        "note": (
            "This is an advisory-only evolution brief. "
            "No changes have been made; everything here is a suggestion "
            "for you to approve or ignore."
        ),
    }

    _log("daily_brief", {"summary": brief["summary"], "suggestions": len(suggestions)})
    return brief


def evolve_request(text: str) -> Dict[str, Any]:
    """
    Generic entry point for Seed's `/evolve` command.

    Right now, it treats the text as intent/context and returns:
    - a daily brief
    - echo of your request
    - a reminder that nothing was changed automatically
    """
    _log("evolve_request", {"text": text})

    brief = daily_brief()

    return {
        "status": "ok",
        "your_request": text,
        "daily_brief": brief,
        "note": (
            "Seed has scanned its environment and suggested possible upgrades. "
            "These are recommendations only; no files were modified. "
            "You can use this as a checklist for manual improvements."
        ),
}
