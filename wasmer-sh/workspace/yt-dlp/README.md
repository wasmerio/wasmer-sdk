# yt-dlp

```sh
pip install -r requirements.txt
/workspace/.python-packages/bin/yt-dlp --help
```

Pass a video URL as an argument. Files are saved in `downloads/` in this project.
You can also inspect the available formats before downloading:

```sh
/workspace/.python-packages/bin/yt-dlp --list-formats 'https://www.youtube.com/watch?v=VIDEO_ID'
/workspace/.python-packages/bin/yt-dlp 'https://www.youtube.com/watch?v=VIDEO_ID'
```

This example loads Python, QuickJS-NG (for YouTube JavaScript challenges), and
FFmpeg (to merge separate audio and video streams). Pip installs only `yt-dlp`
and its matching `yt-dlp-ejs` scripts; it does not install the optional default
extras or another JavaScript engine. No video is downloaded until you supply a
URL. In the browser, outbound requests use the configured WISP connection.

Run these commands from `/workspace` so yt-dlp automatically loads
`yt-dlp.conf`. This native configuration enables QuickJS, prefers H.264/AAC in
MP4, and saves files under `/workspace/downloads`. See yt-dlp's
[configuration documentation](https://github.com/yt-dlp/yt-dlp#configuration).
Site availability and authentication requirements vary; yt-dlp reports those
errors in the terminal.
