#!/usr/bin/env python3
"""Submit the site sitemap to Google Search Console (Webmasters API).

Reads the service-account JSON from the GSC_SA_JSON environment variable
(the raw file contents) or from GOOGLE_APPLICATION_CREDENTIALS / --key.
Never prints the key.

  PUT https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path
from urllib.parse import quote

import requests
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import service_account

DEFAULT_SITE = "https://dailyinsightdesk.com/"
DEFAULT_SITEMAP = "https://dailyinsightdesk.com/sitemap.xml"
SCOPE = "https://www.googleapis.com/auth/webmasters"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--key", help="Path to a service-account JSON key")
    parser.add_argument("--site", default=os.environ.get("GSC_SITE_URL", DEFAULT_SITE))
    parser.add_argument(
        "--sitemap", default=os.environ.get("GSC_SITEMAP_URL", DEFAULT_SITEMAP)
    )
    parser.add_argument(
        "--status-only",
        action="store_true",
        help="List sitemap status without submitting",
    )
    return parser.parse_args()


def load_credentials(key_arg: str | None):
    raw = os.environ.get("GSC_SA_JSON", "").strip()
    key_path = key_arg or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    tmp_path = None
    if raw:
        # Accept either a JSON object or a path (if someone passed a filename).
        if raw.startswith("{"):
            handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
            handle.write(raw)
            handle.close()
            os.chmod(handle.name, 0o600)
            tmp_path = handle.name
            key_path = tmp_path
        else:
            key_path = raw
    if not key_path:
        default = Path.home() / ".secrets" / "dailyinsightdesk-gsa.json"
        if default.is_file():
            key_path = str(default)
        else:
            raise SystemExit(
                "Missing credentials: set GSC_SA_JSON, GOOGLE_APPLICATION_CREDENTIALS, or --key."
            )
    try:
        creds = service_account.Credentials.from_service_account_file(
            key_path, scopes=[SCOPE]
        )
        creds.refresh(GoogleAuthRequest())
        return creds
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def encode(url: str) -> str:
    return quote(url, safe="")


def request(creds, method: str, url: str, *, allow_empty: bool = False):
    creds.refresh(GoogleAuthRequest())
    response = requests.request(
        method,
        url,
        headers={
            "Authorization": f"Bearer {creds.token}",
            "Accept": "application/json",
        },
        timeout=60,
    )
    text = response.text or ""
    if response.status_code >= 400:
        lowered = text.lower()
        if response.status_code in (403, 400) and any(
            marker in lowered
            for marker in (
                "has not been used",
                "it is disabled",
                "api has not been enabled",
                "service_disabled",
            )
        ):
            raise SystemExit(
                "Search Console API is not enabled on the Google Cloud project "
                f"(HTTP {response.status_code}). Enable the Search Console API "
                "on project dailyinsightdesk-data and retry.\n"
                f"{text[:600]}"
            )
        raise SystemExit(f"Search Console API HTTP {response.status_code}: {text[:800]}")
    if allow_empty and not text:
        return {}
    return response.json() if text else {}


def list_sitemaps(creds, site_url: str) -> list[dict]:
    url = (
        "https://www.googleapis.com/webmasters/v3/sites/"
        f"{encode(site_url)}/sitemaps"
    )
    payload = request(creds, "GET", url)
    return payload.get("sitemap") or []


def submit_sitemap(creds, site_url: str, sitemap_url: str) -> None:
    url = (
        "https://www.googleapis.com/webmasters/v3/sites/"
        f"{encode(site_url)}/sitemaps/{encode(sitemap_url)}"
    )
    request(creds, "PUT", url, allow_empty=True)


def print_status(items: list[dict], sitemap_url: str) -> None:
    if not items:
        print("Search Console returned no sitemaps.")
        return
    print(f"Search Console sitemaps for this property ({len(items)}):")
    for item in items:
        path = item.get("path")
        mark = "  <-- submitted" if path == sitemap_url else ""
        print(f"- {path}{mark}")
        print(f"    lastSubmitted:  {item.get('lastSubmitted')}")
        print(f"    lastDownloaded: {item.get('lastDownloaded')}")
        print(f"    isPending:      {item.get('isPending')}")
        print(f"    warnings:       {item.get('warnings') or 0}")
        print(f"    errors:         {item.get('errors') or 0}")
        contents = item.get("contents") or []
        if contents:
            print(f"    contents:       {json.dumps(contents)}")


def main() -> int:
    args = parse_args()
    creds = load_credentials(args.key)
    if not args.status_only:
        submit_sitemap(creds, args.site, args.sitemap)
        print(f"Submitted {args.sitemap} to Search Console for {args.site}")
    print_status(list_sitemaps(creds, args.site), args.sitemap)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
