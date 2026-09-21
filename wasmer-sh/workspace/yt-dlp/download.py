"""Download a video using Python, QuickJS, and FFmpeg inside Wasmer."""
import argparse
from pathlib import Path
from urllib.parse import urlparse


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", help="Video URL, for example https://www.youtube.com/watch?v=VIDEO_ID")
    parser.add_argument("--list-formats", action="store_true", help="List formats without downloading")
    args = parser.parse_args()
    url = args.url
    if urlparse(url).scheme not in ("http", "https"):
        parser.error("Enter an http:// or https:// video URL")

    from yt_dlp import YoutubeDL

    with YoutubeDL({
        "js_runtimes": {"quickjs": {}},
        "format": "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[ext=mp4]/best",
        "merge_output_format": "mp4",
        # The WASIX FFmpeg package needs absolute paths when spawned by Python.
        "outtmpl": str(Path("downloads").resolve() / "%(title).120B [%(id)s].%(ext)s"),
        "noplaylist": True,
        "listformats": args.list_formats,
        "socket_timeout": 30,
        "retries": 2,
    }) as downloader:
        return downloader.download([url])


if __name__ == "__main__":
    raise SystemExit(main())
