#!/usr/bin/env python3
"""
sync_openrouter_models.py
Auto-sync OpenRouter model catalog -> Pi configuration.

Features:
  - Diff: detect new, removed, changed models
  - Dry-run mode: preview changes without writing
  - Auto-backup before any modification
  - Detailed logging with rotation
  - Config-driven (config.json)
  - Cron-friendly (plain text summary + exit codes)
  - Mark discontinued instead of remove (optional)
  - Multi-provider support

Usage:
  python3 sync_openrouter_models.py                # Run sync
  python3 sync_openrouter_models.py --dry-run      # Preview only
  python3 sync_openrouter_models.py --diff-only    # Show diff, no write
  python3 sync_openrouter_models.py --status       # Show current sync status
  python3 sync_openrouter_models.py --config ./myconfig.json  # Custom config
"""

import json
import os
import sys
import shutil
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional, Tuple

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
HOME = Path.home()

def resolve_path(p: str) -> Path:
    """Resolve path relative to home dir if not absolute."""
    path = Path(p)
    if not path.is_absolute():
        path = HOME / path
    return path


def log(msg: str, level: str = "INFO", log_file: Optional[Path] = None):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    line = f"[{ts}] [{level}] {msg}"
    print(line)
    if log_file:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(line + "\n")


def load_json(path: Path) -> Any:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, data: Any):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def backup_file(path: Path, backup_dir: Path, max_backups: int = 10) -> Path:
    if not path.exists():
        return path
    backup_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    stem = path.stem
    suffix = path.suffix
    backup_name = f"{stem}_{timestamp}{suffix}"
    backup_path = backup_dir / backup_name
    shutil.copy2(path, backup_path)
    log(f"Backup dibuat: {backup_path}", "INFO")
    # Prune old backups
    backups = sorted(backup_dir.glob(f"{stem}_*{suffix}"))
    while len(backups) > max_backups:
        old = backups.pop(0)
        old.unlink()
        log(f"Backup lama dihapus: {old}", "INFO")
    return backup_path


# ---------------------------------------------------------------------------
# Core: Fetch live models
# ---------------------------------------------------------------------------

def fetch_live_models(url: str, timeout: int, user_agent: str) -> List[Dict]:
    req = urllib.request.Request(url, headers={"User-Agent": user_agent})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("data", [])


def fetch_live_free_models(url: str, timeout: int, user_agent: str) -> List[Dict]:
    all_models = fetch_live_models(url, timeout, user_agent)
    free = []
    for m in all_models:
        p = m.get("pricing", {}) or {}
        try:
            if float(p.get("prompt", "1")) == 0 and float(p.get("completion", "1")) == 0:
                free.append(m)
        except (ValueError, TypeError):
            continue
    return sorted(free, key=lambda x: x.get("id", "").lower())


# ---------------------------------------------------------------------------
# Diff engine
# ---------------------------------------------------------------------------

