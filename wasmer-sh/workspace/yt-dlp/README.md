# yt-dlp

```sh
pip install -r requirements.txt
python download.py --help
```

Pass a video URL as an argument. Files are saved in `downloads/` in this project.
You can also inspect the available formats before downloading:

```sh
python download.py --list-formats 'https://www.youtube.com/watch?v=VIDEO_ID'
python download.py 'https://www.youtube.com/watch?v=VIDEO_ID'
```

This example loads Python, QuickJS-NG (for YouTube JavaScript challenges), and
FFmpeg (to merge separate audio and video streams). Pip installs only `yt-dlp`
and its matching `yt-dlp-ejs` scripts; it does not install the optional default
extras or another JavaScript engine. No video is downloaded until you supply a
URL. In the browser, outbound requests use the configured WISP connection.

The default format prefers H.264/AAC in MP4. Site availability and authentication
requirements vary; yt-dlp reports those errors in the terminal.
