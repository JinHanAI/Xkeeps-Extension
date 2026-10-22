#!/usr/bin/env python3
"""Verify formal-project initiation evidence for local creation, Git, and CI."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any


BUNDLE_REL = Path(".project-governance/initiation")
MANIFEST_REL = BUNDLE_REL / "manifest.json"
RECEIPT_REL = BUNDLE_REL / "admission-receipt.json"
SCHEMA_REL = BUNDLE_REL / "manifest.schema.json"
VALIDATOR_REL = BUNDLE_REL / "validate_manifest.py"
VERIFY_REL = BUNDLE_REL / "verify_bundle.py"
WORKFLOW_REL = Path(".github/workflows/project-initiation-gate.yml")
FIXED_BUNDLE_FILES = {
    MANIFEST_REL,
    RECEIPT_REL,
    SCHEMA_REL,
    VALIDATOR_REL,
    VERIFY_REL,
    WORKFLOW_REL,
}
ZERO_OIDS = {"0" * 40, "0" * 64}


class GateError(RuntimeError):
    """A user-actionable project-initiation failure."""


def control_root() -> Path:
    return Path(__file__).resolve().parents[1]


def canonical_validator_path() -> Path:
    sibling = Path(__file__).resolve().with_name("validate_manifest.py")
    if sibling.is_file():
        return sibling
    return control_root() / "技能/project-initiation-gate/scripts/validate_manifest.py"


def canonical_registry_path() -> Path:
    return control_root() / "治理方案/正式立项门禁/存量项目登记.json"


def canonical_tool_policy_path() -> Path:
    return control_root() / "治理方案/正式立项门禁/允许的门禁工具哈希.json"


def load_validator() -> Any:
    path = canonical_validator_path()
    if not path.is_file():
        raise GateError(f"立项证据校验器缺失：{path}")
    spec = importlib.util.spec_from_file_location("project_initiation_manifest_validator", path)
    if spec is None or spec.loader is None:
        raise GateError(f"无法加载立项证据校验器：{path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise GateError(f"{label}缺失：{path}") from error
    except json.JSONDecodeError as error:
        raise GateError(f"{label}不是有效 JSON：{path}:{error.lineno}:{error.colno}") from error
    except OSError as error:
        raise GateError(f"无法读取{label}：{path}（{error}）") from error
    if not isinstance(value, dict):
        raise GateError(f"{label}必须是 JSON object：{path}")
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def contained_relative(value: Any, base: Path, label: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise GateError(f"{label}必须是非空相对路径")
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts:
        raise GateError(f"{label}必须留在立项证据目录内")
    resolved = (base / relative).resolve()
    try:
        resolved.relative_to(base.resolve())
    except ValueError as error:
        raise GateError(f"{label}越出立项证据目录") from error
    return relative


def expected_receipt_files(manifest: dict[str, Any]) -> set[Path]:
    artifacts = manifest.get("artifacts")
    report_value = artifacts.get("report_path") if isinstance(artifacts, dict) else None
    report_relative = contained_relative(report_value, Path("/bundle"), "artifacts.report_path")
    expected = FIXED_BUNDLE_FILES | {BUNDLE_REL / report_relative}
    survey = manifest.get("survey") if isinstance(manifest.get("survey"), dict) else {}
    if survey.get("github_search_snapshot_path"):
        search_relative = contained_relative(
            survey.get("github_search_snapshot_path"),
            Path("/bundle"),
            "survey.github_search_snapshot_path",
        )
        expected.add(BUNDLE_REL / search_relative)
    candidates = survey.get("candidates") if isinstance(survey.get("candidates"), list) else []
    for index, candidate in enumerate(candidates):
        if not isinstance(candidate, dict) or not candidate.get("github_snapshot_path"):
            continue
        snapshot_relative = contained_relative(
            candidate.get("github_snapshot_path"),
            Path("/bundle"),
            f"survey.candidates[{index}].github_snapshot_path",
        )
        expected.add(BUNDLE_REL / snapshot_relative)
    return expected


def build_receipt(project_root: Path, admitted_at: str) -> dict[str, Any]:
    project_root = project_root.resolve()
    manifest = read_json(project_root / MANIFEST_REL, "manifest")
    project = manifest.get("project") if isinstance(manifest.get("project"), dict) else {}
    decision = manifest.get("decision") if isinstance(manifest.get("decision"), dict) else {}
    files: dict[str, str] = {}
    for relative in sorted(expected_receipt_files(manifest), key=str):
        if relative == RECEIPT_REL:
            continue
        target = project_root / relative
        if not target.is_file() or target.is_symlink():
            raise GateError(f"立项证据文件缺失或为软链接：{relative}")
        files[str(relative)] = sha256_file(target)
    return {
        "schema_version": 1,
        "admitted_at": admitted_at,
        "project_name": project.get("name"),
        "decision_outcome": decision.get("outcome"),
        "files": files,
    }


def validate_trusted_tool_bundle(project_root: Path, receipt_files: dict[str, Any]) -> None:
    canonical_script = control_root() / "scripts/project-initiation-guard.py"
    if Path(__file__).resolve() != canonical_script.resolve(strict=False):
        return
    policy_path = canonical_tool_policy_path()
    policy = read_json(policy_path, "门禁工具哈希策略")
    bundles = policy.get("bundles")
    if policy.get("schema_version") != 1 or not isinstance(bundles, list) or not bundles:
        raise GateError(f"门禁工具哈希策略无有效 bundles：{policy_path}")
    actual = {
        "validator_sha256": receipt_files.get(str(VALIDATOR_REL)),
        "verifier_sha256": receipt_files.get(str(VERIFY_REL)),
        "schema_sha256": receipt_files.get(str(SCHEMA_REL)),
        "workflow_sha256": receipt_files.get(str(WORKFLOW_REL)),
    }
    accepted = any(
        isinstance(bundle, dict)
        and all(bundle.get(key) == value for key, value in actual.items())
        for bundle in bundles
    )
    if not accepted:
        raise GateError("项目内校验器、schema 或 CI workflow 不属于受信任版本")


def validate_bundle(
    project_root: Path,
    *,
    admission: bool,
    validation_time: datetime | None = None,
    expected_project_name: str | None = None,
) -> None:
    project_root = project_root.expanduser().resolve()
    bundle = project_root / BUNDLE_REL
    manifest_path = project_root / MANIFEST_REL
    manifest = read_json(manifest_path, "manifest")
    receipt = read_json(project_root / RECEIPT_REL, "admission receipt")
    validator = load_validator()
    errors = validator.validate_manifest(
        manifest,
        manifest_path,
        mode="formal",
        now=validation_time,
        allow_expired=not admission,
        expected_project_name=expected_project_name
        or (receipt.get("project_name") if isinstance(receipt, dict) else None),
        require_project_creation=True,
    )
    if errors:
        raise GateError("立项 manifest 校验失败：\n- " + "\n- ".join(errors))

    allowed_receipt_keys = {
        "schema_version",
        "admitted_at",
        "project_name",
        "decision_outcome",
        "files",
    }
    unexpected = set(receipt) - allowed_receipt_keys
    if unexpected:
        raise GateError(f"admission receipt 含未知字段：{sorted(unexpected)}")
    if receipt.get("schema_version") != 1:
        raise GateError("admission receipt 的 schema_version 必须为 1")
    try:
        admitted = datetime.fromisoformat(str(receipt.get("admitted_at", "")).replace("Z", "+00:00"))
    except ValueError as error:
        raise GateError("admission receipt 的 admitted_at 必须是 ISO-8601 时间") from error
    if admitted.tzinfo is None or admitted.utcoffset() is None:
        raise GateError("admission receipt 的 admitted_at 必须带时区")

    gate = manifest.get("gate") if isinstance(manifest.get("gate"), dict) else {}
    review = manifest.get("independent_review") if isinstance(manifest.get("independent_review"), dict) else {}
    try:
        generated = datetime.fromisoformat(str(gate.get("generated_at", "")).replace("Z", "+00:00"))
        valid_until = datetime.fromisoformat(str(gate.get("valid_until", "")).replace("Z", "+00:00"))
        reviewed = datetime.fromisoformat(str(review.get("reviewed_at", "")).replace("Z", "+00:00"))
    except ValueError as error:
        raise GateError("manifest 的 gate/review 时间无法用于 admission receipt 校验") from error
    if admitted < reviewed or admitted < generated:
        raise GateError("admission receipt 不能早于最终复核或 manifest 生成时间")
    if admitted > valid_until:
        raise GateError("admission receipt 必须在 manifest 有效期内生成")
    if validation_time is not None and admitted > validation_time + validator.FUTURE_TOLERANCE:
        raise GateError("admission receipt 不能晚于承载它的 Git 提交")

    project = manifest.get("project") if isinstance(manifest.get("project"), dict) else {}
    decision = manifest.get("decision") if isinstance(manifest.get("decision"), dict) else {}
    if receipt.get("project_name") != project.get("name"):
        raise GateError("admission receipt 与 manifest 的项目名不一致")
    if receipt.get("decision_outcome") != decision.get("outcome"):
        raise GateError("admission receipt 与 manifest 的立项结论不一致")

    receipt_files = receipt.get("files")
    if not isinstance(receipt_files, dict):
        raise GateError("admission receipt.files 必须是 object")
    expected = expected_receipt_files(manifest) - {RECEIPT_REL}
    actual = {Path(key) for key in receipt_files if isinstance(key, str)}
    if actual != expected:
        missing = sorted(str(path) for path in expected - actual)
        extra = sorted(str(path) for path in actual - expected)
        raise GateError(f"admission receipt 文件集合不一致；缺失={missing}，多余={extra}")

    validate_trusted_tool_bundle(project_root, receipt_files)

    for relative in sorted(expected, key=str):
        target = project_root / relative
        if not target.is_file() or target.is_symlink():
            raise GateError(f"立项证据文件缺失或为软链接：{relative}")
        expected_hash = receipt_files.get(str(relative))
        actual_hash = sha256_file(target)
        if expected_hash != actual_hash:
            raise GateError(f"立项证据文件已被改动：{relative}")

    if bundle.is_symlink():
        raise GateError("立项证据目录不得是软链接")


def git(repo: Path, *args: str, input_bytes: bytes | None = None, check: bool = True) -> bytes:
    process = subprocess.run(
        ["git", "-C", str(repo), *args],
        input=input_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if check and process.returncode != 0:
        detail = process.stderr.decode("utf-8", errors="replace").strip()
        raise GateError(f"Git 读取失败：git {' '.join(args)}（{detail}）")
    return process.stdout


def repository_scope(repo: Path) -> tuple[str, str] | None:
    resolved = repo.expanduser().resolve()
    home = Path.home().resolve()
    roots = {
        "development": home / "工作区/开发型项目",
        "opensource": home / "工作区/开源型项目",
    }
    for alias, root in roots.items():
        root = root.resolve(strict=False)
        try:
            relative = resolved.relative_to(root)
        except ValueError:
            continue
        if relative == Path("."):
            raise GateError(f"拒绝把正式项目根目录本身当作仓库：{resolved}")
        return alias, str(relative)
    return None


def current_root_commits(repo: Path, revision: str = "HEAD") -> set[str]:
    process = subprocess.run(
        ["git", "-C", str(repo), "rev-list", "--max-parents=0", revision],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
    )
    if process.returncode != 0:
        return set()
    return {line.strip() for line in process.stdout.splitlines() if line.strip()}


def load_registry(registry_path: Path) -> dict[str, Any]:
    registry = read_json(registry_path, "存量项目登记")
    if registry.get("schema_version") != 1 or not isinstance(registry.get("projects"), list):
        raise GateError(f"存量项目登记结构无效：{registry_path}")
    legacy = registry.get("legacy_directories", [])
    if not isinstance(legacy, list):
        raise GateError(f"存量项目登记 legacy_directories 必须是 array：{registry_path}")
    return registry


def registered_scope(item: Any) -> tuple[str, str] | None:
    """Follow existing compatibility links without admitting a name lookalike."""
    if not isinstance(item, dict):
        return None
    roots = {
        "development": Path.home() / "工作区/开发型项目",
        "opensource": Path.home() / "工作区/开源型项目",
    }
    root = roots.get(item.get("root"))
    value = item.get("path")
    if root is None or not isinstance(value, str) or not value:
        return None
    path = Path(value)
    if path.is_absolute() or ".." in path.parts or path == Path("."):
        raise GateError("存量项目登记不能使用绝对路径、根目录或上级路径")
    scope = repository_scope(root / path)
    # A redirect outside its recorded root cannot transfer admission.
    return scope if scope and scope[0] == item.get("root") else None


def is_legacy_directory(project_root: Path, registry_path: Path) -> bool:
    scope = repository_scope(project_root)
    if scope is None:
        return False
    alias, relative = scope
    top_level = relative.split("/", 1)[0]
    registry = load_registry(registry_path)
    candidates = list(registry["projects"]) + list(registry.get("legacy_directories", []))
    return any(
        (recorded := registered_scope(item)) is not None
        and recorded[0] == alias
        and recorded[1].split("/", 1)[0] == top_level
        for item in candidates
    )


def registered_repository_root(repo: Path) -> Path:
    """Resolve a genuine linked worktree to its registered primary checkout.

    A nested directory or unrelated clone must not inherit admission merely by
    sharing a directory prefix. Git must confirm the exact worktree membership.
    """
    repo = repo.resolve()
    if not (repo / ".git").is_file():
        return repo
    common_raw = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").decode().strip()
    common = Path(common_raw).resolve()
    if common.name != ".git" or not common.is_dir():
        return repo
    members = git(repo, "worktree", "list", "--porcelain", "-z").decode().split("\0")
    paths = {Path(row.removeprefix("worktree ")).resolve()
             for row in members if row.startswith("worktree ")}
    primary = common.parent
    if repo not in paths or primary not in paths:
        return repo
    return primary


def is_grandfathered(repo: Path, registry_path: Path) -> bool:
    scope = repository_scope(registered_repository_root(repo))
    if scope is None:
        return False
    alias, relative = scope
    registry = load_registry(registry_path)
    matches = [
        item
        for item in registry["projects"]
        if registered_scope(item) == (alias, relative)
    ]
    if len(matches) != 1:
        return False
    entry = matches[0]
    if entry.get("state") == "empty":
        raise GateError(
            f"空仓不能作为正式 Git/远端准入；请改登记为 legacy directory 或完成正式立项：{alias}/{relative}"
        )
    registered = entry.get("root_commits")
    if not isinstance(registered, list) or not registered:
        raise GateError(f"存量项目缺 root_commits：{alias}/{relative}")
    current = current_root_commits(repo)
    return bool(current.intersection(str(value) for value in registered))


def directory_check(project_root: Path, registry_path: Path) -> None:
    if repository_scope(project_root) is None:
        return
    git_root_process = subprocess.run(
        ["git", "-C", str(project_root), "rev-parse", "--show-toplevel"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
    )
    if git_root_process.returncode == 0:
        git_root = Path(git_root_process.stdout.strip()).resolve()
        if is_grandfathered(git_root, registry_path):
            return
    elif is_legacy_directory(project_root, registry_path):
        return
    try:
        validate_bundle(project_root, admission=False)
    except GateError as error:
        raise GateError(
            "目录既不在门禁启用前的存量登记中，也没有有效立项证据包："
            f"{project_root}（{error}）"
        ) from error


def remote_check(project_root: Path, registry_path: Path) -> None:
    project_root = project_root.resolve()
    git_root_process = subprocess.run(
        ["git", "-C", str(project_root), "rev-parse", "--show-toplevel"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
    )
    if git_root_process.returncode == 0:
        git_root = Path(git_root_process.stdout.strip()).resolve()
        if is_grandfathered(git_root, registry_path):
            return
        project_root = git_root
    validate_bundle(project_root, admission=False)


def git_blob(repo: Path, source: str, relative: Path) -> bytes:
    relative_text = relative.as_posix()
    if source == "index":
        listing = git(repo, "ls-files", "-s", "--", relative_text).decode("utf-8", errors="replace")
        rows = [line for line in listing.splitlines() if line]
        if len(rows) != 1 or not rows[0].startswith("100"):
            raise GateError(f"Git 暂存区缺少普通文件：{relative_text}")
        return git(repo, "show", f":{relative_text}")
    listing = git(repo, "ls-tree", source, "--", relative_text).decode("utf-8", errors="replace")
    if not listing or not listing.startswith("100"):
        raise GateError(f"提交 {source[:12]} 缺少普通文件：{relative_text}")
    return git(repo, "show", f"{source}:{relative_text}")


def materialize_git_bundle(repo: Path, source: str, destination: Path) -> None:
    manifest_bytes = git_blob(repo, source, MANIFEST_REL)
    try:
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GateError("Git 中的立项 manifest 不是有效 UTF-8 JSON") from error
    if not isinstance(manifest, dict):
        raise GateError("Git 中的立项 manifest 必须是 JSON object")
    required = expected_receipt_files(manifest)
    for relative in sorted(required, key=str):
        data = git_blob(repo, source, relative)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def commit_time(repo: Path, revision: str) -> datetime:
    raw = git(repo, "show", "-s", "--format=%cI", revision).decode().strip()
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as error:
        raise GateError(f"无法解析提交时间：{revision[:12]}") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise GateError(f"提交时间缺少时区：{revision[:12]}")
    return parsed


def validate_git_source(
    repo: Path,
    source: str,
    *,
    admission: bool,
    validation_time: datetime | None = None,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="project-initiation-git-") as temp:
        root = Path(temp)
        materialize_git_bundle(repo, source, root)
        validate_bundle(root, admission=admission, validation_time=validation_time)
        return read_json(root / MANIFEST_REL, "Git manifest")


def revision_has_manifest(repo: Path, revision: str) -> bool:
    return subprocess.run(
        ["git", "-C", str(repo), "cat-file", "-e", f"{revision}:{MANIFEST_REL.as_posix()}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode == 0


def validate_history_anchor(repo: Path, tip: str, manifest: dict[str, Any]) -> None:
    decision = manifest.get("decision") if isinstance(manifest.get("decision"), dict) else {}
    raw_sources = decision.get("upstream_sources", [])
    bases = [
        str(value.get("base_commit"))
        for value in raw_sources
        if isinstance(value, dict) and value.get("base_commit")
    ] if isinstance(raw_sources, list) else []
    if bases:
        for base in bases:
            exists = subprocess.run(
                ["git", "-C", str(repo), "cat-file", "-e", f"{base}^{{commit}}"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            ).returncode == 0
            ancestor = subprocess.run(
                ["git", "-C", str(repo), "merge-base", "--is-ancestor", base, tip],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            ).returncode == 0
            if not exists or not ancestor:
                raise GateError(f"声明的 upstream base 不存在或不是当前历史祖先：{base}")
        arguments = ["rev-list", "--reverse", "--topo-order", tip, *[f"^{base}" for base in bases]]
        new_commits = [line for line in git(repo, *arguments).decode().splitlines() if line]
        if not new_commits:
            raise GateError("fork/integrate 历史中没有承载立项证据的本地 admission commit")
        anchors = [new_commits[0]]
    else:
        anchors = sorted(current_root_commits(repo, tip))
        if not anchors:
            raise GateError(f"无法确定 Git 历史根：{tip[:12]}")

    for anchor in anchors:
        validate_git_source(
            repo,
            anchor,
            admission=True,
            validation_time=commit_time(repo, anchor),
        )


def prepush_sources(stdin_file: Path | None, repo: Path) -> list[str]:
    if stdin_file is None:
        return [git(repo, "rev-parse", "HEAD").decode().strip()]
    try:
        lines = stdin_file.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise GateError(f"无法读取 pre-push 输入：{stdin_file}（{error}）") from error
    sources: list[str] = []
    for index, line in enumerate(lines, start=1):
        fields = line.split()
        if len(fields) != 4:
            raise GateError(f"pre-push 第 {index} 行应有 4 个字段")
        local_oid = fields[1]
        if local_oid not in ZERO_OIDS:
            sources.append(local_oid)
    return list(dict.fromkeys(sources))


def git_check(repo: Path, phase: str, stdin_file: Path | None, registry: Path) -> None:
    for ancestor in (repo.resolve(), *repo.resolve().parents):
        marker = ancestor / ".project-governance/incubation-waiver.json"
        if marker.is_file():
            raise GateError(
                f"本地孵化区禁止 commit/push；先完成正式立项并迁入受控项目：{ancestor}"
            )
        if ancestor == Path.home().resolve():
            break
    scope = repository_scope(repo)
    if scope is None:
        return
    if is_grandfathered(repo, registry):
        return
    if phase == "pre-commit":
        has_head = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "--verify", "HEAD"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        ).returncode == 0
        head_has_manifest = has_head and revision_has_manifest(repo, "HEAD")
        validate_git_source(repo, "index", admission=not head_has_manifest)
        return
    for source in prepush_sources(stdin_file, repo):
        manifest = validate_git_source(repo, source, admission=False)
        validate_history_anchor(repo, source, manifest)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    verify = subparsers.add_parser("verify-bundle")
    verify.add_argument("--project-root", type=Path, default=Path.cwd())
    verify.add_argument("--admission", action="store_true")

    history = subparsers.add_parser("verify-history")
    history.add_argument("--project-root", type=Path, default=Path.cwd())
    history.add_argument("--revision", default="HEAD")

    git_parser = subparsers.add_parser("git-check")
    git_parser.add_argument("--phase", choices=("pre-commit", "pre-push"), required=True)
    git_parser.add_argument("--repo", type=Path, required=True)
    git_parser.add_argument("--stdin-file", type=Path)
    git_parser.add_argument("--registry", type=Path, default=canonical_registry_path())

    registry_parser = subparsers.add_parser("registry-check")
    registry_parser.add_argument("--repo", type=Path, required=True)
    registry_parser.add_argument("--registry", type=Path, default=canonical_registry_path())

    directory_parser = subparsers.add_parser("directory-check")
    directory_parser.add_argument("--project-root", type=Path, required=True)
    directory_parser.add_argument("--registry", type=Path, default=canonical_registry_path())

    remote_parser = subparsers.add_parser("remote-check")
    remote_parser.add_argument("--project-root", type=Path, required=True)
    remote_parser.add_argument("--registry", type=Path, default=canonical_registry_path())

    args = parser.parse_args(argv)
    try:
        if args.command == "verify-bundle":
            validate_bundle(args.project_root, admission=args.admission)
        elif args.command == "verify-history":
            project_root = args.project_root.resolve()
            manifest = validate_git_source(project_root, args.revision, admission=False)
            validate_history_anchor(project_root, args.revision, manifest)
        elif args.command == "git-check":
            git_check(args.repo.resolve(), args.phase, args.stdin_file, args.registry.resolve())
        elif args.command == "registry-check":
            if not is_grandfathered(args.repo.resolve(), args.registry.resolve()):
                raise GateError("该仓库不在正式立项门禁启用前的存量登记中")
        elif args.command == "directory-check":
            directory_check(args.project_root.resolve(), args.registry.resolve())
        else:
            remote_check(args.project_root.resolve(), args.registry.resolve())
    except GateError as error:
        print(f"⛔ 正式立项门禁：{error}", file=sys.stderr)
        return 2
    print("PASS: project initiation gate")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
