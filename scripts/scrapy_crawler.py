#!/usr/bin/env python3
"""Generic Scrapy crawler runner for on-demand website crawling.

Outputs JSON to stdout:
{
  "ok": true|false,
  "startUrl": "https://example.com",
  "pageCount": 3,
  "pages": [{ "url": "...", "title": "...", "description": "...", "text": "...", "links": [...], "status": 200 }],
  "stats": { ... },
  "error": "..."
}
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any
from urllib.parse import urlparse

try:
    import scrapy
    from scrapy.crawler import CrawlerProcess
except Exception:
    scrapy = None
    CrawlerProcess = None


MAX_TEXT_CHARS = 15000
MAX_LINKS_PER_PAGE = 25


def _safe_print(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def _normalize_whitespace(value: str = "") -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _extract_allowed_domains(url: str, same_domain_only: bool) -> list[str]:
    if not same_domain_only:
        return []

    hostname = (urlparse(url).hostname or "").strip().lower()
    if not hostname:
        return []

    domain_variants = {hostname}
    if hostname.startswith("www."):
        domain_variants.add(hostname[4:])
    else:
        domain_variants.add(f"www.{hostname}")

    return [value for value in domain_variants if value]


class GenericSiteSpider(scrapy.Spider):
    name = "generic_site_spider"

    def __init__(self, start_url: str, max_pages: int = 100, same_domain_only: bool = True, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.start_urls = [start_url]
        self.same_domain_only = same_domain_only
        self.allowed_domains = _extract_allowed_domains(start_url, same_domain_only)
        self.max_pages = max(1, int(max_pages))
        self.pages: list[dict[str, Any]] = []
        self.seen_urls: set[str] = set()
        self.stats_payload: dict[str, Any] = {}

    def parse(self, response):
        normalized_url = str(response.url)
        if normalized_url in self.seen_urls:
            return

        self.seen_urls.add(normalized_url)
        page_text = _normalize_whitespace(" ".join(response.css("body *::text").getall()))
        title = _normalize_whitespace(" ".join(response.css("title::text").getall()))

        # Prefer the standard meta description, falling back to Open Graph's
        # og:description when the page has no plain meta description tag.
        description = _normalize_whitespace(
            response.css('meta[name="description"]::attr(content)').get()
            or response.css('meta[property="og:description"]::attr(content)').get()
            or ""
        )

        links: list[str] = []
        for href in response.css("a::attr(href)").getall():
            absolute = response.urljoin(href)
            if not absolute.startswith(("http://", "https://")):
                continue
            if self.same_domain_only and self.allowed_domains:
                hostname = (urlparse(absolute).hostname or "").lower()
                if hostname not in set(self.allowed_domains):
                    continue
            if absolute == normalized_url or absolute in links:
                continue
            links.append(absolute)
            if len(links) >= MAX_LINKS_PER_PAGE:
                break

        self.pages.append(
            {
                "url": normalized_url,
                "title": title,
                "description": description,
                "text": page_text[:MAX_TEXT_CHARS],
                "links": links,
                "status": int(response.status),
            }
        )

        if len(self.pages) >= self.max_pages:
            return

        for next_url in links:
            if next_url in self.seen_urls:
                continue
            yield response.follow(next_url, callback=self.parse)

    @classmethod
    def from_crawler(cls, crawler, *args, **kwargs):
        spider = super().from_crawler(crawler, *args, **kwargs)

        def _capture_stats(_spider, reason):
            stats = crawler.stats.get_stats() if crawler and crawler.stats else {}
            spider.stats_payload = {
                "finishReason": reason,
                "requestCount": int(stats.get("downloader/request_count", 0) or 0),
                "responseCount": int(stats.get("downloader/response_count", 0) or 0),
                "itemScrapedCount": int(stats.get("item_scraped_count", 0) or 0),
            }

        crawler.signals.connect(_capture_stats, signal=scrapy.signals.spider_closed)
        return spider


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a generic Scrapy crawl for a website.")
    parser.add_argument("url", help="Starting URL to crawl")
    parser.add_argument("--max-pages", type=int, default=100, help="Maximum number of pages to capture")
    parser.add_argument("--max-depth", type=int, default=5, help="Maximum crawl depth")
    parser.add_argument(
        "--allow-offsite",
        action="store_true",
        help="Allow the crawl to follow links outside the starting host",
    )
    return parser.parse_args(argv[1:])


def main() -> int:
    args = _parse_args(sys.argv)

    if scrapy is None or CrawlerProcess is None:
        _safe_print(
            {
                "ok": False,
                "startUrl": args.url,
                "pageCount": 0,
                "pages": [],
                "stats": {},
                "error": "scrapy-not-installed",
            }
        )
        return 1

    try:
        parsed = urlparse(args.url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("invalid-url")

        process = CrawlerProcess(
            settings={
                "LOG_ENABLED": False,
                "ROBOTSTXT_OBEY": True,
                "USER_AGENT": "query-notify-scrapy/1.0 (+research crawl)",
                "DEPTH_LIMIT": max(0, int(args.max_depth)),
                "CLOSESPIDER_PAGECOUNT": max(1, int(args.max_pages)),
                "DOWNLOAD_TIMEOUT": 20,
                "REQUEST_FINGERPRINTER_IMPLEMENTATION": "2.7",
            }
        )

        crawler = process.create_crawler(GenericSiteSpider)
        process.crawl(
            crawler,
            start_url=args.url,
            max_pages=max(1, int(args.max_pages)),
            same_domain_only=not bool(args.allow_offsite),
        )
        process.start(stop_after_crawl=True)
        spider = crawler.spider

        _safe_print(
            {
                "ok": True,
                "startUrl": args.url,
                "pageCount": len(spider.pages),
                "pages": spider.pages,
                "stats": spider.stats_payload,
            }
        )
        return 0
    except Exception as error:
        _safe_print(
            {
                "ok": False,
                "startUrl": args.url,
                "pageCount": 0,
                "pages": [],
                "stats": {},
                "error": str(error),
            }
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
