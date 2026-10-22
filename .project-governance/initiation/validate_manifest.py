#!/usr/bin/env python3
"""Validate project-initiation evidence using only Python's standard library."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote_plus, urlparse


FORMAL_MAX_VALIDITY = timedelta(days=30)
INCUBATION_MAX_VALIDITY = timedelta(days=7)
FRESH_EVIDENCE_WINDOW = timedelta(days=30)
FUTURE_TOLERANCE = timedelta(minutes=10)

PROJECT_SCOPES = {"new_project", "new_product", "new_repository", "major_direction"}
QUERY_PROVIDERS = {
    "github",
    "web",
    "official_docs",
    "package_registry",
    "community",
    "app_store",
    "other",
}
DECISIONS = {"adopt", "integrate", "fork", "build", "no_build"}
REQUIRES_DIFFERENTIATION = {"integrate", "fork", "build"}
PROJECT_CREATION_DECISIONS = {"integrate", "fork", "build"}
CATEGORIES = {"direct", "adjacent", "component", "workflow_alternative"}
MAINTENANCE_STATES = {"active", "slow", "inactive", "archived", "unknown"}
ADOPTION_STATES = {"high", "medium", "low", "unknown"}
SECURITY_STATES = {"acceptable", "needs_review", "unacceptable", "unknown"}
FIT_STATES = {"adopt", "integrate", "fork", "reference", "reject"}
GAP_BASES = {"source", "user_feedback", "code_inspection", "inference"}
CONFIDENCE_STATES = {"high", "medium", "low"}
REQUIRED_REVIEW_CHECKS = {
    "coverage",
    "maintenance",
    "adoption",
    "license_security",
    "confirmation_bias",
    "evidence_integrity",
}
ALLOWED_INCUBATION_ACTIONS = {
    "local_notes",
    "local_mockup",
    "read_only_research",
    "throwaway_local_prototype",
}
REQUIRED_PROHIBITED_ACTIONS = {
    "formal_project_directory",
    "git_init",
    "git_remote",
    "push",
    "pull_request",
    "deployment",
    "payment_activity",
    "production_data",
}
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
SHA256_RE = re.compile(r"^[a-fA-F0-9]{64}$")
GIT_OID_RE = re.compile(r"^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$")


def _error(errors: list[str], path: str, message: str) -> None:
    errors.append(f"{path}: {message}")


def _allowed_keys(value: dict[str, Any], allowed: set[str], path: str, errors: list[str]) -> None:
    unexpected = sorted(set(value) - allowed)
    if unexpected:
        _error(errors, path, f"contains unknown fields: {unexpected}")


def _as_object(value: Any, path: str, errors: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        _error(errors, path, "must be an object")
        return {}
    return value


def _as_list(value: Any, path: str, errors: list[str], *, nonempty: bool = False) -> list[Any]:
    if not isinstance(value, list):
        _error(errors, path, "must be an array")
        return []
    if nonempty and not value:
        _error(errors, path, "must not be empty")
    return value


def _string(value: Any, path: str, errors: list[str]) -> str:
    if not isinstance(value, str) or not value.strip():
        _error(errors, path, "must be a non-empty string")
        return ""
    if "REPLACE_" in value:
        _error(errors, path, "still contains a template placeholder")
    return value.strip()


def _string_list(value: Any, path: str, errors: list[str], *, nonempty: bool = False) -> list[str]:
    items = _as_list(value, path, errors, nonempty=nonempty)
    result: list[str] = []
    for index, item in enumerate(items):
        result.append(_string(item, f"{path}[{index}]", errors))
    return result


def _enum(value: Any, allowed: set[str], path: str, errors: list[str]) -> str:
    text = _string(value, path, errors)
    if text and text not in allowed:
        _error(errors, path, f"must be one of {sorted(allowed)}")
    return text


def _timestamp(value: Any, path: str, errors: list[str]) -> datetime | None:
    text = _string(value, path, errors)
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        _error(errors, path, "must be a valid ISO-8601 timestamp")
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        _error(errors, path, "must include a timezone")
        return None
    return parsed.astimezone(timezone.utc)


def _url(value: Any, path: str, errors: list[str], *, github: bool = False) -> str:
    text = _string(value, path, errors)
    if not text:
        return ""
    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        _error(errors, path, "must be an absolute HTTP(S) URL")
        return text
    if parsed.hostname and parsed.hostname.lower() == "example.com":
        _error(errors, path, "must not use the template example.com source")
    if github and (parsed.hostname or "").lower() not in {"github.com", "www.github.com"}:
        _error(errors, path, "GitHub evidence must use github.com")
    return text


def _is_github_repository(url: str) -> bool:
    parsed = urlparse(url)
    if (parsed.hostname or "").lower() not in {"github.com", "www.github.com"}:
        return False
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) < 2:
        return False
    return parts[0].lower() not in {
        "search",
        "topics",
        "collections",
        "marketplace",
        "orgs",
        "users",
        "settings",
    }


def _check_fresh_time(
    observed: datetime | None,
    generated: datetime | None,
    path: str,
    errors: list[str],
) -> None:
    if observed is None or generated is None:
        return
    if observed > generated + FUTURE_TOLERANCE:
        _error(errors, path, "cannot be later than generated_at beyond clock tolerance")
    if observed < generated - FRESH_EVIDENCE_WINDOW:
        _error(errors, path, "was observed more than 30 days before generated_at")


def _check_not_after(
    earlier: datetime | None,
    later: datetime | None,
    path: str,
    later_label: str,
    errors: list[str],
) -> None:
    if earlier is not None and later is not None and earlier > later + FUTURE_TOLERANCE:
        _error(errors, path, f"cannot be later than {later_label}")


def _validate_project(value: Any, errors: list[str]) -> tuple[dict[str, Any], str]:
    project = _as_object(value, "project", errors)
    _allowed_keys(
        project,
        {"name", "slug", "problem", "target_users", "why_now", "scope", "implementation_owner"},
        "project",
        errors,
    )
    _string(project.get("name"), "project.name", errors)
    slug = _string(project.get("slug"), "project.slug", errors)
    if slug and not SLUG_RE.fullmatch(slug):
        _error(errors, "project.slug", "must use lowercase letters, digits, and hyphens")
    _string(project.get("problem"), "project.problem", errors)
    _string_list(project.get("target_users"), "project.target_users", errors, nonempty=True)
    _string(project.get("why_now"), "project.why_now", errors)
    _enum(project.get("scope"), PROJECT_SCOPES, "project.scope", errors)
    owner = _string(project.get("implementation_owner"), "project.implementation_owner", errors)
    return project, owner


def _validate_evidence(
    value: Any,
    path: str,
    generated: datetime | None,
    errors: list[str],
) -> datetime | None:
    evidence = _as_object(value, path, errors)
    _allowed_keys(evidence, {"url", "observed_at", "claim"}, path, errors)
    _url(evidence.get("url"), f"{path}.url", errors)
    observed = _timestamp(evidence.get("observed_at"), f"{path}.observed_at", errors)
    _check_fresh_time(observed, generated, f"{path}.observed_at", errors)
    _string(evidence.get("claim"), f"{path}.claim", errors)
    return observed


def _validate_evidence_list(
    value: Any,
    path: str,
    generated: datetime | None,
    errors: list[str],
) -> list[datetime]:
    observed_times: list[datetime] = []
    for index, evidence in enumerate(_as_list(value, path, errors, nonempty=True)):
        observed = _validate_evidence(evidence, f"{path}[{index}]", generated, errors)
        if observed is not None:
            observed_times.append(observed)
    return observed_times


def _validate_claim(value: Any, path: str, errors: list[str], *, gap: bool = False) -> None:
    claim = _as_object(value, path, errors)
    allowed = {"claim", "evidence_urls", "basis", "confidence"} if gap else {"claim", "evidence_urls"}
    _allowed_keys(claim, allowed, path, errors)
    _string(claim.get("claim"), f"{path}.claim", errors)
    urls = _as_list(claim.get("evidence_urls"), f"{path}.evidence_urls", errors, nonempty=True)
    for index, url in enumerate(urls):
        _url(url, f"{path}.evidence_urls[{index}]", errors)
    if gap:
        _enum(claim.get("basis"), GAP_BASES, f"{path}.basis", errors)
        _enum(claim.get("confidence"), CONFIDENCE_STATES, f"{path}.confidence", errors)


def _validate_github_snapshot(
    candidate: dict[str, Any],
    candidate_path: str,
    candidate_url: str,
    source_commit: str,
    source_commit_url: str,
    maintenance_status: str,
    license_spdx: str,
    manifest_path: Path,
    generated: datetime | None,
    errors: list[str],
) -> datetime | None:
    snapshot_path_text = _string(
        candidate.get("github_snapshot_path"),
        f"{candidate_path}.github_snapshot_path",
        errors,
    )
    expected_hash = _string(
        candidate.get("github_snapshot_sha256"),
        f"{candidate_path}.github_snapshot_sha256",
        errors,
    ).lower()
    if expected_hash and not SHA256_RE.fullmatch(expected_hash):
        _error(errors, f"{candidate_path}.github_snapshot_sha256", "must be exactly 64 hexadecimal characters")
    if not snapshot_path_text:
        return None
    relative = Path(snapshot_path_text)
    if relative.is_absolute() or ".." in relative.parts:
        _error(errors, f"{candidate_path}.github_snapshot_path", "must be a contained relative path")
        return None
    base = manifest_path.resolve().parent
    snapshot_input = base / relative
    if snapshot_input.is_symlink():
        _error(errors, f"{candidate_path}.github_snapshot_path", "must not be a symlink")
        return None
    snapshot_path = snapshot_input.resolve()
    try:
        snapshot_path.relative_to(base)
    except ValueError:
        _error(errors, f"{candidate_path}.github_snapshot_path", "resolves outside the manifest directory")
        return None
    if not snapshot_path.is_file():
        _error(errors, f"{candidate_path}.github_snapshot_path", "must be an existing regular file")
        return None
    actual_hash = hashlib.sha256(snapshot_path.read_bytes()).hexdigest()
    if expected_hash and expected_hash != actual_hash:
        _error(errors, f"{candidate_path}.github_snapshot_sha256", f"hash mismatch; actual is {actual_hash}")
    try:
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        _error(errors, f"{candidate_path}.github_snapshot_path", f"is not valid UTF-8 JSON: {error}")
        return None
    if not isinstance(snapshot, dict) or snapshot.get("schema_version") != 1:
        _error(errors, f"{candidate_path}.github_snapshot_path", "must use snapshot schema_version 1")
        return None
    if str(snapshot.get("repository_url", "")).rstrip("/") != candidate_url.rstrip("/"):
        _error(errors, f"{candidate_path}.github_snapshot_path", "repository_url does not match candidate.url")
    candidate_parts = [part for part in urlparse(candidate_url).path.split("/") if part]
    expected_api_url = "https://api.github.com/repos/" + "/".join(candidate_parts[:2])
    if snapshot.get("api_url") != expected_api_url:
        _error(errors, f"{candidate_path}.github_snapshot.api_url", "does not match candidate.url")
    observed = _timestamp(snapshot.get("collected_at"), f"{candidate_path}.github_snapshot.collected_at", errors)
    _check_fresh_time(observed, generated, f"{candidate_path}.github_snapshot.collected_at", errors)

    repository = _as_object(snapshot.get("repository"), f"{candidate_path}.github_snapshot.repository", errors)
    commit = _as_object(snapshot.get("default_branch_commit"), f"{candidate_path}.github_snapshot.default_branch_commit", errors)
    if repository.get("html_url") != candidate_url:
        _error(errors, f"{candidate_path}.github_snapshot.repository.html_url", "does not match candidate.url")
    archived = repository.get("archived")
    disabled = repository.get("disabled")
    if not isinstance(archived, bool) or not isinstance(disabled, bool):
        _error(errors, f"{candidate_path}.github_snapshot.repository", "archived and disabled must be booleans")
    for field in ("stargazers_count", "forks_count", "open_issues_count"):
        value = repository.get(field)
        if not isinstance(value, int) or value < 0:
            _error(errors, f"{candidate_path}.github_snapshot.repository.{field}", "must be a non-negative integer")
    if repository.get("license_spdx") != license_spdx:
        _error(errors, f"{candidate_path}.license.spdx", "does not match the GitHub API snapshot")
    if commit.get("sha") != source_commit:
        _error(errors, f"{candidate_path}.source_commit", "does not match the GitHub API snapshot")
    if commit.get("html_url") != source_commit_url:
        _error(errors, f"{candidate_path}.source_commit_url", "does not match the GitHub API snapshot")
    committed_at = _timestamp(commit.get("committed_at"), f"{candidate_path}.github_snapshot.default_branch_commit.committed_at", errors)
    pushed_at = _timestamp(repository.get("pushed_at"), f"{candidate_path}.github_snapshot.repository.pushed_at", errors)
    release = snapshot.get("latest_release")
    released_at: datetime | None = None
    if isinstance(release, dict) and release:
        released_at = _timestamp(
            release.get("published_at"),
            f"{candidate_path}.github_snapshot.latest_release.published_at",
            errors,
        )
    activity_times = [value for value in (committed_at, pushed_at, released_at) if value is not None]
    expected_maintenance = "unknown"
    if archived is True:
        expected_maintenance = "archived"
    elif disabled is True:
        expected_maintenance = "inactive"
    elif observed is not None and activity_times:
        latest_activity = max(activity_times)
        if latest_activity > observed + FUTURE_TOLERANCE:
            _error(errors, f"{candidate_path}.github_snapshot", "activity timestamp cannot be later than collection time")
        age = observed - latest_activity
        if age <= timedelta(days=365):
            expected_maintenance = "active"
        elif age <= timedelta(days=730):
            expected_maintenance = "slow"
        else:
            expected_maintenance = "inactive"
    if maintenance_status and maintenance_status != expected_maintenance:
        _error(
            errors,
            f"{candidate_path}.maintenance.status",
            f"must be {expected_maintenance!r} from the GitHub snapshot",
        )
    return observed


def _validate_candidate(
    value: Any,
    index: int,
    manifest_path: Path,
    generated: datetime | None,
    errors: list[str],
) -> tuple[str, list[tuple[datetime, str]], str]:
    path = f"survey.candidates[{index}]"
    candidate = _as_object(value, path, errors)
    _allowed_keys(
        candidate,
        {"name", "url", "source_commit", "source_commit_url", "github_snapshot_path", "github_snapshot_sha256", "category", "maintenance", "adoption", "license", "security", "strengths", "gaps", "fit"},
        path,
        errors,
    )
    _string(candidate.get("name"), f"{path}.name", errors)
    candidate_url = _url(candidate.get("url"), f"{path}.url", errors)
    source_commit_value = candidate.get("source_commit", "")
    source_commit = source_commit_value.strip() if isinstance(source_commit_value, str) else ""
    source_commit_url_value = candidate.get("source_commit_url", "")
    source_commit_url = source_commit_url_value.strip() if isinstance(source_commit_url_value, str) else ""
    if _is_github_repository(candidate_url):
        source_commit = _string(source_commit_value, f"{path}.source_commit", errors)
        if source_commit and not GIT_OID_RE.fullmatch(source_commit):
            _error(errors, f"{path}.source_commit", "must be a 40- or 64-character Git object ID")
        source_commit_url = _url(
            source_commit_url_value,
            f"{path}.source_commit_url",
            errors,
            github=True,
        )
        if source_commit and source_commit_url and source_commit.lower() not in source_commit_url.lower():
            _error(errors, f"{path}.source_commit_url", "must contain source_commit")
    elif source_commit or source_commit_url:
        _error(errors, path, "source_commit fields are only allowed for GitHub repository candidates")
    _enum(candidate.get("category"), CATEGORIES, f"{path}.category", errors)

    maintenance = _as_object(candidate.get("maintenance"), f"{path}.maintenance", errors)
    _allowed_keys(maintenance, {"status", "evidence"}, f"{path}.maintenance", errors)
    maintenance_status = _enum(
        maintenance.get("status"),
        MAINTENANCE_STATES,
        f"{path}.maintenance.status",
        errors,
    )
    evidence_times: list[tuple[datetime, str]] = []
    for observed in _validate_evidence_list(
        maintenance.get("evidence"),
        f"{path}.maintenance.evidence",
        generated,
        errors,
    ):
        evidence_times.append((observed, f"{path}.maintenance.evidence"))

    adoption = _as_object(candidate.get("adoption"), f"{path}.adoption", errors)
    _allowed_keys(adoption, {"status", "evidence"}, f"{path}.adoption", errors)
    _enum(adoption.get("status"), ADOPTION_STATES, f"{path}.adoption.status", errors)
    for observed in _validate_evidence_list(
        adoption.get("evidence"), f"{path}.adoption.evidence", generated, errors
    ):
        evidence_times.append((observed, f"{path}.adoption.evidence"))

    license_data = _as_object(candidate.get("license"), f"{path}.license", errors)
    _allowed_keys(license_data, {"spdx", "evidence_url"}, f"{path}.license", errors)
    license_spdx = _string(license_data.get("spdx"), f"{path}.license.spdx", errors)
    _url(license_data.get("evidence_url"), f"{path}.license.evidence_url", errors)

    security = _as_object(candidate.get("security"), f"{path}.security", errors)
    _allowed_keys(security, {"status", "notes", "evidence"}, f"{path}.security", errors)
    _enum(security.get("status"), SECURITY_STATES, f"{path}.security.status", errors)
    _string(security.get("notes"), f"{path}.security.notes", errors)
    for observed in _validate_evidence_list(
        security.get("evidence"), f"{path}.security.evidence", generated, errors
    ):
        evidence_times.append((observed, f"{path}.security.evidence"))

    strengths = _as_list(candidate.get("strengths"), f"{path}.strengths", errors, nonempty=True)
    for claim_index, claim in enumerate(strengths):
        _validate_claim(claim, f"{path}.strengths[{claim_index}]", errors)

    gaps = _as_list(candidate.get("gaps"), f"{path}.gaps", errors, nonempty=True)
    for claim_index, claim in enumerate(gaps):
        _validate_claim(claim, f"{path}.gaps[{claim_index}]", errors, gap=True)

    _enum(candidate.get("fit"), FIT_STATES, f"{path}.fit", errors)
    if _is_github_repository(candidate_url):
        snapshot_time = _validate_github_snapshot(
            candidate,
            path,
            candidate_url,
            source_commit,
            source_commit_url,
            maintenance_status,
            license_spdx,
            manifest_path,
            generated,
            errors,
        )
        if snapshot_time is not None:
            evidence_times.append((snapshot_time, f"{path}.github_snapshot.collected_at"))
    elif candidate.get("github_snapshot_path") or candidate.get("github_snapshot_sha256"):
        _error(errors, path, "GitHub snapshot fields are only allowed for GitHub repository candidates")
    return candidate_url, evidence_times, source_commit


def _validate_github_search_snapshot(
    survey: dict[str, Any],
    manifest_path: Path,
    github_queries: list[tuple[str, str]],
    completed: datetime | None,
    generated: datetime | None,
    errors: list[str],
) -> None:
    path_text = _string(
        survey.get("github_search_snapshot_path"),
        "survey.github_search_snapshot_path",
        errors,
    )
    expected_hash = _string(
        survey.get("github_search_snapshot_sha256"),
        "survey.github_search_snapshot_sha256",
        errors,
    ).lower()
    if expected_hash and not SHA256_RE.fullmatch(expected_hash):
        _error(errors, "survey.github_search_snapshot_sha256", "must be exactly 64 hexadecimal characters")
    if not path_text:
        return
    relative = Path(path_text)
    if relative.is_absolute() or ".." in relative.parts:
        _error(errors, "survey.github_search_snapshot_path", "must be a contained relative path")
        return
    base = manifest_path.resolve().parent
    source = base / relative
    if source.is_symlink():
        _error(errors, "survey.github_search_snapshot_path", "must not be a symlink")
        return
    snapshot_path = source.resolve()
    try:
        snapshot_path.relative_to(base)
    except ValueError:
        _error(errors, "survey.github_search_snapshot_path", "resolves outside the manifest directory")
        return
    if not snapshot_path.is_file():
        _error(errors, "survey.github_search_snapshot_path", "must be an existing regular file")
        return
    actual_hash = hashlib.sha256(snapshot_path.read_bytes()).hexdigest()
    if expected_hash and expected_hash != actual_hash:
        _error(errors, "survey.github_search_snapshot_sha256", f"hash mismatch; actual is {actual_hash}")
    try:
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        _error(errors, "survey.github_search_snapshot_path", f"is not valid UTF-8 JSON: {error}")
        return
    if not isinstance(snapshot, dict) or snapshot.get("schema_version") != 1 or snapshot.get("kind") != "github_search_bundle":
        _error(errors, "survey.github_search_snapshot_path", "must be a github_search_bundle with schema_version 1")
        return
    collected = _timestamp(snapshot.get("collected_at"), "survey.github_search_snapshot.collected_at", errors)
    _check_fresh_time(collected, generated, "survey.github_search_snapshot.collected_at", errors)
    _check_not_after(collected, completed, "survey.github_search_snapshot.collected_at", "survey.completed_at", errors)
    searches = _as_list(snapshot.get("searches"), "survey.github_search_snapshot.searches", errors, nonempty=True)
    snapshot_pairs: list[tuple[str, str]] = []
    for index, value in enumerate(searches):
        item_path = f"survey.github_search_snapshot.searches[{index}]"
        search = _as_object(value, item_path, errors)
        query = _string(search.get("query"), f"{item_path}.query", errors)
        result_url = _url(search.get("result_url"), f"{item_path}.result_url", errors, github=True)
        api_url = _url(search.get("api_url"), f"{item_path}.api_url", errors)
        expected_query = quote_plus(query)
        expected_result_url = f"https://github.com/search?q={expected_query}&type=repositories"
        if result_url != expected_result_url:
            _error(errors, f"{item_path}.result_url", "does not match the recorded query")
        if not api_url.startswith("https://api.github.com/search/repositories?"):
            _error(errors, f"{item_path}.api_url", "must be a GitHub repository search API URL")
        elif parse_qs(urlparse(api_url).query).get("q", [""])[0] != query:
            _error(errors, f"{item_path}.api_url", "q parameter does not match the recorded query")
        total = search.get("total_count")
        if not isinstance(total, int) or total < 0:
            _error(errors, f"{item_path}.total_count", "must be a non-negative integer")
        if not isinstance(search.get("incomplete_results"), bool):
            _error(errors, f"{item_path}.incomplete_results", "must be a boolean")
        result_items = _as_list(search.get("items"), f"{item_path}.items", errors)
        for item_index, result in enumerate(result_items):
            result_path = f"{item_path}.items[{item_index}]"
            result_object = _as_object(result, result_path, errors)
            _url(result_object.get("html_url"), f"{result_path}.html_url", errors, github=True)
            for field in ("stargazers_count", "forks_count"):
                number = result_object.get(field)
                if not isinstance(number, int) or number < 0:
                    _error(errors, f"{result_path}.{field}", "must be a non-negative integer")
        snapshot_pairs.append((" ".join(query.split()).casefold(), result_url))
    manifest_pairs = [(" ".join(query.split()).casefold(), url) for query, url in github_queries]
    if set(snapshot_pairs) != set(manifest_pairs):
        _error(errors, "survey.github_search_snapshot.searches", "must exactly match the manifest GitHub queries and result URLs")


def _validate_formal(
    data: dict[str, Any],
    manifest_path: Path,
    generated: datetime | None,
    owner: str,
    errors: list[str],
) -> None:
    survey = _as_object(data.get("survey"), "survey", errors)
    _allowed_keys(
        survey,
        {"skill", "survey_run_id", "completed_at", "queries", "github_search_snapshot_path", "github_search_snapshot_sha256", "no_candidates_found", "no_candidates_reason", "candidates"},
        "survey",
        errors,
    )
    if _string(survey.get("skill"), "survey.skill", errors) != "survey":
        _error(errors, "survey.skill", "must identify the reused survey skill")
    survey_run_id = _string(survey.get("survey_run_id"), "survey.survey_run_id", errors)
    completed = _timestamp(survey.get("completed_at"), "survey.completed_at", errors)
    _check_fresh_time(completed, generated, "survey.completed_at", errors)

    queries = _as_list(survey.get("queries"), "survey.queries", errors)
    if len(queries) < 3:
        _error(errors, "survey.queries", "must contain at least three search queries")
    unique_queries: set[tuple[str, str]] = set()
    github_query_count = 0
    github_query_pairs: list[tuple[str, str]] = []
    query_times: list[tuple[datetime, str]] = []
    for index, value in enumerate(queries):
        path = f"survey.queries[{index}]"
        query = _as_object(value, path, errors)
        _allowed_keys(query, {"provider", "query", "result_url", "searched_at"}, path, errors)
        provider = _enum(query.get("provider"), QUERY_PROVIDERS, f"{path}.provider", errors)
        query_text = _string(query.get("query"), f"{path}.query", errors)
        result_url = _url(
            query.get("result_url"),
            f"{path}.result_url",
            errors,
            github=provider == "github",
        )
        if provider == "github" and result_url:
            parsed_result = urlparse(result_url)
            query_params = parse_qs(parsed_result.query)
            if parsed_result.path.rstrip("/") != "/search" or not query_params.get("q"):
                _error(errors, f"{path}.result_url", "must be a GitHub /search URL with a q parameter")
        searched = _timestamp(query.get("searched_at"), f"{path}.searched_at", errors)
        _check_fresh_time(searched, generated, f"{path}.searched_at", errors)
        if searched is not None:
            query_times.append((searched, f"{path}.searched_at"))
        key = (provider.casefold(), " ".join(query_text.casefold().split()))
        if provider and query_text:
            if key in unique_queries:
                _error(errors, path, "duplicates another provider/query pair")
            unique_queries.add(key)
        if provider == "github" and result_url:
            github_query_count += 1
            github_query_pairs.append((query_text, result_url))

    if github_query_count < 2:
        _error(errors, "survey.queries", "must include at least two GitHub searches")
    _validate_github_search_snapshot(
        survey,
        manifest_path,
        github_query_pairs,
        completed,
        generated,
        errors,
    )

    no_candidates = survey.get("no_candidates_found")
    if not isinstance(no_candidates, bool):
        _error(errors, "survey.no_candidates_found", "must be a boolean")
        no_candidates = False
    candidates = _as_list(survey.get("candidates"), "survey.candidates", errors)
    no_candidates_reason = survey.get("no_candidates_reason")
    if not isinstance(no_candidates_reason, str):
        _error(errors, "survey.no_candidates_reason", "must be a string")
        no_candidates_reason = ""

    candidate_urls: list[str] = []
    candidate_sources: set[tuple[str, str]] = set()
    candidate_evidence_times: list[tuple[datetime, str]] = []
    for index, candidate in enumerate(candidates):
        candidate_url, observed_times, source_commit = _validate_candidate(
            candidate,
            index,
            manifest_path,
            generated,
            errors,
        )
        candidate_urls.append(candidate_url)
        if source_commit:
            candidate_sources.add((candidate_url, source_commit))
        candidate_evidence_times.extend(observed_times)

    for observed, observed_path in query_times + candidate_evidence_times:
        _check_not_after(
            observed,
            completed,
            observed_path,
            "survey.completed_at",
            errors,
        )

    if no_candidates:
        if candidates:
            _error(errors, "survey.candidates", "must be empty when no_candidates_found is true")
        if not no_candidates_reason.strip():
            _error(errors, "survey.no_candidates_reason", "must explain the search boundary")
        if github_query_count < 3:
            _error(errors, "survey.queries", "no-candidate claims require at least three GitHub searches")
    else:
        if not candidates:
            _error(errors, "survey.candidates", "must include at least one candidate")
        if no_candidates_reason.strip():
            _error(errors, "survey.no_candidates_reason", "must be empty when candidates were found")
        if candidates and not any(_is_github_repository(url) for url in candidate_urls):
            _error(errors, "survey.candidates", "must include at least one direct GitHub repository URL")

    decision = _as_object(data.get("decision"), "decision", errors)
    _allowed_keys(
        decision,
        {"outcome", "rationale", "why_existing_not_sufficient", "minimum_differentiation", "upstream_sources", "next_step"},
        "decision",
        errors,
    )
    outcome = _enum(decision.get("outcome"), DECISIONS, "decision.outcome", errors)
    _string_list(decision.get("rationale"), "decision.rationale", errors, nonempty=True)
    why_not = _string_list(
        decision.get("why_existing_not_sufficient"),
        "decision.why_existing_not_sufficient",
        errors,
    )
    differentiation = _string_list(
        decision.get("minimum_differentiation"),
        "decision.minimum_differentiation",
        errors,
    )
    upstream_values = _as_list(decision.get("upstream_sources"), "decision.upstream_sources", errors)
    upstream_sources: list[tuple[str, str]] = []
    for index, value in enumerate(upstream_values):
        source_path = f"decision.upstream_sources[{index}]"
        source = _as_object(value, source_path, errors)
        _allowed_keys(source, {"repository_url", "base_commit"}, source_path, errors)
        repository_url = _url(source.get("repository_url"), f"{source_path}.repository_url", errors, github=True)
        base_commit = _string(source.get("base_commit"), f"{source_path}.base_commit", errors)
        if base_commit and not GIT_OID_RE.fullmatch(base_commit):
            _error(errors, f"{source_path}.base_commit", "must be a 40- or 64-character Git object ID")
        pair = (repository_url, base_commit)
        if pair in upstream_sources:
            _error(errors, source_path, "duplicates another upstream source")
        upstream_sources.append(pair)
    _string(decision.get("next_step"), "decision.next_step", errors)
    if outcome in REQUIRES_DIFFERENTIATION:
        if not why_not:
            _error(errors, "decision.why_existing_not_sufficient", f"is required for {outcome}")
        if not differentiation:
            _error(errors, "decision.minimum_differentiation", f"is required for {outcome}")
    if outcome == "fork" and not upstream_sources:
        _error(
            errors,
            "decision.upstream_sources",
            "fork requires at least one inspected upstream repository/base pair",
        )
    if outcome != "fork" and upstream_sources:
        _error(
            errors,
            "decision.upstream_sources",
            "upstream history preservation is only allowed for fork",
        )
    if outcome == "fork":
        unknown_sources = set(upstream_sources) - candidate_sources
        if unknown_sources:
            _error(
                errors,
                "decision.upstream_sources",
                "each repository/base pair must match one inspected GitHub candidate snapshot",
            )

    review = _as_object(data.get("independent_review"), "independent_review", errors)
    _allowed_keys(
        review,
        {"review_run_id", "reviewer", "reviewer_role", "reviewed_at", "reviewed_report_sha256", "verdict", "checks", "challenges"},
        "independent_review",
        errors,
    )
    review_run_id = _string(
        review.get("review_run_id"), "independent_review.review_run_id", errors
    )
    reviewer = _string(review.get("reviewer"), "independent_review.reviewer", errors)
    role = _string(review.get("reviewer_role"), "independent_review.reviewer_role", errors)
    if role and role != "independent_reviewer":
        _error(errors, "independent_review.reviewer_role", "must be independent_reviewer")
    if review_run_id and survey_run_id and review_run_id == survey_run_id:
        _error(errors, "independent_review.review_run_id", "must differ from survey_run_id")
    if reviewer and owner and reviewer.casefold() == owner.casefold():
        _error(errors, "independent_review.reviewer", "must differ from implementation_owner")
    reviewed = _timestamp(review.get("reviewed_at"), "independent_review.reviewed_at", errors)
    _check_fresh_time(reviewed, generated, "independent_review.reviewed_at", errors)
    if completed and reviewed and reviewed + FUTURE_TOLERANCE < completed:
        _error(
            errors,
            "independent_review.reviewed_at",
            "must not be earlier than survey.completed_at",
        )
    reviewed_report_hash = _string(
        review.get("reviewed_report_sha256"),
        "independent_review.reviewed_report_sha256",
        errors,
    ).lower()
    if reviewed_report_hash and not SHA256_RE.fullmatch(reviewed_report_hash):
        _error(
            errors,
            "independent_review.reviewed_report_sha256",
            "must be exactly 64 hexadecimal characters",
        )
    verdict = _string(review.get("verdict"), "independent_review.verdict", errors)
    if verdict and verdict != "pass":
        _error(errors, "independent_review.verdict", "must be pass for a formal gate")

    checks = _as_list(review.get("checks"), "independent_review.checks", errors)
    seen_checks: set[str] = set()
    for index, value in enumerate(checks):
        path = f"independent_review.checks[{index}]"
        check = _as_object(value, path, errors)
        _allowed_keys(check, {"id", "result", "evidence"}, path, errors)
        check_id = _string(check.get("id"), f"{path}.id", errors)
        if check_id not in REQUIRED_REVIEW_CHECKS:
            _error(errors, f"{path}.id", f"must be one of {sorted(REQUIRED_REVIEW_CHECKS)}")
        if check_id in seen_checks:
            _error(errors, f"{path}.id", "duplicates another review check")
        seen_checks.add(check_id)
        result = _string(check.get("result"), f"{path}.result", errors)
        if result and result != "pass":
            _error(errors, f"{path}.result", "must be pass")
        _string(check.get("evidence"), f"{path}.evidence", errors)
    missing_checks = REQUIRED_REVIEW_CHECKS - seen_checks
    if missing_checks:
        _error(errors, "independent_review.checks", f"missing required checks: {sorted(missing_checks)}")

    challenges = _as_list(
        review.get("challenges"), "independent_review.challenges", errors, nonempty=True
    )
    for index, value in enumerate(challenges):
        path = f"independent_review.challenges[{index}]"
        challenge = _as_object(value, path, errors)
        _allowed_keys(challenge, {"challenge", "resolution", "evidence_urls"}, path, errors)
        _string(challenge.get("challenge"), f"{path}.challenge", errors)
        _string(challenge.get("resolution"), f"{path}.resolution", errors)
        urls = _as_list(
            challenge.get("evidence_urls"), f"{path}.evidence_urls", errors, nonempty=True
        )
        for url_index, url in enumerate(urls):
            _url(url, f"{path}.evidence_urls[{url_index}]", errors)

    artifacts = _as_object(data.get("artifacts"), "artifacts", errors)
    _allowed_keys(artifacts, {"report_path", "report_sha256"}, "artifacts", errors)
    report_path_text = _string(artifacts.get("report_path"), "artifacts.report_path", errors)
    expected_hash = _string(
        artifacts.get("report_sha256"), "artifacts.report_sha256", errors
    ).lower()
    if expected_hash and not SHA256_RE.fullmatch(expected_hash):
        _error(errors, "artifacts.report_sha256", "must be exactly 64 hexadecimal characters")
    if reviewed_report_hash and expected_hash and reviewed_report_hash != expected_hash:
        _error(
            errors,
            "independent_review.reviewed_report_sha256",
            "must equal artifacts.report_sha256",
        )

    if report_path_text:
        relative = Path(report_path_text)
        if relative.is_absolute() or ".." in relative.parts:
            _error(errors, "artifacts.report_path", "must be a contained relative path")
            return
        base = manifest_path.resolve().parent
        report_path = (base / relative).resolve()
        try:
            report_path.relative_to(base)
        except ValueError:
            _error(errors, "artifacts.report_path", "resolves outside the manifest directory")
            return
        if not report_path.is_file():
            _error(errors, "artifacts.report_path", f"report does not exist: {report_path}")
            return
        report_bytes = report_path.read_bytes()
        if len(report_bytes) < 200:
            _error(errors, "artifacts.report_path", "report must contain at least 200 bytes")
        actual_hash = hashlib.sha256(report_bytes).hexdigest()
        if expected_hash and actual_hash != expected_hash:
            _error(errors, "artifacts.report_sha256", f"hash mismatch; actual is {actual_hash}")
        try:
            report_text = report_bytes.decode("utf-8")
        except UnicodeDecodeError:
            _error(errors, "artifacts.report_path", "report must be UTF-8 text")
            return
        if "REPLACE_" in report_text:
            _error(errors, "artifacts.report_path", "report still contains template placeholders")
        for index, candidate_url in enumerate(candidate_urls):
            if candidate_url and candidate_url not in report_text:
                _error(
                    errors,
                    "artifacts.report_path",
                    f"does not cite survey.candidates[{index}].url",
                )


def _validate_incubation(
    data: dict[str, Any],
    generated: datetime | None,
    valid_until: datetime | None,
    errors: list[str],
) -> None:
    waiver = _as_object(data.get("waiver"), "waiver", errors)
    _allowed_keys(
        waiver,
        {"approved_by", "approval_reference", "approved_at", "reason", "risks", "allowed_actions", "prohibited_actions", "review_at"},
        "waiver",
        errors,
    )
    _string(waiver.get("approved_by"), "waiver.approved_by", errors)
    _string(waiver.get("approval_reference"), "waiver.approval_reference", errors)
    approved = _timestamp(waiver.get("approved_at"), "waiver.approved_at", errors)
    _check_fresh_time(approved, generated, "waiver.approved_at", errors)
    _string(waiver.get("reason"), "waiver.reason", errors)
    _string_list(waiver.get("risks"), "waiver.risks", errors, nonempty=True)

    allowed = set(
        _string_list(waiver.get("allowed_actions"), "waiver.allowed_actions", errors, nonempty=True)
    )
    unexpected_allowed = allowed - ALLOWED_INCUBATION_ACTIONS
    if unexpected_allowed:
        _error(errors, "waiver.allowed_actions", f"contains prohibited scope: {sorted(unexpected_allowed)}")

    prohibited_values = _string_list(
        waiver.get("prohibited_actions"), "waiver.prohibited_actions", errors
    )
    prohibited = set(prohibited_values)
    if len(prohibited) != len(prohibited_values):
        _error(errors, "waiver.prohibited_actions", "must not contain duplicates")
    missing = REQUIRED_PROHIBITED_ACTIONS - prohibited
    if missing:
        _error(errors, "waiver.prohibited_actions", f"missing required prohibitions: {sorted(missing)}")

    review_at = _timestamp(waiver.get("review_at"), "waiver.review_at", errors)
    if review_at and generated and review_at < generated:
        _error(errors, "waiver.review_at", "must not be earlier than generated_at")
    if review_at and valid_until and review_at > valid_until:
        _error(errors, "waiver.review_at", "must not be later than valid_until")


def validate_manifest(
    data: Any,
    manifest_path: Path,
    *,
    mode: str = "formal",
    now: datetime | None = None,
    allow_expired: bool = False,
    expected_project_name: str | None = None,
    require_project_creation: bool = False,
) -> list[str]:
    """Return all validation errors. An empty list means the gate passes."""

    errors: list[str] = []
    root = _as_object(data, "$", errors)
    _allowed_keys(
        root,
        {"schema_version", "gate", "project", "survey", "decision", "independent_review", "artifacts", "waiver"},
        "$",
        errors,
    )
    if root.get("schema_version") != 1:
        _error(errors, "schema_version", "must be integer 1")

    gate = _as_object(root.get("gate"), "gate", errors)
    _allowed_keys(gate, {"mode", "status", "generated_at", "valid_until"}, "gate", errors)
    actual_mode = _string(gate.get("mode"), "gate.mode", errors)
    if actual_mode and actual_mode != mode:
        _error(errors, "gate.mode", f"manifest mode {actual_mode!r} cannot satisfy requested mode {mode!r}")
    required_status = "passed" if mode == "formal" else "waived"
    status = _string(gate.get("status"), "gate.status", errors)
    if status and status != required_status:
        _error(errors, "gate.status", f"must be {required_status!r} for {mode} mode")

    generated = _timestamp(gate.get("generated_at"), "gate.generated_at", errors)
    valid_until = _timestamp(gate.get("valid_until"), "gate.valid_until", errors)
    now_utc = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    max_validity = FORMAL_MAX_VALIDITY if mode == "formal" else INCUBATION_MAX_VALIDITY
    if generated and generated > now_utc + FUTURE_TOLERANCE:
        _error(errors, "gate.generated_at", "cannot be in the future beyond clock tolerance")
    if generated and valid_until:
        if valid_until <= generated:
            _error(errors, "gate.valid_until", "must be later than generated_at")
        if valid_until - generated > max_validity:
            _error(errors, "gate.valid_until", f"validity may not exceed {max_validity.days} days")
    if valid_until and now_utc > valid_until and not allow_expired:
        _error(errors, "gate.valid_until", "manifest has expired")

    project, owner = _validate_project(root.get("project"), errors)
    if expected_project_name:
        actual_name = project.get("name")
        if actual_name != expected_project_name:
            _error(
                errors,
                "project.name",
                f"must exactly match the requested project name {expected_project_name!r}",
            )
    if mode == "formal":
        if "waiver" in root:
            _error(errors, "waiver", "must not be present in a formal manifest")
        _validate_formal(root, manifest_path, generated, owner, errors)
        if require_project_creation:
            decision = root.get("decision")
            outcome = decision.get("outcome") if isinstance(decision, dict) else None
            if outcome not in PROJECT_CREATION_DECISIONS:
                _error(
                    errors,
                    "decision.outcome",
                    "must be integrate, fork, or build before creating a new formal project",
                )
    else:
        forbidden_formal_fields = sorted(
            {"survey", "decision", "independent_review", "artifacts"}.intersection(root)
        )
        if forbidden_formal_fields:
            _error(errors, "$", f"incubation waiver contains formal-only fields: {forbidden_formal_fields}")
        _validate_incubation(root, generated, valid_until, errors)
    return errors


def _load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="path to a formal manifest or incubation waiver")
    parser.add_argument("--mode", choices=("formal", "incubation"), default="formal")
    parser.add_argument(
        "--allow-expired",
        action="store_true",
        help="ignore only the current-time expiry check; used for post-admission integrity checks",
    )
    parser.add_argument("--expected-project-name")
    parser.add_argument(
        "--require-project-creation",
        action="store_true",
        help="require an integrate, fork, or build decision",
    )
    parser.add_argument("--json", action="store_true", dest="json_output")
    args = parser.parse_args(argv)

    try:
        data = _load_json(args.manifest)
    except FileNotFoundError:
        errors = [f"manifest: file does not exist: {args.manifest}"]
    except json.JSONDecodeError as exc:
        errors = [f"manifest: invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}"]
    except OSError as exc:
        errors = [f"manifest: cannot read file: {exc}"]
    else:
        errors = validate_manifest(
            data,
            args.manifest,
            mode=args.mode,
            allow_expired=args.allow_expired,
            expected_project_name=args.expected_project_name,
            require_project_creation=args.require_project_creation,
        )

    result = {
        "valid": not errors,
        "mode": args.mode,
        "manifest": str(args.manifest.resolve()),
        "errors": errors,
    }
    if args.json_output:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif errors:
        print(f"FAIL: {len(errors)} validation error(s)", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
    else:
        print(f"PASS: {args.mode} project-initiation evidence is valid")
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