class ModelDiff:
    def __init__(self, config: Dict):
        self.config = config
        self.diff_fields = config.get("diff_fields", [
            "name", "reasoning", "input", "contextWindow", "maxTokens", "cost"
        ])

    def _normalize_live(self, m: Dict) -> Dict:
        """Convert live OpenRouter model to local field names for comparison."""
        arch = m.get("architecture", {}) or {}
        pricing = m.get("pricing", {}) or {}
        top = m.get("top_provider", {}) or {}
        return {
            "id": m.get("id", ""),
            "name": m.get("name", ""),
            "reasoning": m.get("reasoning", {}).get("default_enabled", False) if isinstance(m.get("reasoning"), dict) else False,
            "input": arch.get("input_modalities", ["text"]),
            "contextWindow": m.get("context_length", 0),
            "maxTokens": top.get("max_completion_tokens", 32768) or 32768,
            "cost": {
                "input": float(pricing.get("prompt", 0) or 0),
                "output": float(pricing.get("completion", 0) or 0),
                "cacheRead": 0,
                "cacheWrite": 0,
            },
        }

    def diff_models(
        self,
        local_nous: List[Dict],
        local_store: List[Dict],
        live_free: List[Dict],
        live_all: List[Dict],
    ) -> Dict[str, List[Dict]]:
        """Return categorized diff checking both config sources."""
        local_map = {}
        for m in local_nous:
            local_map[m["id"]] = {"data": m, "source": "models.json"}
        for m in local_store:
            local_map[m["id"]] = {"data": m, "source": "models-store.json"}

        live_free_map = {m["id"]: self._normalize_live(m) for m in live_free}
        live_all_map = {m["id"]: self._normalize_live(m) for m in live_all}

        result = {
            "new_free": [],
            "removed_from_free": [],
            "removed_from_or": [],
            "changed": [],
            "unchanged": [],
        }

        for mid, info in local_map.items():
            local_m = info["data"]
            if mid in live_free_map:
                changes = []
                for field in self.diff_fields:
                    lval = local_m.get(field)
                    rval = live_free_map[mid].get(field)
                    if lval != rval:
                        changes.append({"field": field, "old": lval, "new": rval})
                if changes:
                    result["changed"].append({
                        "id": mid,
                        "changes": changes,
                        "local": local_m,
                        "live": live_free_map[mid],
                        "source": info["source"],
                    })
                else:
                    result["unchanged"].append(mid)
            else:
                if mid in live_all_map:
                    result["removed_from_free"].append(mid)
                else:
                    result["removed_from_or"].append(mid)

        for mid, live_m in live_free_map.items():
            if mid not in local_map:
                result["new_free"].append(live_m)

        return result


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------

