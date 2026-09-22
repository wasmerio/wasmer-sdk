# FFmpeg

Turn a video URL into an animated GIF. FFmpeg and FFprobe are already available;
there are no dependencies to install.

```sh
ffmpeg -n -multiple_requests 1 -i https://cdn.wasmer.io/media/wordpress.mp4 -vf 'fps=10,scale=320:-1' /workspace/wordpress.gif
```

This converts the full MP4 video to a looping GIF at 10 frames per second and
320 pixels wide, preserving its aspect ratio. The result is `wordpress.gif` in
this example's directory. GIF has no audio.

`-multiple_requests 1` reuses the HTTP connection when reading the remote video.
`-n` prevents overwriting an existing file; choose another output filename to run
the conversion again.

Inspect the converted file:

```sh
ffprobe -v error -show_streams -show_format /workspace/wordpress.gif
```

For a shorter animation, add `-t 5` after the input to convert only the first
five seconds:

```sh
ffmpeg -n -multiple_requests 1 -i https://cdn.wasmer.io/media/wordpress.mp4 -t 5 -vf 'fps=10,scale=320:-1' /workspace/wordpress-preview.gif
```

Replace the input URL to use your own video. Adjust `fps=10` for a smoother or
smaller animation, and `scale=320:-1` to change its width while preserving the
aspect ratio. In the browser, outbound requests use the configured WISP connection.

See the official [FFmpeg documentation](https://ffmpeg.org/ffmpeg.html) for
transcoding, filters, and supported options.
