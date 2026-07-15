"""Resumable multi-page scholarship enrichment using Crawl4AI and an LLM."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import ipaddress
import json
import os
import random
import re
import socket
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urldefrag, urljoin, urlparse, urlunparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / "src" / "generated" / "catalog.json"
SOURCE_RECORDS = ROOT / "data" / "scholarships.json"
IMPORTS = ROOT / "data" / "imports"
TAXONOMY_PATH = ROOT / "data" / "taxonomy" / "scholarship-taxonomy-v4.json"
SCHEMA_PATH = ROOT / "data" / "taxonomy" / "scholarship-enrichment-v4.schema.json"
OUTPUT_DIR = ROOT / "data" / "enrichment-v4"
RECORDS = OUTPUT_DIR / "records.jsonl"
PROGRESS = OUTPUT_DIR / "progress.jsonl"
EVENTS = OUTPUT_DIR / "events.jsonl"
CRAWL_CACHE = OUTPUT_DIR / "crawl-cache"
FACT_CACHE = OUTPUT_DIR / "fact-cache"
CLASSIFICATION_CACHE = OUTPUT_DIR / "classification-cache"
COMBINED_CACHE = OUTPUT_DIR / "combined-cache"
LOCK = OUTPUT_DIR / ".run.lock"
PIPELINE_VERSION = 1
PROMPT_VERSION = 5
CRAWLER_VERSION = 5
INPUT_VERSION = 2
DEFAULT_MODELS = ['gemma-4-31b-it']
DEFAULT_OPENROUTER_MODELS = ['openrouter/free']
REQUIREMENT_STATUSES = {"required", "not-required", "optional", "unknown"}
RELATIONSHIPS = {"eligible", "required", "preferred", "descriptive"}
DEADLINE_TYPES = {"fixed", "rolling", "varies", "unknown"}
ENROLLMENT_INTENSITIES = {"full-time", "part-time", "either", "unknown"}


class RateLimitError(RuntimeError):
    pass
CANONICAL_GRADES = {
    "Kindergarten",
    "Grade 1",
    "Grade 2",
    "Grade 3",
    "Grade 4",
    "Grade 5",
    "Grade 6",
    "Grade 7",
    "Grade 8",
    "High School Freshman",
    "High School Sophomore",
    "High School Junior",
    "High School Senior",
    "High School Graduate",
    "High School Student",
    "College Freshman",
    "College Sophomore",
    "College Junior",
    "College Senior",
    "Undergraduate",
    "Community College Student",
    "Vocational or Trade Student",
    "Graduate Student",
    "Doctoral Student",
    "Law Student",
    "Medical Student",
    "Not Currently Enrolled",
}
PAGE_ROLES = {"seed", "eligibility", "application", "deadline", "award", "faq", "other", "record-fallback"}
AGGREGATOR_HOSTS = {
    "bigfuture.collegeboard.org",
    "how2winscholarships.com",
}
LINK_TERMS = {
    "eligibility": 12,
    "eligible": 10,
    "requirements": 11,
    "criteria": 8,
    "apply": 10,
    "application": 10,
    "deadline": 10,
    "dates": 5,
    "award": 8,
    "amount": 7,
    "faq": 6,
    "selection": 6,
    "documents": 7,
    "renewal": 6,
    "renewable": 6,
    "scholarship": 3,
}
EXCLUDED_LINK_TERMS = re.compile(
    r"(privacy|terms|cookie|login|sign.?in|register|donate|contact|news|blog|"
    r"facebook|instagram|linkedin|youtube|twitter|calendar|events|javascript:|mailto:)",
    re.IGNORECASE,
)
IMPORTANT_TEXT = re.compile(
    r"(eligib|require|must\b|deadline|apply|application|award|amount|renew|essay|"
    r"recommend|transcript|fafsa|portfolio|audition|interview|gpa|citizen|resident|"
    r"enroll|major|degree|tuition|fee|document|criteria|selection)",
    re.IGNORECASE,
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_environment() -> None:
    for filename in (".env.local", ".env"):
        path = ROOT / filename
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip() and not line.lstrip().startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_source_catalog() -> list[dict[str, Any]]:
    records = load_json(SOURCE_RECORDS)
    if not isinstance(records, list):
        raise ValueError("data/scholarships.json must contain an array.")
    records = list(records)
    if IMPORTS.exists():
        for path in IMPORTS.rglob("records.jsonl"):
            records.extend(json_lines(path))
    by_id: dict[str, dict[str, Any]] = {}
    by_fingerprint: dict[str, dict[str, Any]] = {}
    for record in records:
        record_id = record.get("id")
        title = re.sub(r"\s+", " ", str(record.get("title") or "")).strip().lower()
        provider = re.sub(r"\s+", " ", str(record.get("provider") or "")).strip().lower()
        url = record.get("applicationUrl") or record.get("sourceUrl") or ""
        fingerprint = f"{title}|{provider}|{url}"
        existing = by_id.get(record_id) if record_id else None
        existing = existing or by_fingerprint.get(fingerprint)
        if existing:
            urls = [
                *(existing.get("sourceUrls") or [existing.get("sourceUrl")]),
                record.get("sourceUrl"),
                *(record.get("sourceUrls") or []),
            ]
            existing["sourceUrls"] = [url for url in dict.fromkeys(urls) if url]
            continue
        copy = dict(record)
        if copy.get("sourceUrl") and not copy.get("sourceUrls"):
            copy["sourceUrls"] = [copy["sourceUrl"]]
        if record_id:
            by_id[record_id] = copy
        by_fingerprint[fingerprint] = copy
    return list(by_id.values())


def json_lines(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    values: list[dict[str, Any]] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"Invalid JSON in {path}:{number}") from error
        if isinstance(value, dict):
            values.append(value)
    return values


def append_jsonl(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
    with path.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(encoded + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=True, separators=(",", ":")),
        encoding="utf-8",
    )
    temporary.replace(path)


def crawl_cache_index() -> dict[str, Path]:
    index: dict[str, Path] = {}
    if not CRAWL_CACHE.exists():
        return index
    for path in CRAWL_CACHE.glob("*.json"):
        try:
            record_id = load_json(path).get("id")
        except (OSError, json.JSONDecodeError, AttributeError):
            continue
        if not record_id:
            continue
        existing = index.get(record_id)
        if existing is None or path.stat().st_mtime > existing.stat().st_mtime:
            index[record_id] = path
    return index


def model_cache_index(directory: Path) -> dict[str, Path]:
    index: dict[str, Path] = {}
    if not directory.exists():
        return index
    for path in directory.glob("*.json"):
        try:
            value = load_json(path)
            record_id = value.get("id")
            if not record_id:
                record_id = (value.get("facts") or {}).get("id")
            if not record_id:
                record_id = (value.get("classification") or {}).get("id")
        except (OSError, json.JSONDecodeError, AttributeError):
            continue
        if not record_id:
            continue
        existing = index.get(record_id)
        if existing is None or path.stat().st_mtime > existing.stat().st_mtime:
            index[record_id] = path
    return index


def stable_hash(value: Any, length: int = 20) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    return hashlib.sha256(encoded).hexdigest()[:length]


def compact_record(record: dict[str, Any]) -> dict[str, Any]:
    eligibility = record.get("eligibility") or {}
    return {
        "id": record.get("id"),
        "title": record.get("title"),
        "provider": record.get("provider"),
        "description": record.get("description"),
        "applicationUrl": record.get("applicationUrl"),
        "sourceUrl": record.get("sourceUrl"),
        "sourceUrls": record.get("sourceUrls") or [],
        "opens": record.get("opens"),
        "deadline": record.get("deadline"),
        "award": record.get("award") or {},
        "requirements": record.get("requirements") or {},
        "eligibility": {
            "countries": eligibility.get("countries") or [],
            "states": eligibility.get("states") or [],
            "grades": eligibility.get("grades") or [],
            "degreeLevels": eligibility.get("degreeLevels") or [],
            "fields": eligibility.get("fields") or [],
            "minimumGpa": eligibility.get("minimumGpa"),
            "minimumAge": eligibility.get("minimumAge"),
            "citizenship": eligibility.get("citizenship") or [],
            "other": eligibility.get("other") or [],
        },
        "institutionSpecific": record.get("institutionSpecific"),
        "institutionName": record.get("institutionName"),
        "institutionTypes": record.get("institutionTypes") or [],
    }


def input_hash(record: dict[str, Any], taxonomy_hash: str) -> str:
    return stable_hash(
        {
            "source": source_identity(record),
            "taxonomyHash": taxonomy_hash,
            "pipelineVersion": PIPELINE_VERSION,
            "promptVersion": PROMPT_VERSION,
            "inputVersion": INPUT_VERSION,
        }
    )


def source_identity(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": record.get("id"),
        "sourceCheckedAt": record.get("sourceCheckedAt"),
        "sourceUrl": record.get("sourceUrl"),
        "sourceUrls": sorted(record.get("sourceUrls") or []),
    }


def source_signature(record: dict[str, Any]) -> str:
    return stable_hash(source_identity(record), 20)


def crawl_hash(record: dict[str, Any]) -> str:
    return stable_hash(
        {
            "source": source_identity(record),
            "crawlerVersion": CRAWLER_VERSION,
        }
    )


def pid_running(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def active_lock(path: Path) -> int | None:
    if not path.exists():
        return None
    try:
        pid = int(path.read_text(encoding="ascii").strip())
    except (OSError, ValueError):
        return None
    return pid if pid_running(pid) else None


@contextmanager
def run_lock(name: str = "run"):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    lock = OUTPUT_DIR / f".{name}.lock"
    existing_pid = active_lock(lock)
    if existing_pid:
        raise RuntimeError(f"Another v4 enrichment run is active with PID {existing_pid}.")
    if lock.exists():
        lock.unlink(missing_ok=True)
    descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    try:
        os.write(descriptor, str(os.getpid()).encode("ascii"))
        os.close(descriptor)
        yield
    finally:
        lock.unlink(missing_ok=True)


def normalize_url(value: str | None) -> str | None:
    if not value:
        return None
    try:
        parsed = urlparse(value.strip())
    except ValueError:
        return None
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        return None
    if parsed.username or parsed.password:
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    if port not in {None, 80, 443}:
        return None
    path = parsed.path or "/"
    normalized = parsed._replace(
        scheme=parsed.scheme.lower(),
        netloc=parsed.hostname.lower() + (f":{port}" if port else ""),
        path=path,
        fragment="",
    )
    return urlunparse(normalized)


def assert_public_url(url: str) -> None:
    parsed = urlparse(url)
    hostname = parsed.hostname
    if not hostname:
        raise ValueError("URL has no hostname.")
    if hostname.lower() in {"localhost", "localhost.localdomain"}:
        raise ValueError("Local URLs are not crawlable.")
    try:
        addresses = socket.getaddrinfo(hostname, parsed.port or 443, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        raise ValueError(f"Hostname did not resolve: {hostname}") from error
    if not addresses:
        raise ValueError(f"Hostname did not resolve: {hostname}")
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise ValueError(f"URL resolves to a non-public address: {hostname}")


def same_site(url: str, seed: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    seed_host = (urlparse(seed).hostname or "").lower()
    return bool(host and seed_host and (host == seed_host or host.endswith("." + seed_host) or seed_host.endswith("." + host)))


def role_for_url(url: str, label: str = "") -> str:
    text = f"{url} {label}".lower()
    for role in ("eligibility", "application", "deadline", "award", "faq"):
        if role in text or (role == "application" and re.search(r"\bapply\b", text)):
            return role
    return "other"


def title_terms(record: dict[str, Any]) -> list[str]:
    text = f"{record.get('title', '')} {record.get('provider', '')}".lower()
    return [
        term
        for term in re.findall(r"[a-z0-9]{4,}", text)
        if term not in {"scholarship", "award", "foundation", "program", "application"}
    ][:12]


def link_score(url: str, label: str, record: dict[str, Any]) -> int:
    text = f"{url} {label}".lower()
    if EXCLUDED_LINK_TERMS.search(text):
        return -100
    score = sum(weight for term, weight in LINK_TERMS.items() if term in text)
    score += min(12, 4 * sum(1 for term in title_terms(record) if term in text))
    path = urlparse(url).path.strip("/")
    if path.count("/") > 5:
        score -= 3
    if re.search(r"\.(jpg|jpeg|png|gif|svg|zip|mp4|mp3|pdf|doc|docx|xls|xlsx|ppt|pptx)(?:$|[?\s])", text):
        score -= 100
    substantive = any(
        term in text
        for term in ("eligib", "require", "criteria", "deadline", "award", "amount", "faq", "renew")
    )
    matched_identity = any(term in text for term in title_terms(record))
    path = urlparse(url).path.rstrip("/").lower()
    matched_url_identity = any(term in path for term in title_terms(record))
    generic_listing = bool(
        re.search(r"/(?:search/)?(?:scholarships?|opportunities)(?:/results)?$", path)
        or re.search(r"/(?:search|scholarships?)/(?:search-scholarships?)$", path)
    )
    if generic_listing and not matched_url_identity:
        score -= 100
    if not substantive and "scholarship" not in text and "apply" not in text and "application" not in text:
        score -= 100
    if ("apply" in text or "application" in text) and not substantive and not matched_identity:
        score -= 8
    return score


def extract_result_links(result: Any, base_url: str) -> list[dict[str, str]]:
    links = getattr(result, "links", None) or {}
    groups = links.values() if isinstance(links, dict) else [links]
    found: list[dict[str, str]] = []
    for group in groups:
        if not isinstance(group, list):
            continue
        for item in group:
            if isinstance(item, str):
                href, label = item, ""
            elif isinstance(item, dict):
                href = item.get("href") or item.get("url")
                label = item.get("text") or item.get("title") or ""
            else:
                continue
            normalized = normalize_url(urljoin(base_url, str(href or "")))
            if normalized:
                found.append({"url": normalized, "label": re.sub(r"\s+", " ", str(label)).strip()[:300]})
    return found


def markdown_text(result: Any) -> str:
    markdown = getattr(result, "markdown", "")
    if isinstance(markdown, str):
        return markdown
    return getattr(markdown, "fit_markdown", "") or getattr(markdown, "raw_markdown", "") or ""


def trim_markdown(text: str, record: dict[str, Any], maximum: int) -> str:
    text = re.sub(r"\r\n?", "\n", text)
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines()]
    lines = [line for line in lines if line and len(line) <= 5000]
    joined = "\n".join(lines)
    if len(joined) <= maximum:
        return joined
    selected: set[int] = set(range(min(35, len(lines))))
    terms = title_terms(record)
    for index, line in enumerate(lines):
        lower = line.lower()
        if IMPORTANT_TEXT.search(line) or any(term in lower for term in terms):
            selected.update(range(max(0, index - 2), min(len(lines), index + 4)))
    filtered = "\n".join(lines[index] for index in sorted(selected))
    return filtered[:maximum] if filtered else joined[:maximum]


def fallback_page(record: dict[str, Any]) -> dict[str, Any]:
    text = json.dumps(compact_record(record), ensure_ascii=True, indent=2)
    return {
        "url": f"record://{record['id']}",
        "title": record.get("title"),
        "role": "record-fallback",
        "fetchedAt": utc_now(),
        "contentHash": stable_hash(text),
        "text": text,
        "links": [],
    }


def bound_cached_bundle(
    bundle: dict[str, Any],
    max_pages: int,
    page_chars: int,
    total_chars: int,
) -> dict[str, Any]:
    public = [page for page in bundle.get("pages", []) if page.get("role") != "record-fallback"]
    fallback = [page for page in bundle.get("pages", []) if page.get("role") == "record-fallback"]
    pages = public[:max_pages] + fallback[:1]
    remaining = total_chars
    bounded = []
    for page in pages:
        copy = dict(page)
        maximum = min(page_chars, remaining) if page.get("role") != "record-fallback" else page_chars
        copy["text"] = str(page.get("text") or "")[:maximum]
        if copy["text"]:
            bounded.append(copy)
            if page.get("role") != "record-fallback":
                remaining -= len(copy["text"])
        if remaining <= 0:
            break
    public_count = sum(page.get("role") != "record-fallback" for page in bounded)
    return {
        **bundle,
        "sourceMode": "multi-page" if public_count > 1 else "single-page" if public_count == 1 else "record-fallback",
        "pages": bounded,
    }


def concise_error(error: Exception, maximum: int = 350) -> str:
    text = re.sub(r"\s+", " ", str(error)).strip()
    marker = text.find("Code context:")
    if marker >= 0:
        text = text[:marker].strip()
    return text[:maximum]


class ScholarshipCrawler:
    def __init__(self, page_chars: int, total_chars: int, max_pages: int, timeout_ms: int, record_only: bool = False):
        self.page_chars = page_chars
        self.total_chars = total_chars
        self.max_pages = max_pages
        self.timeout_ms = timeout_ms
        self.record_only = record_only
        self.crawler: Any = None
        self.run_config: Any = None

    async def __aenter__(self):
        if self.record_only:
            return self
        crawl_runtime = ROOT / "data" / "crawl4ai-runtime"
        profile_path = ROOT / "data" / "crawl4ai-profile-v4"
        crawl_runtime.mkdir(parents=True, exist_ok=True)
        profile_path.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("CRAWL4_AI_BASE_DIRECTORY", str(crawl_runtime))
        try:
            from crawl4ai import AsyncWebCrawler, CacheMode
            from crawl4ai.async_configs import BrowserConfig, CrawlerRunConfig
        except ImportError as error:
            raise RuntimeError(
                "Crawl4AI is missing. Run the setup command documented in README.md."
            ) from error
        browser_config = BrowserConfig(
            headless=True,
            verbose=False,
            use_persistent_context=True,
            user_data_dir=str(profile_path),
            enable_stealth=True,
            text_mode=True,
            max_pages_before_recycle=40,
        )
        self.run_config = CrawlerRunConfig(
            word_count_threshold=4,
            remove_overlay_elements=True,
            remove_consent_popups=True,
            process_iframes=False,
            exclude_all_images=True,
            exclude_social_media_links=True,
            cache_mode=CacheMode.BYPASS,
            page_timeout=self.timeout_ms,
            wait_until="domcontentloaded",
        )
        self.crawler = AsyncWebCrawler(config=browser_config)
        await self.crawler.start()
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        if self.crawler:
            await self.crawler.close()

    async def fetch(self, url: str, record: dict[str, Any], role: str) -> dict[str, Any]:
        await asyncio.to_thread(assert_public_url, url)
        result = await self.crawler.arun(url=url, config=self.run_config)
        if not getattr(result, "success", False):
            status = getattr(result, "status_code", "unknown")
            message = getattr(result, "error_message", "")
            raise RuntimeError(f"Crawl failed ({status}) for {url}: {message}")
        final_url = normalize_url(getattr(result, "url", None) or url)
        if not final_url:
            raise RuntimeError(f"Crawler returned an invalid final URL for {url}")
        await asyncio.to_thread(assert_public_url, final_url)
        text = trim_markdown(markdown_text(result), record, self.page_chars)
        if len(text) < 100:
            raise RuntimeError(f"Crawl returned insufficient text for {final_url}")
        links = extract_result_links(result, final_url)
        title = getattr(result, "metadata", None)
        if isinstance(title, dict):
            title = title.get("title")
        else:
            title = None
        return {
            "url": final_url,
            "title": str(title)[:500] if title else None,
            "role": role,
            "fetchedAt": utc_now(),
            "contentHash": stable_hash(text),
            "text": text,
            "links": links,
        }

    async def bundle(self, record: dict[str, Any]) -> dict[str, Any]:
        if self.record_only:
            return deterministic_bundle(record)
        fallback = fallback_page(record)
        pages: list[dict[str, Any]] = []
        warnings: list[str] = []
        seeds: list[str] = []
        for candidate in [
            record.get("applicationUrl"),
            record.get("sourceUrl"),
            *(record.get("sourceUrls") or []),
        ]:
            normalized = normalize_url(candidate)
            if normalized and normalized not in seeds:
                seeds.append(normalized)
        visited: set[str] = set()
        candidates: dict[str, tuple[int, str, str]] = {}

        for seed in seeds[:3]:
            if len(pages) >= self.max_pages:
                break
            try:
                page = await self.fetch(seed, record, "seed")
            except Exception as error:
                warnings.append(f"Seed crawl failed for {seed}: {concise_error(error)}")
                continue
            if page["url"] in visited:
                continue
            visited.add(page["url"])
            pages.append(page)
            seed_host = (urlparse(page["url"]).hostname or "").lower()
            discovered_links = [] if seed_host in AGGREGATOR_HOSTS else page.pop("links", [])
            for link in discovered_links:
                url = link["url"]
                if url in visited or not same_site(url, page["url"]):
                    continue
                score = link_score(url, link["label"], record)
                if score >= 6 and (url not in candidates or score > candidates[url][0]):
                    candidates[url] = (score, link["label"], page["url"])

        attempts = 0
        for url, (score, label, parent) in sorted(
            candidates.items(), key=lambda item: (-item[1][0], item[0])
        ):
            if len(pages) >= self.max_pages:
                break
            if attempts >= self.max_pages * 2:
                break
            if url in visited:
                continue
            visited.add(url)
            attempts += 1
            try:
                page = await self.fetch(url, record, role_for_url(url, label))
            except Exception as error:
                warnings.append(f"Relevant page crawl failed for {url}: {concise_error(error)}")
                continue
            if page["url"] in {existing["url"] for existing in pages}:
                continue
            page.pop("links", None)
            page["discoveredFrom"] = parent
            page["linkScore"] = score
            pages.append(page)

        total = sum(len(page["text"]) for page in pages)
        if total > self.total_chars:
            remaining = self.total_chars
            for page in pages:
                page["text"] = page["text"][:remaining]
                remaining -= len(page["text"])
                if remaining <= 0:
                    break
            pages = [page for page in pages if page["text"]]
        pages.append(fallback)
        public_count = len(pages) - 1
        return {
            "id": record["id"],
            "createdAt": utc_now(),
            "sourceMode": "multi-page" if public_count > 1 else "single-page" if public_count == 1 else "record-fallback",
            "warnings": warnings,
            "pages": pages,
        }


def source_document(bundle: dict[str, Any]) -> str:
    sections = []
    for index, page in enumerate(bundle["pages"], start=1):
        sections.append(
            f"=== SOURCE {index} ===\n"
            f"URL: {page['url']}\nROLE: {page['role']}\nTITLE: {page.get('title') or ''}\n"
            f"TEXT:\n{page['text']}"
        )
    return "\n\n".join(sections)


def source_line_score(line: str, page: dict[str, Any]) -> int:
    score = 0
    if IMPORTANT_TEXT.search(line):
        score += 20
    if re.search(r"(\$[\d,]+|\b\d{1,2}/\d{1,2}/\d{2,4}\b|\b20\d{2}\b)", line):
        score += 5
    if re.search(r"\b(scholarship|grant|applicant|student|winner|recipient)\b", line, re.IGNORECASE):
        score += 4
    title = str(page.get("title") or "")
    for term in re.findall(r"[a-z0-9]{4,}", title.lower()):
        if term in line.lower():
            score += 2
    if len(line) > 280:
        score -= 3
    return score


def filtered_source_text(page: dict[str, Any], max_chars: int) -> str:
    raw_lines = str(page.get("text") or "").splitlines()
    lines: list[tuple[int, int, str]] = []
    seen: set[str] = set()
    for index, raw in enumerate(raw_lines):
        line = re.sub(r"\s+", " ", raw).strip(" \t#*-|")
        key = line.casefold()
        if len(line) < 8 or key in seen:
            continue
        seen.add(key)
        score = source_line_score(line, page)
        if score > 0 or len(lines) < 8:
            lines.append((score, index, line[:700]))
    if not lines:
        return ""
    first_lines = [item for item in lines if item[1] < 8]
    important = sorted(lines, key=lambda item: (-item[0], item[1]))
    selected: list[tuple[int, str]] = []
    seen_indexes: set[int] = set()
    for _, index, line in first_lines + important:
        if index in seen_indexes:
            continue
        seen_indexes.add(index)
        selected.append((index, line))
    output = []
    total = 0
    for _, line in sorted(selected):
        if total + len(line) + 1 > max_chars:
            break
        output.append(line)
        total += len(line) + 1
    return "\n".join(output)


def concise_source_document(bundle: dict[str, Any], max_chars: int) -> str:
    document = source_document(bundle)
    if max_chars <= 0 or len(document) <= max_chars:
        return document
    pages = bundle.get("pages") or []
    if not pages:
        return document[:max_chars]
    page_budget = max(500, max_chars // max(1, len(pages)))
    sections = []
    for index, page in enumerate(pages, start=1):
        text = filtered_source_text(page, page_budget)
        if not text:
            continue
        sections.append(
            f"=== SOURCE {index} ===\n"
            f"URL: {page['url']}\nROLE: {page.get('role') or ''}\nTITLE: {page.get('title') or ''}\n"
            f"TEXT:\n{text}"
        )
    concise = "\n\n".join(sections)
    return concise[:max_chars] if concise else document[:max_chars]


def parse_json_object(text: str) -> dict[str, Any]:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*", "", stripped, flags=re.IGNORECASE)
        stripped = re.sub(r"\s*```$", "", stripped)
    try:
        value = json.loads(stripped)
        if isinstance(value, dict):
            return value
    except json.JSONDecodeError:
        pass
    start = stripped.find("{")
    if start < 0:
        raise ValueError("Model response contained no JSON object.")
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(stripped)):
        character = stripped[index]
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                value = json.loads(stripped[start:index + 1])
                if not isinstance(value, dict):
                    raise ValueError("Model JSON was not an object.")
                return value
    raise ValueError("Model response contained incomplete JSON.")


class GemmaClient:
    def __init__(
        self,
        keys: list[str],
        models: list[str],
        timeout: float,
        retries: int,
        delay: float,
        provider: str = "gemini",
    ):
        if not keys:
            raise RuntimeError("At least one model API key is required.")
        self.keys = keys
        self.models = models
        self.timeout = timeout
        self.retries = retries
        self.delay = delay
        self.provider = provider
        self.dns_lock = threading.Lock()
        self.key_lock = threading.Lock()
        self.next_key = 0

    def key_for_request(self) -> tuple[int, str]:
        with self.key_lock:
            index = self.next_key
            self.next_key = (self.next_key + 1) % len(self.keys)
        return index, self.keys[index]

    def wait_for_dns(self) -> None:
        last_error: OSError | None = None
        for attempt in range(6):
            try:
                with self.dns_lock:
                    socket.getaddrinfo(
                        "openrouter.ai" if self.provider == "openrouter" else "generativelanguage.googleapis.com",
                        443,
                        type=socket.SOCK_STREAM,
                    )
                return
            except OSError as error:
                last_error = error
                time.sleep(min(60, 5 * (2 ** attempt)) + random.random())
        raise RuntimeError(f"Model API DNS resolution failed after retries: {last_error}")

    def generate(self, prompt: str, max_tokens: int = 32768) -> tuple[dict[str, Any], str]:
        last_error: Exception | None = None
        for model_index, model in enumerate(self.models):
            model_id = model.removeprefix("models/")
            if self.provider == "openrouter":
                body = json.dumps({
                    "model": model_id,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0,
                    "max_tokens": max_tokens,
                    "response_format": {"type": "json_object"},
                }).encode("utf-8")
                endpoint = "https://openrouter.ai/api/v1/chat/completions"
                headers = {
                    "Authorization": f"Bearer {self.keys[0]}",
                    "Content-Type": "application/json",
                    "X-OpenRouter-Title": "OpenScholar Index Enrichment",
                }
            else:
                body = json.dumps({
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {"temperature": 0, "maxOutputTokens": max_tokens},
                }).encode("utf-8")
                endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{model_id}:generateContent"
                headers = None
            for attempt in range(self.retries + 1):
                key_index, key = self.key_for_request()
                self.wait_for_dns()
                request = Request(
                    endpoint,
                    data=body,
                    headers=headers or {"x-goog-api-key": key, "Content-Type": "application/json"},
                    method="POST",
                )
                try:
                    with urlopen(request, timeout=self.timeout) as response:
                        payload = json.loads(response.read().decode("utf-8"))
                    if self.provider == "openrouter":
                        choices = payload.get("choices") or []
                        if not choices:
                            raise ValueError(f"{model_id} returned no choices.")
                        response_text = choices[0].get("message", {}).get("content") or ""
                        used_model = payload.get("model") or model_id
                    else:
                        candidates = payload.get("candidates") or []
                        if not candidates:
                            raise ValueError(f"{model_id} returned no candidates.")
                        parts = candidates[0].get("content", {}).get("parts", [])
                        response_text = "".join(part.get("text", "") for part in parts if not part.get("thought"))
                        used_model = model_id
                    return parse_json_object(response_text), used_model
                except HTTPError as error:
                    detail = error.read().decode("utf-8", errors="replace")
                    last_error = RuntimeError(f"{model_id} failed ({error.code}): {detail[:700]}")
                    if error.code == 429:
                        retry_after = float(error.headers.get("Retry-After", "0") or 0)
                        if attempt < self.retries and 0 < retry_after <= 60:
                            time.sleep(retry_after)
                            continue
                        if '"provider_name"' in detail and model_index < len(self.models) - 1:
                            break
                        raise RateLimitError(str(last_error)) from error
                    if error.code not in {500, 502, 503, 504}:
                        raise last_error from error
                except (URLError, TimeoutError, json.JSONDecodeError, ValueError, KeyError) as error:
                    last_error = error
                if attempt < self.retries:
                    time.sleep(self.delay * (2 ** attempt) + random.random())
            append_jsonl(EVENTS, {
                "at": utc_now(),
                "event": "model_switch",
                "model": model_id,
                "keyIndex": key_index if "key_index" in locals() else None,
                "error": str(last_error),
            })
        raise RuntimeError(f"All configured models failed: {last_error}")


def gemini_api_keys() -> list[str]:
    keys: list[str] = []
    seen: set[str] = set()
    for name in ["GEMINI_API_KEY", *[f"GEMINI_API_KEY{index}" for index in range(1, 32)]]:
        value = os.environ.get(name, "").strip()
        if value and value not in seen:
            keys.append(value)
            seen.add(value)
    return keys


def fact_template(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": record["id"],
        "title": "",
        "provider": None,
        "description": "",
        "applicationUrl": None,
        "sourceUrl": None,
        "opens": None,
        "deadline": None,
        "deadlineType": "unknown",
        "programStatus": "uncertain",
        "statusReason": "",
        "statusEvidence": "",
        "statusSourceUrl": None,
        "award": {
            "minimum": None,
            "maximum": None,
            "varies": None,
            "renewable": None,
            "renewableYears": None,
            "totalMaximum": None,
            "awardCount": None,
            "fullTuition": None,
            "fullRide": None,
            "uses": [],
        },
        "application": {
            "essay": {"status": "unknown", "count": None, "evidence": "", "sourceUrl": None},
            "recommendations": {"status": "unknown", "count": None, "evidence": "", "sourceUrl": None},
            "transcript": {"status": "unknown", "evidence": "", "sourceUrl": None},
            "fafsa": {"status": "unknown", "evidence": "", "sourceUrl": None},
            "financialDocuments": {"status": "unknown", "evidence": "", "sourceUrl": None},
            "portfolio": {"status": "unknown", "evidence": "", "sourceUrl": None},
            "audition": {"status": "unknown", "evidence": "", "sourceUrl": None},
            "interview": {"status": "unknown", "evidence": "", "sourceUrl": None},
            "video": {"status": "unknown", "evidence": "", "sourceUrl": None},
            "workSample": {"status": "unknown", "evidence": "", "sourceUrl": None},
            "testScores": {"status": "unknown", "evidence": "", "sourceUrl": None},
            "resume": {"status": "unknown", "evidence": "", "sourceUrl": None},
            "nomination": {"status": "unknown", "evidence": "", "sourceUrl": None},
            "enrollmentVerification": {"status": "unknown", "evidence": "", "sourceUrl": None},
            "citizenshipDocumentation": {"status": "unknown", "evidence": "", "sourceUrl": None},
            "fee": {"status": "unknown", "amount": None, "evidence": "", "sourceUrl": None},
            "requiredDocuments": [],
            "instructions": [],
        },
        "eligibility": {
            "countries": [],
            "states": [],
            "counties": [],
            "cities": [],
            "regions": [],
            "grades": [],
            "degreeLevels": [],
            "fields": [],
            "minimumGpa": None,
            "maximumGpa": None,
            "minimumAge": None,
            "maximumAge": None,
            "citizenship": [],
            "enrollmentIntensity": "unknown",
            "institutions": [],
            "institutionTypes": [],
            "institutionDesignations": [],
            "employers": [],
            "unions": [],
            "tribes": [],
            "organizations": [],
            "medicalConditions": [],
            "exactCriteria": [],
        },
        "confidence": 0.0,
        "warnings": [],
    }


def facts_prompt(record: dict[str, Any], bundle: dict[str, Any]) -> str:
    template = fact_template(record)
    return "\n\n".join(
        [
            "You are a meticulous scholarship data extractor.",
            f"Today's date is {datetime.now(timezone.utc).date().isoformat()}.",
            "Extract all supported facts from every supplied source. Public website text is preferred; "
            "the record fallback is useful when a live page is unavailable.",
            "Use only explicit evidence. Unknown is valid: use null, [], or status='unknown'. "
            "Never turn missing information into false or 'not-required'.",
            "Dates must be YYYY-MM-DD only when the year is explicit. A recurring month/day without a "
            "confirmed current year is not a fixed date; preserve it in exactCriteria and warn.",
            "programStatus is active, inactive, or uncertain. Use inactive for explicit discontinuation, "
            "a final offering year in the past, or a closed program. Use active only with current-cycle "
            "evidence. Both active and inactive require statusEvidence and statusSourceUrl; otherwise uncertain.",
            "Amounts are numeric US-dollar values without symbols. Do not confuse award count with amount.",
            "For application statuses use only required, not-required, optional, unknown. "
            "not-required requires explicit language. Count is null unless explicit. Every non-unknown "
            "application status must include a short exact source excerpt in evidence and its source URL. "
            "If you cannot quote support, status must be unknown.",
            "Retain exact majors, diagnoses, institutions, employers, unions, tribes, and organizations.",
            "Grade values must use only: " + ", ".join(sorted(CANONICAL_GRADES)) + ".",
            "Description must be a concise factual 1-3 sentence summary, not marketing copy.",
            "Do not classify tags in this pass.",
            "Return ONLY one JSON object matching the template exactly. Do not use Markdown.",
            f"REQUIRED TEMPLATE:\n{json.dumps(template, ensure_ascii=True)}",
            f"CURRENT RECORD FOR IDENTITY AND FALLBACK:\n{json.dumps(compact_record(record), ensure_ascii=True)}",
            f"SOURCES:\n{source_document(bundle)}",
        ]
    )


def taxonomy_definitions(taxonomy: dict[str, Any]) -> str:
    return compact_taxonomy_definitions(taxonomy)


TAG_STOPWORDS = {
    "student", "students", "scholarship", "scholarships", "applicant", "applicants",
    "eligible", "eligibility", "required", "preferred", "selection", "program",
    "award", "awards", "support", "supports", "direct", "explicit", "explicitly",
    "affects", "considered", "current", "application",
}


def normalized_corpus(value: str) -> str:
    return " " + re.sub(r"[^a-z0-9]+", " ", value.casefold()) + " "


def tag_terms(tag: dict[str, Any]) -> list[str]:
    text = " ".join([
        tag["id"].replace("-", " "),
        tag.get("label") or "",
        tag.get("definition") or "",
    ])
    terms = []
    for term in re.findall(r"[a-z0-9]{3,}", text.casefold()):
        if term not in TAG_STOPWORDS and term not in terms:
            terms.append(term)
    return terms


def candidate_tag_ids(
    record: dict[str, Any],
    bundle: dict[str, Any],
    taxonomy: dict[str, Any],
    limit: int = 125,
) -> list[str]:
    corpus = normalized_corpus(
        json.dumps(compact_record(record), ensure_ascii=True)
        + "\n"
        + "\n".join(str(page.get("text") or "") for page in bundle.get("pages", []))
    )
    tags = {tag["id"]: tag for tag in taxonomy["tags"]}
    always = {
        tag["id"]
        for tag in taxonomy["tags"]
        if tag["category"] in {
            "application",
            "award-program",
            "selection",
            "pathway",
            "affiliation",
            "activity",
            "military-public-safety",
        }
    }
    always.add("scholarship")
    scores: dict[str, int] = {tag_id: 0 for tag_id in tags}
    for alias, tag_id in taxonomy.get("aliases", {}).items():
        if tag_id in scores and normalized_corpus(alias.replace("-", " ")) in corpus:
            scores[tag_id] += 40
    for tag_id, tag in tags.items():
        phrases = [tag_id.replace("-", " "), str(tag.get("label") or "")]
        for phrase in phrases:
            normalized = normalized_corpus(phrase)
            if len(normalized.strip()) > 2 and normalized in corpus:
                scores[tag_id] += 60
        for term in tag_terms(tag):
            if f" {term} " in corpus:
                scores[tag_id] += 4
    selected = set(always)
    ranked = sorted(scores.items(), key=lambda item: (-item[1], item[0]))
    for tag_id, score in ranked:
        if score > 0:
            selected.add(tag_id)
        if len(selected) >= limit:
            break
    changed = True
    while changed:
        changed = False
        for tag_id in list(selected):
            for parent in tags.get(tag_id, {}).get("implies", []):
                if parent not in selected:
                    selected.add(parent)
                    changed = True
    return [
        tag["id"]
        for tag in taxonomy["tags"]
        if tag["id"] in selected
    ]


def compact_taxonomy_definitions(taxonomy: dict[str, Any], tag_ids: set[str] | None = None) -> str:
    return "\n".join(
        f"- {tag['id']}: {tag['definition']}"
        for tag in taxonomy["tags"]
        if tag_ids is None or tag["id"] in tag_ids
    )


def sparse_facts_contract() -> str:
    return (
        "Return sparse facts: omit unknown/null/empty/default fields. "
        "facts keys: title, provider, description, applicationUrl, sourceUrl, opens, deadline, "
        "deadlineType, programStatus, statusReason, statusEvidence, statusSourceUrl, award, "
        "application, eligibility, confidence, warnings. "
        "award keys: minimum, maximum, varies, renewable, renewableYears, totalMaximum, awardCount, "
        "fullTuition, fullRide, uses. "
        "application keys: essay, recommendations, transcript, fafsa, financialDocuments, portfolio, "
        "audition, interview, video, workSample, testScores, resume, nomination, "
        "enrollmentVerification, citizenshipDocumentation, fee, requiredDocuments, instructions. "
        "Requirement value: {status:'required|not-required|optional|unknown', count?, amount?, "
        "evidence:'exact excerpt', sourceUrl:'url'}. "
        "eligibility keys: countries, states, counties, cities, regions, grades, degreeLevels, fields, "
        "minimumGpa, maximumGpa, minimumAge, maximumAge, citizenship, enrollmentIntensity, "
        "institutions, institutionTypes, institutionDesignations, employers, unions, tribes, "
        "organizations, medicalConditions, exactCriteria. "
        "Grade values only: " + ", ".join(sorted(CANONICAL_GRADES)) + "."
    )


def classification_prompt(
    record: dict[str, Any],
    facts: dict[str, Any],
    bundle: dict[str, Any],
    taxonomy: dict[str, Any],
) -> str:
    return "\n\n".join(
        [
            "You are a high-precision scholarship classifier using a CLOSED taxonomy.",
            "Assign EVERY supported canonical tag and NO unsupported tag.",
            "Each assignment needs relationship eligible|required|preferred|descriptive, a short exact or "
            "near-verbatim evidence excerpt, and the source URL containing that evidence.",
            "Use required only for a mandatory eligibility or application condition. Use preferred when a "
            "factor is considered in selection but is not mandatory. Use eligible for an allowed audience "
            "or pathway and descriptive for award/program characteristics.",
            "Do not infer identity eligibility from a provider name or mission statement.",
            "Do not infer application requirements from silence. no-essay and no-application-fee require "
            "explicit current evidence.",
            "Specific field tags should be assigned when explicit. Parent implications are added later.",
            "Selection criteria describe what affects eligibility or selection, not generic praise.",
            "Return ONLY: "
            '{"id":"record-id","assignments":[{"tag":"canonical-id","relationship":"required",'
            '"evidence":"short excerpt","sourceUrl":"source URL or null"}],"confidence":0.0,"warnings":[]}.',
            f"TAXONOMY POLICY:\n{json.dumps(taxonomy['policy'], ensure_ascii=True)}",
            f"CANONICAL TAGS:\n{taxonomy_definitions(taxonomy)}",
            f"EXTRACTED FACTS:\n{json.dumps(facts, ensure_ascii=True)}",
            f"SOURCES:\n{source_document(bundle)}",
        ]
    )


def combined_prompt(
    record: dict[str, Any],
    bundle: dict[str, Any],
    taxonomy: dict[str, Any],
    source_chars: int = 0,
) -> str:
    candidate_ids = set(candidate_tag_ids(record, bundle, taxonomy))
    return "\n\n".join(
        [
            "You are a meticulous scholarship data extractor and high-precision classifier.",
            f"Today's date is {datetime.now(timezone.utc).date().isoformat()}.",
            "Extract explicit facts and assign supported tags from the closed candidate list only.",
            "Unknowns stay omitted. Never infer a negative from silence.",
            "Dates are YYYY-MM-DD only when the year is explicit. A passed deadline alone does not "
            "make a program inactive.",
            "programStatus active/inactive requires explicit current-cycle or permanent-closure evidence; "
            "otherwise omit it.",
            "Tag assignments require an exact or near-verbatim excerpt and source URL. Identity tags "
            "require explicit applicant eligibility or preference. Provider mission is insufficient.",
            "Use required only for mandatory conditions, preferred for selection considerations, "
            "eligible for allowed audiences/pathways, and descriptive for program characteristics.",
            "Every non-unknown application status needs evidence and sourceUrl. no-essay and "
            "no-application-fee require explicit current wording.",
            "Return ONLY JSON: "
            '{"facts":{},"classification":{"assignments":[{"tag":"tag-id","relationship":"required",'
            '"evidence":"exact excerpt","sourceUrl":"url"}],"confidence":0.0,"warnings":[]}}',
            f"FACT CONTRACT:\n{sparse_facts_contract()}",
            f"CANDIDATE TAGS:\n{compact_taxonomy_definitions(taxonomy, candidate_ids)}",
            f"CURRENT RECORD:\n{json.dumps(compact_record(record), ensure_ascii=True)}",
            f"SOURCES:\n{concise_source_document(bundle, source_chars)}",
        ]
    )


def combined_batch_prompt(
    items: list[tuple[dict[str, Any], dict[str, Any]]],
    taxonomy: dict[str, Any],
    source_chars: int,
) -> str:
    candidate_ids = set()
    for record, bundle in items:
        candidate_ids.update(candidate_tag_ids(record, bundle, taxonomy))
    records = [
        {
            "id": record["id"],
            "currentRecord": compact_record(record),
            "candidateTags": candidate_tag_ids(record, bundle, taxonomy),
            "sources": concise_source_document(bundle, source_chars),
        }
        for record, bundle in items
    ]
    return "\n\n".join([
        "You are a meticulous scholarship data extractor and high-precision classifier.",
        f"Today's date is {datetime.now(timezone.utc).date().isoformat()}.",
        "Process EVERY supplied scholarship independently. Do not merge evidence across records.",
        "For each scholarship, extract typed facts and assign supported tags from the CLOSED taxonomy.",
        "Use only explicit source evidence. Unknown is valid. Never infer a negative from silence.",
        "Every non-unknown application status must include evidence and sourceUrl.",
        "Tag assignments require an exact or near-verbatim excerpt and source URL.",
        "Use only each record's candidateTags.",
        "Return ONLY one JSON object with exactly one top-level key: records.",
        "records must contain exactly one object per input id, each with id, facts, and classification.",
        'Output item shape: {"id":"record-id","facts":{},"classification":{"assignments":[],'
        '"confidence":0.0,"warnings":[]}}.',
        f"FACT CONTRACT:\n{sparse_facts_contract()}",
        f"CANDIDATE TAGS:\n{compact_taxonomy_definitions(taxonomy, candidate_ids)}",
        f"INPUT RECORDS:\n{json.dumps(records, ensure_ascii=True)}",
    ])


def batch_records(raw: dict[str, Any]) -> dict[str, dict[str, Any]]:
    records = raw.get("records")
    if not isinstance(records, list):
        raise ValueError("Batch response omitted records.")
    return {
        record["id"]: record
        for record in records
        if isinstance(record, dict) and isinstance(record.get("id"), str)
    }


def clean_string(value: Any, maximum: int = 1000) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:maximum]


def string_list(value: Any, maximum_items: int = 100, maximum_length: int = 500) -> list[str]:
    if not isinstance(value, list):
        return []
    result = []
    seen = set()
    for item in value:
        cleaned = clean_string(item, maximum_length)
        key = cleaned.casefold()
        if cleaned and key not in seen:
            seen.add(key)
            result.append(cleaned)
        if len(result) >= maximum_items:
            break
    return result


def nullable_number(value: Any, minimum: float = 0, maximum: float | None = None) -> float | int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number < minimum or (maximum is not None and number > maximum):
        return None
    return int(number) if number.is_integer() else number


def nullable_boolean(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def valid_date(value: Any) -> str | None:
    cleaned = clean_string(value, 10)
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", cleaned):
        return None
    try:
        datetime.strptime(cleaned, "%Y-%m-%d")
        return cleaned
    except ValueError:
        return None


def normalize_grades(value: Any) -> list[str]:
    aliases = {
        "community college freshman": "Community College Student",
        "community college sophomore": "Community College Student",
        "5th year college undergraduate": "Undergraduate",
        "nth year college undergraduate": "Undergraduate",
        "post-secondary student": "Undergraduate",
        "postsecondary student": "Undergraduate",
        "doctoral candidate": "Doctoral Student",
    }
    result = []
    for grade in string_list(value, 40):
        canonical = aliases.get(grade.casefold(), grade)
        if canonical in CANONICAL_GRADES and canonical not in result:
            result.append(canonical)
    return result


def normalized_words(value: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", value.casefold())


def evidence_supported(evidence: str, text: str) -> bool:
    normalized_evidence = " ".join(normalized_words(evidence))
    normalized_text = " ".join(normalized_words(text))
    if len(normalized_evidence) >= 10 and normalized_evidence in normalized_text:
        return True
    if re.search(r"\.{2,}|…", evidence):
        segments = [
            " ".join(normalized_words(segment))
            for segment in re.split(r"\.{2,}|…", evidence)
        ]
        segments = [segment for segment in segments if segment]
        if segments:
            position = 0
            for segment in segments:
                found = normalized_text.find(segment, position)
                if found < 0:
                    break
                position = found + len(segment)
            else:
                return sum(len(normalized_words(segment)) for segment in segments) >= 2
    evidence_words = normalized_words(evidence)
    text_words = set(normalized_words(text))
    if len(evidence_words) < 8:
        return False
    overlap = sum(word in text_words for word in evidence_words) / len(evidence_words)
    has_contiguous_quote = any(
        " ".join(evidence_words[index:index + 8]) in normalized_text
        for index in range(len(evidence_words) - 7)
    )
    return overlap >= 0.75 and has_contiguous_quote


def requirement(
    value: Any,
    source_map: dict[str, str],
    count: bool = False,
) -> dict[str, Any]:
    value = value if isinstance(value, dict) else {}
    status = value.get("status")
    status = status if status in REQUIREMENT_STATUSES else "unknown"
    evidence = clean_string(value.get("evidence"), 500)
    source_url = value.get("sourceUrl")
    supported = False
    if status == "unknown":
        supported = True
    elif source_url in source_map:
        supported = evidence_supported(evidence, source_map[source_url])
    else:
        supported = any(evidence_supported(evidence, text) for text in source_map.values())
    result: dict[str, Any] = {"status": status if supported else "unknown"}
    if count:
        numeric = nullable_number(value.get("count"), 0, 100)
        result["count"] = int(numeric) if numeric is not None and supported else None
    return result


def normalize_facts(
    raw: dict[str, Any],
    record: dict[str, Any],
    bundle: dict[str, Any] | None = None,
) -> dict[str, Any]:
    template = fact_template(record)
    award = raw.get("award") if isinstance(raw.get("award"), dict) else {}
    application = raw.get("application") if isinstance(raw.get("application"), dict) else {}
    eligibility = raw.get("eligibility") if isinstance(raw.get("eligibility"), dict) else {}
    source_map = source_text_map(bundle) if bundle else {}
    existing_eligibility = record.get("eligibility") or {}
    program_status = raw.get("programStatus")
    status_evidence = clean_string(raw.get("statusEvidence"), 500)
    status_source = raw.get("statusSourceUrl")
    status_supported = (
        program_status == "uncertain"
        or (
            program_status in {"active", "inactive"}
            and (
                (
                    status_source in source_map
                    and evidence_supported(status_evidence, source_map[status_source])
                )
                or any(evidence_supported(status_evidence, text) for text in source_map.values())
            )
        )
    )
    status_downgraded = False
    if program_status == "active" and status_supported:
        deadline = valid_date(raw.get("deadline"))
        evidence_lower = status_evidence.casefold()
        current_year = datetime.now(timezone.utc).year
        current_signal = (
            str(current_year) in evidence_lower
            or str(current_year + 1) in evidence_lower
            or bool(re.search(r"\b(currently accepting|applications? (?:are|is) open|now open|open now)\b", evidence_lower))
        )
        if (deadline and deadline < datetime.now(timezone.utc).date().isoformat()) or not current_signal:
            program_status = "uncertain"
            status_downgraded = True
    if program_status == "inactive" and status_supported:
        permanent_signal = bool(
            re.search(
                r"\b(discontinued|no longer offered|will not be offered|final (?:year|offering)|"
                r"last (?:year|offering)|program (?:has )?ended|permanently closed|terminated)\b",
                status_evidence.casefold(),
            )
        )
        if not permanent_signal:
            program_status = "uncertain"
            status_downgraded = True
    facts = {
        "id": record["id"],
        "title": clean_string(raw.get("title") or record.get("title"), 500),
        "provider": clean_string(raw.get("provider") or record.get("provider"), 500) or None,
        "description": clean_string(raw.get("description") or record.get("description"), 3000),
        "applicationUrl": normalize_url(raw.get("applicationUrl")) or normalize_url(record.get("applicationUrl")),
        "sourceUrl": normalize_url(raw.get("sourceUrl")) or normalize_url(record.get("sourceUrl")),
        "opens": valid_date(raw.get("opens")),
        "deadline": valid_date(raw.get("deadline")),
        "deadlineType": (
            "fixed"
            if valid_date(raw.get("deadline"))
            else raw.get("deadlineType")
            if raw.get("deadlineType") in DEADLINE_TYPES
            else "unknown"
        ),
        "programStatus": program_status if status_supported and program_status in {"active", "inactive", "uncertain"} else "uncertain",
        "statusReason": (
            clean_string(
                (
                    "Current application cycle could not be confirmed. "
                    if status_downgraded
                    else ""
                )
                + str(raw.get("statusReason") or ""),
                1000,
            )
            if status_supported
            else ""
        ),
        "award": {
            "minimum": nullable_number(award.get("minimum"), 0, 1_000_000_000),
            "maximum": nullable_number(award.get("maximum"), 0, 1_000_000_000),
            "varies": nullable_boolean(award.get("varies")),
            "renewable": nullable_boolean(award.get("renewable")),
            "renewableYears": nullable_number(award.get("renewableYears"), 1, 20),
            "totalMaximum": nullable_number(award.get("totalMaximum"), 0, 1_000_000_000),
            "awardCount": nullable_number(award.get("awardCount"), 1, 1_000_000),
            "fullTuition": nullable_boolean(award.get("fullTuition")),
            "fullRide": nullable_boolean(award.get("fullRide")),
            "uses": string_list(award.get("uses"), 30),
        },
        "application": {
            "essay": requirement(application.get("essay"), source_map, True),
            "recommendations": requirement(application.get("recommendations"), source_map, True),
            **{
                name: requirement(application.get(name), source_map)
                for name in (
                    "transcript",
                    "fafsa",
                    "financialDocuments",
                    "portfolio",
                    "audition",
                    "interview",
                    "video",
                    "workSample",
                    "testScores",
                    "resume",
                    "nomination",
                    "enrollmentVerification",
                    "citizenshipDocumentation",
                )
            },
            "fee": {
                **requirement(application.get("fee"), source_map),
                "amount": nullable_number(
                    (application.get("fee") or {}).get("amount")
                    if isinstance(application.get("fee"), dict)
                    else None,
                    0,
                    100_000,
                ),
            },
            "requiredDocuments": string_list(application.get("requiredDocuments"), 50),
            "instructions": string_list(application.get("instructions"), 50),
        },
        "eligibility": {
            **{
                name: (
                    normalize_grades(eligibility.get(name))
                    if name == "grades"
                    else string_list(
                        [
                            *(eligibility.get(name) if isinstance(eligibility.get(name), list) else []),
                            *(
                                existing_eligibility.get("other", [])
                                if name == "exactCriteria"
                                else []
                            ),
                        ],
                        100,
                    )
                )
                for name in (
                    "countries",
                    "states",
                    "counties",
                    "cities",
                    "regions",
                    "grades",
                    "degreeLevels",
                    "fields",
                    "citizenship",
                    "institutions",
                    "institutionTypes",
                    "institutionDesignations",
                    "employers",
                    "unions",
                    "tribes",
                    "organizations",
                    "medicalConditions",
                    "exactCriteria",
                )
            },
            "minimumGpa": nullable_number(eligibility.get("minimumGpa"), 0, 5),
            "maximumGpa": nullable_number(eligibility.get("maximumGpa"), 0, 5),
            "minimumAge": nullable_number(eligibility.get("minimumAge"), 0, 120),
            "maximumAge": nullable_number(eligibility.get("maximumAge"), 0, 120),
            "enrollmentIntensity": (
                eligibility.get("enrollmentIntensity")
                if eligibility.get("enrollmentIntensity") in ENROLLMENT_INTENSITIES
                else "unknown"
            ),
        },
        "confidence": nullable_number(raw.get("confidence"), 0, 1) or 0.0,
        "warnings": string_list(raw.get("warnings"), 50),
    }
    if facts["award"]["minimum"] is not None and facts["award"]["maximum"] is not None:
        if facts["award"]["minimum"] > facts["award"]["maximum"]:
            facts["award"]["minimum"], facts["award"]["maximum"] = (
                facts["award"]["maximum"],
                facts["award"]["minimum"],
            )
    for name in ("renewableYears", "awardCount"):
        if facts["award"][name] is not None:
            facts["award"][name] = int(facts["award"][name])
    for name in ("minimumAge", "maximumAge"):
        if facts["eligibility"][name] is not None:
            facts["eligibility"][name] = int(facts["eligibility"][name])
    if not facts["title"]:
        facts["title"] = template["title"] or record["title"]
    return facts


def source_text_map(bundle: dict[str, Any]) -> dict[str, str]:
    return {page["url"]: re.sub(r"\s+", " ", page["text"]).casefold() for page in bundle["pages"]}


def normalize_classification(
    raw: dict[str, Any],
    facts: dict[str, Any],
    bundle: dict[str, Any],
    taxonomy: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    tags = {tag["id"]: tag for tag in taxonomy["tags"]}
    source_map = source_text_map(bundle)
    warnings: list[str] = []
    assignments: dict[str, dict[str, Any]] = {}
    for value in raw.get("assignments") if isinstance(raw.get("assignments"), list) else []:
        if not isinstance(value, dict):
            continue
        tag_id = value.get("tag")
        relationship = value.get("relationship")
        evidence = clean_string(value.get("evidence"), 500)
        source_url = value.get("sourceUrl")
        if tag_id not in tags or relationship not in RELATIONSHIPS or not evidence:
            continue
        if tag_id == "employee" and re.search(
            r"\b(parents?|guardians?|spouses?|children|child|dependents?|family)\b.*\bemploy",
            evidence.casefold(),
        ):
            warnings.append("Rejected employee: evidence describes family employment.")
            continue
        default_relationship = tags[tag_id].get("assignment")
        if default_relationship in {"required", "descriptive"}:
            relationship = default_relationship
        if source_url not in source_map or not evidence_supported(evidence, source_map[source_url]):
            matching = [url for url, text in source_map.items() if evidence_supported(evidence, text)]
            source_url = matching[0] if matching else None
        if source_url is None:
            warnings.append(f"Rejected {tag_id}: evidence was not found in a source.")
            continue
        if tags[tag_id].get("requiresExplicitEvidence"):
            corpus = " ".join(source_map.values())
            explicit_patterns = {
                "no-essay": r"\b(no essay|essay (?:is )?not required|without an essay|essay required\s*[:\-]?\s*no)\b",
                "no-application-fee": r"\b(no (?:application )?fee|fee (?:is )?not required|free to apply)\b",
            }
            if not re.search(explicit_patterns[tag_id], corpus, re.IGNORECASE):
                warnings.append(f"Rejected {tag_id}: no explicit source phrase.")
                continue
        assignments[tag_id] = {
            "tag": tag_id,
            "relationship": relationship,
            "evidence": evidence,
            "sourceUrl": source_url,
        }

    derived = {
        "essay-required": facts["application"]["essay"]["status"] == "required",
        "no-essay": facts["application"]["essay"]["status"] == "not-required",
        "recommendation-required": facts["application"]["recommendations"]["status"] == "required",
        "transcript-required": facts["application"]["transcript"]["status"] == "required",
        "fafsa-required": facts["application"]["fafsa"]["status"] == "required",
        "financial-documents-required": facts["application"]["financialDocuments"]["status"] == "required",
        "portfolio-required": facts["application"]["portfolio"]["status"] == "required",
        "audition-required": facts["application"]["audition"]["status"] == "required",
        "interview-required": facts["application"]["interview"]["status"] == "required",
        "video-required": facts["application"]["video"]["status"] == "required",
        "work-sample-required": facts["application"]["workSample"]["status"] == "required",
        "test-scores-required": facts["application"]["testScores"]["status"] == "required",
        "resume-required": facts["application"]["resume"]["status"] == "required",
        "nomination-required": facts["application"]["nomination"]["status"] == "required",
        "enrollment-verification-required": facts["application"]["enrollmentVerification"]["status"] == "required",
        "citizenship-documentation-required": facts["application"]["citizenshipDocumentation"]["status"] == "required",
        "application-fee": facts["application"]["fee"]["status"] == "required",
        "no-application-fee": facts["application"]["fee"]["status"] == "not-required",
        "renewable": facts["award"]["renewable"] is True,
        "one-time-award": facts["award"]["renewable"] is False,
        "full-tuition": facts["award"]["fullTuition"] is True,
        "full-ride": facts["award"]["fullRide"] is True,
        "institution-specific": bool(facts["eligibility"]["institutions"]),
        "part-time-eligible": facts["eligibility"]["enrollmentIntensity"] in {"part-time", "either"},
    }
    for tag_id, supported in derived.items():
        if not supported or tag_id in assignments:
            continue
        if tags[tag_id].get("requiresExplicitEvidence"):
            continue
        assignments[tag_id] = {
            "tag": tag_id,
            "relationship": tags[tag_id]["assignment"].replace("-or-preferred", ""),
            "evidence": "Derived from the corresponding explicitly extracted typed field.",
            "sourceUrl": None,
        }

    for positive, negative, field in (
        ("essay-required", "no-essay", "essay"),
        ("application-fee", "no-application-fee", "fee"),
    ):
        if positive not in assignments or negative not in assignments:
            continue
        status = facts["application"][field]["status"]
        if status == "required":
            assignments.pop(negative, None)
        elif status == "not-required":
            assignments.pop(positive, None)
        else:
            assignments.pop(positive, None)
            assignments.pop(negative, None)
        warnings.append(f"Resolved contradictory assignments: {positive} and {negative}.")

    criteria = facts["eligibility"]["exactCriteria"]
    for criterion in criteria:
        lowered = criterion.casefold()
        tag_id = None
        family_employment = (
            re.search(r"\b(parents?|guardians?|spouses?|children|child|dependents?|family)\b", lowered)
            and re.search(r"\bemploy(?:ed|ee|ees|ment)?\b", lowered)
        )
        if family_employment:
            tag_id = "employee-family"
        elif re.search(r"\b(applicant|candidate|student|must)\b.*\bemploy(?:ed|ee)\b", lowered):
            tag_id = "employee"
        if not tag_id or tag_id in assignments:
            continue
        matching = [url for url, text in source_map.items() if evidence_supported(criterion, text)]
        if matching:
            assignments[tag_id] = {
                "tag": tag_id,
                "relationship": "required",
                "evidence": criterion,
                "sourceUrl": matching[0],
            }

    changed = True
    while changed:
        changed = False
        for assignment in list(assignments.values()):
            for parent in tags[assignment["tag"]].get("implies", []):
                if parent not in assignments:
                    assignments[parent] = {
                        "tag": parent,
                        "relationship": assignment["relationship"],
                        "evidence": f"Implied by canonical tag {assignment['tag']}.",
                        "sourceUrl": assignment["sourceUrl"],
                    }
                    changed = True

    accepted_tags = set(assignments)
    warnings = [
        warning
        for warning in warnings
        if not (
            (match := re.match(r"Rejected ([a-z0-9-]+):", warning))
            and match.group(1) in accepted_tags
        )
    ]
    ordered = [assignments[tag_id] for tag_id in sorted(assignments)]
    backend = [assignment["tag"] for assignment in ordered]
    frontend = [tag_id for tag_id in backend if tags[tag_id].get("frontend")]
    return {
        "backendTags": backend,
        "frontendTags": frontend,
        "assignments": ordered,
    }, warnings


def reconcile_application_requirements(
    facts: dict[str, Any],
    classification: dict[str, Any],
) -> None:
    tags = set(classification["backendTags"])
    requirements = {
        "essay-required": ("essay", "required"),
        "no-essay": ("essay", "not-required"),
        "recommendation-required": ("recommendations", "required"),
        "transcript-required": ("transcript", "required"),
        "fafsa-required": ("fafsa", "required"),
        "financial-documents-required": ("financialDocuments", "required"),
        "portfolio-required": ("portfolio", "required"),
        "audition-required": ("audition", "required"),
        "interview-required": ("interview", "required"),
        "video-required": ("video", "required"),
        "work-sample-required": ("workSample", "required"),
        "test-scores-required": ("testScores", "required"),
        "resume-required": ("resume", "required"),
        "nomination-required": ("nomination", "required"),
        "enrollment-verification-required": ("enrollmentVerification", "required"),
        "citizenship-documentation-required": ("citizenshipDocumentation", "required"),
        "application-fee": ("fee", "required"),
        "no-application-fee": ("fee", "not-required"),
    }
    for tag, (field, status) in requirements.items():
        if tag in tags and facts["application"][field]["status"] == "unknown":
            facts["application"][field]["status"] = status
    if facts["application"]["essay"]["status"] == "required" and "no-essay" in tags:
        facts["application"]["essay"]["status"] = "unknown"
    if facts["application"]["fee"]["status"] == "required" and "no-application-fee" in tags:
        facts["application"]["fee"]["status"] = "unknown"


def merge_record_fallback_facts(
    facts: dict[str, Any],
    record: dict[str, Any],
) -> None:
    eligibility = facts.setdefault("eligibility", {})
    record_eligibility = record.get("eligibility") or {}
    eligibility["exactCriteria"] = string_list(
        [
            *(eligibility.get("exactCriteria") or []),
            *(record_eligibility.get("other") or []),
        ],
        100,
    )


def deterministic_bundle(record: dict[str, Any]) -> dict[str, Any]:
    eligibility = record.get("eligibility") or {}
    requirements = record.get("requirements") or {}
    lines = [
        f"Source record title: {record.get('title') or ''}",
        f"Source record provider: {record.get('provider') or ''}",
        f"Source record description: {record.get('description') or ''}",
    ]
    for tag in [*(record.get("tags") or []), *(eligibility.get("tags") or [])]:
        lines.append(f"Source record eligibility tag: {tag}")
    for name, value in requirements.items():
        lines.append(f"Source record requirement {name}: {value}")
    for field in eligibility.get("fields") or []:
        lines.append(f"Source record field: {field}")
    for criterion in eligibility.get("other") or []:
        lines.append(f"Source record criterion: {criterion}")
    text = "\n".join(lines) + "\n\nRAW RECORD:\n" + json.dumps(record, ensure_ascii=True)
    return {
        "id": record["id"],
        "createdAt": utc_now(),
        "sourceMode": "record-fallback",
        "warnings": ["Deterministic prefill from imported source record; no live-page AI extraction."],
        "pages": [{
            "url": f"record://{record['id']}",
            "title": record.get("title"),
            "role": "record-fallback",
            "fetchedAt": utc_now(),
            "contentHash": stable_hash(text),
            "text": text,
            "links": [],
        }],
    }


def deterministic_requirement(status: str, evidence: str, source_url: str, count: int | None = None) -> dict[str, Any]:
    value: dict[str, Any] = {"status": status, "evidence": evidence, "sourceUrl": source_url}
    if count is not None:
        value["count"] = count
    return value


def deterministic_raw_facts(record: dict[str, Any]) -> dict[str, Any]:
    requirements = record.get("requirements") or {}
    eligibility = record.get("eligibility") or {}
    source_url = f"record://{record['id']}"
    application: dict[str, Any] = {}
    if requirements.get("essay") is True:
        application["essay"] = deterministic_requirement(
            "required",
            "Source record requirement essay: True",
            source_url,
        )
    if requirements.get("fee") is True:
        application["fee"] = deterministic_requirement(
            "required",
            "Source record requirement fee: True",
            source_url,
        )
    elif requirements.get("fee") is False:
        application["fee"] = deterministic_requirement(
            "not-required",
            "Source record requirement fee: False",
            source_url,
        )
    return {
        "title": record.get("title"),
        "provider": record.get("provider"),
        "description": record.get("description"),
        "applicationUrl": record.get("applicationUrl"),
        "sourceUrl": record.get("sourceUrl"),
        "deadline": record.get("deadline"),
        "deadlineType": "fixed" if record.get("deadline") else "unknown",
        "award": record.get("award") or {},
        "application": application,
        "eligibility": {
            **eligibility,
            "exactCriteria": eligibility.get("other") or [],
        },
        "confidence": 0.72,
        "warnings": ["deterministic prefill"],
    }


def canonical_tag(tag_id: str, taxonomy: dict[str, Any]) -> str | None:
    tags = {tag["id"] for tag in taxonomy["tags"]}
    normalized = re.sub(r"[^a-z0-9]+", "-", str(tag_id).casefold()).strip("-")
    if normalized in tags:
        return normalized
    return taxonomy.get("aliases", {}).get(normalized)


def deterministic_assignments(record: dict[str, Any], taxonomy: dict[str, Any]) -> list[dict[str, Any]]:
    tags = {tag["id"]: tag for tag in taxonomy["tags"]}
    eligibility = record.get("eligibility") or {}
    requirements = record.get("requirements") or {}
    source_url = f"record://{record['id']}"
    assignments: dict[str, dict[str, Any]] = {}

    def add(tag_id: str, evidence: str, relationship: str | None = None) -> None:
        tag = canonical_tag(tag_id, taxonomy)
        if not tag or tag not in tags:
            return
        default = tags[tag].get("assignment")
        assignments[tag] = {
            "tag": tag,
            "relationship": relationship or ("eligible" if default == "eligible" else "descriptive" if default == "descriptive" else "required"),
            "evidence": evidence,
            "sourceUrl": source_url,
        }

    add("scholarship", "Source record title: " + str(record.get("title") or ""))
    for tag in [*(record.get("tags") or []), *(eligibility.get("tags") or [])]:
        add(tag, f"Source record eligibility tag: {tag}")
    if requirements.get("needBased") is True:
        add("financial-need", "Source record requirement needBased: True")
    if requirements.get("meritBased") is True:
        add("academic-merit", "Source record requirement meritBased: True")
    field_tags = [tag for tag in taxonomy["tags"] if tag["category"] == "field"]
    for field in eligibility.get("fields") or []:
        field_key = normalized_corpus(str(field))
        matched = canonical_tag(str(field), taxonomy)
        if not matched:
            for tag in field_tags:
                haystack = normalized_corpus(f"{tag['id']} {tag.get('label') or ''} {tag.get('definition') or ''}")
                if field_key.strip() and field_key in haystack:
                    matched = tag["id"]
                    break
        if matched:
            add(matched, f"Source record field: {field}", "eligible")
    criteria = " ".join(str(item) for item in eligibility.get("other") or [])
    criteria_lower = criteria.casefold()
    simple_patterns = {
        "community-service": r"\b(community service|volunteer)\b",
        "extracurricular-involvement": r"\b(extracurricular|school activit|campus activit)\b",
        "leadership": r"\bleadership\b",
        "financial-need": r"\bfinancial need\b",
        "academic-merit": r"\b(gpa|academic achievement|scholastic)\b",
        "first-generation": r"\bfirst[ -]generation\b",
        "part-time-eligible": r"\bpart[ -]?time\b",
    }
    for tag, pattern in simple_patterns.items():
        match = re.search(pattern, criteria_lower)
        if match:
            add(tag, "Source record criterion: " + criteria[:400])
    return list(assignments.values())


def final_record(
    original: dict[str, Any],
    facts: dict[str, Any],
    classification: dict[str, Any],
    bundle: dict[str, Any],
    model_names: list[str],
    input_digest: str,
    taxonomy: dict[str, Any],
    classification_raw: dict[str, Any],
    validation_warnings: list[str],
) -> dict[str, Any]:
    confidence_values = [
        facts.get("confidence"),
        nullable_number(classification_raw.get("confidence"), 0, 1),
    ]
    confidence_values = [float(value) for value in confidence_values if value is not None]
    confidence = sum(confidence_values) / len(confidence_values) if confidence_values else 0.0
    source_metadata = [
        {key: page.get(key) for key in ("url", "title", "role", "fetchedAt", "contentHash")}
        for page in bundle["pages"]
    ]
    warnings = string_list(
        [
            *bundle.get("warnings", []),
            *facts.pop("warnings", []),
            *string_list(classification_raw.get("warnings"), 50),
            *validation_warnings,
        ],
        100,
    )
    confidence = max(0.0, confidence - min(0.25, 0.04 * len(validation_warnings)))
    facts.pop("confidence", None)
    return {
        **facts,
        "classification": classification,
        "sources": source_metadata,
        "quality": {
            "confidence": round(confidence, 3),
            "warnings": warnings,
            "sourceMode": bundle["sourceMode"],
            "pipelineVersion": PIPELINE_VERSION,
            "taxonomyVersion": taxonomy["version"],
            "promptVersion": PROMPT_VERSION,
            "models": model_names,
            "inputHash": input_digest,
            "sourceSignature": source_signature(original),
            "enrichedAt": utc_now(),
            "originalSourceCheckedAt": original.get("sourceCheckedAt"),
        },
    }


def completed_inputs() -> set[tuple[str, str]]:
    return {
        (row.get("id"), row.get("inputHash"))
        for row in json_lines(PROGRESS)
        if row.get("stage") == "complete" and row.get("pipelineVersion") == PIPELINE_VERSION
    }


def latest_records() -> dict[str, dict[str, Any]]:
    return {row["id"]: row for row in json_lines(RECORDS) if row.get("id")}


def output_is_current(
    output: dict[str, Any] | None,
    source_record: dict[str, Any],
    taxonomy_version: int,
) -> bool:
    if not output:
        return False
    quality = output.get("quality") or {}
    if (
        quality.get("pipelineVersion") != PIPELINE_VERSION
        or quality.get("promptVersion") != PROMPT_VERSION
        or quality.get("taxonomyVersion") != taxonomy_version
    ):
        return False
    recorded_signature = quality.get("sourceSignature")
    if recorded_signature:
        return recorded_signature == source_signature(source_record)
    return quality.get("originalSourceCheckedAt") == source_record.get("sourceCheckedAt")


def output_is_prefill(output: dict[str, Any] | None) -> bool:
    return "deterministic-prefill" in ((output or {}).get("quality", {}).get("models") or [])


def progress_stage(record_id: str, digest: str, stage: str, **extra: Any) -> None:
    append_jsonl(
        PROGRESS,
        {
            "at": utc_now(),
            "id": record_id,
            "inputHash": digest,
            "pipelineVersion": PIPELINE_VERSION,
            "stage": stage,
            **extra,
        },
    )


def selected_records(
    catalog: list[dict[str, Any]],
    start_index: int,
    limit: int,
    only_ids: set[str],
    shard_count: int = 1,
    shard_index: int = 0,
) -> list[dict[str, Any]]:
    if shard_count < 1:
        raise ValueError("shard_count must be at least 1.")
    if shard_index < 0 or shard_index >= shard_count:
        raise ValueError("shard_index must be between 0 and shard_count - 1.")
    selected = sorted(catalog, key=lambda record: record.get("id", ""))
    if only_ids:
        selected = [record for record in selected if record.get("id") in only_ids]
    selected = selected[start_index:]
    if limit > 0:
        selected = selected[:limit]
    if shard_count > 1:
        selected = [
            record
            for index, record in enumerate(selected)
            if index % shard_count == shard_index
        ]
    return selected


async def run(args: argparse.Namespace) -> None:
    load_environment()
    if args.model_batch_size < 1:
        raise ValueError("--model-batch-size must be at least 1.")
    openrouter_key = os.environ.get("OPENROUTER_KEY", "").strip()
    provider = "openrouter" if openrouter_key else "gemini"
    keys = [openrouter_key] if openrouter_key else gemini_api_keys()
    if not keys:
        raise RuntimeError("OPENROUTER_KEY or GEMINI_API_KEY is required in .env.local, .env, or the environment.")
    catalog = load_source_catalog()
    taxonomy = load_json(TAXONOMY_PATH)
    load_json(SCHEMA_PATH)
    taxonomy_digest = stable_hash(taxonomy, 16)
    configured_openrouter_models = [
        value.strip()
        for value in os.environ.get("OPENROUTER_MODELS", "").split(",")
        if value.strip()
    ]
    default_models = (configured_openrouter_models or DEFAULT_OPENROUTER_MODELS) if provider == "openrouter" else DEFAULT_MODELS
    models = list(dict.fromkeys(args.model or default_models))
    current_outputs = latest_records()
    if args.upgrade_prefill:
        catalog = [record for record in catalog if output_is_prefill(current_outputs.get(record.get("id")))]
    only_ids = set(args.id or [])
    selected = selected_records(
        catalog,
        args.start_index,
        args.limit,
        only_ids,
        args.shard_count,
        args.shard_index,
    )
    completed = completed_inputs()
    latest_stage = {
        (row.get("id"), row.get("inputHash")): row.get("stage", "unknown")
        for row in json_lines(PROGRESS)
        if row.get("pipelineVersion") == PIPELINE_VERSION
    }
    legacy_crawl_cache = crawl_cache_index()
    legacy_fact_cache = model_cache_index(FACT_CACHE)
    legacy_classification_cache = model_cache_index(CLASSIFICATION_CACHE)
    legacy_combined_cache = model_cache_index(COMBINED_CACHE)
    client = GemmaClient(keys, models, args.model_timeout, args.retries, args.retry_delay, provider)
    counters = {"selected": len(selected), "complete": 0, "cached": 0, "failed": 0, "failedSkipped": 0}
    print(f"Selected {len(selected)} records; provider={provider}; models={','.join(models)}; keys={len(keys)}")

    lock_name = "run" if args.shard_count <= 1 else f"run-shard-{args.shard_index}-of-{args.shard_count}"
    if lock_name == "run":
        for shard_lock in OUTPUT_DIR.glob(".run-shard-*.lock"):
            pid = active_lock(shard_lock)
            if pid:
                raise RuntimeError(f"Sharded v4 enrichment is active with PID {pid}.")
    with run_lock(lock_name):
        work: list[tuple[dict[str, Any], str, dict[str, Any]]] = []
        async with ScholarshipCrawler(
            page_chars=args.page_chars,
            total_chars=args.total_chars,
            max_pages=args.max_pages,
            timeout_ms=args.crawl_timeout_ms,
            record_only=args.record_only,
        ) as crawler:
            crawl_semaphore = asyncio.Semaphore(args.crawl_workers)

            async def prepare_record(
                offset: int,
                record: dict[str, Any],
            ) -> tuple[dict[str, Any], str, dict[str, Any]] | None:
                digest = input_hash(record, taxonomy_digest)
                if latest_stage.get((record["id"], digest)) == "failed" and not args.retry_failed and not args.force:
                    counters["failedSkipped"] += 1
                    return None
                if (
                    (
                        (record["id"], digest) in completed
                        or output_is_current(
                            current_outputs.get(record["id"]),
                            record,
                            taxonomy["version"],
                        )
                    )
                    and not args.force
                    and not (args.upgrade_prefill and output_is_prefill(current_outputs.get(record["id"])))
                ):
                    counters["complete"] += 1
                    return None
                if args.record_only:
                    print(f"[record-only {offset}/{len(selected)}] {record['id']} | {record.get('title')}")
                    return record, digest, deterministic_bundle(record)
                async with crawl_semaphore:
                    crawl_path = CRAWL_CACHE / f"{crawl_hash(record)}.json"
                    try:
                        cached_path = (
                            crawl_path
                            if crawl_path.exists()
                            else legacy_crawl_cache.get(record["id"])
                        )
                        if cached_path and not args.recrawl:
                            print(f"[crawl-cache {offset}/{len(selected)}] {record['id']} | {record.get('title')}")
                            bundle = bound_cached_bundle(
                                load_json(cached_path),
                                args.max_pages,
                                args.page_chars,
                                args.total_chars,
                            )
                            if cached_path != crawl_path:
                                write_json_atomic(crawl_path, bundle)
                            counters["cached"] += 1
                        else:
                            print(f"[crawl {offset}/{len(selected)}] {record['id']} | {record.get('title')}")
                            bundle = await crawler.bundle(record)
                            write_json_atomic(crawl_path, bundle)
                        progress_stage(
                            record["id"],
                            digest,
                            "crawl",
                            sourceMode=bundle["sourceMode"],
                            pages=len(bundle["pages"]) - 1,
                        )
                        return record, digest, bundle
                    except Exception as error:
                        counters["failed"] += 1
                        progress_stage(record["id"], digest, "failed", error=str(error)[:2000])
                        print(f"  CRAWL FAILED: {concise_error(error)}")
                        if args.fail_fast:
                            raise
                        return None

            if args.stop_after_stage == "crawl":
                first = next(
                    (
                        (offset, record)
                        for offset, record in enumerate(selected, start=1)
                        if (
                            (record["id"], input_hash(record, taxonomy_digest)) not in completed
                            and not output_is_current(
                                current_outputs.get(record["id"]),
                                record,
                                taxonomy["version"],
                            )
                        )
                    ),
                    None,
                )
                if first:
                    prepared = await prepare_record(*first)
                    if prepared:
                        work.append(prepared)
                print("Intentional stop after crawl checkpoint.")
                return

            prepared_records = await asyncio.gather(
                *[
                    prepare_record(offset, record)
                    for offset, record in enumerate(selected, start=1)
                ]
            )
            work.extend(prepared for prepared in prepared_records if prepared is not None)

        semaphore = asyncio.Semaphore(args.workers)

        async def process_model(
            position: int,
            record: dict[str, Any],
            digest: str,
            bundle: dict[str, Any],
        ) -> None:
            fact_path = FACT_CACHE / f"{digest}.json"
            classification_path = CLASSIFICATION_CACHE / f"{digest}.json"
            combined_path = COMBINED_CACHE / f"{digest}.json"
            current_output = current_outputs.get(record["id"])
            can_migrate_legacy = output_is_current(
                current_output,
                record,
                taxonomy["version"],
            )
            cached_fact_path = (
                fact_path
                if fact_path.exists()
                else legacy_fact_cache.get(record["id"]) if can_migrate_legacy else None
            )
            cached_classification_path = (
                classification_path
                if classification_path.exists()
                else legacy_classification_cache.get(record["id"]) if can_migrate_legacy else None
            )
            cached_combined_path = (
                combined_path
                if combined_path.exists()
                else legacy_combined_cache.get(record["id"]) if can_migrate_legacy else None
            )
            async with semaphore:
                print(f"[model {position}/{len(work)}] {record['id']} | {record.get('title')}")
                try:
                    if cached_fact_path and not args.reextract:
                        facts = load_json(cached_fact_path)
                        if cached_fact_path != fact_path:
                            write_json_atomic(fact_path, facts)
                        fact_model = "cache"
                        counters["cached"] += 1
                        if cached_classification_path:
                            raw_classification = load_json(cached_classification_path)
                            if cached_classification_path != classification_path:
                                write_json_atomic(classification_path, raw_classification)
                            classification_model = "cache"
                            counters["cached"] += 1
                        elif cached_combined_path:
                            combined = load_json(cached_combined_path)
                            if cached_combined_path != combined_path:
                                write_json_atomic(combined_path, combined)
                            raw_classification = combined.get("classification")
                            if not isinstance(raw_classification, dict):
                                raise ValueError("Combined cache omitted classification.")
                            classification_model = "cache"
                            counters["cached"] += 1
                        else:
                            raw_classification, classification_model = await asyncio.to_thread(
                                client.generate,
                                classification_prompt(record, facts, bundle, taxonomy),
                            )
                            write_json_atomic(classification_path, raw_classification)
                    else:
                        if cached_combined_path and not args.reextract:
                            combined = load_json(cached_combined_path)
                            if cached_combined_path != combined_path:
                                write_json_atomic(combined_path, combined)
                            combined_model = "cache"
                            counters["cached"] += 1
                        else:
                            try:
                                if args.split_pass:
                                    raise RuntimeError("Split pass explicitly requested.")
                                combined, combined_model = await asyncio.to_thread(
                                    client.generate,
                                    combined_prompt(record, bundle, taxonomy, args.batch_source_chars),
                                    args.max_output_tokens,
                                )
                                write_json_atomic(combined_path, combined)
                            except Exception as combined_error:
                                if args.no_split_fallback:
                                    raise
                                print(
                                    f"  Combined pass failed for {record['id']}; "
                                    f"using split fallback: {concise_error(combined_error)}"
                                )
                                raw_facts, fact_model = await asyncio.to_thread(
                                    client.generate,
                                    facts_prompt(record, bundle),
                                    args.max_output_tokens,
                                )
                                facts = normalize_facts(raw_facts, record, bundle)
                                write_json_atomic(fact_path, facts)
                                raw_classification, classification_model = await asyncio.to_thread(
                                    client.generate,
                                    classification_prompt(record, facts, bundle, taxonomy),
                                    args.max_output_tokens,
                                )
                                write_json_atomic(classification_path, raw_classification)
                                combined = None
                        if combined is not None:
                            raw_facts = combined.get("facts")
                            raw_classification = combined.get("classification")
                            if not isinstance(raw_facts, dict) or not isinstance(raw_classification, dict):
                                raise ValueError("Combined model response omitted facts or classification.")
                            facts = normalize_facts(raw_facts, record, bundle)
                            write_json_atomic(fact_path, facts)
                            fact_model = combined_model
                            classification_model = combined_model
                    progress_stage(record["id"], digest, "facts", model=fact_model)
                    if args.stop_after_stage == "facts":
                        return
                    merge_record_fallback_facts(facts, record)
                    if raw_classification.get("id") not in {None, record["id"]}:
                        raise ValueError(
                            f"Classifier changed record id to {raw_classification.get('id')}"
                        )
                    classification, validation_warnings = normalize_classification(
                        raw_classification, facts, bundle, taxonomy
                    )
                    reconcile_application_requirements(facts, classification)
                    output = final_record(
                        record,
                        facts,
                        classification,
                        bundle,
                        [fact_model, classification_model],
                        digest,
                        taxonomy,
                        raw_classification,
                        validation_warnings,
                    )
                    append_jsonl(RECORDS, output)
                    progress_stage(
                        record["id"],
                        digest,
                        "complete",
                        tags=len(classification["backendTags"]),
                        confidence=output["quality"]["confidence"],
                        sourceMode=bundle["sourceMode"],
                    )
                    counters["complete"] += 1
                    if args.delay:
                        await asyncio.sleep(args.delay)
                except RateLimitError:
                    raise
                except Exception as error:
                    counters["failed"] += 1
                    progress_stage(record["id"], digest, "failed", error=str(error)[:2000])
                    append_jsonl(
                        EVENTS,
                        {"at": utc_now(), "event": "record_failed", "id": record["id"], "error": str(error)},
                    )
                    print(f"  MODEL FAILED {record['id']}: {concise_error(error)}")
                    if args.fail_fast:
                        raise

        async def process_model_batch(
            batch_number: int,
            batch: list[tuple[dict[str, Any], str, dict[str, Any]]],
        ) -> None:
            batch_error: Exception | None = None
            missing_batch: list[tuple[dict[str, Any], str, dict[str, Any]]] = []
            async with semaphore:
                print(f"[model-batch {batch_number}] {len(batch)} records")
                try:
                    raw_batch, batch_model = await asyncio.to_thread(
                        client.generate,
                        combined_batch_prompt(
                            [(record, bundle) for record, _, bundle in batch],
                            taxonomy,
                            args.batch_source_chars,
                        ),
                        args.max_output_tokens,
                    )
                    by_id = batch_records(raw_batch)
                    missing_batch = [item for item in batch if item[0]["id"] not in by_id]
                    for record, digest, bundle in batch:
                        if record["id"] not in by_id:
                            continue
                        item = by_id[record["id"]]
                        raw_facts = item.get("facts")
                        raw_classification = item.get("classification")
                        if not isinstance(raw_facts, dict) or not isinstance(raw_classification, dict):
                            raise ValueError(f"Batch response for {record['id']} omitted facts or classification.")
                        if raw_classification.get("id") not in {None, record["id"]}:
                            raise ValueError(f"Classifier changed record id to {raw_classification.get('id')}")
                        combined = {"facts": raw_facts, "classification": raw_classification}
                        write_json_atomic(COMBINED_CACHE / f"{digest}.json", combined)
                        facts = normalize_facts(raw_facts, record, bundle)
                        write_json_atomic(FACT_CACHE / f"{digest}.json", facts)
                        progress_stage(record["id"], digest, "facts", model=batch_model)
                        merge_record_fallback_facts(facts, record)
                        classification, validation_warnings = normalize_classification(
                            raw_classification, facts, bundle, taxonomy
                        )
                        reconcile_application_requirements(facts, classification)
                        output = final_record(
                            record,
                            facts,
                            classification,
                            bundle,
                            [batch_model],
                            digest,
                            taxonomy,
                            raw_classification,
                            validation_warnings,
                        )
                        append_jsonl(RECORDS, output)
                        progress_stage(
                            record["id"],
                            digest,
                            "complete",
                            tags=len(classification["backendTags"]),
                            confidence=output["quality"]["confidence"],
                            sourceMode=bundle["sourceMode"],
                        )
                        counters["complete"] += 1
                except RateLimitError:
                    raise
                except Exception as error:
                    batch_error = error
            if batch_error:
                print(f"  MODEL BATCH FAILED: {concise_error(batch_error)}")
                if args.no_batch_fallback:
                    counters["failed"] += len(batch)
                    for record, digest, _ in batch:
                        progress_stage(record["id"], digest, "crawl", batchError=str(batch_error)[:2000])
                    return
                print("  falling back to singles")
                await asyncio.gather(
                    *[
                        process_model(position, record, digest, bundle)
                        for position, (record, digest, bundle) in enumerate(batch, start=1)
                    ]
                )
                return
            if missing_batch:
                print(f"  batch omitted {len(missing_batch)} record(s); retrying only those")
                await asyncio.gather(
                    *[
                        process_model(position, record, digest, bundle)
                        for position, (record, digest, bundle) in enumerate(missing_batch, start=1)
                    ]
                )

        if args.model_batch_size > 1 and not args.split_pass:
            batches = [
                work[index:index + args.model_batch_size]
                for index in range(0, len(work), args.model_batch_size)
            ]
            await asyncio.gather(
                *[
                    process_model_batch(batch_number, batch)
                    for batch_number, batch in enumerate(batches, start=1)
                ]
            )
        else:
            await asyncio.gather(
                *[
                    process_model(position, record, digest, bundle)
                    for position, (record, digest, bundle) in enumerate(work, start=1)
                ]
            )
        if args.stop_after_stage == "facts":
            print("Intentional stop after facts checkpoints.")
            return
    print(json.dumps(counters, indent=2))


def status(args: argparse.Namespace) -> None:
    catalog = load_source_catalog()
    taxonomy = load_json(TAXONOMY_PATH)
    digest = stable_hash(taxonomy, 16)
    selected = selected_records(catalog, args.start_index, args.limit, set(args.id or []))
    completed = completed_inputs()
    outputs = latest_records()
    progress = json_lines(PROGRESS)
    latest_stage: dict[tuple[str, str], str] = {}
    for row in progress:
        latest_stage[(row.get("id"), row.get("inputHash"))] = row.get("stage", "unknown")
    counts: dict[str, int] = {}
    pending: list[dict[str, str]] = []
    for record in selected:
        key = (record["id"], input_hash(record, digest))
        stage = (
            "complete"
            if key in completed
            or output_is_current(outputs.get(record["id"]), record, taxonomy["version"])
            else latest_stage.get(key, "pending")
        )
        counts[stage] = counts.get(stage, 0) + 1
        if stage != "complete":
            pending.append({
                "id": record["id"],
                "title": record.get("title") or "",
                "stage": stage,
            })
    result = {
        "selected": len(selected),
        "stages": counts,
        "pendingCount": len(pending),
        "recordsWritten": len(latest_records()),
    }
    if not args.summary_only:
        result["pending"] = pending[:args.pending_limit] if args.pending_limit >= 0 else pending
    print(json.dumps(result, indent=2))


def review(args: argparse.Namespace) -> None:
    records = list(latest_records().values())
    records.sort(key=lambda row: row.get("quality", {}).get("enrichedAt", ""), reverse=True)
    if args.limit > 0:
        records = records[:args.limit]
    summary = []
    for row in records:
        summary.append(
            {
                "id": row["id"],
                "title": row.get("title"),
                "sourceMode": row.get("quality", {}).get("sourceMode"),
                "confidence": row.get("quality", {}).get("confidence"),
                "pages": max(0, len(row.get("sources", [])) - 1),
                "tags": row.get("classification", {}).get("backendTags", []),
                "warnings": row.get("quality", {}).get("warnings", []),
            }
        )
    print(json.dumps(summary, indent=2, ensure_ascii=False))


def audit(args: argparse.Namespace) -> None:
    catalog = load_source_catalog()
    taxonomy = load_json(TAXONOMY_PATH)
    selected = selected_records(catalog, args.start_index, args.limit, set(args.id or []))
    records = latest_records()
    legacy_crawl_cache = crawl_cache_index()
    allowed = {tag["id"]: tag for tag in taxonomy["tags"]}
    errors: list[str] = []
    summaries: list[dict[str, Any]] = []
    source_modes: dict[str, int] = {}
    warning_records = 0
    low_confidence: list[dict[str, Any]] = []
    for source_record in selected:
        record = records.get(source_record["id"])
        if not record:
            errors.append(f"{source_record['id']}: no v4 output")
            continue
        if not output_is_current(record, source_record, taxonomy["version"]):
            errors.append(f"{source_record['id']}: output is stale for the current pipeline or source")
        classification = record.get("classification") or {}
        backend = classification.get("backendTags") or []
        frontend = classification.get("frontendTags") or []
        expected_frontend = [tag for tag in backend if allowed.get(tag, {}).get("frontend")]
        unknown = [tag for tag in backend if tag not in allowed]
        if unknown:
            errors.append(f"{record['id']}: unknown tags {unknown}")
        if sorted(frontend) != sorted(expected_frontend):
            errors.append(f"{record['id']}: frontend tags do not match backend taxonomy metadata")
        source_urls = {source.get("url") for source in record.get("sources", [])}
        crawl_path = CRAWL_CACHE / f"{crawl_hash(source_record)}.json"
        cached_path = crawl_path if crawl_path.exists() else legacy_crawl_cache.get(source_record["id"])
        cached_bundle = load_json(cached_path) if cached_path else {"pages": []}
        cached_sources = source_text_map(cached_bundle)
        assignment_tags = []
        for assignment in classification.get("assignments") or []:
            tag = assignment.get("tag")
            assignment_tags.append(tag)
            if not clean_string(assignment.get("evidence")):
                errors.append(f"{record['id']}: {tag} has empty evidence")
            evidence = clean_string(assignment.get("evidence"))
            source_url = assignment.get("sourceUrl")
            locally_derived = evidence.startswith(("Implied by canonical tag ", "Derived from "))
            if not locally_derived and source_url not in source_urls:
                errors.append(f"{record['id']}: {tag} cites an unknown source URL")
            if (
                not locally_derived
                and source_url in cached_sources
                and not evidence_supported(evidence, cached_sources[source_url])
            ):
                errors.append(f"{record['id']}: {tag} evidence was not found in its cited source")
        if sorted(set(assignment_tags)) != sorted(backend):
            errors.append(f"{record['id']}: backendTags and assignments differ")
        application = record.get("application") or {}
        consistency = {
            "essay-required": application.get("essay", {}).get("status") == "required",
            "no-essay": application.get("essay", {}).get("status") == "not-required",
            "transcript-required": application.get("transcript", {}).get("status") == "required",
            "recommendation-required": application.get("recommendations", {}).get("status") == "required",
            "application-fee": application.get("fee", {}).get("status") == "required",
            "no-application-fee": application.get("fee", {}).get("status") == "not-required",
        }
        for tag, supported in consistency.items():
            if (tag in backend) != supported:
                errors.append(f"{record['id']}: typed application field disagrees with {tag}")
        if "essay-required" in backend and "no-essay" in backend:
            errors.append(f"{record['id']}: contradictory essay tags")
        if "application-fee" in backend and "no-application-fee" in backend:
            errors.append(f"{record['id']}: contradictory fee tags")
        source_mode = record.get("quality", {}).get("sourceMode") or "unknown"
        source_modes[source_mode] = source_modes.get(source_mode, 0) + 1
        warnings = record.get("quality", {}).get("warnings") or []
        confidence = record.get("quality", {}).get("confidence")
        if warnings:
            warning_records += 1
        if isinstance(confidence, (int, float)) and confidence < args.minimum_confidence:
            low_confidence.append({
                "id": record["id"],
                "title": record.get("title"),
                "confidence": confidence,
            })
        summaries.append({
            "id": record["id"],
            "title": record.get("title"),
            "sourceMode": source_mode,
            "confidence": confidence,
            "tags": len(backend),
            "warnings": len(warnings),
        })
    result = {
        "selected": len(selected),
        "audited": len(summaries),
        "errors": errors,
        "quality": {
            "sourceModes": source_modes,
            "recordsWithWarnings": warning_records,
            "lowConfidence": low_confidence,
        },
    }
    if not args.summary_only:
        result["records"] = summaries
    print(json.dumps(result, indent=2))
    if errors:
        raise SystemExit(1)


def prefill(args: argparse.Namespace) -> None:
    catalog = load_source_catalog()
    taxonomy = load_json(TAXONOMY_PATH)
    taxonomy_digest = stable_hash(taxonomy, 16)
    selected = selected_records(
        catalog,
        args.start_index,
        args.limit,
        set(args.id or []),
        args.shard_count,
        args.shard_index,
    )
    outputs = latest_records()
    counters = {"selected": len(selected), "written": 0, "cached": 0, "failed": 0}
    for record in selected:
        digest = input_hash(record, taxonomy_digest)
        if output_is_current(outputs.get(record["id"]), record, taxonomy["version"]) and not args.force:
            counters["cached"] += 1
            continue
        try:
            bundle = deterministic_bundle(record)
            write_json_atomic(CRAWL_CACHE / f"{crawl_hash(record)}.json", bundle)
            facts = normalize_facts(deterministic_raw_facts(record), record, bundle)
            merge_record_fallback_facts(facts, record)
            raw_classification = {
                "assignments": deterministic_assignments(record, taxonomy),
                "confidence": 0.72,
                "warnings": ["deterministic prefill"],
            }
            classification, validation_warnings = normalize_classification(
                raw_classification,
                facts,
                bundle,
                taxonomy,
            )
            reconcile_application_requirements(facts, classification)
            append_jsonl(
                RECORDS,
                final_record(
                    record,
                    facts,
                    classification,
                    bundle,
                    ["deterministic-prefill"],
                    digest,
                    taxonomy,
                    raw_classification,
                    validation_warnings,
                ),
            )
            progress_stage(record["id"], digest, "complete", sourceMode="record-fallback", pages=0)
            counters["written"] += 1
        except Exception as error:
            counters["failed"] += 1
            progress_stage(record["id"], digest, "failed", error=str(error)[:2000])
            if args.fail_fast:
                raise
    print(json.dumps(counters, indent=2))


def compact_outputs(_: argparse.Namespace) -> None:
    records = list(latest_records().values())
    records.sort(key=lambda row: row["id"])
    progress_latest: dict[tuple[str, str], dict[str, Any]] = {}
    for row in json_lines(PROGRESS):
        progress_latest[(row.get("id"), row.get("inputHash"))] = row
    for path, values in ((RECORDS, records), (PROGRESS, list(progress_latest.values()))):
        temporary = path.with_suffix(".jsonl.tmp")
        temporary.parent.mkdir(parents=True, exist_ok=True)
        with temporary.open("w", encoding="utf-8", newline="\n") as stream:
            for value in values:
                stream.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n")
        temporary.replace(path)
    print(f"Compacted {len(records)} records and {len(progress_latest)} progress entries.")


def run_shards(args: argparse.Namespace) -> None:
    if args.shards < 1:
        raise ValueError("--shards must be at least 1.")
    if args.batch_size < 1:
        raise ValueError("--batch-size must be at least 1.")
    pid = active_lock(LOCK)
    if pid:
        raise RuntimeError(f"A single v4 enrichment run is active with PID {pid}.")
    catalog = load_source_catalog()
    if args.upgrade_prefill:
        outputs = latest_records()
        catalog = [record for record in catalog if output_is_prefill(outputs.get(record.get("id")))]
    total = len(selected_records(catalog, args.start_index, args.limit, set()))
    print(f"Starting {args.shards} shard workers over {total} selected records in batches of {args.batch_size}.")
    for batch_offset in range(0, total, args.batch_size):
        batch_limit = min(args.batch_size, total - batch_offset)
        batch_start = args.start_index + batch_offset
        commands: list[list[str]] = []
        for shard_index in range(args.shards):
            command = [
                sys.executable,
                str(Path(__file__).resolve()),
                "run",
                "--limit", str(batch_limit),
                "--start-index", str(batch_start),
                "--shard-count", str(args.shards),
                "--shard-index", str(shard_index),
                "--workers", str(args.workers),
                "--crawl-workers", str(args.crawl_workers),
                "--model-timeout", str(args.model_timeout),
                "--max-output-tokens", str(args.max_output_tokens),
                "--model-batch-size", str(args.model_batch_size),
                "--batch-source-chars", str(args.batch_source_chars),
                "--retries", str(args.retries),
                "--retry-delay", str(args.retry_delay),
                "--delay", str(args.delay),
            ]
            if args.record_only:
                command.append("--record-only")
            if args.upgrade_prefill:
                command.append("--upgrade-prefill")
            if args.split_pass:
                command.append("--split-pass")
            if args.no_batch_fallback:
                command.append("--no-batch-fallback")
            if args.no_split_fallback:
                command.append("--no-split-fallback")
            if args.retry_failed:
                command.append("--retry-failed")
            if args.force:
                command.append("--force")
            commands.append(command)
        print(f"Starting batch {batch_offset + 1}-{batch_offset + batch_limit} of {total}.")
        processes = [subprocess.Popen(command, cwd=ROOT) for command in commands]
        failures = []
        for index, process in enumerate(processes):
            code = process.wait()
            if code:
                failures.append({"batchStart": batch_start, "shard": index, "exitCode": code})
        if failures:
            print(json.dumps({"failedShards": failures}, indent=2))
            raise SystemExit(1)
    if not args.no_index:
        subprocess.run(["node", str(ROOT / "scripts" / "build-index.mjs")], cwd=ROOT, check=True)
    print(json.dumps({"shards": args.shards, "complete": True}, indent=2))


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    subparsers = root.add_subparsers(dest="command", required=True)

    def selection(command: argparse.ArgumentParser) -> None:
        command.add_argument("--start-index", type=int, default=0)
        command.add_argument("--limit", type=int, default=0)
        command.add_argument("--id", action="append", default=[])
        command.add_argument("--shard-count", type=int, default=1)
        command.add_argument("--shard-index", type=int, default=0)

    run_parser = subparsers.add_parser("run", help="Crawl and enrich scholarships.")
    selection(run_parser)
    run_parser.add_argument("--model", action="append", default=[])
    run_parser.add_argument("--max-pages", type=int, default=4)
    run_parser.add_argument("--page-chars", type=int, default=16000)
    run_parser.add_argument("--total-chars", type=int, default=50000)
    run_parser.add_argument("--crawl-timeout-ms", type=int, default=60000)
    run_parser.add_argument("--model-timeout", type=float, default=240)
    run_parser.add_argument("--max-output-tokens", type=int, default=12288)
    run_parser.add_argument("--model-batch-size", type=int, default=1)
    run_parser.add_argument("--batch-source-chars", type=int, default=3000)
    run_parser.add_argument("--retries", type=int, default=0)
    run_parser.add_argument("--retry-delay", type=float, default=5)
    run_parser.add_argument("--delay", type=float, default=1)
    run_parser.add_argument("--workers", type=int, default=6)
    run_parser.add_argument("--crawl-workers", type=int, default=2)
    run_parser.add_argument("--stop-after-stage", choices=["crawl", "facts"])
    run_parser.add_argument("--force", action="store_true")
    run_parser.add_argument("--retry-failed", action="store_true")
    run_parser.add_argument("--recrawl", action="store_true")
    run_parser.add_argument("--record-only", action="store_true")
    run_parser.add_argument("--upgrade-prefill", action="store_true")
    run_parser.add_argument("--reextract", action="store_true")
    run_parser.add_argument("--fail-fast", action="store_true")
    run_parser.add_argument("--no-split-fallback", action="store_true")
    run_parser.add_argument("--no-batch-fallback", action="store_true")
    run_parser.add_argument("--split-pass", action="store_true")

    shards_parser = subparsers.add_parser("run-shards", help="Run multiple non-overlapping enrichment workers.")
    shards_parser.add_argument("--shards", type=int, default=9)
    shards_parser.add_argument("--start-index", type=int, default=0)
    shards_parser.add_argument("--limit", type=int, default=0)
    shards_parser.add_argument("--batch-size", type=int, default=400)
    shards_parser.add_argument("--workers", type=int, default=1)
    shards_parser.add_argument("--crawl-workers", type=int, default=1)
    shards_parser.add_argument("--model-timeout", type=float, default=300)
    shards_parser.add_argument("--max-output-tokens", type=int, default=12288)
    shards_parser.add_argument("--model-batch-size", type=int, default=1)
    shards_parser.add_argument("--batch-source-chars", type=int, default=3000)
    shards_parser.add_argument("--retries", type=int, default=1)
    shards_parser.add_argument("--retry-delay", type=float, default=10)
    shards_parser.add_argument("--delay", type=float, default=0)
    shards_parser.add_argument("--record-only", action="store_true")
    shards_parser.add_argument("--upgrade-prefill", action="store_true")
    shards_parser.add_argument("--split-pass", action="store_true")
    shards_parser.add_argument("--no-batch-fallback", action="store_true")
    shards_parser.add_argument("--no-split-fallback", action="store_true")
    shards_parser.add_argument("--retry-failed", action="store_true")
    shards_parser.add_argument("--force", action="store_true")
    shards_parser.add_argument("--no-index", action="store_true")

    status_parser = subparsers.add_parser("status", help="Show current checkpoint status.")
    selection(status_parser)
    status_parser.add_argument("--summary-only", action="store_true")
    status_parser.add_argument("--pending-limit", type=int, default=-1)
    review_parser = subparsers.add_parser("review", help="Print recent enriched records.")
    review_parser.add_argument("--limit", type=int, default=10)
    audit_parser = subparsers.add_parser("audit", help="Validate completed records and tag consistency.")
    selection(audit_parser)
    audit_parser.add_argument("--summary-only", action="store_true")
    audit_parser.add_argument("--minimum-confidence", type=float, default=0.9)
    prefill_parser = subparsers.add_parser("prefill", help="Write deterministic v4 records from imported source data.")
    selection(prefill_parser)
    prefill_parser.add_argument("--force", action="store_true")
    prefill_parser.add_argument("--fail-fast", action="store_true")
    subparsers.add_parser("compact", help="Compact append-only output logs.")
    return root


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    args = parser().parse_args()
    if args.command == "run":
        asyncio.run(run(args))
    elif args.command == "run-shards":
        run_shards(args)
    elif args.command == "status":
        status(args)
    elif args.command == "review":
        review(args)
    elif args.command == "audit":
        audit(args)
    elif args.command == "prefill":
        prefill(args)
    elif args.command == "compact":
        compact_outputs(args)


if __name__ == "__main__":
    main()