class SyncAction:
    def __init__(self, config: Dict, paths: Dict[str, Path]):
        self.config = config
        self.paths = paths
        self.sync_cfg = config.get("sync", {})
        self.backup_cfg = config.get("backup", {})
        self.mark_discontinued = self.sync_cfg.get("mark_discontinued_instead_of_remove", True)
        self.preserve_models = set(self.sync_cfg.get("preserve_models", []))
        self.block_models = set(self.sync_cfg.get("block_models", []))
        self.auto_provider = self.sync_cfg.get("auto_register_provider", "nous")
        self.dry_run = self.sync_cfg.get("dry_run", False)

    def apply_new_models(
        self,
        diff: Dict[str, List],
        local_models: List[Dict],
        models_store_models: List[Dict],
    ) -> Tuple[List[Dict], List[Dict]]:
        """Add new models from OpenRouter to local config."""
        new_models = diff.get("new", [])
        provider_filter = self.sync_cfg.get("providers", ["openrouter"])

        added_to_nous = []
        added_to_store = []

        for live_m in new_models:
            mid = live_m["id"]
            if mid in self.block_models:
                log(f"SKIP (blocked): {mid}", "WARN")
                continue

            # Convert live model to models.json format
            mj_entry = self._live_to_models_json(live_m)
            ms_entry = self._live_to_models_store(live_m)

            # Check if already exists
            if mj_entry["id"] in [m["id"] for m in local_models]:
                continue
            if ms_entry["id"] in [m["id"] for m in models_store_models]:
                continue

            # Add to models.json (nous provider)
            if self.auto_provider and not self.dry_run:
                local_models.append(mj_entry)
                added_to_nous.append(mid)
                log(f"ADDED to models.json: {mid}", "INFO")

            # Add to models-store.json (openrouter provider)
            if "openrouter" in provider_filter and not self.dry_run:
                models_store_models.append(ms_entry)
                added_to_store.append(mid)
                log(f"ADDED to models-store.json: {mid}", "INFO")

            if self.dry_run:
                added_to_nous.append(mid)
                added_to_store.append(mid)
                log(f"[DRY RUN] Would ADD: {mid}", "INFO")

        return added_to_nous, added_to_store

    def apply_changed_models(
        self,
        diff: Dict[str, List],
        local_models: List[Dict],
        models_store_models: List[Dict],
    ) -> List[str]:
        """Update changed models in local config."""
        changed = diff.get("changed", [])
        updated = []

        for ch in changed:
            mid = ch["id"]
            live_m = ch["live"]

            # Update in models.json
            for i, m in enumerate(local_models):
                if m["id"] == mid:
                    if not self.dry_run:
                        local_models[i] = self._live_to_models_json(live_m)
                    updated.append(mid)
                    log(f"UPDATED in models.json: {mid}", "INFO")
                    break

            # Update in models-store.json
            for i, m in enumerate(models_store_models):
                if m["id"] == mid:
                    if not self.dry_run:
                        models_store_models[i] = self._live_to_models_store(live_m)
                    log(f"UPDATED in models-store.json: {mid}", "INFO")
                    break

            if self.dry_run:
                log(f"[DRY RUN] Would UPDATE: {mid}", "INFO")
                if mid not in updated:
                    updated.append(mid)

        return updated

    def apply_removed_models(
        self,
        diff: Dict[str, List],
        local_models: List[Dict],
        models_store_models: List[Dict],
    ) -> Tuple[List[str], List[str]]:
        """Handle removed/discontinued models. Returns (removed_404, no_longer_free)."""
        removed_404 = diff.get("removed_from_or", [])
        no_longer_free = diff.get("removed_from_free", [])
        handled = []

        for mid in removed_404:
            if mid in self.preserve_models:
                log(f"PRESERVED (whitelist): {mid}", "INFO")
                continue
            if mid in self.block_models:
                continue

            if self.mark_discontinued and not self.dry_run:
                mj = self.paths["models_json"]
                data = load_json(mj)
                if "openrouter" not in data.get("providers", {}):
                    data["providers"]["openrouter"] = {}
                if "modelOverrides" not in data["providers"]["openrouter"]:
                    data["providers"]["openrouter"]["modelOverrides"] = {}
                data["providers"]["openrouter"]["modelOverrides"][mid] = {
                    "name": f"{mid} [DISCONTINUED/404]"
                }
                save_json(mj, data)
                log(f"MARKED DISCONTINUED (modelOverrides): {mid}", "WARN")

            local_models[:] = [m for m in local_models if m["id"] != mid]
            models_store_models[:] = [m for m in models_store_models if m["id"] != mid]
            handled.append(mid)

            if self.dry_run:
                log(f"[DRY RUN] Would REMOVE/MARK: {mid}", "WARN")

        for mid in no_longer_free:
            if mid in self.preserve_models:
                continue
            log(f"NO LONGER FREE (keep locally): {mid}", "INFO")

        return handled, no_longer_free

    def update_snapshot(self, live_free: List[Dict]):
        """Update free_models_snapshot.json."""
        snap_path = self.paths.get("snapshot_json")
        if not snap_path:
            return
        snap_data = {
            "free": [m["id"] for m in live_free],
            "checked": datetime.now(timezone.utc).isoformat(),
        }
        if not self.dry_run:
            save_json(snap_path, snap_data)
            log(f"Snapshot updated: {snap_path}", "INFO")
        else:
            log(f"[DRY RUN] Would update snapshot: {snap_path}", "INFO")

    def _live_to_models_json(self, m: Dict) -> Dict:
        arch = m.get("architecture", {}) or {}
        pricing = m.get("pricing", {}) or {}
        top = m.get("top_provider", {}) or {}
        return {
            "id": m.get("id", ""),
            "name": m.get("name", m.get("id", "")),
            "reasoning": m.get("reasoning", {}).get("default_enabled", False) if isinstance(m.get("reasoning"), dict) else False,
            "input": arch.get("input_modalities", ["text"]),
            "contextWindow": m.get("context_length", 0),
            "maxTokens": top.get("max_completion_tokens", 32768) or 32768,
            "cost": {
                "input": float(pricing.get("prompt", 0) or 0),
                "output": float(pricing.get("completion", 0) or 0),
                "cacheRead": 0,
                "cacheWrite": 0,
            },
        }

    def _live_to_models_store(self, m: Dict) -> Dict:
        arch = m.get("architecture", {}) or {}
        pricing = m.get("pricing", {}) or {}
        top = m.get("top_provider", {}) or {}
        return {
            "id": m.get("id", ""),
            "name": m.get("name", m.get("id", "")),
            "api": "openai-completions",
            "baseUrl": "https://openrouter.ai/api/v1",
            "provider": "openrouter",
            "reasoning": m.get("reasoning", {}).get("default_enabled", False) if isinstance(m.get("reasoning"), dict) else False,
            "input": arch.get("input_modalities", ["text"]),
            "cost": {
                "input": float(pricing.get("prompt", 0) or 0),
                "output": float(pricing.get("completion", 0) or 0),
                "cacheRead": 0,
                "cacheWrite": 0,
            },
            "contextWindow": m.get("context_length", 0),
            "maxTokens": top.get("max_completion_tokens", 32768) or 32768,
            "compat": {
                "supportsDeveloperRole": False,
                "thinkingFormat": "openrouter",
                "sendSessionAffinityHeaders": True,
            },
        }


# ---------------------------------------------------------------------------
# Display helpers
# ---------------------------------------------------------------------------

def print_summary(diff: Dict, added: List[str], updated: List[str], removed: List[str]):
    print("\n" + "=" * 60)
    print("  SYNC SUMMARY")
    print("=" * 60)
    new_free = diff.get("new_free", [])
    changed = diff.get("changed", [])
    removed_or = diff.get("removed_from_or", [])
    removed_free = diff.get("removed_from_free", [])
    print(f"  NEW FREE:            {len(new_free)}")
    for m in new_free:
        print(f"     + {m['id']}")
    print(f"  CHANGED:             {len(changed)}")
    for ch in changed:
        print(f"     ~ {ch['id']}")
    print(f"  REMOVED (404):       {len(removed_or)}")
    for m in removed_or:
        print(f"     - {m}")
    print(f"  NO LONGER FREE:      {len(removed_free)}")
    for m in removed_free:
        print(f"     ⚠ {m}")
    print(f"  UNCHANGED:           {len(diff.get('unchanged', []))}")
    print("=" * 60)


def print_diff_detail(diff: Dict):
    print("\n--- DIFF DETAILS ---\n")
    new_free = diff.get("new_free", [])
    changed = diff.get("changed", [])
    removed_or = diff.get("removed_from_or", [])
    removed_free = diff.get("removed_from_free", [])
    if new_free:
        print("NEW FREE MODELS:")
        for m in new_free:
            print(f"  + {m['id']}")
    if changed:
        print("CHANGED:")
        for ch in changed:
            print(f"  ~ {ch['id']}")
    if removed_or:
        print("REMOVED (404):")
        for m in removed_or:
            print(f"  - {m}")
    if removed_free:
        print("NO LONGER FREE:")
        for m in removed_free:
            print(f"  ⚠ {m}")
    if new_free:
        print("NEW FREE MODELS:")
        for m in new_free:
            print(f"  + {m['id']}")
    if changed:
        print("CHANGED:")
        for ch in changed:
            print(f"  ~ {ch['id']}")
    if removed_or:
        print("REMOVED (404):")
        for m in removed_or:
            print(f"  - {m}")
    if removed_free:
        print("NO LONGER FREE:")
        for m in removed_free:
            print(f"  ⚠ {m}")


# -----# ---------------------------------------------------------------------------

def main():
    import argparse

    parser = argparse.ArgumentParser(description="Sync OpenRouter models -> Pi config")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without writing")
    parser.add_argument("--diff-only", action="store_true", help="Show diff only, no write")
    parser.add_argument("--status", action="store_true", help="Show current sync status")
    parser.add_argument("--config", type=str, default=None, help="Custom config path")
    args = parser.parse_args()

    # Load config
    config_path = SCRIPT_DIR.parent.parent / ".pi/agent/sync/config.json"
    if args.config:
        config_path = Path(args.config)
    config = load_json(config_path)

    # Resolve paths
    paths_cfg = config.get("paths", {})
    paths = {k: resolve_path(v) for k, v in paths_cfg.items()}

    # Setup logging
    log_file = paths.get("log_dir", SCRIPT_DIR / "logs") / "sync.log"

    if args.dry_run or args.diff_only:
        config["sync"]["dry_run"] = True

    log(f"=== Sync started (dry_run={args.dry_run}) ===", "INFO", log_file)

    # Load local configs
    mj_path = paths["models_json"]
    ms_path = paths["models_store_json"]

    mj = load_json(mj_path) if mj_path.exists() else {"providers": {}}
    ms = load_json(ms_path) if ms_path.exists() else {"openrouter": {"models": []}}

    local_models = mj.get("providers", {}).get("nous", {}).get("models", [])
    store_models = ms.get("openrouter", {}).get("models", [])

    # Fetch live data
    api_url = config.get("openrouter_api_url", "https://openrouter.ai/api/v1/models")
    timeout = config.get("request_timeout", 30)
    ua = config.get("user_agent", "pi-model-sync/1.0")

    log("Fetching live OpenRouter models...", "INFO", log_file)
    try:
        live_all = fetch_live_models(api_url, timeout, ua)
        live_free = fetch_live_free_models(api_url, timeout, ua)
        log(f"Live: {len(live_all)} total, {len(live_free)} free", "INFO", log_file)
    except urllib.error.URLError as e:
        log(f"FAILED to fetch OpenRouter: {e}", "ERROR", log_file)
        sys.exit(1)
    except Exception as e:
        log(f"ERROR: {e}", "ERROR", log_file)
        sys.exit(1)

    # Diff
    differ = ModelDiff(config)
    diff = differ.diff_models(local_models, store_models, live_free, live_all)

    if args.status:
        print("\n📊 SYNC STATUS")
        print(f"Live models: {len(live_all)} total, {len(live_free)} free")
        print(f"Local models.json (nous): {len(local_models)}")
        print(f"Local models-store.json (openrouter): {len(store_models)}")
        print(f"\nDiff summary:")
        print(f"  New Free:            {len(diff['new_free'])}")
        print(f"  Changed:             {len(diff['changed'])}")
        print(f"  Removed (404):       {len(diff['removed_from_or'])}")
        print(f"  No Longer Free:      {len(diff['removed_from_free'])}")
        print(f"  Unchanged:           {len(diff['unchanged'])}")
        if diff["new_free"]:
            print("\nModel baru tersedia (free):")
            for m in diff["new_free"]:
                print(f"  + {m['id']}")
        if diff["changed"]:
            print("\nModel dengan perubahan spec:")
            for c in diff["changed"]:
                print(f"  ~ {c['id']} ({len(c['changes'])} field(s) changed)")
        if diff["removed_from_or"]:
            print("\nModel sudah 404 di OpenRouter:")
            for m in diff["removed_from_or"]:
                print(f"  - {m}")
        if diff["removed_from_free"]:
            print("\nModel tidak free lagi:")
            for m in diff["removed_from_free"]:
                print(f"  ⚠ {m}")
        print()
        return

    if args.diff_only or args.dry_run:
        print_diff_detail(diff)
        print_summary(diff, [], [], [])
        return

    # Backup
    if config.get("backup", {}).get("enabled", True):
        max_bk = config.get("backup", {}).get("max_backups", 10)
        if mj_path.exists():
            backup_file(mj_path, paths.get("backup_dir", SCRIPT_DIR / "backups"), max_bk)
        if ms_path.exists():
            backup_file(ms_path, paths.get("backup_dir", SCRIPT_DIR / "backups"), max_bk)

    # Apply changes
    action = SyncAction(config, paths)

    added_nous, added_store = action.apply_new_models(diff, local_models, store_models)
    updated = action.apply_changed_models(diff, local_models, store_models)
    removed_404, no_longer_free = action.apply_removed_models(diff, local_models, store_models)

    # Write files
    if not args.dry_run and config["sync"].get("mode") == "smart":
        save_json(mj_path, mj)
        log(f"Saved: {mj_path}", "INFO", log_file)
        save_json(ms_path, ms)
        log(f"Saved: {ms_path}", "INFO", log_file)
    elif not args.dry_run:
        save_json(mj_path, mj)
        save_json(ms_path, ms)

    action.update_snapshot(live_free)

    # Summary
    print_summary(diff, [], updated, [])

    log(f"=== Sync completed: +{len(added_nous)} new, ~{len(updated)} changed, {len(removed_404)} removed, {len(no_longer_free)} no-longer-free ===", "INFO", log_file)


if __name__ == "__main__":
    main()
